// app/services/llm.server.js
//
// Single gateway for all LLM calls. Routes through OpenRouter via the
// OpenAI-compatible chat-completions API. Models are passed as OpenRouter-
// format strings:
//   - 'anthropic/claude-haiku-4-5'
//   - 'anthropic/claude-sonnet-4-6'
//
// The Anthropic SDK does not support custom base URLs, which is why we use
// the OpenAI SDK pointed at OpenRouter.

import OpenAI from 'openai';
import { RETRIEVAL_CONFIG } from './config.server.js';

let client = null;

function getClient() {
  if (client) return client;
  // Read process.env directly so callers can swap credentials at runtime
  // (and tests that delete env vars between cases are honored).
  const orKey = process.env.OPENROUTER_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (orKey) {
    client = new OpenAI({
      apiKey: orKey,
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        // OpenRouter recommends these for analytics; harmless if omitted.
        'HTTP-Referer': 'https://creativeautomation.ae',
        'X-Title': 'Creative Automation Chatbot',
      },
    });
    return client;
  }
  if (anthropicKey) {
    // No Anthropic-native chat-completions in this gateway yet; once we add
    // a direct-Anthropic fallback path it goes here. For now, fail clearly
    // pointing to OpenRouter as the v1 path.
    throw new Error(
      'OPENROUTER_API_KEY not set. Direct ANTHROPIC_API_KEY fallback for this gateway is not yet implemented.'
    );
  }
  throw new Error(
    'No LLM credential configured. Set OPENROUTER_API_KEY (preferred) or ANTHROPIC_API_KEY.'
  );
}

function safeParseJson(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Chat completion that returns parsed JSON (or null on parse failure).
 *
 * @param {object} args
 * @param {string} args.model       e.g. 'anthropic/claude-haiku-4-5'
 * @param {string} args.system      system prompt
 * @param {string} args.user        single user-turn content
 * @param {number} [args.maxTokens] default 512
 * @param {number} [args.temperature] default 0
 * @param {number} [args.timeoutMs]  default 5000
 */
export async function chatJson({
  model,
  system,
  user,
  maxTokens = 512,
  temperature = 0,
  timeoutMs = 5000,
}) {
  const c = getClient();
  const response = await Promise.race([
    c.chat.completions.create({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
    new Promise((_, r) => setTimeout(() => r(new Error('llm timeout')), timeoutMs)),
  ]);
  const text = response?.choices?.[0]?.message?.content ?? '';
  return safeParseJson(text);
}
