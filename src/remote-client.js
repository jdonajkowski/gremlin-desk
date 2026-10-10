// The client side of one remote host: connects, authenticates, sends requests and turns the host's frames into events.
// Reconnects by itself; a host that refuses the pairing stops it until reconnect() so a wrong code cannot lock the host.
const net = require('net');
const C = require('./remote-crypto');

const CONNECT_TIMEOUT_MS = 10000;

function describeError(err) {
  const code = err && err.code;
  if (code === 'ECONNREFUSED') return 'Could not connect. Is Gremlin running there with remote control on?';
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return 'Could not reach that address. Check it and that both computers are on the same network.';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'Could not find that computer by name. Try its IP address.';
  return 'Could not connect.';
}

function createRemoteClient({ host, onState = () => {}, onEvent = () => {}, netImpl = net, timers = { set: setTimeout, clear: clearTimeout },
  delays = [2000, 5000, 10000, 30000], requestTimeoutMs = 15000 }) {
  let sock = null;
  let channel = null;
  let status = { state: 'offline', error: '' };
  let stopped = false;
  let refused = false;
  let attempt = 0;
  let retry = null;
  let lastError = '';
  let nextRid = 1;
  const pending = new Map();
  const attached = new Map(); // session id -> { cols, rows }, re-attached after a reconnect

  function setState(state, error = '') {
    status = { state, error };
    onState(status);
  }

  function write(obj) {
    if (channel && sock && !sock.destroyed) sock.write(channel.seal(obj) + '\n');
  }

  function request(t, args = {}, onResult) {
    return new Promise((resolve, reject) => {
      if (status.state !== 'online' || !channel) return reject(new Error('Not connected'));
      const rid = nextRid++;
      const timer = timers.set(() => { pending.delete(rid); reject(new Error('The other computer did not answer')); }, requestTimeoutMs);
      pending.set(rid, { resolve, reject, timer, onResult });
      write({ t, rid, ...args });
    });
  }
  const notify = (t, args = {}) => { if (status.state === 'online') write({ t, ...args }); };

  function settle(msg) {
    const p = pending.get(msg.rid);
    if (!p) return;
    pending.delete(msg.rid);
    timers.clear(p.timer);
    if (msg.ok) {
      if (p.onResult) p.onResult(msg.data); // before the next frame in this chunk is handled, so a replay precedes live data
      p.resolve(msg.data);
    } else {
      const err = new Error(msg.error || 'Failed');
      err.fromHost = true;
      p.reject(err);
    }
  }

  function failAll(message) {
    for (const [rid, p] of pending) { timers.clear(p.timer); p.reject(new Error(message)); pending.delete(rid); }
  }

  // After a reconnect the host has forgotten who was attached: tell the renderer to reset each terminal, then replay.
  const emitSnapshot = (id, r) => onEvent({ t: 'snapshot', id, data: r.snapshot, progress: r.progress || null, exitCode: r.exitCode == null ? null : r.exitCode });

  function reattach() {
    for (const [id, dims] of attached) {
      onEvent({ t: 'resync', id });
      request('attach', { id, ...dims }, (r) => emitSnapshot(id, r)).catch((err) => {
        // Only the host saying the session is gone ends it; a connection that dropped again is retried on the next reconnect.
        if (err.fromHost) { attached.delete(id); onEvent({ t: 'closed', id }); }
      });
    }
  }

  function connect() {
    if (stopped || sock) return;
    if (retry) { timers.clear(retry); retry = null; }
    refused = false;
    lastError = '';
    setState('connecting');
    const s = netImpl.connect({ host: host.address, port: host.port });
    sock = s;
    channel = null;
    s.setEncoding('utf8');
    s.setNoDelay(true);
    s.setKeepAlive(true, 15000);
    s.setTimeout(CONNECT_TIMEOUT_MS, () => s.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    const clientNonce = C.newNonce();
    let hostNonce = null;
    let stage = 'hello';
    const reader = C.createLineReader(onLine, C.MAX_PRE_AUTH_LINE);

    function refuse(message) {
      refused = true;
      lastError = message;
      s.destroy();
    }

    function onLine(line) {
      if (stage === 'online') {
        let msg;
        try { msg = channel.open(line); } catch { lastError = 'The connection was corrupted.'; return s.destroy(); }
        if (msg.t === 'closed') attached.delete(msg.id); // the session is gone: a later attach must ask the host again
        return msg.t === 'res' ? settle(msg) : onEvent(msg);
      }
      let m;
      try { m = JSON.parse(line); } catch { return refuse('The other computer is not running Gremlin remote control.'); }
      // A locked-out address is answered with "no" before any hello.
      if (m && m.t === 'no') return refuse('The other computer rejected this pairing (wrong code, revoked, or too many attempts). Pair again, or wait a minute.');
      if (stage === 'hello') {
        if (!m || m.t !== 'hello' || m.v !== C.VERSION || !/^[0-9a-f]{32}$/.test(String(m.nonce))) return refuse('The other computer runs an incompatible version of Gremlin.');
        hostNonce = m.nonce;
        stage = 'auth';
        s.write(JSON.stringify({ t: 'auth', dev: host.device, nonce: clientNonce, mac: C.mac(host.secret, 'c', hostNonce, clientNonce, host.device) }) + '\n');
        return;
      }
      if (!m || m.t !== 'ok' || !C.macEqual(m.mac, C.mac(host.secret, 's', hostNonce, clientNonce, host.device))) return refuse('That computer could not prove it holds the pairing code, so it was not trusted.');
      const keys = C.deriveKeys(host.secret, hostNonce, clientNonce);
      channel = C.createChannel(keys.c2s, keys.s2c);
      stage = 'online';
      reader.setMax(C.MAX_LINE);
      s.setTimeout(0);
      attempt = 0;
      setState('online');
      reattach();
    }

    s.on('data', (chunk) => { try { reader.feed(chunk); } catch { lastError = 'The connection was corrupted.'; s.destroy(); } });
    s.on('error', (err) => { if (!lastError) lastError = describeError(err); });
    s.on('close', () => {
      const wasOnline = stage === 'online';
      sock = null;
      channel = null;
      failAll('Connection lost');
      if (wasOnline) for (const id of attached.keys()) onEvent({ t: 'lost', id });
      if (stopped) return setState('offline');
      if (refused) return setState('error', lastError);
      setState('offline', wasOnline ? 'Connection lost. Reconnecting…' : lastError || 'Could not connect.');
      retry = timers.set(() => { retry = null; connect(); }, delays[Math.min(attempt++, delays.length - 1)]);
    });
  }

  return {
    connect,
    stop() {
      stopped = true;
      if (retry) { timers.clear(retry); retry = null; }
      if (sock) sock.destroy();
      else setState('offline');
    },
    // Manual retry (also leaves the refused state).
    reconnect() {
      if (stopped) return;
      attempt = 0;
      if (status.state === 'online' || status.state === 'connecting') return;
      connect();
    },
    request,
    notify,
    async attach(id, cols, rows) {
      await request('attach', { id, cols, rows }, (r) => { attached.set(id, { cols, rows }); emitSnapshot(id, r); });
    },
    isAttached: (id) => attached.has(id),
    detach(id) { attached.delete(id); notify('detach', { id }); },
    // The host ended the session: nothing to re-attach to or detach from, so just drop the record (no network call).
    forget(id) { attached.delete(id); },
    resize(id, cols, rows) {
      if (attached.has(id)) attached.set(id, { cols, rows });
      notify('resize', { id, cols, rows });
    },
    state: () => status
  };
}

module.exports = { createRemoteClient };
