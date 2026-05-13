// scripts/derive-brand-from-title.js
//
// Many Shopify products have vendor="Creative Automation" (the house catch-all)
// when the real manufacturer (WAIRCOM, MINDMAN, SMC, CPT, ...) lives at the END
// of the product title. This causes brand_include filters to miss them.
//
// USAGE:
//   node scripts/derive-brand-from-title.js                # dry run — read-only
//   node scripts/derive-brand-from-title.js --apply        # writes updates
//
// SAFETY:
//   - Dry run NEVER touches the DB.
//   - --apply only updates rows where the derived brand passes ALL these gates:
//       1. last word is purely alphabetic (no digits/punctuation)
//       2. length 2-15 chars
//       3. uppercase in the original title
//       4. NOT in the STOPWORD list (units / common suffixes that aren't brands)
//   - vendor + vendorNormalized are the ONLY columns updated. updatedAt is bumped.
//   - Embeddings, specs, prices, tags untouched.

import 'dotenv/config';
import prisma from '../app/db.server.js';

const APPLY = process.argv.includes('--apply');

// Words that LOOK like brand candidates (uppercase trailing) but aren't.
// Built from manual inspection — extend if discovery surfaces more junk.
const STOPWORDS = new Set([
  // Electrical units
  'VDC', 'VAC', 'V', 'KV', 'MV', 'A', 'MA', 'KA', 'W', 'KW', 'HZ', 'KHZ', 'MHZ',
  'OHM', 'OHMS', 'MOHM',
  // Pneumatic / fluid units
  'BAR', 'PSI', 'MPA', 'KPA', 'NPT', 'BSP', 'BSPP', 'BSPT', 'OD', 'ID', 'NM', 'LBS',
  // Common title suffixes (not brands)
  'COIL', 'ADAPTOR', 'ADAPTER', 'VALVE', 'TYPE', 'PORT', 'WAY', 'SIZE',
  'RETURN', 'SPRING', 'DETEND', 'BISTABLE', 'PROOF', 'NEMA',
  'NO', 'NC', 'AC', 'DC',
  'NEW', 'USED', 'OEM',
  // Geographic (sometimes appears as trailing word)
  'GERMANY', 'JAPAN', 'CHINA', 'ITALY', 'USA',
  // Materials
  'BRASS', 'STEEL', 'ALUMINUM', 'PLASTIC', 'STAINLESS',
  // Found via dry-run as false positives — real brand was earlier in title:
  'SENSOR', 'CYLINDER', 'ACTUATORCOVNA',
]);

function parseTrailingBrand(title) {
  if (typeof title !== 'string' || !title.trim()) return null;
  // Strip trailing punctuation/quotes, then take last whitespace-separated token.
  const cleaned = title.trim().replace(/[.,;:"'`)\]]+$/, '');
  const tokens = cleaned.split(/\s+/);
  const last = tokens[tokens.length - 1];
  if (!last) return null;
  // Must be alphabetic and uppercase in the original.
  if (!/^[A-Z]{2,15}$/.test(last)) return null;
  if (STOPWORDS.has(last)) return null;
  return last;
}

console.log(`=== derive-brand-from-title.js — ${APPLY ? 'APPLY MODE (will write)' : 'DRY RUN (read-only)'} ===\n`);

console.log('Loading "creative automation"-vendored rows...');
const rows = await prisma.$queryRawUnsafe(`
  SELECT id, title, vendor, "vendorNormalized"
  FROM products
  WHERE "deletedAt" IS NULL AND "vendorNormalized" = 'creative automation'
  ORDER BY title
`);
console.log(`  rows to inspect: ${rows.length}`);

// Bucket: brand -> [rows]
const buckets = new Map();
const unparsed = [];
for (const r of rows) {
  const brand = parseTrailingBrand(r.title);
  if (!brand) {
    unparsed.push(r);
    continue;
  }
  if (!buckets.has(brand)) buckets.set(brand, []);
  buckets.get(brand).push(r);
}

const sorted = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);

console.log(`\n=== Candidate brand groups (${sorted.length} distinct, ${rows.length - unparsed.length} rows match) ===`);
console.log('Review each — anything that ISN\'T a real brand should be added to STOPWORDS.\n');
console.log('  count  brand        sample title');
console.log('  -----  -----------  ' + '-'.repeat(70));
for (const [brand, group] of sorted) {
  const sample = group[0].title.length > 65 ? group[0].title.slice(0, 65) + '…' : group[0].title;
  console.log(`  ${String(group.length).padStart(5)}  ${brand.padEnd(11)}  ${sample}`);
}

console.log(`\n=== Rows with NO trailing-brand match (will stay "creative automation") ===`);
console.log(`  ${unparsed.length} rows — sampling first 8:`);
for (const r of unparsed.slice(0, 8)) {
  console.log(`  - ${r.title.slice(0, 90)}`);
}

if (!APPLY) {
  console.log(`\n--- DRY RUN COMPLETE — no DB changes made. ---`);
  console.log(`To apply: node scripts/derive-brand-from-title.js --apply`);
  console.log(`(But review the candidate list above first — any junk groups should be added to STOPWORDS.)`);
  await prisma.$disconnect();
  process.exit(0);
}

// === APPLY MODE ===
console.log(`\n=== APPLYING updates ===`);
let updated = 0;
const t0 = Date.now();
// Do per-brand bulk updates — one UPDATE per brand, IN clause for ids.
for (const [brand, group] of sorted) {
  const ids = group.map(r => r.id);
  const brandLower = brand.toLowerCase();
  // Vendor display: keep the brand uppercase (matches catalog convention).
  // vendorNormalized lowercased — same convention as the rest of the catalog.
  const result = await prisma.$executeRawUnsafe(
    `UPDATE products
       SET vendor = $1, "vendorNormalized" = $2, "updatedAt" = now()
     WHERE id = ANY($3::text[])`,
    brand,
    brandLower,
    ids,
  );
  console.log(`  ${brand.padEnd(11)} updated=${result}`);
  updated += result;
}

console.log(`\n=== Done — ${updated} rows updated in ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);

console.log(`\n=== Verification — vendor counts after the update ===`);
const after = await prisma.$queryRawUnsafe(`
  SELECT "vendorNormalized" AS vendor, count(*)::int AS n
  FROM products
  WHERE "deletedAt" IS NULL
  GROUP BY 1
  HAVING count(*) > 100
  ORDER BY n DESC LIMIT 25
`);
for (const r of after) console.log(`  ${String(r.n).padStart(6)}  ${r.vendor}`);

await prisma.$disconnect();
