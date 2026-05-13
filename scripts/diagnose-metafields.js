// scripts/diagnose-metafields.js
// Fetches one known product (the Burkert 5/2 valve from the manager demo)
// and prints the raw metafields response. Tells us whether the API is
// returning the metafields we need OR if the scope is missing.

import 'dotenv/config';

const shop = process.env.SHOPIFY_SHOP_DOMAIN;
const token = process.env.SHOPIFY_ADMIN_TOKEN;
if (!shop || !token) {
  console.error('Missing SHOPIFY_SHOP_DOMAIN or SHOPIFY_ADMIN_TOKEN');
  process.exit(1);
}

const endpoint = `https://${shop}/admin/api/2025-01/graphql.json`;

async function gql(query, variables = {}) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  return { ok: res.ok, status: res.status, json };
}

console.log(`Probing metafields access on ${shop}...\n`);

// First: try a known product handle from the manager demo
const handleQuery = `
  query($handle: String!) {
    productByHandle(handle: $handle) {
      id
      title
      metafields(first: 50) {
        nodes { namespace key value type }
      }
    }
  }
`;
const handle = process.argv[2] || 'burkert-solenoid-valves-125334';
const r1 = await gql(handleQuery, { handle });
console.log(`Attempt 1: productByHandle("${handle}")`);
console.log(`  Status: ${r1.status}`);
if (r1.json.errors) {
  console.log(`  Errors:`, JSON.stringify(r1.json.errors, null, 2));
}
const p = r1.json?.data?.productByHandle;
if (!p) {
  console.log(`  No product found at that handle. Trying first-1 products instead...\n`);
} else {
  console.log(`  Product: ${p.title}`);
  console.log(`  Metafields count: ${p.metafields?.nodes?.length ?? 0}`);
  if (p.metafields?.nodes?.length) {
    console.log(`  First 5 metafields:`);
    for (const m of p.metafields.nodes.slice(0, 5)) {
      console.log(`    - ${m.namespace}.${m.key} (${m.type}) = ${String(m.value).slice(0, 80)}`);
    }
  }
}

// Second: grab any product that has metafields, regardless of handle
const anyQuery = `
  query {
    products(first: 5, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id
        title
        vendor
        metafields(first: 50) { nodes { namespace key value type } }
      }
    }
  }
`;
console.log(`\nAttempt 2: 5 most-recently-updated products`);
const r2 = await gql(anyQuery);
console.log(`  Status: ${r2.status}`);
if (r2.json.errors) {
  console.log(`  Errors:`, JSON.stringify(r2.json.errors, null, 2));
}
for (const p of r2.json?.data?.products?.nodes ?? []) {
  console.log(`  - ${p.title} (vendor=${p.vendor}) — metafields: ${p.metafields?.nodes?.length ?? 0}`);
  if (p.metafields?.nodes?.length) {
    for (const m of p.metafields.nodes.slice(0, 3)) {
      console.log(`      ${m.namespace}.${m.key} = ${String(m.value).slice(0, 60)}`);
    }
  }
}

// Third: confirm what scopes the current token actually has
const scopeQuery = `{ currentAppInstallation { accessScopes { handle } } }`;
console.log(`\nAttempt 3: scopes attached to this token`);
const r3 = await gql(scopeQuery);
if (r3.json.errors) {
  console.log(`  Errors:`, JSON.stringify(r3.json.errors, null, 2));
} else {
  const scopes = r3.json?.data?.currentAppInstallation?.accessScopes?.map(s => s.handle) ?? [];
  console.log(`  Scopes (${scopes.length}):`, scopes.join(', '));
  if (!scopes.some(s => s.includes('metafield'))) {
    console.log(`\n  ⚠ No "metafields" scope present. This is the bug.`);
    console.log(`  Add "read_product_metafields" to the Dev Dashboard app, reinstall on the shop, refresh the token.`);
  }
}
