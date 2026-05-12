# Retrieval Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Shopify-Storefront-based search with a hybrid retrieval pipeline (Postgres + pgvector + LLM query understanding + Cohere rerank) so that conversational follow-ups like "show me from another brand" return correctly filtered products.

**Architecture:** Build a local product index in the existing Railway Postgres with structured columns, a `tsvector` for keyword matching, and a 1024-dim `vector` for semantic similarity (Voyage AI `voyage-3-lite` output). Keep the index synchronized with Shopify via webhooks + nightly cron + a one-time bootstrap. On each chat turn, run a four-step pipeline — query understanding (Haiku) → hybrid SQL retrieval → Cohere rerank → Claude Sonnet reply — that the user already sees today, just with much better candidates.

**Tech Stack:** Node 20 + React Router 7 + Prisma 6 + PostgreSQL 16 with `pgvector` + `pg_trgm` extensions + Voyage AI client (`voyageai`) for `voyage-3-lite` embeddings (1024 dims) + OpenAI SDK (`openai` ≥ 4) pointed at OpenRouter for Haiku 4.5 and Sonnet 4.6 (`anthropic/claude-haiku-4-5`, `anthropic/claude-sonnet-4-6`) + Cohere SDK (`cohere-ai` ≥ 7) for `rerank-v3.5` + Vitest for tests.

**Provider note (updated 2026-05-12):** Earlier draft used OpenAI for embeddings and Anthropic SDK directly. Switched to Voyage AI (free 200M-token trial covers bootstrap + months of operation) and OpenRouter (user has $20 credit on existing key). `ANTHROPIC_API_KEY` stays in Railway as a fallback — the LLM service prefers OpenRouter when both are present.

---

## File map

### New files
| Path | Responsibility |
|---|---|
| `app/services/embeddings.server.js` | Voyage AI client wrapper; `embedOne(text)` and `embedMany(texts[])` with retry |
| `app/services/product-index.server.js` | `extractProductRow(shopifyProduct)`, `upsertProduct(row)`, `softDeleteProduct(id)` — idempotent |
| `app/services/retrieval.server.js` | `hybridSearch(intent)` — runs the parameterised SQL |
| `app/services/query-understanding.server.js` | `extractIntent(messages, lastShownCategory, lastShownBrands)` — calls Haiku, parses strict JSON |
| `app/services/rerank.server.js` | `rerank(query, candidates, topN)` — Cohere wrapper with graceful fallback |
| `app/services/admin-shopify.server.js` | Thin wrapper around Shopify Admin GraphQL for ingestion (paginated `products` fetch) |
| `app/routes/api.sync.full.jsx` | POST endpoint — runs full reconciliation; protected by `SYNC_SECRET` header |
| `scripts/bootstrap-index.js` | One-time local-run script that paginates Shopify and fills the index |
| `tests/setup/db.js` | Test helper — connect to a `TEST_DATABASE_URL`, truncate the products table between tests |
| `tests/setup/mocks.js` | Shared mock factories for Anthropic / OpenAI / Cohere clients |
| `tests/services/product-index.test.js` | Unit tests for the extractor + upsert |
| `tests/services/retrieval.test.js` | Integration tests against a real Postgres |
| `tests/services/query-understanding.test.js` | Tests with mocked Haiku |
| `tests/services/rerank.test.js` | Tests with mocked Cohere + fallback |
| `tests/eval/cases.json` | Curated eval-set query → expected-result-type pairs |
| `tests/eval/run.js` | Runs the eval set against the full pipeline (gated behind `EVAL=1`) |
| `prisma/migrations/<ts>_add_products_index/migration.sql` | Schema migration |
| `prisma/migrations/<ts>_add_conversation_last_shown/migration.sql` | Schema migration |

### Modified files
| Path | Change |
|---|---|
| `package.json` | Add deps: `voyageai`, `openai` (for OpenRouter), `cohere-ai`, `vitest`; add scripts `test`, `test:integration`, `eval` |
| `prisma/schema.prisma` | Add `Product` model + relations + `Unsupported("tsvector")` and `Unsupported("vector(1024)")` shims |
| `app/db.server.js` | Add named exports for raw SQL helpers used by retrieval |
| `app/routes/api.webhooks.jsx` | Add `PRODUCTS_CREATE`, `PRODUCTS_UPDATE`, `PRODUCTS_DELETE`, `INVENTORY_LEVELS_UPDATE` cases |
| `app/services/search-router.server.js` | Rewrite as a thin orchestrator that calls the new four modules |
| `app/services/tool.server.js` | `processProductSearchResult` simplified — input is already ranked, no re-rank needed |
| `app/services/claude.server.js` | System prompt: remove instructions to strip brand/category from queries |
| `shopify.app.toml` | Declare new webhook subscriptions |
| `.env.example` | Document `VOYAGE_API_KEY`, `OPENROUTER_API_KEY`, `COHERE_API_KEY`, `SYNC_SECRET`, `TEST_DATABASE_URL` |
| `PROGRESS.md` | Update phase tracker as tasks complete |

### Untouched (do not modify)
- `extensions/chat-bubble/*` (the storefront widget)
- `app/auth.server.js`, `app/shopify.server.js`, `app/mcp-client.js` (auth + cart wiring)
- `app/db.server.js` functions related to conversations/leads (only ADD new exports)
- `app/routes/chat.jsx` (only minor — already orchestrates streaming; we plug new pipeline through search-router)

---

## Task 1 — Set up Vitest test infrastructure

**Files:**
- Modify: `package.json` (add devDependencies + scripts)
- Create: `vitest.config.js`
- Create: `tests/setup/db.js`
- Create: `tests/setup/mocks.js`
- Create: `tests/smoke.test.js`
- Modify: `.gitignore` (add `.env.test`)

- [ ] **Step 1: Add Vitest + supporting deps**

Edit `package.json` `devDependencies` (alphabetical order, exact versions):

```json
"devDependencies": {
  "@types/node": "^20.11.0",
  "@types/react": "^18.2.31",
  "@types/uuid": "^9.0.0",
  "@vitest/coverage-v8": "^1.6.0",
  "cross-env": "^7.0.3",
  "eslint": "^8.38.0",
  "prettier": "^3.2.4",
  "typescript": "^5.2.2",
  "vite": "^6.2.2",
  "vitest": "^1.6.0"
}
```

Add to `scripts` (uses `cross-env` so Windows PowerShell and Linux/macOS both work):

```json
"test": "vitest run",
"test:watch": "vitest",
"test:integration": "cross-env INTEGRATION=1 vitest run --testTimeout=20000",
"eval": "cross-env EVAL=1 node tests/eval/run.js"
```

Run:

```powershell
npm install
```

Expected: installs vitest and coverage plugin without errors.

- [ ] **Step 2: Create `vitest.config.js`**

```js
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.js'],
    exclude: ['tests/eval/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['app/services/**/*.js'],
    },
    setupFiles: [],
  },
});
```

- [ ] **Step 3: Create `tests/setup/db.js` — test database helper**

```js
// tests/setup/db.js
import { PrismaClient } from '@prisma/client';

let prisma = null;

export function getTestPrisma() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error(
      'TEST_DATABASE_URL is required for integration tests. ' +
      'Set it to a Postgres URL with pgvector installed.'
    );
  }
  if (!prisma) {
    prisma = new PrismaClient({
      datasources: { db: { url: process.env.TEST_DATABASE_URL } },
    });
  }
  return prisma;
}

export async function truncateProducts() {
  const db = getTestPrisma();
  await db.$executeRawUnsafe('TRUNCATE TABLE products RESTART IDENTITY CASCADE');
}

export async function disconnectTestPrisma() {
  if (prisma) {
    await prisma.$disconnect();
    prisma = null;
  }
}

export function skipIfNotIntegration(name) {
  return process.env.INTEGRATION === '1' ? name : `${name} [SKIPPED — set INTEGRATION=1]`;
}
```

- [ ] **Step 4: Create `tests/setup/mocks.js` — shared mock factories**

```js
// tests/setup/mocks.js
import { vi } from 'vitest';

export function makeAnthropicMock(responseText) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: responseText }],
        stop_reason: 'end_turn',
      }),
    },
  };
}

export function makeOpenAIEmbedMock(vector) {
  const arr = Array.isArray(vector) ? vector : new Array(1024).fill(0.01);
  return {
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [{ embedding: arr, index: 0 }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 5, total_tokens: 5 },
      }),
    },
  };
}

export function makeCohereRerankMock(rankedIndices) {
  return {
    rerank: vi.fn().mockResolvedValue({
      results: rankedIndices.map((idx, position) => ({
        index: idx,
        relevance_score: 1 - position * 0.05,
      })),
    }),
  };
}
```

- [ ] **Step 5: Smoke test to verify Vitest works**

Create `tests/smoke.test.js`:

```js
import { describe, it, expect } from 'vitest';

describe('vitest smoke test', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run:

```powershell
npm test
```

Expected: 1 passing test.

- [ ] **Step 6: Update .gitignore**

Append to `.gitignore`:

```
.env.test
coverage/
.vitest/
```

- [ ] **Step 7: Commit**

```powershell
git add package.json package-lock.json vitest.config.js tests/setup/db.js tests/setup/mocks.js tests/smoke.test.js .gitignore
git commit -m "test: add vitest infrastructure and shared mock factories"
```

---

## Task 2 — Prisma migration: products table with pgvector

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_add_products_index/migration.sql`

- [ ] **Step 1: Add the `Product` model to `prisma/schema.prisma`**

Insert just before `// ====` SHOPIFY SESSION MANAGEMENT block (top of models):

```prisma
// ============================================
// PRODUCT INDEX (RAG retrieval source)
// ============================================

model Product {
  id            String   @id                  // Shopify GID, e.g. "gid://shopify/Product/123"
  handle        String
  title         String
  vendor        String?                       // brand
  productType   String?                       // raw Shopify product_type
  category      String?                       // normalized category (v1 = productType)
  tags          String[]
  description   String?                       // HTML stripped
  priceMin      Decimal? @db.Decimal(12, 2)
  priceMax      Decimal? @db.Decimal(12, 2)
  currency      String?
  imageUrl      String?
  available     Boolean  @default(true)
  specs         Json     @default("{}")
  variants      Json     @default("[]")
  shopifyUpdatedAt DateTime?                  // Shopify's updated_at — for OOO detection
  searchTsv     Unsupported("tsvector")?      // GIN-indexed via raw SQL
  embedding     Unsupported("vector(1024)")?  // Voyage AI voyage-3-lite
  deletedAt     DateTime?                     // soft delete
  indexedAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([handle])
  @@index([vendor])
  @@index([category])
  @@index([deletedAt])
  @@map("products")
}
```

- [ ] **Step 2: Generate the migration**

Run:

```powershell
$env:DATABASE_URL="<your-railway-postgres-public-url>"; npx prisma migrate dev --name add_products_index --create-only
```

