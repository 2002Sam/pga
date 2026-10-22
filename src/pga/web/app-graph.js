/* PGA app · 世界树, its 关系网 mode: everything PGA remembers about you as one picture (pga/graph.py) — you, your personal model and the
   world model, your motivations, the lines of work and their conversations, knowledge, and the agents. Drag, zoom, click a
   node to see it and what it touches, double-click to open it. Draw a line between a tree and a piece of knowledge and the
   tree's agents read it from then on. Drawn on a canvas with d3's force layout (loaded the first time). */
const GT = {
  you: { zh: "你", en: "You", c: () => cssv("--text") },
  dim: { zh: "个人模型", en: "Personal model", c: () => "#7fcf9f", g: "model" },
  world: { zh: "世界模型", en: "World model", c: () => "#6cc4ff", g: "model" },
  aim: { zh: "抱负", en: "Motivation", c: () => cssv("--accent") || "#e2b46a", g: "aim" },
  line: { zh: "线", en: "Line", c: () => "#b48cff", g: "line" },
  conv: { zh: "对话", en: "Conversation", c: () => "#8fb4ff", g: "conv" },
  data: { zh: "数据集", en: "Dataset", c: () => "#5fd3a5", g: "know" }, skill: { zh: "技能", en: "Skill", c: () => "#f0c27b", g: "know" },
  doc: { zh: "文档", en: "Document", c: () => "#4fd1c5", g: "know" }, web: { zh: "网页", en: "Web page", c: () => "#63b3ed", g: "know" },
  note: { zh: "笔记", en: "Note", c: () => "#f6ad55", g: "know" },
  agent: { zh: "Agent", en: "Agent", c: () => "#f08aa8", g: "agent" },
};
const GGROUPS = [["model", L("你和两个模型", "You and the models")], ["aim", L("抱负", "Motivations")], ["line", L("线", "Lines")], ["conv", L("对话", "Conversations")], ["know", L("知识", "Knowledge")], ["agent", "Agent"]];
const EK = { is: L("是", "is"), sees: L("看到", "sees"), pursues: L("追求", "pursues"), grew: L("沉淀出", "grew"), references: L("引用", "references"), relates: L("相关", "relates"),
  derived_from: L("来自", "derived from"), depends_on: L("依赖", "depends on"), contradicts: L("矛盾", "contradicts"), "works on": L("在做", "works on"), in: L("属于", "in"), answered: L("回答过", "answered"), branched: L("分支", "branched") };
