# ClaimCheck Verification Agent

A standalone, three-step agent that post-processes any LLM chatbot response to identify domain-knowledge claims, shortlist the most verifiable and diverse ones, and look up real published papers on arXiv for each.

Built as part of the [Automorph](https://github.com/vaibh-pra/automorph-backend) project — an AI-powered graph automorphism analysis platform — but designed to work with **any** LLM chatbot.

---

## What It Does

LLM responses often mix two fundamentally different kinds of sentences:

- **Graph-structural observations** — orbit sizes, group order, generators, node IDs. These come from exact computation (Nauty) and need no verification.
- **Domain-knowledge claims** — assertions about how algorithms behave, what patterns mean in a field, established scientific findings. These *can* be wrong or hallucinated.

ClaimCheck separates the two and traces the second kind back to real arXiv papers.

---

## Three-Step Pipeline

```
Step 1  markClaims()       LLM (Nemotron) reads every sentence and labels
                           it CLAIM or NOT A CLAIM. Graph-structural
                           observations are never marked as claims.
                           Uses: OLLAMA_API_KEY

Step 2  shortlistClaims()  Client-side — no LLM, no API key needed.
                           Picks up to 3 claims greedily by sentence length,
                           skipping any candidate whose words overlap >55%
                           with an already-selected claim (Jaccard filter).
                           Near-duplicate claims are deduplicated here.

Step 3  findCitations()    Queries the arXiv API — no LLM, no API key.
                           Extracts key terms from each claim, searches
                           arXiv, and returns the top result as the citation.
                           All 3 searches run in parallel (<1 s typical).
                           Claims with no arXiv result are de-marked.
```

**Only Step 1 uses an LLM.** Steps 2 and 3 are entirely LLM-free.

The final output is the original response with up to 3 sentences annotated with arXiv citations — every other sentence is left exactly as-is.

---

## Citation Rendering

When two claims resolve to the same paper, they share the same `[N]` reference number and the source is listed only once:

```
Botnets use hierarchical overlays for resilience. [1]
Mirai used a similar command-and-control topology. [1]   ← same paper, reused

Sources:
[1] Antonakakis et al., "Understanding the Mirai Botnet", USENIX Security, arXiv:...
```

---

## Supported Domains

| Domain key | Context |
|---|---|
| `cybersecurity` | Botnet detection, MITRE ATT&CK, CVE, network security |
| `ppi_network` | Protein-protein interaction networks, bioinformatics, drug targets |
| `crystallography` | Space groups, X-ray diffraction, Metal-Organic Frameworks |
| `social_network` | Community detection, influence propagation, network centrality |
| `finance_research` | AML, wash trading, transaction network fraud, FATF typologies |
| `general` | Mathematics, information theory, computer science, physics, engineering |

---

## Repository Structure

```
claimcheck-agent/
  core.ts        All logic — three exported functions, no framework dependency
  server.ts      Standalone API server (port 4000)
  proxy.ts       Transparent LLM proxy (port 4001) — intercepts before terminal display
  cli.ts         CLI tool — calls any LLM and shows annotated output in terminal
  client.js      Drop-in frontend widget for any chatbot page (zero dependencies)
  agent.json     Marketplace manifest — capabilities, schemas, env requirements
  package.json   npm package definition
  Dockerfile     Container definition
```

---

## Usage Modes

### Mode 1 — Proxy (transparent interception)

The proxy sits between you and Ollama or any cloud LLM. Every response is verified **before it reaches your terminal**. You do not change how you use your LLM — just redirect it to the proxy port.

```bash
# 1. Start the proxy in a background terminal
OLLAMA_API_KEY=your_key \
DEFAULT_DOMAIN=cybersecurity \
npm run proxy
# [ClaimCheck Proxy] listening on port 4001
# [ClaimCheck Proxy] forwarding to http://localhost:11434

# 2. Redirect your Ollama client to the proxy
export OLLAMA_HOST=http://localhost:4001

# 3. Use Ollama exactly as normal — responses are verified automatically
ollama run llama3 "Explain how botnets use graph topology"
```

**Forwarding to a cloud LLM** (OpenAI, Anthropic, etc.):

```bash
REAL_LLM_BASE_URL=https://api.openai.com \
REAL_LLM_API_KEY=sk-your-openai-key \
OLLAMA_API_KEY=your_nemotron_key \
npm run proxy
# Then point your client's base URL to http://localhost:4001
```

Note: `OLLAMA_API_KEY` is used **only** for ClaimCheck's internal Nemotron calls (Step 1).
`REAL_LLM_API_KEY` is forwarded to the upstream LLM and is optional for local Ollama.

**Override domain per request** by passing a header:

```bash
curl -X POST http://localhost:4001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-claimcheck-domain: finance_research" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Explain wash trading"}]}'
```

**Enable verbose logging:**

```bash
DEBUG=1 OLLAMA_API_KEY=your_key npm run proxy
# Shows:
# [markClaims] raw LLM output (first 600 chars): ...
# [arXiv] query: arithmetic coding huffman compression efficiency
# [arXiv] found: Hashimoto et al. (2022) arXiv:2209.08874v1
```

---

### Mode 2 — CLI

```bash
# Pipe any LLM output through ClaimCheck
ollama run llama3 "Explain Shannon entropy" | npx tsx cli.ts

# Or with a specific domain
DEFAULT_DOMAIN=cybersecurity ollama run llama3 "..." | npx tsx cli.ts
```

---

### Mode 3 — API server

```bash
npm start
# Listening on port 4000

# Mark claims
curl -X POST http://localhost:4000/api/mark-claims \
  -H "Content-Type: application/json" \
  -d '{"text":"Botnets use star topologies...","domain":"cybersecurity"}'

# Find citations (arXiv — no LLM key needed)
curl -X POST http://localhost:4000/api/find-citations \
  -H "Content-Type: application/json" \
  -d '{"marked":[...],"domain":"cybersecurity"}'
```

---

## Embed in Your Own Node.js Server

```ts
import { markClaims, shortlistClaims, findCitations } from './core';

// Step 1 — requires OLLAMA_API_KEY
const marked      = await markClaims(responseText, 'finance_research');

// Step 2 — pure function, no I/O
const shortlisted = shortlistClaims(marked);

// Step 3 — queries arXiv API, no LLM key needed
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
| `DEFAULT_DOMAIN` | No (default: `general`) | Domain used when no `x-claimcheck-domain` header is sent |
| `DEBUG` | No | Set to `1` to log raw LLM output and arXiv queries to the console |

---

## Design Decisions

**Why shortlist only 3 claims?**
Finding citations involves network requests to arXiv. Three is the sweet spot — enough to add value, few enough to stay fast (all 3 are fetched in parallel).

**Why the Jaccard similarity filter in Step 2?**
Without it, an LLM that says the same thing in two slightly different sentences would fill all 3 citation slots with near-identical content. The filter (>55% word overlap = skip) ensures the 3 cited claims are genuinely distinct.

**Why arXiv instead of an LLM for citations?**
LLMs recall citations from training data, which means fabricated titles, wrong years, and non-existent venues. arXiv returns real papers with real IDs. If arXiv finds nothing for a claim, the claim is de-marked rather than cited with a hallucination.

**Why exclude graph-structural observations?**
They come from Nauty, an exact mathematical computation. They are already verified by definition. Marking them as claims would be misleading.

**Why de-mark claims with no source?**
A claim with a fabricated citation is worse than no citation at all. If arXiv finds nothing for a claim, the sentence silently reverts to plain text.

**Why buffer the response before display?**
ClaimCheck needs the complete response to identify which sentences are claims. Buffering gives a clean single-pass annotated result. The raw unverified text is never shown.

---

## JSON Parsing Robustness

Step 1 asks Nemotron to return a JSON array. Because Nemotron is a reasoning model, its output may include thinking tokens, markdown formatting, or occasionally unescaped characters inside string values. The parser uses three fallback levels:

1. **Whole-array parse** — `JSON.parse` on the balanced `[{...}]` block (string-aware bracket balancer skips `[` and `]` inside string values).
2. **Control-char cleanup** — strips raw newlines and control characters embedded in string values, then re-tries `JSON.parse`.
3. **Object-by-object extraction** — scans for individual `{...}` blobs and parses each independently. A single malformed sentence cannot drop the rest of the response.

---

## License

MIT
