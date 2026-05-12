// app/routes/api.sync.full.jsx
//
// POST endpoint that runs a full reconciliation between Shopify and our index.
// Protected by a shared secret in the `X-Sync-Secret` header — call this from
// Railway cron or an external scheduler (e.g. cron-job.org, GitHub Actions).
//
// Effect:
//   - Every product on Shopify is upserted (idempotent).
//   - Products that exist in our index but not on Shopify are soft-deleted.
//   - Returns a JSON summary on success.

import { makeAdminClient } from "../services/admin-shopify.server.js";
import { upsertProductFromShopify, softDeleteProduct, getIndexedShopifyIds } from "../services/product-index.server.js";
import { embedMany } from "../services/embeddings.server.js";
import { extractProductRow } from "../services/product-extractor.server.js";
import { RETRIEVAL_CONFIG } from "../services/config.server.js";

export const action = async ({ request }) => {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const provided = request.headers.get('X-Sync-Secret');
  if (!RETRIEVAL_CONFIG.syncSecret || provided !== RETRIEVAL_CONFIG.syncSecret) {
    return new Response('Unauthorized', { status: 401 });
  }

  const shopDomain = process.env.SHOPIFY_SHOP_DOMAIN;
  const accessToken = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!shopDomain || !accessToken) {
    return new Response('Shopify credentials missing', { status: 500 });
  }

  const startedAt = Date.now();
  const client = makeAdminClient({ shopDomain, accessToken });

  const seenIds = new Set();
  let total = 0;
  let pages = 0;

  for await (const products of client.productPages({ pageSize: 250 })) {
    pages += 1;
    const rows = products.map(extractProductRow);
    const texts = rows.map(r => r.textForEmbedding);
    const vectors = await embedMany(texts, { inputType: 'document' });
    for (let i = 0; i < products.length; i++) {
      seenIds.add(rows[i].id);
      const vec = vectors[i];
      await upsertProductFromShopify(products[i], { embedOne: async () => vec });
      total += 1;
    }
  }

  // Soft-delete products that exist locally but no longer on Shopify
  const indexedIds = await getIndexedShopifyIds();
  const toDelete = indexedIds.filter(id => !seenIds.has(id));
  for (const id of toDelete) {
    await softDeleteProduct(id);
  }

  const summary = {
    ok: true,
    pages,
    upserted: total,
    softDeleted: toDelete.length,
    elapsedMs: Date.now() - startedAt,
  };
  console.log(`[sync] full reconciliation complete:`, summary);
  return Response.json(summary);
};
