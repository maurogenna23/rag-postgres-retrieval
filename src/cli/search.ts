import { pool, closePool } from '../db/client.js';
import { searchRelevantChunks } from '../retrieval/search.js';

/**
 * Query CLI.
 *
 * Prints the trace before the results, because watching the cascade fall
 * through is the point of the demo: a clean query stops at strategy 1, a
 * misspelled one falls to trigram.
 *
 *   npm run search -- --tenant acme "horarios de atención"
 */

const LABEL: Record<string, string> = {
  'english-fts': 'strategy 1 (english fts)',
  'simple-fts': 'strategy 2 (simple fts)',
  trigram: 'strategy 3 (trigram)',
  'unaccent-ilike': 'strategy 4 (unaccent ilike)',
};

function parseArgs(argv: string[]): { tenant: string; query: string; limit: number } {
  let tenant = 'acme';
  let limit = 5;
  const rest: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tenant') tenant = argv[++i] ?? tenant;
    else if (argv[i] === '--limit') limit = Number(argv[++i] ?? limit);
    else rest.push(argv[i]!);
  }

  return { tenant, query: rest.join(' ').trim(), limit };
}

async function main(): Promise<void> {
  const { tenant, query, limit } = parseArgs(process.argv.slice(2));

  if (!query) {
    console.error('Usage: npm run search -- --tenant <slug> "your question"');
    process.exitCode = 1;
    return;
  }

  const { rows } = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM companies WHERE slug = $1`,
    [tenant],
  );
  const company = rows[0];
  if (!company) {
    console.error(`No tenant with slug "${tenant}". Run \`npm run seed\` first.`);
    process.exitCode = 1;
    return;
  }

  const started = Date.now();
  const { chunks, trace } = await searchRelevantChunks(company.id, query, limit);
  const ms = Date.now() - started;

  console.log(`\n  ${company.name} · "${query}"\n`);

  for (const step of trace) {
    const label = (LABEL[step.strategy] ?? step.strategy).padEnd(28, '.');
    console.log(`  ${label} ${step.rows} rows${step.skipped ? `  (skipped: ${step.skipped})` : ''}`);
  }

  console.log('  ' + '─'.repeat(70));

  if (chunks.length === 0) {
    console.log('  no results\n');
    return;
  }

  for (const chunk of chunks) {
    const score = chunk.score === null ? '' : ` · ${chunk.score.toFixed(3)}`;
    const preview = chunk.content.replace(/\s+/g, ' ').slice(0, 180);
    console.log(`\n  [${chunk.strategy}${score}] chunk #${chunk.chunkIndex} · ${chunk.wordCount} words`);
    console.log(`    ${preview}…`);
  }

  console.log(`\n  ${chunks.length} results in ${ms} ms\n`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
