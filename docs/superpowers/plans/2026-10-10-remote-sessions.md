# Remote Sessions (phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one Gremlin (the client) list, attach to, start, restart and close Claude Code sessions running in another Gremlin (the host) on the same network.

**Architecture:** The host runs an opt-in TCP server inside Electron main. After an HMAC handshake every frame is AES-256-GCM sealed (Node `crypto`, no new dependency). The host fans PTY output, worker events and status out to authenticated clients; a per-session ring buffer replays recent output on attach. On the client, remote sessions get namespaced ids (`r:<hostId>/<projectId>`), so `main.js` routes the existing `pty:*` / `session:close` IPC to a remote branch and the renderer treats them as ordinary terminals.

**Tech Stack:** Electron main + renderer, Node `net` and `crypto` (`hkdfSync`, `createCipheriv('aes-256-gcm')`), xterm.js (unchanged), `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-10-remote-sessions-design.md`

## Global Constraints

- No new npm dependency. Transport is newline-delimited frames over `net`.
- Remote control is **off by default**. The host listens only on a private IPv4 interface address (10/8, 172.16/12, 192.168/16, 100.64/10) or loopback. Never 0.0.0.0, never a public address.
- Pre-auth lines are limited to 4096 bytes, post-auth lines to 16 MiB (`16 << 20`; a full replay of escape-heavy output is about 2 MB once JSON-escaped and base64-encoded). The handshake must complete within 10 s.
- 5 failed handshakes from one address lock that address out for 60 s.
- Frame crypto: HKDF-SHA256 per-direction keys, AES-256-GCM, 12-byte nonce from a per-direction counter. Replayed, reordered or tampered frames close the connection.
- Ring buffer: 262144 characters per session.
- Remote ids look like `r:<hostId>/<projectId>`; `hostId` matches `/^[a-z0-9-]+$/`. Remote ids are never written to `tabPrefs`, `tabLinks` or restored on launch.
- Host paths are never sent to clients, and clients send project ids only.
- Aux terminals (`aux:N`) stay local-only. Desktop notifications for remote sessions are NOT raised in phase 1.
- Pure modules follow the repo pattern: no Electron imports, dependencies injected, tests in `test/*.test.js` run with `npm test`.
- Match surrounding code style (2-space indent, single quotes, short comments that explain why).
- Commits: Conventional Commits, one per task, trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Work on branch `feat/remote-sessions`. Do not push or open a PR without the user asking.
- The renderer is not covered by `npm test`: after any renderer/preload/main change, run `node --check` on the edited files and do the dev-instance check described in Task 9.

## Review Focus

Failure modes the spec implies but a straight reading would not test. Each has a test in the task that owns the code.

1. **Host unreachable or remote control off at client startup**: the app starts normally and the host row shows `offline` with a plain-language reason (Task 5 `remote-client` test, Task 6 manager test).
2. **Device revoked while connected**: the live connection is closed within the same call, and reconnecting is rejected without hammering the host (Task 4 host test, Task 5 client test: `rejected` stops auto-retry).
3. **A client that stops reading** (laptop asleep with the socket open): the host drops it instead of buffering output without limit (Task 4 backpressure test).
4. **Project ids with `:`, `\` and `/`** (Windows ids look like `c:\users\jacob\projects\x`), and a Windows host with a Linux client: namespacing round-trips them exactly (Task 3 test).
5. **Pairing code pasted with spaces or line breaks** (chat apps wrap long strings): it still parses (Task 1 test).

## File Structure

| File | Responsibility |
|---|---|
| `src/remote-crypto.js` (new) | Handshake MACs, HKDF keys, AES-GCM channel, line reader, pairing code. Pure. |
| `src/ring-buffer.js` (new) | Bounded replay buffer. Pure. |
| `src/osc-progress.js` (new) | Streaming scanner for OSC 9;4 progress. Pure. |
| `src/remote-config.js` (new) | `remote.json` shape, devices, paired hosts, address rules, id namespacing. Pure. |
| `src/remote-host.js` (new) | TCP server: handshake, routing, fan-out, lockout. Dependencies injected. |
| `src/remote-client.js` (new) | One connection to one host: handshake, requests, reconnect. |
| `src/remote-clients.js` (new) | Manager: all hosts, merged project lists, event translation to renderer channels. |
| `src/main.js` | Wire host + manager, route namespaced ids, merge lists, IPC for the Settings tab. |
| `src/preload.js`, `src/settings/preload.js` | Expose `widget.remote.*` and `settingsHost.remote.*`. |
| `src/renderer/rail.js`, `renderer.js`, `terminals.js`, `styles.css` | Host header rows, replay/reset, remote progress, guards. |
| `src/settings/settings.html`, `settings.js`, `settings.css` | "Remote" tab. |
| `src/tab-prefs.js` | Treat `r:` ids as temporary like `aux:`. |

Keep task order: each task builds on the previous ones.

---

### Task 1: `remote-crypto.js` (handshake, channel, framing, pairing code)

**Files:**
- Create: `src/remote-crypto.js`
- Test: `test/remote-crypto.test.js`

**Interfaces:**
- Produces:
  - `VERSION = 1`, `MAX_LINE = 16777216`, `MAX_PRE_AUTH_LINE = 4096`
  - `newSecret(): string` (64 hex), `newNonce(): string` (32 hex)
  - `mac(secret, tag, hostNonce, clientNonce, dev): string` (hex HMAC-SHA256; tag `'c'` for client proof, `'s'` for host proof)
  - `macEqual(a, b): boolean` (constant time, false on malformed input)
  - `deriveKeys(secret, hostNonce, clientNonce): { c2s: Buffer, s2c: Buffer }`
  - `createChannel(sendKey, recvKey): { seal(obj): string, open(line): object }` (`open` throws on any failure)
  - `createLineReader(onLine, maxLen): { feed(chunk), setMax(n) }` (`feed` throws `Error('line too long')`)
  - `makePairingCode({ device, secret }): string`, `parsePairingCode(text): { device, secret } | null`

- [ ] **Step 1: Write the failing test**

Create `test/remote-crypto.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/remote-crypto');

const secret = C.newSecret();
const hn = C.newNonce();
const cn = C.newNonce();

function pair() {
  const k = C.deriveKeys(secret, hn, cn);
  return { host: C.createChannel(k.s2c, k.c2s), client: C.createChannel(k.c2s, k.s2c) };
}

test('secrets and nonces have the expected shape', () => {
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.match(hn, /^[0-9a-f]{32}$/);
  assert.notEqual(C.newSecret(), C.newSecret());
});

test('mac: same inputs verify; other secret, tag or nonce does not; junk is false', () => {
  const m = C.mac(secret, 'c', hn, cn, 'abcd1234');
  assert.ok(C.macEqual(m, C.mac(secret, 'c', hn, cn, 'abcd1234')));
  assert.ok(!C.macEqual(m, C.mac(C.newSecret(), 'c', hn, cn, 'abcd1234')));
  assert.ok(!C.macEqual(m, C.mac(secret, 's', hn, cn, 'abcd1234')));
  assert.ok(!C.macEqual(m, C.mac(secret, 'c', C.newNonce(), cn, 'abcd1234')));
  assert.ok(!C.macEqual(m, 'zz'));
  assert.ok(!C.macEqual(m, undefined));
  assert.ok(!C.macEqual('', ''));
  assert.ok(!C.macEqual(m + 'zz', m), 'trailing junk is not a match');
});

test('channel: frames round-trip in both directions', () => {
  const { host, client } = pair();
  assert.deepEqual(client.open(host.seal({ t: 'data', id: 'a', data: 'héllo\n\x1b[0m' })), { t: 'data', id: 'a', data: 'héllo\n\x1b[0m' });
  assert.deepEqual(host.open(client.seal({ t: 'input', id: 'a', data: 'x' })), { t: 'input', id: 'a', data: 'x' });
  assert.ok(!host.seal({ a: 1 }).includes('\n'), 'a frame is one line');
});

test('channel: tampered, replayed and reordered frames are rejected', () => {
  let { host, client } = pair();
  const f = host.seal({ a: 1 });
  const bad = f.slice(0, 4) + (f[4] === 'A' ? 'B' : 'A') + f.slice(5);
  assert.throws(() => client.open(bad));

  ({ host, client } = pair());
  const f1 = host.seal({ n: 1 });
  assert.deepEqual(client.open(f1), { n: 1 });
  assert.throws(() => client.open(f1), 'replay');

  ({ host, client } = pair());
  host.seal({ n: 1 });
  const f2 = host.seal({ n: 2 });
  assert.throws(() => client.open(f2), 'out of order');
  assert.throws(() => client.open('AAAA'), 'too short');
});

test('channel: a direction cannot read its own frames, and a wrong secret cannot read at all', () => {
  const k = C.deriveKeys(secret, hn, cn);
  const host = C.createChannel(k.s2c, k.c2s);
  assert.throws(() => host.open(host.seal({ a: 1 })), 'host frame opened with the host receive key');
  const other = C.deriveKeys(C.newSecret(), hn, cn);
  const wrong = C.createChannel(other.c2s, other.s2c);
  assert.throws(() => wrong.open(C.createChannel(k.s2c, k.c2s).seal({ a: 1 })));
  const fresh = pair();
  assert.deepEqual(fresh.client.open(fresh.host.seal({ a: 2 })), { a: 2 });
});

test('line reader: splits chunks into lines and enforces the limit', () => {
  const got = [];
  const r = C.createLineReader((l) => got.push(l), 10);
  r.feed('ab');
  r.feed('c\nde');
  r.feed('f\n\n');
  assert.deepEqual(got, ['abc', 'def']);
  assert.throws(() => r.feed('x'.repeat(11)), /too long/);
  const r2 = C.createLineReader(() => {}, 4);
  assert.throws(() => r2.feed('toolong\n'), /too long/);
  r2.setMax(100);
  r2.feed('toolong\n');
});

