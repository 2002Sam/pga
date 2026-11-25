/* Project managers are collapsible pages in the horizontal canvas.
   The small toolbar entry follows the project in view; it opens the existing
   manager instead of reserving another sidebar or creating duplicate frames. */
function stPmIsManager(n) { return !!(n && n.type === "win" && n.managerProject && n.key?.startsWith("chat:pm-")); }
const stPmName = id => id?.startsWith("pj:") && id.length > 3 ? id.slice(3) : null;
function stPmInit(saved) {
  if (saved?.pmPages) { stPmSingle(); return; }
  // Old snapshots stored all managers as folded because the pinned pane ignored
  // that flag. Bring only its current manager back as a page, preserving drafts.
  let old = null;
  try { old = JSON.parse(localStorage.getItem("pga_pm_pane") || "null"); } catch {}
  const managers = stWins().filter(stPmIsManager);
  const first = stWins().find(w => !stPmIsManager(w) && stPmName(stGroupOf(w)?.id));
  const name = stPmName(first && stGroupOf(first)?.id);
  const current = managers.find(w => w.managerProject === name) || managers[0];
  for (const m of managers) {
    m.mini = false;
    m.small = old?.shut || m !== current;
    if (!m.bw) m.bw = Math.min(480, stHalfWidth());
  }
  if (current) { ST.pmCat = "pj:" + current.managerProject; stPmActivate(current); }
}
// One manager is present on the canvas. Other categories retain their mounted
// documents in a hidden cache, so moving between categories cannot discard drafts.
function stPmActivate(manager) {
  for (const n of ST.nodes.filter(stPmIsManager)) {
    n.managerParked = n !== manager;
    try { const w = n.el?.querySelector('iframe')?.contentWindow, state = w?.S;
      if (state) { state.stageDormant = n.managerParked; if (!n.managerParked) w.pgaStageActivated?.(); }
    } catch {}
    if (n.managerParked) {
      delete n.screenPin;
      if (n.el) n.el.hidden = true;
    }
  }
}
function stPmSingle() {
  const active = ST.nodes.filter(n => stPmIsManager(n) && !n.managerParked);
  if (active.length < 2) return;
  const current = active.find(n => n.id === ST.focus) || active.slice().sort((a,b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))[0];
  stPmActivate(current);
}
function stPmUnitId(u) {
  if (u.kind === "cat") return u.g?.id || null;
  const w = u.kind === "win" ? u.win : u.kind === "stack" ? u.par : u.kind === "lines" ? u.wins?.[0] : null;
  return w ? stGroupOf(w)?.id || null : null;
}
function stPmAt(x) {
  if (x == null || !ST.units) return null;
  // Each layout creates a new units array. Resolve project membership once for
  // that layout, before subsequent scroll frames can repeat the catalog lookups.
  if (stPmAt.units !== ST.units) {
    stPmAt.units = ST.units;
    stPmAt.ranges = [];
    for (const u of ST.units) {
      if (u.hide || u.x == null) continue;
      const id = stPmUnitId(u);
      if (stPmName(id)) stPmAt.ranges.push({left:u.x, right:u.x + (u.open ? u.w : ST_TAB), id});
    }
  }
  let best = null, distance = Infinity;
  for (const {left, right, id} of stPmAt.ranges) {
    const d = Math.max(0, left - x, x - right);
    if (!d) return id;
    if (d < distance) { distance = d; best = id; }
  }
  return best;
}
function stPmProbe(a = $("#starena")) {
  if (!a) return null;
  const width = a.clientWidth, max = Math.max(0, a.scrollWidth - width);
  return max ? a.scrollLeft + width * Math.min(1, a.scrollLeft / max) : 0;
}
function stPmUser() { ST.pmUserAt = performance.now(); }
function stPmScrolled() {
  if (performance.now() - (ST.pmUserAt || 0) > 700) return;
  const id = stPmAt(stPmProbe());
  if (id && id !== ST.pmCat) { ST.pmCat = id; stPmButton(); }
}
function stPmRestored() {
  // Page snapshots restore the viewport after the initial stage render.
  const id = stPmAt(stPmProbe());
  if (id) ST.pmCat = id;
  ST.pmUserAt = 0;
  stPmButton();
}
function stPmFollow(w) {
  if (!w || w.type !== "win" || w.mini) return;
  const id = stPmIsManager(w) ? "pj:" + w.managerProject : stGroupOf(w)?.id;
  ST.pmUserAt = 0;
  if (stPmName(id)) { ST.pmCat = id; stPmButton(); }
}
function stPmCats() {
  const seen = new Map();
  for (const w of stWins()) {
    const g = stGroupOf(w);
    if (stPmName(g?.id) && !seen.has(g.id)) seen.set(g.id, g);
  }
  return [...seen.values()];
}
function stPmRendered() {
  const cats = stPmCats();
  if (!cats.some(g => g.id === ST.pmCat)) {
    const focused = ST.nodes.find(w => w.id === ST.focus);
    ST.pmCat = stGroupOf(focused || {})?.id;
    if (!stPmName(ST.pmCat)) ST.pmCat = stPmAt(stPmProbe()) || cats[0]?.id || null;
  }
  stPmButton();
}
function stPmGo(id = ST.pmCat) {
  const name = stPmName(id); if (!name) return;
  ST.pmCat = id; ST.pmUserAt = 0;
  return window.mgOpen(name);
}

