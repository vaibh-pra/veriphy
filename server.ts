/**
 * ClaimCheck Verification Agent — standalone server
 *
 * Run independently:
 *   npm start                  (production)
 *   npm run dev                (development, hot-reload)
 *
 * Or inside Docker:
 *   docker build -t claimcheck .
 *   docker run -e OLLAMA_API_KEY=sk-... -p 4000:4000 claimcheck
 *
 * Endpoints:
 *   GET  /health
 *   GET  /client.js            (drop-in frontend class)
 *   POST /api/mark-claims
 *   POST /api/find-citations
 */

import express from "express";
import cors    from "cors";
import path    from "path";
import { markClaims, shortlistClaims, findCitations } from "./core";

const app  = express();
const PORT = parseInt(process.env.PORT || "4000", 10);

app.use(cors());
app.use(express.json({ limit: "5mb" }));

/* ── Health check ───────────────────────────────────────────────────────── */
app.get("/health", (_req, res) => {
  res.json({ status: "ok", agent: "verification-agent", version: "1.0.0" });
});

/* ── Serve drop-in frontend class ──────────────────────────────────────── */
app.get("/client.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "client.js"));
});

/* ── Step 1: Mark Claims ────────────────────────────────────────────────── */
app.post("/api/mark-claims", async (req, res) => {
  try {
    const { responseText, domain } = req.body;
    if (!responseText) return res.status(400).json({ error: "responseText is required" });

    const marked = await markClaims(responseText, domain || "general");
    if (!marked.length) return res.json({ marked: null });
    res.json({ marked });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Step 2: Shortlist (pure helper — exposed for server-side callers) ─── */
app.post("/api/shortlist-claims", (req, res) => {
  try {
    const { marked } = req.body;
    if (!Array.isArray(marked)) return res.status(400).json({ error: "marked array is required" });
    res.json({ shortlisted: shortlistClaims(marked) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Step 3: Find Citations ─────────────────────────────────────────────── */
app.post("/api/find-citations", async (req, res) => {
  try {
    const { marked, domain } = req.body;
    if (!Array.isArray(marked)) return res.status(400).json({ error: "marked array is required" });

    const cited = await findCitations(marked, domain || "general");
    res.json({ cited });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Start ──────────────────────────────────────────────────────────────── */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[ClaimCheck Agent] running on port ${PORT}`);
});
