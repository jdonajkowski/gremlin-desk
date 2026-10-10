/* global require, monaco */
// Settings window: a form over config.json (General, Appearance) and a Monaco editor for the global
// ~/.claude/AGENTS.md. One Save button saves whichever tab is showing; Ctrl+S does the same.
(async () => {
  const host = window.settingsHost;
  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const statusEl = $('status');
  let tab = 'general';
  let agentsEditor = null;
  let agentsSaved = null;

  const setStatus = (text, kind = '') => {
    statusEl.textContent = text;
    statusEl.className = kind;
  };

  // --- Tabs ----------------------------------------------------------------
  function showTab(name) {
    tab = name;
    for (const el of document.querySelectorAll('[data-tab]')) el.classList.toggle('on', el.dataset.tab === name);
    $('btn-json').hidden = name === 'agents';
    setStatus('');
    if (name === 'agents') loadAgents();
    if (name === 'setup') loadSetup();
    $('btn-save').hidden = name === 'remote';
    if (name === 'remote') loadRemote();
  }
  for (const b of document.querySelectorAll('#tabs button')) b.onclick = () => showTab(b.dataset.tab);
  host.onTab(showTab);

  // --- Widget settings form ------------------------------------------------
  const field = (name) => form.elements.namedItem(name);
  const { form: values } = await host.get();

  function fill(v) {
    for (const el of form.elements) {
      if (!el.name) continue;
      const val = el.name.startsWith('theme.') ? (v.theme || {})[el.name.slice(6)] : v[el.name];
      if (el.type === 'checkbox') el.checked = !!val;
      else el.value = val ?? '';
    }
    syncColors();
    $('opacity-out').textContent = `${Math.round(Number(field('opacity').value) * 100)}%`;
  }

  // Color pickers mirror the hex fields (pickers have no alpha, so the field keeps it).
  function syncColors() {
    for (const picker of document.querySelectorAll('[data-color]')) {
      const hex = field(`theme.${picker.dataset.color}`).value.trim();
      if (/^#[0-9a-f]{6}/i.test(hex)) picker.value = hex.slice(0, 7);
    }
  }
  for (const picker of document.querySelectorAll('[data-color]')) {
    picker.addEventListener('input', () => {
      const input = field(`theme.${picker.dataset.color}`);
      input.value = picker.value + input.value.trim().slice(7, 9); // keep any alpha
    });
  }
  form.addEventListener('input', (e) => {
    if (e.target.name && e.target.name.startsWith('theme.')) syncColors();
    if (e.target.name === 'opacity') $('opacity-out').textContent = `${Math.round(Number(e.target.value) * 100)}%`;
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); save(); });

  for (const b of document.querySelectorAll('[data-browse]')) {
    b.onclick = async () => {
      const input = field(b.dataset.browse);
      const dir = await host.browse(input.value);
      if (dir) input.value = dir;
    };
  }

  function collect() {
    const out = { theme: {} };
    for (const el of form.elements) {
      if (!el.name) continue;
      const val = el.type === 'checkbox' ? el.checked : el.value;
      if (el.name.startsWith('theme.')) out.theme[el.name.slice(6)] = val;
      else out[el.name] = val;
    }
    return out;
  }

  async function saveForm() {
    const res = await host.save(collect());
    if (res.errors && res.errors.length) return setStatus(res.errors.join(' · '), 'error');
    fill(res.form);
    $('btn-restart').hidden = !res.restart;
    setStatus(res.restart ? 'Saved. Some changes apply after a restart.' : 'Saved', 'ok');
  }

  // --- Setup: tools, accounts and the widget's hooks ---------------------------
  // Install and sign-in buttons run a command from the main process's table in a visible terminal.
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function checkRow({ state, title, detail, buttons = [], extra }) {
    const row = el('div', 'check-row');
    row.appendChild(el('span', `mark ${state}`, state === 'ok' ? '✓' : state === 'warn' ? '!' : '–'));
    const body = el('div', 'body');
    body.append(el('div', '', title), el('div', 'detail', detail || ''));
    if (extra) body.appendChild(extra);
    row.appendChild(body);
    for (const b of buttons) {
      const btn = el('button', b.primary ? 'primary' : '', b.label);
      btn.type = 'button';
      btn.disabled = !!b.disabled;
      btn.onclick = b.run;
      row.appendChild(btn);
    }
    return row;
  }

  async function runStep(kind, id, what) {
    const res = await host.setup.run(kind, id);
    if (res.ok) setStatus(`${what} opened in a terminal window. Click "Check again" when it finishes.`, 'ok');
    else if (res.command) setStatus(`No terminal found. The command is on your clipboard: ${res.command}`, 'error');
    else setStatus('Nothing to run for this on this system.', 'error');
  }

  let setupLoading = false;
  async function loadSetup() {
    if (setupLoading) return;
    setupLoading = true;
    $('checks').replaceChildren(el('div', 'detail', 'Checking this machine…'));
    $('accounts').replaceChildren();
    let s;
    try { s = await host.setup.get(); } finally { setupLoading = false; }
    const tool = Object.fromEntries(s.tools.map((t) => [t.id, t]));

    $('checks').replaceChildren(...s.tools.map((t) => checkRow({
      state: t.path ? 'ok' : t.required ? 'warn' : 'opt',
      title: t.path ? `${t.name}${t.version ? ` · ${t.version}` : ''}` : `${t.name} is not installed${t.required ? '' : ' (optional)'}`,
      detail: t.path ? t.path : `${t.why}${t.canInstall ? `\nInstalls with: ${t.installCommand}` : ''}`,
      buttons: t.path ? [] : [{ label: 'Install', primary: t.required, disabled: !t.canInstall, run: () => runStep('install', t.id, `The ${t.name} installer`) }]
    })));

    const rows = [];
    rows.push(checkRow({
      state: s.claudeSignedIn ? 'ok' : 'warn',
      title: s.claudeSignedIn ? 'Signed in to Claude' : 'Not signed in to Claude',
      detail: `${s.claudeSignedIn ? 'Use /login in a session to switch accounts.' : 'Gremlin sessions sign in once; Claude Code asks the first time it runs.'}\nConfig folder: ${s.claudeDir}`,
      buttons: s.claudeSignedIn ? [] : [{ label: 'Sign in', primary: true, disabled: !tool.claude.path, run: () => runStep('signin', 'claude', 'Claude sign-in') }]
    }));

    // Git identity: an inline form, since commits need a name and email.
    const idForm = el('div', 'row inline-form');
    const nameIn = el('input'); nameIn.placeholder = 'Your name'; nameIn.value = s.git.name;
    const mailIn = el('input'); mailIn.placeholder = 'you@example.com'; mailIn.value = s.git.email;
    idForm.append(nameIn, mailIn);
    const gitSet = !!(s.git.name && s.git.email);
    rows.push(checkRow({
      state: !tool.git.path ? 'opt' : gitSet ? 'ok' : 'warn',
      title: gitSet ? `Git identity: ${s.git.name} <${s.git.email}>` : 'Git name and email are not set',
      detail: tool.git.path ? 'Used as the author of commits Claude makes (git config --global).' : 'Install Git first.',
      extra: tool.git.path ? idForm : null,
      buttons: tool.git.path ? [{
        label: 'Save',
        run: async () => {
          const res = await host.setup.gitIdentity(nameIn.value, mailIn.value);
          if (res.error) setStatus(res.error, 'error');
          else { setStatus('Git identity saved', 'ok'); loadSetup(); }
        }
      }] : []
    }));

    rows.push(checkRow({
      state: !tool.gh.path ? 'opt' : s.ghSignedIn ? 'ok' : 'warn',
      title: !tool.gh.path ? 'GitHub sign-in needs the GitHub CLI' : s.ghSignedIn ? 'Signed in to GitHub' : 'Not signed in to GitHub',
      detail: s.ghSignedIn ? 'gh auth status is happy.' : 'Signs in through your browser with gh auth login. Also used by git push over HTTPS.',
      buttons: s.ghSignedIn ? [] : [{ label: 'Sign in', disabled: !tool.gh.path, run: () => runStep('signin', 'gh', 'GitHub sign-in') }]
    }));
    $('accounts').replaceChildren(...rows);

    $('hooks-info').textContent = s.globalHooks
      ? 'Your ~/.claude/settings.json already has the Gremlin hooks, so Gremlin uses those.'
      : s.runtime === 'node' ? 'Hooks run on Node.js.' : 'Hooks run on Gremlin\'s built-in runtime (Node.js is not needed).';
  }
  $('btn-recheck').onclick = () => loadSetup();
  $('btn-setup-done').onclick = () => { host.setup.done(); window.close(); };

  // --- Global instructions (AGENTS.md) ----------------------------------------
  function showLink(info) {
    const el = $('agents-link');
    el.className = info.linked ? 'ok' : '';
    el.textContent = info.linked
      ? `✓ Claude Code loads it through ${info.claudeMd}.`
      : `saving also adds an @AGENTS.md import to ${info.claudeMd} so Claude Code loads it.`;
  }

  let agentsLoading = null;
  function loadAgents() {
    if (agentsLoading) return agentsLoading;
    agentsLoading = new Promise((resolve) => {
      require.config({ paths: { vs: '../../node_modules/monaco-editor/min/vs' } });
      require(['vs/editor/editor.main'], async () => {
        const info = await host.agents.get();
        $('agents-path').textContent = info.path;
        showLink(info);
        monaco.editor.defineTheme('widget', {
          base: 'vs-dark',
          inherit: true,
          rules: [],
          colors: { 'editor.background': '#171615', 'editorCursor.foreground': '#d97757', 'editor.selectionBackground': '#d9775755' }
        });
        agentsEditor = monaco.editor.create($('agents-editor'), {
          value: info.text,
          language: 'markdown',
          theme: 'widget',
          automaticLayout: true,
          wordWrap: 'on',
          minimap: { enabled: false },
          fontSize: 13,
          scrollBeyondLastLine: false
        });
        agentsSaved = info.exists ? info.text : null;
        agentsEditor.onDidChangeModelContent(() => setStatus(agentsEditor.getValue() !== agentsSaved ? 'Unsaved changes' : ''));
        if (!info.exists) setStatus('New file: not saved yet');
        agentsEditor.focus();
        resolve();
      });
    });
    return agentsLoading;
  }

  async function saveAgents() {
    await loadAgents();
    const text = agentsEditor.getValue();
    const res = await host.agents.save(text);
    if (res.error) return setStatus(`Save failed: ${res.error}`, 'error');
    agentsSaved = text;
    showLink(res);
    setStatus('Saved. New Claude sessions pick it up; running ones on their next start.', 'ok');
  }

  // --- Remote: this computer as a host, and the computers it connects to ------------
  const when = (ms) => (ms ? new Date(ms).toLocaleString() : 'never');
  const row = (text, detail, buttons) => {
    const r = el('div', 'check-row');
    const body = el('div', 'body');
    body.append(el('div', '', text), el('div', 'detail', detail || ''));
    r.appendChild(body);
    for (const b of buttons) { const btn = el('button', '', b.label); btn.type = 'button'; btn.onclick = b.run; r.appendChild(btn); }
    return r;
  };

  function showRemote(s) {
    const h = s.host;
    $('rm-enabled').checked = h.enabled;
    $('rm-port').value = h.port;
    const sel = $('rm-address');
    sel.replaceChildren(...[{ name: 'Automatic (first private address)', address: '' }, ...s.interfaces].map((i) => {
      const o = el('option', '', i.address ? `${i.name} · ${i.address}` : i.name);
      o.value = i.address;
      return o;
    }));
    sel.value = h.address;
    $('rm-status').textContent = h.error ? `Not listening: ${h.error}` : h.listening ? `Listening on ${h.boundAddress}:${h.port}. ${h.clients} connected.` : h.enabled ? 'Not listening.' : 'Off.';
    $('rm-status').className = h.error ? 'hint-block error' : 'hint-block';
    $('rm-where').textContent = h.listening ? `address ${h.boundAddress} and port ${h.port}` : 'this computer\'s address and port';
    $('rm-devices').replaceChildren(...(s.devices.length ? s.devices : []).map((d) => row(d.name, `Last connected: ${when(d.lastSeen)}`, [{ label: 'Revoke', run: async () => showRemote(await host.remote.revoke(d.id)) }])));
    $('rm-hosts').replaceChildren(...(s.hosts.length ? s.hosts : []).map((x) => row(x.name, `${x.address}:${x.port} · ${{ online: 'Connected', connecting: 'Connecting…', offline: 'Not connected', error: 'Cannot connect' }[x.state] || x.state}${x.error ? ` — ${x.error}` : ''}`, [
      { label: 'Try again', run: () => { host.remote.reconnect(x.id); setTimeout(loadRemote, 600); } },
      { label: 'Remove', run: async () => showRemote(await host.remote.removeHost(x.id)) }
    ])));
  }

  async function loadRemote() { showRemote(await host.remote.get()); }

  async function applyRemoteHost() {
    const res = await host.remote.setHost({ enabled: $('rm-enabled').checked, address: $('rm-address').value, port: Number($('rm-port').value) });
    if (res.error) { setStatus(res.error, 'error'); return loadRemote(); }
    setStatus('');
    showRemote(res);
  }
  for (const id of ['rm-enabled', 'rm-address', 'rm-port']) $(id).onchange = applyRemoteHost;

  $('rm-pair').onclick = async () => {
    const res = await host.remote.pair($('rm-pair-name').value);
    $('rm-pair-name').value = '';
    showRemote(res);
    $('rm-code').value = res.code;
    $('rm-code-box').hidden = false;
    $('rm-code').select();
  };
  $('rm-copy').onclick = async () => {
    $('rm-code').select();
    try { await navigator.clipboard.writeText($('rm-code').value); setStatus('Copied', 'ok'); } catch { setStatus('Press Ctrl+C to copy the selected code', ''); }
  };
  $('rm-add').onclick = async () => {
    const res = await host.remote.addHost({ name: $('rm-add-name').value, address: $('rm-add-address').value, port: $('rm-add-port').value, code: $('rm-add-code').value });
    if (res.error) return setStatus(res.error, 'error');
    for (const id of ['rm-add-name', 'rm-add-address', 'rm-add-port', 'rm-add-code']) $(id).value = '';
    setStatus('Added. It connects now.', 'ok');
    showRemote(res);
    setTimeout(loadRemote, 800);
  };

  // --- Footer ----------------------------------------------------------------
  const save = () => { if (tab === 'remote') return; return tab === 'agents' ? saveAgents() : saveForm(); };
  $('btn-save').onclick = save;
  $('btn-json').onclick = () => host.openJson();
  $('btn-restart').onclick = () => host.restart();
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    if (e.key === 'Escape' && tab !== 'agents' && tab !== 'remote') window.close();
  });

  fill(values);
})();
