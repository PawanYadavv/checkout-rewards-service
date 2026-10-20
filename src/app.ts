import express from "express";
import { pool } from "./db.js";
import { errorHandler, notFoundHandler } from "./errors.js";
import { cartsRouter } from "./routes/carts.js";

// Builds the app but does not start a server (server.ts does that).
// Tests pass this app to Supertest, which sends requests to it directly.
export function createApp() {
  const app = express();
  app.use(express.json());

  app.get("/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  });

  app.use("/carts", cartsRouter);

  // These two must stay last: they only run if nothing above handled the request.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
