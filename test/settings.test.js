const test = require('node:test');
const assert = require('node:assert/strict');
const { splitArgs, joinArgs, parseEnv, formatEnv, normalize, toForm, ensureImport, hasImport } = require('../src/settings');

const defaults = { shell: 'powershell.exe', projectsRoot: 'C:\\P', cwd: 'C:\\H', fontFamily: 'Consolas' };

test('splitArgs and joinArgs round-trip quoted arguments', () => {
  const args = ['-NoLogo', '-Command', 'claude --model x'];
  assert.equal(joinArgs(args), '-NoLogo -Command "claude --model x"');
  assert.deepEqual(splitArgs(joinArgs(args)), args);
});

test('parseEnv reads KEY=value lines and skips comments', () => {
  assert.deepEqual(parseEnv('# note\nA=1\n\nB = two=2\nbad'), { A: '1', B: ' two=2' });
  assert.equal(formatEnv({ A: '1', B: 'x' }), 'A=1\nB=x');
});

test('normalize clamps numbers, falls back to defaults and reports bad values', () => {
  const { values, errors } = normalize({
    shell: '  ', fontSize: '40', opacity: '0.1', alwaysOnTop: 0, backgroundMaterial: 'glass',
    theme: { background: '#000', cursor: 'red' }
  }, defaults);
  assert.equal(values.shell, 'powershell.exe');
  assert.equal(values.fontSize, 32);
  assert.equal(values.opacity, 0.3);
  assert.equal(values.alwaysOnTop, false);
  assert.equal('backgroundMaterial' in values, false);
  assert.deepEqual(values.theme, { background: '#000' });
  assert.equal(errors.length, 2);
});

test('normalize only returns fields the form sent', () => {
  assert.deepEqual(normalize({ hotkey: ' Control+Alt+K ' }, defaults).values, { hotkey: 'Control+Alt+K' });
  assert.deepEqual(normalize({ claudeHooks: '' }, defaults).values, { claudeHooks: false });
  assert.deepEqual(normalize({ guardMode: 'log', showSysmon: 1, autoOpenDevServer: false }, defaults).values, { guardMode: 'log', showSysmon: true, autoOpenDevServer: false });
  assert.deepEqual(normalize({ guardMode: 'yes' }, defaults).errors.length, 1);
});

test('toForm turns args and env into text', () => {
  const form = toForm({ shellArgs: ['-c', 'a b'], env: { X: '1' }, fontSize: 13 });
  assert.equal(form.shellArgs, '-c "a b"');
  assert.equal(form.env, 'X=1');
  assert.equal(form.fontSize, 13);
});

test('ensureImport adds @AGENTS.md once', () => {
  assert.equal(ensureImport(''), '@AGENTS.md\n');
  assert.equal(ensureImport('# Mine\r\nrules'), '@AGENTS.md\n\n# Mine\r\nrules');
  assert.equal(ensureImport('x\n  @AGENTS.md  \n'), null);
  assert.equal(hasImport('@AGENTS.md'), true);
  assert.equal(hasImport('see AGENTS.md'), false);
});

test('normalize keeps guardMinutes a whole number from 0 to 240', () => {
  const d = { shell: 'sh', projectsRoot: '/p', cwd: '/', fontFamily: 'mono' };
  assert.equal(normalize({ guardMinutes: '5' }, d).values.guardMinutes, 5);
  assert.equal(normalize({ guardMinutes: '2.6' }, d).values.guardMinutes, 3);
  assert.equal(normalize({ guardMinutes: -4 }, d).values.guardMinutes, 0);
  assert.equal(normalize({ guardMinutes: 9999 }, d).values.guardMinutes, 240);
  const bad = normalize({ guardMinutes: 'soon' }, d);
  assert.equal('guardMinutes' in bad.values, false);
  assert.match(bad.errors[0], /Guard minutes/);
});

test('launchOnStartup and startMinimized are booleans', () => {
  assert.deepEqual(normalize({ launchOnStartup: 1, startMinimized: 0 }, defaults).values, { launchOnStartup: true, startMinimized: false });
  assert.deepEqual(normalize({}, defaults).values, {});
});

test('notifyRemote is a boolean, kept in values and shown in the form', () => {
  assert.deepEqual(normalize({ notifyRemote: 0 }, defaults).values, { notifyRemote: false });
  assert.deepEqual(normalize({ notifyRemote: 'on' }, defaults).values, { notifyRemote: true });
  assert.equal('notifyRemote' in normalize({}, defaults).values, false);
  assert.equal(toForm({ notifyRemote: true }).notifyRemote, true);
});
