const test = require('node:test');
const assert = require('node:assert/strict');
const { reduce, DONE_TTL_MS } = require('../src/workers');

const start = (id, kind, ts, label = id) => ({ t: 'start', id, kind, label, ts });

test('start creates a running worker', () => {
  const w = reduce([start('a1', 'agent', 1000, 'Explore')], 2000);
  assert.deepEqual(w, [{ id: 'a1', kind: 'agent', label: 'Explore', startedAt: 1000, doneAt: null, sid: undefined }]);
});

test('stop marks the worker done', () => {
  const w = reduce([start('a1', 'agent', 1000), { t: 'stop', id: 'a1', ts: 3000 }], 3500);
  assert.equal(w[0].doneAt, 3000);
});

test('done workers drop out after DONE_TTL_MS', () => {
  const ev = [start('a1', 'agent', 1000), { t: 'stop', id: 'a1', ts: 3000 }];
  assert.equal(reduce(ev, 3000 + DONE_TTL_MS).length, 1);
  assert.equal(reduce(ev, 3000 + DONE_TTL_MS + 1).length, 0);
});

test('snapshot finishes shells it no longer lists', () => {
  const ev = [start('s1', 'shell', 1000), start('s2', 'shell', 1100), { t: 'snapshot', ids: ['s2'], ts: 5000 }];
  const w = reduce(ev, 5000);
  assert.equal(w.find((x) => x.id === 's1').doneAt, 5000);
  assert.equal(w.find((x) => x.id === 's2').doneAt, null);
});

test('snapshot finishes agents it no longer lists (lost SubagentStop guard)', () => {
  const ev = [start('a1', 'agent', 1000), start('a2', 'agent', 1100), { t: 'snapshot', ids: ['a2'], ts: 5000 }];
  const w = reduce(ev, 5000);
  assert.equal(w.find((x) => x.id === 'a1').doneAt, 5000);
  assert.equal(w.find((x) => x.id === 'a2').doneAt, null);
});

test('snapshot older than a shell start does not finish it', () => {
  const ev = [{ t: 'snapshot', ids: [], ts: 900 }, start('s1', 'shell', 1000)];
  assert.equal(reduce(ev, 1200)[0].doneAt, null);
});

test('snapshot taken before start but logged after it does not finish it', () => {
  const ev = [start('s1', 'shell', 1000), { t: 'snapshot', ids: [], ts: 900 }];
  assert.equal(reduce(ev, 1200)[0].doneAt, null);
});

test('snapshot does not finish already-done workers again', () => {
  const ev = [start('s1', 'shell', 1000), { t: 'snapshot', ids: [], ts: 2000 }, { t: 'snapshot', ids: [], ts: 4000 }];
  assert.equal(reduce(ev, 4000)[0].doneAt, 2000);
});

test('duplicate start is ignored', () => {
  const ev = [start('a1', 'agent', 1000, 'first'), start('a1', 'agent', 2000, 'second')];
  const w = reduce(ev, 2500);
  assert.equal(w.length, 1);
  assert.equal(w[0].label, 'first');
});

test('stop for an unknown id is ignored', () => {
  assert.deepEqual(reduce([{ t: 'stop', id: 'nope', ts: 1 }], 2), []);
});

test('malformed events are skipped', () => {
  const ev = [null, 42, { t: 'start' }, { t: 'snapshot', ids: 'x', ts: 1 }, start('a1', 'agent', 1000)];
  assert.equal(reduce(ev, 1500).length, 1);
});

test('workers are ordered by start time', () => {
  const ev = [start('b', 'shell', 2000), start('a', 'agent', 1000)];
  assert.deepEqual(reduce(ev, 3000).map((w) => w.id), ['a', 'b']);
});

test('snapshot from another session does not finish workers', () => {
  const ev = [{ ...start('s1', 'shell', 1000), sid: 'outer' }, { t: 'snapshot', ids: [], ts: 2000, sid: 'nested', src: 'Stop' }];
  assert.equal(reduce(ev, 2000)[0].doneAt, null);
});

test('snapshot from the same session still finishes workers', () => {
  const ev = [{ ...start('s1', 'shell', 1000), sid: 'outer' }, { t: 'snapshot', ids: [], ts: 2000, sid: 'outer', src: 'Stop' }];
  assert.equal(reduce(ev, 2000)[0].doneAt, 2000);
});

test('SubagentStop snapshot finishes shells but not agents', () => {
  const ev = [start('s1', 'shell', 1000), start('a1', 'agent', 1000), { t: 'snapshot', ids: [], ts: 2000, src: 'SubagentStop' }];
  const w = reduce(ev, 2000);
  assert.equal(w.find((x) => x.id === 's1').doneAt, 2000);
  assert.equal(w.find((x) => x.id === 'a1').doneAt, null);
});

