// app/services/storefront-paginate.server.js
//
// Storefront API client specifically for paginated full-catalog enumeration
// (bootstrap + nightly sync). Different from the existing app/shopify-storefront.js
// which is wired for the v5 `search` query path and auto-creates Storefront
// tokens via Admin REST. Here we use a static `shpss_` token from env vars,
// which is exactly what's already sitting in Railway.
//
// Endpoint: https://{shop}.myshopify.com/api/{version}/graphql.json
// Auth header: X-Shopify-Storefront-Access-Token: shpss_...

const STOREFRONT_PRODUCTS_QUERY = `
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
        featuredImage { url }
        priceRange {
          minVariantPrice { amount currencyCode }
          maxVariantPrice { amount currencyCode }
        }
        variants(first: 50) {
          nodes {
            id
            sku
            price { amount currencyCode }
            availableForSale
          }
        }
      }
    }
  }
`;

export function makeStorefrontClient({ shopDomain, storefrontToken, apiVersion = '2025-01' }) {
  if (!shopDomain || !storefrontToken) {
    throw new Error('makeStorefrontClient: shopDomain and storefrontToken are required');
  }
  const endpoint = `https://${shopDomain}/api/${apiVersion}/graphql.json`;

  async function gql(query, variables) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Storefront-Access-Token': storefrontToken,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Shopify Storefront ${res.status}: ${body.slice(0, 500)}`);
    }
    const json = await res.json();
    if (json.errors) {
      throw new Error(`Shopify Storefront errors: ${JSON.stringify(json.errors)}`);
    }
    return json.data;
  }

  return {
    async *productPages({ pageSize = 250 } = {}) {
      let after = null;
      while (true) {
        const data = await gql(STOREFRONT_PRODUCTS_QUERY, { first: pageSize, after });
        yield data.products.nodes;
        if (!data.products.pageInfo.hasNextPage) break;
        after = data.products.pageInfo.endCursor;
      }
    },
  };
}
