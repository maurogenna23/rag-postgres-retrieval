import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkingUtil } from '../src/ingest/chunking.js';

/** Needs no database. */

const words = (n: number, seed = 'palabra'): string =>
  Array.from({ length: n }, (_, i) => `${seed}${i}`).join(' ') + '.';

test('short text yields a single chunk', () => {
  const chunks = ChunkingUtil.chunkText('Atendemos de lunes a viernes de 9 a 20.');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]!.chunkIndex, 0);
  assert.ok(chunks[0]!.content.includes('lunes'));
});

test('long text is split, and no chunk exceeds the 800-word ceiling', () => {
  const text = Array.from({ length: 12 }, (_, i) => words(120, `s${i}w`)).join(' ');
  const chunks = ChunkingUtil.chunkText(text);

  assert.ok(chunks.length > 1, 'expected more than one chunk');
  for (const chunk of chunks) {
    assert.ok(chunk.wordCount <= 800, `chunk of ${chunk.wordCount} words exceeds the ceiling`);
  }
});

test('chunk indexes are contiguous and start at zero', () => {
  const text = Array.from({ length: 10 }, (_, i) => words(150, `t${i}w`)).join(' ');
  const chunks = ChunkingUtil.chunkText(text);
  assert.deepEqual(
    chunks.map((c) => c.chunkIndex),
    chunks.map((_, i) => i),
  );
});

test('no content is lost: every source word survives chunking', () => {
  const text = Array.from({ length: 6 }, (_, i) => words(200, `k${i}w`)).join(' ');
  const total = ChunkingUtil.getTotalWordCount(text);
  const chunked = ChunkingUtil.chunkText(text).reduce((sum, c) => sum + c.wordCount, 0);
  assert.equal(chunked, total);
});

test('Markdown structure survives indexing', () => {
  const text = '## Horarios\n\nAtendemos de **lunes a viernes**.\n\n## Políticas\n\nCancelás sin cargo.';
  const [chunk] = ChunkingUtil.chunkText(text);
  assert.ok(chunk!.content.includes('## Horarios'), 'heading was lost');
  assert.ok(chunk!.content.includes('**lunes a viernes**'), 'bold was lost');
});

test('accents and ñ are preserved verbatim', () => {
  const [chunk] = ChunkingUtil.chunkText('Atendemos los sábados. La señora preguntó por el año.');
  assert.ok(chunk!.content.includes('sábados'));
  assert.ok(chunk!.content.includes('señora'));
  assert.ok(chunk!.content.includes('año'));
});

test('empty input yields no chunks', () => {
  assert.deepEqual(ChunkingUtil.chunkText(''), []);
  assert.deepEqual(ChunkingUtil.chunkText('   \n\n  '), []);
});
