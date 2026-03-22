'use strict';

const $ = id => document.getElementById(id);

// ── Persist API base URL ────────────────────────────────────────────────────
chrome.storage.local.get('apiBase', ({ apiBase }) => {
  if (apiBase) $('apiBase').value = apiBase;
});

$('apiBase').addEventListener('change', () => {
  chrome.storage.local.set({ apiBase: $('apiBase').value.trim().replace(/\/$/, '') });
});

$('settingsToggle').addEventListener('click', () => {
  const s = $('settings');
  s.style.display = s.style.display === 'none' ? 'block' : 'none';
});

// ── Helpers ─────────────────────────────────────────────────────────────────
function getBase() {
  return ($('apiBase').value.trim().replace(/\/$/, '')) || '';
}

function status(msg) { $('status').textContent = msg; }

async function post(path, body) {
  const base = getBase();
  if (!base) throw new Error('Set your backend URL in ⚙ API settings first.');
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('Server error ' + res.status);
  return res.json();
}

// ── Plain-text citation renderer ────────────────────────────────────────────
function renderPlainText(cited) {
  const citMap = new Map();
  const refs = [];

  const lines = cited.map(s => {
    const cits = Array.isArray(s.citations) ? s.citations
               : s.citation ? [s.citation] : [];
    if (s.isClaim && cits.length > 0) {
      const nums = cits.map(c => {
        if (citMap.has(c)) return citMap.get(c);
        refs.push(c);
        const n = refs.length;
        citMap.set(c, n);
        return n;
      });
      return s.sentence + ' ' + nums.map(n => '[' + n + ']').join('');
    }
    return s.sentence;
  });

  let out = lines.join(' ');
  if (refs.length) {
    out += '\n\n---\nSources:\n' + refs.map((r, i) => '[' + (i+1) + '] ' + r).join('\n');
  } else {
    out += '\n\n(No citations found for this response.)';
  }
  return out;
}

// ── Main verify flow ─────────────────────────────────────────────────────────
$('verifyBtn').addEventListener('click', async () => {
  const responseText = $('response').value.trim();
  const query        = $('query').value.trim();

  if (!responseText) { status('Paste an AI response first.'); return; }

  const btn = $('verifyBtn');
  btn.disabled = true;
  $('output').style.display = 'none';
  $('output').textContent = '';

  try {
    // Step 1 — mark claims
    status('Step 1/3 — identifying claims…');
    const s1 = await post('/api/mark-claims', { responseText, query, domain: 'general' });
    const claimCount = (s1.marked || []).filter(m => m.isClaim).length;
    if (!claimCount) {
      status('No verifiable claims found in this response.');
      btn.disabled = false;
      return;
    }

    // Step 2 — shortlist (server-side or simple client-side fallback)
    status('Step 2/3 — shortlisting relevant claims…');
    let toSend = s1.marked;
    try {
      const s2 = await post('/api/shortlist-claims', { marked: s1.marked, query });
      if (s2.shortlisted) toSend = s2.shortlisted;
    } catch (_) {
      // endpoint may not exist — fall back to sending all marked claims
    }

    // Step 3 — citations
    status('Step 3/3 — finding arXiv citations…');
    const s3 = await post('/api/find-citations', { marked: toSend, query, domain: 'general' });

    const plain = renderPlainText(s3.cited || []);
    $('output').textContent = plain;
    $('output').style.display = 'block';
    status('Done.');
  } catch (err) {
    status('Error: ' + err.message);
  } finally {
    btn.disabled = false;
  }
});
