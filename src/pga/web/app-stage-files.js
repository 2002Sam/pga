/* File readers are ordinary stage windows, each with its own editor lifetime. */
window.pgaFileServices = {L, esc, md, api, toast, copyText: (...args) => copyText(...args)};
async function stOpenFile(path, key, uid = S.uid, web = false, origin = null) {
  const sourceId = (key && stWins().find(n => n.key === key)?.id) || stAnchor()?.id || ST.focus;
  // Resolve aliases and line suffixes before deduplicating; do not discard an editor's dirty buffer.
  const info = web ? null : await api(`/v1/users/${uid}/files/view`, {body: {path, key}});
  const canonical = info?.path || path;
  let n = stWins().find(n => n.file?.uid === uid && n.file.path === canonical && !!n.file.web === web);
  if (!n) {
    const wins = stWins(), source = wins.find(n => n.id === sourceId); stFreezeWidths();
    n = {id: stId(), type: 'win', title: info?.name || canonical.split('/').pop() || canonical,
      prog: {title: info?.name || canonical.split('/').pop() || canonical},
      file: {path: canonical, key, uid, web, origin, sourceId: source?.id, line: info?.line, column: info?.column}, bw: stHalfWidth(),
      creationGroup: source && stGroupOf(source), openedAt: Date.now()};
    stInsertRight(wins, n, source);
    ST.nodes.push(n);
  } else if (info?.line) {
    n.file.line = info.line; n.file.column = info.column;
    n.el?.querySelector('iframe')?.contentWindow?.filePageGo?.(info.line, info.column);
  }
  if (origin) n.file.origin = origin;
  stFocus(n.id, true); stShow(n.id, true); stSave();
  return n;
}
function stFileHtml(n) {
  return `<div class="stwin stfilewin">${['e', 'w'].map(d => `<i class="rz rz-${d}" data-rz="${d}"></i>`).join('')}
    <div class="stwh" data-stfocus="${n.id}"><span aria-hidden="true">▤</span><b class="stwt">${esc(n.title || n.file.path)}</b><span class="grow"></span>
      <button class="stb" data-stw="min" title="${L('收起', 'Collapse')}">–</button><button class="stb" data-stw="max" title="${L('最大化', 'Maximise')}">▢</button><button class="stb" data-stw="close" title="${L('关闭文件页', 'Close file page')}">×</button></div>
    <iframe allowfullscreen title="${esc(n.title || L('文件', 'File'))}"></iframe></div>`;
}
function stFileFrame(n, el) {
  const f = el.querySelector('iframe');
  const q = new URLSearchParams({node: n.id, as: n.file.uid, path: n.file.path});
  if (n.file.key) q.set('key', n.file.key);
  if (n.file.web) q.set('web', '1');
  if (n.file.line) q.set('line', n.file.line);
  if (n.file.column) q.set('column', n.file.column);
  stFileGestureFrame(f);
  f.addEventListener('load', () => {
    if (!f.contentDocument || f.contentDocument.URL === 'about:blank') return;
    const current = ST.nodes.find(node => node.id === n.id);
    if (current?.el === el) stHold(f, current);
  });
  // The stage admits visible editors alongside conversation loads after layout.
  (stFrame.pending ||= new Map()).set(f, '/ui/file-page.html?' + q);
  stScheduleFrameLoads();
}
// Wheel and pointer events do not bubble across iframe boundaries. Bind each
// readable document, including previews created later or replaced by a reload.
function stFileGestureFrame(f) {
  const bind = () => {
    let doc;
    try { doc = f.contentDocument; } catch { return; }
    if (!doc || doc.URL === 'about:blank' || doc._pgaFileGestures) return;
    doc._pgaFileGestures = true;
    const rect = () => {
      let top = 0, left = 0, frame = f;
      while (frame) {
        const box = frame.getBoundingClientRect(); top += box.top; left += box.left;
        const owner = frame.ownerDocument.defaultView;
        if (owner === window) break;
        frame = owner.frameElement;
      }
      return {top, left};
    };
    // Nested previews belong to the outer file window, not whichever chat
    // happened to have focus. Keep its identity as well as stage coordinates.
    const context = {getBoundingClientRect:rect, closest:selector => {
      let frame = f;
      while (frame && frame.ownerDocument.defaultView !== window) frame = frame.ownerDocument.defaultView.frameElement;
      return frame?.closest?.(selector) || null;
    }};
    if (f.ownerDocument !== document) {
      const owner = () => ST.nodes.find(n => n.el === context.closest('.stnode'));
      stPageClickBind(doc, owner, () => doc.getSelection());
      doc.addEventListener('pointerdown', e => {
        const n = owner();
        if (e.button === 0 && n && ST.focus !== n.id) stFocus(n.id);
      }, true);
    }
    stRightPanBind(doc, context);
    stMiddlePanBind(doc, context);
    doc.addEventListener('wheel', e => {
      if (e.ctrlKey || e.metaKey) return;
      const consume = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      if (stShiftWheel(e)) { consume(); return; }
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) {
        if (stBoundaryWheel(e, rect().top + e.clientY)) consume();
        return;
      }
      if (e.target.closest?.('.fp-img, .monaco-editor, video')) return;
      for (let el = e.target; el && el.nodeType === 1; el = el.parentElement)
        if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(doc.defaultView.getComputedStyle(el).overflowX)) return;
      if (stEdgeWheel(e.deltaX, e.deltaY)) consume();
    }, {capture: true, passive: false});
    doc.addEventListener('load', e => { if (e.target.tagName === 'IFRAME') stFileGestureFrame(e.target); }, true);
    doc.querySelectorAll('iframe').forEach(stFileGestureFrame);
  };
  if (!f._pgaFileGestureLoad) { f._pgaFileGestureLoad = bind; f.addEventListener('load', bind); }
  bind();
}
window.stFileGestureFrame = stFileGestureFrame;
function stFileDirty(n) {
  try { return !!n.file && !!n.el?.querySelector('iframe')?.contentWindow?.filePageDirty?.(); } catch { return false; }
}
function stFileCanClose(n) {
  return !stFileDirty(n) || confirm(L(`「${n.title}」有未保存的修改，仍要关闭吗？`, `“${n.title}” has unsaved changes. Close anyway?`));
}
window.addEventListener('beforeunload', e => {
  if (stWins().some(stFileDirty)) { e.preventDefault(); e.returnValue = ''; }
});
