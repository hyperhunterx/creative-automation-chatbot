# Creative Automation Chatbot — Implementation Plan

> **Status:** approved design, ready for implementation planning
> **Working branch:** `rohit`
> **Owner:** Rohit
> **Original codebase:** [shxhidtutorly/shxhid-chat-agent](https://github.com/shxhidtutorly/shxhid-chat-agent) by Shahid Afrid
> **This document is the source of truth for *what* we are building and *why*.** The granular *how* (step-by-step implementation plan) is generated separately and tracked in `PROGRESS.md`.

---

## 1. Problem statement

The existing chatbot deployed at Creative Automation works for narrow keyword and SKU queries but fails on the common conversational follow-ups that drive industrial purchasing:

- **Failing example:** User searches "M20 series cylinder" → cylinders returned. User then says "show me from another brand" → returns pressure gauges, switches, and other unrelated products (not cylinders at all).
- **Symptom reported by user:** "as the number of product increases, it doesn't work good as it was working with the last number of product"
- **Implied diagnosis from user:** scaling problem with Shopify API + Postgres.

This problem statement was rediagnosed during brainstorming — see Section 2.

## 2. Root cause analysis

After reading the v5.0 codebase (`app/services/search-router.server.js`, `app/services/tool.server.js`, `app/services/claude.server.js`), the actual failure mode is **search quality**, not infrastructure scaling.

**Key findings:**

1. **Postgres is not used for product data.** The existing Postgres only stores sessions, conversations, messages, leads, and customer auth tokens. Product search calls Shopify's Storefront `search` API directly. The 200k product count does not stress Postgres.

2. **Product search is pure keyword search via Shopify Storefront API** with a 4-tier fallback (original → plural/singular → strip fillers → main noun only). It has no structured filtering by brand or category.

3. **All filtering gates were deliberately removed in v5.0.** The previous developer iterated through versions that tried strict brand/category/voltage gates, removed them all in v5.0, and now "trusts Shopify search relevance ranking." Comment in the file: *"No brand gates. No vendor filters. No query classification beyond SKU detection."*

4. **Conversation state never reaches the search tool.** Each turn passes only the current message text to `smartSearch(userMessage, shopDomain)`. The category context from prior turns ("we were just looking at cylinders") is dropped.

5. **The system prompt strips meaningful tokens.** It tells Claude to use 2–4 word queries and to omit voltages, dimensions, brands, and qualifiers — leaving very thin queries that match anything in a 200k catalog.

**Why "another brand" specifically fails:**
- Claude generates a tiny query like `another brand` (after stripping fillers per the prompt rules)
- Shopify Storefront search is given two generic tokens with no category filter
- At 200k SKUs, the top hits for `brand` or `another` are dominated by titles that happen to contain those words — pressure gauges, fittings, anything

**This is not fixable by tuning Shopify's storefront search.** It requires a retrieval layer we control where structured filters can be applied as hard constraints.

## 3. What we're reusing vs. replacing

### Reusing (production-tested, working correctly)

- Shopify embedded app authentication (`app/shopify.server.js`, `app/auth.server.js`)
- Chat bubble theme app extension (`extensions/chat-bubble`)
- Conversation, Message, Visitor, Lead, ChatAnalytics Prisma schema
- Customer OAuth flow for add-to-cart on logged-in users (`CustomerToken`, `CodeVerifier`, `CustomerAccountUrls`)
- MCP client for Storefront cart operations (`app/mcp-client.js`)
- Anthropic Claude streaming wrapper (`app/services/claude.server.js`)
- Streaming response handler (`app/services/streaming.server.js`)
- PostHog analytics wiring (`app/services/posthog.server.js`)
- Railway deployment (`Dockerfile`, `nixpacks.toml`, `railway.json`)
- All routes in `app/routes/` except the search-related parts

### Replacing

- `app/services/search-router.server.js` — replaced with a thin orchestrator that calls the new modules in sequence
- `app/services/admin-products.server.js` — partially replaced (SKU exact lookup moves into our Postgres index)
- `app/services/tool.server.js` — `processProductSearchResult` rewritten to consume our new pipeline's output
- System prompt in `app/services/claude.server.js` — adjusted so Claude no longer strips brand/category/specs from queries

### Adding (new code)

- `app/services/query-understanding.server.js` — LLM-driven intent extraction
- `app/services/retrieval.server.js` — hybrid Postgres search (BM25 + vector + filters)
- `app/services/rerank.server.js` — Cohere Rerank wrapper
- `app/services/product-index.server.js` — upsert/delete product rows
- `app/routes/api.webhooks.products.jsx` — Shopify product webhook handlers
- `app/routes/api.sync.full.jsx` — full reconciliation endpoint (called by cron)
- `scripts/bootstrap-index.js` — one-time initial load from local laptop
- `prisma/migrations/<timestamp>_add_products_index/` — schema migration

## 4. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Shopify storefront (creativeautomation.ae)                     │
│  └─ chat-bubble theme app extension (existing, unchanged)       │
└──────────────────────┬──────────────────────────────────────────┘
                       │ POST /chat (streaming)
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  Remix app on Railway (existing scaffolding, retrieval replaced)│
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ chat.jsx route                                          │   │
│  │  1. load conversation history from Postgres             │   │
│  │  2. call query-understanding         (NEW)              │   │
│  │  3. call hybrid-retrieval            (NEW)              │   │
│  │  4. call reranker                    (NEW)              │   │
│  │  5. call Claude Sonnet 4.6 with top-12 as context       │   │
│  │  6. stream response back, persist message               │   │
│  └─────────────────────────────────────────────────────────┘   │
└──────────────────────┬───────────────┬───────────────────┬──────┘
                       │               │                   │
                       ▼               ▼                   ▼
                 Anthropic API     Cohere Rerank      OpenAI Embeddings
                 (Haiku + Sonnet)  (rerank-v3.5)      (text-embedding-3-small)
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│  Railway Postgres (existing, schema extended)                   │
│  ├─ Sessions, Conversations, Messages, Leads (existing)         │
│  └─ products (NEW) with: structured fields, tsvector, vector    │
│      pgvector extension + GIN index on tsvector                 │
└─────────────────────────────────────────────────────────────────┘
                       ▲
                       │ updates
┌──────────────────────┴──────────────────────────────────────────┐
│  Product ingestion (NEW — separate concern, separate routes)    │
│  ├─ /api/webhooks/products (incremental: create/update/delete)  │
│  └─ /api/sync/full (nightly reconciliation via Railway cron)    │
│      Source: Shopify Admin GraphQL (productVariants connection) │
└─────────────────────────────────────────────────────────────────┘
```

**Key principle:** the chat path does not call Shopify for product data. Our Postgres index is the source of truth for the chatbot. Shopify is the source of truth for the catalog, and the ingestion path keeps them synchronized. Cart/checkout still go directly to Shopify (unchanged).

## 5. Component boundaries

| Module | File | Responsibility | Input → Output |
|---|---|---|---|
| Query understanding | `app/services/query-understanding.server.js` | Extract structured intent from message + history | `(messages, last_shown_category?, last_shown_brands?)` → `{category, brand_include[], brand_exclude[], specs{}, free_text}` |
| Hybrid retrieval | `app/services/retrieval.server.js` | Filtered keyword + vector search in Postgres | `(intent)` → top 50 candidate products |
| Reranker | `app/services/rerank.server.js` | Re-score top 50 with Cohere | `(query, candidates)` → top 12 with rerank scores |
| Product index | `app/services/product-index.server.js` | Upsert/delete rows, generate embeddings | `(shopify_product)` → side effects |
| Webhook ingestion | `app/routes/api.webhooks.products.jsx` | Shopify webhook handler | webhook event → product-index calls |
| Full sync | `app/routes/api.sync.full.jsx` | Reconciliation endpoint | cron trigger → paginated Shopify Admin reads |

Each module is independently testable. `search-router.server.js` becomes a 30-line orchestrator that wires steps 1 → 2 → 3.

## 6. Per-turn data flow

For the conversation:
- **Turn N-1 user:** "M20 series cylinder from Festo"
- **Turn N-1 system:** stored `last_shown_category = "Pneumatic Cylinder"`, `last_shown_brands = ["Festo"]` on the Conversation row
- **Turn N user:** "show me from another brand"

```
chat.jsx
  loads last 6 messages + last_shown_category + last_shown_brands
        │
        ▼
[query-understanding.server.js]
  Anthropic Haiku 4.5 with extraction prompt
  → { category: "Pneumatic Cylinder",
      brand_include: [],
      brand_exclude: ["Festo"],
      specs: { bore_mm: 20 },
      free_text: "M20 cylinder" }
        │
        ▼
[retrieval.server.js] one SQL query:
  SELECT id, title, vendor, ..., 
         ts_rank_cd(search_tsv, plainto_tsquery($free_text)) AS bm25,
         1 - (embedding <=> $query_embedding) AS cos
  FROM products
  WHERE category = $category                          -- hard gate
    AND (vendor = ANY($brand_include) OR cardinality($brand_include) = 0)
    AND vendor != ALL($brand_exclude)                 -- antifilter
    AND specs @> $specs_jsonb                         -- jsonb containment
  ORDER BY (0.4 * bm25 + 0.6 * cos) DESC
  LIMIT 50;
        │
        ▼
[rerank.server.js]
  Cohere rerank-v3.5(query="M20 cylinder", documents=[title+description x 50])
  → top 12 with rerank scores
        │
        ▼
[claude.server.js — existing]
  Anthropic Sonnet 4.6 streaming, system prompt adjusted so it does NOT re-search.
  [SYSTEM NOTE — pre-found products] block injected with top 12.
  Persist user_message + cards + assistant_reply + last_shown_* to Postgres.
```

**The critical change:** `brand_exclude` is a hard SQL filter, not a soft ranking signal. Pressure gauges cannot leak into cylinder queries because `category = 'Pneumatic Cylinder'` removes them at the database level.

## 7. Schema additions

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE products (
  id              text PRIMARY KEY,              -- Shopify product GID
  handle          text NOT NULL,
  title           text NOT NULL,
  vendor          text,                          -- brand
  product_type    text,                          -- raw Shopify type
  category        text,                          -- normalized (see ingestion)
  tags            text[],
  description     text,                          -- HTML stripped
  price_min       numeric(12,2),
  price_max       numeric(12,2),
  currency        text,
  image_url       text,
  available       boolean DEFAULT true,
  specs           jsonb DEFAULT '{}'::jsonb,     -- extracted key/value
  variants        jsonb DEFAULT '[]'::jsonb,     -- [{id, sku, price, available}]
  search_tsv      tsvector,                      -- title + vendor + tags + desc
  embedding       vector(1536),                  -- OpenAI text-embedding-3-small
  updated_at      timestamptz DEFAULT now(),
  indexed_at      timestamptz DEFAULT now()
);

CREATE INDEX products_search_tsv_idx ON products USING GIN (search_tsv);
CREATE INDEX products_embedding_idx  ON products USING hnsw (embedding vector_cosine_ops);
CREATE INDEX products_category_idx   ON products (category);
CREATE INDEX products_vendor_idx     ON products (vendor);
CREATE INDEX products_specs_idx      ON products USING GIN (specs);
CREATE INDEX products_handle_idx     ON products (handle);

ALTER TABLE "Conversation" ADD COLUMN last_shown_category text;
ALTER TABLE "Conversation" ADD COLUMN last_shown_brands   text[];
```

One row per product (not per variant). Variants live in the `variants` jsonb column. Variant SKUs are still searchable inside the tsvector.

## 8. Ingestion strategy

### Incremental — Shopify webhooks (steady state)

Subscribe via the existing webhook infrastructure (`app/routes/api.webhooks.jsx`) to:

- `products/create`
- `products/update`
- `products/delete`
- `inventory_levels/update`

Handler pipeline: extract structured fields → embed via OpenAI → upsert into `products` table.

**Idempotency requirement:** Shopify retries aggressively. Every handler must be safe to call multiple times with the same payload. Use `INSERT ... ON CONFLICT (id) DO UPDATE`. Track the latest webhook `updated_at` per product; skip out-of-order older events.

**Latency target:** Shopify event → row updated in < 30 seconds.

### Nightly reconciliation (drift correction)

Cron in Railway runs `/api/sync/full` at 03:00 GST.

- Paginates Shopify Admin GraphQL `products(first: 250, after: cursor)`
- For each page: diff against Postgres, upsert changed rows, soft-delete missing rows
- Only re-embeds products whose Shopify `updated_at` is newer than our `indexed_at`
- Estimated runtime for 200k products: ~15 minutes
- Drift alarm: alert if > 1% of products differ from current state

### One-time bootstrap (initial load)

Script `scripts/bootstrap-index.js`:

- Runs from the developer's local laptop (saves Railway compute credits)
- Connects to Railway Postgres via `DATABASE_PUBLIC_URL` env var
- Same logic as full sync but against an empty table
- Estimated runtime: ~30 minutes
- Estimated cost: ~$0.80 in OpenAI embeddings

### Category normalization

Shopify `productType` is freeform. For v1 we use `productType` directly as `category`. If we observe category-filter misses during QA, we add a canonical mapping table in v1.1. This decision is deliberately deferred to avoid premature engineering.

### Spec extraction

Best-effort regex pass for common attributes (`bore_mm`, `voltage_v`, `current_a`, `ip_rating`, `thread_size`). For v1 this is run during ingestion but spec-based filtering is **off by default** in retrieval — only the `free_text` and category/brand filters are wired in. Spec filters get enabled in v1.1 once we know spec extraction quality is good.

## 9. Models and cost projection

| Component | Provider | Model | Cost |
|---|---|---|---|
| Embeddings (bootstrap) | OpenAI | text-embedding-3-small | ~$0.80 one-time |
| Embeddings (ongoing) | OpenAI | text-embedding-3-small | < $2/month |
| Rerank | Cohere | rerank-v3.5 | first 1000/mo free; ~$1 per 1000 turns after |
| Query understanding | Anthropic | Haiku 4.5 | ~$0.50 per 1000 turns |
| Final reply | Anthropic | Sonnet 4.6 (with prompt caching) | ~$3-5 per 1000 turns |

**Total retrieval-infra addition:** roughly $5/month at low volume, plus the existing Anthropic spend on Sonnet replies.

**New keys to add to Railway environment variables:**
- `OPENAI_API_KEY`
- `COHERE_API_KEY`

(`ANTHROPIC_API_KEY` is already present.)

## 10. Error handling and fallbacks

The chat path has four external dependencies plus Postgres plus the existing Sonnet call. Each step has an explicit fallback so the user never sees a hard error from a single API outage.

| Step | Failure | Fallback |
|---|---|---|
| Query understanding (Haiku) | API error or > 5 s | Use raw user message as `free_text`, no filters. Log `query_understanding_failed`. |
| Query embedding (OpenAI) | API error or > 3 s | Run BM25-only query. Log `embedding_failed`. |
| Retrieval (Postgres) | SQL error | No fallback — surface "Search temporarily unavailable" and alert. |
| Rerank (Cohere) | API error or > 2 s | Use Postgres hybrid score as final ranking. Log `rerank_failed`. |
| Final reply (Sonnet) | API error | Existing error path in chat.jsx — unchanged. |

**Only a Postgres outage stops the chatbot.** Every other dependency degrades to a still-useful state.

## 11. Observability

Logged per chat turn to PostHog (existing wiring):

- `chat_turn_completed`: latency per step (ms), candidate count after each step, rerank score distribution, fallback flags, parsed intent JSON, top-3 result IDs
- `chat_search_zero_results`: user query, parsed intent, attempted SQL filters — replay candidates for development
- `chat_brand_exclude_violated`: any result whose vendor is in `brand_exclude` (this should never happen by SQL — if it does, it's a bug)

Per webhook to PostHog:

- `product_indexed`: shopify_id, embedding latency, total latency
- `product_index_error`: error message, retry count

Per nightly sync to PostHog:

- `product_sync_completed`: rows processed, rows changed, rows soft-deleted, total runtime

## 12. Testing strategy

### Unit tests

- `query-understanding.server.js`: mock Haiku. Assert intent extraction for the "another brand" scenario, brand-include scenario, SKU scenario, spec scenario.
- `retrieval.server.js`: real Postgres (test schema with vector extension). Seed ~20 known products. Assert brand-exclude correctness, category gate, spec containment, score ordering.
- `rerank.server.js`: mock Cohere. Assert score ordering is preserved.
- `product-index.server.js`: assert idempotent upsert, soft-delete, out-of-order rejection, embedding storage.

### Integration tests (gated behind `INTEGRATION=1`)

- Spin up real Postgres + vector extension. Ingest 100 fixture products snapshotted from real catalog. Run battery of queries through the full pipeline (real Haiku, real Cohere, real OpenAI). Burn API credits only on PR / merge, not on every commit.

### Evaluation set (the most important deliverable)

Hand-curated `~50 query → expected-result-type` pairs covering the actual failure modes:

- `"M20 cylinder"` → category=Pneumatic Cylinder, all results are cylinders
- `"show me another brand"` (after `"M20 cylinder from Festo"`) → category still Pneumatic Cylinder, no vendor=Festo
- `"ABB circuit breaker"` → vendor=ABB, category=Circuit Breaker
- `"DSNU-20-50-P-A"` → exact SKU match, top-1
- `"24VDC relay with 2 NO contacts"` → category=Relay, spec match (when spec filtering enabled)
- (more to be collected from your team in week 1)

Run on every change to query-understanding / retrieval / rerank. Track precision@5 and brand-exclude correctness. Regressions block merge.

## 13. Out of scope for v1

Explicitly deferred to keep v1 focused:

- **Product Q&A** ("what is the bore diameter of this cylinder?") — v1.1
- **Cross-brand equivalent mapping** ("what is the Festo equivalent of this SMC cylinder?") — v1.2 (requires a brand-equivalent table or LLM with full product context)
- **Multilingual queries beyond what the existing prompt handles** — v1.x
- **Custom category normalization** — v1.1 if needed
- **Spec-based filtering in retrieval** — v1.1 (extraction runs in v1, but filters are off)
- **Re-skinning the chat widget** — separate project
- **Inventory-aware ranking** ("prefer in-stock items") — easy v1.x add once we see usage

## 14. Open questions to resolve before / during implementation

1. **Algolia env vars exist in Railway** but the codebase doesn't use them. Confirm with team they aren't needed by any other surface, then ignore.
2. **Shopify webhook signing secret** must be configured for the new product webhook routes. Find or generate it.
3. **Cron scheduling** on Railway Hobby — verify cron is available, or use external cron service (e.g. GitHub Actions on a schedule, cron-job.org).
4. **Embedding model dimension lock-in** — `vector(1536)` matches OpenAI 3-small's default. If we want to swap to a 768-dim model later, we change the column type and re-embed. Document this.
5. **Eval set queries** — collect 30–50 real failing queries from current production logs (PostHog) to seed the eval set.

## 15. Success criteria for v1

V1 ships when:

- All eval set queries pass (precision@5 ≥ 0.8 for product queries; 100% for brand-exclude correctness)
- "M20 cylinder from Festo" → "show me from another brand" returns only cylinders, none from Festo
- 200k products fully indexed; webhook lag < 60s p95
- Chat turn p95 latency < 3 seconds end to end
- No regression on cart/checkout flow (manual smoke test)

---

*This plan was approved by Rohit on 2026-05-12. The detailed step-by-step implementation plan lives separately and is tracked in `PROGRESS.md`.*
