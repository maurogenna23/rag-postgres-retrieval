import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePool } from '../db/client.js';
import { ingestFile } from '../ingest/ingest.js';

/**
 * Loads the fixtures for two fictional tenants.
 *
 * Two, not one, so that the isolation test has something to isolate *from*.
 * Every document in `fixtures/` is invented for this repository.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(here, '..', '..', 'fixtures');

const TENANTS = [
  { slug: 'acme', name: 'Acme Corp', dir: 'acme-corp' },
  { slug: 'globex', name: 'Globex S.A.', dir: 'globex' },
];

async function upsertCompany(slug: string, name: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO companies (name, slug) VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name, slug],
  );
  return rows[0]!.id;
}

async function main(): Promise<void> {
  for (const tenant of TENANTS) {
    const companyId = await upsertCompany(tenant.slug, tenant.name);

    // Re-seeding is idempotent: drop what this tenant had, then ingest again.
    await pool.query(`DELETE FROM company_contexts WHERE "companyId" = $1`, [companyId]);

    const dir = path.join(fixturesDir, tenant.dir);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') || f.endsWith('.txt'));

    console.log(`\n${tenant.name}  (--tenant ${tenant.slug})`);
    console.log(`  id ${companyId}`);

    for (const file of files) {
      const result = await ingestFile(companyId, path.join(dir, file));
      console.log(`  ${file.padEnd(18)} ${String(result.chunks).padStart(2)} chunks · ${result.words} words`);
    }
  }

  const { rows } = await pool.query<{ count: string }>(`SELECT count(*) FROM context_chunks`);
  console.log(`\n${rows[0]!.count} chunks indexed. Try:`);
  console.log(`  npm run search -- --tenant acme "horarios de atención"`);
  console.log(`  npm run search -- --tenant acme "asta que ora atienden los sabados"`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
