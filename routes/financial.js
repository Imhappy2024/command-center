/* The Financial section's data.

   The reports themselves started life as a standalone page reading Supabase
   over its HTTP API, with a publishable key and a browser sign-in. None of
   that is needed here: command-center already holds a connection to the same
   database and already knows who you are, so the SQL runs server side behind
   the session this app already requires, and no key goes anywhere near a
   browser.

   Two report families, from one read:

   Company  -- the ledger for one entity. Chart of accounts, period amounts,
               balances, investor loans, investor payments, and the documents
               the figures were extracted from.
   T12      -- the newest trailing-twelve report per property, as leaf lines
               with twelve monthly amounts each.

   Both are shaped exactly as the reports page consumes them, deliberately:
   the field names are one letter because a T12 payload is thirty thousand
   numbers and the key names were most of the bytes. */

import express from 'express';
import { ghlQuery } from '../db/index.js';

/* The companies the Company tab can show. One line per company; `source` says
   which ledger shape its numbers come in. QuickBooks is a full ledger (P&L,
   balance sheet, investor loans and payments); AppFolio is a monthly cash flow
   report (income, expense, "other items" and a cash summary). */
export const COMPANIES = [
  { id: 'd050000a-0616-497e-b8ce-aa699164c5a8', name: 'Liquid Lending Solutions', short: 'Liquid Lending', source: 'quickbooks', brand: 'c0000000-0000-4000-8000-000000000004' },
  { id: '5e6213aa-023d-4fa0-8f93-70d5eded0aec', name: 'LeavenWealth Holdings LLC', short: 'LeavenWealth Holdings', source: 'appfolio', brand: 'c0000000-0000-4000-8000-000000000003' },
  { id: '8bd3c562-1feb-4e85-b363-bc21aebff616', name: 'LeadLi Consulting LLC', short: 'LeadLi', source: 'appfolio', brand: 'c0000000-0000-4000-8000-000000000001' },
  { id: '32bec21a-b52f-49db-93fb-fea5a594b480', name: 'Folio Excel LLC', short: 'Folio', source: 'appfolio', brand: 'c0000000-0000-4000-8000-000000000002' }
];

/* The QuickBooks company. FINANCIAL_ENTITY_ID still overrides it, as before. */
const DEFAULT_ENTITY = COMPANIES[0].id;

/* ---- AppFolio companies ----

   account_type cash_movement is AppFolio's "Other Items" (contributions,
   distributions, work in progress, intercompany transfers), stored as the cash
   effect: positive is cash in. Expenses are positive, as AppFolio prints them.
   cash_flow_month is the report's own summary, one row per month; its ending
   cash is a balance, so the page takes the latest month rather than a sum. */
const APPFOLIO_SQL = `select
  (select coalesce(json_agg(json_build_object('a', a.qb_name, 'name', a.name, 't', a.account_type, 's', a.report_section, 'o', a.sort_order) order by a.sort_order), '[]'::json)
     from gl_account a where a.entity_id = $1 and a.source_system = 'appfolio' and a.is_active) as accounts,
  (select coalesce(json_agg(json_build_object('a', a.qb_name, 'y', p.period_year, 'm', p.period_month, 'v', p.amount)), '[]'::json)
     from gl_period_amount p join gl_account a on a.id = p.gl_account_id
    where p.entity_id = $1 and a.source_system = 'appfolio' and p.accounting_basis = 'cash') as amounts,
  (select coalesce(json_agg(json_build_object('y', c.period_year, 'm', c.period_month, 'total_income', c.total_income, 'total_expense', c.total_expense,
            'noi', c.noi, 'net_income', c.net_income, 'net_other_items', c.net_other_items, 'cash_flow', c.cash_flow, 'beginning_cash', c.beginning_cash,
            'actual_ending_cash', c.actual_ending_cash, 'ending_cash_difference', c.ending_cash_difference) order by c.period_year, c.period_month), '[]'::json)
     from cash_flow_month c where c.entity_id = $1 and c.source_system = 'appfolio' and c.accounting_basis = 'cash') as cash,
  (select coalesce(json_agg(json_build_object('file', d.file_name, 'status', d.extraction_status, 'generated', d.report_generated_at) order by d.report_generated_at desc), '[]'::json)
     from document d where d.entity_id = $1 and d.source_system = 'appfolio') as docs`;

