// scripts/probe-shopify-delta.js
// Count Shopify products updated after our last_indexed timestamp to see
// exactly how stale our index is. Uses a filtered productsCount, which is
// NOT subject to the unfiltered 10,000 cap.

import 'dotenv/config';
import prisma from '../app/db.server.js';

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
  return res.json();
}

const lastIndexed = '2026-05-12T14:37:49Z';

console.log(`=== A. Shopify delta since ${lastIndexed} ===`);
const r1 = await gql(`query { productsCount(query: "updated_at:>${lastIndexed}") { count } }`);
const updatedSinceCount = r1?.data?.productsCount?.count;
console.log(`  Shopify products updated_at > ${lastIndexed}: ${updatedSinceCount}`);

const r2 = await gql(`query { productsCount(query: "created_at:>${lastIndexed}") { count } }`);
const createdSinceCount = r2?.data?.productsCount?.count;
console.log(`  Shopify products created_at > ${lastIndexed}: ${createdSinceCount}  (these are brand new)`);

console.log(`\n=== B. Per-vendor delta for top vendors (case-insensitive DB check) ===`);
const vendors = ['Schmersal', 'SICK', 'Siemens', 'Murr Electronics', 'ifm', 'SMC', 'Pizzato', 'Bonfiglioli'];
for (const v of vendors) {
  const r = await gql(`query { productsCount(query: "vendor:'${v}'") { count } }`);
  const shopifyN = r?.data?.productsCount?.count;
  const dbN = await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM products WHERE "deletedAt" IS NULL AND LOWER(vendor) = LOWER($1)`,
    v,
  );
  const shopifyDisplay = shopifyN === 10000 ? '≥10000 (capped)' : String(shopifyN);
  console.log(`  ${v.padEnd(18)} shopify=${shopifyDisplay.padStart(15)}  db=${String(dbN[0].n).padStart(6)}`);
}

console.log(`\n=== C. Sample 10 most-recently-updated Shopify products — present in DB? ===`);
const r3 = await gql(`
  query {
    products(first: 10, sortKey: UPDATED_AT, reverse: true) {
      nodes { id title vendor updatedAt }
    }
  }
`);
let missing = 0;
for (const p of r3?.data?.products?.nodes ?? []) {
  const row = await prisma.$queryRawUnsafe(`SELECT id FROM products WHERE id = $1`, p.id);
  const present = row.length > 0;
  if (!present) missing++;
  console.log(`  [${present ? '✓' : 'MISSING'}] ${p.updatedAt}  ${p.title.slice(0, 60)} (${p.vendor})`);
}
console.log(`\n  Summary: ${missing}/10 missing from our index`);

console.log(`\n=== D. Sample 10 NEWEST Shopify products by createdAt ===`);
const r4 = await gql(`
  query {
    products(first: 10, sortKey: CREATED_AT, reverse: true) {
      nodes { id title vendor createdAt }
    }
  }
`);
let missing2 = 0;
for (const p of r4?.data?.products?.nodes ?? []) {
  const row = await prisma.$queryRawUnsafe(`SELECT id FROM products WHERE id = $1`, p.id);
  const present = row.length > 0;
  if (!present) missing2++;
  console.log(`  [${present ? '✓' : 'MISSING'}] ${p.createdAt}  ${p.title.slice(0, 60)} (${p.vendor})`);
}
console.log(`\n  Summary: ${missing2}/10 missing from our index`);

await prisma.$disconnect();
