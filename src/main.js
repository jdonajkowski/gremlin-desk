const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, shell, clipboard, screen, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const { createSessions } = require('./sessions');
const projects = require('./projects');
const gitStatus = require('./git-status');
const usageStats = require('./usage');
const { summarize } = require('./footer');
const files = require('./files');
const settingsLib = require('./settings');
const launch = require('./claude-launch');
const setupChecks = require('./setup-checks');
const { createBrowser } = require('./browser-window');
const { createControl } = require('./browser-control');
const { isLocalUrl, openTarget, prependPath } = require('./browser-url');
const { createAux } = require('./aux-sessions');
const remoteConfig = require('./remote-config');
const remoteCrypto = require('./remote-crypto');
const { createRemoteHost } = require('./remote-host');
const { createRemoteClients } = require('./remote-clients');
const { startElevated } = require('./admin-shell');
const tasks = require('./tasks');
const gitOps = require('./git-ops');
const projectRename = require('./project-rename');
const { searchProject } = require('./search');
const { createSampler } = require('./sysmon');
const { setupWorkbench } = require('./workbench-main');
const { buildLaunch } = require('./sessions');

const isWin = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Settings (stored in %APPDATA%\Claude Widget\config.json)
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG = {
  // Shell that hosts Claude Code. On Windows, PowerShell runs `claude` and stays
  // open afterwards, so quitting Claude drops you at a prompt instead of closing.
  shell: isWin ? 'powershell.exe' : process.env.SHELL || '/bin/bash',
  shellArgs: isWin ? ['-NoLogo', '-NoExit', '-Command', 'claude'] : ['-lc', 'claude; exec $SHELL'],
  // Command each project's session runs. Unset: the last shellArgs element (which it replaces), else `claude`.
  claudeCommand: '',
  // The rail lists every subfolder of projectsRoot plus pinned extras (projects.json).
  projectsRoot: path.join(os.homedir(), 'Projects'),
  // Claude Code's config folder for widget sessions (CLAUDE_CONFIG_DIR): sign-in, plugins, history, settings.
  // Empty: Claude's default ~/.claude, shared with other Claude Code installs.
  claudeConfigDir: '~/Projects/.claude',
  cwd: os.homedir(),
  env: {},
  // Pass the widget's hooks and status line wrapper to each Claude session (--settings), so
  // ~/.claude/settings.json needs nothing added. Off: wire them up there yourself (see README).
  claudeHooks: true,
  // System change safety net (hooks/guard-hook.js): "ask" before registry, service, boot, package... changes,
  // "log" records them and their undo without asking, "off" does neither.
  guardMode: 'ask',
  // CPU, memory, GPU and temperature strip in the side panel.
  showSysmon: true,
  // The gremlin peeking up at the bottom of the project list
  showMascot: true,
  // Minutes with no typing, clicking or Claude activity before Glitch climbs out to guard the terminal. 0: never.
  guardMinutes: 5,
  // Open the URL a Run-menu dev server prints in the built-in browser.
  autoOpenDevServer: true,
  // widget-browser (bin/): sessions may drive the built-in browser's page (src/browser-control.js)
  browserControl: true,
  alwaysOnTop: true,
  opacity: 0.95,
  // Windows 11 22H2+ only: "none" | "acrylic" | "mica" | "tabbed"
  backgroundMaterial: 'none',
  showInTaskbar: false,
  // A desktop notification when Claude needs you or finishes a turn in a session you are not looking at.
  notifications: true,
  // Reopen the projects whose sessions were open when Gremlin last quit (each continues its last conversation).
  restoreSessions: true,
  // Start Gremlin when you sign in (installed app only); open hidden in the tray, or minimized when it is in the taskbar.
  launchOnStartup: false,
  startMinimized: false,
  hotkey: 'Control+Alt+Space',
  fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
  fontSize: 13,
  theme: {
    background: '#1f1e1d',
    foreground: '#e8e6e3',
    cursor: '#d97757',
    selectionBackground: '#d9775755'
  }
};

// All of Gremlin's data lives in ~/Projects/.claude/gremlin (src/data-dirs.js), copied once from the app's
// old name, Claude Widget: ~/Projects/.claude/widget, or %APPDATA%\Claude Widget before 0.3.0.
// An explicit --user-data-dir still wins (handy for testing).
const dataDirs = require('./data-dirs');
const dirs = dataDirs.layout(os.homedir());
if (!app.commandLine.hasSwitch('user-data-dir')) {
  for (const from of [dirs.legacy, path.join(app.getPath('appData'), 'Claude Widget')]) {
    try { dataDirs.migrateWidgetData(from, dirs.widget); } catch (err) { console.error(`Copying ${from} failed`, err); }
  }
  app.setPath('userData', dirs.widget);
}
const userDir = app.getPath('userData');
const configPath = path.join(userDir, 'config.json');
const statePath = path.join(userDir, 'window-state.json');
// Pinned extras and hidden projects for the rail, kept apart from the hand-edited config.json.
const projectsPath = path.join(userDir, 'projects.json');
const promptsPath = path.join(userDir, 'prompts.json');
const defaultsPath = path.join(userDir, 'project-defaults.json');
const remotePath = path.join(userDir, 'remote.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Failed to write', file, err);
  }
}

function loadConfig() {
  if (!fs.existsSync(configPath)) writeJson(configPath, DEFAULT_CONFIG);
  const user = readJson(configPath, {});
  return { ...DEFAULT_CONFIG, ...user, theme: { ...DEFAULT_CONFIG.theme, ...(user.theme || {}) } };
}

let config = loadConfig();
let state = readJson(statePath, {});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
let win = null;
let tray = null;
const mdWindows = new Map();
let activeId = null;

// What sessions pass to Claude Code with --settings (src/claude-launch.js). Rewritten before each
// session starts, so it follows the user's current status line and whether Node is installed.
const hooksDir = path.join(__dirname, '..', 'hooks');
const claudeSettingsPath = path.join(userDir, 'claude-settings.json');
// Claude Code's config folder for widget sessions: config.claudeConfigDir, else ~/.claude.
const claudeDir = () => dataDirs.expandHome(config.claudeConfigDir, os.homedir()) || path.join(os.homedir(), '.claude');
const claudeEnv = () => (config.claudeConfigDir ? { CLAUDE_CONFIG_DIR: claudeDir() } : {});
// `widget-open <url-or-file>` (bin/) in every session and tab: runs this executable with --open, which the
// running widget gets as a second instance and shows in the built-in browser. Unpackaged, Electron needs the app folder.
const binDir = path.join(__dirname, '..', 'bin');
const openEnv = () => ({
  ...prependPath(process.env, binDir, isWin),
  GREMLIN_EXE: process.execPath,
  ...(app.isPackaged ? {} : { GREMLIN_APP: path.join(__dirname, '..') }),
  ...(control && control.url() ? { GREMLIN_BROWSER: control.url(), GREMLIN_BROWSER_TOKEN: control.token } : {})
});
const globalClaudeSettings = () => readJson(path.join(claudeDir(), 'settings.json'), {});
// The guard hook's change log and file/registry backups (see hooks/guard-hook.js).
const changesDir = path.join(userDir, 'changes');
const guardEnv = () => ({ GREMLIN_CHANGES: changesDir, GREMLIN_GUARD: config.guardMode || 'ask' });

// First run with a separate config folder: copy ~/.claude into it (not the sign-in token, see data-dirs.js).
let pendingToast = null;
if (config.claudeConfigDir) {
  try {
    const moved = dataDirs.migrateClaudeConfig({ home: os.homedir(), to: claudeDir(), isWin });
    if (moved) pendingToast = `Copied your Claude settings, plugins and history to ${claudeDir()}. Sign in once in a Gremlin session.`;
  } catch (err) {
    console.error('Copying ~/.claude failed', err);
  }
}

function launchInfo() {
  const env = { ...process.env, ...config.env };
  const node = launch.findOnPath(isWin ? ['node.exe'] : ['node'], { env, isWin });
  const gitBash = isWin ? launch.findGitBash({ env }) : null;
  return { env, node, gitBash, ...launch.sessionSettings({ hooksDir, execPath: process.execPath, node, isWin, gitBash, global: globalClaudeSettings(), guard: (config.guardMode || 'ask') !== 'off' }) };
}

function writeSessionSettings() {
  if (config.claudeHooks === false) return null;
  const { settings } = launchInfo();
  if (!settings) return null;
  writeJson(claudeSettingsPath, settings);
  return claudeSettingsPath;
}

// One live session per opened project. Each one's worker log (hooks/workers-hook.js) and statusLine
// JSON (hooks/statusline-tee.js) live in sessions/<hash>/, and its PTY env points the hooks there (see README).
const sessions = createSessions({
  pty,
  config,
  userDir,
  home: os.homedir(),
  isWin,
  send: sessionSend,
  settingsFile: writeSessionSettings,
  claudeDir,
  extraEnv: () => ({ ...claudeEnv(), ...guardEnv(), ...openEnv() }),
  projectDefaults: (id) => { const d = loadDefaults()[id]; return { flags: projDefaults.flags(d), env: projDefaults.normalize(d).env }; },
  onStatus: (id) => { if (id === activeId) pollGit(); }
});

