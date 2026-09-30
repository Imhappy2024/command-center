-- Read-only RPCs for the Financial reports dashboard.
--
-- SECURITY INVOKER on purpose. Every source table has RLS on with
-- "tenant_id in (select current_tenant_ids())" for authenticated users, so
-- these run as the caller and a non-member gets empty arrays rather than an
-- error. A SECURITY DEFINER function here would hand the whole ledger to
-- anybody who could call it.
--
-- search_path is pinned so the function body cannot be redirected by a
-- caller's own search_path.

-- ---------------------------------------------------------------------------
-- Company reports: ONE json object, shaped exactly like the page's old
-- LLS_SNAPSHOT so nothing downstream has to change.
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_company_data(p_entity uuid)
returns json language sql stable security invoker set search_path = public as $fn$
select json_build_object(
  'pl_accounts', (select coalesce(json_agg(json_build_object('a', a.qb_name, 't', a.account_type, 'p', pa.qb_name, 'o', a.sort_order) order by a.sort_order), '[]'::json)
     from gl_account a left join gl_account pa on pa.id = a.parent_account_id
    where a.entity_id = p_entity and a.source_system = 'quickbooks' and a.is_active and a.account_type in ('income','expense')),
  'pl_amounts', (select coalesce(json_agg(json_build_object('a', a.qb_name, 'y', p.period_year, 'm', p.period_month, 'v', p.amount)), '[]'::json)
     from gl_period_amount p join gl_account a on a.id = p.gl_account_id
    where p.entity_id = p_entity and p.accounting_basis = 'cash'),
  'balances', (select coalesce(json_agg(json_build_object('a', a.qb_name, 't', a.account_type, 's', a.report_section, 'd', b.as_of_date, 'v', b.balance)), '[]'::json)
     from gl_balance b join gl_account a on a.id = b.gl_account_id
    where b.entity_id = p_entity and b.accounting_basis = 'cash'),
  'loans', (select coalesce(json_agg(json_build_object('n', l.loan_number, 'name', i.name, 'fund', l.fund, 'status', l.status, 'entity', ie.name, 'acct', a.qb_name) order by l.loan_number), '[]'::json)
     from investor_loan l join investor i on i.id = l.investor_id left join entity ie on ie.id = i.entity_id left join gl_account a on a.id = l.gl_account_id
    where l.entity_id = p_entity),
  -- Only 'active'. Older copies of a payment, superseded by a newer report,
  -- stay in the table and would double the totals if they were included.
  'payments', (select coalesce(json_agg(json_build_object('date', p.txn_date, 'type', p.txn_type, 'num', p.txn_num, 'name', p.name_raw, 'memo', p.memo, 'split', p.split_raw, 'amount', p.amount, 'loan', l.loan_number) order by p.txn_date, p.name_raw), '[]'::json)
     from investor_payment p left join investor_loan l on l.id = p.investor_loan_id
    where p.entity_id = p_entity and p.source_status = 'active'),
  'docs', (select coalesce(json_agg(json_build_object('file', d.file_name, 'status', d.extraction_status, 'generated', d.report_generated_at) order by d.report_generated_at desc), '[]'::json)
     from document d where d.entity_id = p_entity and d.source_system = 'quickbooks'),
  'fetched_at', now())
$fn$;

-- ---------------------------------------------------------------------------
-- Property T12s: a json ARRAY, newest report per property, leaf lines only.
-- Group totals are computed client side, so only is_total = false is returned.
-- ---------------------------------------------------------------------------
create or replace function public.dashboard_t12_data()
returns json language sql stable security invoker set search_path = public as $fn$
with acc as (
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
  order by coalesce(p.dba_name, p.trade_name)), '[]'::json)
from latest r join property p on p.id = r.property_id
$fn$;

-- The browser calls these as an authenticated user. anon gets nothing, so an
-- unsigned page cannot read the ledger even with the publishable key.
revoke all on function public.dashboard_company_data(uuid), public.dashboard_t12_data() from public, anon;
grant execute on function public.dashboard_company_data(uuid), public.dashboard_t12_data() to authenticated;
