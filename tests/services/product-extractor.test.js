import { describe, it, expect } from 'vitest';
import fixture from '../fixtures/shopify-product.json' with { type: 'json' };
import { extractProductRow, stripHtml } from '../../app/services/product-extractor.server.js';

describe('stripHtml', () => {
  it('removes tags', () => {
    expect(stripHtml('<p>hello <b>world</b></p>')).toBe('hello world');
  });
  it('decodes common entities', () => {
    expect(stripHtml('A &amp; B &lt;3 &nbsp;')).toBe('A & B <3');
  });
  it('returns empty string for null/undefined', () => {
    expect(stripHtml(null)).toBe('');
    expect(stripHtml(undefined)).toBe('');
  });
});

describe('extractProductRow', () => {
  it('extracts core fields from a Shopify GraphQL product', () => {
    const row = extractProductRow(fixture);
    expect(row.id).toBe('gid://shopify/Product/8123456789');
    expect(row.handle).toBe('festo-dsnu-20-50-p-a');
    expect(row.vendor).toBe('Festo');
    expect(row.productType).toBe('Pneumatic Cylinder');
    expect(row.category).toBe('Pneumatic Cylinder'); // v1 = productType
    expect(row.tags).toEqual(['pneumatic', 'cylinder', 'ISO-6432', 'festo']);
    expect(row.priceMin).toBe('210.00');
    expect(row.priceMax).toBe('210.00');
    expect(row.currency).toBe('AED');
    expect(row.imageUrl).toBe('https://cdn.shopify.com/.../dsnu-20-50.jpg');
    expect(row.shopifyUpdatedAt).toBe('2026-04-30T12:00:00.000Z');
  });

  it('strips HTML from description', () => {
    const row = extractProductRow(fixture);
    expect(row.description).not.toContain('<p>');
    expect(row.description).toContain('Bore 20mm'); // fixture uses capital B; keep natural casing
  });

  it('flattens variants with SKU + price + availability', () => {
    const row = extractProductRow(fixture);
    expect(row.variants).toHaveLength(1);
    expect(row.variants[0]).toMatchObject({
      id: 'gid://shopify/ProductVariant/411',
      sku: 'DSNU-20-50-P-A',
      price: '210.00',
      available: true,
    });
  });

  it('sets available=false when no variant is available', () => {
    const f = JSON.parse(JSON.stringify(fixture));
    f.variants.nodes[0].availableForSale = false;
    expect(extractProductRow(f).available).toBe(false);
  });

  it('builds textForEmbedding from title+vendor+productType+description', () => {
    const row = extractProductRow(fixture);
    expect(row.textForEmbedding).toContain('Festo');
    expect(row.textForEmbedding).toContain('Pneumatic Cylinder');
    expect(row.textForEmbedding).toContain('DSNU-20-50-P-A');
    expect(row.textForEmbedding).toContain('Bore 20mm');
  });
});