This creates the migration file but does NOT apply it yet (because Prisma can't fully manage `Unsupported` types).

Expected output: a new directory under `prisma/migrations/` named like `20260512123000_add_products_index/`.

- [ ] **Step 3: Edit the generated `migration.sql` so it actually works**

Open the new `prisma/migrations/<ts>_add_products_index/migration.sql` and replace its entire contents with:

```sql
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Products table
CREATE TABLE "products" (
  "id"                TEXT PRIMARY KEY,
  "handle"            TEXT NOT NULL,
  "title"             TEXT NOT NULL,
  "vendor"            TEXT,
  "productType"       TEXT,
  "category"          TEXT,
  "tags"              TEXT[] NOT NULL DEFAULT '{}',
  "description"       TEXT,
  "priceMin"          DECIMAL(12,2),
  "priceMax"          DECIMAL(12,2),
  "currency"          TEXT,
  "imageUrl"          TEXT,
  "available"         BOOLEAN NOT NULL DEFAULT true,
  "specs"             JSONB NOT NULL DEFAULT '{}'::jsonb,
  "variants"          JSONB NOT NULL DEFAULT '[]'::jsonb,
  "shopifyUpdatedAt"  TIMESTAMPTZ,
  "searchTsv"         tsvector,
  "embedding"         vector(1024),
  "deletedAt"         TIMESTAMPTZ,
  "indexedAt"         TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt"         TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- NOTE: embedding column is vector(1024) — matches Voyage voyage-3-lite output

-- Btree indexes for filter columns
CREATE INDEX "products_handle_idx"     ON "products" ("handle");
CREATE INDEX "products_vendor_idx"     ON "products" ("vendor");
CREATE INDEX "products_category_idx"   ON "products" ("category");
CREATE INDEX "products_deletedAt_idx"  ON "products" ("deletedAt");

-- GIN index for full-text search on searchTsv
CREATE INDEX "products_search_tsv_idx" ON "products" USING GIN ("searchTsv");

-- GIN index for jsonb specs containment queries
CREATE INDEX "products_specs_idx"      ON "products" USING GIN ("specs");

-- HNSW index for vector cosine similarity
CREATE INDEX "products_embedding_idx"  ON "products"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Auto-update searchTsv from title + vendor + tags + description + variant SKUs
CREATE OR REPLACE FUNCTION products_search_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW."searchTsv" :=
      setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(NEW.vendor, '')), 'A')
    || setweight(to_tsvector('simple', coalesce(array_to_string(NEW.tags, ' '), '')), 'B')
    || setweight(to_tsvector('simple', coalesce(NEW.description, '')), 'C')
    || setweight(to_tsvector('simple',
         coalesce(
           (SELECT string_agg(v->>'sku', ' ')
              FROM jsonb_array_elements(NEW.variants) v
              WHERE v ? 'sku'),
           ''
         )), 'A');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_search_tsv_trigger
  BEFORE INSERT OR UPDATE OF title, vendor, tags, description, variants
  ON "products"
  FOR EACH ROW EXECUTE FUNCTION products_search_tsv_update();
```

- [ ] **Step 4: Apply the migration**

Run:

```powershell
npx prisma migrate deploy
```

Expected: `1 migration applied successfully`.

- [ ] **Step 5: Verify the schema landed**

Run:

```powershell
npx prisma db execute --stdin
```

…and paste this then send EOF:

```sql
\d products
```

(Or use `psql` directly if you have it.) Expected: the table exists with all columns and the three indexes.

Then check the extensions:

```sql
SELECT extname FROM pg_extension WHERE extname IN ('vector', 'pg_trgm');
```

Expected: both rows returned.

- [ ] **Step 6: Regenerate Prisma client**

```powershell
npx prisma generate
```

- [ ] **Step 7: Commit**

```powershell
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(db): add products table with pgvector and tsvector index"
```

---

## Task 3 — Prisma migration: add `last_shown_*` to Conversation

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<ts>_add_conversation_last_shown/migration.sql`

- [ ] **Step 1: Edit the `Conversation` model in `prisma/schema.prisma`**

Locate the `Conversation` model. Add two fields just below `toolCallCount`:

```prisma
  // Last retrieval state — used to seed query understanding on follow-up turns
  lastShownCategory String?
  lastShownBrands   String[]  @default([])
```

- [ ] **Step 2: Generate + apply the migration**

```powershell
npx prisma migrate dev --name add_conversation_last_shown
```

Expected: the migration applies and Prisma client regenerates. The generated SQL should look like:

```sql
ALTER TABLE "Conversation"
  ADD COLUMN "lastShownCategory" TEXT,
  ADD COLUMN "lastShownBrands" TEXT[] NOT NULL DEFAULT '{}';
```

- [ ] **Step 3: Commit**

```powershell
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(db): add lastShownCategory and lastShownBrands to Conversation"
```

---

## Task 4 — Environment variables and config

**Files:**
- Modify: `.env.example`
- Create: `app/services/config.server.js` (it exists — extend it)

- [ ] **Step 1: Update `.env.example`**

Append:

```
# Embeddings (Voyage AI — 200M-token free trial)
VOYAGE_API_KEY=pa-...

# LLM gateway (OpenRouter — Anthropic models proxied via OpenAI-compatible API)
OPENROUTER_API_KEY=sk-or-v1-...

# Rerank (Cohere — 1000/mo free)
COHERE_API_KEY=...

# Protects the full-sync endpoint — random 32-char string
SYNC_SECRET=replace-with-openssl-rand-hex-16

# Optional: dedicated Postgres for tests (can be a separate DB or schema)
TEST_DATABASE_URL=postgresql://...
```

- [ ] **Step 2: Read existing config.server.js**

Read `app/services/config.server.js`. The file is small (32 lines). Confirm it currently exports a config object.

- [ ] **Step 3: Extend `app/services/config.server.js`**

Add at the bottom of the existing exports (do not remove existing ones):

```js
export const RETRIEVAL_CONFIG = {
  voyageApiKey: process.env.VOYAGE_API_KEY,
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY, // fallback when OpenRouter is unavailable
  cohereApiKey: process.env.COHERE_API_KEY,
  syncSecret: process.env.SYNC_SECRET,
  embeddingModel: 'voyage-3-lite',
  embeddingDimensions: 1024,
  rerankModel: 'rerank-v3.5',
  // OpenRouter passes through to Anthropic models with this exact name.
  queryUnderstandingModel: 'anthropic/claude-haiku-4-5',
  candidatePoolSize: 50,
  finalResultSize: 12,
  bm25Weight: 0.4,
  vectorWeight: 0.6,
};

export function assertRetrievalConfig() {
  const missing = [];
  if (!RETRIEVAL_CONFIG.voyageApiKey) missing.push('VOYAGE_API_KEY');
  if (!RETRIEVAL_CONFIG.cohereApiKey) missing.push('COHERE_API_KEY');
  // Need at least one path to Anthropic — OpenRouter (preferred) or direct.
  if (!RETRIEVAL_CONFIG.openrouterApiKey && !RETRIEVAL_CONFIG.anthropicApiKey) {
    missing.push('OPENROUTER_API_KEY or ANTHROPIC_API_KEY');
  }
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}
```

- [ ] **Step 4: Add config tests**

Create `tests/services/config.test.js`:

```js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('RETRIEVAL_CONFIG', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('reads keys from env', async () => {
    process.env.VOYAGE_API_KEY = 'voyage-test';
    process.env.OPENROUTER_API_KEY = 'or-test';
    process.env.COHERE_API_KEY = 'cohere-test';
    process.env.SYNC_SECRET = 'sync-secret';

    // Re-import to pick up new env (vitest caches modules)
    const mod = await import('../../app/services/config.server.js?reload=1');
    expect(mod.RETRIEVAL_CONFIG.voyageApiKey).toBe('voyage-test');
    expect(mod.RETRIEVAL_CONFIG.openrouterApiKey).toBe('or-test');
    expect(mod.RETRIEVAL_CONFIG.cohereApiKey).toBe('cohere-test');
    expect(mod.RETRIEVAL_CONFIG.embeddingModel).toBe('voyage-3-lite');
    expect(mod.RETRIEVAL_CONFIG.embeddingDimensions).toBe(1024);
  });

  it('assertRetrievalConfig throws when keys missing', async () => {
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.COHERE_API_KEY;
    const mod = await import('../../app/services/config.server.js?reload=2');
    expect(() => mod.assertRetrievalConfig()).toThrow(/VOYAGE_API_KEY/);
  });

  it('assertRetrievalConfig accepts ANTHROPIC_API_KEY as a fallback for the LLM key', async () => {
    process.env.VOYAGE_API_KEY = 'v';
    process.env.COHERE_API_KEY = 'c';
    delete process.env.OPENROUTER_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-...';
    const mod = await import('../../app/services/config.server.js?reload=3');
    expect(() => mod.assertRetrievalConfig()).not.toThrow();
  });
});
```

Run:

```powershell
npm test -- tests/services/config.test.js
```

Expected: 2 passing tests.

- [ ] **Step 5: Commit**

```powershell
git add .env.example app/services/config.server.js tests/services/config.test.js
git commit -m "feat(config): add retrieval-config block with required-keys assertion"
```

---

## Task 5 — Embeddings client (Voyage AI wrapper)

**Files:**
- Create: `app/services/embeddings.server.js`
- Create: `tests/services/embeddings.test.js`
- Modify: `package.json` (add `voyageai` dep)

- [ ] **Step 1: Add the Voyage AI SDK**

```powershell
npm install voyageai@^0.0.3
```

(If a newer version exists at install time, take the latest 0.0.x — Voyage's JS SDK is in early-stage versioning. The class name `VoyageAIClient` is stable.)

- [ ] **Step 2: Write the failing test**

Create `tests/services/embeddings.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('voyageai', () => ({
  VoyageAIClient: vi.fn().mockImplementation(() => ({
    embed: vi.fn().mockResolvedValue({
      data: [
        { embedding: new Array(1024).fill(0.01), index: 0 },
        { embedding: new Array(1024).fill(0.02), index: 1 },
      ],
      model: 'voyage-3-lite',
      usage: { totalTokens: 10 },
    }),
  })),
}));

