// app/services/search-router.server.js
//
// v6.0 — hybrid retrieval orchestrator
//
// Replaces the v5 Storefront-search-based router. Pipeline per turn:
//   1. query understanding (Haiku via OpenRouter) → structured intent
//   2. embed the query free_text (Voyage AI)      → 1024-dim vector
//   3. hybrid retrieval (Postgres pgvector + tsvector + filters) → top 50
//   4. Cohere rerank                                              → top 12

import { extractIntent } from './query-understanding.server.js';
import { embedOne } from './embeddings.server.js';
import { hybridSearch } from './retrieval.server.js';
import { rerank } from './rerank.server.js';
import { RETRIEVAL_CONFIG } from './config.server.js';

// Telemetry — structured logs the user can grep for in Railway. A follow-up
// task can wire these into PostHog; for v1 they land in the Node log stream.
function emit(event, payload) {
  try {
    console.log(`[telemetry] ${event} ${JSON.stringify(payload)}`);
  } catch {
    // Telemetry must never break the chat path.
  }
}

/**
 * @param {object} args
 * @param {Array<{role: string, content: string}>} args.messages
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

  // Early-exit: if the LLM returned an empty intent (no category, no brands,
  // no specs) AND the user message is short / greeting-shaped, skip retrieval.
  // The chat layer will let Claude respond conversationally with no product cards.
  if (
    !intent.category
    && (!intent.brand_include || intent.brand_include.length === 0)
    && (!intent.brand_exclude || intent.brand_exclude.length === 0)
    && (!intent.specs || Object.keys(intent.specs).length === 0)
    && isLikelyNonSearch(intent.free_text)
  ) {
    emit('chat_turn_completed', {
      total_ms: Date.now() - startedAt,
      qu_ms: t1Ms, embed_ms: 0, retrieval_ms: 0, rerank_ms: 0,
      candidates: 0, returned: 0, embed_fallback: false,
      skipped: 'non_search',
    });
    return {
      products: [],
      intent,
      searchType: 'non_search',
      systemHint: 'User did not ask for products; respond conversationally without searching.',
    };
  }

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
  let candidates = await hybridSearch({
    category: intent.category,
    brand_include: intent.brand_include,
    brand_exclude: intent.brand_exclude,
    free_text: intent.free_text,
    query_vector: queryVector,
  });
  let categoryRelaxed = false;
  // If the LLM-extracted category was too narrow to match any catalog tag
  // verbatim (e.g. "pneumatic cylinders" when the catalog stores
  // "pneumatic cylinders & actuators"), retry without the category filter.
  // Brand filters are kept — they're the only stickiness signal that's
  // worth defending hard. The rerank step still favors topical relevance.
  if (candidates.length === 0 && intent.category) {
    categoryRelaxed = true;
    candidates = await hybridSearch({
      category: null,
      brand_include: intent.brand_include,
      brand_exclude: intent.brand_exclude,
      free_text: intent.free_text,
      query_vector: queryVector,
    });
  }
  const t3Ms = Date.now() - t3;

  if (candidates.length === 0) {
    emit('chat_search_zero_results', {
      free_text: intent.free_text,
      intent: {
        category: intent.category,
        brand_include: intent.brand_include,
        brand_exclude: intent.brand_exclude,
      },
    });
    emit('chat_turn_completed', {
      total_ms: Date.now() - startedAt,
      qu_ms: t1Ms,
      embed_ms: t2Ms,
      retrieval_ms: t3Ms,
      rerank_ms: 0,
      candidates: 0,
      returned: 0,
      embed_fallback: embedFallback,
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

  // Defensive check — the brand_exclude SQL filter should make this impossible.
  // If a violation is ever logged it's a real bug (e.g. filter bypassed).
  // intent.brand_exclude is already lowercase; compare against vendorNormalized.
  if (Array.isArray(intent.brand_exclude) && intent.brand_exclude.length > 0) {
    const bad = top.find(p => p.vendorNormalized && intent.brand_exclude.includes(p.vendorNormalized));
    if (bad) {
      emit('chat_brand_exclude_violated', {
        excluded: intent.brand_exclude,
        product_id: bad.id,
        product_vendor: bad.vendor,
        product_vendor_normalized: bad.vendorNormalized,
      });
    }
  }

  emit('chat_turn_completed', {
    total_ms: Date.now() - startedAt,
    qu_ms: t1Ms,
    embed_ms: t2Ms,
    retrieval_ms: t3Ms,
    rerank_ms: t4Ms,
    candidates: candidates.length,
    returned: top.length,
    embed_fallback: embedFallback,
    category_relaxed: categoryRelaxed,
    top3_ids: top.slice(0, 3).map(p => p.id),
  });

  return {
    products: top,
    intent,
    searchType: categoryRelaxed ? 'hybrid_category_relaxed' : 'hybrid',
    systemHint: `Found ${top.length} matching products. Acknowledge briefly — the cards are already displayed.`,
  };
}

// Conservative heuristic — returns true only if the message clearly isn't a
// product query (greeting / acknowledgement / short chit-chat). If unsure,
// we'd rather run a search than skip one.
const NON_SEARCH_PATTERNS = [
  /^(hi|hello|hey|yo|hola|salam|salaam)[!. ?]*$/i,
  /^(thanks|thank you|thx|ty)[!. ?]*$/i,
  /^(ok|okay|cool|nice|great|good|got it)[!. ?]*$/i,
  /^(bye|goodbye|cya)[!. ?]*$/i,
  /^(yes|no|yeah|nope|sure|maybe)[!. ?]*$/i,
];
function isLikelyNonSearch(text) {
  if (!text || typeof text !== 'string') return true;
  const t = text.trim();
  if (t.length === 0) return true;
  if (t.length > 40) return false; // long messages are almost always searches
  return NON_SEARCH_PATTERNS.some(re => re.test(t));
}

function emptyResult(intent, reason) {
  return {
    products: [],
    intent: { category: null, brand_include: [], brand_exclude: [], specs: {}, free_text: '', ...intent },
    searchType: reason,
    systemHint: 'No search performed.',
  };
}
