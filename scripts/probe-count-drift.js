// scripts/probe-count-drift.js
// User reports seeing ~123k records (earlier was ~146k). Investigate:
//   - current DB count broken down by deletedAt / embedding / specs presence
//   - per-vendor counts to see if specific vendors disappeared
//   - recent updates (Shopify shopifyUpdatedAt vs our indexedAt)

import 'dotenv/config';
import prisma from '../app/db.server.js';

console.log('=== Q1: Total counts ===');
const q1 = await prisma.$queryRawUnsafe(`
  SELECT
    count(*)::int                                                        AS rows_total,
    count(*) FILTER (WHERE "deletedAt" IS NULL)::int                     AS active,
    count(*) FILTER (WHERE "deletedAt" IS NOT NULL)::int                 AS soft_deleted,
    count(*) FILTER (WHERE embedding IS NOT NULL)::int                   AS with_embedding,
    count(*) FILTER (WHERE specs <> '{}'::jsonb)::int                    AS with_any_specs,
    count(*) FILTER (WHERE specs ? 'product_specification')::int         AS with_blob,
    count(DISTINCT "vendorNormalized")::int                              AS distinct_vendors
  FROM products
`);
console.log(JSON.stringify(q1[0], null, 2));

console.log('\n=== Q2: Soft-deleted breakdown (when, by vendor) ===');
const q2 = await prisma.$queryRawUnsafe(`
  SELECT
    date_trunc('day', "deletedAt")::date AS day,
    count(*)::int AS n
  FROM products WHERE "deletedAt" IS NOT NULL
  GROUP BY 1 ORDER BY 1 DESC LIMIT 14
`);
for (const r of q2) console.log(`  ${r.day.toISOString().slice(0,10)}  deletions=${r.n}`);

const q2b = await prisma.$queryRawUnsafe(`
  SELECT "vendorNormalized" AS vendor, count(*)::int AS n
  FROM products WHERE "deletedAt" IS NOT NULL
  GROUP BY 1 ORDER BY n DESC LIMIT 15
`);
console.log('\n  Top vendors with soft-deletes:');
for (const r of q2b) console.log(`    ${String(r.n).padStart(6)}  ${r.vendor}`);

console.log('\n=== Q3: Recent Shopify updates (rows where shopifyUpdatedAt > our indexedAt) ===');
const q3 = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int AS n
  FROM products WHERE "deletedAt" IS NULL
    AND "shopifyUpdatedAt" IS NOT NULL
    AND "indexedAt" IS NOT NULL
    AND "shopifyUpdatedAt" > "indexedAt"
`);
console.log(`  stale_rows (Shopify newer than our index) = ${q3[0].n}`);

console.log('\n=== Q4: Top 15 active-row vendors right now ===');
const q4 = await prisma.$queryRawUnsafe(`
  SELECT "vendorNormalized" AS vendor, count(*)::int AS n
  FROM products WHERE "deletedAt" IS NULL AND "vendorNormalized" IS NOT NULL
  GROUP BY 1 ORDER BY n DESC LIMIT 15
`);
for (const r of q4) console.log(`  ${String(r.n).padStart(6)}  ${r.vendor}`);

console.log('\n=== Q5: Most recent indexedAt timestamps (last sync activity) ===');
const q5 = await prisma.$queryRawUnsafe(`
  SELECT
    max("indexedAt")::timestamp AS last_indexed,
    max("updatedAt")::timestamp AS last_row_update,
    max("shopifyUpdatedAt")::timestamp AS newest_shopify_update
  FROM products
`);
console.log(JSON.stringify(q5[0], null, 2));

await prisma.$disconnect();
