const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const C = require('../src/remote-crypto');
const { createRemoteHost } = require('../src/remote-host');

const DEV = 'deadbeef';
const SECRET = C.newSecret();

// A minimal client that speaks the wire protocol, so the host is tested through a real loopback socket.
function connect(port, { dev = DEV, secret = SECRET } = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setEncoding('utf8');
    const queue = [];
    const waiters = [];
    const pushMsg = (m) => (waiters.length ? waiters.shift()(m) : queue.push(m));
    let channel = null;
    let hostNonce;
    const clientNonce = C.newNonce();
    let closed = false;
    let settled = false;
    const c = {
      sock,
      get closed() { return closed; },
      next: () => new Promise((res) => (queue.length ? res(queue.shift()) : waiters.push(res))),
      send: (obj) => sock.write(channel.seal(obj) + '\n'),
      request(t, args = {}) {
        c.send({ t, rid: ++c.rid, ...args });
        return c.until((m) => m.t === 'res' && m.rid === c.rid);
      },
      rid: 0,
      async until(pred) { for (;;) { const m = await c.next(); if (pred(m)) return m; } },
      close: () => sock.destroy()
    };
    const reader = C.createLineReader((line) => {
      if (!channel) {
        const m = JSON.parse(line);
        if (m.t === 'hello') {
          hostNonce = m.nonce;
          sock.write(JSON.stringify({ t: 'auth', dev, nonce: clientNonce, mac: C.mac(secret, 'c', hostNonce, clientNonce, dev) }) + '\n');
        } else if (m.t === 'ok') {
          assert.ok(C.macEqual(m.mac, C.mac(secret, 's', hostNonce, clientNonce, dev)), 'host proves the secret');
          const k = C.deriveKeys(secret, hostNonce, clientNonce);
          channel = C.createChannel(k.c2s, k.s2c);
          reader.setMax(C.MAX_LINE);
          settled = true;
          resolve(c);
        } else if (m.t === 'no') {
          settled = true;
          resolve({ rejected: true, closed: () => closed, sock });
        }
        return;
      }
      pushMsg(channel.open(line));
    }, C.MAX_PRE_AUTH_LINE);
    sock.on('data', (d) => { try { reader.feed(d); } catch (e) { sock.destroy(); } });
    sock.on('close', () => { closed = true; if (!settled) reject(new Error('socket closed before the handshake finished')); });
    sock.on('error', () => {});
    setTimeout(() => reject(new Error('handshake timeout')), 3000).unref();
  });
}

function setup(over = {}) {
  const calls = [];
  const open = new Set(['p1']);
  let devices = [{ id: DEV, secret: SECRET }];
  const host = createRemoteHost({
    getDevices: () => devices,
    onDeviceSeen: (id) => calls.push(['seen', id]),
    snapshot: () => ({ list: [{ id: 'p1', name: 'one' }], open: [...open], git: {} }),
    hasSession: (id) => open.has(id),
    openProject: (id, cols, rows) => { calls.push(['open', id, cols, rows]); open.add(id); return true; },
    write: (id, data) => calls.push(['write', id, data]),
    resize: (id, cols, rows) => calls.push(['resize', id, cols, rows]),
    restart: (id, cols, rows) => calls.push(['restart', id, cols, rows]),
    closeSession: (id) => calls.push(['close', id]),
    ...over
  });
  return { host, calls, setDevices: (d) => { devices = d; } };
}

async function started(over) {
  const s = setup(over);
  s.port = await s.host.listen('127.0.0.1', 0);
  return s;
}

test('refuses to listen on anything but a private or loopback address', async () => {
  const { host } = setup();
  for (const a of ['0.0.0.0', '8.8.8.8', '::', '']) await assert.rejects(host.listen(a, 0), /Refusing/);
});

test('handshake: a paired device gets in, receives the project list, and is recorded', async () => {
  const s = await started();
  const c = await connect(s.port);
  assert.equal(c.rejected, undefined);
  const first = await c.next();
  assert.equal(first.t, 'projects');
  assert.deepEqual(first.open, ['p1']);
  assert.deepEqual(s.calls[0], ['seen', DEV]);
  assert.equal(s.host.status().clients, 1);
  c.close();
  await s.host.close();
});

test('handshake: wrong secret and unknown device are refused alike', async () => {
  const s = await started();
  const wrong = await connect(s.port, { secret: C.newSecret() });
  assert.equal(wrong.rejected, true);
  const unknown = await connect(s.port, { dev: 'cafebabe' });
  assert.equal(unknown.rejected, true);
  assert.equal(s.host.status().clients, 0);
  await s.host.close();
});

