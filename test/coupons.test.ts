import { afterAll, beforeEach, expect, test } from "vitest";
import request from "supertest";
import { pool } from "../src/db.js";
import { resetDb } from "../src/resetDb.js";
import { calculateDiscount } from "../src/coupons.js";
import { app, cartWith, checkout } from "./helpers.js";

beforeEach(() => resetDb());
afterAll(() => pool.end());

// Default config: every 5 orders -> one 10% coupon.

async function placeOrders(count: number) {
  for (let i = 0; i < count; i++) await checkout(await cartWith({ p_cable: 1 }));
}

async function earnCoupon(): Promise<string> {
  await placeOrders(5);
  return (await request(app).post("/admin/coupons")).body.code;
}

test("discount rounds down and never exceeds the subtotal", () => {
  expect(calculateDiscount(29999, 10)).toBe(2999); // 2999.9 -> 2999
  expect(calculateDiscount(1, 10)).toBe(0);
  expect(calculateDiscount(500, 100)).toBe(500); // total 0, never negative
});

test("a coupon is generated only once per reached milestone", async () => {
  await placeOrders(4);
  const early = await request(app).post("/admin/coupons");
  expect(early.status).toBe(409);
  expect(early.body.error.code).toBe("NO_ELIGIBLE_MILESTONE");

  await placeOrders(1);
  const first = await request(app).post("/admin/coupons");
  expect(first.status).toBe(201);
  expect(first.body.milestone).toBe(5);

  const again = await request(app).post("/admin/coupons");
  expect(again.status).toBe(409);
});

test("5 admins generating at the same moment create exactly one coupon", async () => {
  await placeOrders(5);

  const results = await Promise.all(Array.from({ length: 5 }, () => request(app).post("/admin/coupons")));

  expect(results.filter((r) => r.status === 201)).toHaveLength(1);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM coupons");
  expect(rows[0].n).toBe(1);
});

test("coupon is applied at checkout and cannot be used twice", async () => {
  const code = await earnCoupon();

  const order = await checkout(await cartWith({ p_cable: 1 }), undefined, code);
  expect(order.status).toBe(201);
  expect(order.body).toMatchObject({ subtotalPaise: 29999, discountPaise: 2999, totalPaise: 27000, couponCode: code });

  const second = await checkout(await cartWith({ p_cable: 1 }), undefined, code);
  expect(second.status).toBe(409);
  expect(second.body.error.code).toBe("COUPON_ALREADY_REDEEMED");

  const unknown = await checkout(await cartWith({ p_cable: 1 }), undefined, "SAVE-NOPE00");
  expect(unknown.status).toBe(404);
  expect(unknown.body.error.code).toBe("COUPON_NOT_FOUND");
});

test("two checkouts using the same coupon at the same moment: only one wins", async () => {
  const code = await earnCoupon();
  const [a, b] = [await cartWith({ p_mouse: 1 }), await cartWith({ p_mouse: 1 })];

  const results = await Promise.all([checkout(a, undefined, code), checkout(b, undefined, code)]);

  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM orders WHERE coupon_code = $1", [code]);
  expect(rows[0].n).toBe(1);
});

test("a failed checkout does not use up the coupon", async () => {
  const code = await earnCoupon();
  const doomed = await cartWith({ p_lamp: 2 });
  await checkout(await cartWith({ p_lamp: 2 })); // someone else buys the lamps first

  const failed = await checkout(doomed, undefined, code);
  expect(failed.body.error.code).toBe("INSUFFICIENT_STOCK");

  const coupons = await request(app).get("/admin/coupons");
  expect(coupons.body[0].status).toBe("available");
  expect((await checkout(await cartWith({ p_mouse: 1 }), undefined, code)).status).toBe(201);
});
