import { describe, it, expect } from 'vitest';
import fixture from '../fixtures/shopify-product.json' with { type: 'json' };
import {
  extractProductRow,
  stripHtml,
  normalizeVendor,
  deriveCategories,
  isJunkProductType,
  flattenMetafields,
} from '../../app/services/product-extractor.server.js';

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

describe('normalizeVendor', () => {
  it('lowercases and trims', () => {
    expect(normalizeVendor('  Smc  ')).toBe('smc');
    expect(normalizeVendor('ABB')).toBe('abb');
    expect(normalizeVendor('SICK')).toBe('sick');
    expect(normalizeVendor('Phoenix-contact')).toBe('phoenix-contact');
  });
  it('returns null for empty / non-string', () => {
    expect(normalizeVendor(null)).toBeNull();
    expect(normalizeVendor('')).toBeNull();
    expect(normalizeVendor('   ')).toBeNull();
    expect(normalizeVendor(42)).toBeNull();
  });
});

describe('isJunkProductType', () => {
  it('flags breadcrumb-style values', () => {
    expect(isJunkProductType('Home')).toBe(true);
    expect(isJunkProductType('Back to results')).toBe(true);
    expect(isJunkProductType('Home / Electronic Components / Antennas')).toBe(true);
  });
  it('accepts real productTypes', () => {
    expect(isJunkProductType('Pneumatic Cylinder')).toBe(false);
    expect(isJunkProductType('Electrical, Automation & Cables')).toBe(false);
  });
  it('flags empty/null', () => {
    expect(isJunkProductType(null)).toBe(true);
    expect(isJunkProductType('')).toBe(true);
    expect(isJunkProductType('   ')).toBe(true);
  });
});

describe('deriveCategories', () => {
  it('lowercases all tags', () => {
    const cats = deriveCategories(['Pneumatic Cylinders', 'ISO-6432'], null);
    expect(cats).toEqual(['pneumatic cylinders', 'iso-6432']);
  });
  it('strips brand-prefixed redundant tags', () => {
    const cats = deriveCategories(
      ['Smc Pneumatic Guided Cylinders', 'Pneumatic Guided Cylinders', 'Pneumatics & Hydraulics'],
      'Smc'
    );
    expect(cats).toEqual(['pneumatic guided cylinders', 'pneumatics & hydraulics']);
  });
  it('strips a bare brand-name tag', () => {
    const cats = deriveCategories(['pneumatic', 'cylinder', 'festo'], 'Festo');
    expect(cats).toEqual(['pneumatic', 'cylinder']);
  });
  it('dedupes', () => {
    const cats = deriveCategories(['Sensors', 'sensors', 'SENSORS'], 'SICK');
    expect(cats).toEqual(['sensors']);
  });
  it('returns empty array for non-array input', () => {
    expect(deriveCategories(null, 'Smc')).toEqual([]);
    expect(deriveCategories(undefined, 'Smc')).toEqual([]);
  });
  it('matches case-insensitively against the vendor', () => {
    // Real catalog: vendor "Smc" but brand-prefixed tag "Smc Pneumatic ..." —
    // also test the reverse with "ABB" / "Abb Inverter Drives"
    const cats = deriveCategories(['Abb Inverter Drives', 'Inverter Drives'], 'ABB');
    expect(cats).toEqual(['inverter drives']);
  });
});

describe('flattenMetafields', () => {
  it('flattens metafield nodes into a plain key/value object', () => {
    const product = {
      metafields: {
        nodes: [
          { namespace: 'specs', key: 'Type', value: '5/2', type: 'single_line_text_field' },
          { namespace: 'specs', key: 'Series', value: 'DSNU', type: 'single_line_text_field' },
        ],
      },
    };
    expect(flattenMetafields(product)).toEqual({ Type: '5/2', Series: 'DSNU' });
  });
  it('skips reference-type metafields (GIDs are useless for filtering)', () => {
    const product = {
      metafields: {
        nodes: [
          { namespace: 'specs', key: 'Body Material', value: 'Aluminum', type: 'single_line_text_field' },
          { namespace: 'specs', key: 'Featured Image', value: 'gid://shopify/MediaImage/1', type: 'file_reference' },
          { namespace: 'specs', key: 'Datasheet', value: 'gid://shopify/Metaobject/2', type: 'metaobject_reference' },
        ],
      },
    };
    expect(flattenMetafields(product)).toEqual({ 'Body Material': 'Aluminum' });
  });
  it('skips empty / null values', () => {
    const product = {
      metafields: {
        nodes: [
          { namespace: 'specs', key: 'A', value: 'x' },
          { namespace: 'specs', key: 'B', value: '' },
          { namespace: 'specs', key: 'C', value: null },
        ],
      },
    };
    expect(flattenMetafields(product)).toEqual({ A: 'x' });
  });
  it('returns empty object when product has no metafields', () => {
    expect(flattenMetafields({})).toEqual({});
    expect(flattenMetafields(null)).toEqual({});
  });
});

