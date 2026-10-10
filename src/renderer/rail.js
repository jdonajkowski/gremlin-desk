// Project rail: one row per project with its state dot. Collapsed, rows show two-letter initials.
// Loaded as a plain script (window.WidgetRail).
(function (root) {
  const DOT_TITLES = { working: 'Working', attention: 'Needs you', finished: 'Finished while you were away', idle: 'Idle' };

  function createRail({ el, onOpen, onMenu, onAdd, onHeader = () => {} }) {
    const listEl = el.querySelector('#rail-list');
    el.querySelector('#rail-add').onclick = onAdd;
    const rows = new Map();

    function makeRow(p) {
      const row = document.createElement('div');
      row.className = 'proj';
      row.innerHTML = '<span class="pdot"></span><span class="pname"></span><span class="pgit"></span><span class="pinit"></span>';
      row.addEventListener('click', () => (row.dataset.hostId ? onHeader(row.dataset.hostId) : onOpen(row.dataset.id)));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!row.dataset.hostId) onMenu(row.dataset.id); });
      return row;
    }

    // list: [{id, path, name, initials, pinned, missing}], view: {active, open:Set, dot:(id)=>string, git:(id)=>{short,long,dirty}}
    function render(list, view) {
      const keep = new Set(list.map((p) => p.id));
      for (const [id, row] of rows) if (!keep.has(id)) { row.remove(); rows.delete(id); }
      let shown = 0; // Ctrl+1..9 count projects only, not host headers
      list.forEach((p, i) => {
        let row = rows.get(p.id);
        if (!row) { row = makeRow(p); rows.set(p.id, row); }
        if (listEl.children[i] !== row) listEl.insertBefore(row, listEl.children[i] || null);
        if (p.header) {
          row.dataset.id = p.id;
          row.dataset.hostId = p.hostId;
          row.className = 'proj rhead';
          row.querySelector('.pdot').className = `pdot host-${p.state}`;
          row.querySelector('.pname').textContent = p.name;
          row.querySelector('.pinit').textContent = p.initials;
          row.querySelector('.pgit').textContent = '';
          row.title = `${p.name}\n${{ online: 'Connected', connecting: 'Connecting…', offline: 'Not connected', error: 'Cannot connect' }[p.state] || p.state}${p.error ? `\n${p.error}` : ''}${p.state === 'online' || p.state === 'connecting' ? '' : '\nClick to try again'}`;
          return;
        }
        const n = shown++;
        row.dataset.id = p.id;
        const dot = view.open.has(p.id) ? view.dot(p.id) : 'idle';
        row.querySelector('.pdot').className = `pdot ${dot}`;
        row.querySelector('.pname').textContent = (p.pinned ? '📌 ' : '') + (p.worktreeOf ? '⑂ ' : '') + p.name + (p.missing ? ' (missing)' : '');
        row.querySelector('.pinit').textContent = p.initials;
        const git = view.git ? view.git(p.id) : { short: '', long: '', dirty: false };
        const gitEl = row.querySelector('.pgit');
        gitEl.textContent = git.short;
        gitEl.classList.toggle('dirty', git.dirty);
        row.title = `${p.name}\n${p.path}${git.long ? `\nGit: ${git.long}` : ''}${p.worktreeOf ? `\nWorktree of ${p.worktreeOf}` : ''}${view.open.has(p.id) ? ` — ${DOT_TITLES[dot]}` : ''}${n < 9 ? `  (Ctrl+${n + 1})` : ''}`;
        row.classList.toggle('active', p.id === view.active);
        row.classList.toggle('missing', !!p.missing);
        row.classList.toggle('running', view.open.has(p.id));
        row.classList.toggle('offline', !!(p.remote && p.remote.offline));
      });
    }

    function setCollapsed(collapsed, width) {
      document.body.classList.toggle('rail-collapsed', collapsed);
      document.documentElement.style.setProperty('--rail-w', `${width}px`);
    }

    return { render, setCollapsed };
  }

  // Local projects first, then each paired computer: a header row (its state) followed by its projects.
  function withHeaders(list, hosts) {
    const out = list.filter((p) => !p.remote);
    for (const h of hosts || []) {
      out.push({ id: `rh:${h.id}`, header: true, hostId: h.id, name: h.name, state: h.state, error: h.error || '', initials: h.name.slice(0, 2).toUpperCase() });
      out.push(...list.filter((p) => p.remote && p.remote.hostId === h.id));
    }
    return out;
  }

  root.WidgetRail = { createRail, withHeaders };
})(this);
