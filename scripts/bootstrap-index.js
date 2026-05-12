// scripts/bootstrap-index.js
//
// Run this ONCE from your local laptop to populate the products index.
// Usage:
//   $env:SHOPIFY_SHOP_DOMAIN="creativeautomation.myshopify.com"
//   $env:SHOPIFY_ADMIN_TOKEN="shpat_..."
//   $env:DATABASE_URL="<railway public postgres url>"
//   $env:VOYAGE_API_KEY="pa-..."
//   node scripts/bootstrap-index.js
//
// Safe to re-run: upserts are idempotent and out-of-order-safe.

import 'dotenv/config';
import { makeAdminClient } from '../app/services/admin-shopify.server.js';
import { upsertProductFromShopify } from '../app/services/product-index.server.js';
import { embedMany } from '../app/services/embeddings.server.js';
import { extractProductRow } from '../app/services/product-extractor.server.js';
import prisma from '../app/db.server.js';

const REQUIRED_ENV = ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ADMIN_TOKEN', 'DATABASE_URL', 'VOYAGE_API_KEY'];
for (const k of REQUIRED_ENV) {
  if (!process.env[k]) {
    console.error(`Missing required env: ${k}`);
    process.exit(1);
  }
}

async function main() {
  const client = makeAdminClient({
    shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
    accessToken: process.env.SHOPIFY_ADMIN_TOKEN,
  });

  let total = 0;
  let pageNum = 0;
  const startedAt = Date.now();

  for await (const products of client.productPages({ pageSize: 250 })) {
    pageNum += 1;
    // Pre-extract rows so we can batch-embed.
    const rows = products.map(extractProductRow);
    const texts = rows.map(r => r.textForEmbedding);
    // inputType: 'document' — these are catalog entries, not user queries.
    const vectors = await embedMany(texts, { inputType: 'document' });

    // Inject each precomputed embedding into upsert via a wrapper so the
    // single-product upserter doesn't re-embed.
    for (let i = 0; i < products.length; i++) {
      const vec = vectors[i];
      await upsertProductFromShopify(products[i], { embedOne: async () => vec });
      total += 1;
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[bootstrap] page ${pageNum} done | total=${total} | elapsed=${elapsed}s`);
  }

  await prisma.$disconnect();
  console.log(`[bootstrap] complete | ${total} products in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}

main().catch(err => {
  console.error('[bootstrap] FAILED:', err);
  process.exit(1);
});
