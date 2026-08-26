/* One property, in full — and the writes that go with it.

   The list in routes/properties.js answers "what do we own"; this answers "what
   do we know about this one, and let me fix it".

   The shape is the one the Leavenwealth dashboard uses, because the labels are
   the point. `dba_name` is not "Dba name", it is "DBA Name / Name of Apartment
   Complex" -- the name the people who maintain this data use for it, carried
   over from the ClickUp fields the database was migrated out of. Renaming them
   to whatever a snake_case-to-Title-Case function produces would make the record
   unrecognisable to the only people who read it.

   So every field is { id, name, type, value, display } keyed by its normalised
   label, and the id encodes where a write goes:

     p:<col>                 the property row
     u:<unitId>:<col>        a building
     l:<loanId>:<col>        a loan
     f:<finId>:<col>         a financial snapshot
     i:<insId|new>:<col>     the property's insurance policy
     iu:<insId|new>:<col>    a building's insurance policy
     ownerentity             the property's primary owner (ownership + entity_id)
     ownerentityunit:<unitId> a building's primary owner
     loanstatus:<propId>     every loan secured against the property

   Types come from information_schema, not from guessing at the column name, and
   that same lookup is what stops a column name arriving from the browser from
   reaching a query. */

import express from 'express';
import { ghlQuery, ghlClient } from '../db/index.js';

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const money = n => '$' + Math.round(Number(n) || 0).toLocaleString();

/* ---- the label sets, carried over from the migration ------------------- */

const PROP_LABELS = [
  ['dba_name', 'DBA Name / Name of Apartment Complex'], ['trade_name', 'Trade Name'],
  ['management_company', 'Management Company'],
  ['street', 'Location Street Address'], ['city', 'Location City'],
  ['state', 'Location State'], ['zip', 'Location Zip'],
  ['county_assessor_url', 'County Assessor Website'], ['dropbox_url', 'Dropbox Link'],
  ['purchase_price', 'Purchase Price'], ['purchase_date', 'Purchase Date'],
  ['purchase_price_note', 'Purchase Price Note'],
  ['current_market_value', 'Current Market Value'],
  ['current_market_value_2023', "Current Market Value (23')"],
  ['current_market_value_asof', 'Market Value As Of'],
  ['year_built', 'Year Built'], ['year_renovated', 'Year Renovated'],
  ['square_feet', 'Square Feet'], ['stories', '# of Stories'],
  ['num_buildings', '# of Buildings'], ['lot_size_acres', 'Lot Size (Acres)'],
  ['unit_count_reported', 'Total Units'], ['unit_count_verified', 'Total Units (Verified)'],
  ['unit_count_verified_by', 'Verified By'], ['unit_count_note', 'Unit Count Note'],
  ['construction_type', 'Building Construction'],
  ['asset_type', 'Asset Type'], ['status', 'Status'], ['taxpayer', 'Taxpayer'],
  ['year_acquired', 'Year Acquired'], ['current_occupancy', 'Current Occupancy'],
  ['ownership_status', 'Ownership Status'], ['disposition_date', 'Disposition Date'],
  ['disposition_note', 'Disposition Note'],
  ['pool', 'Pool'], ['pool_count', 'Pools'], ['dog_park', 'Dog Park'],
  ['dog_park_count', 'Dog Parks'], ['vehicles', 'Vehicles'],
  ['fire_alarm', 'Fire Alarm'], ['sprinklered', 'Sprinklered'],
  ['roof_year', 'Roofing Year'], ['wiring_year', 'Wiring Year'],
  ['plumbing_year', 'Plumbing Year'], ['heating_year', 'Heating Year'],
  ['service_provider', 'Service Provider'],
  ['reviews_property_tax', 'Does LWC Review Property Tax Payments?'],
  ['reposition_cadence', 'Reposition Cadence'], ['collateral_notes', 'Collateral']
];

