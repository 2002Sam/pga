/* A lightweight reader frame, using the same viewer as the app without starting a chat. */
window.PGA_FILE_PAGE = true;
// Install gestures before async previews/editors finish loading; nested frame
// loads are then observed by the stage as they appear.
window.parent.stFileGestureFrame?.(window.frameElement);
const FILE_QUERY = new URLSearchParams(location.search);
const S = {uid: FILE_QUERY.get('as'), stageDormant: window.frameElement?._pgaInView === false};
window.S = S;
const L = (zh, en) => window.parent.pgaFileServices.L(zh, en);
const esc = text => window.parent.pgaFileServices.esc(text);
const md = text => window.parent.pgaFileServices.md(text);
const api = (...args) => window.parent.api(...args);
const toast = (...args) => window.parent.toast(...args);
const hljs = window.parent.hljs;
const DOMPurify = window.parent.DOMPurify;
const copyText = (...args) => window.parent.pgaFileServices.copyText(...args);
const node = () => window.parent.ST?.nodes.find(n => n.id === FILE_QUERY.get('node'));
window.filePageDirty = () => [...FILE_PANEL.entries.values()].some(en => en.dirty || en.saving);
window.filePageStatus = en => {
  const n = node(), title = n?.el?.querySelector('.stwt');
  if (title) title.textContent = (en.dirty || en.saving ? '● ' : '') + n.title;
};
window.filePageGo = (line, column) => {
  const en = fpActive(); if (!en) return;
  if (en.toSource && en.mode !== 'src') en.toSource(line, column); else fpGo(en, line, column);
};
window.filePageClose = () => { const n = node(); if (n) window.parent.stClose(n); };
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await (FILE_QUERY.has('web') ? openPgaUrl(FILE_QUERY.get('path'), S.uid) : openPgaFile(FILE_QUERY.get('path'), FILE_QUERY.get('key'), S.uid));
    const n = node(); if (n?.file.line) window.filePageGo(n.file.line, n.file.column);
  } finally {
    const frame = window.frameElement;
    if (frame) delete frame._pgaFileStarted;
  }
});
document.addEventListener('click', e => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('[data-local-file]');
  if (a) { e.preventDefault(); window.parent.openPgaFile(a.dataset.localFile, FILE_QUERY.get('key'), S.uid); return; }
  const link = e.target.closest('a[href]'); if (!link || link.hasAttribute('download')) return;
  let u; try { u = new URL(link.getAttribute('href'), location.href); } catch { return; }
  if (/^https?:$/.test(u.protocol) && u.origin !== location.origin) {
    e.preventDefault(); window.parent.openPgaUrl(u.href, S.uid);
  }
});
