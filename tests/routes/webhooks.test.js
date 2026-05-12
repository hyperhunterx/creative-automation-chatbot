import { describe, it, expect } from 'vitest';
import { normalizeRestProduct } from '../../app/services/webhook-payload.server.js';

describe('normalizeRestProduct', () => {
  const restPayload = {
    id: 8123456789,
    handle: 'festo-dsnu-20-50-p-a',
    title: 'Festo DSNU-20-50-P-A',
    vendor: 'Festo',
    product_type: 'Pneumatic Cylinder',
    tags: 'pneumatic, cylinder, festo',
    body_html: '<p>desc</p>',
    updated_at: '2026-04-30T12:00:00Z',
    image: { src: 'https://cdn.shopify.com/abc.jpg' },
    variants: [
      { id: 411, sku: 'DSNU-20-50-P-A', price: '210.00', inventory_quantity: 5 },
      { id: 412, sku: 'DSNU-20-50-P-B', price: '220.00', inventory_quantity: 0 },
    ],
  };

  it('converts integer id to GID', () => {
    const out = normalizeRestProduct(restPayload);
    expect(out.id).toBe('gid://shopify/Product/8123456789');
  });

  it('splits comma-separated tags', () => {
    const out = normalizeRestProduct(restPayload);
    expect(out.tags).toEqual(['pneumatic', 'cylinder', 'festo']);
  });

  it('derives price range from variants', () => {
    const out = normalizeRestProduct(restPayload);
    expect(out.priceRangeV2.minVariantPrice.amount).toBe('210.00');
    expect(out.priceRangeV2.maxVariantPrice.amount).toBe('220.00');
  });

  it('marks variants available/unavailable from inventory_quantity', () => {
    const out = normalizeRestProduct(restPayload);
    expect(out.variants.nodes[0].availableForSale).toBe(true);
    expect(out.variants.nodes[1].availableForSale).toBe(false);
  });

  it('handles missing image gracefully', () => {
    const out = normalizeRestProduct({ ...restPayload, image: null });
    expect(out.featuredMedia).toBeNull();
  });

  it('handles tags as array (not just string)', () => {
    const out = normalizeRestProduct({ ...restPayload, tags: ['a', 'b'] });
    expect(out.tags).toEqual(['a', 'b']);
  });
});
