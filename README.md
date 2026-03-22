# Veriphy

A standalone, three-step agent that post-processes any LLM response to identify factual claims, shortlist the most distinctive ones, and retrieve real arXiv paper citations for each.

Built as part of the [Automorph](https://github.com/vaibh-pra/automorph-backend) project but designed to work with **any** LLM or chatbot on any topic, especially STEM related.

---

## What It Does

LLM responses mix two very different kinds of sentences:

- **Factual claims** — assertions about how algorithms work, what techniques mean, established scientific findings. These *can* be wrong or hallucinated.
- **Everything else** — transitions, rhetorical questions, computed results, opinions, meta-commentary. These need no verification.

Veriphy identifies the first kind and traces each one back to a real arXiv paper.

---

## Three-Step Pipeline

```
Step 1  markClaims()       LLM (Nemotron) reads every sentence and labels
                           it CLAIM or NOT A CLAIM. Transitions, opinions,
                           computed values, and filler are never marked.
                           Requires: OLLAMA_API_KEY

Step 2  shortlistClaims()  Client-side — no LLM, no API key.
                           Picks up to 3 claims greedily by sentence length.
                           Skips any candidate that shares >55% word overlap
                           with an already-selected claim (Jaccard filter),
                           so near-duplicate sentences are never both cited.

Step 3  findCitations()    Queries the arXiv API — no LLM, no API key.
                           Extracts key terms from each claim, searches
                           arXiv, and returns the top-matching paper.
                           All 3 searches run in parallel (<1 s typical).
                           Claims with no arXiv result are de-marked.
```

**Only Step 1 uses an LLM.** Steps 2 and 3 are entirely LLM-free.

The output is the original response with up to 3 sentences annotated with arXiv citations. Every other sentence is left exactly as-is.

---

## Citation Rendering

When two claims resolve to the same paper, they share the same `[N]` reference number and the source is listed only once:

```
Botnets use hierarchical overlays for resilience. [1]
Mirai used a similar command-and-control topology. [1]   ← same paper, reused

Sources:
[1] Antonakakis et al., "Understanding the Mirai Botnet", arXiv:1702.06771, 2017
```

---

## Repository Structure

```
verifi-agent/
  core.ts        All logic — three exported functions, no framework dependency
  server.ts      Standalone API server (port 4000)
  proxy.ts       Transparent LLM proxy (port 4001) — intercepts before terminal display
  cli.ts         CLI tool — pipe any LLM output through Veriphy in the terminal
  client.js      Drop-in frontend widget for any chatbot page (zero dependencies)
  agent.json     Marketplace manifest — capabilities, schemas, env requirements
  package.json   npm package definition
  Dockerfile     Container definition
```

---

## Usage Modes

### Mode 1 — Proxy (transparent interception)

The proxy sits between you and Ollama or any cloud LLM. Every response is verified **before it reaches your terminal**. You do not change how you use your LLM.

```bash
# 1. Start the proxy
OLLAMA_API_KEY=your_key npm run proxy
# [Veriphy Proxy] listening on port 4001
# [Veriphy Proxy] forwarding to http://localhost:11434

# 2. Redirect your client to the proxy
export OLLAMA_HOST=http://localhost:4001

# 3. Use your LLM as normal — responses are verified automatically
ollama run llama3 "Explain arithmetic coding"
```

**Forwarding to a cloud LLM** (OpenAI, Anthropic, etc.):

```bash
REAL_LLM_BASE_URL=https://api.openai.com \
REAL_LLM_API_KEY=sk-your-openai-key \
OLLAMA_API_KEY=your_nemotron_key \
npm run proxy
```

Note: `OLLAMA_API_KEY` is used **only** for Veriphy's internal Nemotron calls (Step 1).
`REAL_LLM_API_KEY` is forwarded to the upstream LLM and is optional for local Ollama.

**Override domain hint per request:**

```bash
curl -X POST http://localhost:4001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-verifi-domain: cybersecurity" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Explain botnets"}]}'
```

**Enable verbose logging:**

```bash
DEBUG=1 OLLAMA_API_KEY=your_key npm run proxy
# Shows:
# [Veriphy] Step 1: marking claims (chars=4209)
# [Veriphy] Step 1 done: 55 sentences, 24 claims
# [arXiv] query: arithmetic coding huffman compression efficiency
# [arXiv] found: Hashimoto et al. (2022) arXiv:2209.08874v1
# [Veriphy] Step 3 done: 3 claim(s) cited, 3 unique source(s)
```

---

### Mode 2 — CLI

```bash
# Pipe any LLM output through Veriphy
ollama run llama3 "Explain Shannon entropy" | npx tsx cli.ts
```

---

### Mode 3 — API server

```bash
npm start
# Listening on port 4000

# Step 1: mark claims
curl -X POST http://localhost:4000/api/mark-claims \
  -H "Content-Type: application/json" \
  -d '{"text":"Arithmetic coding is a lossless compression method..."}'

# Step 3: find citations (arXiv — no LLM key needed for this step)
curl -X POST http://localhost:4000/api/find-citations \
  -H "Content-Type: application/json" \
  -d '{"marked":[...]}'
```

---

## Embed in Your Own Node.js Server

```ts
import { markClaims, shortlistClaims, findCitations } from './core';

// Step 1 — requires OLLAMA_API_KEY
const marked      = await markClaims(responseText);

// Step 2 — pure function, no I/O
const shortlisted = shortlistClaims(marked);

// Step 3 — queries arXiv, no LLM key needed
const cited       = await findCitations(shortlisted);
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OLLAMA_API_KEY` | Yes | API key for Nemotron (Step 1 only) |
| `PORT` | No (default: 4000) | Port for the standalone API server |
| `PROXY_PORT` | No (default: 4001) | Port for the proxy server |
| `REAL_LLM_BASE_URL` | Proxy only | Upstream LLM base URL (default: `http://localhost:11434`) |
| `REAL_LLM_API_KEY` | No | Auth key forwarded to the upstream LLM (omit for local Ollama) |
| `DEBUG` | No | Set to `1` to log raw LLM output and arXiv queries to the console |

---

## Design Decisions

**Why shortlist only 3 claims?**
All 3 arXiv searches run in parallel, so latency is bounded by the slowest single request — typically under a second. Three is enough to meaningfully annotate a response without overwhelming the reader.

**Why the Jaccard similarity filter in Step 2?**
Without it, an LLM that says the same thing in two slightly different sentences would fill both citation slots with near-identical content. The filter (>55% word overlap = skip) ensures the 3 cited claims are genuinely distinct.

**Why arXiv instead of an LLM for citations?**
LLMs hallucinate citations — fabricated titles, wrong years, non-existent venues. arXiv returns real papers with real IDs that can be independently verified. If arXiv has no result for a claim, the claim is de-marked rather than cited with a hallucination.

**Why de-mark claims with no source?**
A claim with a fabricated citation is worse than no citation at all. If arXiv finds nothing, the sentence silently reverts to plain text.

**Why buffer the full response before display?**
Veriphy needs the complete response to identify which sentences are claims. Buffering gives a clean single-pass annotated result. The raw unverified text is never shown.

---

## JSON Parsing Robustness

Step 1 asks Nemotron to return a JSON array. Because Nemotron is a reasoning model, its output may include thinking tokens, markdown, or occasionally malformed character sequences. The parser uses three fallback levels:

1. **Whole-array parse** — `JSON.parse` on the bracket-balanced `[{...}]` block. The balancer is string-aware: it ignores `[` and `]` that appear inside JSON string values, so sentences like `"The formula H[X]..."` don't truncate the array.
2. **Control-char cleanup** — strips raw newlines and other control characters embedded in string values, then re-tries `JSON.parse`.
3. **Object-by-object extraction** — scans for individual `{...}` blobs and parses each independently. A single malformed sentence cannot drop the rest of the response.

---

## License

MIT