test('five failed handshakes lock the address out; a good one is refused until the lock ends', async () => {
  let t = 1000;
  const s = await started({ now: () => t });
  for (let i = 0; i < 5; i++) assert.equal((await connect(s.port, { secret: C.newSecret() })).rejected, true);
  const locked = await connect(s.port, { secret: C.newSecret() });
  assert.equal(locked.rejected, true, 'locked out: answered with no');
  assert.equal((await connect(s.port)).rejected, true, 'a correct secret is still refused while locked');
  t += 30000;
  assert.equal((await connect(s.port, { secret: C.newSecret() })).rejected, true, 'still locked halfway');
  assert.equal(s.host.status().clients, 0);
  t += 31000; // 61s after the real failures: attempts while locked did not extend the lock
  const ok = await connect(s.port);
  assert.equal(ok.rejected, undefined);
  ok.close();
  await s.host.close();
});

test('a locked address does not take pending slots', async () => {
  let t = 1000;
  const s = await started({ now: () => t });
  for (let i = 0; i < 5; i++) assert.equal((await connect(s.port, { secret: C.newSecret() })).rejected, true);
  for (let i = 0; i < 20; i++) assert.equal((await connect(s.port)).rejected, true);
  t += 61000;
  const ok = await connect(s.port);
  assert.equal(ok.rejected, undefined);
  ok.close();
  await s.host.close();
});

test('lock expiry lets a correct client in', async () => {
  let t = 1000;
  const s = await started({ now: () => t });
  for (let i = 0; i < 5; i++) assert.equal((await connect(s.port, { secret: C.newSecret() })).rejected, true);
  t += 61000;
  const ok = await connect(s.port);
  assert.equal(ok.rejected, undefined);
  ok.close();
  await s.host.close();
});

test('requests: open, input, resize, restart and close reach the session functions', async () => {
  const s = await started();
  const c = await connect(s.port);
  await c.next(); // projects
  assert.deepEqual((await c.request('open', { id: 'p2', cols: 100, rows: 30 })).data, true);
  c.send({ t: 'input', id: 'p1', data: 'ls\r' });
  c.send({ t: 'resize', id: 'p1', cols: 90, rows: 20 });
  assert.equal((await c.request('restart', { id: 'p1', cols: 80, rows: 24 })).ok, true);
  assert.equal((await c.request('close', { id: 'p1' })).ok, true);
  assert.deepEqual(s.calls.filter((x) => x[0] !== 'seen'), [
    ['open', 'p2', 100, 30], ['write', 'p1', 'ls\r'], ['resize', 'p1', 90, 20], ['restart', 'p1', 80, 24], ['close', 'p1']
  ]);
  c.close();
  await s.host.close();
});

test('requests: bad input is ignored or answered with an error, never thrown', async () => {
  const s = await started();
  const c = await connect(s.port);
  await c.next();
  c.send({ t: 'input', id: 'p1', data: 5 });
  c.send({ t: 'input', id: 'nope', data: 'x' });
  c.send({ t: 'resize', id: 'p1', cols: 0, rows: 9999 });
  c.send({ t: 'input', id: 'p1', data: 'x'.repeat(70000) });
  const bad = await c.request('attach', { id: 'nope' });
  assert.equal(bad.ok, false);
  assert.equal((await c.request('wat')).ok, false);
  assert.deepEqual(s.calls.filter((x) => x[0] !== 'seen'), []);
  c.close();
  await s.host.close();
});

test('attach returns the replay buffer, then live output only to attached clients', async () => {
  const s = await started();
  const a = await connect(s.port);
  const b = await connect(s.port);
  await a.next(); await b.next();
  s.host.output('p1', 'hello ');
  s.host.output('p1', 'world');
  const res = await a.request('attach', { id: 'p1', cols: 100, rows: 30 });
  assert.deepEqual(res.data, { snapshot: 'hello world', progress: null, exitCode: null });
  assert.deepEqual(s.calls.filter((x) => x[0] === 'resize'), [['resize', 'p1', 100, 30]]);
  s.host.output('p1', '!');
  assert.deepEqual(await a.until((m) => m.t === 'data'), { t: 'data', id: 'p1', data: '!' });
  b.send({ t: 'detach', id: 'p1', rid: 99 }); // b never attached: still fine
  assert.equal((await b.next()).t, 'res', 'b got no data frame before the reply');
  s.host.broadcast('workers', { id: 'p1', events: [1] });
  assert.deepEqual((await b.next()).events, [1], 'b got no data frame before the broadcast');
  a.close(); b.close();
  await s.host.close();
});