/* ---- company ----

   Investor payments are filtered to source_status = 'active'. A payment
   superseded by a later report stays in the table, so without this the totals
   double and the page reports money that was counted twice. */
const COMPANY_SQL = `select
  (select coalesce(json_agg(json_build_object('a', a.qb_name, 't', a.account_type, 'p', pa.qb_name, 'o', a.sort_order) order by a.sort_order), '[]'::json)
     from gl_account a left join gl_account pa on pa.id = a.parent_account_id
    where a.entity_id = $1 and a.source_system = 'quickbooks' and a.is_active
      and a.account_type in ('income','expense')) as pl_accounts,
  (select coalesce(json_agg(json_build_object('a', a.qb_name, 'y', p.period_year, 'm', p.period_month, 'v', p.amount)), '[]'::json)
     from gl_period_amount p join gl_account a on a.id = p.gl_account_id
    where p.entity_id = $1 and p.accounting_basis = 'cash') as pl_amounts,
  (select coalesce(json_agg(json_build_object('a', a.qb_name, 't', a.account_type, 's', a.report_section, 'd', b.as_of_date, 'v', b.balance)), '[]'::json)
     from gl_balance b join gl_account a on a.id = b.gl_account_id
    where b.entity_id = $1 and b.accounting_basis = 'cash') as balances,
  (select coalesce(json_agg(json_build_object('n', l.loan_number, 'name', i.name, 'fund', l.fund, 'status', l.status, 'entity', ie.name, 'acct', a.qb_name) order by l.loan_number), '[]'::json)
     from investor_loan l join investor i on i.id = l.investor_id
     left join entity ie on ie.id = i.entity_id
     left join gl_account a on a.id = l.gl_account_id
    where l.entity_id = $1) as loans,
  (select coalesce(json_agg(json_build_object('date', p.txn_date, 'type', p.txn_type, 'num', p.txn_num, 'name', p.name_raw, 'memo', p.memo, 'split', p.split_raw, 'amount', p.amount, 'loan', l.loan_number) order by p.txn_date, p.name_raw), '[]'::json)
     from investor_payment p left join investor_loan l on l.id = p.investor_loan_id
    where p.entity_id = $1 and p.source_status = 'active') as payments,
  (select coalesce(json_agg(json_build_object('file', d.file_name, 'status', d.extraction_status, 'generated', d.report_generated_at) order by d.report_generated_at desc), '[]'::json)
     from document d where d.entity_id = $1 and d.source_system = 'quickbooks') as docs`;

/* ---- T12 ----

   Leaf lines only (is_total = false); the group subtotals are computed in the
   page, because a stored total and a summed one disagreeing is a bug nobody
   sees until a board meeting.

   The cross join against generate_series is what guarantees twelve values per
   line even where a month has no row: a ragged array would silently shift
   every later month one column left. */
const T12_SQL = `with acc as (
  select l.t12_report_id rid, l.section, l.account_path, min(l.sort_order) so
    from t12_report_line l where not l.is_total group by 1, 2, 3),
grid as (
  select a.rid, a.section, a.account_path, a.so, m.mo,
         coalesce((select sum(x.amount) from t12_report_line x
                    where x.t12_report_id = a.rid and not x.is_total and x.section = a.section
                      and x.account_path = a.account_path and x.month = m.mo), 0) amt
    from acc a join t12_report r on r.id = a.rid
    cross join lateral generate_series(r.period_start, r.period_end, interval '1 month') m(mo)),
lines as (select rid, section, account_path, so, array_agg(amt order by mo) vals from grid group by 1, 2, 3, 4),
latest as (select distinct on (property_id) * from t12_report order by property_id, period_end desc, created_at desc)
select coalesce(json_agg(json_build_object(
  'p', coalesce(p.dba_name, p.trade_name), 'c', coalesce(p.city, ''),
  'm', (select array_agg(to_char(g, 'YYYY-MM') order by g) from generate_series(r.period_start, r.period_end, interval '1 month') g),
  'l', (select json_agg(json_build_array(case section when 'income' then 'i' when 'operating_expense' then 'o'
                                                        when 'non_operating_income' then 'ni' else 'ne' end,
                                         array_to_string(account_path, ' > '), vals) order by so) from lines where rid = r.id),
  't', json_build_array(r.total_income, r.total_operating_expense, r.noi, r.total_non_operating, r.net_income))
  order by coalesce(p.dba_name, p.trade_name)), '[]'::json) as t12
from latest r join property p on p.id = r.property_id`;