const UNIT_LABELS = [
  ['dba_name', 'DBA Name / Name of Apartment Complex'], ['parcel_id', 'Parcel ID'],
  ['building_number', 'Building #'], ['structure_type', 'Occupancy / Type of Asset'],
  ['structure_note', 'Structure Note'], ['building_type', 'Building Type'],
  ['building_purpose', 'Building Purpose'],
  ['year_built', 'Year Built'], ['construction_type', 'Building Construction'],
  ['stories', '# of Stories'], ['square_feet', 'Square Feet'],
  ['beds', 'Beds'], ['baths', 'Baths'], ['status', 'Status'],
  ['location_street', 'Location Street Address'], ['location_city', 'Location City'],
  ['location_state', 'Location State'], ['location_zip', 'Location Zip'],
  ['current_market_value', 'Current Market Value'],
  ['current_market_value_2023', "Current Market Value (23')"],
  ['num_buildings', '# of Buildings'],
  ['asset_type_purchase', 'Asset Type (at Purchase)'], ['asset_type_today', 'Asset Type (Today)'],
  ['asset_status_takeover', 'Asset Status (at Takeover)'], ['asset_status_today', 'Asset Status (Today)'],
  ['original_total_units', 'Original Total Units'], ['current_total_units', 'Current Total Units'],
  ['occupancy', 'Occupancy'], ['unit_count_note', 'Unit Count Note'],
  ['tax_escrow', 'Tax Escrow'], ['insurance_escrow', 'Insurance Escrow'],
  ['replacement_reserve', 'Replacement Reserve'], ['replacement_reserve_notes', 'Replacement Reserve Notes'],
  ['replacement_reserve_draw_criteria', 'Reserve Draw Criteria'],
  ['replacement_reserve_funding_replenishment', 'Reserve Funding / Replenishment'],
  ['replacement_reserve_last_draw_date', 'Reserve Last Draw Date'],
  ['replacement_reserve_last_draw_amount', 'Reserve Last Draw Amount'],
  ['replacement_reserve_remaining_balance', 'Reserve Remaining Balance'],
  ['escrow_taxes', 'Escrow - Taxes'], ['escrow_insurance', 'Escrow - Insurance'],
  ['escrow_replacement_reserve', 'Escrow - Replacement Reserve'], ['escrow_note', 'Escrow Note'],
  ['property_insurance_financing', 'Property Insurance Financing'],
  ['property_insurance_vendor', 'Property Insurance Vendor'],
  ['pool', 'Pool'], ['pool_count', 'Pools'], ['vehicles', 'Vehicles'],
  ['dog_park', 'Dog Park'], ['dog_park_count', 'Dog Parks'],
  ['onsite_washer_dryer', 'Onsite Washer/Dryer'], ['inunit_washer_dryer', 'In-unit Washer/Dryer'],
  ['common_area_washer_dryer', 'Common-area Washer/Dryer'], ['hoa', 'HOA'],
  ['rubs_at_takeover', 'RUBS at Takeover'], ['rubs_implemented', 'RUBS Implemented'],
  ['fire_alarm', 'Fire Alarm'], ['sprinklered', 'Sprinklered'],
  ['roof_year', 'Roofing Year'], ['wiring_year', 'Wiring Year'],
  ['plumbing_year', 'Plumbing Year'], ['heating_year', 'Heating Year'],
  ['asset_management_fee_pct', 'Asset Management Fee %'],
  ['asset_management_fee_vendor', 'Asset Mgmt Fee Vendor'],
  ['asset_management_fee_tracker_url', 'Asset Mgmt Fee Tracker'],
  ['attorney_vendor', 'Attorney Vendor']
];

const LOAN_LABELS = [
  ['lender', 'Lender'], ['loan_number', 'Loan Number'], ['loan_type', 'Loan Type'],
  ['position', 'Position'], ['recourse', 'Recourse'], ['purpose', 'Purpose'],
  ['amortizing_type', 'Amortizing Type'],
  ['origination_amount', 'Loan Origination Amount'], ['origination_date', 'Loan Origination Date'],
  ['maturity_date', 'Maturity Date'],
  ['interest_rate', 'Interest Rate'], ['interest_rate_pct', 'Interest Rate %'],
  ['interest_rate_min', 'Interest Rate Min'], ['interest_rate_max', 'Interest Rate Max'],
  ['interest_type', 'Interest Type'], ['amortization', 'Amortization'],
  ['balloon_payment', 'Balloon Payment'], ['balloon_payment_notes', 'Balloon Payments'],
  ['interest_only_end_date', 'End IO Period'], ['index', 'Index'],
  ['variable_rate_floor', 'Variable Rate Floor'], ['variable_rate_max', 'Variable Rate Max'],
  ['rate_change_limitation', 'Rate Change Limitation per Change Date'],
  ['previous_interest_reset_date', 'Previous Interest Reset Date'],
  ['next_interest_reset_date', 'Next Interest Reset Date'],
  ['interest_reset_cadence', 'Interest Reset Cadence'],
  ['payment_frequency', 'Payment Frequency'], ['debt_service', 'Debt Service'], ['dscr', 'DSCR'],
  ['repayment_fee', 'Repayment Fee'], ['prepayment_penalties', 'Prepayment Penalties'],
  ['extension_available', 'Extension Available'], ['extension_requirements', 'Extension Requirements'],
  ['has_escrow', 'Has Escrow'], ['escrow_taxes', 'Escrow - Taxes'],
  ['escrow_insurance', 'Escrow - Insurance'],
  ['escrow_replacement_reserve', 'Escrow - Replacement Reserve'], ['escrow_note', 'Escrow Note'],
  ['debt_paid_by', 'Debt Paid By'],
  ['loc_beginning', 'Beginning LOC'], ['loc_available', 'Available LOC'],
  ['avail_escrow_reserve', 'Avail Escrow/Reserve'], ['loc_draws_process', 'LOC Draws Process'],
  ['loc_hurdle', 'LOC Hurdle'], ['loc_hurdle_remaining', 'LOC Hurdle Remaining'],
  ['loc_availability_maturity_date', 'LOC Availability Maturity'],
  ['lender_held_cash_reserve', 'Lender Held Cash Reserve'],
  ['distribution_frequency_restrictions', 'Distribution Frequency Restrictions'],
  ['pac_due', 'PAC DUE'], ['ppt_split_ratio', 'PPT Split Ratio'],
  ['primary_mortgage', 'Primary Mortgage'], ['bridge', 'Bridge'],
  ['construction_note', 'Construction Note'], ['construction_budget_amount', 'Construction Budget'],
  ['has_construction_budget', 'Has Construction Budget'],
  ['construction_budget_dropbox_url', 'Construction Budget (Dropbox)'],
  ['lien_waivers_required', 'Lien Waivers Required'],
  ['pace_equity', 'PACE Equity'], ['seller_carry', 'Seller Carry/Financing'],
  ['is_tif', 'TIF'], ['hud_audit', 'HUD Audit'],
  ['covenant_lender_operating_account', 'Covenants - Lender Operating Account'],
  ['covenant_audit', 'Covenant - Audit'],
  ['covenant_replacement_reserve', 'Covenants - Replacement Reserve'],
  ['covenant_distribution_frequency', 'Covenants - Distribution Frequency'],
  ['last_draw_amount', 'Last Draw Amount'], ['amount_left_to_draw', 'Amount Left to Draw'],
  ['last_draw_date', 'Last Draw Date'],
  ['balloon_reposition_normal', 'Balloon / Reposition Normal'],
  ['next_reposition_date', 'Next Reposition Date'], ['last_reposition_date', 'Last Reposition Date']
];

