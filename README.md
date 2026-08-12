# rag-postgres-retrieval

A multi-tenant retrieval engine that answers questions from a company's own
documents — built on plain PostgreSQL, with no vector database and no
embedding API.

Extracted from the context engine of [Arnie](https://www.arniechat.com), a
production AI assistant platform for small businesses in Latin America. The
ingestion pipeline, the chunker and the retrieval cascade are the code that
runs in production; the surrounding framework glue has been replaced so the
whole thing runs locally with one command against sample data.

---

## The problem

A business uploads its price list as a PDF, points the crawler at its website,
and types a few FAQs. A customer then writes, at 23:41, in Spanish, with a
typo:

> ¿asta que ora atienden los sabados?

The engine has to find the paragraph that answers that — from *that business's*
documents and nobody else's — fast enough to sit inside a chat response.

Three things make this harder than a `LIKE '%...%'`:

1. **The query is misspelled and unaccented.** `asta` for `hasta`, `sabados`
   for `sábados`. Postgres' `english` stemmer is no help: it does not know
   Spanish, and it will not bridge a missing `h`.
2. **The corpus is mixed-language.** A hotel's site has Spanish body copy and
   English page titles. A winery answers tourists in both.
3. **It is multi-tenant.** Every row belongs to exactly one company, and a leak
   across that boundary is the worst bug this system can have.

## The design decision: no vector database

The obvious 2024 answer is embeddings — pgvector, Pinecone, Weaviate — and this
project deliberately does not use them. The reasoning:

| | Embeddings | Postgres FTS + trigram |
|---|---|---|
| Infrastructure | A vector store, or an extension your host may not offer | The database you already run |
| Cost per ingest | An API call per chunk, forever | Zero |
| Cost per query | An API call before you can search | Zero |
| Latency | Network round-trip on the hot path | One local query |
| Typos / accents | Handled well | Handled by trigram + `unaccent` |
| True synonymy | Handled well | **Not handled** |
| Failure mode | Your search is down when the embedding API is | Degrades to the next strategy |

For the actual workload — a few hundred chunks per tenant, queries that mostly
share vocabulary with the source documents — the second column wins on every
axis that mattered, and loses on one that rarely came up. A customer asking
about "horarios" is quoting the document; they are not asking about "temporal
availability windows".

**This is a trade-off, not a claim of superiority.** The moment the corpus grows
past what a GIN index answers comfortably, or the questions stop sharing
vocabulary with the sources, embeddings become the right call. The cascade
below is designed so that adding a fifth strategy — a vector search — is a
new block, not a rewrite.

---

## The retrieval cascade

Four strategies run in order. Each one only runs if the ones before it have not
already produced enough results, and each one skips rows the previous ones
already returned. The query stops as soon as it has `limit` chunks.

```
query: "asta que ora atienden los sabados"
   │
   ├─ 1. English FTS ─────────── to_tsquery('english', …) against a tsvector
   │       stemmed, ranked by ts_rank                    ↓ nothing
   │
   ├─ 2. Simple FTS ──────────── to_tsquery('simple', …)
   │       unstemmed — catches Spanish words the         ↓ nothing
   │       English stemmer mangles
   │
   ├─ 3. Trigram similarity ──── similarity(content, query) > 0.01
   │       pg_trgm. This is the one that survives        ↓ 3 chunks
   │       "asta"/"hasta" and "sabados"/"sábados"
   │
   └─ 4. Unaccented ILIKE ────── unaccent(content) ILIKE unaccent('%word%')
           last resort, per keyword
```

**Why this order.** Cheapest and most precise first. Strategies 1 and 2 hit a
GIN index on a stored `tsvector` and give a real relevance ranking. Strategy 3
is fuzzy and slower but is the one that actually rescues misspellings. Strategy
4 has no ranking at all and exists so that a query that would otherwise return
nothing returns *something*.

**Why two full-text strategies.** The `searchVector` column is built as
`to_tsvector('english', content) || to_tsvector('simple', content)` — both
dictionaries in one vector. The English pass finds stemmed matches; the simple
pass finds literal ones. A Spanish word run through the English stemmer often
lands on a token that matches nothing, so the unstemmed copy is what makes
Spanish work at all without installing a Spanish dictionary.

**Every strategy is wrapped in its own try/catch.** If `pg_trgm` is not
installed, strategy 3 logs a warning and the cascade carries on. A missing
extension degrades the quality of the results; it does not break search.

### Multi-tenant isolation

Every query in the cascade — all four — carries `WHERE c."companyId" = $n`, and
`companyId` is denormalised onto the chunk row precisely so that no strategy can
reach a chunk through a join it forgot to filter. There is a test that asserts a
query from tenant A cannot retrieve tenant B's content, including for the
fallback strategies, which are the easy ones to get wrong.

---

## Ingestion

```
PDF / DOCX / TXT ──┐
                   ├─→ text extraction ──→ cleaning ──→ chunking ──→ tsvector
website URL ───────┘                                                    │
                                                                        ▼
                                                              context_chunks
```

**Text extraction** handles PDF (`pdf.js-extract`), DOCX (`mammoth`) and plain
text.

**Website crawling** is a breadth-first walk from a start URL, following only
same-domain links, capped at `maxPages`. It skips asset URLs, feeds, admin
paths and social domains; it rejects JSON and XML bodies even when the
`content-type` header lies about them. Pages are parsed with Cheerio, and text
is pulled from semantic elements (`p`, `h1`–`h6`, `li`, `td`, …) rather than
from the body, which is what makes it survive page builders like Elementor
where the real content sits under a dozen wrapper `div`s.

Two cleaning passes are worth calling out because they came from watching real
sites break the naive version:

- **Weird-casing normalisation.** PDFs and some CMSs emit `SupERFICIE`.
  Words with 4+ characters that mix cases and have 2+ capitals after the first
  are title-cased — while all-caps acronyms (`HTML`, `PDF`, `API`) are left
  alone.
- **Near-duplicate page removal.** Many small business sites serve the same
  content under several URLs. Pages whose word sets overlap by more than 80%
  (Jaccard similarity) are dropped, so the index is not three copies of the
  same paragraph.

**Chunking** splits on sentence boundaries and accumulates until a target of
500 words, with a hard floor of 300 and a ceiling of 800. Sentences are joined
with blank lines so Markdown structure (`##` headings, `**bold**`) survives
indexing.

---

## Running it

Requires Node 20+ and Docker.

```bash
git clone https://github.com/maurogenna23/rag-postgres-retrieval
cd rag-postgres-retrieval
npm install
cp .env.example .env

# Postgres 16 with unaccent + pg_trgm, bound to 127.0.0.1:5433
docker compose up -d

# Creates the schema, its extensions and its indexes
npm run db:setup

# Ingests the fixtures: two fictional tenants, Acme Corp and Globex
npm run seed
```

Then search:

```bash
# Clean query — full-text search answers it
npm run search -- --tenant acme "reprogramacion turno"

# Unaccented, and the stemmer cannot bridge it — falls through to trigram
npm run search -- --tenant acme "sabados abren"

# The same query against the other tenant never touches Acme's documents
npm run search -- --tenant globex "sabados abren"
```

Each result says which pass produced it, so you can watch the cascade fall
through. Real output, from the fixtures in this repository:

```
$ npm run search -- --tenant acme "sabados abren"

  Acme Corp · "sabados abren"

  strategy 1 (english fts).... 0 rows
  strategy 2 (simple fts)..... 0 rows
  strategy 3 (trigram)........ 3 rows
  strategy 4 (unaccent ilike). 0 rows
  ──────────────────────────────────────────────────────────────────────

  [trigram · 0.022] chunk #0 · 166 words
    ## Servicios y precios de referencia La consulta inicial de diagnóstico…

  [trigram · 0.017] chunk #0 · 407 words
    ## Horarios de atención Atendemos de lunes a viernes de 9 a 20 horas, de
    corrido, sin cerrar al mediodía. Los sábados abrimos de 9 a 13…
```

Note what that output shows, because it is the honest version: trigram found
the right paragraph, and ranked it **second**. See
[Where this design falls short](#where-this-design-falls-short).

Crawl a real site into a tenant:

```bash
npm run crawl -- --tenant acme --url https://example.com --max-pages 20
```

Run the tests:

```bash
npm test
```

---

---

## Where this design falls short

Three limitations, all of them visible in the demo above.

**Trigram ranks by whole-chunk overlap, so it favours short chunks.**
`similarity(content, query)` compares the query against the entire chunk, and
the score is normalised by length. A 166-word chunk that shares a few trigrams
outranks a 407-word chunk that actually answers the question. In the product
this mattered less than it looks — the caller passes the top *k* chunks to an
LLM, which reads all of them and picks — but as pure retrieval it is a real
weakness. Chunk-level scoring against a sub-window, or a rerank pass, would fix
it; neither is here.

**There is no synonymy.** "Horario" and "cuándo abren" share no tokens and no
trigrams. Nothing in this cascade bridges that gap, and no amount of tuning
will. This is the one thing embeddings genuinely buy, and the reason the
cascade is written as an ordered list of independent strategies: adding a
vector pass is a new block, not a rewrite.

**Scores are not comparable across strategies.** `ts_rank` and `similarity`
are different scales, so the assembled result list is ordered by *which pass
found it first*, then by that pass's own score. It is a deliberate ranking —
precise strategies before fuzzy ones — but it is not a single global relevance
order, and the `score` field should not be read as one.

## What is in here

```
src/
  db/
    schema.sql          Tables, extensions, GIN indexes (FTS + trigram)
    client.ts           pg Pool, configured from DATABASE_URL
  ingest/
    chunking.ts         Sentence-aware chunker, 300–800 words
    text-extraction.ts  PDF/DOCX/TXT extraction, BFS crawler, cleaning, dedup
    ingest.ts           Orchestration: extract → chunk → store → index
  retrieval/
    search.ts           The four-strategy cascade
  cli/
    setup.ts  seed.ts  search.ts  crawl.ts
fixtures/
  acme-corp/            Sample documents for tenant A
  globex/               Sample documents for tenant B
test/
  chunking.test.ts      Chunk boundaries, word counts, Markdown survival
  isolation.test.ts     A tenant cannot retrieve another tenant's chunks
  cascade.test.ts       Each strategy fires when the ones before it miss
```

## Verification

Everything above was run before publishing: schema applied, fixtures ingested,
all 16 tests green against PostgreSQL 16 with `unaccent` and `pg_trgm`
installed. The sample output in this README is copied from a real run, not
written by hand.

One caveat: it was verified against a local PostgreSQL 16, not against the
`docker-compose.yml` in this repository, because Docker was not available on
the machine where it was assembled. Its YAML parses and it pins the same major
version, and the standard image ships both extensions — but it has never been
brought up, so if something here fails for you, that is the file to suspect.

The compose file binds the database to `127.0.0.1` rather than publishing it on
every interface, and takes its credentials from the environment with throwaway
defaults. That is worth noting because the obvious `'5433:5432'` form listens
on `0.0.0.0`: on a shared network it hands a guessable-password database to
anyone on the same wifi. It holds nothing but the invented fixtures in this
repository, but it should not be answering the LAN either way.

## Notes on the extraction

This repository is a portfolio piece, not a fork of a running product. What
that means concretely:

- `chunking.ts` is byte-for-byte the production file, below its header comment.
- `text-extraction.ts` keeps every extraction, cleaning and deduplication rule;
  what changed is `require` → dynamic `import` (this package is ESM), the
  crawler User-Agent, and three methods that the original marks `@deprecated`.
- The four SQL strategies in `search.ts` are the production SQL. What changed
  around them is the driver — TypeORM's `repository.query` became a `pg` pool —
  and a `strategy` label added to each row so the CLI can show its trace.
- The NestJS controller, the auth guards, the TypeORM entities and the
  multi-module wiring were removed and replaced with a thin `pg` layer, a
  `schema.sql` and a CLI, so the repository runs on its own. The product's
  CRUD around contexts — create, retry, delete, stats — is not here; it is
  product surface, not retrieval.
- All content in `fixtures/` is invented. No customer document, company name or
  identifier from the original product appears anywhere in this repository.
- There are no API keys, because this engine calls no external service. Its
  only dependency is a PostgreSQL connection string.

## License

MIT — see [LICENSE](LICENSE).
