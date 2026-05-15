// scripts/parse-spec-blobs.js
//
// Re-parses the `product_specification` HTML blob already stored in each
// product's specs JSONB and merges the structured keys (depth, length, width,
// actuator_type, ip_rating, etc.) back into specs. This is PURE DB work — no
// Shopify Admin API call, no Voyage re-embedding. The blob is the source we
// already have; we just unlock the structure inside it.
//
// USAGE:
//   node scripts/parse-spec-blobs.js                                    # dry run — read-only, prints first 5 diffs
//   node scripts/parse-spec-blobs.js --apply                            # writes merged specs (full scan)
//   node scripts/parse-spec-blobs.js --apply --limit 200                # apply but cap at 200 rows (for staged rollout)
//   node scripts/parse-spec-blobs.js --apply --since 2026-05-12         # only touch rows whose updatedAt > cutoff (post-delta-sync)
//
// SAFETY:
//   - Dry run never writes.
//   - Apply mode UPDATEs the specs JSONB only — embedding, vendor, prices,
//     categories untouched. updatedAt is bumped.
//   - Existing structured metafield keys ALWAYS take precedence over parsed
//     blob values (parser merges into a NEW dict and writes back specs with
//     the original real metafields layered on top).

import 'dotenv/config';
import prisma from '../app/db.server.js';
import { parseSpecBlob } from '../app/services/product-extractor.server.js';

const APPLY = process.argv.includes('--apply');
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : Infinity;
const sinceIdx = process.argv.indexOf('--since');
const SINCE = sinceIdx >= 0 ? process.argv[sinceIdx + 1] : null;

console.log(`=== parse-spec-blobs.js — ${APPLY ? 'APPLY MODE' : 'DRY RUN'} (limit=${Number.isFinite(LIMIT) ? LIMIT : 'no cap'}, since=${SINCE || 'all'}) ===\n`);

// Pull only the rows that have a blob worth parsing. Stream in pages so we
// don't load 142k rows into memory at once.
const PAGE_SIZE = 500;
let lastId = '';
let totalSeen = 0;
let totalUpdated = 0;
let totalNoChange = 0;
let totalNewKeys = 0;
const sampleDiffs = [];
const t0 = Date.now();

while (true) {
  if (totalSeen >= LIMIT) break;
  // Keyset pagination — WHERE id > lastId — stays fast as we get deeper into
  // the catalog, unlike OFFSET which scans more rows the further it goes.
  // Optional --since filter narrows to rows touched after that timestamp, so
  // a post-delta-sync re-parse only inspects the ~thousands of new/updated
  // rows instead of all 142k. Whole-catalog parse takes ~30 min, since-filter
  // takes ~1 min.
  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT id, title, specs
    FROM products
    WHERE "deletedAt" IS NULL
      AND id > $1
      AND specs ? 'product_specification'
      AND length(specs->>'product_specification') > 50
      AND ($2::timestamp IS NULL OR "updatedAt" > $2::timestamp)
    ORDER BY id
    LIMIT ${PAGE_SIZE}
  `,
    lastId,
    SINCE,
  );
  if (rows.length === 0) break;
  lastId = rows[rows.length - 1].id;

  const updates = [];
  for (const r of rows) {
    if (totalSeen >= LIMIT) break;
    totalSeen++;
    const blob = r.specs?.product_specification;
    if (typeof blob !== 'string') continue;
    const parsed = parseSpecBlob(blob);
    const parsedKeys = Object.keys(parsed);
    if (parsedKeys.length === 0) {
      totalNoChange++;
      continue;
    }
    // Merge: keep existing real metafields, add parsed-only keys.
    const merged = { ...r.specs };
    let added = 0;
    for (const [k, v] of Object.entries(parsed)) {
      if (merged[k] == null || merged[k] === '') {
        merged[k] = v;
        added++;
      }
    }
    if (added === 0) {
      totalNoChange++;
      continue;
    }
    totalUpdated++;
    totalNewKeys += added;
    updates.push({ id: r.id, specs: merged });
    // Capture first 5 diffs for the dry-run review.
    if (sampleDiffs.length < 5) {
      const newKeys = {};
      for (const k of Object.keys(parsed)) {
        if (r.specs[k] == null || r.specs[k] === '') newKeys[k] = parsed[k];
      }
      sampleDiffs.push({ title: r.title, newKeys });
    }
  }

  if (APPLY && updates.length > 0) {
    // Bulk-update via a VALUES table. One round-trip per page (~500 rows).
    const placeholders = [];
    const params = [];
    for (let i = 0; i < updates.length; i++) {
      const base = i * 2;
      placeholders.push(`($${base + 1}, $${base + 2}::jsonb)`);
      params.push(updates[i].id, JSON.stringify(updates[i].specs));
    }
    const sql = `
      UPDATE products AS p
      SET specs = v.specs, "updatedAt" = now()
      FROM (VALUES ${placeholders.join(',')}) AS v(id, specs)
      WHERE p.id = v.id
    `;
    await prisma.$executeRawUnsafe(sql, ...params);
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  page seen=${totalSeen} updated=${totalUpdated} no_change=${totalNoChange} new_keys_total=${totalNewKeys}  (${elapsed}s)`);
}

console.log(`\n=== Summary ===`);
console.log(`  total_inspected      ${totalSeen}`);
console.log(`  rows_with_new_keys   ${totalUpdated}`);
console.log(`  rows_with_no_change  ${totalNoChange}  (blob already fully covered by existing metafields, OR plain-list shape)`);
console.log(`  total_new_keys_added ${totalNewKeys}`);
console.log(`  elapsed              ${((Date.now() - t0) / 1000).toFixed(1)}s`);

console.log(`\n=== Sample diffs (first 5 rows that would change) ===`);
for (const d of sampleDiffs) {
  console.log(`\n  --- ${d.title.slice(0, 80)} ---`);
  for (const [k, v] of Object.entries(d.newKeys)) {
    console.log(`    + ${k.padEnd(30)} = ${String(v).slice(0, 80)}`);
  }
}

if (!APPLY) {
  console.log(`\n--- DRY RUN COMPLETE — no DB changes made. ---`);
  console.log(`To apply: node scripts/parse-spec-blobs.js --apply`);
}

await prisma.$disconnect();
