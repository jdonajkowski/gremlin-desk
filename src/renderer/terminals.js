/* global Terminal, FitAddon, WebLinksAddon, SearchAddon, WidgetMdLinks */
// One xterm per session, each in its own <div> inside a zone's host (#terminal, or #terminal-b in split view).
// Hidden terminals keep receiving output, so switching back shows complete scrollback. Loaded as a plain script (window.WidgetTerminals).
(function (root) {
  function createTerminals({ widget, cfg, host, onProgress, onInput, toast, onFocus = () => {}, isMuted = () => false }) {
    const terms = new Map();
    let activeId = null;
    let fontSize = cfg.fontSize;

    function create(id) {
      const el = document.createElement('div');
      el.className = 'term-pane';
      el.hidden = true;
      host.appendChild(el);

      const term = new Terminal({
        fontFamily: cfg.fontFamily,
        fontSize,
        cursorBlink: true,
        allowProposedApi: true,
        allowTransparency: cfg.transparent,
        scrollback: 10000,
        theme: cfg.transparent ? { ...cfg.theme, background: '#00000000' } : cfg.theme,
        // OSC 8 hyperlinks: Markdown files (file: URIs or plain paths) open in a popout, web links in the browser.
        linkHandler: {
          allowNonHttpProtocols: true,
          activate: (_e, uri) => {
            if (/^https?:\/\//i.test(uri)) return widget.openExternal(uri);
            if (id.startsWith('r:')) return; // a remote terminal's output must not open files from this computer's disk
            // A scheme has 2+ letters, so a drive letter (C:\…) counts as a plain path.
            const target = uri.split(/[?#]/)[0].replace(/(?::\d+)+$/, '');
            const local = /^file:/i.test(target) || !/^[a-z][\w+.-]+:/i.test(target);
            if (local && /\.(md|markdown)$/i.test(target)) widget.md.open(target, id);
          }
        }
      });
      const fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, url) => widget.openExternal(url)));
      const search = new SearchAddon.SearchAddon();
      term.loadAddon(search);
      term.open(el);
      const t = { id, el, term, fit, exited: false, bar: null };
      const decorations = { matchOverviewRuler: '#d6a642', activeMatchColorOverviewRuler: '#ffb454', matchBackground: '#5a4a1a', activeMatchBackground: '#a87a12' };
      // Clicking into a terminal of the other zone makes it the active one (keys, Ctrl+PageUp/Down).
      el.addEventListener('focusin', () => { if (activeId !== id) { activeId = id; onFocus(id); } });
      terms.set(id, t);

      term.parser.registerOscHandler(9, (data) => {
        const m = /^4;(\d)(?:;(\d{1,3}))?/.exec(data);
        if (!m) return false; // not a progress sequence; leave other OSC 9 uses alone
        onProgress(id, Number(m[1]), Number(m[2] || 0));
        return true;
      });

      term.onData((data) => {
        if (isMuted(id)) return; // xterm answers terminal queries found in a replay; those answers are not typing
        if (t.exited) {
          if (data === '\r') restart(id);
          return;
        }
        widget.pty.write(id, data);
        onInput(id, data);
      });
      term.onResize(({ cols, rows }) => { if (!t.el.hidden) widget.pty.resize(id, cols, rows); });

      // Markdown paths in the output open rendered in a popout (click).
      // Wrapped rows are joined so a long path that spans rows is still one link.
      term.registerLinkProvider({
        provideLinks(y, callback) {
          if (id.startsWith('r:')) return callback(undefined); // the paths in a remote screen are not this computer's
          const buf = term.buffer.active;
          let first = y - 1;
          while (first > 0 && buf.getLine(first) && buf.getLine(first).isWrapped) first--;
          let last = y - 1;
          while (buf.getLine(last + 1) && buf.getLine(last + 1).isWrapped) last++;
          let text = '';
          for (let r = first; r <= last; r++) {
            const line = buf.getLine(r);
            if (line) text += line.translateToString(r === last);
          }
          const matches = WidgetMdLinks.find(text);
          if (!matches.length) return callback(undefined);
          const cols = term.cols;
          const pos = (i) => ({ x: (i % cols) + 1, y: first + Math.floor(i / cols) + 1 });
          Promise.all(matches.map((m) => widget.md.resolve(m.candidates.map((c) => c.path), id)
            .then((hit) => hit && { c: m.candidates[hit.index], file: hit.file })))
            .then((hits) => {
              const links = hits.filter(Boolean).map(({ c, file }) => ({
                range: { start: pos(c.start), end: pos(c.end - 1) },
                text: c.path,
                decorations: { underline: true, pointerCursor: true },
                activate: () => widget.md.open(file, id)
              })).filter((l) => l.range.start.y <= y && l.range.end.y >= y);
              callback(links.length ? links : undefined);
            }, () => callback(undefined));
        }
      });

      // Keyboard: copy/paste, newline, restart, font zoom.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        const key = e.key.toLowerCase();
        // Ctrl+C copies when text is selected, otherwise it is sent as SIGINT.
        if (e.ctrlKey && !e.shiftKey && key === 'c' && term.hasSelection()) {
          widget.clipboard.write(term.getSelection());
          term.clearSelection();
          return false;
        }
        if (e.ctrlKey && e.shiftKey && key === 'c') {
          if (term.hasSelection()) widget.clipboard.write(term.getSelection());
          return false;
        }
        // Ctrl+V / Ctrl+Shift+V paste (bracketed paste handled by xterm). preventDefault stops the browser's
        // own paste event, which xterm would turn into a second copy of the text.
        if (e.ctrlKey && key === 'v') {
          e.preventDefault();
          widget.clipboard.read().then((text) => text && term.paste(text));
          return false;
        }
        // Shift+Enter inserts a newline in Claude Code's prompt (sent as Esc+Enter).
        if (e.shiftKey && !e.ctrlKey && !e.altKey && key === 'enter') {
          if (!t.exited) widget.pty.write(id, '\x1b\r');
          return false;
        }
        if (key === 'f11' && !e.ctrlKey && !e.shiftKey && !e.altKey) {
          widget.win.toggleFullScreen();
          return false;
        }
        // Ctrl+Alt+F searches the scrollback (Ctrl+F belongs to Claude Code, Ctrl+Shift+F to the file search).
        if (e.ctrlKey && e.altKey && !e.shiftKey && key === 'f') {
          openSearch(t, search, decorations);
          return false;
        }
        if (e.ctrlKey && e.shiftKey && key === 'r') {
          restart(id);
          return false;
        }
        // Ctrl+= / Ctrl+- zoom the font of every terminal.
        if (e.ctrlKey && (key === '=' || key === '+' || key === '-')) {
          fontSize = Math.min(32, Math.max(8, fontSize + (key === '-' ? -1 : 1)));
          for (const x of terms.values()) x.term.options.fontSize = fontSize;
          fitActive();
          toast(`Font ${fontSize}px`);
          return false;
        }
        return true;
      });

      // Right-click: copy selection if any, otherwise paste (Windows Terminal style).
      el.addEventListener('contextmenu', async (e) => {
        e.preventDefault();
        if (term.hasSelection()) {
          widget.clipboard.write(term.getSelection());
          term.clearSelection();
          toast('Copied');
        } else {
          const text = await widget.clipboard.read();
          if (text) term.paste(text);
        }
      });
      return t;
    }

    // A small bar over the top right of the pane: type to find, Enter / Shift+Enter next / previous, Esc closes.
    function openSearch(t, search, decorations) {
      if (!t.bar) {
        const bar = document.createElement('div');
        bar.className = 'term-search';
        bar.innerHTML = '<input type="text" placeholder="Find in output" spellcheck="false"><span class="ts-count"></span><button type="button" title="Previous (Shift+Enter)">↑</button><button type="button" title="Next (Enter)">↓</button><button type="button" title="Close (Esc)">×</button>';
        const input = bar.querySelector('input');
        const count = bar.querySelector('.ts-count');
        const [prev, next, close] = bar.querySelectorAll('button');
        const opts = () => ({ decorations, caseSensitive: false });
        const find = (back) => {
          if (!input.value) { search.clearDecorations(); count.textContent = ''; return; }
          if (back) search.findPrevious(input.value, opts()); else search.findNext(input.value, opts());
        };
        search.onDidChangeResults(({ resultIndex, resultCount }) => {
          count.textContent = !input.value ? '' : resultCount ? `${resultIndex + 1}/${resultCount}` : 'none';
        });
        const shut = () => { bar.hidden = true; search.clearDecorations(); t.term.focus(); };
        input.addEventListener('input', () => find(false));
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Escape') { e.preventDefault(); shut(); }
          else if (e.key === 'Enter') { e.preventDefault(); find(e.shiftKey); }
        });
        prev.onclick = () => find(true);
        next.onclick = () => find(false);
        close.onclick = shut;
        t.el.appendChild(bar);
        t.bar = bar;
      }
      t.bar.hidden = false;
      const input = t.bar.querySelector('input');
      const sel = t.term.hasSelection() ? t.term.getSelection().split('\n')[0] : '';
      if (sel) input.value = sel;
      input.focus();
      input.select();
    }

    // Fitting happens after showing: xterm measures 0x0 while hidden.
    function show(id) {
      const t = terms.get(id);
      if (!t) return null;
      for (const x of terms.values()) if (x !== t) x.el.hidden = true;
      t.el.hidden = false;
      activeId = id;
      try { t.fit.fit(); } catch { /* not laid out yet */ }
      widget.pty.resize(id, t.term.cols, t.term.rows);
      t.term.focus();
      return t;
    }

    // Split view: shows exactly these terminals (one per zone), each fitted to its zone, and focuses one.
    function showOnly(ids, focusId) {
      for (const x of terms.values()) x.el.hidden = !ids.includes(x.id);
      for (const id of ids) {
        const t = terms.get(id);
        if (!t) continue;
        try { t.fit.fit(); } catch { /* not laid out yet */ }
        widget.pty.resize(id, t.term.cols, t.term.rows);
      }
      if (terms.has(focusId)) activeId = focusId; // focus() then puts the keyboard there
    }

    // Moves a terminal's element into a zone's host (it keeps its scrollback).
    function place(id, hostEl) {
      const t = terms.get(id);
      if (t && t.el.parentNode !== hostEl) hostEl.appendChild(t.el);
    }

    // Every visible terminal (both zones in split view).
    function fitActive() {
      for (const t of terms.values()) {
        if (t.el.hidden) continue;
        try { t.fit.fit(); } catch { /* not visible yet */ }
      }
    }

    function restart(id) {
      const t = terms.get(id);
      if (!t) return;
      t.exited = false;
      t.term.reset();
      if (!t.el.hidden) {
        try { t.fit.fit(); } catch { /* not visible */ }
      }
      widget.pty.restart(id, t.term.cols, t.term.rows);
      onRestart(id);
    }
    let onRestart = () => {};

    function markExited(id, code) {
      const t = terms.get(id);
      if (!t) return;
      t.exited = true;
      t.term.write(`\r\n\x1b[90m[session ended (exit ${code}). Press Enter to restart]\x1b[0m\r\n`);
    }

    function destroy(id) {
      const t = terms.get(id);
      if (!t) return;
      terms.delete(id);
      t.term.dispose();
      t.el.remove();
      if (activeId === id) activeId = null;
    }

    return {
      create,
      show,
      showOnly,
      place,
      restart,
      markExited,
      destroy,
      fitActive,
      has: (id) => terms.has(id),
      get: (id) => terms.get(id),
      write: (id, data, cb) => { const t = terms.get(id); if (t) t.term.write(data, cb); else if (cb) cb(); },
      reset: (id) => { const t = terms.get(id); if (t) { t.exited = false; t.term.reset(); } },
      focus: () => { const t = terms.get(activeId); if (t) t.term.focus(); },
      setOnRestart: (fn) => { onRestart = fn; }
    };
  }

  root.WidgetTerminals = { createTerminals };
})(this);
