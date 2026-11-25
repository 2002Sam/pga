/* The desktop's isolated web view fits inside the existing page workspace.
   Web builds keep their reader. No site scripts or cookies pass through PGA's API. */
function fpBrowserAvailable() {
  try { return !!window.top.PGA_NATIVE?.browser; } catch { return false; }
}
function fpBrowserURL(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const scheme = /^[a-z][a-z\d+.-]*:/i.test(raw) && !/^(localhost|[\w.-]+\.\w+):\d+(?:\/|$)/i.test(raw);
  try {
    const url = new URL(scheme ? raw : 'https://' + raw);
    return /^https?:$/.test(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
const FP_BROWSER = { frame: 0, signature: '', observer: null, overlays: null };
function fpBrowserPost(op, data = {}) {
  if (!fpBrowserAvailable()) return false;
  try { window.webkit.messageHandlers.pga.postMessage({ kind: 'browser', op, ...data }); return true; } catch { return false; }
}
function fpBrowserSync() {
  if (!fpBrowserAvailable() || FP_BROWSER.frame) return;
  FP_BROWSER.frame = requestAnimationFrame(() => {
    FP_BROWSER.frame = 0;
    const en = fpActive(), panel = FILE_PANEL.host;
    const visible = en?.browser && en.web !== 'about:blank' && panel && !panel.hidden && !document.hidden && !document.querySelector('.modal, dialog[open]');
    const r = visible && en.viewport?.getBoundingClientRect();
    const payload = r && r.width > 0 && r.height > 0 ? { id: en.id, url: en.web, stageWheel:S.view==='stage', viewportWidth: innerWidth,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height } } : null;
    const signature = JSON.stringify(payload);
    if (signature === FP_BROWSER.signature) return;
    FP_BROWSER.signature = signature;
    if (!payload && typeof READING_NATIVE !== 'undefined' && READING_NATIVE.entries.size) { READING_NATIVE.signature=''; readingNativeSync(); }
    else fpBrowserPost(payload ? 'show' : 'hide', payload || {});
  });
}
function fpBrowserWatch() {
  if (FP_BROWSER.observer) return;
  FP_BROWSER.observer = new ResizeObserver(fpBrowserSync);
  FP_BROWSER.overlays = new MutationObserver(fpBrowserSync);
  FP_BROWSER.overlays.observe(document.body, { childList: true });
  const stage = document.getElementById?.('vStage');
  if (stage) FP_BROWSER.overlays.observe(stage, {attributes:true, attributeFilter:['hidden']});
  document.addEventListener('visibilitychange', fpBrowserSync);
  window.addEventListener('pagehide', () => { FP_BROWSER.signature = ''; fpBrowserPost('dispose'); });
}
function fpBrowserDispose(en) {
  if (!en?.browser) return;
  FP_BROWSER.observer?.unobserve(en.viewport);
  fpBrowserPost('close', { id: en.id }); FP_BROWSER.signature = '';
}
function fpBrowserNavigate(en, value) {
  const url = fpBrowserURL(value);
  if (!url) { en.hint.textContent = L('请输入有效的 http 或 https 网址。', 'Enter a valid http or https address.'); en.address.focus(); return false; }
  if (!fpBrowserAvailable()) { openPgaUrl(url, en.uid); return true; }
  en.web = url; en.path = url; en.editingAddress = false; en.address.value = url; en.address.blur(); en.hint.textContent = L('正在载入网页', 'Loading page');
  en.state = { ...en.state, error: '', loading: true };
  fpBrowserPost('navigate', { id: en.id, url }); FP_BROWSER.signature = ''; fpBrowserSync();
  return true;
}
function fpBrowserButton(label, symbol, action) {
  const button = document.createElement('button'); button.type = 'button'; button.className = 'fp-ib';
  button.title = label; button.setAttribute('aria-label', label); button.textContent = symbol; button.onclick = action;
  return button;
}
function openPgaBrowser(value = '', uid = S.uid, origin = typeof fpCaptureOrigin === 'function' ? fpCaptureOrigin() : null) {
  try { if (window.top !== window && typeof window.top.openPgaBrowser === 'function') return window.top.openPgaBrowser(value, uid, origin); } catch {}
  const url = value ? fpBrowserURL(value) : 'about:blank';
  if (!url) { toast(L('请输入有效的网址', 'Enter a valid address')); return; }
  if (value && !fpBrowserAvailable()) return openPgaUrl(url, uid);
  if (value) { const old = [...FILE_PANEL.entries.values()].find(en => en.browser && en.uid === uid && en.web === url); if (old) { selectFile(old.id); return old; } }
  const name = value ? new URL(url).hostname : L('新网页', 'New page');
  const en = { id: 'browser:' + crypto.randomUUID(), browser: true, origin, uid, web: url, path: url, name, state: {} };
  const panel = filePanel();
  en.tab = fpTab(en.id, `${fpIcon('', true)}<span class="fp-name">${esc(name)}</span>`, value || name);
  en.body = document.createElement('div'); en.body.className = 'fileview fp-browser';
  const bar = document.createElement('form'); bar.className = 'fp-browser-nav'; bar.setAttribute('aria-label', L('网页导航', 'Web navigation'));
  const command = op => fpBrowserPost(op, { id: en.id });
  en.back = fpBrowserButton(L('后退', 'Back'), '←', () => command('back')); en.back.disabled = true;
  en.forward = fpBrowserButton(L('前进', 'Forward'), '→', () => command('forward')); en.forward.disabled = true;
  en.reload = fpBrowserButton(L('刷新网页', 'Reload page'), '↻', () => {
    if (en.web === 'about:blank') { en.address.focus(); return; }
    if (en.state.loading) command('stop');
    else if (en.state.suspended) fpBrowserNavigate(en, en.web);
    else command('reload');
  });
  en.address = document.createElement('input'); en.address.className = 'fp-browser-address'; en.address.type = 'text'; en.address.inputMode = 'url';
  en.address.setAttribute('aria-label', L('网页地址', 'Page address')); en.address.placeholder = L('输入网址，按回车打开', 'Enter an address and press Return');
  en.address.autocomplete = 'off'; en.address.spellcheck = false; en.address.value = value ? url : '';
  en.address.oninput = () => { en.editingAddress = true; };
  en.address.onblur = () => { en.editingAddress = false; en.address.value = en.web === 'about:blank' ? '' : en.web; };
  bar.onsubmit = e => { e.preventDefault(); fpBrowserNavigate(en, en.address.value); };
  const external = fpBrowserButton(L('在外部浏览器打开', 'Open in external browser'), '↗', () => { if (en.web !== 'about:blank') window.open(en.web, '_blank', 'noopener'); });
  const reader = fpBrowserButton(L('中英对照阅读', 'Bilingual reader'), '中 / EN', () => { if (en.web !== 'about:blank') openPgaUrl(en.web, en.uid, true, en.origin || undefined); });
  bar.append(en.back, en.forward, en.reload, en.address, reader, external);
  en.viewport = document.createElement('div'); en.viewport.className = 'fp-browser-viewport';
  en.hint = document.createElement('p'); en.hint.className = 'fp-browser-hint'; en.hint.setAttribute('role', 'status');
  en.hint.textContent = value ? L('正在载入网页', 'Loading page') : L('输入网址，即可在这里浏览网页。', 'Enter an address to browse here.');
  en.viewport.append(en.hint); en.body.append(bar, en.viewport);
  panel.querySelector('.fileframes').append(en.body); FILE_PANEL.entries.set(en.id, en);
  fpBrowserWatch(); FP_BROWSER.observer.observe(en.viewport);
  selectFile(en.id); fpBrowserSync(); if (!value) en.address.focus();
  return en;
}
window.openPgaBrowser = openPgaBrowser;
window.pgaBrowserState = function (state) {
  if (window.readingNativeState?.(state)) return;
  const en = FILE_PANEL.entries.get(state.id); if (!en?.browser) return;
  if (state.event === 'pageSize') {
    if (FILE_PANEL.active === en.id && !FILE_PANEL.host.hidden) fpClickWidth(state.clicks);
    return;
  }
  if (state.open) { openPgaBrowser(state.open, en.uid, en.origin); return; }
  if (state.action) {
    if (state.action === 'address') { en.address.focus(); en.address.select(); }
    else if (state.action === 'close') fpClose(en.id);
    else if (state.action === 'next' || state.action === 'previous') fpCycle(state.action === 'next' ? 1 : -1);
    return;
  }
  en.state = state;
  if (state.url) { en.web = state.url; en.path = state.url; en.tab.title = state.url; if (!en.editingAddress) en.address.value = state.url; }
  if (state.title) { en.name = state.title; en.tab.querySelector('.fp-name').textContent = state.title; }
  en.back.disabled = !state.back; en.forward.disabled = !state.forward;
  const label = state.loading ? L('停止载入', 'Stop loading') : L('刷新网页', 'Reload page');
  en.reload.textContent = state.loading ? '×' : '↻'; en.reload.title = label; en.reload.setAttribute('aria-label', label);
  en.hint.textContent = state.error || (state.loading ? L('正在载入网页', 'Loading page') : '');
  if (FILE_PANEL.active === en.id) {
    const panel = FILE_PANEL.host;
    panel.querySelector('.fp-sl').textContent = state.error ? L('未能打开 · 可刷新重试或在外部浏览器打开', 'Could not open · retry or open externally') : state.loading ? L('载入中', 'Loading') : L('网页', 'Web page');
    panel.querySelector('.fp-sr').textContent = state.url ? new URL(state.url).hostname : '';
  }
};
document.addEventListener('click', e => { if (e.target.closest?.('[data-browser-new]')) { window.stMoreClose?.(); openPgaBrowser(); } });
document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'l' && !FILE_PANEL.host?.hidden && fpActive()?.browser) {
    e.preventDefault(); e.stopPropagation(); fpActive().address.focus(); fpActive().address.select();
  }
}, true);
