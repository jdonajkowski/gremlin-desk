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
