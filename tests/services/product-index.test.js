import { describe, expect, beforeEach, afterAll } from 'vitest';
import { integrationIt, integrationDescribe, getTestPrisma, truncateProducts, disconnectTestPrisma } from '../setup/db.js';
import fixture from '../fixtures/shopify-product.json' with { type: 'json' };

integrationDescribe('product-index.server', () => {
  beforeEach(async () => {
    await truncateProducts();
  });
  afterAll(async () => {
    await disconnectTestPrisma();
  });

  integrationIt('upserts a new product and stores its embedding', async () => {
    const { upsertProductFromShopify } = await import('../../app/services/product-index.server.js');
    const fakeEmbed = async () => new Array(1024).fill(0.01);
    await upsertProductFromShopify(fixture, { embedOne: fakeEmbed });

    const db = getTestPrisma();
    const row = await db.product.findUnique({ where: { id: fixture.id } });
    expect(row).not.toBeNull();
    expect(row.title).toBe(fixture.title);
    expect(row.vendor).toBe('Festo');
    expect(row.vendorNormalized).toBe('festo');
    expect(row.categories).toEqual(['pneumatic', 'cylinder', 'iso-6432']);
  });

  integrationIt('upsert is idempotent for the same payload', async () => {
    const { upsertProductFromShopify } = await import('../../app/services/product-index.server.js');
    const fakeEmbed = async () => new Array(1024).fill(0.01);
    await upsertProductFromShopify(fixture, { embedOne: fakeEmbed });
    await upsertProductFromShopify(fixture, { embedOne: fakeEmbed });

    const db = getTestPrisma();
    const count = await db.product.count();
    expect(count).toBe(1);
  });

  integrationIt('skips upsert when incoming shopifyUpdatedAt is older than stored', async () => {
    const { upsertProductFromShopify } = await import('../../app/services/product-index.server.js');
    const fakeEmbed = async () => new Array(1024).fill(0.01);

    const newer = { ...fixture, updatedAt: '2026-04-30T12:00:00Z' };
    const older = { ...fixture, title: 'STALE', updatedAt: '2026-04-29T12:00:00Z' };

    await upsertProductFromShopify(newer, { embedOne: fakeEmbed });
    await upsertProductFromShopify(older, { embedOne: fakeEmbed });

    const db = getTestPrisma();
    const row = await db.product.findUnique({ where: { id: fixture.id } });
    expect(row.title).toBe(fixture.title); // not "STALE"
  });

  integrationIt('softDeleteProduct sets deletedAt without removing the row', async () => {
    const { upsertProductFromShopify, softDeleteProduct } = await import(
      '../../app/services/product-index.server.js'
    );
    const fakeEmbed = async () => new Array(1024).fill(0.01);
    await upsertProductFromShopify(fixture, { embedOne: fakeEmbed });
    await softDeleteProduct(fixture.id);

    const db = getTestPrisma();
    const row = await db.product.findUnique({ where: { id: fixture.id } });
    expect(row).not.toBeNull();
    expect(row.deletedAt).not.toBeNull();
  });
});
