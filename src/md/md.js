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
    meta.content = "default-src 'none'; img-src data:; style-src 'self'; script-src 'self'; font-src 'self' data:; form-action 'none'; base-uri 'none'";
    document.head.appendChild(meta);
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
    docEl.innerHTML = doc.html;
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