describe('embeddings.server', () => {
  beforeEach(() => {
    process.env.VOYAGE_API_KEY = 'test-key';
  });

  it('embedOne returns a 1024-dim vector', async () => {
    const { embedOne } = await import('../../app/services/embeddings.server.js?one=1');
    const v = await embedOne('M20 cylinder');
    expect(v).toHaveLength(1024);
    expect(v[0]).toBe(0.01);
  });

  it('embedMany returns one vector per input, ordered by index', async () => {
    const { embedMany } = await import('../../app/services/embeddings.server.js?many=1');
    const result = await embedMany(['a', 'b']);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(1024);
    expect(result[1][0]).toBe(0.02);
  });

  it('embedOne throws clearly when text is empty', async () => {
    const { embedOne } = await import('../../app/services/embeddings.server.js?empty=1');
    await expect(embedOne('')).rejects.toThrow(/empty/i);
  });

  it('vectorToPgLiteral formats correctly for pgvector', async () => {
    const { vectorToPgLiteral } = await import('../../app/services/embeddings.server.js?vec=1');
    expect(vectorToPgLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
  });
});
```

Run:

```powershell
npm test -- tests/services/embeddings.test.js
```

Expected: FAIL — `Cannot find module '../../app/services/embeddings.server.js'`.

- [ ] **Step 3: Implement `app/services/embeddings.server.js`**

```js
// app/services/embeddings.server.js
import { VoyageAIClient } from 'voyageai';
import { RETRIEVAL_CONFIG } from './config.server.js';

let client = null;
function getClient() {
  if (!client) {
    if (!RETRIEVAL_CONFIG.voyageApiKey) {
      throw new Error('VOYAGE_API_KEY is not configured');
    }
    client = new VoyageAIClient({ apiKey: RETRIEVAL_CONFIG.voyageApiKey });
  }
  return client;
}

function clean(text) {
  if (typeof text !== 'string') throw new Error('embedding input must be a string');
  const t = text.trim();
  if (!t) throw new Error('embedding input is empty');
  // voyage-3-lite max input is 32k tokens per item; truncate at 24k chars for safety.
  return t.length > 24000 ? t.slice(0, 24000) : t;
}

async function withRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = err?.statusCode || err?.status;
      const isRetryable = status === 429 || (status >= 500 && status < 600);
      if (!isRetryable || i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, 250 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

/**
 * Embed a single text. inputType="query" gives better retrieval-side embedding
 * quality on Voyage's evaluation; "document" is for indexed content.
 */
export async function embedOne(text, { inputType = 'query' } = {}) {
  const input = clean(text);
  const result = await withRetry(() =>
    getClient().embed({
      model: RETRIEVAL_CONFIG.embeddingModel,
      input: [input],
      inputType,
    })
  );
  return result.data[0].embedding;
}

/**
 * Embed many texts in chunks. inputType defaults to "document" — this is the
 * call used during ingestion. Pass inputType: "query" if embedding a batch of
 * user-side queries.
 */
export async function embedMany(texts, { inputType = 'document' } = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const inputs = texts.map(clean);
  // Voyage allows 128 inputs per call for voyage-3-lite.
  const chunks = [];
  for (let i = 0; i < inputs.length; i += 100) chunks.push(inputs.slice(i, i + 100));
  const all = [];
  for (const chunk of chunks) {
    const r = await withRetry(() =>
      getClient().embed({
        model: RETRIEVAL_CONFIG.embeddingModel,
        input: chunk,
        inputType,
      })
    );
    const ordered = r.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map(d => d.embedding);
    all.push(...ordered);
  }
  return all;
}

export function vectorToPgLiteral(vec) {
  // Postgres pgvector literal: '[0.1,0.2,...]'
  return `[${vec.join(',')}]`;
}
```

- [ ] **Step 4: Run tests, expect pass**

```powershell
npm test -- tests/services/embeddings.test.js
```

Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```powershell
git add package.json package-lock.json app/services/embeddings.server.js tests/services/embeddings.test.js
git commit -m "feat(embeddings): add Voyage AI voyage-3-lite client with retry and inputType support"
```

---

## Task 6 — Product extractor (pure function, no I/O)

**Files:**
- Create: `app/services/product-extractor.server.js`
- Create: `tests/services/product-extractor.test.js`
- Create: `tests/fixtures/shopify-product.json`

- [ ] **Step 1: Capture a representative Shopify product as a fixture**

Create `tests/fixtures/shopify-product.json`:

```json
{
  "id": "gid://shopify/Product/8123456789",
  "handle": "festo-dsnu-20-50-p-a",
  "title": "Festo DSNU-20-50-P-A ISO 6432 Pneumatic Cylinder",
  "vendor": "Festo",
  "productType": "Pneumatic Cylinder",
  "tags": ["pneumatic", "cylinder", "ISO-6432", "festo"],
  "descriptionHtml": "<p>Round body, magnetic piston. Bore 20mm, stroke 50mm.</p><ul><li>Operating pressure 1-10 bar</li></ul>",
  "featuredMedia": {
    "preview": { "image": { "url": "https://cdn.shopify.com/.../dsnu-20-50.jpg" } }
  },
  "updatedAt": "2026-04-30T12:00:00Z",
  "priceRangeV2": {
    "minVariantPrice": { "amount": "210.00", "currencyCode": "AED" },
    "maxVariantPrice": { "amount": "210.00", "currencyCode": "AED" }
  },
  "variants": {
    "nodes": [
      {
        "id": "gid://shopify/ProductVariant/411",
        "sku": "DSNU-20-50-P-A",
        "price": "210.00",
        "availableForSale": true
      }
    ]
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/services/product-extractor.test.js`:

```js
import { describe, it, expect } from 'vitest';
import fixture from '../fixtures/shopify-product.json' with { type: 'json' };
import { extractProductRow, stripHtml } from '../../app/services/product-extractor.server.js';

describe('stripHtml', () => {
  it('removes tags', () => {
    expect(stripHtml('<p>hello <b>world</b></p>')).toBe('hello world');
  });
  it('decodes common entities', () => {
    expect(stripHtml('A &amp; B &lt;3 &nbsp;')).toBe('A & B <3');
  });
  it('returns empty string for null/undefined', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
  });
});

describe('extractProductRow', () => {
  it('extracts core fields from a Shopify GraphQL product', () => {
    const row = extractProductRow(fixture);
    expect(row.id).toBe('gid://shopify/Product/8123456789');
    expect(row.handle).toBe('festo-dsnu-20-50-p-a');
    expect(row.vendor).toBe('Festo');
    expect(row.productType).toBe('Pneumatic Cylinder');
    expect(row.category).toBe('Pneumatic Cylinder'); // v1 = productType
    expect(row.tags).toEqual(['pneumatic', 'cylinder', 'ISO-6432', 'festo']);
    expect(row.priceMin).toBe('210.00');
    expect(row.priceMax).toBe('210.00');
    expect(row.currency).toBe('AED');
    expect(row.imageUrl).toBe('https://cdn.shopify.com/.../dsnu-20-50.jpg');
    expect(row.shopifyUpdatedAt).toBe('2026-04-30T12:00:00.000Z');
  });

  it('strips HTML from description', () => {
    const row = extractProductRow(fixture);
    expect(row.description).not.toContain('<p>');
    expect(row.description).toContain('bore 20mm');
  });

  it('flattens variants with SKU + price + availability', () => {
    const row = extractProductRow(fixture);
    expect(row.variants).toHaveLength(1);
    expect(row.variants[0]).toMatchObject({
      id: 'gid://shopify/ProductVariant/411',
      sku: 'DSNU-20-50-P-A',
      price: '210.00',
      available: true,
    });
  });

  it('sets available=false when no variant is available', () => {
    const f = JSON.parse(JSON.stringify(fixture));
    f.variants.nodes[0].availableForSale = false;
    expect(extractProductRow(f).available).toBe(false);
  });

  it('builds textForEmbedding from title+vendor+productType+description', () => {
    const row = extractProductRow(fixture);
    expect(row.textForEmbedding).toContain('Festo');
    expect(row.textForEmbedding).toContain('Pneumatic Cylinder');
    expect(row.textForEmbedding).toContain('DSNU-20-50-P-A');
    expect(row.textForEmbedding).toContain('bore 20mm');
  });
});
```

Run:

```powershell
npm test -- tests/services/product-extractor.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/services/product-extractor.server.js`**

```js
// app/services/product-extractor.server.js

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

export function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, m => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function pickImageUrl(p) {
  const featured = p?.featuredMedia?.preview?.image?.url;
  if (featured) return featured;
  const first = p?.images?.nodes?.[0]?.url || p?.featuredImage?.url;
  return first || null;
}

function variantsToRows(variantsField) {
  const nodes = variantsField?.nodes
    || (Array.isArray(variantsField) ? variantsField : null)
    || variantsField?.edges?.map(e => e.node)
    || [];
  return nodes.map(v => ({
    id: v.id,
    sku: v.sku || null,
    price: v.price?.amount ?? v.price ?? null,
    available: Boolean(v.availableForSale ?? v.available ?? true),
  }));
}

export function extractProductRow(shopifyProduct) {
  const p = shopifyProduct;
  const variants = variantsToRows(p.variants);
  const description = stripHtml(p.descriptionHtml || p.description || '');

  const priceMin = p.priceRangeV2?.minVariantPrice?.amount ?? null;
  const priceMax = p.priceRangeV2?.maxVariantPrice?.amount ?? priceMin;
  const currency =
    p.priceRangeV2?.minVariantPrice?.currencyCode
    || p.priceRangeV2?.maxVariantPrice?.currencyCode
    || null;

  const productType = p.productType || null;

  // For v1 we treat productType as the normalized category. A future task
  // can map productType → canonical category via a lookup table.
  const category = productType;

  // Compose the text we send to the embedder. Order matters for the model:
  // title and brand first (most weight), then category, then SKUs, then desc.
  const skuLine = variants.map(v => v.sku).filter(Boolean).join(' ');
  const textForEmbedding = [
    p.title || '',
    p.vendor || '',
    productType || '',
    skuLine,
    description,
  ]
    .filter(Boolean)
    .join('. ');

  return {
    id: p.id,
    handle: p.handle,
    title: p.title || 'Untitled Product',
    vendor: p.vendor || null,
    productType,
    category,
    tags: Array.isArray(p.tags) ? p.tags : [],
    description,
    priceMin,
    priceMax,
    currency,
    imageUrl: pickImageUrl(p),
    available: variants.some(v => v.available),
    specs: {},                 // Phase 1.1 will populate
    variants,
    shopifyUpdatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : null,
    textForEmbedding,
  };
}
```

- [ ] **Step 4: Run tests, expect pass**

```powershell
npm test -- tests/services/product-extractor.test.js
```

Expected: 8 passing tests.

- [ ] **Step 5: Commit**

```powershell
git add app/services/product-extractor.server.js tests/services/product-extractor.test.js tests/fixtures/shopify-product.json
git commit -m "feat(extractor): add Shopify-product → row extractor with full test coverage"
```

---

## Task 7 — Product index service (upsert, soft-delete, idempotency)

**Files:**
- Create: `app/services/product-index.server.js`
- Create: `tests/services/product-index.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/services/product-index.test.js`:

```js
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { getTestPrisma, truncateProducts, disconnectTestPrisma, skipIfNotIntegration } from '../setup/db.js';
import fixture from '../fixtures/shopify-product.json' with { type: 'json' };

const itInt = process.env.INTEGRATION === '1' ? it : it.skip;

describe(skipIfNotIntegration('product-index.server'), () => {
  beforeEach(async () => {
    await truncateProducts();
  });
  afterAll(async () => {
    await disconnectTestPrisma();
  });

  itInt('upserts a new product and stores its embedding', async () => {
    const { upsertProductFromShopify } = await import('../../app/services/product-index.server.js');
    // We pass an injected embedder so the test doesn't call OpenAI
    const fakeEmbed = async () => new Array(1024).fill(0.01);
    await upsertProductFromShopify(fixture, { embedOne: fakeEmbed });

    const db = getTestPrisma();
    const row = await db.product.findUnique({ where: { id: fixture.id } });
    expect(row).not.toBeNull();
    expect(row.title).toBe(fixture.title);
    expect(row.vendor).toBe('Festo');
  });

  itInt('upsert is idempotent for the same payload', async () => {
    const { upsertProductFromShopify } = await import('../../app/services/product-index.server.js');
    const fakeEmbed = async () => new Array(1024).fill(0.01);
    await upsertProductFromShopify(fixture, { embedOne: fakeEmbed });
    await upsertProductFromShopify(fixture, { embedOne: fakeEmbed });

    const db = getTestPrisma();
    const count = await db.product.count();
    expect(count).toBe(1);
  });

  itInt('skips upsert when incoming shopifyUpdatedAt is older than stored', async () => {
    const { upsertProductFromShopify } = await import('../../app/services/product-index.server.js');
    const fakeEmbed = async () => new Array(1024).fill(0.01);

    const newer = { ...fixture, updatedAt: '2026-04-30T12:00:00Z' };
    const older = { ...fixture, title: 'STALE', updatedAt: '2026-04-29T12:00:00Z' };

    await upsertProductFromShopify(newer, { embedOne: fakeEmbed });
    await upsertProductFromShopify(older, { embedOne: fakeEmbed });

    const db = getTestPrisma();
    const row = await db.product.findUnique({ where: { id: fixture.id } });
    expect(row.title).toBe(fixture.title); // not "STALE"
  });

  itInt('softDeleteProduct sets deletedAt without removing the row', async () => {
    const { upsertProductFromShopify, softDeleteProduct } = await import(
      '../../app/services/product-index.server.js'
    );
    const fakeEmbed = async () => new Array(1024).fill(0.01);
    await upsertProductFromShopify(fixture, { embedOne: fakeEmbed });
    await softDeleteProduct(fixture.id);

    const db = getTestPrisma();
    const row = await db.product.findUnique({ where: { id: fixture.id } });
    expect(row).not.toBeNull();
    expect(row.deletedAt).not.toBeNull();
  });
});
```

Run:

```powershell
$env:INTEGRATION="1"; npm run test:integration -- tests/services/product-index.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 2: Implement `app/services/product-index.server.js`**

```js
// app/services/product-index.server.js
import prisma from '../db.server.js';
import { extractProductRow } from './product-extractor.server.js';
import { embedOne as defaultEmbedOne, vectorToPgLiteral } from './embeddings.server.js';

/**
 * Upsert a Shopify product into the local index.
 * Idempotent and safe for out-of-order webhook delivery.
 *
 * @param {object} shopifyProduct - product as returned by Shopify GraphQL
 * @param {object} [deps] - injected dependencies (for testing)
 */
export async function upsertProductFromShopify(shopifyProduct, deps = {}) {
  const embedOne = deps.embedOne || defaultEmbedOne;

  const row = extractProductRow(shopifyProduct);

  // Out-of-order protection — skip if a newer version is already stored.
  if (row.shopifyUpdatedAt) {
    const existing = await prisma.product.findUnique({
      where: { id: row.id },
      select: { shopifyUpdatedAt: true },
    });
    if (existing?.shopifyUpdatedAt && new Date(existing.shopifyUpdatedAt) >= new Date(row.shopifyUpdatedAt)) {
      return { skipped: true, reason: 'stale_payload' };
    }
  }

  const embedding = await embedOne(row.textForEmbedding);
  const vecLit = vectorToPgLiteral(embedding);

  // Use raw SQL because Prisma doesn't natively support vector(N).
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO products (
      id, handle, title, vendor, "productType", category, tags, description,
      "priceMin", "priceMax", currency, "imageUrl", available, specs, variants,
      "shopifyUpdatedAt", embedding, "deletedAt", "indexedAt", "updatedAt"
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb,
      $16, $17::vector, NULL, now(), now()
    )
    ON CONFLICT (id) DO UPDATE SET
      handle = EXCLUDED.handle,
      title = EXCLUDED.title,
      vendor = EXCLUDED.vendor,
      "productType" = EXCLUDED."productType",
      category = EXCLUDED.category,
      tags = EXCLUDED.tags,
      description = EXCLUDED.description,
      "priceMin" = EXCLUDED."priceMin",
      "priceMax" = EXCLUDED."priceMax",
      currency = EXCLUDED.currency,
      "imageUrl" = EXCLUDED."imageUrl",
      available = EXCLUDED.available,
      specs = EXCLUDED.specs,
      variants = EXCLUDED.variants,
      "shopifyUpdatedAt" = EXCLUDED."shopifyUpdatedAt",
      embedding = EXCLUDED.embedding,
      "deletedAt" = NULL,
      "indexedAt" = now(),
      "updatedAt" = now()
    `,
    row.id,
    row.handle,
    row.title,
    row.vendor,
    row.productType,
    row.category,
    row.tags,
    row.description,
    row.priceMin,
    row.priceMax,
    row.currency,
    row.imageUrl,
    row.available,
    JSON.stringify(row.specs),
    JSON.stringify(row.variants),
    row.shopifyUpdatedAt ? new Date(row.shopifyUpdatedAt) : null,
    vecLit,
  );

  return { skipped: false, id: row.id };
}

export async function softDeleteProduct(shopifyId) {
  await prisma.$executeRawUnsafe(
    `UPDATE products SET "deletedAt" = now(), "updatedAt" = now() WHERE id = $1`,
    shopifyId,
  );
}

export async function getIndexedShopifyIds() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM products WHERE "deletedAt" IS NULL`,
  );
  return rows.map(r => r.id);
}
```

- [ ] **Step 3: Run integration tests, expect pass**

Set `TEST_DATABASE_URL` to a Postgres URL with pgvector enabled — easiest is to create a `chatbot_test` database on the same Railway Postgres:

```powershell
$env:TEST_DATABASE_URL="<railway-postgres-url-but-with-different-db-name>"
$env:INTEGRATION="1"
npm run test:integration -- tests/services/product-index.test.js
```

(If you do not have a separate test database, run the migrations against it first: `DATABASE_URL=$env:TEST_DATABASE_URL npx prisma migrate deploy`.)

Expected: 4 passing tests.

- [ ] **Step 4: Commit**

```powershell
git add app/services/product-index.server.js tests/services/product-index.test.js
git commit -m "feat(index): add idempotent product upsert + soft-delete with OOO protection"
```

---

## Task 8 — Bootstrap script (one-time initial load)

**Files:**
- Create: `scripts/bootstrap-index.js`
- Create: `app/services/admin-shopify.server.js`

- [ ] **Step 1: Implement `app/services/admin-shopify.server.js`**

```js
// app/services/admin-shopify.server.js
// Pure GraphQL-over-fetch wrapper. Does NOT depend on Remix authentication
// because the bootstrap script runs outside the app server.

const PRODUCTS_QUERY = `
  query Products($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        handle
        title
        vendor
        productType
        tags
        descriptionHtml
        updatedAt
        featuredMedia {
          preview { image { url } }
        }
        priceRangeV2 {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        variants(first: 50) {
          nodes {
            id
            sku
            price
            availableForSale
          }
        }
      }
    }
  }
`;

export function makeAdminClient({ shopDomain, accessToken, apiVersion = '2025-01' }) {
  if (!shopDomain || !accessToken) {
    throw new Error('makeAdminClient: shopDomain and accessToken are required');
  }
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  async function gql(query, variables) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify Admin GraphQL ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = await res.json();
    if (json.errors) {
      throw new Error(`Shopify Admin GraphQL errors: ${JSON.stringify(json.errors)}`);
    }
    return json.data;
  }

  return {
    async *productPages({ pageSize = 250 } = {}) {
      let after = null;
      while (true) {
        const data = await gql(PRODUCTS_QUERY, { first: pageSize, after });
        yield data.products.nodes;
        if (!data.products.pageInfo.hasNextPage) break;
        after = data.products.pageInfo.endCursor;
      }
    },
  };
}
```

- [ ] **Step 2: Implement `scripts/bootstrap-index.js`**