// Every project on this stage gets a tab. Only expanded chats are navigation targets.
function stPmUpdateProjects(wins, expanded, recent) {
  const manager = wins.find(stPmIsManager);
  const targets = new Map();
  ST.pmProjectTargets = targets;
  if (!manager) return;
  const visible = new Set(expanded);
  for (const w of wins) {
    const name = stPmName(stGroupOf(w)?.id);
    if (!name) continue;
    if (!targets.has(name)) targets.set(name, null);
    if (!visible.has(w) || stPmIsManager(w) || w.file || w.pad || w.memo || w.knowledge) continue;
    const time = stMapTime(w, recent);
    if (!targets.get(name) || time > targets.get(name).time) targets.set(name, {node:w, time});
  }
  manager.el?.querySelector('iframe')?.contentWindow?.pmRenderProjects?.();
}
async function stPmSwitchProject(name) {
  const source = ST.pmProjectTargets?.get(name)?.node;
  if (!ST.pmProjectTargets?.has(name)) return;
  const pinned = stWins().find(n => stPmIsManager(n) && n.screenPin && !n.small && !n.mini);
  if (pinned || !source || !ST.nodes.includes(source) || !ST.pos?.has(source.id) || source.small || source.mini) {
    const current = window.pmBeginManagerOpen();
    if (pinned?.managerProject === name) return;
    try {
      const {manager:key} = await window.pmResolveManager(name);
      if (!current() || S.view !== 'stage' || !ST.pmProjectTargets?.has(name)) return;
      if (pinned && (!ST.nodes.includes(pinned) || pinned.managerParked || !pinned.screenPin || pinned.small || pinned.mini)) return;
      if (!key?.startsWith('chat:pm-')) throw Error(L('未找到这个分类的管理员', 'No manager found for this category'));
      stOpen(key, {managerProject:name, pinnedFrom:pinned});
    } catch (err) { if (current()) toast(err.message); }
    return;
  }
  const manager = await pmPanelStageOpen(source.id);
  const pos = manager && ST.pos?.get(manager.id);
  if (pos && !manager.managerParked && ST.focus === manager.id) {
    const arena = $("#starena");
    const [inset] = stPinViewport(manager, arena);
    arena.scrollTo({left:pos.x - inset, behavior:'instant'});
    ST.managerScrollLeft = arena.scrollLeft;
  }
}
function stPmButton() {
  const button = $("#stpmopen"); if (!button) return;
  const name = stPmName(ST.pmCat);
  button.hidden = !name;
  button.textContent = L("管理员", "Manager");
  button.title = name ? L(`打开「${name}」管理员`, `Open the ${name} manager`) : L("管理员", "Manager");
  button.setAttribute("aria-label", button.title);
  const manager = stWins().find(w => stPmIsManager(w) && w.managerProject === name);
  button.classList.toggle("on", !!manager && ST.focus === manager.id && !manager.small);
  button.onclick = () => stPmGo();
}

// Explicit manager navigation takes priority over the canvas's speculative
// iframe queue. Reuse the document and drafts, and resume only after placement.
window.stPmReady = function (manager) {
  if (!manager || ST.focus !== manager.id || manager.managerParked || manager.el?.hidden) return;
  const arena = $("#starena");
  if (arena) ST.managerScrollLeft = arena.scrollLeft;
  clearTimeout(ST.scrollEndTimer);
  // A manager click can interrupt another insertion; no old visual offset may
  // keep moving the source after the new final positions have been committed.
  for (const n of ST.nodes || []) {
    n.el?._insertAnimation?.cancel();
    n.el?._managerEntrance?.cancel();
  }
  ST.movedAt = -Infinity;
  stFrameMotion(false);
  const frame = manager.el?.querySelector('iframe');
  if (!frame) return;
  if (manager._stageSuspended) { delete manager._stageSuspended; stFrame(manager, manager.el); }
  const pending = stFrame.pending?.get(frame);
  if (pending) { stFrame.pending.delete(frame); stFrameStart(frame, pending); }
  try {
    const state = frame.contentWindow?.S;
    if (state) {
      state.stageDormant = false; state.stageMotion = false;
      frame.contentWindow.pgaStageActivated?.();
    }
  } catch {}
  stScheduleFrameLoads(0);
};