// Extra terminal tabs per project (src/aux-sessions.js): Run-menu tasks, plain and admin shells.
const aux = createAux({
  pty,
  isWin,
  send,
  startElevated: (o) => startElevated({ execPath: process.execPath, helper: path.join(__dirname, 'admin-helper.js'), ...o }),
  onUrl: (_a, url) => {
    if (config.autoOpenDevServer === false) return send('toast', `Dev server at ${url}`);
    browser.open(url);
  },
  onChange: () => send('aux:list', aux.list())
});
const auxEnv = () => ({ ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...claudeEnv(), ...guardEnv(), ...openEnv(), ...config.env });

// kind: task (runs command), shell, admin (elevated shell), admin-claude (elevated Claude session, Windows).
// zone 1: show it in the bottom zone of a split view.
function openAux(projectId, { kind, title, command, zone = 0 }) {
  const cwd = projectPath(projectId);
  if (!cwd || !fs.existsSync(cwd)) { send('toast', 'Open a project first'); return null; }
  let launchSpec;
  let elevated = false;
  if (kind === 'admin') {
    launchSpec = isWin ? tasks.auxLaunch({ shell: config.shell, isWin }) : { file: 'sudo', args: ['-s'] };
    elevated = isWin;
  } else if (kind === 'admin-claude') {
    launchSpec = buildLaunch(config, { cont: false, isWin, settingsFile: writeSessionSettings() });
    elevated = true;
  } else {
    launchSpec = tasks.auxLaunch({ shell: config.shell, isWin, command });
  }
  const id = aux.open({ projectId, cwd, title, kind, launch: launchSpec, env: auxEnv(), elevated }, 100, 30);
  if (win) { win.show(); win.focus(); }
  send('aux:select', { id, projectId, zone });
  return id;
}
const startTask = (projectId, t) => openAux(projectId, { kind: 'task', title: t.label, command: t.command });

// Terminal tabs and Claude sessions share the PTY channels; aux ids start with "aux:".
const owner = (id) => (aux.has(id) ? aux.get(id).projectId : id);

// The project rail adds its width to the window, growing it to the left, so the terminal stays put.
// window-state.json keeps the bounds without the rail.
const autostart = require('./autostart');
// Windows files toasts under this ID (the installer's appId), so they say "Gremlin" and not "electron.app".
if (process.platform === 'win32') app.setAppUserModelId('com.jdonajkowski.gremlin-desk');
const railLimits = require('./rail-width'); // dragging the rail's right edge sets state.railWidth
const RAIL_COLLAPSED = 36;
const MIN_WIDTH = 320;
const railWidth = () => (state.railCollapsed ? RAIL_COLLAPSED : railLimits.clamp(state.railWidth ?? railLimits.DEFAULT));
// Rail width when the window was maximized or went full screen, to fix the size on the way back.
let zoomRail = null;

const withRail = (b) => ({ ...b, x: b.x - railWidth(), width: b.width + railWidth() });

// Keep the window on its display: shift it right first, shrink it (the terminal) only as a last resort.
function fitWorkArea(b) {
  const { workArea: wa } = screen.getDisplayMatching(b);
  const out = { ...b };
  if (out.x < wa.x) out.x = wa.x;
  if (out.x + out.width > wa.x + wa.width) out.width = Math.max(MIN_WIDTH + railWidth(), wa.x + wa.width - out.x);
  return out;
}

function applyRail(oldRail) {
  const rail = railWidth();
  win.setMinimumSize(MIN_WIDTH + rail, 180);
  send('rail:state', { collapsed: !!state.railCollapsed, width: rail });
  // Maximized or full screen: the window can't grow, so the terminal takes the difference.
  if (win.isMaximized() || win.isFullScreen()) return;
  const b = win.getBounds();
  const delta = rail - oldRail;
  setBoundsExact(fitWorkArea({ ...b, x: b.x - delta, width: b.width + delta }));
}

// At 125% scaling, setBounds on the frameless window lands a few px larger (+2 wide, +1 tall), and
// repeated rail toggles would add that up. Measure once and set again with the error taken off.
function setBoundsExact(target) {
  win.setBounds(target);
  const got = win.getBounds();
  if (got.x === target.x && got.y === target.y && got.width === target.width && got.height === target.height) return;
  win.setBounds({ x: 2 * target.x - got.x, y: 2 * target.y - got.y, width: 2 * target.width - got.width, height: 2 * target.height - got.height });
}

function defaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 874;
  const height = 552;
  return { width, height, x: workArea.x + workArea.width - width - 24, y: workArea.y + workArea.height - height - 24 };
}

function boundsAreVisible(b) {
  return screen.getAllDisplays().some(({ workArea: w }) =>
    b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + b.height > w.y);
}

let startQuiet = true;

function createWindow() {
  const bounds = fitWorkArea(withRail(state.bounds && boundsAreVisible(state.bounds) ? state.bounds : defaultBounds()));
  const material = isWin && config.backgroundMaterial !== 'none' ? config.backgroundMaterial : undefined;

  win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH + railWidth(),
    minHeight: 180,
    frame: false,
    show: false,
    resizable: true,
    maximizable: true,
    fullscreenable: true,
    alwaysOnTop: state.alwaysOnTop ?? config.alwaysOnTop,
    skipTaskbar: !config.showInTaskbar,
    backgroundColor: material ? '#00000000' : config.theme.background,
    backgroundMaterial: material,
    roundedCorners: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    title: 'Gremlin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  win.setOpacity(clampOpacity(state.opacity ?? config.opacity));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Maximize only after showing at the normal bounds: maximizing a hidden frameless window
  // makes Windows restore it a few pixels off.
  // Start minimized applies to the window opened at launch only; the hotkey or tray reopens it normally.
  const quiet = startQuiet && config.startMinimized;
  startQuiet = false;
  win.once('ready-to-show', () => {
    // In the tray (no taskbar button) it simply stays hidden; with a taskbar button it opens minimized.
    if (quiet && !config.showInTaskbar) {
      if (state.maximized) win.once('show', () => win.maximize()); // maximize only once it is shown, as below
      return;
    }
    if (quiet) win.showInactive(); else win.show();
    setBoundsExact(bounds);
    if (state.maximized) win.maximize();
    if (quiet) win.minimize();
  });

  const saveState = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    // Keep the normal bounds while maximized or full screen, so leaving either returns to them.
    const zoomed = win.isMaximized() || win.isFullScreen();
    if (!zoomed) {
      const b = win.getBounds();
      state.bounds = { ...b, x: b.x + railWidth(), width: b.width - railWidth() };
    }
    if (!win.isFullScreen()) state.maximized = win.isMaximized();
    writeJson(statePath, state);
  };
  win.on('moved', saveState);
  win.on('resized', saveState);
  win.on('close', saveState);
  win.on('closed', () => { win = null; });
  win.on('focus', scanProjects);
  const sendZoom = () => send('win:zoom', { maximized: win.isMaximized(), fullScreen: win.isFullScreen() });
  win.webContents.on('did-finish-load', sendZoom);
  win.webContents.on('did-finish-load', () => { if (pendingToast) { send('toast', pendingToast); pendingToast = null; } });
  for (const ev of ['maximize', 'enter-full-screen']) win.on(ev, () => { if (zoomRail === null) zoomRail = railWidth(); });
  // These events fire before Windows finishes the transition (and in bursts), so read the state once it settles.
  let zoomTimer;
  const onZoomChange = () => {
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      sendZoom();
      // The rail changed while zoomed: Windows restored the old outer size, so apply the saved bounds plus today's rail.
      if (!win.isMaximized() && !win.isFullScreen() && zoomRail !== null) {
        if (zoomRail !== railWidth() && state.bounds) setBoundsExact(fitWorkArea(withRail(state.bounds)));
        zoomRail = null;
      }
      // Only the flag: bounds read mid-transition can be off, so they are saved on user moves/resizes only.
      if (!win.isFullScreen()) state.maximized = win.isMaximized();
      writeJson(statePath, state);
    }, 150);
  };
  for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, onZoomChange);

  // Open links (Claude's login URL, docs links) in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// The sign-in entry only makes sense for the installed app (a dev run would register electron.exe). Linux has no
// login-item API, so there it is an autostart .desktop file (src/autostart.js).
function applyLoginItem() {
  if (!app.isPackaged) return;
  if (process.platform !== 'linux') return app.setLoginItemSettings({ openAtLogin: !!config.launchOnStartup });
  const file = autostart.entryPath(os.homedir(), process.env);
  try {
    if (config.launchOnStartup) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, autostart.desktopEntry(process.env.APPIMAGE || process.execPath));
    } else if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch (err) {
    console.error('Autostart entry:', err.message);
  }
}

function clampOpacity(v) {
  return Math.min(1, Math.max(0.3, Number(v) || 1));
}

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Session output also goes to attached remote clients. Aux terminals use plain send(): they stay on this computer.
function sessionSend(channel, payload) {
  send(channel, payload);
  if (channel === 'pty:data') remoteHost.output(payload.id, payload.data);
  else if (channel === 'pty:exit') remoteHost.exited(payload.id, payload.code);
  else if (channel === 'workers:events') remoteHost.broadcast('workers', payload);
  else if (channel === 'status:update') remoteHost.broadcast('status', payload);
}

