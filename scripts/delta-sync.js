// scripts/delta-sync.js
//
// Pulls only the Shopify products updated since our last_indexed timestamp,
// embeds them via Voyage, and upserts into Postgres. Idempotent — safe to
// retry. Existing rows get replaced with fresh data; brand-new rows get added.
//
// USAGE:
//   $env:SHOPIFY_SHOP_DOMAIN="<shop>.myshopify.com"
//   $env:SHOPIFY_ADMIN_TOKEN="shpat_..."
//   $env:DATABASE_URL="..."
//   $env:VOYAGE_API_KEY="pa-..."
//   node scripts/delta-sync.js                          # filter=updated_at, since=DB last_indexed
//   node scripts/delta-sync.js --created-only           # filter=created_at — catches only TRULY NEW products.
//                                                      # Strongly recommended over updated_at for ad-hoc
//                                                      # catch-up syncs: Shopify flips updated_at on every
//                                                      # inventory change, so updated_at deltas are
//                                                      # mostly stock-level edits we'd re-embed for no benefit.
//   node scripts/delta-sync.js --since 2026-05-12       # explicit cutoff
//   node scripts/delta-sync.js --dry-run                # NO writes, NO embeddings
//
// SAFETY:
//   - Dry run never writes and never calls Voyage (no cost).
//   - Apply mode upserts via the same path bootstrap uses (idempotent ON CONFLICT).
//   - Brand-from-title and spec-blob backfill scripts may need to be re-run on
//     the newly-added rows for full retrieval quality. Those scripts are
//     idempotent and only touch rows that need updating.

import 'dotenv/config';
import { makeAdminClient } from '../app/services/admin-shopify.server.js';
import { upsertManyFromShopify } from '../app/services/product-index.server.js';
import { embedMany } from '../app/services/embeddings.server.js';
import { extractProductRow } from '../app/services/product-extractor.server.js';
import prisma from '../app/db.server.js';

const DRY_RUN = process.argv.includes('--dry-run');
const CREATED_ONLY = process.argv.includes('--created-only');
const sinceArgIdx = process.argv.indexOf('--since');
const sinceArg = sinceArgIdx >= 0 ? process.argv[sinceArgIdx + 1] : null;

const REQUIRED_ENV = ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ADMIN_TOKEN', 'DATABASE_URL'];
if (!DRY_RUN) REQUIRED_ENV.push('VOYAGE_API_KEY');
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`Missing required env: ${k}`);
    process.exit(1);
  }
}

async function resolveSince() {
  if (sinceArg) return sinceArg;
  const r = await prisma.$queryRawUnsafe(`SELECT max("indexedAt")::timestamp AS t FROM products`);
  const t = r[0]?.t;
  if (!t) {
    console.error('Could not resolve last_indexed from DB; pass --since YYYY-MM-DDTHH:MM:SSZ');
    process.exit(1);
  }
  return new Date(t).toISOString();
}

const since = await resolveSince();
const filterField = CREATED_ONLY ? 'created_at' : 'updated_at';
console.log(`=== delta-sync.js — ${DRY_RUN ? 'DRY RUN' : 'APPLY MODE'} ===`);
console.log(`  cutoff (${filterField} >): ${since}\n`);

const client = makeAdminClient({
  shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
  accessToken: process.env.SHOPIFY_ADMIN_TOKEN,
});

const queryFilter = `${filterField}:>${since}`;
let total = 0;
let pageNum = 0;
let firstSampleTitles = [];
const startedAt = Date.now();

for await (const products of client.productPages({ pageSize: 100, query: queryFilter })) {
  pageNum += 1;
  if (products.length === 0) {
    console.log(`[delta] page ${pageNum} empty — done`);
    break;
  }
  for (const p of products) {
    if (firstSampleTitles.length < 8) firstSampleTitles.push(`  - ${p.title.slice(0, 80)} (vendor=${p.vendor})`);
  }
  if (DRY_RUN) {
    total += products.length;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[delta] page ${pageNum} | products_seen=${products.length} | total=${total} | elapsed=${elapsed}s [DRY]`);
    continue;
  }
  const rows = products.map(extractProductRow);
  const texts = rows.map(r => r.textForEmbedding);
  const vectors = await embedMany(texts, { inputType: 'document' });
  const { count } = await upsertManyFromShopify(products, vectors);
  total += count;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[delta] page ${pageNum} | products=${products.length} | upserted=${count} | total=${total} | elapsed=${elapsed}s`);
}

console.log(`\n=== Summary ===`);
console.log(`  ${DRY_RUN ? 'would_sync' : 'synced'}=${total} products in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
console.log(`\n  First 8 products in the delta:`);
for (const s of firstSampleTitles) console.log(s);

if (!DRY_RUN && total > 0) {
  console.log(`\n  NEXT STEPS (also idempotent — safe to skip if not needed):`);
  console.log(`    1. node scripts/derive-brand-from-title.js --apply   # re-vendor any new house-brand-listed products`);
  console.log(`    2. node scripts/parse-spec-blobs.js --apply          # parse the HTML spec blobs on new rows`);
}

await prisma.$disconnect();
