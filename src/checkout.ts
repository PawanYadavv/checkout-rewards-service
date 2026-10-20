
import { withTransaction } from "./db.js";
import { AppError } from "./errors.js";
import { lockCart } from "./cart.js";
import { calculateDiscount, redeemCoupon } from "./coupons.js";

// Turns a cart into an order. Everything runs in ONE transaction:
// if any step throws, nothing is saved (no stock taken, no order, cart stays open).
// Returns the order id, and replayed = true if this key already made that order.
export async function checkout(
  cartId: string,
  idempotencyKey: string,
  couponCode?: string,
): Promise<{ orderId: string; replayed: boolean }> {
  return withTransaction(async (client) => {
    // 1. Lock the cart: a second checkout of the same cart waits here.
    const status = await lockCart(client, cartId);

    // 1b. Retry? If this key already made an order, return it and change nothing.
    //     This runs AFTER the lock, so a retry that arrives while the first attempt
    //     is still running waits, then finds the order the first attempt committed.
    const previous = await client.query(
      "SELECT id, cart_id FROM orders WHERE idempotency_key = $1",
      [idempotencyKey],
    );
    if (previous.rows.length > 0) {
      if (previous.rows[0].cart_id !== cartId) {
        throw new AppError(422, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for another cart");
      }
      return { orderId: previous.rows[0].id, replayed: true };
    }
    if (status !== "open") throw new AppError(409, "CART_NOT_OPEN", "Cart is already checked out");

    // 2. Read what is in the cart. ORDER BY id = every checkout locks products in the same order, so two checkouts can never wait on each other forever (deadlock).
    const { rows: cartItems } = await client.query(
      "SELECT product_id, quantity FROM cart_items WHERE cart_id = $1 ORDER BY product_id",
      [cartId],
    );
    if (cartItems.length === 0) throw new AppError(409, "CART_EMPTY", "Cannot check out an empty cart");

    // 2b. Use the coupon (if any) inside this same transaction. If a later step fails
    //     (e.g. out of stock), the rollback makes the coupon available again.
    const percentOff = couponCode ? await redeemCoupon(client, couponCode) : 0;

    // 3. Take stock. THE anti-oversell line: the UPDATE only happens if enough stock
    //    is left. Postgres locks the product row, so concurrent checkouts go one at a
    //    time and each one sees the stock the previous one left.
    //    RETURNING gives us the current name and price for the order snapshot.
    const lines = [];
    const shortages = [];
    for (const item of cartItems) {
      const updated = await client.query(
        `UPDATE products SET inventory = inventory - $2
          WHERE id = $1 AND inventory >= $2
          RETURNING name, price_paise, inventory`,
        [item.product_id, item.quantity],
      );
      if (updated.rowCount === 0) {
        const p = await client.query("SELECT inventory FROM products WHERE id = $1", [item.product_id]);
        shortages.push({ productId: item.product_id, requested: item.quantity, available: p.rows[0].inventory });
        continue;
      }
      const { name, price_paise } = updated.rows[0];
      lines.push({
        productId: item.product_id,
        name,
        unitPricePaise: price_paise,
        quantity: item.quantity,
        lineTotalPaise: price_paise * item.quantity,
      });
    }
    // Throwing rolls back the stock already taken for the other lines too.
    if (shortages.length > 0) {
      throw new AppError(409, "INSUFFICIENT_STOCK", "Not enough stock for some items", shortages);
    }

    // 4. Money: integers only.
    const subtotal = lines.reduce((sum, l) => sum + l.lineTotalPaise, 0);
    const discount = calculateDiscount(subtotal, percentOff);

    // 5. Save the order and the snapshot of each line.
    const order = await client.query(
      `INSERT INTO orders (cart_id, idempotency_key, coupon_code, subtotal_paise, discount_paise, total_paise)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [cartId, idempotencyKey, couponCode ?? null, subtotal, discount, subtotal - discount],
    );
    const orderId: string = order.rows[0].id;
    for (const l of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, unit_price_paise, quantity, line_total_paise)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [orderId, l.productId, l.name, l.unitPricePaise, l.quantity, l.lineTotalPaise],
      );
    }

    // 6. Close the cart so it can never be checked out or edited again.
    await client.query("UPDATE carts SET status = 'checked_out' WHERE id = $1", [cartId]);
    return { orderId, replayed: false };
  });
}
