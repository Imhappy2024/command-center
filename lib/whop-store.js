/* What we know about a Whop product that Whop's own product list does not say.

   GET /products returns titles and routes and no pricing at all; the plan list
   is a second call whose response shape is not pinned by the reference. So the
   plan id, the price and the checkout link are written down at creation, when
   we are holding all three, and the list joins them back on product id.

   Nothing here is authoritative. A product created in Whop's dashboard has no
   row and still appears in the list — just without a price until the plan list
   fills it in. */

import { query } from '../db/index.js';

export async function remember(row){
  await query(
    `INSERT INTO whop_links
       (product_id, plan_id, title, plan_type, amount, currency,
        billing_period, price_label, purchase_url, product_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (product_id) DO UPDATE SET
       plan_id        = EXCLUDED.plan_id,
       title          = EXCLUDED.title,
       plan_type      = EXCLUDED.plan_type,
       amount         = EXCLUDED.amount,
       currency       = EXCLUDED.currency,
       billing_period = EXCLUDED.billing_period,
       price_label    = EXCLUDED.price_label,
       purchase_url   = EXCLUDED.purchase_url,
       product_url    = EXCLUDED.product_url`,
    [row.productId, row.planId || null, row.title || null, row.planType || null,
     row.amount ?? null, row.currency || null, row.billingPeriodDays ?? null,
     row.priceLabel || null, row.purchaseUrl || null, row.productUrl || null]);
}

/* Keyed by product id, because that is what the caller is joining on. */
export async function byProduct(){
  const { rows } = await query(`SELECT * FROM whop_links`);
  const out = new Map();
  for (const r of rows) out.set(r.product_id, shape(r));
  return out;
}

export async function recent(limit = 60){
  const { rows } = await query(
    `SELECT * FROM whop_links ORDER BY created_at DESC LIMIT $1`, [limit]);
  return rows.map(shape);
}

export async function forget(productId){
  await query(`DELETE FROM whop_links WHERE product_id = $1`, [productId]);
}

const shape = r => ({
  productId: r.product_id,
  planId: r.plan_id,
  title: r.title,
  planType: r.plan_type,
  amount: r.amount == null ? null : Number(r.amount),
  currency: r.currency,
  billingPeriodDays: r.billing_period,
  priceLabel: r.price_label,
  purchaseUrl: r.purchase_url,
  productUrl: r.product_url,
  createdAt: r.created_at
});
