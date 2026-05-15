// scripts/probe-ethernet-cable.js
// User: "it's not able to find ethernet cable category" — investigate.

import 'dotenv/config';
import prisma from '../app/db.server.js';

console.log('=== Q1: Distinct categories containing "ethernet" or "network" ===');
const r1 = await prisma.$queryRawUnsafe(`
  SELECT DISTINCT unnest(categories) AS cat
  FROM products WHERE "deletedAt" IS NULL
    AND EXISTS (SELECT 1 FROM unnest(categories) c WHERE c ILIKE '%ethernet%' OR c ILIKE '%network%')
  ORDER BY cat
`);
for (const r of r1) console.log(`  - ${r.cat}`);

console.log('\n=== Q2: Categories containing "cable" or "patch" ===');
const r2 = await prisma.$queryRawUnsafe(`
  SELECT cat, count(*)::int AS n FROM products, unnest(categories) AS cat
  WHERE "deletedAt" IS NULL AND (cat ILIKE '%cable%' OR cat ILIKE '%patch%')
  GROUP BY cat ORDER BY n DESC LIMIT 30
`);
for (const r of r2) console.log(`  ${String(r.n).padStart(5)}  ${r.cat}`);

console.log('\n=== Q3: Products with "ethernet" in title ===');
const r3 = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int AS n FROM products
  WHERE "deletedAt" IS NULL AND title ILIKE '%ethernet%'
`);
console.log(`  count=${r3[0].n}`);

const r3b = await prisma.$queryRawUnsafe(`
  SELECT id, title, vendor, categories
  FROM products WHERE "deletedAt" IS NULL AND title ILIKE '%ethernet%'
  ORDER BY title LIMIT 10
`);
for (const r of r3b) {
  console.log(`  - ${r.title.slice(0, 80)}`);
  console.log(`      vendor=${r.vendor} | categories=${JSON.stringify(r.categories).slice(0, 100)}`);
}

console.log('\n=== Q4: Products with ethernet-y SKU patterns (RJ45 / Cat / patch / network) ===');
const r4 = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int AS n FROM products WHERE "deletedAt" IS NULL
    AND (title ILIKE '%rj45%' OR title ILIKE '%cat5%' OR title ILIKE '%cat6%' OR title ILIKE '%cat 5%' OR title ILIKE '%cat 6%'
         OR title ILIKE '%patch cord%' OR title ILIKE '%network cable%' OR title ILIKE '%lan cable%')
`);
console.log(`  count=${r4[0].n}`);

const r4b = await prisma.$queryRawUnsafe(`
  SELECT title, vendor, categories
  FROM products WHERE "deletedAt" IS NULL
    AND (title ILIKE '%rj45%' OR title ILIKE '%cat5%' OR title ILIKE '%cat6%' OR title ILIKE '%cat 5%' OR title ILIKE '%cat 6%'
         OR title ILIKE '%patch cord%' OR title ILIKE '%network cable%' OR title ILIKE '%lan cable%')
  ORDER BY title LIMIT 10
`);
for (const r of r4b) {
  console.log(`  - ${r.title.slice(0, 80)}`);
  console.log(`      vendor=${r.vendor} | categories=${JSON.stringify(r.categories).slice(0, 100)}`);
}

console.log('\n=== Q5: Top 30 "cables" related categories ===');
const r5 = await prisma.$queryRawUnsafe(`
  SELECT cat, count(*)::int AS n FROM products, unnest(categories) AS cat
  WHERE "deletedAt" IS NULL AND cat ILIKE '%cable%'
  GROUP BY cat ORDER BY n DESC LIMIT 30
`);
for (const r of r5) console.log(`  ${String(r.n).padStart(6)}  ${r.cat}`);

await prisma.$disconnect();
