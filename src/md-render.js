// Markdown text -> HTML for the popout, shared by local files (main.js renderMd) and text received from a remote
// computer, so the two cannot drift. Also the pure helpers for remote documents: the link resolver (main process) and the
// allowlist tables the popout uses to rebuild a remote document's HTML (src/md/md.js loads this file with a script tag).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MdRender = factory();
})(this, function () {
  function renderMarkdown(text) {
    const { marked } = require('marked');
    // YAML front matter is metadata, not content.
    return marked.parse(String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''), { gfm: true });
  }

  // --- Remote documents: the popout parses the HTML inertly and copies only what is listed here -----------------------
  const ALLOWED_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'del', 's', 'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'details', 'summary', 'kbd', 'sup', 'sub', 'span', 'div'];
  // Dropped together with everything inside. Any other unknown tag is unwrapped (its children are kept).
  const DROP_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'svg', 'math', 'video', 'audio', 'source', 'template',
    'noscript', 'textarea', 'select', 'button', 'head', 'title', 'frame', 'frameset', 'applet', 'canvas', 'track', 'param'];
  const ALLOWED_ATTRS = {
    '*': ['title'],
    h1: ['id'], h2: ['id'], h3: ['id'], h4: ['id'], h5: ['id'], h6: ['id'],
    a: ['href'],
    code: ['class'],
    th: ['align'],
    td: ['align'],
    ol: ['start'],
    input: ['type', 'checked', 'disabled']
  };

  // http(s), a #fragment or a relative path; nothing else. Control characters and whitespace are ignored first (browsers do),
  // and a scheme hidden behind an entity is refused.
  function isSafeHref(href) {
    if (typeof href !== 'string') return false;
    const v = href.replace(/[\u0000- \u007f-\u009f]+/g, '');
    if (!v || v.length > 2048) return false;
    if (v.startsWith('#')) return true;
    if (/^[\\/]{2}/.test(v) || v.includes('\\')) return false;
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v);
    if (scheme) return /^https?$/i.test(scheme[1]);
    return !/^[^/?#]*&/.test(v);
  }

  // The value to copy for an attribute of an allowed tag, or null to drop it.
  function allowedAttr(tag, name, value) {
    tag = String(tag).toLowerCase();
    name = String(name).toLowerCase();
    value = String(value);
    if (!(ALLOWED_ATTRS['*'].includes(name) || (ALLOWED_ATTRS[tag] || []).includes(name))) return null;
    if (name === 'title') return value.slice(0, 500);
    if (name === 'href') return isSafeHref(value) ? value : null;
    if (name === 'class') return /^language-[A-Za-z0-9_+-]+$/.test(value) ? value : null;
    if (name === 'align') return /^(left|right|center)$/i.test(value) ? value.toLowerCase() : null;
    if (name === 'start') return /^\d{1,9}$/.test(value) ? value : null;
    if (name === 'type') return value.toLowerCase() === 'checkbox' ? 'checkbox' : null;
    if (name === 'checked' || name === 'disabled') return '';
    return value.slice(0, 200); // id
  }

  // A link clicked in a remote document -> a project-relative Markdown path, or null. The target is resolved against the
  // document's folder and must stay inside the project; anything with a scheme, a drive letter or a backslash is refused.
  function resolveRelativeLink(fromRel, href) {
    const path = require('path');
    if (typeof fromRel !== 'string' || typeof href !== 'string') return null;
    let target;
    try { target = decodeURIComponent(href.split('#')[0].split('?')[0]); } catch { return null; }
    if (!target || target.length > 1024 || /[:\\\0]/.test(target) || target.startsWith('/')) return null;
    if (!/\.(md|markdown)$/i.test(target)) return null;
    const rel = path.posix.join(path.posix.dirname(fromRel.replace(/\\/g, '/')), target);
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('/') || rel === '.') return null;
    return rel;
  }

  return { renderMarkdown, ALLOWED_TAGS, DROP_TAGS, ALLOWED_ATTRS, isSafeHref, allowedAttr, resolveRelativeLink };
});
