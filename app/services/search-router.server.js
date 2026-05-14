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
import { hybridSearch, findProductsByTitlePattern } from './retrieval.server.js';
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

  // Early-exit on non-search turns.
  //  Primary:  the LLM's is_search flag — handles arbitrary chit-chat / off-topic
  //  Fallback: a conservative greeting regex — used when the LLM is unreachable
  //            and we got a fallbackIntent (which defaults is_search=true)
  const intentEmpty =
    !intent.category
    && (!intent.brand_include || intent.brand_include.length === 0)
    && (!intent.brand_exclude || intent.brand_exclude.length === 0)
    && (!intent.specs || Object.keys(intent.specs).length === 0);

  if (intent.is_search === false || (intentEmpty && isLikelyNonSearch(intent.free_text))) {
    emit('chat_turn_completed', {
      total_ms: Date.now() - startedAt,
      qu_ms: t1Ms, embed_ms: 0, retrieval_ms: 0, rerank_ms: 0,
      candidates: 0, returned: 0, embed_fallback: false,
      skipped: intent.is_search === false ? 'non_search_llm' : 'non_search_regex',
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

  // Step 3 — hybrid retrieval with a 3-tier relax cascade.
  //
  // Two retrieval paths run together each pass:
  //   (a) hybridSearch — structured spec_values JSONB containment filter
  //   (b) findProductsByLiteralPattern — literal slash-style spec patterns
  //       (5/2, 3/2, 1/4) that the Postgres `simple` tsvector tokenizer destroys
  //
  // Cascade tiers — each tier only fires if the previous returned zero:
  //   1. Strict        — category + brand + spec_values (full intent)
  //   2. Spec-relaxed  — drop spec_values, keep category + brand. Triggered
  //                      when LLM extracts free-text spec tokens ("230V",
  //                      "single phase") that don't match the catalog's
  //                      literal formatting ("230 V ac", "1 Phase") and
  //                      collapse the result set to nothing.
  //   3. Cat-relaxed   — drop category too, keep brand only. Triggered when
  //                      the LLM picked a category absent from the catalog.
  //
  // We run spec-relax BEFORE category-relax because spec_values is the noisier
  // signal — the LLM frequently picks tokens that don't appear verbatim in
  // the catalog, while the user's category intent is usually right.
  const t3 = Date.now();
  const specPatterns = extractSlashSpecPatterns(intent.free_text);
  const mergedSpecValues = mergeUnique(intent.spec_values || [], specPatterns);
  // Detect SKU tokens up front. When the user types a SKU like "DUS60E", the
  // LLM frequently sticks the carry-over category (e.g. "inverter drives" from
  // a prior turn) onto the new turn — locking retrieval to the wrong shelf
  // and blocking the exact product. A SKU is a specific-product signal that
  // overrides topical context, so we null category before retrieval and let
  // BM25 + vector + the post-rerank SKU narrowing do the rest. Brand filters
  // stay — user can still say "the Siemens version of X".
  const skuTokensEarly = extractSkuTokens(intent.free_text);
  const skuOverridesCategory = skuTokensEarly.length > 0 && intent.category != null;
  const strictFilters = {
    category: skuOverridesCategory ? null : intent.category,
    brand_include: intent.brand_include,
    brand_exclude: intent.brand_exclude,
  };

  // Single retrieval pass — dual-path + dedup. Returns merged candidates
  // (spec-pattern matches first, then hybrid) and a `specBoosted` flag.
  const runPass = async (filters, specValues) => {
    const [hybridResults, specResults] = await Promise.all([
      hybridSearch({
        ...filters,
        spec_values: specValues,
        free_text: intent.free_text,
        query_vector: queryVector,
      }),
      specPatterns.length > 0
        ? findProductsByTitlePattern(specPatterns, { ...filters, limit: 20 })
        : Promise.resolve([]),
    ]);
    const seen = new Set();
    const out = [];
    for (const p of specResults) {
      if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
    }
    for (const p of hybridResults) {
      if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
    }
    return { merged: out, specBoosted: specResults.length > 0 };
  };

  // Tier 1 — strict.
  const pass1 = await runPass(strictFilters, mergedSpecValues);
  let candidates = pass1.merged;
  const specBoosted = pass1.specBoosted;
  let specRelaxed = false;
  let categoryRelaxed = false;

  // Tier 2 — spec relax (only if spec_values were actually applied).
  if (candidates.length === 0 && mergedSpecValues.length > 0) {
    specRelaxed = true;
    const pass2 = await runPass(strictFilters, []);
    candidates = pass2.merged;
  }

  // Tier 3 — category relax (drop both category and spec_values, keep brand).
  // Only fires if a category filter was actually in effect during this turn —
  // SKU queries already null category up front, so there's nothing to relax.
  if (candidates.length === 0 && strictFilters.category) {
    categoryRelaxed = true;
    const relaxedFilters = {
      category: null,
      brand_include: intent.brand_include,
      brand_exclude: intent.brand_exclude,
    };
    const pass3 = await runPass(relaxedFilters, []);
    candidates = pass3.merged;
  }

  // Hard slash-pattern post-filter. When the user asked for "5/2", drop any
  // candidate whose title/description/specs don't literally contain that
  // pattern. The hybrid path can otherwise pull in BM25 lookalikes ("BP 15/2",
  // "1/2 NPT") and vector-similar valves with a different port config (3/2
  // instead of 5/2) that the rerank model doesn't know is a hard constraint.
  // Better to return an honest empty page than 12 wrong-port valves.
  if (specPatterns.length > 0) {
    candidates = candidates.filter(p => productContainsAllPatterns(p, specPatterns));
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
  let top = await rerank(intent.free_text, candidates, RETRIEVAL_CONFIG.finalResultSize);
  const t4Ms = Date.now() - t4;

  // SKU-tight filter: if the user query carries a SKU-shaped token, only
  // products that literally contain that token (in title or a variant SKU)
  // are useful. Without this, the rerank dilutes the page with vector-only
  // matches that share no real signal with the SKU.
  //   skuFiltered          = the page WAS narrowed to actual SKU matches
  //   skuLookupNoExactMatch = a SKU was searched but the catalog has none;
  //                           kept the hybrid results as "related items"
  // Tokens were already extracted at the top of step 3 to drive category-override.
  const skuTokens = skuTokensEarly;
  let skuFiltered = false;
  let skuLookupNoExactMatch = false;
  if (skuTokens.length > 0) {
    const narrowed = top.filter(p => productMatchesAnySku(p, skuTokens));
    if (narrowed.length > 0) {
      top = narrowed;
      skuFiltered = true;
    } else {
      skuLookupNoExactMatch = true;
    }
  }

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
    spec_relaxed: specRelaxed,
    category_relaxed: categoryRelaxed,
    spec_boosted: specBoosted,
    sku_overrides_category: skuOverridesCategory,
    sku_filtered: skuFiltered,
    sku_lookup_no_exact_match: skuLookupNoExactMatch,
    top3_ids: top.slice(0, 3).map(p => p.id),
  });

  let searchType = 'hybrid';
  if (skuFiltered) searchType = 'hybrid_sku';
  else if (skuLookupNoExactMatch) searchType = 'hybrid_sku_no_match';
  else if (categoryRelaxed) searchType = 'hybrid_category_relaxed';
  else if (specRelaxed) searchType = 'hybrid_spec_relaxed';
  else if (specBoosted) searchType = 'hybrid_spec';

  return {
    products: top,
    intent,
    searchType,
    skuTokens,
    skuLookupNoExactMatch,
    systemHint: skuLookupNoExactMatch
      ? `No exact match for SKU "${skuTokens.join(', ')}". Showing ${top.length} related products as alternatives.`
      : `Found ${top.length} matching products. Acknowledge briefly — the cards are already displayed.`,
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
function mergeUnique(...arrays) {
  const seen = new Set();
  const out = [];
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const v of arr) {
      const key = String(v).trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

// Extract slash-separated numeric spec patterns (5/2, 3/2, 1/4, etc.) that
// the Postgres `simple` tsvector tokenizer destroys. Used to drive a literal-
// pattern title query alongside the hybrid search so spec-matched products
// don't get lost in BM25's blind spot.
export function extractSlashSpecPatterns(text) {
  if (!text || typeof text !== 'string') return [];
  const matches = text.match(/\b\d+\/\d+\b/g) || [];
  return [...new Set(matches)];
}

// Extract tokens that look like a product SKU from arbitrary free-text.
// A real SKU has both digits and letters/punctuation, AND is structured enough
// to be more than a units-style token. Rules:
//   - must contain at least one digit
//   - must contain a letter OR structural punctuation (dot/hyphen/underscore/slash)
//   - must be either 5+ chars long (DUS60E, R412006218, ACS310) OR contain
//     structural punctuation (DSNU-20, 1.5/2). A short "230V" / "24V" / "M20"
//     is a spec, not a SKU; without this gate the filter mistakes voltages for
//     part numbers and aggressively prunes correct results.
// Returns uppercased dedup'd list.
export function extractSkuTokens(text) {
  if (!text || typeof text !== 'string') return [];
  const out = new Set();
  const matches = text.match(/\b[A-Za-z0-9][A-Za-z0-9.\-_/]{3,}\b/g) || [];
  for (const m of matches) {
    if (!/\d/.test(m)) continue;                            // must have a digit
    if (!/[A-Za-z]/.test(m) && !/[.\-_/]/.test(m)) continue; // not pure-number
    const hasStructuralPunct = /[.\-_/]/.test(m);
    if (m.length < 5 && !hasStructuralPunct) continue;      // skip short tokens like "230V", "24V", "M20"
    out.add(m.toUpperCase());
  }
  return [...out];
}

// Hard slash-pattern check. A candidate passes only if EVERY requested pattern
// appears as a word-boundaried slash-token in the product's title, description,
// or spec values. Word boundaries matter: a "5/2" request must NOT match a
// product titled "BP 15/2" — the substring is there but the actual port-config
// token in that title is "15/2", not "5/2". Same regex as extractSlashSpecPatterns
// so request-side and product-side parse the same way.
export function productContainsAllPatterns(product, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true;
  const parts = [];
  if (typeof product.title === 'string') parts.push(product.title);
  if (typeof product.description === 'string') parts.push(product.description);
  if (product.specs && typeof product.specs === 'object') {
    for (const v of Object.values(product.specs)) {
      if (v != null) parts.push(String(v));
    }
  }
  const blob = parts.join(' ');
  const productTokens = new Set(blob.match(/\b\d+\/\d+\b/g) || []);
  return patterns.every(pat => productTokens.has(pat));
}

function productMatchesAnySku(product, skus) {
  const haystack = [];
  if (typeof product.title === 'string') haystack.push(product.title.toUpperCase());
  if (typeof product.handle === 'string') haystack.push(product.handle.toUpperCase());
  const variants = Array.isArray(product.variants)
    ? product.variants
    : (product.variants?.nodes || []);
  for (const v of variants) {
    if (typeof v?.sku === 'string') haystack.push(v.sku.toUpperCase());
  }
  const blob = haystack.join(' ');
  return skus.some(s => blob.includes(s));
}

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
