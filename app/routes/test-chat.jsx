// app/routes/test-chat.jsx
//
// Standalone test page for the v6 retrieval pipeline. Renders a chat UI on
// the left and a live "what v6 understood" telemetry panel on the right.
// Intentionally styled distinct from the v5 storefront widget — different
// palette + layout so demo viewers can see this isn't the existing bot.

import { useEffect, useRef, useState } from "react";

export const meta = () => [
  { title: "v6 Retrieval Test — Creative Automation" },
  { name: "robots", content: "noindex" },
];

const STYLES = `
  :root {
    --bg: #0a0e1a;
    --surface: #11182a;
    --surface-2: #1a2540;
    --border: #243150;
    --text: #e8edf5;
    --muted: #7f8aa3;
    --accent: #00d4aa;
    --accent-dim: #00d4aa22;
    --warn: #ffb547;
    --danger: #ff5a6c;
  }
  * { box-sizing: border-box; }
  html, body, #root { height: 100%; margin: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: 'Inter', -apple-system, system-ui, sans-serif;
    font-size: 14px;
  }
  .app {
    display: grid; grid-template-rows: 56px 1fr;
    height: 100vh;
  }
  .topbar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 24px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  .brand {
    display: flex; align-items: center; gap: 12px;
    font-weight: 600; letter-spacing: 0.3px;
  }
  .brand .dot {
    width: 10px; height: 10px; border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 12px var(--accent);
  }
  .brand .tag {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    background: var(--accent-dim); color: var(--accent);
    padding: 2px 8px; border-radius: 4px; font-size: 11px;
    border: 1px solid var(--accent);
  }
  .topbar .meta {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    color: var(--muted); font-size: 12px;
  }
  .main {
    display: grid; grid-template-columns: 1fr 420px;
    overflow: hidden;
  }
  .chat {
    display: flex; flex-direction: column;
    border-right: 1px solid var(--border);
    overflow: hidden;
  }
  .thread {
    flex: 1; overflow-y: auto; padding: 24px;
    display: flex; flex-direction: column; gap: 16px;
  }
  .thread::-webkit-scrollbar { width: 8px; }
  .thread::-webkit-scrollbar-thumb { background: var(--surface-2); border-radius: 4px; }
  .msg {
    max-width: 720px; padding: 12px 16px; border-radius: 10px;
    line-height: 1.5;
  }
  .msg.user {
    align-self: flex-end; background: var(--surface-2);
    border: 1px solid var(--border); border-right: 3px solid var(--accent);
  }
  .msg.assistant {
    align-self: flex-start; background: var(--surface);
    border: 1px solid var(--border);
  }
  .msg .role {
    font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 10px; color: var(--muted); text-transform: uppercase;
    letter-spacing: 1px; margin-bottom: 4px;
  }
  .products {
    align-self: stretch; display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 12px;
  }
  .product {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 8px; padding: 12px; display: flex; flex-direction: column;
    gap: 8px;
  }
  .product:hover { border-color: var(--accent); }
  .product .image {
    width: 100%; aspect-ratio: 1; background: var(--surface-2);
    border-radius: 6px; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
  }
  .product .image img { width: 100%; height: 100%; object-fit: contain; }
  .product .title { font-size: 13px; line-height: 1.35; }
  .product .row {
    display: flex; justify-content: space-between; align-items: center;
    font-size: 12px;
  }
  .pill {
    display: inline-block; padding: 2px 8px; border-radius: 999px;
    background: var(--accent-dim); color: var(--accent);
    font-size: 11px; font-weight: 500;
    border: 1px solid var(--accent);
    font-family: 'JetBrains Mono', ui-monospace, monospace;
  }
  .price { color: var(--text); font-weight: 600; }
  .composer {
    padding: 16px 24px; border-top: 1px solid var(--border);
    display: flex; gap: 12px;
  }
  .composer input {
    flex: 1; background: var(--surface); color: var(--text);
    border: 1px solid var(--border); padding: 12px 16px;
    border-radius: 8px; outline: none; font-size: 14px;
  }
  .composer input:focus { border-color: var(--accent); }
  .composer button {
    background: var(--accent); color: var(--bg);
    border: none; padding: 0 20px; border-radius: 8px;
    font-weight: 600; cursor: pointer; font-size: 14px;
  }
  .composer button:disabled {
    background: var(--surface-2); color: var(--muted); cursor: not-allowed;
  }
  .quick {
    display: flex; gap: 8px; padding: 0 24px 12px;
    flex-wrap: wrap;
  }
  .quick button {
    background: transparent; color: var(--muted);
    border: 1px solid var(--border); border-radius: 999px;
    padding: 6px 12px; font-size: 12px; cursor: pointer;
    font-family: inherit;
  }
  .quick button:hover { color: var(--accent); border-color: var(--accent); }
  .side {
    background: var(--surface); overflow-y: auto; padding: 24px;
    font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px;
  }
  .side h3 {
    margin: 0 0 12px; font-size: 11px; letter-spacing: 1.5px;
    text-transform: uppercase; color: var(--muted); font-weight: 600;
  }
  .panel {
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; padding: 12px; margin-bottom: 16px;
  }
  .kv { display: grid; grid-template-columns: 110px 1fr; gap: 6px 12px; }
  .kv .k { color: var(--muted); }
  .kv .v { color: var(--text); word-break: break-all; }
  .v.accent { color: var(--accent); }
  .v.warn { color: var(--warn); }
  .v.muted { color: var(--muted); }
  pre {
    background: var(--bg); border: 1px solid var(--border);
    border-radius: 6px; padding: 12px; overflow-x: auto;
    margin: 0; font-size: 11px; color: var(--text);
  }
  .empty { color: var(--muted); font-style: italic; padding: 24px; text-align: center; }
`;

