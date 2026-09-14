/**
 * iccp-inspector.js — a local page that shows exactly what iccp-client.js sent
 * and received, live, as you use the app.
 * =============================================================================
 *   node iccp-inspector.js          # open http://localhost:4200
 *
 * Reads iccp-api-log.jsonl (iccp-client.js's own audit log — every request and
 * response is already written there, redacted the same way regardless of
 * whether this inspector is running). This tool adds nothing to what's
 * already on disk; it just makes it readable: each XML field is flattened to
 * a path → value row so a specific field (a customFieldValue, a companyId, a
 * PAN) can be checked at a glance instead of read out of raw XML.
 *
 * Card numbers and CVVs (Pan/Avv) are already redacted by iccp-client.js
 * BEFORE they reach the log file — this tool only ever sees what's on disk,
 * so it can't show them even if asked to.
 */

const express = require("express");
const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

const PORT = Number(process.env.ICCP_INSPECTOR_PORT || 4200);
const LOG_FILE = process.env.ICCP_LOG_FILE || path.join(__dirname, "iccp-api-log.jsonl");

const app = express();
app.use(express.json());

const xmlParser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: false, parseTagValue: false });

/** The SOAP operation name — the element just inside <soapenv:Body>, not Envelope itself. */
function rootElementName(xml) {
  const body = String(xml || "").match(/<(?:[\w-]+:)?Body[^>]*>\s*<(?:[\w-]+:)?([A-Za-z][\w-]*)/);
  if (body) return body[1];
  const any = String(xml || "").match(/<(?:[\w-]+:)?([A-Za-z][\w-]*)[ >/]/);
  return any ? any[1] : "(unknown)";
}

/** Every leaf element/attribute in an XML doc, as a flat list of {path, value}. */
function flattenXml(xml) {
  if (!xml || typeof xml !== "string") return [];
  let parsed;
  try {
    parsed = xmlParser.parse(xml);
  } catch {
    return [{ path: "(unparseable)", value: xml.slice(0, 200) }];
  }
  const out = [];
  const walk = (node, prefix) => {
    if (node == null || typeof node !== "object") {
      if (node !== "" && node != null) out.push({ path: prefix || "/", value: String(node) });
      return;
    }
    for (const [key, val] of Object.entries(node)) {
      if (key === "?xml") continue;
      // Namespace declarations are wire boilerplate, not data to verify.
      if (/^@_xmlns(:|$)/.test(key)) continue;
      if (key === "#text") {
        if (val !== "") out.push({ path: prefix, value: String(val) });
        continue;
      }
      const label = key.startsWith("@_") ? `${prefix}[@${key.slice(2)}]` : `${prefix}/${key}`;
      const values = Array.isArray(val) ? val : [val];
      values.forEach((v, i) => {
        const indexed = values.length > 1 ? `${label}[${i}]` : label;
        walk(v, indexed);
      });
    }
  };
  walk(parsed, "");
  return out.filter((r) => r.path && r.path !== "/");
}

