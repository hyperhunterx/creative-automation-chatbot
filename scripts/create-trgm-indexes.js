// scripts/create-trgm-indexes.js
//
// Adds pg_trgm GIN indexes on products.title and products.description so the
// `ILIKE '%substring%'` clauses in the spec_values filter use an index instead
// of a sequential scan. Before this script, retrieval with spec_values often
// hit 9-20s because every row in the candidate pool had to be string-scanned.
//
// pg_trgm is a Postgres-builtin extension. On Railway's Postgres it ships
// available — CREATE EXTENSION is a no-op if already enabled.
//
// Safety: CREATE INDEX (non-concurrent) takes a SHARE lock — reads stay
// unblocked, only writes pause for the duration. We have no concurrent writers
// to the products table outside of bootstrap/backfill ops, so this is fine.
// IF NOT EXISTS guards make the script idempotent.

import 'dotenv/config';
import prisma from '../app/db.server.js';

const steps = [
  {
    label: 'pg_trgm extension',
    sql: `CREATE EXTENSION IF NOT EXISTS pg_trgm`,
  },
  {
    label: 'products_title_trgm index',
    sql: `CREATE INDEX IF NOT EXISTS products_title_trgm ON products USING gin (title gin_trgm_ops)`,
  },
  {
    label: 'products_description_trgm index',
    sql: `CREATE INDEX IF NOT EXISTS products_description_trgm ON products USING gin (description gin_trgm_ops)`,
  },
  // Expression indexes for the whitespace-stripped, lowercased versions —
  // these match the second branch of the spec_values filter
  // (replace(lower(title), ' ', '') LIKE '%' || replace(lower(v), ' ', '') || '%')
  // so spec queries with format variance (user types "230V", catalog has
  // "230 V") use an index instead of a sequential scan.
  {
    label: 'products_title_nospace_trgm index',
    sql: `CREATE INDEX IF NOT EXISTS products_title_nospace_trgm ON products USING gin (replace(lower(title), ' ', '') gin_trgm_ops)`,
  },
  {
    label: 'products_description_nospace_trgm index',
    sql: `CREATE INDEX IF NOT EXISTS products_description_nospace_trgm ON products USING gin (replace(lower(description), ' ', '') gin_trgm_ops)`,
  },
];

console.log(`=== create-trgm-indexes.js ===\n`);
const t0 = Date.now();
for (const s of steps) {
  const stepStart = Date.now();
  process.stdout.write(`  ${s.label.padEnd(40)} `);
  await prisma.$executeRawUnsafe(s.sql);
  console.log(`done (${((Date.now() - stepStart) / 1000).toFixed(1)}s)`);
}

console.log(`\n=== Verification — confirm both indexes exist ===`);
const idx = await prisma.$queryRawUnsafe(`
  SELECT indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = 'public' AND tablename = 'products' AND indexname LIKE '%trgm%'
  ORDER BY indexname
`);
for (const r of idx) {
  console.log(`  ${r.indexname}`);
  console.log(`    ${r.indexdef}`);
}

console.log(`\n=== Smoke test — measure ILIKE plan + timing on a real spec query ===`);
const tQ = Date.now();
const rows = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int AS n FROM products
  WHERE "deletedAt" IS NULL
    AND (title ILIKE '%inverter drive%' OR description ILIKE '%inverter drive%')
`);
console.log(`  ILIKE '%inverter drive%' matched ${rows[0].n} rows in ${Date.now() - tQ}ms`);

console.log(`\nTotal elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
await prisma.$disconnect();
