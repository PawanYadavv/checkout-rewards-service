import { afterAll, expect, test } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { pool } from "../src/db.js";

afterAll(() => pool.end());

test("GET /health returns ok when the database is reachable", async () => {
  const res = await request(createApp()).get("/health");

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ status: "ok" });
});
