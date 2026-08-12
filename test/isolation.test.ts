import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, closePool } from '../src/db/client.js';
import { ingestText } from '../src/ingest/ingest.js';
import { searchRelevantChunks } from '../src/retrieval/search.js';

/**
 * The test that matters most.
 *
 * A leak across the tenant boundary is the worst bug this system can have, and
 * the easy place to introduce one is a fallback strategy — nobody forgets the
 * filter on the query they were thinking about, they forget it on strategy 4.
 * So this asserts isolation for the cascade as a whole *and* checks that all
 * four strategies carry the filter.
 *
 * Needs a database: run `docker compose up -d && npm run db:setup` first.
 */

let tenantA = '';
let tenantB = '';

/** A phrase that exists only in tenant A, in several spellings. */
const SECRET = 'plataforma confidencial ariztizabal';

before(async () => {
  const mk = async (slug: string, name: string): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO companies (name, slug) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [name, slug],
    );
    return rows[0]!.id;
  };

  tenantA = await mk('test-isolation-a', 'Tenant A');
  tenantB = await mk('test-isolation-b', 'Tenant B');

  await pool.query(`DELETE FROM company_contexts WHERE "companyId" = ANY($1)`, [[tenantA, tenantB]]);

  await ingestText(
    tenantA,
    'secret',
    `Documento reservado de Tenant A. La ${SECRET} solo se menciona acá. ` +
      'Contiene los horarios internos y las condiciones que no son públicas. ' +
      'Ninguna otra empresa debería poder recuperar este párrafo jamás.',
  );

  await ingestText(
    tenantB,
    'public',
    'Documento de Tenant B. Habla de logística, envíos y plazos de entrega. ' +
      'No menciona nada reservado de ninguna otra empresa.',
  );
});

after(async () => {
  await pool.query(`DELETE FROM companies WHERE slug IN ('test-isolation-a', 'test-isolation-b')`);
  await closePool();
});

test('tenant A can retrieve its own content', async () => {
  const { chunks } = await searchRelevantChunks(tenantA, SECRET, 5);
  assert.ok(chunks.length > 0, 'tenant A should find its own document');
  assert.ok(chunks.every((c) => c.companyId === tenantA));
});

test('tenant B cannot retrieve tenant A content, for the same query', async () => {
  const { chunks } = await searchRelevantChunks(tenantB, SECRET, 5);
  for (const chunk of chunks) {
    assert.equal(chunk.companyId, tenantB, 'a chunk from another tenant was returned');
    assert.ok(!chunk.content.includes(SECRET), 'tenant A content leaked into tenant B results');
  }
});

test('isolation holds for the fuzzy strategies too', async () => {
  /* Misspelled and unaccented, so strategies 1 and 2 miss and the query falls
     through to trigram and ILIKE — the passes where a missing filter hides. */
  const { chunks } = await searchRelevantChunks(tenantB, 'plataforma confidensial ariztizabal', 10);
  for (const chunk of chunks) {
    assert.equal(chunk.companyId, tenantB);
  }
});

test('every strategy in the cascade filters on companyId', async () => {
  /* A structural check rather than a behavioural one: read the SQL and assert
     the filter is present in all four queries. Behaviour can pass by luck when
     a fixture happens not to match. */
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/retrieval/search.ts', import.meta.url), 'utf-8'),
  );

  const selects = source.match(/FROM "context_chunks" c/g) ?? [];
  const filters = source.match(/c\."companyId" = \$\d/g) ?? [];

  assert.equal(selects.length, 4, 'expected exactly four queries against context_chunks');
  assert.equal(filters.length, 4, 'every one of the four queries must filter on companyId');
});
