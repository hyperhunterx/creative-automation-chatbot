// app/services/product-extractor.server.js

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
  '&deg;': '°',
  '&micro;': 'µ',
  '&plusmn;': '±',
  '&times;': '×',
  '&le;': '≤',
  '&ge;': '≥',
  '&hellip;': '…',
  '&mdash;': '—',
  '&ndash;': '–',
  '&rarr;': '→',
  '&larr;': '←',
  '&uarr;': '↑',
  '&darr;': '↓',
  '&ldquo;': '"',
  '&rdquo;': '"',
  '&lsquo;': "'",
  '&rsquo;': "'",
  '&bull;': '•',
  '&middot;': '·',
  '&sup2;': '²',
  '&sup3;': '³',
};

function decodeEntities(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&[a-z#0-9]+;/gi, m => ENTITIES[m] ?? m)
    // Numeric entities like &#176; or &#x00B5;
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Normalize a parsed key from a `<strong>KEY:</strong>` blob entry into the
// snake_case convention the Shopify metafields use (matches keys like
// "supply_voltage", "ip_rating", "minimum_operating_temperature"). Trims, drops
// trailing colons, lowercases, replaces non-alphanumeric runs with a single
// underscore, and collapses leading/trailing underscores.
export function normalizeSpecKey(rawKey) {
  if (typeof rawKey !== 'string') return null;
  let k = decodeEntities(rawKey).trim();
  if (!k) return null;
  if (k.endsWith(':')) k = k.slice(0, -1);
  k = k.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return k || null;
}

// Parses the Creative Automation `product_specification` HTML blob into a
// flat key/value object.
//
// The catalog stores rich specs as HTML inside a single `product_specification`
// metafield. Across 138,526 products (97% of the catalog), the shape is:
//   <table>... <li><strong>Key:</strong> Value</li> <li>...</li> ...</table>
// A second variant (3,523 products) is `<div><ul><li>free text</li>...</ul></div>`
// with no kv structure — parser returns {} for those, and we leave them alone.
//
// Returned keys are snake_cased (so "Cable Length" → "cable_length"). Values
// are HTML-stripped, entity-decoded, and trimmed but otherwise preserved
// verbatim ("≤ 6,000 min⁻¹", "+80°C", "10...30 DC", "IP65; IP67; IP68").
export function parseSpecBlob(blob) {
  if (typeof blob !== 'string' || !blob.trim()) return {};
  const out = {};
  // Capture every `<li>...</li>` block. A handful of Schmersal blobs omit the
  // closing `</li>` (the next `<li>` opens directly). Use a lookahead boundary
  // — match content up to `</li>` OR the next `<li>` OR end-of-string — so we
  // stop at the right place without consuming the boundary marker, letting the
  // next iteration pick up the following item cleanly.
  const liRe = /<li\b[^>]*>([\s\S]*?)(?=<\/li>|<li\b|$)/gi;
  // Inside each `<li>`, find a `<strong>KEY:</strong>` (or `<b>` as a fallback)
  // followed by the value text up to the close of the `<li>` block.
  const kvRe = /<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>([\s\S]*)/i;
  let m;
  while ((m = liRe.exec(blob)) !== null) {
    const inner = m[1];
    const kv = inner.match(kvRe);
    if (!kv) continue;
    const key = normalizeSpecKey(stripHtml(kv[1]));
    if (!key) continue;
    let value = stripHtml(kv[2]).replace(/^[:\s]+/, '').trim();
    if (!value) continue;
    out[key] = value;
  }
  return out;
}

export function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  const tagsStripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(tagsStripped).replace(/\s+/g, ' ').trim();
}

function pickImageUrl(p) {
  const featured = p?.featuredMedia?.preview?.image?.url;
  if (featured) return featured;
  const first = p?.images?.nodes?.[0]?.url || p?.featuredImage?.url;
  return first || null;
}

// Shopify metafield types we treat as plain key/value pairs for filtering
// and display. Skip reference-style types (`*_reference`, `file_reference`,
// `metaobject_reference`, etc.) — those resolve to GIDs that aren't useful
// for direct catalog search.
const METAFIELD_REFERENCE_RE = /reference/i;

export function flattenMetafields(product) {
  const nodes = product?.metafields?.nodes;
  if (!Array.isArray(nodes)) return {};
  const out = {};
  for (const m of nodes) {
    if (!m || typeof m.key !== 'string' || !m.key.trim()) continue;
    if (m.value == null || m.value === '') continue;
    if (typeof m.type === 'string' && METAFIELD_REFERENCE_RE.test(m.type)) continue;
    // Use the bare key (no namespace prefix) — the catalog conventionally
    // uses a single namespace per product type, and the keys (Type, Series,
    // Supply Voltage, etc.) are already distinctive enough.
    out[m.key] = String(m.value);
  }
  // The `product_specification` metafield is an HTML blob containing the rich
  // key/value spec table the website renders on product pages (Depth, Length,
  // Width, Actuator Type, IP Rating, ...). Parse it into individual normalized
  // keys so retrieval can match dimensional / spec queries directly. Existing
  // structured metafields take precedence over the parsed values to preserve
  // canonical Shopify data when both sources happen to carry the same key.
  const blob = out.product_specification;
  if (typeof blob === 'string' && blob) {
    const parsed = parseSpecBlob(blob);
    for (const [k, v] of Object.entries(parsed)) {
      if (out[k] == null || out[k] === '') out[k] = v;
    }
  }
  return out;
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
    specs: flattenMetafields(p),
    variants,
    shopifyUpdatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString() : null,
    textForEmbedding,
  };
}