test('pairing code round-trips, tolerates whitespace and line breaks, rejects junk', () => {
  const code = C.makePairingCode({ device: 'deadbeef', secret });
  assert.match(code, /^gremlin1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(C.parsePairingCode(code), { device: 'deadbeef', secret });
  const wrapped = '  ' + code.slice(0, 20) + '\r\n' + code.slice(20, 50) + ' \n' + code.slice(50) + '  ';
  assert.deepEqual(C.parsePairingCode(wrapped), { device: 'deadbeef', secret });
  for (const bad of ['', 'hello', 'gremlin1.', 'gremlin1.!!!', 'gremlin2.' + code.slice(9), null, undefined, 42]) assert.equal(C.parsePairingCode(bad), null);
  const wrongShape = 'gremlin1.' + Buffer.from(JSON.stringify({ d: 'xx', s: 'yy' })).toString('base64url');
  assert.equal(C.parsePairingCode(wrongShape), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/remote-crypto.test.js`
Expected: FAIL with "Cannot find module '../src/remote-crypto'".

- [ ] **Step 3: Write the implementation**

Create `src/remote-crypto.js`:

```js
// Wire format for remote sessions. After a plain-JSON handshake (hello / auth / ok) every frame is one line:
// base64(AES-256-GCM(JSON) + tag). Keys are derived per direction from the pairing secret and both nonces; the nonce of
// each frame is a counter, so a replayed or reordered frame fails to decrypt. Pure: only Node's crypto.
const crypto = require('crypto');

const VERSION = 1;
const MAX_LINE = 16 << 20; // a 256K-character replay of escape-heavy output is ~2 MB sealed
const MAX_PRE_AUTH_LINE = 4096;

const HEX8 = /^[0-9a-f]{8}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const newSecret = () => crypto.randomBytes(32).toString('hex');
const newNonce = () => crypto.randomBytes(16).toString('hex');

// tag: 'c' is the client's proof, 's' the host's, so one cannot be replayed as the other.
function mac(secret, tag, hostNonce, clientNonce, dev) {
  return crypto.createHmac('sha256', Buffer.from(secret, 'hex')).update([tag, hostNonce, clientNonce, dev].join('|')).digest('hex');
}

function macEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!HEX64.test(a) || !HEX64.test(b)) return false; // Buffer.from(hex) stops at the first bad character, so check the shape first
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function deriveKeys(secret, hostNonce, clientNonce) {
  const ikm = Buffer.from(secret, 'hex');
  const salt = Buffer.from(hostNonce + clientNonce, 'hex');
  const key = (info) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, 32));
  return { c2s: key('gremlin c2s'), s2c: key('gremlin s2c') };
}

function createChannel(sendKey, recvKey) {
  let out = 0;
  let inn = 0;
  const iv = (n) => {
    const b = Buffer.alloc(12);
    b.writeBigUInt64BE(BigInt(n), 4);
    return b;
  };
  return {
    seal(obj) {
      const c = crypto.createCipheriv('aes-256-gcm', sendKey, iv(out++));
      const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
      return Buffer.concat([body, c.getAuthTag()]).toString('base64');
    },
    // Throws on a short, tampered, replayed or reordered frame; the caller closes the connection.
    open(line) {
      const raw = Buffer.from(String(line), 'base64');
      if (raw.length < 17) throw new Error('short frame');
      const d = crypto.createDecipheriv('aes-256-gcm', recvKey, iv(inn));
      d.setAuthTag(raw.subarray(raw.length - 16));
      const text = Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8');
      inn++;
      return JSON.parse(text);
    }
  };
}

function createLineReader(onLine, maxLen) {
  let buf = '';
  return {
    feed(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.length > maxLen) throw new Error('line too long');
        if (line) onLine(line);
      }
      if (buf.length > maxLen) throw new Error('line too long');
    },
    setMax(n) { maxLen = n; }
  };
}

function makePairingCode({ device, secret }) {
  return 'gremlin1.' + Buffer.from(JSON.stringify({ d: device, s: secret })).toString('base64url');
}

// Chat apps wrap long strings, so all whitespace is ignored.
function parsePairingCode(text) {
  const m = /^gremlin1\.([A-Za-z0-9_-]+)$/.exec(String(text == null ? '' : text).replace(/\s+/g, ''));
  if (!m) return null;
  try {
    const o = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    if (o && HEX8.test(o.d) && HEX64.test(o.s)) return { device: o.d, secret: o.s };
  } catch { /* not a code */ }
  return null;
}

module.exports = { VERSION, MAX_LINE, MAX_PRE_AUTH_LINE, newSecret, newNonce, mac, macEqual, deriveKeys, createChannel, createLineReader, makePairingCode, parsePairingCode };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/remote-crypto.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/remote-crypto.js test/remote-crypto.test.js
git commit -m "feat: encrypted channel and pairing code for remote sessions" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `ring-buffer.js` and `osc-progress.js`

**Files:**
- Create: `src/ring-buffer.js`, `src/osc-progress.js`
- Test: `test/ring-buffer.test.js`, `test/osc-progress.test.js`

**Interfaces:**
- Produces:
  - `createRing(max = 262144): { push(str), snapshot(): string, clear(), size: number }`. `snapshot()` starts with `'\x1b[0m'` once old output has been dropped.
  - `createScanner(): { feed(chunk): Array<{ state: number, value: number }> }` for OSC 9;4 sequences, tolerant of sequences split across chunks.

- [ ] **Step 1: Write the failing tests**

`test/ring-buffer.test.js`:

```js
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
```

`test/osc-progress.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/ring-buffer.test.js test/osc-progress.test.js`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/ring-buffer.js`:

```js
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
```

`src/osc-progress.js`:

```js
// Claude Code reports turn progress as OSC 9;4;<state>[;<percent>] (see terminals.js). The host's main process has no
// terminal, so this finds the same sequences in the raw PTY stream, across chunk boundaries.
const SEQ = /\x1b\]9;4;(\d)(?:;(\d{1,3}))?(?:\x07|\x1b\\)/g;
const MAX_PARTIAL = 24;

function createScanner() {
  let pending = '';
  return {
    feed(chunk) {
      const text = pending + chunk;
      pending = '';
      const out = [];
      let end = 0;
      let m;
      SEQ.lastIndex = 0;
      while ((m = SEQ.exec(text))) {
        out.push({ state: Number(m[1]), value: Number(m[2] || 0) });
        end = SEQ.lastIndex;
      }
      const tail = text.slice(end);
      const esc = tail.lastIndexOf('\x1b');
      if (esc !== -1 && tail.length - esc <= MAX_PARTIAL) pending = tail.slice(esc);
      return out;
    }
  };
}

module.exports = { createScanner };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/ring-buffer.test.js test/osc-progress.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ring-buffer.js src/osc-progress.js test/ring-buffer.test.js test/osc-progress.test.js
git commit -m "feat: replay buffer and progress scanner for remote sessions" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `remote-config.js` (settings file, devices, hosts, address rules, id namespacing)

**Files:**
- Create: `src/remote-config.js`
- Test: `test/remote-config.test.js`

**Interfaces:**
- Consumes: `makePairingCode`, `parsePairingCode`, `newSecret` from `src/remote-crypto.js` (Task 1).
- Produces (all pure; list-changing functions return new objects):
  - `DEFAULT_PORT = 47731`
  - `isPrivateV4(addr): boolean`, `isListenable(addr): boolean` (private or loopback)
  - `privateInterfaces(osInterfaces): Array<{ name, address }>` (non-internal private IPv4, then loopback last as name `'This computer only'`)
  - `normalize(raw): { host: { enabled, address, port }, devices: [{ id, name, secret, lastSeen }], hosts: [{ id, name, address, port, device, secret }] }`
  - `setHost(cfg, { enabled, address, port }): { cfg } | { error }`
  - `createDevice(cfg, name): { cfg, device }`, `revokeDevice(cfg, id): cfg`, `touchDevice(cfg, id, now): cfg`, `publicDevices(cfg): [{ id, name, lastSeen }]`
  - `addHost(cfg, { name, address, port, code }): { cfg, host } | { error }`, `removeHost(cfg, id): cfg`, `renameHost(cfg, id, name): cfg`
  - `nsId(hostId, projectId): string`, `parseNsId(id): { hostId, projectId } | null`
  - `decorate(hostId, hostName, projects): Array<project>` with `id` namespaced, `path: ''`, `remote: { hostId, hostName }`

- [ ] **Step 1: Write the failing test**

