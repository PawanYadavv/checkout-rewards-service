import { Router } from "express";
import { pool } from "../db.js";
import { generateCoupon } from "../coupons.js";

// ADMINISTRATIVE routes. No auth (allowed by the brief); in production these need it.
export const adminRouter = Router();

adminRouter.post("/coupons", async (_req, res) => {
  res.status(201).json(await generateCoupon());
});

adminRouter.get("/coupons", async (_req, res) => {
  const { rows } = await pool.query(
    "SELECT code, milestone, percent_off, redeemed_at, created_at FROM coupons ORDER BY milestone",
  );
  res.json(
    rows.map((c) => ({
      code: c.code,
      milestone: c.milestone,
      percentOff: c.percent_off,
      status: c.redeemed_at ? "redeemed" : "available",
      redeemedAt: c.redeemed_at,
      createdAt: c.created_at,
    })),
  );
});
