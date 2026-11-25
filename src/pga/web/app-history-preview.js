// One preview per document. Delay loading until the pointer settles on a conversation.
window.historyPreview = (() => {
  let current, panel, openTimer, closeTimer;
  function close() {
    clearTimeout(openTimer); clearTimeout(closeTimer);
    current?.controller.abort();
    current = null;
    panel?.remove(); panel = null;
  }
  function later() { clearTimeout(closeTimer); closeTimer = setTimeout(close, 200); }
  async function render(state) {
    if (current !== state) return;
    openTimer = null;
    if (!state.anchor.isConnected) { close(); return; }
    const {anchor, key, options} = state;
    if (!panel) {
      panel = document.createElement('aside');
      panel.className = 'history-hover';
      panel.addEventListener('pointerenter', () => clearTimeout(closeTimer));
      panel.addEventListener('pointerleave', later);
    }
    document.body.appendChild(panel);
    const rect = anchor.getBoundingClientRect();
    panel.style.left = Math.max(4, Math.min(options.x ?? rect.left, innerWidth - panel.offsetWidth - 4)) + 'px';
    if (rect.top > innerHeight / 2) panel.style.bottom = innerHeight - rect.top + 'px';
    else panel.style.top = rect.bottom + 'px';
    const heading = document.createElement('strong'), body = document.createElement('div');
    heading.textContent = options.title;
    panel.replaceChildren(heading, body);
    body.textContent = L('正在读取…', 'Loading…');
    function appendTurn(t, urls) {
      const el = document.createElement('section');
      el.className = t.role === 'user' ? 'mine' : '';
      el.textContent = t.text || t.error || '';
      for (const url of urls) {
        const img = document.createElement('img');
        img.loading = 'lazy'; img.alt = L('上传的图片', 'Uploaded image');
        img.onerror = () => img.replaceWith(L('原图不可用', 'Original image unavailable'));
        img.src = url; el.appendChild(img);
      }
      if (t.missing_images) el.append(document.createElement('br'), L('这条记录未保留原图', 'Original image unavailable'));
      body.appendChild(el);
    }
    try {
      const imported = /^(c|imp):/.test(key);
      const path = imported ? 'imported/' + encodeURIComponent(key.slice(key.indexOf(':')+1)) : 'chats/' + encodeURIComponent(key);
      const uid = S.uid;
      const data = await api('/v1/users/' + uid + '/' + path, {signal:state.controller.signal});
      if (current !== state || S.uid !== uid) return;
      const turns = [...(data.context || []), ...(data.turns || [])].filter(t => t.role !== 'aside');
      body.replaceChildren();
      for (const t of turns) {
        const urls = t.manager_pictures?.length ? t.manager_pictures.map(pic => pic.url) : t.question_images || (imported && t.role === 'user' && data.session
          ? (t.images || []).map(ref => imgUrl({session:data.session,kind:data.source},ref)) : []);
        appendTurn(t, urls);
      }
      if (!turns.length) body.textContent = data.excerpt || L('暂无历史消息', 'No saved messages');
    } catch {
      if (current === state) body.textContent = L('无法读取这段会话', 'Could not load this conversation');
    }
  }
  function show(anchor, key, options) {
    clearTimeout(closeTimer);
    if (current?.anchor === anchor && current.key === key) return;
    close();
    current = {anchor,key,options,controller:new AbortController()};
    openTimer = setTimeout(render, 260, current);
  }
  const rows = '[data-ritem], [data-running-key]';
  document.addEventListener('pointerover', e => {
    const row = e.target.closest?.(rows);
    if (!row || e.buttons || e.pointerType === 'touch' || e.target.closest('button[data-rk]')) return;
    if (row === current?.anchor) { clearTimeout(closeTimer); return; }
    show(row, row.dataset.ritem || row.dataset.runningKey, {
      title: row.querySelector('b')?.textContent || row.textContent
    });
  });
  document.addEventListener('pointerout', e => {
    if (current?.anchor.contains(e.target) && !current.anchor.contains(e.relatedTarget)) {
      if (openTimer) close();
      later();
    }
  });
  document.addEventListener('pointerdown', e => { if (!panel?.contains(e.target)) close(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  window.addEventListener('blur', () => close());
  return {show,closeFor(anchor) { if (current?.anchor === anchor) close(); }};
})();
