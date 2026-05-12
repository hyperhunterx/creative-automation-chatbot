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
