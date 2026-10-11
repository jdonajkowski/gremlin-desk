const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const files = require('../src/files');
const { createFileService, MAX_VIEW_BYTES, MAX_REPLY_JSON, MAX_ENTRIES, SEARCH_MS } = require('../src/remote-files');
const { searchProject } = require('../src/search');
const C = require('../src/remote-crypto');

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
  assert.deepEqual(r.entries.map((e) => [e.name, e.dir, e.rel]), [['src', true, 'src'], ['big.txt', false, 'big.txt'], ['bin.dat', false, 'bin.dat'], ['README.md', false, 'README.md']]);
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

test('probes: odd but harmless paths stay inside the project and never throw', () => {
  const { svc, root, dir } = setup();
  fs.mkdirSync(path.join(root, 'build'));
  fs.writeFileSync(path.join(root, 'build', 'out.txt'), 'built');
  // %2e%2e is a literal name, not decoded
  assert.deepEqual(svc.read('p1', '%2e%2e/secret.txt'), { error: 'Not found' });
  assert.deepEqual(svc.read('p1', 'src/%2e%2e/README.md'), { error: 'Not found' });
  // dot segments are collapsed
  assert.equal(svc.read('p1', 'src/./a.js').rel, 'src/a.js');
  assert.equal(svc.read('p1', './src//a.js').text, 'const a = 1;\n');
  // trailing dot or space on Windows must not escape or throw
  for (const rel of ['src/a.js.', 'src/a.js ', 'src. /a.js', '...', '.. ', ' ..', '../']) {
    const r = svc.read('p1', rel);
    assert.ok(r.error || r.rel.startsWith('src'), rel);
    if (r.text !== undefined) assert.notEqual(r.text, 'outside');
  }
  assert.ok(svc.read('p1', '.. ').error);
  assert.deepEqual(svc.read('p1', '../'), { error: 'That path is not allowed' });
  // case differences stay inside
  const up = svc.read('p1', 'SRC/A.JS');
  if (process.platform === 'win32') assert.equal(up.text, 'const a = 1;\n');
  else assert.deepEqual(up, { error: 'Not found' });
  // a very deep path that does not exist is just not found
  assert.deepEqual(svc.read('p1', Array(500).fill('d').join('/')), { error: 'Not found' });
  // a folder named like an ignored one is hidden from listings but the secret outside is still unreachable
  assert.ok(!svc.list('p1', '').entries.some((e) => e.name === 'build'));
  assert.equal(svc.read('p1', 'build/out.txt').text, 'built');
  assert.ok(fs.existsSync(path.join(dir, 'secret.txt')));
});

test('read: a junction/directory link pointing outside the project is refused even when file symlinks are unavailable', (t) => {
  const { svc, root, dir } = setup();
  try {
    fs.symlinkSync(dir, path.join(root, 'jdir'), 'junction');
  } catch {
    return t.skip('this OS refused to create a junction');
  }
  assert.deepEqual(svc.read('p1', 'jdir/secret.txt'), { error: 'That path is not allowed' });
  assert.deepEqual(svc.list('p1', 'jdir'), { error: 'That path is not allowed' });
  assert.deepEqual(svc.read('p1', 'JDIR/secret.txt'), process.platform === 'win32' ? { error: 'That path is not allowed' } : { error: 'Not found' });
  assert.ok(!svc.list('p1', '').entries.some((e) => e.name === 'jdir'), 'links are not listed');
});

test('paths: a colon anywhere is refused (alternate data streams, drive letters)', () => {
  const { svc } = setup();
  for (const rel of ['README.md:hidden', 'README.md:hidden:$DATA', 'README.md::$DATA', 'src/a.js:x', 'C:/x', 'src/C:x']) {
    assert.deepEqual(svc.read('p1', rel), { error: 'That path is not allowed' }, rel);
    assert.deepEqual(svc.list('p1', rel), { error: 'That path is not allowed' }, rel);
  }
});