function readEntries() {
  let text;
  try {
    text = fs.readFileSync(LOG_FILE, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((line, i) => {
      try {
        const entry = JSON.parse(line);
        return {
          seq: i,
          at: entry.at,
          direction: entry.direction,
          endpoint: entry.endpoint,
          url: entry.url,
          operation: rootElementName(entry.request),
          status: entry.status,
          ms: entry.ms,
          error: entry.error || null,
          requestFields: flattenXml(entry.request),
          responseFields: entry.response ? flattenXml(entry.response) : [],
          requestXml: entry.request || null,
          responseXml: entry.response || null,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

app.get("/api/entries", (_req, res) => res.json(readEntries()));

app.post("/api/clear", (_req, res) => {
  try {
    fs.writeFileSync(LOG_FILE, "");
  } catch {
    // no log file yet — nothing to clear
  }
  res.json({ ok: true });
});

// ─── Live updates: watch the log file, push new entries over SSE ──────────
const subscribers = new Set();
let lastSize = 0;
try {
  lastSize = fs.statSync(LOG_FILE).size;
} catch {
  lastSize = 0;
}

fs.watchFile(LOG_FILE, { interval: 500 }, () => {
  for (const res of subscribers) {
    try {
      res.write("event: changed\ndata: {}\n\n");
    } catch {
      subscribers.delete(res);
    }
  }
});

app.get("/events", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": connected\n\n");
  subscribers.add(res);
  req.on("close", () => subscribers.delete(res));
});

app.get("/", (_req, res) => {
  res.type("html").send(PAGE);
});

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>ICCP Inspector</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f4f6f8; --surface: #ffffff; --line: #dde3e8; --ink: #16202c; --muted: #647180;
    --accent: #2454a6; --ok: #2f7d5e; --err: #b4432f;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #10161d; --surface: #17202a; --line: #2b3844; --ink: #e7ecf1; --muted: #9aa7b3; --accent: #6fa2ec; --ok: #6fce9e; --err: #ec8b7a; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font: 13px/1.5 -apple-system, "Segoe UI", sans-serif; }
  header { padding: 14px 18px; border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 14px; background: var(--surface); }
  header h1 { font-size: 15px; margin: 0; }
  header .sub { color: var(--muted); font-size: 12px; }
  header button { margin-left: auto; font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); cursor: pointer; }
  header button:hover { border-color: var(--accent); }
  .layout { display: grid; grid-template-columns: 340px 1fr; height: calc(100vh - 49px); }
  .list { overflow-y: auto; border-right: 1px solid var(--line); }
  .row { padding: 10px 14px; border-bottom: 1px solid var(--line); cursor: pointer; }
  .row:hover { background: var(--surface); }
  .row.active { background: var(--surface); border-left: 3px solid var(--accent); padding-left: 11px; }
  .row .op { font-weight: 600; font-family: ui-monospace, monospace; font-size: 12.5px; }
  .row .meta { color: var(--muted); font-size: 11px; margin-top: 2px; display: flex; gap: 8px; }
  .pill { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 10px; font-weight: 600; }
  .pill.ok { color: var(--ok); background: color-mix(in srgb, var(--ok) 15%, transparent); }
  .pill.err { color: var(--err); background: color-mix(in srgb, var(--err) 15%, transparent); }
  .detail { overflow-y: auto; padding: 18px 24px; }
  .detail h2 { font-family: ui-monospace, monospace; font-size: 16px; margin: 0 0 4px; }
  .detail .meta { color: var(--muted); font-size: 12px; margin-bottom: 18px; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
  .cols h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 0 0 8px; }
  table { width: 100%; border-collapse: collapse; font-family: ui-monospace, monospace; font-size: 12px; }
  td { padding: 4px 6px; border-bottom: 1px solid var(--line); vertical-align: top; word-break: break-word; }
  td.path { color: var(--muted); width: 55%; }
  td.value { font-weight: 600; }
  .empty { color: var(--muted); padding: 40px; text-align: center; }
  details { margin-top: 18px; }
  summary { cursor: pointer; color: var(--muted); font-size: 12px; }
  pre { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 10px; overflow-x: auto; font-size: 11px; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
<header>
  <h1>ICCP Inspector</h1>
  <span class="sub">live view of iccp-api-log.jsonl</span>
  <button id="clearBtn">Clear log</button>
</header>
<div class="layout">
  <div class="list" id="list"></div>
  <div class="detail" id="detail"><div class="empty">Select a request on the left, or trigger one in the chat — it'll show up here automatically.</div></div>
</div>
<script>
  let entries = [];
  let selected = null;

  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

  function renderList() {
    const list = document.getElementById('list');
    if (!entries.length) { list.innerHTML = '<div class="empty">No requests yet.</div>'; return; }
    list.innerHTML = entries.slice().reverse().map(e => \`
      <div class="row \${selected === e.seq ? 'active' : ''}" data-seq="\${e.seq}">
        <div class="op">\${esc(e.operation)}</div>
        <div class="meta">
          <span class="pill \${e.error ? 'err' : 'ok'}">\${e.error ? 'ERROR' : (e.status || '—')}</span>
          <span>\${esc(e.endpoint || '')}</span>
          <span>\${e.ms != null ? e.ms + 'ms' : ''}</span>
        </div>
      </div>\`).join('');
    list.querySelectorAll('.row').forEach(el => el.addEventListener('click', () => { selected = Number(el.dataset.seq); render(); }));
  }

  function fieldTable(fields) {
    if (!fields || !fields.length) return '<div class="empty">—</div>';
    return '<table>' + fields.map(f => \`<tr><td class="path">\${esc(f.path)}</td><td class="value">\${esc(f.value)}</td></tr>\`).join('') + '</table>';
  }

  function renderDetail() {
    const detail = document.getElementById('detail');
    const e = entries.find(x => x.seq === selected);
    if (!e) { detail.innerHTML = '<div class="empty">Select a request on the left.</div>'; return; }
    detail.innerHTML = \`
      <h2>\${esc(e.operation)}</h2>
      <div class="meta">\${esc(e.at)} · \${esc(e.endpoint)} · \${e.error ? 'ERROR: ' + esc(e.error) : (e.status + ' · ' + e.ms + 'ms')}</div>
      <div class="cols">
        <div><h3>Request fields</h3>\${fieldTable(e.requestFields)}</div>
        <div><h3>Response fields</h3>\${fieldTable(e.responseFields)}</div>
      </div>
      <details><summary>Raw request XML</summary><pre>\${esc(e.requestXml)}</pre></details>
      \${e.responseXml ? '<details><summary>Raw response XML</summary><pre>' + esc(e.responseXml) + '</pre></details>' : ''}
    \`;
  }

  function render() { renderList(); renderDetail(); }

  async function load() {
    const res = await fetch('/api/entries');
    entries = await res.json();
    if (selected == null && entries.length) selected = entries[entries.length - 1].seq;
    render();
  }

  document.getElementById('clearBtn').addEventListener('click', async () => {
    await fetch('/api/clear', { method: 'POST' });
    entries = []; selected = null; render();
  });

  const es = new EventSource('/events');
  es.addEventListener('changed', async () => {
    const wasLatest = !entries.length || selected === entries[entries.length - 1].seq;
    await load();
    if (wasLatest && entries.length) { selected = entries[entries.length - 1].seq; render(); }
  });

  load();
</script>
</body>
</html>`;

app.listen(PORT, () => {
  console.log(`[iccp-inspector] listening on http://localhost:${PORT}`);
  console.log(`[iccp-inspector]   watching ${LOG_FILE}`);
});
