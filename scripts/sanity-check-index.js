// scripts/sanity-check-index.js
// Quick post-bootstrap health check on the products table.

import 'dotenv/config';
import prisma from '../app/db.server.js';

const counts = await prisma.$queryRawUnsafe(`
  SELECT
    (SELECT count(*) FROM products WHERE "deletedAt" IS NULL)                            AS total,
    (SELECT count(*) FROM products WHERE "vendorNormalized" IS NOT NULL)                 AS with_vendor,
    (SELECT count(*) FROM products WHERE cardinality(categories) > 0)                    AS with_categories,
    (SELECT count(*) FROM products WHERE embedding IS NOT NULL)                          AS with_embedding,
    (SELECT count(*) FROM products WHERE "searchTsv" IS NOT NULL)                        AS with_tsv,
    (SELECT count(DISTINCT "vendorNormalized") FROM products)                            AS distinct_vendors
`);

console.log('=== Index coverage ===');
const r = counts[0];
for (const k of Object.keys(r)) console.log(`  ${k.padEnd(20)} ${String(r[k]).padStart(8)}`);

console.log('\n=== Top vendors (by row count, normalized) ===');
const topVendors = await prisma.$queryRawUnsafe(`
  SELECT "vendorNormalized" AS vendor, count(*)::int AS n
  FROM products
  WHERE "deletedAt" IS NULL AND "vendorNormalized" IS NOT NULL
  GROUP BY 1 ORDER BY n DESC LIMIT 15
`);
for (const row of topVendors) console.log(`  ${row.vendor.padEnd(30)} ${String(row.n).padStart(6)}`);

console.log('\n=== Top categories ===');
const topCats = await prisma.$queryRawUnsafe(`
  SELECT cat, count(*)::int AS n
  FROM products, unnest(categories) AS cat
  WHERE "deletedAt" IS NULL
  GROUP BY 1 ORDER BY n DESC LIMIT 15
`);
for (const row of topCats) console.log(`  ${row.cat.padEnd(45)} ${String(row.n).padStart(6)}`);

console.log('\n=== Sample row (random branded product) ===');
const sample = await prisma.$queryRawUnsafe(`
  SELECT id, title, vendor, "vendorNormalized", categories, tags, "priceMin", currency,
         (embedding IS NOT NULL) AS has_embed
  FROM products
  WHERE "vendorNormalized" IS NOT NULL AND cardinality(categories) > 0
  ORDER BY random() LIMIT 1
`);
console.log(JSON.stringify(sample[0], null, 2));

console.log('\n=== HNSW index sanity (random vector ANN, top 3) ===');
// Build a tiny random vector to prove the HNSW index is queryable.
const v = new Array(1024).fill(0).map(() => (Math.random() - 0.5) * 0.01);
const vecLit = `[${v.join(',')}]`;
const nn = await prisma.$queryRawUnsafe(
  `SELECT id, title, "vendorNormalized" AS vendor, (embedding <=> $1::vector) AS dist
   FROM products WHERE "deletedAt" IS NULL ORDER BY embedding <=> $1::vector LIMIT 3`,
  vecLit,
);
for (const row of nn) console.log(`  dist=${Number(row.dist).toFixed(4)}  ${row.vendor?.padEnd(15) ?? ''}  ${row.title.slice(0, 80)}`);

await prisma.$disconnect();
