import { pool } from '../db/client.js';

/**
 * The retrieval cascade.
 *
 * Four strategies, cheapest and most precise first. Each runs only if the ones
 * before it have not already filled the result set, and each excludes the rows
 * its predecessors already returned. The SQL is the production SQL; what
 * changed is the driver (TypeORM's `repository.query` became a `pg` pool) and
 * the addition of a `strategy` label on each row so the CLI can show which
 * pass produced a result.
 *
 * The ordering is the whole design:
 *
 *   1. english FTS  — stemmed, GIN-indexed, gives a real ts_rank ordering
 *   2. simple FTS   — unstemmed; this is what makes Spanish work without
 *                     installing a Spanish dictionary
 *   3. trigram      — pg_trgm similarity; the pass that survives typos and
 *                     missing accents, which is most of what real users type
 *   4. unaccent+ILIKE — no ranking at all, exists so that a query which would
 *                     otherwise return nothing returns something
 *
 * Every strategy is wrapped in its own try/catch. A missing extension degrades
 * the quality of the answer; it does not take search down.
 *
 * Tenant isolation: all four queries filter on `"companyId" = $n`. That column
 * is denormalised onto the chunk row so no strategy can reach a chunk through
 * a join it forgot to constrain.
 */

export type Strategy = 'english-fts' | 'simple-fts' | 'trigram' | 'unaccent-ilike';

export interface RetrievedChunk {
  id: string;
  contextId: string;
  companyId: string;
  content: string;
  chunkIndex: number;
  wordCount: number;
  /** Which pass produced this row. */
  strategy: Strategy;
  /** ts_rank for the FTS passes, similarity for trigram, null for ILIKE. */
  score: number | null;
}

export interface SearchTrace {
  strategy: Strategy;
  rows: number;
  skipped?: string;
}

export interface SearchResult {
  chunks: RetrievedChunk[];
  /** What each pass did — used by the CLI, and by the cascade test. */
  trace: SearchTrace[];
}

interface Row {
  id: string;
  contextId: string;
  companyId: string;
  content: string;
  chunkIndex: number;
  wordCount: number;
  rank?: string | number;
  sim?: string | number;
}

const toNumber = (v: string | number | undefined): number | null =>
  v === undefined || v === null ? null : Number(v);

export async function searchRelevantChunks(
  companyId: string,
  query: string,
  limit = 5,
): Promise<SearchResult> {
  /* Words of three characters or fewer are dropped: in both Spanish and
     English they are almost entirely articles and prepositions, and they match
     everything, which is worse than matching nothing. */
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 3);

  if (keywords.length === 0) {
    return { chunks: [], trace: [] };
  }

  /* OR rather than AND. A partial match ranked by ts_rank beats no match: the
     ranking is what separates the good hits, not the query operator. */
  const tsQuery = keywords.join(' | ');

  const collected: RetrievedChunk[] = [];
  const seenIds = new Set<string>();
  const trace: SearchTrace[] = [];

  const addResults = (rows: Row[], strategy: Strategy) => {
    let added = 0;
    for (const row of rows) {
      if (!seenIds.has(row.id)) {
        seenIds.add(row.id);
        collected.push({
          id: row.id,
          contextId: row.contextId,
          companyId: row.companyId,
          content: row.content,
          chunkIndex: row.chunkIndex,
          wordCount: row.wordCount,
          strategy,
          score: toNumber(row.rank ?? row.sim),
        });
        added++;
      }
    }
    trace.push({ strategy, rows: added });
  };

  // ── Strategy 1: english-stemmed FTS ────────────────────────────────────────
  try {
    const { rows } = await pool.query<Row>(
      `SELECT c.*, ts_rank(c."searchVector", to_tsquery('english', $1)) AS rank
         FROM "context_chunks" c
        WHERE c."companyId" = $2
          AND c."searchVector" @@ to_tsquery('english', $1)
        ORDER BY rank DESC
        LIMIT $3`,
      [tsQuery, companyId, limit],
    );
    addResults(rows, 'english-fts');
  } catch (err) {
    trace.push({ strategy: 'english-fts', rows: 0, skipped: (err as Error).message });
  }

  if (collected.length >= limit) return { chunks: collected.slice(0, limit), trace };

  // ── Strategy 2: simple (unstemmed) FTS ─────────────────────────────────────
  try {
    const { rows } = await pool.query<Row>(
      `SELECT c.*, ts_rank(c."searchVector", to_tsquery('simple', $1)) AS rank
         FROM "context_chunks" c
        WHERE c."companyId" = $2
          AND c."searchVector" @@ to_tsquery('simple', $1)
        ORDER BY rank DESC
        LIMIT $3`,
      [tsQuery, companyId, limit],
    );
    addResults(rows, 'simple-fts');
  } catch (err) {
    trace.push({ strategy: 'simple-fts', rows: 0, skipped: (err as Error).message });
  }

  if (collected.length >= limit) return { chunks: collected.slice(0, limit), trace };

  // ── Strategy 3: trigram similarity ─────────────────────────────────────────
  /* The threshold is 0.01, which is very low on purpose. similarity() compares
     the query against the *whole chunk*, and a six-word question against a
     500-word paragraph scores low even when it is the right paragraph. The
     ordering does the work; the threshold only exists to bound the scan. */
  try {
    const excludeIds = [...seenIds];
    const excludeClause =
      excludeIds.length > 0
        ? 'AND c.id NOT IN (' + excludeIds.map((_, i) => '$' + (3 + i)).join(',') + ')'
        : '';
    const limitIdx = 3 + excludeIds.length;

    const { rows } = await pool.query<Row>(
      `SELECT c.*, similarity(c.content, $1) AS sim
         FROM "context_chunks" c
        WHERE c."companyId" = $2
          AND similarity(c.content, $1) > 0.01
          ${excludeClause}
        ORDER BY sim DESC
        LIMIT $${limitIdx}`,
      [query, companyId, ...excludeIds, limit - collected.length],
    );
    addResults(rows, 'trigram');
  } catch (err) {
    trace.push({ strategy: 'trigram', rows: 0, skipped: (err as Error).message });
  }

  if (collected.length >= limit) return { chunks: collected.slice(0, limit), trace };

  // ── Strategy 4: unaccented ILIKE ───────────────────────────────────────────
  try {
    const excludeIds = [...seenIds];
    const ilikeClauses = keywords
      .map((_, idx) => `unaccent(c.content) ILIKE unaccent($${idx + 2})`)
      .join(' OR ');

    const excludeClause =
      excludeIds.length > 0
        ? 'AND c.id NOT IN (' +
          excludeIds.map((_, i) => '$' + (keywords.length + 2 + i)).join(',') +
          ')'
        : '';
    const limitIdx = keywords.length + 2 + excludeIds.length;

    const { rows } = await pool.query<Row>(
      `SELECT c.* FROM "context_chunks" c
        WHERE c."companyId" = $1
          AND (${ilikeClauses})
          ${excludeClause}
        ORDER BY c."createdAt" DESC
        LIMIT $${limitIdx}`,
      [
        companyId,
        ...keywords.map((w) => '%' + w + '%'),
        ...excludeIds,
        limit - collected.length,
      ],
    );
    addResults(rows, 'unaccent-ilike');
  } catch (err) {
    trace.push({ strategy: 'unaccent-ilike', rows: 0, skipped: (err as Error).message });
  }

  return { chunks: collected.slice(0, limit), trace };
}