`test/remote-config.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../src/remote-config');
const C = require('../src/remote-crypto');

test('isPrivateV4 / isListenable: private ranges and loopback only', () => {
  for (const ok of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.20', '100.64.0.1', '100.127.9.9']) assert.ok(R.isPrivateV4(ok), ok);
  for (const no of ['8.8.8.8', '172.32.0.1', '172.15.0.1', '100.128.0.1', '0.0.0.0', '127.0.0.1', '::1', '', 'host', undefined]) assert.ok(!R.isPrivateV4(no), String(no));
  assert.ok(R.isListenable('127.0.0.1'));
  assert.ok(R.isListenable('192.168.1.20'));
  assert.ok(!R.isListenable('0.0.0.0'));
  assert.ok(!R.isListenable('203.0.113.5'));
});

test('privateInterfaces: home LAN ranges first, loopback last, nothing public or IPv6', () => {
  const ifaces = {
    wsl: [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
    eth0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    wan: [{ family: 'IPv4', address: '203.0.113.5', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }]
  };
  assert.deepEqual(R.privateInterfaces(ifaces), [{ name: 'eth0', address: '192.168.1.20' }, { name: 'wsl', address: '172.20.0.1' }, { name: 'This computer only', address: '127.0.0.1' }]);
});

test('normalize: defaults, bad ports and entries dropped, duplicates removed', () => {
  assert.deepEqual(R.normalize(null), { host: { enabled: false, address: '', port: R.DEFAULT_PORT }, devices: [], hosts: [] });
  const secret = C.newSecret();
  const out = R.normalize({
    host: { enabled: true, address: ' 192.168.1.5 ', port: 80 },
    devices: [{ id: 'deadbeef', name: 'Laptop', secret, lastSeen: 5 }, { id: 'deadbeef', name: 'dup', secret }, { id: 'nothex!!', secret }, null],
    hosts: [{ id: 'desk', name: 'Desk', address: 'desk.local', port: 47731, device: 'cafebabe', secret }, { id: 'Bad Id', name: 'x', address: 'a', port: 1, device: 'cafebabe', secret }]
  });
  assert.deepEqual(out.host, { enabled: true, address: '192.168.1.5', port: R.DEFAULT_PORT });
  assert.deepEqual(out.devices.map((d) => d.id), ['deadbeef']);
  assert.equal(out.devices[0].lastSeen, 5);
  assert.deepEqual(out.hosts.map((h) => h.id), ['desk']);
});

test('setHost validates the address and port', () => {
  const cfg = R.normalize({});
  assert.deepEqual(R.setHost(cfg, { enabled: true, address: '', port: 50000 }).cfg.host, { enabled: true, address: '', port: 50000 });
  assert.match(R.setHost(cfg, { enabled: true, address: '8.8.8.8', port: 50000 }).error, /private/i);
  assert.match(R.setHost(cfg, { enabled: true, address: '', port: 80 }).error, /1024/);
  assert.match(R.setHost(cfg, { enabled: true, address: '', port: 'x' }).error, /1024/);
});

test('devices: create, touch, revoke; the public view has no secret', () => {
  let cfg = R.normalize({});
  const made = R.createDevice(cfg, '  Laptop ');
  cfg = made.cfg;
  assert.equal(made.device.name, 'Laptop');
  assert.match(made.device.id, /^[0-9a-f]{8}$/);
  assert.match(made.device.secret, /^[0-9a-f]{64}$/);
  cfg = R.touchDevice(cfg, made.device.id, 123);
  assert.deepEqual(R.publicDevices(cfg), [{ id: made.device.id, name: 'Laptop', lastSeen: 123 }]);
  assert.equal(R.createDevice(cfg, '').device.name, 'Device 2');
  assert.deepEqual(R.revokeDevice(cfg, made.device.id).devices, []);
  assert.equal(R.touchDevice(cfg, 'nope', 1), cfg);
});

test('addHost: parses the code, defaults the port, rejects bad input with plain messages', () => {
  const cfg = R.normalize({});
  const code = C.makePairingCode({ device: 'cafebabe', secret: C.newSecret() });
  const ok = R.addHost(cfg, { name: 'Desk PC', address: ' 192.168.1.20 ', port: '', code });
  assert.equal(ok.host.id, 'desk-pc');
  assert.equal(ok.host.port, R.DEFAULT_PORT);
  assert.equal(ok.host.address, '192.168.1.20');
  assert.equal(R.addHost(ok.cfg, { name: 'Desk PC', address: 'b.local', port: 50000, code }).host.id, 'desk-pc-2');
  assert.match(R.addHost(cfg, { name: 'x', address: '', port: 1, code }).error, /address/i);
  assert.match(R.addHost(cfg, { name: 'x', address: 'a b', port: 47731, code }).error, /address/i);
  assert.match(R.addHost(cfg, { name: 'x', address: 'a', port: 80, code }).error, /1024/);
  assert.match(R.addHost(cfg, { name: 'x', address: 'a', port: 47731, code: 'nope' }).error, /pairing code/i);
  assert.equal(R.addHost(cfg, { name: '', address: 'desk.local', port: 47731, code }).host.name, 'desk.local');
  assert.deepEqual(R.removeHost(ok.cfg, 'desk-pc').hosts, []);
  assert.equal(R.renameHost(ok.cfg, 'desk-pc', ' Study ').hosts[0].name, 'Study');
});

test('nsId / parseNsId round-trip ids with colons, backslashes and slashes', () => {
  for (const pid of ['c:\\users\\jacob\\projects\\x', '/home/me/Projects/app', 'c:/odd/with:colon/and space']) {
    const id = R.nsId('desk-pc', pid);
    assert.deepEqual(R.parseNsId(id), { hostId: 'desk-pc', projectId: pid });
  }
  for (const bad of ['aux:1', 'r:/x', 'r:Bad/x', 'r:desk', 'plain', '', null, undefined]) assert.equal(R.parseNsId(bad), null);
});

test('decorate: namespaced ids, no host paths, remote marker', () => {
  const out = R.decorate('desk', 'Desk PC', [{ id: 'c:\\p\\a', name: 'a', folder: 'a', initials: 'A', worktreeOf: null }]);
  assert.deepEqual(out, [{ id: 'r:desk/c:\\p\\a', path: '', name: 'a', folder: 'a', initials: 'A', pinned: false, missing: false, worktreeOf: null, remote: { hostId: 'desk', hostName: 'Desk PC' } }]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/remote-config.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/remote-config.js`:

```js
// remote.json: this computer as a host (enabled, address, port, paired devices) and the computers it connects to.
// Pure; main.js reads and writes the file.
const crypto = require('crypto');
const { newSecret, parsePairingCode } = require('./remote-crypto');

const DEFAULT_PORT = 47731;
const HEX8 = /^[0-9a-f]{8}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const HOST_ID = /^[a-z0-9-]+$/;
const ADDRESS = /^[A-Za-z0-9._-]+$/;
const PORT_ERROR = 'Port must be between 1024 and 65535';

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const portOk = (p) => Number.isInteger(p) && p >= 1024 && p <= 65535;
const hex8 = () => crypto.randomBytes(4).toString('hex');

function isPrivateV4(addr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(addr));
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

// The host never listens on 0.0.0.0 or a public address; loopback is allowed for testing two instances on one machine.
const isListenable = (addr) => isPrivateV4(addr) || addr === '127.0.0.1';

function privateInterfaces(ifaces) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const i of list || []) if (i && i.family === 'IPv4' && !i.internal && isPrivateV4(i.address)) out.push({ name, address: i.address });
  }
  // Home LAN ranges first: on Windows the WSL / Hyper-V adapter is often a 172.x address and must not be the default.
  const rank = (a) => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : a.startsWith('100.') ? 2 : 3);
  out.sort((x, y) => rank(x.address) - rank(y.address));
  out.push({ name: 'This computer only', address: '127.0.0.1' });
  return out;
}

function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const h = r.host && typeof r.host === 'object' ? r.host : {};
  const seen = new Set();
  const once = (id) => (seen.has(id) ? false : (seen.add(id), true));
  const devices = (Array.isArray(r.devices) ? r.devices : [])
    .filter((d) => d && HEX8.test(d.id) && HEX64.test(d.secret) && once(`d${d.id}`))
    .map((d) => ({ id: d.id, name: str(d.name) || 'Device', secret: d.secret, lastSeen: typeof d.lastSeen === 'number' ? d.lastSeen : null }));
  const hosts = (Array.isArray(r.hosts) ? r.hosts : [])
    .filter((x) => x && typeof x.id === 'string' && HOST_ID.test(x.id) && ADDRESS.test(str(x.address)) && portOk(x.port) && HEX8.test(x.device) && HEX64.test(x.secret) && once(`h${x.id}`))
    .map((x) => ({ id: x.id, name: str(x.name) || str(x.address), address: str(x.address), port: x.port, device: x.device, secret: x.secret }));
  return { host: { enabled: h.enabled === true, address: str(h.address), port: portOk(h.port) ? h.port : DEFAULT_PORT }, devices, hosts };
}

function setHost(cfg, { enabled, address, port }) {
  const a = str(address);
  if (a && !isListenable(a)) return { error: 'Use a private network address (192.168.x.x, 10.x.x.x, 172.16-31.x.x or 100.64-127.x.x)' };
  const p = Number(port);
  if (!portOk(p)) return { error: PORT_ERROR };
  return { cfg: { ...cfg, host: { enabled: enabled === true, address: a, port: p } } };
}

function createDevice(cfg, name) {
  let id = hex8();
  while (cfg.devices.some((d) => d.id === id)) id = hex8();
  const device = { id, name: str(name) || `Device ${cfg.devices.length + 1}`, secret: newSecret(), lastSeen: null };
  return { cfg: { ...cfg, devices: [...cfg.devices, device] }, device };
}

const revokeDevice = (cfg, id) => ({ ...cfg, devices: cfg.devices.filter((d) => d.id !== id) });

function touchDevice(cfg, id, now) {
  if (!cfg.devices.some((d) => d.id === id)) return cfg;
  return { ...cfg, devices: cfg.devices.map((d) => (d.id === id ? { ...d, lastSeen: now } : d)) };
}

const publicDevices = (cfg) => cfg.devices.map((d) => ({ id: d.id, name: d.name, lastSeen: d.lastSeen }));

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'host';

function addHost(cfg, { name, address, port, code }) {
  const parsed = parsePairingCode(code);
  if (!parsed) return { error: 'That pairing code is not valid. Copy it again from the other computer.' };
  const a = str(address);
  if (!a || !ADDRESS.test(a)) return { error: "Enter the other computer's address, like 192.168.1.20 or desk.local" };
  const p = port === '' || port == null ? DEFAULT_PORT : Number(port);
  if (!portOk(p)) return { error: PORT_ERROR };
  const label = str(name) || a;
  let id = slug(label);
  for (let n = 2; cfg.hosts.some((h) => h.id === id); n++) id = `${slug(label)}-${n}`;
  const host = { id, name: label, address: a, port: p, device: parsed.device, secret: parsed.secret };
  return { cfg: { ...cfg, hosts: [...cfg.hosts, host] }, host };
}

const removeHost = (cfg, id) => ({ ...cfg, hosts: cfg.hosts.filter((h) => h.id !== id) });
const renameHost = (cfg, id, name) => ({ ...cfg, hosts: cfg.hosts.map((h) => (h.id === id ? { ...h, name: str(name) || h.name } : h)) });

// Remote project ids: r:<hostId>/<the host's project id>. The host's id can hold any character, so only the first / splits.
const nsId = (hostId, projectId) => `r:${hostId}/${projectId}`;
function parseNsId(id) {
  const m = /^r:([a-z0-9-]+)\/([\s\S]+)$/.exec(typeof id === 'string' ? id : '');
  return m ? { hostId: m[1], projectId: m[2] } : null;
}

// A host's project list as rows for the local rail: namespaced ids, and no folder paths from the other computer.
function decorate(hostId, hostName, projects) {
  return (projects || []).map((p) => ({
    id: nsId(hostId, p.id),
    path: '',
    name: p.name,
    folder: p.folder,
    initials: p.initials,
    pinned: false,
    missing: false,
    worktreeOf: p.worktreeOf || null,
    remote: { hostId, hostName }
  }));
}

module.exports = { DEFAULT_PORT, isPrivateV4, isListenable, privateInterfaces, normalize, setHost, createDevice, revokeDevice, touchDevice, publicDevices, addHost, removeHost, renameHost, nsId, parseNsId, decorate };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/remote-config.test.js`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/remote-config.js test/remote-config.test.js
git commit -m "feat: remote.json model, device pairing and id namespacing" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `remote-host.js` (the server)

**Files:**
- Create: `src/remote-host.js`
- Test: `test/remote-host.test.js`

**Interfaces:**
- Consumes: Task 1 (`remote-crypto`), Task 2 (`createRing`, `createScanner`), Task 3 (`isListenable`).
- Produces `createRemoteHost(opts)` returning:
  - `listen(address, port): Promise<number>` (rejects with `Error('Refusing to listen on <addr>')` for non-listenable addresses; resolves the bound port; `port` 0 allowed for tests)
  - `close(): Promise<void>`
  - `status(): { listening: boolean, address: string, port: number, clients: number }`
  - `output(id, data)`: PTY output (ring + progress scan + attached clients)
  - `exited(id, code)`: broadcast `exit`
  - `restarted(id)`: clear the session's ring, forget its exit and progress, broadcast `restarted`
  - `drop(id)`: delete ring and scanner (session closed)
  - `broadcast(t, payload)`: to every authenticated client (`t` is the event name, payload is an object merged into the frame)
  - `projectsChanged()`: broadcast `projects` with `snapshot()`, but only when it differs from the last one broadcast (two Gremlins paired with each other would otherwise echo forever)
  - `disconnectDevice(deviceId)`
