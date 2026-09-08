/* Whop.

   One job: turn a name and a price into a checkout link.

   The v1 REST API is the versioned surface — https://api.whop.com/api/v1, Bearer
   auth, and an Api-Version-Date header that pins the payload shape so a change
   on their side does not silently move a field out from under us.

   Three calls make a link:

     POST /products   {account_id, title}            -> prod_xxx
     POST /plans      {account_id, product_id, ...}  -> plan_xxx + purchase_url
     POST /checkout_configurations {plan_id}         -> purchase_url   (fallback)

   The plan is what carries the price, and its `purchase_url` IS the checkout
   link. The checkout-configuration call is only there for the case where a plan
   comes back without one — the documented field is on both objects, so asking
   twice costs one request and removes a whole class of "created but no link".

   Two field names are guessed rather than read from a schema, and both are
   handled by retrying instead of by hoping:

     - currency on plan create. The product endpoint's `plan_options` calls it
       `base_currency`; the plan object returned everywhere else calls it
       `currency`. We send base_currency, and on a 4xx send currency instead.
     - which key on a plan points back at its product. Read through a list of
       candidates rather than one.

   billing_period is a NUMBER OF DAYS, not a month count — 30 for monthly, 365
   for annual. Sending 1 for "1 month" would bill every day. */

const BASE = 'https://api.whop.com/api/v1';
const CHECKOUT_HOST = 'https://whop.com';

/* The variable is WHOP_API_KEY; WHOP_API is accepted because that is what was
   set on Railway first and a rename there is a redeploy nobody needs. */
const key = env => env.WHOP_API_KEY || env.WHOP_API || '';

export const configured = env => Boolean(key(env));

/* Days between charges. The labels are the ones the form offers. */
export const PERIODS = [
  { days: 7,   label: '1 week' },
  { days: 14,  label: '2 weeks' },
  { days: 30,  label: '1 month' },
  { days: 90,  label: '3 months' },
  { days: 180, label: '6 months' },
  { days: 365, label: '1 year' }
];

export const CURRENCIES = ['usd', 'eur', 'gbp', 'cad', 'aud', 'php'];

export const periodLabel = days => PERIODS.find(p => p.days === Number(days))?.label
  || (days ? `${days} days` : '');

/* ---------------------------------------------------------------------------
   Transport.
   --------------------------------------------------------------------------- */

function headers(env, withBody){
  const h = {
    Authorization: `Bearer ${key(env)}`,
    Accept: 'application/json'
  };
  /* Pinned by default. Overridable because the right answer changes with time
     and a redeploy is cheaper than an edit here. */
  const version = env.WHOP_API_VERSION_DATE ?? '2026-07-01';
  if (version) h['Api-Version-Date'] = version;
  if (withBody) h['Content-Type'] = 'application/json';
  return h;
}

/* Whop reports a failure in at least three shapes depending on where it was
   raised. Pull the sentence a person can act on out of whichever arrived. */
function reason(json, text, res){
  const e = json?.error;
  return (typeof e === 'string' ? e : e?.message)
    || json?.message
    || (Array.isArray(json?.errors) ? json.errors.map(x => x?.message || x).join('; ') : null)
    || (text || '').slice(0, 300)
    || res.statusText;
}

async function call(env, path, { method = 'GET', body = null, query = null, timeout = 30_000 } = {}){
  if (!configured(env)) {
    const err = new Error('Whop is not configured. Set WHOP_API_KEY.');
    err.unconfigured = true;
    throw err;
  }

  let url = BASE + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === null || v === undefined || v === '') continue;
      if (Array.isArray(v)) v.forEach(x => qs.append(k + '[]', String(x)));
      else qs.append(k, String(v));
    }
    const s = qs.toString();
    if (s) url += '?' + s;
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  let res, text;
  try {
    res = await fetch(url, {
      method,
      headers: headers(env, Boolean(body)),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal
    });
    text = await res.text();
  } catch (err) {
    clearTimeout(t);
    throw new Error(err.name === 'AbortError'
      ? `Whop timed out after ${timeout / 1000}s`
      : err.message);
  }
  clearTimeout(t);

  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }

  if (!res.ok) {
    const err = new Error(reason(json, text, res));
    err.status = res.status;
    err.body = json ?? text;
    throw err;
  }
  return json;
}

export const raw = (env, path, query) => call(env, path, { query });

/* ---------------------------------------------------------------------------
   Which business are we acting for.

   Every write needs account_id. It can be set explicitly, and otherwise comes
   from /accounts/me — cached, because it never changes for a given key and the
   product list would otherwise pay for it on every load.
   --------------------------------------------------------------------------- */

let cachedAccount = { key: null, id: null, route: null };

export async function account(env){
  const k = key(env);
  const forced = env.WHOP_ACCOUNT_ID || env.WHOP_COMPANY_ID || '';
  if (forced) return { id: forced, route: cachedAccount.route || null };
  if (cachedAccount.key === k && cachedAccount.id) return cachedAccount;

  const j = await call(env, '/accounts/me');
  const body = j?.data ?? j;
  const id = body?.id || body?.account?.id || body?.company?.id;
  if (!id) throw new Error('Whop did not say which account this key belongs to.');
  cachedAccount = { key: k, id, route: body?.route || body?.company?.route || null };
  return cachedAccount;
}

export const accountId = async env => (await account(env)).id;

/* ---------------------------------------------------------------------------
   Reading.
   --------------------------------------------------------------------------- */

const list = j => (Array.isArray(j) ? j : j?.data) || [];

