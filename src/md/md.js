// Markdown popout: shows HTML rendered by the main process and routes link clicks back to it.
(() => {
  const docEl = document.getElementById('doc');
  const pathEl = document.getElementById('path');
  const baseEl = document.querySelector('base');
  let current = null;

  const fileUrl = (dir) => 'file:///' + dir.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:') + '/';

  // A document from another computer is untrusted: before its first content, tighten the policy (a second policy only ever
  // adds restrictions). No images except data:, no inline styles, nothing that can reach the network or a file share.
  let locked = false;
  function lockDown() {
    if (locked) return;
    locked = true;
    const meta = document.createElement('meta');
    meta.httpEquiv = 'Content-Security-Policy';
    // No 'self' source: on a file: page it would match file: URLs (including network shares). The page's own script and
    // stylesheet are already loaded, and a policy is only checked when something is fetched.
    meta.content = "default-src 'none'; img-src data:; form-action 'none'; base-uri 'none'";
    document.head.appendChild(meta);
  }

  // A remote document's HTML is parsed inertly (nothing loads or runs) and rebuilt in this page from an allowlist
  // (src/md-render.js): the parsed nodes are never moved into the live document.
  function safeFragment(html) {
    const R = window.MdRender;
    const dom = new DOMParser().parseFromString(html, 'text/html');
    const frag = document.createDocumentFragment();
    const copy = (from, into) => {
      for (const n of from.childNodes) {
        if (n.nodeType === Node.TEXT_NODE) { into.appendChild(document.createTextNode(n.data)); continue; }
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = n.localName.toLowerCase();
        if (R.DROP_TAGS.includes(tag)) continue;
        if (tag === 'img') { into.appendChild(document.createTextNode(`[${n.getAttribute('alt') || 'image'}]`)); continue; }
        if (!R.ALLOWED_TAGS.includes(tag)) { copy(n, into); continue; } // unknown: keep what is inside
        if (tag === 'input' && R.allowedAttr(tag, 'type', n.getAttribute('type') || '') !== 'checkbox') continue;
        const el = document.createElement(tag);
        for (const a of n.attributes) {
          const v = R.allowedAttr(tag, a.name, a.value);
          if (v !== null) el.setAttribute(a.name.toLowerCase(), v);
        }
        copy(n, el);
        into.appendChild(el);
      }
    };
    copy(dom.body, frag);
    return frag;
  }

  window.mdView.onRender((doc) => {
    if (doc.remote) lockDown();
    current = doc;
    // A document from another computer: no file to edit or open here, only Reload; its images cannot load.
    for (const id of ['btn-edit', 'btn-vscode']) document.getElementById(id).hidden = !!doc.remote;
    document.getElementById('btn-reload').hidden = !doc.remote;
    document.title = doc.remote ? `${doc.remote.rel.split('/').pop()} · ${doc.remote.hostName}` : doc.file.split(/[\\/]/).pop();
    pathEl.textContent = doc.file;
    if (doc.error) {
      docEl.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'error';
      p.textContent = `Could not read the file: ${doc.error}`;
      docEl.appendChild(p);
      return;
    }
    // Relative image paths resolve against the Markdown file's folder.
    if (doc.dir) baseEl.href = fileUrl(doc.dir);
    const scroll = document.scrollingElement.scrollTop;
    if (doc.remote) docEl.replaceChildren(safeFragment(String(doc.html)));
    else docEl.innerHTML = doc.html;
    document.scrollingElement.scrollTop = scroll; // keep the place on live reloads
  });

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1));
      const target = document.getElementById(id) || document.querySelector(`[name="${CSS.escape(id)}"]`);
      if (target) target.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (current) window.mdView.openLink(href, current.file);
  });

  // Headings get ids so in-document links like [Setup](#setup) work.
  new MutationObserver(() => {
    for (const h of docEl.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      if (!h.id) h.id = h.textContent.trim().toLowerCase().replace(/[^\w\- ]/g, '').replace(/ /g, '-');
    }
  }).observe(docEl, { childList: true });

  document.getElementById('btn-reload').onclick = () => window.mdView.reload();
  document.getElementById('btn-edit').onclick = () => window.mdView.edit();
  document.getElementById('btn-vscode').onclick = () => window.mdView.openInVSCode();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') window.close();
  });
})();
