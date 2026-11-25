/* Retire idle views across categories; conversation history and agent runs live
   on the server. This also covers pages left behind by an explicit tidy. */
const ST_RESOURCES = {maxPages: 20, idleMs: 120000};
function stAutoCloseProtected(n) {
  if (!n.key || n.pad || n.memo || n.knowledge || n.file || n.managerProject || n.key.startsWith('chat:pm-')
    || n.screenPin || n.id === ST.focus || n.run || n.done || n._pgRestoring || stBusy(n)) return true;
  // Do not guess whether a task is idle when status polling is unavailable.
  if (!ST.liveCheckedAt || Date.now() - ST.liveCheckedAt > 10000) return true;
  const live = ST.liveByKey?.get(n.key);
  if (live && !live.finished) return true;
  const a = $('#starena'), p = ST.pos?.get(n.id);
  if (a && p && !n.small && !n.mini && !n.el?.hidden && !ST.folded?.has(n.id)
    && p.x < a.scrollLeft + a.clientWidth && p.x + p.w > a.scrollLeft) return true;
  try {
    const f = n.el?.querySelector('iframe'), w = f?.contentWindow, state = w?.S;
    const draft = f?.contentDocument?.querySelector('#chatText')?.value || state?.chatDraft || n.prog?.draft
      || window.PG?.pending?.get(n.id)?.draft;
    if (draft || state?.att?.length || state?.sending || state?.regenBusy || state?.knowledgePreparing
      || state?.remoteRun || state?.followupActive || state?.followupDraining || state?.followups?.[n.key]?.length) return true;
    if (JSON.parse(localStorage.getItem(`pga:followups:${S.uid}:${n.key}`) || '[]').length) return true;
    const selection = w?.getSelection?.();
    if (selection && !selection.isCollapsed) return true;
  } catch { return true; }
  return false;
}
function stAutoCloseIdlePages() {
  if (S.view !== 'stage' || !$('#vStage')?.dataset.ready || document.hidden || ST.frameMoving || ST.navigation
    || ST.drag || ST.pan || ST.overview || ST.rz || ST.branchResize || performance.now() - (ST.movedAt || 0) < 1500) return 0;
  const pages = stWins().filter(n => n.key && !n.pad && !n.memo && !n.knowledge && !n.file && !n.managerProject && !n.key.startsWith('chat:pm-'));
  let excess = pages.length - ST_RESOURCES.maxPages;
  if (excess <= 0) return 0;
  const now = Date.now(), tick = performance.now();
  const used = n => Math.max(n.lastUsedAt || 0, n.openedAt || 0, n.runAt || 0, n.completedAt || 0);
  const candidates = pages.filter(n => now - used(n) >= ST_RESOURCES.idleMs && !stAutoCloseProtected(n)
    && tick - (n.el?.querySelector('iframe')?._pgaSeenAt ?? -Infinity) >= ST_RESOURCES.idleMs).sort((a,b) => used(a) - used(b));
  const anchor = stAnchor(); let closed = 0;
  for (const n of candidates) {
    if (excess <= 0) break;
    // Storage exhaustion must not turn resource recovery into state loss.
    if (stRememberPage(n) === false) continue;
    stClose(n, {deferRender: true}); closed++; excess--;
  }
  if (closed) {
    ST.sortAnchor = anchor; stRender(); stSave(); stContexts(); window.pgLocalSave?.();
    toast(L(`已关闭 ${closed} 个闲置页面，对话仍在“所有对话”中`, `Closed ${closed} idle views; conversations remain in All conversations`));
  }
  return closed;
}
setTimeout(stAutoCloseIdlePages, 15000);
setInterval(stAutoCloseIdlePages, 30000);
