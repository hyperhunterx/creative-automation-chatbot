// scripts/probe-solenoid-5-2.js
// Diagnoses why "solenoid valve 5/2" fell back to hybrid_category_relaxed.

import 'dotenv/config';
import prisma from '../app/db.server.js';

console.log('=== Q1: Real WAIRCOM 5/2 solenoid valves in the index? ===');
const q1 = await prisma.$queryRawUnsafe(`
  SELECT id, title, vendor, "vendorNormalized", categories, specs
  FROM products
  WHERE "deletedAt" IS NULL
    AND title ILIKE '%solenoid valve%5/2%'
  ORDER BY title
  LIMIT 15
`);
console.log(`Rows: ${q1.length}\n`);
for (const r of q1) {
  console.log(`- ${r.title}`);
  console.log(`  vendor=${r.vendor} | vendorNormalized=${r.vendorNormalized}`);
  console.log(`  categories=${JSON.stringify(r.categories)}`);
  console.log(`  specs=${JSON.stringify(r.specs)}`);
  console.log('');
}

console.log('=== Q2: Categories used by all products with "solenoid valve" in title ===');
const q2 = await prisma.$queryRawUnsafe(`
  SELECT cat, count(*)::int AS n
  FROM products, unnest(categories) AS cat
  WHERE "deletedAt" IS NULL
    AND title ILIKE '%solenoid valve%'
  GROUP BY cat
  ORDER BY n DESC
  LIMIT 25
`);
for (const r of q2) console.log(`  ${String(r.n).padStart(5)}  ${r.cat}`);

console.log('\n=== Q3: Total products whose title contains "solenoid valve" ===');
const q3 = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int AS total
  FROM products
  WHERE "deletedAt" IS NULL AND title ILIKE '%solenoid valve%'
`);
console.log(`  total=${q3[0].total}`);

console.log('\n=== Q4: Of those, how many have categories containing "solenoid"? ===');
const q4 = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int AS n
  FROM products
  WHERE "deletedAt" IS NULL
    AND title ILIKE '%solenoid valve%'
    AND EXISTS (SELECT 1 FROM unnest(categories) c WHERE c ILIKE '%solenoid%')
`);
console.log(`  with_solenoid_in_categories=${q4[0].n}`);

console.log('\n=== Q5: Spec coverage on solenoid-valve titled products ===');
const q5 = await prisma.$queryRawUnsafe(`
  SELECT
    count(*)::int AS total,
    count(*) FILTER (WHERE specs IS NOT NULL AND specs <> '{}'::jsonb)::int AS with_specs,
    count(*) FILTER (WHERE specs ? 'Type')::int AS with_type,
    count(*) FILTER (WHERE specs->>'Type' = '5/2')::int AS type_eq_5_2
  FROM products
  WHERE "deletedAt" IS NULL AND title ILIKE '%solenoid valve%'
`);
console.log(JSON.stringify(q5[0], null, 2));

console.log('\n=== Q6: Sample of products where specs.Type = "5/2" ===');
const q6 = await prisma.$queryRawUnsafe(`
  SELECT id, title, vendor, categories, specs->>'Type' AS spec_type
  FROM products
  WHERE "deletedAt" IS NULL AND specs->>'Type' = '5/2'
  ORDER BY random()
  LIMIT 10
`);
for (const r of q6) {
  console.log(`- ${r.title}`);
  console.log(`  vendor=${r.vendor} | categories=${JSON.stringify(r.categories)} | Type=${r.spec_type}`);
}

await prisma.$disconnect();
