import 'dotenv/config';
import pg from 'pg';

/**
 * The single piece of configuration this project has.
 *
 * There is no API key anywhere in this repository because the engine calls no
 * external service: extraction, chunking and retrieval all happen locally or
 * inside Postgres.
 */
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env, or run `docker compose up -d` first.',
  );
}

export const pool = new pg.Pool({ connectionString });

export async function closePool(): Promise<void> {
  await pool.end();
}