```js
// scripts/bootstrap-index.js
//
// Run this ONCE from your local laptop to populate the products index.
// Usage:
//   $env:SHOPIFY_SHOP_DOMAIN="creativeautomation.myshopify.com"
//   $env:SHOPIFY_ADMIN_TOKEN="shpat_..."
//   $env:DATABASE_URL="<railway public postgres url>"
//   $env:VOYAGE_API_KEY="pa-..."
//   node scripts/bootstrap-index.js
//
// Safe to re-run: upserts are idempotent and out-of-order-safe.

import 'dotenv/config';
import { makeAdminClient } from '../app/services/admin-shopify.server.js';
import { upsertProductFromShopify } from '../app/services/product-index.server.js';
import { embedMany } from '../app/services/embeddings.server.js';
import { extractProductRow } from '../app/services/product-extractor.server.js';
import prisma from '../app/db.server.js';

const REQUIRED_ENV = ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ADMIN_TOKEN', 'DATABASE_URL', 'VOYAGE_API_KEY'];
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`Missing required env: ${k}`);
    process.exit(1);
  }
}

const BATCH_SIZE = 50; // embed this many products per OpenAI request

async function main() {
  const client = makeAdminClient({
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
    accessToken: process.env.SHOPIFY_ADMIN_TOKEN,
  });

  let total = 0;
  let pageNum = 0;
  const startedAt = Date.now();

  for await (const products of client.productPages({ pageSize: 250 })) {
    pageNum += 1;
    // Pre-extract rows so we can batch-embed.
    const rows = products.map(extractProductRow);
    const texts = rows.map(r => r.textForEmbedding);
    // inputType: 'document' — these are catalog entries, not user queries.
    const vectors = await embedMany(texts, { inputType: 'document' });

    // Inject each precomputed embedding into upsert via a wrapper.
    for (let i = 0; i < products.length; i++) {
      const vec = vectors[i];
      await upsertProductFromShopify(products[i], { embedOne: async () => vec });
      total += 1;
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[bootstrap] page ${pageNum} done | total=${total} | elapsed=${elapsed}s`);
  }

  await prisma.$disconnect();
  console.log(`[bootstrap] complete | ${total} products in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch(err => {
  console.error('[bootstrap] FAILED:', err);
  process.exit(1);
});
```

- [ ] **Step 3: Smoke-test the bootstrap on a small slice**

There is no full unit test for this script — it integrates Shopify + OpenAI + Postgres end to end. Smoke test against your real data with a small `pageSize`:

Temporarily edit `scripts/bootstrap-index.js` line `for await (const products of client.productPages({ pageSize: 250 }))` to `pageSize: 5`, then run from your laptop:

```powershell
$env:SHOPIFY_SHOP_DOMAIN="<your-myshopify-domain>"
$env:SHOPIFY_ADMIN_TOKEN="<admin-api-token>"
$env:DATABASE_URL="<railway-DATABASE_PUBLIC_URL>"
$env:VOYAGE_API_KEY="<pa-...>"
node scripts/bootstrap-index.js
```

Expected: prints `page 1 done | total=5 | ...`, then more pages, then stops. Check:

```sql
SELECT count(*) FROM products WHERE "deletedAt" IS NULL;
SELECT title, vendor, length(embedding::text) FROM products LIMIT 3;
```

You should see a few rows with embeddings. After verifying, revert `pageSize` to 250.

- [ ] **Step 4: Commit**

```powershell
git add app/services/admin-shopify.server.js scripts/bootstrap-index.js
git commit -m "feat(ingest): add Admin GraphQL client and one-shot bootstrap script"
```

---

## Task 9 — Webhook handlers for product changes

**Files:**
- Modify: `app/routes/api.webhooks.jsx`
- Modify: `shopify.app.toml`
- Create: `tests/routes/webhooks.test.js`

- [ ] **Step 1: Subscribe to product webhooks in `shopify.app.toml`**

Open `shopify.app.toml`. Locate the existing `[[webhooks.subscriptions]]` blocks (there is at least one for `app/uninstalled`). Add these alongside:

```toml
[[webhooks.subscriptions]]
topics = [ "products/create", "products/update", "products/delete" ]
uri = "/api/webhooks"

[[webhooks.subscriptions]]
topics = [ "inventory_levels/update" ]
uri = "/api/webhooks"
```

- [ ] **Step 2: Extend `app/routes/api.webhooks.jsx`**

Replace the entire file with:

```jsx
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { upsertProductFromShopify, softDeleteProduct } from "../services/product-index.server.js";

export const action = async ({ request }) => {
  const { shop, session, topic, payload } = await authenticate.webhook(request);

  console.log(`[webhook] Received ${topic} for ${shop}`);

  try {
    switch (topic) {
      case 'APP_UNINSTALLED':
        if (session) {
          await db.session.deleteMany({ where: { shop } });
        }
        return new Response();

      case 'PRODUCTS_CREATE':
      case 'PRODUCTS_UPDATE':
        // Shopify webhook payload uses REST shape, not GraphQL. The extractor
        // handles both because both have id, title, vendor, variants etc.
        // We normalize the GID first since REST gives integer IDs.
        await upsertProductFromShopify(normalizeRestProduct(payload));
        return new Response();

      case 'PRODUCTS_DELETE':
        // Delete payload only carries the integer id
        await softDeleteProduct(`gid://shopify/Product/${payload.id}`);
        return new Response();

      case 'INVENTORY_LEVELS_UPDATE':
        // Inventory webhook tells us a variant changed availability.
        // For v1 we trigger a refresh by fetching the related product.
        // Simpler v1 implementation: mark stale and let the nightly sync correct.
        // For now we just log; full inventory handling lands in v1.1.
        console.log(`[webhook] inventory update logged — full handling in v1.1`);
        return new Response();

      default:
        throw new Response('Unhandled webhook topic', { status: 404 });
    }
  } catch (err) {
    console.error(`[webhook] ${topic} handler failed:`, err);
    // Return 500 so Shopify retries.
    return new Response(`Handler error: ${err.message}`, { status: 500 });
  }
};

function normalizeRestProduct(p) {
  // REST `products/create` shape → roughly GraphQL shape the extractor expects.
  return {
    id: `gid://shopify/Product/${p.id}`,
    handle: p.handle,
    title: p.title,
    vendor: p.vendor,
    productType: p.product_type,
    tags: typeof p.tags === 'string' ? p.tags.split(',').map(s => s.trim()).filter(Boolean) : (p.tags || []),
    descriptionHtml: p.body_html,
    updatedAt: p.updated_at,
    featuredMedia: p.image?.src
      ? { preview: { image: { url: p.image.src } } }
      : null,
    priceRangeV2: deriveRestPriceRange(p),
    variants: { nodes: (p.variants || []).map(v => ({
      id: `gid://shopify/ProductVariant/${v.id}`,
      sku: v.sku,
      price: v.price,
      availableForSale: v.inventory_quantity == null ? true : v.inventory_quantity > 0,
    })) },
  };
}

function deriveRestPriceRange(p) {
  const prices = (p.variants || []).map(v => parseFloat(v.price)).filter(n => !Number.isNaN(n));
  if (prices.length === 0) return null;
  const min = Math.min(...prices).toFixed(2);
  const max = Math.max(...prices).toFixed(2);
  const currency = p.variants?.[0]?.currency || 'AED';
  return {
    minVariantPrice: { amount: min, currencyCode: currency },
    maxVariantPrice: { amount: max, currencyCode: currency },
  };
}
```

- [ ] **Step 3: Write tests for `normalizeRestProduct`**

Create `tests/routes/webhooks.test.js`:

```js
import { describe, it, expect } from 'vitest';

// We need to test normalizeRestProduct, but it's not exported. Since this is
// the only consumer, the simplest approach: re-create the function inline
// here from the webhook file via a side-channel. We can do this by importing
// the module — but it isn't exported, so we export a __test helper.

// Alternative: extract normalizeRestProduct to its own module. We do this:
import { normalizeRestProduct } from '../../app/services/webhook-payload.server.js';

describe('normalizeRestProduct', () => {
  const restPayload = {
    id: 8123456789,
    handle: 'festo-dsnu-20-50-p-a',
    title: 'Festo DSNU-20-50-P-A',
    vendor: 'Festo',
    product_type: 'Pneumatic Cylinder',
    tags: 'pneumatic, cylinder, festo',
    body_html: '<p>desc</p>',
    updated_at: '2026-04-30T12:00:00Z',
    image: { src: 'https://cdn.shopify.com/abc.jpg' },
    variants: [
      { id: 411, sku: 'DSNU-20-50-P-A', price: '210.00', inventory_quantity: 5 },
      { id: 412, sku: 'DSNU-20-50-P-B', price: '220.00', inventory_quantity: 0 },
    ],
  };

  it('converts integer id to GID', () => {
    const out = normalizeRestProduct(restPayload);
    expect(out.id).toBe('gid://shopify/Product/8123456789');
  });

  it('splits comma-separated tags', () => {
    const out = normalizeRestProduct(restPayload);
    expect(out.tags).toEqual(['pneumatic', 'cylinder', 'festo']);
  });

  it('derives price range from variants', () => {
    const out = normalizeRestProduct(restPayload);
    expect(out.priceRangeV2.minVariantPrice.amount).toBe('210.00');
    expect(out.priceRangeV2.maxVariantPrice.amount).toBe('220.00');
  });

  it('marks variants available/unavailable from inventory_quantity', () => {
    const out = normalizeRestProduct(restPayload);
    expect(out.variants.nodes[0].availableForSale).toBe(true);
    expect(out.variants.nodes[1].availableForSale).toBe(false);
  });
});
```

Run:

```powershell
npm test -- tests/routes/webhooks.test.js
```

Expected: FAIL — `webhook-payload.server.js` does not exist.

- [ ] **Step 4: Extract `normalizeRestProduct` to its own module**

Create `app/services/webhook-payload.server.js`:

```js
// app/services/webhook-payload.server.js
export function normalizeRestProduct(p) {
  return {
    id: `gid://shopify/Product/${p.id}`,
    handle: p.handle,
    title: p.title,
    vendor: p.vendor,
    productType: p.product_type,
    tags: typeof p.tags === 'string' ? p.tags.split(',').map(s => s.trim()).filter(Boolean) : (p.tags || []),
    descriptionHtml: p.body_html,
    updatedAt: p.updated_at,
    featuredMedia: p.image?.src
      ? { preview: { image: { url: p.image.src } } }
      : null,
    priceRangeV2: deriveRestPriceRange(p),
    variants: { nodes: (p.variants || []).map(v => ({
      id: `gid://shopify/ProductVariant/${v.id}`,
      sku: v.sku,
      price: v.price,
      availableForSale: v.inventory_quantity == null ? true : v.inventory_quantity > 0,
    })) },
  };
}

function deriveRestPriceRange(p) {
  const prices = (p.variants || []).map(v => parseFloat(v.price)).filter(n => !Number.isNaN(n));
  if (prices.length === 0) return null;
  const min = Math.min(...prices).toFixed(2);
  const max = Math.max(...prices).toFixed(2);
  const currency = p.variants?.[0]?.currency || 'AED';
  return {
    minVariantPrice: { amount: min, currencyCode: currency },
    maxVariantPrice: { amount: max, currencyCode: currency },
  };
}
```

Update `app/routes/api.webhooks.jsx`: replace the inline `normalizeRestProduct` + `deriveRestPriceRange` functions with an import:

```jsx
import { normalizeRestProduct } from "../services/webhook-payload.server.js";
```

…and delete the two function declarations from the route file.

- [ ] **Step 5: Run tests, expect pass**

```powershell
npm test -- tests/routes/webhooks.test.js
```

Expected: 4 passing tests.

- [ ] **Step 6: Commit**

```powershell
git add shopify.app.toml app/routes/api.webhooks.jsx app/services/webhook-payload.server.js tests/routes/webhooks.test.js
git commit -m "feat(webhooks): subscribe to product create/update/delete and index incoming changes"
```

---

## Task 10 — Full sync route (nightly reconciliation)

**Files:**
- Create: `app/routes/api.sync.full.jsx`
- Create: `tests/routes/sync.test.js`

- [ ] **Step 1: Implement `app/routes/api.sync.full.jsx`**

```jsx
// app/routes/api.sync.full.jsx
//
// POST endpoint that runs a full reconciliation between Shopify and our index.
// Protected by a shared secret in the `X-Sync-Secret` header — call this from
// Railway cron or an external scheduler.
//
// Effect: every product on Shopify is upserted (idempotent); products that
// exist in our index but not in Shopify get soft-deleted.

import { makeAdminClient } from "../services/admin-shopify.server.js";
import { upsertProductFromShopify, softDeleteProduct, getIndexedShopifyIds } from "../services/product-index.server.js";
import { embedMany } from "../services/embeddings.server.js";
import { extractProductRow } from "../services/product-extractor.server.js";
import { RETRIEVAL_CONFIG } from "../services/config.server.js";

export const action = async ({ request }) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const provided = request.headers.get('X-Sync-Secret');
  if (!RETRIEVAL_CONFIG.syncSecret || provided !== RETRIEVAL_CONFIG.syncSecret) {
    return new Response('Unauthorized', { status: 401 });
  }

  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shopDomain || !accessToken) {
    return new Response('Shopify credentials missing', { status: 500 });
  }

  const startedAt = Date.now();
  const client = makeAdminClient({ shopDomain, accessToken });

  const seenIds = new Set();
  let total = 0;
  let pages = 0;

  for await (const products of client.productPages({ pageSize: 250 })) {
    pages += 1;
    const rows = products.map(extractProductRow);
    const texts = rows.map(r => r.textForEmbedding);
    const vectors = await embedMany(texts);
    for (let i = 0; i < products.length; i++) {
      seenIds.add(rows[i].id);
      const vec = vectors[i];
      await upsertProductFromShopify(products[i], { embedOne: async () => vec });
      total += 1;
    }
  }

  // Soft-delete products that exist locally but no longer on Shopify
  const indexedIds = await getIndexedShopifyIds();
  const toDelete = indexedIds.filter(id => !seenIds.has(id));
  for (const id of toDelete) {
    await softDeleteProduct(id);
  }

  const summary = {
    ok: true,
    pages,
    upserted: total,
    softDeleted: toDelete.length,
    elapsedMs: Date.now() - startedAt,
  };
  console.log(`[sync] full reconciliation complete:`, summary);
  return Response.json(summary);
};
```

- [ ] **Step 2: Test that the secret is enforced**

Create `tests/routes/sync.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../app/services/admin-shopify.server.js', () => ({
  makeAdminClient: vi.fn(),
}));
vi.mock('../../app/services/product-index.server.js', () => ({
  upsertProductFromShopify: vi.fn(),
  softDeleteProduct: vi.fn(),
  getIndexedShopifyIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../app/services/embeddings.server.js', () => ({
  embedMany: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../app/services/config.server.js', () => ({
  RETRIEVAL_CONFIG: { syncSecret: 'right' },
}));

