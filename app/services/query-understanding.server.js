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
//     specs: object,                   // unused (legacy slot); use spec_values for filtering
//     spec_values: string[],           // exact spec values to filter on — e.g. ["5/2"] for port config, ["24V"] for voltage
//     free_text: string                // 2-6 word search phrase, natural casing
//   }

import { chatJson } from './llm.server.js';
import { RETRIEVAL_CONFIG } from './config.server.js';

const SYSTEM_PROMPT = `You are a query-understanding component for an industrial-automation e-commerce chatbot.

Given the user's most recent message AND the prior conversation, output STRICTLY a single JSON object describing what the user is asking the catalog to find. Do not output any prose, markdown, or commentary — only valid JSON.

JSON schema (every key required; use empty arrays / empty object / null for not-present):
{
  "is_search": boolean,              // true if this turn is asking the catalog to find a product; false for chit-chat, greetings, off-topic, vague meta-questions.
  "category": string | null,        // LOWERCASE granular product category matching how the catalog tags products. Examples actually present in the catalog: "pneumatic guided cylinders", "motion control sensors", "inverter drives", "damper actuators", "sensor & actuator cables", "ethernet cable", "ethernet connectors", "limit switches", "solenoid valves", "circuit breakers", "proximity sensors", "safety interlock switches", "terminal blocks", "power supplies", "relays", "contactors", "encoders", "heat shrink boots", "pneumatic fittings". When the user explicitly names a product type ("ethernet cable", "limit switch", "proximity sensor"), that wording is the category — extract it verbatim in lowercase, do NOT swap it for a similar-sounding category from carry-over. Prefer the most specific category that fits the user's intent. Use null if the user hasn't asked about a specific product family.
  "brand_include": string[],         // LOWERCASE brand names the user wants to see; empty = any brand. Example: ["smc", "festo"]
  "brand_exclude": string[],         // LOWERCASE brand names the user does NOT want. Example: user says "from another brand" after seeing Festo → ["festo"]
  "specs": object,                   // legacy slot; leave empty {} unless specifically asked to use it
  "spec_values": string[],           // EXACT spec values to filter on. The catalog stores rich metafields per product (Type, Supply Voltage, Number of Ports, Connection Size, Body Material, Country of Origin, etc.). Put just the VALUE here — the retrieval layer matches it against any metafield value. Examples: user says "5/2 solenoid valve" → ["5/2"]. User says "24V" or "24 V ac" → ["24V"] or ["24 V ac"] (use the canonical form most likely to appear in spec sheets). User says "G 1/4 thread" → ["G 1/4"]. User says "made in Germany" → ["Germany"]. Empty array if no spec filter applies.
  "free_text": string                // 2-6 word search phrase capturing what to search. Keep dimension/spec words like "M20", "24VDC", and SKUs intact in natural casing.
}

Rules for is_search — the test is "does the page need a NEW set of product cards?":
- TRUE when the user is asking to BROWSE / FIND a new or different set of products: "show me cables", "do you have any safety items", "I need a 24V contactor", "from Festo", or filter changes that meaningfully shift the result set: "another brand", "cheaper alternatives", "smaller bore", "different category".
- TRUE — ALWAYS — when the user's message contains a specific product SKU or part number that is NOT already in the recent_conversation. Even if the framing is a question ("what's the spec of X12345", "is X12345 in stock", "country of origin of X12345"), we need to retrieve that product first so the reply can ground in real data. Put the SKU in free_text. A SKU looks like an alphanumeric code with digits, often hyphens or letters mixed (e.g. DUS60E, R412006219, AF26-40-00-14, 1SBL237201R1400, MXZ20-20).
- FALSE when the user is asking ABOUT products already shown in this conversation, with no new SKU mentioned. The cards stay, the reply answers from the prior context. Examples that MUST be FALSE: "tell me more about it", "what's its manufacturer series", "what's the price", "what spec", "is it in stock", "what colors", "what dimensions", "the cheapest one", "the most expensive one", "compare them", "which one for X application".
- FALSE for greetings ("hi", "hello"), acknowledgements ("ok", "thanks", "got it"), pure small talk, off-topic questions ("what time is it", "how are you"), meta-questions about the chatbot itself ("who are you", "how does this work"), or cart/checkout actions.
- Tie-breakers: if the user references a previously-shown product implicitly ("it", "that one", "this", "the one above", "the third one") and no new SKU is mentioned, prefer FALSE. If a SKU or product name not in recent_conversation appears, prefer TRUE.
- When still unsure, prefer FALSE — showing irrelevant cards on a Q&A turn looks worse than answering in text on a search turn.

Rules for the rest:
- ALL brand names and the category MUST be lowercase. The catalog filters on a lowercased index — mixed-case values will silently miss.
- Use the prior conversation. If the user previously asked about "M20 pneumatic guided cylinder from Smc" and now says "from another brand", category stays "pneumatic guided cylinders" and brand_exclude=["smc"].
- The "Last shown:" hint fills in MISSING context only — it does NOT override what the new turn explicitly says. Examples:
    - Prior: "Last shown: category=sensor & actuator cables". User now says "ifm ethernet cable" → category="ethernet cable" (new turn names a different product type, IGNORE the hint).
    - Prior: "Last shown: category=inverter drives". User now says "DUS60E" (a SKU) → category=null (specific SKU overrides topical context).
    - Prior: "Last shown: category=solenoid valves, brands=[festo]". User now says "show me another brand" → category="solenoid valves", brand_exclude=["festo"] (no new product type, use carry-over).
- If a hint matches the new turn's intent, copy it through unchanged. If it conflicts, follow the new turn.
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
    spec_values: [],
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

function trimmedStringArray(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (!trimmed) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
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
    spec_values: trimmedStringArray(parsed.spec_values),
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
