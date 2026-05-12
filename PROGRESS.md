# Progress Tracker

> **Read me first if resuming in a new Claude session.**
> Always read `PLAN.md` for the full design and architectural rationale. This file only tracks status and short-term notes.

---

## Project context (for a new session)

- **Repo:** cloned from [shxhidtutorly/shxhid-chat-agent](https://github.com/shxhidtutorly/shxhid-chat-agent)
- **Working branch:** `rohit`
- **Goal:** fix the chatbot's retrieval quality so conversational follow-ups like "show me from another brand" work correctly on the 200k-product Creative Automation Shopify catalog.
- **Approach:** replace the Shopify Storefront search with a hybrid retrieval layer (Postgres + pgvector) we control. Add an LLM query-understanding step in front and a reranker behind. Keep everything else (Shopify auth, chat widget, cart, OAuth, conversation persistence) untouched.
- **Stack additions:** OpenAI text-embedding-3-small, Cohere Rerank 3.5, Anthropic Haiku 4.5 (in addition to Sonnet 4.6 already in use).

## Status overview

```
Phase 0  Brainstorming & design               [██████████] 100% — PLAN.md written
Phase 1  Implementation plan (writing-plans)  [░░░░░░░░░░]   0% — next step
Phase 2  Schema + bootstrap script            [░░░░░░░░░░]   0%
Phase 3  Ingestion (webhooks + cron)          [░░░░░░░░░░]   0%
Phase 4  Retrieval module                     [░░░░░░░░░░]   0%
Phase 5  Query understanding module           [░░░░░░░░░░]   0%
Phase 6  Rerank module                        [░░░░░░░░░░]   0%
Phase 7  Wire into chat.jsx                   [░░░░░░░░░░]   0%
Phase 8  Eval set + QA                        [░░░░░░░░░░]   0%
Phase 9  Ship to production                   [░░░░░░░░░░]   0%
```

## Checklist (in order)

### Phase 0 — Brainstorming & design
- [x] Read previous codebase, identify root cause (search quality, not Postgres scale)
- [x] Choose architecture: Approach A — hybrid retrieval + LLM query understanding + LLM rerank
- [x] Choose retrieval store: Postgres + pgvector on existing Railway instance
- [x] Choose models: OpenAI 3-small embed + Cohere Rerank 3.5 + Anthropic Haiku/Sonnet
- [x] Scope v1: search only (Q&A and cart polish deferred to v1.1+)
- [x] Clone repo into Chatbot dir, create `rohit` branch
- [x] Write PLAN.md + PROGRESS.md
- [x] User reviews PLAN.md and approves
- [x] Push repo to new GitHub home `hyperhunterx/creative-automation-chatbot` (squashed history, no secrets)
- [x] Invoke `superpowers:writing-plans` skill for granular implementation plan

### Phase 1 — Implementation plan
- [x] Use `superpowers:writing-plans` skill, input = PLAN.md
- [x] Output saved to [docs/superpowers/plans/2026-05-12-retrieval-rewrite.md](docs/superpowers/plans/2026-05-12-retrieval-rewrite.md) — 21 tasks, ~110 steps, covers Phases 2–9
- [ ] **User reviews implementation plan** ← we are here
- [ ] Choose execution mode (subagent-driven vs inline) and begin Task 1

### Phase 2 — Schema + bootstrap (no user-visible change yet)
- [ ] Add Prisma migration with `products` table + `pgvector` + `pg_trgm` extensions
- [ ] Add `last_shown_category`, `last_shown_brands` to `Conversation`
- [ ] Add OpenAI + Cohere env vars to Railway
- [ ] Write `scripts/bootstrap-index.js` (local-run, hits Railway public Postgres URL)
- [ ] Run bootstrap against staging copy first (or a 1000-product subset) to validate
- [ ] Run bootstrap against production Railway Postgres

### Phase 3 — Ingestion
- [ ] Implement `app/services/product-index.server.js` (upsert + idempotency + embedding)
- [ ] Implement `app/routes/api.webhooks.products.jsx`
- [ ] Subscribe to Shopify webhooks: products/create, products/update, products/delete, inventory_levels/update
- [ ] Implement `app/routes/api.sync.full.jsx`
- [ ] Configure cron (Railway-native or external) for nightly full sync

### Phase 4 — Retrieval module
- [ ] Implement `app/services/retrieval.server.js` (hybrid SQL query)
- [ ] Unit tests with seeded fixture products
- [ ] Verify brand-exclude is enforced by SQL, never by ranking

### Phase 5 — Query understanding
- [ ] Implement `app/services/query-understanding.server.js`
- [ ] Design extraction prompt (strict JSON output, low temperature)
- [ ] Pass `last_shown_category` and `last_shown_brands` as context
- [ ] Unit tests for the "another brand" scenario + SKU + brand + spec scenarios

### Phase 6 — Rerank
- [ ] Implement `app/services/rerank.server.js` (Cohere SDK)
- [ ] Fallback path if Cohere is down (use hybrid score directly)

### Phase 7 — Wire into chat
- [ ] Rewrite `app/services/search-router.server.js` as a thin orchestrator
- [ ] Update `app/services/tool.server.js` → consume new pipeline output
- [ ] Adjust system prompt in `app/services/claude.server.js` (do not strip brand/category)
- [ ] Persist `last_shown_category` and `last_shown_brands` after each turn
- [ ] Add fallback wiring per Section 10 of PLAN.md

### Phase 8 — Eval set + QA
- [ ] Collect 30–50 real failing queries from PostHog production logs
- [ ] Build hand-curated eval set with expected categories/brands
- [ ] Wire eval set into CI (gated behind INTEGRATION=1)
- [ ] Manual smoke test of cart/checkout flow (should be unaffected)

### Phase 9 — Ship
- [ ] Deploy `rohit` branch to a Railway preview environment
- [ ] QA with the real Shopify storefront against the preview backend
- [ ] Run eval set against preview, confirm targets met (precision@5 ≥ 0.8, brand-exclude 100%)
- [ ] Merge to `main`, redeploy
- [ ] Monitor PostHog for `chat_search_zero_results` and `chat_brand_exclude_violated` for 1 week

## Key facts for a new session

- **Railway project:** has Postgres service (with persistent volume) + the Remix Node service, both online.
- **Env vars already in Railway:** `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `DATABASE_URL`, `DATABASE_PUBLIC_URL`, "App automation token" (Shopify admin token), plus ~20 others (26 total). `ALGOLIA_*` vars exist but are unused — ignore them.
- **Env vars to add:** `OPENAI_API_KEY`, `COHERE_API_KEY`.
- **Bootstrap script runs from local laptop**, not Railway, to save Hobby plan compute credits.
- **Plan/Hobby tier** is the Railway plan in use — keep memory + CPU usage modest.
- **Storefront host:** `creativeautomation.ae` (used to build product URLs).
- **Currency:** AED.
- **Company branding** in system prompts: Creative Industrial Automation L.L.C (Creative Automation). Leave it alone.
- **Original author** of the codebase: Shahid Afrid (kept in the "Who created you?" prompt response). Leave it alone unless instructed.

## Recent decisions log

| Date | Decision | Reason |
|---|---|---|
| 2026-05-12 | Reuse the codebase, replace retrieval layer only | Bug is localized to retrieval; rewriting auth/cart/widget wastes 2-4 weeks |
| 2026-05-12 | Postgres + pgvector on existing Railway instance | 200k products is trivial for one Postgres; zero new infra |
| 2026-05-12 | ~~OpenAI 3-small embed~~ → Voyage AI `voyage-3-lite` (1024 dims) | Voyage 200M-token free trial covers bootstrap; voyage-3-lite slightly beats OpenAI 3-small on retrieval benchmarks; smaller vectors (1024 vs 1536) = smaller index. Embedding dimension column changed from `vector(1536)` to `vector(1024)` |
| 2026-05-12 | Route Haiku (query understanding) through OpenRouter | Rohit has $20 OpenRouter credit; use it instead of letting it sit idle. New `app/services/llm.server.js` gateway uses OpenAI SDK pointed at `https://openrouter.ai/api/v1` (Anthropic SDK doesn't support custom base URLs) |
| 2026-05-12 | Keep Sonnet (final reply) on direct Anthropic SDK | Streaming + tool-use path is delicate; lower risk to leave `claude.server.js` untouched at the SDK layer in v1. Can flip to OpenRouter later if desired |
| 2026-05-12 | Cohere Rerank kept | Free tier covers all of QA; small per-call cost in production |
| 2026-05-12 | Defer spec-based filtering to v1.1 | Spec extraction quality unknown; ship category + brand filters first |
| 2026-05-12 | Defer category normalization to v1.1 | Use raw Shopify productType in v1; add canonical mapping only if QA shows misses |
| 2026-05-12 | v1 scope = search only (no Q&A, no cart polish) | Lowest-risk, addresses the reported failure mode directly |

## Last updated

2026-05-12 — by Rohit + Claude, end of brainstorming phase. PLAN.md committed. Next step: get user review of PLAN.md, then invoke `superpowers:writing-plans` for the granular implementation plan.