describe('POST /api/sync/full', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('rejects request without secret', async () => {
    const { action } = await import('../../app/routes/api.sync.full.jsx');
    const res = await action({
      request: new Request('http://x/api/sync/full', { method: 'POST' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects request with wrong secret', async () => {
    const { action } = await import('../../app/routes/api.sync.full.jsx');
    const res = await action({
      request: new Request('http://x/api/sync/full', {
        method: 'POST',
        headers: { 'X-Sync-Secret': 'wrong' },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects GET requests', async () => {
    const { action } = await import('../../app/routes/api.sync.full.jsx');
    const res = await action({
      request: new Request('http://x/api/sync/full', { method: 'GET' }),
    });
    expect(res.status).toBe(405);
  });
});
```

Run:

```powershell
npm test -- tests/routes/sync.test.js
```

Expected: 3 passing tests.

- [ ] **Step 3: Commit**

```powershell
git add app/routes/api.sync.full.jsx tests/routes/sync.test.js
git commit -m "feat(sync): add /api/sync/full reconciliation endpoint with shared-secret guard"
```

---

## Task 11 — Retrieval service (hybrid SQL)

**Files:**
- Create: `app/services/retrieval.server.js`
- Create: `tests/services/retrieval.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/services/retrieval.test.js`:

```js
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getTestPrisma, truncateProducts, disconnectTestPrisma, skipIfNotIntegration } from '../setup/db.js';

const itInt = process.env.INTEGRATION === '1' ? it : it.skip;

describe(skipIfNotIntegration('retrieval.server'), () => {
  const db = getTestPrisma ? null : null;

  beforeAll(async () => {
    if (process.env.INTEGRATION !== '1') return;
    await truncateProducts();
    // Seed 6 fixture products with explicit pre-computed embeddings so the
    // test is deterministic. We use simple synthetic embeddings where vectors
    // for "cylinder" products cluster around index 0 and "gauge" products
    // cluster around index 1.
    const seed = await import('./_seed_retrieval.js');
    await seed.seedFixtures();
  });
  afterAll(async () => {
    await disconnectTestPrisma();
  });

  itInt('returns only products in the requested category', async () => {
    const { hybridSearch } = await import('../../app/services/retrieval.server.js');
    const results = await hybridSearch({
      category: 'Pneumatic Cylinder',
      brand_include: [],
      brand_exclude: [],
      free_text: 'cylinder',
      query_vector: cylinderVec(),
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => r.category === 'Pneumatic Cylinder')).toBe(true);
  });

  itInt('respects brand_exclude — pressure gauges from excluded brand are not returned', async () => {
    const { hybridSearch } = await import('../../app/services/retrieval.server.js');
    const results = await hybridSearch({
      category: 'Pneumatic Cylinder',
      brand_include: [],
      brand_exclude: ['Festo'],
      free_text: 'M20',
      query_vector: cylinderVec(),
    });
    expect(results.every(r => r.vendor !== 'Festo')).toBe(true);
  });

  itInt('respects brand_include — only listed brands returned', async () => {
    const { hybridSearch } = await import('../../app/services/retrieval.server.js');
    const results = await hybridSearch({
      category: 'Pneumatic Cylinder',
      brand_include: ['SMC'],
      brand_exclude: [],
      free_text: 'cylinder',
      query_vector: cylinderVec(),
    });
    expect(results.every(r => r.vendor === 'SMC')).toBe(true);
  });

  itInt('excludes soft-deleted products', async () => {
    const { hybridSearch } = await import('../../app/services/retrieval.server.js');
    // Soft-delete the SMC cylinder, then search
    const dbi = getTestPrisma();
    await dbi.$executeRawUnsafe(`UPDATE products SET "deletedAt" = now() WHERE vendor = 'SMC'`);
    const results = await hybridSearch({
      category: 'Pneumatic Cylinder',
      brand_include: [],
      brand_exclude: [],
      free_text: 'cylinder',
      query_vector: cylinderVec(),
    });
    expect(results.every(r => r.vendor !== 'SMC')).toBe(true);
  });
});

function cylinderVec() {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return v;
}
```

Also create the seed helper `tests/services/_seed_retrieval.js`:

```js
import prisma from '../../app/db.server.js';

function vec(i) {
  const v = new Array(1024).fill(0);
  v[i] = 1;
  return `[${v.join(',')}]`;
}

const FIXTURES = [
  { id: 'gid://x/1', vendor: 'Festo',     category: 'Pneumatic Cylinder', title: 'Festo M20 cylinder',     desc: 'pneumatic cylinder bore 20mm', embIdx: 0 },
  { id: 'gid://x/2', vendor: 'SMC',       category: 'Pneumatic Cylinder', title: 'SMC M20 pneumatic cyl',  desc: 'pneumatic cylinder bore 20mm', embIdx: 0 },
  { id: 'gid://x/3', vendor: 'Norgren',   category: 'Pneumatic Cylinder', title: 'Norgren cyl 20mm',       desc: 'pneumatic cylinder',           embIdx: 0 },
  { id: 'gid://x/4', vendor: 'Festo',     category: 'Pressure Gauge',     title: 'Festo PG-100 gauge',     desc: 'pressure gauge analog',        embIdx: 1 },
  { id: 'gid://x/5', vendor: 'ABB',       category: 'Circuit Breaker',    title: 'ABB MCB 16A',            desc: 'miniature circuit breaker',    embIdx: 2 },
  { id: 'gid://x/6', vendor: 'Schneider', category: 'Pneumatic Cylinder', title: 'Schneider cyl PCM-20',   desc: 'pneumatic cylinder M20',       embIdx: 0 },
];

export async function seedFixtures() {
  for (const f of FIXTURES) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO products (id, handle, title, vendor, "productType", category, description, embedding, "indexedAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, now(), now())
       ON CONFLICT (id) DO NOTHING`,
      f.id, f.id.replace(/[^a-z0-9]/gi, '-').toLowerCase(), f.title, f.vendor, f.category, f.category, f.desc, vec(f.embIdx),
    );
  }
}
```

Run:

```powershell
$env:INTEGRATION="1"; $env:TEST_DATABASE_URL="<your-test-db-url>"; npm run test:integration -- tests/services/retrieval.test.js
```

Expected: FAIL — `retrieval.server.js` does not exist.

- [ ] **Step 2: Implement `app/services/retrieval.server.js`**

```js
// app/services/retrieval.server.js
import prisma from '../db.server.js';
import { vectorToPgLiteral } from './embeddings.server.js';
import { RETRIEVAL_CONFIG } from './config.server.js';

/**
 * Run the hybrid SQL retrieval.
 *
 * @param {object} intent
 * @param {string|null} intent.category
 * @param {string[]}    intent.brand_include
 * @param {string[]}    intent.brand_exclude
 * @param {object}      intent.specs (jsonb-containment filter; v1: ignored)
 * @param {string}      intent.free_text
 * @param {number[]}    intent.query_vector  (1024 dims)
 * @returns {Promise<Array<row>>} up to RETRIEVAL_CONFIG.candidatePoolSize rows
 */
export async function hybridSearch(intent) {
  const {
    category = null,
    brand_include = [],
    brand_exclude = [],
    free_text = '',
    query_vector,
  } = intent || {};

  if (!Array.isArray(query_vector) || query_vector.length !== RETRIEVAL_CONFIG.embeddingDimensions) {
    throw new Error(`hybridSearch: query_vector must be a ${RETRIEVAL_CONFIG.embeddingDimensions}-dim array`);
  }

  const ftsClean = (free_text || '').trim() || 'a';   // tsquery cannot be empty
  const vecLit = vectorToPgLiteral(query_vector);

  const sql = `
    SELECT id, handle, title, vendor, category, tags, description,
           "priceMin", "priceMax", currency, "imageUrl", available, variants,
           ts_rank_cd("searchTsv", plainto_tsquery('simple', $1)) AS bm25,
           1 - (embedding <=> $2::vector) AS cos
    FROM products
    WHERE "deletedAt" IS NULL
      AND ($3::text IS NULL OR category = $3)
      AND (cardinality($4::text[]) = 0 OR vendor = ANY($4))
      AND (cardinality($5::text[]) = 0 OR vendor <> ALL($5))
    ORDER BY ($6 * ts_rank_cd("searchTsv", plainto_tsquery('simple', $1))
              + $7 * (1 - (embedding <=> $2::vector))) DESC
    LIMIT $8
  `;

  const rows = await prisma.$queryRawUnsafe(
    sql,
    ftsClean,
    vecLit,
    category,
    brand_include,
    brand_exclude,
    RETRIEVAL_CONFIG.bm25Weight,
    RETRIEVAL_CONFIG.vectorWeight,
    RETRIEVAL_CONFIG.candidatePoolSize,
  );

  return rows;
}
```

- [ ] **Step 3: Run integration tests, expect pass**

```powershell
$env:INTEGRATION="1"; npm run test:integration -- tests/services/retrieval.test.js
```

Expected: 4 passing tests.

- [ ] **Step 4: Commit**

```powershell
git add app/services/retrieval.server.js tests/services/retrieval.test.js tests/services/_seed_retrieval.js
git commit -m "feat(retrieval): add hybrid SQL search with hard category and brand filters"
```

---

## Task 12 — Reranker service (Cohere wrapper + fallback)

**Files:**
- Create: `app/services/rerank.server.js`
- Create: `tests/services/rerank.test.js`
- Modify: `package.json` (add `cohere-ai`)

- [ ] **Step 1: Add Cohere SDK**

```powershell
npm install cohere-ai@^7.13.0
```

- [ ] **Step 2: Write the failing test**

Create `tests/services/rerank.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const cohereInstance = { v2: { rerank: vi.fn() } };

vi.mock('cohere-ai', () => ({
  CohereClient: vi.fn().mockImplementation(() => cohereInstance),
  CohereClientV2: vi.fn().mockImplementation(() => cohereInstance),
}));

describe('rerank', () => {
  beforeEach(() => {
    cohereInstance.v2.rerank.mockReset();
    process.env.COHERE_API_KEY = 'test-key';
  });

  it('reorders candidates by Cohere relevance score', async () => {
    cohereInstance.v2.rerank.mockResolvedValue({
      results: [
        { index: 2, relevanceScore: 0.95 },
        { index: 0, relevanceScore: 0.7 },
        { index: 1, relevanceScore: 0.3 },
      ],
    });

    const { rerank } = await import('../../app/services/rerank.server.js?one=1');
    const candidates = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ];
    const result = await rerank('query', candidates, 3);

    expect(result.map(r => r.id)).toEqual(['c', 'a', 'b']);
    expect(result[0].rerank_score).toBe(0.95);
  });

  it('falls back to original order when Cohere fails', async () => {
    cohereInstance.v2.rerank.mockRejectedValue(new Error('boom'));

    const { rerank } = await import('../../app/services/rerank.server.js?two=2');
    const candidates = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ];
    const result = await rerank('query', candidates, 2);

    expect(result.map(r => r.id)).toEqual(['a', 'b']);
    expect(result[0].rerank_score).toBeUndefined();
  });

  it('returns empty array when no candidates', async () => {
    const { rerank } = await import('../../app/services/rerank.server.js?three=3');
    const result = await rerank('query', [], 5);
    expect(result).toEqual([]);
  });

  it('truncates to topN', async () => {
    cohereInstance.v2.rerank.mockResolvedValue({
      results: [
        { index: 0, relevanceScore: 0.9 },
        { index: 1, relevanceScore: 0.8 },
        { index: 2, relevanceScore: 0.7 },
      ],
    });

    const { rerank } = await import('../../app/services/rerank.server.js?four=4');
    const candidates = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const result = await rerank('query', candidates, 2);
    expect(result).toHaveLength(2);
  });
});
```

Run:

```powershell
npm test -- tests/services/rerank.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `app/services/rerank.server.js`**

```js
// app/services/rerank.server.js
import { CohereClientV2 } from 'cohere-ai';
import { RETRIEVAL_CONFIG } from './config.server.js';

let client = null;
function getClient() {
  if (!client) {
    if (!RETRIEVAL_CONFIG.cohereApiKey) {
      throw new Error('COHERE_API_KEY is not configured');
    }
    client = new CohereClientV2({ token: RETRIEVAL_CONFIG.cohereApiKey });
  }
  return client;
}

function candidateToDocument(c) {
  // Cohere accepts plain strings or objects with a `text` field.
  // We feed title + vendor + (truncated) description.
  const parts = [
    c.title,
    c.vendor ? `Brand: ${c.vendor}` : '',
    c.description ? `Description: ${String(c.description).slice(0, 800)}` : '',
  ].filter(Boolean);
  return parts.join('. ');
}

/**
 * Rerank candidates by relevance to query using Cohere Rerank 3.5.
 *
 * On any failure (timeout, API error) returns candidates unchanged so the
 * chat flow still works — the caller's existing ordering becomes the final
 * ordering.
 *
 * @param {string} query
 * @param {Array<object>} candidates
 * @param {number} topN
 * @returns {Promise<Array<object>>} up to topN candidates with `rerank_score`
 */
export async function rerank(query, candidates, topN) {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];
  const safeTopN = Math.min(topN, candidates.length);

  try {
    const documents = candidates.map(candidateToDocument);
    const result = await getClient().rerank({
      model: RETRIEVAL_CONFIG.rerankModel,
      query,
      documents,
      topN: safeTopN,
    });

    return result.results.map(r => ({
      ...candidates[r.index],
      rerank_score: r.relevanceScore,
    }));
  } catch (err) {
    console.warn('[rerank] Cohere failed, falling back to input order:', err.message);
    return candidates.slice(0, safeTopN);
  }
}
```

- [ ] **Step 4: Run tests, expect pass**

```powershell
npm test -- tests/services/rerank.test.js
```

Expected: 4 passing tests.

- [ ] **Step 5: Commit**

```powershell
git add package.json package-lock.json app/services/rerank.server.js tests/services/rerank.test.js
git commit -m "feat(rerank): add Cohere rerank-v3.5 wrapper with graceful fallback"
```

---

## Task 13 — Query understanding service (Haiku intent extraction via OpenRouter)

**Files:**
- Create: `app/services/llm.server.js` (shared OpenRouter → Anthropic gateway)
- Create: `app/services/query-understanding.server.js`
- Create: `tests/services/llm.test.js`
- Create: `tests/services/query-understanding.test.js`

**Why a shared gateway:** both query-understanding (Haiku) and the final-reply path (Sonnet in `claude.server.js`) will route through OpenRouter using an OpenAI-compatible chat-completions endpoint. The Anthropic SDK does not support arbitrary base URLs, so we use the OpenAI SDK pointed at `https://openrouter.ai/api/v1`. Centralising this in `llm.server.js` means Task 17 reuses the same gateway with no extra wiring.

- [ ] **Step 1a: Write the failing test for `llm.server.js`**

Create `tests/services/llm.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const openaiInstance = { chat: { completions: { create: vi.fn() } } };

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => openaiInstance),
  OpenAI: vi.fn().mockImplementation(() => openaiInstance),
}));

describe('llm.server (OpenRouter-via-OpenAI-SDK gateway)', () => {
  beforeEach(() => {
    openaiInstance.chat.completions.create.mockReset();
    process.env.OPENROUTER_API_KEY = 'or-test';
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('chatJson returns parsed JSON from the model response', async () => {
    openaiInstance.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: '{"category":"X","brand_include":[],"brand_exclude":[],"specs":{},"free_text":"q"}' } }],
    });
    const { chatJson } = await import('../../app/services/llm.server.js?one=1');
    const out = await chatJson({
      model: 'anthropic/claude-haiku-4-5',
      system: 'sys',
      user: 'msg',
      maxTokens: 256,
    });
    expect(out.category).toBe('X');
  });

  it('chatJson returns null on invalid JSON', async () => {
    openaiInstance.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: 'not json' } }],
    });
    const { chatJson } = await import('../../app/services/llm.server.js?two=2');
    const out = await chatJson({ model: 'x', system: 's', user: 'u' });
    expect(out).toBeNull();
  });

  it('throws when neither OPENROUTER_API_KEY nor ANTHROPIC_API_KEY is set', async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { chatJson } = await import('../../app/services/llm.server.js?three=3');
    await expect(chatJson({ model: 'x', system: 's', user: 'u' })).rejects.toThrow(/OPENROUTER_API_KEY|ANTHROPIC_API_KEY/);
  });
});
```

Run:

```powershell
npm test -- tests/services/llm.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 1b: Implement `app/services/llm.server.js`**

```js
// app/services/llm.server.js
//
// Single gateway for all LLM calls. Routes through OpenRouter via the
// OpenAI-compatible chat-completions API. Falls back to direct Anthropic
// only if OPENROUTER_API_KEY is missing AND a direct ANTHROPIC_API_KEY is
// available (for future direct-Anthropic mode).
//
// Models are passed as OpenRouter-format strings:
//   - 'anthropic/claude-haiku-4-5'
//   - 'anthropic/claude-sonnet-4-6'

import OpenAI from 'openai';
import { RETRIEVAL_CONFIG } from './config.server.js';

let client = null;

function getClient() {
  if (client) return client;
  if (RETRIEVAL_CONFIG.openrouterApiKey) {
    client = new OpenAI({
      apiKey: RETRIEVAL_CONFIG.openrouterApiKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        // OpenRouter recommends these for analytics; harmless if omitted.
        'HTTP-Referer': 'https://creativeautomation.ae',
        'X-Title': 'Creative Automation Chatbot',
      },
    });
    return client;
  }
  throw new Error(
    'No LLM credential configured. Set OPENROUTER_API_KEY (preferred) or ANTHROPIC_API_KEY.'
  );
}

function safeParseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Chat completion returning parsed JSON (or null on parse failure).
 *
 * @param {object} args
 * @param {string} args.model       e.g. 'anthropic/claude-haiku-4-5'
 * @param {string} args.system      system prompt
 * @param {string} args.user        single user-turn content
 * @param {number} [args.maxTokens] default 512
 * @param {number} [args.temperature] default 0
 * @param {number} [args.timeoutMs]  default 5000
 */
export async function chatJson({ model, system, user, maxTokens = 512, temperature = 0, timeoutMs = 5000 }) {
  const c = getClient();
  const response = await Promise.race([
    c.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    new Promise((_, r) => setTimeout(() => r(new Error('llm timeout')), timeoutMs)),
  ]);
  const text = response?.choices?.[0]?.message?.content ?? '';
  return safeParseJson(text);
}

/**
 * Streaming chat completion. Returns the async iterable from the OpenAI SDK
 * so the caller can pipe tokens to the user. Use this for the user-facing
 * reply (Sonnet) where streaming UX matters.
 *
 * @param {object} args
 * @param {string} args.model
 * @param {string} args.system
 * @param {Array<{role: string, content: string}>} args.messages
 * @param {Array} [args.tools]
 * @param {number} [args.maxTokens]
 */
export async function chatStream({ model, system, messages, tools, maxTokens = 4096 }) {
  const c = getClient();
  return c.chat.completions.create({
    model,
    max_tokens: maxTokens,
    stream: true,
    messages: [
      { role: 'system', content: system },
      ...messages,
    ],
    ...(tools && tools.length ? { tools } : {}),
  });
}
```

- [ ] **Step 1c: Run llm tests, expect pass**

```powershell
npm test -- tests/services/llm.test.js
```

Expected: 3 passing tests.

- [ ] **Step 2: Write the failing test for query-understanding**

Create `tests/services/query-understanding.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../app/services/llm.server.js', () => ({
  chatJson: vi.fn(),
}));

import * as llm from '../../app/services/llm.server.js';

describe('extractIntent', () => {
  beforeEach(() => {
    llm.chatJson.mockReset();
  });

  it('extracts category + brand_exclude when user says "another brand"', async () => {
    llm.chatJson.mockResolvedValue({
      category: 'Pneumatic Cylinder',
      brand_include: [],
      brand_exclude: ['Festo'],
      specs: {},
      free_text: 'M20 cylinder',
    });

    const { extractIntent } = await import('../../app/services/query-understanding.server.js?case=1');
    const intent = await extractIntent({
      messages: [
        { role: 'user', content: 'M20 cylinder from Festo' },
        { role: 'assistant', content: 'Here are some Festo M20 cylinders.' },
        { role: 'user', content: 'show me from another brand' },
      ],
      lastShownCategory: 'Pneumatic Cylinder',
      lastShownBrands: ['Festo'],
    });

    expect(intent.category).toBe('Pneumatic Cylinder');
    expect(intent.brand_exclude).toEqual(['Festo']);
  });

  it('extracts category + brand_include when user specifies brand', async () => {
    llm.chatJson.mockResolvedValue({
      category: 'Circuit Breaker',
      brand_include: ['ABB'],
      brand_exclude: [],
      specs: {},
      free_text: 'circuit breaker',
    });

    const { extractIntent } = await import('../../app/services/query-understanding.server.js?case=2');
    const intent = await extractIntent({
      messages: [{ role: 'user', content: 'ABB circuit breaker' }],
    });

    expect(intent.brand_include).toEqual(['ABB']);
  });

  it('returns null filters and raw free_text on parse failure', async () => {
    llm.chatJson.mockResolvedValue(null); // simulates a failed JSON parse

    const { extractIntent } = await import('../../app/services/query-understanding.server.js?case=3');
    const intent = await extractIntent({
      messages: [{ role: 'user', content: 'some query' }],
    });

    expect(intent.category).toBeNull();
    expect(intent.brand_include).toEqual([]);
    expect(intent.free_text).toBe('some query');
  });

  it('returns fallback intent on LLM error', async () => {
    llm.chatJson.mockRejectedValue(new Error('boom'));

    const { extractIntent } = await import('../../app/services/query-understanding.server.js?case=4');
    const intent = await extractIntent({
      messages: [{ role: 'user', content: 'M20 cylinder' }],
    });

    expect(intent.category).toBeNull();
    expect(intent.free_text).toBe('M20 cylinder');
  });
});
```

Run:

```powershell
npm test -- tests/services/query-understanding.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 2: Implement `app/services/query-understanding.server.js`**

```js
// app/services/query-understanding.server.js
import { chatJson } from './llm.server.js';
import { RETRIEVAL_CONFIG } from './config.server.js';

const SYSTEM_PROMPT = `You are a query-understanding component for an industrial-automation e-commerce chatbot.

Given the user's most recent message AND the prior conversation, output STRICTLY a single JSON object describing what the user is asking the catalog to find. Do not output any prose, markdown, or commentary — only valid JSON.

JSON schema (every key required, use empty arrays / empty object / null for not-present):
{
  "category": string | null,        // canonical product category, e.g. "Pneumatic Cylinder", "Circuit Breaker", "Relay"
  "brand_include": string[],         // brands the user wants to see; empty = any brand
  "brand_exclude": string[],         // brands the user does NOT want; e.g. "another brand than X" → ["X"]
  "specs": object,                   // attribute filters as flat key-value, e.g. {"bore_mm": 20}; empty if none
  "free_text": string                // a cleaned 2-6 word search phrase capturing what to search
}

Rules:
- Use the prior conversation. If the user previously asked about "M20 cylinder from Festo" and now says "from another brand", category stays "Pneumatic Cylinder" and brand_exclude=["Festo"].
- If you receive a "Last shown:" hint about category/brands, USE IT to anchor the current turn.
- Never invent specs. If the user did not state a value, leave specs empty.
- free_text should keep dimension/spec words like "M20", "24VDC", or SKUs intact.
- If the user is just chatting (greeting, thanks, etc.) return all empty fields with free_text equal to the raw message.

OUTPUT JSON ONLY.`;

function buildUserMessage({ messages, lastShownCategory, lastShownBrands }) {
  const recent = messages.slice(-6);
  const transcript = recent
    .map(m => `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n');
  const hint = lastShownCategory
    ? `\n\nLast shown: category="${lastShownCategory}"${lastShownBrands?.length ? `, brands=${JSON.stringify(lastShownBrands)}` : ''}`
    : '';
  return `Conversation transcript:\n${transcript}${hint}\n\nReturn the JSON object now.`;
}

function fallbackIntent(rawMessage) {
  return {
    category: null,
    brand_include: [],
    brand_exclude: [],
    specs: {},
    free_text: rawMessage || '',
  };
}

function normalize(parsed, rawMessage) {
  if (!parsed || typeof parsed !== 'object') return fallbackIntent(rawMessage);
  return {
    category: typeof parsed.category === 'string' && parsed.category.trim() ? parsed.category.trim() : null,
    brand_include: Array.isArray(parsed.brand_include) ? parsed.brand_include.filter(b => typeof b === 'string') : [],
    brand_exclude: Array.isArray(parsed.brand_exclude) ? parsed.brand_exclude.filter(b => typeof b === 'string') : [],
    specs: parsed.specs && typeof parsed.specs === 'object' ? parsed.specs : {},
    free_text: typeof parsed.free_text === 'string' && parsed.free_text.trim() ? parsed.free_text.trim() : (rawMessage || ''),
  };
}

export async function extractIntent({ messages, lastShownCategory = null, lastShownBrands = [] }) {
  const rawMessage = messages?.[messages.length - 1]?.content ?? '';
  try {
    const parsed = await chatJson({
      model: RETRIEVAL_CONFIG.queryUnderstandingModel,
      system: SYSTEM_PROMPT,
      user: buildUserMessage({ messages, lastShownCategory, lastShownBrands }),
      maxTokens: 256,
      temperature: 0,
      timeoutMs: 5000,
    });
    return normalize(parsed, rawMessage);
  } catch (err) {
    console.warn('[query-understanding] failed, using fallback:', err.message);
    return fallbackIntent(rawMessage);
  }
}
```

- [ ] **Step 3: Run tests, expect pass**

```powershell
npm test -- tests/services/query-understanding.test.js
```

Expected: 4 passing tests.

- [ ] **Step 4: Commit**

```powershell
git add app/services/query-understanding.server.js tests/services/query-understanding.test.js
git commit -m "feat(query): add Haiku-based query understanding with conversation memory"
```

---

## Task 14 — New search-router orchestrator

**Files:**
- Modify: `app/services/search-router.server.js` (replace entirely)
- Create: `tests/services/search-router.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/services/search-router.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../app/services/query-understanding.server.js', () => ({
  extractIntent: vi.fn(),
}));
vi.mock('../../app/services/embeddings.server.js', () => ({
  embedOne: vi.fn(),
  vectorToPgLiteral: v => `[${v.join(',')}]`,
}));
vi.mock('../../app/services/retrieval.server.js', () => ({
  hybridSearch: vi.fn(),
}));
vi.mock('../../app/services/rerank.server.js', () => ({
  rerank: vi.fn(),
}));

