/**
 * VerificationAgent — drop-in claim verification widget
 *
 * Usage (any page):
 *   <script src="/verificationAgent.js"></script>
 *   <script>
 *     const agent = new VerificationAgent({
 *       container: document.getElementById('my-div'),
 *       apiBase: 'https://your-backend.com',   // optional, defaults to same origin
 *       domain: 'finance_research',             // optional, defaults to 'general'
 *     });
 *     // After your chatbot produces a response:
 *     agent.run(responseText);
 *   </script>
 *
 * API endpoints required on the backend:
 *   POST /api/mark-claims     { responseText, domain } → { marked: [{sentence, isClaim}] }
 *   POST /api/find-citations  { marked, domain }       → { cited: [{sentence, isClaim, citation}] }
 */

(function (global) {
  'use strict';

  /* ─── Embedded CSS (injected once into <head>) ─────────────────────── */
  const CSS = `
.va-wrap { font-family: inherit; line-height: 1.85; }
.va-wrap span { white-space: pre-wrap; }
.va-claim {
  background: rgba(139,92,246,0.10);
  border-radius: 3px;
  padding: 1px 0;
}
.va-pill {
  display: inline-block;
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: .4px;
  border-radius: 3px;
  padding: 0 4px;
  margin-left: 4px;
  vertical-align: middle;
}
.va-pill-claim     { color:#a78bfa; background:rgba(139,92,246,.15); border:1px solid rgba(139,92,246,.3); }
.va-pill-candidate { color:#818cf8; background:rgba(99,102,241,.15); border:1px solid rgba(99,102,241,.3); }
.va-pill-cite {
  color:#10b981; background:rgba(16,185,129,.10); border:1px solid rgba(16,185,129,.3);
  cursor:pointer; transition:background .15s;
}
.va-pill-cite:hover { background:rgba(16,185,129,.22); }
.va-cite-panel {
  display:none;
  margin:3px 0 6px 0;
  padding:5px 10px;
  background:rgba(16,185,129,.06);
  border-left:2px solid #10b981;
  border-radius:0 5px 5px 0;
  font-size:11px;
  color:#a7f3d0;
  line-height:1.5;
}
.va-cite-panel.open { display:block; }
.va-footer {
  display:flex;
  align-items:center;
  justify-content:space-between;
  flex-wrap:wrap;
  gap:6px;
  font-size:10px;
  color:#94a3b8;
  margin-top:10px;
  padding-top:8px;
  border-top:1px solid rgba(255,255,255,.07);
}
.va-btn {
  font-size:10px;
  font-weight:600;
  color:#a78bfa;
  background:rgba(139,92,246,.10);
  border:1px solid rgba(139,92,246,.3);
  border-radius:5px;
  padding:3px 10px;
  cursor:pointer;
  transition:background .15s;
}
.va-btn:hover    { background:rgba(139,92,246,.22); }
.va-btn:disabled { opacity:.45; cursor:not-allowed; }
.va-spinner {
  display:inline-block;
  width:11px; height:11px;
  border:2px solid rgba(139,92,246,.25);
  border-top-color:#a78bfa;
  border-radius:50%;
  animation:va-spin .7s linear infinite;
  vertical-align:middle;
  margin-right:6px;
}
@keyframes va-spin { to { transform:rotate(360deg); } }
`;

  let cssInjected = false;
  function injectCSS() {
    if (cssInjected || document.getElementById('va-css')) return;
    const s = document.createElement('style');
    s.id = 'va-css';
    s.textContent = CSS;
    document.head.appendChild(s);
    cssInjected = true;
  }

  /* ─── Instance registry (lets inline onclick reach the instance) ───── */
  if (!global.__va) global.__va = {};
  let _nextId = 1;

  /* ─── VerificationAgent class ───────────────────────────────────────── */
  function VerificationAgent(opts) {
    if (!opts || !opts.container) throw new Error('VerificationAgent: container is required');
    this._el      = typeof opts.container === 'string'
                      ? document.querySelector(opts.container)
                      : opts.container;
    this._api     = (opts.apiBase || '').replace(/\/$/, '');
    this._domain  = opts.domain || 'general';
    this._id      = 'va' + (_nextId++);
    this._marked  = null;
    this._shortlisted = null;

    global.__va[this._id] = this;
    injectCSS();
  }

  /* Public: call with the chatbot response text */
  VerificationAgent.prototype.run = async function (responseText) {
    this._raw = responseText;
    this._render(`<span class="va-spinner"></span>Marking claims…`);
    try {
      const res  = await this._post('/api/mark-claims', { responseText, domain: this._domain });
      const data = await res.json();
      if (data.marked && data.marked.length) {
        this._marked = data.marked;
        this._renderStep1();
      } else {
        this._el.innerHTML = `<div class="va-wrap">${this._esc(responseText)}</div>`;
      }
    } catch (_) {
      this._el.innerHTML = `<div class="va-wrap">${this._esc(responseText)}</div>`;
    }
  };

  /* Step 2 — client-side: pick top 3 by length, de-mark the rest */
  VerificationAgent.prototype.shortlist = function () {
    const claims = this._marked.filter(m => m.isClaim);
    const top3   = new Set(
      [...claims].sort((a, b) => b.sentence.length - a.sentence.length)
                 .slice(0, 3)
                 .map(m => m.sentence)
    );
    this._shortlisted = this._marked.map(m => ({
      sentence: m.sentence,
      isClaim:  m.isClaim && top3.has(m.sentence),
    }));
    this._renderStep2();
  };

  /* Step 3 — LLM citation lookup for the 3 shortlisted claims */
  VerificationAgent.prototype.cite = async function (btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = 'Finding citations…'; }
    const toSend = this._shortlisted || this._marked;
    try {
      const res  = await this._post('/api/find-citations', { marked: toSend, domain: this._domain });
      const data = await res.json();
      if (data.cited && data.cited.length) {
        this._renderStep3(data.cited);
      } else if (btnEl) {
        btnEl.disabled = false;
        btnEl.textContent = 'Step 3: Cite 3 Claims →';
      }
    } catch (_) {
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Step 3: Cite 3 Claims →'; }
    }
  };

  /* ─── Render helpers ─────────────────────────────────────────────────── */

  VerificationAgent.prototype._renderStep1 = function () {
    const id     = this._id;
    let html     = '<div class="va-wrap">';
    let count    = 0;
    for (const m of this._marked) {
      const s = this._esc(m.sentence);
      if (m.isClaim) {
        count++;
        html += `<span class="va-claim">${s}<span class="va-pill va-pill-claim">claim</span></span> `;
      } else {
        html += `<span>${s}</span> `;
      }
    }
    html += `<div class="va-footer">
      <span>📌 ${count} of ${this._marked.length} sentences identified as claims</span>
      <button class="va-btn" onclick="window.__va['${id}'].shortlist()">Step 2: Shortlist 3 →</button>
    </div></div>`;
    this._el.innerHTML = html;
  };

  VerificationAgent.prototype._renderStep2 = function () {
    const id  = this._id;
    let html  = '<div class="va-wrap">';
    let count = 0;
    for (const m of this._shortlisted) {
      const s = this._esc(m.sentence);
      if (m.isClaim) {
        count++;
        html += `<span class="va-claim">${s}<span class="va-pill va-pill-candidate">candidate</span></span> `;
      } else {
        html += `<span>${s}</span> `;
      }
    }
    html += `<div class="va-footer">
      <span>📌 ${count} candidate${count !== 1 ? 's' : ''} shortlisted</span>
      <button class="va-btn" id="${id}-cite-btn"
        onclick="window.__va['${id}'].cite(document.getElementById('${id}-cite-btn'))">
        Step 3: Cite 3 Claims →
      </button>
    </div></div>`;
    this._el.innerHTML = html;
  };

  VerificationAgent.prototype._renderStep3 = function (cited) {
    let html  = '<div class="va-wrap">';
    let count = 0;
    let pid   = 0;
    for (const m of cited) {
      const s = this._esc(m.sentence);
      if (m.isClaim && m.citation) {
        count++;
        const panelId = `${this._id}-p${++pid}`;
        const cite    = this._esc(m.citation);
        html += `<span class="va-claim">${s}<span class="va-pill va-pill-cite"
          onclick="(function(el){var p=document.getElementById('${panelId}');p.classList.toggle('open');})(this)"
          >[cite]</span></span><div class="va-cite-panel" id="${panelId}">${cite}</div> `;
      } else {
        html += `<span>${s}</span> `;
      }
    }
    html += `<div class="va-footer"><span>📌 ${count} claim${count !== 1 ? 's' : ''} cited</span></div></div>`;
    this._el.innerHTML = html;
  };

  /* ─── Utilities ──────────────────────────────────────────────────────── */

  VerificationAgent.prototype._render = function (inner) {
    this._el.innerHTML = `<div class="va-wrap">${inner}</div>`;
  };

  VerificationAgent.prototype._post = function (path, body) {
    return fetch(this._api + path, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
  };

  VerificationAgent.prototype._esc = function (str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  /* Expose */
  global.VerificationAgent = VerificationAgent;

})(window);
