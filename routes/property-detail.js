/* One property, in full — and the writes that go with it.

   The list view in routes/properties.js answers "what do we own"; this answers
   "what do we know about this one, and let me fix it". It is the half that
   turns a report into a record.

   Everything here is plain SQL against the same Supabase database the list
   reads. There is no ORM and no field registry: the columns ARE the fields, and
   information_schema is what says which exist and what type they are. That
   matters for safety as much as for rendering -- a column name arriving from the
   browser is checked against the real column list before it can reach a query,
   so `p:street` works and `p:street=1;drop` cannot.

   Labels are derived from column names rather than maintained by hand. Sixty
   columns hand-labelled is sixty things to forget when the schema moves; a
   handful of overrides covers the ones that read badly on their own. */

import express from 'express';
import { ghlQuery, ghlClient } from '../db/index.js';

/* Tables the browser may address, and what a row of each is called. Nothing
   outside this map is reachable, whatever the field id says. */
const EDITABLE = {
  p: { table: 'property', label: 'Property' },
  u: { table: 'unit', label: 'Building' },
  l: { table: 'loan', label: 'Loan' },
  f: { table: 'property_financials', label: 'Financials' },
  i: { table: 'insurance_policy', label: 'Insurance' }
};

/* Never editable, whatever the schema says: identity, ownership of the row, and
   the audit trail. `entity_id` is excluded on purpose -- changing a property's
   owner has to go through the ownership table too, so it has its own path. */
const LOCKED = new Set(['id', 'created_at', 'updated_at', 'created_by', 'updated_by',
  'tenant_id', 'company_id', 'property_id', 'unit_id', 'loan_id', 'entity_id',
  'borrower_entity_id', 'clickup_task_id']);

/* Columns whose derived label is wrong or unreadable. Everything else becomes
   Title Case from snake_case. */
const LABEL = {
  dba_name: 'DBA name', ein: 'EIN', noi: 'NOI', egi: 'EGI', dcr: 'DCR', dscr: 'DSCR',
  tiv: 'TIV', hoa: 'HOA', rubs_at_takeover: 'RUBS at takeover', rubs_implemented: 'RUBS implemented',
  is_tif: 'Is TIF', hud_audit: 'HUD audit', loc_beginning: 'LOC beginning',
  loc_available: 'LOC available', loc_draws_process: 'LOC draws process',
  loc_hurdle: 'LOC hurdle', loc_hurdle_remaining: 'LOC hurdle remaining',
  loc_draws_form_required: 'LOC draws form required', loc_draws_form_url: 'LOC draws form URL',
  loc_draws_submission_contact: 'LOC draws submission contact', loc_draws_timing: 'LOC draws timing',
  loc_availability_maturity_date: 'LOC availability maturity date',
  county_assessor_url: 'County assessor website', dropbox_url: 'Dropbox link',
  ppt_split_ratio: 'PPT split ratio', pac_due: 'PAC due',
  aop_deductible_amount: 'AOP deductible amount', aop_deductible_pct: 'AOP deductible %',
  aop_deductible_basis: 'AOP deductible basis',
  all_other_perils_deductible: 'All-other-perils deductible',
  total_ltv: 'Total LTV', cap_rate: 'Cap rate', as_of_date: 'As of',
  fmv_notes: 'FMV notes', current_market_value: 'Current market value',
  current_market_value_2023: 'Current market value (2023)',
  current_market_value_asof: 'Market value as of',
  unit_count_reported: 'Unit count (reported)', unit_count_verified: 'Unit count (verified)',
  unit_count_verified_by: 'Unit count verified by', unit_count_verified_at: 'Unit count verified at',
  construction_budget_dropbox_url: 'Construction budget link'
};

const titleise = col => LABEL[col]
  || col.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()).replace(/\bpct\b/, '%');

/* How the browser should render and send a value back. Derived from the SQL
   type, not guessed from the name. */
function kindOf(dataType, col){
  if (dataType === 'boolean') return 'bool';
  if (dataType === 'date') return 'date';
  if (/timestamp/.test(dataType)) return 'datetime';
  if (['numeric', 'integer', 'bigint', 'double precision', 'real', 'smallint'].includes(dataType)) {
    return /(_pct|_ratio|occupancy|cap_rate|dcr|dscr|ltv)$/.test(col) ? 'number' : 'money';
  }
  if (dataType === 'ARRAY') return 'list';
  if (dataType === 'jsonb' || dataType === 'json') return 'json';
  if (/(_url|_website)$/.test(col) || col === 'county_assessor_url') return 'url';
  if (/(note|notes|description|_note)$/.test(col)) return 'text';
  return 'string';
}

