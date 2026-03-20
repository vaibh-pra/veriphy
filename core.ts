/**
 * ClaimCheck Verification Agent — core logic
 *
 * Pure async functions, no framework dependency.
 * Import these into any Node.js server or agent runtime.
 *
 * Required env: OLLAMA_API_KEY
 */

const OLLAMA_BASE_URL = "https://ollama.com/v1";
const OLLAMA_MODEL    = "nemotron-3-super:cloud";

export type Domain =
  | "cybersecurity"
  | "ppi_network"
  | "crystallography"
  | "social_network"
  | "finance_research"
  | "general";

export interface MarkedSentence {
  sentence: string;
  isClaim:  boolean;
}

export interface CitedSentence {
  sentence: string;
  isClaim:  boolean;
  citation: string | null;
}

/* ─── Internal LLM call ─────────────────────────────────────────────────── */

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
    } catch (e: any) {
      if (attempt >= 3) throw e;
    }
  }
  throw new Error("Ollama unavailable after retries");
}

function parseJsonArray(raw: string): any[] | null {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (_) {}
  try { return JSON.parse(m[0].replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")); } catch (_) {}
  return null;
}

/* ─── Domain context ─────────────────────────────────────────────────────── */

const MARK_EXAMPLES: Record<string, string> = {
  cybersecurity:   "'Botnets use star topologies for C2 communication' is a claim. 'The group order is 36' is not.",
  ppi_network:     "'PLK1 localizes to centrosomes via its Polo-box domain' is a claim. 'Orbit 1 has nodes 0 and 5' is not.",
  crystallography: "'MOFs with dia topology exhibit high gas storage capacity' is a claim. 'The graph has 12 vertices' is not.",
  social_network:  "'Nodes in the same orbit occupy structurally equivalent positions' is a claim. 'There are 3 generators' is not.",
  finance_research:"'Circular transaction patterns are a hallmark of wash trading' is a claim. 'The automorphism group order is 288' is not.",
  general:         "'Shannon entropy measures the average uncertainty in a probability distribution' is a claim. 'The result is 2.3 bits' is not (it is a computed value, not a verifiable assertion about how something works).",
};

const CITE_CTX: Record<string, string> = {
  cybersecurity:   "cybersecurity, network security, botnet detection, intrusion detection, MITRE ATT&CK, CVE",
  ppi_network:     "protein-protein interaction networks, bioinformatics, drug targets, UniProt, STRING database, systems biology",
  crystallography: "crystallography, space groups, X-ray diffraction, Metal-Organic Frameworks, lattice symmetry",
  social_network:  "social network analysis, community detection, influence propagation, network centrality",
  finance_research:"financial fraud, anti-money laundering, wash trading, transaction networks, FATF typologies",
  general:         "mathematics, information theory, computer science, physics, biology, engineering, and related fields",
};

/* ─── Step 1: markClaims ─────────────────────────────────────────────────── */

/**
 * Labels every sentence in an LLM response as a domain-knowledge claim or not.
 * Graph-structural observations (orbits, group order, node IDs) are never claims.
 */
export async function markClaims(
  responseText: string,
  domain: Domain | string = "general"
): Promise<MarkedSentence[]> {
  const domainName = domain === "general" ? "general science and knowledge" : domain.replace(/_/g, " ");
  const fieldCtx   = domain === "general" ? "" : " and graph theory";
  const examples   = MARK_EXAMPLES[domain] ?? MARK_EXAMPLES["general"]!;

  const prompt = `You are a claim identification agent specialising in ${domainName}${fieldCtx}.

Read the text below sentence by sentence. For each sentence decide: CLAIM or NOT A CLAIM.

CLAIM: A sentence asserting a verifiable real-world fact — how a named technique works, what a concept means, who discovered something, or established scientific knowledge. (${examples})

NOT A CLAIM: Transition phrases, questions, greetings, list or table headers, purely mathematical results, computed numbers, AND any sentence about specific graph structure (orbit sizes, group order, generators, node IDs, edge counts) — those are already grounded in exact computation.

RULES:
- Return ONLY a valid JSON array. No markdown, no preamble.
- Plain ASCII only.
- Every input sentence appears exactly once.
- Fields: sentence (string), isClaim (boolean). No other fields.

[{"sentence":"...", "isClaim": true}, ...]

Text:
${responseText}`;

  const raw    = await llm([{ role: "system", content: prompt }, { role: "user", content: "Return the JSON array now." }]);
  const parsed = parseJsonArray(raw);
  return Array.isArray(parsed) ? (parsed as MarkedSentence[]) : [];
}

/* ─── Step 2: shortlistClaims (client-side helper) ───────────────────────── */

/**
 * Pure client-side helper — no LLM call.
 * Picks the 3 most specific-looking claims (by sentence length) and de-marks the rest.
 */
export function shortlistClaims(marked: MarkedSentence[]): MarkedSentence[] {
  const claims = marked.filter(m => m.isClaim);
  const top3   = new Set(
    [...claims]
      .sort((a, b) => b.sentence.length - a.sentence.length)
      .slice(0, 3)
      .map(m => m.sentence)
  );
  return marked.map(m => ({ sentence: m.sentence, isClaim: m.isClaim && top3.has(m.sentence) }));
}

/* ─── Step 3: findCitations ─────────────────────────────────────────────── */

/**
 * For each isClaim:true sentence, finds a real published citation.
 * Sentences with no verifiable source are de-marked.
 * Never fabricates references.
 */
export async function findCitations(
  marked: MarkedSentence[],
  domain: Domain | string = "general"
): Promise<CitedSentence[]> {
  const domainName = domain === "general" ? "general science and knowledge" : domain.replace(/_/g, " ");
  const ctx        = CITE_CTX[domain] ?? CITE_CTX["general"]!;

  const claims = marked.filter(m => m.isClaim);
  if (!claims.length) return marked.map(m => ({ ...m, citation: null }));

  const list   = claims.map((m, i) => `${i + 1}. ${m.sentence}`).join("\n");

  const prompt = `You are a citation agent for ${domainName}.

For EACH numbered claim, find a specific, real published paper or authoritative source that directly supports that exact assertion in the context of ${ctx}.

Rules:
- Source must directly support the claim, not just the general topic.
- If no real specific source exists, return null. Do NOT fabricate.
- Citation format: FirstAuthor et al., "Exact Title", Venue, Year

Return ONLY a JSON array, one object per claim in order. Plain ASCII.

[{"claimNumber": 1, "citation": "..."}, {"claimNumber": 2, "citation": null}]

Claims:
${list}`;

  const raw    = await llm([{ role: "system", content: prompt }, { role: "user", content: "Return the JSON array now, one object per claim in order." }]);
  const parsed = parseJsonArray(raw);

  const citMap = new Map<number, string | null>();
  if (Array.isArray(parsed)) {
    for (const r of parsed) {
      if (r.claimNumber) citMap.set(Number(r.claimNumber), r.citation ?? null);
    }
  }

  let idx = 0;
  return marked.map(m => {
    if (!m.isClaim) return { ...m, citation: null };
    idx++;
    const cit = citMap.get(idx) ?? null;
    return { sentence: m.sentence, isClaim: cit !== null, citation: cit };
  });
}
