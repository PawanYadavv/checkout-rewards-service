import type pg from "pg";
import type { Db } from "./db.js";
import { AppError } from "./errors.js";
import { isUuid } from "./validate.js";

// A badly formed id can never match a cart, so treat it as "not found".
export function parseCartId(value: string): string {
  if (!isUuid(value)) throw new AppError(404, "CART_NOT_FOUND", "Cart not found");
  return value;
}

// Locks the cart row until the transaction ends and returns its status.
// Every cart change and checkout calls this first, so they run one at a time
// per cart and see the latest status.
export async function lockCart(client: pg.PoolClient, cartId: string): Promise<string> {
  const { rows } = await client.query("SELECT status FROM carts WHERE id = $1 FOR UPDATE", [cartId]);
  if (rows.length === 0) throw new AppError(404, "CART_NOT_FOUND", "Cart not found");
  return rows[0].status;
}

export async function lockOpenCart(client: pg.PoolClient, cartId: string) {
  const status = await lockCart(client, cartId);
  if (status !== "open") throw new AppError(409, "CART_NOT_OPEN", "Cart is already checked out");
}

// Soft stock check when editing a cart. Checkout does the real, race-safe check.
export async function ensureStock(client: pg.PoolClient, productId: string, quantity: number) {
  const { rows } = await client.query("SELECT inventory FROM products WHERE id = $1", [productId]);
  if (rows.length === 0) throw new AppError(404, "PRODUCT_NOT_FOUND", `Product ${productId} not found`);
  if (quantity > rows[0].inventory) {
    throw new AppError(409, "INSUFFICIENT_STOCK", `Not enough stock for ${productId}`, {
      productId,
      requested: quantity,
      available: rows[0].inventory,
    });
  }
}

// Cart with CURRENT prices (decision: live price until checkout).
export async function getCartView(db: Db, cartId: string) {
  const cart = await db.query("SELECT id, status FROM carts WHERE id = $1", [cartId]);
  if (cart.rows.length === 0) throw new AppError(404, "CART_NOT_FOUND", "Cart not found");

  const { rows } = await db.query(
    `SELECT p.id, p.name, p.price_paise, p.inventory, ci.quantity
       FROM cart_items ci JOIN products p ON p.id = ci.product_id
      WHERE ci.cart_id = $1
      ORDER BY p.id`,
    [cartId],
  );
  const items = rows.map((r) => ({
    productId: r.id,
    name: r.name,
    unitPricePaise: r.price_paise,
    quantity: r.quantity,
    lineTotalPaise: r.price_paise * r.quantity, // integers only, no floats
    availableInventory: r.inventory,
  }));

  return {
    id: cart.rows[0].id,
    status: cart.rows[0].status,
    items,
    subtotalPaise: items.reduce((sum, i) => sum + i.lineTotalPaise, 0),
  };
}





