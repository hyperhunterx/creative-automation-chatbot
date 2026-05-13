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
 * @param {object}      intent.specs          (jsonb-containment filter; v1: ignored)
 * @param {string}      intent.free_text
 * @param {number[]}    intent.query_vector   (1024 dims)
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
    throw new Error(
      `hybridSearch: query_vector must be a ${RETRIEVAL_CONFIG.embeddingDimensions}-dim array`
    );
  }

  // Defensive normalization at the boundary — even if a caller forgets to
  // lowercase, the SQL filter still works.
  const categoryNorm = category ? String(category).trim().toLowerCase() || null : null;
  const includeNorm = (brand_include || []).map(b => String(b).trim().toLowerCase()).filter(Boolean);
  const excludeNorm = (brand_exclude || []).map(b => String(b).trim().toLowerCase()).filter(Boolean);

  // tsquery cannot be the empty string; use a placeholder when free_text is blank.
  const ftsClean = (free_text || '').trim() || 'a';
  const vecLit = vectorToPgLiteral(query_vector);

  const sql = `
    SELECT id, handle, title, vendor, "vendorNormalized", category, categories, tags, description,
           "priceMin", "priceMax", currency, "imageUrl", available, variants,
           ts_rank_cd("searchTsv", plainto_tsquery('simple', $1)) AS bm25,
           1 - (embedding <=> $2::vector) AS cos
    FROM products
    WHERE "deletedAt" IS NULL
      AND ($3::text IS NULL OR $3 = ANY(categories))
      AND (cardinality($4::text[]) = 0 OR "vendorNormalized" = ANY($4))
      AND (cardinality($5::text[]) = 0 OR "vendorNormalized" IS NULL OR "vendorNormalized" <> ALL($5))
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
  );

  return rows;
}

/**
 * Literal-pattern fallback for industrial spec tokens that the Postgres tsvector
 * `simple` config tokenizes badly. Slash-separated numerics like "5/2", "3/2",
 * "1/4" get split into pair-of-single-digit tokens by BM25 and lose all signal.
 * This query finds products whose title contains any of the patterns as a
 * substring, respecting the same category / brand filters as hybridSearch.
 *
 * @param {string[]} patterns           literal substrings to match in title
 * @param {object} filters
 * @param {string|null} filters.category
 * @param {string[]} filters.brand_include
 * @param {string[]} filters.brand_exclude
 * @param {number} [filters.limit]      max rows returned (default 20)
 */
export async function findProductsByTitlePattern(patterns, filters = {}) {
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

  // Build "title ILIKE '%pat1%' OR title ILIKE '%pat2%' OR ..." dynamically.
  // Patterns start at parameter index 4 (after categoryNorm, includeNorm,
  // excludeNorm). Limit is appended last.
  const titleConds = patterns
    .map((_, i) => `title ILIKE '%' || $${4 + i} || '%'`)
    .join(' OR ');

  const sql = `
    SELECT id, handle, title, vendor, "vendorNormalized", category, categories, tags, description,
           "priceMin", "priceMax", currency, "imageUrl", available, variants
    FROM products
    WHERE "deletedAt" IS NULL
      AND ($1::text IS NULL OR $1 = ANY(categories))
      AND (cardinality($2::text[]) = 0 OR "vendorNormalized" = ANY($2))
      AND (cardinality($3::text[]) = 0 OR "vendorNormalized" IS NULL OR "vendorNormalized" <> ALL($3))
      AND (${titleConds})
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
