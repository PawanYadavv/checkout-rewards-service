import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { pool } from "../src/db.js";

export const app = createApp();

// Creates a cart and adds the given items, e.g. cartWith({ p_mouse: 2 }).
export async function cartWith(items: Record<string, number>): Promise<string> {
  const id = (await request(app).post("/carts")).body.id;
  for (const [productId, quantity] of Object.entries(items)) {
    await request(app).post(`/carts/${id}/items`).send({ productId, quantity });
  }
  return id;
}

// A new random Idempotency-Key unless one is given (to simulate a retry).
export function checkout(cartId: string, key: string = randomUUID(), couponCode?: string) {
  return request(app)
    .post(`/carts/${cartId}/checkout`)
    .set("Idempotency-Key", key)
    .send(couponCode ? { couponCode } : {});
}

export async function inventory(productId: string): Promise<number> {
  const { rows } = await pool.query("SELECT inventory FROM products WHERE id = $1", [productId]);
  return rows[0].inventory;
}
