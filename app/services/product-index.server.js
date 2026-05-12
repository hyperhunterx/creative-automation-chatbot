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
      id, handle, title, vendor, "vendorNormalized", "productType", category, categories, tags, description,
      "priceMin", "priceMax", currency, "imageUrl", available, specs, variants,
      "shopifyUpdatedAt", embedding, "deletedAt", "indexedAt", "updatedAt"
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11::numeric, $12::numeric, $13, $14, $15, $16::jsonb, $17::jsonb,
      $18, $19::vector, NULL, now(), now()
    )
    ON CONFLICT (id) DO UPDATE SET
      handle = EXCLUDED.handle,
      title = EXCLUDED.title,
      vendor = EXCLUDED.vendor,
      "vendorNormalized" = EXCLUDED."vendorNormalized",
      "productType" = EXCLUDED."productType",
      category = EXCLUDED.category,
      categories = EXCLUDED.categories,
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
    row.vendorNormalized,
    row.productType,
    row.category,
    row.categories,
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

/**
 * Bulk-upsert many products in a single multi-row INSERT. Used by bootstrap
 * and the full-sync route to avoid per-row network round trips against a
 * proxied database. Caller supplies pre-computed embeddings (the bootstrap
 * already batches Voyage calls upstream).
 *
 * Skips the per-product shopifyUpdatedAt precheck — callers that need OOO
 * protection should still use upsertProductFromShopify.
 *
 * @param {object[]} products  Shopify GraphQL product nodes
 * @param {number[][]} vectors One embedding per product, matching index order
 * @returns {Promise<{count: number}>}
 */
export async function upsertManyFromShopify(products, vectors) {
  if (!Array.isArray(products) || products.length === 0) return { count: 0 };
  if (!Array.isArray(vectors) || vectors.length !== products.length) {
    throw new Error(`upsertManyFromShopify: vectors.length (${vectors?.length}) must match products.length (${products.length})`);
  }

  const rows = products.map(extractProductRow);
  const COLS = 19; // id..embedding — keep in sync with the INSERT column list below
  const params = [];
  const placeholders = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const base = i * COLS;
    placeholders.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11}::numeric,$${base + 12}::numeric,$${base + 13},$${base + 14},$${base + 15},$${base + 16}::jsonb,$${base + 17}::jsonb,$${base + 18},$${base + 19}::vector,NULL,now(),now())`
    );
    params.push(
      r.id,
      r.handle,
      r.title,
      r.vendor,
      r.vendorNormalized,
      r.productType,
      r.category,
      r.categories,
      r.tags,
      r.description,
      r.priceMin,
      r.priceMax,
      r.currency,
      r.imageUrl,
      r.available,
      JSON.stringify(r.specs),
      JSON.stringify(r.variants),
      r.shopifyUpdatedAt ? new Date(r.shopifyUpdatedAt) : null,
      vectorToPgLiteral(vectors[i]),
    );
  }

  const sql = `
    INSERT INTO products (
      id, handle, title, vendor, "vendorNormalized", "productType", category, categories, tags, description,
      "priceMin", "priceMax", currency, "imageUrl", available, specs, variants,
      "shopifyUpdatedAt", embedding, "deletedAt", "indexedAt", "updatedAt"
    )
    VALUES ${placeholders.join(',')}
    ON CONFLICT (id) DO UPDATE SET
      handle = EXCLUDED.handle,
      title = EXCLUDED.title,
      vendor = EXCLUDED.vendor,
      "vendorNormalized" = EXCLUDED."vendorNormalized",
      "productType" = EXCLUDED."productType",
      category = EXCLUDED.category,
      categories = EXCLUDED.categories,
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
  `;

  await prisma.$executeRawUnsafe(sql, ...params);
  return { count: rows.length };
}