export async function listProducts(env, { limit = 50 } = {}){
  const acct = await account(env);
  /* Only account_id and first are sent. The endpoint also documents ordering
     and visibility filters, but an unknown query key is a 400 and the sort is
     three lines to do here. */
  const j = await call(env, '/products', { query: { account_id: acct.id, first: limit } });
  return list(j)
    .filter(p => p?.visibility !== 'archived')
    .sort((a, b) => new Date(b?.created_at || 0) - new Date(a?.created_at || 0));
}

/* Every plan on the account in one call, so the product list is two requests
   rather than one per row. Returns null — not [] — when the endpoint is not
   available, so the caller can tell "no plans" from "could not ask". */
export async function listPlans(env, { limit = 200 } = {}){
  const acct = await account(env);
  try {
    const j = await call(env, '/plans', { query: { account_id: acct.id, first: limit } });
    return list(j);
  } catch (err) {
    if (err.status === 404 || err.status === 400) return null;
    throw err;
  }
}

/* A plan names its product under one of several keys depending on how old the
   surface it came from is. */
export const planProductId = p =>
  p?.product_id || p?.product?.id || p?.access_pass_id || p?.access_pass?.id || null;

/* ---------------------------------------------------------------------------
   Writing.
   --------------------------------------------------------------------------- */

export async function createProduct(env, { title, visibility = 'visible' }){
  const acct = await account(env);
  const j = await call(env, '/products', {
    method: 'POST',
    body: { account_id: acct.id, title: String(title).slice(0, 80), visibility }
  });
  const p = j?.data ?? j;
  if (!p?.id) throw new Error('Whop created no product id.');
  return p;
}

/* plan_type 'one_time' charges initial_price once. 'renewal' charges
   initial_price up front and renewal_price every billing_period days; when the
   form gives one number both are set to it, which is what "$X per month" means
   to the person typing it. */
export async function createPlan(env, {
  productId, planType, amount, currency = 'usd', billingPeriodDays = 30, visibility = 'visible'
}){
  const acct = await account(env);
  const price = Math.round(Number(amount || 0) * 100) / 100;

  const base = {
    account_id: acct.id,
    product_id: productId,
    plan_type: planType,
    initial_price: price,
    visibility,
    release_method: 'buy_now'
  };
  if (planType === 'renewal') {
    base.renewal_price = price;
    base.billing_period = Number(billingPeriodDays) || 30;
  }

  /* base_currency first — it is what the products endpoint's plan_options
     documents. On a rejection, the other spelling, once. */
  try {
    return unwrapPlan(await call(env, '/plans', {
      method: 'POST', body: { ...base, base_currency: currency }
    }));
  } catch (err) {
    if (!(err.status >= 400 && err.status < 500)) throw err;
    return unwrapPlan(await call(env, '/plans', {
      method: 'POST', body: { ...base, currency }
    }));
  }
}

function unwrapPlan(j){
  const p = j?.data ?? j;
  if (!p?.id) throw new Error('Whop created no plan id.');
  return p;
}

/* The documented second way to get a link for a plan. Only reached when the
   plan itself came back without one. */
export async function checkoutUrlFor(env, planId){
  const j = await call(env, '/checkout_configurations', {
    method: 'POST', body: { plan_id: planId }
  });
  const c = j?.data ?? j;
  return c?.purchase_url || null;
}

/* ---------------------------------------------------------------------------
   Links.
   --------------------------------------------------------------------------- */

/* purchase_url is documented as a path — "/checkout/ch_xxxx/" — so it is not
   something to hand a user as-is. */
export const absolute = u => {
  if (!u) return null;
  const s = String(u).trim();
  if (/^https?:\/\//i.test(s)) return s;
  return CHECKOUT_HOST + (s.startsWith('/') ? s : '/' + s);
};

/* Last resort, and still a working checkout: a plan id addresses its own
   checkout page directly. */
export const planCheckoutUrl = planId => planId ? `${CHECKOUT_HOST}/checkout/${planId}` : null;

/* The storefront page for the product, which is a different thing from a
   checkout link and worth showing beside it when both exist. */
export const productPageUrl = product => {
  const company = product?.company?.route;
  const route = product?.route;
  return company && route ? `${CHECKOUT_HOST}/${company}/${route}/` : null;
};

/* One link for a plan, trying the three sources in the order they are
   trustworthy. Never throws: a product that exists with no link is a better
   outcome than an error that hides it. */
export async function resolveLink(env, plan){
  const direct = absolute(plan?.purchase_url);
  if (direct) return direct;
  try {
    const made = absolute(await checkoutUrlFor(env, plan?.id));
    if (made) return made;
  } catch (err) {
    console.error('[whop] checkout configuration failed:', err.message);
  }
  return planCheckoutUrl(plan?.id);
}

/* ---------------------------------------------------------------------------
   Display.
   --------------------------------------------------------------------------- */

const SYMBOL = { usd: '$', eur: '€', gbp: '£', cad: 'CA$', aud: 'A$', php: '₱' };

export function money(amount, currency = 'usd'){
  const n = Number(amount || 0);
  const sym = SYMBOL[String(currency).toLowerCase()] || '';
  const shown = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return sym ? sym + shown : shown + ' ' + String(currency).toUpperCase();
}

export function priceLabel({ planType, amount, currency, billingPeriodDays }){
  if (!Number(amount)) return 'Free';
  const m = money(amount, currency);
  return planType === 'renewal' ? `${m} per ${periodLabel(billingPeriodDays)}` : m;
}

/* The same label, from a plan as Whop returns it. */
export function planLabel(plan){
  if (!plan) return null;
  const renewal = plan.plan_type === 'renewal';
  const amount = renewal ? (plan.renewal_price ?? plan.initial_price) : plan.initial_price;
  return priceLabel({
    planType: plan.plan_type,
    amount,
    currency: plan.currency || plan.base_currency || 'usd',
    billingPeriodDays: plan.billing_period
  });
}