- `opts`: `{ getDevices() => [{id, secret}], onDeviceSeen(id), snapshot() => {list, open, git}, hasSession(id) => bool, openProject(id, cols, rows) => bool|Promise<bool>, write(id, data), resize(id, cols, rows), restart(id, cols, rows), closeSession(id), log(entry) = no-op, ringSize = 262144, maxQueued = 8388608, now = Date.now, netImpl = require('net') }`. `log` receives `{ result: 'ok' | 'refused', device? }` (device name and result only)
- Wire protocol (inside the encrypted channel): requests are `{ t, rid, ...args }`, answered by `{ t: 'res', rid, ok: true, data }` or `{ t: 'res', rid, ok: false, error }`. A message without `rid` gets no answer (used for `input`, `resize`, `restart`). Events from the host: `projects` (`{list, open, git}`), `data` (`{id, data}`), `exit` (`{id, code}`), `restarted` (`{id}`), `sevent` (`{id, ev: {t: 'progress', state, value}}`), `workers` (`{id, events}`), `status` (`{id, status}`), `closed` (`{id}`). Requests: `projects`, `open {id, cols, rows}`, `attach {id, cols, rows}` (data: `{ snapshot, progress: {state, value} | null, exitCode: number | null }`), `detach {id}`, `input {id, data}`, `resize {id, cols, rows}`, `restart {id, cols, rows}`, `close {id}`.
- Handshake (plain JSON lines): host sends `{t:'hello', v:1, nonce}`; client replies `{t:'auth', dev, nonce, mac}`; host answers `{t:'ok', mac}` or `{t:'no'}` then closes. A locked-out address is closed silently.

- [ ] **Step 1: Write the failing test**

`test/remote-host.test.js`:

```js
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
          resolve(c);
        } else if (m.t === 'no') {
          resolve({ rejected: true, closed: () => closed, sock });
        }
        return;
      }
      pushMsg(channel.open(line));
    }, C.MAX_PRE_AUTH_LINE);
    sock.on('data', (d) => { try { reader.feed(d); } catch (e) { sock.destroy(); } });
    sock.on('close', () => { closed = true; });
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
  await assert.rejects(connect(s.port), /timeout|closed/i, 'locked out: dropped silently');
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
  await b.request('detach', { id: 'p1' }); // b never attached: still fine
  s.host.broadcast('workers', { id: 'p1', events: [1] });
  assert.deepEqual((await b.until((m) => m.t === 'workers')).events, [1]);
  a.close(); b.close();
  await s.host.close();
});

test('restarted clears the replay buffer and tells everyone; exited and projectsChanged reach everyone', async () => {
  const s = await started();
  const a = await connect(s.port);
  await a.next();
  s.host.output('p1', 'old');
  s.host.restarted('p1');
  assert.deepEqual(await a.until((m) => m.t === 'restarted'), { t: 'restarted', id: 'p1' });
  assert.equal((await a.request('attach', { id: 'p1' })).data.snapshot, '');
  s.host.exited('p1', 3);
  assert.deepEqual(await a.until((m) => m.t === 'exit'), { t: 'exit', id: 'p1', code: 3 });
  assert.equal((await a.request('attach', { id: 'p1' })).data.exitCode, 3, 'a late viewer learns the session ended');
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
  s.host.output('gone', 'stale');
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
  await new Promise((r) => setTimeout(r, 100));
  const extra = net.connect({ host: '127.0.0.1', port: s.port });
  extra.on('error', () => {});
  const closed = await new Promise((resolve) => { extra.on('close', () => resolve(true)); setTimeout(() => resolve(false), 1000); });
  assert.equal(closed, true, 'the 17th is dropped');
  for (const k of socks) k.destroy();
  extra.destroy();
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/remote-host.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/remote-host.js`:

```js
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
const dim = (n) => (Number.isInteger(n) && n >= 1 && n <= 500 ? n : undefined);

function createRemoteHost({ getDevices, onDeviceSeen = () => {}, snapshot, hasSession, openProject, write, resize, restart, closeSession, log = () => {},
  ringSize = 262144, maxQueued = 8 * 1024 * 1024, now = Date.now, netImpl = net }) {
  const clients = new Set();
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
    exitedIds.delete(id);
    lastProgress.delete(id);
    broadcast('restarted', { id });
  }

  const handlers = {
    projects: () => snapshot(),
    open: (c, a) => openProject(a.id, dim(a.cols), dim(a.rows)),
    attach: (c, a) => {
      if (typeof a.id !== 'string' || !hasSession(a.id)) throw new Error('That session is not running');
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
      reply({ ok: false, error: err.message });
    }
  }

  function onConnection(sock) {
    const addr = sock.remoteAddress || '';
    if (locked(addr) || pending >= MAX_PENDING) { sock.destroy(); return; }
    sock.setEncoding('utf8');
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 15000);
    sock.on('error', () => {});
    const c = { sock, channel: null, dev: null, attached: new Set() };
    const hostNonce = C.newNonce();
    let waiting = true;
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
      sendTo(c, 'projects', snapshot());
    }

    function onLine(line) {
      if (!c.channel) return handshake(line);
      let msg;
      try { msg = c.channel.open(line); } catch { sock.destroy(); return; }
      handle(c, msg);
    }

    sock.on('data', (chunk) => { try { reader.feed(chunk); } catch { if (!c.channel) noteFailure(addr); sock.destroy(); } });
    sock.on('close', () => { clearTimeout(timer); done(); clients.delete(c); });
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
      for (const c of [...clients]) c.sock.destroy();
      clients.clear();
      const s = server;
      server = null;
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
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/remote-host.test.js`
Expected: PASS, 14 tests. If the lockout test hangs, check that a locked address is destroyed before `hello` is written (the `locked()` check comes first in `onConnection`).

- [ ] **Step 5: Run the whole suite and commit**

Run: `npm test`
Expected: all tests pass (282 existing + the new ones).

```bash
git add src/remote-host.js test/remote-host.test.js
git commit -m "feat: remote session host server" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `remote-client.js` (one connection to one host)

**Files:**
- Create: `src/remote-client.js`
- Test: `test/remote-client.test.js`

**Interfaces:**
- Consumes: Task 1 and Task 4 (the test runs a real `createRemoteHost` on loopback).
- Produces `createRemoteClient({ host, onState, onEvent, netImpl, timers, delays, requestTimeoutMs })` with `host = { address, port, device, secret }`:
  - `connect()`, `stop()`, `reconnect()` (manual; also leaves the `error` state)
  - `request(t, args, onResult?): Promise<data>` (`onResult(data)` runs synchronously when the answer is read, before any frame that follows it in the same chunk; rejects `Error('Not connected')` when not online; rejects with the host's `error` text on `ok: false`; times out after `requestTimeoutMs`, default 15000)
  - `notify(t, args)`: fire-and-forget (dropped unless online)
  - `attach(id, cols, rows): Promise<void>`, `detach(id)`, `resize(id, cols, rows)`, `isAttached(id): boolean`
  - `state(): { state, error }` where state is `'offline' | 'connecting' | 'online' | 'error'`
- `onState({ state, error })` fires on every change. `onEvent(msg)` receives every host event (`projects`, `data`, `exit`, `sevent`, `workers`, `status`, `closed`) plus three local events: `{ t: 'snapshot', id, data, progress, exitCode }` (replay text and the session's current progress / exit code after an attach), `{ t: 'resync', id }` (sent just before a re-attach after reconnect, so the renderer resets that terminal), `{ t: 'lost', id }` (an attached session's connection dropped).
- Reconnect: `delays` default `[2000, 5000, 10000, 30000]`. A host that answers `no` (wrong/revoked code, locked out) puts the client in `error` and stops retrying until `reconnect()`.

- [ ] **Step 1: Write the failing test**

`test/remote-client.test.js`:

```js
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
  const net = require('net');
  const again = createRemoteHost({
    getDevices: () => [{ id: DEV, secret: SECRET }],
    snapshot: () => ({ list: [], open: ['p1'], git: {} }),
    hasSession: () => true, openProject: () => true, write() {}, resize() {}, restart() {}, closeSession() {}
  });
  await again.listen('127.0.0.1', h.port);
  again.output('p1', 'screen');
  await until(() => client.state().state === 'online', 4000);
  const order = events.map((e) => e.t).filter((t) => t === 'resync' || t === 'snapshot');
  assert.deepEqual(order, ['resync', 'snapshot']);
  assert.equal(events.find((e) => e.t === 'snapshot').data, 'screen');
  client.stop();
  await again.close();
  void net;
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

test('a host that cannot prove it holds the secret is not trusted', async () => {
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/remote-client.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/remote-client.js`:

```js
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
        return msg.t === 'res' ? settle(msg) : onEvent(msg);
      }
      let m;
      try { m = JSON.parse(line); } catch { return refuse('The other computer is not running Gremlin remote control.'); }
      if (stage === 'hello') {
        if (!m || m.t !== 'hello' || m.v !== C.VERSION || !/^[0-9a-f]{32}$/.test(String(m.nonce))) return refuse('The other computer runs an incompatible version of Gremlin.');
        hostNonce = m.nonce;
        stage = 'auth';
        s.write(JSON.stringify({ t: 'auth', dev: host.device, nonce: clientNonce, mac: C.mac(host.secret, 'c', hostNonce, clientNonce, host.device) }) + '\n');
        return;
      }
      if (m && m.t === 'no') return refuse('The other computer rejected this pairing (wrong code, revoked, or too many attempts). Pair again, or wait a minute.');
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
    resize(id, cols, rows) {
      if (attached.has(id)) attached.set(id, { cols, rows });
      notify('resize', { id, cols, rows });
    },
    state: () => status
  };
}

module.exports = { createRemoteClient };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/remote-client.test.js`
Expected: PASS, 7 tests. In the reconnect test the new host is created on the old port; if the OS has not freed it yet (`EADDRINUSE`), retry the `listen` in the test once after 50 ms.

- [ ] **Step 5: Run the whole suite and commit**

Run: `npm test`
Expected: all pass.

```bash
git add src/remote-client.js test/remote-client.test.js
git commit -m "feat: remote session client connection" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `remote-clients.js` (manager: all hosts, merged lists, event translation)

**Files:**
- Create: `src/remote-clients.js`
- Test: `test/remote-clients.test.js`