describe('extractProductRow', () => {
  it('extracts core fields from a Shopify GraphQL product', () => {
    const row = extractProductRow(fixture);
    expect(row.id).toBe('gid://shopify/Product/8123456789');
    expect(row.handle).toBe('festo-dsnu-20-50-p-a');
    expect(row.vendor).toBe('Festo');
    expect(row.productType).toBe('Pneumatic Cylinder');
    expect(row.tags).toEqual(['pneumatic', 'cylinder', 'ISO-6432', 'festo']);
    expect(row.priceMin).toBe('210.00');
    expect(row.priceMax).toBe('210.00');
    expect(row.currency).toBe('AED');
    expect(row.imageUrl).toBe('https://cdn.shopify.com/.../dsnu-20-50.jpg');
    expect(row.shopifyUpdatedAt).toBe('2026-04-30T12:00:00.000Z');
  });

  it('populates vendorNormalized (lowercased)', () => {
    const row = extractProductRow(fixture);
    expect(row.vendorNormalized).toBe('festo');
  });

  it('populates categories from tags, stripping brand-name tag', () => {
    const row = extractProductRow(fixture);
    expect(row.categories).toEqual(['pneumatic', 'cylinder', 'iso-6432']);
  });

  it('legacy `category` falls back to first derived category', () => {
    const row = extractProductRow(fixture);
    expect(row.category).toBe('pneumatic');
  });

  it('strips HTML from description', () => {
    const row = extractProductRow(fixture);
    expect(row.description).not.toContain('<p>');
    expect(row.description).toContain('Bore 20mm');
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

  it('handles Storefront API priceRange shape (no V2 suffix)', () => {
    const storefrontShaped = JSON.parse(JSON.stringify(fixture));
    delete storefrontShaped.priceRangeV2;
    storefrontShaped.priceRange = {
      minVariantPrice: { amount: '99.50', currencyCode: 'AED' },
      maxVariantPrice: { amount: '129.99', currencyCode: 'AED' },
    };
    const row = extractProductRow(storefrontShaped);
    expect(row.priceMin).toBe('99.50');
    expect(row.priceMax).toBe('129.99');
    expect(row.currency).toBe('AED');
  });

  it('populates specs from metafield nodes (drops reference types)', () => {
    const row = extractProductRow(fixture);
    expect(row.specs).toEqual({
      Type: '5/2',
      Series: 'DSNU',
      'Country of Origin': 'Germany',
      'Body Material': 'Aluminum',
    });
    expect(row.specs).not.toHaveProperty('Featured Image');
  });

  it('handles real-catalog-shape product (Smc cylinder with brand-prefixed tags)', () => {
    const real = {
      id: 'gid://shopify/Product/9000000001',
      handle: 'smc-mxz20-20',
      title: 'MXZ20-20 - Smc Double Pneumatic Guided Cylinder, 20 mm Bore x 20 mm Stroke',
      vendor: 'Smc',
      productType: 'Mechanical Fluid Power & Tools',
      tags: [
        'Pneumatic Cylinders & Actuators',
        'Pneumatic Guided Cylinders',
        'Pneumatics & Hydraulics',
        'Smc Pneumatic Guided Cylinders',
      ],
      descriptionHtml: '<p>MXZ series guided cylinder.</p>',
      priceRangeV2: {
        minVariantPrice: { amount: '350.00', currencyCode: 'AED' },
        maxVariantPrice: { amount: '350.00', currencyCode: 'AED' },
      },
      variants: { nodes: [{ id: 'gid://x/1', sku: 'MXZ20-20', price: '350.00', availableForSale: true }] },
      updatedAt: '2026-05-01T00:00:00Z',
    };
    const row = extractProductRow(real);
    expect(row.vendor).toBe('Smc');
    expect(row.vendorNormalized).toBe('smc');
    expect(row.categories).toEqual([
      'pneumatic cylinders & actuators',
      'pneumatic guided cylinders',
      'pneumatics & hydraulics',
    ]);
    expect(row.categories).not.toContain('smc pneumatic guided cylinders');
  });
});
