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
