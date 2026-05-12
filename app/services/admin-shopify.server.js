// app/services/admin-shopify.server.js
// Pure GraphQL-over-fetch wrapper for Shopify Admin API. Does NOT depend on
// Remix request authentication because the bootstrap script (and the cron
// reconciliation endpoint) run outside the per-request shop session lifecycle
// and authenticate with a fixed Admin access token.

const PRODUCTS_QUERY = `
  query Products($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
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
      }
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
    async *productPages({ pageSize = 250 } = {}) {
      let after = null;
      while (true) {
        const data = await gql(PRODUCTS_QUERY, { first: pageSize, after });
        yield data.products.nodes;
        if (!data.products.pageInfo.hasNextPage) break;
        after = data.products.pageInfo.endCursor;
      }
    },
  };
}
