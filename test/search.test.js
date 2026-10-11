const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { matcher, preview, searchProject } = require('../src/search');

test('matcher: plain text ignores case by default, regex optional, bad regex gives null', () => {
  assert.equal(matcher('foo')('a FOO b'), 2);
  assert.equal(matcher('foo', { caseSensitive: true })('a FOO b'), -1);
  assert.equal(matcher('f.o', { regex: true })('xfao'), 1);
  assert.equal(matcher('(', { regex: true }), null);
  assert.equal(matcher(''), null);
});

test('preview keeps the match in view on long lines', () => {
  const line = `${'x'.repeat(300)}NEEDLE${'y'.repeat(300)}`;
  const p = preview(line, 300);
  assert.equal(p.text.length <= 161, true);
  assert.equal(p.text.slice(p.col, p.col + 6), 'NEEDLE');
});

test('searchProject finds names and contents, skipping ignored folders and binaries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'widget.js'), 'const a = 1;\nfunction makeWidget() {}\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# Widget\n');
  fs.writeFileSync(path.join(root, 'node_modules', 'x', 'widget.js'), 'widget');
  fs.writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 119, 105, 100, 103, 101, 116]));
  const r = await searchProject(root, 'widget');
  assert.deepEqual(r.files, [{ rel: 'src/widget.js' }]);
  assert.deepEqual(r.hits.map((h) => [h.rel, h.matches.map((m) => m.line)]), [['README.md', [1]], ['src/widget.js', [2]]]);
  assert.equal(await searchProject(root, 'widget', { isCancelled: () => true }), null);
  const capped = await searchProject(root, 'e', { maxHits: 1 });
  assert.equal(capped.truncated, true);
});

test('searchProject: isLate ends the walk with the hits found so far; isCancelled still gives null', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
  for (const d of ['a', 'b', 'c']) {
    fs.mkdirSync(path.join(root, d));
    fs.writeFileSync(path.join(root, d, 'x.txt'), 'needle\n');
  }
  const all = await searchProject(root, 'needle', { isLate: () => false });
  assert.equal(all.hits.length, 3);
  assert.equal(all.truncated, false);
  let n = 0;
  const part = await searchProject(root, 'needle', { isLate: () => ++n > 4 });
  assert.ok(part.hits.length >= 1 && part.hits.length < 3, `partial hits: ${part.hits.length}`);
  assert.equal(part.hits[0].rel, 'a/x.txt');
  assert.equal(part.truncated, true);
  assert.equal(await searchProject(root, 'needle', { isCancelled: () => true, isLate: () => true }), null, 'cancel wins');
});

test('searchProject: a cancel is seen between files inside one folder, not only between folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-'));
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'needle\n');
  let n = 0;
  assert.equal(await searchProject(root, 'needle', { isCancelled: () => ++n > 2 }), null);
});