test('tasks counts TaskCreate/TaskUpdate events of the newest session', () => {
  const { tasks, TASKS_DONE_TTL_MS } = require('../src/workers');
  const ev = [
    { t: 'task', id: '1', subject: 'old', status: 'pending', ts: 1, sid: 'a' },
    { t: 'task', id: '1', subject: 'alpha', status: 'pending', ts: 2, sid: 'b' },
    { t: 'task', id: '2', subject: 'beta', status: 'pending', ts: 3, sid: 'b' },
    { t: 'task', id: '3', subject: 'gamma', status: 'pending', ts: 4, sid: 'b' },
    { t: 'task', id: '1', status: 'completed', ts: 5, sid: 'b' },
    { t: 'task', id: '2', status: 'in_progress', ts: 6, sid: 'b' },
    { t: 'task', id: '3', status: 'deleted', ts: 7, sid: 'b' }
  ];
  const r = tasks(ev, 10);
  assert.deepEqual([r.done, r.total, r.current], [1, 2, 'beta']);
  const finished = ev.concat({ t: 'task', id: '2', status: 'completed', ts: 8, sid: 'b' });
  assert.equal(tasks(finished, 9).done, 2);
  assert.equal(tasks(finished, 8 + TASKS_DONE_TTL_MS + 1), null);
  assert.equal(tasks([{ t: 'start', id: 'x', kind: 'agent', ts: 1 }], 2), null);
});

test('tasks takes a TodoWrite list as a whole', () => {
  const { tasks } = require('../src/workers');
  const r = tasks([{ t: 'todos', items: [{ subject: 'a', status: 'completed' }, { subject: 'Doing b', status: 'in_progress' }, { subject: 'c', status: 'pending' }], ts: 1 }], 2);
  assert.deepEqual([r.done, r.total, r.current], [1, 3, 'Doing b']);
});

const snap = (ts, tasks, src = 'Stop', sid) => ({ t: 'snapshot', ids: tasks.map((x) => x.id), tasks, ts, src, sid });

test('a task only Claude lists gets a row, and ends when it is gone or marked ended', () => {
  let w = reduce([snap(2000, [{ id: 'm1', kind: 'monitor', status: 'running', label: 'watch the build' }])], 2000);
  assert.deepEqual(w.map((x) => [x.id, x.kind, x.label, x.doneAt]), [['m1', 'monitor', 'watch the build', null]]);
  w = reduce([snap(2000, [{ id: 'm1', kind: 'monitor', status: 'running', label: 'x' }]), snap(3000, [])], 3000);
  assert.equal(w[0].doneAt, 3000);
  w = reduce([snap(2000, [{ id: 'm1', kind: 'monitor', status: 'running', label: 'x' }]), snap(3000, [{ id: 'm1', kind: 'monitor', status: 'completed', label: 'x' }])], 3000);
  assert.equal(w[0].doneAt, 3000);
});

test('a listed task that is already over gets no row; a known one listed as ended finishes', () => {
  assert.deepEqual(reduce([snap(2000, [{ id: 'x', kind: 'shell', status: 'completed', label: 'x' }])], 2000), []);
  const w = reduce([start('a1', 'agent', 1000), snap(2000, [{ id: 'a1', kind: 'agent', status: 'completed', label: 'a' }], 'SubagentStop')], 2000);
  assert.equal(w[0].doneAt, 2000);
});

test('a known worker is not duplicated by the list, and keeps its own label', () => {
  const w = reduce([start('s1', 'shell', 1000, 'npm run dev'), snap(2000, [{ id: 's1', kind: 'shell', status: 'running', label: 'other' }])], 2000);
  assert.deepEqual(w.map((x) => [x.id, x.label, x.doneAt]), [['s1', 'npm run dev', null]]);
});

test("another session's listed rows end when the newest session finishes a turn", () => {
  const ev = [
    snap(2000, [{ id: 'c1', kind: 'shell', status: 'running', label: 'child' }], 'Stop', 'child'),
    snap(3000, [], 'Stop', 'main')
  ];
  assert.equal(reduce(ev, 3000)[0].doneAt, 3000);
  assert.equal(reduce(ev.slice(0, 1), 2500)[0].doneAt, null);
});

test('stopAll: stops running workers only, across sessions', () => {
  const { stopAll } = require('../src/workers');
  const ev = [
    { ...start('a', 'agent', 1000), sid: 's1' },
    { ...start('b', 'shell', 1100), sid: 's2' },
    start('c', 'shell', 1200),
    { t: 'stop', id: 'c', ts: 1500 }
  ];
  assert.deepEqual(stopAll(ev, 2000), [{ t: 'stop', id: 'a', ts: 2000 }, { t: 'stop', id: 'b', ts: 2000 }]);
});

test('stopAll: non-immediate keeps rows for the TTL, immediate hides at once, and a later duplicate start stays hidden', () => {
  const { stopAll } = require('../src/workers');
  const ev = [start('a', 'agent', 1000), start('b', 'shell', 1100)];
  const soft = ev.concat(stopAll(ev, 2000));
  assert.equal(reduce(soft, 2000).length, 2);
  assert.ok(reduce(soft, 2000).every((w) => w.doneAt === 2000));
  assert.equal(reduce(soft, 2000 + DONE_TTL_MS).length, 2);
  assert.equal(reduce(soft, 2000 + DONE_TTL_MS + 1).length, 0);
  const hard = ev.concat(stopAll(ev, 2000, { immediate: true }));
  assert.equal(reduce(hard, 2000).length, 0);
  assert.equal(reduce(hard.concat(start('a', 'agent', 3000)), 3000).length, 0);
});

test('stopAll: nothing running or garbage gives []', () => {
  const { stopAll } = require('../src/workers');
  assert.deepEqual(stopAll([], 1), []);
  assert.deepEqual(stopAll([start('a', 'agent', 1), { t: 'stop', id: 'a', ts: 2 }], 3), []);
  for (const bad of [null, undefined, 'x', 5, {}, [null, 1, {}]]) assert.deepEqual(stopAll(bad, 1), []);
});
