import { Router } from "express";
import { pool } from "../db.js";
import { AppError } from "../errors.js";
import { getOrderView } from "../order.js";
import { isUuid } from "../validate.js";

export const ordersRouter = Router();

ordersRouter.get("/:orderId", async (req, res) => {
  const { orderId } = req.params;
  if (!isUuid(orderId)) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
  res.json(await getOrderView(pool, orderId));
});
