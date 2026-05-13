// scripts/update-specs-from-shopify.js
//
// One-shot script to backfill the `specs` JSONB column on existing products
// from Shopify metafields. Does NOT re-embed (would waste ~80 min + Voyage
// budget for no gain — textForEmbedding hasn't changed).
//
// Safe to re-run: it's an UPDATE keyed on id, missing products are skipped.
//
// Usage:
//   $env:SHOPIFY_SHOP_DOMAIN="nfejky-ge.myshopify.com"
//   $env:SHOPIFY_ADMIN_TOKEN="..."   # token from client_credentials grant
//   $env:DATABASE_URL="..."
//   node scripts/update-specs-from-shopify.js

import 'dotenv/config';
import { makeAdminClient } from '../app/services/admin-shopify.server.js';
import { flattenMetafields } from '../app/services/product-extractor.server.js';
import prisma from '../app/db.server.js';

const REQUIRED_ENV = ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ADMIN_TOKEN', 'DATABASE_URL'];
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`Missing required env: ${k}`);
    process.exit(1);
  }
}

const client = makeAdminClient({
  shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
  accessToken: process.env.SHOPIFY_ADMIN_TOKEN,
});

async function bulkUpdateSpecs(rows) {
  if (!rows.length) return 0;
  // One multi-row UPDATE per page using a VALUES join — far fewer round trips
  // than per-row updates against the Railway proxy.
  const params = [];
  const placeholders = [];
  for (let i = 0; i < rows.length; i++) {
    const base = i * 2;
    placeholders.push(`($${base + 1}, $${base + 2}::jsonb)`);
    params.push(rows[i].id, JSON.stringify(rows[i].specs));
  }
  const sql = `
    UPDATE products AS p
    SET specs = v.specs, "updatedAt" = now()
    FROM (VALUES ${placeholders.join(',')}) AS v(id, specs)
    WHERE p.id = v.id
  `;
  return prisma.$executeRawUnsafe(sql, ...params);
}

async function main() {
  const startedAt = Date.now();
  let pageNum = 0;
  let totalSeen = 0;
  let totalWithSpecs = 0;
  let totalUpdated = 0;

  for await (const products of client.productPages({ pageSize: 250 })) {
    pageNum += 1;
    const updates = [];
    for (const p of products) {
      totalSeen += 1;
      const specs = flattenMetafields(p);
      const specCount = Object.keys(specs).length;
      if (specCount > 0) totalWithSpecs += 1;
      updates.push({ id: p.id, specs });
    }

    const affected = await bulkUpdateSpecs(updates);
    totalUpdated += Number(affected || updates.length);

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(
      `[specs] page ${pageNum} | seen=${totalSeen} with_specs=${totalWithSpecs} updated=${totalUpdated} | elapsed=${elapsed}s`,
    );
  }

  await prisma.$disconnect();
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `[specs] complete | seen=${totalSeen} with_specs=${totalWithSpecs} updated=${totalUpdated} in ${elapsed}s`,
  );
}

main().catch((err) => {
  console.error('[specs] FAILED:', err);
  process.exit(1);
});
