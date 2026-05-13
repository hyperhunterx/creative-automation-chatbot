// app/services/retrieval.server.js
//
// Hybrid retrieval against the local Postgres index. Combines:
//   - structured filters (category, brand_include, brand_exclude) applied as
//     hard SQL constraints — these CANNOT be bypassed by ranking signals
//   - BM25 score via ts_rank_cd over the auto-maintained searchTsv
//   - cosine distance via pgvector's <=> operator over the embedding column
//
// Final score = bm25Weight * bm25 + vectorWeight * (1 - cos_distance)

import prisma from '../db.server.js';
import { vectorToPgLiteral } from './embeddings.server.js';
import { RETRIEVAL_CONFIG } from './config.server.js';

/**
 * @param {object} intent
 * @param {string|null} intent.category       lowercased granular tag, e.g. "pneumatic guided cylinders"
 * @param {string[]}    intent.brand_include  lowercased brand names
 * @param {string[]}    intent.brand_exclude  lowercased brand names
 * @param {string[]}    intent.spec_values    metafield values that MUST be present in product.specs
 * @param {string}      intent.free_text
 * @param {number[]}    intent.query_vector   (1024 dims)
 * @returns {Promise<Array<row>>} up to RETRIEVAL_CONFIG.candidatePoolSize rows
 */
export async function hybridSearch(intent) {
  const {
    category = null,
    brand_include = [],
    brand_exclude = [],
    spec_values = [],
    free_text = '',
    query_vector,
  } = intent || {};

  if (!Array.isArray(query_vector) || query_vector.length !== RETRIEVAL_CONFIG.embeddingDimensions) {
    throw new Error(
      `hybridSearch: query_vector must be a ${RETRIEVAL_CONFIG.embeddingDimensions}-dim array`
    );
  }

  // Defensive normalization at the boundary — even if a caller forgets to
  // lowercase, the SQL filter still works.
  const categoryNorm = category ? String(category).trim().toLowerCase() || null : null;
  const includeNorm = (brand_include || []).map(b => String(b).trim().toLowerCase()).filter(Boolean);
  const excludeNorm = (brand_exclude || []).map(b => String(b).trim().toLowerCase()).filter(Boolean);
  const specValuesNorm = (spec_values || []).map(s => String(s).trim()).filter(Boolean);

  // tsquery cannot be the empty string; use a placeholder when free_text is blank.
  const ftsClean = (free_text || '').trim() || 'a';
  const vecLit = vectorToPgLiteral(query_vector);

  // Spec-values filter: every required value must appear SOMEWHERE the product
  // carries searchable text — specs JSONB, title, OR description. Specs alone
  // would be too strict for this catalog: most house-brand listings (Waircom,
  // Mindman, CPT) have empty metafields, but the actual spec ("5/2", "1/4")
  // lives in the title. A JSONB-only filter kills those rows even when the
  // title literally contains the user-requested value, which is the opposite
  // of what we want. So: pass if the value is in specs OR title OR description.
  // The strict word-boundary slash-pattern post-filter in search-router still
  // prevents "5/2" from matching "BP 15/2" lookalikes.
  //
  // Category filter uses ILIKE substring match (not equality) because the
  // catalog stores granular tags like "solenoid valve accessories",
  // "pneumatic solenoid valves", "valves & taps" — the LLM's coarse "solenoid
  // valves" would only equal-match 6 rows out of 6,000+. Substring keeps the
  // filter useful without forcing the LLM to know the catalog's exact tag
  // vocabulary. The relaxed fallback in search-router still handles the
  // residual case where the LLM picks a category absent from the catalog
  // entirely.
  const sql = `
    SELECT id, handle, title, vendor, "vendorNormalized", category, categories, tags, description,
           "priceMin", "priceMax", currency, "imageUrl", available, variants, specs,
           ts_rank_cd("searchTsv", plainto_tsquery('simple', $1)) AS bm25,
           1 - (embedding <=> $2::vector) AS cos
    FROM products
    WHERE "deletedAt" IS NULL
      AND (
        $3::text IS NULL
        OR EXISTS (SELECT 1 FROM unnest(categories) c WHERE c ILIKE '%' || $3 || '%')
      )
      AND (cardinality($4::text[]) = 0 OR "vendorNormalized" = ANY($4))
      AND (cardinality($5::text[]) = 0 OR "vendorNormalized" IS NULL OR "vendorNormalized" <> ALL($5))
      AND (
        cardinality($9::text[]) = 0
        OR NOT EXISTS (
          SELECT 1 FROM unnest($9::text[]) AS required(v)
          WHERE NOT (
            EXISTS (
              SELECT 1 FROM jsonb_each_text(specs) AS s
              WHERE lower(s.value) = lower(required.v)
            )
            OR title ILIKE '%' || required.v || '%'
            OR description ILIKE '%' || required.v || '%'
          )
        )
      )
    ORDER BY ($6 * ts_rank_cd("searchTsv", plainto_tsquery('simple', $1))
              + $7 * (1 - (embedding <=> $2::vector))) DESC
    LIMIT $8
  `;

  const rows = await prisma.$queryRawUnsafe(
    sql,
    ftsClean,
    vecLit,
    categoryNorm,
    includeNorm,
    excludeNorm,
    RETRIEVAL_CONFIG.bm25Weight,
    RETRIEVAL_CONFIG.vectorWeight,
    RETRIEVAL_CONFIG.candidatePoolSize,
    specValuesNorm,
  );

  return rows;
}

