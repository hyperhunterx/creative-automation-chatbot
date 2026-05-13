# Progress Tracker

> **Read me first if resuming in a new Claude session.**
> Always read `PLAN.md` for the full design and architectural rationale. This file only tracks status and short-term notes.

---

## Project context (for a new session)

- **Repo:** `hyperhunterx/creative-automation-chatbot` (cloned from [shxhidtutorly/shxhid-chat-agent](https://github.com/shxhidtutorly/shxhid-chat-agent))
- **Working branch:** `rohit`
- **Goal:** fix the chatbot's retrieval quality so conversational follow-ups like "show me from another brand" work correctly on the Creative Automation Shopify catalog (146,115 products).
- **Approach:** replace the Shopify Storefront search with a hybrid retrieval layer (Postgres + pgvector) we control. Add an LLM query-understanding step in front and a reranker behind. Keep everything else (Shopify auth, chat widget, cart, OAuth, conversation persistence) untouched.
- **Stack additions:** Voyage AI `voyage-3.5-lite` (1024-dim, configurable output_dimension), Cohere Rerank 3.5, Anthropic Haiku 4.5 via OpenRouter (in addition to Sonnet 4.6 already in use).

## Status overview

```
Phase 0  Brainstorming & design               [██████████] 100%
Phase 1  Implementation plan                  [██████████] 100%
Phase 2  Schema migrations                    [██████████] 100% — applied + backfilled
Phase 3  Ingestion (webhooks + cron)          [█████████░]  90% — webhooks + sync route complete; cron config pending
Phase 4  Retrieval module                     [██████████] 100% — hybridSearch w/ normalized filters
Phase 5  Query understanding module           [██████████] 100% — Haiku via OpenRouter w/ is_search flag
Phase 6  Rerank module                        [██████████] 100% — Cohere wrapper with fallback
Phase 7  Wire into chat                       [██████████] 100% — v6 orchestrator + last_shown persistence
Phase 8  Eval set + QA                        [██████████] 100% — 5/5 baseline cases passing live
Phase 9  Bake-off demo page                   [██████████] 100% — /test-chat + /api/v6-search built
Phase 10 Ship to production (Railway deploy)  [░░░░░░░░░░]   0% — user-operated; in progress
```

## Where we actually are right now

- **146,115 products indexed** in Railway Postgres with vendor / vendorNormalized / categories / embedding / tsvector — verified via `scripts/sanity-check-index.js`.
- **Eval 5/5 passing** against the live index (Siemens motion sensor, "another brand" follow-up, ABB inverter drive, DUS60E SKU, greeting bypass).
- **`/test-chat` demo page** live locally, distinctive dark navy/teal styling, sidebar shows live intent + carry-over state + how-v6-differs-from-v5. Natural-language replies via Haiku. Ready to deploy.
- **All implementation commits on `rohit` branch**, latest commit: `fix(test-chat): honest wording on result counts + SKU-not-found`.
- **Currently in progress:** user is deploying `/test-chat` to Railway (new service alongside Postgres, env vars copied from local `.env`, internal `DATABASE_URL` reference) and sharing the URL with the manager for bake-off testing.

## Completed (this iteration on top of the original 21-task plan)

### Normalization layer (one-day add-on after first eval pass)
Real catalog metadata is messy — "ABB"/"Abb"/"abb" case dupes, `Electrical Automation & Cables` vs `Electrical, Automation & Cables` comma dupes, breadcrumb junk in productType ("Home", "Back to results"), brand-prefixed redundant tags ("Smc Pneumatic Guided Cylinders" alongside "Pneumatic Guided Cylinders"). Before fix, an estimated 20-40% of legitimate brand/category filter hits would miss silently.

- [x] `vendorNormalized TEXT` column (lowercase+trim) — added in migration `20260512183000_add_product_normalization`
- [x] `categories TEXT[]` column with GIN index — derived from tags with brand-prefix stripping
- [x] Hybrid SQL switched to `vendorNormalized = ANY($brands)` and `$category = ANY(categories)`
- [x] Query-understanding prompt emits lowercase brand/category
- [x] `chat.jsx` persists normalized values in `Conversation.lastShownBrands`
- [x] Tests + retrieval seed updated; 24-test extractor suite

### Embedding pipeline rewrite
- [x] Bypassed the v0.0.3 voyageai SDK (silently dropped `output_dimension` on voyage-3-era requests) — now calling `/v1/embeddings` REST directly
- [x] Switched model from `voyage-3-lite` (locked at 512-dim) to `voyage-3.5-lite` (same price, configurable 1024-dim)
- [x] Added `openai` npm dep (was missing — caused first deploy error)

### Bootstrap perf
- [x] `upsertManyFromShopify` — single multi-row INSERT per page; eliminated ~250 round trips per page
- [x] Per-page time dropped from 274s → 8s (~35× speedup)
- [x] 146k products bootstrapped in 101 minutes (was projected at ~44 hours pre-fix)

### Search router robustness
- [x] **Greeting short-circuit** via conservative regex (`hi`, `hello`, `thanks`, ...) — saves embed + DB round trips on chit-chat
- [x] **`is_search` flag** on LLM intent — catches off-topic queries ("what time is it in india") that slip past regex
- [x] **Category-relax fallback** — if exact category match returns 0, retry without category filter (keeps brand filter); flagged as `searchType: hybrid_category_relaxed`
- [x] **SKU narrowing** — if free_text contains SKU-shaped tokens, post-filter results to keep only literal SKU matches; `searchType: hybrid_sku`
- [x] **SKU not-found handling** — when SKU is searched but zero literal matches, mark `sku_lookup_no_exact_match: true` so the reply says "we don't carry SKU X, here are related items" instead of pretending to have found the SKU; `searchType: hybrid_sku_no_match`
- [x] **Q&A vs search disambiguation** — `is_search=false` for follow-up questions about already-shown products ("tell me more", "what's the manufacturer series", "the cheapest one") so they don't trigger new card grids

### Natural-language replies
- [x] `chatText()` added to LLM gateway — plain-text completion path alongside `chatJson()`
- [x] `/api/v6-search` now calls Haiku for a 1-2 sentence reply after every search
- [x] Reply prompt grounds in: full 12-product result list, pre-computed price stats, last 4 conversation turns, SKU-not-found flag
- [x] Honest count wording: "here are 12 top matches" not "we have 12 in stock"
- [x] Spec-question branch: when products found but spec metafields aren't indexed, acknowledge product exists + defer to sales rather than hallucinating

### Demo page (Phase 9)
- [x] `/test-chat` route — chat UI deliberately styled distinct from v5 (dark navy + teal industrial dashboard, monospace telemetry sidebar)
- [x] Live sidebar: "What v6 understood" + "Carry-over state" + "How v6 differs from v5"
- [x] Quick-prompt buttons for the 5 eval cases
- [x] `/api/v6-search` JSON endpoint — bypasses MCP/Claude streaming layer, returns just smartSearch result + reply text
- [x] Sanity script `scripts/sanity-check-index.js` confirms 146k rows, top vendors, HNSW queryable

## Deferred (post-bake-off priority list)

### High value, low effort

1. **Metafield ingest (specs JSONB)** — Shopify products carry rich structured specs (manufacturer series, country of origin, IP rating, voltage, dimensions, etc.) as metafields. Our `specs` JSONB column is already in the schema, just empty. Adding `metafields(first: 50) { nodes { namespace key value type } }` to the bootstrap GraphQL query and storing them would let v6 answer spec questions accurately instead of deferring to sales. ~2-3 hours dev + re-bootstrap (~80 min). Decision was made today to defer until after the bake-off — current behavior (acknowledge product, defer to sales) is honest and works.

2. **Analytics path** — questions like "how many brands have circuit breakers", "count of Siemens products", "list all categories under pneumatics" are simple `COUNT() GROUP BY` queries but the current pipeline only does retrieval (returns top 12 reranked products). Adding an analytics intent flag + branch in the router + COUNT/GROUP BY SQL would unlock these in ~1-2 hours. v5 can't do this either, so it's a differentiator if added. Useful for procurement-style users scoping inventory before quotes.

3. **Nightly cron sync** — `/api/sync/full` route is built and protected by `SYNC_SECRET`; just needs a Railway-native cron or GitHub Actions workflow to POST to it nightly. Webhook handlers also already implemented for create/update/delete. Note: the Dev Dashboard token expires every 24h, so cron auth needs to use `client_credentials` grant refresh — a small wrapper around `admin-shopify.server.js`.

### Lower priority

4. **Storefront preview toggle** — add `?bot=v6` query param to the theme.liquid so stakeholders can test v6 inside the actual store browser without affecting public traffic.
5. **Production cutover** — after the bake-off win, replace the Shopify app extension's chat widget config to point at v6's deployment URL, or unpublish Shahid's extension and ship v6 as the official one.
6. **Specs-based filtering** ("show me filter regulators rated 60°C or above") — requires metafield ingest first (#1).
7. **Category normalization v2** — fuzzy match the LLM-extracted category against actual catalog vocabulary instead of relying on the relax-fallback. Would reduce the rate of `hybrid_category_relaxed` hits.

## Recent decisions log (newest first)

| Date | Decision | Reason |
|---|---|---|
| 2026-05-13 | Defer Shopify metafield ingest to post-bake-off | Current spec-question UX (acknowledge product, defer to sales) is honest; bake-off is about retrieval quality, not spec coverage. v5 doesn't have grounded specs either |
| 2026-05-13 | Defer analytics path (COUNT/GROUP BY) | Not on the failing path we set out to fix; v5 also can't do this |
| 2026-05-13 | Add `is_search` flag to LLM intent | Regex-based greeting filter missed off-topic queries longer than ~40 chars (e.g. "what time is it in india right now") |
| 2026-05-13 | SKU references always trigger search even when framed as Q&A | Side-by-side vs v5 surfaced a regression: v6 said "we don't have that model" for an in-stock SKU because the LLM marked it as Q&A and we never searched |
| 2026-05-13 | Q&A turns about prior products skip retrieval | "what's the manufacturer series" was dumping 12 irrelevant cards on top of correct text reply; the right test is "does the page need NEW cards?" |
| 2026-05-13 | Reply LLM gets recent_conversation + price_stats + sku flags | Replies were hallucinating prices and confidently claiming "we don't stock" products we'd just shown |
| 2026-05-13 | Built `/test-chat` demo page as new service, not modifying Shahid's widget | Bake-off must compare v6 vs. v5 side-by-side; Shahid's v5 stays running on live storefront, v6 lives on its own Railway URL |
| 2026-05-12 | Switched bootstrap to multi-row INSERT batched per page | Per-row upserts over Railway public proxy were 274s/page → would have taken ~44 hours for 146k products |
| 2026-05-12 | Bypassed voyageai npm SDK, call REST directly | Installed SDK was v0.0.3, pre-voyage-3 era, silently dropped `output_dimension` field |
| 2026-05-12 | Switched embed model to `voyage-3.5-lite` | `voyage-3-lite` is locked at 512-dim; `3.5-lite` is same price/free trial with configurable output_dimension |
| 2026-05-12 | Added normalization layer (vendorNormalized + categories TEXT[]) | Real catalog had case/punctuation duplicates ("ABB"/"Abb") and brand-prefixed redundant tags; hard filters were silently missing 20-40% of legitimate hits |
| 2026-05-12 | Reuse codebase, replace retrieval layer only | Bug is localized to retrieval; rewriting auth/cart/widget wastes 2-4 weeks |
| 2026-05-12 | Postgres + pgvector on existing Railway instance | 146k products is trivial for one Postgres; zero new infra |
| 2026-05-12 | Route Haiku (query understanding) through OpenRouter | Rohit has OpenRouter credit; new `app/services/llm.server.js` gateway uses OpenAI SDK pointed at OpenRouter's compatible endpoint |
| 2026-05-12 | Keep Sonnet (final reply) on direct Anthropic SDK | Streaming + tool-use path is delicate; lower risk to leave `claude.server.js` untouched at the SDK layer in v1 |

## Key facts for a new session

- **Total catalog:** 146,115 products. 202 distinct vendors. 25 distinct productTypes (but those are coarse — granular categories live in `categories TEXT[]` derived from tags).
- **Shop domain:** `nfejky-ge.myshopify.com` (custom domain `creativeautomation.ae`).
- **Railway project:** `creative-chatbot-Rohit` (Rohit's account; Shahid still has the production v5 chatbot in a separate Railway project). Postgres service is the only thing deployed there right now; new chatbot-v6 service is being added.
- **Env vars in .env (also need to be in Railway):** `VOYAGE_API_KEY`, `OPENROUTER_API_KEY`, `COHERE_API_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL` (use Railway internal reference: `${{Postgres.DATABASE_URL}}`), `SYNC_SECRET`, plus dummy Shopify env vars (`SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`) so the Shopify SDK initializes.
- **Voyage admin token (`SHOPIFY_ADMIN_TOKEN`)** — obtained via Dev Dashboard `client_credentials` grant flow; expires every 24h. Only needed for bootstrap / sync, not for `/test-chat`. Refresh wrapper is a TODO before nightly cron goes live.
- **Storefront host:** `creativeautomation.ae` (used to build product URLs).
- **Currency:** AED. Most products priced.
- **Bootstrap script runs from local laptop** to avoid Railway compute spend during ingest.

## Last updated

2026-05-13 — by Rohit + Claude, end of demo-page polish phase. All implementation done; only thing left is the Railway deploy + share with manager for bake-off testing. After the company decides v6 wins, we revisit the deferred items (metafields, analytics, cron, production cutover).
