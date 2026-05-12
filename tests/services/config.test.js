import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('RETRIEVAL_CONFIG', () => {
  let originalEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it('reads keys from env', async () => {
    process.env.VOYAGE_API_KEY = 'voyage-test';
    process.env.OPENROUTER_API_KEY = 'or-test';
    process.env.COHERE_API_KEY = 'cohere-test';
    process.env.SYNC_SECRET = 'sync-secret';

    // Re-import to pick up new env (vitest caches modules between tests).
    const mod = await import('../../app/services/config.server.js?reload=1');
    expect(mod.RETRIEVAL_CONFIG.voyageApiKey).toBe('voyage-test');
    expect(mod.RETRIEVAL_CONFIG.openrouterApiKey).toBe('or-test');
    expect(mod.RETRIEVAL_CONFIG.cohereApiKey).toBe('cohere-test');
    expect(mod.RETRIEVAL_CONFIG.embeddingModel).toBe('voyage-3-lite');
    expect(mod.RETRIEVAL_CONFIG.embeddingDimensions).toBe(1024);
    expect(mod.RETRIEVAL_CONFIG.queryUnderstandingModel).toBe('anthropic/claude-haiku-4-5');
  });

  it('assertRetrievalConfig throws when keys missing', async () => {
    delete process.env.VOYAGE_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.COHERE_API_KEY;
    const mod = await import('../../app/services/config.server.js?reload=2');
    expect(() => mod.assertRetrievalConfig()).toThrow(/VOYAGE_API_KEY/);
  });

  it('assertRetrievalConfig accepts ANTHROPIC_API_KEY as a fallback for the LLM key', async () => {
    process.env.VOYAGE_API_KEY = 'v';
    process.env.COHERE_API_KEY = 'c';
    delete process.env.OPENROUTER_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-...';
    const mod = await import('../../app/services/config.server.js?reload=3');
    expect(() => mod.assertRetrievalConfig()).not.toThrow();
  });
});
