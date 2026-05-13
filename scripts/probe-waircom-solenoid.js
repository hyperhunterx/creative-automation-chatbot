// scripts/probe-waircom-solenoid.js
// Why doesn't "solenoid valve 5/2 waircom" surface the real SOLENOID VALVE
// WAIRCOM products that the website search returns?

import 'dotenv/config';
import prisma from '../app/db.server.js';
import { hybridSearch, findProductsByTitlePattern } from '../app/services/retrieval.server.js';

console.log('=== Q1: Do "SOLENOID VALVE … WAIRCOM" products exist in our index? ===');
const r1 = await prisma.$queryRawUnsafe(`
  SELECT id, title, vendor, "vendorNormalized", "priceMin", categories
  FROM products
  WHERE "deletedAt" IS NULL
    AND title ILIKE '%solenoid valve%'
    AND title ILIKE '%waircom%'
  ORDER BY title
  LIMIT 20
`);
console.log(`  count=${r1.length}`);
for (const r of r1) {
  console.log(`  - ${r.title}`);
  console.log(`      vendor=${r.vendor} | vendorNormalized=${r.vendorNormalized} | price=${r.priceMin}`);
  console.log(`      categories=${JSON.stringify(r.categories)}`);
}

console.log('\n=== Q2: Of those, how many have "5/2" in title? ===');
const r2 = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int AS n FROM products
  WHERE "deletedAt" IS NULL
    AND title ILIKE '%solenoid valve%'
    AND title ILIKE '%waircom%'
    AND title ~ '\\m5/2\\M'
`);
console.log(`  count_with_5_2=${r2[0].n}`);

console.log('\n=== Q3: hybridSearch (real call) — category="solenoid valves" + brand=waircom ===');
const vec = new Array(1024).fill(0); vec[0] = 0.5;
const r3 = await hybridSearch({
  category: 'solenoid valves',
  brand_include: ['waircom'],
  brand_exclude: [],
  spec_values: ['5/2'],
  free_text: 'solenoid valve 5/2 waircom',
  query_vector: vec,
});
console.log(`  total=${r3.length}`);
for (const r of r3.slice(0, 10)) {
  console.log(`  - ${r.title.slice(0, 80)}`);
}

console.log('\n=== Q4: hybridSearch with category=null (relax) + brand=waircom ===');
const r4 = await hybridSearch({
  category: null,
  brand_include: ['waircom'],
  brand_exclude: [],
  spec_values: ['5/2'],
  free_text: 'solenoid valve 5/2 waircom',
  query_vector: vec,
});
console.log(`  total=${r4.length}`);
// Tally by title prefix (Solenoid vs Pilot vs Hand vs Popet)
const prefixes = {};
for (const r of r4) {
  const p = r.title.split(/\s/)[0];
  prefixes[p] = (prefixes[p] || 0) + 1;
}
console.log(`  title-prefix breakdown:`);
for (const [p, n] of Object.entries(prefixes).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(3)}  ${p}`);
}

console.log('\n=== Q5: findProductsByTitlePattern(["5/2"]) with brand=waircom ===');
const r5 = await findProductsByTitlePattern(['5/2'], {
  category: null,
  brand_include: ['waircom'],
  brand_exclude: [],
  limit: 50,
});
console.log(`  total=${r5.length}`);
const p5 = {};
for (const r of r5) {
  const p = r.title.split(/\s/)[0];
  p5[p] = (p5[p] || 0) + 1;
}
for (const [p, n] of Object.entries(p5).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(3)}  ${p}`);
}

console.log('\n=== Q6: spec_values JSONB filter — does it kill the solenoid ones? ===');
const r6 = await prisma.$queryRawUnsafe(`
  SELECT id, title, specs
  FROM products
  WHERE "deletedAt" IS NULL
    AND title ILIKE '%solenoid valve%'
    AND title ILIKE '%waircom%'
    AND title ~ '\\m5/2\\M'
  LIMIT 5
`);
for (const r of r6) {
  console.log(`  - ${r.title.slice(0, 80)}`);
  console.log(`    specs=${JSON.stringify(r.specs)}`);
}

console.log('\n=== Q7: Specs containment check for those rows ===');
const r7 = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int AS n FROM products
  WHERE "deletedAt" IS NULL
    AND title ILIKE '%solenoid valve%'
    AND title ILIKE '%waircom%'
    AND title ~ '\\m5/2\\M'
    AND NOT EXISTS (
      SELECT 1 FROM unnest(ARRAY['5/2']::text[]) AS required(v)
      WHERE NOT EXISTS (
        SELECT 1 FROM jsonb_each_text(specs) AS s
        WHERE lower(s.value) = lower(required.v)
      )
    )
`);
console.log(`  pass_spec_filter=${r7[0].n}  (this is what hybridSearch would keep)`);

await prisma.$disconnect();
