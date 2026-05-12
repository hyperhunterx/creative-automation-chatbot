import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('voyageai', () => ({
  VoyageAIClient: vi.fn().mockImplementation(() => ({
    embed: vi.fn().mockResolvedValue({
      data: [
        { embedding: new Array(1024).fill(0.01), index: 0 },
        { embedding: new Array(1024).fill(0.02), index: 1 },
      ],
      model: 'voyage-3-lite',
      usage: { totalTokens: 10 },
    }),
  })),
}));

describe('embeddings.server', () => {
  beforeEach(() => {
    process.env.VOYAGE_API_KEY = 'test-key';
  });

  it('embedOne returns a 1024-dim vector', async () => {
    const { embedOne } = await import('../../app/services/embeddings.server.js?one=1');
    const v = await embedOne('M20 cylinder');
    expect(v).toHaveLength(1024);
    expect(v[0]).toBe(0.01);
  });

  it('embedMany returns one vector per input, ordered by index', async () => {
    const { embedMany } = await import('../../app/services/embeddings.server.js?many=1');
    const result = await embedMany(['a', 'b']);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(1024);
    expect(result[1][0]).toBe(0.02);
  });

  it('embedOne throws clearly when text is empty', async () => {
    const { embedOne } = await import('../../app/services/embeddings.server.js?empty=1');
    await expect(embedOne('')).rejects.toThrow(/empty/i);
  });

  it('vectorToPgLiteral formats correctly for pgvector', async () => {
    const { vectorToPgLiteral } = await import('../../app/services/embeddings.server.js?vec=1');
    expect(vectorToPgLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
  });
});
