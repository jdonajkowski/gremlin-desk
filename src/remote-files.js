// Read-only file access for remote clients. A paired client names a project by id and a path inside it; this
// module is the only place those requests touch the disk, so the path rules live here. Pure: fs, path and the
// helpers are injected so tests can use real temp folders.
const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const MAX_REPLY_JSON = 4 * 1024 * 1024; // a text reply is JSON-escaped, sealed and base64'd: it has to stay under the client's line limit
const MAX_ENTRIES = 2000;
const MAX_REL = 1024;
const MD = /\.(md|markdown)$/i;
const SEARCH_MS = 20000;
const MAX_QUERY = 200;
const MAX_CANDIDATES = 16;

function createFileService({ fs, path, files, projectRoot, gitOps, searchProject, projects = () => [], mdFiles = files && files.mdFiles, findByTail = files && files.findByTail, now = Date.now }) {
  // '' is the project root. Anything that could point elsewhere is refused before the disk is touched.
  function cleanRel(rel) {
    if (rel === undefined || rel === null || rel === '') return '';
    if (typeof rel !== 'string' || rel.length > MAX_REL || rel.includes('\0')) return null;
    // No ':' at all: blocks NTFS alternate data streams (file:stream) and drive letters. A POSIX name with ':' is refused too, an accepted tradeoff.
    if (rel.includes(':')) return null;
    const s = rel.replace(/\\/g, '/');
    if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null;
    const parts = s.split('/').filter((x) => x && x !== '.');
    if (parts.includes('..')) return null;
    return parts.join('/');
  }

  function inside(base, target) {
    const r = path.relative(base, target);
    return !(r === '..' || r.startsWith('..' + path.sep) || path.isAbsolute(r));
  }

  // The path must stay inside the project after symlinks are resolved.
  function resolveInside(id, rel) {
    const root = typeof id === 'string' && id ? projectRoot(id) : null;
    if (!root) return { error: 'That project is not available' };
    const clean = cleanRel(rel);
    if (clean === null) return { error: 'That path is not allowed' };
    // Not files.safeJoin: its startsWith('..') test also rejects names like '..foo'.
    const base = path.resolve(root);
    const full = path.resolve(base, clean);
    if (!inside(base, full)) return { error: 'That path is not allowed' };
    let real;
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
      real = fs.realpathSync(full);
    } catch {
      return { error: 'Not found' };
    }
    if (!inside(realRoot, real)) return { error: 'That path is not allowed' };
    return { root, clean, full: real };
  }

  function list(id, rel) {
    const r = resolveInside(id, rel);
    if (r.error) return { error: r.error };
    let st;
    try { st = fs.statSync(r.full); } catch { return { error: 'Not found' }; }
    if (!st.isDirectory()) return { error: 'Not a folder' };
    const listed = files.listDir(r.full, '');
    if (!listed) return { error: 'Cannot read that folder' };
    const entries = listed.map((e) => ({ ...e, rel: r.clean ? r.clean + '/' + e.name : e.name }));
    return { entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
  }

  function read(id, rel) {
    const r = resolveInside(id, rel);
    if (r.error) return { error: r.error };
    let st;
    try { st = fs.statSync(r.full); } catch { return { error: 'Not found' }; }
    if (!st.isFile()) return { error: 'Not a file' };
    const name = path.posix.basename(r.clean);
    // One descriptor: its size and its bytes come from the same open file, and never more than the cap is read.
    let fd;
    try {
      fd = fs.openSync(r.full, 'r');
      const fst = fs.fstatSync(fd);
      const head = { rel: r.clean, name, size: fst.size, mtimeMs: fst.mtimeMs };
      if (fst.size > MAX_VIEW_BYTES) return { ...head, kind: 'toolarge' };
      // Sized from fstat (small files stay cheap); if the file grew meanwhile, grow the buffer but never past the cap + 1.
      let buf = Buffer.alloc(Math.min(fst.size, MAX_VIEW_BYTES) + 1);
      let n = 0;
      while (n < MAX_VIEW_BYTES + 1) {
        if (n === buf.length) { const bigger = Buffer.alloc(MAX_VIEW_BYTES + 1); buf.copy(bigger, 0, 0, n); buf = bigger; }
        const got = fs.readSync(fd, buf, n, buf.length - n, n);
        if (!got) break;
        n += got;
      }
      if (n > MAX_VIEW_BYTES) return { ...head, kind: 'toolarge' };
      const bytes = buf.subarray(0, n);
      if (bytes.subarray(0, 8192).includes(0)) return { ...head, kind: 'binary' };
      const text = bytes.toString('utf8').replace(/^\ufeff/, '');
      if (Buffer.byteLength(JSON.stringify(text)) > MAX_REPLY_JSON) return { ...head, kind: 'toolarge' };
      return { ...head, kind: MD.test(name) ? 'md' : 'text', text };
    } catch {
      return { error: 'Not found' };
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
  }

  async function git(id) {
    const root = typeof id === 'string' && id ? projectRoot(id) : null;
    if (!root) return { error: 'That project is not available' };
    if (!gitOps) return { badges: null };
    const st = await gitOps.status(root);
    return { badges: st && st.repo ? gitOps.badgeMap(st.files, st.prefix) : null };
  }

  const badQuery = (q) => typeof q !== 'string' || !q || q.length > MAX_QUERY;
  // The time budget: when it runs out the search stops but keeps what it found (truncated); a client cancel drops it.
  function budget() {
    const t0 = now();
    return () => now() - t0 > SEARCH_MS;
  }

  // Literal only (regex is false whatever the client sends): a catastrophic pattern could not be interrupted.
  async function search(id, query, opts, isCancelled = () => false) {
    if (badQuery(query)) return { error: 'Enter something to search for' };
    const root = typeof id === 'string' && id ? projectRoot(id) : null;
    if (!root) return { error: 'That project is not available' };
    const late = budget();
    const r = await searchProject(root, query, { regex: false, caseSensitive: !!(opts && opts.caseSensitive), maxHits: 500, maxFiles: 20000, isCancelled: () => !!isCancelled(), isLate: late });
    if (!r) return { cancelled: true };
    return {
      files: r.files.map((f) => ({ rel: f.rel })),
      hits: r.hits.map((h) => ({ rel: h.rel, matches: h.matches.map((m) => ({ line: m.line, text: m.text })) })),
      truncated: r.truncated
    };
  }

  // Same rows as the local files:searchAll in main.js: a few hits from each project so a common word does not drown the rest.
  async function searchAll(query, isCancelled = () => false) {
    if (badQuery(query)) return { error: 'Enter something to search for' };
    const late = budget();
    const rows = [];
    for (const p of projects()) {
      if (p.missing) continue;
      if (isCancelled()) return { cancelled: true };
      if (late()) break;
      const r = await searchProject(p.path, query, { regex: false, maxHits: 12, maxFiles: 8000, isCancelled: () => !!isCancelled(), isLate: late });
      if (!r) return { cancelled: true };
      for (const f of r.files.slice(0, 5)) rows.push({ id: p.id, project: p.name, rel: f.rel, line: 0, text: '' });
      for (const hit of r.hits) for (const m of hit.matches.slice(0, 3)) rows.push({ id: p.id, project: p.name, rel: hit.rel, line: m.line, text: m.text });
      if (rows.length >= 200 || late()) break; // the budget ended inside this project: keep its rows, skip the rest
    }
    return { rows: rows.slice(0, 200) };
  }

  // A project-relative Markdown file for a terminal link, or null. Absolute candidates are compared as text with the
  // project root first, so a path elsewhere (a UNC share, another drive) is never touched on disk.
  function resolveMd(id, candidates) {
    const root = typeof id === 'string' && id ? projectRoot(id) : null;
    if (!root) return { error: 'That project is not available' };
    if (!Array.isArray(candidates)) return null;
    const isWin = path.sep === '\\';
    const base = path.resolve(root);
    let realBase = null;
    try { realBase = fs.realpathSync(root); } catch { /* the inside check below fails too */ }
    let mds = null;
    const existing = (rel) => {
      if (rel === null || !MD.test(rel)) return null;
      const r = resolveInside(id, rel);
      if (r.error) return null;
      try { return fs.statSync(r.full).isFile() ? r.clean : null; } catch { return null; }
    };
    for (let i = 0; i < candidates.length && i < MAX_CANDIDATES; i++) {
      const c = candidates[i];
      if (typeof c !== 'string' || !c || c.length > MAX_REL || c.includes('\0')) continue;
      const s = c.replace(/\\/g, '/');
      if (s.startsWith('//')) continue; // UNC
      let rel;
      if (path.isAbsolute(c)) {
        const full = path.resolve(c);
        const from = [base, realBase].find((b) => b && inside(b, full));
        if (!from) continue;
        rel = cleanRel(path.relative(from, full));
      } else {
        rel = cleanRel(c);
        if (rel === null) continue;
      }
      let hit = existing(rel);
      if (!hit && !path.isAbsolute(c) && MD.test(c) && mdFiles && findByTail) {
        if (!mds) mds = mdFiles(root);
        hit = existing(findByTail(mds, c, isWin));
      }
      if (hit) return { index: i, rel: hit };
    }
    return null;
  }

  return { list, read, git, search, searchAll, resolveMd };
}

module.exports = { createFileService, MAX_VIEW_BYTES, MAX_REPLY_JSON, MAX_ENTRIES, MAX_REL, SEARCH_MS, MAX_QUERY, MAX_CANDIDATES };
