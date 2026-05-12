// tests/eval/run.js
//
// Runs all cases in cases.json through the live pipeline against the real
// catalog and prints a pass/fail summary. Requires:
//   EVAL=1, DATABASE_URL, VOYAGE_API_KEY, COHERE_API_KEY, OPENROUTER_API_KEY
//
// Usage:  npm run eval
//
// Exits non-zero if any case fails.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { smartSearch } from '../../app/services/search-router.server.js';

if (process.env.EVAL !== '1') {
  console.error('Set EVAL=1 to run the eval (use: npm run eval).');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8'));

function fail(testName, reason) {
  console.error(`X ${testName} — ${reason}`);
  return false;
}
function pass(testName) {
  console.log(`✓ ${testName}`);
  return true;
}

function evaluate(testCase, result) {
  const e = testCase.expect || {};
  if (e.minResults != null && result.products.length < e.minResults)
    return fail(testCase.name, `expected at least ${e.minResults} results, got ${result.products.length}`);
  if (e.maxResults != null && result.products.length > e.maxResults)
    return fail(testCase.name, `expected at most ${e.maxResults} results, got ${result.products.length}`);
  if (e.category && result.intent.category !== e.category)
    return fail(testCase.name, `expected intent.category=${e.category}, got ${result.intent.category}`);
  if (e.vendorIncludes && !result.products.some(p => p.vendor === e.vendorIncludes))
    return fail(testCase.name, `expected at least one product with vendor=${e.vendorIncludes}`);
  if (Array.isArray(e.vendorExcludes)) {
    const bad = result.products.find(p => e.vendorExcludes.includes(p.vendor));
    if (bad) return fail(testCase.name, `found excluded vendor ${bad.vendor} in results`);
  }
  if (e.categoryHomogeneous && result.products.length > 1) {
    const cats = new Set(result.products.map(p => p.category).filter(Boolean));
    if (cats.size > 1) return fail(testCase.name, `expected single category, got ${[...cats].join(', ')}`);
  }
  if (e.topMatchSkuContains) {
    const top = result.products[0];
    const variants = top?.variants;
    const arr = Array.isArray(variants) ? variants : (variants?.nodes || []);
    const skus = arr.map(v => v?.sku).filter(Boolean).join(',');
    if (!skus.includes(e.topMatchSkuContains))
      return fail(testCase.name, `expected top SKU to contain ${e.topMatchSkuContains}, got [${skus}]`);
  }
  return pass(testCase.name);
}

let failures = 0;
for (const c of cases) {
  let result;
  try {
    result = await smartSearch({
      messages: c.messages,
      lastShownCategory: c.lastShownCategory ?? null,
      lastShownBrands: c.lastShownBrands ?? [],
    });
  } catch (err) {
    failures += 1;
    console.error(`X ${c.name} — pipeline threw: ${err.message}`);
    continue;
  }
  if (!evaluate(c, result)) failures += 1;
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures === 0 ? 0 : 1);
