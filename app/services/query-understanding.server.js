// app/services/query-understanding.server.js
//
// Turns a conversation transcript (plus optional "last shown" context) into a
// structured intent object the retrieval layer can act on. Powered by
// Anthropic Haiku via OpenRouter (centralised in llm.server.js).
//
// Output shape (every field always present):
//   {
//     category: string | null,
//     brand_include: string[],
//     brand_exclude: string[],
//     specs: object,
//     free_text: string
//   }

import { chatJson } from './llm.server.js';
import { RETRIEVAL_CONFIG } from './config.server.js';

const SYSTEM_PROMPT = `You are a query-understanding component for an industrial-automation e-commerce chatbot.

Given the user's most recent message AND the prior conversation, output STRICTLY a single JSON object describing what the user is asking the catalog to find. Do not output any prose, markdown, or commentary — only valid JSON.

JSON schema (every key required, use empty arrays / empty object / null for not-present):
{
  "category": string | null,        // canonical product category, e.g. "Pneumatic Cylinder", "Circuit Breaker", "Relay"
  "brand_include": string[],         // brands the user wants to see; empty = any brand
  "brand_exclude": string[],         // brands the user does NOT want; e.g. "another brand than X" → ["X"]
  "specs": object,                   // attribute filters as flat key-value, e.g. {"bore_mm": 20}; empty if none
  "free_text": string                // a cleaned 2-6 word search phrase capturing what to search
}

Rules:
- Use the prior conversation. If the user previously asked about "M20 cylinder from Festo" and now says "from another brand", category stays "Pneumatic Cylinder" and brand_exclude=["Festo"].
- If you receive a "Last shown:" hint about category/brands, USE IT to anchor the current turn.
- Never invent specs. If the user did not state a value, leave specs empty.
- free_text should keep dimension/spec words like "M20", "24VDC", or SKUs intact.
- If the user is just chatting (greeting, thanks, etc.) return all empty fields with free_text equal to the raw message.

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
  return {
    category: null,
    brand_include: [],
    brand_exclude: [],
    specs: {},
    free_text: rawMessage || '',
  };
}

function normalize(parsed, rawMessage) {
  if (!parsed || typeof parsed !== 'object') return fallbackIntent(rawMessage);
  return {
    category: typeof parsed.category === 'string' && parsed.category.trim() ? parsed.category.trim() : null,
    brand_include: Array.isArray(parsed.brand_include) ? parsed.brand_include.filter(b => typeof b === 'string') : [],
    brand_exclude: Array.isArray(parsed.brand_exclude) ? parsed.brand_exclude.filter(b => typeof b === 'string') : [],
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
