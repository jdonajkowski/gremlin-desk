// Files pane: a folder tree of the active project, left of the terminal. Folders load when expanded;
// clicking a file opens it (Markdown in the viewer). Git changes show as a letter after the name
// (M modified, A added, D deleted, R renamed, U conflict, ? new, • folder with changes).
// The search box searches names and contents; clicking a hit opens the editor at that line.
// Loaded as a plain script (window.WidgetFilesPane).
(function (root) {
  function createFilesPane({ el, widget, open: initial = false }) {
    const listEl = el.querySelector('#files-list');
    const headEl = el.querySelector('#files-head .title');
    const qEl = el.querySelector('#files-q');
    const regexBtn = el.querySelector('#files-regex');
    const caseBtn = el.querySelector('#files-case');
    el.querySelector('#files-refresh').onclick = () => refresh();

    let projectId = null;
    let cache = new Map(); // rel -> entries for the current project
    const expanded = new Map(); // project id -> Set of expanded folder rels
    let badges = {};
    let renderSeq = 0;
    let query = '';
    let notice = '';
    let regex = false;
    let caseSensitive = false;

    const openDirs = () => {
      if (!expanded.has(projectId)) expanded.set(projectId, new Set());
      return expanded.get(projectId);
    };

    async function load(rel) {
      if (cache.has(rel)) return cache.get(rel);
      const id = projectId;
      const into = cache;
      const res = await widget.files.list(id, rel);
      const entries = (res && res.entries) || null;
      // Switched project (or refreshed) while this was loading: the answer is stale.
      if (id !== projectId || into !== cache) return entries;
      if (rel === '' && res) {
        const name = res.root.split(/[\\/]/).filter(Boolean).pop() || res.root;
        headEl.textContent = name;
        headEl.title = res.root;
      }
      cache.set(rel, entries);
      return entries;
    }

    function badgeEl(rel) {
      const b = badges[rel];
      if (!b) return null;
      const s = document.createElement('span');
      s.className = `gbadge g-${b === '?' ? 'new' : b === '•' ? 'dir' : b}`;
      s.textContent = b === '?' ? 'N' : b;
      s.title = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', U: 'Conflict', '?': 'New, not in git yet', '•': 'Has changes' }[b] || '';
      return s;
    }

    function row(entry, depth) {
      const r = document.createElement('div');
      r.className = entry.dir ? 'frow dir' : 'frow';
      r.style.paddingLeft = `${6 + depth * 12}px`;
      r.title = entry.rel;
      const chev = document.createElement('span');
      chev.className = 'chev';
      if (entry.dir) chev.textContent = openDirs().has(entry.rel) ? '▾' : '▸';
      const name = document.createElement('span');
      name.className = 'fname';
      name.textContent = entry.name;
      r.append(chev, name);
      const b = badgeEl(entry.rel);
      if (b) { r.appendChild(b); r.classList.add('changed'); }
      r.addEventListener('click', () => {
        if (!entry.dir) return widget.files.open(projectId, entry.rel);
        const dirs = openDirs();
        if (dirs.has(entry.rel)) dirs.delete(entry.rel);
        else dirs.add(entry.rel);
        render();
      });
      r.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        widget.files.menu(projectId, entry.rel, entry.dir);
      });
      return r;
    }

    function swapIn(frag, emptyText) {
      if (!frag.childNodes.length) {
        const empty = document.createElement('div');
        empty.className = 'fempty';
        empty.textContent = emptyText;
        frag.appendChild(empty);
      }
      const scroll = listEl.scrollTop;
      listEl.replaceChildren(frag);
      listEl.scrollTop = scroll;
    }

    // Builds the whole visible tree off-screen, then swaps it in, so a refresh doesn't flicker.
    async function render() {
      if (el.hidden) return;
      if (query) return renderSearch();
      const seq = ++renderSeq;
      const frag = document.createDocumentFragment();
      if (!projectId) {
        headEl.textContent = 'Files';
        headEl.title = '';
      } else {
        const dirs = openDirs();
        const walk = async (rel, depth) => {
          const entries = await load(rel);
          if (!entries) return;
          for (const e of entries) {
            frag.appendChild(row(e, depth));
            if (e.dir && dirs.has(e.rel)) await walk(e.rel, depth + 1);
          }
        };
        await walk('', 0);
      }
      if (seq !== renderSeq) return; // a newer render started meanwhile
      swapIn(frag, projectId ? 'Empty folder' : notice || 'No project open');
    }

    // --- Search ------------------------------------------------------------------------------------
    function highlight(text, col, len) {
      const span = document.createElement('span');
      span.className = 'stext';
      if (col < 0 || !len) { span.textContent = text; return span; }
      const mark = document.createElement('mark');
      mark.textContent = text.slice(col, col + len);
      span.append(text.slice(0, col), mark, text.slice(col + len));
      return span;
    }

    async function renderSearch() {
      const seq = ++renderSeq;
      const q = query;
      const frag = document.createDocumentFragment();
      if (!projectId) return swapIn(frag, notice || 'No project open');
      await load(''); // sets the header to this project
      if (seq !== renderSeq) return;
      const loading = document.createElement('div');
      loading.className = 'fempty';
      loading.textContent = 'Searching…';
      listEl.replaceChildren(loading);
      const res = await widget.files.search(projectId, q, { regex, caseSensitive });
      if (seq !== renderSeq || q !== query) return;
      if (!res) return swapIn(frag, regex ? 'Invalid pattern' : 'No results');
      // The match length for highlighting: plain text is the query; a regex is measured per line.
      const lenAt = (text, col) => {
        if (!regex) return q.length;
        try { const m = new RegExp(q, caseSensitive ? '' : 'i').exec(text.slice(col)); return m && m.index === 0 ? m[0].length : 0; } catch { return 0; }
      };
      if (res.files.length) {
        const h = document.createElement('div');
        h.className = 'shead';
        h.textContent = `Files (${res.files.length})`;
        frag.appendChild(h);
        for (const f of res.files) {
          const r = document.createElement('div');
          r.className = 'frow';
          r.title = f.rel;
          const name = document.createElement('span');
          name.className = 'fname';
          name.textContent = f.rel;
          r.appendChild(name);
          r.onclick = () => widget.files.open(projectId, f.rel);
          frag.appendChild(r);
        }
      }
      const total = res.hits.reduce((a, h) => a + h.matches.length, 0);
      if (res.hits.length) {
        const h = document.createElement('div');
        h.className = 'shead';
        h.textContent = `${total}${res.truncated ? '+' : ''} matches in ${res.hits.length} files`;
        frag.appendChild(h);
      }
      for (const hit of res.hits) {
        const fr = document.createElement('div');
        fr.className = 'frow sfile';
        fr.title = hit.rel;
        const name = document.createElement('span');
        name.className = 'fname';
        name.textContent = hit.rel;
        const count = document.createElement('span');
        count.className = 'scount';
        count.textContent = hit.matches.length;
        fr.append(name, count);
        fr.onclick = () => widget.files.openAt(projectId, hit.rel, hit.matches[0].line);
        frag.appendChild(fr);
        for (const m of hit.matches) {
          const r = document.createElement('div');
          r.className = 'frow smatch';
          const ln = document.createElement('span');
          ln.className = 'sline';
          ln.textContent = m.line;
          r.append(ln, highlight(m.text, m.col, lenAt(m.text, m.col)));
          r.title = `${hit.rel}:${m.line}`;
          r.onclick = () => widget.files.openAt(projectId, hit.rel, m.line);
          frag.appendChild(r);
        }
      }
      swapIn(frag, 'No results');
    }

    let searchTimer;
    qEl.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        query = qEl.value.trim().length >= 2 ? qEl.value : '';
        listEl.scrollTop = 0;
        render();
      }, 250);
    });
    qEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        qEl.value = '';
        query = '';
        render();
        qEl.blur();
      }
    });
    const toggle = (btn, get, set) => {
      btn.onclick = () => { set(!get()); btn.classList.toggle('on', get()); if (query) render(); qEl.focus(); };
    };
    toggle(regexBtn, () => regex, (v) => { regex = v; });
    toggle(caseBtn, () => caseSensitive, (v) => { caseSensitive = v; });

    // --- Git badges ----------------------------------------------------------------------------------
    let badgeSeq = 0;
    async function loadBadges() {
      const seq = ++badgeSeq;
      const id = projectId;
      const map = id ? await widget.files.git(id) : null;
      if (seq !== badgeSeq || id !== projectId) return;
      const next = map || {};
      if (JSON.stringify(next) === JSON.stringify(badges)) return;
      badges = next;
      if (!query) render();
    }

    function refresh() {
      cache = new Map();
      loadBadges();
      return render();
    }

    // notice: shown instead of "No project open" when there is no project to list (e.g. a remote session).
    function setProject(id, text = '') {
      if (id === projectId && text === notice) return;
      projectId = id;
      notice = text;
      badges = {};
      listEl.scrollTop = 0;
      refresh();
    }

    function setOpen(open) {
      el.hidden = !open;
      document.getElementById('btn-files').classList.toggle('on', open);
      if (open) refresh();
    }

    setOpen(initial);

    return {
      setProject,
      refresh: () => (el.hidden ? undefined : refresh()),
      toggle: () => { setOpen(el.hidden); widget.files.setOpen(!el.hidden); },
      focusSearch: () => {
        if (el.hidden) { setOpen(true); widget.files.setOpen(true); }
        qEl.focus();
        qEl.select();
      },
      isOpen: () => !el.hidden
    };
  }

  root.WidgetFilesPane = { createFilesPane };
})(this);
