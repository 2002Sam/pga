// A space mark owns presentation state only. A live chat/editor and its iframe
// remain the source of truth for messages, drafts, files and running work.
const ST_MARK_LAYOUT = [
  'ord', 'catOrd', 'overviewOrder', 'bw', 'pre', 'small', 'mini', 'big', 'fullscreen', 'bigWidth',
  'fx', 'fy', 'mw', 'mh', 'screenPin', 'side', 'par', 'kids', 'sel', 'kw', 'branchGap',
  'branchLayout', 'branchDocked', 'branchWeight', 'kidsCollapsed', 'tidyLinear', 'tidyCompact',
  'managerParked', 'managerBeside', 'ws',
];
function stMarkIdentity(n) {
  if (n.file) return JSON.stringify([n.file.uid, n.file.path, !!n.file.web]);
  return n.key || n.memo || n.knowledge || (n.pad && 'pad') || null;
}
// A blank window can acquire a conversation key after the mark was created.
function stMarkAssignChatKey(n, key) {
  if (!key) return;
  for (const mark of Object.values(ST.positionMarks)) {
    if (mark.page !== PG.cur || !mark.space) continue;
    const row = mark.space.windows.find(w => (mark.space.ids?.[w.id] || w.id) === n.id);
    if (!row?.seed || row.identity) continue;
    row.identity = row.seed.key = key;
    const rect = mark.space.visible.find(r => r.id === row.id);
    if (rect) rect.identity = key;
  }
}
function stMarkFields(n, fields) {
  return structuredClone(Object.fromEntries(fields.filter(k => n[k] !== undefined).map(k => [k, n[k]])));
}
function stMarkScene() {
  const rects = [], arena = $('#starena');
  let pinned = 0;
  for (const n of stWins()) {
    const p = ST.pos?.get(n.id);
    if (!p || p.tab || n.small || n.el?.hidden) continue;
    const fixed = !!n.screenPin;
    rects.push({id:n.id, identity:stMarkIdentity(n), x:fixed ? pinned : p.x, y:p.y, w:p.w, h:p.h,
      fixed, mini:!!n.mini, side:n.side !== false, kid:!!p.kid});
    if (fixed) pinned += p.w;
  }
  return {rects, inset:pinned, width:arena.clientWidth, height:arena.clientHeight};
}
function stMarkVisible({rects, inset, width}, left) {
  return rects.filter(r => r.fixed ? r.x < width : inset < width && r.x < left + width && r.x + r.w > left + inset);
}
function stMarkUnitMembers(u) {
  const nodes = u.wins || (u.win ? [u.win] : u.nodes || []);
  return [u.kind, ...nodes.map(n => n.id)];
}
function stCaptureMarkSpace(mark) {
  const scene = stMarkScene();
  const visible = stMarkVisible(scene, mark.left);
  const needed = new Set(visible.map(r => r.id));
  const byId = new Map(ST.nodes.map(n => [n.id, n]));
  // Ancestors lay out stacked children, even when the parent itself is offscreen.
  for (const id of needed) {
    const parent = byId.get(id)?.par;
    if (parent) needed.add(parent);
  }
  const windows = ST.nodes.filter(n => n.type === 'win').map(n => ({
    id:n.id, identity:stMarkIdentity(n), layout:stMarkFields(n, ST_MARK_LAYOUT),
    seed:needed.has(n.id) ? stMarkFields(n, ['key','title','pad','memo','memoSource','knowledge','knowledgeSource',
      'file','readingKey','managerProject','creationGroup','from','branchFrom','branchKey','branchParent']) : null,
  }));
  return {visible, windows, width:scene.width, height:scene.height, mode:ST.mapMode,
    list:!!ST.listOpen, shift:ST.shift, lead:ST.sortLead, catOpen:[...(ST.catOpen || [])],
    slots:(ST.units || []).filter(u => !u.hide && u.open).map(u => ({members:stMarkUnitMembers(u), x:u.x, w:u.w}))};
}
function stMarkSpaceChanged(mark, scene) {
  const s = mark.space;
  const scale = scene.width / s.width, height = scene.height / s.height;
  const visible = stMarkVisible(scene, mark.left * scale);
  if (s.list !== !!ST.listOpen || visible.length !== s.visible.length) return true;
  return s.visible.some(old => {
    const id = s.ids?.[old.id] || old.id;
    const r = visible.find(n => n.id === id && (!old.identity || n.identity === old.identity))
      || (old.identity && visible.find(n => n.identity === old.identity));
    if (r && r.id !== id) (s.ids ||= {})[old.id] = r.id;
    return !r || r.fixed !== old.fixed || r.mini !== old.mini || r.side !== old.side || r.kid !== old.kid ||
      Math.abs(r.x - old.x * scale) > 1 || Math.abs(r.w - old.w * scale) > 1 ||
      Math.abs(r.y - old.y * height) > 2 || Math.abs(r.h - old.h * height) > 2;
  });
}
function stRestoreMarkSpace(mark) {
  const s = mark.space, ids = {}, mounted = new Map(), wins = ST.nodes.filter(n => n.type === 'win');
  for (const row of s.windows) {
    const previous = s.ids?.[row.id] || row.id;
    let n = wins.find(w => w.id === previous && (!row.identity || stMarkIdentity(w) === row.identity));
    if (!n && row.identity) n = wins.find(w => stMarkIdentity(w) === row.identity && !mounted.has(w.id));
    if (!n && row.seed) {
      const id = ST.nodes.some(w => w.id === row.id) ? stId() : row.id;
      n = {type:'win', id, ...structuredClone(row.seed)};
      ST.nodes.push(n);
      stRecallPage(n);
      if (n.managerProject) stPmOffSet(n.managerProject, false);
      if (n.pad) store.set('pga_pad_off', '0');
    }
    if (n) { ids[row.id] = n.id; mounted.set(n.id, n); }
  }
  const mapped = id => ids[id] || id;
  if (s.list !== !!ST.listOpen) {
    stDropToggle(s.list);
    clearTimeout(ST.listFocusTimer); // The next navigation key still belongs to the stage.
  }
  const arena = stArena(), scale = arena.w / s.width;
  // Keep the object, iframe and current conversation data of every surviving window.
  for (const row of s.windows) {
    const n = mounted.get(ids[row.id]); if (!n) continue;
    const layout = structuredClone(row.layout), side = n.side;
    for (const k of ['par','sel','managerBeside']) if (layout[k]) layout[k] = mapped(layout[k]);
    if (layout.kids) layout.kids = layout.kids.map(mapped);
    if (layout.screenPin) for (const k of ['prev','next']) if (layout.screenPin[k]) layout.screenPin[k] = mapped(layout.screenPin[k]);
    const rect = s.visible.find(r => r.id === row.id);
    if (rect && scale !== 1 && layout.screenPin) layout.screenPin.resizedWidth = rect.w * scale;
    if (rect?.mini) {
      layout.mw = rect.w * scale; layout.mh = rect.h * arena.h / s.height;
      layout.fx = rect.x / s.width; layout.fy = rect.y / s.height;
    }
    for (const k of ST_MARK_LAYOUT) {
      if (k in layout) n[k] = layout[k]; else delete n[k];
    }
    if (n.el && n.side !== side) {
      n.el.querySelector('[data-stw="side"]')?.classList.toggle('on', n.side !== false);
      stSide(n);
    }
  }
  // Newly opened windows remain mounted, after the restored row.
  let ord = s.windows.reduce((max, row) => Math.max(max, row.layout.ord || 0), 0);
  for (const n of wins.filter(n => !mounted.has(n.id)).sort((a,b) => a.ord - b.ord)) {
    n.ord = ++ord;
    delete n.screenPin;
    if (n.mini) n.mini = false;
    if (n.par && mounted.has(n.par)) delete n.par;
  }
  const manager = s.visible.map(r => mounted.get(mapped(r.id))).find(n => n?.managerProject);
  if (manager) stPmActivate(manager);
  s.ids = ids;
  ST.shift = s.shift; ST.sortLead = s.lead; ST.sortAnchor = null;
  if (ST.mapMode !== s.mode) {
    ST.mapMode = s.mode;
    try { localStorage.setItem('pga_map_mode', s.mode); } catch {}
  }
  ST.catOpen = new Set(s.catOpen);
  const open = new Set(s.windows.filter(w => w.seed).map(w => mapped(w.id)));
  ST.markOpen = {page:PG.cur, ids:open};
  ST.focus = mapped(mark.anchor?.id) || ST.focus;
  ST.markPlacement = null;
  stRender();
  // Automatic time/category ordering or intervening windows can change the
  // native geometry even after the original window properties are restored.
  if (stMarkSpaceChanged(mark, stMarkScene())) {
    const slots = new Map(s.slots.map(slot => {
      const [kind, ...members] = slot.members;
      return [JSON.stringify([kind, ...members.map(mapped)]), slot];
    }));
    ST.markPlacement = {page:PG.cur, slots, width:s.width, end:mark.left + s.width};
    stRender();
  }
  stSave(); stScheduleFrameLoads();
}
// Replay the saved occupied slots only for the restored layout. A subsequent
// drag, resize, insertion or sort changes its native layout and releases it.
function stMarkPlaceUnits(units, arena) {
  const placement = ST.markPlacement;
  const open = units.filter(u => !u.hide && u.open);
  const keys = open.map(u => JSON.stringify(stMarkUnitMembers(u)));
  const signature = JSON.stringify(open.map((u,i) => [keys[i], u.x, u.w]));
  if (placement.page !== PG.cur || (placement.signature && placement.signature !== signature)) {
    ST.markPlacement = null; return;
  }
  placement.signature = signature;
  const scale = arena.w / placement.width;
  let end = placement.end * scale;
  const extra = [];
  for (const [i,u] of open.entries()) {
    const slot = placement.slots.get(keys[i]);
    if (!slot) { extra.push(u); continue; }
    u.x = slot.x * scale; u.w = slot.w * scale;
    end = Math.max(end, u.x + u.w + ST_GAP);
  }
  for (const u of extra) { u.x = end; end += u.w + ST_GAP; }
  units.sort((a,b) => (a.x ?? Infinity) - (b.x ?? Infinity));
  ST.span = Math.max(ST.span, end + ST_PADX);
}
