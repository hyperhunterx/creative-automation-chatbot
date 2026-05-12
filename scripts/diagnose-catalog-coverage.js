// scripts/diagnose-catalog-coverage.js
// Sample N products and report metadata coverage broken down by vendor.
// Helps us decide whether v6 retrieval will work on the real catalog before
// we commit 30 minutes of embeddings.

import 'dotenv/config';
import { makeAdminClient } from '../app/services/admin-shopify.server.js';
import { extractProductRow } from '../app/services/product-extractor.server.js';

const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE || 500);

const client = makeAdminClient({
  shopDomain: process.env.SHOPIFY_SHOP_DOMAIN,
  accessToken: process.env.SHOPIFY_ADMIN_TOKEN,
});

const rows = [];
for await (const page of client.productPages({ pageSize: 250 })) {
  for (const p of page) {
    rows.push(extractProductRow(p));
    if (rows.length >= SAMPLE_SIZE) break;
  }
  if (rows.length >= SAMPLE_SIZE) break;
}

console.log(`\nSampled ${rows.length} products.\n`);

// Overall coverage
const has = pred => rows.filter(pred).length;
const pct = n => `${((n / rows.length) * 100).toFixed(1)}%`;
console.log('Overall coverage:');
console.log(`  vendor:                 ${has(r => r.vendor)} (${pct(has(r => r.vendor))})`);
console.log(`  productType:            ${has(r => r.productType)} (${pct(has(r => r.productType))})`);
console.log(`  tags (>=1):             ${has(r => r.tags.length > 0)} (${pct(has(r => r.tags.length > 0))})`);
console.log(`  price:                  ${has(r => r.priceMin)} (${pct(has(r => r.priceMin))})`);
console.log(`  image:                  ${has(r => r.imageUrl)} (${pct(has(r => r.imageUrl))})`);
console.log(`  description (>20 char): ${has(r => r.description.length > 20)} (${pct(has(r => r.description.length > 20))})`);
console.log(`  variants with sku:      ${has(r => r.variants.some(v => v.sku))} (${pct(has(r => r.variants.some(v => v.sku)))})`);

// Top vendors and their coverage
const byVendor = new Map();
for (const r of rows) {
  const v = r.vendor || '(no vendor)';
  if (!byVendor.has(v)) byVendor.set(v, []);
  byVendor.get(v).push(r);
}
const sortedVendors = [...byVendor.entries()].sort((a, b) => b[1].length - a[1].length);

console.log(`\nTop vendors by count (out of ${byVendor.size} distinct):`);
for (const [vendor, vrows] of sortedVendors.slice(0, 15)) {
  const withType = vrows.filter(r => r.productType).length;
  const withTags = vrows.filter(r => r.tags.length > 0).length;
  console.log(`  ${vendor.padEnd(30)} count=${String(vrows.length).padStart(4)}  productType=${pct(withType / vrows.length * rows.length)}  tags=${pct(withTags / vrows.length * rows.length)}`);
}

// Top productTypes
const byType = new Map();
for (const r of rows) {
  const t = r.productType || '(null)';
  byType.set(t, (byType.get(t) || 0) + 1);
}
const sortedTypes = [...byType.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\nTop productTypes (out of ${byType.size} distinct):`);
for (const [type, count] of sortedTypes.slice(0, 15)) {
  console.log(`  ${type.padEnd(40)} ${count} (${pct(count)})`);
}

// Embedding text length distribution
const lens = rows.map(r => r.textForEmbedding.length).sort((a, b) => a - b);
const q = p => lens[Math.floor(lens.length * p)];
console.log(`\nembed-text length: p10=${q(0.1)} p50=${q(0.5)} p90=${q(0.9)} p99=${q(0.99)} max=${lens[lens.length - 1]}`);
