// Project search for the files pane: file names and file contents, skipping the folders the pane
// hides (node_modules, .git, build output) and binary or large files. Async, with yields, so a big
// project doesn't freeze the main process; a newer search cancels an older one through isCancelled.
const fs = require('fs');
const path = require('path');
const { IGNORED } = require('./files');

const MAX_FILE_BYTES = 1024 * 1024;
const PREVIEW = 160;

// A matcher for one line: returns the column of the first match or -1. Plain text unless regex.
function matcher(query, { regex = false, caseSensitive = false } = {}) {
  const q = String(query || '');
  if (!q) return null;
  if (regex) {
    let re;
    try { re = new RegExp(q, caseSensitive ? '' : 'i'); } catch { return null; }
    return (line) => { const m = re.exec(line); return m ? m.index : -1; };
  }
  const needle = caseSensitive ? q : q.toLowerCase();
  return (line) => (caseSensitive ? line : line.toLowerCase()).indexOf(needle);
}

// The line around the match, trimmed to PREVIEW characters with the match in view.
function preview(line, col) {
  const text = line.replace(/\t/g, '  ');
  if (text.length <= PREVIEW) return { text: text.trimEnd(), col };
  const start = Math.max(0, Math.min(col - 40, text.length - PREVIEW));
  return { text: (start ? '…' : '') + text.slice(start, start + PREVIEW).trimEnd(), col: col - start + (start ? 1 : 0) };
}

// { files: [{ rel, name match }], hits: [{ rel, matches: [{ line, col, text }] }], truncated }
// isCancelled gives null (a newer search took over); isLate ends the walk early but keeps what was found (truncated).
async function searchProject(root, query, { regex, caseSensitive, maxHits = 500, maxFiles = 20000, isCancelled = () => false, isLate = () => false } = {}) {
  const test = matcher(query, { regex, caseSensitive });
  const out = { files: [], hits: [], truncated: false };
  if (!test) return out;
  let hitCount = 0;
  let seen = 0;
  const queue = [''];
  while (queue.length) {
    if (isCancelled()) return null;
    if (isLate()) { out.truncated = true; return out; }
    const rel = queue.shift();
    let entries;
    try { entries = await fs.promises.readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!IGNORED.has(e.name)) queue.push(r); continue; }
      if (!e.isFile()) continue;
      if (isLate()) { out.truncated = true; return out; }
      if (++seen > maxFiles) { out.truncated = true; return out; }
      if (test(e.name) >= 0 && out.files.length < 200) out.files.push({ rel: r });
      let buf;
      try {
        const st = await fs.promises.stat(path.join(root, r));
        if (st.size > MAX_FILE_BYTES) continue;
        buf = await fs.promises.readFile(path.join(root, r));
      } catch { continue; }
      if (buf.subarray(0, 8000).includes(0)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      const matches = [];
      for (let i = 0; i < lines.length; i++) {
        const col = test(lines[i]);
        if (col < 0) continue;
        matches.push({ line: i + 1, ...preview(lines[i], col) });
        if (++hitCount >= maxHits) break;
      }
      if (matches.length) out.hits.push({ rel: r, matches });
      if (hitCount >= maxHits) { out.truncated = true; return out; }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return out;
}

module.exports = { matcher, preview, searchProject };
