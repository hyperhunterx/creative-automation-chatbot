// scripts/probe-brand-exclude.js
// Verifies the brand_exclude SQL filter actually removes the named vendor.
// Calls hybridSearch directly with category-relaxed-style inputs.

import 'dotenv/config';
import { hybridSearch } from '../app/services/retrieval.server.js';
import prisma from '../app/db.server.js';

const vec = new Array(1024).fill(0);
vec[0] = 1;

console.log('=== Q1: hybridSearch with brand_exclude=["mindman"], category=null ===');
const r1 = await hybridSearch({
  category: null,
  brand_include: [],
  brand_exclude: ['mindman'],
  spec_values: [],
  free_text: '5/2 solenoid valve',
  query_vector: vec,
});
const mindmanCount1 = r1.filter(r => r.vendorNormalized === 'mindman').length;
console.log(`  total=${r1.length}  mindman_count=${mindmanCount1}`);
console.log(`  top 5 vendors: ${r1.slice(0, 5).map(r => r.vendorNormalized).join(', ')}`);

console.log('\n=== Q2: hybridSearch with category="solenoid valves" + brand_exclude=["mindman"] ===');
const r2 = await hybridSearch({
  category: 'solenoid valves',
  brand_include: [],
  brand_exclude: ['mindman'],
  spec_values: [],
  free_text: '5/2 solenoid valve',
  query_vector: vec,
});
const mindmanCount2 = r2.filter(r => r.vendorNormalized === 'mindman').length;
console.log(`  total=${r2.length}  mindman_count=${mindmanCount2}`);
console.log(`  top 5 vendors: ${r2.slice(0, 5).map(r => r.vendorNormalized).join(', ')}`);

console.log('\n=== Q3: Direct SQL — confirm vendorNormalized="mindman" rows exist post-update ===');
const r3 = await prisma.$queryRawUnsafe(`
  SELECT count(*)::int AS n FROM products
  WHERE "deletedAt" IS NULL AND "vendorNormalized" = 'mindman'
`);
console.log(`  rows_with_vendor_mindman=${r3[0].n}`);

console.log('\n=== Q4: Without brand_exclude — top vendors for "5/2 solenoid valve" ===');
const r4 = await hybridSearch({
  category: null,
  brand_include: [],
  brand_exclude: [],
  spec_values: [],
  free_text: '5/2 solenoid valve',
  query_vector: vec,
});
const breakdown = {};
for (const r of r4.slice(0, 20)) {
  breakdown[r.vendorNormalized] = (breakdown[r.vendorNormalized] || 0) + 1;
}
console.log(`  total=${r4.length}, top-20 vendor breakdown:`);
for (const [v, n] of Object.entries(breakdown).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(n).padStart(3)}  ${v}`);
}

await prisma.$disconnect();
