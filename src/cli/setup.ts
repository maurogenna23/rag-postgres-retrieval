import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from '../db/client.js';

/** Applies schema.sql: extensions, tables and the two GIN indexes. */
const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, '..', 'db', 'schema.sql');

async function main(): Promise<void> {
  const sql = fs.readFileSync(schemaPath, 'utf-8');
  await pool.query(sql);

  const { rows } = await pool.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname IN ('unaccent', 'pg_trgm')`,
  );
  const installed = rows.map((r) => r.extname);

  console.log('Schema applied.');
  for (const ext of ['unaccent', 'pg_trgm']) {
    console.log(
      installed.includes(ext)
        ? `  ${ext} …… installed`
        : `  ${ext} …… MISSING — the matching strategy will be skipped at query time`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
