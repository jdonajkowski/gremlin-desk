const test = require('node:test');
const assert = require('node:assert/strict');
const { createRing } = require('../src/ring-buffer');

test('keeps everything under the limit, in order', () => {
  const r = createRing(100);
  r.push('abc');
  r.push('');
  r.push('def');
  assert.equal(r.snapshot(), 'abcdef');
  assert.equal(r.size, 6);
});

test('drops the oldest chunks past the limit and marks the cut with a style reset', () => {
  const r = createRing(10);
  r.push('aaaaa');
  r.push('bbbbb');
  r.push('ccccc');
  assert.equal(r.snapshot(), '\x1b[0mbbbbbccccc');
  assert.ok(r.size <= 10);
});

test('a single chunk bigger than the limit is cut to its tail', () => {
  const r = createRing(5);
  r.push('0123456789');
  assert.equal(r.snapshot(), '\x1b[0m56789');
});

test('clear forgets everything, including the cut mark', () => {
  const r = createRing(5);
  r.push('0123456789');
  r.clear();
  r.push('x');
  assert.equal(r.snapshot(), 'x');
});
