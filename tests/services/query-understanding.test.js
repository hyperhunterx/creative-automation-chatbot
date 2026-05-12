import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../app/services/llm.server.js', () => ({
  chatJson: vi.fn(),
}));

import * as llm from '../../app/services/llm.server.js';

describe('extractIntent', () => {
  beforeEach(() => {
    llm.chatJson.mockReset();
  });

  it('extracts category + brand_exclude when user says "another brand"', async () => {
    llm.chatJson.mockResolvedValue({
      is_search: true,
      category: 'pneumatic guided cylinders',
      brand_include: [],
      brand_exclude: ['festo'],
      specs: {},
      free_text: 'M20 cylinder',
    });

    const { extractIntent } = await import('../../app/services/query-understanding.server.js?case=1');
    const intent = await extractIntent({
      messages: [
        { role: 'user', content: 'M20 cylinder from Festo' },
        { role: 'assistant', content: 'Here are some Festo M20 cylinders.' },
        { role: 'user', content: 'show me from another brand' },
      ],
      lastShownCategory: 'pneumatic guided cylinders',
      lastShownBrands: ['festo'],
    });

    expect(intent.is_search).toBe(true);
    expect(intent.category).toBe('pneumatic guided cylinders');
    expect(intent.brand_exclude).toEqual(['festo']);
  });

  it('parses is_search=false for greetings / off-topic questions', async () => {
    llm.chatJson.mockResolvedValue({
      is_search: false,
      category: null,
      brand_include: [],
      brand_exclude: [],
      specs: {},
      free_text: 'what time is it in india right now',
    });
    const { extractIntent } = await import('../../app/services/query-understanding.server.js?case=is_search_false');
    const intent = await extractIntent({
      messages: [{ role: 'user', content: 'what time is it in india right now' }],
    });
    expect(intent.is_search).toBe(false);
    expect(intent.category).toBeNull();
    expect(intent.brand_include).toEqual([]);
  });

  it('defaults is_search=true when the LLM omits the field', async () => {
    llm.chatJson.mockResolvedValue({
      category: 'cables',
      brand_include: [],
      brand_exclude: [],
      specs: {},
      free_text: 'cables',
    });
    const { extractIntent } = await import('../../app/services/query-understanding.server.js?case=is_search_default');
    const intent = await extractIntent({
      messages: [{ role: 'user', content: 'cables' }],
    });
    expect(intent.is_search).toBe(true);
  });

  it('extracts category + brand_include when user specifies brand', async () => {
    llm.chatJson.mockResolvedValue({
      category: 'circuit breakers',
      brand_include: ['abb'],
      brand_exclude: [],
      specs: {},
      free_text: 'circuit breaker',
    });

    const { extractIntent } = await import('../../app/services/query-understanding.server.js?case=2');
    const intent = await extractIntent({
      messages: [{ role: 'user', content: 'ABB circuit breaker' }],
    });

    expect(intent.brand_include).toEqual(['abb']);
  });

  it('lowercases values even when the LLM accidentally returns mixed case', async () => {
    llm.chatJson.mockResolvedValue({
      category: 'Pneumatic Guided Cylinders',
      brand_include: ['Festo', '  SMC  '],
      brand_exclude: ['ABB'],
      specs: {},
      free_text: 'cylinder',
    });

    const { extractIntent } = await import('../../app/services/query-understanding.server.js?case=2b');
    const intent = await extractIntent({
      messages: [{ role: 'user', content: 'cylinder' }],
    });
    expect(intent.category).toBe('pneumatic guided cylinders');
    expect(intent.brand_include).toEqual(['festo', 'smc']);
    expect(intent.brand_exclude).toEqual(['abb']);
  });

  it('returns null filters and raw free_text on parse failure', async () => {
    llm.chatJson.mockResolvedValue(null);

    const { extractIntent } = await import('../../app/services/query-understanding.server.js?case=3');
    const intent = await extractIntent({
      messages: [{ role: 'user', content: 'some query' }],
    });

    expect(intent.category).toBeNull();
    expect(intent.brand_include).toEqual([]);
    expect(intent.free_text).toBe('some query');
  });

  it('returns fallback intent on LLM error', async () => {
    llm.chatJson.mockRejectedValue(new Error('boom'));

    const { extractIntent } = await import('../../app/services/query-understanding.server.js?case=4');
    const intent = await extractIntent({
      messages: [{ role: 'user', content: 'M20 cylinder' }],
    });

    expect(intent.category).toBeNull();
    expect(intent.free_text).toBe('M20 cylinder');
  });

  it('filters out non-string entries from brand_include/exclude arrays', async () => {
    llm.chatJson.mockResolvedValue({
      category: 'relays',
      brand_include: ['Siemens', 42, null],
      brand_exclude: [{ bad: 'obj' }, 'Omron'],
      specs: {},
      free_text: 'relay',
    });
    const { extractIntent } = await import('../../app/services/query-understanding.server.js?case=5');
    const intent = await extractIntent({ messages: [{ role: 'user', content: 'relay' }] });
    expect(intent.brand_include).toEqual(['siemens']);
    expect(intent.brand_exclude).toEqual(['omron']);
  });
});