test('read: the size limit holds even if the file grows after fstat', () => {
  const { svc, root } = setup();
  const fake = Object.assign(Object.create(fs), {
    openSync: () => 99,
    closeSync: () => {},
    fstatSync: () => ({ size: 10, mtimeMs: 1, isFile: () => true }),
    readSync: (fd, buf, off, len) => { buf.fill(97, off, off + len); return len; }
  });
  const s = createFileService({ fs: fake, path, files, projectRoot: () => root });
  const r = s.read('p1', 'src/a.js');
  assert.equal(r.kind, 'toolarge');
  assert.equal(r.text, undefined);
});

test('read: a NUL in the first 8 KB means binary, read from the same descriptor', () => {
  const { svc, root } = setup();
  fs.writeFileSync(path.join(root, 'nul.txt'), Buffer.concat([Buffer.from('abc'), Buffer.from([0]), Buffer.from('def')]));
  const r = svc.read('p1', 'nul.txt');
  assert.equal(r.kind, 'binary');
  assert.equal(r.text, undefined);
});

test('names starting with two dots are listed and can be opened; real escapes are still refused', (t) => {
  const { svc, root, dir } = setup();
  fs.writeFileSync(path.join(root, '..foo'), 'dots');
  fs.mkdirSync(path.join(root, '..cfg'));
  fs.writeFileSync(path.join(root, '..cfg', 'x.txt'), 'inner');
  const names = svc.list('p1', '').entries.map((e) => e.name);
  assert.ok(names.includes('..foo') && names.includes('..cfg'));
  assert.equal(svc.read('p1', '..foo').text, 'dots');
  assert.equal(svc.read('p1', '..cfg/x.txt').text, 'inner');
  assert.deepEqual(svc.list('p1', '..cfg').entries.map((e) => e.rel), ['..cfg/x.txt']);
  assert.deepEqual(svc.read('p1', '../secret.txt'), { error: 'That path is not allowed' });
  assert.deepEqual(svc.read('p1', '..cfg/../../secret.txt'), { error: 'That path is not allowed' });
  try { fs.symlinkSync(dir, path.join(root, '..jx'), 'junction'); } catch { return t.skip('no junction'); }
  assert.deepEqual(svc.read('p1', '..jx/secret.txt'), { error: 'That path is not allowed' });
  assert.deepEqual(svc.list('p1', '..jx'), { error: 'That path is not allowed' });
});

test('read: name is the last requested segment, not the resolved target name (injected realpath)', () => {
  const { root } = setup();
  fs.writeFileSync(path.join(root, 'real-target.txt'), 'hi');
  const fake = Object.assign(Object.create(fs), {
    realpathSync: (p) => (path.basename(p) === 'shown.txt' ? path.join(fs.realpathSync(root), 'real-target.txt') : fs.realpathSync(p))
  });
  const s = createFileService({ fs: fake, path, files, projectRoot: () => root });
  const r = s.read('p1', 'shown.txt');
  assert.equal(r.name, 'shown.txt');
  assert.equal(r.rel, 'shown.txt');
  assert.equal(r.text, 'hi');
});

test('read: name through a real in-project link is the requested name (skipped where links cannot be created)', (t) => {
  const { svc, root } = setup();
  try { fs.symlinkSync(path.join(root, 'src', 'a.js'), path.join(root, 'shown.js'), 'file'); } catch { return t.skip('this OS refused to create a file symlink'); }
  const r = svc.read('p1', 'shown.js');
  assert.equal(r.name, 'shown.js');
  assert.equal(r.rel, 'shown.js');
});

test('read: a file that keeps growing past fstat is reported toolarge, never read unbounded', () => {
  const { root } = setup();
  let requested = 0;
  const fake = Object.assign(Object.create(fs), {
    openSync: () => 99,
    closeSync: () => {},
    fstatSync: () => ({ size: 10, mtimeMs: 1, isFile: () => true }),
    readSync: (fd, buf, off, len) => { requested += len; buf.fill(97, off, off + len); return len; }
  });
  const s = createFileService({ fs: fake, path, files, projectRoot: () => root });
  const r = s.read('p1', 'src/a.js');
  assert.equal(r.kind, 'toolarge');
  assert.equal(r.text, undefined);
  assert.ok(requested <= MAX_VIEW_BYTES + 1, 'never more than the cap + 1 bytes are requested');
});

