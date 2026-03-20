/**
 * ClaimCheck Proxy Server
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
 *   OLLAMA_API_KEY      API key used ONLY for ClaimCheck's internal Nemotron calls
 *   REAL_LLM_BASE_URL   Where to forward LLM requests (default: http://localhost:11434)
 *   REAL_LLM_API_KEY    Only set this for cloud endpoints (OpenAI, Groq, etc.) that
 *                       require their OWN key. Leave unset for local Ollama — it manages
 *                       its own cloud model auth internally.
 *   PROXY_PORT          Port this proxy listens on (default: 4001)
 *   DEFAULT_DOMAIN      Default domain for claim checking (default: general)
 *
 * Per-request domain override:
 *   curl -H "x-claimcheck-domain: cybersecurity" http://localhost:4001/v1/chat/completions ...
 */

import express, { Request } from "express";
import { markClaims, shortlistClaims, findCitations, Domain } from "./core";

const app          = express();
const PROXY_PORT   = parseInt(process.env.PROXY_PORT || "4001", 10);
const REAL_LLM_URL = (process.env.REAL_LLM_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
const DEF_DOMAIN   = (process.env.DEFAULT_DOMAIN    || "general") as Domain;
const FORWARD_KEY  = process.env.REAL_LLM_API_KEY   || "";

app.use(express.json({ limit: "10mb" }));

/**
 * Build forwarding headers.
 * Always passes through ALL original request headers (so cloud model auth
 * tokens from the Ollama CLI are preserved). Strips only hop-by-hop headers
 * that must not be forwarded. Optionally overrides Authorization with
 * REAL_LLM_API_KEY when set (for external cloud endpoints).
 */
function buildForwardHeaders(req: Request): Record<string, string> {
  const skip = new Set([
    "host", "content-length", "transfer-encoding",
    "connection", "keep-alive", "proxy-authenticate",
    "proxy-authorization", "te", "trailers", "upgrade",
  ]);

  const h: Record<string, string> = {};

  for (const [key, value] of Object.entries(req.headers)) {
    if (skip.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      h[key] = value.join(", ");
    } else if (value) {
      h[key] = value;
    }
  }

  h["Content-Type"] = "application/json";

  if (FORWARD_KEY) {
    h["Authorization"] = `Bearer ${FORWARD_KEY}`;
  }

  return h;
}

function inlineCitations(cited: Awaited<ReturnType<typeof findCitations>>): string {
  const refs: string[] = [];
  let idx = 0;
  const body = cited.map(s => {
    if (s.isClaim && s.citation) {
      refs.push(s.citation);
      idx++;
      return `${s.sentence} [${idx}]`;
    }
    return s.sentence;
  }).join(" ");

  if (!refs.length) return body;
  const refBlock = "\n\n---\nSources:\n" + refs.map((r, i) => `[${i + 1}] ${r}`).join("\n");
  return body + refBlock;
}

async function runClaimCheck(text: string, domain: Domain): Promise<string> {
  const marked      = await markClaims(text, domain);
  const shortlisted = shortlistClaims(marked);
  const cited       = await findCitations(shortlisted, domain);
  return inlineCitations(cited);
}

/* ── Health ─────────────────────────────────────────────────────────────── */
app.get("/health", (_req, res) => {
  res.json({
    status:         "ok",
    mode:           "proxy",
    target:         REAL_LLM_URL,
    forwardAuthSet: !!FORWARD_KEY,
  });
});

/* ── OpenAI-compatible: POST /v1/chat/completions ────────────────────────── */
app.post("/v1/chat/completions", async (req, res) => {
  const domain = (req.headers["x-claimcheck-domain"] as Domain) || DEF_DOMAIN;
  try {
    const forwardRes = await fetch(`${REAL_LLM_URL}/v1/chat/completions`, {
      method:  "POST",
      headers: buildForwardHeaders(req),
      body:    JSON.stringify({ ...req.body, stream: false }),
    });
    if (!forwardRes.ok) return res.status(forwardRes.status).send(await forwardRes.text());

    const data     = await forwardRes.json() as any;
    const raw      = data.choices?.[0]?.message?.content ?? "";
    const verified = await runClaimCheck(raw, domain);

    data.choices[0].message.content = verified;
    data.choices[0].finish_reason   = "stop";
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Ollama native: POST /api/chat ──────────────────────────────────────── */
app.post("/api/chat", async (req, res) => {
  const domain = (req.headers["x-claimcheck-domain"] as Domain) || DEF_DOMAIN;
  try {
    const forwardRes = await fetch(`${REAL_LLM_URL}/api/chat`, {
      method:  "POST",
      headers: buildForwardHeaders(req),
      body:    JSON.stringify({ ...req.body, stream: false }),
    });
    if (!forwardRes.ok) return res.status(forwardRes.status).send(await forwardRes.text());

    const data     = await forwardRes.json() as any;
    const raw      = data.message?.content ?? "";
    const verified = await runClaimCheck(raw, domain);

    data.message.content = verified;
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Ollama native: POST /api/generate ──────────────────────────────────── */
app.post("/api/generate", async (req, res) => {
  const domain = (req.headers["x-claimcheck-domain"] as Domain) || DEF_DOMAIN;
  try {
    const forwardRes = await fetch(`${REAL_LLM_URL}/api/generate`, {
      method:  "POST",
      headers: buildForwardHeaders(req),
      body:    JSON.stringify({ ...req.body, stream: false }),
    });
    if (!forwardRes.ok) return res.status(forwardRes.status).send(await forwardRes.text());

    const data     = await forwardRes.json() as any;
    const raw      = data.response ?? "";
    const verified = await runClaimCheck(raw, domain);

    data.response = verified;
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Pass-through: everything else forwarded unchanged ──────────────────── */
app.all("*", async (req, res) => {
  try {
    const forwardRes = await fetch(`${REAL_LLM_URL}${req.path}`, {
      method:  req.method,
      headers: buildForwardHeaders(req),
      body:    ["GET", "HEAD"].includes(req.method) ? undefined : JSON.stringify(req.body),
    });
    const txt = await forwardRes.text();
    res.status(forwardRes.status).send(txt);
  } catch (err: any) {
    res.status(502).json({ error: "Proxy error: " + err.message });
  }
});

app.listen(PROXY_PORT, "0.0.0.0", () => {
  console.log(`[ClaimCheck Proxy] listening on port ${PROXY_PORT}`);
  console.log(`[ClaimCheck Proxy] forwarding to     ${REAL_LLM_URL}`);
  console.log(`[ClaimCheck Proxy] forward auth key:  ${FORWARD_KEY ? "set (REAL_LLM_API_KEY)" : "not set — passing original headers"}`);
  console.log(`[ClaimCheck Proxy] default domain:    ${DEF_DOMAIN}`);
  console.log(`[ClaimCheck Proxy] in your shell:     export OLLAMA_HOST=http://localhost:${PROXY_PORT}`);
});