**Interfaces:**
- Consumes: Task 3 (`nsId`, `parseNsId`, `decorate`), Task 5 (`createRemoteClient`, injected as `createClient` for tests).
- Produces `createRemoteClients({ getHosts, createClient = createRemoteClient, send, onChange })`:
  - `sync()`: start clients for new hosts, stop clients for removed ones (call at startup and after the paired-host list changes)
  - `has(id)`: true for a namespaced id of a known host
  - `isOpen(id)`: the host reports that session as running
  - `list()`: decorated projects of every paired host (host order, then the host's order); rows of a host that is not connected keep their last known state and are flagged `remote.offline: true`
  - `openIds()`: namespaced ids of running remote sessions
  - `git()`: namespaced git map of online hosts
  - `hosts()`: `[{ id, name, address, port, state, error }]`
  - `open(id, cols, rows): Promise<boolean>`; `write(id, data)`; `resize(id, cols, rows)`; `restart(id, cols, rows)`; `close(id): Promise`
  - `reconnect(hostId)`, `stopAll()`
- Event translation (client event → `send(channel, payload)` to the renderer, ids namespaced): `data` → `pty:data {id, data}`; `exit` → `pty:exit {id, code}`; `workers` → `workers:events {id, events}`; `status` → `status:update {id, status}`; `sevent` → `remote:sevent {id, ev}`; `snapshot` → `remote:replay {id, data, progress}` and, when `exitCode` is not null, `pty:exit {id, code}` right after it; `resync` and `restarted` → `remote:reset {id}`; `closed` → `session:closed {id}`; `lost` → `pty:data {id, data: '\r\n\x1b[90m[connection lost, reconnecting…]\x1b[0m\r\n'}`. `projects` replaces the host's cached snapshot and calls `onChange()`. Any state change also calls `onChange()`.
- Input to an offline host is dropped (`client.notify` already ignores it).

- [ ] **Step 1: Write the failing test**

`test/remote-clients.test.js`:

```js
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
```

- [ ] **Step 2: Run to verify failure**

Run: `node --test test/remote-clients.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`src/remote-clients.js`:

```js
// Every paired host as the rest of the app sees it: a merged project list, namespaced session ids, and the host's events
// re-sent to the renderer on the channels it already listens to (pty:data, workers:events...), so a remote session
// behaves like a local one. The connection itself is src/remote-client.js.
const { createRemoteClient } = require('./remote-client');
const { nsId, parseNsId, decorate } = require('./remote-config');

const LOST = '\r\n\x1b[90m[connection lost, reconnecting…]\x1b[0m\r\n';

function createRemoteClients({ getHosts, createClient = createRemoteClient, send, onChange = () => {} }) {
  const entries = new Map(); // host id -> { host, client, snapshot: { list, open, git } }

  function translate(hostId, msg) {
    const id = nsId(hostId, msg.id);
    switch (msg.t) {
      case 'data': return send('pty:data', { id, data: msg.data });
      case 'exit': return send('pty:exit', { id, code: msg.code });
      case 'workers': return send('workers:events', { id, events: msg.events });
      case 'status': return send('status:update', { id, status: msg.status });
      case 'sevent': return send('remote:sevent', { id, ev: msg.ev });
      case 'snapshot':
        send('remote:replay', { id, data: msg.data, progress: msg.progress || null });
        return msg.exitCode == null ? undefined : send('pty:exit', { id, code: msg.exitCode });
      case 'resync':
      case 'restarted': return send('remote:reset', { id });
      case 'closed': return send('session:closed', { id });
      case 'lost': return send('pty:data', { id, data: LOST });
      default: return undefined;
    }
  }

  function start(host) {
    const entry = { host, client: null, snapshot: { list: [], open: [], git: {} } };
    entry.client = createClient({
      host,
      onState: () => onChange(),
      onEvent: (msg) => {
        if (msg.t === 'projects') {
          entry.snapshot = { list: msg.list || [], open: msg.open || [], git: msg.git || {} };
          return onChange();
        }
        translate(host.id, msg);
      }
    });
    entries.set(host.id, entry);
    entry.client.connect();
  }

  function sync() {
    const wanted = new Map(getHosts().map((h) => [h.id, h]));
    for (const [id, e] of entries) {
      if (!wanted.has(id)) { e.client.stop(); entries.delete(id); }
    }
    for (const [id, h] of wanted) if (!entries.has(id)) start(h);
    onChange();
  }

  const parts = (id) => {
    const p = parseNsId(id);
    const entry = p && entries.get(p.hostId);
    return entry ? { entry, projectId: p.projectId, hostId: p.hostId } : null;
  };
  const onlineEntries = () => [...entries.values()].filter((e) => e.client.state().state === 'online');

  return {
    sync,
    has: (id) => !!parts(id),
    isOpen: (id) => { const p = parts(id); return !!p && p.entry.snapshot.open.includes(p.projectId); },
    list: () => [...entries.values()].flatMap((e) => {
      const rows = decorate(e.host.id, e.host.name, e.snapshot.list);
      return e.client.state().state === 'online' ? rows : rows.map((p) => ({ ...p, remote: { ...p.remote, offline: true } }));
    }),
    openIds: () => onlineEntries().flatMap((e) => e.snapshot.open.map((id) => nsId(e.host.id, id))),
    git: () => {
      const out = {};
      for (const e of onlineEntries()) for (const [id, info] of Object.entries(e.snapshot.git)) out[nsId(e.host.id, id)] = info;
      return out;
    },
    hosts: () => [...entries.values()].map((e) => ({ id: e.host.id, name: e.host.name, address: e.host.address, port: e.host.port, ...e.client.state() })),
    async open(id, cols, rows) {
      const p = parts(id);
      if (!p) return false;
      if (p.entry.client.isAttached(p.projectId)) return true; // switching back to a tab: the terminal already has the screen
      try {
        if (!(await p.entry.client.request('open', { id: p.projectId, cols, rows }))) return false;
        await p.entry.client.attach(p.projectId, cols, rows);
        return true;
      } catch {
        return false;
      }
    },
    write(id, data) { const p = parts(id); if (p) p.entry.client.notify('input', { id: p.projectId, data }); },
    resize(id, cols, rows) { const p = parts(id); if (p) p.entry.client.resize(p.projectId, cols, rows); },
    restart(id, cols, rows) { const p = parts(id); if (p) p.entry.client.notify('restart', { id: p.projectId, cols, rows }); },
    async close(id) {
      const p = parts(id);
      if (!p) return;
      try { await p.entry.client.request('close', { id: p.projectId }); } catch { /* host gone: nothing to close */ }
      p.entry.client.detach(p.projectId);
    },
    reconnect(hostId) { const e = entries.get(hostId); if (e) e.client.reconnect(); },
    stopAll() { for (const e of entries.values()) e.client.stop(); entries.clear(); }
  };
}

module.exports = { createRemoteClients };
```

- [ ] **Step 4: Run to verify pass**

Run: `node --test test/remote-clients.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/remote-clients.js test/remote-clients.test.js
git commit -m "feat: manager for paired remote hosts" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Wire the host and the client into `main.js` and the preloads

**Files:**
- Modify: `src/main.js`, `src/preload.js`, `src/settings/preload.js`
- No unit test (Electron main). Verify with `node --check` and the dev-instance run in Task 9.

**Interfaces:**
- Consumes: Tasks 3-6.
- Produces (IPC, all in `main.js`):
  - Renderer: `projects:list` payload and `projects:get` result gain `remoteHosts: [{ id, name, address, port, state, error }]`; `list` and `open` include remote entries. New one-way channels to the renderer: `remote:replay {id, data}`, `remote:reset {id}`, `remote:sevent {id, ev}`. New renderer-to-main: `remote:reconnect hostId`.
  - Settings window: `remote:get`, `remote:setHost`, `remote:pair`, `remote:revoke`, `remote:addHost`, `remote:removeHost`, `remote:reconnect`. `remote:get` returns `{ host: { enabled, address, port, listening, boundAddress, error }, interfaces, devices, hosts }`. `remote:pair` returns the same plus `code` (shown once).

Read the current text of each block before editing. Line numbers below are from the repo at the time of writing; use the quoted text as the anchor.

- [ ] **Step 1: Requires and the data file**

In `src/main.js`, after `const { createAux } = require('./aux-sessions');` add:

```js
const remoteConfig = require('./remote-config');
const remoteCrypto = require('./remote-crypto');
const { createRemoteHost } = require('./remote-host');
const { createRemoteClients } = require('./remote-clients');
```

After `const defaultsPath = path.join(userDir, 'project-defaults.json');` add:

```js
const remotePath = path.join(userDir, 'remote.json');
```

- [ ] **Step 2: Tee session output to the remote host**

Directly after the existing `function send(channel, payload) { ... }` add:

```js
// Session output also goes to attached remote clients. Aux terminals use plain send(): they stay on this computer.
function sessionSend(channel, payload) {
  send(channel, payload);
  if (channel === 'pty:data') remoteHost.output(payload.id, payload.data);
  else if (channel === 'pty:exit') remoteHost.exited(payload.id, payload.code);
  else if (channel === 'workers:events') remoteHost.broadcast('workers', payload);
  else if (channel === 'status:update') remoteHost.broadcast('status', payload);
}
```

In the `createSessions({ ... })` call (the one with `settingsFile: writeSessionSettings,`) change its `send,` line to `send: sessionSend,`. Do not change the `createAux` call.

- [ ] **Step 3: Host and client objects**

Insert this block directly after the line `ipcMain.handle('git:all', () => lastAllGit);` (and delete that old `git:all` line, replaced below):

```js
// ---------------------------------------------------------------------------
// Remote sessions: this computer as a host (src/remote-host.js) and as a client of other computers (src/remote-clients.js)
// ---------------------------------------------------------------------------
let remoteCfg = remoteConfig.normalize(readJson(remotePath, {}));
let remoteError = '';
function saveRemote(next) {
  remoteCfg = next;
  writeJson(remotePath, next);
}

// Starts a project's session without making it the active one (used when a remote client opens it).
function startSession(id, cols, rows) {
  if (sessions.has(id)) return true;
  const p = projectList.find((x) => x.id === id);
  if (!p || p.missing || !fs.existsSync(p.path)) return false;
  sessions.open(id, p.path, cols, rows);
  saveOpen();
  return true;
}

// No folder paths: a client only ever refers to projects by id.
function remoteSnapshot() {
  return {
    list: projectList.filter((p) => !p.missing).map((p) => ({ id: p.id, name: p.name, folder: p.folder, initials: p.initials, worktreeOf: p.worktreeOf || null })),
    open: sessions.ids(),
    git: lastAllGit
  };
}

const remoteHost = createRemoteHost({
  getDevices: () => remoteCfg.devices,
  onDeviceSeen: (id) => saveRemote(remoteConfig.touchDevice(remoteCfg, id, Date.now())),
  snapshot: remoteSnapshot,
  hasSession: (id) => sessions.has(id),
  openProject: (id, cols, rows) => { const ok = startSession(id, cols, rows); if (ok) sendProjects(); return ok; },
  write: (id, data) => sessions.write(id, data),
  resize: (id, cols, rows) => sessions.resize(id, cols, rows),
  restart: (id, cols, rows) => sessions.restart(id, cols, rows),
  closeSession: (id) => closeSession(id),
  log: (e) => console.log('remote control:', e.result, e.device || '')
});

const remote = createRemoteClients({
  getHosts: () => remoteCfg.hosts,
  send,
  onChange: () => { sendProjectsLocal(); sendGitAll(); } // never sendProjects(): two Gremlins paired with each other would echo forever
});

function sendGitAll() {
  send('git:all', { ...lastAllGit, ...remote.git() });
}
ipcMain.handle('git:all', () => ({ ...lastAllGit, ...remote.git() }));

// One at a time: two overlapping runs could leave a second server listening.
let applying = Promise.resolve();
const applyRemoteHost = () => (applying = applying.then(applyRemoteHostNow));
async function applyRemoteHostNow() {
  await remoteHost.close();
  remoteError = '';
  if (!remoteCfg.host.enabled) return;
  const address = remoteCfg.host.address || (remoteConfig.privateInterfaces(os.networkInterfaces())[0] || {}).address;
  try {
    await remoteHost.listen(address, remoteCfg.host.port);
  } catch (err) {
    remoteError = err.code === 'EADDRINUSE' ? `Port ${remoteCfg.host.port} is already in use` : err.code === 'EADDRNOTAVAIL' ? `${address} is not an address of this computer` : err.message;
  }
}

function remoteState() {
  const st = remoteHost.status();
  return {
    host: { enabled: remoteCfg.host.enabled, address: remoteCfg.host.address, port: remoteCfg.host.port, listening: st.listening, boundAddress: st.address, clients: st.clients, error: remoteError },
    interfaces: remoteConfig.privateInterfaces(os.networkInterfaces()),
    devices: remoteConfig.publicDevices(remoteCfg),
    hosts: remote.hosts()
  };
}

ipcMain.handle('remote:get', () => remoteState());
ipcMain.handle('remote:setHost', async (_e, form) => {
  const next = remoteConfig.setHost(remoteCfg, form || {});
  if (next.error) return { error: next.error };
  saveRemote(next.cfg);
  await applyRemoteHost();
  return remoteState();
});
ipcMain.handle('remote:pair', (_e, { name } = {}) => {
  const made = remoteConfig.createDevice(remoteCfg, name);
  saveRemote(made.cfg);
  return { ...remoteState(), code: remoteCrypto.makePairingCode({ device: made.device.id, secret: made.device.secret }) };
});
ipcMain.handle('remote:revoke', (_e, { id } = {}) => {
  saveRemote(remoteConfig.revokeDevice(remoteCfg, id));
  remoteHost.disconnectDevice(id);
  return remoteState();
});
ipcMain.handle('remote:addHost', (_e, form) => {
  const res = remoteConfig.addHost(remoteCfg, form || {});
  if (res.error) return { error: res.error };
  saveRemote(res.cfg);
  remote.sync();
  return remoteState();
});
ipcMain.handle('remote:removeHost', (_e, { id } = {}) => {
  saveRemote(remoteConfig.removeHost(remoteCfg, id));
  remote.sync();
  return remoteState();
});
ipcMain.on('remote:reconnect', (_e, hostId) => remote.reconnect(hostId));
```

Note: `lastAllGit` is declared with `let` above this block (in `pollAllGit`'s section), and `remoteHost`/`remote` are used by `sessionSend`/`sendProjects` only at call time, which is after this block has run.

- [ ] **Step 4: Merge remote rows into the lists the renderer sees**

Replace `sendProjects` with these two functions (remote changes use only the first, so a change on one computer never bounces back):

```js
function sendProjectsLocal() {
  send('projects:list', { list: projectList.concat(remote.list()), open: sessions.ids().concat(remote.openIds()), active: activeId, remoteHosts: remote.hosts() });
}
function sendProjects() {
  sendProjectsLocal();
  remoteHost.projectsChanged();
}
```

In `ipcMain.handle('projects:get', ...)` change the return to:

```js
  return { list: projectList.concat(remote.list()), open: sessions.ids().concat(remote.openIds()), active: initialActive(), restore, remoteHosts: remote.hosts() };
```

In `pollAllGit`, replace the line
`if (JSON.stringify(next) !== JSON.stringify(lastAllGit)) { lastAllGit = next; send('git:all', next); }`
with
`if (JSON.stringify(next) !== JSON.stringify(lastAllGit)) { lastAllGit = next; sendGitAll(); remoteHost.projectsChanged(); }`

- [ ] **Step 5: Route namespaced ids**

Replace the `project:open` handler body so it uses `startSession` and routes remote ids first:

```js
ipcMain.handle('project:open', async (_e, { id, cols, rows, link }) => {
  if (remote.has(id)) return remote.open(id, cols, rows); // the active project stays a local one: main's activeId drives local git polling
  if (!startSession(id, cols, rows)) return false;
  if (!link && activeId !== id) {
    activeId = id;
    state.activeProject = id;
    writeJson(statePath, state);
    lastGit = undefined;
    pollGit();
  }
  sendProjects();
  return true;
});
```

(Behavior for local ids is unchanged: the old code started the session only when it was not running, then switched the active project and sent the list.)

At the end of `closeSession(id)` (after `scanProjects();`) add:

```js
  remoteHost.broadcast('closed', { id });
  remoteHost.drop(id);
```

Replace the four PTY routing lines with:

```js
ipcMain.on('pty:input', (_e, { id, data }) => (remote.has(id) ? remote.write(id, data) : aux.has(id) ? aux.write(id, data) : sessions.write(id, data)));
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => (remote.has(id) ? remote.resize(id, cols, rows) : aux.has(id) ? aux.resize(id, cols, rows) : sessions.resize(id, cols, rows)));
ipcMain.on('pty:restart', (_e, { id, cols, rows }) => {
  if (remote.has(id)) return remote.restart(id, cols, rows);
  if (aux.has(id)) return aux.restart(id, cols, rows);
  remoteHost.restarted(id); // a restarted session starts a fresh screen for everyone watching it
  sessions.restart(id, cols, rows);
});
ipcMain.on('session:close', (_e, { id }) => (remote.has(id) ? remote.close(id) : aux.has(id) ? aux.close(id) : closeSession(id)));
```

At the top of the `project:menu` handler, before `const p = projectList.find(...)`, add:

```js
  if (remote.has(id)) {
    // Phase 1: opening is a click, restart is Ctrl+Shift+R, so the menu only has Close.
    if (remote.isOpen(id) && win) Menu.buildFromTemplate([{ label: 'Close session', click: () => remote.close(id) }]).popup({ window: win });
    return;
  }
```

- [ ] **Step 6: Lifecycle**

In the `app.whenReady().then(async () => { ... })` callback, after `createWindow();` add:

```js
    remote.sync();
    applyRemoteHost();
```

In `app.on('will-quit', ...)` add `remoteHost.close();` and `remote.stopAll();` next to `sessions.closeAll();`.

- [ ] **Step 7: Preloads**

In `src/preload.js`, after the `aux: { ... },` block add:

```js
  remote: {
    reconnect: (hostId) => ipcRenderer.send('remote:reconnect', hostId),
    onReplay: on('remote:replay'),
    onReset: on('remote:reset'),
    onSessionEvent: on('remote:sevent')
  },
```

In `src/settings/preload.js`, add inside the `settingsHost` object (after `agents`):

```js
  remote: {
    get: () => ipcRenderer.invoke('remote:get'),
    setHost: (form) => ipcRenderer.invoke('remote:setHost', form),
    pair: (name) => ipcRenderer.invoke('remote:pair', { name }),
    revoke: (id) => ipcRenderer.invoke('remote:revoke', { id }),
    addHost: (form) => ipcRenderer.invoke('remote:addHost', form),
    removeHost: (id) => ipcRenderer.invoke('remote:removeHost', { id }),
    reconnect: (id) => ipcRenderer.send('remote:reconnect', id)
  },
```

- [ ] **Step 8: Check and commit**

Run: `node --check src/main.js; node --check src/preload.js; node --check src/settings/preload.js; npm test`
Expected: no syntax errors; all tests pass.

```bash
git add src/main.js src/preload.js src/settings/preload.js
git commit -m "feat: wire remote host and remote clients into the main process" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Renderer: remote rows, replay, progress, guards

**Files:**
- Modify: `src/renderer/rail.js`, `src/renderer/renderer.js`, `src/renderer/terminals.js`, `src/renderer/styles.css`, `src/tab-prefs.js`
- Test: `test/tab-prefs.test.js` (extend)

**Interfaces:**
- Consumes: the channels and payloads from Task 7.
- Produces: `WidgetRail.withHeaders(list, hosts)`; `createRail({ ..., onHeader(hostId) })`; `createTerminals({ ..., isMuted(id) })`, `terminals.reset(id)` (also clears the exited flag) and `terminals.write(id, data, cb)`; `tab-prefs` treats `r:` ids as temporary.

- [ ] **Step 1: Failing test for tab-prefs**

Open `test/tab-prefs.test.js`, find the existing test that checks `aux:` ids are stripped on load and save, and add this test below it (use the same `require` name the file already uses for the module; shown here as `TP`). The prefs object is `{ order, pinned, names }` (see the header of `src/tab-prefs.js`):

```js
test('remote session ids are never kept between runs, like terminal tabs', () => {
  const prefs = { order: ['r:desk/p', 'aux:3', 'c:\\p'], pinned: ['r:desk/p', 'c:\\p'], names: { 'r:desk/p': 'x', 'aux:3': 'y', 'c:\\p': 'z' } };
  assert.deepEqual(TP.forStorage(prefs), { order: ['c:\\p'], pinned: ['c:\\p'], names: { 'c:\\p': 'z' } });
  const loaded = TP.parse(JSON.stringify(prefs));
  assert.deepEqual(loaded.order, ['c:\\p']);
  assert.deepEqual(loaded.names, { 'c:\\p': 'z' });
});
```

Run: `node --test test/tab-prefs.test.js`
Expected: the new test FAILS (the `r:` entry is kept).

- [ ] **Step 2: Make `r:` temporary**

In `src/tab-prefs.js` change line 9 from
`const temporary = (id) => /^aux:/.test(id);`
to
`const temporary = (id) => /^(aux|r):/.test(id);`
and update the comment above it to mention remote sessions: `// ...and remote sessions (r:host/project) are reconnected by hand each run.`

Run: `node --test test/tab-prefs.test.js`
Expected: PASS.

- [ ] **Step 3: Rail: host header rows**

In `src/renderer/rail.js`:

1. Change the signature to `function createRail({ el, onOpen, onMenu, onAdd, onHeader = () => {} })`.
2. In `makeRow`, replace the click and contextmenu listeners with:

```js
      row.addEventListener('click', () => (row.dataset.hostId ? onHeader(row.dataset.hostId) : onOpen(row.dataset.id)));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!row.dataset.hostId) onMenu(row.dataset.id); });
```

3. In `render`, add `let shown = 0; // Ctrl+1..9 count projects only, not host headers` on the line before `list.forEach((p, i) => {`, and insert this inside the callback, right after the `insertBefore` line:

```js
        if (p.header) {
          row.dataset.id = p.id;
          row.dataset.hostId = p.hostId;
          row.className = 'proj rhead';
          row.querySelector('.pdot').className = `pdot host-${p.state}`;
          row.querySelector('.pname').textContent = p.name;
          row.querySelector('.pinit').textContent = p.initials;
          row.querySelector('.pgit').textContent = '';
          row.title = `${p.name}\n${{ online: 'Connected', connecting: 'Connecting…', offline: 'Not connected', error: 'Cannot connect' }[p.state] || p.state}${p.error ? `\n${p.error}` : ''}${p.state === 'online' || p.state === 'connecting' ? '' : '\nClick to try again'}`;
          return;
        }
        const n = shown++;
```

and in the `row.title` line replace `${i < 9 ? ` with `${n < 9 ? ` and `(Ctrl+${i + 1})` with `(Ctrl+${n + 1})`. After the existing `row.classList.toggle('running', ...)` line add `row.classList.toggle('offline', !!(p.remote && p.remote.offline));`.

4. Add the helper above `return { render, setCollapsed };` and export it:

```js
  return { render, setCollapsed };
  }

  // Local projects first, then each paired computer: a header row (its state) followed by its projects.
  function withHeaders(list, hosts) {
    const out = list.filter((p) => !p.remote);
    for (const h of hosts || []) {
      out.push({ id: `rh:${h.id}`, header: true, hostId: h.id, name: h.name, state: h.state, error: h.error || '', initials: h.name.slice(0, 2).toUpperCase() });
      out.push(...list.filter((p) => p.remote && p.remote.hostId === h.id));
    }
    return out;
  }

  root.WidgetRail = { createRail, withHeaders };
```

(Keep the existing closing braces consistent: the existing file ends `return { render, setCollapsed }; }` then `root.WidgetRail = { createRail };`. Replace that last line with the `withHeaders` function and the new export, as above.)

- [ ] **Step 4: Terminals: reset and write callback**

In `src/renderer/terminals.js`, in the returned object replace
`write: (id, data) => { const t = terms.get(id); if (t) t.term.write(data); },`
with:

```js
      write: (id, data, cb) => { const t = terms.get(id); if (t) t.term.write(data, cb); else if (cb) cb(); },
      reset: (id) => { const t = terms.get(id); if (t) { t.exited = false; t.term.reset(); } },
```

Also in `terminals.js`: add `isMuted = () => false` to the destructured options of `createTerminals({ widget, cfg, host, onProgress, onInput, toast, onFocus = () => {} })`, and make the first line of the `term.onData((data) => {` callback `if (isMuted(id)) return; // xterm answers terminal queries found in a replay; those answers are not typing`.

- [ ] **Step 5: Renderer logic**

In `src/renderer/renderer.js`:

1. After `const isAux = ...` add:

```js
  const isRemote = (id) => typeof id === 'string' && id.startsWith('r:');
  let remoteHosts = [];
  const replaying = new Set(); // remote terminals still parsing a replay: old progress sequences must not count as news
```

2. At the top of `notify()` add `if (isRemote(id)) return; // phase 1: no desktop notifications for remote sessions`.

3. Add `isMuted: (id) => replaying.has(id),` to the options of `createTerminals({`, and replace its `onProgress` option with
`onProgress: (id, state, value) => { if (!replaying.has(id)) applyProgress(id, state, value); }`
and add this function declaration just before `const terminals = ...` (move the old body into it unchanged):

```js
  function applyProgress(id, state, value) {
    if (isAux(id)) return;
    const s = sess(id);
    s.progress = { state, value };
    // A new turn: forget tool calls a previous one left without an end (e.g. interrupted).
    if (state >= 1 && state <= 4 && s.turnStart === null) s.tools = new Map();
    const ended = state === 0 && s.turnStart !== null;
    trackTurn(s, state);
    update(id, { t: 'progress', state });
    if (ended) notify(id, 'finished');
    // Claude may have added or removed files during the turn.
    if (ended && id === activeId) filesPane.refresh();
    if (id === activeId) { renderProgress(); renderFooter(); }
    renderTaskbar();
  }
```

4. After `widget.pty.onRestartActive(...)` add:

```js
  // Remote sessions: the host sends a replay of the screen on attach, and tells us about progress even while nobody is
  // attached (a terminal that exists parses progress itself, so the host's copy is only used when there is none).
  widget.remote.onReplay(({ id, data, progress }) => {
    replaying.add(id);
    terminals.write(id, data, () => {
      replaying.delete(id);
      if (progress) applyProgress(id, progress.state, progress.value || 0); // where the turn is now, not what the replayed history says
    });
  });
  widget.remote.onReset(({ id }) => terminals.reset(id));
  widget.remote.onSessionEvent(({ id, ev }) => {
    if (ev && ev.t === 'progress' && !terminals.has(id)) applyProgress(id, ev.state, ev.value || 0);
  });
```

5. Rail: in `WidgetRail.createRail({...})` add `onHeader: (hostId) => widget.remote.reconnect(hostId),`. In `renderRail` replace `rail.render(projects, {` with `rail.render(WidgetRail.withHeaders(projects, remoteHosts), {`.

6. `widget.projects.onList(({ list, open }) => {` becomes `widget.projects.onList(({ list, open, remoteHosts: hosts }) => {` and its first line gets `remoteHosts = hosts || [];`. Do the same where the startup code uses the result of `widget.projects.get()` (grep for `const initial = await widget.projects.get();`): after it add `remoteHosts = initial.remoteHosts || [];` before the first `renderRail()` that follows.

7. Files pane: change `filesPane.setProject(activeId);` to `filesPane.setProject(isRemote(activeId) ? null : activeId);`. Read `files-pane.js` `setProject` first; if it does not accept `null` (today `setProject(null)` still runs `refresh()`, which leaves the previous project's header), make it clear the header and the list and show a muted line "Files are not available on remote computers yet." instead of calling `widget.files.list`.

8. A failed open of a remote session says so: in `doActivate`, where `toast(`Folder missing: ${p.path}`, 2500)` follows `if (!ok) {`, use `toast(isRemote(id) ? 'Could not open that session on the other computer' : `Folder missing: ${p.path}`, 2500)`. Switcher items (the `items:` line of `WidgetSwitcher.createSwitcher({` for the project switcher, near `git: [WidgetGitBadge...`): change `path: p.path,` to `path: p.remote ? p.remote.hostName : p.path,`.

9. Do not persist remote tab links: in the function containing `localStorage.setItem('tabLinks', TL.stringify(tabLinks, bottom))` (around line 349), before the setItem, drop remote ids from `tabLinks`/`bottom`. Read the function; filter every id for which `isRemote(id)` is true out of the link lists written to storage (keep them in memory).

- [ ] **Step 5b: Tab labels**

The spec labels remote tabs `name · hostname`. Read `makeTab` / the code that builds a project tab's label (`renderer.js`, around line 450) and, for ids where `isRemote(id)` is true, append ` · ${p.remote.hostName}` to the label and put the host name in the tab's title. Keep the rest of the label logic as is.

- [ ] **Step 6: CSS**

Append to `src/renderer/styles.css`:

```css
/* A paired computer in the project rail: header row, then its projects */
.proj.rhead { cursor: pointer; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; opacity: 0.8; margin-top: 6px; }
.proj.rhead:hover { opacity: 1; }
.pdot.host-online { border: 0; background: #57ab5a; }
.pdot.host-connecting { border: 0; background: #d6a642; animation: dot-pulse 1.2s ease-in-out infinite; }
.pdot.host-offline, .pdot.host-error { border: 1.5px solid #8a8580; background: transparent; }
.pdot.host-error { border-color: #e5534b; }
.proj.offline { opacity: 0.45; }
body.rail-collapsed .proj.rhead .pname { display: none; }
body.rail-collapsed .proj.rhead { margin-top: 8px; border-top: 1px solid rgba(255, 255, 255, 0.08); border-radius: 0; }
```

- [ ] **Step 7: Check and commit**

Run: `node --check src/renderer/renderer.js; node --check src/renderer/rail.js; node --check src/renderer/terminals.js; npm test`
Expected: no syntax errors; all tests pass.

```bash
git add src/tab-prefs.js test/tab-prefs.test.js src/renderer
git commit -m "feat: remote sessions in the rail, switcher and terminals" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Settings "Remote" tab

**Files:**
- Modify: `src/settings/settings.html`, `src/settings/settings.js`, `src/settings/settings.css`

**Interfaces:**
- Consumes: `settingsHost.remote.*` and the `remote:get` shape from Task 7.

- [ ] **Step 1: Markup**

In `settings.html`, add a nav button after the Setup one: `<button data-tab="remote">Remote</button>`. Add this section after `<section id="agents" ...>...</section>` (outside the form, like the agents tab):

```html
  <section id="remote" data-tab="remote">
    <p class="intro">Attach to Claude sessions on another computer on your network, or let another computer attach to this one.</p>

    <h2>This computer (host)</h2>
    <p class="hint-block"><b>Anyone holding a pairing code can type into your sessions as you</b>, which is the same as having a shell on this computer. Pair only your own devices, and revoke a device you no longer use. Traffic is encrypted. Windows may ask to allow Gremlin through the firewall the first time.</p>
    <label class="check"><input type="checkbox" id="rm-enabled"> Allow other computers to attach to my sessions</label>
    <label>Network address<select id="rm-address"></select></label>
    <label>Port<input id="rm-port" type="number" min="1024" max="65535"></label>
    <p class="hint-block" id="rm-status"></p>
    <p class="row"><input id="rm-pair-name" placeholder="Name for the new device, e.g. Laptop"><button type="button" id="rm-pair">Pair a new device</button></p>
    <div id="rm-code-box" hidden>
      <p class="hint-block">On the other computer: Settings → Remote → Add a computer. Enter <b id="rm-where"></b> and this code. It is shown once.</p>
      <p class="row"><input id="rm-code" readonly><button type="button" id="rm-copy">Copy</button></p>
    </div>
    <div id="rm-devices"></div>

    <h2>Other computers</h2>
    <div id="rm-hosts"></div>
    <p class="row"><input id="rm-add-name" placeholder="Name, e.g. Desk PC"><input id="rm-add-address" placeholder="Address, e.g. 192.168.1.20"><input id="rm-add-port" type="number" placeholder="Port (47731)"></p>
    <p class="row"><input id="rm-add-code" placeholder="Pairing code (gremlin1.…)"><button type="button" id="rm-add">Add a computer</button></p>
  </section>
```

- [ ] **Step 2: Logic**

In `settings.js`:

1. In `showTab`: add `$('btn-save').hidden = name === 'remote';` and `if (name === 'remote') loadRemote();`.
2. Add before the `// --- Footer` section:

```js
  // --- Remote: this computer as a host, and the computers it connects to ------------
  const when = (ms) => (ms ? new Date(ms).toLocaleString() : 'never');
  const row = (text, detail, buttons) => {
    const r = el('div', 'check-row');
    const body = el('div', 'body');
    body.append(el('div', '', text), el('div', 'detail', detail || ''));
    r.appendChild(body);
    for (const b of buttons) { const btn = el('button', '', b.label); btn.type = 'button'; btn.onclick = b.run; r.appendChild(btn); }
    return r;
  };

  function showRemote(s) {
    const h = s.host;
    $('rm-enabled').checked = h.enabled;
    $('rm-port').value = h.port;
    const sel = $('rm-address');
    sel.replaceChildren(...[{ name: 'Automatic (first private address)', address: '' }, ...s.interfaces].map((i) => {
      const o = el('option', '', i.address ? `${i.name} · ${i.address}` : i.name);
      o.value = i.address;
      return o;
    }));
    sel.value = h.address;
    $('rm-status').textContent = h.error ? `Not listening: ${h.error}` : h.listening ? `Listening on ${h.boundAddress}:${h.port}. ${h.clients} connected.` : h.enabled ? 'Not listening.' : 'Off.';
    $('rm-status').className = h.error ? 'hint-block error' : 'hint-block';
    $('rm-where').textContent = h.listening ? `address ${h.boundAddress} and port ${h.port}` : 'this computer\'s address and port';
    $('rm-devices').replaceChildren(...(s.devices.length ? s.devices : []).map((d) => row(d.name, `Last connected: ${when(d.lastSeen)}`, [{ label: 'Revoke', run: async () => showRemote(await host.remote.revoke(d.id)) }])));
    $('rm-hosts').replaceChildren(...(s.hosts.length ? s.hosts : []).map((x) => row(x.name, `${x.address}:${x.port} · ${{ online: 'Connected', connecting: 'Connecting…', offline: 'Not connected', error: 'Cannot connect' }[x.state] || x.state}${x.error ? ` — ${x.error}` : ''}`, [
      { label: 'Try again', run: () => { host.remote.reconnect(x.id); setTimeout(loadRemote, 600); } },
      { label: 'Remove', run: async () => showRemote(await host.remote.removeHost(x.id)) }
    ])));
  }

  async function loadRemote() { showRemote(await host.remote.get()); }

  async function applyRemoteHost() {
    const res = await host.remote.setHost({ enabled: $('rm-enabled').checked, address: $('rm-address').value, port: Number($('rm-port').value) });
    if (res.error) { setStatus(res.error, 'error'); return loadRemote(); }
    setStatus('');
    showRemote(res);
  }
  for (const id of ['rm-enabled', 'rm-address', 'rm-port']) $(id).onchange = applyRemoteHost;

  $('rm-pair').onclick = async () => {
    const res = await host.remote.pair($('rm-pair-name').value);
    $('rm-pair-name').value = '';
    showRemote(res);
    $('rm-code').value = res.code;
    $('rm-code-box').hidden = false;
    $('rm-code').select();
  };
  $('rm-copy').onclick = async () => {
    $('rm-code').select();
    try { await navigator.clipboard.writeText($('rm-code').value); setStatus('Copied', 'ok'); } catch { setStatus('Press Ctrl+C to copy the selected code', ''); }
  };
  $('rm-add').onclick = async () => {
    const res = await host.remote.addHost({ name: $('rm-add-name').value, address: $('rm-add-address').value, port: $('rm-add-port').value, code: $('rm-add-code').value });
    if (res.error) return setStatus(res.error, 'error');
    for (const id of ['rm-add-name', 'rm-add-address', 'rm-add-port', 'rm-add-code']) $(id).value = '';
    setStatus('Added. It connects now.', 'ok');
    showRemote(res);
    setTimeout(loadRemote, 800);
  };
```

3. The Escape handler (`if (e.key === 'Escape' && tab !== 'agents') window.close();`) stays as is.

- [ ] **Step 3: Styles**

In `settings.css` the form and the agents section share a grid cell: add `#remote` to the selector of the rule that places `#form, #agents` (about line 46, `grid-column` / `grid-row`), or the section lands in the wrong cell. Then add:

```css
#remote { padding: 14px 18px 24px; overflow: auto; }
#remote .row { display: flex; gap: 8px; max-width: 560px; margin: 6px 0; }
#remote .row input { flex: 1; min-width: 0; }
#remote .hint-block.error { color: #e5534b; }
```

- [ ] **Step 4: Check and commit**

Run: `node --check src/settings/settings.js; npm test`

```bash
git add src/settings
git commit -m "feat: Remote tab in Settings for pairing and paired computers" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: End-to-end check with two instances, README, hand-off

**Files:**
- Modify: `README.md`

No automated test covers the renderer, so this task is the verification. Scripts go in the scratchpad directory, not the repo.

- [ ] **Step 1: Start a host and a client on this machine**

Host (terminal 1): `npx electron . --user-data-dir="$TEMP/gremlin-host" --remote-debugging-port=9333`
Client (terminal 2): `npx electron . --user-data-dir="$TEMP/gremlin-client" --remote-debugging-port=9334`
(Delete `Local Storage` in each dir first, as in earlier runs.) Run both in the background.

- [ ] **Step 2: Pair over loopback with CDP**

Drive each instance's Settings window or call the IPC through its main window's `widget`... The Settings window is its own page; open it with a CDP `Runtime.evaluate` in the main window via `widget.openConfig()`, then attach to the new page target on the same debugging port. In the host's Settings → Remote: select "This computer only · 127.0.0.1", tick Allow, click "Pair a new device", read `#rm-code`. In the client's Settings → Remote: Add a computer with address `127.0.0.1`, port from the host status line, and that code.
Expected: the client's host row shows "Connected"; the host's status line shows "1 connected".

- [ ] **Step 3: Verify the main flows** (take a screenshot after each and read it)

1. Client rail: a header row with a green dot and the host's projects below it, with git badges.
2. Click a remote project: the terminal shows the host's Claude session; type a prompt; output streams back.
3. Switch to another remote project and back: the screen is intact.
4. On the host window open the same project: both windows show the same session; typing in either reaches Claude.
5. Kill the host process, watch the client rail dot go grey and the open terminal print `[connection lost, reconnecting…]`; start the host again, the client reconnects and the terminal resets and replays.
6. Revoke the device in the host's Settings while connected: the client row changes to "Cannot connect" with the "rejected this pairing" message and does not retry.
7. Ctrl+Shift+J and the Ctrl+P switcher include remote projects (the switcher row shows the host name).
8. Restart the client: paired hosts reappear and connect; no remote tabs are restored.
9. Pair the two instances with each other as well (each is a host and a client of the other) and change something (open a project on one): both stay quiet afterwards, with no projects traffic looping (watch CPU, or log `sendProjectsLocal` calls for a few seconds).
10. In a remote session with a long, busy screen (run `ls -R /` or similar until it scrolls), switch to another project and back: the screen is not duplicated. Then close and reopen the client: the replay arrives before live output, with no stray characters typed into the prompt.
11. Restart a session from the client while a second viewer is attached: the second viewer's terminal clears and the session works; restarting an exited session also clears it in the host window.

Record anything that does not work and fix it before continuing.

- [ ] **Step 4: Things only the user can verify**

State plainly in the hand-off that these were NOT tested: a second physical computer, the Windows Firewall prompt, DHCP address changes, and Linux. Also list the known limitations:
- A session started by a remote client and later opened in the host window shows a blank screen until Claude redraws (the host window's terminal has no replay).
- A remote user answering a prompt does not clear the "needs you" dot in the host window.
- Host git badges update only while the host window is visible (existing `pollAllGit` behavior).
- Remote desktop notifications are off in phase 1.
- Markdown links, rename, session defaults and worktree actions with a remote project active reach `main.js` with an `r:` id and quietly do nothing.
- Saved layouts can include remote projects; applying one while the host is offline shows the dimmed row and a failed-open toast.
- The remote project menu has only Close (restart is Ctrl+Shift+R, open is a click). The spec listed Open, Restart and Close; this is the one deliberate difference.
- A same-size attach does not force Claude Code to redraw, so after a replay the screen is the host's last output, which is correct unless it was cut mid-sequence (the ring starts with a style reset).

- [ ] **Step 5: README**

In `README.md`, add a "Remote sessions" bullet under the features list and a short section:

```markdown
### Remote sessions

Attach to Claude sessions on another computer on your network. On the computer that runs the sessions, open Settings → Remote, tick **Allow other computers**, and click **Pair a new device**. On the other computer, Settings → Remote → **Add a computer**, enter the address, port and pairing code. The host's projects appear in your project list with their state; click one to attach, start a session, restart it (Ctrl+Shift+R) or close it. Traffic is encrypted. A pairing code gives full access to the host's sessions (a shell as you), so pair only your own devices and revoke ones you stop using. Files, search, Markdown links, session defaults and spend are not available on remote projects yet.
```

- [ ] **Step 6: Final suite and commit**

Run: `npm test`
Expected: all pass.

```bash
git add README.md
git commit -m "docs: README for remote sessions" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Do not push, tag or release. Report to the user what was verified (list from Step 3) and what was not (Step 4), then ask whether to open a PR.

---

## Phase 2 backlog (not in this plan)

Files panel, cross-project search, Markdown popouts, session defaults, worktrees, spend and layouts for remote projects; desktop notifications for remote attention events; installing tools on the host from a remote Setup tab (needs a request type that runs the host's setup step and streams its output back, since the installer opens a terminal window on the host that the remote user cannot see); keychain storage for secrets.
