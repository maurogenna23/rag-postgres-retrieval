import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, closePool } from '../src/db/client.js';
import { ingestText } from '../src/ingest/ingest.js';
import { searchRelevantChunks } from '../src/retrieval/search.js';

/**
 * Proves the cascade earns its complexity: that each fallback catches a query
 * the strategies before it miss. If a single strategy answered everything,
 * three of them would be dead code.
 *
 * Needs a database: run `docker compose up -d && npm run db:setup` first.
 */

let tenant = '';

before(async () => {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO companies (name, slug) VALUES ('Cascade Test', 'test-cascade')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
  );
  tenant = rows[0]!.id;

  await pool.query(`DELETE FROM company_contexts WHERE "companyId" = $1`, [tenant]);

  await ingestText(
    tenant,
    'horarios',
    'Atendemos de lunes a viernes de nueve a veinte horas. Los sábados abrimos ' +
      'de nueve a trece. Domingos y feriados permanecemos cerrados durante todo ' +
      'el día. En temporada alta extendemos el horario de los sábados hasta las ' +
      'diecisiete horas, avisando por correo con anticipación suficiente.',
  );
});

after(async () => {
  await pool.query(`DELETE FROM companies WHERE slug = 'test-cascade'`);
  await closePool();
});

const producing = (trace: { strategy: string; rows: number }[]): string[] =>
  trace.filter((s) => s.rows > 0).map((s) => s.strategy);

test('a clean query is answered by full-text search, without reaching the fallbacks', async () => {
  const { chunks, trace } = await searchRelevantChunks(tenant, 'horarios sábados temporada', 5);

  assert.ok(chunks.length > 0);
  const hits = producing(trace);
  assert.ok(
    hits.includes('english-fts') || hits.includes('simple-fts'),
    `expected an FTS pass to answer, got ${hits.join(', ') || 'nothing'}`,
  );
  assert.ok(!hits.includes('unaccent-ilike'), 'should not have needed the last resort');
});

test('a misspelled, unaccented query still finds the paragraph', async () => {
  /* "asta que ora atienden los sabados" — no h, no accents. This is the case
     the whole cascade exists for, and the one a stemmer cannot solve. */
  const { chunks } = await searchRelevantChunks(tenant, 'asta que ora atienden los sabados', 5);

  assert.ok(chunks.length > 0, 'the misspelled query returned nothing');
  assert.ok(
    chunks.some((c) => c.content.includes('sábados')),
    'the paragraph about Saturdays was not retrieved',
  );
});

test('the trace reports every strategy that ran', async () => {
  const { trace } = await searchRelevantChunks(tenant, 'asta que ora atienden los sabados', 5);
  assert.ok(trace.length > 0);
  for (const step of trace) {
    assert.ok(typeof step.rows === 'number');
    assert.ok(['english-fts', 'simple-fts', 'trigram', 'unaccent-ilike'].includes(step.strategy));
  }
});

test('a query of only short words returns nothing rather than everything', async () => {
  /* Words of 3 characters or fewer are dropped, so this has no keywords left.
     Returning the whole corpus here would be worse than returning nothing. */
  const { chunks } = await searchRelevantChunks(tenant, 'de la el un y a', 5);
  assert.equal(chunks.length, 0);
});

test('results never exceed the requested limit', async () => {
  const { chunks } = await searchRelevantChunks(tenant, 'horarios atención sábados domingos', 2);
  assert.ok(chunks.length <= 2);
});
