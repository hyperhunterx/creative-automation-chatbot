// scripts/probe-spec-blob-shapes.js
// Sample product_specification HTML blobs across top vendors to verify our
// parser will handle the real variations, not just one shape.

import 'dotenv/config';
import prisma from '../app/db.server.js';

console.log('=== A. Blob coverage by vendor (top 15) ===');
const cov = await prisma.$queryRawUnsafe(`
  SELECT
    "vendorNormalized" AS vendor,
    count(*)::int AS total,
    count(*) FILTER (WHERE specs ? 'product_specification')::int AS with_blob
  FROM products
  WHERE "deletedAt" IS NULL AND "vendorNormalized" IS NOT NULL
  GROUP BY 1
  HAVING count(*) >= 1000
  ORDER BY total DESC
  LIMIT 15
`);
for (const r of cov) {
  const pct = (100 * r.with_blob / r.total).toFixed(1);
  console.log(`  ${r.vendor.padEnd(20)} ${String(r.with_blob).padStart(6)} / ${String(r.total).padStart(6)}  (${pct}%)`);
}

console.log('\n=== B. Blob shape — one sample per top vendor ===');
const vendors = ['murr electronics', 'sick', 'siemens', 'schmersal', 'te-connectivity', 'ifm', 'pizzato', 'bonfiglioli', 'smc'];
for (const v of vendors) {
  const r = await prisma.$queryRawUnsafe(`
    SELECT title, specs->>'product_specification' AS blob
    FROM products
    WHERE "deletedAt" IS NULL
      AND "vendorNormalized" = $1
      AND specs ? 'product_specification'
      AND length(specs->>'product_specification') > 100
    LIMIT 1
  `, v);
  if (!r.length) {
    console.log(`\n--- ${v.toUpperCase()} (no blob sample) ---`);
    continue;
  }
  console.log(`\n--- ${v.toUpperCase()} — ${r[0].title.slice(0, 60)} ---`);
  console.log(r[0].blob.slice(0, 800));
}

console.log('\n\n=== C. Detect blob shape variants ===');
const shapes = await prisma.$queryRawUnsafe(`
  SELECT
    count(*) FILTER (WHERE specs->>'product_specification' ILIKE '%<table%')::int  AS table_shape,
    count(*) FILTER (WHERE specs->>'product_specification' ILIKE '%<ul%' AND specs->>'product_specification' NOT ILIKE '%<table%')::int AS ul_only,
    count(*) FILTER (WHERE specs->>'product_specification' ILIKE '%<div%' AND specs->>'product_specification' NOT ILIKE '%<table%' AND specs->>'product_specification' NOT ILIKE '%<ul%')::int AS div_only,
    count(*) FILTER (WHERE specs->>'product_specification' ILIKE '%<strong%')::int AS uses_strong,
    count(*) FILTER (WHERE specs->>'product_specification' ILIKE '%<b>%')::int AS uses_b_tag,
    count(*) FILTER (WHERE specs->>'product_specification' ILIKE '%&amp;%' OR specs->>'product_specification' ILIKE '%&deg;%' OR specs->>'product_specification' ILIKE '%&micro;%')::int AS has_entities,
    count(*) FILTER (WHERE specs ? 'product_specification')::int AS total_with_blob
  FROM products
  WHERE "deletedAt" IS NULL
`);
console.log(JSON.stringify(shapes[0], null, 2));

console.log('\n=== D. Sample a few NON-table shapes if any ===');
const odd = await prisma.$queryRawUnsafe(`
  SELECT vendor, title, specs->>'product_specification' AS blob
  FROM products
  WHERE "deletedAt" IS NULL
    AND specs ? 'product_specification'
    AND specs->>'product_specification' NOT ILIKE '%<table%'
    AND length(specs->>'product_specification') > 50
  LIMIT 3
`);
console.log(`  non-table shapes: ${odd.length}`);
for (const r of odd) {
  console.log(`\n  --- ${r.vendor} — ${r.title.slice(0, 50)} ---`);
  console.log(`  ${r.blob.slice(0, 600)}`);
}

console.log('\n=== E. Key overlap check — would parser overwrite existing structured metafields? ===');
// Get keys most commonly found INSIDE the blob, compare with keys that exist
// as separate metafields. If "Brand" is inside the blob AND already exists as
// a separate metafield, parser must not overwrite.
const sample = await prisma.$queryRawUnsafe(`
  SELECT specs->>'product_specification' AS blob, specs - 'product_specification' AS other
  FROM products
  WHERE "deletedAt" IS NULL
    AND specs ? 'product_specification'
    AND specs->>'product_specification' ILIKE '%<strong>Brand:%'
  LIMIT 5
`);
for (const r of sample) {
  // Extract just the keys from the blob via regex
  const m = [...(r.blob.match(/<strong>([^:<]+):<\/strong>/g) || [])]
    .map(s => s.replace(/<strong>|:<\/strong>/g, '').trim());
  console.log(`\n  blob_keys: ${JSON.stringify(m)}`);
  console.log(`  existing_metafield_keys: ${Object.keys(r.other || {})}`);
}

console.log('\n=== F. Are there products WITHOUT a blob? Where do their specs live? ===');
const noblob = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE specs = '{}'::jsonb)::int AS empty_specs,
         count(*) FILTER (WHERE specs <> '{}'::jsonb AND NOT (specs ? 'product_specification'))::int AS some_specs_no_blob
  FROM products WHERE "deletedAt" IS NULL
`);
console.log(JSON.stringify(noblob[0], null, 2));

await prisma.$disconnect();
