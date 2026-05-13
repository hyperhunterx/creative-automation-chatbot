// scripts/probe-product-count.js
// Verifies our DB matches Shopify's actual product count, not just the admin UI.
// Uses Shopify Admin GraphQL `productsCount` plus per-vendor sanity samples.

import 'dotenv/config';
import prisma from '../app/db.server.js';

const shop = process.env.SHOPIFY_SHOP_DOMAIN;
const token = process.env.SHOPIFY_ADMIN_TOKEN;
if (!shop || !token) {
  console.error('Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_TOKEN in .env');
  process.exit(1);
}

const endpoint = `https://${shop}/admin/api/2025-01/graphql.json`;
async function gql(query, variables = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

console.log('=== A. Shopify total product count (authoritative) ===');
const totalQ = `{ productsCount { count } }`;
const tr = await gql(totalQ);
if (tr.errors) {
  console.log('  Shopify error:', JSON.stringify(tr.errors));
} else {
  console.log(`  Shopify says: ${tr.data?.productsCount?.count} products total`);
}

console.log('\n=== B. Our DB count ===');
const ours = await prisma.$queryRawUnsafe(`
  SELECT
    count(*)::int AS total,
    count(*) FILTER (WHERE "deletedAt" IS NULL)::int AS active,
    count(*) FILTER (WHERE "deletedAt" IS NOT NULL)::int AS soft_deleted,
    count(*) FILTER (WHERE embedding IS NOT NULL)::int AS with_embedding
  FROM products
`);
console.log(JSON.stringify(ours[0], null, 2));

console.log('\n=== C. Per-vendor sanity — Shopify vs DB for top vendors ===');
const vendors = ['Schmersal', 'SICK', 'Siemens', 'Murr Electronics', 'IFM', 'SMC', 'Creative Automation'];
for (const v of vendors) {
  const q = `query($q: String!) { productsCount(query: $q) { count } }`;
  const r = await gql(q, { q: `vendor:'${v}'` });
  const shopifyN = r.data?.productsCount?.count ?? 'ERR';
  const dbN = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM products WHERE "deletedAt" IS NULL AND vendor = $1`,
    v,
  );
  console.log(`  ${v.padEnd(20)} shopify=${String(shopifyN).padStart(6)}  db=${String(dbN[0].n).padStart(6)}  diff=${shopifyN - dbN[0].n}`);
}

console.log('\n=== D. Sample 3 random Shopify product IDs — are they in our DB? ===');
const sampleQ = `
  query { products(first: 3, sortKey: UPDATED_AT, reverse: true) {
    nodes { id title vendor }
  }}
`;
const sr = await gql(sampleQ);
for (const p of sr.data?.products?.nodes ?? []) {
  const row = await prisma.$queryRawUnsafe(
    `SELECT id FROM products WHERE id = $1`,
    p.id,
  );
  const present = row.length > 0 ? 'YES' : 'MISSING';
  console.log(`  [${present}] ${p.id}  ${p.title.slice(0, 70)} (vendor=${p.vendor})`);
}

await prisma.$disconnect();