describe('smartSearch (v6 orchestrator)', () => {
  let mods;
  beforeEach(async () => {
    vi.resetModules();
    mods = {
      qu: await import('../../app/services/query-understanding.server.js'),
      em: await import('../../app/services/embeddings.server.js'),
      re: await import('../../app/services/retrieval.server.js'),
      rk: await import('../../app/services/rerank.server.js'),
    };
  });

  it('runs the full pipeline and returns top-N reranked candidates', async () => {
    mods.qu.extractIntent.mockResolvedValue({
      category: 'Pneumatic Cylinder',
      brand_include: [],
      brand_exclude: ['Festo'],
      specs: {},
      free_text: 'M20 cylinder',
    });
    mods.em.embedOne.mockResolvedValue(new Array(1024).fill(0.01));
    mods.re.hybridSearch.mockResolvedValue([
      { id: '1', title: 'SMC', vendor: 'SMC' },
      { id: '2', title: 'Norgren', vendor: 'Norgren' },
    ]);
    mods.rk.rerank.mockResolvedValue([
      { id: '2', title: 'Norgren', vendor: 'Norgren', rerank_score: 0.9 },
      { id: '1', title: 'SMC', vendor: 'SMC', rerank_score: 0.8 },
    ]);

    const { smartSearch } = await import('../../app/services/search-router.server.js?case=1');
    const out = await smartSearch({
      messages: [{ role: 'user', content: 'M20 cylinder from another brand' }],
      lastShownCategory: 'Pneumatic Cylinder',
      lastShownBrands: ['Festo'],
    });

    expect(out.products.map(p => p.id)).toEqual(['2', '1']);
    expect(out.intent.brand_exclude).toEqual(['Festo']);
    expect(out.searchType).toBe('hybrid');
  });

  it('returns empty result with intent when retrieval is empty', async () => {
    mods.qu.extractIntent.mockResolvedValue({
      category: 'Nonexistent',
      brand_include: [],
      brand_exclude: [],
      specs: {},
      free_text: 'nonsense xyz',
    });
    mods.em.embedOne.mockResolvedValue(new Array(1024).fill(0.01));
    mods.re.hybridSearch.mockResolvedValue([]);
    mods.rk.rerank.mockResolvedValue([]);

    const { smartSearch } = await import('../../app/services/search-router.server.js?case=2');
    const out = await smartSearch({ messages: [{ role: 'user', content: 'nonsense' }] });
    expect(out.products).toEqual([]);
    expect(out.searchType).toBe('hybrid_empty');
  });

  it('falls back to retrieval candidates when rerank fails (returns empty)', async () => {
    mods.qu.extractIntent.mockResolvedValue({
      category: null,
      brand_include: [],
      brand_exclude: [],
      specs: {},
      free_text: 'x',
    });
    mods.em.embedOne.mockResolvedValue(new Array(1024).fill(0.01));
    mods.re.hybridSearch.mockResolvedValue([{ id: '1', title: 'A' }]);
    mods.rk.rerank.mockResolvedValue([{ id: '1', title: 'A' }]); // rerank module handles its own fallback

    const { smartSearch } = await import('../../app/services/search-router.server.js?case=3');
    const out = await smartSearch({ messages: [{ role: 'user', content: 'x' }] });
    expect(out.products).toHaveLength(1);
  });
});
```

Run:

```powershell
npm test -- tests/services/search-router.test.js
```

Expected: FAIL — old file still exists with the v5 implementation.

- [ ] **Step 2: Replace `app/services/search-router.server.js` entirely**

Overwrite the whole file with:

```js
// app/services/search-router.server.js
//
// v6.0 — hybrid retrieval orchestrator
//
// Replaces the v5 Storefront-search-based router. Pipeline:
//   query understanding (Haiku) → embed query (OpenAI) → hybrid SQL retrieval
//   (pgvector + tsvector + filters) → Cohere rerank → top-12 to caller.

