import { afterAll, beforeEach, expect, test } from "vitest";
import request from "supertest";
import { pool } from "../src/db.js";
import { resetDb } from "../src/resetDb.js";
import { app, cartWith, checkout } from "./helpers.js";

beforeEach(() => resetDb());
afterAll(() => pool.end());

async function order(items: Record<string, number>, couponCode?: string) {
  return (await checkout(await cartWith(items), undefined, couponCode)).body;
}

test("empty store reports zeros", async () => {
  const res = await request(app).get("/admin/report");

  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({
    totalOrders: 0,
    grossRevenuePaise: 0,
    totalDiscountPaise: 0,
    netRevenuePaise: 0,
    coupons: { generated: 0, available: 0, redeemed: 0 },
  });
});

test("report reconciles with the orders and coupons, and does not change state", async () => {
  // 5 orders -> earn a coupon -> 6th order uses it. A second coupon stays unearned.
  const orders: any[] = [];
  for (let i = 0; i < 5; i++) orders.push(await order({ p_cable: 1, p_mouse: 1 }));
  const code = (await request(app).post("/admin/coupons")).body.code;
  orders.push(await order({ p_mouse: 2 }, code));

  const report = (await request(app).get("/admin/report")).body;

  const sum = (key: string) => orders.reduce((s, o) => s + o[key], 0);
  expect(report.totalOrders).toBe(6);
  expect(report.grossRevenuePaise).toBe(sum("subtotalPaise"));
  expect(report.totalDiscountPaise).toBe(sum("discountPaise"));
  expect(report.totalDiscountPaise).toBeGreaterThan(0);
  expect(report.netRevenuePaise).toBe(report.grossRevenuePaise - report.totalDiscountPaise);
  expect(report.coupons).toEqual({ generated: 1, available: 0, redeemed: 1 });

  const qty = Object.fromEntries(report.quantitySoldByProduct.map((p: any) => [p.productId, p.quantity]));
  expect(qty).toMatchObject({ p_cable: 5, p_mouse: 7, p_lamp: 0 });

  // Asking again gives exactly the same answer.
  expect((await request(app).get("/admin/report")).body).toEqual(report);
});
