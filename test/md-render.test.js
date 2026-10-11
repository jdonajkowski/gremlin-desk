const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown, altTextForImages, resolveRelativeLink } = require('../src/md-render');

test('renderMarkdown strips YAML front matter and renders GFM', () => {
  const html = renderMarkdown('---\ntitle: x\n---\n# Hi\n\n| a |\n|---|\n| b |\n');
  assert.ok(html.includes('<h1>Hi</h1>'));
  assert.ok(html.includes('<table>'));
  assert.ok(!html.includes('title: x'));
});

test('renderMarkdown handles CRLF front matter', () => {
  assert.ok(!renderMarkdown('---\r\na: 1\r\n---\r\ntext').includes('a: 1'));
});

test('altTextForImages replaces images with their alt text', () => {
  const html = altTextForImages(renderMarkdown('![Logo](img/logo.png) and <img src="https://x/y.png">'));
  assert.ok(!/<img/i.test(html));
  assert.ok(html.includes('[Logo]'));
  assert.ok(html.includes('[image]'));
});

test('resolveRelativeLink resolves against the document folder', () => {
  assert.strictEqual(resolveRelativeLink('README.md', 'docs/guide.md'), 'docs/guide.md');
  assert.strictEqual(resolveRelativeLink('docs/guide.md', '../README.md'), 'README.md');
  assert.strictEqual(resolveRelativeLink('docs/a/b.md', './c.md#top'), 'docs/a/c.md');
  assert.strictEqual(resolveRelativeLink('docs/a.md', 'my%20file.md'), 'docs/my file.md');
});

test('resolveRelativeLink refuses anything outside the project or odd', () => {
  for (const href of ['../x.md', '../../x.md', '/etc/a.md', 'C:/a.md', 'C:\\a.md', 'a\\..\\b.md', 'file:///a.md', 'https://x/a.md',
    '%2e%2e/x.md', 'a.txt', '', '#top', 'a\0.md', '//host/share/a.md', 'x'.repeat(1100) + '.md']) {
    assert.strictEqual(resolveRelativeLink('README.md', href), null, href);
  }
  assert.strictEqual(resolveRelativeLink('a.md', 5), null);
  assert.strictEqual(resolveRelativeLink(null, 'a.md'), null);
});

const { sanitizeRemoteHtml } = require('../src/md-render');

test('sanitizeRemoteHtml removes tags and attributes that load or navigate', () => {
  const hostile = [
    '<input type="image" src="https://evil.test/a.png">',
    '<video poster="https://evil.test/p.png"><source src="https://evil.test/v.mp4"></video>',
    '<svg><image href="https://evil.test/i.png"/></svg>',
    '<div style="background:url(https://evil.test/b.png)">x</div>',
    '<style>body{background:url(file://evil/share/x.png)}</style>',
    '<meta http-equiv="refresh" content="0;url=http://evil.test/">',
    '<iframe src="https://evil.test/"></iframe>',
    '<object data="https://evil.test/o"></object><embed src="https://evil.test/e">',
    '<form action="https://evil.test/"><button>go</button></form>',
    '<link rel="stylesheet" href="https://evil.test/c.css"><base href="https://evil.test/">',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="  JaVa\tScRiPt:alert(1)">x</a>',
    '<a href="&#106;avascript:alert(1)">x</a>',
    '<img srcset="https://evil.test/a.png 1x" onerror="x()">',
    '<script>alert(1)</script>'
  ].join('\n');
  const out = sanitizeRemoteHtml(hostile);
  assert.ok(!/evil/i.test(out), out);
  assert.ok(!/<(meta|iframe|object|embed|form|link|base|style|script|svg|video|input)\b/i.test(out), out);
  assert.ok(!/javascript:|onerror|style=|srcset|poster/i.test(out), out);
});

test('sanitizeRemoteHtml leaves ordinary Markdown output alone', () => {
  const html = renderMarkdown('# T\n\n- [x] done\n- b\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst a = "<b>";\n```\n\n[ok](docs/a.md) [web](https://example.com/x?y=1) `code`\n');
  assert.strictEqual(sanitizeRemoteHtml(html), html);
  assert.ok(sanitizeRemoteHtml(altTextForImages(renderMarkdown('![Logo](a.png)'))).includes('[Logo]'));
});