export function financialRoutes({ env, auth }){
  const r = express.Router();
  const configured = Boolean(env.SUPABASE_DB_URL);
  const entity = String(env.FINANCIAL_ENTITY_ID || '').trim() || DEFAULT_ENTITY;

  let cache = null;          // { payload, at }
  let inFlight = null;
  const STALE_MS = 5 * 60 * 1000;

  async function build(){
    /* A missing TABLE is tolerable and a broken QUERY is a bug in this file,
       and the two must not look alike from outside. Properties learned this
       the hard way: a bad column name was swallowed as "no rows" and the view
       sat empty with nothing saying why. Every failure is recorded and
       returned, so an empty report can always be told from an empty table. */
    const problems = [];
    const one = (label, sql, params) => ghlQuery(sql, params).then(res => res.rows[0] || null)
      .catch(err => {
        problems.push({
          query: label,
          kind: /relation .* does not exist/i.test(err.message) ? 'missing-table' : 'failed',
          message: err.message
        });
        return null;
      });

    const appfolio = COMPANIES.filter((c) => c.source === 'appfolio');
    const [co, t12row, ...af] = await Promise.all([
      one('company', COMPANY_SQL, [entity]),
      one('t12', T12_SQL, []),
      ...appfolio.map((c) => one('appfolio:' + c.short, APPFOLIO_SQL, [c.id]))
    ]);
    const company = co || { pl_accounts: [], pl_amounts: [], balances: [], loans: [], payments: [], docs: [] };
    const afData = new Map(appfolio.map((c, i) => [c.id, af[i] || { accounts: [], amounts: [], cash: [], docs: [] }]));

    return {
      entity,
      company,
      /* Every company with its own data, so switching between them in the page
         is a lookup rather than a second read -- and can never show one
         company's numbers under another's name while a request is in flight. */
      companies: COMPANIES.map((c) => ({
        id: c.source === 'quickbooks' ? entity : c.id, name: c.name, short: c.short, source: c.source, brand: c.brand,
        data: c.source === 'quickbooks' ? company : afData.get(c.id)
      })),
      t12: (t12row && t12row.t12) || [],
      problems,
      fetchedAt: new Date().toISOString()
    };
  }

  /* One rebuild at a time. Two tabs opening at once used to mean two of these
     queries in flight, and the T12 one is not cheap. */
  async function refresh(){
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try { cache = { payload: await build(), at: Date.now() }; }
      finally { inFlight = null; }
    })();
    return inFlight;
  }

  r.get('/api/financial', auth.require, async (req, res) => {
    if (!configured) {
      return res.json({
        configured: false,
        reason: 'SUPABASE_DB_URL is not set, so there is no ledger to read.',
        company: null, t12: [], problems: []
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
      /* Stale beats blank. A reader who can see the last good numbers and a
         note that the refresh failed is better served than one staring at an
         error where the reports were. */
      if (cache) {
        return res.json({
          configured: true, ...cache.payload,
          cachedAt: new Date(cache.at).toISOString(),
          ageMs: Date.now() - cache.at,
          error: err.message
        });
      }
      res.status(502).json({ error: 'financial_read_failed', detail: err.message });
    }
  });

  return r;
}
