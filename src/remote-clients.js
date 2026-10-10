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
      onState: () => { if (entries.get(host.id) === entry) onChange(); },
      onEvent: (msg) => {
        if (entries.get(host.id) !== entry) return; // a stopped or replaced client's late events (e.g. 'lost' after stop)
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
    isOpen: (id) => { const p = parts(id); return !!p && p.entry.client.state().state === 'online' && p.entry.snapshot.open.includes(p.projectId); },
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
