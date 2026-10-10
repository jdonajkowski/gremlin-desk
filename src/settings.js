// Settings window helpers: clean the values the form sends before they go into config.json, and keep
// ~/.claude/CLAUDE.md importing the global AGENTS.md. Pure, so tests can call them directly.

const MATERIALS = ['none', 'acrylic', 'mica', 'tabbed'];
// System change guard (hooks/guard-hook.js): ask before running, only log, or off.
const GUARD_MODES = ['ask', 'log', 'off'];
const COLOR_KEYS = ['background', 'foreground', 'cursor', 'selectionBackground'];
const COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Splits a command line into arguments, honoring double quotes: -Command "claude --x" -> ['-Command', 'claude --x'].
function splitArgs(text) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

const joinArgs = (args) => (Array.isArray(args) ? args.map((a) => (/\s/.test(a) || a === '' ? `"${a}"` : a)).join(' ') : '');

// KEY=value per line; blank lines and # comments are skipped.
function parseEnv(text) {
  const env = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    env[t.slice(0, i).trim()] = t.slice(i + 1);
  }
  return env;
}

const formatEnv = (env) => Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');

// Returns { values, errors }: values holds only valid fields, ready to merge over config.json.
function normalize(form, defaults) {
  const values = {};
  const errors = [];
  const f = form || {};

  if ('shell' in f) values.shell = str(f.shell) || defaults.shell;
  if ('shellArgs' in f) values.shellArgs = splitArgs(f.shellArgs);
  if ('claudeCommand' in f) values.claudeCommand = str(f.claudeCommand);
  if ('claudeConfigDir' in f) values.claudeConfigDir = str(f.claudeConfigDir);
  if ('projectsRoot' in f) values.projectsRoot = str(f.projectsRoot) || defaults.projectsRoot;
  if ('cwd' in f) values.cwd = str(f.cwd) || defaults.cwd;
  if ('env' in f) values.env = parseEnv(f.env);
  if ('hotkey' in f) values.hotkey = str(f.hotkey);
  if ('alwaysOnTop' in f) values.alwaysOnTop = !!f.alwaysOnTop;
  if ('showInTaskbar' in f) values.showInTaskbar = !!f.showInTaskbar;
  if ('restoreSessions' in f) values.restoreSessions = !!f.restoreSessions;
  if ('notifications' in f) values.notifications = !!f.notifications;
  if ('notifyRemote' in f) values.notifyRemote = !!f.notifyRemote;
  if ('launchOnStartup' in f) values.launchOnStartup = !!f.launchOnStartup;
  if ('startMinimized' in f) values.startMinimized = !!f.startMinimized;
  if ('claudeHooks' in f) values.claudeHooks = !!f.claudeHooks;
  if ('fontFamily' in f) values.fontFamily = str(f.fontFamily) || defaults.fontFamily;
  if ('showSysmon' in f) values.showSysmon = !!f.showSysmon;
  if ('showMascot' in f) values.showMascot = !!f.showMascot;
  if ('autoOpenDevServer' in f) values.autoOpenDevServer = !!f.autoOpenDevServer;
  if ('browserControl' in f) values.browserControl = !!f.browserControl;
  if ('guardMode' in f) {
    if (GUARD_MODES.includes(f.guardMode)) values.guardMode = f.guardMode;
    else errors.push(`System change guard must be one of ${GUARD_MODES.join(', ')}`);
  }

  if ('guardMinutes' in f) {
    const n = Number(f.guardMinutes);
    if (Number.isFinite(n)) values.guardMinutes = clamp(Math.round(n), 0, 240);
    else errors.push('Guard minutes must be a number');
  }
  if ('fontSize' in f) {
    const n = Number(f.fontSize);
    if (Number.isFinite(n)) values.fontSize = clamp(Math.round(n), 8, 32);
    else errors.push('Font size must be a number');
  }
  if ('opacity' in f) {
    const n = Number(f.opacity);
    if (Number.isFinite(n)) values.opacity = clamp(Math.round(n * 100) / 100, 0.3, 1);
    else errors.push('Opacity must be a number');
  }
  if ('backgroundMaterial' in f) {
    if (MATERIALS.includes(f.backgroundMaterial)) values.backgroundMaterial = f.backgroundMaterial;
    else errors.push(`Backdrop must be one of ${MATERIALS.join(', ')}`);
  }
  if (f.theme && typeof f.theme === 'object') {
    const theme = {};
    for (const k of COLOR_KEYS) {
      if (!(k in f.theme)) continue;
      const v = str(f.theme[k]);
      if (COLOR.test(v)) theme[k] = v;
      else errors.push(`Theme ${k} must be a hex color like #1f1e1d`);
    }
    values.theme = theme;
  }
  return { values, errors };
}

// The form shows shellArgs and env as text.
function toForm(config) {
  return { ...config, shellArgs: joinArgs(config.shellArgs), env: formatEnv(config.env) };
}

const IMPORT_LINE = '@AGENTS.md';

// CLAUDE.md text that imports AGENTS.md: unchanged (null) if it already does, else the import on top.
function ensureImport(claudeMd) {
  const text = claudeMd || '';
  if (text.split(/\r?\n/).some((l) => l.trim() === IMPORT_LINE)) return null;
  return text ? `${IMPORT_LINE}\n\n${text}` : `${IMPORT_LINE}\n`;
}

const hasImport = (claudeMd) => ensureImport(claudeMd) === null;

module.exports = { MATERIALS, GUARD_MODES, splitArgs, joinArgs, parseEnv, formatEnv, normalize, toForm, ensureImport, hasImport };
