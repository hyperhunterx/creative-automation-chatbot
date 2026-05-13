// app/routes/api.v6-search.jsx
//
// POST endpoint that runs the v6 retrieval pipeline and returns JSON.
// Used by the /test-chat page for bake-off demos. Bypasses the v5 MCP
// catalog tool but does call Haiku for a short natural-language reply
// so the demo feels like a real conversation, not a debug printout.

import { smartSearch } from "../services/search-router.server.js";
import { chatText } from "../services/llm.server.js";
import { RETRIEVAL_CONFIG } from "../services/config.server.js";

const REPLY_SYSTEM_PROMPT = `You are the AI sales assistant for Creative Industrial Automation L.L.C, a UAE-based industrial automation supplier. You speak to engineers, procurement staff, and maintenance buyers.

Rules:
- Reply in 1-2 short sentences. No bullet lists, no markdown tables, no SKU dumps.
- Product cards are already displayed in the UI — do not describe individual products. Acknowledge the result and offer one helpful next step.
- The "count" you see is the number of TOP MATCHES shown on the page, NOT the total stock. Phrase accordingly: say "here are 12 top matches", "showing the top 12", or "12 closest matches" — NEVER "we have 12 in stock" or "we found 12 X" (which implies 12 is the total catalog count for that product family).
- Mention the product family and (if relevant) which brand(s) are present.
- If brand_exclude is set ("from another brand"), acknowledge that you swapped brands while keeping the same product family.
- If sku_lookup_no_exact_match is true, the user typed a specific SKU that is NOT in our catalog — the cards shown are RELATED items, not the requested SKU. State this clearly: "We don't carry SKU X, but here are related products from our catalog" or similar. Do NOT claim we found results "for" the SKU. Offer sales contact for sourcing the exact part.
- For price questions ("cheapest", "lowest", "under X"): use the price_stats provided — they are computed from the FULL result set, not just what you can see. Quote the exact cheapest_title and cheapest_price.
- For SPEC questions (manufacturer series, country of origin, voltage rating, IP rating, dimensions, datasheet, etc.) when products WERE found: acknowledge the product exists in our catalog by name/SKU, then state we don't have its full datasheet indexed yet and offer to connect with sales (websales@creativeautomation.ae) for the spec details. Do NOT invent specs or guess. Example: "Yes, R412006219 is in our catalog — for the manufacturer series and country of origin, let me connect you with our sales team at websales@creativeautomation.ae who can pull the full datasheet."
- If 0 products found AND this is a brand new search topic AND recent_conversation has no relevant products, say the item isn't in our catalog and offer sales (websales@creativeautomation.ae).
- If is_search=false AND recent_conversation shows products were already presented: this is a Q&A follow-up. Answer the user's question using what's in the recent_conversation. Do NOT say "we don't stock", do NOT mention sales contact. Examples:
    - "what's its manufacturer series" → identify the series from the prior product title/SKU and answer
    - "the cheapest one" → identify the cheapest from prior products and quote it
    - "tell me more about it" → reference the prior product and offer to fetch specs / connect with sales for full datasheet
- If is_search=false AND no products in recent_conversation either (greeting/chit-chat/off-topic): respond naturally and briefly. For greetings, welcome them. For off-topic, politely steer back to industrial-automation help.
- Never invent products, specs, prices, or URLs. Use ONLY the data in the JSON or what was clearly stated in recent_conversation.
- Tone: confident, technical, concise. Not chatty.`;

function computePriceStats(products) {
  const priced = products
    .map((p) => ({
      title: p.title,
      vendor: p.vendor,
      price: p.priceMin == null ? null : Number(p.priceMin),
      currency: p.currency || null,
    }))
    .filter((p) => p.price != null && !Number.isNaN(p.price));
  if (priced.length === 0) return null;
  priced.sort((a, b) => a.price - b.price);
  const cheapest = priced[0];
  const priciest = priced[priced.length - 1];
  return {
    min_price: cheapest.price,
    max_price: priciest.price,
    currency: cheapest.currency,
    cheapest_title: cheapest.title,
    cheapest_vendor: cheapest.vendor,
    priciest_title: priciest.title,
  };
}

