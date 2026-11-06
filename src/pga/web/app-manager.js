/* 管理员 is a normal stage conversation. Its knowledge graph lives above the chat history; the native composer,
   history, model controls and live agent all stay in that same frame (pga.project_context.brief supplies its context). */
const PM = { name: null, data: null, m: null, sel: null, mode: "graph", q: "", fold: new Set(), x: 0, y: 0, k: 1, pos: new Map(), N: [], E: [] };
const pmHost = () => { try { if (window.parent !== window && window.parent.mgOpen) return window.parent; } catch {} return window; };
// stWins is a lexical binding, not a property of the parent window. Read its public stage state.
const pmWins = () => (pmHost().ST?.nodes || []).filter(n=>n.type === "win").sort((a,b)=>(a.ord||0)-(b.ord||0));
const pmQ = id => document.querySelector(id + "-" + PM.mode);
function pmActivate(mode) {
  PM.views ||= {};
  PM.views[PM.mode] = Object.fromEntries(["N","E","at","x","y","k","graphReady"].map(k=>[k,PM[k]]));
  PM.mode=mode;
  Object.assign(PM,PM.views[mode] || {N:[],E:[],at:new Map(),x:0,y:0,k:1,graphReady:false});
}
function pmBoth(rebuild=false) {
  if(!PM.m)return;
  const mode=PM.mode;
  for(const next of ["graph"]){pmActivate(next);if(rebuild)PM.graphReady=false;pmGraphShow(rebuild);}
  pmActivate(mode);
}
const pmColor = (name) => pmHost().ST?.groupColors?.get("pj:" + name) || `hsl(${hueOf(name)} 62% 58%)`;
const pmShort = (t, n = 16) => { t = String(t || "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
const pmPush = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
const pmIcon = (kind) => ({ branch: "⑂", copy: "⧉", derived: "↳" })[kind] || "◇";

async function pmRequest(name) {
  const host = pmHost(), wins = pmWins(), refs = [];
  for (const b of wins) for (const l of b.links || []) { const a = host.ST?.nodes.find((n) => n.id === l.from); if (a?.key && b.key) refs.push([a.key, b.key]); }
  return api(`/v1/users/${S.uid}/project-map`, { body: { project: name, shown: wins.map((w) => w.key).filter(Boolean), refs } });
}
async function pmLoad() {
  const name = PM.name, request = PM.request = (PM.request || 0) + 1, data = await pmRequest(name);
  if (PM.name !== name || PM.request !== request) return false;
  PM.data = data;
  const d = PM.data, by = new Map(d.conversations.map((c) => [c.key, c])), parent = new Map(), kind = new Map(), kids = new Map(), refIn = new Map(), refOut = new Map();
  for (const e of d.edges) {
    if (e.kind === "ref") { pmPush(refIn, e.to, e.from); pmPush(refOut, e.from, e.to); continue; }
    if (!by.has(e.to) || !by.has(e.from) || parent.has(e.to)) continue;
    let up = e.from, loop = false; for (let i = 0; up && i < 60; i++) { if (up === e.to) { loop = true; break; } up = parent.get(up); }
    if (!loop) { parent.set(e.to, e.from); kind.set(e.to, e.kind); pmPush(kids, e.from, e.to); }
  }
  const names = new Map([...d.conversations.map((c) => [c.key, c.title]), ...d.outside.map((x) => [x.key, x.title])]);
  PM.m = { by, parent, kind, kids, refIn, refOut, names, topics: new Map(d.topics.map((t) => [t.id, t])) };
  return true;
}
const pmLive = () => { const s = new Set(); try { const h = pmHost(); for (const w of pmWins()) if (w.key && h.stBusy?.(w)) s.add(w.key); } catch {} return s; };

/* ------------------------------------------------ the graph: a knowledge-graph view of the same relations */
function pmLayout() {
  const d = PM.data, M = PM.m, N = [], E = [], at = new Map(), name = PM.name;
  const seed = (id, r) => { const a = hueOf(id) / 180 * Math.PI, p = PM.pos.get(name + "|" + id); return p ? { ...p } : { x: Math.cos(a) * r, y: Math.sin(a) * r }; };
  const add = (id, type, r, extra = {}) => { const n = { id, type, r, vx: 0, vy: 0, ...seed(id, type === "topic" ? 170 : 300), ...extra }; N.push(n); at.set(id, n); return n; };
  add("hub", "hub", 30, { x: 0, y: 0, fixed: true });
  for (const t of d.topics) add("t:" + t.id, "topic", 9, { label: t.title });
  for (const c of d.conversations) add(c.key, "conv", 6 + Math.min(13, Math.sqrt(c.turns || 0) * 2.2), { label: c.title, c });
  for (const x of d.outside) add(x.key, "out", 6, { label: x.title });
  const link = (a, b, kind, len, s) => { if (at.has(a) && at.has(b) && a !== b) E.push({ a: at.get(a), b: at.get(b), kind, len, s }); };
  for (const t of d.topics) link("hub", "t:" + t.id, "tree", 190, .04);
  for (const c of d.conversations) {
    if (M.parent.has(c.key)) link(M.parent.get(c.key), c.key, M.kind.get(c.key) || "branch", 64, .12);
    else if (c.topic && at.has("t:" + c.topic)) link("t:" + c.topic, c.key, "tree", 95, .07);
    else link("hub", c.key, "tree", 210, .025);
  }
  for (const e of d.edges) if (e.kind === "ref") link(e.from, e.to, "ref", 150, .03);
  const steps = PM.pos.size ? 120 : 320;
  for (let i=0;i<steps;i++) {
    for (let a=0;a<N.length;a++) for(let b=a+1;b<N.length;b++) {
      const p=N[a],q=N[b],dx=q.x-p.x,dy=q.y-p.y,d=Math.max(1,Math.hypot(dx,dy)),f=(1500+(p.r+q.r)*70)/(d*d);
      p.vx-=dx/d*f;p.vy-=dy/d*f;q.vx+=dx/d*f;q.vy+=dy/d*f;
    }
    for(const e of E){const dx=e.b.x-e.a.x,dy=e.b.y-e.a.y,d=Math.max(1,Math.hypot(dx,dy)),f=(d-e.len)*e.s;e.a.vx+=dx/d*f;e.a.vy+=dy/d*f;e.b.vx-=dx/d*f;e.b.vy-=dy/d*f;}
    for(const n of N){if(n.fixed){n.vx=n.vy=0;continue;}n.vx-=n.x*.004;n.vy-=n.y*.004;const v=Math.hypot(n.vx,n.vy),max=24*(1-i/steps)+1;if(v>max){n.vx*=max/v;n.vy*=max/v;}n.x+=n.vx;n.y+=n.vy;n.vx*=.55;n.vy*=.55;}
  }
  for(const n of N) PM.pos.set(name+"|"+n.id,{x:n.x,y:n.y});
  PM.N = N; PM.E = E; PM.at = at;
}
function pmEdgePath(e) {
  const {a,b}=e,dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;const x=a.x+dx/d*a.r,y=a.y+dy/d*a.r,tx=b.x-dx/d*(b.r+4),ty=b.y-dy/d*(b.r+4);return `M${x},${y} Q${(x+tx)/2-dy*.12},${(y+ty)/2+dx*.12} ${tx},${ty}`;
}
function pmGraph() {
  const svg = pmQ("#pmsvg"); if (!svg) return; if (!PM.N.length) { svg.innerHTML = `<text x="24" y="42" fill="currentColor">${L("当前页面还没有打开的对话", "No conversations open on this page")}</text>`; return; }
  const live = pmLive(), recent = new Set([...PM.m.by.values()].sort((a, b) => String(b.last || "").localeCompare(String(a.last || ""))).slice(0, 6).map((c) => c.key));
  svg.classList.toggle("intro", !svg.childElementCount); clearTimeout(PM.intro); PM.intro = setTimeout(() => svg.classList.remove("intro"), 1200);
  svg.innerHTML = `<defs><marker id="pm-a-${PM.mode}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 1 L9 5 L0 9 Z" class="pmarr"/></marker>
    <marker id="pm-r-${PM.mode}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 1 L9 5 L0 9 Z" class="pmarr ref"/></marker>
    <radialGradient id="pm-hub-${PM.mode}"><stop offset="0" stop-color="var(--pm-c)" stop-opacity=".95"/><stop offset="1" stop-color="var(--pm-c)" stop-opacity=".55"/></radialGradient></defs>
    <g id="pmg-${PM.mode}">${PM.E.map((e, i) => `<path class="pe ${e.kind}" data-pe="${i}" d="${pmEdgePath(e)}" ${e.kind === "tree" ? "" : `marker-end="url(#pm-${e.kind === "ref" ? "r" : "a"}-${PM.mode})"`}/>`).join("")}
    ${PM.N.map((n, i) => {
      const c = n.c, fresh = c && Date.now() - new Date(c.last || 0) < 3 * 864e5;
      const label = `<text y="${n.r+15}">${esc(pmShort(n.label || PM.name,16))}</text>`;
      const shape = `<title>${esc(n.label || PM.name)}</title>` + (n.type === "hub" ? `<circle class="pmhalo" r="40"/><circle r="30" fill="url(#pm-hub-${PM.mode})"/><text class="pmhubt" y="0">◎</text>` : n.type === "topic" ? `<rect x="-9" y="-9" width="18" height="18" rx="3" transform="rotate(45)"/>` : `<circle r="${n.r}"/>`);
      return `<g class="pn ${n.type}${fresh ? " fresh" : ""}${recent.has(n.id) ? " named" : ""}${live.has(n.id) ? " live" : ""}${PM.sel === n.id ? " on" : ""}" data-pn="${i}" data-pmk="${esc(n.id)}" transform="translate(${n.x},${n.y})" style="--i:${Math.min(i, 40)}">${live.has(n.id) ? `<circle r="${n.r + 5}" class="pmpulse"/>` : ""}${shape}${label}</g>`;
    }).join("")}</g>`;
  pmTransform(); pmLight();
}
function pmTransform() {
  const g = pmQ("#pmg"); if (g) g.setAttribute("transform", `translate(${PM.x},${PM.y}) scale(${PM.k})`);
  pmQ("#pmsvg")?.classList.toggle("near", PM.k > 1.6);
  const z = pmQ("#pmzoom"); if (z) z.textContent = Math.round(PM.k * 100) + "%";
}
function pmFit() {
  const vp = pmQ("#pmvp"); if (!vp || !PM.N.length || vp.hidden || !vp.clientHeight) return;
  const left = Math.min(...PM.N.map(n => n.x - 120)), right = Math.max(...PM.N.map(n => n.x + 120));
  const top = Math.min(...PM.N.map(n => n.y - n.r - 12)), bottom = Math.max(...PM.N.map(n => n.y + n.r + 28));
  // Leave room for labels and the zoom toolbar inside a normal, narrow conversation pane.
  const height = Math.max(30, vp.clientHeight - 48);
  PM.k = Math.max(.08, Math.min(1, (vp.clientWidth - 24) / (right - left), height / (bottom - top)));
  PM.x = vp.clientWidth / 2 - (left + right) / 2 * PM.k; PM.y = height / 2 - (top + bottom) / 2 * PM.k;
  pmTransform();
}
function pmZoom(k, cx, cy) {
  const vp = pmQ("#pmvp"), r = vp.getBoundingClientRect(), x = cx == null ? r.width / 2 : cx - r.left, y = cy == null ? r.height / 2 : cy - r.top, next = Math.max(.08, Math.min(3, k));
  PM.x = x - (x - PM.x) * next / PM.k; PM.y = y - (y - PM.y) * next / PM.k; PM.k = next; pmTransform();
}
function pmLight(id) {                                   // a node and what it touches stand out; the rest steps back
  const svg = pmQ("#pmsvg"); if (!svg) return;
  id = id ?? PM.sel; const near = new Set(id ? [id] : []);
  PM.E.forEach((e, i) => { const on = !!id && (e.a.id === id || e.b.id === id); if (on) { near.add(e.a.id); near.add(e.b.id); } svg.querySelector(`[data-pe="${i}"]`)?.classList.toggle("on", on); });
  svg.classList.toggle("focus", !!id);
  svg.querySelectorAll(".pn").forEach((g) => { g.classList.toggle("near", near.has(g.dataset.pmk)); g.classList.toggle("on", g.dataset.pmk === PM.sel); });
}

/* ------------------------------------------------ what is selected */
function pmInfo() {
  const box = document.querySelector("#pminfo"); if (!box) return;
  const M = PM.m, id = PM.sel, c = id && (M.by.get(id) || PM.at?.get(id)?.c), t = id?.startsWith("t:") && M.topics.get(id.slice(2)), o = id && PM.data.outside.find((x) => x.key === id);
  box.hidden = !(c || t || o); if (box.hidden) return;
  if (t) { const cs = [...M.by.values()].filter((x) => x.topic === t.id);
    box.innerHTML = `<div class="pmih"><span>◈ ${L("主题", "Topic")}</span><button data-pmclose-info>×</button></div><h3>${esc(t.title)}</h3>${t.summary ? `<p>${esc(t.summary)}</p>` : ""}<div class="pmis">${L(`${cs.length} 个对话`, `${cs.length} conversations`)}</div>${cs.slice(0, 8).map((x) => `<button class="pmil" data-pmsel="${esc(x.key)}">◇ ${esc(pmShort(x.title, 30))}</button>`).join("")}`; return; }
  if (o) { box.innerHTML = `<div class="pmih"><span>◌ ${esc(o.project || L("其他分类", "Elsewhere"))}</span><button data-pmclose-info>×</button></div><h3>${esc(o.title)}</h3><div class="pmia"><button class="primary" data-pmopen="${esc(o.key)}">${L("打开对话", "Open")} ↗</button></div>`; return; }
  const rel = [];
  if (M.parent.has(id)) rel.push([pmIcon(M.kind.get(id)) + " " + L("派生自", "grew from"), M.parent.get(id)]);
  for (const k of M.kids.get(id) || []) rel.push([pmIcon(M.kind.get(k)) + " " + L("派生出", "led to"), k]);
  for (const k of M.refIn.get(id) || []) rel.push(["⇠ " + L("引用了", "uses"), k]);
  for (const k of M.refOut.get(id) || []) rel.push(["⇢ " + L("被引用于", "used by"), k]);
  const topic = c.topic && M.topics.get(c.topic);
  box.innerHTML = `<div class="pmih"><span>${pmIcon(M.kind.get(id))} ${c.kind === "import" ? L("导入的对话", "Imported") : L("对话", "Conversation")}${c.agent ? " · " + esc(c.agent) : ""}</span><button data-pmclose-info>×</button></div>
    <h3>${esc(c.title)}</h3><div class="pmis">${[c.turns ? L(`${c.turns} 轮`, `${c.turns} turns`) : "", c.first ? L("始于 ", "since ") + esc(String(c.first).slice(0, 10)) : "", c.last ? L("最近 ", "last ") + esc(ago(c.last)) : ""].filter(Boolean).join(" · ")}</div>
    ${topic ? `<button class="pmtopic" data-pmsel="t:${esc(topic.id)}">◈ ${esc(topic.title)}</button>` : ""}${c.summary ? `<p>${esc(c.summary)}</p>` : ""}
    ${c.asked.length ? `<div class="pmsec">${L("最近的提问", "Latest questions")}</div>${c.asked.slice().reverse().map((q) => `<button class="pmq" data-pmopen="${esc(id)}" data-pmtext="${esc(q)}" title="${L("打开并定位到这句", "Open at this question")}">${esc(q)}</button>`).join("")}` : ""}
    ${rel.length ? `<div class="pmsec">${L("关系", "Relations")}</div>${rel.map(([how, k]) => `<button class="pmil" data-pmsel="${esc(k)}"><i>${how}</i> ${esc(pmShort(M.names.get(k) || k, 26))}</button>`).join("")}` : ""}
    <div class="pmia"><button data-pmassign="${esc(id)}">${L("分配输入中的任务", "Assign input task")}</button><button class="primary" data-pmopen="${esc(id)}">${L("打开对话", "Open")} ↗</button><button data-pmask="${esc(id)}">${L("问管理员", "Ask the manager")}</button></div>`;
}
function pmSelect(id, center) {
  PM.sel = id || null; pmLight(); pmInfo();
  const n = center && PM.mode !== "topic" && PM.at?.get(id), vp = pmQ("#pmvp");
  if (n && vp) { const from = { x: PM.x, y: PM.y }, to = { x: vp.clientWidth / 2 - n.x * PM.k, y: vp.clientHeight / 2 - n.y * PM.k }, t0 = performance.now();
    const step = (t) => { const p = Math.min(1, (t - t0) / 320), e = 1 - (1 - p) ** 3; PM.x = from.x + (to.x - from.x) * e; PM.y = from.y + (to.y - from.y) * e; pmTransform(); if (p < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step); }
}

/* ------------------------------------------------ the manager agent */
function pmAsk(text) {                              // use this conversation's native composer, preserving any draft
  const t = document.querySelector("#pdDraft") || document.querySelector("#chatText");
  if (!t) { toast(L("管理员还在加载，稍等一下", "The manager is still loading")); return; }
  if (text != null) { t.value = t.value.trim() ? t.value + "\n" + text : text; t.dispatchEvent(new Event("input", { bubbles: true })); }
  t.focus(); t.setSelectionRange(t.value.length, t.value.length);
}
const PM_ASK = [[L("总结进展", "Progress"), L("总结这个分类目前的整体进展：已经确定了什么、还在讨论什么。", "Summarise where this category stands: what is settled and what is still open.")],
  [L("未完成的事", "Open threads"), L("哪些对话还没有结论、或者有待办没做完？按优先级列出来。", "Which conversations have no conclusion yet or unfinished tasks? List them by priority.")],
  [L("从哪继续", "Where next"), L("我现在最应该接着哪个对话继续？说明理由。", "Which conversation should I continue now, and why?")],
  [L("整理关系", "Relations"), L("梳理这些对话之间的派生和引用关系，指出可以合并或者应该互相引用的对话。", "Map how these conversations relate; point out ones to merge or link.")]];

// Search is independent from generation: paging and opening results do not spend model tokens.
async function pmSearch(query, page=1) {
  const input=document.querySelector("#pmquery"), box=document.querySelector("#pmhits");
  query=String(query ?? input?.value ?? "").trim();
  if(!query) { PM.searchQuery=""; pmAll(); return; }
  if(!box) return;
  const name=PM.name, request=PM.searchRequest=(PM.searchRequest || 0)+1;
  PM.searchQuery=query; PM.hits=[]; if(input) input.value=query;
  box.textContent=L("正在检索项目上下文…", "Searching project context…");
  try {
    const data=await api(`/v1/users/${S.uid}/project-context/search?project=${encodeURIComponent(name)}&q=${encodeURIComponent(query)}&page=${page}&page_size=8`);
    if(PM.name!==name || PM.searchRequest!==request) return;
    if (!Number.isFinite(data.total)) throw new Error(L("后端尚未更新，请重启 PGA 服务", "Restart PGA to load the updated search API"));
    PM.hits=data.sources;
    box.innerHTML=`<div class="pmresultbar"><span>${L(`找到 ${data.total} 项 · ${data.page}/${data.pages} 页`, `${data.total} matches · ${data.page}/${data.pages}`)}</span><button data-pmopenpage ${data.sources.some(h=>h.key)?"":"disabled"}>${L("本页并排打开", "Open page side by side")}</button></div>` +
      data.sources.map(h=>`<article class="pmhit"><b>${h.key?`<button data-pmopen="${esc(h.key)}">${esc(h.title)} ↗</button>`:esc(h.title)}</b><small>${esc((h.at || "").slice(0,10))} · ${h.kind==="import"?L("导入摘录", "Imported excerpt"):L("原文匹配", "Source match")}</small><p>${esc(h.text)}</p></article>`).join("") +
      (!data.total?`<p>${L("没有找到匹配内容，试试功能名或换一组关键词。", "No matches. Try a feature name or different keywords.")}</p>`:"") +
      `<nav><button data-pmpage="${data.page-1}" ${data.page<=1?"disabled":""}>${L("上一页", "Previous")}</button><button data-pmpage="${data.page+1}" ${data.page>=data.pages?"disabled":""}>${L("下一页", "Next")}</button></nav><small>${esc(data.coverage || "")}</small>`;
  } catch(err) { if(PM.name===name && PM.searchRequest===request) box.textContent=L("检索失败：", "Search failed: ")+err.message; }
}

/* ------------------------------------------------ open the same regular conversation on the stage */
const pmOpening = new Map();
window.mgOpen = async function (name) {
  if (!name) return;
  const host = pmHost(); if (host !== window) return host.mgOpen(name);
  if (pmOpening.has(name)) return pmOpening.get(name);
  const opening = (async () => {
    try {
      const existing = window.ST?.nodes.find(n => n.type === "win" && n.managerProject === name && n.key?.startsWith("chat:pm-"));
      const data = existing ? { project: name, manager: existing.key } : await pmRequest(name);
      if (S.view !== "stage") show("stage");
      const n = stOpen(data.manager, { managerProject: data.project });
      // Also upgrade an already-open manager from an older snapshot, without reloading its draft or run.
      n.el?.querySelector("iframe")?.contentWindow?.pmSync?.();
      return n;
    } catch (err) { toast(err.message); }
  })();
  pmOpening.set(name, opening);
  try { return await opening; } finally { pmOpening.delete(name); }
};
window.pmProjectFor = function (key) {
  if (!key?.startsWith("chat:pm-")) return null;
  const n = pmHost().ST?.nodes.find(n => n.type === "win" && n.key === key && n.managerProject);
  return n?.managerProject || (typeof Q !== "undefined" && Q.get("c") === key ? Q.get("manager") : null);
};
function pmFullOpen(mode) {
  const host = pmHost(), doc = host.document;
  doc.querySelector('#pmfullscreen')?._close?.();
  const overlay = doc.createElement('section'); overlay.id = 'pmfullscreen';
  overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-label', PM.name + ' · ' + L('项目视图', 'Project view'));
  const url = new URL(location.href); url.searchParams.set('pmfull', mode); url.searchParams.set('manager', PM.name); url.searchParams.set('c', S.chat);
  const button = doc.createElement('button'); button.textContent = L('‹ 返回对话', '‹ Back to conversation');
  const frame = doc.createElement('iframe'); frame.src = url.href; frame.title = overlay.getAttribute('aria-label');
  const previous = doc.activeElement;
  const close = () => { overlay.remove(); doc.removeEventListener('keydown', escape); previous?.focus?.(); };
  const escape = e => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  overlay._close = close; button.onclick = close; doc.addEventListener('keydown', escape);
  frame.addEventListener('load', () => { frame.contentDocument?.addEventListener('keydown', escape); });
  overlay.append(button, frame); doc.body.appendChild(overlay); button.focus();
}
window.pmSync = function () {
  const name = !S.imp && !S.lineView && !S.treeItem && window.pmProjectFor(S.chat), pane = document.querySelector(".cpane");
  if (!name || !pane) { pmRemove(); return null; }
  if (PM.name === name && document.querySelector("#pmview")) return name;
  pmRemove();
  PM.name = name; PM.autoQuery = null; PM.hits = []; PM.sel = null; PM.q = ""; PM.views = {}; PM.mode = "graph"; PM.fold = new Set(); PM.graphReady = false;
  const el = document.createElement("section"); el.id = "pmview";
  el.setAttribute("aria-label", name + " · " + L("对话关系", "Conversation relationships"));
  el.style.setProperty("--pm-c", pmColor(name));
  // Two panes: on the left the manager's document (app-pmdoc.js), on the right the category's knowledge graph and every
  // conversation in it.
  el.innerHTML = `<nav class="pmviewnav"><button data-pmfull="doc">${L('管理员文档', 'Manager document')} ↗</button><button data-pmfull="graph">${L('知识图谱', 'Knowledge graph')} ↗</button><button data-pmfull="search">${L('对话检索', 'Conversation search')} ↗</button></nav><section class="pmdocpane" id="pmdoc" aria-label="${L("管理员文档", "Manager document")}"></section>
    <aside class="pmside"><header class="pmhead"><b>${esc(name)} · ${L("知识图谱", "Knowledge graph")}</b><span class="pmstats" id="pmstats">${L("读取中…", "Loading…")}</span>
    <button data-pmcontext title="${L("资料与记忆", "Context")}">◈</button><button data-pmreload title="${L("刷新关系", "Refresh relationships")}">⟳</button></header>
    <div class="pmdetail"><div class="pmbody pmsplit">${["graph"].map(mode=>`<section class="pmcanvas" data-pmcanvas="${mode}"><div id="pmvp-${mode}" class="pmviewport"><svg id="pmsvg-${mode}" class="pmsvg"></svg><div class="pmtools"><button data-pmz="out">−</button><span id="pmzoom-${mode}">100%</span><button data-pmz="in">+</button><button data-pmfit>${L("适应", "Fit")}</button><button data-pmrelayout>${L("重排", "Re-arrange")}</button></div></div></section>`).join("")}
    <aside id="pminfo" hidden aria-label="${L("对话详情", "Conversation details")}"></aside></div>
    <div class="pmlegend"><span><i class="lb"></i>${L("派生 / 分支", "Grew from")}</span><span><i class="lr"></i>${L("引用", "Uses")}</span><span><i class="lt"></i>${L("主题", "Topic")}</span></div></div>
    <section class="pmresults"><form id="pmsearchform"><input id="pmquery" maxlength="600" placeholder="${L("在这个分类里查找对话、功能或之前的决定…", "Find conversations, features or decisions…")}" aria-label="${L("搜索项目上下文", "Search project context")}"><button type="submit">${L("搜索", "Search")}</button></form><div id="pmhits" aria-live="polite">${L("读取中…", "Loading…")}</div></section></aside>`;
  document.documentElement.classList.add("pmworkspace"); pane.classList.add("pmchat"); pane.insertBefore(el, document.querySelector("#cdlg"));
  const fullMode = new URLSearchParams(location.search).get('pmfull');
  if (['doc','graph','search'].includes(fullMode)) {
    document.documentElement.dataset.pmfull = fullMode;
    el.dataset.fullMode = fullMode;
  }
  pmWire(el); pmRefresh(true);
  return name;
};
function pmGraphShow(fit = false) {
  if (!PM.m || PM.mode === "topic" || document.querySelector("#pmview .pmdetail")?.hidden) return;
  if (!PM.graphReady) { pmLayout(); pmGraph(); PM.graphReady = true; fit = true; }
  if (fit) pmFit();
}
async function pmRefresh(first) {
  const name = PM.name;
  try { if (!await pmLoad()) return; PM.retries = 0; } catch (err) {
    if (PM.name !== name) return;
    const stats = document.querySelector("#pmstats"); if (stats) stats.textContent = L("读取失败，点 ⟳ 重试", "Could not load; retry with ⟳");
    console.warn("manager map", err);
    if ((PM.retries = (PM.retries || 0) + 1) <= 4) setTimeout(() => { if (PM.name === name && !PM.data) pmRefresh(); }, 1500 * PM.retries);   // the stage may still be starting
    return;
  }
  if (!document.querySelector("#pmview")) return;
  const d = PM.data, M = PM.m, br = M.parent.size, refs = d.edges.filter(e => e.kind === "ref").length;
  document.querySelector("#pmstats").textContent = L(`${d.conversations.length} 个对话 · ${br} 派生 · ${refs} 引用`, `${d.conversations.length} chats · ${br} derived · ${refs} references`);
  PM.graphReady = false;
  pmBoth(true); pmInfo();
  if (!PM.searchQuery) pmAll();
  window.pdRender?.();
}
function pmAll() {                                  // by default: every conversation of the category, the latest first
  const box = document.querySelector("#pmhits"); if (!box || !PM.data) return;
  const cs = [...PM.data.conversations].sort((a, b) => String(b.last || "").localeCompare(String(a.last || "")));
  box.innerHTML = `<div class="pmresultbar"><span>${L(`全部相关对话 · ${cs.length}`, `All related conversations · ${cs.length}`)}</span></div>` +
    cs.map(c => `<article class="pmhit"><b><button data-pmbeside="${esc(c.key)}" title="${L("拉到管理员旁边", "Open beside the manager")}">${esc(c.title)}</button></b><small>${esc(c.last ? ago(c.last) : "")}${c.turns ? " · " + L(`${c.turns} 轮`, `${c.turns} turns`) : ""}</small>${c.summary ? `<p>${esc(c.summary)}</p>` : ""}</article>`).join("") +
    (cs.length ? "" : `<p>${L("这个分类还没有对话。", "No conversations in this category yet.")}</p>`);
}
function pmRemove() {
  clearInterval(PM.timer); PM.resize?.disconnect(); PM.request = (PM.request || 0) + 1;
  document.querySelector("#pmview")?.remove(); document.querySelector(".cpane")?.classList.remove("pmchat");
  document.documentElement.classList.remove("pmworkspace");
  PM.searchRequest = (PM.searchRequest || 0) + 1;
  PM.name = null; PM.data = PM.m = null; PM.N = []; PM.E = [];
}
window.mgGo = function (key, text) {                  // leave the manager in place and open the selected conversation
  if (!key) return;
  const host = pmHost(); host.document.querySelector("#pmfullscreen")?._close?.(); if (host !== window) return host.mgGo(key, text);
  if (S.view !== "stage" && typeof show === "function") show("stage");
  if (text && typeof pjOpenOn === "function") pjOpenOn(window, key, "", text); else if (typeof stOpen === "function") stOpen(key); else pjGo(key, "", "");
};
// Conversation re-renders update only the normal chat. The relationship panel and its selection keep their DOM.
if (typeof renderChat === "function") {
  const chatRender = renderChat;
  renderChat = function (...args) {
    const name = window.pmSync(), result = chatRender(...args);
    if (name) {
      const title = document.querySelector("#chead h1"), kind = document.querySelector("#chead .kind"), input = document.querySelector("#chatText");
      if (title) title.textContent = `${name} · ${L("管理员", "Manager")}`;
      if (kind) kind.textContent = L("项目管理员", "Project manager");
      if (input) input.placeholder = L(`描述要找的功能、旧讨论或决定，管理员会检索「${name}」…`, `Organize “${name}”, assign tasks or specify the next step…`);
      const stats = document.querySelector("#pmstats");
      if (stats && S.sending) stats.textContent = L("正在处理管理指令…", "Processing instructions…");
      const turns = S.chatTurns[S.chat] || [];
      const question = [...turns].reverse().find(t => t.role === "user")?.text;
      window.pdRender?.();
      const last = [...turns].reverse().find(t => t.role === "agent");
      if (PM.wasSending && !S.sending) pmRefresh(); PM.wasSending = !!S.sending;
    }
    return result;
  };
}

function pmWire(el) {
  el.addEventListener('click', e => {
    const button = e.target.closest('[data-pmfull]');
    if (button) { e.preventDefault(); pmFullOpen(button.dataset.pmfull); }
  });
  let g = null, suppress = false;
  for(const type of ["pointerdown","pointerover","click","dblclick","wheel"]) el.addEventListener(type,e=>{const panel=e.target.closest("[data-pmcanvas]");if(panel && PM.mode!==panel.dataset.pmcanvas)pmActivate(panel.dataset.pmcanvas);},true);
  el.querySelector("#pmsearchform").addEventListener("submit", e => { e.preventDefault(); pmSearch(); });
  el.addEventListener("click", (e) => {
    if (suppress) { suppress = false; return; }
    const t = e.target;
    if (t.closest("[data-pmtoggle]")) {
      const detail = el.querySelector(".pmdetail"), button = el.querySelector("[data-pmtoggle]");
      detail.hidden = !detail.hidden; button.setAttribute("aria-expanded", String(!detail.hidden));
      if (!detail.hidden) pmGraphShow(true); return;
    }
    if (t.closest("[data-pmreload]")) return pmRefresh();
    if (t.closest("[data-pmcontext]")) return pmHost().pjShared(PM.name);
    if (t.closest("[data-pmfit]")) return pmFit();
    if (t.closest("[data-pmrelayout]")) { if (!PM.m) return; for (const k of [...PM.pos.keys()]) if (k.startsWith(PM.name + "|")) PM.pos.delete(k); pmLayout(); pmGraph(); pmFit(); return; }
    const z = t.closest("[data-pmz]"); if (z) return pmZoom(PM.k * (z.dataset.pmz === "in" ? 1.25 : 1 / 1.25));
    const chip = t.closest("[data-pmchip]"); if (chip) return pmAsk(PM_ASK[+chip.dataset.pmchip][1]);
    if (t.closest("[data-pmsearch]")) { const input=el.querySelector("#pmquery"); input.value=document.querySelector("#chatText")?.value.trim() || input.value; input.focus(); if(input.value.trim()) pmSearch(); return; }
    const page=t.closest("[data-pmpage]"); if(page) return pmSearch(PM.searchQuery, +page.dataset.pmpage);
    if(t.closest("[data-pmopenpage]")) { for(const hit of PM.hits || []) if(hit.key) mgGo(hit.key); return; }
    const open = t.closest("[data-pmopen]"); if (open) return mgGo(open.dataset.pmopen, open.dataset.pmtext || "");
    const beside = t.closest("[data-pmbeside]"); if (beside) return window.pdBeside?.(beside.dataset.pmbeside);
    const assign = t.closest("[data-pmassign]");
    if (assign) {
      const text = (document.querySelector("#pdDraft") || document.querySelector("#chatText"))?.value.trim();
      if (!text) { toast(L("先在输入框写下要分配的任务", "Write the task in the input first")); return; }
      const host = pmHost(), n = host.stOpen(assign.dataset.pmassign);
      let tries=0;
      const deliver = () => {
        const w=n.el?.querySelector("iframe")?.contentWindow, input=w?.document.querySelector("#chatText");
        if (!input) { if (++tries<40) setTimeout(deliver,250); else toast(L("对话未加载完成，请重试", "Conversation not ready; retry")); return; }
        input.value = input.value.trim() ? input.value + "\n" + text : text;
        input.dispatchEvent(new w.Event("input",{bubbles:true})); input.focus();
        toast(L("任务已放入目标对话，点击发送即可执行", "Task prepared in the target conversation; send to execute"));
      }; deliver(); return;
    }
    const ask = t.closest("[data-pmask]"); if (ask) { const c = PM.m.by.get(ask.dataset.pmask); return pmAsk(L(`关于「${c.title}」：`, `About “${c.title}”: `)); }
    if (t.closest("[data-pmclose-info]")) return pmSelect(null);
    const sel = t.closest("[data-pmsel]"); if (sel) return pmSelect(sel.dataset.pmsel, true);
    const node = t.closest(".pn"); if (node) return node.dataset.pmk === "hub" ? pmAsk(null) : pmSelect(node.dataset.pmk);
    if (t.closest(".pmsvg")) pmSelect(null);
  });
  el.addEventListener("dblclick", (e) => {
    const node = e.target.closest(".pn");
    const k = (node && node.dataset.pmk !== "hub" && !node.dataset.pmk.startsWith("t:") && node.dataset.pmk);
    if (k && !e.target.closest("button")) mgGo(k);
  });
  el.addEventListener("pointerover", (e) => { const n = e.target.closest(".pn"); if (n) pmLight(n.dataset.pmk); });
  el.addEventListener("pointerout", (e) => { const n = e.target.closest(".pn"); if (n && !n.contains(e.relatedTarget)) pmLight(); });
  for(const vp of el.querySelectorAll(".pmviewport")) {
  vp.addEventListener("wheel", (e) => { e.preventDefault(); e.stopPropagation(); pmZoom(PM.k * Math.exp(-e.deltaY * .0015), e.clientX, e.clientY); }, { passive: false });
  vp.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".pmtools, #pminfo")) return;
    const node = e.target.closest(".pn"), n = node && PM.N[+node.dataset.pn];
    g = { n: n && !n.fixed ? n : null, el: node, sx: e.clientX, sy: e.clientY, x: n ? n.x : PM.x, y: n ? n.y : PM.y, moved: false };
  });
  vp.addEventListener("pointermove", (e) => {
    if (!g) return; const dx = e.clientX - g.sx, dy = e.clientY - g.sy; if (!g.moved && Math.hypot(dx, dy) < 4) return;
    if (!g.moved) { g.moved = true; vp.setPointerCapture(e.pointerId); vp.classList.add("grab"); }   // captured only once it moves: a plain click keeps its target
    if (g.n) { g.n.x = g.x + dx / PM.k; g.n.y = g.y + dy / PM.k; g.el.setAttribute("transform", `translate(${g.n.x},${g.n.y})`); PM.pos.set(PM.name + "|" + g.n.id, { x: g.n.x, y: g.n.y });
      PM.E.forEach((ed, i) => { if (ed.a === g.n || ed.b === g.n) vp.querySelector(`[data-pe="${i}"]`)?.setAttribute("d", pmEdgePath(ed)); }); }
    else if (!g.el) { PM.x = g.x + dx; PM.y = g.y + dy; pmTransform(); }
  });
  const end = (e) => { if (!g) return; suppress = g.moved; g = null; vp.classList.remove("grab"); if (vp.hasPointerCapture(e.pointerId)) vp.releasePointerCapture(e.pointerId); setTimeout(() => { suppress = false; }, 0); };
  vp.addEventListener("pointerup", end); vp.addEventListener("pointercancel", end);
  }
  el.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || document.querySelector(".modal")) return;
    e.preventDefault(); e.stopPropagation(); pmSelect(null);
  });
  PM.resize = new ResizeObserver(() => pmFit());
  el.querySelectorAll(".pmviewport").forEach(vp=>PM.resize.observe(vp));
  let stageSig = "", sig = "";
  PM.timer = setInterval(() => {
    const stage=JSON.stringify(pmWins().map(w=>[w.key,w.par,w.from,w.links])),live=[...pmLive()].join();
    if(!g && (stage!==stageSig || live!==sig)){stageSig=stage;sig=live;PM.graphReady=false;pmBoth();}
  },1500);

}

/* ------------------------------------------------ ways in, and links out of the manager's answers */
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-pjmgr]");
  if (b) { e.preventDefault(); e.stopImmediatePropagation(); window.stMapHideTip?.(); pmHost().mgOpen(b.dataset.pjmgr, b); return; }
  const a = e.target.closest('a[href^="#pga-open="]');
  if (a) { e.preventDefault(); e.stopImmediatePropagation(); const key = decodeURIComponent(a.getAttribute("href").slice(10)); const h = pmHost(); h.mgGo ? h.mgGo(key) : pjGo(key, "", ""); }
}, true);
window.addEventListener("pagehide", () => { clearInterval(PM.timer); PM.resize?.disconnect(); });
