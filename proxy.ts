/**
 * Veriphy Proxy Server
 *
 * Sits transparently between you and any Ollama or OpenAI-compatible LLM.
 * Every response passes through the three-step verification pipeline before
 * being returned to the caller.
 *
 * Setup:
 *   1. Start the proxy in a background terminal:
 *        OLLAMA_API_KEY=sk-... npm run proxy
 *
 *   2. Point your Ollama client at the proxy:
 *        export OLLAMA_HOST=http://localhost:4001
 *        ollama run llama3 "explain botnets"
 *
 * Environment variables:
 *   OLLAMA_API_KEY      API key used ONLY for Veriphy's internal Nemotron calls
 *   REAL_LLM_BASE_URL   Where to forward LLM requests (default: http://localhost:11434)
 *   REAL_LLM_API_KEY    Only set for cloud endpoints needing their own key (OpenAI etc.)
 *   PROXY_PORT          Port this proxy listens on (default: 4001)
 *   DEFAULT_DOMAIN      Default domain for claim checking (default: general)
 *   DEBUG               Set to "1" to print pipeline details to the proxy terminal
 */

import express, { Request } from "express";
import { markClaims, shortlistClaims, findCitations } from "./core";

const app          = express();
const PROXY_PORT   = parseInt(process.env.PROXY_PORT || "4001", 10);
const REAL_LLM_URL = (process.env.REAL_LLM_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
const DEF_DOMAIN   = (process.env.DEFAULT_DOMAIN    || "general") as Domain;
const FORWARD_KEY  = process.env.REAL_LLM_API_KEY   || "";
const DEBUG        = process.env.DEBUG === "1";

app.use(express.json({ limit: "10mb" }));

function log(...args: any[]) {
  if (DEBUG) console.log("[Veriphy]", ...args);
}

function buildForwardHeaders(req: Request): Record<string, string> {
  const skip = new Set([
    "host", "content-length", "transfer-encoding",
    "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailers", "upgrade",
  ]);
  const h: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (skip.has(key.toLowerCase())) continue;
    h[key] = Array.isArray(value) ? value.join(", ") : (value ?? "");
  }
  h["Content-Type"] = "application/json";
  if (FORWARD_KEY) h["Authorization"] = `Bearer ${FORWARD_KEY}`;
  return h;
}

/**
 * Deduplicated citation rendering.
 * If two claims share the exact same citation string, they get the same [N]
 * and that source is listed only once in the Sources block.
 */
function inlineCitations(cited: Awaited<ReturnType<typeof findCitations>>): string {
  const citMap = new Map<string, number>(); // citation → ref number
  const refs: string[] = [];               // unique citations in order

  const lines = cited.map(s => {
    const cits: string[] = Array.isArray((s as any).citations)
      ? (s as any).citations
      : (s.citation ? [s.citation] : []);
    if (s.isClaim && cits.length > 0) {
      const nums = cits.map(c => {
        if (citMap.has(c)) return citMap.get(c)!;
        refs.push(c);
        const num = refs.length;
        citMap.set(c, num);
        return num;
      });
      return `${s.sentence} ${nums.map(n => `[${n}]`).join('')}`;
    }
    return s.sentence;
  });

  const body = lines.join(" ");
  if (!refs.length) return body;
  const refBlock = "\n\n---\nSources:\n" + refs.map((r, i) => `[${i + 1}] ${r}`).join("\n");
  return body + refBlock;
}

async function runVeriphy(text: string, domain: string): Promise<string> {
  console.log(`[Veriphy] Step 1: marking claims (domain=${domain}, chars=${text.length})`);
  const marked = await markClaims(text, domain);
  const claimCount = marked.filter(m => m.isClaim).length;
  console.log(`[Veriphy] Step 1 done: ${marked.length} sentences, ${claimCount} claims`);

  if (DEBUG) {
    marked.filter(m => m.isClaim).forEach((m, i) =>
      console.log(`  claim[${i}]: ${m.sentence.slice(0, 80)}...`)
    );
  }

  if (claimCount === 0) {
    console.log("[Veriphy] No claims found — returning original response unchanged");
    return text;
  }

  const shortlisted = shortlistClaims(marked);
  const shortCount  = shortlisted.filter(m => m.isClaim).length;
  console.log(`[Veriphy] Step 2 done: shortlisted ${shortCount} claim(s) for citation`);

  console.log("[Veriphy] Step 3: finding citations...");
  const cited    = await findCitations(shortlisted, domain);
  const citCount = cited.filter(c => c.isClaim && ((c as any).citations?.length || c.citation)).length;

  // Count unique citations
  const uniqueCitations = new Set(cited.flatMap(c => (c as any).citations?.length ? (c as any).citations : c.citation ? [c.citation] : []));
  console.log(`[Veriphy] Step 3 done: ${citCount} claim(s) cited, ${uniqueCitations.size} unique source(s)`);

  if (DEBUG) {
    [...uniqueCitations].forEach((c, i) => console.log(`  source[${i + 1}]: ${c}`));
  }

  return inlineCitations(cited);
}

