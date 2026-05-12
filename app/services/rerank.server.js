// app/services/rerank.server.js
//
// Thin wrapper around Cohere Rerank 3.5. Reorders candidates by relevance to
// the query. On any failure (timeout, API error, missing key) returns the
// input candidates unchanged (truncated to topN) — the chat flow keeps
// working with the hybrid SQL ranking as a fallback.

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
  // Cohere accepts plain strings or objects with a `text` field. We feed
  // title + vendor + (truncated) description.
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
