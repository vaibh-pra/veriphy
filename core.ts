/**
 * Veriphy — core logic (self-contained, no local imports)
 *
 * Exports three functions used by /api/mark-claims and /api/find-citations.
 * The canonical standalone package lives at: github.com/vaibh-pra/veriphy-agent
 *
 * Step 1 (markClaims)     — LLM labels each sentence as CLAIM or NOT A CLAIM
 * Step 2 (shortlistClaims) — Jaccard deduplication, top 5 diverse claims
 * Step 3 (findCitations)   — arXiv API lookup, no LLM needed
 */

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
const OLLAMA_MODEL    = process.env.OLLAMA_MODEL    || "nemotron-3-super:cloud";

export interface MarkedSentence { sentence: string; isClaim: boolean; }
export interface CitedSentence  { sentence: string; isClaim: boolean; citation: string | null; }

// ── LLM call (Step 1 only) ───────────────────────────────────────────────────

async function llm(messages: { role: string; content: string }[]): Promise<string> {
  const key = process.env.OLLAMA_API_KEY || "";
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 240_000);
      const res   = await fetch(`${OLLAMA_BASE_URL}/chat/completions`, {
        method:  "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body:    JSON.stringify({ model: OLLAMA_MODEL, messages, max_tokens: 8192, stream: false }),
        signal:  ctrl.signal,
      });
      clearTimeout(timer);
      if (res.status === 503 || res.status === 429) continue;
      if (!res.ok) throw new Error(`Ollama error ${res.status}`);
      const data = await res.json() as any;
      return data.choices?.[0]?.message?.content ?? "";
    } catch (e: any) {
      if (e.name === "AbortError") throw new Error("LLM timed out after 4 minutes — try a shorter prompt");
      if (attempt >= 3) throw e;
    }
  }
  throw new Error("Ollama unavailable after retries");
}

// ── Robust JSON parser (3-level fallback) ────────────────────────────────────

