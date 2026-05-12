// app/services/product-index.server.js
import prisma from '../db.server.js';
import { extractProductRow } from './product-extractor.server.js';
import { embedOne as defaultEmbedOne, vectorToPgLiteral } from './embeddings.server.js';

/**
 * Upsert a Shopify product into the local index.
 * Idempotent and safe for out-of-order webhook delivery.
 *
 * @param {object} shopifyProduct - product as returned by Shopify GraphQL
 * @param {object} [deps] - injected dependencies (for testing)
 * @returns {Promise<{skipped: boolean, reason?: string, id?: string}>}
 */
export async function upsertProductFromShopify(shopifyProduct, deps = {}) {
  const embedOne = deps.embedOne || defaultEmbedOne;

  const row = extractProductRow(shopifyProduct);

  // Out-of-order protection — skip if a newer version is already stored.
  if (row.shopifyUpdatedAt) {
    const existing = await prisma.product.findUnique({
      where: { id: row.id },
      select: { shopifyUpdatedAt: true },
    });
    if (existing?.shopifyUpdatedAt && new Date(existing.shopifyUpdatedAt) >= new Date(row.shopifyUpdatedAt)) {
      return { skipped: true, reason: 'stale_payload' };
    }
  }

  // Embedding step uses textForEmbedding from the extractor. inputType
  // defaults to 'document' is what we want for indexing — but the injected
  // fakeEmbed (in tests) doesn't take options, so we pass them only to the
  // default. The wrapping `embedOne(text)` signature is what the contract
  // says; the inputType is set by the default-implementation's default.
  const embedding = await embedOne(row.textForEmbedding);
  const vecLit = vectorToPgLiteral(embedding);

  // Use raw SQL because Prisma doesn't natively support vector(N) types.
  await prisma.$executeRawUnsafe(
    `
    INSERT INTO products (
      id, handle, title, vendor, "productType", category, tags, description,
      "priceMin", "priceMax", currency, "imageUrl", available, specs, variants,
      "shopifyUpdatedAt", embedding, "deletedAt", "indexedAt", "updatedAt"
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8,
      $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb,
      $16, $17::vector, NULL, now(), now()
    )
    ON CONFLICT (id) DO UPDATE SET
      handle = EXCLUDED.handle,
      title = EXCLUDED.title,
      vendor = EXCLUDED.vendor,
      "productType" = EXCLUDED."productType",
      category = EXCLUDED.category,
      tags = EXCLUDED.tags,
      description = EXCLUDED.description,
      "priceMin" = EXCLUDED."priceMin",
      "priceMax" = EXCLUDED."priceMax",
      currency = EXCLUDED.currency,
      "imageUrl" = EXCLUDED."imageUrl",
      available = EXCLUDED.available,
      specs = EXCLUDED.specs,
      variants = EXCLUDED.variants,
      "shopifyUpdatedAt" = EXCLUDED."shopifyUpdatedAt",
      embedding = EXCLUDED.embedding,
      "deletedAt" = NULL,
      "indexedAt" = now(),
      "updatedAt" = now()
    `,
    row.id,
    row.handle,
    row.title,
    row.vendor,
    row.productType,
    row.category,
    row.tags,
    row.description,
    row.priceMin,
    row.priceMax,
    row.currency,
    row.imageUrl,
    row.available,
    JSON.stringify(row.specs),
    JSON.stringify(row.variants),
    row.shopifyUpdatedAt ? new Date(row.shopifyUpdatedAt) : null,
    vecLit,
  );

  return { skipped: false, id: row.id };
}

export async function softDeleteProduct(shopifyId) {
  await prisma.$executeRawUnsafe(
    `UPDATE products SET "deletedAt" = now(), "updatedAt" = now() WHERE id = $1`,
    shopifyId,
  );
}

export async function getIndexedShopifyIds() {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id FROM products WHERE "deletedAt" IS NULL`,
  );
  return rows.map(r => r.id);
}
