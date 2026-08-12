import { pool, closePool } from '../db/client.js';
import { ingestWebsite } from '../ingest/ingest.js';

/**
 * Crawl a real site into a tenant.
 *
 *   npm run crawl -- --tenant acme --url https://example.com --max-pages 20
 *
 * The crawler is polite by construction: same-domain links only, a hard page
 * cap, and it skips feeds, assets, admin paths and social domains. It does not
 * read robots.txt — if you point it at a site you do not own, that is on you.
 */

function parseArgs(argv: string[]): { tenant: string; url: string; maxPages: number } {
  let tenant = 'acme';
  let url = '';
  let maxPages = 20;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--tenant') tenant = argv[++i] ?? tenant;
    else if (argv[i] === '--url') url = argv[++i] ?? '';
    else if (argv[i] === '--max-pages') maxPages = Number(argv[++i] ?? maxPages);
  }

  return { tenant, url, maxPages };
}

async function main(): Promise<void> {
  const { tenant, url, maxPages } = parseArgs(process.argv.slice(2));

  if (!url) {
    console.error('Usage: npm run crawl -- --tenant <slug> --url <https://…> [--max-pages 20]');
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

  console.log(`\n  Crawling ${url} into ${company.name}\n`);

  const result = await ingestWebsite(company.id, url, maxPages, (current, total) => {
    process.stdout.write(`\r  page ${current}/${total}   `);
  });

  console.log(
    `\r  ${result.pages} pages kept · ${result.chunks} chunks · ${result.words} words\n`,
  );
  console.log(`  npm run search -- --tenant ${tenant} "something from that site"\n`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(closePool);