const INS_LABELS = [
  ['carrier', 'Insurance Carrier'], ['annual_premium', 'Insurance Annual Premium'],
  ['renewal_date', 'Insurance Renewal Date'], ['tiv', 'TIV  (Total Insured Value)'],
  ['tiv_basis', 'TIV Basis'],
  ['building_limit_amount', 'Building Limit (Replacement Cost)'],
  ['building_limit_replacement_cost', 'Building Limit (text)'],
  ['building_limit_basis', 'Building Limit Basis'],
  ['business_personal_property', 'Business Personal Property'],
  ['business_personal_property_basis', 'BPP Basis'],
  ['business_income_amount', 'Business Income Limit'],
  ['business_income_extra_expense_limit', 'Business Income & Extra Expense Limit'],
  ['business_income_basis', 'Business Income Basis'],
  ['all_other_perils_deductible', 'All Other Perils Deductible'],
  ['aop_deductible_amount', 'AOP Deductible ($)'], ['aop_deductible_pct', 'AOP Deductible (%)'],
  ['aop_deductible_basis', 'AOP Deductible Basis'],
  ['wind_hail_deductible', 'Wind/Hail Deductible'],
  ['wind_deductible_amount', 'Wind/Hail Deductible ($)'],
  ['wind_deductible_pct', 'Wind/Hail Deductible (%)'],
  ['wind_deductible_min', 'Wind/Hail Minimum ($)'],
  ['wind_deductible_basis', 'Wind/Hail Basis'], ['wind_applies_per', 'Wind/Hail Applies Per'],
  ['water_damage_deductible', 'Water Damage Deductible'],
  ['water_deductible_amount', 'Water Deductible ($)'],
  ['deductible_note', 'Deductible Note'], ['limits_note', 'Limits Note'],
  ['broker', 'Broker'], ['broker_contact_name', 'Broker Contact'],
  ['broker_contact_email', 'Broker Email'], ['policy_note', 'Policy Note']
];

const FIN_LABELS = [
  ['as_of_date', 'As Of'], ['egi', 'EGI'], ['operating_expenses', 'Operating Expenses'],
  ['noi', 'NOI'], ['current_market_value', 'Current Market Value'], ['fmv_notes', 'FMV Notes'],
  ['occupancy', 'Occupancy'], ['cap_rate', 'Cap Rate'], ['dcr', 'DCR'],
  ['property_equity', 'Property Equity'], ['value_per_unit', 'Value per Unit'],
  ['total_ltv', 'Total LTV'],
  ['projected_annual_owner_net_distributions', 'Projected Owner Distributions'],
  ['projected_annual_owner_net_contributions', 'Projected Owner Contributions'],
  ['post_distribution_dcr', 'Post-distribution DCR'], ['notes', 'Notes']
];

/* Which section of the record a field belongs in. Anything unmapped falls into
   "Other" rather than being dropped -- a column nobody has classified yet is
   still a column somebody entered data into. */
const GROUPS = {
  'Property': ['DBA Name / Name of Apartment Complex', 'Trade Name', 'Owner Entity',
    'Management Company', 'Location Street Address', 'Location City', 'Location State',
    'Location Zip', 'Parcel ID', 'Square Feet', 'Total Units', 'Total Units (Verified)',
    'Verified By', 'Unit Count Note', 'Year Built', 'Year Renovated', '# of Stories',
    '# of Buildings', 'Lot Size (Acres)', 'Building Construction', 'Asset Type', 'Status',
    'Taxpayer', 'Year Acquired', 'Current Occupancy', 'Purchase Price', 'Purchase Date',
    'Purchase Price Note', 'Current Market Value', "Current Market Value (23')",
    'Market Value As Of', 'County Assessor Website', 'Dropbox Link', 'Service Provider',
    'Reposition Cadence', 'Deal', 'Ownership Status', 'Disposition Date', 'Disposition Note',
    'Building #', 'Occupancy / Type of Asset', 'Structure Note', 'Building Type',
    'Building Purpose', 'Beds', 'Baths', 'Original Total Units', 'Current Total Units',
    'Occupancy', 'Asset Type (at Purchase)', 'Asset Type (Today)',
    'Asset Status (at Takeover)', 'Asset Status (Today)'],
  'Amenities & Systems': ['Pool', 'Pools', 'Dog Park', 'Dog Parks', 'Vehicles', 'Fire Alarm',
    'Sprinklered', 'Roofing Year', 'Wiring Year', 'Plumbing Year', 'Heating Year',
    'Onsite Washer/Dryer', 'In-unit Washer/Dryer', 'Common-area Washer/Dryer', 'HOA',
    'RUBS at Takeover', 'RUBS Implemented'],
  'Loan & Debt': ['Lender', 'Loan Number', 'Loan Type', 'Position', 'Recourse', 'Purpose',
    'Loan Origination Amount', 'Loan Origination Date', 'Maturity Date',
    'Current Debt as of (09/30/24)', 'DSCR', 'Interest Rate', 'Interest Rate %',
    'Interest Type', 'Amortization', 'Amortizing Type', 'Balloon Payment', 'Balloon Payments',
    'Prepayment Penalties', 'Payment Frequency', 'End IO Period', 'Available LOC',
    'Beginning LOC', 'Avail Escrow/Reserve', 'Debt Paid By', 'Collateral', 'Loan Status',
    'Debt Service', 'Tax Escrow', 'Insurance Escrow', 'Replacement Reserve',
    'Replacement Reserve Notes', 'Reserve Draw Criteria', 'Reserve Funding / Replenishment',
    'Reserve Last Draw Date', 'Reserve Last Draw Amount', 'Reserve Remaining Balance',
    'Escrow - Taxes', 'Escrow - Insurance', 'Escrow - Replacement Reserve', 'Escrow Note',
    'Has Escrow', 'TIF', 'HUD Audit'],
  'Insurance': INS_LABELS.map(x => x[1]).concat([
    'Property Insurance Financing', 'Property Insurance Vendor']),
  'Covenants & Legal': ['Covenant - Audit', 'Covenants - Distribution Frequency',
    'Covenants - Lender Operating Account', 'Covenants - Replacement Reserve',
    'Does LWC Review Property Tax Payments?', 'Extension Available', 'Extension Requirements',
    'Lien Waivers Required', 'Attorney Vendor', 'Asset Management Fee %',
    'Asset Mgmt Fee Vendor', 'Asset Mgmt Fee Tracker']
};
export const GROUP_ORDER = ['Property', 'Amenities & Systems', 'Loan & Debt', 'Insurance',
  'Covenants & Legal', 'Other'];
