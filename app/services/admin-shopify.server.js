// app/services/admin-shopify.server.js
// Pure GraphQL-over-fetch wrapper for Shopify Admin API. Does NOT depend on
// Remix request authentication because the bootstrap script (and the cron
// reconciliation endpoint) run outside the per-request shop session lifecycle
// and authenticate with a fixed Admin access token.

const PRODUCT_NODE_FIELDS = `
  id
  handle
  title
  vendor
  productType
  tags
  descriptionHtml
  updatedAt
  featuredMedia {
    preview { image { url } }
  }
  priceRangeV2 {
    minVariantPrice { amount currencyCode }
    maxVariantPrice { amount currencyCode }
  }
  variants(first: 50) {
    nodes {
      id
      sku
      price
      availableForSale
    }
  }
  metafields(first: 50) {
    nodes {
      namespace
      key
      value
      type
    }
  }
`;

const PRODUCTS_QUERY = `
  query Products($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PRODUCT_NODE_FIELDS} }
    }
  }
`;

export function makeAdminClient({ shopDomain, accessToken, apiVersion = '2025-01' }) {
  if (!shopDomain || !accessToken) {
    throw new Error('makeAdminClient: shopDomain and accessToken are required');
  }
  const endpoint = `https://${shopDomain}/admin/api/${apiVersion}/graphql.json`;

  async function gql(query, variables) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify Admin GraphQL ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = await res.json();
    if (json.errors) {
      throw new Error(`Shopify Admin GraphQL errors: ${JSON.stringify(json.errors)}`);
    }
    return json.data;
  }

  return {
    // Iterate Shopify products in pages. The optional `query` parameter is
    // passed through to Shopify's GraphQL `products(query: ...)` filter so
    // delta syncs can scope by `updated_at:>...`, `vendor:'...'`, etc.
    // Defaults to no filter, preserving the existing bootstrap behavior.
    async *productPages({ pageSize = 250, query = null } = {}) {
      let after = null;
      while (true) {
        const data = await gql(PRODUCTS_QUERY, { first: pageSize, after, query });
        yield data.products.nodes;
        if (!data.products.pageInfo.hasNextPage) break;
        after = data.products.pageInfo.endCursor;
      }
    },
  };
}
