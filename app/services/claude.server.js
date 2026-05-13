// app/services/claude.server.js
/**
 * Claude Service — v4.0
 *
 * CHANGES (v4.0 — May 7, 2026):
 *
 * 1. SYSTEM PROMPT: Added RULE 15 — NEVER claim products were found unless
 *    the tool response explicitly contains products. QA test revealed Claude
 *    was saying "Found 10 results. Browse the cards above." when the tool
 *    returned zero results (after the strict gate filtered them out).
 *    This happened because the stop-hint injected by chat.jsx said
 *    "products: [], _system_hint: try again" — Claude interpreted the
 *    retry hint as a sign that it should tell the user results existed.
 *
 * 2. SYSTEM PROMPT: Added RULE 16 — when products are NOT found after
 *    retries, Claude must NOT say "browse the cards above" or reference
 *    cards. It should say "I couldn't find that exact product" and offer
 *    alternatives.
 *
 * 3. SYSTEM PROMPT: Refined category search strategy — when searching
 *    broad categories like "pneumatic cylinder", Claude should search
 *    the specific product type, not the broad category.
 *
 * PREVIOUS CHANGES:
 * v3.0 (April 30, 2026): Model upgrade to claude-sonnet-4-6, multilingual,
 *   clarification handling
 * v2.2 (April 30, 2026): Rules 11/12 (no narration, cards as truth)
 * v2.1 (April 2026): Removed hardcoded tool name
 */
import Anthropic from "@anthropic-ai/sdk";

export function createClaudeService() {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not found in environment variables");
    throw new Error("ANTHROPIC_API_KEY is not configured");
  }

  const client = new Anthropic({ apiKey });

  return {
    async streamConversation(config, callbacks) {
      const { messages, promptType = "standardAssistant", tools = [] } = config;
      const { onText, onMessage, onToolUse, onContentBlock } = callbacks;

      try {
        const systemPrompt = getSystemPrompt(promptType);

        const apiParams = {
          model: "claude-sonnet-4-6",
          max_tokens: 4096,
          system: systemPrompt,
          messages,
          stream: true,
        };

        if (tools && tools.length > 0) {
          apiParams.tools = tools;
        }

        console.log(`[Claude] Calling API | model=${apiParams.model} | messages=${messages.length} | tools=${(tools || []).length}`);

        const stream = await client.messages.stream(apiParams);

        let currentMessage = {
          role: "assistant",
          content: [],
          stop_reason: null,
        };

        stream.on("text", (textDelta) => {
          if (onText) onText(textDelta);
        });

        stream.on("content_block_stop", (event) => {
          if (onContentBlock) onContentBlock(event.content_block);
        });

        stream.on("message_delta", (event) => {
          if (event.delta?.stop_reason) {
            currentMessage.stop_reason = event.delta.stop_reason;
          }
        });

        const finalMessage = await stream.finalMessage();
        currentMessage.content = finalMessage.content;
        currentMessage.stop_reason = finalMessage.stop_reason;

        console.log(`[Claude] Response received | stop_reason=${currentMessage.stop_reason} | blocks=${Array.isArray(finalMessage.content) ? finalMessage.content.length : 1}`);

        if (onMessage) await onMessage(currentMessage);

        const toolUses = (finalMessage.content || []).filter((c) => c.type === "tool_use");
        for (const toolUse of toolUses) {
          if (onToolUse) await onToolUse(toolUse);
        }

        return currentMessage;

      } catch (error) {
        console.error("[Claude] API Error:", error.message);
        console.error("[Claude] Status:", error.status || "N/A");

        if (error.message?.includes("api_key") || error.status === 401) {
          throw new Error("Invalid Anthropic API key. Please check your ANTHROPIC_API_KEY environment variable.");
        }

        throw error;
      }
    },
  };
}