test('read: text whose JSON-escaped form is over the reply cap is toolarge', () => {
  const { svc, root } = setup();
  fs.writeFileSync(path.join(root, 'ctl.txt'), Buffer.alloc(1536 * 1024, 1));
  const r = svc.read('p1', 'ctl.txt');
  assert.equal(r.kind, 'toolarge');
  assert.equal(r.text, undefined);
  fs.writeFileSync(path.join(root, 'edge.txt'), 'x'.repeat(MAX_VIEW_BYTES));
  assert.equal(svc.read('p1', 'edge.txt').kind, 'text', 'exactly at the view limit still shows');
  fs.writeFileSync(path.join(root, 'uni.txt'), 'héllo wörld ✓ 日本語\n'.repeat(60000).slice(0, 1.9 * 1024 * 1024 / 2));
  assert.equal(svc.read('p1', 'uni.txt').kind, 'text');
});

test('read: the largest text that is returned fits in one sealed line', () => {
  const { svc, root } = setup();
  const k = C.deriveKeys('s'.repeat(64), C.newNonce(), C.newNonce());
  const ch = C.createChannel(k.s2c, k.c2s);
  // control bytes expand 6x when escaped: find a size that is just under the reply cap
  const n = Math.floor(MAX_REPLY_JSON / 6);
  fs.writeFileSync(path.join(root, 'ctl.txt'), Buffer.alloc(n, 1));
  const r = svc.read('p1', 'ctl.txt');
  assert.equal(r.kind, 'text');
  assert.ok(Buffer.byteLength(JSON.stringify(r.text)) <= MAX_REPLY_JSON);
  assert.ok(ch.seal({ t: 'res', ok: true, data: r }).length < C.MAX_LINE);
});

// --- search, searchAll, resolveMd ---

function searchSetup(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsearch-'));
  const mk = (name) => {
    const root = path.join(dir, name);
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    return root;
  };
  const root = mk('proj');
  const root2 = mk('proj2');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'Hello world\nhello again\nliteral a.*b here\naxxb not this\n');
  fs.writeFileSync(path.join(root, 'docs', 'guide.md'), '# Guide\nhello from the guide\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'skip.txt'), 'hello hidden\n');
  fs.writeFileSync(path.join(root2, 'other.txt'), 'hello two\n');
  fs.writeFileSync(path.join(dir, 'outside.md'), '# Outside\n');
  const roots = { p1: root, p2: root2 };
  const list = [
    { id: 'p1', name: 'One', path: root, missing: false },
    { id: 'gone', name: 'Gone', path: path.join(dir, 'gone'), missing: true },
    { id: 'p2', name: 'Two', path: root2, missing: false }
  ];
  const svc = createFileService({
    fs, path, files, projectRoot: (id) => roots[id] || null,
    searchProject, projects: () => list, mdFiles: files.mdFiles, findByTail: files.findByTail, ...extra
  });
  return { dir, root, root2, svc, list };
}

test('search: literal matches with rel, line and text; case option respected', async () => {
  const { svc } = searchSetup();
  const r = await svc.search('p1', 'hello', {}, () => false);
  assert.equal(r.truncated, false);
  const notes = r.hits.find((h) => h.rel === 'notes.txt');
  assert.deepEqual(notes.matches, [{ line: 1, text: 'Hello world' }, { line: 2, text: 'hello again' }]);
  assert.ok(r.hits.some((h) => h.rel === 'docs/guide.md'));
  assert.ok(!r.hits.some((h) => h.rel.startsWith('node_modules')), 'ignored folders are skipped');
  const cs = await svc.search('p1', 'hello', { caseSensitive: true }, () => false);
  assert.deepEqual(cs.hits.find((h) => h.rel === 'notes.txt').matches, [{ line: 2, text: 'hello again' }]);
  const names = await svc.search('p1', 'guide', {}, () => false);
  assert.deepEqual(names.files, [{ rel: 'docs/guide.md' }]);
});

