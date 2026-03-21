/**
 * Verifi — core logic (self-contained, no local imports)
 *
 * Exports three functions used by /api/mark-claims and /api/find-citations.
 * The canonical standalone package lives at: github.com/vaibh-pra/verifi-agent
 */

const OLLAMA_BASE_URL = "https://ollama.com/v1";
const OLLAMA_MODEL    = "nemotron-3-super:cloud";

export interface MarkedSentence { sentence: string; isClaim: boolean; }
export interface CitedSentence  { sentence: string; isClaim: boolean; citation: string | null; }

async function llm(messages: { role: string; content: string }[]): Promise<string> {
  const key = process.env.OLLAMA_API_KEY;
  if (!key) throw new Error("OLLAMA_API_KEY is not set");
  for (let attempt = 0; attempt <= 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120_000);
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
    } catch (e: any) { if (attempt >= 3) throw e; }
  }
  throw new Error("Ollama unavailable after retries");
}

function parseJsonArray(raw: string): any[] | null {
  // Skip scalar arrays like [1] or [citation needed] — look for start of object array
  const start = raw.search(/\[\s*\{/);
  if (start === -1) return null;

  // String-aware bracket balancer: ignore [ and ] that appear inside JSON string values
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (esc)             { esc = false; continue; }
    if (ch === "\\" && inStr) { esc = true;  continue; }
    if (ch === '"')      { inStr = !inStr; continue; }
    if (inStr)           continue;
    if (ch === "[")      depth++;
    else if (ch === "]") { depth--; if (depth === 0) { end = i; break; } }
  }

  if (end !== -1) {
    const candidate = raw.slice(start, end + 1);
    // Try 1: as-is
    try { return JSON.parse(candidate); } catch (_) {}
    // Try 2: replace raw control chars (incl. unescaped newlines inside string values)
    try { return JSON.parse(candidate.replace(/[\x00-\x1F\x7F]/g, " ")); } catch (_) {}
  }

  // Try 3: object-by-object regex extraction — survives unescaped quotes or other
  // character-level corruption that breaks the whole-array parse.
  const results: any[] = [];
  const objRe = /\{[^{}]{1,4000}\}/gs;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(raw)) !== null) {
    const obj = m[0];
    // Attempt JSON.parse on the individual object first
    try {
      const parsed = JSON.parse(obj);
      if (typeof parsed.sentence === "string" && typeof parsed.isClaim === "boolean") {
        results.push(parsed); continue;
      }
    } catch (_) {}
    // Regex fallback: extract sentence and isClaim independently
    const sentM  = obj.match(/"sentence"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const claimM = obj.match(/"isClaim"\s*:\s*(true|false)/);
    if (sentM && claimM) {
      results.push({ sentence: sentM[1].replace(/\\"/g, '"'), isClaim: claimM[1] === "true" });
    }
  }
  return results.length > 0 ? results : null;
}

export async function markClaims(responseText: string, _domain?: string): Promise<MarkedSentence[]> {
  const prompt = `You are Verifi — an AI claim identification agent.

Read the text below sentence by sentence. For each sentence decide: CLAIM or NOT A CLAIM.

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
${responseText}`;
  const raw    = await llm([{ role: "system", content: prompt }, { role: "user", content: "Return the JSON array now." }]);
  if (process.env.DEBUG === "1") console.log("[markClaims] raw LLM output (first 600 chars):", raw.slice(0, 600));
  const parsed = parseJsonArray(raw);
  if (process.env.DEBUG === "1" && !parsed) console.log("[markClaims] parseJsonArray returned null — full raw:\n", raw);
  return Array.isArray(parsed) ? (parsed as MarkedSentence[]) : [];
}

function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set((a.toLowerCase().match(/\w+/g) || []));
  const wordsB = new Set((b.toLowerCase().match(/\w+/g) || []));
  let intersection = 0;
  for (const w of wordsA) if (wordsB.has(w)) intersection++;
  const union = new Set([...wordsA, ...wordsB]).size;
  return union === 0 ? 0 : intersection / union;
}

export function shortlistClaims(marked: MarkedSentence[], maxClaims = 5, similarityThreshold = 0.55): MarkedSentence[] {
  const candidates = [...marked.filter(m => m.isClaim)]
    .sort((a, b) => b.sentence.length - a.sentence.length);

  const selected: string[] = [];
  for (const candidate of candidates) {
    if (selected.length >= maxClaims) break;
    const tooSimilar = selected.some(s => jaccardSimilarity(s, candidate.sentence) > similarityThreshold);
    if (!tooSimilar) selected.push(candidate.sentence);
  }

  const selectedSet = new Set(selected);
  return marked.map(m => ({ sentence: m.sentence, isClaim: m.isClaim && selectedSet.has(m.sentence) }));
}

const ARXIV_STOP_WORDS = new Set([
  "a","an","the","is","are","was","were","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","must","can",
  "this","that","these","those","of","in","to","for","on","at","by","with",
  "from","and","or","but","not","as","it","its","also","which","than","more",
  "most","such","each","both","they","their","thus","hence","via","per","when",
  "where","how","all","any","some","one","two","three","often","very","well",
]);

async function searchArxiv(claim: string): Promise<string | null> {
  const terms = (claim.toLowerCase().match(/\b[a-z][a-z0-9\-]{2,}\b/g) || [])
    .filter(w => !ARXIV_STOP_WORDS.has(w));
  const query = terms.slice(0, 10).join(" ");
  if (!query) return null;

  try {
    const url = `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=1&sortBy=relevance`;
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