export function propertyDetailRoutes({ env, auth, invalidate }){
  const r = express.Router();
  const configured = Boolean(env.SUPABASE_DB_URL);

  /* information_schema, read once. Every field id the browser sends is validated
     against this, so it is a security boundary as much as a convenience. */
  let schema = null;
  async function columns(){
    if (schema) return schema;
    const rows = (await ghlQuery(
      `select table_name, column_name, data_type, ordinal_position
         from information_schema.columns
        where table_schema = 'public'
          and table_name = any($1)
        order by table_name, ordinal_position`,
      [Object.values(EDITABLE).map(x => x.table)]
    )).rows;
    schema = {};
    for (const row of rows) {
      (schema[row.table_name] ||= []).push({
        col: row.column_name,
        type: row.data_type,
        kind: kindOf(row.data_type, row.column_name),
        label: titleise(row.column_name),
        locked: LOCKED.has(row.column_name)
      });
    }
    return schema;
  }

  /* A field id is "<kind>:<rowId>:<column>", or "p:<column>" for the property
     itself. Resolving it is the only place a column name becomes SQL, so it is
     also the only place that has to be careful. */
  async function resolveField(propertyId, fieldId){
    const parts = String(fieldId || '').split(':');
    const kind = parts[0];
    const spec = EDITABLE[kind];
    if (!spec) throw Object.assign(new Error('Unknown field group: ' + kind), { status: 400 });

    const col = kind === 'p' ? parts[1] : parts[2];
    const rowId = kind === 'p' ? propertyId : parts[1];
    if (!rowId) throw Object.assign(new Error('That field needs a row id'), { status: 400 });

    const cols = (await columns())[spec.table] || [];
    const meta = cols.find(c => c.col === col);
    if (!meta) throw Object.assign(new Error('No such column: ' + spec.table + '.' + col), { status: 400 });
    if (meta.locked) throw Object.assign(new Error(titleise(col) + ' is not editable'), { status: 400 });

    return { table: spec.table, col, rowId, meta };
  }

  /* Turn what the browser sent into what the column will accept. An empty string
     is an erasure, not a zero -- a cleared "purchase price" that stored 0 would
     read as a property bought for nothing. */
  function coerce(meta, value){
    if (value === null || value === undefined || value === '') return null;
    switch (meta.kind) {
      case 'bool':
        return value === true || value === 'true' || value === 'Yes' || value === 'yes';
      case 'money':
      case 'number': {
        const n = Number(String(value).replace(/[$,%\s,]/g, ''));
        if (!Number.isFinite(n)) throw Object.assign(new Error('That is not a number'), { status: 400 });
        return n;
      }
      case 'date':
      case 'datetime': {
        const t = Date.parse(value);
        if (!Number.isFinite(t)) throw Object.assign(new Error('That is not a date'), { status: 400 });
        return new Date(t).toISOString();
      }
      case 'list':
        return Array.isArray(value) ? value.map(String) : String(value).split(',').map(s => s.trim()).filter(Boolean);
      default:
        return String(value);
    }
  }

  const guard = (req, res, next) => {
    if (!configured) return res.status(400).json({ error: 'SUPABASE_DB_URL is not set.' });
    next();
  };

  const fail = (res, err) => {
    const status = err.status || 500;
    if (status === 500) console.error('[properties]', err.message);
    res.status(status).json({ error: err.message });
  };

  /* ---- read one property, everything about it ---------------------------- */

  r.get('/api/properties/:id/detail', auth.require, guard, async (req, res) => {
    const id = String(req.params.id);
    try {
      const cols = await columns();
      const one = async (sql, params) => (await ghlQuery(sql, params)).rows;

      const [prop] = await one(`select * from public.property where id = $1`, [id]);
      if (!prop) return res.status(404).json({ error: 'No such property' });

      const [entities, owners, units, loans, fins, ins, comments, parcels, tasks] = await Promise.all([
        one(`select id, name, parent_entity_id from public.entity order by name`),
        one(`select o.entity_id, o.is_primary, e.name
               from public.ownership o join public.entity e on e.id = o.entity_id
              where o.property_id = $1 order by o.is_primary desc, e.name`, [id]),
        one(`select * from public.unit where property_id = $1 order by building_number nulls last, unit_identifier`, [id]),
        one(`select l.*, b.balance, b.as_of_date as balance_as_of
               from public.loan l
               join public.loan_collateral lc on lc.loan_id = l.id
               left join lateral (
                 select balance, as_of_date from public.loan_balance
                  where loan_id = l.id order by as_of_date desc nulls last limit 1
               ) b on true
              where lc.property_id = $1
                 or lc.unit_id in (select id from public.unit where property_id = $1)
              group by l.id, b.balance, b.as_of_date
              order by l.maturity_date nulls last`, [id]),
        one(`select * from public.property_financials where property_id = $1
              order by as_of_date desc nulls last`, [id]),
        one(`select * from public.insurance_policy where property_id = $1 order by renewal_date nulls last`, [id]),
        one(`select id, author, body, created_at from public.property_comment
              where property_id = $1 order by created_at asc`, [id]),
        one(`select parcel_number, county, is_primary from public.property_parcel where property_id = $1`, [id])
          .catch(() => []),
        one(`select id, name, status, priority, due_date, assignees
               from public.task where property_id = $1 order by due_date nulls last`, [id])
          .catch(() => [])
      ]);

      /* The entity chain, so the drawer can show where this sits. */
      const byId = new Map(entities.map(e => [e.id, e]));
      const path = [];
      for (let e = byId.get(prop.entity_id); e; e = byId.get(e.parent_entity_id)) path.unshift({ id: e.id, name: e.name });

      /* A group is a table, its rows, and the column metadata to render them.
         Sending the metadata rather than baking it into the page means a column
         added to Supabase appears here without a deploy. */
      const group = (table, rows, idOf) => ({
        table,
        fields: (cols[table] || []).filter(c => !c.locked),
        rows: rows.map(row => ({ id: idOf(row), values: row }))
      });

      res.json({
        ok: true,
        property: prop,
        path,
        entities: entities.map(e => ({ id: e.id, name: e.name, parentId: e.parent_entity_id })),
        owners: owners.map(o => ({ entityId: o.entity_id, name: o.name, primary: Boolean(o.is_primary) })),
        primaryOwnerId: prop.entity_id || (owners.find(o => o.is_primary) || {}).entity_id || null,
        parcels,
        tasks,
        comments: comments.map(c => ({
          id: c.id, author: c.author || 'Unknown', body: c.body,
          at: c.created_at ? new Date(c.created_at).getTime() : null
        })),
        groups: {
          property: group('property', [prop], () => 'p'),
          loans: group('loan', loans, row => 'l:' + row.id),
          financials: group('property_financials', fins, row => 'f:' + row.id),
          buildings: group('unit', units, row => 'u:' + row.id),
          insurance: group('insurance_policy', ins, row => 'i:' + row.id)
        }
      });
    } catch (err) { fail(res, err); }
  });

  /* ---- write one field --------------------------------------------------- */

  r.patch('/api/properties/:id/field', auth.require, guard, express.json({ limit: '128kb' }), async (req, res) => {
    const id = String(req.params.id);
    try {
      const { table, col, rowId, meta } = await resolveField(id, req.body?.field);
      const value = coerce(meta, req.body?.value);
      const out = await ghlQuery(
        `update public.${table} set ${col} = $1 where id = $2 returning ${col}`,
        [value, rowId]
      );
      if (!out.rows.length) throw Object.assign(new Error('No such row'), { status: 404 });
      /* The list view's cache now disagrees with the database. Dropping it costs
         one rebuild; leaving it means the edit appears to have done nothing. */
      invalidate();
      res.json({ ok: true, field: req.body.field, value: out.rows[0][col] });
    } catch (err) { fail(res, err); }
  });

  /* ---- ownership ---------------------------------------------------------

     The `ownership` table is the source of truth and `property.entity_id` is a
     convenience copy of the primary row. They have to move together or the tree
     in the list view and the owner in the drawer say different things. */

  r.put('/api/properties/:id/owner', auth.require, guard, express.json({ limit: '16kb' }), async (req, res) => {
    const id = String(req.params.id);
    const entityId = String(req.body?.entityId || '');
    if (!entityId) return res.status(400).json({ error: 'Pick an entity' });
    /* One client, not the pool: three statements that must all land or none of
       them. Through ghlQuery they could each get a different connection and the
       BEGIN would apply to none of the work. */
    const client = await ghlClient();
    try {
      await client.query('begin');
      try {
        await client.query(`update public.property set entity_id = $1 where id = $2`, [entityId, id]);
        /* If this entity was already a co-owner, it stops being one -- it cannot
           be both, and a leftover row would show it twice. */
        await client.query(
          `delete from public.ownership
            where property_id = $1 and entity_id = $2 and coalesce(is_primary, false) = false`,
          [id, entityId]);
        const moved = await client.query(
          `update public.ownership set entity_id = $1
            where property_id = $2 and is_primary = true returning id`, [entityId, id]);
        if (!moved.rows.length) {
          await client.query(
            `insert into public.ownership (entity_id, property_id, is_primary) values ($1, $2, true)`,
            [entityId, id]);
        }
        await client.query('commit');
      } catch (err) { await client.query('rollback').catch(() => {}); throw err; }
      invalidate();
      res.json({ ok: true, entityId });
    } catch (err) { fail(res, err); }
    finally { client.release(); }
  });

  r.post('/api/properties/:id/owners', auth.require, guard, express.json({ limit: '16kb' }), async (req, res) => {
    const id = String(req.params.id);
    const entityId = String(req.body?.entityId || '');
    if (!entityId) return res.status(400).json({ error: 'Pick an entity' });
    try {
      const [existing] = (await ghlQuery(
        `select id, is_primary from public.ownership where property_id = $1 and entity_id = $2`,
        [id, entityId])).rows;
      if (existing?.is_primary) {
        throw Object.assign(new Error('That entity is already the primary owner'), { status: 400 });
      }
      /* Idempotent: adding the same co-owner twice is a double-click, not an
         error worth showing anyone. */
      if (!existing) {
        await ghlQuery(
          `insert into public.ownership (entity_id, property_id, is_primary) values ($1, $2, false)`,
          [entityId, id]);
      }
      invalidate();
      res.json({ ok: true, entityId });
    } catch (err) { fail(res, err); }
  });

  r.delete('/api/properties/:id/owners/:entityId', auth.require, guard, async (req, res) => {
    try {
      const [row] = (await ghlQuery(
        `select id, is_primary from public.ownership where property_id = $1 and entity_id = $2`,
        [req.params.id, req.params.entityId])).rows;
      if (!row) return res.json({ ok: true });        // already gone
      if (row.is_primary) {
        throw Object.assign(
          new Error('That is the primary owner. Change the owner entity instead of removing it.'),
          { status: 400 });
      }
      await ghlQuery(`delete from public.ownership where id = $1`, [row.id]);
      invalidate();
      res.json({ ok: true });
    } catch (err) { fail(res, err); }
  });

  /* ---- messages ---------------------------------------------------------- */

  r.get('/api/properties/:id/comments', auth.require, guard, async (req, res) => {
    try {
      const rows = (await ghlQuery(
        `select id, author, body, created_at from public.property_comment
          where property_id = $1 order by created_at asc`, [req.params.id])).rows;
      res.json({ ok: true, comments: rows.map(c => ({
        id: c.id, author: c.author || 'Unknown', body: c.body,
        at: c.created_at ? new Date(c.created_at).getTime() : null
      })) });
    } catch (err) { fail(res, err); }
  });

  r.post('/api/properties/:id/comments', auth.require, guard, express.json({ limit: '32kb' }), async (req, res) => {
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Write something first' });
    try {
      /* Attribution is whoever is signed in to the dashboard. An unattributed
         comment on a shared record is worth very little six months later. */
      const author = req.session?.user?.email || req.session?.user?.name || env.OWNER_EMAIL || 'Command Center';
      const [row] = (await ghlQuery(
        `insert into public.property_comment (property_id, author, body)
         values ($1, $2, $3) returning id, author, body, created_at`,
        [req.params.id, author, body])).rows;
      res.json({ ok: true, comment: {
        id: row.id, author: row.author, body: row.body,
        at: row.created_at ? new Date(row.created_at).getTime() : Date.now()
      } });
    } catch (err) { fail(res, err); }
  });

  /* ---- create ------------------------------------------------------------ */

  r.post('/api/properties/entity', auth.require, guard, express.json({ limit: '16kb' }), async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'An entity needs a name' });
    try {
      const [row] = (await ghlQuery(
        `insert into public.entity (name, parent_entity_id) values ($1, $2) returning id, name`,
        [name, req.body?.parentEntityId || null])).rows;
      invalidate();
      res.json({ ok: true, id: row.id, name: row.name });
    } catch (err) { fail(res, err); }
  });

  r.post('/api/properties/property', auth.require, guard, express.json({ limit: '16kb' }), async (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    const entityId = String(b.entityId || '');
    if (!entityId) return res.status(400).json({ error: 'A property has to belong to an entity' });
    if (!name) return res.status(400).json({ error: 'A property needs a name' });
    try {
      const cols = { entity_id: entityId, dba_name: name, ownership_status: 'held' };
      for (const k of ['street', 'city', 'state', 'zip']) {
        if (b[k] && String(b[k]).trim()) cols[k] = String(b[k]).trim();
      }
      const keys = Object.keys(cols);
      const [row] = (await ghlQuery(
        `insert into public.property (${keys.join(', ')})
         values (${keys.map((_, i) => '$' + (i + 1)).join(', ')}) returning id`,
        keys.map(k => cols[k]))).rows;
      /* The ownership row too, not just the column: the list view's tree is built
         from `ownership`, so a property created without one is invisible in it. */
      await ghlQuery(
        `insert into public.ownership (entity_id, property_id, is_primary) values ($1, $2, true)`,
        [entityId, row.id]);
      invalidate();
      res.json({ ok: true, id: row.id });
    } catch (err) { fail(res, err); }
  });

  return r;
}
