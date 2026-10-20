import { pool } from "../db.js";
import { resetDb } from "../resetDb.js";

await resetDb();
console.log("Database reset: tables created and products seeded.");
await pool.end();
