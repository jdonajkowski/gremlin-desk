// The host side of remote sessions: an opt-in TCP server inside Gremlin. A client proves it holds a device's pairing
// secret (src/remote-crypto.js), then everything is encrypted. The session functions come in from main.js, so this file
// has no Electron or node-pty in it and the tests run it against fakes over a real loopback socket.
const net = require('net');
const C = require('./remote-crypto');
const { createRing } = require('./ring-buffer');
const { createScanner } = require('./osc-progress');
const { isListenable } = require('./remote-config');

const HELLO_TIMEOUT_MS = 10000;
const LOCK_AFTER = 5;
const LOCK_MS = 60000;
const MAX_PENDING = 16; // sockets that have not authenticated yet
const MAX_INPUT = 65536;
class PublicError extends Error {} // only these messages are safe to show a client; anything else may hold host paths
const dim = (n) => (Number.isInteger(n) && n >= 1 && n <= 500 ? n : undefined);

// getDevices() entries are { id, secret, name? }; name is only used for the log.
function createRemoteHost({ getDevices, onDeviceSeen = () => {}, snapshot, hasSession, openProject, write, resize, restart, closeSession, log = () => {},
  ringSize = 262144, maxQueued = 8 * 1024 * 1024, now = Date.now, netImpl = net }) {
  const clients = new Set();
  const sockets = new Set(); // every accepted socket, authenticated or not
  const rings = new Map();
  const scanners = new Map();
  const failures = new Map(); // address -> timestamps of recent failed handshakes
  const lastProgress = new Map(); // session id -> { state, value }, for late viewers
  const exitedIds = new Map(); // session id -> exit code while it is not running
  let lastProjects = '';
  let pending = 0;
  let server = null;
  let where = { address: '', port: 0 };

  const ring = (id) => { if (!rings.has(id)) rings.set(id, createRing(ringSize)); return rings.get(id); };
  const scanner = (id) => { if (!scanners.has(id)) scanners.set(id, createScanner()); return scanners.get(id); };

  function locked(addr) {
    const recent = (failures.get(addr) || []).filter((t) => now() - t < LOCK_MS);
    if (recent.length) failures.set(addr, recent); else failures.delete(addr);
    return recent.length >= LOCK_AFTER;
  }
  const noteFailure = (addr) => failures.set(addr, [...(failures.get(addr) || []), now()]);

  function sendTo(c, t, payload) {
    if (!c.channel || c.sock.destroyed) return;
    // A client that stopped reading (asleep, unplugged) must not make the host buffer its output forever.
    if (c.sock.writableLength > maxQueued) { c.sock.destroy(); clients.delete(c); return; }
    c.sock.write(c.channel.seal({ t, ...payload }) + '\n');
  }
  const broadcast = (t, payload) => { for (const c of [...clients]) sendTo(c, t, payload); };

  function restarted(id) {
    if (rings.has(id)) rings.get(id).clear();
    scanners.delete(id);
    exitedIds.delete(id);
    lastProgress.delete(id);
    broadcast('restarted', { id });
  }

  const handlers = {
    projects: () => snapshot(),
    open: (c, a) => {
      if (typeof a.id !== 'string' || !a.id) throw new PublicError('Invalid session id');
      return openProject(a.id, dim(a.cols), dim(a.rows));
    },
    attach: (c, a) => {
      if (typeof a.id !== 'string' || !hasSession(a.id)) throw new PublicError('That session is not running');
      c.attached.add(a.id);
      if (dim(a.cols) && dim(a.rows)) resize(a.id, dim(a.cols), dim(a.rows));
      return { snapshot: ring(a.id).snapshot(), progress: lastProgress.get(a.id) || null, exitCode: exitedIds.has(a.id) ? exitedIds.get(a.id) : null };
    },
    detach: (c, a) => { c.attached.delete(a.id); return true; },
    input: (c, a) => { if (typeof a.data === 'string' && a.data.length <= MAX_INPUT && hasSession(a.id)) write(a.id, a.data); return true; },
    resize: (c, a) => { if (dim(a.cols) && dim(a.rows) && hasSession(a.id)) resize(a.id, dim(a.cols), dim(a.rows)); return true; },
    restart: (c, a) => { if (hasSession(a.id)) { restarted(a.id); restart(a.id, dim(a.cols), dim(a.rows)); } return true; },
    close: (c, a) => { if (hasSession(a.id)) closeSession(a.id); return true; }
  };

  async function handle(c, msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
    const reply = (body) => { if (msg.rid !== undefined) sendTo(c, 'res', { rid: msg.rid, ...body }); };
    const fn = Object.prototype.hasOwnProperty.call(handlers, msg.t) ? handlers[msg.t] : null;
    if (!fn) return reply({ ok: false, error: 'Unknown request' });
    try {
      reply({ ok: true, data: await fn(c, msg) });
    } catch (err) {
      reply({ ok: false, error: err instanceof PublicError ? err.message : 'The request failed' });
    }
  }

  function onConnection(sock) {
    const addr = sock.remoteAddress || '';
    if (!server || locked(addr) || pending >= MAX_PENDING) { sock.destroy(); return; }
    sockets.add(sock);
    sock.setEncoding('utf8');
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15000);
    sock.on('error', () => {});
    const c = { sock, channel: null, dev: null, attached: new Set() };
    const hostNonce = C.newNonce();
    let waiting = true;
    let finished = false; // the first handshake line is final, whatever the outcome
    pending++;
    const done = () => { if (waiting) { waiting = false; pending--; } };
    const timer = setTimeout(() => { noteFailure(addr); sock.destroy(); }, HELLO_TIMEOUT_MS);
    timer.unref();
    const reader = C.createLineReader(onLine, C.MAX_PRE_AUTH_LINE);

    function refuse() {
      noteFailure(addr);
      log({ result: 'refused' });
      sock.end(JSON.stringify({ t: 'no' }) + '\n');
    }

    function handshake(line) {
      if (finished) return;
      finished = true;
      if (!server || locked(addr)) { sock.destroy(); return; }
      let m;
      try { m = JSON.parse(line); } catch { return refuse(); }
      const dev = m && typeof m === 'object' ? (getDevices() || []).find((d) => d.id === m.dev) : null;
      if (!dev || m.t !== 'auth' || !/^[0-9a-f]{32}$/.test(String(m.nonce)) || !C.macEqual(m.mac, C.mac(dev.secret, 'c', hostNonce, m.nonce, dev.id))) return refuse();
      clearTimeout(timer);
      done();
      failures.delete(addr);
      log({ result: 'ok', device: dev.name || dev.id });
      const keys = C.deriveKeys(dev.secret, hostNonce, m.nonce);
      sock.write(JSON.stringify({ t: 'ok', mac: C.mac(dev.secret, 's', hostNonce, m.nonce, dev.id) }) + '\n');
      c.channel = C.createChannel(keys.s2c, keys.c2s);
      c.dev = dev.id;
      reader.setMax(C.MAX_LINE);
      clients.add(c);
      onDeviceSeen(dev.id);
      const snap = snapshot();
      lastProjects = JSON.stringify(snap); // what the newest client holds, so projectsChanged compares against it
      sendTo(c, 'projects', snap);
    }

    function onLine(line) {
      if (!c.channel) return handshake(line);
      let msg;
      try { msg = c.channel.open(line); } catch { sock.destroy(); return; }
      handle(c, msg).catch(() => sock.destroy());
    }

    sock.on('data', (chunk) => { try { reader.feed(chunk); } catch { if (!c.channel) noteFailure(addr); sock.destroy(); } });
    sock.on('close', () => { sockets.delete(sock); clearTimeout(timer); done(); clients.delete(c); if (!clients.size) lastProjects = ''; });
    sock.write(JSON.stringify({ t: 'hello', v: C.VERSION, nonce: hostNonce }) + '\n');
  }

  return {
    listen(address, port) {
      return new Promise((resolve, reject) => {
        if (!isListenable(address)) return reject(new Error(`Refusing to listen on ${address || 'an empty address'}`));
        const s = netImpl.createServer(onConnection);
        s.once('error', reject);
        s.listen(port, address, () => {
          s.removeListener('error', reject);
          s.on('error', () => {});
          server = s;
          where = { address, port: s.address().port };
          resolve(where.port);
        });
      });
    },
    close() {
      const s = server;
      server = null;
      for (const k of [...sockets]) k.destroy();
      clients.clear();
      return new Promise((resolve) => (s ? s.close(() => resolve()) : resolve()));
    },
    status: () => ({ listening: !!server, address: server ? where.address : '', port: server ? where.port : 0, clients: clients.size }),
    output(id, data) {
      if (!hasSession(id)) return; // a killed PTY can still emit a last chunk: it must not recreate the buffer
      ring(id).push(data);
      for (const p of scanner(id).feed(data)) {
        lastProgress.set(id, { state: p.state, value: p.value });
        broadcast('sevent', { id, ev: { t: 'progress', state: p.state, value: p.value } });
      }
      for (const c of clients) if (c.attached.has(id)) sendTo(c, 'data', { id, data });
    },
    exited: (id, code) => { exitedIds.set(id, code); broadcast('exit', { id, code }); },
    restarted,
    drop(id) {
      rings.delete(id);
      scanners.delete(id);
      lastProgress.delete(id);
      exitedIds.delete(id);
      for (const c of clients) c.attached.delete(id);
    },
    broadcast,
    projectsChanged() {
      if (!clients.size) return;
      const snap = snapshot();
      const json = JSON.stringify(snap);
      if (json === lastProjects) return;
      lastProjects = json;
      broadcast('projects', snap);
    },
    disconnectDevice(deviceId) { for (const c of [...clients]) if (c.dev === deviceId) c.sock.destroy(); }
  };
}

module.exports = { createRemoteHost };
