// Read-only file access for remote clients. A paired client names a project by id and a path inside it; this
// module is the only place those requests touch the disk, so the path rules live here. Pure: fs, path and the
// helpers are injected so tests can use real temp folders.
const MAX_VIEW_BYTES = 2 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_REL = 1024;
const MD = /\.(md|markdown)$/i;

function createFileService({ fs, path, files, projectRoot, gitOps }) {
  // '' is the project root. Anything that could point elsewhere is refused before the disk is touched.
  function cleanRel(rel) {
    if (rel === undefined || rel === null || rel === '') return '';
    if (typeof rel !== 'string' || rel.length > MAX_REL || rel.includes('\0')) return null;
    const s = rel.replace(/\\/g, '/');
    if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null;
    const parts = s.split('/').filter((x) => x && x !== '.');
    if (parts.includes('..')) return null;
    return parts.join('/');
  }

  // The path must stay inside the project after symlinks are resolved.
  function resolveInside(id, rel) {
    const root = typeof id === 'string' && id ? projectRoot(id) : null;
    if (!root) return { error: 'That project is not available' };
    const clean = cleanRel(rel);
    if (clean === null) return { error: 'That path is not allowed' };
    const full = files.safeJoin(root, clean);
    if (!full) return { error: 'That path is not allowed' };
    let real;
    let realRoot;
    try {
      realRoot = fs.realpathSync(root);
      real = fs.realpathSync(full);
    } catch {
      return { error: 'Not found' };
    }
    const r = path.relative(realRoot, real);
    if (r.startsWith('..') || path.isAbsolute(r)) return { error: 'That path is not allowed' };
    return { root, clean, full: real };
  }

  function list(id, rel) {
    const r = resolveInside(id, rel);
    if (r.error) return { error: r.error };
    let st;
    try { st = fs.statSync(r.full); } catch { return { error: 'Not found' }; }
    if (!st.isDirectory()) return { error: 'Not a folder' };
    const entries = files.listDir(r.root, r.clean);
    if (!entries) return { error: 'Cannot read that folder' };
    return { entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES };
  }

  function read(id, rel) {
    const r = resolveInside(id, rel);
    if (r.error) return { error: r.error };
    let st;
    try { st = fs.statSync(r.full); } catch { return { error: 'Not found' }; }
    if (!st.isFile()) return { error: 'Not a file' };
    const name = path.basename(r.full);
    const head = { rel: r.clean, name, size: st.size, mtimeMs: st.mtimeMs };
    if (st.size > MAX_VIEW_BYTES) return { ...head, kind: 'toolarge' };
    if (!files.isTextFile(r.full)) return { ...head, kind: 'binary' };
    let text;
    try { text = fs.readFileSync(r.full, 'utf8'); } catch { return { error: 'Not found' }; }
    return { ...head, kind: MD.test(name) ? 'md' : 'text', text: text.replace(/^﻿/, '') };
  }

  async function git(id) {
    const root = typeof id === 'string' && id ? projectRoot(id) : null;
    if (!root) return { error: 'That project is not available' };
    if (!gitOps) return { badges: null };
    const st = await gitOps.status(root);
    return { badges: st && st.repo ? gitOps.badgeMap(st.files, st.prefix) : null };
  }

  return { list, read, git };
}

module.exports = { createFileService, MAX_VIEW_BYTES, MAX_ENTRIES, MAX_REL };
