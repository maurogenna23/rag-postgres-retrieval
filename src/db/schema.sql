-- Schema for the retrieval engine.
--
-- In the product this came from, these tables are TypeORM entities inside a
-- much larger model. Here they are plain SQL and reduced to what retrieval
-- actually needs, so the interesting parts — the extensions, the generated
-- search vector and the two GIN indexes — are visible in one file.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- unaccent powers the last fallback strategy (accent-insensitive ILIKE).
-- pg_trgm powers strategy 3, which is the one that survives typos.
-- Both ship with the standard Postgres image. If either is missing the
-- corresponding strategy degrades instead of breaking — see search.ts.
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- The tenant. Deliberately minimal: in the original this table carries the
-- whole commercial model, none of which retrieval needs.
CREATE TABLE IF NOT EXISTS companies (
  id    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  name  text NOT NULL,
  slug  text NOT NULL UNIQUE
);

-- One row per ingested source: an uploaded file, a crawled site, a typed FAQ.
CREATE TABLE IF NOT EXISTS company_contexts (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "companyId"   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type          text NOT NULL CHECK (type IN ('DOCUMENT', 'WEBSITE', 'FAQ', 'PROCESS')),
  title         text NOT NULL,
  metadata      jsonb,
  status        text NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING', 'PROCESSING', 'INDEXED', 'ERROR')),
  "errorMessage" text,
  "createdAt"   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS context_chunks (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  "contextId"   uuid NOT NULL REFERENCES company_contexts(id) ON DELETE CASCADE,

  -- Denormalised on purpose. Every retrieval strategy filters on this column
  -- directly, so no strategy can reach a chunk through a join it forgot to
  -- constrain. Tenant isolation should not depend on remembering to write a
  -- JOIN correctly four times.
  "companyId"   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,

  content       text NOT NULL,
  "chunkIndex"  integer NOT NULL DEFAULT 0,
  "wordCount"   integer NOT NULL DEFAULT 0,

  -- Two dictionaries in one vector. The english pass gives stemmed matches and
  -- a usable ts_rank; the simple pass keeps the literal tokens, which is what
  -- makes Spanish work without installing a Spanish dictionary — the english
  -- stemmer maps many Spanish words onto tokens that match nothing.
  "searchVector" tsvector,

  "createdAt"   timestamptz NOT NULL DEFAULT now()
);

-- Strategies 1 and 2 read this.
CREATE INDEX IF NOT EXISTS "IDX_context_chunks_search_vector"
  ON context_chunks USING GIN ("searchVector");

-- Strategy 3 reads this. Without it, similarity() degrades to a sequential
-- scan over every chunk in the tenant.
CREATE INDEX IF NOT EXISTS "IDX_context_chunks_content_trgm"
  ON context_chunks USING GIN (content gin_trgm_ops);

-- Every query in the cascade starts by narrowing to one tenant.
CREATE INDEX IF NOT EXISTS "IDX_context_chunks_company_context"
  ON context_chunks ("companyId", "contextId");
