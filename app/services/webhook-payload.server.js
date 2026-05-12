// app/services/webhook-payload.server.js
//
// Normalize Shopify REST webhook payloads into the GraphQL-like shape the
// product extractor expects. Extracted to its own module so it can be
// unit-tested without dragging in route-level imports.

export function normalizeRestProduct(p) {
  return {
    id: `gid://shopify/Product/${p.id}`,
    handle: p.handle,
    title: p.title,
    vendor: p.vendor,
    productType: p.product_type,
    tags: typeof p.tags === 'string'
      ? p.tags.split(',').map(s => s.trim()).filter(Boolean)
      : (p.tags || []),
    descriptionHtml: p.body_html,
    updatedAt: p.updated_at,
    featuredMedia: p.image?.src
      ? { preview: { image: { url: p.image.src } } }
      : null,
    priceRangeV2: deriveRestPriceRange(p),
    variants: {
      nodes: (p.variants || []).map(v => ({
        id: `gid://shopify/ProductVariant/${v.id}`,
        sku: v.sku,
        price: v.price,
        availableForSale: v.inventory_quantity == null ? true : v.inventory_quantity > 0,
      })),
    },
  };
}

function deriveRestPriceRange(p) {
  const prices = (p.variants || [])
    .map(v => parseFloat(v.price))
    .filter(n => !Number.isNaN(n));
  if (prices.length === 0) return null;
  const min = Math.min(...prices).toFixed(2);
  const max = Math.max(...prices).toFixed(2);
  const currency = p.variants?.[0]?.currency || 'AED';
  return {
    minVariantPrice: { amount: min, currencyCode: currency },
    maxVariantPrice: { amount: max, currencyCode: currency },
  };
}
