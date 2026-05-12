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

// Lowercased + trimmed vendor for SQL filtering. Display code reads the
// original `vendor` field so "Smc"/"Abb" still render in their stored casing.
export function normalizeVendor(vendor) {
  if (!vendor || typeof vendor !== 'string') return null;
  const v = vendor.trim().toLowerCase();
  return v || null;
}

// The catalog has breadcrumb/navigation strings leaked into productType
// ("Home", "Back to results", "Home / X / Y / Z"). Don't trust these as
// categories — we'd only use them if we filtered on productType, which we no
// longer do. Kept here so downstream display can hide junk if it ever wants to.
const PRODUCT_TYPE_JUNK = new Set(['home', 'back to results']);
export function isJunkProductType(t) {
  if (!t || typeof t !== 'string') return true;
  const v = t.trim().toLowerCase();
  if (!v) return true;
  if (PRODUCT_TYPE_JUNK.has(v)) return true;
  if (v.includes(' / ')) return true;
  return false;
}

// Derive a list of canonical categories (lowercase) from a product's tags.
// Drops the brand-redundant variants like "Smc Pneumatic Guided Cylinders"
// when the same tag without the brand prefix is already there. Also drops a
// bare brand-name tag. Vendor is stored separately so brand-in-category is
// pure noise for filtering.
export function deriveCategories(tags, vendor) {
  if (!Array.isArray(tags)) return [];
  const vendorLower = (vendor || '').trim().toLowerCase();
  const out = new Set();
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const lower = t.trim().toLowerCase();
    if (!lower) continue;
    if (vendorLower && (lower === vendorLower || lower.startsWith(vendorLower + ' '))) continue;
    out.add(lower);
  }
  return [...out];
}

export function extractProductRow(shopifyProduct) {
  const p = shopifyProduct;
  const variants = variantsToRows(p.variants);
  // Keep natural casing — description is shown to users in the chat widget.
  const description = stripHtml(p.descriptionHtml || p.description || '');

  // Admin API uses priceRangeV2; Storefront API uses priceRange — same shape.
  const priceRange = p.priceRangeV2 || p.priceRange || null;
  const priceMin = priceRange?.minVariantPrice?.amount ?? null;
  const priceMax = priceRange?.maxVariantPrice?.amount ?? priceMin;
  const currency =
    priceRange?.minVariantPrice?.currencyCode
    || priceRange?.maxVariantPrice?.currencyCode
    || null;

  const productType = p.productType || null;
  const rawTags = Array.isArray(p.tags) ? p.tags : [];
  const vendorNormalized = normalizeVendor(p.vendor);
  const categories = deriveCategories(rawTags, p.vendor);

  // Legacy column kept for backward compat; not used by v6 retrieval filters.
  // Populated with the first derived category so the row still has a useful
  // singular display value if anything downstream reads it.
  const category = categories[0] || (isJunkProductType(productType) ? null : productType);

  // Compose the text we send to the embedder.
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
    vendorNormalized,
    productType,
    category,
    categories,
    tags: rawTags,
    description,
    priceMin,
    priceMax,
    currency,
    imageUrl: pickImageUrl(p),
    available: variants.some(v => v.available),
    specs: {},
    variants,
    shopifyUpdatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : null,
    textForEmbedding,
  };
}
