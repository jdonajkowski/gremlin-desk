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

module.exports = { renderMarkdown, altTextForImages, resolveRelativeLink };
