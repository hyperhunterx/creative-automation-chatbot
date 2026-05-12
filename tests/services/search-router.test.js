import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../app/services/query-understanding.server.js', () => ({
  extractIntent: vi.fn(),
}));
vi.mock('../../app/services/embeddings.server.js', () => ({
  embedOne: vi.fn(),
  vectorToPgLiteral: v => `[${v.join(',')}]`,
}));
vi.mock('../../app/services/retrieval.server.js', () => ({
  hybridSearch: vi.fn(),
}));
vi.mock('../../app/services/rerank.server.js', () => ({
  rerank: vi.fn(),
}));

describe('smartSearch (v6 orchestrator)', () => {
  let mods;
  beforeEach(async () => {
    vi.resetModules();
    mods = {
      qu: await import('../../app/services/query-understanding.server.js'),
      em: await import('../../app/services/embeddings.server.js'),
      re: await import('../../app/services/retrieval.server.js'),
      rk: await import('../../app/services/rerank.server.js'),
    };
  });

  it('runs the full pipeline and returns top-N reranked candidates', async () => {
    mods.qu.extractIntent.mockResolvedValue({
      category: 'pneumatic cylinders',
      brand_include: [],
      brand_exclude: ['festo'],
      specs: {},
      free_text: 'M20 cylinder',
    });
    mods.em.embedOne.mockResolvedValue(new Array(1024).fill(0.01));
    mods.re.hybridSearch.mockResolvedValue([
      { id: '1', title: 'SMC', vendor: 'SMC', vendorNormalized: 'smc' },
      { id: '2', title: 'Norgren', vendor: 'Norgren', vendorNormalized: 'norgren' },
    ]);
    mods.rk.rerank.mockResolvedValue([
      { id: '2', title: 'Norgren', vendor: 'Norgren', vendorNormalized: 'norgren', rerank_score: 0.9 },
      { id: '1', title: 'SMC', vendor: 'SMC', vendorNormalized: 'smc', rerank_score: 0.8 },
    ]);

    const { smartSearch } = await import('../../app/services/search-router.server.js?case=1');
    const out = await smartSearch({
      messages: [{ role: 'user', content: 'M20 cylinder from another brand' }],
      lastShownCategory: 'pneumatic cylinders',
      lastShownBrands: ['festo'],
    });

    expect(out.products.map(p => p.id)).toEqual(['2', '1']);
    expect(out.intent.brand_exclude).toEqual(['festo']);
    expect(out.searchType).toBe('hybrid');
  });

  it('returns empty result with intent when retrieval is empty', async () => {
    mods.qu.extractIntent.mockResolvedValue({
      category: 'nonexistent',
      brand_include: [],
      brand_exclude: [],
      specs: {},
      free_text: 'nonsense xyz',
    });
    mods.em.embedOne.mockResolvedValue(new Array(1024).fill(0.01));
    mods.re.hybridSearch.mockResolvedValue([]);
    mods.rk.rerank.mockResolvedValue([]);

    const { smartSearch } = await import('../../app/services/search-router.server.js?case=2');
    const out = await smartSearch({ messages: [{ role: 'user', content: 'nonsense' }] });
    expect(out.products).toEqual([]);
    expect(out.searchType).toBe('hybrid_empty');
  });

  it('returns retrieval candidates when rerank returns them unchanged', async () => {
    mods.qu.extractIntent.mockResolvedValue({
      category: null,
      brand_include: [],
      brand_exclude: [],
      specs: {},
      free_text: 'x',
    });
    mods.em.embedOne.mockResolvedValue(new Array(1024).fill(0.01));
    mods.re.hybridSearch.mockResolvedValue([{ id: '1', title: 'A' }]);
    mods.rk.rerank.mockResolvedValue([{ id: '1', title: 'A' }]);

    const { smartSearch } = await import('../../app/services/search-router.server.js?case=3');
    const out = await smartSearch({ messages: [{ role: 'user', content: 'x' }] });
    expect(out.products).toHaveLength(1);
  });

  it('returns empty_input when messages is empty', async () => {
    const { smartSearch } = await import('../../app/services/search-router.server.js?case=4');
    const out = await smartSearch({ messages: [] });
    expect(out.searchType).toBe('empty_input');
    expect(out.products).toEqual([]);
  });
});
