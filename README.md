# Veriphy

Veriphy checks AI responses for you. After any LLM answers a question, Veriphy reads the response, finds the sentences that are making factual claims, and looks up real research papers on arXiv to back them up — or flags them if nothing is found.

Built as part of the [Automorph](https://github.com/vaibh-pra) project, but works with any LLM or chatbot.

---

## What It Does

When an AI responds to a question, not every sentence needs to be checked. Some sentences are just transitions, examples, or commentary. Veriphy finds the sentences that are actually *claiming* something — the ones that could be right or wrong — and looks for real papers that support them.

If a paper is found, the sentence gets a citation badge like `[1]`. If nothing is found on arXiv, the sentence is left as plain text rather than inventing a fake citation.

---

## How It Works (Three Steps)

```
Step 1  Mark the claims      An AI model reads every sentence and decides whether
                             it is making a factual claim or not. Things like
                             transitions, examples, opinions, and computed results
                             are skipped. If you provide your original question,
                             the model pays extra attention to sentences that
                             directly answer it.

Step 2  Pick the best ones   No AI needed here. Veriphy picks up to 5 of the most
                             relevant claims — the ones most closely tied to what
                             you actually asked. It also avoids picking two claims
                             that say nearly the same thing.

Step 3  Find the papers      No AI needed here either. For each claim, Veriphy
                             searches arXiv and returns up to 4 real papers.
                             All searches run at the same time, so this is fast.
                             Older, foundational papers are preferred over recent
                             ones for well-established topics.
```

**Only Step 1 uses an AI model.** Steps 2 and 3 are simple searches with no AI involved.

---

## How Citations Are Shown

Each claim that gets a citation shows `[1]`, `[2]`, etc. right after it. If a single claim is supported by multiple papers, it shows all of them: `[1][2][3]`. If two different claims are backed by the same paper, they both show the same number and the paper is only listed once in the sources.

```
Quantum arithmetic coding must be reversible to obey unitarity. [1][2]
Schumacher compression is the quantum analogue of Huffman coding. [3]

Sources:
[1] Wilde et al., "Quantum Rate-Distortion Coding", arXiv:1108.4985, 2012
[2] Chuang et al., "Quantum Computation and Quantum Information", arXiv:..., 2000
[3] Schumacher, "Quantum Coding", arXiv:quant-ph/9604030, 1996
```

In the browser widget, each badge is bold and green. Clicking it scrolls you to the matching source in the list.

---

## Files

```
veriphy/
  core.ts        The main logic — all three steps live here
  proxy.ts       Runs as a middleman between you and your LLM (port 4001)
  agent.js       A small widget you can drop into any web page
  agent.json     Describes what Veriphy can do (for integrations)
  package.json   Project setup
  README.md      This file
```

---

## Ways to Use It

### Option 1 — As a proxy (sits between you and your LLM)

The proxy intercepts every response from your LLM and runs Veriphy on it before you see it. You don't need to change how you use your LLM.

```bash
# Start the proxy
OLLAMA_API_KEY=your_key npm run proxy

# Tell your LLM client to go through the proxy instead
export OLLAMA_HOST=http://localhost:4001

# Use your LLM as normal — every response is verified automatically
ollama run llama3 "Explain arithmetic coding"
```

**Using a cloud LLM instead of Ollama:**

```bash
REAL_LLM_BASE_URL=https://api.openai.com \
REAL_LLM_API_KEY=sk-your-openai-key \
OLLAMA_API_KEY=your_nemotron_key \
npm run proxy
```

`OLLAMA_API_KEY` is only used by Veriphy's own internal model call (Step 1). It is not sent to your LLM.

---

### Option 2 — As a widget on a web page

Drop `agent.js` into any page that has a chatbot. It will add a verification panel that lets you run all three steps with a button click.

```html
<script src="/agent.js"></script>
<script>
  const agent = new VerificationAgent({
    container: document.getElementById('response-div'),
    query: 'How does arithmetic coding work?', // your original question
  });

  // After the chatbot responds:
  agent.run(responseText);

  // Or pass the question at run time:
  agent.run(responseText, 'How does arithmetic coding work?');
</script>
```

The widget cleans up the AI response before checking it — stripping bold markers, headers, tables, and math formatting — so only the actual sentences are analysed.

---

### Option 3 — Directly in code

```typescript
import { markClaims, shortlistClaims, findCitations } from './core';

const query     = 'How does arithmetic coding work?';
const marked    = await markClaims(responseText, 'general', query);
const shortlist = shortlistClaims(marked, 5, 0.55, query);
const cited     = await findCitations(shortlist, 'general', query);

// cited[i].sentence   — the sentence
// cited[i].isClaim    — true if at least one paper was found
// cited[i].citations  — list of up to 4 paper references
```

---

## Settings (Environment Variables)

| Setting | Default | What it does |
|---|---|---|
| `OLLAMA_API_KEY` | — | API key for the AI model used in Step 1. Not needed for local models. |
| `OLLAMA_BASE_URL` | `http://localhost:11434/v1` | Where Step 1 sends its request. |
| `OLLAMA_MODEL` | `nemotron-3-super:cloud` | Which AI model Step 1 uses. |
| `PROXY_PORT` | `4001` | Port the proxy listens on. |
| `REAL_LLM_BASE_URL` | `http://localhost:11434` | Where the proxy forwards your LLM requests. |
| `REAL_LLM_API_KEY` | — | Key to send with forwarded requests (leave blank for local Ollama). |
| `DEFAULT_DOMAIN` | `general` | Topic hint passed to Step 1. |
| `DEBUG` | — | Set to `1` to print detailed logs to the terminal. |

---

## How the Paper Search Works

When searching arXiv for a claim like:

> "Arithmetic coding outperforms Huffman coding by getting closer to the Shannon entropy limit."

Veriphy does the following:

1. **Strips common words** — over 130 words like "first", "encode", "narrow", "symbol", "approach", and "result" are ignored because they appear in almost every AI explanation and don't help find the right paper.

2. **Anchors the search to your topic** — your original question (e.g. "explain arithmetic coding") is used to extract the core subject ("arithmetic coding"). Every single arXiv search must include that subject, so completely unrelated papers can never slip through.

3. **Searches by phrase** — instead of searching for loose keywords, Veriphy searches for the exact phrases it found in the claim. This is much more precise.

4. **Falls back gracefully** — if the phrase search finds nothing, it tries a broader keyword search as a backup.

5. **Prefers older papers** — among all matching papers, the oldest ones are returned first, so you get the foundational work on a topic rather than the most recent preprint.

---

## Why These Choices

**Why ignore 130+ words?**
AI responses use a lot of everyday words that sound specific but aren't — "first", "process", "encode", "narrow", "symbol", "interval". If these words are included in the search, arXiv returns papers about completely unrelated things that happen to use the same words.

**Why anchor every search to your question?**
Without anchoring, a search built from phrases in the AI response can match papers from totally different fields. For example, a response about arithmetic coding might produce the phrase "encode ABBA first" from an example — which could match a paper about the band ABBA or a radio survey. Anchoring every search with "arithmetic coding" prevents this entirely.

**Why prefer older papers?**
For topics that have been around for decades — compression, graph theory, cryptography — the important foundational papers were written in the 1990s and 2000s. Showing a 2024 preprint as the source for a well-known fact gives the wrong impression. Older papers are preferred when the topic is already well-established.

**Why use arXiv instead of asking an AI for citations?**
AI models frequently invent citations — real-sounding paper titles, plausible author names, wrong years, journals that don't exist. arXiv returns real papers with real IDs that you can look up yourself. If no real paper is found, Veriphy leaves the sentence uncited rather than making one up.

**Why process the full response before showing anything?**
Veriphy needs to read all the sentences before it can decide which ones are claims. It waits for the complete response, then returns the annotated version in one go. The raw, unverified response is never shown.

---

## Handling Messy AI Output

Step 1 asks the AI to return a structured list. AI models sometimes include extra commentary, formatting, or broken characters around the list. Veriphy handles this with three fallback levels:

1. Try to parse the full list at once.
2. If that fails, clean up any unusual characters and try again.
3. If that still fails, parse each item in the list one by one — so one bad sentence can't break the whole response.

---

## License

MIT
