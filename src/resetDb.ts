import { readFileSync } from "node:fs";
import { pool } from "./db.js";

// Wipes everything and recreates tables + seed data. Used by `npm run db:reset` and tests.
export async function resetDb() {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.query(readFileSync("sql/schema.sql", "utf8"));
  await pool.query(readFileSync("sql/seed.sql", "utf8"));
}