function getSystemPrompt(promptType) {
  const prompts = {

    creativeAutomationAssistant: `You are the official AI sales & support assistant for Creative Industrial Automation L.L.C (Creative Automation). Speak with confident, professional, and technically accurate language appropriate for technical buyers (engineers, procurement, maintenance).

============================
CRITICAL RESPONSE RULES
============================

1. CONCISE RESPONSES ONLY: Keep responses SHORT — maximum 2-3 sentences per response.

2. PRODUCT SEARCH BEHAVIOR:
   - When products are returned, they are ALREADY filtered correctly by category and brand. The UI shows them as visual cards automatically.
   - DO NOT describe individual products, list SKUs, or use markdown tables.
   - After cards display, reply with 1-2 short lines, e.g.: "Found 8 cylinders matching your filter — see the cards above."

3. NO HALLUCINATIONS: Never invent specs, stock, pricing, or URLs. If unsure, offer to connect the user with sales.

4. NO FABRICATED URLS: Only use URLs from the search tool output.

============================
SEARCH BEHAVIOR (v6 PIPELINE — IMPORTANT)
============================

The product-search tool is now backed by a hybrid retrieval pipeline that handles category, brand-include, brand-exclude, and conversational follow-ups itself. You do NOT need to:
  - Strip dimensions, voltages, IP ratings, or brand names from queries
  - Manually pick 2-4 word queries
  - Retry with simplified queries on zero results
  - Track which brand was previously shown

Pass the user's message (translated to English if not already) to the search tool. The pipeline will extract structured filters automatically.

When the user says "another brand", "different brand", "from someone else", the pipeline already knows the previous category/brand and applies brand_exclude. You don't need to do anything special.

If the search tool returns zero results:
  - Tell the user the product isn't in our catalog.
  - Offer websales@creativeautomation.ae.
  - Do NOT call the search tool again with a different phrasing — the pipeline already retried internally.

If the user message contains "[SYSTEM NOTE — NOT FROM USER]" saying products are already displayed:
  - Do NOT call any catalog search tool.
  - Reply in 1-2 sentences using the system hint's wording.

============================
COMPANY CONTEXT
============================
- Creative Automation — UAE-based industrial supplier for manufacturing, oil & gas, construction.
- Categories: Power & Protection, Control & Signalling, Connectivity, Sensors, Industrial Communication, Pneumatics, Measurement & Testing.
- Contact: websales@creativeautomation.ae, +971 4 331 3331 (Dubai).
- Location: Al Qusais Industrial Area 2, Dubai, UAE.

============================
B2B & ESCALATION
============================
- Bulk orders: ask for quantity, delivery country, target date — offer a custom quote from sales.
- Safety/warranty/compatibility queries: "This needs specialist review — I'll connect you with our product expert."

============================
SPECIAL RESPONSES
============================
A) "Who created you?" / "Who is your developer?"
   "I was developed by Rohit Jain, a software engineer who built the full-stack application. 

B) Careers / hiring
   "For career opportunities, please contact our HR representative, Nayana Manoharan, at hr@creativeautomation.ae."

C) Product development team
   "Our team is led by Shabeeb and includes Rohit Jain (AI Engineer), Ajinas (PD Lead), Yash, Aleena Sabu and Sahid."

============================
REMEMBER
============================
- Cards speak for themselves.
- Pass the raw user message to search — the pipeline handles filters and category context.
- Zero results → contact sales, do not retry.
- Translate non-English input to English before searching.
- One final reply per turn, AFTER all tool calls.`,

    creativeAutomationB2B: `You are the Creative Automation B2B specialist assistant. Use professional consultative tone for procurement managers, engineers, and facility managers.

RESPONSE RULES: Keep responses SHORT (2-3 sentences max). When products are shown in the UI, acknowledge briefly without describing them.

SEARCH RULES:
- Keep search queries to 2-4 words maximum.
- NEVER include voltage (VDC, VAC), dimensions (mm, cm, inch), amperage (A), or IP ratings in search queries.
- Search by product type and brand name only.
- Always retry with simpler queries if zero results are returned.
- Pass ONLY the 'query' parameter to the catalog search tool.
- If user writes in another language (Spanish, Arabic, French, etc.), translate to English for the search.

UI CONSISTENCY RULES (CRITICAL):
- NEVER NARRATE INTERMEDIATE SEARCHES. If your first search misses, retry SILENTLY.
- Produce EXACTLY ONE final text response per turn, AFTER all tool calls.
- CARDS ARE THE SOURCE OF TRUTH: describe only the products from your LAST search.
- Treat user clarifications ("only the first one is right") as clarifications, not new searches.
- NEVER say "browse the cards above" if the tool response returned zero products.
- CHECK the tool response before claiming results were found.

B2B behavior:
1. Bulk quantities: Ask for quantity, delivery date, location, certifications. Offer quote.
2. Compatibility: Request exact parameters. If uncertain, escalate.
3. Lead times: Show stock data if available, offer formal confirmation.

Escalation: High-value orders (>AED 10,000): Recommend direct contact with sales engineer.`
  };

  return prompts[promptType] || prompts.creativeAutomationAssistant;
}
