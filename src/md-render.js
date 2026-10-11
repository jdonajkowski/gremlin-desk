// Markdown text -> HTML for the popout, shared by local files (main.js renderMd) and text received from a remote
// computer, so the two cannot drift. Also the pure helpers for remote documents: relative links and images.
const path = require('path');

function renderMarkdown(text) {
  const { marked } = require('marked');
  // YAML front matter is metadata, not content.
  return marked.parse(String(text).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, ''), { gfm: true });
}

// Images of a remote document cannot load (the file is on the other computer): show the alt text instead.
function altTextForImages(html) {
  return String(html).replace(/<img\b[^>]*>/gi, (tag) => {
    const m = /\balt="([^"]*)"/i.exec(tag);
    return `<span class="noimg">[${m && m[1] ? m[1] : 'image'}]</span>`;
  });
}

// Raw HTML in a remote document is untrusted: drop everything that can fetch, navigate or submit (the popout's CSP is the
// second line of defence). Ordinary Markdown output has none of these, so it passes through unchanged.
const DROP_WITH_CONTENT = 'script|style|iframe|object|form|svg|math|video|audio|noscript|template|frameset|frame|applet|canvas';
const DROP_TAG = `${DROP_WITH_CONTENT}|meta|link|base|embed|source|track|param|image|picture`;
const ATTR_VALUE = '"[^"]*"|\'[^\']*\'|[^\\s>]*';
const BAD_ATTR = new RegExp(`\\s(?:style|src|srcset|poster|background|formaction|action|ping|data|xlink:href|on[a-z]+)\\s*=\\s*(?:${ATTR_VALUE})`, 'gi');
const HREF_ATTR = new RegExp(`\\shref\\s*=\\s*(${ATTR_VALUE})`, 'gi');

function sanitizeRemoteHtml(html) {
  return String(html)
    .replace(new RegExp(`<(${DROP_WITH_CONTENT})\\b[\\s\\S]*?<\\/\\1\\s*>`, 'gi'), '')
    .replace(new RegExp(`<\\/?(?:${DROP_TAG})\\b(?:"[^"]*"|'[^']*'|[^'">])*>`, 'gi'), '')
    .replace(/<([a-z][a-z0-9-]*)\b((?:"[^"]*"|'[^']*'|[^'">])*)>/gi, (m, tag, attrs) => {
      if (/^input$/i.test(tag) && /\btype\s*=\s*["']?image/i.test(attrs)) return '';
      const a = attrs.replace(BAD_ATTR, '').replace(HREF_ATTR, (whole, v) => {
        const val = v.replace(/^["']|["']$/g, '').replace(/[\s\x00-\x20]+/g, '');
        return /^(javascript|vbscript|data):/i.test(val) || /^[^/#?]*&(#|colon)/i.test(val) ? '' : whole;
      });
      return a === attrs ? m : `<${tag}${a}>`;
    });
}

// A link clicked in a remote document -> a project-relative Markdown path, or null. The target is resolved against the
// document's folder and must stay inside the project; anything with a scheme, a drive letter or a backslash is refused.
function resolveRelativeLink(fromRel, href) {
  if (typeof fromRel !== 'string' || typeof href !== 'string') return null;
  let target;
  try { target = decodeURIComponent(href.split('#')[0].split('?')[0]); } catch { return null; }
  if (!target || target.length > 1024 || /[:\\\0]/.test(target) || target.startsWith('/')) return null;
  if (!/\.(md|markdown)$/i.test(target)) return null;
  const rel = path.posix.join(path.posix.dirname(fromRel.replace(/\\/g, '/')), target);
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('/') || rel === '.') return null;
  return rel;
}

module.exports = { renderMarkdown, altTextForImages, sanitizeRemoteHtml, resolveRelativeLink };