const cssv = (k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
const G = { mode: (() => { try { return localStorage.getItem("pga_world_mode") || "3d"; } catch { return "3d"; } })(), data: null, days: 90, off: new Set(), q: "", sel: null, hover: null, linkFrom: null, t: null, sim: null, nodes: [], edges: [] };

function loadD3() {
  if (window.d3) return Promise.resolve();
  return new Promise((ok, no) => { const s = document.createElement("script"); s.src = "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
}
async function showGraph() {
  document.title = L("世界树 · PGA", "World tree · PGA");
  $("#gbar").innerHTML = `<div class="gh"><b>${L("世界树", "World tree")}</b><span class="dimt" id="gcount">…</span></div>`;
  try { await loadD3(); } catch { $("#gbar").innerHTML += `<div class="empty">${L("没能载入画图用的库（d3）", "Could not load the drawing library (d3)")}</div>`; return; }
  initCanvas(); graphSurface();
  if (G.mode !== "net") await loadWorld(); else await loadGraph();
}
function graphSurface() {            /* the 3D sky draws in its own canvas; the levels and the network in the 2D one */
  const three = G.mode === "3d"; $("#g3d").hidden = !three; $("#gcv").style.display = three ? "none" : "";
  if (!three && typeof w3Pause === "function") w3Pause();
}
const modeSeg = () => `<span class="seg gmode"><button class="${G.mode === "3d" ? "on" : ""}" data-gmode="3d">${L("星空", "Sky")}</button><button class="${G.mode === "tree" ? "on" : ""}" data-gmode="tree">${L("层级", "Levels")}</button><button class="${G.mode === "net" ? "on" : ""}" data-gmode="net">${L("关系网", "Network")}</button></span>`;
async function loadGraph() {
  try { G.data = await api(`/v1/users/${S.uid}/memory-graph?days=${G.days}`); } catch (err) { toast(err.message); return; }
  const keep = new Map((G.nodes || []).map((n) => [n.id, n]));
  G.nodes = G.data.nodes.map((n) => { const o = keep.get(n.id); return o ? Object.assign(o, n) : { ...n }; });
  const ids = new Set(G.nodes.map((n) => n.id));
  G.edges = G.data.edges.filter((e) => ids.has(e.a) && ids.has(e.b)).map((e) => ({ ...e, source: e.a, target: e.b }));
  if (G.sel && !ids.has(G.sel)) G.sel = null;
  drawBar(); startSim(); drawSide();
}
function visible(n) { return !G.off.has((GT[n.type] || {}).g) || n.type === "you"; }
function drawBar() {
  const c = G.data?.counts || {};
  if (G.mode !== "net") { drawWorldBar(); return; }
  $("#gbar").innerHTML = `<div class="gh"><b>${L("世界树", "World tree")}</b>${modeSeg()}<span class="dimt" id="gcount">${L(`${G.nodes.length} 个节点 · ${G.edges.length} 条连线`, `${G.nodes.length} nodes · ${G.edges.length} links`)}</span></div>
    <div class="gchips">${GGROUPS.map(([g, n]) => { const k = Object.entries(GT).filter(([, x]) => x.g === g).reduce((a, [t]) => a + (c[t] || 0), 0);
      return `<button class="gchip ${G.off.has(g) ? "" : "on"}" data-gg="${g}"><i style="background:${Object.values(GT).find((x) => x.g === g).c()}"></i>${n}<em>${k}</em></button>`; }).join("")}</div>
    <div class="grow2"><span class="seg">${[[7, L("7 天", "7 d")], [30, L("30 天", "30 d")], [90, L("90 天", "90 d")], [365, L("一年", "1 y")]].map(([d, n]) => `<button class="${G.days === d ? "on" : ""}" data-gdays="${d}">${n}</button>`).join("")}</span>
      <input type="text" id="gq" placeholder="${L("找一个节点…", "Find a node…")}" value="${esc(G.q)}"></div>
    <div class="ghint dimt">${G.linkFrom ? `<b class="glink">${L("连线中：再点另一个抱负或知识", "Linking: click another motivation or piece of knowledge")}</b> <a href="#" data-gcancel="1">${L("取消", "Cancel")}</a>`
      : L("拖动、滚轮缩放 · 点一下看它连着什么，点对话直接进去 · 双击打开 · 发光的是最近一天新长出来的", "Drag, scroll to zoom · click to see what it touches, a conversation opens · double-click to open · glowing = new in the last day")}</div>`;
}
const R = (n) => 3 + n.size * 2.6;
function startSim() {
  const cv = $("#gcv"), W = cv.clientWidth, H = cv.clientHeight;
  const dpr = devicePixelRatio || 1; cv.width = W * dpr; cv.height = H * dpr;
  const LD = { is: 50, sees: 90, pursues: 150, grew: 60, references: 110, relates: 90, "works on": 170, in: 52, answered: 90, branched: 40 };
  const LS = { is: 0.9, sees: 0.6, pursues: 0.5, grew: 0.6, references: 0.3, relates: 0.3, "works on": 0.25, in: 0.8, answered: 0.015, branched: 0.5 };
  initCanvas();
  G.sim?.stop();
  G.sim = d3.forceSimulation(G.nodes)
    .force("link", d3.forceLink(G.edges).id((d) => d.id).distance((e) => LD[e.kind] || 80).strength((e) => LS[e.kind] ?? 0.3))
    .force("charge", d3.forceManyBody().strength((d) => -18 - d.size * d.size * 9).distanceMax(600))
    .force("collide", d3.forceCollide((d) => R(d) + 2))
    .force("x", d3.forceX(0).strength(0.02)).force("y", d3.forceY(0).strength(0.02))
    .alphaDecay(0.025).on("tick", drawGraph);
}
/* the canvas, shared by the two modes: zoom and pan, hover, click, double-click (each mode answers through these) */
function initCanvas() {
  if (G.t) return;
  const cv = $("#gcv"), W = cv.clientWidth, H = cv.clientHeight, dpr = devicePixelRatio || 1;
  cv.width = W * dpr; cv.height = H * dpr;
    G.t = d3.zoomIdentity.translate(W / 2, H / 2).scale(0.75);
    const sel = d3.select(cv);
    sel.call(d3.drag().container(cv).subject((e) => (G.mode === "net" ? pick(e.x, e.y) : null)).on("start", (e) => { if (!e.active) G.sim.alphaTarget(0.2).restart(); e.subject.fx = e.subject.x; e.subject.fy = e.subject.y; })
      .on("drag", (e) => { const [x, y] = G.t.invert([e.x, e.y]); e.subject.fx = x; e.subject.fy = y; })
      .on("end", (e) => { if (!e.active) G.sim.alphaTarget(0); e.subject.fx = null; e.subject.fy = null; }));
    G.zoom = d3.zoom().scaleExtent([0.1, 6]).filter((e) => e.type === "wheel" || !pickAny(...d3.pointer(e, cv))).on("zoom", (e) => { G.t = e.transform; drawGraph(); });
    sel.call(G.zoom).on("dblclick.zoom", null);
    sel.call(G.zoom.transform, G.t);
    cv.addEventListener("mousemove", (e) => { const n = pickAny(e.offsetX, e.offsetY); if (n?.id !== G.hover) { G.hover = n?.id || null; cv.style.cursor = n ? "pointer" : "grab"; drawGraph(); } tip(n, e); });
    cv.addEventListener("mouseleave", () => { G.hover = null; tip(null); drawGraph(); });
    cv.addEventListener("click", (e) => { const n = pickAny(e.offsetX, e.offsetY); if (G.mode === "tree") worldClick(n); else clickNode(n); });
    cv.addEventListener("dblclick", (e) => { const n = pickAny(e.offsetX, e.offsetY); if (!n) return; if (G.mode === "tree") worldDbl(n); else openNode(n); });
    new ResizeObserver(() => { if (S.view === "graph") { const w = cv.clientWidth, h = cv.clientHeight; cv.width = w * dpr; cv.height = h * dpr; drawGraph(); } }).observe(cv);
    (function pulse() { if (S.view === "graph" && G.mode === "net" && G.nodes.some((n) => n.new)) drawGraph(); requestAnimationFrame(() => setTimeout(pulse, 60)); })();
  }
const pickAny = (x, y) => (G.mode === "tree" ? worldPick(x, y) : pick(x, y));
function pick(px, py) {
  if (!G.t) return null;
  const [x, y] = G.t.invert([px, py]); let best = null, bd = Infinity;
  for (const n of G.nodes) { if (!visible(n)) continue; const d = Math.hypot(n.x - x, n.y - y); if (d < R(n) + 4 / G.t.k && d < bd) { bd = d; best = n; } }
  return best;
}
function neighbours(id) { const s = new Set([id]); for (const e of G.edges) { if (e.source.id === id) s.add(e.target.id); if (e.target.id === id) s.add(e.source.id); } return s; }
function drawGraph() {
  if (G.mode !== "net") { if (G.mode === "tree") drawWorld(); return; }
  const cv = $("#gcv"); if (!cv || !G.t) return;
  const ctx = cv.getContext("2d"), dpr = devicePixelRatio || 1, W = cv.width / dpr, H = cv.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
  ctx.save(); ctx.translate(G.t.x, G.t.y); ctx.scale(G.t.k, G.t.k);
  const focus = G.sel || G.hover, near = focus ? neighbours(focus) : null, q = G.q.trim().toLowerCase();
  const hit = q ? new Set(G.nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id)) : null;
  const line = cssv("--line-3") || "rgba(255,255,255,.2)", text = cssv("--text") || "#eee", dim = cssv("--dim") || "#888";
  ctx.lineCap = "round";
  for (const e of G.edges) {
    const a = e.source, b = e.target; if (!visible(a) || !visible(b)) continue;
    const on = near && near.has(a.id) && near.has(b.id) && (a.id === focus || b.id === focus);
    ctx.globalAlpha = near ? (on ? 0.9 : 0.05) : hit ? 0.06 : e.kind === "answered" ? 0.12 : 0.35;
    ctx.strokeStyle = e.bridge ? (cssv("--accent") || "#e2b46a") : on ? GT[(a.id === focus ? b : a).type]?.c() || line : line;
    ctx.lineWidth = (e.bridge ? 1.6 : on ? 1.4 : 0.8) / Math.sqrt(G.t.k);
    if (e.kind === "contradicts") ctx.setLineDash([4, 4]); else ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.setLineDash([]);
  const now = performance.now() / 1000;
  for (const n of G.nodes) {
    if (!visible(n)) continue;
    const r = R(n), c = (GT[n.type] || GT.conv).c(), faded = (near && !near.has(n.id)) || (hit && !hit.has(n.id));
    ctx.globalAlpha = faded ? 0.12 : 1;
    if (n.new && !faded) { const p = (now % 2) / 2; ctx.beginPath(); ctx.arc(n.x, n.y, r + 3 + p * 10, 0, 7); ctx.strokeStyle = c; ctx.globalAlpha = (1 - p) * 0.6; ctx.lineWidth = 1.5 / G.t.k; ctx.stroke(); ctx.globalAlpha = 1; }
    if (n.type === "you" || n.type === "aim") { ctx.shadowColor = c; ctx.shadowBlur = 18; }
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 7); ctx.fillStyle = c; ctx.fill(); ctx.shadowBlur = 0;
    if (n.id === G.sel || n.id === G.linkFrom) { ctx.lineWidth = 2.5 / G.t.k; ctx.strokeStyle = text; ctx.stroke(); }
    if (n.type === "aim" && n.status === "running") { ctx.beginPath(); ctx.arc(n.x, n.y, r + 4, 0, 7); ctx.lineWidth = 1.2 / G.t.k; ctx.strokeStyle = c; ctx.stroke(); }
  }
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (const n of G.nodes) {
    if (!visible(n)) continue;
    const big = n.type !== "conv", show = n.id === focus || (near ? near.has(n.id) && (big || G.t.k > 1.1 || near.size < 40) : hit ? hit.has(n.id) : big ? G.t.k > 0.55 || n.size >= 3 : G.t.k > 2.2);
    if (!show) continue;
    const fs = Math.max(9, (n.type === "you" || n.type === "aim" ? 13 : 11.5) / Math.sqrt(G.t.k));
    ctx.font = `${n.type === "aim" || n.type === "you" ? 600 : 500} ${fs}px ${cssv("--font") || "sans-serif"}`;
    ctx.globalAlpha = (near && !near.has(n.id)) ? 0.2 : 1;
    const s = n.label.length > 22 ? n.label.slice(0, 21) + "…" : n.label;
    ctx.lineWidth = 3 / G.t.k; ctx.strokeStyle = cssv("--bg") || "#000"; ctx.strokeText(s, n.x, n.y + R(n) + 3);
    ctx.fillStyle = n.id === focus ? text : near ? text : dim; ctx.fillText(s, n.x, n.y + R(n) + 3);
  }
  ctx.restore(); ctx.globalAlpha = 1;
}
function tip(n, e) {
  const t = $("#gtip"); if (!t) return;
  if (!n) { t.hidden = true; return; }
  t.hidden = false; t.innerHTML = `<b>${esc(n.label)}</b><span>${esc(L(GT[n.type]?.zh, GT[n.type]?.en) || n.type)}${n.sub ? " · " + esc(String(n.sub).slice(0, 80)) : ""}</span>`;
  const b = $("#vGraph").getBoundingClientRect(); t.style.left = Math.min(e.clientX - b.left + 14, b.width - 280) + "px"; t.style.top = e.clientY - b.top + 14 + "px";
}
async function clickNode(n) {
  if (G.linkFrom) {
    if (!n || n.id === G.linkFrom) { G.linkFrom = null; drawBar(); drawGraph(); return; }
    const a = G.nodes.find((x) => x.id === G.linkFrom);
    if (!n.link) { toast(L("只能连到抱负或知识上", "A line goes to a motivation or a piece of knowledge")); return; }
    try { const r = await api(`/v1/users/${S.uid}/memory-graph/link`, { body: { a: a.link, b: n.link } });
      toast(r.kind === "references" ? L("连好了：这棵树的 agent 以后会读到它", "Linked: this tree's agents read it from now on") : L("连好了：标为相关", "Linked as related")); }
    catch (err) { toast(err.message); }
    G.linkFrom = null; G.sel = n.id; await loadGraph(); return;
  }
  if (n?.type === "conv") { openNode(n); return; }          // a conversation: straight into it
  G.sel = n ? n.id : null; drawSide(); drawGraph();
}
function drawSide() {
  if (G.mode !== "net") { drawWorldSide(); return; }
  const box = $("#gside"), n = G.nodes.find((x) => x.id === G.sel);
  if (!n) { box.hidden = true; return; }
  box.hidden = false;
  const ns = G.edges.filter((e) => e.source.id === n.id || e.target.id === n.id).map((e) => ({ e, o: e.source.id === n.id ? e.target : e.source }));
  const by = {}; ns.forEach((x) => { (by[x.o.type] = by[x.o.type] || []).push(x); });
  box.innerHTML = `<div class="gs-h"><i style="background:${GT[n.type]?.c()}"></i><span>${esc(L(GT[n.type]?.zh, GT[n.type]?.en))}</span><span class="grow"></span><button class="sm ghost" data-gclose="1">×</button></div>
    <h3>${esc(n.label)}</h3>${n.sub ? `<div class="gs-sub md">${md(String(n.sub).slice(0, 600))}</div>` : n.private ? `<div class="dimt">${L("私密：内容不显示", "Private: content hidden")}</div>` : ""}
    <div class="gs-meta dimt">${[n.at ? L("最近 ", "last ") + ago(n.at) : "", n.turns ? L(`${n.turns} 轮`, `${n.turns} turns`) : "", L(`连着 ${ns.length} 个`, `${ns.length} links`)].filter(Boolean).join(" · ")}${n.url ? ` · <a href="${esc(n.url)}" target="_blank" rel="noopener">${L("原网页", "Source")}</a>` : ""}</div>
    <div class="gs-acts">${n.open ? `<button class="sm primary" data-gopen="1">${L("打开", "Open")}</button>` : ""}${n.link ? `<button class="sm" data-glink="1">${L("连一条线…", "Draw a line…")}</button>` : ""}</div>
    ${Object.entries(by).map(([t, xs]) => `<div class="gs-g"><div class="label">${esc(L(GT[t]?.zh, GT[t]?.en))} · ${xs.length}</div>${xs.slice(0, 40).map(({ e, o }) => `<div class="gs-n" data-gfocus="${esc(o.id)}"><i style="background:${GT[o.type]?.c()}"></i><span>${esc(o.label)}</span><em>${esc(EK[e.kind] || e.kind)}</em>${e.bridge ? `<button class="sm ghost" data-gunlink="${e.bridge}" title="${L("删掉这条线", "Remove this line")}">×</button>` : ""}</div>`).join("")}${xs.length > 40 ? `<div class="dimt">… ${xs.length - 40}</div>` : ""}</div>`).join("")}`;
}
async function openNode(n) {
  const o = n.open || {};
  if (o.tree) { show("tree", { aim: o.tree, node: o.node || null }); return; }
  if (o.doc) { await showDoc(o.doc); return; }
  if (o.note) { S.note = o.note; show("notes"); return; }
  if (o.chat || o.import || o.line) {
    show("chats"); await loadTimeline();
    if (o.chat || o.import) { const key = n.id.slice(5), x = (S.tl?.sessions || []).find((y) => y.item === key); if (x) { openSession(x.id); return; } }
    if (o.line) pickLine(o.line);
  }
}
function focusOn(id) {
  const n = G.nodes.find((x) => x.id === id); if (!n) return;
  G.sel = id; const cv = $("#gcv"), k = Math.max(G.t.k, 1.2);
  d3.select(cv).transition().duration(500).call(G.zoom.transform, d3.zoomIdentity.translate(cv.clientWidth / 2 - n.x * k, cv.clientHeight / 2 - n.y * k).scale(k));
  drawSide(); drawGraph();
}
document.addEventListener("click", async (e) => {
  if (!e.target.closest("#vGraph")) return;
  const t = e.target.closest("[data-gg], [data-gdays], [data-gclose], [data-gopen], [data-glink], [data-gfocus], [data-gunlink], [data-gcancel], [data-gmode]"); if (!t) return;
  e.preventDefault();
  if (t.dataset.gmode) { if (G.mode === t.dataset.gmode) return; G.mode = t.dataset.gmode; G.sel = null; G.hover = null; G.sim?.stop();
    try { localStorage.setItem("pga_world_mode", G.mode); } catch {} graphSurface();
    if (G.mode !== "net") await loadWorld(); else await loadGraph(); return; }
  if (t.dataset.gg) { const g = t.dataset.gg; G.off.has(g) ? G.off.delete(g) : G.off.add(g); drawBar(); drawGraph(); }
  else if (t.dataset.gdays) { G.days = Number(t.dataset.gdays); await loadGraph(); }
  else if (t.dataset.gclose) { G.sel = null; drawSide(); drawGraph(); }
  else if (t.dataset.gopen) { const n = G.nodes.find((x) => x.id === G.sel); if (n) openNode(n); }
  else if (t.dataset.glink) { G.linkFrom = G.sel; drawBar(); drawGraph(); }
  else if (t.dataset.gcancel) { G.linkFrom = null; drawBar(); drawGraph(); }
  else if (t.dataset.gunlink) { if (!confirm(L("删掉这条线？", "Remove this line?"))) return; try { await api(`/v1/bridges/${t.dataset.gunlink}`, { method: "DELETE" }); await loadGraph(); } catch (err) { toast(err.message); } }
  else if (t.dataset.gfocus) focusOn(t.dataset.gfocus);
});
document.addEventListener("input", (e) => { if (e.target.id === "gq") { G.q = e.target.value; drawGraph(); } });
document.addEventListener("keydown", (e) => {
  if (e.target.id === "gq" && e.key === "Enter" && G.mode === "tree") { const q = G.q.trim().toLowerCase(), n = W.nodes.find((x) => x.title.toLowerCase().includes(q));
    if (n) { G.sel = n.id; const cv = $("#gcv"), k = Math.max(G.t.k, 1.4); d3.select(cv).transition().duration(500).call(G.zoom.transform, d3.zoomIdentity.translate(cv.clientWidth / 2 - n.x * k, cv.clientHeight / 2 - n.y * k).scale(k)); drawWorldSide(); } return; }
  if (e.target.id === "gq" && e.key === "Enter") { const q = G.q.trim().toLowerCase(), n = G.nodes.find((x) => visible(x) && x.label.toLowerCase().includes(q)); if (n) focusOn(n.id); }
  if (S.view === "graph" && e.key === "Escape") { G.linkFrom = null; G.sel = null; drawBar(); drawSide(); drawGraph(); }
});
window.addEventListener("pga:look", () => { if (S.view === "graph") drawGraph(); });
window.addEventListener("pga:theme", () => { if (S.view === "graph") drawGraph(); });
