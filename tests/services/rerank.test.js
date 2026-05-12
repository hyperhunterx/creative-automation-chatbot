import { describe, it, expect, vi, beforeEach } from 'vitest';

const cohereInstance = { rerank: vi.fn() };

vi.mock('cohere-ai', () => ({
  CohereClientV2: vi.fn().mockImplementation(() => cohereInstance),
}));

describe('rerank', () => {
  beforeEach(() => {
    cohereInstance.rerank.mockReset();
    process.env.COHERE_API_KEY = 'test-key';
  });

  it('reorders candidates by Cohere relevance score', async () => {
    cohereInstance.rerank.mockResolvedValue({
      results: [
        { index: 2, relevanceScore: 0.95 },
        { index: 0, relevanceScore: 0.7 },
        { index: 1, relevanceScore: 0.3 },
      ],
    });

    const { rerank } = await import('../../app/services/rerank.server.js?one=1');
    const candidates = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
      { id: 'c', title: 'C' },
    ];
    const result = await rerank('query', candidates, 3);

    expect(result.map(r => r.id)).toEqual(['c', 'a', 'b']);
    expect(result[0].rerank_score).toBe(0.95);
  });

  it('falls back to original order when Cohere fails', async () => {
    cohereInstance.rerank.mockRejectedValue(new Error('boom'));

    const { rerank } = await import('../../app/services/rerank.server.js?two=2');
    const candidates = [
      { id: 'a', title: 'A' },
      { id: 'b', title: 'B' },
    ];
    const result = await rerank('query', candidates, 2);

    expect(result.map(r => r.id)).toEqual(['a', 'b']);
    expect(result[0].rerank_score).toBeUndefined();
  });

  it('returns empty array when no candidates', async () => {
    const { rerank } = await import('../../app/services/rerank.server.js?three=3');
    const result = await rerank('query', [], 5);
    expect(result).toEqual([]);
  });

  it('truncates to topN', async () => {
    cohereInstance.rerank.mockResolvedValue({
      results: [
        { index: 0, relevanceScore: 0.9 },
        { index: 1, relevanceScore: 0.8 },
      ],
    });

    const { rerank } = await import('../../app/services/rerank.server.js?four=4');
    const candidates = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const result = await rerank('query', candidates, 2);
    expect(result).toHaveLength(2);
  });
});
