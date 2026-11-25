/* Explicitly tidy this stage. Folding changes presentation only: all windows,
   live frames, drafts and fork/context identities stay in the same page. */
function stTidyTime(w, recent) {
  return Math.max(0, ...[w.lastUsedAt, w.openedAt, w.runAt, w.completedAt].map(t => Number(t) || 0),
    Date.parse(recent?.get(w.key || w.memoSource || w.knowledgeSource)?.last || '') || 0);
}
function stTidyPlan(wins, recent, pageLimit = 15, categoryLimit = 5, perCategoryLimit = 4) {
  const byId = new Map(wins.map(w => [w.id, w])), byKey = new Map(wins.filter(w => w.key).map(w => [w.key, w]));
  const times = new Map(wins.map(w => [w.id, stTidyTime(w, recent)]));
  const groups = new Map(), groupOf = new Map(), parents = new Map(), children = new Map();
  const index = new Map(wins.map((w,i) => [w.id,i]));
  const byUse = (a,b) => times.get(b.id) - times.get(a.id) || index.get(a.id) - index.get(b.id);
  for (const w of wins) {
    const id = stGroupOf(w)?.id || '';
    groupOf.set(w.id, id);
    if (!groups.has(id)) groups.set(id, {id, wins:[], at:0});
    const group = groups.get(id); group.wins.push(w); group.at = Math.max(group.at, times.get(w.id));
  }
  const categories = [...groups.values()].sort((a,b) => b.at - a.at);
  const candidates = categories.slice(0, categoryLimit)
    .flatMap(g => g.wins.slice().sort(byUse).slice(0, perCategoryLimit));
  const keep = new Set(candidates.sort(byUse).slice(0,pageLimit).map(w => w.id));
  // Detached branches still have provenance. Gather them without changing their
  // category or reparenting the underlying conversation.
  for (const w of wins) {
    const parent = byId.get(w.par) || byId.get(w.branchParent) || byKey.get(w.branchFrom)
      || (w.branchKey && byKey.get(w.from)) || byKey.get(w.memoSource || w.knowledgeSource);
    if (parent && parent !== w && groupOf.get(parent.id) === groupOf.get(w.id)) parents.set(w.id, parent);
  }
  for (const w of wins) {
    const seen = new Set([w.id]);
    for (let p = parents.get(w.id); p; p = parents.get(p.id)) {
      if (seen.has(p.id)) { parents.delete(w.id); break; }
      seen.add(p.id);
    }
  }
  for (const [id, parent] of parents) {
    if (!children.has(parent.id)) children.set(parent.id, []);
    children.get(parent.id).push(byId.get(id));
  }
  const familyTime = new Map(times), post = [];
  const roots = wins.filter(w => !parents.has(w.id)), queue = [...roots];
  while (queue.length) { const w = queue.pop(); post.push(w); queue.push(...(children.get(w.id) || [])); }
  for (const w of post.reverse()) {
    const p = parents.get(w.id); if (p) familyTime.set(p.id, Math.max(familyTime.get(p.id), familyTime.get(w.id)));
  }
  const byFamily = (a,b) => familyTime.get(b.id) - familyTime.get(a.id) || byUse(a,b);
  const ordered = [];
  for (const group of categories) {
    const stack = group.wins.filter(w => !parents.has(w.id)).sort(byFamily).reverse();
    while (stack.length) {
      const w = stack.pop(); ordered.push(w);
      stack.push(...(children.get(w.id) || []).sort(byFamily).reverse());
    }
  }
  return {ordered, keep, categories: new Set(wins.filter(w => keep.has(w.id)).map(w => groupOf.get(w.id)))};
}
function stTidyRepair(wins) {
  const byId = new Map(wins.map(w => [w.id,w]));
  // Repair layout links only. branchFrom/branchKey and saved conversation
  // context are deliberately independent of these display relationships.
  for (const w of wins) {
    const seen = new Set([w.id]);
    for (let child = w; child.par;) {
      const parent = byId.get(child.par);
      if (!parent || seen.has(parent.id)) { delete child.par; break; }
      seen.add(parent.id); child = parent;
    }
  }
  for (const w of wins) {
    const kids = wins.filter(k => k.par === w.id).map(k => k.id);
    if (kids.length) { w.kids = kids; if (!kids.includes(w.sel)) w.sel = kids[0]; }
    else { delete w.kids; delete w.sel; }
  }
}
function stTidyStage() {
  window.stDockCancel?.(); window.stShiftStop?.(); stReorderStop();
  const wins = stWins(), recent = new Map(recentItems().map(x => [x.item,x]));
  stTidyRepair(wins);
  const plan = stTidyPlan(wins, recent), width = Math.max(1, Math.floor((stArena().w - 2 * ST_PADX) / 2));
  for (const [i,w] of plan.ordered.entries()) {
    const folded = !plan.keep.has(w.id);
    if (folded !== !!w.small) stKidKeep(w, folded);
    w.ord = i; w.bw = width; w.kw = width; w.tidyCompact = true; w.tidyLinear = true;
    w.small = folded; w.mini = false;
    for (const key of ['big','fullscreen','bigWidth','pre','branchGap','fx','fy','overviewOrder','catOrd','kidsCollapsed','branchDocked']) delete w[key];
  }
  ST.mapMode = 'cat';
  try { localStorage.setItem('pga_map_mode','cat'); } catch {}
  ST.catOpen?.clear(); ST.mapExpanded?.clear(); ST.stageOpen?.clear();
  ST.foldCatIds = {}; delete ST.foldAllIds; ST.projectLimits = {};
  ST.shift = 0; ST.sortLead = 0; ST.spaceRight = 0; ST.sortAnchor = null;
  if (!plan.keep.has(ST.focus)) ST.focus = plan.ordered.find(w => plan.keep.has(w.id))?.id || null;
  // A bulk reorder may move windows across dozens of screens. Commit their
  // final positions before revealing them instead of animating an empty view.
  const stage = window.document?.querySelector('#vStage');
  stage?.classList.add('st-tidying');
  try {
    stRender();
    if (ST.focus) stShow(ST.focus);
  } finally {
    stage?.getBoundingClientRect();
    stage?.classList.remove('st-tidying');
  }
  stSave(); window.pgLocalSave?.();
  return {open: plan.keep.size, categories: plan.categories.size, folded: wins.length - plan.keep.size};
}
// A tidied branch can stand beside a folded parent. Explicitly folding a whole
// branch layer still hides its descendants, and opening it restores them.
function stTidyHidden(w) {
  if (!w.tidyLinear) return false;
  if (w.branchDocked) return true;
  const seen = new Set([w.id]);
  for (let p = ST.nodes.find(n => n.id === w.par); p && !seen.has(p.id); p = ST.nodes.find(n => n.id === p.par)) {
    if (p.kidsCollapsed || p.branchDocked) return true;
    seen.add(p.id);
  }
  return false;
}
function stTidyUnits(units) {
  const recent = new Map(recentItems().map(x => [x.item,x]));
  const tail = [], body = [];
  for (const u of units) {
    const wins = u.wins || (u.win ? [u.win] : []);
    if (!u.hide && wins.length && wins.every(w => w.tidyLinear) && (u.kind === 'cat' || u.kind === 'lines' || u.line)) tail.push(u);
    else body.push(u);
  }
  const time = u => Math.max(0, ...(u.wins || [u.win]).map(w => stTidyTime(w, recent)));
  tail.sort((a,b) => time(b) - time(a));
  units.splice(0, units.length, ...body, ...tail);
}
