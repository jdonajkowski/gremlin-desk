/* global WidgetZones, WidgetTabLinks, WidgetNotify, WidgetSwitcher, WidgetWorkers, WidgetFooter, WidgetSessionState, WidgetMascotState, WidgetGuardRoutine, WidgetGuardActor, GuardPoses, WidgetTerminals, WidgetRail, WidgetFilesPane */
(async () => {
  const { widget } = window;
  const cfg = await widget.getConfig();
  const $ = (id) => document.getElementById(id);

  if (cfg.transparent) document.body.classList.add('transparent');
  document.documentElement.style.setProperty('--bg', cfg.theme.background);

  // --- toast -------------------------------------------------------------
  const toastEl = $('toast');
  let toastTimer;
  const toast = (msg, ms = 1200) => {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  };
  widget.onToast((msg) => toast(msg, 4000));

  // --- Per-session cache: dot state, worker events, footer status, progress, turn timer ---
  const SS = WidgetSessionState;
  const cache = new Map();
  const sess = (id) => {
    if (!cache.has(id)) {
      cache.set(id, { state: SS.initial(), workerEvents: [], tools: new Map(), status: null, git: null, progress: { state: 0, value: 0 }, turnStart: null, lastTurnMs: null });
    }
    return cache.get(id);
  };
  let projects = [];
  let openIds = new Set();
  let activeId = null;

  const isAux = (id) => typeof id === 'string' && id.startsWith('aux:');
  const isRemote = (id) => typeof id === 'string' && id.startsWith('r:');
  let remoteHosts = [];
  const replaying = new Set(); // remote terminals still parsing a replay: old progress sequences must not count as news

  // A desktop notification (shown by main.js) for a session you are not looking at: Gremlin is in the background,
  // or that session is not on screen. Whether the setting is on is checked by main.
  function notify(id, kind, reason) {
    if (isRemote(id)) return; // phase 1: no desktop notifications for remote sessions
    const shownIds = activeId && terminals.has(activeId) ? currentLayout().front.filter(Boolean) : [];
    if (!WidgetNotify.shouldNotify({ enabled: true, id, windowFocused: document.hasFocus(), shownIds })) return;
    const p = projects.find((x) => x.id === id);
    widget.notify.show({ id, ...WidgetNotify.message(kind, p && p.name, reason) });
  }
  const update = (id, ev) => {
    if (isAux(id)) return;
    const s = sess(id);
    s.state = SS.apply(s.state, ev, id === activeId);
    renderRail();
    renderMascot();
    if (Object.keys(tabLinks).length) renderStrips(currentLayout()); // the state dot on a project's tab
  };

  // What the Gremlin acts out follows Claude (mascot-state.js): a ? bubble while any open session has a
  // question waiting, else the shown session's turn: drumming fingers while a tool or subagent runs,
  // a thought bubble in between. Idle, it just blinks and now and then waves.
  const MS = WidgetMascotState;
  const MOODS = ['question', 'working', 'thinking'];
  let mood = 'idle';
  // Guarding (below the mascot setup): out of the rail after guardMinutes with nothing happening.
  let guarding = false;
  let lastActive = Date.now();
  function renderMascot() {
    const s = activeId ? sess(activeId) : null;
    const question = [...openIds].some((id) => cache.has(id) && cache.get(id).state.attention);
    const agents = s ? WidgetWorkers.reduce(s.workerEvents, Date.now()).filter((w) => w.kind === 'agent' && w.doneAt === null).length : 0;
    const next = MS.mood({ question, turn: !!(s && s.state.working), tools: s ? MS.running(s.tools) : 0, agents });
    if (next !== 'idle') noteActivity(); // Claude busy or asking: back to the rail, where the moods show
    if (next === mood) return;
    mood = next;
    const el = $('mascot');
    for (const m of MOODS) el.classList.toggle(m, m === next);
    if (next !== 'idle') el.classList.remove('wave');
  }

  // --- Terminals ----------------------------------------------------------
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
  const terminals = WidgetTerminals.createTerminals({
    widget,
    cfg,
    host: $('terminal'),
    toast,
    onFocus: (id) => focusTab(id),
    // Only real typing answers a question; focus/mouse reports and query replies also come through here.
    onInput: (id, data) => { if (SS.isTyping(data)) update(id, { t: 'input' }); },
    isMuted: (id) => replaying.has(id),
    onProgress: (id, state, value) => { if (!replaying.has(id)) applyProgress(id, state, value); }
  });
  terminals.setOnRestart((id) => {
    if (isAux(id)) return renderTabs();
    cache.delete(id);
    update(id, { t: 'start' });
    if (id === activeId) renderActive();
    renderTaskbar();
  });

  widget.pty.onData(({ id, data }) => terminals.write(id, data));
  widget.pty.onExit(({ id, code }) => {
    terminals.markExited(id, code);
    if (isAux(id)) return renderTabs();
    const s = sess(id);
    s.progress = { state: 0, value: 0 };
    trackTurn(s, 0);
    update(id, { t: 'exit' });
    // Claude is gone, so its workers are too: stop their rows showing as running.
    s.workerEvents = s.workerEvents.concat(WidgetWorkers.stopAll(s.workerEvents, Date.now()));
    renderMascot();
    if (id === activeId) renderActive();
    renderTaskbar();
  });
  widget.pty.onRestartActive(() => activeId && terminals.restart(activeId));

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

  // --- Rail ---------------------------------------------------------------
  const rail = WidgetRail.createRail({
    el: $('rail'),
    onOpen: (id) => activate(id),
    onMenu: (id) => widget.projects.menu(id),
    onAdd: () => widget.projects.addMenu(),
    onHeader: (hostId) => widget.remote.reconnect(hostId)
  });
  rail.setCollapsed(cfg.rail.collapsed, cfg.rail.width);
  widget.rail.onState(({ collapsed, width }) => rail.setCollapsed(collapsed, width));
  $('btn-rail').onclick = () => widget.rail.toggle();

  // Drag the rail's right edge to resize it (main.js clamps the width and keeps it); double-click resets it.
  const railResize = $('rail-resize');
  const setRailWidth = (w, final) => { rail.setCollapsed(false, w); widget.rail.resize(w, final); };
  railResize.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    railResize.setPointerCapture(e.pointerId);
    document.body.classList.add('rail-resizing');
    const startX = e.clientX;
    const startW = $('rail').getBoundingClientRect().width;
    let w = startW;
    const onMove = (ev) => { w = Math.round(startW + ev.clientX - startX); setRailWidth(w, false); };
    const onUp = () => {
      railResize.removeEventListener('pointermove', onMove);
      railResize.removeEventListener('pointerup', onUp);
      railResize.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('rail-resizing');
      setRailWidth(w, true);
    };
    railResize.addEventListener('pointermove', onMove);
    railResize.addEventListener('pointerup', onUp);
    railResize.addEventListener('pointercancel', onUp);
  });
  railResize.addEventListener('dblclick', () => setRailWidth(170, true));

  // The gremlin peeking up over the ledge at the bottom of the project list. It ducks when the mouse comes
  // near and peeks back up a moment later.
  const mascot = $('mascot');
  let duckTimer;
  document.body.classList.toggle('no-mascot', cfg.showMascot === false);
  mascot.addEventListener('mouseenter', () => {
    mascot.classList.add('ducking');
    clearTimeout(duckTimer);
    duckTimer = setTimeout(() => mascot.classList.remove('ducking'), 1600);
  });

  // It blinks every few seconds (sometimes twice) and now and then waves. Skipped while it can't be seen,
  // and entirely when Windows asks for less animation.
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');
  // The rail copy only: while Glitch is out guarding he is a pose card (guard-actor.js) and the rail copy is hidden.
  const play = (cls) => {
    if (guarding || still.matches || document.hidden || mascot.classList.contains('ducking') || mascot.offsetParent === null) return;
    mascot.classList.remove(cls);
    void mascot.getBoundingClientRect(); // restart the animation if it is already set
    mascot.classList.add(cls);
  };
  const endPlay = (e) => {
    if (e.animationName === 'm-blink') e.currentTarget.classList.remove('blink');
    if (e.animationName === 'm-wave') e.currentTarget.classList.remove('wave');
  };
  mascot.addEventListener('animationend', endPlay);
  const later = (min, max, fn) => setTimeout(fn, min + Math.random() * (max - min));
  const blinkLoop = () => later(2500, 6500, () => {
    play('blink');
    if (Math.random() < 0.2) later(300, 360, () => play('blink'));
    blinkLoop();
  });
  const waveLoop = () => later(25000, 70000, () => { if (mood === 'idle') play('wave'); waveLoop(); });
  blinkLoop();
  waveLoop();

  // --- Guarding: after guardMinutes with no key, click or mouse movement in Gremlin and nothing from Claude,
  // Glitch climbs out over the bottom edge of the terminal, pulls his spear up from below it and patrols along
  // it, now and then stopping to chew a cable or type (guard-routine.js decides, guard-actor.js draws the pose
  // cards). Any activity ducks him straight back to the rail.
  const GR = WidgetGuardRoutine;
  const guardActor = WidgetGuardActor.createGuardActor({ hostEl: $('terminal'), poses: GuardPoses.poses });
  let guardMs = (cfg.guardMinutes ?? 5) * 60000;
  let deploying = false;
  let guardRun = 0;

  function noteActivity() {
    lastActive = Date.now();
    if (guarding) recall();
  }
  for (const type of ['keydown', 'mousedown', 'mousemove', 'wheel', 'resize']) window.addEventListener(type, noteActivity, { capture: true, passive: true });
  const guardCheck = () => ({ guarding, deploying, guardMs, lastActive, now: Date.now(), mood, hidden: document.hidden, modalOpen: !$('modal').hidden });
  setInterval(() => { if (GR.canDeploy(guardCheck())) deploy(); }, 5000);

  async function deploy() {
    if (document.body.classList.contains('no-mascot') || mascot.offsetParent === null) return;
    const host = $('terminal').getBoundingClientRect();
    if (!mascot.getBoundingClientRect().width || host.width < 260 || host.height < 160) return;
    deploying = true;
    try {
      await guardActor.load();
    } catch (err) {
      console.warn(`Glitch stays on the rail: ${err.message}`); // a missing pose card must not leave a half-drawn guard
      return;
    } finally {
      deploying = false;
    }
    // The poses took a moment to load: only go if nothing happened meanwhile.
    if (!GR.canDeploy(guardCheck())) return;
    guarding = true;
    mascot.classList.add('away');
    if (still.matches) return guardActor.deployStill();
    guardActor.deploy();
    const mine = ++guardRun;
    let state = GR.initial(Math.random);
    while (guarding && guardRun === mine) {
      const out = GR.advance(state, Math.random);
      state = out.state;
      if (!(await guardActor.run(out.step))) break;
    }
  }

  function recall() {
    guarding = false;
    guardRun++;
    guardActor.recall();
    // Back on the ledge: starts ducked and peeks up.
    mascot.classList.add('ducking');
    mascot.classList.remove('away');
    clearTimeout(duckTimer);
    duckTimer = setTimeout(() => mascot.classList.remove('ducking'), 350);
  }
  // --- Files pane ---------------------------------------------------------
  const filesPane = WidgetFilesPane.createFilesPane({ el: $('files'), widget, open: cfg.filesOpen });
  $('btn-files').onclick = () => { filesPane.toggle(); terminals.focus(); };
  $('btn-browser').onclick = () => widget.browser.open();
  $('btn-run').onclick = () => widget.menus.run();
  $('btn-admin').onclick = () => widget.menus.admin();
  $('btn-workbench').onclick = () => widget.workbench.open();

  let gitAll = {}; // every project's git state, from main (polled)
  widget.status.onGitAll((all) => { gitAll = all || {}; renderRail(); });
  widget.status.gitAll().then((all) => { gitAll = all || {}; renderRail(); });

  function renderRail() {
    rail.render(WidgetRail.withHeaders(projects, remoteHosts), { active: activeId, open: openIds, dot: (id) => SS.dot(sess(id).state), git: (id) => WidgetGitBadge.badge(gitAll[id]) });
  }

  widget.projects.onList(({ list, open, remoteHosts: hosts }) => {
    remoteHosts = hosts || [];
    projects = list;
    openIds = new Set(open);
    renderRail();
    renderTitle(); // the active project may have been renamed
    renderMascot();
  });
  widget.projects.onSelect(({ id }) => activate(id));
  widget.projects.onClosed(({ id }) => {
    for (const host of Object.keys(tabLinks)) tabLinks = TL.remove(tabLinks, host, id); // a closed session is not a tab anywhere
    terminals.destroy(id);
    cache.delete(id);
    openIds.delete(id);
    renderRail();
    renderTaskbar();
    renderMascot();
    if (id === activeId) {
      showPlaceholder('Session closed. Press Enter or click the project to start it again.');
      renderActive();
    }
  });

  // --- Switching ----------------------------------------------------------
  const placeholderEl = $('placeholder');
  function showPlaceholder(text) {
    placeholderEl.textContent = text;
    placeholderEl.hidden = !text;
  }

  let switching = Promise.resolve();
  function activate(id) {
    switching = switching.then(() => doActivate(id)).catch(() => {});
    return switching;
  }

  async function doActivate(id) {
    const p = projects.find((x) => x.id === id);
    if (!p) return;
    if (p.missing && !terminals.has(id)) return toast(`Folder missing: ${p.path}`, 2500);
    const fresh = !terminals.has(id);
    if (fresh) terminals.create(id);
    const t = terminals.show(id);
    const ok = await widget.projects.open(id, t.term.cols, t.term.rows);
    if (!ok) {
      terminals.destroy(id);
      toast(isRemote(id) ? 'Could not open that session on the other computer' : `Folder missing: ${p.path}`, 2500);
      if (activeId && terminals.has(activeId)) terminals.show(activeId);
      return;
    }
    activeId = id;
    openIds.add(id);
    showPlaceholder('');
    update(id, { t: 'activate' });
    renderActive();
    terminals.focus();
    restoreLinks(id);
  }

  // --- Terminal tabs: the project's Claude session plus Run-menu tasks, terminals and admin shells ---
  // Split view (src/zones.js) stacks two zones, each with its own tab strip; tabs move between them by
  // dragging, Ctrl+Shift+M or the split button. Ctrl+Shift+\ splits and unsplits.
  const Z = WidgetZones;
  const hosts = [$('terminal'), $('terminal-b')];
  const strips = [$('tabs'), $('tabs-b')];
  const zoneEls = [$('zone-a'), $('zone-b')];
  const splitterEl = $('splitter');
  const dropEl = $('split-drop');
  let auxList = [];
  const zoneState = new Map(); // project id -> zones state
  const zst = () => zoneState.get(activeId) || Z.initial();
  const setZst = (st) => { if (activeId) zoneState.set(activeId, st); };
  // Other projects' Claude sessions shown as tabs of a project (Open in tab, src/tab-links.js). The links and which
  // of them sat in the lower zone are remembered; a project's links come back when it is first shown after a start.
  const TL = WidgetTabLinks;
  const savedLinks = (() => { try { return TL.parse(localStorage.getItem('tabLinks')); } catch { return TL.parse(null); } })();
  let tabLinks = savedLinks.links;
  const linkedOf = (p) => TL.of(tabLinks, p).filter((id) => terminals.has(id));
  function saveLinks() {
    const bottom = {};
    for (const host of Object.keys(tabLinks)) {
      const st = zoneState.get(host);
      // A project not shown yet this run keeps what was saved for it.
      const kept = st ? TL.of(tabLinks, host).filter((id) => st.split && st.zone[id] === 1) : TL.of(savedLinks.bottom, host);
      if (kept.length) bottom[host] = kept;
    }
    // Remote sessions are reconnected by hand each run: never stored, as host or as linked tab.
    const stored = (m) => { const out = {}; for (const [host, ids] of Object.entries(m)) { const keep = ids.filter((id) => !isRemote(id)); if (!isRemote(host) && keep.length) out[host] = keep; } return out; };
    try { localStorage.setItem('tabLinks', TL.stringify(stored(tabLinks), stored(bottom))); } catch { /* storage off */ }
  }
  // Your own tab order, pins and names (Right-click a tab; drag a tab onto another to reorder).
  const TP = WidgetTabPrefs;
  let tabPrefs = (() => { try { return TP.parse(localStorage.getItem('tabPrefs')); } catch { return TP.empty(); } })();
  function saveTabPrefs(next) {
    tabPrefs = TP.prune(next, [...auxList.map((a) => a.id), ...projects.map((p) => p.id)]);
    try { localStorage.setItem('tabPrefs', JSON.stringify(TP.forStorage(tabPrefs))); } catch { /* storage off */ }
    renderTabs();
  }
  const tabIds = () => (activeId ? TP.arrange([activeId, ...auxList.filter((a) => a.projectId === activeId).map((a) => a.id), ...linkedOf(activeId)].filter((id) => terminals.has(id)), tabPrefs) : []);
  const currentLayout = () => Z.layout(zst(), tabIds());
  const shownView = () => currentLayout().focused || activeId;
  let splitRatio = 0.6;
  try { splitRatio = Math.min(0.85, Math.max(0.15, Number(localStorage.getItem('splitRatio')) || 0.6)); } catch { /* storage off */ }

  function showView(id) {
    if (!terminals.has(id)) return;
    setZst(Z.show(zst(), tabIds(), id));
    renderTabs(true);
  }

  // A click into a terminal: its zone becomes the focused one.
  function focusTab(id) {
    if (!tabIds().includes(id)) return;
    const L = currentLayout();
    if (L.focused === id) return;
    setZst(Z.show(zst(), tabIds(), id));
    renderStrips(currentLayout());
  }

  function moveTab(id, zone) {
    setZst(Z.moveTo(zst(), tabIds(), id, zone));
    renderTabs(true);
  }

  function toggleSplit() {
    const ids = tabIds();
    if (currentLayout().split) {
      setZst(Z.unsplit(zst(), ids));
      return renderTabs(true);
    }
    const pick = Z.splitCandidate(zst(), ids);
    if (pick) return moveTab(pick, 1);
    widget.aux.newShell(activeId); // arrives through aux:select with zone 1
  }

  function tabInfo(id) {
    if (id === activeId) return { id, title: 'Claude', kind: 'claude', running: true };
    const a = auxList.find((x) => x.id === id);
    if (a) return a;
    const p = projects.find((x) => x.id === id);
    return { id, title: p ? p.name : id, kind: 'claude', linked: true, running: openIds.has(id) };
  }

  // Open in tab: another project's Claude session joins this project's tabs (it keeps running when removed).
  // quiet: bringing back a saved link, so the tab appears without taking focus.
  async function linkProject(id, { quiet = false } = {}) {
    const p = projects.find((x) => x.id === id);
    if (!p || !activeId || id === activeId) return;
    if (p.missing && !terminals.has(id)) return quiet ? undefined : toast(`Folder missing: ${p.path}`, 2500);
    const host = activeId;
    const fresh = !terminals.has(id);
    if (fresh) terminals.create(id);
    tabLinks = TL.add(tabLinks, host, id);
    if (!quiet) setZst(Z.show(zst(), tabIds(), id));
    renderTabs(!quiet); // lays it out and fits it, so the session starts at its real size
    const t = terminals.get(id);
    const ok = await widget.projects.open(id, t.term.cols, t.term.rows, true);
    if (!ok) {
      tabLinks = TL.remove(tabLinks, host, id);
      if (fresh) terminals.destroy(id);
      renderTabs(!quiet);
      return quiet ? undefined : toast(`Folder missing: ${p.path}`, 2500);
    }
    openIds.add(id);
    update(id, { t: 'activate' });
    renderRail();
  }

  function unlinkProject(id) {
    tabLinks = TL.remove(tabLinks, activeId, id);
    setZst(Z.normalize(zst(), tabIds()));
    renderTabs(true);
  }
  widget.projects.onLinkTab(({ id }) => linkProject(id));

  // First time a project is shown in this run: its saved links come back (their sessions start), lower-zone ones below.
  const linksRestored = new Set();
  async function restoreLinks(host) {
    if (linksRestored.has(host)) return;
    linksRestored.add(host);
    const down = TL.of(savedLinks.bottom, host);
    for (const id of TL.of(tabLinks, host)) {
      if (activeId !== host) { linksRestored.delete(host); return; } // switched away: try again next time
      if (!projects.some((x) => x.id === id)) { tabLinks = TL.remove(tabLinks, host, id); continue; } // folder gone
      await linkProject(id, { quiet: true });
      if (activeId === host && down.includes(id) && tabIds().includes(id)) moveTab(id, 1);
    }
  }

  function makeTab(t, on) {
    const el = document.createElement('div');
    el.className = `tab k-${t.kind}${on ? ' on' : ''}${t.running ? '' : ' exited'}`;
    el.title = t.kind === 'admin' ? 'Administrator terminal' : t.kind === 'admin-claude' ? 'Claude running as administrator' : t.linked ? `${t.title}: its Claude session (drag to the other zone to split)` : `${t.title} (drag to the other zone to split)`;
    el.draggable = true;
    const label = document.createElement('span');
    label.className = 'tlabel';
    label.textContent = (t.kind.startsWith('admin') ? '⛨ ' : '') + (TP.isPinned(tabPrefs, t.id) ? '▪ ' : '') + TP.nameOf(tabPrefs, t.id, t.title);
    // A remote session's tab says which computer it runs on.
    const remoteHost = isRemote(t.id) ? (projects.find((x) => x.id === t.id) || {}).remote : null;
    if (remoteHost) { label.textContent += ` · ${remoteHost.hostName}`; el.title += `\nOn ${remoteHost.hostName}`; }
    // A project's Claude session (the first tab, or one opened in a tab) shows its state like the sidebar does.
    if (t.kind === 'claude') {
      const dot = document.createElement('span');
      dot.className = `pdot ${openIds.has(t.id) ? SS.dot(sess(t.id).state) : 'idle'}`;
      el.appendChild(dot);
    }
    el.appendChild(label);
    // A linked project tab only leaves this view: its session keeps running.
    const close = () => (t.linked ? unlinkProject(t.id) : widget.aux.close(t.id));
    const closable = (t.kind !== 'claude' || t.linked) && !TP.isPinned(tabPrefs, t.id); // a pinned tab has to be unpinned first
    if (closable) {
      const x = document.createElement('button');
      x.className = 'tclose';
      x.textContent = '×';
      x.title = t.linked ? 'Remove from this view (the session keeps running)' : 'Close';
      x.onclick = (e) => { e.stopPropagation(); close(); };
      el.appendChild(x);
    }
    el.onclick = () => showView(t.id);
    el.onauxclick = (e) => { if (e.button === 1 && closable) close(); };
    const rename = () => ask({
      title: 'Rename tab',
      text: 'Only changes the name shown on the tab. Leave it empty to go back to the original.',
      value: TP.nameOf(tabPrefs, t.id, ''),
      ok: 'Rename',
      submit: async (name) => { saveTabPrefs(TP.rename(tabPrefs, t.id, name)); return null; }
    });
    el.ondblclick = rename;
    el.oncontextmenu = async (e) => {
      e.preventDefault();
      const L = currentLayout();
      const action = await widget.tabs.menu({ pinned: TP.isPinned(tabPrefs, t.id), closable: t.kind !== 'claude' || t.linked, split: L.split });
      if (action === 'rename') rename();
      else if (action === 'pin') saveTabPrefs(TP.togglePin(tabPrefs, t.id));
      else if (action === 'close') close();
      else if (action === 'move' && t.id !== tabIds()[0]) moveTab(t.id, L.split ? 1 - (L.zones[1].includes(t.id) ? 1 : 0) : 1);
    };
    // Dropping another tab on this one puts it just before this one (moving it into this zone first if needed).
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-widget-tab')) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.add('drop-before');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-before'));
    el.addEventListener('drop', (e) => {
      const id = e.dataTransfer.getData('application/x-widget-tab');
      el.classList.remove('drop-before');
      document.body.classList.remove('dragging-tab');
      dropEl.hidden = true;
      if (!id || id === t.id || t.id === tabIds()[0]) return;
      e.preventDefault();
      e.stopPropagation();
      const L = currentLayout();
      const zoneOfTarget = L.zones[1].includes(t.id) ? 1 : 0;
      if (L.split && !L.zones[zoneOfTarget].includes(id)) moveTab(id, zoneOfTarget);
      saveTabPrefs(TP.move(tabPrefs, tabIds(), id, t.id));
    });
    el.ondragstart = (e) => {
      e.dataTransfer.setData('application/x-widget-tab', t.id);
      e.dataTransfer.effectAllowed = 'move';
      document.body.classList.add('dragging-tab');
      dropEl.hidden = currentLayout().split;
    };
    el.ondragend = () => { document.body.classList.remove('dragging-tab'); dropEl.hidden = true; };
    return el;
  }

  function splitButton(split) {
    const b = document.createElement('button');
    b.className = 'tsplit';
    b.textContent = split ? '▭' : '⬓';
    b.title = split ? 'Back to one zone (Ctrl+Shift+\\)' : 'Split into two zones (Ctrl+Shift+\\)';
    b.onclick = () => toggleSplit();
    return b;
  }

  function renderStrips(L) {
    const multi = tabIds().length > 1;
    strips.forEach((strip, z) => {
      const ids = L.zones[z];
      strip.hidden = z === 1 ? !L.split : !multi && !L.split;
      strip.classList.toggle('focused', L.split && L.focus === z);
      if (strip.hidden) { strip.replaceChildren(); return; }
      strip.replaceChildren(...ids.map((id) => makeTab(tabInfo(id), id === L.front[z])));
      if (z === 0) strip.appendChild(splitButton(L.split));
    });
    const front = L.focused && auxList.find((a) => a.id === L.focused);
    document.body.classList.toggle('admin-view', !!front && front.kind.startsWith('admin'));
  }

  // Lays out the active project's tabs: each terminal into its zone, the front one of each zone shown.
  function renderTabs(focus = false) {
    const L = currentLayout();
    zoneEls[1].hidden = !L.split;
    splitterEl.hidden = !L.split;
    zoneEls[0].style.flex = L.split ? `${splitRatio} 1 0` : '';
    zoneEls[1].style.flex = L.split ? `${1 - splitRatio} 1 0` : '';
    L.zones.forEach((ids, z) => ids.forEach((id) => terminals.place(id, hosts[z])));
    if (activeId && terminals.has(activeId)) {
      terminals.showOnly(L.front.filter(Boolean), L.focused);
      if (focus) terminals.focus();
    }
    renderStrips(L);
    saveLinks();
  }

  // Dropping a tab on a zone (its strip or terminal) moves it there; on the drop area below, splits.
  const dropTargets = [[zoneEls[0], 0], [zoneEls[1], 1], [dropEl, 1]];
  for (const [el, zone] of dropTargets) {
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-widget-tab')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-over');
    });
    el.addEventListener('dragleave', (e) => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop-over'); });
    el.addEventListener('drop', (e) => {
      const id = e.dataTransfer.getData('application/x-widget-tab');
      el.classList.remove('drop-over');
      document.body.classList.remove('dragging-tab');
      dropEl.hidden = true;
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      // Dropped on the top zone while unsplit: nothing to do.
      if (zone === 0 && !currentLayout().split) return;
      moveTab(id, zone);
    });
  }

  // Dragging the bar between the zones sets their heights.
  splitterEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    splitterEl.setPointerCapture(e.pointerId);
    const box = $('center').getBoundingClientRect();
    const onMove = (ev) => {
      splitRatio = Math.min(0.85, Math.max(0.15, (ev.clientY - box.top) / box.height));
      zoneEls[0].style.flex = `${splitRatio} 1 0`;
      zoneEls[1].style.flex = `${1 - splitRatio} 1 0`;
    };
    const onUp = () => {
      splitterEl.removeEventListener('pointermove', onMove);
      splitterEl.removeEventListener('pointerup', onUp);
      try { localStorage.setItem('splitRatio', String(splitRatio)); } catch { /* storage off */ }
      terminals.fitActive();
    };
    splitterEl.addEventListener('pointermove', onMove);
    splitterEl.addEventListener('pointerup', onUp);
  });

  function applyAux(list) {
    const ids = new Set(list.map((a) => a.id));
    for (const a of auxList) if (!ids.has(a.id)) terminals.destroy(a.id);
    for (const a of list) if (!terminals.has(a.id)) terminals.create(a.id);
    auxList = list;
    renderJobs();
    // A closed tab leaves its zone; a zone left empty merges back into one.
    for (const [p, st] of zoneState) {
      const pids = [p, ...list.filter((a) => a.projectId === p).map((a) => a.id), ...linkedOf(p)];
      zoneState.set(p, Z.normalize(st, pids));
    }
    renderTabs();
  }
  widget.aux.onList(applyAux);
  widget.aux.onSelect(async ({ id, projectId, zone }) => {
    if (projectId !== activeId) await activate(projectId);
    if (!terminals.has(id)) applyAux(await widget.aux.get());
    if (zone === 1 && id !== activeId) return moveTab(id, 1);
    showView(id);
  });

  // Title bar and window title (taskbar, Alt+Tab): "Gremlin - <project>".
  function renderTitle() {
    const p = projects.find((x) => x.id === activeId);
    document.title = $('title-text').textContent = p ? `Gremlin - ${p.name}` : 'Gremlin';
    $('title').title = p ? p.path : '';
  }

  // Everything that shows the active session: title, progress strip, workers, footer.
  function renderActive() {
    renderTitle();
    widget.view.setRemote(isRemote(activeId));
    if (isRemote(activeId)) filesPane.setProject(null, 'Files are not available on remote computers yet.');
    else filesPane.setProject(activeId);
    renderTabs();
    const t = activeId && terminals.get(activeId);
    document.body.classList.toggle('exited', !t || t.exited);
    rowEls.forEach((el) => el.remove());
    rowEls.clear();
    renderProgress();
    renderWorkers();
    renderJobs();
    renderFooter();
    renderRail();
    renderMascot();
  }

  // --- OSC 9;4 progress: strip shows the active session, taskbar is busy while any session works ---
  const progressEl = $('progress');
  function renderProgress() {
    const { state, value } = activeId ? sess(activeId).progress : { state: 0, value: 0 };
    progressEl.className = '';
    if (state >= 1 && state <= 4) {
      progressEl.classList.add('on');
      if (state === 2) progressEl.classList.add('error');
      if (state === 3) progressEl.classList.add('busy');
      if (state === 4) progressEl.classList.add('paused');
      progressEl.style.width = state === 3 ? '' : `${Math.min(100, Math.max(0, value))}%`;
    } else {
      progressEl.style.width = '0';
    }
  }

  let lastTaskbar = '';
  function renderTaskbar() {
    const active = activeId && cache.has(activeId) ? cache.get(activeId).progress : { state: 0, value: 0 };
    const busy = [...cache.entries()].some(([id, s]) => openIds.has(id) && s.state.working);
    const { state, value } = active.state ? active : busy ? { state: 3, value: 0 } : { state: 0, value: 0 };
    const key = `${state}:${value}`;
    if (key === lastTaskbar) return;
    lastTaskbar = key;
    widget.win.progress(state, value);
  }

  // --- Side panel: worker rows on top, status footer at the bottom ------------
  const sideEl = $('side');
  const workersEl = $('workers');
  const countEl = $('workers-count');
  const clearBtn = $('workers-clear');
  const askBtn = $('workers-ask');
  const footerEl = $('footer');
  let workerCount = 0;
  const sysEl = $('sysmon');
  const jobsEl = $('jobs');
  const updateSide = () => { sideEl.hidden = workerCount === 0 && footerEl.hidden && sysEl.hidden && jobsEl.hidden; };

  // Collapsed, the panel is a slim strip with the running-worker count and a turn indicator.
  let sideCollapsed = !!cfg.sideCollapsed;
  const setSideCollapsed = (collapsed) => {
    sideCollapsed = collapsed;
    document.body.classList.toggle('side-collapsed', collapsed);
    widget.side.setCollapsed(collapsed);
  };
  document.body.classList.toggle('side-collapsed', sideCollapsed);
  $('side-toggle').onclick = () => { setSideCollapsed(true); terminals.focus(); };
  $('side-mini').onclick = () => { setSideCollapsed(false); terminals.focus(); };

  const meterTo = (el, pct) => { el.style.width = `${Math.min(100, Math.max(0, pct))}%`; setLevel(el, pct); };
  const setLevel = (el, pct) => {
    el.classList.remove('warm', 'hot');
    const lv = WidgetFooter.level(pct);
    if (lv) el.classList.add(lv);
  };

  function renderFooter() {
    const now = Date.now();
    const a = activeId ? sess(activeId) : null;
    const s = a && a.status;
    const git = a && a.git;
    const turnStart = a ? a.turnStart : null;
    const lastTurnMs = a ? a.lastTurnMs : null;
    $('f-model').textContent = s && s.model ? (s.effort ? `${s.model} · ${s.effort}` : s.model) : '';
    $('f-cost').textContent = s && s.cost !== null ? `$${s.cost.toFixed(2)}` : '';
    $('f-ctx-row').hidden = !s || s.ctxPct === null;
    if (s && s.ctxPct !== null) {
      $('f-meter').style.width = `${s.ctxPct}%`;
      setLevel($('f-meter'), s.ctxPct);
      setLevel($('f-ctx'), s.ctxPct);
      const size = s.ctxSize ? `/${WidgetFooter.fmtTokens(s.ctxSize)}` : '';
      $('f-ctx').textContent = `${s.ctxPct}% ${WidgetFooter.fmtTokens(s.ctxTokens)}${size}`;
    }
    // Rate limits, plus how far through the 5-hour window we are: usage running ahead of time hits the limit early.
    const limit = (key, pct, resetsAt) => {
      $(`f-${key}-row`).hidden = pct === null;
      if (pct === null) return;
      meterTo($(`f-${key}-m`), pct);
      setLevel($(`f-${key}`), pct);
      const resets = WidgetFooter.fmtResets(resetsAt, now);
      $(`f-${key}`).textContent = `${Math.round(pct)}%${key === '7d' && resets ? ` · ${resets}` : ''}`;
    };
    limit('5h', s ? s.fiveHour : null, s && s.fiveHourResets);
    limit('7d', s ? s.sevenDay : null, s && s.sevenDayResets);
    const blk = s && s.fiveHour !== null ? WidgetFooter.windowPct(s.fiveHourResets, now, WidgetFooter.WINDOWS.fiveHour) : null;
    $('f-blk-row').hidden = blk === null;
    if (blk !== null) {
      $('f-blk-m').style.width = `${blk}%`;
      $('f-blk').textContent = `${WidgetFooter.fmtResets(s.fiveHourResets, now)} left`;
    }
    $('f-git').textContent = WidgetFooter.fmtGit(git) || '';
    $('f-git').title = (s && s.cwd) || '';
    const turn = $('f-turn');
    turn.classList.toggle('busy', turnStart !== null);
    $('mini-turn').classList.toggle('busy', turnStart !== null);
    $('mini-turn').title = turn.textContent;
    turn.textContent = turnStart !== null ? `▶ ${WidgetFooter.fmtDuration(now - turnStart)}`
      : lastTurnMs !== null ? `last ${WidgetFooter.fmtDuration(lastTurnMs)}` : '';
    footerEl.hidden = !s && !git && turnStart === null && lastTurnMs === null;
    updateSide();
  }

  // Claude Code sets OSC 9;4 progress when a turn starts and clears it when the turn ends.
  function trackTurn(s, state) {
    if (state >= 1 && state <= 4 && s.turnStart === null) {
      s.turnStart = Date.now();
    } else if (state === 0 && s.turnStart !== null) {
      s.lastTurnMs = Date.now() - s.turnStart;
      s.turnStart = null;
    }
  }

  // --- Progress rows: Claude's task list, the benchmark, Run-menu tasks of the active project ---
  let bench = null; // { label, step, of } while a benchmark runs, { done: true, at } just after
  widget.bench.onProgress((m) => {
    bench = m.done ? { ...bench, done: true, failed: !!m.failed, at: Date.now() } : m;
    renderJobs();
  });
  const runEls = new Map();
  function renderJobs() {
    const now = Date.now();
    const t = activeId ? WidgetWorkers.tasks(sess(activeId).workerEvents, now) : null;
    $('j-tasks').hidden = !t;
    if (t) {
      meterTo($('j-tasks-m'), (t.done / t.total) * 100);
      $('j-tasks-m').classList.remove('warm', 'hot');
      $('j-tasks-t').textContent = `${t.done}/${t.total}`;
      $('j-tasks-now').textContent = t.current ? `▸ ${t.current}` : '';
      $('j-tasks').title = t.all.map((x) => `${x.status === 'completed' ? '✓' : x.status === 'in_progress' ? '▸' : '·'} ${x.subject}`).join('\n');
    }
    if (bench && bench.done && now - bench.at > 4000) bench = null;
    $('j-bench').hidden = !bench;
    if (bench) {
      const pct = bench.done ? 100 : ((bench.step - 1) / bench.of) * 100;
      $('j-bench-m').style.width = `${pct}%`;
      $('j-bench-t').textContent = bench.done ? (bench.failed ? 'stopped' : 'done') : `${bench.label} ${bench.step}/${bench.of}`;
    }
    const runs = auxList.filter((a) => a.projectId === activeId && a.kind === 'task');
    const keep = new Set(runs.map((a) => a.id));
    for (const [id, el] of runEls) if (!keep.has(id)) { el.remove(); runEls.delete(id); }
    for (const a of runs) {
      let el = runEls.get(a.id);
      if (!el) {
        el = document.createElement('div');
        el.innerHTML = '<span class="s-label"></span><span class="meter"><i></i></span><span class="right"></span>';
        el.onclick = () => { showView(a.id); terminals.focus(); };
        runEls.set(a.id, el);
        $('j-runs').appendChild(el);
      }
      const state = a.running ? 'running' : a.exitCode === 0 ? 'ok' : 'failed';
      el.className = `f-row j-run ${state}`;
      el.querySelector('.s-label').textContent = a.title;
      const took = a.startedAt ? fmtElapsed((a.endedAt || now) - a.startedAt) : '';
      el.querySelector('.right').textContent = state === 'running' ? took : state === 'ok' ? `✓ ${took}` : `exit ${a.exitCode ?? '?'}`;
      el.title = `${a.title}: ${state === 'running' ? 'running' : state === 'ok' ? 'finished' : 'failed'}. Click to show its tab`;
    }
    jobsEl.hidden = !t && !bench && !runs.length;
    updateSide();
  }

  // --- System monitor strip (src/sysmon.js samples in the main process) ---
  let showSysmon = cfg.showSysmon;
  const pctOf = (used, total) => (total ? Math.round((used / total) * 100) : 0);
  const gb = (bytes) => `${(bytes / 1073741824).toFixed(1)}G`;
  widget.sys.onSample((smp) => {
    sysEl.hidden = !showSysmon;
    if (!showSysmon) return updateSide();
    const meter = (id, pct) => meterTo($(id), pct);
    meter('s-cpu', smp.cpu.pct);
    $('s-cpu-t').textContent = `${smp.cpu.pct}%`;
    // CPU temperature on a 30-100 °C scale, so warm (60%) is 72 °C and hot (85%) about 90 °C.
    $('s-temp-row').hidden = smp.cpuTemp === null;
    if (smp.cpuTemp !== null) {
      meter('s-temp', Math.round(((smp.cpuTemp - 30) / 70) * 100));
      $('s-temp-t').textContent = `${Math.round(smp.cpuTemp)}°C`;
    }
    const memPct = pctOf(smp.mem.used, smp.mem.total);
    meter('s-mem', memPct);
    $('s-mem-t').textContent = `${gb(smp.mem.used)}/${gb(smp.mem.total)}`;
    const g = smp.gpus[0];
    $('s-gpu-row').hidden = !g;
    if (g) {
      meter('s-gpu', g.util || 0);
      $('s-gpu-t').textContent = `${g.util ?? '–'}%${g.temp !== null ? ` · ${g.temp}°C` : ''}`;
      $('s-gpu-row').title = g.name;
    }
    const vram = g && g.memTotal ? g : null;
    $('s-vram-row').hidden = !vram;
    if (vram) {
      meter('s-vram', pctOf(vram.memUsed || 0, vram.memTotal));
      $('s-vram-t').textContent = `${((vram.memUsed || 0) / 1024).toFixed(1)}/${(vram.memTotal / 1024).toFixed(1)}G`;
    }
    $('s-disk-row').hidden = !smp.disk;
    if (smp.disk) {
      meter('s-disk', pctOf(smp.disk.used, smp.disk.total));
      $('s-disk-t').textContent = `${WidgetFooter.fmtBytes(smp.disk.used)}/${WidgetFooter.fmtBytes(smp.disk.total)}`;
      $('s-disk-row').title = `Disk space used on ${smp.disk.path}`;
    }
    sysEl.title = `${smp.cpu.model} (${smp.cpu.count} threads)${smp.cpuTemp === null ? '\nCPU temperature: not available (on Windows it needs LibreHardwareMonitor running)' : ''}\nClick for the full monitor`;
    updateSide();
  });
  sysEl.onclick = () => widget.workbench.open('system');

  widget.status.onUpdate(({ id, status }) => {
    sess(id).status = WidgetFooter.summarize(status);
    if (id === activeId) renderFooter();
  });
  widget.status.onGit(({ id, info }) => {
    sess(id).git = info;
    if (id === activeId) renderFooter();
  });

  // --- Worker rows (subagents + background shells, fed by hooks/workers-hook.js) ---
  const MAX_ROWS = 20;
  const rowEls = new Map();

  const fmtElapsed = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  const makeRow = () => {
    const row = document.createElement('div');
    row.className = 'worker';
    row.innerHTML = '<span class="icon"></span><span class="label"></span><span class="time"></span>';
    return row;
  };

  function renderWorkers() {
    const now = Date.now();
    const workers = activeId ? WidgetWorkers.reduce(sess(activeId).workerEvents, now) : [];
    const shown = workers.slice(0, MAX_ROWS);
    const keep = new Set(shown.map((w) => w.id));
    for (const [id, el] of rowEls) if (!keep.has(id)) { el.remove(); rowEls.delete(id); }
    let more = workersEl.querySelector('.more');
    for (const w of shown) {
      let row = rowEls.get(w.id);
      if (!row) {
        // Insert once and never move it: moving a node restarts its CSS fade/spin animations.
        // Workers start in time order, so a new row belongs at the end (before "+N more").
        row = makeRow();
        rowEls.set(w.id, row);
        workersEl.insertBefore(row, more);
      }
      row.querySelector('.label').textContent = w.label;
      row.title = `${{ shell: 'Background command', agent: 'Subagent' }[w.kind] || `Background ${w.kind}`}: ${w.label}`;
      row.querySelector('.time').textContent = fmtElapsed((w.doneAt ?? now) - w.startedAt);
      row.classList.toggle('done', w.doneAt !== null);
    }
    if (workers.length > MAX_ROWS) {
      if (!more) { more = document.createElement('div'); more.className = 'worker more'; workersEl.appendChild(more); }
      more.textContent = `+${workers.length - MAX_ROWS} more`;
    } else if (more) {
      more.remove();
    }
    const running = workers.filter((w) => w.doneAt === null).length;
    const done = workers.length - running;
    const parts = [];
    if (running) parts.push(`${running} running`);
    if (done) parts.push(`${done} done`);
    countEl.textContent = parts.join(' · ') || 'idle';
    countEl.classList.toggle('idle', running === 0);
    $('mini-count').textContent = running ? String(running) : '';
    $('mini-count').classList.toggle('idle', running === 0);
    workerCount = workers.length;
    clearBtn.disabled = workers.length === 0;
    askBtn.disabled = !askTarget();
    updateSide();
  }

  // Hides the rows only: Claude Code owns the processes, nothing here stops them.
  clearBtn.addEventListener('click', () => {
    if (!activeId) return;
    const s = sess(activeId);
    s.workerEvents = s.workerEvents.concat(WidgetWorkers.stopAll(s.workerEvents, Date.now(), { immediate: true }));
    renderWorkers();
    renderMascot();
  });

  const ASK_CLOSE_TEXT = 'Please check your background tasks, shells, monitors and subagents. Stop the ones you no longer need, keep anything I still depend on such as dev servers I asked for, and tell me what you stopped and what is still running.';
  // The active project's Claude terminal while it is focused and running.
  function askTarget() {
    if (!activeId || promptTarget() !== activeId) return null; // an aux tab or another pane has focus
    const t = terminals.get(activeId);
    return t && !t.exited ? activeId : null;
  }
  askBtn.addEventListener('click', () => {
    const target = askTarget();
    if (!target) return toast('Focus a Claude session first');
    typeIntoClaude(target, ASK_CLOSE_TEXT, true);
    toast('Asked Claude to close what it no longer needs');
  });

  widget.workers.onEvents(({ id, events }) => {
    const s = sess(id);
    // Tool start/end only feed the mascot; kept out of workerEvents, which keeps everything for the rows.
    const tools = events.filter((e) => e && e.t === 'tool');
    if (tools.length) s.tools = tools.reduce(MS.applyTool, s.tools);
    s.workerEvents = s.workerEvents.concat(tools.length ? events.filter((e) => !e || e.t !== 'tool') : events);
    // Permission prompts and questions (hooks/workers-hook.js) turn the row's dot to "needs you".
    const ask = events.find((e) => e && e.t === 'attention');
    if (ask) {
      update(id, { t: 'attention' });
      notify(id, 'attention', ask.reason);
    }
    if (id === activeId) { renderWorkers(); renderJobs(); }
    renderMascot();
  });

  // Elapsed times in the worker rows and the turn timer tick once a second.
  setInterval(() => {
    if (!activeId) return;
    const s = sess(activeId);
    if (s.workerEvents.length) renderWorkers();
    if (s.turnStart !== null) renderFooter();
    if (!jobsEl.hidden) renderJobs();
  }, 1000);
  // The 5-hour window bar and reset times move even while the session is idle.
  setInterval(() => { if (activeId) renderFooter(); }, 30000);

  // Debounced so a burst of size changes (window drag, rail or worker panel opening) resizes the PTY once.
  let fitTimer;
  const fitObserver = new ResizeObserver(() => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => terminals.fitActive(), 60);
  });
  fitObserver.observe($('terminal'));
  fitObserver.observe($('terminal-b'));

  // --- Keyboard (caught before xterm): Ctrl+1…9, Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+Shift+B, Ctrl+Shift+E, Ctrl+Shift+W ---
  // The rail toggle is Ctrl+Shift+B, not Ctrl+B: Claude Code uses Ctrl+B to background a running command.
  window.addEventListener('keydown', (e) => {
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (e.ctrlKey && !e.altKey && !e.shiftKey && /^[1-9]$/.test(e.key)) {
      handled();
      const p = projects[Number(e.key) - 1];
      if (p) activate(p.id);
    } else if (e.ctrlKey && !e.altKey && e.key === 'Tab') {
      handled();
      const open = projects.filter((p) => openIds.has(p.id));
      if (open.length < 2) return;
      const i = open.findIndex((p) => p.id === activeId);
      activate(open[(i + (e.shiftKey ? -1 : 1) + open.length) % open.length].id);
    } else if (e.ctrlKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'b') {
      handled();
      widget.rail.toggle();
    } else if (e.ctrlKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'w') {
      handled();
      setSideCollapsed(!sideCollapsed);
    } else if (e.ctrlKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'p') {
      handled();
      if (!switcher.isOpen()) loadSpend();
      switcher.toggle();
    } else if (e.ctrlKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'j') {
      handled();
      const id = WidgetAttention.next(projects.filter((p) => openIds.has(p.id)), (x) => SS.dot(sess(x).state), activeId);
      if (id) activate(id); else toast('Nothing is waiting for you');
    } else if (e.ctrlKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'k') {
      handled();
      promptsPalette.toggle();
    } else if (e.ctrlKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'l') {
      handled();
      if (sendTo.isOpen()) sendTo.close(); else openSendTo();
    } else if (e.ctrlKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'h') {
      handled();
      if (!findAll.isOpen()) findRows = [];
      findAll.toggle();
    } else if (e.ctrlKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'o') {
      handled();
      layoutsPalette.toggle();
    } else if (e.ctrlKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'e') {
      handled();
      filesPane.toggle();
    } else if (e.ctrlKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'f') {
      handled();
      filesPane.focusSearch();
    } else if (e.ctrlKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'g') {
      handled();
      widget.workbench.open();
    } else if (e.ctrlKey && !e.altKey && (e.key === 'PageDown' || e.key === 'PageUp') && activeId) {
      handled();
      // Cycles the tabs of the focused zone.
      const L = currentLayout();
      const ids = L.zones[L.focus];
      if (ids.length < 2) return;
      const i = ids.indexOf(L.focused);
      showView(ids[(i + (e.key === 'PageDown' ? 1 : -1) + ids.length) % ids.length]);
    } else if (e.ctrlKey && !e.altKey && e.shiftKey && e.code === 'Backslash' && activeId) {
      handled();
      toggleSplit();
    } else if (e.ctrlKey && !e.altKey && e.shiftKey && e.key.toLowerCase() === 'm' && activeId) {
      handled();
      const L = currentLayout();
      if (L.focused) moveTab(L.focused, L.split ? 1 - L.focus : 1);
    } else if (e.key === 'Enter' && !placeholderEl.hidden && activeId && !terminals.has(activeId)) {
      handled();
      activate(activeId);
    }
  }, true);

  // --- Title bar buttons --------------------------------------------------
  const pinBtn = $('btn-pin');
  pinBtn.classList.toggle('on', cfg.alwaysOnTop);

  $('btn-restart').onclick = () => activeId && terminals.restart(activeId);
  $('btn-fade').onclick = async () => toast(`Opacity ${Math.round((await widget.win.opacity(-0.05)) * 100)}%`);
  $('btn-solid').onclick = async () => toast(`Opacity ${Math.round((await widget.win.opacity(0.05)) * 100)}%`);
  pinBtn.onclick = async () => {
    const on = await widget.win.togglePin();
    pinBtn.classList.toggle('on', on);
    toast(on ? 'Pinned on top' : 'Unpinned');
  };
  $('btn-settings').onclick = () => widget.openConfig();
  widget.onConfigChanged(({ alwaysOnTop, showSysmon: sm, showMascot, guardMinutes }) => {
    pinBtn.classList.toggle('on', alwaysOnTop);
    if (sm !== undefined) { showSysmon = sm; sysEl.hidden = !sm; updateSide(); }
    if (showMascot !== undefined) document.body.classList.toggle('no-mascot', !showMascot);
    if (guardMinutes !== undefined) { guardMs = guardMinutes * 60000; noteActivity(); }
  });

  // --- Project switcher (Ctrl+Shift+P): type to filter, Enter opens, Ctrl+Enter opens it as a tab ---
  // Spend per project (ccusage, cached in main): fetched when the switcher opens, shown once it arrives.
  let spend = {};
  const loadSpend = () => widget.usage.byProject().then((x) => { spend = x || {}; switcher.refresh(); });
  const switcher = WidgetSwitcher.createSwitcher({
    el: $('switcher'),
    items: () => projects.map((p) => ({ id: p.id, name: p.name, path: p.remote ? p.remote.hostName : p.path, open: openIds.has(p.id), active: p.id === activeId, dot: SS.dot(sess(p.id).state), git: [WidgetGitBadge.badge(gitAll[p.id]).long, spend[p.id]].filter(Boolean).join('  ') })),
    pick: (id, { inTab }) => (inTab ? linkProject(id) : activate(id)),
    canTab: (id) => !!activeId && id !== activeId,
    onClose: () => terminals.focus()
  });

  // --- Saved layouts (Ctrl+Shift+O): a project with other projects' sessions as tabs, some in the lower zone ---
  let layouts = [];
  try { layouts = WidgetLayouts.normalize(JSON.parse(localStorage.getItem('layouts'))); } catch { /* none saved */ }
  const saveLayouts = (next) => {
    layouts = next;
    try { localStorage.setItem('layouts', JSON.stringify(layouts)); } catch { /* storage off */ }
  };
  const projectName = (id) => (projects.find((p) => p.id === id) || {}).name;
  const projectExists = (id) => projects.some((p) => p.id === id && !p.missing);

  async function applyLayout(l) {
    const use = WidgetLayouts.usable(l, projectExists);
    if (!use) return toast('Some of those projects are gone');
    await activate(use.host);
    if (activeId !== use.host) return;
    for (const id of linkedOf(use.host).slice()) if (!use.links.includes(id)) unlinkProject(id);
    for (const id of use.links) await linkProject(id, { quiet: true });
    splitRatio = use.ratio;
    try { localStorage.setItem('splitRatio', String(splitRatio)); } catch { /* storage off */ }
    for (const id of use.links) {
      if (!tabIds().includes(id)) continue;
      const down = currentLayout().zones[1].includes(id);
      if (use.bottom.includes(id) !== down) moveTab(id, down ? 0 : 1);
    }
    renderTabs(true);
    toast(`Layout: ${use.name}`);
  }

  function saveCurrentLayout() {
    const links = activeId ? linkedOf(activeId) : [];
    if (!links.length) return toast('Open another project in a tab first (right-click it > Open in tab)');
    ask({
      title: 'Save layout',
      text: `${WidgetLayouts.describe({ host: activeId, links, bottom: links.filter((id) => currentLayout().zones[1].includes(id)) }, projectName)}. Saving with an existing name replaces it.`,
      value: '',
      ok: 'Save',
      submit: async (name) => {
        if (!name.trim()) return 'Give the layout a name';
        const bottom = links.filter((id) => currentLayout().zones[1].includes(id));
        saveLayouts(WidgetLayouts.add(layouts, { name, host: activeId, links, bottom, ratio: splitRatio }));
        return null;
      }
    });
  }

  const layoutsPalette = WidgetSwitcher.createSwitcher({
    el: $('layouts'),
    emptyText: 'No saved layouts. Ctrl+N saves the current tabs as one.',
    items: () => layouts.map((l) => ({ id: l.id, name: l.name, path: WidgetLayouts.describe(l, projectName), plain: true })),
    pick: (id) => { const l = layouts.find((x) => x.id === id); if (l) applyLayout(l); },
    onKey: (e, item, api) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'n') { api.close(); saveCurrentLayout(); return true; }
      if (e.ctrlKey && e.key === 'Delete' && item) { saveLayouts(WidgetLayouts.remove(layouts, item.id)); api.refresh(); return true; }
      return false;
    },
    onClose: () => terminals.focus()
  });

  // --- Search every project (Ctrl+Shift+H): file names and contents, results from the main process as you type ---
  let findRows = [];
  let findTimer = null;
  const findAll = WidgetSwitcher.createSwitcher({
    el: $('findall'),
    emptyText: 'Type to search (two or more characters)',
    items: () => findRows.map((r, i) => ({ id: String(i), name: r.project + '  ' + r.rel + (r.line ? ':' + r.line : ''), path: r.text || (r.line ? '' : 'file name'), plain: true })),
    canTab: () => false,
    pick: (id) => {
      const r = findRows[Number(id)];
      if (!r) return;
      if (r.line) widget.files.openAt(r.id, r.rel, r.line); else widget.files.open(r.id, r.rel);
    },
    onInput: (q) => {
      clearTimeout(findTimer);
      findRows = [];
      if (q.trim().length < 2) return findAll.refresh();
      findTimer = setTimeout(async () => {
        const rows = await widget.files.searchAll(q.trim());
        if (rows && findAll.isOpen()) { findRows = rows; findAll.refresh(); }
      }, 250);
    },
    onClose: () => { clearTimeout(findTimer); terminals.focus(); }
  });

  // --- Send to another session (Ctrl+Shift+L): the selected text (else the clipboard) goes into that session's prompt ---
  let sendText = '';
  const sendTo = WidgetSwitcher.createSwitcher({
    el: $('sendto'),
    emptyText: 'No other session is open',
    items: () => projects
      .filter((p) => openIds.has(p.id) && p.id !== sendFrom())
      .map((p) => ({ id: p.id, name: p.name, path: p.path, open: true, active: false, dot: SS.dot(sess(p.id).state) })),
    canTab: () => true,
    pick: (id, { inTab }) => {
      if (!sendText.trim()) return toast('Nothing to send');
      widget.pty.write(id, `\x1b[200~${sendText}\x1b[201~${inTab ? '\r' : ''}`);
      toast(`Sent ${sendText.length} characters to ${(projects.find((p) => p.id === id) || {}).name}`);
      activate(id);
    },
    onClose: () => terminals.focus()
  });
  const sendFrom = () => { const L = currentLayout(); return L.focused; };
  async function openSendTo() {
    const t = terminals.get(sendFrom());
    sendText = (t && t.term.hasSelection() ? t.term.getSelection() : '') || (await widget.clipboard.read()) || '';
    if (!sendText.trim()) return toast('Select some text first (or copy it)');
    sendTo.open();
  }

  // --- Saved prompts (Ctrl+Shift+K): Enter pastes into the focused session's prompt, Ctrl+Enter pastes and sends ---
  let savedPrompts = [];
  widget.prompts.get().then((list) => { savedPrompts = list; });
  const savePrompts = async (list) => { savedPrompts = await widget.prompts.set(list); };
  function promptTarget() { const L = currentLayout(); return L.focused && !L.focused.startsWith('aux:') && terminals.has(L.focused) ? L.focused : null; } // Claude sessions only: a shell would run the text
  // Bracketed paste into a Claude terminal (local or remote: the write goes through the pty bridge), optionally submitted.
  function typeIntoClaude(id, text, submit) { widget.pty.write(id, `\x1b[200~${text}\x1b[201~${submit ? '\r' : ''}`); }
  const promptsPalette = WidgetSwitcher.createSwitcher({
    el: $('prompts'),
    emptyText: 'No saved prompts. Ctrl+N makes one.',
    items: () => WidgetPrompts.visible(savedPrompts, activeId).map((p) => ({ id: p.id, name: (p.project ? '• ' : '') + p.title, path: p.text.replace(/\s+/g, ' '), plain: true })),
    canTab: () => true,
    pick: (id, { inTab }) => {
      const p = savedPrompts.find((x) => x.id === id);
      const target = promptTarget();
      if (!p || !target) return toast('Focus a Claude session first');
      typeIntoClaude(target, p.text, inTab);
    },
    onKey: (e, item, api) => {
      if (e.ctrlKey && e.key.toLowerCase() === 'n') {
        const scoped = e.shiftKey && activeId;
        api.close();
        ask({
          title: scoped ? 'New prompt for this project' : 'New saved prompt',
          text: 'The first line becomes its name. Ctrl+Enter saves.',
          ok: 'Save',
          area: true,
          submit: async (text) => {
            if (!text.trim()) return 'Write the prompt first';
            await savePrompts(WidgetPrompts.add(savedPrompts, { title: '', text, project: scoped ? activeId : null }));
            return null;
          }
        });
        return true;
      }
      if (e.ctrlKey && e.key === 'Delete' && item) {
        savePrompts(WidgetPrompts.remove(savedPrompts, item.id)).then(api.refresh);
        return true;
      }
      return false;
    },
    onClose: () => terminals.focus()
  });

  // --- Small prompt (worktree branch name, project name) ------------------------
  const modal = $('modal');
  function ask({ title, text, value = '', ok = 'OK', area = false, submit }) {
    $('modal-title').textContent = title;
    $('modal-text').textContent = text || '';
    $('modal-error').textContent = '';
    $('modal-ok').textContent = ok;
    const input = $(area ? 'modal-area' : 'modal-input');
    $('modal-area').hidden = !area;
    $('modal-input').hidden = area;
    input.value = value;
    modal.hidden = false;
    input.focus();
    input.select();
    const close = () => { modal.hidden = true; terminals.focus(); };
    $('modal-cancel').onclick = close;
    modal.onkeydown = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
      else if (area && e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); $('modal-ok').click(); }
    };
    $('modal-form').onsubmit = async (e) => {
      e.preventDefault();
      $('modal-ok').disabled = true;
      $('modal-error').textContent = '';
      try {
        const err = await submit(input.value);
        if (err) $('modal-error').textContent = err;
        else close();
      } finally {
        $('modal-ok').disabled = false;
      }
    };
  }
  widget.projects.onWorktreeAsk(({ id, name }) => ask({
    title: `New worktree session for ${name}`,
    text: 'A second checkout on its own branch, in its own folder, with its own Claude session. An existing branch is checked out; a new name makes a new branch.',
    value: 'feature/',
    ok: 'Create',
    submit: async (branch) => {
      const r = await widget.projects.createWorktree(id, branch);
      if (r && r.error) return r.error;
      toast(`Worktree ready: ${r.dir}`, 3000);
      return null;
    }
  }));
  widget.projects.onDefaultsAsk(({ id, name, text, open }) => ask({
    title: `Session defaults for ${name}`,
    text: `Model, permission mode and environment variables this project's Claude session starts with.${open ? ' Restart the session (↻) to apply them.' : ''} Ctrl+Enter saves.`,
    value: text,
    ok: 'Save',
    area: true,
    submit: async (value) => {
      const r = await widget.projects.setDefaults(id, value);
      return r && r.error ? r.error : null;
    }
  }));
  // Starts from the name shown, which is a 0.8.0 display name if one was set, so renaming the folder to it is one click.
  widget.projects.onRenameAsk(({ id, name, path, open }) => ask({
    title: `Rename ${name}`,
    text: `Renames the folder ${path}.${open ? ' Its Claude session restarts and picks up the same conversation; terminals open in it close.' : ''}`,
    value: name,
    ok: 'Rename',
    submit: async (value) => {
      const r = await widget.projects.rename(id, value);
      return r && r.error ? r.error : null;
    }
  }));
  $('btn-min').onclick = () => widget.win.hide();
  $('btn-close').onclick = () => widget.win.close();
  // Double-clicking the bar maximizes natively (it is an OS drag region).
  const maxBtn = $('btn-max');
  maxBtn.onclick = () => widget.win.toggleMaximize();
  widget.win.onZoom(({ maximized, fullScreen }) => {
    maxBtn.textContent = maximized || fullScreen ? '❐' : '□';
    maxBtn.title = fullScreen ? 'Exit full screen (F11)' : maximized ? 'Restore' : 'Maximize (F11 for full screen)';
  });

  window.addEventListener('focus', () => {
    if (!modal.hidden || document.activeElement === $('files-q')) return filesPane.refresh();
    terminals.focus();
    filesPane.refresh();
  });

  // Starts the sessions that were open at the last quit (main.js restoreSessions), one after another, in the background.
  // Each is a hidden terminal until its project is clicked; Claude continues its last conversation.
  async function reopenSessions(ids, shownId) {
    await switching; // the project being shown starts first
    for (const id of ids) {
      const p = projects.find((x) => x.id === id);
      if (!p || p.missing || id === shownId || openIds.has(id) || terminals.has(id)) continue;
      const t = terminals.create(id);
      t.el.hidden = true;
      const ok = await widget.projects.open(id, 120, 30, true);
      if (!ok) { terminals.destroy(id); continue; }
      openIds.add(id);
      renderRail();
    }
  }

  // --- Launch: open the last active project; every other one stays idle until clicked ---
  const initial = await widget.projects.get();
  projects = initial.list;
  remoteHosts = initial.remoteHosts || [];
  openIds = new Set(initial.open);
  renderRail();
  applyAux(await widget.aux.get());
  if (initial.active) activate(initial.active);
  else showPlaceholder('No projects yet. Add a folder with + in the project list.');
  reopenSessions(initial.restore || [], initial.active);
})();
