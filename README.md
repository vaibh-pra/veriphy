# Veriphy

A standalone, three-step agent that post-processes any LLM response to identify factual claims, shortlist the most important ones relative to the original query, and retrieve real arXiv citations — up to four per claim — without hallucinating.

Built as part of the [Automorph](https://github.com/vaibh-pra) project but designed to work with **any** LLM or chatbot on any topic, especially STEM related.

---

## What It Does

LLM responses mix two very different kinds of sentences:

- **Factual claims** — assertions about how algorithms work, what techniques mean, established scientific findings. These *can* be wrong or hallucinated.
- **Everything else** — transitions, rhetorical questions, computed results, opinions, meta-commentary. These need no verification.

Veriphy identifies the first kind, ranks them by how closely they answer the original user question, and traces each one back to real arXiv papers.

---

## Three-Step Pipeline

```
Step 1  markClaims()       LLM (Nemotron by default) reads every sentence and
                           labels it CLAIM or NOT A CLAIM.
                           If the original user query is provided, the prompt
                           instructs the LLM to prioritise sentences that
                           directly answer that question — so claim detection
                           is query-aware, not purely structural.
                           Transitions, opinions, computed values, and filler
                           are never marked regardless of the query.
                           Input is truncated to 5 000 chars before sending.
                           Requires: OLLAMA_API_KEY (for cloud models)

Step 2  shortlistClaims()  No LLM, no API key.
                           Picks up to 5 claims ranked by relevance to the
                           original query (word-overlap score, normalised by
                           query length). Falls back to sentence length when
                           no query is provided.
                           Skips any candidate that shares >55% word overlap
                           with an already-selected claim (Jaccard filter),
                           so near-duplicate sentences are never both cited.

Step 3  findCitations()    Queries the arXiv API — no LLM, no API key.
                           Extracts scored n-gram phrases from each claim,
                           builds a quoted phrase query targeting the abs:
                           field (e.g. abs:"quantum arithmetic coding" AND
                           "von neumann entropy"), fetches up to 4 results per claim sorted by
                           submission date ascending (oldest first), and
                           falls back to a broad keyword search if the
                           phrase query returns nothing.
                           All claim searches run in parallel.
                           Claims with no arXiv match are de-marked.
```

**Only Step 1 uses an LLM.** Steps 2 and 3 are entirely LLM-free.

---

## Citation Rendering

Each cited sentence receives one **[N]** marker per citation found. When a claim matches multiple papers, multiple markers appear inline. When two claims share the exact same paper, they share the same `[N]` number and the source is listed only once.

```
Quantum arithmetic coding must be reversible to obey unitarity. [1][2]
Schumacher compression is the quantum analogue of Huffman coding. [3]

Sources:
[1] Wilde et al., "Quantum Rate-Distortion Coding", arXiv:1108.4985, 2012
[2] Chuang et al., "Quantum Computation and Quantum Information", arXiv:..., 2000
[3] Schumacher, "Quantum Coding", arXiv:quant-ph/9604030, 1996
```

In the browser widget, each `[N]` is rendered as bold green text and scrolls to the matching source entry when clicked.

---

## Repository Structure

```
veriphy/
  core.ts        All logic — three exported functions, no framework dependency
  proxy.ts       Transparent LLM proxy (port 4001) — intercepts before display
  agent.js       Drop-in frontend widget for any chatbot page (zero dependencies)
  agent.json     Marketplace manifest — capabilities, schemas, env requirements
  package.json   npm package definition
  README.md      This file
```

---

## Usage Modes

### Mode 1 — Proxy (transparent interception)

The proxy sits between you and Ollama or any cloud LLM. Every response is verified before it reaches your terminal or application. You do not change how you use your LLM.

```bash
# 1. Start the proxy
OLLAMA_API_KEY=your_key npm run proxy
# [Veriphy Proxy] listening on port 4001
# [Veriphy Proxy] forwarding to http://localhost:11434

# 2. Redirect your client to the proxy
export OLLAMA_HOST=http://localhost:4001

# 3. Use your LLM as normal — responses are verified automatically
ollama run llama3 "Explain quantum arithmetic coding"
```

**Forwarding to a cloud LLM** (OpenAI, Anthropic, etc.):

```bash
REAL_LLM_BASE_URL=https://api.openai.com \
REAL_LLM_API_KEY=sk-your-openai-key \
OLLAMA_API_KEY=your_nemotron_key \
npm run proxy
```

Note: `OLLAMA_API_KEY` is used **only** for Veriphy's internal Nemotron calls in Step 1. It is not forwarded to the upstream LLM unless you also set `REAL_LLM_API_KEY`.

---

### Mode 2 — Browser Widget

Drop `agent.js` into any page that has a chatbot. The widget calls your backend's `/api/mark-claims` and `/api/find-citations` endpoints, renders verified text in-place, and shows a latency counter when Step 3 completes.

```html
<script src="/agent.js"></script>
<script>
  const agent = new VerificationAgent({
    container: document.getElementById('response-div'),
    apiBase:   'https://your-backend.com',  // optional, defaults to same origin
    domain:    'general',                   // optional
    query:     'How does quantum arithmetic coding work?', // optional but recommended
  });

  // After your chatbot produces a response:
  agent.run(responseText);

  // Or pass the query at run time:
  agent.run(responseText, 'How does quantum arithmetic coding work?');

  // Or update the query separately before running:
  agent.setQuery('How does quantum arithmetic coding work?');
  agent.run(responseText);
</script>
```

The widget automatically strips markdown symbols (`**`, `##`, tables, LaTeX `$...$`, original `[N]` markers) from the response text before sending it to the backend, so the LLM sees clean prose rather than formatting noise.

The three pipeline steps are user-triggered inside the widget:

| Button | Action |
|---|---|
| Step 2: Shortlist → | Picks the 5 most query-relevant, diverse claims |
| Step 3: Cite Claims → | Fetches up to 4 arXiv citations per claim |

---

### Mode 3 — Direct API (TypeScript / Node.js)

```typescript
import { markClaims, shortlistClaims, findCitations } from './core';

const query     = 'How does quantum arithmetic coding work?';
const marked    = await markClaims(responseText, 'general', query);
const shortlist = shortlistClaims(marked, 5, 0.55, query);
const cited     = await findCitations(shortlist);

// cited[i].sentence   — sentence text
// cited[i].isClaim    — true if at least one citation was found
// cited[i].citations  — string[] of up to 4 arXiv reference strings
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OLLAMA_API_KEY` | Yes (for cloud models) | API key for the Step 1 LLM. Not needed for local Ollama with open-weight models. |
| `OLLAMA_BASE_URL` | No (default: `http://localhost:11434/v1`) | Base URL of the LLM endpoint used by Step 1. |
| `OLLAMA_MODEL` | No (default: `nemotron-3-super:cloud`) | Model used by Step 1. Any Ollama-compatible model works. |
| `PROXY_PORT` | No (default: `4001`) | Port the proxy listens on. |
| `REAL_LLM_BASE_URL` | Proxy only | Upstream LLM base URL (default: `http://localhost:11434`). |
| `REAL_LLM_API_KEY` | No | Auth key forwarded to the upstream LLM. Omit for local Ollama. |
| `DEFAULT_DOMAIN` | No (default: `general`) | Domain hint passed to Step 1. |
| `DEBUG` | No | Set to `1` to log raw LLM output and arXiv queries to the console. |

---

## arXiv Query Strategy

Step 3 builds quoted phrase queries rather than plain keyword bags. For a claim like:

> "Quantum Arithmetic Coding achieves the von Neumann entropy bound for non-uniform quantum sources."

The query becomes:

```
abs:"quantum arithmetic coding" AND "von neumann entropy bound" AND "non uniform quantum"
```

**How phrases are selected:**
1. All trigrams and bigrams are extracted from the claim (stop-words removed).
2. Each phrase is scored by the number of non-stop-word tokens it contains.
3. The top 3 highest-scoring, non-overlapping phrases are selected. Two phrases overlap if they share a consecutive word pair.
4. The query targets the `abs:` field (abstract) for precision, with automatic fallback to a broad `all:` keyword search if the phrase query returns no results.
5. Results are sorted by submission date **ascending** — oldest matching papers appear first.
6. Up to 4 papers are returned per claim in a single arXiv API call.

---

## Design Decisions

**Why up to 5 shortlisted claims?**
Five claims give broader coverage of the response while remaining readable. All arXiv lookups run in parallel so latency scales with the slowest single request, not with the count.

**Why query-aware shortlisting?**
Ranking by sentence length (the naive approach) often promotes the longest sentence regardless of whether it answers the user's question. Ranking by word-overlap with the original query surfaces the claims most directly relevant to what was actually asked.

**Why quoted phrases instead of bag-of-words arXiv queries?**
Bag-of-words queries like `all:quantum arithmetic coding` match any paper containing those three words anywhere — often returning unrelated results. Quoted phrases like `"quantum arithmetic coding"` require the words to appear adjacent, dramatically improving precision.

**Why sort by oldest date first?**
For well-established topics (compression, graph theory, cryptography), the seminal papers from the 1990s–2000s are more appropriate citations than last month's preprint. Sorting ascending surfaces foundational work while still respecting the relevance of the phrase query that filtered the candidates.

**Why arXiv instead of an LLM for citations?**
LLMs hallucinate citations — fabricated titles, wrong years, non-existent venues. arXiv returns real papers with real IDs that can be independently verified. If arXiv has no result for a claim, the claim is de-marked rather than cited with a hallucination.

**Why de-mark claims with no source?**
A claim with a fabricated citation is worse than no citation at all. If arXiv finds nothing, the sentence silently reverts to plain text.

**Why buffer the full response before processing?**
Veriphy needs the complete response to identify which sentences are claims. Buffering gives a clean single-pass annotated result. The raw, unverified text is never shown.

---

## JSON Parsing Robustness

Step 1 asks the LLM to return a JSON array. Because reasoning models may include thinking tokens, markdown fences, or malformed characters, the parser uses three fallback levels:

1. **Whole-array parse** — `JSON.parse` on the bracket-balanced `[{...}]` block. The balancer is string-aware so sentences like `"The formula H[X]..."` do not truncate the array.
2. **Control-char cleanup** — strips raw newlines and control characters embedded in string values, then retries `JSON.parse`.
3. **Object-by-object extraction** — scans for individual `{...}` blobs and parses each independently. A single malformed sentence cannot drop the rest of the response.

---

## License

MIT