/* ── Health ─────────────────────────────────────────────────────────────── */
app.get("/health", (_req, res) => {
  res.json({ status: "ok", mode: "proxy", target: REAL_LLM_URL, forwardAuthSet: !!FORWARD_KEY, debug: DEBUG });
});

/* ── OpenAI-compatible: POST /v1/chat/completions ────────────────────────── */
app.post("/v1/chat/completions", async (req, res) => {
  const domain = (req.headers["x-verifi-domain"] as string | undefined) || DEF_DOMAIN;
  try {
    log("→ /v1/chat/completions");
    const forwardRes = await fetch(`${REAL_LLM_URL}/v1/chat/completions`, {
      method: "POST", headers: buildForwardHeaders(req),
      body: JSON.stringify({ ...req.body, stream: false }),
    });
    if (!forwardRes.ok) return res.status(forwardRes.status).send(await forwardRes.text());

    const data     = await forwardRes.json() as any;
    const raw      = data.choices?.[0]?.message?.content ?? "";
    const verified = await runVeriphy(raw, domain);

    data.choices[0].message.content = verified;
    data.choices[0].finish_reason   = "stop";
    res.json(data);
  } catch (err: any) {
    console.error("[Veriphy] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Ollama native: POST /api/chat ──────────────────────────────────────── */
app.post("/api/chat", async (req, res) => {
  const domain = (req.headers["x-verifi-domain"] as string | undefined) || DEF_DOMAIN;
  try {
    log("→ /api/chat");
    const forwardRes = await fetch(`${REAL_LLM_URL}/api/chat`, {
      method: "POST", headers: buildForwardHeaders(req),
      body: JSON.stringify({ ...req.body, stream: false }),
    });
    if (!forwardRes.ok) return res.status(forwardRes.status).send(await forwardRes.text());

    const data     = await forwardRes.json() as any;
    const raw      = data.message?.content ?? "";
    const verified = await runVeriphy(raw, domain);

    data.message.content = verified;
    res.json(data);
  } catch (err: any) {
    console.error("[Veriphy] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Ollama native: POST /api/generate ──────────────────────────────────── */
app.post("/api/generate", async (req, res) => {
  const domain = (req.headers["x-verifi-domain"] as string | undefined) || DEF_DOMAIN;
  try {
    log("→ /api/generate");
    const forwardRes = await fetch(`${REAL_LLM_URL}/api/generate`, {
      method: "POST", headers: buildForwardHeaders(req),
      body: JSON.stringify({ ...req.body, stream: false }),
    });
    if (!forwardRes.ok) return res.status(forwardRes.status).send(await forwardRes.text());

    const data     = await forwardRes.json() as any;
    const raw      = data.response ?? "";
    const verified = await runVeriphy(raw, domain);

    data.response = verified;
    res.json(data);
  } catch (err: any) {
    console.error("[Veriphy] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ── Pass-through: everything else forwarded unchanged ──────────────────── */
app.all("*", async (req, res) => {
  try {
    const forwardRes = await fetch(`${REAL_LLM_URL}${req.path}`, {
      method: req.method, headers: buildForwardHeaders(req),
      body: ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    const txt = await forwardRes.text();
    res.status(forwardRes.status).send(txt);
  } catch (err: any) {
    res.status(502).json({ error: "Proxy error: " + err.message });
  }
});

app.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(`[Veriphy Proxy] listening on port ${PROXY_PORT}`);
  console.log(`[Veriphy Proxy] forwarding to     ${REAL_LLM_URL}`);
  const agentBase = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
  const agentKey  = process.env.OLLAMA_API_KEY  || "";
  console.log(`[Veriphy Proxy] agent LLM base:    ${agentBase}`);
  console.log(`[Veriphy Proxy] agent LLM key:     ${agentKey ? "set (OLLAMA_API_KEY)" : "not set"}`);
  console.log(`[Veriphy Proxy] forward auth key:  ${FORWARD_KEY ? "set (REAL_LLM_API_KEY)" : "not set — passing original headers"}`);
  console.log(`[Veriphy Proxy] default domain:    ${DEF_DOMAIN}`);
  console.log(`[Veriphy Proxy] debug logging:     ${DEBUG ? "ON" : "OFF (set DEBUG=1 to enable)"}`);
  console.log(`[Veriphy Proxy] in your shell:     export OLLAMA_HOST=http://localhost:${PROXY_PORT}`);
});
