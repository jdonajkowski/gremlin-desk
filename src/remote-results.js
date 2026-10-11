// Search and terminal-link replies from a paired host, checked before main.js uses them. A host is trusted with its
// sessions but not to be well-formed: keep only what the files pane, the Ctrl+Shift+H list and the link provider can
// safely read. Pure, so the tests can feed it odd replies.
const { MAX_REL, MAX_CANDIDATES } = require('./remote-files');

const MAX_ROWS = 200; // Ctrl+Shift+H, local and remote rows together
const MAX_FILES = 200;
const MAX_HITS = 500;
const MAX_TEXT = 400; // a preview line (the host trims to 160)
// Not shown as errors: a newer search replaced this one, or the host's per-client request cap was full for a moment.
const CANCELLED = 'Search cancelled';
const BUSY = 'Too many file requests';
const QUIET = new Set([CANCELLED, BUSY]);

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isRel = (s) => typeof s === 'string' && s.length > 0 && s.length <= MAX_REL && !s.includes('\0');

// The column of the query in a preview line, for the highlight; -1 shows the line without a mark.
function matchCol(text, query, caseSensitive) {
  const q = String(query || '');
  if (!q) return -1;
  return caseSensitive ? text.indexOf(q) : text.toLowerCase().indexOf(q.toLowerCase());
}

// A files.search reply as the files pane renders a local one ({ root, files, hits, truncated }), or null.
function searchResult(reply, query, caseSensitive) {
  if (!isObj(reply)) return null;
  const files = (Array.isArray(reply.files) ? reply.files : [])
    .filter((f) => isObj(f) && isRel(f.rel)).slice(0, MAX_FILES).map((f) => ({ rel: f.rel }));
  const hits = [];
  let left = MAX_HITS;
  let cut = false;
  for (const h of Array.isArray(reply.hits) ? reply.hits : []) {
    if (left <= 0) { cut = true; break; }
    if (!isObj(h) || !isRel(h.rel) || !Array.isArray(h.matches)) continue;
    const ok = h.matches.filter((m) => isObj(m) && Number.isInteger(m.line) && m.line >= 1 && typeof m.text === 'string');
    if (ok.length > left) cut = true;
    const matches = ok.slice(0, left).map((m) => {
      const text = m.text.slice(0, MAX_TEXT);
      return { line: m.line, text, col: matchCol(text, query, caseSensitive) };
    });
    if (!matches.length) continue;
    left -= matches.length;
    hits.push({ rel: h.rel, matches });
  }
  return { root: '', files, hits, truncated: reply.truncated === true || cut };
}

// Ctrl+Shift+H: local rows first, then the hosts' rows labelled "Host · Project", at most MAX_ROWS in all.
function mergeFindRows(local, remoteRows, cap = MAX_ROWS) {
  const rows = (Array.isArray(local) ? local : []).slice(0, cap);
  for (const r of Array.isArray(remoteRows) ? remoteRows : []) {
    if (rows.length >= cap) break;
    if (!isObj(r) || typeof r.id !== 'string' || !isRel(r.rel)) continue;
    const project = typeof r.project === 'string' ? r.project : '';
    rows.push({
      id: r.id,
      project: r.host ? `${r.host} · ${project}` : project,
      rel: r.rel,
      line: Number.isInteger(r.line) && r.line >= 0 ? r.line : 0,
      text: typeof r.text === 'string' ? r.text.slice(0, MAX_TEXT) : ''
    });
  }
  return rows;
}

// One toast for the hosts that failed a search ("Host: message; Other: message"), or '' when none is worth showing.
function findErrorText(errors) {
  return (Array.isArray(errors) ? errors : [])
    .filter((e) => isObj(e) && typeof e.message === 'string' && !QUIET.has(e.message))
    .map((e) => `${e.name || 'Other computer'}: ${e.message}`)
    .join('; ');
}

// Host ids whose search was refused only because that host was busy, to ask once more.
const busyHosts = (errors) => (Array.isArray(errors) ? errors : []).filter((e) => isObj(e) && e.message === BUSY).map((e) => e.host);

// The candidates as the host accepts them, same positions as the renderer's list (a bad entry becomes '', which the
// host skips), so a reply's index still points at the renderer's candidate.
function mdCandidates(candidates) {
  if (!Array.isArray(candidates)) return null;
  return candidates.slice(0, MAX_CANDIDATES).map((c) => (isRel(c) ? c : ''));
}

// A project-relative Markdown path: no drive, no leading slash, no backslash, no '..' segment.
function isMdRel(rel) {
  if (!isRel(rel) || rel.includes(':') || rel.includes('\\') || rel.startsWith('/')) return false;
  if (rel.split('/').some((p) => p === '..' || p === '')) return false;
  return /\.(md|markdown)$/i.test(rel);
}

// An md.resolve reply checked against what was sent: { index, rel } or null.
function resolvedMd(reply, count) {
  if (!isObj(reply) || reply.error) return null;
  const { index, rel } = reply;
  if (!Number.isInteger(index) || index < 0 || index >= count || !isMdRel(rel)) return null;
  return { index, rel };
}

module.exports = { MAX_ROWS, CANCELLED, BUSY, matchCol, searchResult, mergeFindRows, findErrorText, busyHosts, mdCandidates, isMdRel, resolvedMd };
