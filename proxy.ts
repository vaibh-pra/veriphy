/**
 * ClaimCheck Proxy Server
 *
 * Sits transparently between you and any Ollama or OpenAI-compatible LLM.
 * Every response passes through the three-step verification pipeline before
 * being returned to the caller.
 *
 * Setup:
 *   1. Start this alongside (or instead of) server.ts:
 *        OLLAMA_API_KEY=sk-... REAL_LLM_BASE_URL=http://localhost:11434 npx tsx proxy.ts
 *
 *   2. Point your LLM client at the proxy instead of the real endpoint:
 *        export OLLAMA_HOST=http://localhost:4001
 *        ollama run llama3 "explain botnets"   ← response is verified before you see it
 *
 *      Or for cloud APIs, set your client's base URL to http://localhost:4001
 *
 * Environment variables:
 *   REAL_LLM_BASE_URL   Where to forward requests (default: http://localhost:11434)
 *   PROXY_PORT          Port this proxy listens on (default: 4001)
 *   OLLAMA_API_KEY      API key forwarded to the real LLM AND used for ClaimCheck LLM calls
 *   DEFAULT_DOMAIN      Default domain for claim checking (default: general)
 *
 * Pass x-claimcheck-domain header to override domain per request:
 *   curl -H "x-claimcheck-domain: cybersecurity" http://localhost:4001/v1/chat/completions ...
 */

import express from "express";
import { markClaims, shortlistClaims, findCitations, Domain } from "./core";

const app          = express();
const PROXY_PORT   = parseInt(process.env.PROXY_PORT   || "4001", 10);
const REAL_LLM_URL = (process.env.REAL_LLM_BASE_URL   || "http://localhost:11434").replace(/\/$/, "");
const DEF_DOMAIN   = (process.env.DEFAULT_DOMAIN       || "general") as Domain;

app.use(express.json({ limit: "10mb" }));

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
  res.json({ status: "ok", mode: "proxy", target: REAL_LLM_URL });
});

/* ── OpenAI-compatible: POST /v1/chat/completions ────────────────────────
   Works with: Ollama (openai-compat mode), OpenAI, Groq, Mistral, Together,
   Anyscale, LM Studio, Jan, Open WebUI, etc.                              */
app.post("/v1/chat/completions", async (req, res) => {
  const domain = (req.headers["x-claimcheck-domain"] as Domain) || DEF_DOMAIN;
  const apiKey = process.env.OLLAMA_API_KEY || "";

  try {
    const forwardRes = await fetch(`${REAL_LLM_URL}/v1/chat/completions`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ ...req.body, stream: false }),
    });

    if (!forwardRes.ok) {
      const txt = await forwardRes.text();
      return res.status(forwardRes.status).send(txt);
    }

    const data = await forwardRes.json() as any;
    const raw  = data.choices?.[0]?.message?.content ?? "";
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
  const apiKey = process.env.OLLAMA_API_KEY || "";

  try {
    const forwardRes = await fetch(`${REAL_LLM_URL}/api/chat`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ ...req.body, stream: false }),
    });

    if (!forwardRes.ok) {
      const txt = await forwardRes.text();
      return res.status(forwardRes.status).send(txt);
    }

    const data = await forwardRes.json() as any;
    const raw  = data.message?.content ?? "";
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
  const apiKey = process.env.OLLAMA_API_KEY || "";

  try {
    const forwardRes = await fetch(`${REAL_LLM_URL}/api/generate`, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ ...req.body, stream: false }),
    });

    if (!forwardRes.ok) {
      const txt = await forwardRes.text();
      return res.status(forwardRes.status).send(txt);
    }

    const data = await forwardRes.json() as any;
    const raw  = data.response ?? "";
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
      headers: { "Content-Type": "application/json" },
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
  console.log(`[ClaimCheck Proxy] forwarding to ${REAL_LLM_URL}`);
  console.log(`[ClaimCheck Proxy] default domain: ${DEF_DOMAIN}`);
  console.log(`[ClaimCheck Proxy] set OLLAMA_HOST=http://localhost:${PROXY_PORT} in your shell`);
});