test('restarted clears the replay buffer and tells everyone; exited and projectsChanged reach everyone', async () => {
  let name = 'one';
  const s = await started({ snapshot: () => ({ list: [{ id: 'p1', name }], open: ['p1'], git: {} }) });
  const a = await connect(s.port);
  await a.next();
  s.host.output('p1', 'old');
  s.host.restarted('p1');
  assert.deepEqual(await a.until((m) => m.t === 'restarted'), { t: 'restarted', id: 'p1' });
  assert.equal((await a.request('attach', { id: 'p1' })).data.snapshot, '');
  s.host.exited('p1', 3);
  assert.deepEqual(await a.until((m) => m.t === 'exit'), { t: 'exit', id: 'p1', code: 3 });
  assert.equal((await a.request('attach', { id: 'p1' })).data.exitCode, 3, 'a late viewer learns the session ended');
  name = 'renamed';
  s.host.projectsChanged();
  assert.equal((await a.until((m) => m.t === 'projects')).list[0].id, 'p1');
  s.host.projectsChanged(); // unchanged: not sent again
  s.host.broadcast('workers', { id: 'p1', events: [] });
  assert.equal((await a.next()).t, 'workers');
  a.close();
  await s.host.close();
});

test('output for a session that no longer exists is ignored (late data from a killed PTY)', async () => {
  const s = await started();
  const a = await connect(s.port);
  await a.next();
  s.host.output('gone', 'stale\x1b]9;4;3\x07');
  s.host.drop('gone');
  s.host.broadcast('workers', { id: 'x', events: [] });
  assert.equal((await a.next()).t, 'workers', 'nothing was sent for the dead session');
  a.close();
  await s.host.close();
});

test('the current progress is part of the attach reply, so a late viewer shows the right dot', async () => {
  const s = await started();
  const a = await connect(s.port);
  await a.next();
  s.host.output('p1', '\x1b]9;4;3\x07');
  assert.deepEqual((await a.request('attach', { id: 'p1' })).data.progress, { state: 3, value: 0 });
  a.close();
  await s.host.close();
});

test('a full screen of escape characters still replays (the frame limit is not hit)', async () => {
  const s = await started({ ringSize: 262144 });
  const a = await connect(s.port);
  await a.next();
  s.host.output('p1', '\x1b'.repeat(262144));
  const res = await a.request('attach', { id: 'p1' });
  assert.equal(res.ok, true);
  assert.equal(res.data.snapshot.length, 262144);
  a.close();
  await s.host.close();
});

test('only 16 connections may wait to authenticate at once', async () => {
  const s = await started();
  const socks = [];
  for (let i = 0; i < 16; i++) { const k = net.connect({ host: '127.0.0.1', port: s.port }); k.on('error', () => {}); socks.push(k); }
  const hellos = await Promise.all(socks.map((k) => new Promise((res) => k.once('data', (d) => res(String(d).includes('"hello"'))))));
  assert.ok(hellos.every(Boolean), 'the first 16 received hello');
  assert.ok(socks.every((k) => !k.destroyed), 'and stayed open');
  const extra = net.connect({ host: '127.0.0.1', port: s.port });
  extra.on('error', () => {});
  const closed = await new Promise((resolve) => { extra.on('close', () => resolve(true)); setTimeout(() => resolve(false), 1000); });
  assert.equal(closed, true, 'the 17th is dropped');
  for (const k of socks) k.destroy();
  extra.destroy();
  await new Promise((r) => setTimeout(r, 100));
  const again = await connect(s.port);
  assert.equal(again.rejected, undefined, 'pending slots were freed');
  again.close();
  await s.host.close();
});

test('progress in the output is reported as a session event even to clients that are not attached', async () => {
  const s = await started();
  const a = await connect(s.port);
  await a.next();
  s.host.output('p1', 'x\x1b]9;4;3\x07');
  s.host.output('p1', '\x1b]9;4;0\x07');
  assert.deepEqual((await a.until((m) => m.t === 'sevent')).ev, { t: 'progress', state: 3, value: 0 });
  assert.deepEqual((await a.until((m) => m.t === 'sevent')).ev, { t: 'progress', state: 0, value: 0 });
  a.close();
  await s.host.close();
});

