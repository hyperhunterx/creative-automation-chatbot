// app/services/embeddings.server.js
//
// Direct REST call to Voyage AI. The installed `voyageai` JS SDK (0.0.3) is
// pre-voyage-3 era and silently drops `output_dimension`, so we hit the HTTP
// endpoint ourselves and pass the param in snake_case as the API expects.

import { RETRIEVAL_CONFIG } from './config.server.js';

const VOYAGE_EMBED_URL = 'https://api.voyageai.com/v1/embeddings';

async function voyageEmbed({ input, model, inputType, outputDimension }) {
  if (!RETRIEVAL_CONFIG.voyageApiKey) {
    throw new Error('VOYAGE_API_KEY is not configured');
  }
  const body = {
    input,
    model,
    output_dimension: outputDimension,
  };
  if (inputType) body.input_type = inputType;

  const res = await fetch(VOYAGE_EMBED_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RETRIEVAL_CONFIG.voyageApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Voyage ${res.status}: ${text.slice(0, 500)}`);
    err.statusCode = res.status;
    throw err;
  }
  return res.json();
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
    voyageEmbed({
      model: RETRIEVAL_CONFIG.embeddingModel,
      input: [input],
      inputType,
      outputDimension: RETRIEVAL_CONFIG.embeddingDimensions,
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
      voyageEmbed({
        model: RETRIEVAL_CONFIG.embeddingModel,
        input: chunk,
        inputType,
        outputDimension: RETRIEVAL_CONFIG.embeddingDimensions,
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
