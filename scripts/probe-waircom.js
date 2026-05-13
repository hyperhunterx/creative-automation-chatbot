// scripts/probe-waircom.js
// Test the brand=Waircom failure mode.
import 'dotenv/config';
import prisma from '../app/db.server.js';

console.log('=== Q1: Total products in our index ===');
const total = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int AS total FROM products WHERE "deletedAt" IS NULL
`);
console.log(`  total=${total[0].total}  (Shopify shows 146,115)`);

console.log('\n=== Q2: Any row with vendorNormalized="waircom"? ===');
const v = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int AS n
  FROM products
  WHERE "deletedAt" IS NULL AND "vendorNormalized" = 'waircom'
`);
console.log(`  vendor_eq_waircom=${v[0].n}`);

console.log('\n=== Q3: Products whose title contains "WAIRCOM" ===');
const t = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int AS n
  FROM products
  WHERE "deletedAt" IS NULL AND title ILIKE '%waircom%'
`);
console.log(`  title_has_waircom=${t[0].n}`);

console.log('\n=== Q4: Vendor breakdown of those WAIRCOM-titled products ===');
const breakdown = await prisma.$queryRawUnsafe(`
  SELECT "vendorNormalized" AS vendor, count(*)::int AS n
  FROM products
  WHERE "deletedAt" IS NULL AND title ILIKE '%waircom%'
  GROUP BY 1 ORDER BY n DESC LIMIT 10
`);
for (const r of breakdown) console.log(`  ${String(r.n).padStart(6)}  vendor=${r.vendor}`);

console.log('\n=== Q5: 5 sample WAIRCOM 5/2 products (the exact thing user asked for) ===');
const samples = await prisma.$queryRawUnsafe(`
  SELECT id, title, vendor, "vendorNormalized", categories, specs
  FROM products
  WHERE "deletedAt" IS NULL
    AND title ILIKE '%waircom%'
    AND title ILIKE '%5/2%'
  ORDER BY title LIMIT 5
`);
console.log(`  found ${samples.length} matching rows`);
for (const r of samples) {
  console.log(`  - ${r.title}`);
  console.log(`    vendor=${r.vendor} | vendorNormalized=${r.vendorNormalized}`);
  console.log(`    categories=${JSON.stringify(r.categories)}`);
}

console.log('\n=== Q6: Same for MINDMAN — for comparison ===');
const mind = await prisma.$queryRawUnsafe(`
  SELECT "vendorNormalized" AS vendor, count(*)::int AS n
  FROM products
  WHERE "deletedAt" IS NULL AND title ILIKE '%mindman%'
  GROUP BY 1 ORDER BY n DESC LIMIT 5
`);
for (const r of mind) console.log(`  ${String(r.n).padStart(6)}  vendor=${r.vendor}`);

console.log('\n=== Q7: How many distinct vendor strings are in the index? ===');
const vc = await prisma.$queryRawUnsafe(`
  SELECT count(DISTINCT "vendorNormalized")::int AS n
  FROM products WHERE "deletedAt" IS NULL AND "vendorNormalized" IS NOT NULL
`);
console.log(`  distinct_vendors=${vc[0].n}`);

console.log('\n=== Q8: Top 25 vendors ===');
const tv = await prisma.$queryRawUnsafe(`
  SELECT "vendorNormalized" AS vendor, count(*)::int AS n
  FROM products WHERE "deletedAt" IS NULL AND "vendorNormalized" IS NOT NULL
  GROUP BY 1 ORDER BY n DESC LIMIT 25
`);
for (const r of tv) console.log(`  ${String(r.n).padStart(6)}  ${r.vendor}`);

await prisma.$disconnect();
