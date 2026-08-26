/* Properties — the portfolio, out of Supabase.

   Read-only. Six queries, joined in memory rather than in SQL, because the shape
   the view needs is a tree and Postgres would return it as a cross-product that
   costs more to unpick than to build.

   The tree is the point. A property belongs to the deepest entity that owns it,
   and debt and market value roll up through descendants — so "Acme Holdings"
   shows what its sub-entities hold too. Getting that wrong makes every number on
   the screen wrong, which is why placement is computed here once rather than in
   the browser per render.

   Two numbers deserve suspicion and get it:

     - `unit_count_reported` holds only the FIRST building's count. Summing it
       across a property under-reports badly (one property reads 26 against a
       real 87). Apartments come from SUM(unit.current_total_units) instead.
     - Debt is the latest balance per loan, not the loan's original amount, and a
       loan can be collateralised by a property OR by one of its buildings —
       counting only the former misses real debt. */

import express from 'express';
import { ghlQuery } from '../db/index.js';

const num = v => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* Two rate columns, and they disagree in type: interest_rate_pct is numeric,
   interest_rate is free text like "3.75%" or "SOFR + 2.5". Prefer the numeric
   one; parse the text only when it is a plain percentage, because guessing at a
   spread over an index would be inventing a number. */
function loanRate(l){
  if (l.interest_rate_pct !== null && l.interest_rate_pct !== undefined && l.interest_rate_pct !== '') {
    const n = Number(l.interest_rate_pct);
    if (Number.isFinite(n)) return n > 1 ? n / 100 : n;
  }
  const m = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(String(l.interest_rate || ''));
  return m ? Number(m[1]) / 100 : null;
}

/* Occupancy lives in three places and they are not equally trustworthy: a dated
   financial snapshot beats a column on the property, which beats averaging the
   buildings. The building average is weighted by unit count, because an
   unweighted mean lets an 8-unit outbuilding count as much as a 200-unit tower. */
function occupancyOf(p, fin, buildings){
  if (fin && fin.occupancy !== null && fin.occupancy !== undefined && fin.occupancy !== '') {
    const n = Number(fin.occupancy);
    if (Number.isFinite(n)) return n > 1 ? n / 100 : n;
  }
  if (p.current_occupancy !== null && p.current_occupancy !== undefined && p.current_occupancy !== '') {
    const n = Number(p.current_occupancy);
    if (Number.isFinite(n)) return n > 1 ? n / 100 : n;
  }
  let units = 0, sum = 0;
  for (const b of buildings) {
    const u = num(b.current_total_units);
    const o = b.occupancy === null || b.occupancy === undefined || b.occupancy === '' ? null : Number(b.occupancy);
    if (!u || o === null || !Number.isFinite(o)) continue;
    units += u; sum += (o > 1 ? o / 100 : o) * u;
  }
  return units ? sum / units : null;
}

/* Set by propertyRoutes so the detail routes can drop the list's cache after a
   write. A module-level handle rather than a shared module: there is exactly one
   properties router, and passing a setter through lib/app.js keeps the coupling
   visible at the mount point instead of hiding it in an import. */
export let invalidateProperties = () => {};

