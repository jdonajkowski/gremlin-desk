// Claude Code reports turn progress as OSC 9;4;<state>[;<percent>] (see terminals.js). The host's main process has no
// terminal, so this finds the same sequences in the raw PTY stream, across chunk boundaries.
const SEQ = /\x1b\]9;4;(\d)(?:;(\d{1,3}))?(?:\x07|\x1b\\)/g;
const MAX_PARTIAL = 24;

function createScanner() {
  let pending = '';
  return {
    feed(chunk) {
      const text = pending + chunk;
      pending = '';
      const out = [];
      let end = 0;
      let m;
      SEQ.lastIndex = 0;
      while ((m = SEQ.exec(text))) {
        out.push({ state: Number(m[1]), value: Number(m[2] || 0) });
        end = SEQ.lastIndex;
      }
      const tail = text.slice(end);
      const esc = tail.indexOf('\x1b', Math.max(0, tail.length - MAX_PARTIAL));
      if (esc !== -1) pending = tail.slice(esc);
      return out;
    }
  };
}

module.exports = { createScanner };
