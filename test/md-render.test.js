const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown, resolveRelativeLink, isSafeHref, allowedAttr, ALLOWED_TAGS, DROP_TAGS, ALLOWED_ATTRS } = require('../src/md-render');

test('renderMarkdown strips YAML front matter and renders GFM', () => {
  const html = renderMarkdown('---\ntitle: x\n---\n# Hi\n\n| a |\n|---|\n| b |\n');
  assert.ok(html.includes('<h1>Hi</h1>'));
  assert.ok(html.includes('<table>'));
  assert.ok(!html.includes('title: x'));
});

test('renderMarkdown handles CRLF front matter', () => {
  assert.ok(!renderMarkdown('---\r\na: 1\r\n---\r\ntext').includes('a: 1'));
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

test('isSafeHref accepts #fragments, relative paths and http(s)', () => {
  for (const h of ['#frag', 'docs/a.md', '../x.md', './a', '/root/a.md', 'a.md?x=1&y=2', 'https://example.com/x?a=1&b=2', 'HTTP://x.test', 'mailto-ish/ok']) {
    assert.strictEqual(isSafeHref(h), true, h);
  }
});

test('isSafeHref refuses other schemes, obfuscation, UNC and protocol-relative links', () => {
  for (const h of ['javascript:alert(1)', 'JaVa\tScRiPt:alert(1)', ' java\0script:x', 'java\nscript:x', '&#106;avascript:x', 'javascript&colon;x',
    'vbscript:x', 'data:text/html,<b>', 'file://evil/share/x', 'file:///c:/x', '//host/x', '\\\\host\\share', '/\\host/x', 'a\\b', 'ftp://x', '', '   ', null, 5,
    'x'.repeat(3000)]) {
    assert.strictEqual(isSafeHref(h), false, String(h));
  }
});

test('allowedAttr ignores tag names that are Object.prototype members', () => {
  for (const tag of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.strictEqual(allowedAttr(tag, 'name', 'x'), null, tag);
    assert.strictEqual(allowedAttr(tag, 'length', '1'), null, tag);
    assert.strictEqual(allowedAttr(tag, 'title', 'ok'), 'ok', tag); // the '*' list still applies
  }
});

test('allowedAttr copies only the listed attributes', () => {
  assert.strictEqual(allowedAttr('a', 'href', 'docs/a.md'), 'docs/a.md');
  assert.strictEqual(allowedAttr('a', 'href', 'javascript:x'), null);
  assert.strictEqual(allowedAttr('div', 'href', 'a.md'), null);
  assert.strictEqual(allowedAttr('div', 'style', 'background:url(http://x)'), null);
  assert.strictEqual(allowedAttr('img', 'src', 'http://x'), null);
  assert.strictEqual(allowedAttr('a', 'onclick', 'x()'), null);
  assert.strictEqual(allowedAttr('video', 'poster', 'http://x'), null);
  assert.strictEqual(allowedAttr('p', 'title', 'hi'), 'hi');
  assert.strictEqual(allowedAttr('h2', 'id', 'setup'), 'setup');
  assert.strictEqual(allowedAttr('p', 'id', 'setup'), null);
  assert.strictEqual(allowedAttr('code', 'class', 'language-js'), 'language-js');
  assert.strictEqual(allowedAttr('code', 'class', 'language-js x'), null);
  assert.strictEqual(allowedAttr('p', 'class', 'language-js'), null);
  assert.strictEqual(allowedAttr('td', 'align', 'CENTER'), 'center');
  assert.strictEqual(allowedAttr('td', 'align', 'expression(x)'), null);
  assert.strictEqual(allowedAttr('ol', 'start', '3'), '3');
  assert.strictEqual(allowedAttr('ol', 'start', 'x'), null);
  assert.strictEqual(allowedAttr('input', 'type', 'checkbox'), 'checkbox');
  assert.strictEqual(allowedAttr('input', 'type', 'image'), null);
  assert.strictEqual(allowedAttr('input', 'src', 'http://x'), null);
  assert.strictEqual(allowedAttr('input', 'checked', ''), '');
});

test('the tables keep dangerous tags out of the allowlist', () => {
  for (const t of ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'svg', 'math', 'video', 'audio', 'source', 'template', 'noscript', 'textarea', 'select', 'button']) {
    assert.ok(DROP_TAGS.includes(t), t);
    assert.ok(!ALLOWED_TAGS.includes(t), t);
  }
  for (const t of ['h1', 'p', 'a', 'table', 'td', 'pre', 'code', 'li', 'input', 'details', 'summary']) assert.ok(ALLOWED_TAGS.includes(t), t);
  assert.ok(!ALLOWED_TAGS.includes('img'));
  for (const list of Object.values(ALLOWED_ATTRS)) for (const a of list) assert.ok(!/^(style|src|srcset|poster|on)/.test(a), a);
});