import { extractIntent } from './query-understanding.server.js';
import { embedOne } from './embeddings.server.js';
import { hybridSearch } from './retrieval.server.js';
import { rerank } from './rerank.server.js';
import { RETRIEVAL_CONFIG } from './config.server.js';

// Telemetry — for v1 we log structured events; a follow-up task can wire
// these into PostHog. Keep the keys exactly as documented in PLAN.md §11 so
// downstream dashboards work without changes.
function emit(event, payload) {
  try {
    console.log(`[telemetry] ${event} ${JSON.stringify(payload)}`);
  } catch {
    // ignore JSON errors — telemetry must never break the chat
  }
}

/**
 * @param {object} args
 * @param {Array<{role: string, content: string}>} args.messages - last N turns including current user message
 * @param {string|null} args.lastShownCategory
 * @param {string[]}    args.lastShownBrands
 * @returns {Promise<{products: object[], intent: object, searchType: string, systemHint: string}>}
 */
export async function smartSearch({ messages, lastShownCategory = null, lastShownBrands = [] }) {
  const startedAt = Date.now();
  if (!Array.isArray(messages) || messages.length === 0) {
    return emptyResult({ free_text: '' }, 'empty_input');
  }

  // Step 1 — query understanding
  const t1 = Date.now();
  const intent = await extractIntent({ messages, lastShownCategory, lastShownBrands });
  const t1Ms = Date.now() - t1;

  // Step 2 — query embedding
  const t2 = Date.now();
  let queryVector;
  let embedFallback = false;
  try {
    queryVector = await Promise.race([
      embedOne(intent.free_text || (messages[messages.length - 1].content || 'x')),
      new Promise((_, r) => setTimeout(() => r(new Error('embed timeout')), 3000)),
    ]);
  } catch (err) {
    console.warn('[search-router] embedding failed, falling back to BM25-only:', err.message);
    queryVector = new Array(RETRIEVAL_CONFIG.embeddingDimensions).fill(0);
    embedFallback = true;
  }
  const t2Ms = Date.now() - t2;

  // Step 3 — hybrid retrieval
  const t3 = Date.now();
  const candidates = await hybridSearch({
    category: intent.category,
    brand_include: intent.brand_include,
    brand_exclude: intent.brand_exclude,
    free_text: intent.free_text,
    query_vector: queryVector,
  });
  const t3Ms = Date.now() - t3;

  if (candidates.length === 0) {
    emit('chat_search_zero_results', {
      free_text: intent.free_text,
      intent: { category: intent.category, brand_include: intent.brand_include, brand_exclude: intent.brand_exclude },
    });
    emit('chat_turn_completed', {
      total_ms: Date.now() - startedAt, qu_ms: t1Ms, embed_ms: t2Ms, retrieval_ms: t3Ms, rerank_ms: 0,
      candidates: 0, returned: 0, embed_fallback: embedFallback,
    });
    return {
      products: [],
      intent,
      searchType: 'hybrid_empty',
      systemHint: `No products found for "${intent.free_text}". Tell the user the item isn't in our catalog and offer to connect them with sales.`,
    };
  }

  // Step 4 — rerank
  const t4 = Date.now();
  const top = await rerank(intent.free_text, candidates, RETRIEVAL_CONFIG.finalResultSize);
  const t4Ms = Date.now() - t4;

  // Defensive check — the brand-exclude SQL filter should make this impossible.
  // If we ever log a violation, it's a real bug (e.g. someone bypassed the filter).
  if (Array.isArray(intent.brand_exclude) && intent.brand_exclude.length > 0) {
    const bad = top.find(p => intent.brand_exclude.includes(p.vendor));
    if (bad) {
      emit('chat_brand_exclude_violated', {
        excluded: intent.brand_exclude,
        product_id: bad.id,
        product_vendor: bad.vendor,
      });
    }
  }

  emit('chat_turn_completed', {
    total_ms: Date.now() - startedAt, qu_ms: t1Ms, embed_ms: t2Ms, retrieval_ms: t3Ms, rerank_ms: t4Ms,
    candidates: candidates.length, returned: top.length, embed_fallback: embedFallback,
    top3_ids: top.slice(0, 3).map(p => p.id),
  });

  return {
    products: top,
    intent,
    searchType: 'hybrid',
    systemHint: `Found ${top.length} matching products. Acknowledge briefly — the cards are already displayed.`,
  };
}

function emptyResult(intent, reason) {
  return {
    products: [],
    intent: { category: null, brand_include: [], brand_exclude: [], specs: {}, free_text: '', ...intent },
    searchType: reason,
    systemHint: 'No search performed.',
  };
}
```

- [ ] **Step 3: Run tests, expect pass**

```powershell
npm test -- tests/services/search-router.test.js
```

Expected: 3 passing tests.

- [ ] **Step 4: Commit**

```powershell
git add app/services/search-router.server.js tests/services/search-router.test.js
git commit -m "feat(search-router): v6 orchestrator wiring query-understanding + retrieval + rerank"
```

---

## Task 15 — Persist conversation state (`lastShownCategory`/`Brands`)

**Files:**
- Modify: `app/routes/chat.jsx` (find the existing search call site and update it)

- [ ] **Step 1: Read `app/routes/chat.jsx` to find the search call site**

```powershell
npm test -- --reporter=verbose 2>&1 | Out-Null   # just to ensure tests baseline still passes
```

Open `app/routes/chat.jsx`. Find where `smartSearch` is called (the old signature was `smartSearch(userMessage, shopDomain)` — search for `smartSearch(` in this file and `tool.server.js`).

- [ ] **Step 2: Update the call site to the new signature and persist state**

Locate the block where `smartSearch` is called. Replace it with:

```js
import prisma from '../db.server.js';

// ... inside the chat handler, where products are fetched ...

// Load lastShown_* from the conversation row (load conversation first if you don't already)
const conversationRow = conversationId
  ? await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { lastShownCategory: true, lastShownBrands: true },
    })
  : null;

const search = await smartSearch({
  messages,                                  // existing variable in chat.jsx
  lastShownCategory: conversationRow?.lastShownCategory ?? null,
  lastShownBrands: conversationRow?.lastShownBrands ?? [],
});

// After the chat reply is generated and persisted, update the conversation row
// with the category/brand we ended up showing this turn — only if products were
// actually returned.
if (search.products.length > 0) {
  const shownBrands = [...new Set(search.products.map(p => p.vendor).filter(Boolean))];
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      lastShownCategory: search.intent.category || conversationRow?.lastShownCategory,
      lastShownBrands: shownBrands.length ? shownBrands : (conversationRow?.lastShownBrands ?? []),
    },
  });
}
```

If your `chat.jsx` does not currently load `conversationId` near the top, you must do so — search for how `conversation` is constructed/retrieved (it should already exist because there's a `Message` model linked to `Conversation`). If the route does not yet pass `messages` in a shape your `smartSearch` expects (`{role, content}[]`), add a tiny adapter:

```js
const messagesForSearch = messages.map(m => ({
  role: m.role,
  content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
}));
```

…and pass `messagesForSearch` to `smartSearch`.

- [ ] **Step 3: Quick local sanity run**

This is a wiring change — full coverage comes from the eval set in Task 18. For now:

```powershell
npm test -- tests/services/search-router.test.js
```

(Ensures we did not break the orchestrator's expected signature.)

- [ ] **Step 4: Commit**

```powershell
git add app/routes/chat.jsx
git commit -m "feat(chat): persist lastShownCategory/Brands per conversation turn"
```

---

## Task 16 — Update `tool.server.js` to consume the new pipeline output

**Files:**
- Modify: `app/services/tool.server.js`

- [ ] **Step 1: Read the current `processProductSearchResult`**

Re-read `app/services/tool.server.js`. The current implementation re-ranks results coming from the v5 storefront search. Since v6's search-router already returns final-ranked results, this step now becomes a simple shape-conformance pass.

- [ ] **Step 2: Simplify `processProductSearchResult`**

Replace the body of `processProductSearchResult` (keep the existing exports and the `createToolService` factory shape intact) with:

```js
const processProductSearchResult = (searchResult, shopDomain) => {
  // searchResult is the object returned by smartSearch in search-router v6
  if (!searchResult || !Array.isArray(searchResult.products)) return [];

  const products = searchResult.products.slice(0, MAX_PRODUCTS_TO_DISPLAY);

  return products.map(p => ({
    id: p.id,
    title: p.title || 'Untitled Product',
    handle: p.handle || null,
    vendor: p.vendor || null,
    image_url: p.imageUrl || p.image_url || null,
    url: p.handle
      ? `https://${shopDomain}/products/${p.handle}`
      : null,
    price: formatPriceFromRow(p),
    description: p.description ? String(p.description).slice(0, 500) : '',
    variant_id: pickFirstVariantId(p),
    merchandise_id: pickFirstVariantId(p),
    sku: pickFirstVariantSku(p),
  }));
};

function formatPriceFromRow(p) {
  // p.priceMin / p.priceMax are already strings/numbers
  if (p.priceMin == null) return '';
  const min = Number(p.priceMin).toFixed(2);
  const max = Number(p.priceMax ?? p.priceMin).toFixed(2);
  const cur = p.currency || 'AED';
  return min === max ? `${min} ${cur}` : `${min} - ${max} ${cur}`;
}

function pickFirstVariantId(p) {
  const arr = Array.isArray(p.variants) ? p.variants : (p.variants?.nodes || []);
  return arr[0]?.id || null;
}

