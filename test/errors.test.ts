import { expect, test } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";

test("unknown route returns 404 with the JSON error format", async () => {
  const res = await request(createApp()).get("/does-not-exist");

  expect(res.status).toBe(404);
  expect(res.body.error.code).toBe("NOT_FOUND");
});

test("malformed JSON body returns 400 INVALID_JSON", async () => {
  const res = await request(createApp())
    .post("/carts")
    .set("Content-Type", "application/json")
    .send("{ not json");

  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe("INVALID_JSON");
});
