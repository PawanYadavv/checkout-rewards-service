import type { Db } from "./db.js";
import { AppError } from "./errors.js";

// Built only from orders + order_items (the snapshot), never from products,
// so an order looks the same forever even if product prices change.
export async function getOrderView(db: Db, orderId: string) {
  const order = await db.query("SELECT * FROM orders WHERE id = $1", [orderId]);
  if (order.rows.length === 0) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
  const o = order.rows[0];

  const items = await db.query(
    "SELECT * FROM order_items WHERE order_id = $1 ORDER BY product_id",
    [orderId],
  );

  return {
    id: o.id,
    cartId: o.cart_id,
    items: items.rows.map((i) => ({
      productId: i.product_id,
      name: i.product_name,
      unitPricePaise: i.unit_price_paise,
      quantity: i.quantity,
      lineTotalPaise: i.line_total_paise,
    })),
    subtotalPaise: o.subtotal_paise,
    couponCode: o.coupon_code,
    discountPaise: o.discount_paise,
    totalPaise: o.total_paise,
    createdAt: o.created_at,
  };
}