function buildReplyUserPrompt({ userMessage, messages, products, intent, searchType, skuLookupNoExactMatch, skuTokens }) {
  // Pass ALL returned products (capped at 12, which is finalResultSize). The
  // LLM needs visibility into the full set so price/spec-based reasoning is
  // grounded in real data, not the first few results by relevance.
  const productList = products.slice(0, 12).map((p) => ({
    title: p.title,
    vendor: p.vendor,
    price: p.priceMin ? `${p.priceMin} ${p.currency || ""}`.trim() : null,
  }));
  // Pass recent conversation (excluding the current user turn — that's in
  // user_message). Truncate to last 4 turns to keep token cost down. Assistant
  // messages let the LLM ground follow-up questions in what we already showed.
  const recent = (messages || [])
    .slice(0, -1)
    .slice(-4)
    .map((m) => ({
      role: m.role,
      content: typeof m.content === "string" ? m.content.slice(0, 600) : "",
    }));
  return JSON.stringify(
    {
      user_message: userMessage,
      recent_conversation: recent,
      search_result: {
        searchType,
        intent: {
          is_search: intent.is_search,
          category: intent.category,
          brand_include: intent.brand_include,
          brand_exclude: intent.brand_exclude,
        },
        count: products.length,
        sku_lookup_no_exact_match: Boolean(skuLookupNoExactMatch),
        requested_sku: skuTokens && skuTokens.length > 0 ? skuTokens.join(", ") : null,
        products: productList,
        price_stats: computePriceStats(products),
      },
      task: "Write the 1-2 sentence reply now.",
    },
    null,
    2,
  );
}

async function generateReply({ userMessage, messages, products, intent, searchType, skuLookupNoExactMatch, skuTokens }) {
  const text = await chatText({
    model: RETRIEVAL_CONFIG.queryUnderstandingModel,
    system: REPLY_SYSTEM_PROMPT,
    user: buildReplyUserPrompt({ userMessage, messages, products, intent, searchType, skuLookupNoExactMatch, skuTokens }),
    maxTokens: 180,
    temperature: 0.4,
    timeoutMs: 6000,
  });
  if (text) return text;
  // Fallback if the LLM is unreachable — produce something usable, not silence.
  if (searchType === "non_search") return "Happy to help — what are you looking for today?";
  if (skuLookupNoExactMatch && skuTokens?.length) {
    return `We don't carry SKU ${skuTokens.join(", ")} in our catalog. Showing ${products.length} related products — want me to connect you with sales at websales@creativeautomation.ae for sourcing?`;
  }
  if (products.length === 0) return `I couldn't find anything matching "${intent.free_text}" in our catalog. Want me to connect you with our sales team at websales@creativeautomation.ae?`;
  const brandLine = intent.brand_exclude?.length
    ? ` from brands other than ${intent.brand_exclude.join(", ")}`
    : intent.brand_include?.length
    ? ` from ${intent.brand_include.join(", ")}`
    : "";
  const catLine = intent.category ? ` ${intent.category}` : " products";
  return `Here are ${products.length} top${catLine} matches${brandLine} — see the cards above.`;
}

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
  const searchMs = Date.now() - startedAt;

  // Generate the natural reply alongside (parallel) — but smartSearch already
  // ran, so just do it serially. ~500-1000ms additional via Haiku.
  const userMessage = messages[messages.length - 1]?.content || "";
  const reply = await generateReply({
    userMessage,
    messages,
    products: result.products,
    intent: result.intent,
    searchType: result.searchType,
    skuLookupNoExactMatch: result.skuLookupNoExactMatch,
    skuTokens: result.skuTokens,
  });
  const elapsedMs = Date.now() - startedAt;

  return new Response(
    JSON.stringify({
      ok: true,
      elapsedMs,
      searchMs,
      replyMs: elapsedMs - searchMs,
      searchType: result.searchType,
      intent: result.intent,
      products: result.products,
      reply,
      systemHint: result.systemHint,
    }),
    { status: 200, headers: cors(request) },
  );
};

export const loader = ({ request }) =>
  new Response(JSON.stringify({ status: "ok", endpoint: "v6-search", method: "POST only" }), {
    headers: cors(request),
  });
