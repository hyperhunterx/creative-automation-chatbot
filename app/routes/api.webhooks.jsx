import { authenticate } from "../shopify.server";
import db from "../db.server";
import { upsertProductFromShopify, softDeleteProduct } from "../services/product-index.server.js";
import { normalizeRestProduct } from "../services/webhook-payload.server.js";

export const action = async ({ request }) => {
  const { shop, session, topic, payload } = await authenticate.webhook(request);

  console.log(`[webhook] Received ${topic} for ${shop}`);

  try {
    switch (topic) {
      case 'APP_UNINSTALLED':
        if (session) {
          await db.session.deleteMany({ where: { shop } });
        }
        return new Response();

      case 'PRODUCTS_CREATE':
      case 'PRODUCTS_UPDATE':
        await upsertProductFromShopify(normalizeRestProduct(payload));
        return new Response();

      case 'PRODUCTS_DELETE':
        // Delete payload only carries the integer id
        await softDeleteProduct(`gid://shopify/Product/${payload.id}`);
        return new Response();

      case 'INVENTORY_LEVELS_UPDATE':
        // Inventory webhook tells us a variant changed availability.
        // Simpler v1 implementation: log and let the nightly sync correct.
        // Full inventory-aware re-index lands in v1.1.
        console.log(`[webhook] inventory update logged — full handling in v1.1`);
        return new Response();

      default:
        throw new Response('Unhandled webhook topic', { status: 404 });
    }
  } catch (err) {
    console.error(`[webhook] ${topic} handler failed:`, err);
    // Return 500 so Shopify retries.
    return new Response(`Handler error: ${err.message}`, { status: 500 });
  }
};
