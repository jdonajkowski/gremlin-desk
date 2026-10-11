# Remote files, part A: host requests, tree and viewing (2b-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A remote project's files panel lists folders, shows git markers, and opens files read-only (Markdown in the popout, text in a read-only editor window).

**Architecture:** A pure `src/remote-files.js` service (dependencies injected) answers `files.list`, `files.read`, `files.git` for a project id with strict path rules. `remote-host.js` exposes it as new request names (with a per-client concurrency cap). `remote-clients.js` gains `filesList/filesRead/filesGit`. `main.js` routes the existing `files:*` IPC for remote ids and opens viewer windows with the received text; the Markdown popout and editor window learn a remote/read-only mode.

**Tech Stack:** Node `fs`/`path`, node:test, Electron main + renderer (plain scripts), `marked` (already used).

**Spec:** `docs/superpowers/specs/2026-10-11-remote-files-design.md` (read it first; it is binding).

## Global Constraints

- View-only: no code path writes to the host. 2 MB view limit, 2,000 listing entries, 4 in-flight file requests per client, `rel` ≤ 1024 chars.
- Project-relative paths only in responses (never absolute host paths). Paths must stay inside the project **after realpath**; symlinks are not listed.
- No new npm dependency. Match surrounding style. CRLF source files keep CRLF. Commits: Conventional Commits, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Local behaviour (files panel, popout, editor, editing, saving) must be unchanged for local ids.
- Never touch `docs/manual/` or `docs/remote-sessions-guide.md` (another untracked draft).

## Review Focus

1. A hostile paired client: `..`, absolute, `C:\`, `\\server\share`, `%2e%2e`, NUL, huge strings, non-string `id`/`rel`, `id` of a project that is hidden/missing, symlink or junction escaping the root.
2. The read-only editor window must be impossible to save from (page AND main), and must not change local editor behaviour.
3. A remote viewer window whose host goes offline or whose host closes the project: clear error, no crash, no stale write.
4. Many rapid `files.list`/`files.read` requests must not freeze the host window or exceed the concurrency cap.
5. Unicode / BOM / CRLF / very long lines in viewed files.

---

### Task 1: `remote-files.js` service (list, read, git)

**Files:**
- Create: `src/remote-files.js`, `test/remote-files.test.js`

**Interfaces:**
- Produces `createFileService({ fs, path, files, projectRoot, gitOps })`:
  - `fs`, `path`: Node modules (injected for tests). `files`: `require('./files')` (needs `safeJoin`, `listDir`, `isTextFile`). `projectRoot(id): string|null` returns the project's root only for known, non-missing projects. `gitOps` (optional): `{ status(root): Promise<{repo, files, prefix}>, badgeMap(files, prefix) }`.
  - `list(id, rel): { entries, truncated } | { error }`
  - `read(id, rel): { rel, name, size, mtimeMs, kind, text? } | { error }`
  - `git(id): Promise<{ badges } | { error }>`
  - Constants exported: `MAX_VIEW_BYTES = 2 * 1024 * 1024`, `MAX_ENTRIES = 2000`, `MAX_REL = 1024`.
  - Errors are plain strings meant for the user: `'That project is not available'`, `'That path is not allowed'`, `'Not found'`, `'Not a file'`, `'Not a folder'`, `'Cannot read that folder'`.

- [ ] **Step 1: Write the failing test** `test/remote-files.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const files = require('../src/files');
const { createFileService, MAX_VIEW_BYTES, MAX_ENTRIES } = require('../src/remote-files');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfiles-'));
  const root = path.join(dir, 'proj');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '\ufeff# Title\r\n\r\nHello é');
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const a = 1;\n');
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(MAX_VIEW_BYTES + 1));
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside');
  const calls = [];
  const gitOps = {
    status: async (r) => { calls.push(['status', r]); return { repo: true, files: [{ path: 'src/a.js', xy: ' M' }], prefix: '' }; },
    badgeMap: (f) => ({ 'src/a.js': 'M' })
  };
  const svc = createFileService({ fs, path, files, projectRoot: (id) => (id === 'p1' ? root : null), gitOps });
  return { dir, root, svc, calls };
}

