// app/services/product-extractor.server.js

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

export function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, m => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

function pickImageUrl(p) {
  const featured = p?.featuredMedia?.preview?.image?.url;
  if (featured) return featured;
  const first = p?.images?.nodes?.[0]?.url || p?.featuredImage?.url;
  return first || null;
}

function variantsToRows(variantsField) {
  const nodes = variantsField?.nodes
    || (Array.isArray(variantsField) ? variantsField : null)
    || variantsField?.edges?.map(e => e.node)
    || [];
  return nodes.map(v => ({
    id: v.id,
    sku: v.sku || null,
    price: v.price?.amount ?? v.price ?? null,
    available: Boolean(v.availableForSale ?? v.available ?? true),
  }));
}

export function extractProductRow(shopifyProduct) {
  const p = shopifyProduct;
  const variants = variantsToRows(p.variants);
  const description = stripHtml(p.descriptionHtml || p.description || '').toLowerCase();

  const priceMin = p.priceRangeV2?.minVariantPrice?.amount ?? null;
  const priceMax = p.priceRangeV2?.maxVariantPrice?.amount ?? priceMin;
  const currency =
    p.priceRangeV2?.minVariantPrice?.currencyCode
    || p.priceRangeV2?.maxVariantPrice?.currencyCode
    || null;

  const productType = p.productType || null;

  // For v1 we treat productType as the normalized category. A future task
  // can map productType to canonical category via a lookup table.
  const category = productType;

  // Compose the text we send to the embedder. Order matters for the model:
  // title and brand first (most weight), then category, then SKUs, then desc.
  const skuLine = variants.map(v => v.sku).filter(Boolean).join(' ');
  const textForEmbedding = [
    p.title || '',
    p.vendor || '',
    productType || '',
    skuLine,
    description,
  ]
    .filter(Boolean)
    .join('. ');

  return {
    id: p.id,
    handle: p.handle,
    title: p.title || 'Untitled Product',
    vendor: p.vendor || null,
    productType,
    category,
    tags: Array.isArray(p.tags) ? p.tags : [],
    description,
    priceMin,
    priceMax,
    currency,
    imageUrl: pickImageUrl(p),
    available: variants.some(v => v.available),
    specs: {},                 // Phase 1.1 will populate
    variants,
    shopifyUpdatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : null,
    textForEmbedding,
  };
}