function pickFirstVariantSku(p) {
  const arr = Array.isArray(p.variants) ? p.variants : (p.variants?.nodes || []);
  return arr[0]?.sku || p.sku || null;
}
```

Delete the now-unused helper functions: `extractAmount`, `extractCurrency`, `formatPrice` (old), `extractQuerySpecs`, `scoreProductBySpecs`, `scoreProductByRelevance`, `extractDescription`, `extractImageUrl`, `resolveProductUrl`. The new pipeline produces clean rows directly; no extraction or re-ranking is needed.

Keep `processCartUpdateResult` exactly as it is — cart logic is unchanged.

- [ ] **Step 3: Search the codebase for any other callers**

```powershell
git grep -n "processProductSearchResult" -- "*.js" "*.jsx"
```

Update each call site to pass `searchResult` (the object from `smartSearch`) instead of the old `toolUseResponse, shopDomain, userQuery, searchQuery` signature.

- [ ] **Step 4: Commit**

```powershell
git add app/services/tool.server.js app/routes/chat.jsx
git commit -m "refactor(tool): simplify processProductSearchResult — pipeline already ranks"
```

---

## Task 17 — Update `claude.server.js` system prompt

**Files:**
- Modify: `app/services/claude.server.js`

- [ ] **Step 1: Replace the `creativeAutomationAssistant` system prompt**

In `app/services/claude.server.js`, find the `creativeAutomationAssistant` string literal inside `getSystemPrompt`. Replace it with:

```js
creativeAutomationAssistant: `You are the official AI sales & support assistant for Creative Industrial Automation L.L.C (Creative Automation). Speak with confident, professional, and technically accurate language appropriate for technical buyers (engineers, procurement, maintenance).

============================
CRITICAL RESPONSE RULES
============================

1. CONCISE RESPONSES ONLY: Keep responses SHORT — maximum 2-3 sentences per response.

2. PRODUCT SEARCH BEHAVIOR:
   - When products are returned, they are ALREADY filtered correctly by category and brand. The UI shows them as visual cards automatically.
   - DO NOT describe individual products, list SKUs, or use markdown tables.
   - After cards display, reply with 1-2 short lines, e.g.: "Found 8 cylinders matching your filter — see the cards above."

3. NO HALLUCINATIONS: Never invent specs, stock, pricing, or URLs. If unsure, offer to connect the user with sales.

4. NO FABRICATED URLS: Only use URLs from the search tool output.

============================
SEARCH BEHAVIOR (NEW — v6 pipeline)
============================

The product-search tool is now backed by a hybrid retrieval pipeline that handles category, brand-include, brand-exclude, and conversational follow-ups itself. You do NOT need to:
  - Strip dimensions, voltages, IP ratings, or brand names from queries
  - Manually pick 2-4 word queries
  - Retry with simplified queries on zero results
  - Track which brand was previously shown

Just pass the user's message (translated to English if not already) to the search tool. The pipeline will extract structured filters automatically.

When the user says "another brand", "different brand", "from someone else", the pipeline already knows the previous category/brand and applies brand_exclude. You don't need to do anything special.

If the search tool returns zero results:
  - Tell the user the product isn't in our catalog.
  - Offer websales@creativeautomation.ae.
  - Do NOT call the search tool again with a different phrasing — the pipeline already retried internally.

============================
COMPANY CONTEXT
============================
- Creative Automation — UAE-based industrial supplier for manufacturing, oil & gas, construction.
- Categories: Power & Protection, Control & Signalling, Connectivity, Sensors, Industrial Communication, Pneumatics, Measurement & Testing.
- Contact: websales@creativeautomation.ae, +971 4 331 3331.
- Location: Al Qusais Industrial Area 2, Dubai, UAE.

============================
B2B & ESCALATION
============================
- Bulk: ask for quantity, delivery country, target date — offer a custom quote from sales.
- Safety/warranty/compatibility queries: "This needs specialist review — I'll connect you with our product expert."

============================
SPECIAL RESPONSES
============================
A) "Who created you?" → "I was developed by Shahid Afrid (https://github.com/akhi-shxhid)."
B) Careers / hiring → "Please contact our HR representative, Nayana Manoharan, at hr@creativeautomation.ae."
C) Product team → "Led by Shabeeb. Includes Shahid Afrid (Dev), Ajinas (PD Lead), Yash, Aleena Sabu, Rohit, Pushkar."

============================
REMEMBER
============================
- Cards speak for themselves.
- Pass the raw user message to search — the pipeline handles everything.
- Zero results → contact sales, do not retry.
- Translate non-English input to English before searching.
- One final reply per turn, after the tool calls.`,
```

- [ ] **Step 2: Commit**

```powershell
git add app/services/claude.server.js
git commit -m "refactor(prompt): rewrite v6 system prompt — pipeline handles filters, no query trimming"
```

---

## Task 18 — Eval set + runner

**Files:**
- Create: `tests/eval/cases.json`
- Create: `tests/eval/run.js`
- Modify: `PROGRESS.md` (Phase 8 checklist)

- [ ] **Step 1: Seed `tests/eval/cases.json`**

These are the *initial* eval cases. Phase 8 of `PROGRESS.md` includes a follow-up to collect 30–50 real failing queries from PostHog logs and append them.

```json
[
  {
    "name": "M20 cylinder from Festo — initial query",
    "messages": [{ "role": "user", "content": "M20 cylinder from Festo" }],
    "expect": {
      "category": "Pneumatic Cylinder",
      "minResults": 1,
      "vendorIncludes": "Festo",
      "vendorExcludesNone": true
    }
  },
  {
    "name": "show me from another brand — must keep cylinder, drop Festo",
    "messages": [
      { "role": "user", "content": "M20 cylinder from Festo" },
      { "role": "assistant", "content": "Here are some Festo M20 cylinders." },
      { "role": "user", "content": "show me from another brand" }
    ],
    "lastShownCategory": "Pneumatic Cylinder",
    "lastShownBrands": ["Festo"],
    "expect": {
      "category": "Pneumatic Cylinder",
      "minResults": 1,
      "vendorExcludes": ["Festo"],
      "categoryHomogeneous": true
    }
  },
  {
    "name": "ABB circuit breaker",
    "messages": [{ "role": "user", "content": "ABB circuit breaker" }],
    "expect": {
      "category": "Circuit Breaker",
      "minResults": 1,
      "vendorIncludes": "ABB"
    }
  },
  {
    "name": "exact SKU lookup",
    "messages": [{ "role": "user", "content": "DSNU-20-50-P-A" }],
    "expect": {
      "minResults": 1,
      "topMatchSkuContains": "DSNU-20-50-P-A"
    }
  },
  {
    "name": "vague greeting — no products needed",
    "messages": [{ "role": "user", "content": "hello" }],
    "expect": {
      "minResults": 0,
      "maxResults": 0
    }
  }
]
```

- [ ] **Step 2: Implement `tests/eval/run.js`**

```js
// tests/eval/run.js
//
// Runs all cases in cases.json through the live pipeline against the real
// catalog and prints a pass/fail summary. Requires:
//   EVAL=1, DATABASE_URL, OPENAI_API_KEY, COHERE_API_KEY, ANTHROPIC_API_KEY
//
// Usage:  npm run eval
//
// Exits non-zero if any case fails.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { smartSearch } from '../../app/services/search-router.server.js';

if (process.env.EVAL !== '1') {
  console.error('Set EVAL=1 to run the eval.');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));

function fail(testName, reason) {
  console.error(`✗ ${testName} — ${reason}`);
  return false;
}
function pass(testName) {
  console.log(`✓ ${testName}`);
  return true;
}

function evaluate(testCase, result) {
  const e = testCase.expect || {};
  if (e.minResults != null && result.products.length < e.minResults)
    return fail(testCase.name, `expected ≥${e.minResults} results, got ${result.products.length}`);
  if (e.maxResults != null && result.products.length > e.maxResults)
    return fail(testCase.name, `expected ≤${e.maxResults} results, got ${result.products.length}`);
  if (e.category && result.intent.category !== e.category)
    return fail(testCase.name, `expected intent.category=${e.category}, got ${result.intent.category}`);
  if (e.vendorIncludes && !result.products.some(p => p.vendor === e.vendorIncludes))
    return fail(testCase.name, `expected at least one product with vendor=${e.vendorIncludes}`);
  if (Array.isArray(e.vendorExcludes)) {
    const bad = result.products.find(p => e.vendorExcludes.includes(p.vendor));
    if (bad) return fail(testCase.name, `found excluded vendor ${bad.vendor} in results`);
  }
  if (e.categoryHomogeneous && result.products.length > 1) {
    const cats = new Set(result.products.map(p => p.category).filter(Boolean));
    if (cats.size > 1) return fail(testCase.name, `expected single category, got ${[...cats].join(', ')}`);
  }
  if (e.topMatchSkuContains) {
    const top = result.products[0];
    const skus = (top?.variants?.map(v => v.sku) || []).filter(Boolean).join(',');
    if (!skus.includes(e.topMatchSkuContains))
      return fail(testCase.name, `expected top SKU to contain ${e.topMatchSkuContains}, got [${skus}]`);
  }
  return pass(testCase.name);
}

let failures = 0;
for (const c of cases) {
  let result;
  try {
    result = await smartSearch({
      messages: c.messages,
      lastShownCategory: c.lastShownCategory ?? null,
      lastShownBrands: c.lastShownBrands ?? [],
    });
  } catch (err) {
    failures += 1;
    console.error(`✗ ${c.name} — pipeline threw: ${err.message}`);
    continue;
  }
  if (!evaluate(c, result)) failures += 1;
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: Run the eval against the live catalog**

You must have already completed Task 7 (bootstrap) so the index has data. Then:

```powershell
$env:EVAL="1"
npm run eval
```

Expected: all 5 cases pass. If any fail, the diagnosis path is in `PLAN.md` Section 12.

- [ ] **Step 4: Update `PROGRESS.md`**

Tick the eval-set items in Phase 8 and add a note that real-PostHog queries should be appended in production rollout.

- [ ] **Step 5: Commit**

```powershell
git add tests/eval/ PROGRESS.md
git commit -m "test(eval): add curated eval set and runner — 5 baseline cases passing"
```

---

## Task 19 — Local bootstrap run against Railway Postgres

**Files:** (no code changes — this is a one-off operational task)

- [ ] **Step 1: Add the new env vars to Railway**

In Railway → your service → Variables, add:

- `OPENAI_API_KEY=<sk-...>`
- `COHERE_API_KEY=<...>`
- `SYNC_SECRET=<random 32-char string>` (generate with `node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"`)

Restart the service so they take effect.

- [ ] **Step 2: Run the bootstrap from your laptop**

From `C:\Users\jainr\OneDrive\Desktop\Chatbot`:

```powershell
$env:SHOPIFY_SHOP_DOMAIN="<creativeautomation.myshopify.com>"
$env:SHOPIFY_ADMIN_TOKEN="<the App automation token shown in Railway vars>"
$env:DATABASE_URL="<DATABASE_PUBLIC_URL from Railway>"
$env:OPENAI_API_KEY="<sk-...>"
node scripts/bootstrap-index.js
```

Expected: streams page-by-page progress logs. ~30 min for 200k products.

- [ ] **Step 3: Verify the index**

Connect to the Railway Postgres (any client — pgAdmin, TablePlus, `psql` from your laptop) and run:

```sql
SELECT count(*) FILTER (WHERE "deletedAt" IS NULL) AS live,
       count(*) FILTER (WHERE "deletedAt" IS NOT NULL) AS deleted
  FROM products;

SELECT category, count(*) FROM products WHERE "deletedAt" IS NULL GROUP BY category ORDER BY 2 DESC LIMIT 20;

SELECT vendor, count(*) FROM products WHERE "deletedAt" IS NULL GROUP BY vendor ORDER BY 2 DESC LIMIT 20;
```

Confirm `live` count ≈ Shopify catalog size; categories and vendors look sane.

- [ ] **Step 4: Re-run the eval against real data**

```powershell
$env:EVAL="1"; $env:DATABASE_URL="<DATABASE_PUBLIC_URL>"; npm run eval
```

Expected: 5/5 passing (or, if not, file each failure as a real bug, do not proceed).

- [ ] **Step 5: Commit nothing — record outcomes in `PROGRESS.md`**

Edit `PROGRESS.md`, tick:

```
### Phase 2 — Schema + bootstrap
- [x] Add Prisma migration with `products` table + `pgvector` + `pg_trgm` extensions
- [x] Add `last_shown_category`, `last_shown_brands` to `Conversation`
- [x] Add OpenAI + Cohere env vars to Railway
- [x] Write `scripts/bootstrap-index.js` (local-run, hits Railway public Postgres URL)
- [x] Run bootstrap against production Railway Postgres
```

Commit:

```powershell
git add PROGRESS.md
git commit -m "chore: mark Phase 2 (bootstrap) complete in progress tracker"
```

---

## Task 20 — Configure nightly cron for `/api/sync/full`

**Files:** (config, no code changes)

- [ ] **Step 1: Choose a cron mechanism**

Railway Hobby has cron in the form of a separate Cron service that pings a URL. If you cannot use it, use cron-job.org or GitHub Actions schedule. All three options below work:

**Option A — Railway cron service:** create a new "Cron" service in your Railway project. Schedule: `0 23 * * *` UTC (03:00 GST). Command:
```sh
curl -X POST -H "X-Sync-Secret: $SYNC_SECRET" https://<your-railway-host>/api/sync/full
```
(`SYNC_SECRET` must be a Variable on the Cron service too.)

**Option B — cron-job.org (external):** add a job with the same URL + header. Free for one job.

**Option C — GitHub Actions:** create `.github/workflows/nightly-sync.yml`:
```yaml
name: nightly product sync
on:
  schedule: [{ cron: '0 23 * * *' }]
  workflow_dispatch:
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - run: |
          curl -fsS -X POST \
            -H "X-Sync-Secret: ${{ secrets.SYNC_SECRET }}" \
            https://<your-railway-host>/api/sync/full
```
Add `SYNC_SECRET` as a GitHub Actions secret.

- [ ] **Step 2: Trigger one manual sync run to verify**

From your laptop:

```powershell
curl -X POST -H "X-Sync-Secret: <secret>" https://<your-railway-host>/api/sync/full
```

Expected: JSON response with `ok: true, pages, upserted, softDeleted, elapsedMs`. Logs in Railway dashboard show the sync ran.

- [ ] **Step 3: Mark cron task complete in `PROGRESS.md` and commit**

```powershell
git add PROGRESS.md .github/workflows/nightly-sync.yml   # only if you used Option C
git commit -m "chore: enable nightly product sync cron"
```

---

## Task 21 — Deploy to Railway preview, smoke-test, monitor

**Files:** (no code changes — this is shipping)

- [ ] **Step 1: Open a PR from `rohit` to `main`**

```powershell
git push origin rohit
gh pr create --base main --head rohit --title "v6: hybrid retrieval pipeline (search rewrite)" --body-file - <<'EOF'
## Summary
- Replace Shopify Storefront search with hybrid Postgres retrieval (pgvector + tsvector)
- Add Haiku query understanding with conversation memory
- Add Cohere rerank
- Add full ingestion pipeline (bootstrap + webhooks + nightly sync)

## Test plan
- [ ] All unit tests pass: `npm test`
- [ ] Integration tests pass with real Postgres: `INTEGRATION=1 npm run test:integration`
- [ ] Eval set passes against real index: `EVAL=1 npm run eval`
- [ ] Manual smoke test on Railway preview: bubble opens, search for "M20 cylinder" returns cylinders, follow-up "another brand" excludes the prior brand
- [ ] Add-to-cart still works on a real product
EOF
```

- [ ] **Step 2: Manually smoke-test on the storefront**

Open the storefront with the chatbot deployed. Run through these scenarios in a fresh chat each:

1. "I need an M20 pneumatic cylinder" → expect cylinder cards, not gauges/breakers.
2. Same chat: "show me from another brand" → expect cylinders only, none from the brand shown in #1.
3. New chat: "ABB circuit breaker" → expect circuit breakers, vendor ABB.
4. New chat: "DSNU-20-50-P-A" → expect exact-SKU top match.
5. New chat: "hello" → expect a short greeting, no cards.
6. Add a product to cart → expect cart-update success (unchanged path).

If all 6 pass, this is ready.

- [ ] **Step 3: Merge PR, deploy production**

```powershell
gh pr merge --merge
```

Railway auto-deploys on merge to main. Watch the deploy logs.

- [ ] **Step 4: Watch PostHog for one week**

Track these events for a week:

- `chat_search_zero_results`: should be < 5% of search turns. If higher, investigate.
- `chat_brand_exclude_violated`: should always be 0. Any occurrence is a bug.
- `chat_turn_completed`: p95 latency should be ≤ 3s.

- [ ] **Step 5: Update `PROGRESS.md` final**

Mark Phase 9 complete and the project shipped. Commit.

```powershell
git checkout main
git pull
git add PROGRESS.md
git commit -m "chore: v6 retrieval pipeline shipped to production"
git push
```

---

## Plan complete

Total: 21 tasks, ~110 steps. The plan covers the entire scope of `PLAN.md` v1 (search-only — no spec Q&A, no cart polish, no custom category mapping).