test('list: folders first, ignored folders and dot-git hidden, rel paths use /', () => {
  const { svc } = setup();
  const r = svc.list('p1', '');
  assert.equal(r.truncated, false);
  assert.deepEqual(r.entries.map((e) => [e.name, e.dir, e.rel]), [['src', true, 'src'], ['bin.dat', false, 'bin.dat'], ['big.txt', false, 'big.txt'], ['README.md', false, 'README.md']]);
  assert.ok(!r.entries.some((e) => e.name === 'node_modules'));
  assert.equal(svc.list('p1', 'src').entries[0].rel, 'src/a.js');
  assert.equal(svc.list('p1', 'src/').entries[0].rel, 'src/a.js', 'trailing slash is fine');
});

test('list: caps the number of entries', () => {
  const { svc, root } = setup();
  fs.mkdirSync(path.join(root, 'many'));
  for (let i = 0; i < MAX_ENTRIES + 5; i++) fs.writeFileSync(path.join(root, 'many', `f${i}.txt`), '');
  const r = svc.list('p1', 'many');
  assert.equal(r.entries.length, MAX_ENTRIES);
  assert.equal(r.truncated, true);
});

test('paths: traversal, absolute, drive, backslash, UNC, NUL, long and non-string are refused', () => {
  const { svc } = setup();
  const bad = ['..', '../secret.txt', 'src/../../secret.txt', '/etc/passwd', 'C:/Windows/win.ini', 'C:\\Windows', '..\\secret.txt', '\\\\server\\share', 'src\\..\\..\\secret.txt', 'a\0b', 'x'.repeat(1025), 5, {}, ['a'], true];
  for (const rel of bad) {
    assert.deepEqual(svc.read('p1', rel), { error: 'That path is not allowed' }, JSON.stringify(rel));
    assert.deepEqual(svc.list('p1', rel), { error: 'That path is not allowed' }, JSON.stringify(rel));
  }
});

test('project ids: unknown, non-string and path-looking ids are refused', async () => {
  const { svc, root } = setup();
  for (const id of ['nope', '', undefined, null, 5, {}, root]) {
    assert.deepEqual(svc.list(id, ''), { error: 'That project is not available' });
    assert.deepEqual(svc.read(id, 'README.md'), { error: 'That project is not available' });
    assert.deepEqual(await svc.git(id), { error: 'That project is not available' });
  }
});

test('read: Markdown and text come back as text without a BOM; names and sizes are reported', () => {
  const { svc } = setup();
  const md = svc.read('p1', 'README.md');
  assert.equal(md.kind, 'md');
  assert.equal(md.name, 'README.md');
  assert.equal(md.rel, 'README.md');
  assert.equal(md.text, '# Title\r\n\r\nHello é');
  assert.ok(md.size > 0 && typeof md.mtimeMs === 'number');
  const js = svc.read('p1', 'src/a.js');
  assert.equal(js.kind, 'text');
  assert.equal(js.text, 'const a = 1;\n');
});

test('read: binary and too-large files report a kind and no text; folders and missing files are errors', () => {
  const { svc } = setup();
  const bin = svc.read('p1', 'bin.dat');
  assert.equal(bin.kind, 'binary');
  assert.equal(bin.text, undefined);
  const big = svc.read('p1', 'big.txt');
  assert.equal(big.kind, 'toolarge');
  assert.equal(big.text, undefined);
  assert.equal(big.size, MAX_VIEW_BYTES + 1);
  assert.deepEqual(svc.read('p1', 'src'), { error: 'Not a file' });
  assert.deepEqual(svc.read('p1', 'nope.txt'), { error: 'Not found' });
  assert.deepEqual(svc.list('p1', 'README.md'), { error: 'Not a folder' });
  assert.deepEqual(svc.list('p1', 'nope'), { error: 'Not found' });
});

