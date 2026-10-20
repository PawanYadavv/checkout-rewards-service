import { afterAll, beforeEach, expect, test } from "vitest";
import request from "supertest";
import { pool } from "../src/db.js";
import { resetDb } from "../src/resetDb.js";
import { app, cartWith, checkout, inventory } from "./helpers.js";

beforeEach(() => resetDb());
afterAll(() => pool.end());

test("checkout creates an order, takes stock and closes the cart", async () => {
  const cartId = await cartWith({ p_mouse: 2, p_cable: 1 });

  const res = await checkout(cartId);

  expect(res.status).toBe(201);
  expect(res.body.subtotalPaise).toBe(2 * 99900 + 29999);
  expect(res.body.totalPaise).toBe(2 * 99900 + 29999);
  expect(await inventory("p_mouse")).toBe(98);
  expect((await request(app).get(`/carts/${cartId}`)).body.status).toBe("checked_out");
  expect((await request(app).get(`/orders/${res.body.id}`)).body).toEqual(res.body);
});

test("order keeps the price paid even if the product price changes later", async () => {
  const res = await checkout(await cartWith({ p_mouse: 1 }));
  await pool.query("UPDATE products SET price_paise = 1 WHERE id = 'p_mouse'");

  const order = await request(app).get(`/orders/${res.body.id}`);
  expect(order.body.items[0].unitPricePaise).toBe(99900);
});

test("a cart cannot be checked out twice", async () => {
  const cartId = await cartWith({ p_mouse: 1 });
  await checkout(cartId);

  const second = await checkout(cartId);
  expect(second.status).toBe(409);
  expect(second.body.error.code).toBe("CART_NOT_OPEN");
  expect(await inventory("p_mouse")).toBe(99);
});

test("failed checkout changes nothing (stock taken by someone else first)", async () => {
  const a = await cartWith({ p_lamp: 2, p_mouse: 1 });
  const b = await cartWith({ p_lamp: 2 }); // soft check passes: stock is still 2
  await checkout(b);

  const res = await checkout(a);
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe("INSUFFICIENT_STOCK");
  expect(res.body.error.details).toEqual([{ productId: "p_lamp", requested: 2, available: 0 }]);
  expect(await inventory("p_mouse")).toBe(100); // mouse stock was rolled back too
  expect((await request(app).get(`/carts/${a}`)).body.status).toBe("open");
});

test("concurrent checkouts never oversell the last units", async () => {
  // Lamp stock is 2. Five customers each try to buy 1 at the same moment.
  const carts = await Promise.all(Array.from({ length: 5 }, () => cartWith({ p_lamp: 1 })));

  const results = await Promise.all(carts.map((c) => checkout(c)));

  const statuses = results.map((r) => r.status).sort();
  expect(statuses).toEqual([201, 201, 409, 409, 409]);
  expect(await inventory("p_lamp")).toBe(0);
});

test("empty cart and missing Idempotency-Key are rejected", async () => {
  const empty = await checkout(await cartWith({}));
  expect(empty.body.error.code).toBe("CART_EMPTY");

  const noKey = await request(app).post(`/carts/${await cartWith({ p_mouse: 1 })}/checkout`);
  expect(noKey.status).toBe(400);
  expect(noKey.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
});

test("retry with the same key returns the same order and takes stock once", async () => {
  const cartId = await cartWith({ p_mouse: 2 });

  const first = await checkout(cartId, "key-1");
  const retry = await checkout(cartId, "key-1");

  expect(retry.status).toBe(201);
  expect(retry.headers["idempotent-replayed"]).toBe("true");
  expect(retry.body).toEqual(first.body);
  expect(await inventory("p_mouse")).toBe(98);
});

test("5 simultaneous retries with the same key create exactly one order", async () => {
  const cartId = await cartWith({ p_mouse: 1 });

  const results = await Promise.all(Array.from({ length: 5 }, () => checkout(cartId, "same-key")));

  expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
  expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
  expect(await inventory("p_mouse")).toBe(99);
});

test("same key on a different cart is rejected", async () => {
  await checkout(await cartWith({ p_mouse: 1 }), "key-x");

  const res = await checkout(await cartWith({ p_cable: 1 }), "key-x");
  expect(res.status).toBe(422);
  expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
});

test("a failed checkout does not burn the key: fix the cart and retry with the same key", async () => {
  const a = await cartWith({ p_lamp: 2 });
  await checkout(await cartWith({ p_lamp: 2 }), "other"); // someone else takes the lamps

  expect((await checkout(a, "key-a")).status).toBe(409);

  await request(app).delete(`/carts/${a}/items/p_lamp`);
  await request(app).post(`/carts/${a}/items`).send({ productId: "p_mouse", quantity: 1 });
  expect((await checkout(a, "key-a")).status).toBe(201);
});

test("price change before checkout: cart shows and checkout charges the new price", async () => {
  const cartId = await cartWith({ p_mouse: 1 });
  await pool.query("UPDATE products SET price_paise = 120000 WHERE id = 'p_mouse'");

  expect((await request(app).get(`/carts/${cartId}`)).body.subtotalPaise).toBe(120000);
  expect((await checkout(cartId)).body.totalPaise).toBe(120000);
});

test("item added while checkout runs is either in the order or rejected, never lost", async () => {
  for (let i = 0; i < 10; i++) {
    const cartId = await cartWith({ p_mouse: 1 });

    const [order, add] = await Promise.all([
      checkout(cartId),
      request(app).post(`/carts/${cartId}/items`).send({ productId: "p_cable", quantity: 1 }),
    ]);

    const cableInOrder = order.body.items.some((i: any) => i.productId === "p_cable");
    if (add.status === 200) expect(cableInOrder).toBe(true); // add won the cart lock first
    else expect(add.body.error.code).toBe("CART_NOT_OPEN"); // checkout won; add was refused
  }
});
