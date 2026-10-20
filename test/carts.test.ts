import { afterAll, beforeEach, describe, expect, test } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { pool } from "../src/db.js";
import { resetDb } from "../src/resetDb.js";

const app = createApp();

beforeEach(() => resetDb());
afterAll(() => pool.end());

async function newCart(): Promise<string> {
  const res = await request(app).post("/carts");
  expect(res.status).toBe(201);
  return res.body.id;
}

describe("carts", () => {
  test("add, merge, update and remove items with correct totals", async () => {
    const id = await newCart();

    await request(app).post(`/carts/${id}/items`).send({ productId: "p_mouse", quantity: 1 });
    const merged = await request(app).post(`/carts/${id}/items`).send({ productId: "p_mouse", quantity: 2 });
    expect(merged.body.items[0].quantity).toBe(3);
    expect(merged.body.subtotalPaise).toBe(3 * 99900);

    const updated = await request(app).patch(`/carts/${id}/items/p_mouse`).send({ quantity: 5 });
    expect(updated.body.subtotalPaise).toBe(5 * 99900);

    const removed = await request(app).delete(`/carts/${id}/items/p_mouse`);
    expect(removed.status).toBe(200);
    expect(removed.body.items).toEqual([]);
    expect(removed.body.subtotalPaise).toBe(0);
  });

  test("invalid quantities and unknown products never enter the cart", async () => {
    const id = await newCart();

    for (const quantity of [0, -1, 1.5, "2", 101, undefined]) {
      const res = await request(app).post(`/carts/${id}/items`).send({ productId: "p_mouse", quantity });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    }
    const unknown = await request(app).post(`/carts/${id}/items`).send({ productId: "p_nope", quantity: 1 });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("PRODUCT_NOT_FOUND");

    const cart = await request(app).get(`/carts/${id}`);
    expect(cart.body.items).toEqual([]);
  });

  test("cannot add more than current stock", async () => {
    const id = await newCart();
    const res = await request(app).post(`/carts/${id}/items`).send({ productId: "p_lamp", quantity: 3 });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
    expect(res.body.error.details).toEqual({ productId: "p_lamp", requested: 3, available: 2 });
  });

  test("unknown or malformed cart id returns 404", async () => {
    for (const id of ["not-a-uuid", "00000000-0000-0000-0000-000000000000"]) {
      const res = await request(app).get(`/carts/${id}`);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("CART_NOT_FOUND");
    }
  });

  test("a checked-out cart cannot be edited", async () => {
    const id = await newCart();
    await pool.query("UPDATE carts SET status = 'checked_out' WHERE id = $1", [id]);

    const res = await request(app).post(`/carts/${id}/items`).send({ productId: "p_mouse", quantity: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CART_NOT_OPEN");
  });

  test("concurrent adds to the same cart do not lose updates", async () => {
    const id = await newCart();

    // 10 requests at the same time, each adding 1 mouse.
    await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app).post(`/carts/${id}/items`).send({ productId: "p_mouse", quantity: 1 }),
      ),
    );

    const cart = await request(app).get(`/carts/${id}`);
    expect(cart.body.items[0].quantity).toBe(10);
  });
});
