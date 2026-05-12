// tests/setup/mocks.js
import { vi } from 'vitest';

export function makeAnthropicMock(responseText) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: responseText }],
        stop_reason: 'end_turn',
      }),
    },
  };
}

export function makeOpenAIEmbedMock(vector) {
  const arr = Array.isArray(vector) ? vector : new Array(1536).fill(0.01);
  return {
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [{ embedding: arr, index: 0 }],
        model: 'text-embedding-3-small',
        usage: { prompt_tokens: 5, total_tokens: 5 },
      }),
    },
  };
}

export function makeCohereRerankMock(rankedIndices) {
  return {
    rerank: vi.fn().mockResolvedValue({
      results: rankedIndices.map((idx, position) => ({
        index: idx,
        relevance_score: 1 - position * 0.05,
      })),
    }),
  };
}
