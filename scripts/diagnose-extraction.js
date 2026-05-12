// scripts/diagnose-extraction.js
// One-off: pull 5 real products from Shopify and run them through the
// extractor. Lets us eyeball data quality before the long bootstrap.

import 'dotenv/config';
import { makeAdminClient } from '../app/services/admin-shopify.server.js';
import { extractProductRow } from '../app/services/product-extractor.server.js';

const REQUIRED = ['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_ADMIN_TOKEN'];
for (const k of REQUIRED) {
  if (!process.env[k]) {
    console.error(`Missing required env: ${k}`);
    process.exit(1);
  }
}

const client = makeAdminClient({
  shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
  accessToken: process.env.SHOPIFY_ADMIN_TOKEN,
});

const iter = client.productPages({ pageSize: 5 });
const { value: products } = await iter.next();

console.log(`\nFetched ${products.length} products. Running through extractor...\n`);

for (const p of products) {
  const row = extractProductRow(p);
  console.log('═'.repeat(80));
  console.log(`id:              ${row.id}`);
  console.log(`handle:          ${row.handle}`);
  console.log(`title:           ${row.title}`);
  console.log(`vendor:          ${row.vendor}`);
  console.log(`productType:     ${row.productType}`);
  console.log(`category:        ${row.category}`);
  console.log(`tags:            ${JSON.stringify(row.tags)}`);
  console.log(`priceMin/Max:    ${row.priceMin} - ${row.priceMax} ${row.currency}`);
  console.log(`available:       ${row.available}`);
  console.log(`imageUrl:        ${row.imageUrl ? row.imageUrl.slice(0, 80) + '...' : '(none)'}`);
  console.log(`variants:        ${row.variants.length} (first sku: ${row.variants[0]?.sku ?? '∅'}, price: ${row.variants[0]?.price ?? '∅'})`);
  console.log(`shopifyUpdated:  ${row.shopifyUpdatedAt}`);
  console.log(`description:`);
  console.log(`  ${(row.description || '(empty)').slice(0, 240)}${row.description.length > 240 ? '...' : ''}`);
  console.log(`textForEmbedding (${row.textForEmbedding.length} chars):`);
  console.log(`  ${row.textForEmbedding.slice(0, 320)}${row.textForEmbedding.length > 320 ? '...' : ''}`);
  console.log();
}

// Aggregate health check
console.log('═'.repeat(80));
console.log('Health summary:');
const rows = products.map(extractProductRow);
console.log(`  with vendor:        ${rows.filter(r => r.vendor).length}/${rows.length}`);
console.log(`  with productType:   ${rows.filter(r => r.productType).length}/${rows.length}`);
console.log(`  with price:         ${rows.filter(r => r.priceMin).length}/${rows.length}`);
console.log(`  with image:         ${rows.filter(r => r.imageUrl).length}/${rows.length}`);
console.log(`  with description:   ${rows.filter(r => r.description && r.description.length > 20).length}/${rows.length}`);
console.log(`  with tags:          ${rows.filter(r => r.tags.length > 0).length}/${rows.length}`);
console.log(`  with variants+sku:  ${rows.filter(r => r.variants.some(v => v.sku)).length}/${rows.length}`);
console.log(`  avg embed-text len: ${Math.round(rows.reduce((s, r) => s + r.textForEmbedding.length, 0) / rows.length)} chars`);
