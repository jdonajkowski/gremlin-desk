const test = require('node:test');
const assert = require('node:assert');
const { renderRemoteMarkdown, plainHtml, FALLBACK_NOTICE } = require('../src/remote-md');

test('renderRemoteMarkdown renders ordinary Markdown in a worker', async () => {
  const r = await renderRemoteMarkdown('---\ntitle: x\n---\n# Hi\n\n*em*');
  assert.strictEqual(r.plain, false);
  assert.ok(r.html.includes('<h1>Hi</h1>'));
  assert.ok(r.html.includes('<em>em</em>'));
  assert.ok(!r.html.includes('title: x'));
});

test('a quadratic payload falls back to plain text within the deadline', async () => {
  const text = '*a_'.repeat(16000); // ~48 KB; marked alone takes many seconds on this
  const t0 = Date.now();
  const r = await renderRemoteMarkdown(text);
  const ms = Date.now() - t0;
  assert.ok(ms < 3000, `took ${ms} ms`);
  assert.strictEqual(r.plain, true);
  assert.ok(r.html.startsWith(`<p><em>${FALLBACK_NOTICE}</em></p><pre>`));
  assert.ok(r.html.includes('*a_*a_'));
});

test('deep nesting that overflows the stack does not throw', async () => {
  const r = await renderRemoteMarkdown('>'.repeat(20000));
  assert.strictEqual(typeof r.html, 'string');
  if (r.plain) assert.ok(r.html.includes(FALLBACK_NOTICE));
});

test('a worker that cannot start falls back instead of rejecting', async () => {
  const r = await renderRemoteMarkdown('# x', { workerFile: 'C:/does/not/exist-md-worker.js' });
  assert.strictEqual(r.plain, true);
});

test('plainHtml escapes the text', () => {
  assert.strictEqual(plainHtml('<script>&"'), `<p><em>${FALLBACK_NOTICE}</em></p><pre>&lt;script&gt;&amp;&quot;</pre>`);
});
