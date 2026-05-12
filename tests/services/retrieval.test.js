import { describe, expect, beforeAll, afterAll } from 'vitest';
import { integrationIt, integrationDescribe, getTestPrisma, truncateProducts, disconnectTestPrisma } from '../setup/db.js';

function cylinderVec() {
  const v = new Array(1024).fill(0);
  v[0] = 1;
  return v;
}

integrationDescribe('retrieval.server', () => {
  beforeAll(async () => {
    await truncateProducts();
    const seed = await import('./_seed_retrieval.js');
    await seed.seedFixtures();
  });
  afterAll(async () => {
    await disconnectTestPrisma();
  });

  integrationIt('returns only products in the requested category', async () => {
    const { hybridSearch } = await import('../../app/services/retrieval.server.js');
    const results = await hybridSearch({
      category: 'pneumatic cylinders',
      brand_include: [],
      brand_exclude: [],
      free_text: 'cylinder',
      query_vector: cylinderVec(),
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(r => Array.isArray(r.categories) && r.categories.includes('pneumatic cylinders'))).toBe(true);
  });

  integrationIt('respects brand_exclude — excluded brand is not returned', async () => {
    const { hybridSearch } = await import('../../app/services/retrieval.server.js');
    const results = await hybridSearch({
      category: 'pneumatic cylinders',
      brand_include: [],
      brand_exclude: ['festo'],
      free_text: 'M20',
      query_vector: cylinderVec(),
    });
    expect(results.every(r => r.vendorNormalized !== 'festo')).toBe(true);
  });

  integrationIt('respects brand_include — only listed brands returned', async () => {
    const { hybridSearch } = await import('../../app/services/retrieval.server.js');
    const results = await hybridSearch({
      category: 'pneumatic cylinders',
      brand_include: ['smc'],
      brand_exclude: [],
      free_text: 'cylinder',
      query_vector: cylinderVec(),
    });
    expect(results.every(r => r.vendorNormalized === 'smc')).toBe(true);
  });

  integrationIt('normalizes mixed-case inputs defensively (smoke test)', async () => {
    const { hybridSearch } = await import('../../app/services/retrieval.server.js');
    const results = await hybridSearch({
      category: 'Pneumatic Cylinders',
      brand_include: ['SMC'],
      brand_exclude: [],
      free_text: 'cylinder',
      query_vector: cylinderVec(),
    });
    expect(results.every(r => r.vendorNormalized === 'smc')).toBe(true);
  });

  integrationIt('excludes soft-deleted products', async () => {
    const { hybridSearch } = await import('../../app/services/retrieval.server.js');
    const dbi = getTestPrisma();
    await dbi.$executeRawUnsafe(`UPDATE products SET "deletedAt" = now() WHERE "vendorNormalized" = 'smc'`);
    const results = await hybridSearch({
      category: 'pneumatic cylinders',
      brand_include: [],
      brand_exclude: [],
      free_text: 'cylinder',
      query_vector: cylinderVec(),
    });
    expect(results.every(r => r.vendorNormalized !== 'smc')).toBe(true);
  });
});
