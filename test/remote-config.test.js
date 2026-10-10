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

test('decorate: skips entries without a usable id and tolerates a non-array', () => {
  const out = R.decorate('desk', 'Desk PC', [null, 3, { name: 'x' }, { id: '', name: 'y' }, { id: 7, name: 'z' }, { id: 'ok', name: 'good' }]);
  assert.deepEqual(out.map((p) => p.id), ['r:desk/ok']);
  assert.deepEqual(R.decorate('desk', 'Desk PC', 'nope'), []);
  assert.deepEqual(R.decorate('desk', 'Desk PC', null), []);
});
