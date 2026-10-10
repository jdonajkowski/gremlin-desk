const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/remote-crypto');
const { createRemoteHost } = require('../src/remote-host');
const { createRemoteClient } = require('../src/remote-client');

const DEV = 'deadbeef';
const SECRET = C.newSecret();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return; await sleep(10); }
  throw new Error('timed out waiting for condition');
}

async function startHost(over = {}) {
  const open = new Set(['p1']);
  const calls = [];
  let devices = [{ id: DEV, secret: SECRET }];
  const host = createRemoteHost({
    getDevices: () => devices,
    snapshot: () => ({ list: [{ id: 'p1', name: 'one' }], open: [...open], git: {} }),
    hasSession: (id) => open.has(id),
    openProject: (id) => { open.add(id); return true; },
    write: (id, d) => calls.push(['write', id, d]),
    resize: () => {}, restart: () => {}, closeSession: () => {},
    ...over
  });
  const port = await host.listen('127.0.0.1', 0);
  return { host, port, calls, setDevices: (d) => { devices = d; } };
}

function makeClient(port, over = {}) {
  const events = [];
  const states = [];
  const client = createRemoteClient({
    host: { address: '127.0.0.1', port, device: DEV, secret: SECRET },
    onState: (s) => states.push(s.state),
    onEvent: (e) => events.push(e),
    delays: [20, 20, 20],
    ...over
  });
  return { client, events, states };
}

test('connects, receives the project list, and requests work', async () => {
  const h = await startHost();
  const { client, events, states } = makeClient(h.port);
  client.connect();
  await until(() => client.state().state === 'online');
  assert.deepEqual(states, ['connecting', 'online']);
  await until(() => events.some((e) => e.t === 'projects'));
  assert.deepEqual(await client.request('open', { id: 'p2' }), true);
  await assert.rejects(client.request('attach', { id: 'missing' }), /not running/);
  client.stop();
  await h.host.close();
});

test('attach delivers the replay as a snapshot event, then live data', async () => {
  const h = await startHost();
  h.host.output('p1', 'before ');
  const { client, events } = makeClient(h.port);
  client.connect();
  await until(() => client.state().state === 'online');
  await client.attach('p1', 100, 30);
  assert.deepEqual(events.find((e) => e.t === 'snapshot'), { t: 'snapshot', id: 'p1', data: 'before ', progress: null, exitCode: null });
  assert.equal(client.isAttached('p1'), true);
  h.host.output('p1', 'after');
  await until(() => events.some((e) => e.t === 'data' && e.data === 'after'));
  client.notify('input', { id: 'p1', data: 'hi' });
  await until(() => h.calls.some((c) => c[0] === 'write'));
  client.stop();
  await h.host.close();
});

test('an unreachable host leaves the client offline with a plain reason, and it keeps trying', async () => {
  const net = require('net');
  const probe = net.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const { client, states } = makeClient(port);
  client.connect();
  await until(() => states.filter((s) => s === 'connecting').length >= 2);
  await until(() => client.state().state === 'offline');
  const s = client.state();
  assert.equal(s.state, 'offline');
  assert.match(s.error, /could not connect/i);
  client.stop();
});

test('reconnects after the host restarts and re-attaches with a resync first', async () => {
  const h = await startHost();
  const { client, events } = makeClient(h.port);
  client.connect();
  await until(() => client.state().state === 'online');
  await client.attach('p1', 80, 24);
  events.length = 0;
  await h.host.close();
  await until(() => client.state().state !== 'online');
  assert.ok(events.some((e) => e.t === 'lost' && e.id === 'p1'));
  // Same port again: a fresh host process.
  const again = createRemoteHost({
    getDevices: () => [{ id: DEV, secret: SECRET }],
    snapshot: () => ({ list: [], open: ['p1'], git: {} }),
    hasSession: () => true, openProject: () => true, write() {}, resize() {}, restart() {}, closeSession() {}
  });
  try {
    await again.listen('127.0.0.1', h.port);
  } catch (err) {
    if (err && err.code !== 'EADDRINUSE') throw err;
    await sleep(50);
    await again.listen('127.0.0.1', h.port);
  }
  again.output('p1', 'screen');
  await until(() => client.state().state === 'online', 4000);
  await until(() => events.some((e) => e.t === 'snapshot'), 2000);
  const order = events.map((e) => e.t).filter((t) => t === 'resync' || t === 'snapshot');
  assert.deepEqual(order, ['resync', 'snapshot']);
  assert.equal(events.find((e) => e.t === 'snapshot').data, 'screen');
  client.stop();
  await again.close();
});

test('a refused pairing stops retrying until reconnect() is called', async () => {
  const h = await startHost();
  h.setDevices([]);
  const { client, states } = makeClient(h.port);
  client.connect();
  await until(() => client.state().state === 'error');
  assert.match(client.state().error, /rejected|revoked/i);
  const count = states.length;
  await sleep(150);
  assert.equal(states.length, count, 'no retries while refused');
  h.setDevices([{ id: DEV, secret: SECRET }]);
  client.reconnect();
  await until(() => client.state().state === 'online');
  client.stop();
  await h.host.close();
});

test('a locked-out address is told the pairing was rejected, not "could not connect", and is not retried', async () => {
  let t = 1000;
  const h = await startHost({ now: () => t });
  for (let i = 0; i < 5; i++) {
    const bad = makeClient(h.port, { host: { address: '127.0.0.1', port: h.port, device: DEV, secret: C.newSecret() } });
    bad.client.connect();
    await until(() => bad.client.state().state === 'error');
    bad.client.stop();
  }
  const { client, states } = makeClient(h.port); // the CORRECT secret
  client.connect();
  await until(() => client.state().state === 'error');
  assert.match(client.state().error, /rejected this pairing/);
  assert.doesNotMatch(client.state().error, /Could not connect/);
  const count = states.length;
  await sleep(150);
  assert.equal(states.length, count, 'no retries while locked out');
  t += 61000;
  client.reconnect();
  await until(() => client.state().state === 'online');
  client.stop();
  await h.host.close();
});

test('a host that cannot prove it holds the secret is not trusted',async () => {
  const net = require('net');
  const fake = net.createServer((sock) => {
    sock.setEncoding('utf8');
    sock.write(JSON.stringify({ t: 'hello', v: C.VERSION, nonce: C.newNonce() }) + '\n');
    sock.on('data', () => sock.write(JSON.stringify({ t: 'ok', mac: C.newSecret() }) + '\n'));
    sock.on('error', () => {});
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const { client } = makeClient(fake.address().port);
  client.connect();
  await until(() => client.state().state === 'error');
  assert.match(client.state().error, /prove|trust/i);
  client.stop();
  await new Promise((r) => fake.close(r));
});

test('requests fail fast when offline, and stop() ends everything', async () => {
  const { client } = makeClient(1);
  await assert.rejects(client.request('projects'), /Not connected/);
  client.notify('input', { id: 'x', data: 'y' }); // dropped, no throw
  client.stop();
  client.connect();
  assert.equal(client.state().state, 'offline');
});

test('a closed event from the host forgets the attachment so the session can be reopened', async () => {
  const h = await startHost();
  const { client, events } = makeClient(h.port);
  client.connect();
  await until(() => client.state().state === 'online');
  await client.attach('p1', 100, 30);
  assert.equal(client.isAttached('p1'), true);
  h.host.broadcast('closed', { id: 'p1' });
  await until(() => events.some((e) => e.t === 'closed'));
  assert.equal(client.isAttached('p1'), false);
  client.stop();
  await h.host.close();
});