test('read: a symlink that points outside the project is refused (skipped where symlinks cannot be created)', (t) => {
  const { svc, root, dir } = setup();
  try {
    fs.symlinkSync(path.join(dir, 'secret.txt'), path.join(root, 'link.txt'));
    fs.symlinkSync(dir, path.join(root, 'linkdir'), 'junction');
  } catch {
    return t.skip('this OS refused to create a symlink');
  }
  assert.deepEqual(svc.read('p1', 'link.txt'), { error: 'That path is not allowed' });
  assert.deepEqual(svc.read('p1', 'linkdir/secret.txt'), { error: 'That path is not allowed' });
  assert.deepEqual(svc.list('p1', 'linkdir'), { error: 'That path is not allowed' });
  assert.ok(!svc.list('p1', '').entries.some((e) => e.name === 'link.txt'), 'symlinks are not listed');
});

test('git: returns the badge map, or null badges for a non-repository', async () => {
  const { svc, calls } = setup();
  assert.deepEqual(await svc.git('p1'), { badges: { 'src/a.js': 'M' } });
  assert.equal(calls.length, 1);
  const none = createFileService({ fs, path, files, projectRoot: () => '/x', gitOps: { status: async () => ({ repo: false }), badgeMap: () => ({}) } });
  assert.deepEqual(await none.git('p1'), { badges: null });
  const nogit = createFileService({ fs, path, files, projectRoot: () => '/x' });
  assert.deepEqual(await nogit.git('p1'), { badges: null });
});
```

NOTE for the implementer: the expected order in the first test follows `files.listDir` (folders first, then files alphabetical case-insensitively: bin.dat, big.txt, README.md; `node_modules` and `.git` are in `IGNORED`). If a real run disagrees, fix the expectation to the real order, not the code.

- [ ] **Step 2: Run, see it fail**

Run: `node --test --test-timeout=60000 test/remote-files.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `src/remote-files.js`:

```js
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
    return { ...head, kind: MD.test(name) ? 'md' : 'text', text: text.replace(/^\ufeff/, '') };
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
```

- [ ] **Step 4: Run, see it pass**, then `npm test`. Expected: all pass (362 + new).
- [ ] **Step 5: Commit**

