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
      category: 'Pneumatic Cylinder',
      brand_include: [],
      brand_exclude: ['Festo'],
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
      lastShownCategory: 'Pneumatic Cylinder',
      lastShownBrands: ['Festo'],
    });

    expect(intent.category).toBe('Pneumatic Cylinder');
    expect(intent.brand_exclude).toEqual(['Festo']);
  });

  it('extracts category + brand_include when user specifies brand', async () => {
    llm.chatJson.mockResolvedValue({
      category: 'Circuit Breaker',
      brand_include: ['ABB'],
      brand_exclude: [],
      specs: {},
      free_text: 'circuit breaker',
    });

    const { extractIntent } = await import('../../app/services/query-understanding.server.js?case=2');
    const intent = await extractIntent({
      messages: [{ role: 'user', content: 'ABB circuit breaker' }],
    });

    expect(intent.brand_include).toEqual(['ABB']);
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
      category: 'Relay',
      brand_include: ['Siemens', 42, null],
      brand_exclude: [{ bad: 'obj' }, 'Omron'],
      specs: {},
      free_text: 'relay',
    });
    const { extractIntent } = await import('../../app/services/query-understanding.server.js?case=5');
    const intent = await extractIntent({ messages: [{ role: 'user', content: 'relay' }] });
    expect(intent.brand_include).toEqual(['Siemens']);
    expect(intent.brand_exclude).toEqual(['Omron']);
  });
});