const QUICK_PROMPTS = [
  "Siemens motion control sensor",
  "ABB inverter drive",
  "SICK motion control sensor",
  "show me from another brand",
  "DUS60E",
  "hello",
];

export default function TestChat() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [lastShownCategory, setLastShownCategory] = useState(null);
  const [lastShownBrands, setLastShownBrands] = useState([]);
  const [lastResponse, setLastResponse] = useState(null);
  const threadRef = useRef(null);

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, pending]);

  async function send(text) {
    const content = (text ?? input).trim();
    if (!content || pending) return;
    setInput("");
    const userMsg = { role: "user", content };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setPending(true);

    try {
      const res = await fetch("/api/v6-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages.map((m) => ({ role: m.role, content: m.content })),
          lastShownCategory,
          lastShownBrands,
        }),
      });
      const data = await res.json();
      setLastResponse(data);

      const products = Array.isArray(data.products) ? data.products : [];
      const intent = data.intent || {};
      const assistantMsg = {
        role: "assistant",
        content: data.reply || summarize(intent, products, data.searchType),
        products,
      };
      setMessages((prev) => [...prev, assistantMsg]);

      if (products.length > 0) {
        const nextBrands = [
          ...new Set(
            products
              .map((p) => p.vendorNormalized || (p.vendor ? String(p.vendor).toLowerCase() : null))
              .filter(Boolean),
          ),
        ];
        setLastShownBrands(nextBrands);
        if (intent.category) setLastShownCategory(intent.category);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Error: ${err.message}`, products: [] },
      ]);
    } finally {
      setPending(false);
    }
  }

  function reset() {
    setMessages([]);
    setLastShownCategory(null);
    setLastShownBrands([]);
    setLastResponse(null);
  }

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div className="app">
        <div className="topbar">
          <div className="brand">
            <span className="dot" />
            <span>Creative Automation</span>
            <span className="tag">v6 RETRIEVAL TEST</span>
          </div>
          <div className="meta">
            hybrid SQL • voyage-3.5-lite • haiku-4.5 • cohere rerank-v3.5
          </div>
        </div>

        <div className="main">
          <div className="chat">
            <div className="thread" ref={threadRef}>
              {messages.length === 0 && (
                <div className="empty">
                  Try one of the quick prompts below — or type a search.
                </div>
              )}
              {messages.map((m, i) => (
                <Message key={i} msg={m} />
              ))}
              {pending && (
                <div className="msg assistant">
                  <div className="role">v6</div>
                  searching…
                </div>
              )}
            </div>

            <div className="quick">
              {QUICK_PROMPTS.map((p) => (
                <button key={p} onClick={() => send(p)} disabled={pending}>
                  {p}
                </button>
              ))}
              <button onClick={reset} disabled={pending}>↻ reset</button>
            </div>

            <div className="composer">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
                placeholder="Ask the catalog…"
                disabled={pending}
                autoFocus
              />
              <button onClick={() => send()} disabled={pending || !input.trim()}>
                Send
              </button>
            </div>
          </div>

          <Sidebar
            lastShownCategory={lastShownCategory}
            lastShownBrands={lastShownBrands}
            response={lastResponse}
          />
        </div>
      </div>
    </>
  );
}

function Message({ msg }) {
  return (
    <>
      <div className={`msg ${msg.role}`}>
        <div className="role">{msg.role === "user" ? "you" : "v6"}</div>
        {msg.content}
      </div>
      {Array.isArray(msg.products) && msg.products.length > 0 && (
        <div className="products">
          {msg.products.slice(0, 12).map((p) => (
            <ProductCard key={p.id} p={p} />
          ))}
        </div>
      )}
    </>
  );
}

function ProductCard({ p }) {
  const price = p.priceMin ? `${Number(p.priceMin).toFixed(0)} ${p.currency || ""}` : "—";
  return (
    <div className="product">
      <div className="image">
        {p.imageUrl ? <img src={p.imageUrl} alt={p.title} loading="lazy" /> : <span style={{ color: "var(--muted)" }}>no image</span>}
      </div>
      <div className="title">{p.title}</div>
      <div className="row">
        <span className="pill">{p.vendor || "—"}</span>
        <span className="price">{price}</span>
      </div>
    </div>
  );
}

function Sidebar({ lastShownCategory, lastShownBrands, response }) {
  const intent = response?.intent;
  return (
    <div className="side">
      <h3>What v6 understood</h3>
      <div className="panel">
        {intent ? (
          <div className="kv">
            <div className="k">category</div>
            <div className={`v ${intent.category ? "accent" : "muted"}`}>
              {intent.category || "(none)"}
            </div>
            <div className="k">brand_include</div>
            <div className={`v ${intent.brand_include?.length ? "accent" : "muted"}`}>
              {intent.brand_include?.length ? intent.brand_include.join(", ") : "—"}
            </div>
            <div className="k">brand_exclude</div>
            <div className={`v ${intent.brand_exclude?.length ? "warn" : "muted"}`}>
              {intent.brand_exclude?.length ? intent.brand_exclude.join(", ") : "—"}
            </div>
            <div className="k">free_text</div>
            <div className="v">{intent.free_text || "—"}</div>
            <div className="k">searchType</div>
            <div className={`v ${response.searchType === "non_search" ? "muted" : response.searchType?.includes("relaxed") ? "warn" : "accent"}`}>
              {response.searchType}
            </div>
            <div className="k">products</div>
            <div className="v">{response.products?.length ?? 0}</div>
            <div className="k">elapsedMs</div>
            <div className="v muted">{response.elapsedMs} ms</div>
          </div>
        ) : (
          <div style={{ color: "var(--muted)" }}>no query yet</div>
        )}
      </div>

      <h3>Carry-over state</h3>
      <div className="panel">
        <div className="kv">
          <div className="k">lastShownCategory</div>
          <div className={`v ${lastShownCategory ? "accent" : "muted"}`}>
            {lastShownCategory || "(none)"}
          </div>
          <div className="k">lastShownBrands</div>
          <div className="v">
            {lastShownBrands.length ? lastShownBrands.join(", ") : "—"}
          </div>
        </div>
      </div>

      <h3>How v6 differs from v5</h3>
      <div className="panel" style={{ fontFamily: "Inter, sans-serif", lineHeight: 1.55, color: "var(--text)" }}>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>Structured intent extraction (Haiku) before retrieval — not after</li>
          <li>Hard SQL filters for brand & category, not just embedding similarity</li>
          <li>Category stickiness: "another brand" keeps the prior product family</li>
          <li>Brand exclude is enforced in SQL — cannot be bypassed by ranking</li>
          <li>Local pgvector + BM25 hybrid score, reranked by Cohere</li>
        </ul>
      </div>
    </div>
  );
}

function summarize(intent, products, searchType) {
  if (searchType === "non_search") return "Not a product query — chatting only.";
  if (!products.length) return `No matches for "${intent.free_text}".`;
  const filterBits = [];
  if (intent.category) filterBits.push(`category="${intent.category}"`);
  if (intent.brand_include?.length) filterBits.push(`brands=[${intent.brand_include.join(", ")}]`);
  if (intent.brand_exclude?.length) filterBits.push(`exclude=[${intent.brand_exclude.join(", ")}]`);
  const filterStr = filterBits.length ? ` (${filterBits.join(", ")})` : "";
  return `Found ${products.length} products${filterStr}.`;
}
