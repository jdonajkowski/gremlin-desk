const test = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteClients } = require('../src/remote-clients');

function fakeFactory() {
  const made = {};
  const createClient = ({ host, onState, onEvent }) => {
    const c = {
      host, onState, onEvent, started: false, stopped: false, sent: [], reqs: [],
      connect() { c.started = true; },
      stop() { c.stopped = true; },
      reconnect() { c.reconnected = true; },
      state: () => c.st || { state: 'offline', error: '' },
      notify: (t, a) => c.sent.push([t, a]),
      request: async (t, a) => { c.reqs.push([t, a]); return c.reply === undefined ? true : c.reply; },
      attach: async (id, cols, rows) => { c.reqs.push(['attach', { id, cols, rows }]); (c.att = c.att || new Set()).add(id); },
      isAttached: (id) => !!(c.att && c.att.has(id)),
      detach: (id) => c.sent.push(['detach', { id }]),
      resize: (id, cols, rows) => c.sent.push(['resize', { id, cols, rows }])
    };
    made[host.id] = c;
    return c;
  };
  return { made, createClient };
}

const HOSTS = [{ id: 'desk', name: 'Desk PC', address: 'a', port: 1, device: 'cafebabe', secret: 's' }];

function setup(hosts = HOSTS) {
  const { made, createClient } = fakeFactory();
  const out = [];
  let changes = 0;
  let list = hosts;
  const m = createRemoteClients({ getHosts: () => list, createClient, send: (ch, p) => out.push([ch, p]), onChange: () => { changes++; } });
  m.sync();
  return { m, made, out, changes: () => changes, setHosts: (h) => { list = h; } };
}

const online = (c) => { c.st = { state: 'online', error: '' }; c.onState(c.st); };

test('sync starts a client per host and stops removed ones', () => {
  const t = setup();
  assert.equal(t.made.desk.started, true);
  t.setHosts([]);
  t.m.sync();
  assert.equal(t.made.desk.stopped, true);
  assert.deepEqual(t.m.hosts(), []);
});

test('projects are listed with namespaced ids; a host that is not connected keeps its rows, flagged offline', () => {
  const t = setup();
  const c = t.made.desk;
  c.onEvent({ t: 'projects', list: [{ id: 'c:\\p\\a', name: 'a', folder: 'a', initials: 'A' }], open: ['c:\\p\\a'], git: { 'c:\\p\\a': { branch: 'main' } } });
  assert.deepEqual(t.m.list().map((p) => [p.id, p.remote.offline]), [['r:desk/c:\\p\\a', true]], 'not connected yet: shown dimmed');
  assert.deepEqual(t.m.openIds(), [], 'but not counted as running');
  online(c);
  assert.deepEqual(t.m.list().map((p) => [p.id, p.remote.offline]), [['r:desk/c:\\p\\a', undefined]]);
  assert.deepEqual(t.m.openIds(), ['r:desk/c:\\p\\a']);
  assert.deepEqual(Object.keys(t.m.git()), ['r:desk/c:\\p\\a']);
  assert.ok(t.m.isOpen('r:desk/c:\\p\\a'));
  assert.ok(!t.m.isOpen('r:desk/other'));
  assert.deepEqual(t.m.hosts(), [{ id: 'desk', name: 'Desk PC', address: 'a', port: 1, state: 'online', error: '' }]);
  assert.ok(t.changes() >= 2);
});

test('has: only namespaced ids of known hosts', () => {
  const t = setup();
  assert.ok(t.m.has('r:desk/x'));
  assert.ok(!t.m.has('r:gone/x'));
  assert.ok(!t.m.has('aux:1'));
  assert.ok(!t.m.has('c:\\local'));
});

test('events become renderer messages with namespaced ids', () => {
  const t = setup();
  const e = t.made.desk.onEvent;
  e({ t: 'data', id: 'p', data: 'hi' });
  e({ t: 'exit', id: 'p', code: 2 });
  e({ t: 'workers', id: 'p', events: [1] });
  e({ t: 'status', id: 'p', status: { a: 1 } });
  e({ t: 'sevent', id: 'p', ev: { t: 'progress', state: 3, value: 0 } });
  e({ t: 'snapshot', id: 'p', data: 'screen', progress: null, exitCode: null });
  e({ t: 'resync', id: 'p' });
  e({ t: 'restarted', id: 'p' });
  e({ t: 'closed', id: 'p' });
  e({ t: 'snapshot', id: 'p', data: 'ended', progress: { state: 0, value: 0 }, exitCode: 1 });
  e({ t: 'lost', id: 'p' });
  e({ t: 'unknown', id: 'p' });
  const id = 'r:desk/p';
  assert.deepEqual(t.out, [
    ['pty:data', { id, data: 'hi' }],
    ['pty:exit', { id, code: 2 }],
    ['workers:events', { id, events: [1] }],
    ['status:update', { id, status: { a: 1 } }],
    ['remote:sevent', { id, ev: { t: 'progress', state: 3, value: 0 } }],
    ['remote:replay', { id, data: 'screen', progress: null }],
    ['remote:reset', { id }],
    ['remote:reset', { id }],
    ['session:closed', { id }],
    ['remote:replay', { id, data: 'ended', progress: { state: 0, value: 0 } }],
    ['pty:exit', { id, code: 1 }],
    ['pty:data', { id, data: '\r\n\x1b[90m[connection lost, reconnecting…]\x1b[0m\r\n' }]
  ]);
});

test('open asks the host to start the session, then attaches; a refusal or error is false', async () => {
  const t = setup();
  const c = t.made.desk;
  online(c);
  assert.equal(await t.m.open('r:desk/c:\\p\\a', 100, 30), true);
  assert.deepEqual(c.reqs, [['open', { id: 'c:\\p\\a', cols: 100, rows: 30 }], ['attach', { id: 'c:\\p\\a', cols: 100, rows: 30 }]]);
  c.reqs.length = 0;
  assert.equal(await t.m.open('r:desk/c:\\p\\a', 100, 30), true);
  assert.deepEqual(c.reqs, [], 'already attached: no second replay on top of the screen');
  c.reply = false;
  assert.equal(await t.m.open('r:desk/x', 100, 30), false);
  assert.deepEqual(c.reqs, [['open', { id: 'x', cols: 100, rows: 30 }]], 'no attach after a refusal');
  c.request = async () => { throw new Error('Not connected'); };
  assert.equal(await t.m.open('r:desk/x', 1, 1), false);
  assert.equal(await t.m.open('r:nobody/x', 1, 1), false);
});

test('write, resize and restart go to the host with the host-side project id', () => {
  const t = setup();
  const c = t.made.desk;
  t.m.write('r:desk/c:\\p\\a', 'ls');
  t.m.resize('r:desk/c:\\p\\a', 90, 20);
  t.m.restart('r:desk/c:\\p\\a', 80, 24);
  assert.deepEqual(c.sent, [
    ['input', { id: 'c:\\p\\a', data: 'ls' }],
    ['resize', { id: 'c:\\p\\a', cols: 90, rows: 20 }],
    ['restart', { id: 'c:\\p\\a', cols: 80, rows: 24 }]
  ]);
});

test('close tells the host and detaches; reconnect and stopAll reach the clients', async () => {
  const t = setup();
  const c = t.made.desk;
  online(c);
  await t.m.close('r:desk/p');
  assert.deepEqual(c.reqs, [['close', { id: 'p' }]]);
  assert.deepEqual(c.sent, [['detach', { id: 'p' }]]);
  t.m.reconnect('desk');
  assert.equal(c.reconnected, true);
  t.m.stopAll();
  assert.equal(c.stopped, true);
});
