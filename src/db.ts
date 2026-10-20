
import pg from "pg";

export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://app:app@localhost:5433/checkout",
});

// A pool or a single client from it: both can run queries.
export type Db = pg.Pool | pg.PoolClient;

// Runs fn inside BEGIN/COMMIT on one connection. Any thrown error rolls everything back.
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}