export function propertyRoutes({ env, auth }){
  const r = express.Router();
  const configured = Boolean(env.SUPABASE_DB_URL);

  let cache = null;      // { payload, at }
  /* An edit in the drawer has just made this stale in a way age cannot detect.
     Dropping it costs one rebuild; keeping it means the edit looks like it did
     nothing, which is the worst possible outcome of a successful write. */
  invalidateProperties = () => { cache = null; };
  let inFlight = null;
  const STALE_MS = 5 * 60 * 1000;

  async function build(){
    /* A MISSING TABLE is tolerable; a missing COLUMN is a bug in this file, and
       the two must not be treated alike.

       They were. `select ... name ... from public.loan` fails because loan has no
       name column, the catch matched /does not exist/, and the endpoint reported
       zero loans against a database holding seventy-five. The Debt view was empty
       and nothing anywhere said why. Every swallowed error is now recorded and
       returned, so an empty view can always be told apart from an empty table. */
    const problems = [];
    const q = (label, sql, params) => ghlQuery(sql, params).then(r2 => r2.rows).catch(err => {
      if (/relation .* does not exist/i.test(err.message)) {
        problems.push({ query: label, kind: 'missing-table', message: err.message });
        return [];
      }
      problems.push({ query: label, kind: 'failed', message: err.message });
      /* Rethrow anything that is not simply an absent table: a column typo must
         surface as a 502, not as a portfolio that looks debt-free. */
      throw err;
    });

    const [entities, properties, units, loans, collateral, balances, financials, parcels, ownership] =
      await Promise.all([
        q('entity', 'select id, name, parent_entity_id from public.entity order by name'),
        q('property', `select id, entity_id, dba_name, trade_name, street, city, state, zip,
                  current_market_value, current_market_value_asof, purchase_price, purchase_date,
                  management_company, asset_type, status, ownership_status, disposition_date,
                  unit_count_reported, unit_count_verified, num_buildings, year_built,
                  current_occupancy
             from public.property`),
        q('unit', `select id, property_id, unit_identifier, structure_type, current_total_units,
                  square_feet, year_built, occupancy
             from public.unit`),
        /* No `name` column on loan. The display name is built from what is there:
           loan_number, then the lender, then the type. */
        q('loan', `select id, loan_number, lender, lender_id, status, position, purpose, loan_type,
                  maturity_date, interest_rate, interest_rate_pct, origination_amount,
                  origination_date, borrower_entity_id, dscr
             from public.loan`),
        q('loan_collateral', 'select loan_id, property_id, unit_id from public.loan_collateral'),
        q('loan_balance', `select distinct on (loan_id) loan_id, balance, as_of_date
             from public.loan_balance order by loan_id, as_of_date desc`),
        q('property_financials', `select distinct on (property_id) property_id, as_of_date,
                  current_market_value, noi, occupancy, cap_rate, total_ltv
             from public.property_financials
            where property_id is not null order by property_id, as_of_date desc nulls last`),
        q('property_parcel', 'select property_id, parcel_number, county, is_primary from public.property_parcel'),
        q('ownership', 'select entity_id, property_id, unit_id, is_primary from public.ownership')
      ]);

    /* ---- indexes ---- */
    const unitsByProp = new Map();
    for (const u of units) {
      if (!u.property_id) continue;
      (unitsByProp.get(u.property_id) || unitsByProp.set(u.property_id, []).get(u.property_id)).push(u);
    }
    const balanceByLoan = new Map(balances.map(b => [b.loan_id, num(b.balance)]));
    const finByProp = new Map(financials.map(f => [f.property_id, f]));

    const parcelsByProp = new Map();
    for (const pc of parcels) {
      if (!pc.property_id) continue;
      (parcelsByProp.get(pc.property_id) || parcelsByProp.set(pc.property_id, []).get(pc.property_id)).push(pc);
    }

    /* A loan reaches a property directly, or through one of its buildings. */
    const unitOwner = new Map(units.map(u => [u.id, u.property_id]));
    const loansByProp = new Map();
    for (const c of collateral) {
      const pid = c.property_id || unitOwner.get(c.unit_id);
      if (!pid) continue;
      const set = loansByProp.get(pid) || new Set();
      set.add(c.loan_id);
      loansByProp.set(pid, set);
    }
    const loanById = new Map(loans.map(l => [l.id, l]));

    /* Every entity that owns a property: the property's own entity_id plus any
       ownership rows. Co-ownership is real here, so this is a set. */
    const ownersByProp = new Map();
    for (const p of properties) {
      const set = new Set();
      if (p.entity_id) set.add(p.entity_id);
      ownersByProp.set(p.id, set);
    }
    for (const o of ownership) {
      if (!o.property_id || !o.entity_id) continue;
      const set = ownersByProp.get(o.property_id);
      if (set) set.add(o.entity_id);
    }

    /* ---- shape each property ---- */
    const shaped = properties.map(p => {
      const bl = unitsByProp.get(p.id) || [];
      const loanIds = [...(loansByProp.get(p.id) || [])];
      const propLoans = loanIds.map(id => loanById.get(id)).filter(Boolean);
      const fin = finByProp.get(p.id);
      const pcs = parcelsByProp.get(p.id) || [];

      const debt = loanIds.reduce((a, id) => a + (balanceByLoan.get(id) || 0), 0);
      /* The financial snapshot wins when there is one: it is dated, the column is
         not. */
      const mv = fin && num(fin.current_market_value) ? num(fin.current_market_value)
        : num(p.current_market_value);

      const loanStatus = propLoans.some(l => l.status === 'active') ? 'active'
        : propLoans.some(l => l.status === 'pending') ? 'pending'
        : propLoans.length ? 'closed' : 'none';

      return {
        id: p.id,
        name: p.dba_name || p.trade_name || p.street || '(unnamed)',
        entityId: p.entity_id,
        owners: [...(ownersByProp.get(p.id) || [])],
        street: p.street, city: p.city, state: p.state, zip: p.zip,
        assetType: p.asset_type,
        status: p.status,
        ownershipStatus: String(p.ownership_status || 'unknown').toLowerCase(),
        dispositionDate: p.disposition_date,
        manager: p.management_company,
        yearBuilt: p.year_built,
        marketValue: mv,
        marketValueAsOf: fin?.as_of_date || p.current_market_value_asof || null,
        purchasePrice: num(p.purchase_price),
        purchaseDate: p.purchase_date,
        debt,
        noi: fin ? num(fin.noi) : 0,
        occupancy: occupancyOf(p, fin, bl),
        capRate: fin && fin.cap_rate !== null ? Number(fin.cap_rate) : null,
        loanStatus,
        loans: propLoans.map(l => ({
          id: l.id,
          /* Whatever identifies it to a human. Falling back to the lender beats
             a column of rows all reading "loan". */
          name: l.loan_number || [l.lender, l.loan_type].filter(Boolean).join(' ') || l.purpose || 'Loan',
          lender: l.lender,
          status: l.status, position: l.position, purpose: l.purpose,
          maturity: l.maturity_date,
          ratePct: loanRate(l),
          dscr: l.dscr === null ? null : Number(l.dscr),
          originationAmount: num(l.origination_amount),
          balance: balanceByLoan.get(l.id) || 0
        })),
        buildings: bl.length,
        /* Apartments from the buildings, never from unit_count_reported. */
        apartments: bl.reduce((a, u) => a + num(u.current_total_units), 0),
        unitsReported: num(p.unit_count_reported),
        unitsVerified: p.unit_count_verified === null ? null : num(p.unit_count_verified),
        parcels: pcs.map(x => ({ number: x.parcel_number, county: x.county, primary: Boolean(x.is_primary) }))
      };
    });

    /* ---- placement: the deepest owning entity ---- */
    const childrenOf = new Map();
    for (const e of entities) {
      if (!e.parent_entity_id) continue;
      (childrenOf.get(e.parent_entity_id) || childrenOf.set(e.parent_entity_id, []).get(e.parent_entity_id)).push(e.id);
    }
    const owns = (entityId, prop) => prop.owners.includes(entityId);
    const subtreeOwns = (entityId, prop) => {
      if (owns(entityId, prop)) return true;
      return (childrenOf.get(entityId) || []).some(c => subtreeOwns(c, prop));
    };
    const placedAt = entityId => shaped.filter(p =>
      owns(entityId, p) && !(childrenOf.get(entityId) || []).some(c => subtreeOwns(c, p)));

    const byEntity = new Map(entities.map(e => [e.id, { ...e, properties: [] }]));
    for (const e of entities) byEntity.get(e.id).properties = placedAt(e.id).map(p => p.id);

    /* Roll debt and value up through descendants, so a holding company shows what
       its sub-entities carry. */
    const propById = new Map(shaped.map(p => [p.id, p]));
    /* Sum over a SET of property ids, not over the tree.

       Co-ownership is real here: four TIC entities holding one building each get
       placed under all four, so adding subtree totals counted the same property
       four times -- one holding company read $124M of debt against a real $31M.
       Deduplicating by property id is the difference between a figure and a
       coincidence. */
    const subtreeProps = id => {
      const out = new Set(byEntity.get(id).properties);
      for (const c of childrenOf.get(id) || []) for (const pid of subtreeProps(c)) out.add(pid);
      return out;
    };
    const rollup = id => {
      const ids = subtreeProps(id);
      let debt = 0, mv = 0;
      for (const pid of ids) {
        const p = propById.get(pid);
        if (!p) continue;
        debt += p.debt; mv += p.marketValue;
      }
      return { count: ids.size, debt, mv };
    };

    const tree = entities
      .filter(e => !e.parent_entity_id)
      .map(function node(e){
        const roll = rollup(e.id);
        return {
          id: e.id, name: e.name,
          properties: byEntity.get(e.id).properties,
          children: (childrenOf.get(e.id) || []).map(cid => node(byEntity.get(cid))),
          ...roll
        };
      });

    const orphans = shaped.filter(p => !p.owners.length).map(p => p.id);

    return {
      entities: entities.map(e => ({ id: e.id, name: e.name, parentId: e.parent_entity_id })),
      tree,
      properties: shaped,
      orphans,
      /* Empty because there is nothing, or empty because a query broke? The UI
         cannot tell the difference on its own, so it is told. */
      problems,
      totals: {
        properties: shaped.length,
        entities: entities.length,
        buildings: units.length,
        apartments: shaped.reduce((a, p) => a + p.apartments, 0),
        debt: [...balanceByLoan.values()].reduce((a, b) => a + b, 0),
        marketValue: shaped.reduce((a, p) => a + p.marketValue, 0),
        loans: loans.length
      },
      generatedAt: new Date().toISOString()
    };
  }

  function refresh(){
    if (inFlight) return inFlight;
    inFlight = build()
      .then(payload => { cache = { payload, at: Date.now() }; return payload; })
      .finally(() => { inFlight = null; });
    return inFlight;
  }

  r.get('/api/properties', auth.require, async (req, res) => {
    if (!configured) {
      return res.json({
        configured: false,
        reason: 'SUPABASE_DB_URL is not set, so there is no portfolio to read.',
        entities: [], tree: [], properties: [], totals: null
      });
    }
    try {
      if (!cache || req.query.force === '1' || Date.now() - cache.at > STALE_MS) await refresh();
      res.json({
        configured: true,
        ...cache.payload,
        cachedAt: new Date(cache.at).toISOString(),
        ageMs: Date.now() - cache.at
      });
    } catch (err) {
      if (cache) {
        return res.json({
          configured: true, ...cache.payload,
          cachedAt: new Date(cache.at).toISOString(), ageMs: Date.now() - cache.at,
          error: err.message
        });
      }
      res.status(502).json({ configured: true, error: err.message, entities: [], tree: [], properties: [] });
    }
  });

  return r;
}
