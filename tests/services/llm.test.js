import { describe, it, expect, vi, beforeEach } from 'vitest';

const openaiInstance = { chat: { completions: { create: vi.fn() } } };

vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => openaiInstance),
  OpenAI: vi.fn().mockImplementation(() => openaiInstance),
}));

describe('llm.server (OpenRouter-via-OpenAI-SDK gateway)', () => {
  beforeEach(() => {
    openaiInstance.chat.completions.create.mockReset();
    process.env.OPENROUTER_API_KEY = 'or-test';
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('chatJson returns parsed JSON from the model response', async () => {
    openaiInstance.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: '{"category":"X","brand_include":[],"brand_exclude":[],"specs":{},"free_text":"q"}' } }],
    });
    const { chatJson } = await import('../../app/services/llm.server.js?one=1');
    const out = await chatJson({
      model: 'anthropic/claude-haiku-4-5',
      system: 'sys',
      user: 'msg',
      maxTokens: 256,
    });
    expect(out.category).toBe('X');
  });

  it('chatJson returns null on invalid JSON', async () => {
    openaiInstance.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: 'not json' } }],
    });
    const { chatJson } = await import('../../app/services/llm.server.js?two=2');
    const out = await chatJson({ model: 'x', system: 's', user: 'u' });
    expect(out).toBeNull();
  });

  it('strips markdown code-fence wrappers before parsing', async () => {
    openaiInstance.chat.completions.create.mockResolvedValue({
      choices: [{ message: { content: '```json\n{"category":"Y"}\n```' } }],
    });
    const { chatJson } = await import('../../app/services/llm.server.js?fence=1');
    const out = await chatJson({ model: 'x', system: 's', user: 'u' });
    expect(out.category).toBe('Y');
  });

  it('throws when neither OPENROUTER_API_KEY nor ANTHROPIC_API_KEY is set', async () => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { chatJson } = await import('../../app/services/llm.server.js?three=3');
    await expect(chatJson({ model: 'x', system: 's', user: 'u' })).rejects.toThrow(/OPENROUTER_API_KEY|ANTHROPIC_API_KEY/);
  });
});
