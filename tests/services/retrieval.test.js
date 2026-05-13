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

  integrationIt('spec_values filter narrows to products whose specs contain the value', async () => {
    const { hybridSearch } = await import('../../app/services/retrieval.server.js');
    const results = await hybridSearch({
      category: 'pneumatic cylinders',
      brand_include: [],
      brand_exclude: [],
      spec_values: ['5/2'],
      free_text: 'cylinder',
      query_vector: cylinderVec(),
    });
    // Only Festo (x/1) and Schneider (x/6) have Type=5/2 in the seed.
    const ids = new Set(results.map(r => r.id));
    expect(ids.has('gid://x/1')).toBe(true);
    expect(ids.has('gid://x/6')).toBe(true);
    expect(ids.has('gid://x/2')).toBe(false); // SMC is 3/2
    expect(ids.has('gid://x/3')).toBe(false); // Norgren has no specs
  });

  integrationIt('spec_values is case-insensitive', async () => {
    const { hybridSearch } = await import('../../app/services/retrieval.server.js');
    const results = await hybridSearch({
      category: null,
      brand_include: [],
      brand_exclude: [],
      spec_values: ['germany'], // lowercase, seed has "Germany"
      free_text: 'cylinder',
      query_vector: cylinderVec(),
    });
    const ids = new Set(results.map(r => r.id));
    expect(ids.has('gid://x/1')).toBe(true); // Festo cylinder, Germany
    expect(ids.has('gid://x/4')).toBe(true); // Festo gauge, Germany
    expect(ids.has('gid://x/2')).toBe(false); // SMC, Japan
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