const FIELD_GROUP = {};
for (const [g, names] of Object.entries(GROUPS)) for (const n of names) FIELD_GROUP[norm(n)] = g;
const groupOf = key => FIELD_GROUP[key] || 'Other';

/* ---- types ------------------------------------------------------------- */

const NUM_TYPES = new Set(['numeric', 'integer', 'bigint', 'double precision', 'real',
  'money', 'smallint', 'decimal']);
const DATE_TYPES = new Set(['date', 'timestamp without time zone', 'timestamp with time zone']);
/* A column whose name says it holds an amount of money gets rendered as one.
   "property" is in here because property_equity and value_per_unit are. */
const CURRENCY_HINT =
  /(amount|price|value|debt|balance|loc|escrow|reserve|budget|fee|premium|tiv|limit|deductible|property|income|egi|noi|expenses|service)/i;
const LINK_COL = /(_url|_website)$/i;
const PCT_COLS = new Set(['interest_rate_pct', 'aop_deductible_pct', 'wind_deductible_pct',
  'cap_rate', 'total_ltv', 'asset_management_fee_pct']);
const BOOL_OPTIONS = [{ id: 'true', name: 'Yes' }, { id: 'false', name: 'No' }];
const LOAN_STATUS_OPTIONS = [{ id: 'none', name: 'None' }, { id: 'pending', name: 'Pending' },
  { id: 'active', name: 'Active' }, { id: 'closed', name: 'Closed' }];
const STATUS_LABEL = { none: 'None', pending: 'Pending', active: 'Active', closed: 'Closed' };

const TABLE_FOR_KIND = { p: 'property', u: 'unit', l: 'loan', f: 'property_financials',
  i: 'insurance_policy', iu: 'insurance_policy' };
/* Never writable, whatever the schema says: identity, parentage, audit trail.
   The two entity columns have their own endpoints because they have to move the
   ownership table with them. */
const LOCKED = new Set(['id', 'created_at', 'updated_at', 'created_by', 'updated_by',
  'tenant_id', 'company_id', 'property_id', 'unit_id', 'loan_id', 'entity_id',
  'borrower_entity_id', 'clickup_task_id', 'lender_id', 'lender_contact_id',
  'primary_contact_id', 'deal_id', 'parent_loan_id']);