// ---------------------------------------------------------------------------
// Projects: subfolders of projectsRoot plus pinned extras, minus hidden ones
// ---------------------------------------------------------------------------
let saved = loadSaved();
let projectList = [];
let rootWarned = false;
let rootWatcher = null;

function loadSaved() {
  const raw = readJson(projectsPath, {});
  const strs = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x) : []);
  const names = raw.names && typeof raw.names === 'object' && !Array.isArray(raw.names) ? raw.names : {};
  return { pinned: strs(raw.pinned), hidden: strs(raw.hidden), names };
}

function projectsRoot() {
  return config.projectsRoot || path.join(os.homedir(), 'Projects');
}

function scanRoot() {
  const root = projectsRoot();
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => path.join(root, d.name));
  } catch {
    if (!rootWarned) {
      rootWarned = true;
      send('toast', `Projects folder not found: ${root}`);
    }
    return null;
  }
}

function scanProjects() {
  const scanned = scanRoot();
  const list = projects.buildList({ scanned: scanned || [], pinned: saved.pinned, hidden: saved.hidden, names: saved.names, exists: (p) => fs.existsSync(p), isWin });
  for (const p of list) {
    const main = p.missing ? null : gitOps.worktreeMain(p.path);
    if (main) p.worktreeOf = path.basename(main);
  }
  // A running session keeps its row even if its folder disappeared or was hidden, until it is closed.
  const known = new Set(list.map((p) => p.id));
  for (const id of sessions.ids()) {
    if (known.has(id)) continue;
    const cwd = sessions.cwd(id);
    const folder = path.basename(cwd) || cwd;
    const name = projects.displayName(saved.names, id, folder);
    list.push({ id, path: cwd, name, folder, initials: projects.initials(name), pinned: false, missing: !fs.existsSync(cwd), orphan: true });
  }
  list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  projectList = list;
  sendProjects();
  if (scanned && !rootWatcher) watchRoot();
}

function sendProjectsLocal() {
  send('projects:list', { list: projectList.concat(remote.list()), open: sessions.ids().concat(remote.openIds()), active: activeId, remoteHosts: remote.hosts() });
}
function sendProjects() {
  sendProjectsLocal();
  remoteHost.projectsChanged();
}

function watchRoot() {
  let timer;
  try {
    rootWatcher = fs.watch(projectsRoot(), { persistent: false }, () => {
      clearTimeout(timer);
      timer = setTimeout(scanProjects, 300);
    });
    rootWatcher.on('error', () => { rootWatcher.close(); rootWatcher = null; });
  } catch {
    rootWatcher = null;
  }
}

function saveProjects() {
  writeJson(projectsPath, saved);
  scanProjects();
}

// Launch: activeProject from window state, else config.cwd if it is a project, else the first project.
function initialActive() {
  const usable = (id) => projectList.find((p) => p.id === id && !p.missing);
  const hit = (state.activeProject && usable(state.activeProject)) || usable(projects.normId(config.cwd, isWin)) || projectList.find((p) => !p.missing);
  return hit ? hit.id : null;
}

// Remembers which projects have a session, so the next launch can reopen them (restoreSessions).
function saveOpen() {
  const ids = sessions.ids();
  if (JSON.stringify(ids) === JSON.stringify(state.openProjects)) return;
  state.openProjects = ids;
  writeJson(statePath, state);
}

// What each project has cost so far, for the switcher: one ccusage run, kept for ten minutes.
let spendCache = null;
let spendAt = 0;
let spendBusy = null;
ipcMain.handle('usage:projects', async () => {
  if (spendCache && Date.now() - spendAt < 600000) return spendCache;
  if (!spendBusy) {
    spendBusy = usageStats.load({ dirs: [claudeDir()], ccusage: ccusageCommand(), isWin })
      .then((u) => {
        const by = usageStats.byProject(u.sessions, projectList);
        spendCache = Object.fromEntries(Object.entries(by).map(([id, x]) => [id, usageStats.formatSpend(x)]));
        spendAt = Date.now();
        return spendCache;
      })
      .catch(() => ({}))
      .finally(() => { spendBusy = null; });
  }
  return spendBusy;
});

const savedPrompts = require('./prompts');
ipcMain.handle('prompts:get', () => savedPrompts.normalize(readJson(promptsPath, [])));
ipcMain.handle('prompts:set', (_e, list) => {
  const clean = savedPrompts.normalize(list);
  writeJson(promptsPath, clean);
  return clean;
});

ipcMain.handle('projects:get', () => {
  scanProjects();
  const usable = (id) => projectList.some((p) => p.id === id && !p.missing);
  const restore = config.restoreSessions === false ? [] : (Array.isArray(state.openProjects) ? state.openProjects : []).filter(usable);
  return { list: projectList.concat(remote.list()), open: sessions.ids().concat(remote.openIds()), active: initialActive(), restore, remoteHosts: remote.hosts() };
});

// Makes a project active, starting its session the first time. Returns false for a missing folder.
// link: the session only joins the current project's tabs (Open in tab), so the active project stays as it is.
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

function closeSession(id) {
  aux.closeProject(id);
  if (!sessions.close(id)) return;
  saveOpen();
  send('session:closed', { id });
  scanProjects();
  remoteHost.broadcast('closed', { id });
  remoteHost.drop(id);
}

ipcMain.on('pty:input', (_e, { id, data }) => (remote.has(id) ? remote.write(id, data) : aux.has(id) ? aux.write(id, data) : sessions.write(id, data)));
ipcMain.on('pty:resize', (_e, { id, cols, rows }) => (remote.has(id) ? remote.resize(id, cols, rows) : aux.has(id) ? aux.resize(id, cols, rows) : sessions.resize(id, cols, rows)));
ipcMain.on('pty:restart', (_e, { id, cols, rows }) => {
  if (remote.has(id)) return remote.restart(id, cols, rows);
  if (aux.has(id)) return aux.restart(id, cols, rows);
  remoteHost.restarted(id); // a restarted session starts a fresh screen for everyone watching it
  sessions.restart(id, cols, rows);
});
ipcMain.on('session:close', (_e, { id }) => (remote.has(id) ? remote.close(id) : aux.has(id) ? aux.close(id) : closeSession(id)));
ipcMain.handle('aux:get', () => aux.list());
// Split view with only the Claude tab: a new terminal for the bottom zone.
ipcMain.on('aux:newShell', (_e, projectId) => { if (projectPath(projectId)) openAux(projectId, { kind: 'shell', title: 'Terminal', zone: 1 }); });

// The run button: the project's tasks (src/tasks.js) and a new terminal.
ipcMain.on('run:menu', () => {
  const id = activeId;
  const root = projectPath(id);
  if (!root || !win) return;
  const ps = /(^|[\\/])(powershell|pwsh)(\.exe)?$/i.test(config.shell || (isWin ? 'powershell.exe' : ''));
  const list = tasks.detectTasks(root, { isWin, ps });
  // One dropdown per toolchain (npm, SPFx, C# / .NET, Python, ...), with Run / Test / Package / Setup inside.
  const item = (t) => ({ label: t.label, sublabel: t.command, toolTip: t.command, click: () => startTask(id, t) });
  const items = [...new Set(list.map((t) => t.group))].map((g) => {
    const inGroup = list.filter((t) => t.group === g);
    const sub = inGroup.filter((t) => t.first).map((t) => ({ ...item(t), label: `${t.label} (needed first)` }));
    for (const s of tasks.SECTIONS) {
      const inSection = inGroup.filter((t) => t.section === s && !t.first);
      if (!inSection.length) continue;
      if (sub.length) sub.push({ type: 'separator' });
      if (s === 'scripts' && inSection.length > 10) sub.push({ label: tasks.SECTION_LABELS[s], submenu: inSection.map(item) });
      else sub.push({ label: tasks.SECTION_LABELS[s], enabled: false }, ...inSection.map(item));
    }
    return { label: tasks.GROUP_LABELS[g] || g, submenu: sub };
  });
  if (!list.length) items.push({ label: 'No tasks found in this project', enabled: false });
  items.push({ type: 'separator' });
  items.push({ label: 'New terminal', click: () => openAux(id, { kind: 'shell', title: 'Terminal' }) });
  items.push({ label: 'New terminal below (split)', accelerator: 'Ctrl+Shift+\\', registerAccelerator: false, click: () => openAux(id, { kind: 'shell', title: 'Terminal', zone: 1 }) });
  Menu.buildFromTemplate(items).popup({ window: win });
});

// The shield button: admin terminals, the system change guard, snapshots and the system views.
ipcMain.on('admin:menu', () => {
  if (!win) return;
  const id = activeId;
  const mode = config.guardMode || 'ask';
  const setMode = (m) => {
    setConfig({ guardMode: m });
    send('toast', m === 'off' ? 'System change guard off' : m === 'log' ? 'System changes are logged, not asked about' : 'Claude asks before system changes');
  };
  Menu.buildFromTemplate([
    { label: isWin ? 'Admin terminal (UAC)' : 'Root shell (sudo -s)', enabled: !!projectPath(id), click: () => openAux(id, { kind: 'admin', title: 'Admin' }) },
    ...(isWin ? [{ label: 'Claude as administrator (UAC)', enabled: !!projectPath(id), click: () => openAux(id, { kind: 'admin-claude', title: 'Admin Claude' }) }] : []),
    { type: 'separator' },
    { label: 'Create snapshot…', click: () => workbench.open('system') },
    { label: 'System changes and undo…', click: () => workbench.open('changes') },
    { label: 'System monitor and benchmark…', click: () => workbench.open('system') },
    { label: 'Logs…', click: () => workbench.open('logs') },
    { type: 'separator' },
    { label: 'Before system changes', enabled: false },
    { label: 'Ask first', type: 'radio', checked: mode === 'ask', click: () => setMode('ask') },
    { label: 'Only log them', type: 'radio', checked: mode === 'log', click: () => setMode('log') },
    { label: 'Off', type: 'radio', checked: mode === 'off', click: () => setMode('off') }
  ]).popup({ window: win });
});
ipcMain.on('workbench:open', (_e, tab) => workbench.open(tab));

