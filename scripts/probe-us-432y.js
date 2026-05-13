// scripts/probe-us-432y.js
// The chatbot returned US 432Y-M20 in turn 1 but said "we don't have it"
// when asked by dimensions in turn 2. Investigate the spec format.

import 'dotenv/config';
import prisma from '../app/db.server.js';
import { hybridSearch } from '../app/services/retrieval.server.js';

console.log('=== Q1: US 432Y-M20 row in our index ===');
const r1 = await prisma.$queryRawUnsafe(`
  SELECT id, title, vendor, "vendorNormalized", categories, specs
  FROM products
  WHERE "deletedAt" IS NULL AND title ILIKE '%US 432Y-M20%'
  LIMIT 3
`);
for (const r of r1) {
  console.log(`- ${r.title}`);
  console.log(`  categories=${JSON.stringify(r.categories)}`);
  console.log(`  specs=${JSON.stringify(r.specs, null, 2)}`);
}

console.log('\n=== Q2: All Schmersal limit switches with Depth=50, Length=62, Width=80 ===');
const r2 = await prisma.$queryRawUnsafe(`
  SELECT id, title, specs->>'depth' AS depth, specs->>'length' AS len, specs->>'width' AS w
  FROM products
  WHERE "deletedAt" IS NULL AND "vendorNormalized" = 'schmersal'
    AND specs->>'depth' ILIKE '%50%'
    AND specs->>'length' ILIKE '%62%'
    AND specs->>'width' ILIKE '%80%'
  LIMIT 10
`);
console.log(`  matches: ${r2.length}`);
for (const r of r2) console.log(`  - ${r.title} | d=${r.depth} l=${r.len} w=${r.w}`);

console.log('\n=== Q3: What are the actual spec keys for Schmersal limit switches? ===');
const r3 = await prisma.$queryRawUnsafe(`
  SELECT k, count(*)::int AS n
  FROM products, jsonb_object_keys(specs) AS k
  WHERE "deletedAt" IS NULL
    AND "vendorNormalized" = 'schmersal'
    AND title ILIKE '%limit switch%'
  GROUP BY 1 ORDER BY n DESC LIMIT 20
`);
for (const r of r3) console.log(`  ${String(r.n).padStart(5)}  ${r.k}`);

console.log('\n=== Q4: hybridSearch with spec_values=["50 mm","62 mm","80 mm"] + brand=schmersal ===');
const vec = new Array(1024).fill(0); vec[0] = 0.5;
const r4 = await hybridSearch({
  category: null,
  brand_include: ['schmersal'],
  brand_exclude: [],
  spec_values: ['50 mm', '62 mm', '80 mm'],
  free_text: 'limit switch 50mm 62mm 80mm',
  query_vector: vec,
});
console.log(`  total=${r4.length}`);
for (const r of r4.slice(0, 5)) console.log(`  - ${r.title}`);

console.log('\n=== Q5: With spec_values=["50","62","80"] (LLM might drop "mm") ===');
const r5 = await hybridSearch({
  category: null,
  brand_include: ['schmersal'],
  brand_exclude: [],
  spec_values: ['50', '62', '80'],
  free_text: 'limit switch',
  query_vector: vec,
});
console.log(`  total=${r5.length}`);
for (const r of r5.slice(0, 5)) console.log(`  - ${r.title}`);

console.log('\n=== Q6: Distinct Depth values in Schmersal limit switches ===');
const r6 = await prisma.$queryRawUnsafe(`
  SELECT specs->>'depth' AS depth, count(*)::int AS n
  FROM products
  WHERE "deletedAt" IS NULL AND "vendorNormalized" = 'schmersal'
    AND title ILIKE '%limit switch%'
    AND specs ? 'depth'
  GROUP BY 1 ORDER BY n DESC LIMIT 10
`);
for (const r of r6) console.log(`  ${String(r.n).padStart(4)}  depth=${r.depth}`);

await prisma.$disconnect();
