/* Middle-button overview and sorting: transient visuals; keep every iframe mounted. */
function stDockOrder(items, moving, slot) {
  const rest = items.filter(n => n !== moving);
  rest.splice(Math.max(0, Math.min(rest.length, slot)), 0, moving);
  return rest;
}
function stDockPeers(n, all) {
  const group = stGroupOf(n)?.id;
  const peers = all.filter(p => (p.par || null) === (n.par || null) && stGroupOf(p)?.id === group && !p.managerProject && !p.screenPin);
  if (n.screenPin) return [];
  if (n.managerProject) return [n]; // Managers retain their category's first position.
  if (n.par) {
    const parent = ST.nodes.find(p => p.id === n.par);
    peers.sort((a,b) => (parent?.kids || []).indexOf(a.id) - (parent?.kids || []).indexOf(b.id));
  }
  return peers;
}
function stDockMerge(all, peers, ordered) {
  let i = 0;
  return all.map(n => peers.includes(n) ? ordered[i++] : n);
}
// Across categories carry the entire original category; never reassign a chat's category.
// Inside a category retain sibling order, pinned pages and the manager's first position.
function stDockPlan(all, n, slot) {
  if (n.screenPin || ST.mapMode === 'time') return {order:all};
  const rest = all.filter(w => w !== n), group = stGroupOf(n)?.id;
  slot = Math.max(0, Math.min(rest.length, slot));
  const target = rest[Math.min(slot, rest.length - 1)];
  if (group && target && stGroupOf(target)?.id !== group) {
    const moving = all.filter(w => stGroupOf(w)?.id === group);
    const other = all.filter(w => !moving.includes(w));
    const targetGroup = stGroupOf(target)?.id;
    const targets = rest.filter(w => targetGroup ? stGroupOf(w)?.id === targetGroup : w === target);
    const after = slot >= (rest.indexOf(targets[0]) + rest.indexOf(targets.at(-1)) + 1) / 2;
    const at = after ? other.indexOf(targets.at(-1)) + 1 : other.indexOf(targets[0]);
    const order = [...other]; order.splice(at, 0, ...moving);
    return {order, moving, group:stGroupOf(n)};
  }
  const peers = stDockPeers(n, all);
  const peerSlot = rest.slice(0, slot).filter(w => peers.includes(w)).length;
  const ordered = peers.includes(n) ? stDockOrder(peers, n, peerSlot) : peers;
  return {order:stDockMerge(all, peers, ordered), peers, ordered};
}
function stDockHint(k, plan) {
  const text = ST.mapMode === 'time' ? L('按交流时间排序 · 切换到分类模式可拖动排序', 'Sorted by activity · Switch to category mode to reorder')
    : plan?.moving ? L(`移动整个分类「${plan.group?.name || plan.group?.id}」· ${plan.moving.length} 个页面 · Esc 取消`, `Move category “${plan.group?.name || plan.group?.id}” · ${plan.moving.length} pages · Esc to cancel`)
    : L('拖动排序 · 跨分类时整类移动 · Esc 取消', 'Drag to reorder · Across categories move the whole category · Esc to cancel');
  // Keep the exit button while the overview is latched.
  if (k.hint.firstChild?.nodeType === 3) k.hint.firstChild.textContent = text;
  else k.hint.textContent = text;
}
function stDockStart(d) {
  const arena = $('#starena');
  const all = stWins();
  const peers = stDockPeers(d.n, all);
  if (!peers.includes(d.n)) peers.push(d.n);
  const others = all.filter(n => n !== d.n);
  const layer = document.createElement('div'); layer.className = 'st-dock-layer';
  layer.style.left = arena.scrollLeft + 'px'; layer.style.width = arena.clientWidth + 'px';
  const hint = document.createElement('div'); hint.className = 'st-dock-hint';
  hint.textContent = L('拖动排序 · 松手放置 · Esc 取消', 'Drag to reorder · Release to place · Esc to cancel');layer.append(hint);
  const bars = others.map(n => {
    const bar = document.createElement('div');bar.className = 'st-dock-line';bar.dataset.dockPick=n.id;
    bar.style.setProperty('--dock-color', stGroupOf(n)?.c || 'var(--accent)');
    const title = document.createElement('span'); title.textContent = (n.file ? n.title : stTitle(n.key)) || n.managerProject || '';bar.append(title);layer.append(bar);
    const data = typeof stSummaryData === 'function' ? stSummaryData(n) : null;
    const excerpt = document.createElement('small');
    const latest = data?.excerpts?.filter(x => x.role !== L('你','You')).at(-1) || data?.excerpts?.at(-1);
    excerpt.textContent = String(data?.summary || latest?.text || L('暂无内容概要','No summary yet')).replace(/\s+/g,' ').slice(0,90);
    bar.append(excerpt);
    if (!data?.summary && !latest?.text && n.key && typeof api === 'function') {
      const imported = /^(c:|imp:)/.test(n.key);
      const url = imported ? `/v1/users/${S.uid}/imported/${encodeURIComponent(n.key.replace(/^(c:|imp:)/, ''))}` : `/v1/users/${S.uid}/chats/${encodeURIComponent(n.key)}`;
      api(url).then(r => {
        if (!layer.isConnected) return;
        const turns = r.turns || [], last = turns.filter(t => t.role !== 'user' && t.text).at(-1) || turns.at(-1);
        excerpt.textContent = String(r.summary || last?.text || r.excerpt || L('暂无内容概要','No summary yet')).replace(/\s+/g,' ').slice(0,90);
      }).catch(() => {});
    }
    return {n,bar};
  });
  arena.append(layer);
  const rect = d.el.getBoundingClientRect();
  d.dock = {layer,hint,bars,all,peers,slot:peers.indexOf(d.n),initial:peers.indexOf(d.n),
    scroll:arena.scrollLeft, width:arena.clientWidth, styles:d.el.getAttribute('style'),
    gap:Math.min(260,arena.clientWidth*.35), hidden:[], rect};
  // CSS transforms animate existing pages into lines; drafts/streams remain alive.
  for (const el of document.querySelectorAll('#stnodes > .stnode, #stbars > *')) {
    if (el === d.el) continue;
    d.dock.hidden.push(el);el.classList.add('st-dock-muted');
  }
  d.el.classList.add('st-dock-held');
  d.el.style.transformOrigin = '0 0';d.el.style.transform = 'scale(.65)';
  stDockMove(d, d.sx, d.sy);
}
function stDockMove(d, sx, sy) {
  if (d.dock?.latched) return;
  const k = d.dock, rest = k.all.filter(n => n !== d.n);
  const x = Math.max(12,Math.min(k.width-12, d.l0-k.scroll + d.gx + sx-d.sx));
  // Stable thresholds independent of the animated gap prevent slot oscillation.
  const pitch = Math.max(1,(k.width-k.gap-32)/Math.max(1,k.bars.length));
  const base = new Map(k.bars.map((b,i)=>[b.n,16+(i+.5)*pitch]));
  if (d.moved || Math.hypot(sx-d.sx,sy-d.sy)>4) {
    k.slot = rest.filter(n => x > (base.get(n) ?? 0)+k.gap/2).length;
    k.plan = stDockPlan(k.all, d.n, k.slot);
  }
  stDockHint(k, k.plan);
  stDockOverviewLayout(d, k.plan?.order || k.all);
  k.gapIndex = (k.plan?.order || k.all).indexOf(d.n);
  k.bars.forEach(({n,bar}) => bar.classList.toggle('eligible', k.plan?.moving ? k.plan.moving.includes(n) : k.peers.includes(n)));
  d.el.style.left = (k.scroll + x - Math.min(d.gx*.65,k.gap*.65))+'px';
  d.el.style.top = Math.max(8,d.t0+(sy-d.sy)*.3)+'px';
  if(Math.hypot(sx-d.sx,sy-d.sy)>4)d.moved=true;
  d.lx=sx;d.ly=sy;
}
function stDockCommit(d) {
  const k=d.dock;
  if (ST.mapMode === 'time') return;
  if (k.plan) {
    if (!d.moved) return;
    const {order, peers, ordered} = k.plan;
    const ranks = order.map(n => n.ord).sort((a,b) => a-b);
    order.forEach((n,i) => { n.ord=ranks[i]; if(n.overviewOrder!=null)n.overviewOrder=ranks[i]; });
    if (d.n.par && peers && ordered) {
      const parent=ST.nodes.find(n=>n.id===d.n.par);
      let i=0;if(parent)parent.kids=parent.kids.map(id=>peers.some(n=>n.id===id)?ordered[i++].id:id);
    }
    return;
  }
  if(d.moved && k.slot!==k.initial){
    const ordered=stDockOrder(k.peers,d.n,k.slot);
    if(d.n.par){
      const parent=ST.nodes.find(n=>n.id===d.n.par);
      let i=0;if(parent)parent.kids=parent.kids.map(id=>k.peers.some(n=>n.id===id)?ordered[i++].id:id);
    }else{
      const ranks=k.peers.map(n=>n.ord).sort((a,b)=>a-b);
      ordered.forEach((n,i)=>{n.ord=ranks[i];});
    }
    k.initial=k.slot;
  }
}
// Reflow only the overview visuals. Never move/reload the conversation iframes.
function stDockOverviewLayout(d, order = d.dock.all) {
  const k = d.dock, pitch = Math.max(1,(k.width-k.gap-32)/Math.max(1,k.bars.length));
  const gapIndex = order.indexOf(d.n), bars = new Map(k.bars.map(b => [b.n,b.bar]));
  k.centers = new Map();
  order.filter(n => n !== d.n).forEach((n,i) => {
    const x = 16+(i+.5)*pitch+(i>=gapIndex?k.gap:0), bar = bars.get(n);
    k.centers.set(n,x);
    if (bar) { bar.style.transform = `translateX(${x}px)`; bar.classList.remove('near'); }
  });
  const left = 24+gapIndex*pitch;
  d.el.style.left = (k.scroll+left)+'px';
  k.centers.set(d.n,left+(k.gap-16)/2);
}
function stDockReorderStart(d, n, e) {
  const k = d.dock;
  if (k.reorder) return;
  stDockOverviewLayout(d);
  const peers = stDockPeers(n,k.all), initial = peers.indexOf(n);
  k.ignoreClick = false;
  k.reorder = {n,peers,initial,slot:initial,sx:e.clientX,sy:e.clientY,id:e.pointerId,
    centers:new Map(k.centers),moved:false,order:k.all,el:n===d.n?d.el:k.bars.find(b=>b.n===n)?.bar};
  // Capture on the thumbnail, so a plain click still selects that thumbnail.
  try { k.reorder.el?.setPointerCapture(e.pointerId); } catch {}
}
function stDockReorderMove(d, e) {
  const k = d.dock, r = k.reorder;
  if (!r || r.id !== e.pointerId || r.n.screenPin) return;
  const dx = e.clientX-r.sx, dy = e.clientY-r.sy;
  if (!r.moved && Math.hypot(dx,dy) < 6) return;
  r.moved = true; r.el?.classList.add('st-dock-sorting');
  if (ST.mapMode === 'time') { stDockHint(k); return; }
  const x = Math.max(12,Math.min(k.width-12,r.centers.get(r.n)+dx));
  const rest = k.all.filter(n=>n!==r.n);
  r.slot = rest.filter(n=>x>r.centers.get(n)).length;
  r.plan = stDockPlan(k.all, r.n, r.slot); r.order = r.plan.order;
  stDockHint(k,r.plan);
  stDockOverviewLayout(d,r.order);
  if (r.n===d.n) d.el.style.left = (k.scroll+x-(k.gap-16)/2)+'px';
  else r.el.style.transform = `translateX(${x}px)`;
}
function stDockReorderEnd(d, cancel = false) {
  const k = d.dock, r = k.reorder;
  if (!r) return;
  k.reorder = null; k.ignoreClick = r.moved;
  r.el?.classList.remove('st-dock-sorting');
  try { if(r.el?.hasPointerCapture(r.id)) r.el.releasePointerCapture(r.id); } catch {}
  if (r.moved && !cancel) {
    stDockCommit({n:r.n,moved:true,dock:{plan:r.plan,peers:r.peers,slot:r.slot,initial:r.initial}});
    k.all = r.order;
    stSave();
  }
  stDockOverviewLayout(d);
}
function stDockRelease(d) {
  const k=d.dock;if(!k || k.latched)return d;
  if(ST.raf){cancelAnimationFrame(ST.raf);ST.raf=0;}ST.nx=null;
  stDockCommit(d);
  k.all = k.plan?.order || stDockMerge(k.all || [d.n,...k.bars.map(b=>b.n)],k.peers,stDockOrder(k.peers,d.n,k.slot));
  ST.drag=null;ST.overview=d;k.latched=true;
  // The released preview fits its reserved slot, even for a maximized page.
  const pitch=Math.max(1,(k.width-k.gap-32)/Math.max(1,k.bars.length));
  d.el.style.left=(k.scroll+24+(k.gapIndex||0)*pitch)+'px';
  d.el.style.transform=`scale(${Math.min(.65,(k.gap-16)/Math.max(1,d.el.offsetWidth))})`;
  $('#vStage').classList.remove('dragging');$('#vStage').classList.add('overview');
  k.layer.classList.add('latched');k.layer.tabIndex=-1;k.layer.setAttribute('aria-label',L('对话缩略视图','Conversation overview'));
  k.hint.textContent=L('左键拖动调整顺序 · 单击进入对话 · 中键或 Esc 退出','Drag previews to reorder · Click to open · Middle-click or Esc to exit');
  if (ST.mapMode === 'time') stDockHint(k);
  const close=document.createElement('button');close.type='button';close.dataset.dockClose='';close.textContent=L('退出缩略视图','Exit overview');k.hint.append(close);
  for(const {n,bar} of k.bars){bar.tabIndex=0;bar.setAttribute('role','button');bar.setAttribute('aria-label',(n.file ? n.title : stTitle(n.key))||n.title||L('打开对话','Open conversation'));}
  // Hidden live pages keep streaming, but must not take keyboard focus in overview.
  k.inert=[...k.hidden,d.el.querySelector('.stwin')].filter(Boolean).map(el=>[el,el.inert]);
  for(const [el] of k.inert)el.inert=true;
  stDockOverviewLayout(d);
  k.layer.focus({preventScroll:true});stSave();
  return d;
}
function stDockFinish(d, cancel=false) {
  const k=d.dock;if(!k)return;
  const middle=ST.middlePan;ST.middlePan=null;
  try { middle?.capture?.releasePointerCapture(middle.id); } catch {}
  if(k.reorder)stDockReorderEnd(d,true);
  if(ST.raf){cancelAnimationFrame(ST.raf);ST.raf=0;}ST.nx=null;
  const before = d.el.getBoundingClientRect();
  ST.drag=null;if(ST.overview===d)ST.overview=null;k.layer.remove();
  for(const [el,inert] of k.inert||[])el.inert=inert;
  k.hidden.forEach(el=>el.classList.remove('st-dock-muted'));
  d.el.classList.remove('st-dock-held','held');
  if(k.styles===null)d.el.removeAttribute('style');else d.el.setAttribute('style',k.styles);
  $('#vStage').classList.remove('dragging','overview');
  if(!cancel)stDockCommit(d);
  stRender();$('#starena').scrollLeft=k.scroll;
  if(!cancel)stSave();
  const after=d.el.getBoundingClientRect();
  if(d.el.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches && after.width){
    d.el.animate([{transformOrigin:'0 0',transform:`translate(${before.left-after.left}px,${before.top-after.top}px) scale(${before.width/after.width},${before.height/after.height})`},{transformOrigin:'0 0',transform:'none'}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});
  }
  return d;
}
function stDockCancel(){const d=ST.overview||(ST.drag?.dock&&ST.drag);if(d)stDockFinish(d,true);}
window.stDockCancel=stDockCancel;
function stDockPick(id){
  const n=ST.nodes.find(n=>n.id===id);stDockCancel();if(!n)return;
  if(n.mini){n.mini=false;stRender();}
  stMapNavigate(id);
}
document.addEventListener('pointerdown',e=>{
  if(!ST.overview)return;
  if(e.button===1){e.preventDefault();e.stopImmediatePropagation();stDockCancel();return;}
  if(e.button!==0)return;
  if(e.target.closest('.st-dock-layer,.st-dock-held')){
    e.preventDefault();e.stopImmediatePropagation();
    const id=e.target.closest('[data-dock-pick]')?.dataset.dockPick || e.target.closest('.st-dock-held')?.dataset.nid;
    const n=ST.nodes.find(n=>n.id===id);
    if(n)stDockReorderStart(ST.overview,n,e);
    else ST.overview.dock.ignoreClick=false;
    return;
  }
  stDockCancel(); // Other navigation controls remain usable.
},true);
document.addEventListener('pointermove',e=>{
  const d=ST.overview;if(!d?.dock.reorder || d.dock.reorder.id!==e.pointerId)return;
  e.preventDefault();e.stopImmediatePropagation();stDockReorderMove(d,e);
},true);
for(const type of ['pointerup','pointercancel','lostpointercapture'])document.addEventListener(type,e=>{
  const d=ST.overview;if(!d?.dock.reorder || d.dock.reorder.id!==e.pointerId)return;
  e.preventDefault();e.stopImmediatePropagation();stDockReorderEnd(d,type!=='pointerup');
},true);
document.addEventListener('click',e=>{
  if(!ST.overview || !e.target.closest('.st-dock-layer,.st-dock-held'))return;
  e.preventDefault();e.stopImmediatePropagation();
  if(ST.overview.dock.ignoreClick){ST.overview.dock.ignoreClick=false;return;}
  if(e.target.closest('[data-dock-close]')){stDockCancel();return;}
  const id=e.target.closest('[data-dock-pick]')?.dataset.dockPick || e.target.closest('.st-dock-held')?.dataset.nid;
  if(id)stDockPick(id);
},true);
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&(ST.overview||ST.drag?.dock)){e.preventDefault();e.stopImmediatePropagation();stDockCancel();return;}
  const id=ST.overview&&e.target.closest?.('[data-dock-pick]')?.dataset.dockPick;
  if(id&&(e.key==='Enter'||e.key===' ')){e.preventDefault();e.stopImmediatePropagation();stDockPick(id);}
},true);
document.addEventListener('wheel',e=>{if(ST.overview&&e.target.closest('#starena')){e.preventDefault();e.stopImmediatePropagation();}}, {capture:true,passive:false});
window.addEventListener('blur',()=>{if(ST.overview)stDockReorderEnd(ST.overview,true);else stDockCancel();});
window.addEventListener('resize',()=>{if(ST.overview)stDockCancel();});