function parseJsonArray(raw: string): any[] | null {
  const start = raw.search(/\[\s*\{/);
  if (start === -1) return null;

  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (esc)              { esc = false; continue; }
    if (ch === "\\" && inStr) { esc = true; continue; }
    if (ch === '"')       { inStr = !inStr; continue; }
    if (inStr)            continue;
    if (ch === "[")       depth++;
    else if (ch === "]")  { depth--; if (depth === 0) { end = i; break; } }
  }

  if (end !== -1) {
    const candidate = raw.slice(start, end + 1);
    try { return JSON.parse(candidate); } catch (_) {}
    try { return JSON.parse(candidate.replace(/[\x00-\x1F\x7F]/g, " ")); } catch (_) {}
  }

  const results: any[] = [];
  const objRe = /\{[^{}]{1,4000}\}/gs;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(raw)) !== null) {
    try {
      const parsed = JSON.parse(m[0]);
      if (typeof parsed.sentence === "string" && typeof parsed.isClaim === "boolean") {
        results.push(parsed); continue;
      }
    } catch (_) {}
    const sentM  = m[0].match(/"sentence"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const claimM = m[0].match(/"isClaim"\s*:\s*(true|false)/);
    if (sentM && claimM)
      results.push({ sentence: sentM[1].replace(/\\"/g, '"'), isClaim: claimM[1] === "true" });
  }
  return results.length > 0 ? results : null;
}

// ── Step 1: LLM-based claim detection ───────────────────────────────────────

const MAX_MARK_CHARS = 5000;

function truncateToSentenceBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastBoundary = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "), cut.lastIndexOf("\n"));
  return lastBoundary > maxChars * 0.5 ? cut.slice(0, lastBoundary + 1) : cut;
}

export async function markClaims(responseText: string, _domain?: string, query?: string): Promise<MarkedSentence[]> {
  const text = truncateToSentenceBoundary(responseText, MAX_MARK_CHARS);
  if (text.length < responseText.length && process.env.DEBUG === "1")
    console.log(`[Veriphy] Input truncated ${responseText.length} → ${text.length} chars for claim marking`);

  const queryContext = query
    ? `\nThe user's original question was: "${query}"\nPrioritise marking sentences as CLAIM if they directly answer or are highly relevant to this question.\n`
    : "";

  const prompt = `You are Veriphy — an AI claim identification agent.

Read the text below sentence by sentence. For each sentence decide: CLAIM or NOT A CLAIM.
${queryContext}
CLAIM: A sentence asserting a specific, verifiable fact — how a named technique, algorithm, or system works; an established scientific finding; a measurable property; or a relationship supported by literature.
Examples:
- "Arithmetic coding approaches the theoretical entropy limit for data compression." → CLAIM
- "Shannon entropy measures the average uncertainty in a probability distribution." → CLAIM
- "Neurons in the hippocampus play a key role in spatial memory formation." → CLAIM

NOT A CLAIM: Transition phrases, rhetorical questions, greetings, list or table headers, computed numerical results, personal opinions, meta-commentary about the response, or vague encouragements.
Examples:
- "Here is a breakdown of how this works." → NOT A CLAIM
- "Let me explain this step by step." → NOT A CLAIM
- "The result is 2.3 bits." → NOT A CLAIM (a computed value, not a verifiable assertion)
- "That's a great question!" → NOT A CLAIM
- "In summary..." → NOT A CLAIM

RULES:
- Return ONLY a valid JSON array. No markdown, no preamble.
- Plain ASCII only. Fields: sentence (string), isClaim (boolean). No other fields.
- Every input sentence appears exactly once.

[{"sentence":"...", "isClaim": true}, ...]

Text:
${text}`;

  const raw    = await llm([{ role: "system", content: prompt }, { role: "user", content: "Return the JSON array now." }]);
  if (process.env.DEBUG === "1") console.log("[markClaims] raw LLM output (first 600 chars):", raw.slice(0, 600));
  const parsed = parseJsonArray(raw);
  if (process.env.DEBUG === "1" && !parsed) console.log("[markClaims] parseJsonArray returned null — full raw:\n", raw);
  return Array.isArray(parsed) ? (parsed as MarkedSentence[]) : [];
}

// ── Step 2: Shortlist diverse claims (Jaccard deduplication) ─────────────────

function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set((a.toLowerCase().match(/\w+/g) || []));
  const wordsB = new Set((b.toLowerCase().match(/\w+/g) || []));
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

export function shortlistClaims(marked: MarkedSentence[], maxClaims = 5, similarityThreshold = 0.55, query?: string): MarkedSentence[] {
  const queryWords = query
    ? new Set((query.toLowerCase().match(/\w+/g) || []).filter(w => w.length > 2))
    : null;

  // Score each claim: if a query is provided, rank by word-overlap with query;
  // otherwise fall back to sentence length as a proxy for specificity.
  function relevanceScore(sentence: string): number {
    if (!queryWords || queryWords.size === 0) return sentence.length;
    const sentWords = (sentence.toLowerCase().match(/\w+/g) || []);
    const overlap = sentWords.filter(w => queryWords.has(w)).length;
    return overlap / Math.sqrt(queryWords.size); // normalise by query length
  }

  const candidates = [...marked.filter(m => m.isClaim)]
    .sort((a, b) => relevanceScore(b.sentence) - relevanceScore(a.sentence));

  const selected: string[] = [];
  for (const candidate of candidates) {
    if (selected.length >= maxClaims) break;
    const tooSimilar = selected.some(s => jaccardSimilarity(s, candidate.sentence) > similarityThreshold);
    if (!tooSimilar) selected.push(candidate.sentence);
  }

  const selectedSet = new Set(selected);
  return marked.map(m => ({ sentence: m.sentence, isClaim: m.isClaim && selectedSet.has(m.sentence) }));
}

// ── Step 3: arXiv citation lookup ────────────────────────────────────────────

const ARXIV_STOP_WORDS = new Set([
  "a","an","the","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","must","can",
  "this","that","these","those","of","in","to","for","on","at","by","with",
  "from","and","or","but","not","as","it","its","also","which","than","more",
  "most","such","each","both","they","their","thus","hence","via","per","when",
  "where","how","all","any","some","one","two","three","often","very","well",
  "show","shows","shown","use","used","uses","using","based","approach","method",
  "result","results","work","works","paper","study","propose","provides","achieve",
]);

// Build a quoted phrase query from the claim using n-gram extraction
function buildArxivQuery(claim: string): { primary: string; fallback: string } {
  const words = (claim.toLowerCase().match(/\b[a-z][a-z0-9]{1,}\b/g) || []);
  const isKey = (w: string) => !ARXIV_STOP_WORDS.has(w) && w.length > 2;

  // Score a phrase by how many key words it contains
  const score = (ws: string[]) => ws.filter(isKey).length;

  // Extract scored trigrams (need at least 2 key words)
  type Phrase = { text: string; ws: string[]; sc: number };
  const candidates: Phrase[] = [];
  for (let i = 0; i <= words.length - 3; i++) {
    const ws = [words[i], words[i+1], words[i+2]];
    const sc = score(ws);
    if (sc >= 2) candidates.push({ text: ws.join(" "), ws, sc });
  }
  // Extract scored bigrams (need at least 1 key word)
  for (let i = 0; i <= words.length - 2; i++) {
    const ws = [words[i], words[i+1]];
    const sc = score(ws);
    if (sc >= 1) candidates.push({ text: ws.join(" "), ws, sc });
  }

  // Sort highest-scoring first
  candidates.sort((a, b) => b.sc - a.sc);

  // Two phrases overlap if they share a consecutive word pair (a bigram)
  function sharesABigram(ws1: string[], ws2: string[]): boolean {
    const bigrams1 = new Set<string>();
    for (let i = 0; i < ws1.length - 1; i++) bigrams1.add(ws1[i] + "|" + ws1[i+1]);
    for (let i = 0; i < ws2.length - 1; i++) {
      if (bigrams1.has(ws2[i] + "|" + ws2[i+1])) return true;
    }
    return false;
  }

  // Pick up to 3 non-overlapping highest-scoring phrases
  const selected: Phrase[] = [];
  for (const c of candidates) {
    if (selected.length >= 3) break;
    if (!selected.some(s => sharesABigram(s.ws, c.ws))) selected.push(c);
  }

  const singles = words.filter(isKey);

  if (selected.length === 0) {
    const kw = singles.slice(0, 6).join(" ");
    return { primary: `all:${kw}`, fallback: `ti:${singles.slice(0, 4).join(" ")}` };
  }

  const quoted   = selected.map(p => `"${p.text}"`).join(" AND ");
  const primary  = `abs:${quoted}`;
  const fallback = `all:${singles.slice(0, 6).join(" ")}`;
  return { primary, fallback };
}

async function runArxivQuery(query: string): Promise<string | null> {
  try {
    const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&max_results=1&sortBy=relevance`;
    if (process.env.DEBUG === "1") console.log("[arXiv] query:", query);
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const xml = await res.text();
    if (!xml.includes("<entry>")) return null;

    const titleMatch     = xml.match(/<entry>[\s\S]*?<title>([\s\S]*?)<\/title>/);
    const firstNameMatch = xml.match(/<author>\s*<name>([\s\S]*?)<\/name>/);
    const publishedMatch = xml.match(/<published>([\s\S]*?)<\/published>/);
    const idMatch        = xml.match(/<id>\s*https?:\/\/arxiv\.org\/abs\/([^\s<]+)\s*<\/id>/);

    if (!titleMatch || !idMatch) return null;

    const title    = titleMatch[1].trim().replace(/\s+/g, " ");
    const year     = publishedMatch?.[1]?.slice(0, 4) ?? "";
    const arxivId  = idMatch[1].trim();
    const rawName  = firstNameMatch?.[1]?.trim() ?? "";
    const lastName = rawName ? rawName.split(/\s+/).pop()! : "Unknown";
    const author   = rawName.includes(" ") ? `${lastName} et al.` : rawName;

    if (process.env.DEBUG === "1") console.log(`[arXiv] found: ${author} (${year}) arXiv:${arxivId}`);
    return `${author}, "${title}", arXiv:${arxivId}${year ? `, ${year}` : ""}`;
  } catch {
    return null;
  }
}

async function searchArxiv(claim: string): Promise<string | null> {
  const { primary, fallback } = buildArxivQuery(claim);
  // Try precise phrase query first, fall back to broad keyword search
  return (await runArxivQuery(primary)) ?? (await runArxivQuery(fallback));
}

export async function findCitations(marked: MarkedSentence[], _domain?: string): Promise<CitedSentence[]> {
  const claims = marked.filter(m => m.isClaim);
  if (!claims.length) return marked.map(m => ({ ...m, citation: null }));

  const results = await Promise.all(claims.map(m => searchArxiv(m.sentence)));

  let idx = 0;
  return marked.map(m => {
    if (!m.isClaim) return { ...m, citation: null };
    const citation = results[idx++] ?? null;
    return { sentence: m.sentence, isClaim: citation !== null, citation };
  });
}
