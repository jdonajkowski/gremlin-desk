const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/tab-prefs');

test('arrange: the first tab stays first, pins come next, then your order, then the rest as they were', () => {
  const ids = ['claude', 'a', 'b', 'c', 'd'];
  assert.deepEqual(P.arrange(ids, P.empty()), ids);
  assert.deepEqual(P.arrange(ids, { order: ['c', 'a'], pinned: [], names: {} }), ['claude', 'c', 'a', 'b', 'd']);
  assert.deepEqual(P.arrange(ids, { order: ['c', 'a'], pinned: ['d', 'a'], names: {} }), ['claude', 'a', 'd', 'c', 'b']);
  assert.deepEqual(P.arrange([], P.empty()), []);
});

test('move: before another tab, or to the end; never above the first tab', () => {
  const ids = ['claude', 'a', 'b', 'c'];
  assert.deepEqual(P.move(P.empty(), ids, 'c', 'a').order, ['c', 'a', 'b']);
  assert.deepEqual(P.move(P.empty(), ids, 'a', null).order, ['b', 'c', 'a']);
  assert.deepEqual(P.move(P.empty(), ids, 'claude', 'a'), P.empty());
});

test('togglePin and rename', () => {
  let p = P.togglePin(P.empty(), 'a');
  assert.ok(P.isPinned(p, 'a'));
  p = P.togglePin(p, 'a');
  assert.ok(!P.isPinned(p, 'a'));
  p = P.rename(p, 'a', '  build  ');
  assert.equal(P.nameOf(p, 'a', 'zsh'), 'build');
  p = P.rename(p, 'a', '   ');
  assert.equal(P.nameOf(p, 'a', 'zsh'), 'zsh');
});

test('prune drops tabs that are gone; parse survives bad input', () => {
  const p = { order: ['a', 'x'], pinned: ['x'], names: { a: 'A', x: 'X' } };
  assert.deepEqual(P.prune(p, ['a']), { order: ['a'], pinned: [], names: { a: 'A' } });
  assert.deepEqual(P.parse('not json'), P.empty());
  assert.deepEqual(P.parse('{"order":5,"names":{"a":3}}'), P.empty());
});

test('terminal tabs (aux:N) are not kept between runs: ids restart at aux:1 every launch', () => {
  const saved = JSON.stringify(P.forStorage({ order: ['aux:2', 'proj-a'], pinned: ['aux:1', 'proj-a'], names: { 'aux:2': 'build', 'proj-a': 'Alpha' } }));
  assert.deepEqual(JSON.parse(saved), { order: ['proj-a'], pinned: ['proj-a'], names: { 'proj-a': 'Alpha' } });
  // An old value that already holds terminal ids is cleaned on load too.
  const loaded = P.parse('{"order":["aux:1","p"],"pinned":["aux:1"],"names":{"aux:1":"build","p":"P"}}');
  assert.deepEqual(loaded, { order: ['p'], pinned: [], names: { p: 'P' } });
});

test('remote session ids are never kept between runs, like terminal tabs', () => {
  const prefs = { order: ['r:desk/p', 'aux:3', 'c:\\p'], pinned: ['r:desk/p', 'c:\\p'], names: { 'r:desk/p': 'x', 'aux:3': 'y', 'c:\\p': 'z' } };
  assert.deepEqual(P.forStorage(prefs), { order: ['c:\\p'], pinned: ['c:\\p'], names: { 'c:\\p': 'z' } });
  const loaded = P.parse(JSON.stringify(prefs));
  assert.deepEqual(loaded.order, ['c:\\p']);
  assert.deepEqual(loaded.names, { 'c:\\p': 'z' });
});
