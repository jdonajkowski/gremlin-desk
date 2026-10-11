const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/remote-results');

test('searchResult shapes a host reply like a local search and adds the highlight column', () => {
  const r = R.searchResult({
    files: [{ rel: 'docs/Needle.md' }],
    hits: [{ rel: 'src/a.js', matches: [{ line: 3, text: 'const NEEDLE = 1' }, { line: 9, text: 'no match here' }] }],
    truncated: false
  }, 'needle', false);
  assert.deepStrictEqual(r, {
    root: '',
    files: [{ rel: 'docs/Needle.md' }],
    hits: [{ rel: 'src/a.js', matches: [{ line: 3, text: 'const NEEDLE = 1', col: 6 }, { line: 9, text: 'no match here', col: -1 }] }],
    truncated: false
  });
  assert.strictEqual(R.searchResult({ hits: [{ rel: 'a', matches: [{ line: 1, text: 'NEEDLE needle' }] }] }, 'needle', true).hits[0].matches[0].col, 7);
});

test('searchResult drops malformed entries and caps what it keeps', () => {
  for (const bad of [null, 'x', [], 5]) assert.strictEqual(R.searchResult(bad, 'q', false), null);
  const r = R.searchResult({
    files: [{ rel: 5 }, null, { rel: '' }, { rel: 'ok.txt', extra: 1 }, { rel: 'x'.repeat(2000) }],
    hits: [
      { rel: 'a', matches: [{ line: 0, text: 'q' }, { line: 1.5, text: 'q' }, { line: 2, text: 7 }] },
      { rel: 7, matches: [{ line: 1, text: 'q' }] },
      { rel: 'b', matches: 'nope' },
      { rel: 'c', matches: [{ line: 4, text: 'q'.repeat(1000) }] }
    ],
    truncated: 'yes'
  }, 'q', false);
  assert.deepStrictEqual(r.files, [{ rel: 'ok.txt' }]);
  assert.strictEqual(r.hits.length, 1);
  assert.strictEqual(r.hits[0].rel, 'c');
  assert.strictEqual(r.hits[0].matches[0].text.length, 400);
  assert.strictEqual(r.truncated, false);
  const many = R.searchResult({ hits: [{ rel: 'a', matches: Array.from({ length: 600 }, (_, i) => ({ line: i + 1, text: 'q' })) }, { rel: 'b', matches: [{ line: 1, text: 'q' }] }] }, 'q', false);
  assert.strictEqual(many.hits.length, 1);
  assert.strictEqual(many.hits[0].matches.length, 500);
  assert.strictEqual(many.truncated, true);
});

test('mergeFindRows puts local rows first, labels remote rows with the host and caps at 200', () => {
  const local = [{ id: 'C:/p', project: 'p', rel: 'a.md', line: 1, text: 'x' }];
  const remote = [
    { id: 'r:h1/C:/q', host: 'Box', project: 'q', rel: 'b.md', line: 2, text: 'y' },
    { id: 'r:h1/C:/q', host: 'Box', project: 'q', rel: 5, line: 2, text: 'y' },
    { id: 7, host: 'Box', project: 'q', rel: 'c.md' }
  ];
  assert.deepStrictEqual(R.mergeFindRows(local, remote), [
    local[0],
    { id: 'r:h1/C:/q', project: 'Box · q', rel: 'b.md', line: 2, text: 'y' }
  ]);
  const lots = Array.from({ length: 150 }, (_, i) => ({ id: 'l', project: 'p', rel: `l${i}`, line: 0, text: '' }));
  const far = Array.from({ length: 150 }, (_, i) => ({ id: 'r:h/x', host: 'H', project: 'x', rel: `r${i}`, line: 0, text: '' }));
  const rows = R.mergeFindRows(lots, far);
  assert.strictEqual(rows.length, 200);
  assert.strictEqual(rows[149].rel, 'l149');
  assert.strictEqual(rows[150].rel, 'r0');
  assert.strictEqual(R.mergeFindRows(null, null).length, 0);
});

test('findErrorText joins host errors into one toast and leaves out cancelled and busy', () => {
  assert.strictEqual(R.findErrorText([
    { host: 'a', name: 'Box', message: 'Host is not connected' },
    { host: 'b', name: 'Lap', message: 'Search cancelled' },
    { host: 'c', name: 'Pi', message: 'Too many file requests' },
    { host: 'd', name: 'Mac', message: 'The other computer did not answer' }
  ]), 'Box: Host is not connected; Mac: The other computer did not answer');
  assert.strictEqual(R.findErrorText([{ host: 'b', name: 'Lap', message: 'Search cancelled' }]), '');
  assert.strictEqual(R.findErrorText(undefined), '');
  assert.deepStrictEqual(R.busyHosts([{ host: 'c', name: 'Pi', message: 'Too many file requests' }, { host: 'a', message: 'x' }]), ['c']);
});

