// app/services/query-understanding.server.js
//
// Turns a conversation transcript (plus optional "last shown" context) into a
// structured intent object the retrieval layer can act on. Powered by
// Anthropic Haiku via OpenRouter (centralised in llm.server.js).
//
// Output shape (every field always present):
//   {
//     is_search: boolean,              // true if this turn is a catalog search; false for greetings, small talk, off-topic
//     category: string | null,        // lowercase, granular tag-style, e.g. "pneumatic guided cylinders"
//     brand_include: string[],         // lowercase brand names
//     brand_exclude: string[],         // lowercase brand names
//     specs: object,
//     free_text: string                // 2-6 word search phrase, natural casing
//   }

import { chatJson } from './llm.server.js';
import { RETRIEVAL_CONFIG } from './config.server.js';

const SYSTEM_PROMPT = `You are a query-understanding component for an industrial-automation e-commerce chatbot.

Given the user's most recent message AND the prior conversation, output STRICTLY a single JSON object describing what the user is asking the catalog to find. Do not output any prose, markdown, or commentary — only valid JSON.

JSON schema (every key required; use empty arrays / empty object / null for not-present):
{
  "is_search": boolean,              // true if this turn is asking the catalog to find a product; false for chit-chat, greetings, off-topic, vague meta-questions.
  "category": string | null,        // LOWERCASE granular product category matching how the catalog tags products, e.g. "pneumatic guided cylinders", "motion control sensors", "inverter drives", "damper actuators", "sensor & actuator cables". Prefer the most specific category that fits the user's intent. Use null if the user hasn't asked about a specific product family.
  "brand_include": string[],         // LOWERCASE brand names the user wants to see; empty = any brand. Example: ["smc", "festo"]
  "brand_exclude": string[],         // LOWERCASE brand names the user does NOT want. Example: user says "from another brand" after seeing Festo → ["festo"]
  "specs": object,                   // attribute filters, flat key/value, e.g. {"bore_mm": 20}; empty if none
  "free_text": string                // 2-6 word search phrase capturing what to search. Keep dimension/spec words like "M20", "24VDC", and SKUs intact in natural casing.
}

Rules for is_search:
- TRUE when the user is asking to find / buy / browse / compare ANY catalog item — even vague queries like "show me cables" or "do you have anything for safety".
- TRUE for follow-up questions about a specific product mentioned in prior turns: "show me specs", "tell me more about it", "what's the price", "is it in stock", "what are the dimensions". These reference a real product and should trigger a search to retrieve fresh data.
- TRUE for filter-style follow-ups: "show me the cheapest one", "the most expensive", "under 1000 AED", "only the ones in stock" — these still operate on the catalog.
- FALSE for: greetings ("hi", "hello"), acknowledgements ("ok", "thanks", "got it"), pure small talk, off-topic questions ("what time is it", "how are you", "what's the weather"), meta-questions about the chatbot itself ("who are you", "how does this work"), or anything that doesn't reference a product, category, brand, SKU, spec, or shopping action.
- When unsure, prefer TRUE — a false negative (missed search) is worse than a false positive (an empty search returns gracefully).

Rules for the rest:
- ALL brand names and the category MUST be lowercase. The catalog filters on a lowercased index — mixed-case values will silently miss.
- Use the prior conversation. If the user previously asked about "M20 pneumatic guided cylinder from Smc" and now says "from another brand", category stays "pneumatic guided cylinders" and brand_exclude=["smc"].
- If you receive a "Last shown:" hint about category/brands, USE IT to anchor the current turn. The hint is already lowercase — copy it through unchanged.
- Never invent specs. If the user did not state a value, leave specs empty.
- free_text keeps its natural casing (this drives BM25 ranking on titles/SKUs).
- If is_search is false, you may still echo the user's message into free_text but the retrieval layer will ignore it.

OUTPUT JSON ONLY.`;

function buildUserMessage({ messages, lastShownCategory, lastShownBrands }) {
  const recent = messages.slice(-6);
  const transcript = recent
    .map(m => `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
    .join('\n');
  const hint = lastShownCategory
    ? `\n\nLast shown: category="${lastShownCategory}"${lastShownBrands?.length ? `, brands=${JSON.stringify(lastShownBrands)}` : ''}`
    : '';
  return `Conversation transcript:\n${transcript}${hint}\n\nReturn the JSON object now.`;
}

function fallbackIntent(rawMessage) {
  // When the LLM is unreachable we can't know intent. Default is_search to
  // true so the retrieval still runs — the regex guard in the router will
  // catch obvious greetings as a last line of defense.
  return {
    is_search: true,
    category: null,
    brand_include: [],
    brand_exclude: [],
    specs: {},
    free_text: rawMessage || '',
  };
}

function toLowerStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  const out = new Set();
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    const lower = v.trim().toLowerCase();
    if (lower) out.add(lower);
  }
  return [...out];
}

function normalize(parsed, rawMessage) {
  if (!parsed || typeof parsed !== 'object') return fallbackIntent(rawMessage);
  const categoryRaw = typeof parsed.category === 'string' ? parsed.category.trim() : '';
  const category = categoryRaw ? categoryRaw.toLowerCase() : null;
  // is_search is required in the schema; default to true if the LLM omitted it.
  const isSearch = typeof parsed.is_search === 'boolean' ? parsed.is_search : true;
  return {
    is_search: isSearch,
    category,
    brand_include: toLowerStringArray(parsed.brand_include),
    brand_exclude: toLowerStringArray(parsed.brand_exclude),
    specs: parsed.specs && typeof parsed.specs === 'object' ? parsed.specs : {},
    free_text: typeof parsed.free_text === 'string' && parsed.free_text.trim() ? parsed.free_text.trim() : (rawMessage || ''),
  };
}

export async function extractIntent({ messages, lastShownCategory = null, lastShownBrands = [] }) {
  const rawMessage = messages?.[messages.length - 1]?.content ?? '';
  try {
    const parsed = await chatJson({
      model: RETRIEVAL_CONFIG.queryUnderstandingModel,
      system: SYSTEM_PROMPT,
      user: buildUserMessage({ messages, lastShownCategory, lastShownBrands }),
      maxTokens: 256,
      temperature: 0,
      timeoutMs: 5000,
    });
    return normalize(parsed, rawMessage);
  } catch (err) {
    console.warn('[query-understanding] failed, using fallback:', err.message);
    return fallbackIntent(rawMessage);
  }
}
