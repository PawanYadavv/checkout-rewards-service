import { randomInt } from "node:crypto";
import type pg from "pg";
import { withTransaction } from "./db.js";
import { AppError } from "./errors.js";
import { config } from "./config.js";

// Integer math only. Round DOWN, and never more than the subtotal -> total is never negative.
// Example: 10% of 29999 paise = 2999.9 -> 2999.
export function calculateDiscount(subtotalPaise: number, percentOff: number): number {
  return Math.min(subtotalPaise, Math.floor((subtotalPaise * percentOff) / 100));
}

// Readable random code like "SAVE-7KQ2M9" (no 0/O or 1/I to avoid confusion).
function newCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "SAVE-";
  for (let i = 0; i < 6; i++) code += chars[randomInt(chars.length)];
  return code;
}

// Admin: create a coupon for the next milestone, if it has been reached.
// Next milestone = last rewarded milestone + N (first one is N).
export async function generateCoupon() {
  return withTransaction(async (client) => {
    // Only one generation runs at a time (other callers wait here until we commit),
    // so two admins clicking at once cannot both reward the same milestone.
    // UNIQUE(milestone) in the schema is the backup.
    await client.query("SELECT pg_advisory_xact_lock(1)");

    const orders = await client.query("SELECT count(*)::int AS n FROM orders");
    const last = await client.query("SELECT COALESCE(max(milestone), 0)::int AS m FROM coupons");
    const orderCount: number = orders.rows[0].n;
    const nextMilestone: number = last.rows[0].m + config.couponEveryNOrders;

    if (orderCount < nextMilestone) {
      throw new AppError(409, "NO_ELIGIBLE_MILESTONE", "No unrewarded milestone has been reached yet", {
        orderCount,
        nextMilestone,
      });
    }

    const { rows } = await client.query(
      `INSERT INTO coupons (code, milestone, percent_off) VALUES ($1, $2, $3)
       RETURNING code, milestone, percent_off, created_at`,
      [newCode(), nextMilestone, config.couponPercentOff],
    );
    return {
      code: rows[0].code,
      milestone: rows[0].milestone,
      percentOff: rows[0].percent_off,
      createdAt: rows[0].created_at,
    };
  });
}

// Called inside the checkout transaction. Marks the coupon used and returns its percent.
// THE anti-double-use line: only succeeds if redeemed_at is still NULL. A second checkout
// with the same coupon waits for the row lock; if the first commits, it finds
// redeemed_at set -> 0 rows -> 409. If the first rolls back, the coupon is still free.
export async function redeemCoupon(client: pg.PoolClient, code: string): Promise<number> {
  const updated = await client.query(
    "UPDATE coupons SET redeemed_at = now() WHERE code = $1 AND redeemed_at IS NULL RETURNING percent_off",
    [code],
  );
  if (updated.rowCount === 1) return updated.rows[0].percent_off;

  const exists = await client.query("SELECT 1 FROM coupons WHERE code = $1", [code]);
  if (exists.rows.length === 0) throw new AppError(404, "COUPON_NOT_FOUND", `Coupon ${code} not found`);
  throw new AppError(409, "COUPON_ALREADY_REDEEMED", `Coupon ${code} has already been used`);
}
