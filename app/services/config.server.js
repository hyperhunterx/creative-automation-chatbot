/**
 * Configuration Service — v2.0
 * Centralizes all configuration values for the chat service
 */

export const AppConfig = {
  // API Configuration
  api: {
    defaultModel: 'claude-sonnet-4-20250514',
    maxTokens: 4096,
    defaultPromptType: 'standardAssistant',
  },

  // Error Message Templates
  errorMessages: {
    missingMessage: "Message is required",
    apiUnsupported: "This endpoint only supports server-sent events (SSE) requests or history requests.",
    authFailed: "Authentication failed with Claude API",
    apiKeyError: "Please check your API key in environment variables",
    rateLimitExceeded: "Rate limit exceeded",
    rateLimitDetails: "Please try again later",
    genericError: "Failed to get response from Claude"
  },

  // Tool Configuration
  tools: {
    productSearchName: "search_shop_catalog",
    maxProductsToDisplay: 12
  }
};

export default AppConfig;

export const RETRIEVAL_CONFIG = {
  voyageApiKey: process.env.VOYAGE_API_KEY,
  openrouterApiKey: process.env.OPENROUTER_API_KEY,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY, // fallback when OpenRouter is unavailable
  cohereApiKey: process.env.COHERE_API_KEY,
  syncSecret: process.env.SYNC_SECRET,
  // voyage-3.5-lite — same price as voyage-3-lite, same 200M free trial, but
  // supports configurable output_dimension. voyage-3-lite is locked at 512.
  embeddingModel: 'voyage-3.5-lite',
  embeddingDimensions: 1024,
  rerankModel: 'rerank-v3.5',
  // OpenRouter passes through to Anthropic models with this exact name.
  queryUnderstandingModel: 'anthropic/claude-haiku-4-5',
  candidatePoolSize: 50,
  finalResultSize: 12,
  bm25Weight: 0.4,
  vectorWeight: 0.6,
};

export function assertRetrievalConfig() {
  const missing = [];
  if (!RETRIEVAL_CONFIG.voyageApiKey) missing.push('VOYAGE_API_KEY');
  if (!RETRIEVAL_CONFIG.cohereApiKey) missing.push('COHERE_API_KEY');
  // Need at least one path to Anthropic — OpenRouter (preferred) or direct.
  if (!RETRIEVAL_CONFIG.openrouterApiKey && !RETRIEVAL_CONFIG.anthropicApiKey) {
    missing.push('OPENROUTER_API_KEY or ANTHROPIC_API_KEY');
  }
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}
