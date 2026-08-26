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

export function propertyRoutes({ env, auth }){
  const r = express.Router();
  const configured = Boolean(env.SUPABASE_DB_URL);

  let cache = null;      // { payload, at }
  let inFlight = null;
  const STALE_MS = 5 * 60 * 1000;

  async function build(){
    const q = (sql, params) => ghlQuery(sql, params).then(r2 => r2.rows).catch(err => {
      /* A missing optional table should not empty the whole portfolio. */
      if (/does not exist/i.test(err.message)) return [];
      throw err;
    });

    const [entities, properties, units, loans, collateral, balances, financials, parcels, ownership] =
      await Promise.all([
        q('select id, name, parent_entity_id from public.entity order by name'),
        q(`select id, entity_id, dba_name, trade_name, street, city, state, zip,
                  current_market_value, current_market_value_asof, purchase_price, purchase_date,
                  management_company, asset_type, status, ownership_status, disposition_date,
                  unit_count_reported, unit_count_verified, num_buildings, year_built
             from public.property`),
        q(`select id, property_id, unit_identifier, structure_type, current_total_units,
                  square_feet, year_built
             from public.unit`),
        q(`select id, name, loan_number, lender, status, position, maturity_date,
                  interest_rate_pct, origination_amount, borrower_entity_id
             from public.loan`),
        q('select loan_id, property_id, unit_id from public.loan_collateral'),
        q(`select distinct on (loan_id) loan_id, balance, as_of_date
             from public.loan_balance order by loan_id, as_of_date desc`),
        q(`select distinct on (property_id) property_id, as_of_date, current_market_value, noi, occupancy
             from public.property_financials
            where property_id is not null order by property_id, as_of_date desc nulls last`),
        q('select property_id, parcel_number, county, is_primary from public.property_parcel'),
        q('select entity_id, property_id, unit_id, is_primary from public.ownership')
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
        occupancy: fin?.occupancy ?? null,
        loanStatus,
        loans: propLoans.map(l => ({
          id: l.id, name: l.name || l.loan_number || 'loan', lender: l.lender,
          status: l.status, position: l.position, maturity: l.maturity_date,
          ratePct: l.interest_rate_pct === null ? null : Number(l.interest_rate_pct),
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
