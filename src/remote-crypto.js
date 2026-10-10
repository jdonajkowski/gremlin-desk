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
