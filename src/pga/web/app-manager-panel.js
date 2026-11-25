/* Canvas conversations open their category manager as an adjacent conversation page.
   Standalone hosts retain cached panels, including drafts and scroll position. */
const MP = { open: false, request: 0, identity: '', uid: '', frames: new Map() };
const pmPanelKey = () => String(MP.source || (S.lineView ? S.lineTarget || '' : S.imp?.key || S.treeItem?.item || S.chat || ''));
window.pmPanelSource = pmPanelKey;
function pmPanelTool() {
  if (S.view !== 'chats' || pmPanelKey().startsWith('chat:pm-')) return '';
  const stage = pmPanelStage();
  const label = stage ? L('将管理员移到当前会话左侧', 'Move the manager to the left of this conversation') : (MP.open ? L('收起管理员', 'Collapse manager') : L('打开分类管理员', 'Open this category’s manager'));
  if (stage) return `<button type="button" class="ghost ctool manager-panel-toggle" data-manager-panel aria-label="${label}" title="${label}">◎ <span>${L('管理员', 'Manager')}</span></button>`;
  return `<button type="button" class="ghost ctool manager-panel-toggle${MP.open ? ' on' : ''}" data-manager-panel aria-controls="managerPanel" aria-expanded="${MP.open}" aria-label="${label}" title="${label}">◎ <span>${L('管理员', 'Manager')}</span></button>`;
}
function pmPanelShell() {
  let panel = document.getElementById('managerPanel');
  if (panel) return panel;
  panel = document.createElement('aside'); panel.id = 'managerPanel'; panel.hidden = true;
  panel.setAttribute('aria-label', L('分类管理员', 'Category manager'));
  panel.innerHTML = `<header><span class="mp-icon" aria-hidden="true">◎</span><b data-mp-name>${L('管理员', 'Manager')}</b><button type="button" data-mp-close title="${L('收起管理员', 'Hide manager')}" aria-label="${L('收起管理员', 'Hide manager')}">‹</button></header><div class="mp-status" role="status"></div><div class="mp-frames"></div>`;
  document.body.append(panel);
  return panel;
}
function pmPanelLook() {
  // A persistent edge entry stays independent of composer rows and draft rerenders.
  if (document.body) {
    let entry = document.getElementById('managerEntry');
    const html = pmPanelStage() ? '' : pmPanelTool();
    if (!entry && html) {
      entry = document.createElement('div'); entry.id = 'managerEntry';
      document.body.append(entry);
    }
    if (entry) {
      entry.hidden = !html;
      if (entry._html !== html) { entry.innerHTML = html; entry._html = html; }
    }
  }
  const panel = document.getElementById('managerPanel');
  if (panel) panel.hidden = !MP.open;
  document.getElementById('vChats')?.classList.toggle('manager-side-open', MP.open);
  document.querySelectorAll('[data-manager-panel]').forEach(b => {
    if (b.hasAttribute('aria-controls')) b.setAttribute('aria-expanded', String(MP.open));
    b.classList.toggle('on', MP.open);
  });
}
function pmPanelClose(focus = true) {
  MP.open = false; MP.request++; MP.identity = ''; pmPanelLook();
  if (focus) document.querySelector('[data-manager-panel]')?.focus({preventScroll:true});
}
function pmPanelProject(catalog, key) {
  const canonical = typeof pjCanonical === 'function' ? pjCanonical(key) : key;
  const assigned = catalog.of?.[canonical];
  if (assigned) return assigned;
  const chat = (typeof recentItems === 'function' ? recentItems() : []).find(x =>
    (typeof pjCanonical === 'function' ? pjCanonical(x.item) : x.item) === canonical);
  return typeof pjName === 'function' ? pjName(chat) : chat?.project || '日常对话';
}
async function pmPanelLoad() {
  const key = pmPanelKey(), uid = S.uid, identity = uid + ':' + key;
  const request = ++MP.request, panel = pmPanelShell();
  MP.identity = identity;
  // An account switch must never expose the previous user's manager, even during loading.
  if (MP.uid !== uid) { MP.frames.forEach(f => f.remove()); MP.frames.clear(); MP.uid = uid; }
  MP.frames.forEach(f => { f.hidden = true; });
  const status = panel.querySelector('.mp-status'), label = panel.querySelector('[data-mp-name]');
  label.textContent = L('管理员', 'Manager');
  status.hidden = false; status.textContent = L('正在读取当前分类…', 'Loading this category…');
  const current = () => MP.open && request === MP.request && S.uid === uid && pmPanelKey() === key;
  try {
    const catalog = await api(`/v1/users/${uid}/conversation-projects`);
    if (!current()) return;
    const project = pmPanelProject(catalog, key);
    // The server resolves the stable manager key; never create a task or stage page to show it.
    const data = typeof window.pmResolveManager === 'function' ? await window.pmResolveManager(project)
      : await api(`/v1/users/${uid}/project-map`, {body:{project, manager_only:true}});
    if (!current()) return;
    if (!data.manager?.startsWith('chat:pm-')) throw new Error(L('未找到这个分类的管理员', 'No manager found for this category'));
    label.textContent = `${data.project || project} · ${L('管理员', 'Manager')}`;
    label.title = label.textContent;
    let frame = MP.frames.get(data.manager);
    if (!frame) {
      frame = document.createElement('iframe'); frame.title = label.textContent;
      const query = new URLSearchParams({view:'chats', embed:'1', c:data.manager, manager:data.project || project, pmpanel:'1'});
      if (typeof AS_UID !== 'undefined' && AS_UID) query.set('as', AS_UID);
      if (Q.get('lang')) query.set('lang', Q.get('lang'));
      frame.src = '/?' + query;
      frame.addEventListener('load', () => {
        frame.contentDocument?.addEventListener('keydown', e => {
          if (e.key === 'Escape' && !e.target.closest?.('.pj-inline-find') && !frame.contentDocument.querySelector('.modal')) {
            e.preventDefault(); e.stopPropagation(); pmPanelClose();
          }
        }, true);
      });
      MP.frames.set(data.manager, frame); panel.querySelector('.mp-frames').append(frame);
    }
    frame.hidden = false; status.hidden = true;
    frame.contentWindow?.pdRestoreScroll?.();
  } catch (err) {
    if (!current()) return;
    status.textContent = L('管理员读取失败：', 'Could not load the manager: ') + err.message;
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = L('重试', 'Retry');
    retry.onclick = () => pmPanelLoad(); status.append(retry);
  }
}
// A conversation embedded on the canvas opens a regular sibling page.
function pmPanelStage() {
  let host = window;
  try {
    while (host.parent && host.parent !== host && typeof host.parent.pmPanelToggle === 'function') host = host.parent;
    return host.S?.view === 'stage' && host.ST && typeof host.stOpen === 'function' ? host : null;
  } catch { return null; }
}
function pmPanelStageSource(project) {
  const arena = document.getElementById('starena'), left = arena?.scrollLeft || 0, width = arena?.clientWidth || 1000;
  const candidates = ST.nodes.filter(n => n.type === 'win' && !n.managerProject && !n.key?.startsWith('chat:pm-')
    && !n.small && !n.mini && stGroupOf(n)?.id === 'pj:' + project);
  const distance = n => { const p = ST.pos?.get(n.id); return p ? Math.max(0, left-p.x-p.w, p.x-left-width) : Infinity; };
  const focus = ST.nodes.find(n => n.id === ST.focus), preferred = focus?.managerBeside || ST.focus;
  return candidates.find(n => n.id === preferred && distance(n) === 0)
    || candidates.sort((a,b) => distance(a)-distance(b))[0];
}
window.pmPanelStageSource = pmPanelStageSource;
// Pointer intent starts only the lightweight identity lookup, without opening
// a page or changing focus. The click shares this same in-flight request.
function pmPanelPrepare(source) {
  if (S.view !== 'stage' || !S.uid || typeof window.pmResolveManager !== 'function') return;
  const origin = ST.nodes.find(n => n.id === source && n.type === 'win' && !n.managerProject);
  const group = origin && typeof stGroupOf === 'function' && stGroupOf(origin);
  const project = group?.id?.startsWith('pj:') ? group.id.slice(3) : null;
  if (project) window.pmResolveManager(project).catch(() => {});
}
async function pmPanelStageOpen(source, toggle = false) {
  if (!source || !S.uid) return;
  const origin = ST.nodes.find(n => n.type === 'win' && (n.id === source || n.key === source));
  if (!origin || origin.managerProject || origin.key?.startsWith('chat:pm-')) return;
  const sourceKey = origin.key;
  const button = origin.el?.querySelector('[data-stw="manager"]');
  const buttons = [button, document.getElementById('stpmopen')].filter(Boolean);
  if (MP.open) pmPanelClose(false);
  const request = ++MP.request, uid = S.uid, latest = window.pmBeginManagerOpen?.();
  const current = () => request === MP.request && (!latest || latest()) && S.uid === uid && S.view === 'stage' && ST.nodes.includes(origin) && origin.key === sourceKey;
  if (toggle) {
    // A second press can arrive before the first identity lookup finishes.
    if (MP.pendingOrigin === origin && MP.pendingRequest === request - 1) {
      MP.pendingOrigin = null;
      for (const b of buttons) b.removeAttribute('aria-busy');
      return;
    }
    const manager = ST.nodes.find(n => n.managerProject && n.managerBeside === origin.id
      && !n.managerParked && !n.small && !n.mini && !n.el?.hidden);
    if (manager) {
      const arena = document.getElementById('starena'), pos = ST.pos?.get(origin.id);
      if (arena && pos) ST.sortAnchor = {id:origin.id, dx:pos.x-arena.scrollLeft};
      stFocus(origin.id);
      stMini(manager, true);
      button?.focus({preventScroll:true});
      return;
    }
  }
  MP.pendingOrigin = toggle ? origin : null;
  MP.pendingRequest = request;
  for (const b of buttons) { b._pmRequest = request; b.setAttribute('aria-busy', 'true'); }
  try {
    // The canvas already knows its category, including unsent blank conversations.
    const group = typeof stGroupOf === 'function' ? stGroupOf(origin) : null;
    let project = group?.id?.startsWith('pj:') ? group.id.slice(3) : null;
    if (!project) {
      const catalog = await api(`/v1/users/${uid}/conversation-projects`);
      if (!current()) return;
      project = pmPanelProject(catalog, sourceKey || '');
    }
    const existing = ST.nodes.find(n => n.type === 'win' && n.managerProject === project && n.key?.startsWith('chat:pm-'));
    const data = existing ? {manager:existing.key, project} : typeof window.pmResolveManager === 'function'
      ? await window.pmResolveManager(project) : await api(`/v1/users/${uid}/project-map`, {body:{project, manager_only:true}});
    if (!current()) return;
    if (!data.manager?.startsWith('chat:pm-')) throw new Error(L('未找到这个分类的管理员', 'No manager found for this category'));
    const n = stOpen(data.manager, {win:origin.id, managerProject:data.project || project, managerBeside:origin.id});
    n.el?.querySelector('iframe')?.contentWindow?.pmSync?.();
    return n;
  } catch (err) { if (current()) toast(L('管理员读取失败：', 'Could not load the manager: ') + err.message); }
  finally {
    if (MP.pendingRequest === request) MP.pendingOrigin = null;
    for (const b of buttons) if (b._pmRequest === request) b.removeAttribute('aria-busy');
  }
}
window.pmPanelToggle = async function (source) {
  const stage = pmPanelStage();
  if (stage) return stage.pmPanelStageOpen(source || window.frameElement?._pgaNodeId || pmPanelKey(), true);
  // Standalone embedded views keep their existing host behavior.
  if (window.parent && window.parent !== window) {
    try {
      if (typeof window.parent.pmPanelToggle === 'function') {
        return window.parent.pmPanelToggle(pmPanelKey());
      }
    } catch {}
  }
  if (source && source !== MP.source) {
    MP.source = source;
    if (MP.open) { await pmPanelLoad(); return; }
  }
  if (MP.open) { pmPanelClose(); return; }
  if (!S.uid || (!MP.source && S.view !== 'chats') || pmPanelKey().startsWith('chat:pm-')) return;
  MP.open = true; pmPanelShell(); pmPanelLook();
  // Both use the same extension area; the memo's contents remain mounted.
  if (typeof MT !== 'undefined' && MT.open) { MT.open = false; mtDraw(); }
  await pmPanelLoad();
};
const pmPanelRenderChat = renderChat;
renderChat = function (...args) {
  const result = pmPanelRenderChat(...args);
  if (MP.open && ((!MP.source && S.view !== 'chats') || pmPanelKey().startsWith('chat:pm-'))) pmPanelClose(false);
  if (MP.open && MP.identity !== S.uid + ':' + pmPanelKey()) pmPanelLoad();
  pmPanelLook(); return result;
};
document.addEventListener('click', e => {
  if (e.target.closest('[data-manager-panel]')) { e.preventDefault(); pmPanelToggle(); }
  else if (e.target.closest('[data-mp-close]')) { e.preventDefault(); pmPanelClose(); }
  else if (e.target.closest('[data-chat-memo]')) pmPanelClose(false);
}, true);
for (const type of ['pointerover','focusin']) document.addEventListener(type, e => {
  const button = e.target.closest?.('[data-stw="manager"], #stpmopen, [data-pjmgr]');
  if (!button || (e.relatedTarget && button.contains(e.relatedTarget))) return;
  if (button.matches('[data-stw="manager"]')) pmPanelPrepare(button.closest('.stnode')?.dataset.nid);
  else {
    const project = button.dataset.pjmgr || (typeof ST !== 'undefined' && ST.pmCat?.startsWith('pj:') ? ST.pmCat.slice(3) : null);
    if (project && typeof window.pmResolveManager === 'function') window.pmResolveManager(project).catch(() => {});
  }
}, true);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && MP.open && !document.querySelector('.modal')) { e.preventDefault(); pmPanelClose(); }
});