test('search: a regex-looking query is searched literally', async () => {
  const { svc } = searchSetup();
  const r = await svc.search('p1', 'a.*b', {}, () => false);
  assert.deepEqual(r.hits, [{ rel: 'notes.txt', matches: [{ line: 3, text: 'literal a.*b here' }] }]);
  const r2 = await svc.search('p1', 'a.*b', { regex: true }, () => false);
  assert.deepEqual(r2.hits, r.hits, 'a regex option is ignored');
});

test('search: empty, non-string and too-long queries are refused', async () => {
  const { svc } = searchSetup();
  for (const q of ['', undefined, null, 5, {}, ['hello'], 'x'.repeat(201)]) {
    assert.deepEqual(await svc.search('p1', q, {}, () => false), { error: 'Enter something to search for' }, JSON.stringify(q));
    assert.deepEqual(await svc.searchAll(q, () => false), { error: 'Enter something to search for' }, JSON.stringify(q));
  }
  assert.ok(!(await svc.search('p1', 'x'.repeat(200), {}, () => false)).error, '200 characters is fine');
});

test('search: unknown project is refused', async () => {
  const { svc } = searchSetup();
  for (const id of ['nope', '', undefined, 5]) assert.deepEqual(await svc.search(id, 'hello', {}, () => false), { error: 'That project is not available' });
});

test('search: cancellation mid-way and the time budget', async () => {
  const { svc } = searchSetup();
  let calls = 0;
  assert.deepEqual(await svc.search('p1', 'hello', {}, () => ++calls > 1), { cancelled: true });
  calls = 0;
  assert.deepEqual(await svc.searchAll('hello', () => ++calls > 1), { cancelled: true });
  let t = 1000;
  const late = searchSetup({ now: () => { const v = t; t += 25000; return v; } }).svc;
  const r = await late.search('p1', 'hello', {}, () => false);
  assert.equal(r.truncated, true);
  assert.ok(Array.isArray(r.files) && Array.isArray(r.hits));
  t = 1000;
  const all = await late.searchAll('hello', () => false);
  assert.ok(Array.isArray(all.rows), 'the budget ends searchAll with the rows found so far');
  assert.equal(SEARCH_MS, 20000);
});

test('searchAll: rows from every non-missing project, mapped like the local search', async () => {
  const { svc, root } = searchSetup();
  const r = await svc.searchAll('hello', () => false);
  assert.ok(r.rows.every((x) => x.id === 'p1' || x.id === 'p2'));
  assert.ok(!r.rows.some((x) => x.id === 'gone'));
  assert.deepEqual(r.rows.find((x) => x.id === 'p2'), { id: 'p2', project: 'Two', rel: 'other.txt', line: 1, text: 'hello two' });
  for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(root, `hello${i}.txt`), 'nothing\n');
  fs.writeFileSync(path.join(root, 'zz.txt'), 'one hello\ntwo hello\nthree hello\nfour hello\n');
  const m = await svc.searchAll('hello', () => false);
  const nameRows = m.rows.filter((x) => x.id === 'p1' && x.line === 0);
  assert.equal(nameRows.length, 5, 'first 5 file name matches');
  assert.ok(nameRows.every((x) => x.text === '' && x.project === 'One'));
  assert.ok(m.rows.findIndex((x) => x.line > 0 && x.id === 'p1') > m.rows.findLastIndex((x) => x.line === 0 && x.id === 'p1'), 'names come before content rows');
  assert.equal(m.rows.filter((x) => x.id === 'p1' && x.rel === 'zz.txt' && x.line > 0).length, 3, 'first 3 matches of a hit');
});

