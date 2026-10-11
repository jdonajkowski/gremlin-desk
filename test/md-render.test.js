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
