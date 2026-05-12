// app/routes/api.v6-search.jsx
//
// POST endpoint that runs the v6 retrieval pipeline and returns JSON.
// Used by the /test-chat page for bake-off demos. Bypasses the v5 MCP
// catalog tool and Claude — purely tests the v6 search router.

import { smartSearch } from "../services/search-router.server.js";

function cors(req) {
  const origin = req.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

export const action = async ({ request }) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors(request) });
  }
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: cors(request),
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid JSON" }), {
      status: 400,
      headers: cors(request),
    });
  }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastShownCategory = body.lastShownCategory ?? null;
  const lastShownBrands = Array.isArray(body.lastShownBrands) ? body.lastShownBrands : [];

  const startedAt = Date.now();
  const result = await smartSearch({ messages, lastShownCategory, lastShownBrands });
  const elapsedMs = Date.now() - startedAt;

  return new Response(
    JSON.stringify({
      ok: true,
      elapsedMs,
      searchType: result.searchType,
      intent: result.intent,
      products: result.products,
      systemHint: result.systemHint,
    }),
    { status: 200, headers: cors(request) },
  );
};

export const loader = ({ request }) =>
  new Response(JSON.stringify({ status: "ok", endpoint: "v6-search", method: "POST only" }), {
    headers: cors(request),
  });
