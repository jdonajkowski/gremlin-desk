// Tab tidying: your own order, pins and names for the tabs of a project. A plain object
// { order: [tabId], pinned: [tabId], names: { [tabId]: name } }; the renderer owns the DOM and storage.
// The first tab (the project's Claude session) always stays first. Pinned tabs come right after it.
// Loaded by the renderer as a plain <script> (window.WidgetTabPrefs) and by tests via require.
(function (root) {
  const empty = () => ({ order: [], pinned: [], names: {} });

  // Terminal tabs are numbered again in every run (aux:1, aux:2...), so their names and pins are not kept between runs.
  // ...and remote sessions (r:host/project) are reconnected by hand each run.
  const temporary = (id) => /^(aux|r):/.test(id);

  function parse(text) {
    let v;
    try { v = JSON.parse(text); } catch { return empty(); }
    if (!v || typeof v !== 'object') return empty();
    const names = {};
    for (const [k, n] of Object.entries(v.names && typeof v.names === 'object' ? v.names : {})) if (typeof n === 'string' && n.trim()) names[k] = n.slice(0, 40);
    const ids = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && !temporary(x)) : []);
    for (const k of Object.keys(names)) if (temporary(k)) delete names[k];
    return { order: ids(v.order), pinned: ids(v.pinned), names };
  }

  // What is written to storage: everything except the terminal tabs of this run.
  function forStorage(prefs) {
    const names = {};
    for (const [k, n] of Object.entries(prefs.names)) if (!temporary(k)) names[k] = n;
    return { order: prefs.order.filter((x) => !temporary(x)), pinned: prefs.pinned.filter((x) => !temporary(x)), names };
  }

  // ids in their natural order (Claude session first) -> display order.
  function arrange(ids, prefs) {
    const [first, ...rest] = ids;
    const rank = (id) => { const i = prefs.order.indexOf(id); return i < 0 ? Infinity : i; };
    const sorted = rest.map((id, i) => ({ id, i, pin: prefs.pinned.includes(id) ? 0 : 1 }))
      .sort((a, b) => a.pin - b.pin || rank(a.id) - rank(b.id) || a.i - b.i)
      .map((x) => x.id);
    return first === undefined ? [] : [first, ...sorted];
  }

  // Moves id to just before beforeId (or to the end). ids: the current display order.
  function move(prefs, ids, id, beforeId) {
    const rest = ids.slice(1).filter((x) => x !== id);
    if (!ids.slice(1).includes(id)) return prefs;
    const at = beforeId ? rest.indexOf(beforeId) : -1;
    if (at < 0) rest.push(id); else rest.splice(at, 0, id);
    return { ...prefs, order: rest };
  }

  function togglePin(prefs, id) {
    const pinned = prefs.pinned.includes(id) ? prefs.pinned.filter((x) => x !== id) : [...prefs.pinned, id];
    return { ...prefs, pinned };
  }

  function rename(prefs, id, name) {
    const names = { ...prefs.names };
    const n = String(name || '').trim().slice(0, 40);
    if (n) names[id] = n; else delete names[id];
    return { ...prefs, names };
  }

  const nameOf = (prefs, id, fallback) => prefs.names[id] || fallback;
  const isPinned = (prefs, id) => prefs.pinned.includes(id);

  // Forgets tabs that no longer exist (terminals get a new id every run).
  function prune(prefs, liveIds) {
    const live = new Set(liveIds);
    const names = {};
    for (const [k, n] of Object.entries(prefs.names)) if (live.has(k)) names[k] = n;
    return { order: prefs.order.filter((x) => live.has(x)), pinned: prefs.pinned.filter((x) => live.has(x)), names };
  }

  const api = { empty, parse, forStorage, arrange, move, togglePin, rename, nameOf, isPinned, prune };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WidgetTabPrefs = api;
})(this);