```bash
git add src/remote-files.js test/remote-files.test.js
git commit -m "feat: read-only file service for remote clients" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Host requests (`files.list`, `files.read`, `files.git`)

**Files:**
- Modify: `src/remote-host.js`, `test/remote-host.test.js`

**Interfaces:**
- Consumes: Task 1 `createFileService` (injected as option `fileService`).
- Produces: `createRemoteHost({ ..., fileService })`. New request handlers: `'files.list' {id, rel}`, `'files.read' {id, rel}`, `'files.git' {id}`. A service result containing `error` becomes `throw new PublicError(error)`; otherwise the result is the reply data. At most **4** file requests may be in flight per client (`c.fileBusy`); the 5th is refused with `PublicError('Too many file requests')`. Without `fileService` the names are "Unknown request".

- [ ] **Step 1: Failing tests** in `test/remote-host.test.js` (use the file's existing `setup`/`connect` helpers; pass a fake `fileService` through `setup`'s `over`):
  1. `files.list`/`files.read`/`files.git` return the fake's data; arguments are passed through exactly (`id`, `rel`).
  2. A fake returning `{error:'That path is not allowed'}` reaches the client as `ok:false` with that exact message.
  3. A fake that throws `new Error('ENOENT C:\\secret\\x')` gives the fixed `The request failed` (no path).
  4. Non-string `id` (5, {}) or non-string non-undefined `rel` (5, {}) is refused with a message before the fake is called (assert the fake was not called).
  5. Concurrency: a fake whose `read` never resolves until released; send 4 reads (no wait), the 5th gets `Too many file requests`; releasing one frees a slot.
  6. Without `fileService`, `files.list` is `Unknown request`.
  Run RED first.
- [ ] **Step 2: Implement** in `src/remote-host.js`: add `fileService` to the options; add the three handlers to the `handlers` table via a small wrapper:

```js
const fileCall = (fn) => async (c, a) => {
  if (!fileService) throw new PublicError('Unknown request');
  if (typeof a.id !== 'string' || (a.rel !== undefined && typeof a.rel !== 'string')) throw new PublicError('That request is not valid');
  if ((c.fileBusy || 0) >= 4) throw new PublicError('Too many file requests');
  c.fileBusy = (c.fileBusy || 0) + 1;
  try {
    const r = await fn(a);
    if (r && r.error) throw new PublicError(r.error);
    return r;
  } finally {
    c.fileBusy -= 1;
  }
};
// handlers['files.list'] = fileCall((a) => fileService.list(a.id, a.rel)); same for read; git: (a) => fileService.git(a.id)
```
(Read the existing `PublicError` and `handlers` definitions first; keep their style. Without `fileService` the lookup must still yield "Unknown request": add the handlers only when `fileService` is given.)
- [ ] **Step 3:** run the host tests, then `npm test`. Commit: `feat: file requests on the remote host`.

---

### Task 3: Client manager methods

**Files:**
- Modify: `src/remote-clients.js`, `test/remote-clients.test.js`

**Interfaces:**
- Produces on the manager: `filesList(id, rel)`, `filesRead(id, rel)`, `filesGit(id)`. Each takes a namespaced id, parses it (`parseNsId`), and returns a Promise that **never rejects**: the reply data, or `{ error: <message> }` (host message on `ok:false`, `'Host is not connected'` when the client is not online or the host unknown, `'The other computer did not answer'` on timeout). They call `client.request('files.list', { id: projectId, rel })` etc.

- [ ] **Step 1: Failing tests** with the fake client of the existing test file (give it a `request` that records and returns configurable replies or rejects): success passthrough with the host-side project id (not the namespaced one); a rejected request becomes `{error}`; offline client → `{error:'Host is not connected'}` without calling request; unknown host / non-remote id → `{error:'Host is not connected'}`.
- [ ] **Step 2: Implement**, reusing `parts(id)` and the entry's `client.state().state === 'online'` check.
- [ ] **Step 3:** tests, `npm test`, commit `feat: file requests in the remote clients manager`.

---

### Task 4: Main-process routing, viewer windows, files panel

**Files:**
- Modify: `src/main.js`, `src/preload.js` (only if a new channel is needed), `src/md/md.js`, `src/md/preload.js`, `src/md/md.html` (hide Edit/VS Code for remote docs), `src/editor/*` (read-only mode: read `src/editor/editor.js`/`preload.js`/`editor.html` first), `src/renderer/files-pane.js`, `src/renderer/renderer.js`, `README.md`
- No new unit tests for UI; the pure parts (rendering Markdown text) get a small tested helper if you add one.

**Interfaces:**
- Consumes: `remote.filesList/filesRead/filesGit` (Task 3); host-side `createFileService` is wired into `createRemoteHost({ fileService })` in main.js with `projectRoot: (id) => { const p = projectList.find((x) => x.id === id); return p && !p.missing ? p.path : null; }` (NOT `projectPath`, which also returns session cwds of orphans) and `gitOps` from `./git-ops`.
- Produces (client side): for remote ids `files:list` returns `{ root: '', entries }` (so the panel works unchanged) or `null` on error with the message sent as a toast; `files:git` returns the badge map; `files:open` / `files:openAt` fetch with `remote.filesRead` and open:
  - `kind: 'md'` → a Markdown popout in remote mode (reuse `openMd` window class with a document object `{ file: 'HostName: rel', dir: null, html, remote: {hostName, id, rel} }`; render with `marked` from the text; window key `r:` + id + rel; title `name · HostName`; Edit/VS Code buttons hidden; a Reload button sends `md:reload` which re-reads via the host).
  - `kind: 'text'` → the editor window in **read-only remote mode**: `editor:get` returns `{ name, text, line, readOnly: true, banner: 'Read-only copy from HostName' , ...fonts }`; the page sets Monaco `readOnly: true`, hides/disables Save and shows the banner; `editor:save` in main must return `{ error: 'Read-only' }` for remote editor windows (guard in main, not only in the page); no file watching.
  - `kind: 'binary' | 'toolarge'` → toast `Binary file` / `File is too large to view remotely (over 2 MB)`.
  - `md:link` from a remote popout: `http(s)` → `shell.openExternal`; a relative `.md` link → resolve against the document's `rel` folder (POSIX join, refuse anything that normalizes outside the project) → `filesRead` → open another remote popout; anchors unchanged.
  - `files:menu` for remote ids: items Open (read-only) and Copy path (project-relative) only.
  - The files pane's phase 1 notice ("Files are not available on remote computers yet") is removed for remote ids; its search box uses part B (until then the search box shows a short "Search on remote projects comes next" note and is disabled).

- [ ] **Step 1:** Read before editing: `src/main.js` regions `files:list`…`files:menu`, `openMd`, `renderMd`, `openEditor`, `editor:get/save`; `src/md/md.js` + preload; `src/editor/*`; `src/renderer/files-pane.js` (how `setProject(null, notice)` and the search box work) and `renderer.js` (`isRemote`, `filesPane.setProject(isRemote(activeId) ? null : activeId, ...)`).
- [ ] **Step 2:** Implement the host wiring (`fileService` into `createRemoteHost`) and the client routes above. Keep every local path byte-for-byte as before: put each remote branch at the top of its handler (`const r = remote.has(id); if (r) {...}`).
- [ ] **Step 3: Verify** `node --check` on every edited JS, `npm test`.
- [ ] **Step 4: Real run** (throwaway instances only, user data dirs under `$TEMP`, ports 9370/9371; kill only your own PIDs; delete temp dirs; never touch the user's real Gremlin/data). Host: `projectsRoot` with a sample project containing `README.md` (with a relative link to `docs/guide.md`), `docs/guide.md`, `src/a.js`, a binary file, a >2 MB text file, a `.git` repo with one modified file, and a symlink/junction pointing outside if the OS allows; `claudeCommand` a harmless session. Pair over loopback as before. Verify and screenshot (READ every screenshot): the tree for the remote project with a git marker; clicking `README.md` opens the popout titled `README.md · HostName` with rendered content and no Edit/VS Code buttons; clicking its relative link opens `guide.md`; `src/a.js` opens read-only with the banner and Save disabled; binary and too-large show the toasts; the context menu has only Open and Copy path; host killed → clear toast, no crash; host `README.md` changed on disk then Reload shows the new text; a raw-socket hostile client (reuse the pairing to open an authenticated socket in a Node script, or call `settingsHost`-independent: use `src/remote-client.js` from a script in the scratchpad with the pairing secret) sends `..`, absolute paths, wrong ids, 10 parallel reads: every refusal as specified, the 5th+ concurrent read refused, host window stays responsive. Local projects: open a local file and a local Markdown to confirm nothing changed (popout has Edit/VS Code, editor saves).
- [ ] **Step 5:** README: add "Browse files on a remote project (read-only)" to the Remote sessions section and fix the "not available" sentence (search comes in part B). Commit in logical commits (`feat: …`).

---

## Self-review notes

- Spec coverage: list, read, git, panel, popouts, read-only editor, context menu, errors, safety rules, limits, tests: Tasks 1-4. Search, cross-project search, terminal links, in-popout links to non-open files: part B (`2026-10-11-remote-files-part-b.md`). In-popout *relative links* are in Task 4 because they only need `files.read`.
- Names used across tasks: `createFileService`, `list/read/git`, `MAX_VIEW_BYTES`, `fileService` option, `filesList/filesRead/filesGit`.