// Row context menu: Close session, Rename…, Open in Explorer, then Hide (scanned) or Unpin (pinned extras).
// Right-click menu of a tab: resolves with the chosen action ('rename', 'pin', 'close', 'move') or null.
ipcMain.handle('tab:menu', (_e, { pinned, closable, split }) => new Promise((resolve) => {
  if (!win) return resolve(null);
  const items = [
    { label: 'Rename…', click: () => resolve('rename') },
    { label: pinned ? 'Unpin' : 'Pin', click: () => resolve('pin') },
    { label: split ? 'Move to the other zone' : 'Move to the lower zone', click: () => resolve('move') }
  ];
  if (closable) items.push({ type: 'separator' }, { label: 'Close', click: () => resolve('close') });
  Menu.buildFromTemplate(items).popup({ window: win, callback: () => setTimeout(() => resolve(null), 50) });
}));

// Per-project session defaults (model, permission mode, env); read again at every session start.
const projDefaults = require('./project-defaults');
const loadDefaults = () => readJson(defaultsPath, {});
ipcMain.handle('project:setDefaults', (_e, { id, text }) => {
  const r = projDefaults.parseText(text);
  if (r.error) return { error: r.error };
  const all = loadDefaults();
  if (projDefaults.isEmpty(r.defaults)) delete all[id]; else all[id] = r.defaults;
  writeJson(defaultsPath, all);
  return { ok: true };
});

ipcMain.on('project:menu', (_e, { id }) => {
  if (remote.has(id)) {
    // Phase 1: opening is a click, restart is Ctrl+Shift+R, so the menu only has Close.
    if (remote.isOpen(id) && win) Menu.buildFromTemplate([{ label: 'Close session', click: () => remote.close(id) }]).popup({ window: win });
    return;
  }
  const p = projectList.find((x) => x.id === id);
  if (!p || !win) return;
  const items = [];
  // Its Claude session as a tab next to the current project's, which can then be moved to the lower zone.
  if (activeId && id !== activeId) items.push({ label: 'Open in tab', enabled: !p.missing, click: () => send('project:linkTab', { id }) });
  if (sessions.has(id)) items.push({ label: 'Close session', click: () => closeSession(id) });
  if (items.length) items.push({ type: 'separator' });
  items.push({ label: 'Rename…', enabled: !p.missing && !p.orphan, click: () => send('project:renameAsk', { id, name: p.name, path: p.path, open: sessions.has(id) }) });
  items.push({ label: 'Session defaults…', click: () => send('project:defaultsAsk', { id, name: p.name, text: projDefaults.formatText(loadDefaults()[id]), open: sessions.has(id) }) });
  items.push({ label: 'Open in Explorer', enabled: !p.missing, click: () => shell.openPath(p.path) });
  // Worktree sessions: a second checkout of the repo on its own branch, listed as its own project.
  if (!p.missing && fs.existsSync(path.join(p.path, '.git'))) {
    items.push({ type: 'separator' }, { label: 'New worktree session…', click: () => send('worktree:ask', { id, name: p.worktreeOf || p.name }) });
    if (p.worktreeOf) items.push({ label: 'Remove this worktree…', click: () => removeWorktree(p) });
  }
  items.push({ type: 'separator' });
  if (p.pinned) {
    items.push({ label: 'Unpin', click: () => { saved.pinned = saved.pinned.filter((x) => projects.normId(x, isWin) !== id); saveProjects(); } });
  } else if (!p.orphan) {
    items.push({ label: 'Hide', click: () => { saved.hidden.push(id); saveProjects(); } });
  }
  Menu.buildFromTemplate(items).popup({ window: win });
});

// The + button: Add folder… (pinned) and Show hidden (n), which un-hides one project.
ipcMain.on('projects:addMenu', () => {
  if (!win) return;
  const hidden = saved.hidden;
  Menu.buildFromTemplate([
    { label: 'Add folder…', click: addFolder },
    {
      label: `Show hidden (${hidden.length})`,
      enabled: hidden.length > 0,
      submenu: hidden.map((h) => ({ label: h, click: () => { saved.hidden = saved.hidden.filter((x) => x !== h); saveProjects(); } }))
    }
  ]).popup({ window: win });
});

