import { Router } from "express";
import { pool, withTransaction } from "../db.js";
import { AppError } from "../errors.js";
import { ensureStock, getCartView, lockOpenCart, parseCartId } from "../cart.js";
import { MAX_QUANTITY, requireProductId, requireQuantity } from "../validate.js";
import { checkout } from "../checkout.js";
import { getOrderView } from "../order.js";

export const cartsRouter = Router();

cartsRouter.post("/", async (_req, res) => {
  const { rows } = await pool.query("INSERT INTO carts DEFAULT VALUES RETURNING id");
  res.status(201).json(await getCartView(pool, rows[0].id));
});

cartsRouter.get("/:cartId", async (req, res) => {
  res.json(await getCartView(pool, parseCartId(req.params.cartId)));
});

// Add a product. If it is already in the cart, the quantities are added together.
cartsRouter.post("/:cartId/items", async (req, res) => {
  const cartId = parseCartId(req.params.cartId);
  const productId = requireProductId(req.body?.productId);
  const quantity = requireQuantity(req.body?.quantity);

  const cart = await withTransaction(async (client) => {
    await lockOpenCart(client, cartId);
    const existing = await client.query(
      "SELECT quantity FROM cart_items WHERE cart_id = $1 AND product_id = $2",
      [cartId, productId],
    );
    const newQuantity = (existing.rows[0]?.quantity ?? 0) + quantity;
    if (newQuantity > MAX_QUANTITY) {
      throw new AppError(400, "VALIDATION_ERROR", `Total quantity per product cannot exceed ${MAX_QUANTITY}`);
    }
    await ensureStock(client, productId, newQuantity);
    await client.query(
      `INSERT INTO cart_items (cart_id, product_id, quantity) VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, product_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
      [cartId, productId, newQuantity],
    );
    return getCartView(client, cartId);
  });
  res.json(cart);
});

// Set an item's quantity to an exact number.
cartsRouter.patch("/:cartId/items/:productId", async (req, res) => {
  const cartId = parseCartId(req.params.cartId);
  const { productId } = req.params;
  const quantity = requireQuantity(req.body?.quantity);

  const cart = await withTransaction(async (client) => {
    await lockOpenCart(client, cartId);
    const existing = await client.query(
      "SELECT 1 FROM cart_items WHERE cart_id = $1 AND product_id = $2",
      [cartId, productId],
    );
    if (existing.rows.length === 0) throw new AppError(404, "ITEM_NOT_IN_CART", `${productId} is not in this cart`);
    await ensureStock(client, productId, quantity);
    await client.query(
      "UPDATE cart_items SET quantity = $3 WHERE cart_id = $1 AND product_id = $2",
      [cartId, productId, quantity],
    );
    return getCartView(client, cartId);
  });
  res.json(cart);
});

cartsRouter.delete("/:cartId/items/:productId", async (req, res) => {
  const cartId = parseCartId(req.params.cartId);
  const { productId } = req.params;

  const cart = await withTransaction(async (client) => {
    await lockOpenCart(client, cartId);
    const deleted = await client.query(
      "DELETE FROM cart_items WHERE cart_id = $1 AND product_id = $2",
      [cartId, productId],
    );
    if (deleted.rowCount === 0) throw new AppError(404, "ITEM_NOT_IN_CART", `${productId} is not in this cart`);
    return getCartView(client, cartId);
  });
  res.json(cart);
});


// Checkout. A retry with the same Idempotency-Key gets the same order back.
cartsRouter.post("/:cartId/checkout", async (req, res) => {
  const cartId = parseCartId(req.params.cartId);
  const key = req.get("Idempotency-Key");
  if (!key || key.length > 255) {
    throw new AppError(400, "IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header is required (max 255 chars)");
  }
  const couponCode = req.body?.couponCode;
  if (couponCode !== undefined && (typeof couponCode !== "string" || couponCode.trim() === "")) {
    throw new AppError(400, "VALIDATION_ERROR", "couponCode must be a non-empty string");
  }

  let result;
  try {
    result = await checkout(cartId, key, couponCode);
  } catch (err: any) {
    // Rare race: the same key used on two DIFFERENT carts at the same moment.
    // Both pass the lookup; the UNIQUE constraint on orders.idempotency_key stops the second.
    if (err.code === "23505" && err.constraint === "orders_idempotency_key_key") {
      throw new AppError(422, "IDEMPOTENCY_KEY_REUSED", "This Idempotency-Key was already used for another cart");
    }
    throw err;
  }

  if (result.replayed) res.set("Idempotent-Replayed", "true");
  res.status(201).json(await getOrderView(pool, result.orderId));
});
