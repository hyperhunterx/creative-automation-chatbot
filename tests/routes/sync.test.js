import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../app/services/admin-shopify.server.js', () => ({
  makeAdminClient: vi.fn(),
}));
vi.mock('../../app/services/product-index.server.js', () => ({
  upsertProductFromShopify: vi.fn(),
  softDeleteProduct: vi.fn(),
  getIndexedShopifyIds: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../app/services/embeddings.server.js', () => ({
  embedMany: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../app/services/config.server.js', () => ({
  RETRIEVAL_CONFIG: { syncSecret: 'right' },
}));

describe('POST /api/sync/full', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('rejects request without secret', async () => {
    const { action } = await import('../../app/routes/api.sync.full.jsx');
    const res = await action({
      request: new Request('http://x/api/sync/full', { method: 'POST' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects request with wrong secret', async () => {
    const { action } = await import('../../app/routes/api.sync.full.jsx');
    const res = await action({
      request: new Request('http://x/api/sync/full', {
        method: 'POST',
        headers: { 'X-Sync-Secret': 'wrong' },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects GET requests', async () => {
    const { action } = await import('../../app/routes/api.sync.full.jsx');
    const res = await action({
      request: new Request('http://x/api/sync/full', { method: 'GET' }),
    });
    expect(res.status).toBe(405);
  });
});
