// scripts/diagnose-catalog-shape.js
// Lightweight catalog-shape queries: total count, all vendors, all productTypes.
// No embedder, no extraction — pure Shopify Admin GraphQL.

import 'dotenv/config';

const shop = process.env.SHOPIFY_SHOP_DOMAIN;
const token = process.env.SHOPIFY_ADMIN_TOKEN;
if (!shop || !token) {
  console.error('Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_TOKEN');
  process.exit(1);
}

const endpoint = `https://${shop}/admin/api/2025-01/graphql.json`;

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

// 1) Total product count
const countQuery = `{ productsCount { count } }`;
const countData = await gql(countQuery).catch(() => null);
if (countData?.productsCount) {
  console.log(`Total products in store: ${countData.productsCount.count.toLocaleString()}`);
} else {
  console.log('productsCount field unavailable on this API version. Skipping.');
}

// 2) All distinct vendors (paginated)
console.log(`\nFetching distinct vendors...`);
let vendors = new Set();
let after = null;
while (true) {
  const data = await gql(
    `query($after: String) { productVendors(first: 250, after: $after) { edges { node cursor } pageInfo { hasNextPage endCursor } } }`,
    { after }
  );
  for (const e of data.productVendors.edges) vendors.add(e.node);
  if (!data.productVendors.pageInfo.hasNextPage) break;
  after = data.productVendors.pageInfo.endCursor;
}
console.log(`Distinct vendors: ${vendors.size}`);
const vendorList = [...vendors].sort();
console.log(vendorList.slice(0, 50).map(v => `  - ${v}`).join('\n'));
if (vendorList.length > 50) console.log(`  ... and ${vendorList.length - 50} more`);

// 3) All distinct productTypes
console.log(`\nFetching distinct productTypes...`);
let types = new Set();
after = null;
while (true) {
  const data = await gql(
    `query($after: String) { productTypes(first: 250, after: $after) { edges { node cursor } pageInfo { hasNextPage endCursor } } }`,
    { after }
  );
  for (const e of data.productTypes.edges) types.add(e.node);
  if (!data.productTypes.pageInfo.hasNextPage) break;
  after = data.productTypes.pageInfo.endCursor;
}
console.log(`Distinct productTypes: ${types.size}`);
const typeList = [...types].filter(Boolean).sort();
console.log(typeList.slice(0, 50).map(t => `  - ${t}`).join('\n'));
if (typeList.length > 50) console.log(`  ... and ${typeList.length - 50} more`);

// 4) Spot check — try to find any Festo, SMC, Siemens product
console.log(`\nSpot-checking for known brands:`);
for (const brand of ['Festo', 'SMC', 'Siemens', 'Schneider', 'Omron', 'Pneumatic Cylinder']) {
  const data = await gql(
    `query($q: String!) { products(first: 1, query: $q) { nodes { id title vendor productType } } }`,
    { q: brand.startsWith('Pneumatic') ? `product_type:"${brand}"` : `vendor:"${brand}"` }
  );
  const hit = data.products.nodes[0];
  console.log(`  ${brand.padEnd(20)} ${hit ? `✓ found: "${hit.title}" (vendor=${hit.vendor}, type=${hit.productType})` : '✗ none'}`);
}
