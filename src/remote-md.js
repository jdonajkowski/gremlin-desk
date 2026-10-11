// Markdown from a remote computer is rendered off the main thread under a deadline: marked is slow (quadratic) on some
// inputs and can overflow the stack on deep nesting, and a host must not be able to freeze or crash this app by sending
// such a file. Past the deadline, or on an error, the document is shown as escaped plain text instead.
// Local Markdown still renders in main (src/md-render.js), unchanged.
const path = require('path');
const { Worker } = require('worker_threads');

const RENDER_MS = 2000;
const FALLBACK_NOTICE = 'Too complex to render, showing plain text';

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Only tags the remote popout's allowlist keeps (p, em, pre).
const plainHtml = (text) => `<p><em>${FALLBACK_NOTICE}</em></p><pre>${escapeHtml(text)}</pre>`;

// Resolves { html, plain } and never rejects: plain is true when the fallback was used.
function renderRemoteMarkdown(text, { timeoutMs = RENDER_MS, workerFile = path.join(__dirname, 'md-worker.js') } = {}) {
  const src = String(text);
  return new Promise((resolve) => {
    let done = false;
    let worker;
    let timer;
    const finish = (html, plain) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (worker) worker.terminate().catch(() => {});
      resolve({ html: plain ? plainHtml(src) : html, plain });
    };
    try {
      worker = new Worker(workerFile, { workerData: { text: src } });
    } catch {
      return finish(null, true);
    }
    timer = setTimeout(() => finish(null, true), timeoutMs);
    worker.once('message', (m) => (m && typeof m.html === 'string' ? finish(m.html, false) : finish(null, true)));
    worker.once('error', () => finish(null, true));
    worker.once('exit', () => finish(null, true)); // exited without a message
  });
}

module.exports = { renderRemoteMarkdown, plainHtml, escapeHtml, RENDER_MS, FALLBACK_NOTICE };