test('revoking a device closes its live connection', async () => {
  const s = await started();
  const a = await connect(s.port);
  await a.next();
  s.setDevices([]);
  s.host.disconnectDevice(DEV);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(a.closed, true);
  assert.equal((await connect(s.port)).rejected, true);
  await s.host.close();
});

test('a client that stops reading is dropped instead of buffered without limit', async () => {
  const s = await started({ maxQueued: 1 << 20 });
  const a = await connect(s.port);
  await a.next();
  await a.request('attach', { id: 'p1' });
  a.sock.pause();
  const chunk = 'x'.repeat(1 << 20);
  for (let i = 0; i < 200 && s.host.status().clients; i++) s.host.output('p1', chunk);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.host.status().clients, 0, 'slow client dropped');
  await s.host.close();
});

test('a connection gets one handshake attempt: later auth lines in the same write are ignored', async () => {
  const s = await started();
  const sock = net.connect({ host: '127.0.0.1', port: s.port });
  sock.setEncoding('utf8');
  sock.on('error', () => {});
  const hello = await new Promise((res) => sock.once('data', (d) => res(JSON.parse(d.split('\n')[0]))));
  const bad = JSON.stringify({ t: 'auth', dev: DEV, nonce: C.newNonce(), mac: 'x'.repeat(64) }) + '\n';
  const cn = C.newNonce();
  const good = JSON.stringify({ t: 'auth', dev: DEV, nonce: cn, mac: C.mac(SECRET, 'c', hello.nonce, cn, DEV) }) + '\n';
  sock.write(bad.repeat(6) + good);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.host.status().clients, 0);
  assert.deepEqual(s.calls, [], 'device never seen');
  sock.destroy();
  await s.host.close();
});

test('close() drops connections that are still handshaking; they cannot authenticate afterwards', async () => {
  const s = await started();
  const sock = net.connect({ host: '127.0.0.1', port: s.port });
  sock.setEncoding('utf8');
  sock.on('error', () => {});
  let closed = false;
  sock.on('close', () => { closed = true; });
  const hello = await new Promise((res) => sock.once('data', (d) => res(JSON.parse(d.split('\n')[0]))));
  const t0 = Date.now();
  await s.host.close();
  assert.ok(Date.now() - t0 < 500, 'close() did not hang');
  const cn = C.newNonce();
  sock.write(JSON.stringify({ t: 'auth', dev: DEV, nonce: cn, mac: C.mac(SECRET, 'c', hello.nonce, cn, DEV) }) + '\n');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(closed, true);
  assert.equal(s.host.status().clients, 0);
  assert.deepEqual(s.calls, []);
});

test('errors from the session functions never reach the client with host paths in them', async () => {
  const s = await started({ openProject: () => { throw new Error('ENOENT C:\\Users\\jacob\\secret'); } });
  const c = await connect(s.port);
  await c.next();
  const res = await c.request('open', { id: 'p2' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'The request failed');
  assert.equal((await c.request('open', { id: '' })).ok, false);
  assert.equal((await c.request('open', { id: 5 })).error, 'Invalid session id');
  c.close();
  await s.host.close();
});

test('restarted forgets a half-finished escape sequence from the previous process', async () => {
  const s = await started();
  const a = await connect(s.port);
  await a.next();
  s.host.output('p1', '\x1b]9;4;');
  s.host.restarted('p1');
  await a.until((m) => m.t === 'restarted');
  s.host.output('p1', '3\x07');
  s.host.broadcast('workers', { id: 'p1', events: [] });
  assert.equal((await a.next()).t, 'workers', 'no progress event from the stitched fragments');
  a.close();
  await s.host.close();
});

test('projectsChanged: a client that connected while the list was Y still hears when it returns to X', async () => {
  let name = 'X';
  const s = await started({ snapshot: () => ({ list: [{ id: 'p1', name }], open: ['p1'], git: {} }) });
  const a = await connect(s.port);
  assert.equal((await a.next()).list[0].name, 'X');
  s.host.projectsChanged(); // lastProjects = X
  a.close();
  while (s.host.status().clients) await new Promise((r) => setTimeout(r, 10));
  name = 'Y';
  const b = await connect(s.port);
  assert.equal((await b.next()).list[0].name, 'Y');
  name = 'X';
  s.host.projectsChanged();
  assert.equal((await b.until((m) => m.t === 'projects')).list[0].name, 'X');
  b.close();
  await s.host.close();
});
