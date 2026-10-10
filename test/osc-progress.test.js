const test = require('node:test');
const assert = require('node:assert/strict');
const { createScanner } = require('../src/osc-progress');

test('finds start and end of a turn, with BEL and ST terminators', () => {
  const s = createScanner();
  assert.deepEqual(s.feed('hi\x1b]9;4;3\x07there\x1b]9;4;0\x1b\\'), [{ state: 3, value: 0 }, { state: 0, value: 0 }]);
});

test('reads the percentage', () => {
  assert.deepEqual(createScanner().feed('\x1b]9;4;1;42\x07'), [{ state: 1, value: 42 }]);
});

test('a sequence split across chunks is found once', () => {
  const s = createScanner();
  assert.deepEqual(s.feed('abc\x1b]9;'), []);
  assert.deepEqual(s.feed('4;3'), []);
  assert.deepEqual(s.feed('\x07tail'), [{ state: 3, value: 0 }]);
  assert.deepEqual(s.feed('tail'), []);
});

test('ignores other OSC sequences and plain output', () => {
  const s = createScanner();
  assert.deepEqual(s.feed('\x1b]0;title\x07\x1b]9;1;note\x07 plain'), []);
});

test('a lone escape at the end of a chunk does not swallow later output', () => {
  const s = createScanner();
  assert.deepEqual(s.feed('x\x1b'), []);
  assert.deepEqual(s.feed('[31mred\x1b]9;4;0\x07'), [{ state: 0, value: 0 }]);
});