test('searchAll: at most 200 rows', async () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ id: `q${i}`, name: `Q${i}`, path: `/q${i}`, missing: false }));
  const fake = async () => ({ files: [{ rel: 'a' }, { rel: 'b' }], hits: [{ rel: 'c', matches: [{ line: 1, col: 0, text: 'x' }, { line: 2, col: 0, text: 'y' }, { line: 3, col: 0, text: 'z' }, { line: 4, col: 0, text: 'w' }] }], truncated: false });
  const svc = createFileService({ fs, path, files, projectRoot: () => null, searchProject: fake, projects: () => many });
  const r = await svc.searchAll('x', () => false);
  assert.equal(r.rows.length, 200);
  assert.deepEqual(r.rows[0], { id: 'q0', project: 'Q0', rel: 'a', line: 0, text: '' });
  assert.deepEqual(r.rows[2], { id: 'q0', project: 'Q0', rel: 'c', line: 1, text: 'x' });
  assert.equal(r.rows[5].id, 'q1');
});

test('resolveMd: relative, bare name, absolute inside; first resolving candidate wins', () => {
  const { svc, root } = searchSetup();
  assert.deepEqual(svc.resolveMd('p1', ['docs/guide.md']), { index: 0, rel: 'docs/guide.md' });
  assert.deepEqual(svc.resolveMd('p1', ['docs\\guide.md']), { index: 0, rel: 'docs/guide.md' });
  assert.deepEqual(svc.resolveMd('p1', ['guide.md']), { index: 0, rel: 'docs/guide.md' });
  assert.deepEqual(svc.resolveMd('p1', [path.join(root, 'docs', 'guide.md')]), { index: 0, rel: 'docs/guide.md' });
  assert.deepEqual(svc.resolveMd('p1', ['missing.md', 'nope/x.md', 'guide.md', 'docs/guide.md']), { index: 2, rel: 'docs/guide.md' });
});

test('resolveMd: outside, traversal, non-Markdown and odd candidates do not resolve', () => {
  const { svc, root, dir } = searchSetup();
  fs.writeFileSync(path.join(root, 'notes.txt.bak'), 'x');
  assert.equal(svc.resolveMd('p1', [path.join(dir, 'outside.md')]), null);
  assert.equal(svc.resolveMd('p1', ['../outside.md']), null);
  assert.equal(svc.resolveMd('p1', ['docs/../../outside.md']), null);
  assert.equal(svc.resolveMd('p1', ['notes.txt']), null);
  assert.equal(svc.resolveMd('p1', ['\\\\server\\share\\x.md', '//server/share/x.md', 'C:x.md', 'guide.md:hidden', 'a\0.md']), null);
  assert.equal(svc.resolveMd('p1', ['docs']), null);
  assert.equal(svc.resolveMd('p1', []), null);
  assert.equal(svc.resolveMd('p1', 'docs/guide.md'), null, 'candidates must be a list');
});

test('resolveMd: non-strings and long candidates are skipped, only the first 16 count; unknown project is refused', () => {
  const { svc } = searchSetup();
  assert.deepEqual(svc.resolveMd('p1', [5, null, {}, 'x'.repeat(1020) + '.md', 'guide.md']), { index: 4, rel: 'docs/guide.md' });
  assert.equal(svc.resolveMd('p1', ['x'.repeat(1022) + '.md']), null, 'over 1024 characters');
  const late = Array(16).fill('missing.md').concat(['guide.md']);
  assert.equal(late.length, 17);
  assert.equal(svc.resolveMd('p1', late), null, 'the 17th candidate is ignored');
  assert.deepEqual(svc.resolveMd('p1', Array(15).fill('missing.md').concat(['guide.md'])), { index: 15, rel: 'docs/guide.md' });
  assert.deepEqual(svc.resolveMd('nope', ['guide.md']), { error: 'That project is not available' });
});

test('resolveMd: a symlink to a Markdown file outside the project is refused (skipped where links cannot be created)', (t) => {
  const { svc, root, dir } = searchSetup();
  try { fs.symlinkSync(dir, path.join(root, 'jx'), 'junction'); } catch { return t.skip('no junction'); }
  assert.equal(svc.resolveMd('p1', ['jx/outside.md']), null);
  assert.equal(svc.resolveMd('p1', [path.join(root, 'jx', 'outside.md')]), null);
});