test('mdCandidates keeps positions and blanks what the host would refuse', () => {
  assert.strictEqual(R.mdCandidates('a.md'), null);
  assert.deepStrictEqual(R.mdCandidates(['a.md', 5, '', 'b\0.md', 'x'.repeat(2000), 'docs/c.md']), ['a.md', '', '', '', '', 'docs/c.md']);
  assert.strictEqual(R.mdCandidates(Array.from({ length: 40 }, () => 'a.md')).length, 16);
});

test('resolvedMd accepts only an in-range index and a project-relative Markdown path', () => {
  assert.deepStrictEqual(R.resolvedMd({ index: 1, rel: 'docs/a.md' }, 3), { index: 1, rel: 'docs/a.md' });
  for (const bad of [
    null, { error: 'x' }, { index: 3, rel: 'a.md' }, { index: -1, rel: 'a.md' }, { index: 0.5, rel: 'a.md' }, { index: '0', rel: 'a.md' },
    { index: 0, rel: 5 }, { index: 0, rel: '../a.md' }, { index: 0, rel: 'docs/../../a.md' }, { index: 0, rel: '/etc/a.md' },
    { index: 0, rel: 'C:/a.md' }, { index: 0, rel: 'a\\b.md' }, { index: 0, rel: 'a.txt' }, { index: 0, rel: 'a//b.md' }, { index: 0, rel: 'a\0.md' }
  ]) assert.strictEqual(R.resolvedMd(bad, 3), null, JSON.stringify(bad));
});

test('isRemoteId matches a host namespace whether or not the host is still paired, never a local path', () => {
  for (const id of ['r:hostbox/c:\\users\\me\\proj', 'r:box-2//home/me/proj', 'r:gone/x']) assert.strictEqual(R.isRemoteId(id), true, id);
  for (const id of ['r:\\work\\proj', 'r:/work', 'c:\\users\\me\\proj', '/home/me/proj', 'R:HOST/x', 'r:', '', null, undefined, 5, {}]) {
    assert.strictEqual(R.isRemoteId(id), false, String(id));
  }
});

test('listEntries keeps typed name/rel/dir entries, caps at 2000 and drops the rest', () => {
  for (const bad of [null, 'x', [], { entries: 'x' }]) assert.strictEqual(R.listEntries(bad), null);
  assert.deepStrictEqual(R.listEntries({ entries: [
    { name: 'a.md', rel: 'docs/a.md', dir: false, size: 5, evil: '<b>' },
    { name: 'src', rel: 'src', dir: true },
    { name: 5, rel: 'x', dir: false },
    { name: 'y', rel: 7, dir: false },
    { name: 'z', rel: 'z', dir: 'yes' },
    { name: '', rel: 'e', dir: false },
    { name: 'n\0', rel: 'n', dir: false },
    null
  ] }), [{ name: 'a.md', rel: 'docs/a.md', dir: false }, { name: 'src', rel: 'src', dir: true }]);
  assert.strictEqual(R.listEntries({ entries: Array.from({ length: 2500 }, (_, i) => ({ name: `f${i}`, rel: `f${i}`, dir: false })) }).length, 2000);
});

test('looksRemote refuses anything r:-like except a local drive R: path', () => {
  for (const id of ['R:HOST/x', 'r:', 'r:host', 'r:hostbox/c:\\x', 'R:', 'r:..', 'r:host\\x']) assert.strictEqual(R.looksRemote(id), true, id);
  for (const id of ['r:\\proj', 'r:/x', 'R:\\proj', 'c:\\users\\me', '/home/r:x', '', null, undefined, 5]) assert.strictEqual(R.looksRemote(id), false, String(id));
});

test('searchResult marks a reply truncated when it drops file-name rows past 200', () => {
  const r = R.searchResult({ files: Array.from({ length: 201 }, (_, i) => ({ rel: `f${i}` })), hits: [], truncated: false }, 'f', false);
  assert.strictEqual(r.files.length, 200);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(R.searchResult({ files: [{ rel: 'a' }], hits: [] }, 'a', false).truncated, false);
});
