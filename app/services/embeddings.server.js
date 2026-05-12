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
