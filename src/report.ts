import { withTransaction } from "./db.js";

// Admin summary. Only SELECTs, so calling it any number of times changes nothing.
// REPEATABLE READ = all queries below see the SAME snapshot of the data, so the
// numbers always agree with each other even if an order is placed meanwhile.
// SUM() returns bigint, which pg gives us as a string -> Number().
export async function getReport() {
  return withTransaction(async (client) => {
    const orders = await client.query(`
      SELECT count(*)::int                         AS total_orders,
             COALESCE(sum(subtotal_paise), 0)::bigint AS gross,
             COALESCE(sum(discount_paise), 0)::bigint AS discounts,
             COALESCE(sum(total_paise), 0)::bigint    AS net
        FROM orders`);

    const coupons = await client.query(`
      SELECT count(*)::int                                     AS generated,
             count(*) FILTER (WHERE redeemed_at IS NULL)::int     AS available,
             count(*) FILTER (WHERE redeemed_at IS NOT NULL)::int AS redeemed
        FROM coupons`);

    const products = await client.query(`
      SELECT p.id, p.name, COALESCE(sum(oi.quantity), 0)::int AS quantity
        FROM products p LEFT JOIN order_items oi ON oi.product_id = p.id
       GROUP BY p.id, p.name
       ORDER BY p.id`);

    const o = orders.rows[0];
    return {
      totalOrders: o.total_orders,
      grossRevenuePaise: Number(o.gross),
      totalDiscountPaise: Number(o.discounts),
      netRevenuePaise: Number(o.net),
      coupons: coupons.rows[0],
      quantitySoldByProduct: products.rows.map((p) => ({ productId: p.id, name: p.name, quantity: p.quantity })),
    };
  }, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
}
