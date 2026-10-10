// The last `max` characters of a session's output, kept by the host so a client that attaches later can see the screen.
// Whole chunks are dropped from the front, so the cut falls where the PTY wrote it.
function createRing(max = 262144) {
  let chunks = [];
  let size = 0;
  let cut = false;
  return {
    push(s) {
      if (!s) return;
      chunks.push(s);
      size += s.length;
      while (size > max && chunks.length > 1) {
        size -= chunks.shift().length;
        cut = true;
      }
      if (size > max) { // one chunk alone is over the limit
        chunks[0] = chunks[0].slice(-max);
        size = chunks[0].length;
        cut = true;
      }
    },
    // After a cut the first line may start mid-style, so the snapshot begins with a reset.
    snapshot() { return (cut ? '\x1b[0m' : '') + chunks.join(''); },
    clear() { chunks = []; size = 0; cut = false; },
    get size() { return size; }
  };
}

module.exports = { createRing };
