// Worker thread for src/remote-md.js: renders one Markdown text and posts the HTML (or the error) back. marked can take
// seconds on hostile input or overflow the stack; here that only costs this thread, which the parent terminates.
const { parentPort, workerData } = require('worker_threads');
const { renderMarkdown } = require('./md-render');

try {
  parentPort.postMessage({ html: renderMarkdown(workerData.text) });
} catch (err) {
  parentPort.postMessage({ error: String((err && err.message) || err) });
}
