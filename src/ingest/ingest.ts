import fs from 'node:fs';
import path from 'node:path';
import { pool } from '../db/client.js';
import { ChunkingUtil } from './chunking.js';
import { TextExtractionUtil } from './text-extraction.js';

/**
 * Ingestion: turn a source into indexed chunks.
 *
 *   file or URL → extract text → clean → chunk → store → build tsvector
 *
 * Ported from the production service. What was dropped is the part that only
 * makes sense inside the product: status transitions driven by a UI, crawl
 * progress written into a jsonb column so a modal can render a spinner, and
 * the retry path. What is kept is the pipeline.
 */

export type ContextType = 'DOCUMENT' | 'WEBSITE' | 'FAQ' | 'PROCESS';

const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

async function createContext(
  companyId: string,
  type: ContextType,
  title: string,
  metadata: Record<string, unknown>,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO company_contexts ("companyId", type, title, metadata, status)
     VALUES ($1, $2, $3, $4, 'PROCESSING')
     RETURNING id`,
    [companyId, type, title, metadata],
  );
  return rows[0]!.id;
}

/**
 * Insert chunks and build their search vector.
 *
 * The vector is `to_tsvector('english', …) || to_tsvector('simple', …)` — both
 * dictionaries concatenated. Strategy 1 queries the stemmed half, strategy 2
 * the literal half, and a Spanish corpus is retrievable without a Spanish
 * dictionary being installed on the server.
 */
async function storeChunks(
  contextId: string,
  companyId: string,
  chunks: { content: string; wordCount: number; chunkIndex: number }[],
): Promise<number> {
  if (chunks.length === 0) return 0;

  const values: unknown[] = [];
  const tuples = chunks.map((c, i) => {
    const b = i * 5;
    values.push(contextId, companyId, c.content, c.chunkIndex, c.wordCount);
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
  });

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO context_chunks ("contextId", "companyId", content, "chunkIndex", "wordCount")
     VALUES ${tuples.join(', ')}
     RETURNING id`,
    values,
  );

  await pool.query(
    `UPDATE context_chunks
        SET "searchVector" = to_tsvector('english', content) || to_tsvector('simple', content)
      WHERE id = ANY($1)`,
    [rows.map((r) => r.id)],
  );

  return rows.length;
}

async function markIndexed(contextId: string, metadata: Record<string, unknown>): Promise<void> {
  await pool.query(
    `UPDATE company_contexts
        SET status = 'INDEXED', metadata = metadata || $2::jsonb
      WHERE id = $1`,
    [contextId, JSON.stringify(metadata)],
  );
}

/** Ingest raw text that is already in hand — an FAQ, a pasted process. */
export async function ingestText(
  companyId: string,
  title: string,
  text: string,
  type: ContextType = 'DOCUMENT',
): Promise<{ contextId: string; chunks: number; words: number }> {
  const contextId = await createContext(companyId, type, title, {});
  const chunks = ChunkingUtil.chunkText(text);
  const words = ChunkingUtil.getTotalWordCount(text);
  const stored = await storeChunks(contextId, companyId, chunks);
  await markIndexed(contextId, { chunkCount: stored, wordCount: words });
  return { contextId, chunks: stored, words };
}

/** Ingest a file from disk: PDF, DOCX, TXT or MD. */
export async function ingestFile(
  companyId: string,
  filePath: string,
  title?: string,
): Promise<{ contextId: string; chunks: number; words: number }> {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(`Unsupported file type: ${ext}. Supported: ${Object.keys(MIME_BY_EXT).join(', ')}`);
  }

  const text =
    mime === 'text/plain'
      ? fs.readFileSync(filePath, 'utf-8')
      : await TextExtractionUtil.extractText(filePath, mime);

  return ingestText(companyId, title ?? path.basename(filePath), text, 'DOCUMENT');
}

/**
 * Crawl a site and ingest every page it keeps.
 *
 * Each page is prefixed with its title as a Markdown heading before chunking,
 * so a chunk that ends up in a search result still says which page it is from.
 */
export async function ingestWebsite(
  companyId: string,
  url: string,
  maxPages = 20,
  onProgress?: (current: number, total: number) => void,
): Promise<{ contextId: string; pages: number; chunks: number; words: number }> {
  const contextId = await createContext(companyId, 'WEBSITE', url, { url });
  const pages = await TextExtractionUtil.crawlWebsite(url, maxPages, onProgress);

  const all: { content: string; wordCount: number; chunkIndex: number }[] = [];
  let globalIndex = 0;
  let words = 0;

  for (const page of pages) {
    const pageText = `## ${page.title || page.url}\n\n${page.content}`;
    for (const chunk of ChunkingUtil.chunkText(pageText)) {
      all.push({ content: chunk.content, wordCount: chunk.wordCount, chunkIndex: globalIndex++ });
      words += chunk.wordCount;
    }
  }

  const stored = await storeChunks(contextId, companyId, all);
  await markIndexed(contextId, {
    url,
    pageCount: pages.length,
    chunkCount: stored,
    wordCount: words,
  });

  return { contextId, pages: pages.length, chunks: stored, words };
}
