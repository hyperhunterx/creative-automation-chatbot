// scripts/probe-spec-keys.js
// What metafield keys are actually in the catalog, and which ones hold "5/2"?
import 'dotenv/config';
import prisma from '../app/db.server.js';

console.log('=== Q1: Top 30 spec keys across the whole catalog ===');
const keys = await prisma.$queryRawUnsafe(`
  SELECT k, count(*)::int AS n
  FROM products, jsonb_object_keys(specs) AS k
  WHERE "deletedAt" IS NULL AND specs <> '{}'::jsonb
  GROUP BY k ORDER BY n DESC LIMIT 30
`);
for (const r of keys) console.log(`  ${String(r.n).padStart(6)}  ${r.k}`);

console.log('\n=== Q2: Spec keys for products whose title contains "solenoid valve" ===');
const sKeys = await prisma.$queryRawUnsafe(`
  SELECT k, count(*)::int AS n
  FROM products, jsonb_object_keys(specs) AS k
  WHERE "deletedAt" IS NULL AND specs <> '{}'::jsonb
    AND title ILIKE '%solenoid valve%'
  GROUP BY k ORDER BY n DESC LIMIT 30
`);
console.log(`(${sKeys.length} distinct keys)`);
for (const r of sKeys) console.log(`  ${String(r.n).padStart(6)}  ${r.k}`);

console.log('\n=== Q3: Any spec value equal to "5/2" anywhere — under which key? ===');
const slash52 = await prisma.$queryRawUnsafe(`
  SELECT k, count(*)::int AS n
  FROM products, jsonb_each_text(specs) AS s(k, v)
  WHERE "deletedAt" IS NULL AND v = '5/2'
  GROUP BY k ORDER BY n DESC LIMIT 20
`);
console.log(`(${slash52.length} keys hold value "5/2")`);
for (const r of slash52) console.log(`  ${String(r.n).padStart(6)}  ${r.k}`);

console.log('\n=== Q4: Any spec value CONTAINING "5/2" (substring) — top keys ===');
const slash52sub = await prisma.$queryRawUnsafe(`
  SELECT k, count(*)::int AS n
  FROM products, jsonb_each_text(specs) AS s(k, v)
  WHERE "deletedAt" IS NULL AND v ILIKE '%5/2%'
  GROUP BY k ORDER BY n DESC LIMIT 20
`);
console.log(`(${slash52sub.length} keys hold a value containing "5/2")`);
for (const r of slash52sub) console.log(`  ${String(r.n).padStart(6)}  ${r.k}`);

console.log('\n=== Q5: Sample 5 products that actually carry a "5/2" anywhere in specs ===');
const sample = await prisma.$queryRawUnsafe(`
  SELECT id, title, vendor, categories, specs
  FROM products
  WHERE "deletedAt" IS NULL
    AND EXISTS (SELECT 1 FROM jsonb_each_text(specs) s WHERE s.value ILIKE '%5/2%')
  ORDER BY random() LIMIT 5
`);
for (const r of sample) {
  console.log(`- ${r.title}`);
  console.log(`  vendor=${r.vendor} | categories=${JSON.stringify(r.categories)}`);
  console.log(`  specs=${JSON.stringify(r.specs)}`);
  console.log('');
}

await prisma.$disconnect();
