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
  findProductsByTitlePattern: vi.fn().mockResolvedValue([]),
  findProductsByLiteralPattern: vi.fn().mockResolvedValue([]),
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

  it('extractSlashSpecPatterns finds industrial spec tokens like 5/2, 3/2, 1/4', async () => {
    const { extractSlashSpecPatterns } = await import('../../app/services/search-router.server.js?case=spec');
    expect(extractSlashSpecPatterns('solenoid valve 5/2')).toEqual(['5/2']);
    expect(extractSlashSpecPatterns('I need a 3/2 valve and a 5/2 valve')).toEqual(['3/2', '5/2']);
    expect(extractSlashSpecPatterns('filter regulator G 1/4 BSP')).toEqual(['1/4']);
    expect(extractSlashSpecPatterns('limit switches please')).toEqual([]);
    expect(extractSlashSpecPatterns('R412006218')).toEqual([]); // SKU, not a spec
    expect(extractSlashSpecPatterns('')).toEqual([]);
    expect(extractSlashSpecPatterns(null)).toEqual([]);
  });

  it('extractSkuTokens recognizes real SKU shapes and rejects ordinary words', async () => {
    const { extractSkuTokens } = await import('../../app/services/search-router.server.js?case=sku');
    expect(extractSkuTokens('R412006218')).toEqual(['R412006218']);
    expect(extractSkuTokens('R412006218 specs please')).toEqual(['R412006218']);
    expect(extractSkuTokens('DSNU-20-50-P-A')).toEqual(['DSNU-20-50-P-A']);
    expect(extractSkuTokens('Show me 1SBL237201R1400 spec sheet')).toEqual(['1SBL237201R1400']);
    expect(extractSkuTokens('limit switches please')).toEqual([]);
    expect(extractSkuTokens('100')).toEqual([]); // pure number — not a SKU
    expect(extractSkuTokens('hi there')).toEqual([]);
    expect(extractSkuTokens('')).toEqual([]);
    expect(extractSkuTokens(null)).toEqual([]);
  });

  it('drops candidates without the requested slash-pattern (5/2 != 3/2 != 15/2)', async () => {
    mods.qu.extractIntent.mockResolvedValue({
      is_search: true,
      category: 'solenoid valves',
      brand_include: [],
      brand_exclude: [],
      specs: {},
      spec_values: ['5/2'],
      free_text: 'solenoid valve 5/2',
    });
    mods.em.embedOne.mockResolvedValue(new Array(1024).fill(0.01));
    // Hybrid returns: one real 5/2 (keep), one 3/2 (drop), one "BP 15/2" lookalike (drop —
    // substring 5/2 is there but the token in the title is 15/2, not 5/2).
    mods.re.hybridSearch.mockResolvedValue([
      { id: 'good',  title: 'Waircom Solenoid Valve 5/2 1/2"', description: '', specs: {} },
      { id: 'wrong', title: 'SMC Solenoid Valve 3/2 1/4"',     description: '', specs: {} },
      { id: 'noise', title: 'BP 15/2 magnetic actuator',       description: '', specs: {} },
    ]);
    mods.re.findProductsByTitlePattern.mockResolvedValue([]);
    mods.rk.rerank.mockImplementation(async (_q, items) => items);

    const { smartSearch } = await import('../../app/services/search-router.server.js?case=slash');
    const out = await smartSearch({
      messages: [{ role: 'user', content: 'solenoid valve 5/2' }],
    });
    expect(out.products.map(p => p.id)).toEqual(['good']);
  });

  it('productContainsAllPatterns checks word-bounded slash tokens, not substrings', async () => {
    const { productContainsAllPatterns } = await import('../../app/services/search-router.server.js?case=helper');
    expect(productContainsAllPatterns({ title: 'Valve 5/2' }, ['5/2'])).toBe(true);
    expect(productContainsAllPatterns({ title: 'Valve 3/2' }, ['5/2'])).toBe(false);
    expect(productContainsAllPatterns({ title: 'BP 15/2 actuator' }, ['5/2'])).toBe(false);
    expect(productContainsAllPatterns({ title: '', description: '', specs: { Type: '5/2' } }, ['5/2'])).toBe(true);
    expect(productContainsAllPatterns({ title: 'anything' }, [])).toBe(true);
    expect(productContainsAllPatterns({ title: 'Valve 5/2 and 24V port' }, ['5/2'])).toBe(true);
  });

  it('short-circuits when LLM says is_search=false (off-topic)', async () => {
    mods.em.embedOne.mockClear();
    mods.re.hybridSearch.mockClear();
    mods.rk.rerank.mockClear();
    mods.qu.extractIntent.mockResolvedValue({
      is_search: false,
      category: null,
      brand_include: [],
      brand_exclude: [],
      specs: {},
      free_text: 'what time is it in india right now',
    });
    const { smartSearch } = await import('../../app/services/search-router.server.js?case=5');
    const out = await smartSearch({
      messages: [{ role: 'user', content: 'what time is it in india right now' }],
    });
    expect(out.searchType).toBe('non_search');
    expect(out.products).toEqual([]);
    expect(mods.em.embedOne).not.toHaveBeenCalled();
    expect(mods.re.hybridSearch).not.toHaveBeenCalled();
  });
});