export function propertyDetailRoutes({ env, auth, invalidate }){
  const r = express.Router();
  const configured = Boolean(env.SUPABASE_DB_URL);

  let types = null;
  async function colTypes(){
    if (types) return types;
    const rows = (await ghlQuery(
      `select table_name, column_name, data_type from information_schema.columns
        where table_schema = 'public' and table_name = any($1)`,
      [['property', 'unit', 'loan', 'insurance_policy', 'property_financials']])).rows;
    const m = {};
    for (const row of rows) (m[row.table_name] ||= {})[row.column_name] = row.data_type;
    types = m;
    return m;
  }

  function renderType(table, col){
    const dt = (types[table] || {})[col];
    if (!dt) return null;                       // the column does not exist here
    if (dt === 'boolean') return 'boolean';
    if (DATE_TYPES.has(dt)) return 'date';
    if (NUM_TYPES.has(dt)) return CURRENCY_HINT.test(col) ? 'currency' : 'number';
    if (dt === 'ARRAY') return 'list';
    return 'short_text';
  }

  /* One field, in the shape the panel renders. `display` is what to show when
     there is nothing better to compute from `value`. */
  function mkField(id, label, type, raw, options){
    let value, display;
    if (type === 'label') { value = raw; display = raw; }
    else if (type === 'date') {
      const t = raw == null ? null : new Date(raw).getTime();
      value = Number.isFinite(t) ? t : null;
      display = value;
    } else if (type === 'currency' || type === 'number') {
      value = (raw === null || raw === undefined || raw === '') ? null : Number(raw);
      display = value;
    } else if (type === 'boolean') {
      /* Tri-state on purpose: false and "not recorded" are different answers to
         "is it sprinklered", and collapsing them loses the one that matters. */
      value = raw == null ? null : String(raw === true || raw === 'true');
      display = raw == null ? null : (raw === true || raw === 'true' ? 'Yes' : 'No');
    } else if (type === 'list') {
      value = Array.isArray(raw) ? raw.join(', ') : (raw == null ? null : String(raw));
      display = value;
    } else {
      value = raw == null ? null : String(raw);
      display = value;
    }
    const f = { id, name: label, type: type === 'boolean' ? 'drop_down' : type, value, display };
    if (type === 'boolean') f.options = BOOL_OPTIONS;
    if (options) f.options = options;
    f.group = groupOf(norm(label));
    return f;
  }

  const flag = (f, col) => {
    if (LINK_COL.test(col)) f.link = true;
    if (PCT_COLS.has(col)) f.pct = true;
    return f;
  };

  /* Turn a row into a label-keyed field map. Columns the label set names but the
     table does not have are skipped: the label sets outlive the schema. */
  function fieldsFrom(prefix, labels, table, row){
    const out = {};
    for (const [col, label] of labels) {
      const type = renderType(table, col);
      if (!type) continue;
      if (LOCKED.has(col)) continue;
      out[norm(label)] = flag(mkField(prefix + col, label, type, row ? row[col] : null), col);
    }
    return out;
  }

  const guard = (req, res, next) => {
    if (!configured) return res.status(400).json({ error: 'SUPABASE_DB_URL is not set.' });
    next();
  };
  const fail = (res, err) => {
    /* 22P02 is Postgres refusing a malformed uuid. That is a bad request, not a
       server fault, and answering it with 500 and "invalid input syntax for type
       uuid" tells the caller nothing and puts a false alarm in the log. */
    if (err.code === '22P02') {
      return res.status(400).json({ error: 'That is not a valid id.' });
    }
    const status = err.status || 500;
    if (status === 500) console.error('[properties]', err.message);
    res.status(status).json({ error: err.message });
  };

  /* ---- read one property ------------------------------------------------ */

  r.get('/api/properties/:id/detail', auth.require, guard, async (req, res) => {
    const id = String(req.params.id);
    try {
      await colTypes();
      const one = async (sql, params) => (await ghlQuery(sql, params)).rows;

      const [prop] = await one(`select * from public.property where id = $1`, [id]);
      if (!prop) return res.status(404).json({ error: 'No such property' });

      const [entities, owners, units, unitOwners, loans, balances, collateral,
             fins, ins, unitIns, comments, parcels, tasks, deal] = await Promise.all([
        one(`select id, name, parent_entity_id from public.entity order by name`),
        one(`select o.entity_id, o.is_primary, e.name from public.ownership o
               join public.entity e on e.id = o.entity_id
              where o.property_id = $1 order by o.is_primary desc, e.name`, [id]),
        one(`select * from public.unit where property_id = $1
              order by building_number nulls last, unit_identifier nulls last`, [id]),
        one(`select o.unit_id, o.entity_id, o.is_primary, e.name from public.ownership o
               join public.entity e on e.id = o.entity_id
              where o.unit_id in (select id from public.unit where property_id = $1)`, [id]),
        /* A loan reaches a property directly or through one of its buildings.
           Counting only the direct ones misses real debt. */
        one(`select distinct l.* from public.loan l
               join public.loan_collateral lc on lc.loan_id = l.id
              where lc.property_id = $1
                 or lc.unit_id in (select id from public.unit where property_id = $1)
              order by l.maturity_date nulls last`, [id]),
        one(`select lb.loan_id, lb.as_of_date, lb.balance from public.loan_balance lb
              where lb.loan_id in (
                select lc.loan_id from public.loan_collateral lc
                 where lc.property_id = $1
                    or lc.unit_id in (select id from public.unit where property_id = $1))
              order by lb.as_of_date`, [id]),
        one(`select lc.loan_id, lc.property_id, lc.unit_id, p.dba_name, u.unit_identifier
               from public.loan_collateral lc
               left join public.property p on p.id = lc.property_id
               left join public.unit u on u.id = lc.unit_id
              where lc.loan_id in (
                select loan_id from public.loan_collateral
                 where property_id = $1
                    or unit_id in (select id from public.unit where property_id = $1))`, [id]),
        one(`select * from public.property_financials where property_id = $1
              order by as_of_date desc nulls last`, [id]),
        one(`select * from public.insurance_policy where property_id = $1
              order by renewal_date desc nulls last`, [id]),
        one(`select * from public.insurance_policy
              where unit_id in (select id from public.unit where property_id = $1)`, [id]),
        one(`select id, author, body, created_at from public.property_comment
              where property_id = $1 order by created_at asc`, [id]),
        one(`select parcel_number, county, is_primary from public.property_parcel
              where property_id = $1 order by is_primary desc nulls last`, [id]).catch(() => []),
        one(`select id, name, status, priority, due_date from public.task
              where property_id = $1 order by due_date nulls last`, [id]).catch(() => []),
        one(`select d.name from public.deal d
               join public.entity e on e.deal_id = d.id
              where e.id = $1`, [prop.entity_id]).catch(() => [])
      ]);

      const byId = new Map(entities.map(e => [e.id, e]));
      const path = [];
      for (let e = byId.get(prop.entity_id); e; e = byId.get(e.parent_entity_id)) {
        path.unshift({ id: e.id, name: e.name });
      }
      const entityOptions = entities.map(e => ({ id: e.id, name: e.name }));

      /* ---- the property's own fields ---- */
      const fields = fieldsFrom('p:', PROP_LABELS, 'property', prop);

      fields[norm('Owner Entity')] = {
        id: 'ownerentity', name: 'Owner Entity', type: 'drop_down',
        value: prop.entity_id ? String(prop.entity_id) : '',
        display: (byId.get(prop.entity_id) || {}).name || null,
        options: entityOptions, group: 'Property'
      };

      /* Derived, therefore read-only: it comes from loan_balance, not from a
         column anyone can type into. */
      const balByLoan = new Map();
      for (const b of balances) balByLoan.set(b.loan_id, b);   // ordered, so the last wins
      const currentDebt = loans.reduce((a, l) => a + Number(balByLoan.get(l.id)?.balance || 0), 0);
      if (currentDebt) {
        fields[norm('Current Debt as of (09/30/24)')] =
          mkField(null, 'Current Debt as of (09/30/24)', 'label', money(currentDebt));
      }

      const loanStatus = loans.some(l => l.status === 'active') ? 'active'
        : loans.some(l => l.status === 'pending') ? 'pending'
        : loans.length ? 'closed' : 'none';
      fields[norm('Loan Status')] = mkField('loanstatus:' + id, 'Loan Status', 'label',
        STATUS_LABEL[loanStatus]);
      fields[norm('Loan Status')].type = 'drop_down';
      fields[norm('Loan Status')].value = loanStatus;
      fields[norm('Loan Status')].display = STATUS_LABEL[loanStatus];
      fields[norm('Loan Status')].options = LOAN_STATUS_OPTIONS;

      if (parcels.length) {
        fields[norm('Parcel ID')] = mkField(null, 'Parcel ID', 'label',
          parcels[0].parcel_number + (parcels.length > 1 ? ' (+' + (parcels.length - 1) + ' more)' : ''));
      }
      if (deal.length) fields[norm('Deal')] = mkField(null, 'Deal', 'label', deal[0].name);

      /* The property's insurance policy, always present as fields even when no
         row exists yet -- writing one creates it. A record you cannot start
         filling in is a report. */
      const insRow = ins[0] || null;
      Object.assign(fields, fieldsFrom('i:' + (insRow ? insRow.id : 'new') + ':',
        INS_LABELS, 'insurance_policy', insRow));

      /* ---- buildings ---- */
      const insByUnit = new Map(unitIns.map(x => [x.unit_id, x]));
      const ownersByUnit = new Map();
      for (const o of unitOwners) (ownersByUnit.get(o.unit_id) || ownersByUnit.set(o.unit_id, []).get(o.unit_id)).push(o);

      const buildings = units.map(u => {
        const uf = {
          [norm('Unit / Building')]: mkField(null, 'Unit / Building', 'label',
            u.unit_identifier || u.dba_name || ('Building ' + (u.building_number || '')))
        };
        Object.assign(uf, fieldsFrom('u:' + u.id + ':', UNIT_LABELS, 'unit', u));
        const uins = insByUnit.get(u.id) || null;
        Object.assign(uf, fieldsFrom('iu:' + (uins ? uins.id : 'new-' + u.id) + ':',
          INS_LABELS, 'insurance_policy', uins));
        uf[norm('Owner Entity')] = {
          id: 'ownerentityunit:' + u.id, name: 'Owner Entity', type: 'drop_down',
          value: u.entity_id ? String(u.entity_id) : '',
          display: (byId.get(u.entity_id) || {}).name || null,
          options: entityOptions, group: 'Property'
        };
        const list = ownersByUnit.get(u.id) || [];
        return {
          id: u.id,
          name: u.unit_identifier || u.dba_name || ('Building ' + (u.building_number || '?')),
          units: Number(u.current_total_units || 0),
          squareFeet: Number(u.square_feet || 0),
          fields: uf,
          owners: list.map(o => ({ id: o.entity_id, name: o.name, primary: Boolean(o.is_primary) }))
        };
      });

      /* ---- loans ---- */
      const collByLoan = new Map();
      for (const c of collateral) {
        (collByLoan.get(c.loan_id) || collByLoan.set(c.loan_id, []).get(c.loan_id)).push({
          level: c.unit_id ? 'building' : 'property',
          name: c.unit_id ? (c.unit_identifier || 'a building') : (c.dba_name || 'a property'),
          here: c.property_id === id || units.some(u => u.id === c.unit_id)
        });
      }
      const seriesByLoan = new Map();
      for (const b of balances) {
        (seriesByLoan.get(b.loan_id) || seriesByLoan.set(b.loan_id, []).get(b.loan_id))
          .push({ at: b.as_of_date, balance: Number(b.balance || 0) });
      }

      const loansOut = loans.map(l => {
        const lf = fieldsFrom('l:' + l.id + ':', LOAN_LABELS, 'loan', l);
        const bal = balByLoan.get(l.id);
        lf[norm('Loan Status')] = mkField(null, 'Loan Status', 'label',
          STATUS_LABEL[l.status] || l.status || 'None');
        if (bal) {
          lf[norm('Current Debt as of (09/30/24)')] = mkField(null,
            'Current Debt as of (09/30/24)', 'label', money(bal.balance));
        }
        return {
          id: l.id,
          name: l.loan_number || [l.lender, l.loan_type].filter(Boolean).join(' ') || 'Loan',
          lender: l.lender, loanNumber: l.loan_number,
          position: l.position || 'primary',
          status: STATUS_LABEL[l.status] || l.status || 'None',
          currentDebt: Number(bal?.balance || 0),
          currentDebtAsOf: bal?.as_of_date || null,
          maturityDate: l.maturity_date, originationAmount: Number(l.origination_amount || 0),
          interestRatePct: l.interest_rate_pct === null ? null : Number(l.interest_rate_pct),
          interestRate: l.interest_rate,
          dscr: l.dscr === null ? null : Number(l.dscr),
          isTif: l.is_tif === true, recourse: l.recourse,
          hasEscrow: l.has_escrow, escrowTaxes: l.escrow_taxes,
          escrowInsurance: l.escrow_insurance, escrowReserve: l.escrow_replacement_reserve,
          extensionAvailable: l.extension_available,
          collateral: collByLoan.get(l.id) || [],
          balances: seriesByLoan.get(l.id) || [],
          fields: lf
        };
      });

      res.json({
        ok: true,
        id,
        name: prop.dba_name || prop.trade_name || prop.street || '(unnamed)',
        ownershipStatus: String(prop.ownership_status || 'unknown').toLowerCase(),
        address: [prop.street, prop.city, prop.state, prop.zip].filter(Boolean).join(', '),
        path, entityOptions,
        owners: owners.map(o => ({ id: o.entity_id, name: o.name, primary: Boolean(o.is_primary) })),
        primaryOwnerId: prop.entity_id || null,
        fields, buildings, loans: loansOut,
        financials: fins.map(f => ({
          ...f,
          fields: fieldsFrom('f:' + f.id + ':', FIN_LABELS, 'property_financials', f)
        })),
        parcels, tasks, currentDebt, loanStatus,
        deal: deal.length ? deal[0].name : null,
        comments: comments.map(c => ({
          id: c.id, author: c.author || 'Unknown', body: c.body,
          at: c.created_at ? new Date(c.created_at).getTime() : null
        })),
        groupOrder: GROUP_ORDER
      });
    } catch (err) { fail(res, err); }
  });

  /* ---- write one field --------------------------------------------------- */

  /* An insurance row is created on first write rather than up front: 168
     properties would otherwise get 168 empty policies, and "has a policy row"
     would stop meaning anything. */
  async function ensureInsurance(scope, ownerId){
    const col = scope === 'unit' ? 'unit_id' : 'property_id';
    const [found] = (await ghlQuery(
      `select id from public.insurance_policy where ${col} = $1 order by created_at limit 1`,
      [ownerId])).rows;
    if (found) return found.id;
    const [made] = (await ghlQuery(
      `insert into public.insurance_policy (${col}) values ($1) returning id`, [ownerId])).rows;
    return made.id;
  }

  function coerce(table, col, value){
    const dt = (types[table] || {})[col];
    if (value === null || value === undefined || value === '') return null;
    if (dt === 'boolean') return value === true || value === 'true' || value === 'Yes';
    if (DATE_TYPES.has(dt)) {
      const n = Number(value);
      const t = Number.isFinite(n) && String(value).trim() !== '' ? n : Date.parse(value);
      if (!Number.isFinite(t)) throw Object.assign(new Error('That is not a date'), { status: 400 });
      return new Date(t).toISOString();
    }
    if (NUM_TYPES.has(dt)) {
      const n = Number(String(value).replace(/[$,%\s]/g, ''));
      if (!Number.isFinite(n)) throw Object.assign(new Error('That is not a number'), { status: 400 });
      return n;
    }
    return String(value);
  }

  /* Change the primary owner of a property or a building. property.entity_id is
     a convenience copy of the is_primary ownership row; they move together or
     the tree in the list and the owner in the panel disagree. */
  async function setPrimaryOwner(scope, ownerId, entityId){
    const table = scope === 'unit' ? 'unit' : 'property';
    const col = scope === 'unit' ? 'unit_id' : 'property_id';
    /* One client, not the pool: through ghlQuery each statement can land on a
       different connection and the BEGIN applies to none of the work. */
    const client = await ghlClient();
    try {
      await client.query('begin');
      try {
        await client.query(`update public.${table} set entity_id = $1 where id = $2`, [entityId, ownerId]);
        await client.query(
          `delete from public.ownership
            where ${col} = $1 and entity_id = $2 and coalesce(is_primary, false) = false`,
          [ownerId, entityId]);
        const moved = await client.query(
          `update public.ownership set entity_id = $1
            where ${col} = $2 and is_primary = true returning id`, [entityId, ownerId]);
        if (!moved.rows.length) {
          await client.query(
            `insert into public.ownership (entity_id, ${col}, is_primary) values ($1, $2, true)`,
            [entityId, ownerId]);
        }
        await client.query('commit');
      } catch (err) { await client.query('rollback').catch(() => {}); throw err; }
    } finally { client.release(); }
  }

  r.patch('/api/properties/:id/field', auth.require, guard, express.json({ limit: '128kb' }),
    async (req, res) => {
      const propertyId = String(req.params.id);
      const fieldId = String(req.body?.field || '');
      const value = req.body?.value;
      try {
        await colTypes();
        const parts = fieldId.split(':');
        const kind = parts[0];

        if (kind === 'ownerentity') {
          if (!value) throw Object.assign(new Error('Pick an entity'), { status: 400 });
          await setPrimaryOwner('property', propertyId, String(value));
          invalidate();
          return res.json({ ok: true, field: fieldId });
        }
        if (kind === 'ownerentityunit') {
          if (!parts[1]) throw Object.assign(new Error('Which building?'), { status: 400 });
          if (!value) throw Object.assign(new Error('Pick an entity'), { status: 400 });
          await setPrimaryOwner('unit', parts[1], String(value));
          invalidate();
          return res.json({ ok: true, field: fieldId });
        }
        if (kind === 'loanstatus') {
          const status = String(value || 'none').toLowerCase();
          if (!LOAN_STATUS_OPTIONS.some(o => o.id === status)) {
            throw Object.assign(new Error('Not a loan status'), { status: 400 });
          }
          await ghlQuery(
            `update public.loan set status = $1 where id in (
               select loan_id from public.loan_collateral
                where property_id = $2
                   or unit_id in (select id from public.unit where property_id = $2))`,
            [status, propertyId]);
          invalidate();
          return res.json({ ok: true, field: fieldId, value: status });
        }

        const table = TABLE_FOR_KIND[kind];
        if (!table) throw Object.assign(new Error('Unknown field group: ' + kind), { status: 400 });
        const col = kind === 'p' ? parts[1] : parts[2];
        if (!col) throw Object.assign(new Error('That field has no column'), { status: 400 });
        if (LOCKED.has(col)) throw Object.assign(new Error(col + ' is not editable'), { status: 400 });
        /* The column has to exist in the live schema. This is the only check
           standing between a field id and a query, so it is an existence test
           against information_schema rather than a pattern that looks safe. */
        if (!(types[table] || {})[col]) {
          throw Object.assign(new Error('No such column: ' + table + '.' + col), { status: 400 });
        }

        let rowId = kind === 'p' ? propertyId : parts[1];
        if (kind === 'i' && String(rowId).startsWith('new')) {
          rowId = await ensureInsurance('property', propertyId);
        } else if (kind === 'iu' && String(rowId).startsWith('new-')) {
          rowId = await ensureInsurance('unit', String(rowId).slice(4));
        }
        if (!rowId) throw Object.assign(new Error('That field needs a row id'), { status: 400 });

        const out = await ghlQuery(
          `update public.${table} set ${col} = $1 where id = $2 returning ${col}`,
          [coerce(table, col, value), rowId]);
        if (!out.rows.length) throw Object.assign(new Error('No such row'), { status: 404 });

        /* The list's cache now disagrees with the database. Dropping it costs one
           rebuild; keeping it means a successful write looks like it did nothing. */
        invalidate();
        res.json({ ok: true, field: fieldId, value: out.rows[0][col] });
      } catch (err) { fail(res, err); }
    });

  /* ---- co-owners --------------------------------------------------------- */

  r.post('/api/properties/:id/owners', auth.require, guard, express.json({ limit: '16kb' }),
    async (req, res) => {
      const id = String(req.params.id);
      const entityId = String(req.body?.entityId || '');
      const unitId = req.body?.unitId ? String(req.body.unitId) : null;
      const col = unitId ? 'unit_id' : 'property_id';
      const owner = unitId || id;
      if (!entityId) return res.status(400).json({ error: 'Pick an entity' });
      try {
        const [existing] = (await ghlQuery(
          `select id, is_primary from public.ownership where ${col} = $1 and entity_id = $2`,
          [owner, entityId])).rows;
        if (existing?.is_primary) {
          throw Object.assign(new Error('That entity is already the primary owner'), { status: 400 });
        }
        /* Idempotent: adding the same co-owner twice is a double-click. */
        if (!existing) {
          await ghlQuery(
            `insert into public.ownership (entity_id, ${col}, is_primary) values ($1, $2, false)`,
            [entityId, owner]);
        }
        invalidate();
        res.json({ ok: true, entityId });
      } catch (err) { fail(res, err); }
    });

  r.delete('/api/properties/:id/owners/:entityId', auth.require, guard, async (req, res) => {
    const unitId = req.query.unitId ? String(req.query.unitId) : null;
    const col = unitId ? 'unit_id' : 'property_id';
    const owner = unitId || String(req.params.id);
    try {
      const [row] = (await ghlQuery(
        `select id, is_primary from public.ownership where ${col} = $1 and entity_id = $2`,
        [owner, req.params.entityId])).rows;
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

  r.post('/api/properties/:id/comments', auth.require, guard, express.json({ limit: '32kb' }),
    async (req, res) => {
      const body = String(req.body?.body || '').trim();
      if (!body) return res.status(400).json({ error: 'Write something first' });
      try {
        /* Whoever is signed in. An unattributed note on a shared record is worth
           very little six months later. */
        const author = req.session?.user?.email || req.session?.user?.name
          || env.OWNER_EMAIL || 'Command Center';
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

  r.post('/api/properties/entity', auth.require, guard, express.json({ limit: '16kb' }),
    async (req, res) => {
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

  r.post('/api/properties/property', auth.require, guard, express.json({ limit: '16kb' }),
    async (req, res) => {
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
        /* The ownership row too: the list's tree is built from `ownership`, so a
           property created without one is invisible in it. */
        await ghlQuery(
          `insert into public.ownership (entity_id, property_id, is_primary) values ($1, $2, true)`,
          [entityId, row.id]);
        invalidate();
        res.json({ ok: true, id: row.id });
      } catch (err) { fail(res, err); }
    });

  r.post('/api/properties/:id/building', auth.require, guard, express.json({ limit: '16kb' }),
    async (req, res) => {
      const name = String(req.body?.name || '').trim();
      if (!name) return res.status(400).json({ error: 'A building needs a name' });
      try {
        const [row] = (await ghlQuery(
          `insert into public.unit (property_id, unit_identifier) values ($1, $2) returning id`,
          [req.params.id, name])).rows;
        invalidate();
        res.json({ ok: true, id: row.id });
      } catch (err) { fail(res, err); }
    });

  return r;
}
