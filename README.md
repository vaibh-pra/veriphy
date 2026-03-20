# ClaimCheck Verification Agent

A standalone, three-step AI agent that post-processes any LLM chatbot response to identify domain-knowledge claims, shortlist the most verifiable ones, and find accurate published citations for each.

Built as part of the [Automorph](https://github.com/vaibh-pra/automorph-backend) project — an AI-powered graph automorphism analysis platform — but designed to work with **any** LLM chatbot.

---

## What It Does

LLM responses often mix two fundamentally different kinds of sentences:

- **Graph-structural observations** — orbit sizes, group order, generators, node IDs. These come from exact computation (Nauty) and need no verification.
- **Domain-knowledge claims** — assertions about how algorithms behave, what patterns mean in a field, established scientific findings. These *can* be wrong or hallucinated.

ClaimCheck separates the two and traces the second kind back to real sources.

---

## Three-Step Pipeline

```
Step 1  markClaims()       LLM reads every sentence and labels it as a
                           domain-knowledge claim or not. Graph-structural
                           observations are never marked.

Step 2  shortlistClaims()  Client-side (no LLM call). Picks the 3 most
                           specific-looking claims by sentence length and
                           de-marks the rest.

Step 3  findCitations()    LLM finds one real published source per shortlisted
                           claim. Claims with no verifiable source are
                           de-marked. Nothing is fabricated.
```

The final output is the original response with up to 3 sentences annotated with citations — every other sentence is left exactly as-is.

---

## Supported Domains

| Domain key | Context |
|---|---|
| `cybersecurity` | Botnet detection, MITRE ATT&CK, CVE, network security |
| `ppi_network` | Protein-protein interaction networks, bioinformatics, drug targets |
| `crystallography` | Space groups, X-ray diffraction, Metal-Organic Frameworks |
| `social_network` | Community detection, influence propagation, network centrality |
| `finance_research` | AML, wash trading, transaction network fraud, FATF typologies |
| `general` | Graph theory, network science, combinatorics |

---

## Repository Structure

```
claimcheck-agent/
  core.ts        All logic — three exported functions, no framework dependency
  server.ts      Standalone Express server (runs independently on port 4000)
  client.js      Drop-in frontend class for any chatbot page (zero dependencies)
  agent.json     Marketplace manifest — capabilities, schemas, env requirements
  package.json   npm package definition (@automorph/verification-agent)
  Dockerfile     Container definition
```

---

## Quick Start

### Run as a standalone server

```bash
git clone https://github.com/vaibh-pra/claimcheck-agent.git
cd claimcheck-agent
npm install
OLLAMA_API_KEY=your_key npm start
# Agent running on http://localhost:4000
```

### Run in Docker

```bash
docker build -t claimcheck-agent .
docker run -e OLLAMA_API_KEY=your_key -p 4000:4000 claimcheck-agent
```

---

## API Reference

### `GET /health`

Returns agent status.

```json
{ "status": "ok", "agent": "verification-agent", "version": "1.0.0" }
```

---

### `POST /api/mark-claims`

Labels every sentence in an LLM response as a domain-knowledge claim or not.

**Request**
```json
{
  "responseText": "Botnets often use star topologies for C2 communication. The graph has 12 nodes and group order 36.",
  "domain": "cybersecurity"
}
```

**Response**
```json
{
  "marked": [
    { "sentence": "Botnets often use star topologies for C2 communication.", "isClaim": true },
    { "sentence": "The graph has 12 nodes and group order 36.", "isClaim": false }
  ]
}
```

---

### `POST /api/shortlist-claims`

Picks the top 3 claims by sentence length and de-marks the rest. No LLM call.

**Request**
```json
{ "marked": [ ...output of mark-claims... ] }
```

**Response**
```json
{ "shortlisted": [ ...same array with at most 3 isClaim:true entries... ] }
```

---

### `POST /api/find-citations`

Finds a real published source for each `isClaim: true` sentence. De-marks any claim that cannot be sourced. Never fabricates.

**Request**
```json
{
  "marked": [ ...output of shortlist-claims... ],
  "domain": "cybersecurity"
}
```

**Response**
```json
{
  "cited": [
    {
      "sentence": "Botnets often use star topologies for C2 communication.",
      "isClaim": true,
      "citation": "Gu et al., \"BotSniffer: Detecting Botnet Command and Control Channels\", NDSS, 2008"
    }
  ]
}
```

---

## Drop-in Frontend Integration

Add the agent to any chatbot page with one script tag:

```html
<script src="https://your-agent-url/client.js"></script>
```

Then after your LLM stream completes:

```js
const agent = new VerificationAgent({
  container: document.getElementById('chat-response'),
  apiBase:   'https://your-agent-url',
  domain:    'cybersecurity'
});

await agent.run(responseText);
// Automatically runs all 3 steps and annotates the UI
```

---

## Embed in Your Own Node.js Server

Import the pure functions directly — no extra server needed:

```ts
import { markClaims, shortlistClaims, findCitations } from './core';

const marked      = await markClaims(responseText, 'finance_research');
const shortlisted = shortlistClaims(marked);
const cited       = await findCitations(shortlisted, 'finance_research');
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OLLAMA_API_KEY` | Yes | API key for the Ollama cloud endpoint (nemotron-3-super:cloud) |
| `PORT` | No (default: 4000) | Port the standalone server listens on |

---

## Design Decisions

**Why shortlist only 3 claims?**
Finding citations is an LLM call and costs latency. Three is the sweet spot — enough to add value, few enough to stay fast.

**Why exclude graph-structural observations?**
They come from Nauty, an exact mathematical computation. They are already verified by definition. Marking them as claims would be misleading.

**Why de-mark claims with no source?**
A claim with a fabricated citation is worse than no citation at all. If the LLM cannot find a real specific source, the sentence silently reverts to plain text.

---

## License

MIT
