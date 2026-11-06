/* Middle-button sorting: transient visuals only; keep every iframe mounted. */
function stDockOrder(items, moving, slot) {
  const rest = items.filter(n => n !== moving);
  rest.splice(Math.max(0, Math.min(rest.length, slot)), 0, moving);
  return rest;
}
function stDockStart(d) {
  const arena = $('#starena');
  const group = stGroupOf(d.n)?.id;
  const all = stWins();
  const peers = all.filter(n => n.par === d.n.par && stGroupOf(n)?.id === group && !n.managerProject);
  if (!peers.includes(d.n)) peers.push(d.n);
  if (d.n.par) {
    const parent = ST.nodes.find(n => n.id === d.n.par);
    peers.sort((a,b) => (parent?.kids || []).indexOf(a.id) - (parent?.kids || []).indexOf(b.id));
  }
  const others = all.filter(n => n !== d.n);
  const layer = document.createElement('div'); layer.className = 'st-dock-layer';
  layer.style.left = arena.scrollLeft + 'px'; layer.style.width = arena.clientWidth + 'px';
  const hint = document.createElement('div'); hint.className = 'st-dock-hint';
  hint.textContent = L('拖动排序 · 松手放置 · Esc 取消', 'Drag to reorder · Release to place · Esc to cancel');layer.append(hint);
  const bars = others.map(n => {
    const bar = document.createElement('div');bar.className = 'st-dock-line';
    bar.style.setProperty('--dock-color', stGroupOf(n)?.c || 'var(--accent)');
    const title = document.createElement('span'); title.textContent = stTitle(n.key) || n.managerProject || '';bar.append(title);layer.append(bar);
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
  d.dock = {layer,bars,all,peers,slot:peers.indexOf(d.n),initial:peers.indexOf(d.n),
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
  const k = d.dock, rest = k.peers.filter(n => n !== d.n);
  const x = Math.max(12,Math.min(k.width-12, d.l0-k.scroll + d.gx + sx-d.sx));
  // Stable thresholds independent of the animated gap prevent slot oscillation.
  const pitch = Math.max(1,(k.width-k.gap-32)/Math.max(1,k.bars.length));
  const base = new Map(k.bars.map((b,i)=>[b.n,16+(i+.5)*pitch]));
  if (d.moved || Math.hypot(sx-d.sx,sy-d.sy)>4) k.slot = rest.filter(n => x > (base.get(n) ?? 0)+k.gap/2).length;
  const next = rest[k.slot], previous = rest[k.slot-1];
  const gapIndex = next ? k.bars.findIndex(b=>b.n===next) : previous ? k.bars.findIndex(b=>b.n===previous)+1 : 0;
  k.bars.forEach(({n,bar},i)=>{
    const left = 16+(i+.5)*pitch+(i>=gapIndex?k.gap:0);
    const near = Math.max(0,1-Math.abs(left-x)/130);
    bar.style.transform = `translateX(${left}px) scaleX(${1+near*1.1}) scaleY(${1+near*.025})`;
    bar.classList.toggle('near',near>.45);
    bar.classList.toggle('eligible',k.peers.includes(n));
  });
  d.el.style.left = (k.scroll + x - Math.min(d.gx*.65,k.gap*.65))+'px';
  d.el.style.top = Math.max(8,d.t0+(sy-d.sy)*.3)+'px';
  if(Math.hypot(sx-d.sx,sy-d.sy)>4)d.moved=true;
  d.lx=sx;d.ly=sy;
}
function stDockFinish(d, cancel=false) {
  const k=d.dock;if(!k)return;
  if(ST.raf){cancelAnimationFrame(ST.raf);ST.raf=0;}ST.nx=null;
  const before = d.el.getBoundingClientRect();
  ST.drag=null;k.layer.remove();
  k.hidden.forEach(el=>el.classList.remove('st-dock-muted'));
  d.el.classList.remove('st-dock-held','held');
  if(k.styles===null)d.el.removeAttribute('style');else d.el.setAttribute('style',k.styles);
  $('#vStage').classList.remove('dragging');
  if(!cancel && d.moved && k.slot!==k.initial){
    const ordered=stDockOrder(k.peers,d.n,k.slot);
    if(d.n.par){
      const parent=ST.nodes.find(n=>n.id===d.n.par);
      let i=0;if(parent)parent.kids=parent.kids.map(id=>k.peers.some(n=>n.id===id)?ordered[i++].id:id);
    }else{
      const ranks=k.peers.map(n=>n.ord).sort((a,b)=>a-b);
      ordered.forEach((n,i)=>{n.ord=ranks[i];});
    }
  }
  stRender();$('#starena').scrollLeft=k.scroll;
  if(!cancel)stSave();
  const after=d.el.getBoundingClientRect();
  if(d.el.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches && after.width){
    d.el.animate([{transformOrigin:'0 0',transform:`translate(${before.left-after.left}px,${before.top-after.top}px) scale(${before.width/after.width},${before.height/after.height})`},{transformOrigin:'0 0',transform:'none'}],{duration:240,easing:'cubic-bezier(.2,.8,.2,1)'});
  }
  return d;
}
function stDockCancel(){if(ST.drag?.dock)stDockFinish(ST.drag,true);}
window.stDockCancel=stDockCancel;
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&ST.drag?.dock){e.preventDefault();e.stopImmediatePropagation();stDockCancel();}},true);
window.addEventListener('blur',stDockCancel);
