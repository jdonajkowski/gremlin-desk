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
