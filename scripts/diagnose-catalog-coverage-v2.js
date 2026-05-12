// scripts/diagnose-catalog-coverage-v2.js
// Sample products from the REAL branded catalog by:
//   1. Sorting id-DESC (newest first) — skips the house-brand bulk-imports
//   2. Spot-checking specific known-brand vendor queries
// Then compute the same coverage stats as v1.

import 'dotenv/config';
import { extractProductRow } from '../app/services/product-extractor.server.js';

const shop = process.env.SHOPIFY_SHOP_DOMAIN;
const token = process.env.SHOPIFY_ADMIN_TOKEN;
const endpoint = `https://${shop}/admin/api/2025-01/graphql.json`;
const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE || 500);

const FIELDS = `
  id handle title vendor productType tags descriptionHtml updatedAt
  featuredMedia { preview { image { url } } }
  priceRangeV2 {
    minVariantPrice { amount currencyCode }
    maxVariantPrice { amount currencyCode }
  }
  variants(first: 50) { nodes { id sku price availableForSale } }
`;

async function gql(query, variables = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function fetchN(n, { sortKey = 'ID', reverse = true, query = null } = {}) {
  const rows = [];
  let after = null;
  while (rows.length < n) {
    const data = await gql(
      `query($first: Int!, $after: String, $sortKey: ProductSortKeys, $reverse: Boolean, $query: String) {
        products(first: $first, after: $after, sortKey: $sortKey, reverse: $reverse, query: $query) {
          nodes { ${FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { first: Math.min(250, n - rows.length), after, sortKey, reverse, query }
    );
    for (const p of data.products.nodes) rows.push(extractProductRow(p));
    if (!data.products.pageInfo.hasNextPage) break;
    after = data.products.pageInfo.endCursor;
  }
  return rows;
}

function report(label, rows) {
  if (!rows.length) {
    console.log(`\n=== ${label}: 0 products ===`);
    return;
  }
  const has = pred => rows.filter(pred).length;
  const pct = n => `${((n / rows.length) * 100).toFixed(1)}%`;
  console.log(`\n=== ${label} (n=${rows.length}) ===`);
  console.log(`  vendor:                 ${pct(has(r => r.vendor))}`);
  console.log(`  productType:            ${pct(has(r => r.productType))}`);
  console.log(`  tags (>=1):             ${pct(has(r => r.tags.length > 0))}`);
  console.log(`  description (>20 char): ${pct(has(r => r.description.length > 20))}`);
  console.log(`  price:                  ${pct(has(r => r.priceMin))}`);
  console.log(`  variants with sku:      ${pct(has(r => r.variants.some(v => v.sku)))}`);

  const byVendor = new Map();
  const byType = new Map();
  for (const r of rows) {
    byVendor.set(r.vendor || '(none)', (byVendor.get(r.vendor || '(none)') || 0) + 1);
    byType.set(r.productType || '(null)', (byType.get(r.productType || '(null)') || 0) + 1);
  }
  console.log(`  distinct vendors:       ${byVendor.size}`);
  console.log(`  distinct productTypes:  ${byType.size}`);

  const topVendors = [...byVendor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`  top vendors:`);
  for (const [v, c] of topVendors) console.log(`    ${v.padEnd(30)} ${c}`);

  const topTypes = [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`  top productTypes:`);
  for (const [t, c] of topTypes) console.log(`    ${t.padEnd(60)} ${c}`);

  // Show 2 example titles + embed-text from the sample
  console.log(`  examples:`);
  for (const r of rows.slice(0, 2)) {
    console.log(`    - title: "${r.title}"`);
    console.log(`      vendor=${r.vendor}, type=${r.productType}, tags=${JSON.stringify(r.tags.slice(0, 4))}`);
    console.log(`      embed: "${r.textForEmbedding.slice(0, 200)}${r.textForEmbedding.length > 200 ? '...' : ''}"`);
  }
}

console.log(`Sampling ${SAMPLE_SIZE} newest products (id-DESC) — where the real branded catalog lives...`);
const newest = await fetchN(SAMPLE_SIZE, { sortKey: 'ID', reverse: true });
report('Newest 500 (id-DESC)', newest);

console.log(`\nSpot-checking known supplier brands...`);
for (const brand of ['Schmersal', 'SMC', 'Siemens', 'Omron', 'Belimo', 'ABB']) {
  const sample = await fetchN(50, { query: `vendor:"${brand}"` });
  report(`vendor:"${brand}"`, sample);
}