/**
 * Literal-pattern fallback for industrial spec tokens that the Postgres tsvector
 * `simple` config tokenizes badly. Slash-separated numerics like "5/2", "3/2",
 * "1/4" get split into pair-of-single-digit tokens by BM25 and lose all signal.
 * This query finds products whose title OR description literally contains any
 * of the patterns, respecting the same category / brand filters as hybridSearch.
 *
 * Note: spec values often live ONLY in the description text or metafields, not
 * the title — e.g. "Burkert Solenoid Valves 125334" with description
 * "3/2-way-solenoid valve, direct". Searching both surfaces matches that title-
 * only filtering would miss.
 *
 * @param {string[]} patterns           literal substrings to match
 * @param {object} filters
 * @param {string|null} filters.category
 * @param {string[]} filters.brand_include
 * @param {string[]} filters.brand_exclude
 * @param {number} [filters.limit]      max rows returned (default 20)
 */
export async function findProductsByLiteralPattern(patterns, filters = {}) {
  if (!Array.isArray(patterns) || patterns.length === 0) return [];
  const {
    category = null,
    brand_include = [],
    brand_exclude = [],
    limit = 20,
  } = filters;

  const categoryNorm = category ? String(category).trim().toLowerCase() || null : null;
  const includeNorm = (brand_include || []).map(b => String(b).trim().toLowerCase()).filter(Boolean);
  const excludeNorm = (brand_exclude || []).map(b => String(b).trim().toLowerCase()).filter(Boolean);

  // Build "(title ILIKE '%patN%' OR description ILIKE '%patN%' OR EXISTS(specs value match)) OR ..."
  // dynamically. Patterns start at parameter index 4 (after categoryNorm,
  // includeNorm, excludeNorm). Limit is appended last.
  //
  // The specs check is what lets us catch products like Burkert 125334 where
  // the 3/2 spec lives only in the metafield map, never in title or text.
  const literalConds = patterns
    .map((_, i) => `(
        title ILIKE '%' || $${4 + i} || '%'
        OR description ILIKE '%' || $${4 + i} || '%'
        OR EXISTS (
          SELECT 1 FROM jsonb_each_text(specs) AS s
          WHERE lower(s.value) = lower($${4 + i})
        )
      )`)
    .join(' OR ');

  const sql = `
    SELECT id, handle, title, vendor, "vendorNormalized", category, categories, tags, description,
           "priceMin", "priceMax", currency, "imageUrl", available, variants, specs
    FROM products
    WHERE "deletedAt" IS NULL
      AND (
        $1::text IS NULL
        OR EXISTS (SELECT 1 FROM unnest(categories) c WHERE c ILIKE '%' || $1 || '%')
      )
      AND (cardinality($2::text[]) = 0 OR "vendorNormalized" = ANY($2))
      AND (cardinality($3::text[]) = 0 OR "vendorNormalized" IS NULL OR "vendorNormalized" <> ALL($3))
      AND (${literalConds})
    LIMIT $${4 + patterns.length}
  `;

  return prisma.$queryRawUnsafe(
    sql,
    categoryNorm,
    includeNorm,
    excludeNorm,
    ...patterns,
    limit,
  );
}

// Back-compat alias for callers (search-router) — same behavior, new name above.
export const findProductsByTitlePattern = findProductsByLiteralPattern;