async function addFolder() {
  const r = await dialog.showOpenDialog(win, { title: 'Add project folder', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return;
  const dir = r.filePaths[0];
  const id = projects.normId(dir, isWin);
  saved.hidden = saved.hidden.filter((x) => projects.normId(x, isWin) !== id);
  if (!saved.pinned.some((x) => projects.normId(x, isWin) === id)) saved.pinned.push(dir);
  saveProjects();
  send('projects:select', { id });
}

// Renames a project's folder and Claude's history for it (project-rename.js), then reopens its session,
// which continues the same conversation. Everything running in the folder is stopped first: Windows won't
// rename a folder a process is working in. If it still can't, the session comes back under the old name.
ipcMain.handle('project:rename', async (_e, { id, name }) => {
  const p = projectList.find((x) => x.id === id);
  if (!p || p.missing || p.orphan) return { error: 'Project not found' };
  const n = String(name || '').trim();
  const bad = projectRename.nameError(n, isWin);
  if (bad) return { error: bad };
  const to = path.join(path.dirname(p.path), n);
  const newId = projects.normId(to, isWin);
  const unname = () => { saved.names = projects.setName(saved.names, id, ''); }; // a 0.8.0 display name
  if (to === p.path) { unname(); saveProjects(); return { id }; }
  if (newId !== id && fs.existsSync(to)) return { error: `${path.dirname(p.path)} already has a folder named ${n}.` };

  const reopen = sessions.has(id) && activeId === id;
  closeSession(id);
  browser.releaseDir(p.path);
  const err = await projectRename.renameWithRetry(p.path, to);
  if (err) {
    if (reopen) send('projects:select', { id });
    return { error: err.code === 'ENOENT' ? `${p.path} is gone.` : `Something still has the folder open (an editor, Explorer, or a program started from it). Close it and try again. (${err.code || err.message})` };
  }
  try {
    projectRename.moveHistory(claudeDir(), p.path, to, { isWin });
  } catch (e) {
    send('toast', `Renamed, but Claude's history stayed under the old name: ${e.message}`);
  }
  // Worktrees keep absolute paths to each other; git fixes them from either side.
  if (fs.existsSync(path.join(to, '.git'))) await gitOps.git(to, ['worktree', 'repair']);
  const same = (x) => projects.normId(x, isWin) === id;
  saved.pinned = saved.pinned.map((x) => (same(x) ? to : x));
  saved.hidden = saved.hidden.filter((x) => !same(x));
  unname();
  if (state.activeProject === id) { state.activeProject = newId; writeJson(statePath, state); }
  saveProjects();
  if (reopen) send('projects:select', { id: newId });
  return { id: newId };
});

ipcMain.handle('worktree:create', async (_e, { id, branch }) => {
  const p = projectList.find((x) => x.id === id);
  const b = String(branch || '').trim();
  if (!p || p.missing) return { error: 'Project not found' };
  if (!gitOps.validBranch(b)) return { error: 'Not a valid branch name' };
  const st = await gitOps.status(p.path);
  if (!st.repo) return { error: 'Not a git repository' };
  const mainDir = gitOps.worktreeMain(p.path) || st.top;
  const dir = gitOps.worktreeDir(projectsRoot(), path.basename(mainDir), b);
  if (fs.existsSync(dir)) return { error: `${dir} already exists` };
  const r = await gitOps.addWorktree(st.top, dir, b);
  if (!r.ok) return { error: r.err || 'git worktree add failed' };
  addProject(dir);
  return { ok: true, dir };
});

async function removeWorktree(p) {
  const mainDir = gitOps.worktreeMain(p.path);
  if (!mainDir) return;
  const choice = dialog.showMessageBoxSync(win, {
    type: 'question', buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Remove the worktree ${p.name}?`,
    detail: `Deletes the folder ${p.path}. Its branch stays in ${path.basename(mainDir)}; commits on it are kept.`
  });
  if (choice !== 0) return;
  closeSession(p.id);
  let r = await gitOps.removeWorktree(mainDir, p.path, false);
  if (!r.ok && /modified or untracked|contains/.test(r.err)) {
    const force = dialog.showMessageBoxSync(win, {
      type: 'warning', buttons: ['Remove anyway', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'This worktree has changes that are not committed.', detail: 'Removing it throws those changes away.'
    });
    if (force !== 0) return;
    r = await gitOps.removeWorktree(mainDir, p.path, true);
  }
  if (!r.ok) send('toast', `Could not remove the worktree: ${r.err}`);
  saved.pinned = saved.pinned.filter((x) => projects.normId(x, isWin) !== p.id);
  saveProjects();
}

// A new folder (wizard, worktree) as a project: listed by the scan if it is in the projects folder, else pinned.
function addProject(dir) {
  const id = projects.normId(dir, isWin);
  if (projects.normId(path.dirname(dir), isWin) !== projects.normId(projectsRoot(), isWin) && !saved.pinned.some((x) => projects.normId(x, isWin) === id)) saved.pinned.push(dir);
  saved.hidden = saved.hidden.filter((x) => projects.normId(x, isWin) !== id);
  saveProjects();
  send('projects:select', { id });
  return id;
}

// Dragging the rail's edge: the window keeps its size and the terminal takes the difference, so the edge follows the cursor.
// The width is saved at the end of the drag (final), and sent back when the terminal's minimum width capped it.
ipcMain.on('rail:resize', (_e, { width, final } = {}) => {
  if (!win || state.railCollapsed) return;
  const next = railLimits.cap(width, win.getBounds().width, MIN_WIDTH);
  state.railWidth = next;
  win.setMinimumSize(MIN_WIDTH + next, 180);
  if (final) {
    writeJson(statePath, state);
    send('rail:state', { collapsed: false, width: next });
  }
});

ipcMain.on('rail:toggle', () => {
  if (!win) return;
  const old = railWidth();
  state.railCollapsed = !state.railCollapsed;
  writeJson(statePath, state);
  applyRail(old);
});

// ---------------------------------------------------------------------------
// Footer: statusLine JSON per session, git status of the active session's folder
// ---------------------------------------------------------------------------
let gitBusy = false;
let lastGit;

// The session's current folder (from its status JSON), else the folder it started in.
function baseCwd(id = activeId) {
  const status = id ? summarize(sessions.status(id)) : null;
  return (status && status.cwd) || (id && sessions.cwd(id)) || (fs.existsSync(config.cwd) ? config.cwd : os.homedir());
}

async function pollGit() {
  if (gitBusy || !activeId || !win || win.isDestroyed() || !win.isVisible()) return;
  gitBusy = true;
  const id = activeId;
  const info = await gitStatus.read(baseCwd(id));
  gitBusy = false;
  if (id !== activeId) return pollGit(); // switched while reading
  const json = JSON.stringify(info);
  if (json !== lastGit) { lastGit = json; send('git:update', { id, info }); }
}

// Every project's git state for the sidebar and the switcher, one repo after another, only when the window is showing.
let allGitBusy = false;
let lastAllGit = {};
async function pollAllGit() {
  if (allGitBusy || !win || win.isDestroyed() || !win.isVisible()) return;
  allGitBusy = true;
  const next = {};
  for (const p of projectList) {
    if (p.missing) continue;
    const info = await gitStatus.read(p.path);
    if (info) next[p.id] = info;
  }
  allGitBusy = false;
  if (JSON.stringify(next) !== JSON.stringify(lastAllGit)) { lastAllGit = next; sendGitAll(); remoteHost.projectsChanged(); }
}

const statusTimer = setInterval(() => sessions.pollStatus(), 500);
const gitTimer = setInterval(pollGit, 3000);
const allGitTimer = setInterval(pollAllGit, 15000);
setTimeout(pollAllGit, 4000);

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

// ---------------------------------------------------------------------------
// Markdown popouts: .md paths clicked in the terminal open rendered in their own window
// ---------------------------------------------------------------------------
const MD_EXT = /\.(md|markdown)$/i;

function resolveMd(p, from) {
  let file = String(p).trim();
  if (/^file:\/\//i.test(file)) {
    try { file = require('url').fileURLToPath(file); } catch { return null; }
  }
  if (file.startsWith('~')) file = path.join(os.homedir(), file.slice(1));
  file = path.resolve(from, file);
  if (!MD_EXT.test(file)) return null;
  try { return fs.statSync(file).isFile() ? file : null; } catch { return null; }
}

function renderMd(file) {
  const { marked } = require('marked');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) { return { file, error: err.message }; }
  // YAML front matter is metadata, not content.
  text = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  return { file, dir: path.dirname(file), html: marked.parse(text, { gfm: true }) };
}

function openMd(file) {
  const key = file.toLowerCase();
  const existing = mdWindows.get(key);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return;
  }
  const md = new BrowserWindow({
    width: 760,
    height: 860,
    title: path.basename(file),
    backgroundColor: config.theme.background,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'md', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  md.setMenu(null);
  md.mdFile = file;
  mdWindows.set(key, md);
  const push = () => !md.isDestroyed() && md.webContents.send('md:render', renderMd(file));
  md.webContents.on('did-finish-load', push);
  // Re-render when the file changes on disk, e.g. while Claude is still editing it.
  const onChange = (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) push(); };
  fs.watchFile(file, { interval: 500 }, onChange);
  md.on('closed', () => {
    fs.unwatchFile(file, onChange);
    if (mdWindows.get(key) === md) mdWindows.delete(key);
  });
  md.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  md.webContents.on('will-navigate', (e) => e.preventDefault());
  md.loadFile(path.join(__dirname, 'md', 'md.html'));
}

// Markdown files of a project, for paths Claude prints relative to a subfolder or as a bare name.
// Cached briefly: the link provider asks once per hovered row.
const mdIndex = new Map();
function projectMdFiles(root) {
  const hit = mdIndex.get(root);
  if (hit && Date.now() - hit.at < 5000) return hit.files;
  const entry = { at: Date.now(), files: files.mdFiles(root) };
  mdIndex.set(root, entry);
  return entry.files;
}

// A printed path as-is (relative to the session's folder), else the project file it is the tail of.
function findMd(p, id) {
  const from = baseCwd(id);
  const direct = resolveMd(p, from);
  if (direct) return direct;
  const root = projectPath(id);
  if (!root) return null;
  const rel = files.findByTail(projectMdFiles(root), p, isWin);
  return rel ? resolveMd(rel, root) : null;
}

// Candidates come from md-links.js, longest first; the first one that is an existing file wins.
ipcMain.handle('md:resolve', (_e, { candidates, id }) => {
  if (!Array.isArray(candidates)) return null;
  for (let i = 0; i < candidates.length && i < 16; i++) {
    const file = findMd(candidates[i], owner(id));
    if (file) return { index: i, file };
  }
  return null;
});
ipcMain.on('md:open', (_e, { file: p, id }) => {
  const file = findMd(p, owner(id));
  if (file) openMd(file);
});
// Links inside a popout: web links go to the browser, other Markdown files open in their own popout.
ipcMain.on('md:link', (_e, { href, from }) => {
  if (/^https?:\/\//i.test(href)) return shell.openExternal(href);
  let target;
  try { target = decodeURIComponent(String(href).split('#')[0]); } catch { return; }
  const file = target && resolveMd(target, path.dirname(String(from)));
  if (file) openMd(file);
});

// ---------------------------------------------------------------------------
// Editor windows: text files open in Monaco (src/editor), one window per file
// ---------------------------------------------------------------------------
const editors = new Map(); // lower-cased path -> { win, file, line, bom, disk, dirty, forceClose }

function readForEdit(file) {
  const buf = fs.readFileSync(file);
  const bom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  return { text: buf.toString('utf8', bom ? 3 : 0), bom };
}

const editorFor = (sender) => {
  const w = BrowserWindow.fromWebContents(sender);
  for (const e of editors.values()) if (e.win === w) return e;
  return null;
};

function openInVSCode(file, line) {
  shell.openExternal(files.vscodeUrl(file, line)).catch(() => send('toast', 'VS Code did not open. Is it installed?'));
}

function openEditor(file, line) {
  const key = file.toLowerCase();
  const existing = editors.get(key);
  if (existing && !existing.win.isDestroyed()) {
    if (existing.win.isMinimized()) existing.win.restore();
    existing.win.show();
    existing.win.focus();
    return;
  }
  const ed = new BrowserWindow({
    width: 900,
    height: 820,
    title: path.basename(file),
    backgroundColor: config.theme.background,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'editor', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  ed.setMenu(null);
  const e = { win: ed, file, line, bom: false, disk: null, dirty: false, forceClose: false };
  editors.set(key, e);

  // Changes on disk (Claude editing the file) go to the page, which reloads or offers to.
  const onChange = (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs || ed.isDestroyed()) return;
    let read;
    try { read = readForEdit(file); } catch { return; }
    if (read.text === e.disk) return; // our own save
    e.disk = read.text;
    e.bom = read.bom;
    ed.webContents.send('editor:changed', read.text);
  };
  fs.watchFile(file, { interval: 500 }, onChange);

  ed.on('close', (ev) => {
    if (!e.dirty || e.forceClose) return;
    ev.preventDefault();
    const choice = dialog.showMessageBoxSync(ed, {
      type: 'warning',
      buttons: ['Save', "Don't save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: `Save changes to ${path.basename(file)}?`
    });
    if (choice === 0) ed.webContents.send('editor:saveAndClose');
    else if (choice === 1) { e.forceClose = true; ed.close(); }
  });
  ed.on('closed', () => {
    fs.unwatchFile(file, onChange);
    if (editors.get(key) === e) editors.delete(key);
  });
  ed.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  ed.webContents.on('will-navigate', (ev) => ev.preventDefault());
  ed.loadFile(path.join(__dirname, 'editor', 'editor.html'));
}

ipcMain.handle('editor:get', (ev) => {
  const e = editorFor(ev.sender);
  if (!e) return null;
  try {
    const { text, bom } = readForEdit(e.file);
    e.disk = text;
    e.bom = bom;
    return { file: e.file, name: path.basename(e.file), text, line: e.line, fontFamily: config.fontFamily, fontSize: config.fontSize };
  } catch (err) {
    return { file: e.file, name: path.basename(e.file), error: err.message };
  }
});

// Keeps a UTF-8 BOM if the file had one; line endings are whatever the text already uses.
ipcMain.handle('editor:save', (ev, text) => {
  const e = editorFor(ev.sender);
  if (!e || typeof text !== 'string') return { error: 'No file' };
  try {
    e.disk = text;
    fs.writeFileSync(e.file, (e.bom ? '﻿' : '') + text, 'utf8');
    e.dirty = false;
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.on('editor:dirty', (ev, dirty) => { const e = editorFor(ev.sender); if (e) e.dirty = !!dirty; });
ipcMain.on('editor:vscode', (ev, line) => { const e = editorFor(ev.sender); if (e) openInVSCode(e.file, Number(line) || undefined); });
ipcMain.on('editor:close', (ev) => { const e = editorFor(ev.sender); if (e) { e.forceClose = true; e.win.close(); } });

// The Markdown viewer's Edit and VS Code buttons act on the file that viewer shows.
const mdFileOf = (sender) => { const w = BrowserWindow.fromWebContents(sender); return w && w.mdFile; };
ipcMain.on('md:edit', (ev) => { const f = mdFileOf(ev.sender); if (f) openEditor(f); });
ipcMain.on('md:vscode', (ev) => { const f = mdFileOf(ev.sender); if (f) openInVSCode(f); });

// Built-in browser (src/browser-window.js): mockups, local dev servers, screenshots.
const browser = createBrowser({ icon: path.join(__dirname, '..', 'assets', 'icon.png'), projectDir: () => projectPath(activeId), isWin });
browser.handle(ipcMain);
ipcMain.on('browser:open', () => browser.open());
// Sessions started after this listens get GREMLIN_BROWSER(_TOKEN) for widget-browser (see openEnv).
const control = config.browserControl === false ? null : createControl({ browser });

// ---------------------------------------------------------------------------
// Files pane: browse the active project's folder
// ---------------------------------------------------------------------------
function projectPath(id) {
  if (!id) return null;
  const p = projectList.find((x) => x.id === id);
  return (p && !p.missing && p.path) || (sessions.has(id) ? sessions.cwd(id) : null);
}

ipcMain.on('files:setOpen', (_e, open) => {
  state.filesOpen = !!open;
  writeJson(statePath, state);
});

ipcMain.handle('files:list', (_e, { id, rel }) => {
  const root = projectPath(id);
  if (!root) return null;
  return { root, entries: files.listDir(root, rel) };
});

function fileTarget(id, rel) {
  const root = projectPath(id);
  return root ? files.safeJoin(root, rel) : null;
}

// Click: Markdown opens in the viewer, other text files in the editor, runnable binaries are shown in
// Explorer, the rest open in their default app.
ipcMain.on('files:open', (_e, { id, rel }) => {
  const file = fileTarget(id, rel);
  if (!file || !fs.existsSync(file)) return;
  const action = files.openAction(file, files.isTextFile);
  if (action === 'md') openMd(file);
  else if (action === 'browse') browser.open(file);
  else if (action === 'edit') openEditor(file);
  else if (action === 'reveal') shell.showItemInFolder(file);
  else shell.openPath(file);
});

let searchSeq = 0;
ipcMain.handle('files:search', async (_e, { id, query, regex, caseSensitive }) => {
  const root = projectPath(id);
  if (!root) return null;
  const seq = ++searchSeq;
  const r = await searchProject(root, query, { regex, caseSensitive, isCancelled: () => seq !== searchSeq });
  return r && { ...r, root };
});
// Ctrl+Shift+H: file contents in every project at once, a few hits from each so a common word does not drown the rest.
let searchAllSeq = 0;
ipcMain.handle('files:searchAll', async (_e, { query }) => {
  const seq = ++searchAllSeq;
  const rows = [];
  for (const p of projectList) {
    if (p.missing || seq !== searchAllSeq) continue;
    const r = await searchProject(p.path, query, { maxHits: 12, maxFiles: 8000, isCancelled: () => seq !== searchAllSeq });
    if (!r) return null; // a newer search took over
    for (const f of r.files.slice(0, 5)) rows.push({ id: p.id, project: p.name, rel: f.rel, line: 0, text: '' });
    for (const hit of r.hits) for (const m of hit.matches.slice(0, 3)) rows.push({ id: p.id, project: p.name, rel: hit.rel, line: m.line, text: m.text });
  }
  return rows.slice(0, 200);
});
ipcMain.handle('files:git', async (_e, { id }) => {
  const root = projectPath(id);
  if (!root) return null;
  const st = await gitOps.status(root);
  return st.repo ? gitOps.badgeMap(st.files, st.prefix) : null;
});
ipcMain.on('files:openAt', (_e, { id, rel, line }) => {
  const file = fileTarget(id, rel);
  if (file && fs.existsSync(file)) openEditor(file, Number(line) || undefined);
});

ipcMain.on('files:menu', (_e, { id, rel, dir }) => {
  const file = fileTarget(id, rel);
  if (!file || !win) return;
  const items = [];
  const action = dir ? null : files.openAction(file, files.isTextFile);
  if (action === 'md') items.push({ label: 'Open in viewer', click: () => openMd(file) });
  if (action === 'browse') items.push({ label: 'Open in browser', click: () => browser.open(file) });
  if (action === 'md' || action === 'edit' || (action === 'browse' && files.isTextFile(file))) items.push({ label: 'Edit', click: () => openEditor(file) });
  if (action === 'open') items.push({ label: 'Open', click: () => shell.openPath(file) });
  items.push({ label: 'Open in VS Code', click: () => openInVSCode(file) });
  if (dir) items.push({ label: 'Open in Explorer', click: () => shell.openPath(file) });
  else items.push({ label: 'Show in Explorer', click: () => shell.showItemInFolder(file) });
  items.push(
    { type: 'separator' },
    { label: 'Copy path', click: () => clipboard.writeText(file) },
    { label: 'Copy relative path', click: () => clipboard.writeText(String(rel).replace(/\//g, path.sep)) }
  );
  Menu.buildFromTemplate(items).popup({ window: win });
});

// ---------------------------------------------------------------------------
// Settings window (src/settings): a form over config.json and the global AGENTS.md
// ---------------------------------------------------------------------------
let settingsWin = null;
const agentsPath = () => path.join(claudeDir(), 'AGENTS.md');
const claudeMdPath = () => path.join(claudeDir(), 'CLAUDE.md');
// Changing these needs a restart: sessions and the terminal read them once.
const RESTART_KEYS = ['shell', 'shellArgs', 'claudeCommand', 'claudeConfigDir', 'env', 'projectsRoot', 'cwd', 'fontFamily', 'fontSize', 'theme', 'backgroundMaterial', 'showInTaskbar'];

function openSettings(tab) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    if (tab) settingsWin.webContents.send('settings:tab', tab);
    return;
  }
  settingsWin = new BrowserWindow({
    width: 860,
    height: 680,
    minWidth: 620,
    minHeight: 420,
    title: 'Gremlin Settings',
    backgroundColor: config.theme.background,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'settings', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  settingsWin.setMenu(null);
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWin.webContents.on('will-navigate', (ev) => ev.preventDefault());
  if (tab) settingsWin.webContents.once('did-finish-load', () => settingsWin.webContents.send('settings:tab', tab));
  settingsWin.on('closed', () => { settingsWin = null; });
  settingsWin.loadFile(path.join(__dirname, 'settings', 'settings.html'));
}

// Opacity and pin state live in window-state.json once changed from the title bar, so show those.
function effectiveSettings() {
  return settingsLib.toForm({
    ...config,
    opacity: win ? win.getOpacity() : (state.opacity ?? config.opacity),
    alwaysOnTop: win ? win.isAlwaysOnTop() : (state.alwaysOnTop ?? config.alwaysOnTop)
  });
}

function registerHotkey(hotkey) {
  globalShortcut.unregisterAll();
  if (hotkey && !globalShortcut.register(hotkey, toggleWindow)) {
    console.warn(`Could not register hotkey ${hotkey}`);
    return false;
  }
  return true;
}

ipcMain.handle('settings:get', () => ({ form: effectiveSettings() }));

ipcMain.handle('settings:save', (_e, formValues) => {
  const { values, errors } = settingsLib.normalize(formValues, DEFAULT_CONFIG);
  if (errors.length) return { errors };
  const raw = readJson(configPath, {});
  const before = loadConfig();
  const next = { ...raw, ...values, theme: { ...(raw.theme || {}), ...(values.theme || {}) } };
  writeJson(configPath, next);
  config = loadConfig();
  const restart = RESTART_KEYS.some((k) => JSON.stringify(before[k]) !== JSON.stringify(config[k]));

  // Applied right away: opacity, pin state, hotkey.
  const warnings = [];
  if (win && !win.isDestroyed()) {
    win.setOpacity(clampOpacity(config.opacity));
    win.setAlwaysOnTop(!!config.alwaysOnTop, 'floating');
  }
  applyLoginItem();
  state.opacity = config.opacity;
  state.alwaysOnTop = !!config.alwaysOnTop;
  writeJson(statePath, state);
  if (before.hotkey !== config.hotkey && !registerHotkey(config.hotkey)) warnings.push(`Hotkey ${config.hotkey} is taken or invalid`);
  watchSysmon();
  send('config:changed', { alwaysOnTop: state.alwaysOnTop, ...rendererToggles() });
  return { form: effectiveSettings(), restart, errors: warnings };
});

// Settings the main window applies live, without a restart.
function rendererToggles() {
  const g = Number(config.guardMinutes);
  return { showSysmon: config.showSysmon !== false, showMascot: config.showMascot !== false, guardMinutes: Number.isFinite(g) && g >= 0 ? g : 5 };
}

function setConfig(values) {
  const raw = readJson(configPath, {});
  writeJson(configPath, { ...raw, ...values });
  config = loadConfig();
  watchSysmon();
  send('config:changed', { alwaysOnTop: win ? win.isAlwaysOnTop() : config.alwaysOnTop, ...rendererToggles() });
  return { ok: true };
}

ipcMain.handle('settings:browse', async (_e, current) => {
  const r = await dialog.showOpenDialog(settingsWin || win, { defaultPath: current || os.homedir(), properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.on('settings:openJson', () => shell.openPath(configPath));
ipcMain.on('settings:restart', () => { app.relaunch(); app.quit(); });

// Setup tab (first launch, and Settings → Setup): which tools this machine has, whether Claude, Git and
// GitHub are signed in / configured, and buttons that install or sign in through a visible terminal.
const { execFile, spawn: spawnProcess } = require('child_process');

const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 8000, windowsHide: true, ...opts }, (err, stdout, stderr) =>
    resolve({ ok: !err, code: err ? err.code : 0, out: String(stdout || '').trim(), err: String(stderr || '').trim() }));
});

// Installers change PATH for new processes only, so read it fresh (registry on Windows, a login shell on
// Linux) and adopt it: tools installed from the Setup tab then work without restarting the widget.
async function refreshPath() {
  if (isWin) {
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "[Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'))"]);
    if (r.ok && r.out) process.env.PATH = r.out;
  } else {
    const r = await run(process.env.SHELL || '/bin/bash', ['-lc', 'printf %s "$PATH"']);
    if (r.ok && r.out) process.env.PATH = r.out;
  }
  const local = path.join(os.homedir(), '.local', 'bin'); // Claude Code's native installer
  const sep = isWin ? ';' : ':';
  if (!process.env.PATH.split(sep).some((d) => path.resolve(d) === path.resolve(local))) process.env.PATH += sep + local;
}

function findTool(tool) {
  const env = { ...process.env, ...config.env };
  const p = setupChecks.plat(isWin);
  const hit = launch.findOnPath(tool.bins[p], { env, isWin });
  if (hit) return hit;
  return ((tool.extraPaths || {})[p] || []).map((rel) => path.join(os.homedir(), rel)).find((x) => fs.existsSync(x)) || null;
}

const version = async (file) => {
  const r = /\.(cmd|bat)$/i.test(file)
    ? await run(process.env.ComSpec || 'cmd.exe', ['/d', '/c', `"${file}" --version`], { windowsVerbatimArguments: true })
    : await run(file, ['--version']);
  return r.ok ? r.out.split(/\r?\n/)[0].slice(0, 80) : '';
};

const linuxPm = () => (isWin ? null : setupChecks.LINUX_PMS.find((pm) => launch.findOnPath([pm.bin], { isWin: false })) || null);

ipcMain.handle('setup:get', async () => {
  await refreshPath();
  const pm = linuxPm();
  const tools = await Promise.all(setupChecks.TOOLS.map(async (t) => {
    const found = findTool(t);
    return {
      id: t.id,
      name: t.name,
      why: t.why,
      required: !!t.required,
      path: found,
      version: found ? await version(found) : '',
      canInstall: !!setupChecks.installCommand(t, { isWin, pm }),
      installCommand: setupChecks.installCommand(t, { isWin, pm })
    };
  }));
  const byId = Object.fromEntries(tools.map((t) => [t.id, t]));

  // Claude: signed in when its credentials file exists or an API key is set (the file is never read).
  const claudeSignedIn = fs.existsSync(path.join(claudeDir(), '.credentials.json')) ||
    !!(process.env.ANTHROPIC_API_KEY || (config.env || {}).ANTHROPIC_API_KEY);
  let gitName = '';
  let gitEmail = '';
  if (byId.git.path) {
    gitName = (await run(byId.git.path, ['config', '--global', 'user.name'])).out;
    gitEmail = (await run(byId.git.path, ['config', '--global', 'user.email'])).out;
  }
  const ghSignedIn = byId.gh.path ? (await run(byId.gh.path, ['auth', 'status'])).ok : false;

  const info = launchInfo();
  return {
    isWin,
    pm: pm ? pm.id : null,
    tools,
    claudeSignedIn,
    claudeDir: claudeDir(),
    git: { name: gitName, email: gitEmail },
    ghSignedIn,
    gitBash: info.gitBash,
    runtime: info.runtime,
    globalHooks: JSON.stringify(globalClaudeSettings().hooks || {}).includes('workers-hook.js')
  };
});

// Runs a command from the setup table in a new terminal window, so the user sees prompts and output.
// Same Claude config folder as widget sessions, so "Sign in" signs those sessions in.
// detached: false for a launcher that asks for UAC (Start-Process -Verb RunAs): started with no console of its own, PowerShell never shows the prompt.
const spawnDetached = (cmd, args, { detached = true } = {}) => new Promise((resolve) => {
  try {
    const child = spawnProcess(cmd, args, { detached, stdio: 'ignore', windowsHide: !detached, env: { ...process.env, ...claudeEnv() } });
    child.on('error', () => resolve(false));
    child.on('spawn', () => { child.unref(); resolve(true); });
  } catch { resolve(false); }
});

function runInTerminal(command) {
  const tryRun = spawnDetached;
  if (isWin) return tryRun('powershell.exe', ['-NoExit', '-NoProfile', '-Command', command]);
  const script = `${command}; echo; read -p "Done. Press Enter to close."`;
  const terms = [
    ['x-terminal-emulator', ['-e', 'bash', '-lc', script]],
    ['kgx', ['--', 'bash', '-lc', script]],
    ['gnome-terminal', ['--', 'bash', '-lc', script]],
    ['konsole', ['-e', 'bash', '-lc', script]],
    ['alacritty', ['-e', 'bash', '-lc', script]],
    ['kitty', ['bash', '-lc', script]],
    ['foot', ['bash', '-lc', script]],
    ['xterm', ['-e', 'bash', '-lc', script]]
  ];
  return (async () => {
    for (const [cmd, args] of terms) if (await tryRun(cmd, args)) return true;
    return false;
  })();
}

// kind: 'install' or 'signin'; id: a tool id from the table.
ipcMain.handle('setup:run', async (_e, { kind, id }) => {
  const tool = setupChecks.TOOLS.find((t) => t.id === id);
  if (!tool) return { ok: false };
  const command = kind === 'install' ? setupChecks.installCommand(tool, { isWin, pm: linuxPm() })
    : kind === 'signin' ? setupChecks.signInCommand(id, isWin) : null;
  if (!command) return { ok: false };
  const ok = await runInTerminal(command);
  if (!ok) clipboard.writeText(command);
  return { ok, command };
});

ipcMain.handle('setup:gitIdentity', async (_e, { name, email }) => {
  const git = findTool(setupChecks.TOOLS.find((t) => t.id === 'git'));
  if (!git) return { error: 'Git is not installed' };
  const n = setupChecks.cleanIdentity(name);
  const m = setupChecks.cleanIdentity(email);
  if (!n) return { error: 'Enter your name' };
  if (!setupChecks.looksLikeEmail(m)) return { error: 'Enter a valid email' };
  const a = await run(git, ['config', '--global', 'user.name', n]);
  const b = await run(git, ['config', '--global', 'user.email', m]);
  return a.ok && b.ok ? { ok: true } : { error: a.err || b.err || 'git config failed' };
});

ipcMain.on('setup:done', () => { state.setupDone = true; writeJson(statePath, state); });

ipcMain.handle('agents:get', () => {
  let text = '';
  let exists = false;
  try { text = fs.readFileSync(agentsPath(), 'utf8'); exists = true; } catch { /* not created yet */ }
  if (!exists) text = '# Global instructions\n\nThese apply to every project.\n\n- \n';
  let claudeMd = '';
  try { claudeMd = fs.readFileSync(claudeMdPath(), 'utf8'); } catch { /* none yet */ }
  return { path: agentsPath(), claudeMd: claudeMdPath(), text, exists, linked: settingsLib.hasImport(claudeMd) };
});

// Writes AGENTS.md, then makes sure ~/.claude/CLAUDE.md imports it (Claude Code reads CLAUDE.md, not AGENTS.md).
ipcMain.handle('agents:save', (_e, text) => {
  if (typeof text !== 'string') return { error: 'Nothing to save' };
  try {
    fs.mkdirSync(path.dirname(agentsPath()), { recursive: true });
    fs.writeFileSync(agentsPath(), text, 'utf8');
    let claudeMd = '';
    try { claudeMd = fs.readFileSync(claudeMdPath(), 'utf8'); } catch { /* created below */ }
    const updated = settingsLib.ensureImport(claudeMd);
    if (updated !== null) fs.writeFileSync(claudeMdPath(), updated, 'utf8');
    return { ok: true, linked: true, claudeMd: claudeMdPath() };
  } catch (err) {
    return { error: err.message };
  }
});

// ---------------------------------------------------------------------------
// Workbench (src/workbench-main.js) and the system monitor
// ---------------------------------------------------------------------------
const sampleListeners = [];
const sampler = createSampler({ isWin, onSample: (smp) => { send('sys:sample', smp); for (const fn of sampleListeners) fn(smp); } });
// The side panel's strip samples while the widget is visible; the Workbench adds its own watcher.
function watchSysmon() {
  sampler.want('main', !!(config.showSysmon !== false && win && !win.isDestroyed() && win.isVisible()));
}

const which = (name) => launch.findOnPath([name], { env: { ...process.env, ...config.env }, isWin });

// ccusage when installed, else through npx (both run through a shell on Windows, so names, not paths).
function ccusageCommand() {
  if (which(isWin ? 'ccusage.cmd' : 'ccusage') || which(isWin ? 'ccusage.exe' : 'ccusage')) return { file: 'ccusage', args: [] };
  if (which(isWin ? 'npx.cmd' : 'npx')) return { file: 'npx', args: ['-y', 'ccusage@latest'] };
  return null;
}

// Pastes text into the active project's Claude prompt (bracketed paste, not sent), for the user to review.
function sendToSession(text) {
  if (!activeId || !sessions.has(activeId)) return { error: 'Open a project session in Gremlin first' };
  sessions.write(activeId, `\x1b[200~${text}\x1b[201~`);
  send('aux:select', { id: activeId, projectId: activeId });
  if (win) { win.show(); win.focus(); }
  return { ok: true };
}

const workbench = setupWorkbench({
  ipcMain,
  isWin,
  userDir,
  home: os.homedir(),
  icon: path.join(__dirname, '..', 'assets', 'icon.png'),
  background: () => config.theme.background,
  changesDir,
  sampler,
  onSample: (fn) => sampleListeners.push(fn),
  config: () => config,
  setConfig,
  activeProject: () => activeId,
  projectInfo: (id) => projectList.find((p) => p.id === id) || null,
  projectPath,
  projectsRoot,
  openEditor,
  findClaude: () => findTool(setupChecks.TOOLS.find((t) => t.id === 'claude')),
  claudeEnv,
  claudeDir,
  runInTerminal,
  spawnDetached,
  which,
  benchDir: () => userDir,
  onBenchProgress: (m) => send('bench:progress', m),
  sendToSession,
  ccusageCommand,
  addProject,
  startTask
});

// ---------------------------------------------------------------------------
// Window controls from the renderer
// ---------------------------------------------------------------------------
ipcMain.handle('config:get', () => ({
  fontFamily: config.fontFamily,
  fontSize: config.fontSize,
  theme: config.theme,
  transparent: isWin && config.backgroundMaterial !== 'none',
  alwaysOnTop: win ? win.isAlwaysOnTop() : config.alwaysOnTop,
  opacity: win ? win.getOpacity() : config.opacity,
  rail: { collapsed: !!state.railCollapsed, width: railWidth() },
  filesOpen: !!state.filesOpen,
  sideCollapsed: !!state.sideCollapsed,
  ...rendererToggles(),
  isWin
}));
ipcMain.on('side:setCollapsed', (_e, collapsed) => {
  state.sideCollapsed = !!collapsed;
  writeJson(statePath, state);
});
ipcMain.handle('win:togglePin', () => {
  const next = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(next, 'floating');
  state.alwaysOnTop = next;
  writeJson(statePath, state);
  return next;
});
ipcMain.handle('win:opacity', (_e, delta) => {
  const next = clampOpacity(Math.round((win.getOpacity() + delta) * 100) / 100);
  win.setOpacity(next);
  state.opacity = next;
  writeJson(statePath, state);
  return next;
});
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:toggleMaximize', () => {
  if (!win) return;
  if (win.isFullScreen()) win.setFullScreen(false);
  else if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win:toggleFullScreen', () => win && win.setFullScreen(!win.isFullScreen()));
ipcMain.on('win:hide', () => win && win.hide());
ipcMain.on('win:close', () => app.quit());
// OSC 9;4 states: 0 clear, 1 normal, 2 error, 3 indeterminate, 4 paused.
ipcMain.on('win:progress', (_e, { state, value }) => {
  if (!win || win.isDestroyed()) return;
  const mode = { 1: 'normal', 2: 'error', 3: 'indeterminate', 4: 'paused' }[state];
  if (!mode) return win.setProgressBar(-1);
  win.setProgressBar(state === 3 ? 2 : Math.min(100, Math.max(0, value)) / 100, { mode });
});
// Desktop notification from the renderer (it decides when, src/notify-rules.js); clicking one opens that project.
const shownNotes = new Set(); // kept until closed so they are not garbage collected before the click
ipcMain.on('notify:show', (_e, { id, title, body } = {}) => {
  if (config.notifications === false || !Notification.isSupported()) return;
  const n = new Notification({ title: String(title || 'Gremlin').slice(0, 120), body: String(body || '').slice(0, 300), icon: path.join(__dirname, '..', 'assets', 'icon.png') });
  shownNotes.add(n);
  n.on('click', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (typeof id === 'string' && id) send('projects:select', { id });
    }
  });
  for (const ev of ['click', 'close', 'failed']) n.on(ev, () => shownNotes.delete(n));
  n.show();
});
ipcMain.on('app:openConfig', () => openSettings());
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(String(text)));
// Local dev servers (localhost, 127.0.0.1) open in the built-in browser; other web links in the default browser.
ipcMain.on('shell:openExternal', (_e, url) => {
  if (isLocalUrl(url)) browser.open(url);
  else if (/^https?:\/\//.test(url)) shell.openExternal(url);
});

// ---------------------------------------------------------------------------
// Tray + lifecycle
// ---------------------------------------------------------------------------
function createTray() {
  tray = new Tray(path.join(__dirname, '..', 'assets', isWin ? 'icon.ico' : 'icon.png'));
  tray.setToolTip('Gremlin');
  tray.on('click', toggleWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / hide', click: toggleWindow },
    { label: 'Restart Claude session', click: () => send('pty:restartActive') },
    { label: 'Settings…', click: () => openSettings() },
    { label: 'Setup…', click: () => openSettings('setup') },
    { label: 'Workbench…', click: () => workbench.open() },
    { label: 'Reset window position', click: () => win && setBoundsExact(fitWorkArea(withRail(defaultBounds()))) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    const target = openTarget(argv, cwd);
    if (target) return browser.open(target);
    if (!win) return createWindow();
    win.show();
    win.focus();
  });

  app.whenReady().then(async () => {
    if (control) await control.start().catch((err) => console.error('gremlin-browser endpoint:', err.message));
    applyLoginItem();
    createWindow();
    remote.sync();
    applyRemoteHost();
    for (const ev of ['show', 'hide', 'minimize', 'restore']) win.on(ev, watchSysmon);
    win.once('ready-to-show', watchSysmon);
    createTray();
    // Shown once: closing the window without pressing Done must not bring it back on every launch.
    if (!state.setupDone) win.once('ready-to-show', () => setTimeout(() => { state.setupDone = true; writeJson(statePath, state); openSettings('setup'); }, 600));
    registerHotkey(config.hotkey);
    const target = openTarget(process.argv, process.cwd());
    if (target) win.once('ready-to-show', () => browser.open(target));
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    sessions.closeAll();
    remoteHost.close();
    remote.stopAll();
    aux.closeAll();
    sampler.stop();
    if (control) control.stop();
    if (rootWatcher) rootWatcher.close();
    clearInterval(statusTimer);
    clearInterval(gitTimer);
    clearInterval(allGitTimer);
  });

  // The tray keeps the app alive when the window is hidden; closing the
  // widget with the X button quits explicitly via win:close.
  app.on('window-all-closed', () => app.quit());
  // Quitting from the widget also closes any open Markdown popouts.
  // Unsaved editors get one prompt for the whole quit; the rest of the popouts just close.
  app.on('before-quit', (ev) => {
    const dirty = [...editors.values()].filter((e) => e.dirty && !e.win.isDestroyed());
    if (dirty.length) {
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        buttons: ['Quit anyway', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: `${dirty.length} file${dirty.length > 1 ? 's have' : ' has'} unsaved changes`,
        detail: dirty.map((e) => e.file).join('\n')
      });
      if (choice === 1) {
        ev.preventDefault();
        dirty[0].win.focus();
        return;
      }
    }
    for (const e of editors.values()) { e.forceClose = true; if (!e.win.isDestroyed()) e.win.destroy(); }
    for (const md of mdWindows.values()) if (!md.isDestroyed()) md.destroy();
    browser.close();
    workbench.close();
  });
}
