/* PGA app · the stage. Conversation windows in a row, each with the knowledge wired into it standing in a column at
   its left, everything inside the app's own window.

   A window has three inputs on its left edge, like the pins of a blueprint node:
   - top: other conversations (and world-tree topics) it refers to;
   - middle: data (world knowledge, self knowledge, documents, files, notes);
   - bottom: skills.
   The cards wired into a window stand in its column, each in the band of its input, and its agents read them with every
   question (PUT /chat-context). Drag a card next to another window to wire it there, onto the shelf at the far left to
   unwire it. Right-click anywhere to add a note, skill, document, file, conversation, topic or window.

   Nothing leaves the screen. When the row is too wide, the columns of the other windows, then the other windows
   themselves, fold into narrow bars at the sides, stacked; click one to bring it back. Windows always stand the full
   height; their width changes only when you drag their edges. Drag a window by its title bar to move it along the row:
   the others slide aside. */

const ST = { nodes: [], focus: null, drag: null };
window.ST = ST;                                     // a window's page reaches its stage through this (返回, 全图)
const ST_GAP = 18, ST_CW = 190, ST_CH = 78, ST_WW = 660, ST_TAB = 150, ST_TH = 30, ST_PADX = 12, ST_LW = 224;
const ST_MINI = { w: 300, h: 210 };                 // a window made small (–): a little page you can pull to any size
const ST_T = {
  world: ["世界知识", "World knowledge", "#6fa8ff"], self: ["自我知识", "Self knowledge", "#e9b35f"], note: ["笔记", "Note", "#a1a1aa"],
  skill: ["技能", "Skill", "#e9b35f"], doc: ["资料", "Document", "#7fcf9f"], file: ["文件", "File", "#5fc9c0"], conv: ["对话", "Conversation", "#8fb4ff"],
  topic: ["世界树主题", "Topic", "#d6a75c"], win: ["对话窗口", "Window", "#8fb4ff"] };
const ST_PIN = (n) => (["conv", "topic"].includes(n.type) ? 0 : n.type === "skill" ? 2 : 1);      // which input: conversations, data, skills
const ST_PINS = [["对话引用", "Conversations"], ["数据引用", "Data"], ["技能引用", "Skills"]];
const ST_OUTS = [["拉线：把这段对话问过的交给另一个窗口", "Pull a wire: what was asked here, into another window"], ["拉线：把这段对话读过、改过的交给另一个窗口", "Pull a wire: what this conversation read and changed"], ["拉线：把这段对话用过的技能交给另一个窗口", "Pull a wire: the skills this conversation used"]];
const stTitle = (key) => (key ? recentItems().find((x) => x.item === key)?.title || S.chats?.find((c) => c.key === key)?.title || key : L("新对话", "New chat"));
const stId = () => Math.random().toString(36).slice(2, 9);
const stSL = () => $("#starena")?.scrollLeft || 0;             // the stage scrolls sideways: arena coordinates include it
const stArena = () => { const a = $("#starena"); return a ? { w: a.clientWidth, h: a.clientHeight } : { w: 1000, h: 700 }; };
const stWins = () => ST.nodes.filter((n) => n.type === "win").sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
function stSave() { try { localStorage.setItem("pga_st4", JSON.stringify({ v: 5, nodes: ST.nodes.map(({ max, sent, ...n }) => n), ws: ST.ws })); } catch {} }

/* ------------------------------------------------ the page */
function showStage() {
  document.title = "PGA";
  const v = $("#vStage");
  if (!v.dataset.ready) {
    v.dataset.ready = "1";
    v.innerHTML = `<div class="stground"></div><div class="stbar card" id="stbar"></div>
      <div class="starena" id="starena"><svg class="stwires" id="stwires"></svg><div id="stnodes"></div><div id="stbars"></div></div>`;
    let saved = null; try { saved = JSON.parse(localStorage.getItem("pga_st4") || "null"); } catch {}
    if (saved?.nodes?.length) ST.nodes = saved.nodes; else stDefault();
    ST.ws = saved?.ws || {};
    if (saved && saved.v !== 5) for (const w of ST.nodes) if (w.type === "win") { delete w.bw; delete w.pre; }   // narrowed by the old fit-the-screen rule: natural again
    if (!ST.nodes.some((n) => n.pad) && store.get("pga_pad_off") !== "1") ST.nodes.push(stPadNode(-1));       // the notepad is a page here
    ST.focus = stWins()[0]?.id || null;
    stBind(); new ResizeObserver(() => stRender()).observe($("#starena"));
  }
  stBar(); stRender(); stContexts();
}
function stDefault() {                            // one window, the latest conversation, with world and self knowledge wired in
  recentItems().slice(0, 1).forEach((r, i) => ST.nodes.push({ id: stId(), type: "win", key: r.item, ord: i }));
  const first = ST.nodes[0]?.id || null;
  ST.nodes.push({ id: "world", type: "world", win: first }, { id: "self", type: "self", win: first });
}

/* ------------------------------------------------ the notepad (常驻笔记) is a page of the stage, not a sidebar: a window
   whose content is the notepad itself (app-pad.js), moved in and out of it */
const stPadNode = (ord) => ({ id: "pad", type: "win", pad: true, ord, bw: 320 });
function stPadIn(e) {
  const p = $("#pad"), box = e.querySelector(".stpadbox"); if (!p || !box) return;
  box.appendChild(p); if (typeof PAD === "object") { PAD.open = true; padLayout?.(); }
}
function stPadOut() {                               // the page closed: the notepad waits, unseen, until it is a page again
  let hold = $("#padhold"); if (!hold) { document.body.insertAdjacentHTML("beforeend", `<div id="padhold" hidden></div>`); hold = $("#padhold"); }
  const p = $("#pad"); if (p) hold.appendChild(p);
}

/* ------------------------------------------------ workspaces: pages at work on one problem. They stand side by side
   (move one and the rest come with it), and wear one colour — on their heads, in a band above them and on the map */
const ST_WSC = ["#e9845f", "#5fc98f", "#b48cf0", "#e9c35f", "#5fb8e9", "#e96fa8"];
const stWs = (n) => (n?.ws && ST.ws?.[n.ws]) || null;
function stWsGather(anchor) {                       // each workspace's pages next to each other, round the one you moved (or the first)
  const order = stWins(), groups = new Map();
  for (const w of order) if (stWs(w)) { if (!groups.has(w.ws)) groups.set(w.ws, []); groups.get(w.ws).push(w); }
  for (const [, g] of groups) { if (g.length < 2) continue;
    const pivot = g.find((w) => w.id === anchor) || g[0], pi = g.indexOf(pivot);
    for (const w of g) if (w !== pivot) order.splice(order.indexOf(w), 1);
    const at = order.indexOf(pivot); order.splice(at, 1, ...g.slice(0, pi), pivot, ...g.slice(pi + 1)); }
  order.forEach((w, k) => { w.ord = k; });
}
function stWsJoin(n, id) {                          // id: a workspace; "new": a new one; null: out of any
  if (id === "new") { const used = new Set(Object.values(ST.ws).map((w) => w.c)), k = Object.keys(ST.ws).length;
    id = stId(); ST.ws[id] = { name: L(`工作区 ${k + 1}`, `Workspace ${k + 1}`), c: ST_WSC.find((c) => !used.has(c)) || ST_WSC[k % ST_WSC.length] }; }
  if (id) n.ws = id; else delete n.ws;
  const live = new Set(stWins().map((w) => w.ws).filter(Boolean)); for (const k of Object.keys(ST.ws)) if (!live.has(k)) delete ST.ws[k];   // nobody left in it: gone
  if (id) stWsGather(n.id); ST.shift = null; stRender(); stSave(); if (id) stShow(n.id);
}
function stWsMenu(btn, n) {                         // the dot on a page's head: which workspace it is in
  document.querySelector(".stmenu")?.remove();
  const b = btn.getBoundingClientRect(), m = document.createElement("div"); m.className = "cvpal cvmenu stmenu card"; m.dataset.nid = n.id;
  m.style.left = Math.min(b.left, innerWidth - 260) + "px"; m.style.top = b.bottom + 4 + "px";
  const count = (id) => stWins().filter((w) => w.ws === id).length;
  m.innerHTML = `<div class="stmh">${L("工作区：一起处理同一件事的页面，排在一起、同一个颜色", "Workspace: pages on one problem, side by side, one colour")}</div>`
    + Object.entries(ST.ws).map(([id, w]) => `<button data-stws="${id}"><i class="stwsdot" style="--wc:${w.c}"></i>${esc(w.name)}<em>${n.ws === id ? "✓" : L(`${count(id)} 页`, `${count(id)} pages`)}</em></button>`).join("")
    + `<button data-stws="new">＋ ${L("新建工作区", "New workspace")}</button>`
    + (stWs(n) ? `<button data-stws="rename">✎ ${L("重命名这个工作区", "Rename this workspace")}</button><button data-stws="out">↩ ${L("移出工作区", "Leave the workspace")}</button>` : "");
  document.body.appendChild(m);
}
function stWsLook(e, n) {                           // a page's head in its workspace's colour
  const w = stWs(n), b = e.querySelector('[data-stw="ws"]');
  if (w) e.style.setProperty("--wc", w.c); else e.style.removeProperty("--wc"); e.classList.toggle("inws", !!w);
  if (b) b.title = w ? L(`工作区「${w.name}」· 点一下换或移出`, `Workspace “${w.name}” · click to change or leave`) : L("放进一个工作区", "Put it in a workspace");
}

/* ------------------------------------------------ the layout: a row that always fits the screen */
const ST_MINW = 300, ST_FIT = 560;                  // the least a page gets from an edge or a squeeze; the least it gives to fit the screen
const stDock = (n) => ["world", "self"].includes(n.type) && n.fx == null;    // world and self knowledge live in the 所有对话 panel
function stPanel() {                                // 所有对话: a panel of its own — docked at the left of the row, or wherever you dragged it
  if (!ST.lp) { try { ST.lp = JSON.parse(localStorage.getItem("pga_st_lp") || "null"); } catch {} ST.lp = ST.lp || {}; ST.listOpen = !!ST.lp.open; }
  return ST.lp;
}
function stLayout() {
  const A = stArena(), all = stWins(), ids = new Set(all.map((w) => w.id)), wins = all.filter((w) => !w.mini);   // small pages float, outside the row
  ST.nodes = ST.nodes.filter((n) => !n.rail || ids.has(n.win));                                   // a wire from the history column goes with its window
  for (const n of ST.nodes) if (n.type !== "win" && n.win && !ids.has(n.win)) n.win = null;       // its window is gone: unwired
  for (const w of wins) if (w.links) w.links = w.links.filter((l) => ids.has(l.from) && l.from !== w.id);
  const shelf = ST.nodes.filter((n) => n.type !== "win" && !n.win && !n.rail && !stDock(n));
  const units = [];                                 // 所有对话 is a sidebar outside the stage: the stage itself moves over for it
  if (shelf.length) units.push({ kind: "shelf", nodes: shelf, w: ST_CW, open: true });
  for (const w of wins) { const col = ST.nodes.filter((n) => n.win === w.id && !n.rail && !stDock(n)); units.push({ kind: "col", win: w, nodes: col, w: ST_CW, open: true, hide: !col.length }); units.push({ kind: "win", win: w, w: w.bw || ST_MINW, open: true, flex: !w.bw }); }
  // Nothing is squeezed or folded to fit the screen: a page keeps its width, and what does not fit runs on to the right —
  // the stage scrolls sideways. A page you did not size starts at ST_WW (never wider than the screen); while the row is
  // a little too wide those pages give, down to ST_FIT, and while there is room to spare they share it.
  const colOpen = (w) => units.some((c) => c.kind === "col" && c.win === w && !c.hide && c.open);
  const preOf = (u) => (u.kind === "col" || (u.kind === "win" && !colOpen(u.win)) ? u.win.pre || 0 : 0);   // a gap before a page goes before its column
  const width = () => { let t = -ST_GAP, run = false; for (const u of units) { if (u.hide) continue; if (u.open) { t += preOf(u) + u.w + ST_GAP; run = false; } else if (!run) { t += ST_TAB + ST_GAP; run = true; } } return t; };
  const room = Math.max(1, A.w - 2 * ST_PADX);
  for (const u of units) if (u.kind === "win") u.w = Math.min(u.w, room);
  const flex = units.filter((u) => u.kind === "win" && u.open && u.flex);
  for (const u of flex) u.w = Math.min(room, Math.max(ST_MINW, Math.min(ST_WW, room)));
  if (flex.length && width() > room) { const cut = (width() - room) / flex.length; for (const u of flex) u.w = Math.max(Math.min(u.w, ST_FIT), u.w - cut); }
  if (flex.length && width() < room) { const add = (room - width()) / flex.length; for (const u of flex) u.w += add; }
  const free = Math.max(0, room - width()), off = ST.shift == null ? free / 2 : Math.max(0, Math.min(free, ST.shift));   // centred, unless an edge you pulled holds it
  let x = ST_PADX + off;
  let run = null;
  for (const u of units) { if (u.hide) continue; if (u.open) { x += preOf(u); u.x = x; x += u.w + ST_GAP; run = null; continue; }
    if (!run) { run = { x, tabs: [] }; x += ST_TAB + ST_GAP; } u.x = run.x; u.run = run; }
  ST.span = ST_PADX * 2 + off + width();             // how far the row reaches: the stage scrolls to it
  return { units, A, off };
}

/* ------------------------------------------------ drawing */
function stWinHtml(n) {
  if (n.pad) return `<div class="stwin stpadwin">${["e", "w", "n", "s", "ne", "nw", "se", "sw"].map((d) => `<i class="rz rz-${d}" data-rz="${d}"></i>`).join("")}
    <div class="stwh" data-stfocus="${n.id}"><b class="stwt">${L("笔记", "Notepad")}</b><span class="grow"></span>
      <button class="stb stwsb" data-stw="ws">●</button><button class="stb" data-stw="min" title="${L("缩成小页面", "Make it a small page")}">–</button><button class="stb" data-stw="max" title="${L("最大化（Esc 还原）", "Maximise (Esc restores)")}">▢</button><button class="stb" data-stw="close" title="${L("关掉笔记页（右键空白处可以再加回来）", "Close the notepad page (right-click the stage to add it again)")}">×</button></div>
    <div class="stpadbox"></div></div>`;
  return `<div class="stwin">${["e", "w", "n", "s", "ne", "nw", "se", "sw"].map((d) => `<i class="rz rz-${d}" data-rz="${d}" title="${L("拖动改大小，双击还原", "Drag to resize, double-click to reset")}"></i>`).join("")}
    <div class="stwh" data-stfocus="${n.id}"><b class="stwt">${esc(stTitle(n.key))}</b><em class="stctxn" data-stctxn="${n.id}"></em><span class="grow"></span>
      <button class="stb stwsb" data-stw="ws">●</button><button class="stb ${n.side === false ? "" : "on"}" data-stw="side" title="${L("右侧栏：环境、上下文、世界树", "Side panel: environment, context, world tree")}">◧</button><button class="stb" data-stw="min" title="${L("缩成小页面", "Make it a small page")}">–</button><button class="stb" data-stw="max" title="${L("最大化（Esc 还原）", "Maximise (Esc restores)")}">▢</button><button class="stb" data-stw="close" title="${L("关掉这个窗口（对话还在）", "Close the window (the conversation stays)")}">×</button></div>
    <iframe title="conversation"></iframe></div>${ST_PINS.map((p, i) => `<i class="stin" style="top:${(i * 2 + 1) / 6 * 100}%" data-pin="${i}" title="${L("拉一根线到别的窗口或卡片", "Pull a wire to another window or card")}"></i><i class="stout" style="top:${(i * 2 + 1) / 6 * 100}%" data-pin="${i}" title="${L(...ST_OUTS[i])}"></i>`).join("")}`;
}
function stCardHtml(n) {
  const t = ST_T[n.type], K = S.forest?.knowledge || [], P = S.forest?.personal;
  let title = n.title || "", sub = n.sub || "", extra = "";
  if (n.type === "world") { const k = K.find((x) => x.system === "world"); title = L(...t.slice(0, 2)); sub = k?.gist || k?.brief || L("还没有整理", "not compiled yet"); extra = k ? `data-doc="${k.id}"` : ""; }
  if (n.type === "self") { const k = K.find((x) => x.system === "user"); title = L(...t.slice(0, 2)); sub = P ? ["goals", "background", "abilities"].map((d) => P[d]?.summary).filter(Boolean)[0] || "" : L("还没有整理", "not compiled yet"); extra = k ? `data-doc="${k.id}"` : ""; }
  if (n.type === "conv") title = n.title || stTitle(n.key);
  const body = n.type === "note" ? `<textarea class="stnote" data-stnote="${n.id}" placeholder="${L("写下要给 agent 的话…", "Something for the agents to read…")}">${esc(n.text || "")}</textarea>`
    : `<b ${extra}>${esc(title.slice(0, 60))}</b><span>${esc(String(sub).slice(0, 90))}</span>`;
  return `<div class="stcard st-${n.type}" style="--tc:${t[2]}"><i class="stk">${L(...t.slice(0, 2))}</i>${["world", "self"].includes(n.type) ? "" : `<button class="stx" data-stdel="${n.id}" title="${L("拿掉", "Remove")}">×</button>`}${body}</div>
    <i class="stpin r" title="${L("拉线连到一个窗口", "Pull a wire into a window")}"></i>`;
}
function stGrow(w) {                               // the stage reaches as far as the row (further while a page is carried past its end)
  const x = Math.max(w || 0, ST.span || 0);
  for (const id of ["stnodes", "stbars", "stwires"]) { const e = document.getElementById(id); if (e) e.style.width = Math.ceil(x) + "px"; }
}
function stRender() {
  const box = $("#stnodes"), bars = $("#stbars"); if (!box) return;
  const { units, A } = stLayout(), keep = new Set(ST.nodes.map((n) => n.id)), held = ST.drag?.n;
  box.querySelectorAll(".stnode").forEach((el) => { if (!keep.has(el.dataset.nid)) el.remove(); });
  const el = (n) => { let e = box.querySelector(`.stnode[data-nid="${n.id}"]`);
    if (!e) { e = document.createElement("div"); e.className = `stnode t-${n.type}`; e.dataset.nid = n.id; e.innerHTML = n.type === "win" ? stWinHtml(n) : stCardHtml(n); box.appendChild(e); if (n.type === "win") { if (n.pad) stPadIn(e); else stFrame(n, e); } }
    else if (n.type !== "win" && n.type !== "note" && e.dataset.sig !== (n.title || "") + (S.forest ? 1 : 0)) e.innerHTML = stCardHtml(n);
    e.dataset.sig = (n.title || "") + (S.forest ? 1 : 0); return e; };
  const rid = (ST.rid = (ST.rid || 0) + 1);
  const place = (e, x, y, w, h, show = true) => { e.dataset.r = rid; if (e === held?.el) return; e.style.left = x + "px"; e.style.top = y + "px"; e.style.width = w + "px"; e.style.height = h + "px"; e.hidden = !show; };
  let barHtml = ""; const pos = new Map(), runs = new Set();
  for (const u of units) {
    if (u.kind === "win") {
      const e = el(u.win); u.win.el = e;
      if (u.hide || !u.open) { place(e, -9999, 0, u.w, A.h, false); if (!u.hide) { const t = stTitle(u.win.key);
        u.run.tabs.push({ win: u.win.id, html: (y) => `<div class="sttab win" style="left:${u.x}px;top:${y}px;width:${ST_TAB}px;height:${ST_TH}px" data-stunfold="${u.win.id}" title="${esc(t)}"><span>▢ ${esc(t.slice(0, 40))}</span></div>` }); runs.add(u.run); } continue; }
      const wy = 8, mh = A.h - 16; stMiniLook(e, false);
      place(e, u.x, wy, u.w, mh); e.classList.toggle("focus", u.win.id === ST.focus); stWsLook(e, u.win);
      e.classList.toggle("hascol", units.some((c) => c.kind === "col" && c.win === u.win && !c.hide && c.open));      // its column covers the input labels
      pos.set(u.win.id, { x: u.x, y: wy, w: u.w, h: mh }); continue;
    }
    const zones = [[], [], []]; u.nodes.forEach((n) => zones[u.kind === "shelf" ? 1 : ST_PIN(n)].push(n));
    if (u.hide || !u.open) {                      // folded: each card is a small horizontal tab, still wired in
      for (const n of u.nodes) { const e = el(n); if (u.hide) { place(e, -9999, 0, ST_CW, ST_CH, false); continue; } e.classList.add("tab"); e.classList.toggle("shelved", u.kind === "shelf"); u.run.tabs.push({ n, e, win: u.win?.id }); }
      if (!u.hide) runs.add(u.run); continue;
    }
    const zh = (A.h - 16) / 3;                    // three bands, each beside its input
    const ax = u.kind === "col" ? units.find((x) => x.kind === "win" && x.win === u.win)?.x ?? u.x : u.x;   // what a moved card keeps its place against
    zones.forEach((zn, zi) => {
      const ch = Math.max(46, Math.min(ST_CH, (zh - 10) / Math.max(1, zn.length) - 8)), tot = zn.length * (ch + 8) - 8;
      let y = 8 + zi * zh + Math.max(4, (zh - tot) / 2);
      for (const n of zn) { const e = el(n); e.classList.remove("tab", "docked"); e.classList.toggle("short", ch < 66); e.classList.toggle("shelved", u.kind === "shelf");
        const yy = n.fy == null ? y : Math.max(4, Math.min(A.h - ch - 4, n.fy * A.h));    // where you put it, if you moved it
        const xx = n.fx == null ? u.x : Math.max(0, Math.min(A.w - ST_CW, ax + n.fx));
        e.classList.toggle("moved", n.fx != null);
        place(e, xx, yy, ST_CW, ch); pos.set(n.id, { x: xx, y: yy, w: ST_CW, h: ch, zone: zi, win: u.win?.id }); y += ch + 8; }
    });
    if (u.kind === "shelf") barHtml += `<div class="stshelf" style="left:${u.x - 4}px;width:${ST_CW + 8}px;height:${A.h - 8}px"><em>${L("未连接", "Unwired")}</em></div>`;
  }
  stSideList();                                    // 所有对话, with world and self knowledge in its lower part
  let k = 0;                                       // small pages: where you left them, else stacked in the lower right corner
  for (const w of stWins().filter((x) => x.mini)) {
    const e = el(w); w.el = e; stMiniLook(e, true);
    const mw = Math.max(200, Math.min(A.w - 16, w.mw || ST_MINI.w)), mh = Math.max(140, Math.min(A.h - 16, w.mh || ST_MINI.h));
    const x = w.fx == null ? A.w - mw - 16 - 28 * k : w.fx * A.w, y = w.fy == null ? A.h - mh - 16 - 28 * k : w.fy * A.h; if (w.fx == null) k++;
    const cx = Math.max(0, Math.min(A.w - mw, x)), cy = Math.max(0, Math.min(A.h - mh, y));
    e.style.setProperty("--sc", Math.max(0.42, Math.min(1, mw / 640)).toFixed(3));
    place(e, cx, cy, mw, mh); e.classList.toggle("focus", w.id === ST.focus); stWsLook(e, w); pos.set(w.id, { x: cx, y: cy, w: mw, h: mh });
  }
  for (const r of runs) {                         // a stack of tabs, in the middle of the height
    const tot = r.tabs.length * (ST_TH + 6) - 6; let y = 8 + Math.max(0, (A.h - 16 - tot) / 2);
    for (const t of r.tabs) {
      if (t.n) { place(t.e, r.x, y, ST_TAB, ST_TH); pos.set(t.n.id, { x: r.x, y, w: ST_TAB, h: ST_TH, zone: ST_PIN(t.n), win: t.win }); }
      else { barHtml += t.html(y); if (t.win) pos.set(t.win, { x: r.x, y, w: ST_TAB, h: ST_TH, tab: true }); }
      y += ST_TH + 6;
    }
  }
  for (const [id, w] of Object.entries(ST.ws || {})) {   // a band above a workspace's pages in the row, in its colour
    const ps = stWins().filter((o) => o.ws === id && !o.mini).map((o) => pos.get(o.id)).filter((p) => p && !p.tab); if (!ps.length) continue;
    const l = Math.min(...ps.map((p) => p.x)), r = Math.max(...ps.map((p) => p.x + p.w));
    barHtml += `<div class="stwsband" style="left:${l}px;width:${r - l}px;--wc:${w.c}" title="${esc(w.name)}"></div>`; }
  bars.innerHTML = barHtml;
  box.querySelectorAll(".stnode").forEach((e) => { if (e.dataset.r !== String(rid) && e !== held?.el) e.hidden = true; });   // cards of a small page wait unseen
  ST.pos = pos; ST.units = units; requestAnimationFrame(stMap); if (!ST.drag) stGrow();
  if (ST.drag?.groups && ST.drag.moved && ST.drag.lx != null) stDragTo(ST.drag.lx, ST.drag.ly);   // redrawn mid-drag: the squeeze stays
  else stWires();
}
const stPinY = (w, i) => (w.tab ? w.y + w.h / 2 : w.y + w.h * (i * 2 + 1) / 6);
const stCurve = (x0, y0, x1, y1) => { const k = Math.max(40, Math.abs(x1 - x0) / 2); return `M ${x0} ${y0} C ${x0 + k} ${y0}, ${x1 - k} ${y1}, ${x1} ${y1}`; };
function stWires() {                              // each card into the input of its band; windows into each other, right pin to left pin
  const svg = $("#stwires"); if (!svg || !ST.pos) return; let h = "";
  for (const n of ST.nodes) {
    if (n.type === "win" || !n.win) continue; const p = ST.pos.get(n.id), w = ST.pos.get(n.win); if (!p || !w || ST.drag?.n === n) continue;
    const right = p.x + p.w / 2 > w.x + 24, x0 = right ? p.x : p.x + p.w, y0 = p.y + p.h / 2;
    h += `<path class="stwire z${p.zone}" d="${right ? `M ${x0} ${y0} C ${x0 - 60} ${y0}, ${w.x - 60} ${stPinY(w, p.zone)}, ${w.x} ${stPinY(w, p.zone)}` : stCurve(x0, y0, w.x, stPinY(w, p.zone))}"/><circle class="stball z${p.zone}" cx="${x0}" cy="${y0}" r="5"/>`;
  }
  for (const b of stWins()) for (const l of b.links || []) {
    const a = ST.pos.get(l.from), t = ST.pos.get(b.id); if (!a || !t) continue;
    const d = stCurve(a.x + a.w, stPinY(a, l.pin), t.x, stPinY(t, l.pin));
    h += `<path class="stwire link z${l.pin}" d="${d}"/><path class="sthit" d="${d}" data-unlink="${b.id}|${l.from}|${l.pin}"><title>${L("点一下断开这根线", "Click to cut this wire")}</title></path>`;
  }
  const g = ST.wire; if (g) h += `<path class="stwire tmp z${g.pin}" d="${g.back ? stCurve(g.x, g.y, g.x0, g.y0) : stCurve(g.x0, g.y0, g.x, g.y)}"/><circle class="stball z${g.pin}" cx="${g.x}" cy="${g.y}" r="5"/>`;
  svg.innerHTML = h;
  stOver();
}
function stFrame(n, el) {
  const q = new URLSearchParams({ view: "chats", embed: "1" });
  if (n.key) { if (S.allChats?.some((c) => c.key === n.key) || n.key.startsWith("chat:")) q.set("c", n.key); else q.set("item", n.key); }
  if (AS_UID) q.set("as", AS_UID); if (Q.get("lang")) q.set("lang", Q.get("lang"));
  const f = el.querySelector("iframe"); f.src = "/?" + q;
  f.addEventListener("load", () => { try { stHold(f, n); stSide(n); } catch {} });
}
function stHold(f, n) {                          // inside a conversation: press and hold (~0.25 s, still), then move the window
  const cw = f.contentWindow, doc = cw.document; let h = null, dragged = false;
  doc.addEventListener("pointerdown", (e) => {
    dragged = false; stFocus(n.id);
    if (e.button !== 0 || e.target.closest("input, textarea, select, button, a, [contenteditable], #ccomp")) return;   // the composer moves on its own
    h = { sx: e.screenX, sy: e.screenY, on: false, t: setTimeout(() => { if (!h) return; h.on = true; doc.documentElement.classList.add("stgrab");
      try { doc.documentElement.setPointerCapture(e.pointerId); } catch {} stGrab(n, h.sx, h.sy, e.clientX); cw.getSelection()?.removeAllRanges(); }, 250) };
  }, true);
  doc.addEventListener("pointermove", (e) => {
    if (!h) return;
    if (!h.on) { if (Math.hypot(e.screenX - h.sx, e.screenY - h.sy) > 5) { clearTimeout(h.t); h = null; } return; }
    e.preventDefault(); cw.getSelection()?.removeAllRanges(); stDragSoon(e.screenX, e.screenY);
  }, true);
  const end = () => { if (!h) return; clearTimeout(h.t); const was = h.on; dragged = was; h = null; doc.documentElement.classList.remove("stgrab"); if (was) { stDragFlush(); stDrop(); } };
  doc.addEventListener("pointerup", end, true); doc.addEventListener("pointercancel", end, true);
  doc.addEventListener("click", () => { if (!dragged && !ST.drag && !ST.pan && !cw.getSelection()?.toString()) stShow(n.id); }, true);
  doc.addEventListener("selectstart", (e) => { if (h?.on) e.preventDefault(); }, true);
  const st = doc.createElement("style"); st.textContent = "html.stgrab, html.stgrab * { cursor: grabbing !important; user-select: none !important; }"; doc.head.appendChild(st);
}
function stDragSoon(sx, sy) {                      // one move per frame, however fast the pointer reports
  ST.nx = [sx, sy]; if (!ST.raf) ST.raf = requestAnimationFrame(() => { ST.raf = 0; if (ST.nx) stDragTo(...ST.nx); });
}
function stDragFlush() { if (ST.raf) { cancelAnimationFrame(ST.raf); ST.raf = 0; if (ST.nx) stDragTo(...ST.nx); } ST.nx = null; }


/* ------------------------------------------------ 所有对话 are the sidebar: on the stage it is a tight column of every past
   conversation, newest first. A click opens one as a window; pulling from it draws a wire into the window you drop it on
   (anywhere else on the stage: the one you are on) — it becomes that window's conversation reference. Wired ones show
   their wire from the column to the window; the dot at a row's end toggles its wire into the window you are on. */
/* It stands the full height at the left of the app; while it is open the stage starts after it (--chats-w), so no page
   is ever under it. ☰ at the top left opens it, ‹ in its head closes it, its right edge sets its width. */
function stSideList() {
  const v = $("#vStage"), lp = stPanel(), open = !!ST.listOpen, w = Math.max(180, Math.min(520, lp.w || 240));
  let box = $("#stlist");
  if (!box) {
    v.insertAdjacentHTML("beforeend", `<aside class="stlist side" id="stlist"><i class="lrz lrz-e" data-lrz="e" title="${L("拖动改宽度", "Drag to resize")}"></i>
      <div class="stlh"><b>${L("所有对话", "All conversations")}</b><em class="cvdim" id="stln"></em><span class="grow"></span>
      <button class="stb" id="stlmk" data-rk="only" title="${L("只看标注和置顶的", "Only the marked and pinned")}">★</button><button class="stb" data-stlistmin title="${L("收起（左上角 ☰ 再打开）", "Close (☰ at the top left opens it again)")}">‹</button></div><input id="stlq" placeholder="${L("搜对话…", "Search…")}"><div class="stli" id="stli"></div>
      <div class="stmy" id="stmy"><div class="stmyh"><b>${L("我的输入", "What I typed")}</b><em class="cvdim" id="stmyn"></em></div><div class="stmyl" id="stmyl"></div></div></aside>`);
    box = $("#stlist");
    $("#stlq").addEventListener("input", (e) => { ST.q = e.target.value.toLowerCase(); stListItems(); stInputsDraw(); });
    box.querySelector("[data-lrz]").addEventListener("pointerdown", (e) => {     // its right edge: wider or narrower, the stage following
      if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); e.target.setPointerCapture(e.pointerId);
      ST.lmove = { x: e.clientX, w0: box.offsetWidth }; v.classList.add("dragging", "resizing");
    });
    box.addEventListener("pointermove", (e) => { const m = ST.lmove; if (!m) return; stPanel().w = Math.max(180, Math.min(520, m.w0 + e.clientX - m.x)); stRender(); });
    const end = () => { if (!ST.lmove) return; ST.lmove = null; v.classList.remove("dragging", "resizing"); stPanelSave(); };
    box.addEventListener("pointerup", end); box.addEventListener("pointercancel", end);
  }
  box.hidden = !open; v.classList.toggle("chats-open", open); v.style.setProperty("--chats-w", open ? w + "px" : "0px");
  const bar = $("#stlbar"); if (bar) { bar.hidden = open; const c = bar.querySelector("em"); if (c) c.textContent = recentItems().length; }
  if (!open) return;
  const sig = String(recentItems().length) + (recentItems()[0]?.item || "") + (recentItems()[0]?.title || "");
  if (box.dataset.sig !== sig) { box.dataset.sig = sig; stListItems(); }
  stInputs();
  const wired = ST.nodes.filter((n) => stDock(n) && n.win);     // world and self knowledge have no rows here any more: nothing hidden stays wired
  if (wired.length) { wired.forEach((n) => { n.win = null; }); stSave(); stContexts(); }
}
async function stSync(b) {                         // ⟳: the import, now — new and changed conversations from the apps on this machine
  if (b.classList.contains("on")) return;
  const n0 = recentItems().length; b.classList.add("on"); b.title = L("正在导入…", "Importing…");
  try {
    const r = await api(`/v1/users/${S.uid}/hub/sync`, { method: "POST" });
    const got = Object.values(r?.synced || {}).reduce((t, x) => ({ n: t.n + (x?.new || 0), u: t.u + (x?.updated || 0) }), { n: 0, u: 0 });
    await loadTimeline(); stRender(); stInputs(true);
    const errs = Object.keys(r?.errors || {}).filter((k) => k !== "digest");     // the apps that could not be read (the digest is a later step)
    toast(L(`导入好了：新增 ${got.n || Math.max(0, recentItems().length - n0)} 段，更新 ${got.u} 段`, `Imported: ${got.n || Math.max(0, recentItems().length - n0)} new, ${got.u} updated`)
      + (errs.length ? L(` · ${errs.join("、")} 没读到`, ` · ${errs.join(", ")} could not be read`) : ""));
    b.title = L(`上次刷新 ${new Date().toLocaleTimeString()} · 再点一次重新导入`, `Last refreshed ${new Date().toLocaleTimeString()} · click to import again`);
  } catch (err) { toast(err.message); b.title = L("刷新失败，点一下重试", "Refresh failed; click to retry"); }
  b.classList.remove("on");
}
function stTidyLayout() {                         // ✦ first tidies the stage: every page side by side, two to a screen, wired ones together
  const A = stArena(), room = A.w - 2 * ST_PADX;                 // the open sidebar has already narrowed the stage
  const pw = Math.max(320, Math.floor((room - ST_GAP) / 2));
  const wins = stWins(), byKey = new Map(wins.filter((w) => w.key).map((w) => [w.key, w])), nb = new Map(wins.map((w) => [w.id, new Set()]));
  const tie = (a, b) => { if (a && b && a !== b && nb.has(a) && nb.has(b)) { nb.get(a).add(b); nb.get(b).add(a); } };
  for (const w of wins) for (const l of w.links || []) tie(w.id, l.from);                       // window to window
  for (const w of wins) if (stWs(w)) tie(w.id, wins.find((o) => o.ws === w.ws)?.id);            // one workspace
  for (const n of ST.nodes) if (n.type === "conv" && n.win) tie(n.win, byKey.get(n.key)?.id);   // a conversation wired in that is open too
  const order = [], seen = new Set(), at = new Map(wins.map((w, i) => [w.id, i]));
  const walk = (id) => { if (seen.has(id)) return; seen.add(id); order.push(id); [...nb.get(id)].sort((a, b) => at.get(a) - at.get(b)).forEach(walk); };
  wins.forEach((w) => walk(w.id));
  order.forEach((id, i) => { const w = wins.find((x) => x.id === id); w.ord = i; w.mini = false; w.bw = pw; delete w.pre; });
  stWsGather();
  ST.shift = null; stRender(); stSave();
  const a = $("#starena"); if (a) a.scrollTo({ left: 0, behavior: "smooth" });
  return wins.length;
}
async function stTidy(b) {                         // ✦: the stage laid out, then every conversation where it belongs
  if (b.classList.contains("on")) return;
  const pages = stTidyLayout();
  b.classList.add("on"); b.title = L("正在整理…", "Tidying…");
  let placed = 0, sums = 0, lines = 0, why = "";
  try { const r = await api(`/v1/users/${S.uid}/world/place`, { method: "POST" }); placed = r.placed || 0; sums = r.summarised || 0; if (r.why === "not built") why = L("世界树还没建", "the world tree is not built yet"); }
  catch (err) { why = err.message; }
  try { const r = await api(`/v1/users/${S.uid}/timeline/organize`, { body: { use_model: false } }); lines = r.new_lines || 0; } catch {}
  let filed = 0; try { const r = await api(`/v1/users/${S.uid}/projects/sort`, { method: "POST" }); filed = (r.ruled || 0) + (r.sorted || 0); } catch {}
  try { await loadTimeline(); if (typeof loadWorld === "function") loadWorld().catch?.(() => {}); } catch {}
  stRender();
  toast(L(`台面排好了：${pages} 个页面，一屏两个，连着线的挨在一起 · ${placed} 段对话放进世界树，${sums} 个主题重写了总结，${lines} 条新线 · ${filed} 段归进项目`, `Laid out: ${pages} pages, two to a screen, wired ones together · ${placed} into the world tree, ${sums} topics summarised, ${lines} new lines · ${filed} filed under projects`) + (why ? ` · ${why}` : ""));
  b.classList.remove("on"); b.title = L(`上次整理 ${new Date().toLocaleTimeString()} · 再点一次重新整理`, `Last tidied ${new Date().toLocaleTimeString()} · click to tidy again`);
}
function stDropToggle(open) {                       // 所有对话 open or closed, kept across reloads
  const lp = stPanel(); ST.listOpen = lp.open = open ?? !ST.listOpen; stPanelSave(); stRender();
  if (ST.listOpen) setTimeout(() => $("#stlq")?.focus(), 30);
}
function stPanelSave() { try { localStorage.setItem("pga_st_lp", JSON.stringify(ST.lp || {})); } catch {} }
/* Each row: one conversation, under its project (pga.projectsort files them when they are imported). Newest first;
   pinned ones above the rest; a mark (★, or a word of yours) on any. */
const stMarks = () => (ST.marks ||= (() => { try { return JSON.parse(localStorage.getItem("pga_marks") || "{}"); } catch { return {}; } })());
function stMarkSet(key, f) {
  const m = stMarks(), o = { ...(m[key] || {}) }; f(o);
  if (o.pin || o.mark) m[key] = o; else delete m[key];
  try { localStorage.setItem("pga_marks", JSON.stringify(m)); } catch {} stListItems();
}
function stLeafOf(key) {                           // the world tree's leaf for a conversation, by its key
  if (ST.leafAt !== W.nodes) { ST.leafAt = W.nodes; ST.leaves = new Map(W.nodes.filter((n) => n.kind === "leaf" && n.ref).map((n) => [n.ref, n])); }
  return ST.leaves?.get(key) || null;
}
const stFolderOf = (key) => { const l = stLeafOf(key); return l ? worldPath(l).slice(1, -1) : []; };   // root and leaf left out
/* 我的输入: the bottom third of 所有对话 — what you typed lately, in any conversation, newest first, one line each like
   files in a folder (your words only).
   Click one: its conversation opens, at that question. Fetched again a minute later at most, and after an import. */
async function stInputs(force) {
  if (!$("#stmyl") || (!force && ST.inAt && Date.now() - ST.inAt < 60000)) return;
  ST.inAt = Date.now();
  try { ST.inputs = (await api(`/v1/users/${S.uid}/inputs?limit=80`)).inputs || []; } catch { ST.inAt = 0; return; }
  stInputsDraw();
}
function stInputsDraw() {
  const box = $("#stmyl"); if (!box || !ST.inputs) return; const q = ST.q || "";
  const xs = ST.inputs.filter((x) => !q || x.text.toLowerCase().includes(q) || (x.title || "").toLowerCase().includes(q));
  box.innerHTML = xs.map((x) => `<div class="stmyr" data-inkey="${esc(x.key)}" data-inrun="${esc(x.run || "")}" title="${esc(x.text + "\n— " + (x.title || ""))}"><b>${esc(x.text.replace(/\s+/g, " "))}</b><span>${x.at ? ago(x.at) : ""}</span></div>`).join("")
    || `<div class="cvdim" style="padding:6px 8px">${q ? L("没有找到", "Nothing found") : L("最近还没有输入", "Nothing typed lately")}</div>`;
  const n = $("#stmyn"); if (n) n.textContent = String(xs.length);
}
document.addEventListener("click", (e) => {
  const r = S.view === "stage" && e.target.closest?.("#stmy [data-inkey]"); if (!r) return;
  e.preventDefault(); e.stopPropagation(); pjOpenOn(window, r.dataset.inkey, r.dataset.inrun, r.dataset.inrun ? "" : r.title);
}, true);
function stListItems() {                           // every past conversation, newest first, one tight row each
  const box = $("#stli"); if (!box) return;
  if (!W.nodes.length && !ST.wtAsked) { ST.wtAsked = true; wtFetch().then(() => W.nodes.length && stListItems()); }
  const M = stMarks(), q = ST.q || "", fd = ST.folder && W.byId?.get(ST.folder);
  const xs = recentItems().filter((x) => (!q || (x.title || "").toLowerCase().includes(q) || (M[x.item]?.mark || "").toLowerCase().includes(q))
    && (!ST.onlyMarked || M[x.item]) && (!fd || stFolderOf(x.item).some((f) => f.id === fd.id)));
  const pinned = xs.filter((x) => M[x.item]?.pin).sort((a, b) => M[b.item].pin - M[a.item].pin), rest = xs.filter((x) => !M[x.item]?.pin);
  const row = (x) => { const m = M[x.item] || {};
    return `<div class="ritem ${m.pin ? "pinned" : ""} ${m.mark ? "marked" : ""}" data-ritem="${esc(x.item)}" title="${esc((x.title || "") + " · " + (x.agent ? agentLabel(x.agent) : "PGA") + (x.last ? " · " + ago(x.last) : ""))}">
      <div class="rline"><b>${esc(x.title || L("新对话", "New chat"))}</b>${m.mark ? `<i class="rmark">${esc(m.mark)}</i>` : ""}
        <span class="racts"><button data-rk="pin" title="${m.pin ? L("取消置顶", "Unpin") : L("置顶", "Pin to the top")}">${m.pin ? "⊗" : "📌"}</button><button data-rk="mark" title="${m.mark ? L("改标注（清空就去掉）", "Change the mark (empty removes it)") : L("标注", "Mark it")}">★</button></span></div></div>`; };
  let html = "";
  if (pinned.length) html += `<div class="rgrp">📌 ${L("置顶", "Pinned")}</div>` + pinned.map(row).join("");
  for (const g of pjGroups(rest.slice(0, 400))) {   // every conversation under its project (the folder it ran in), the latest project first
    const shut = !q && pjShut(g.name);
    html += pjHead(g, shut) + (shut ? "" : g.items.map(row).join(""));
  }
  const keep = box.scrollTop;
  box.innerHTML = (fd ? `<div class="rfold">📁 ${esc(worldPath(fd).slice(1).map((f) => f.title).join(" › "))}<button data-rk="unfolder" title="${L("看全部", "Show all")}">×</button></div>` : "")
    + (html || `<div class="cvdim" style="padding:10px">${L("没有找到", "Nothing found")}</div>`);
  box.scrollTop = keep; const n = $("#stln"); if (n) n.textContent = String(xs.length);
  $("#stlmk")?.classList.toggle("on", !!ST.onlyMarked);
  stOver();
}
function stRailNode(key, win) {
  const have = ST.nodes.find((n) => n.rail && n.key === key && n.win === win);
  if (have) return null;
  const x = recentItems().find((y) => y.item === key);
  const n = { id: stId(), type: "conv", key, title: x?.title || key, win, rail: true }; ST.nodes.push(n); return n;
}
function stRailToggle(key) {
  const win = ST.focus || stWins()[0]?.id; if (!win) return;
  const have = ST.nodes.find((n) => n.rail && n.key === key && n.win === win);
  if (have) ST.nodes = ST.nodes.filter((n) => n !== have); else stRailNode(key, win);
  stRender(); stSave(); stContexts();
}
function stRailRow(key) { return [...document.querySelectorAll("#stlist [data-ritem]")].find((r) => r.dataset.ritem === key); }
function stRailMarks() {                        // which rows are open as windows, and which are wired into one
  if (S.view !== "stage") return;
  const open = new Set(stWins().map((w) => w.key)), wired = new Set(ST.nodes.filter((n) => n.rail).map((n) => n.key));
  document.querySelectorAll("#stlist [data-ritem]").forEach((r) => { r.classList.toggle("stopen", open.has(r.dataset.ritem)); r.classList.toggle("stwired", wired.has(r.dataset.ritem)); });
}
function stOver() {                              // the wires from the history column to the windows, drawn over the whole app
  let svg = $("#stover");
  if (!svg) { document.body.insertAdjacentHTML("beforeend", `<svg id="stover" class="stover"></svg>`); svg = $("#stover"); }
  if (S.view !== "stage" || $("#vStage")?.classList.contains("hasmax")) { svg.innerHTML = ""; return; }
  stRailMarks();
  const list = $("#stli")?.getBoundingClientRect(), ar = $("#starena")?.getBoundingClientRect(); if (!list || !ar || $("#stlist")?.hidden) { svg.innerHTML = ""; return; }
  let h = "";
  const from = (key) => { const r = stRailRow(key)?.getBoundingClientRect(); if (!r) return null;
    const y = Math.max(list.top + 4, Math.min(list.bottom - 4, r.top + r.height / 2)); return { x: r.right - 9, y, out: y !== r.top + r.height / 2 }; };
  const visible = (w) => ar.left + w.x - stSL() + 4 >= ar.left;     // a page scrolled away to the left: no wire across the stage to it
  for (const n of ST.nodes) {
    if (!n.rail) continue; const a = from(n.key), w = ST.pos?.get(n.win); if (!a || !w || !visible(w)) continue;
    const x1 = ar.left + w.x - stSL(), y1 = ar.top + stPinY(w, 0), d = stCurve(a.x, a.y, x1, y1);
    h += `<path class="stwire z0 ${a.out ? "faint" : ""}" d="${d}"/><path class="sthit" d="${d}" data-unrail="${n.id}"><title>${esc(stTitle(n.key))} · ${L("点一下断开", "click to cut")}</title></path>`;
  }
  const g = ST.rw; if (g) h += `<path class="stwire tmp z0" d="${stCurve(g.x0, g.y0, g.x, g.y)}"/><circle class="stball z0" cx="${g.x}" cy="${g.y}" r="5"/>`;
  svg.innerHTML = h;
}
document.addEventListener("pointerdown", (e) => {
  if (S.view !== "stage" || e.button !== 0) return;
  const it = e.target.closest("#stlist [data-ritem]"); if (!it || e.target.closest("[data-rk]")) return;
  const r = it.getBoundingClientRect();
  ST.rp = { key: it.dataset.ritem, x: e.clientX, y: e.clientY, pin: e.clientX > r.right - 26, wire: false };
}, true);
document.addEventListener("pointermove", (e) => {
  const p = ST.rp; if (!p) return;
  if (!p.wire && !p.page) { if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8) return;
    window.getSelection()?.removeAllRanges(); const r = stRailRow(p.key)?.getBoundingClientRect();
    if (p.pin) { p.wire = true; ST.rw = { x0: r ? r.right - 9 : p.x, y0: r ? r.top + r.height / 2 : p.y, x: e.clientX, y: e.clientY }; $("#vStage").classList.add("dragging", "wiring"); }
    else {                                         // the row itself: the conversation comes out as a page, where you let go
      p.page = true; $("#vStage").classList.add("dragging");
      document.body.insertAdjacentHTML("beforeend", `<div class="stghost" id="stghost"><b>${esc(stTitle(p.key).slice(0, 40))}</b><span>${L("松手打开成页面", "Let go to open it as a page")}</span></div>`);
    } }
  e.preventDefault();
  if (p.page) { const g = $("#stghost"); if (g) { g.style.left = e.clientX - 20 + "px"; g.style.top = e.clientY - 18 + "px"; } return; }
  ST.rw.x = e.clientX; ST.rw.y = e.clientY; stOver();
}, true);
document.addEventListener("pointerup", (e) => {
  const p = ST.rp; if (!p) return; ST.rp = null; ST.rpClick = true;
  if (p.page) { $("#stghost")?.remove(); $("#vStage").classList.remove("dragging");
    const ar = $("#starena").getBoundingClientRect(), inPanel = e.target.closest?.("#stlist") || document.elementsFromPoint(e.clientX, e.clientY).some((x) => x.id === "stlist");
    if (!inPanel && e.clientX > ar.left && e.clientX < ar.right && e.clientY > ar.top && e.clientY < ar.bottom) stOpenAt(p.key, e.clientX - ar.left + stSL());
    return; }
  if (!p.wire) { if (p.pin) stRailToggle(p.key); else stOpen(p.key); return; }
  ST.rw = null; $("#vStage").classList.remove("dragging", "wiring");
  const hit = document.elementsFromPoint(e.clientX, e.clientY), ar = $("#starena").getBoundingClientRect();
  const w = hit.map((x) => x.closest?.(".stnode.t-win")?.dataset.nid || x.closest?.(".sttab.win")?.dataset.stunfold).find(Boolean)
    || (e.clientX > ar.left && e.clientX < ar.right && e.clientY > ar.top && e.clientY < ar.bottom ? ST.focus || stWins()[0]?.id : null);
  if (w && stWins().some((x) => x.id === w && x.key !== p.key)) { stRailNode(p.key, w); stRender(); stSave(); stContexts(); } else stOver();
}, true);
document.addEventListener("click", (e) => {                     // the sidebar's own click (open in the chats page) is not wanted here
  const rk = S.view === "stage" && e.target.closest?.("#stlist [data-rk]");
  if (rk) { e.stopPropagation(); e.preventDefault(); const key = rk.closest("[data-ritem]")?.dataset.ritem, op = rk.dataset.rk;
    if (op === "pin") stMarkSet(key, (o) => { o.pin = o.pin ? 0 : Date.now(); });
    else if (op === "mark") { const cur = stMarks()[key]?.mark || "", t = prompt(L("标注这段对话（一个词或 ★；清空就去掉）", "Mark this conversation (a word, or ★; empty removes it)"), cur || "★"); if (t !== null) stMarkSet(key, (o) => { o.mark = t.trim().slice(0, 24); }); }
    else if (op === "folder") { ST.folder = rk.dataset.fid; $("#stli").scrollTop = 0; stListItems(); }
    else if (op === "unfolder") { ST.folder = null; stListItems(); }
    else if (op === "only") { ST.onlyMarked = !ST.onlyMarked; stListItems(); }
    return; }
  if (ST.rpClick && e.target.closest("#stlist [data-ritem]")) { e.stopPropagation(); e.preventDefault(); }
  ST.rpClick = false;
  const cut = e.target.closest?.("[data-unrail]"); if (cut) { ST.nodes = ST.nodes.filter((n) => n.id !== cut.dataset.unrail); stRender(); stSave(); stContexts(); }
  const k = e.target.closest?.("[data-unk], .stkdot"), kn = k && ST.nodes.find((n) => n.id === (k.dataset.unk || k.closest("[data-stk]")?.dataset.stk));
  if (kn) { kn.win = kn.win ? null : ST.focus || stWins()[0]?.id || null; stRender(); stSave(); stContexts(); }
}, true);
document.addEventListener("scroll", () => { if (S.view === "stage") requestAnimationFrame(stOver); }, true);
window.addEventListener("resize", () => { if (S.view === "stage") requestAnimationFrame(stOver); });

/* the side panel inside a window: the conversation page's own right panel (environment, context, world tree) */
function stSide(n) {
  const f = document.querySelector(`.stnode[data-nid="${n.id}"] iframe`); try { f.contentDocument.documentElement.classList.toggle("eside", n.side !== false); f.contentWindow.renderChat?.(); } catch {}
}

/* ------------------------------------------------ moving: a card to another window or the shelf; a window along the row */
function stGrab(n, sx, sy, gx = 40) {               // gx: where on the page you hold it
  const e = document.querySelector(`.stnode[data-nid="${n.id}"]`); if (!e) return;
  ST.drag = { n, el: e, sx, sy, gx, s0: stSL(), l0: parseFloat(e.style.left), t0: parseFloat(e.style.top), moved: false };
  e.classList.add("held"); $("#vStage").classList.add("dragging");
  if (n.type === "win" && !n.mini) {               // what is in the row besides it: still, until the page you drag touches it
    const g = ST.drag.groups = stGroups(n), mid = ST.drag.l0 + e.offsetWidth / 2;
    for (const x of g) x.side = x.x + x.w / 2 > mid ? 1 : -1;
    const c = (ST.units || []).find((u) => u.kind === "col" && u.win === n && !u.hide && u.open);
    ST.drag.slot = { x: ST.drag.l0 - (c ? ST_CW + ST_GAP : 0), e: ST.drag.l0 + e.offsetWidth };
  }
}
function stEdgeHold(id, side) {                    // an edge you pull: only the page across it gives or takes the room, the rest stay put
  const us = (ST.units || []).filter((u) => !u.hide && u.x != null && u.open);
  const i = us.findIndex((u) => u.kind === "win" && u.win.id === id); if (i < 0) return false;
  const step = side.includes("e") ? 1 : -1; let nb = null;
  for (let j = i + step; j >= 0 && j < us.length; j += step) if (us[j].kind === "win") { nb = us[j]; break; }
  for (const u of us) if (u.kind === "win" && u !== nb && u.win.id !== id) u.win.bw = Math.round(u.w);   // the others keep their width
  if (!nb) return false;                                                                                 // nobody across: it opens a gap
  ST.shift = null;
  if (step < 0) return { win: nb.win, w0: (nb.win.bw = Math.round(nb.w)) };     // a left edge: the page before gives exactly what this one takes, so its right edge stays
  delete nb.win.bw; return true;
}
function stGroups(n) {                             // the row by its parts: each page with its column, each stack of tabs
  const els = (ids) => ids.map((id) => document.querySelector(`.stnode[data-nid="${id}"]`)).filter((x) => x && !x.hidden);
  const gs = [], runs = new Map(); let col = null;
  for (const u of ST.units || []) {
    if (u.hide || u.x == null || (u.win && u.win.id === n.id)) continue;
    if (!u.open) { if (!runs.has(u.run)) runs.set(u.run, { key: "run", x: u.run.x, w: ST_TAB, els: [], wins: [] }); const g = runs.get(u.run);
      if (u.kind === "win") g.wins.push(u.win.id); continue; }
    if (u.kind === "col") col = { u, els: els(u.nodes.map((x) => x.id)) };
    else if (u.kind === "win") { const c = col?.u.win === u.win ? col : null; col = null;     // a page and its column move as one
      gs.push({ key: "win", win: u.win, x: c ? c.u.x : u.x, w: u.w + (c ? u.x - c.u.x : 0), off: c ? u.x - c.u.x : 0, els: c ? c.els : [], pel: u.win.el, page: true, wins: [u.win.id] }); }
    else gs.push({ key: u.kind, x: u.x, w: u.w, els: els(u.nodes.map((x) => x.id)) });
  }
  for (const g of runs.values()) { g.els = [...document.querySelectorAll("#stbars > .sttab")].filter((t) => Math.abs(parseFloat(t.style.left) - g.x) < 1);
    g.els.push(...[...document.querySelectorAll("#stnodes > .stnode.tab")].filter((t) => !t.hidden && Math.abs(parseFloat(t.style.left) - g.x) < 1)); gs.push(g); }
  for (const g of gs) { g.off = g.off || 0; g.cx = g.x; g.cw = g.w; g.o = g.els.map((el) => ({ el, l: parseFloat(el.style.left) })); }
  return gs;
}
/* dragging a page: the pages beside it stay where they are until it touches one; then only the edge it touches gives way
   (the far edge stays), down to ST_SQ, after which the page you drag slides over it. Once your page's middle is past a
   page's middle, that page jumps into the slot you left. Nothing follows you back when you reverse. */
const ST_SQ = ST_MINW;                                 // the least a page is squeezed to by one you drag into it
function stPush(d, l, w) {
  const G = ST_GAP, mid = l + w / 2, gs = d.groups || [];
  for (const g of gs) {
    if (!g.page) continue;
    const flip = g.side > 0 ? mid > g.cx + g.cw / 2 : mid < g.cx + g.cw / 2; if (!flip) continue;
    g.side = -g.side; const least = g.off + ST_SQ, others = gs.filter((o) => o !== g && o.side === g.side), sl = d.slot;   // it takes the slot you left
    if (g.side < 0) { const x = Math.max(ST_PADX, sl.x, ...others.map((o) => o.cx + o.cw + G)), e = Math.min(l - G, x + g.w); g.cx = Math.min(x, e - least); g.cw = e - g.cx; }
    else { const e = Math.min(sl.e, ...others.map((o) => o.cx - G)), x = Math.max(l + w + G, e - g.w); g.cx = x; g.cw = Math.max(least, e - x); }
    d.slot = { x: g.x, e: g.x + g.w };                                           // and its own old place is the slot now
    for (const el of [g.pel, ...g.els]) { if (!el) continue; el.classList.add("jump"); clearTimeout(el._jt); el._jt = setTimeout(() => el.classList.remove("jump"), 260); }
  }
  for (const g of gs) {                            // a touch
    if (!g.page) continue; const least = g.off + ST_SQ, end = g.cx + g.cw;
    if (g.side > 0 && g.cx < l + w && end > l + w) { g.cx = Math.min(l + w, end - least); g.cw = end - g.cx; }   // only once the edges meet
    if (g.side < 0 && end > l && g.cx < l) g.cw = Math.max(least, l - g.cx);
  }
  for (const g of gs) {
    const dx = g.cx - g.x;
    if (g.page) { g.pel.style.left = g.cx + g.off + "px"; g.pel.style.width = g.cw - g.off + "px"; const p = ST.pos?.get(g.win.id); if (p) { p.x = g.cx + g.off; p.w = g.cw - g.off; } }
    for (const o of g.o) { o.el.style.transform = dx ? `translateX(${dx}px)` : ""; const id = o.el.dataset.nid || o.el.dataset.stunfold, p = id && ST.pos?.get(id); if (p) p.x = o.l + dx; }
  }
}
function stDragTo(sx, sy) {
  const d = ST.drag; if (!d) return;
  if (Math.hypot(sx - d.sx, sy - d.sy) > 4) d.moved = true; d.lx = sx; d.ly = sy;
  const A = stArena(), w = d.el.offsetWidth, sl = stSL();
  const big = d.n.type === "win" && !d.n.mini;                     // a page as wide as the stage still moves: up to 60% of it may hang
  const lo = big ? sl - w * 0.6 : sl, hi = big ? sl + A.w - w * 0.4 : Math.max(sl, sl + A.w - w);   // past an edge, the rest stays in view
  const raw = d.l0 + sx - d.sx + sl - d.s0, l = Math.max(lo, Math.min(hi, raw)); d.el.style.left = l + "px";
  const px = raw + d.gx - sl;                     // held at an edge of the stage: it scrolls that way, the page along with it
  d.v = big ? (px > A.w - 48 ? Math.min(24, (px - A.w + 48) / 2) : px < 48 && sl > 0 ? -Math.min(24, (48 - px) / 2) : 0) : 0;
  if (d.v && !d.auto) d.auto = requestAnimationFrame(function step() {
    const D = ST.drag; if (!D || !D.v) { if (D) D.auto = 0; return; }
    const a = $("#starena"), b = a.scrollLeft; a.scrollLeft = Math.max(0, b + D.v);
    if (a.scrollLeft === b && D.v > 0) stGrow(a.scrollLeft + a.clientWidth + 40);   // at the end of the row: there is more stage
    D.auto = requestAnimationFrame(step); stDragTo(D.lx, D.ly);
  });
  if (d.n.type !== "win" || d.n.mini) d.el.style.top = Math.max(0, Math.min(A.h - d.el.offsetHeight, d.t0 + sy - d.sy)) + "px";
  if (big) {
    const up = sy - d.sy < -60;                     // pulled up by its head: let go and it fills the screen
    if (up !== !!d.up) { d.up = up; $("#vStage").classList.toggle("maxhint", up); }
    stPush(d, l, w);
    const me = ST.pos?.get(d.n.id);                // its wired cards come along, keeping their place beside it
    if (me) { const dx = l - me.x; me.x = l;
      for (const n of ST.nodes) { if (n.win !== d.n.id || stDock(n) || n.rail) continue; const p = ST.pos.get(n.id), e = document.querySelector(`.stnode[data-nid="${n.id}"]`); if (!p || !e || e.hidden) continue; p.x += dx; e.style.left = p.x + "px"; } }
  }
  stWires();
}
function stSettle(d) {                             // a page let go: everything stays as it is now — the order, each width, the gaps
  for (const g of d.groups || []) for (const o of g.o) o.el.style.transform = "";
  if (!d.moved) return;
  const A = stArena(), G = ST_GAP, l = parseFloat(d.el.style.left), w = d.el.offsetWidth;
  const mc = (ST.units || []).find((u) => u.kind === "col" && u.win === d.n && !u.hide && u.open), doff = mc ? ST_CW + G : 0;
  const bs = (d.groups || []).map((g) => ({ key: g.key, win: g.win, x: g.cx, w: g.cw, off: g.off, page: g.page, side: g.side, wins: g.wins || [] }));
  // hanging over the left edge of the stage, the page you dropped slides back in (to the right the stage goes on); a
  // neighbour it covers gives at the edge it touches (as while dragging); whatever is still covered comes off its own edges
  let x = l - doff, e = l + w;
  if (x < ST_PADX) { e += ST_PADX - x; x = ST_PADX; }
  for (const b of bs) { if (!b.page) continue; const least = b.off + ST_SQ, end = b.x + b.w;
    if (b.side < 0 && end > x - G) b.w = Math.max(least, x - G - b.x);
    if (b.side > 0 && b.x < e + G) { b.x = Math.min(e + G, end - least); b.w = end - b.x; } }
  const lb = Math.max(ST_PADX, ...bs.filter((b) => b.side < 0).map((b) => b.x + b.w + G)), rb = Math.min(Infinity, ...bs.filter((b) => b.side > 0).map((b) => b.x - G));
  x = Math.max(x, lb); e = Math.min(e, rb); if (e - x < doff + ST_SQ) e = x + doff + ST_SQ;
  bs.push({ key: "win", win: d.n, x, w: e - x, off: doff, page: true, side: 0, wins: [d.n.id] });
  bs.sort((a, b) => a.side - b.side || a.x - b.x);
  let c = ST_PADX; for (const b of bs) { b.x = Math.max(b.x, c); c = b.x + b.w + G; }   // only what still overlaps moves on to the right
  // the order of the pages, then their widths and gaps, written so the next layout puts them exactly here
  const seq = bs.flatMap((b) => b.wins), wins = stWins().filter((o) => !o.mini);
  wins.sort((p, q) => (seq.includes(p.id) ? seq.indexOf(p.id) : 1e4 + wins.indexOf(p)) - (seq.includes(q.id) ? seq.indexOf(q.id) : 1e4 + wins.indexOf(q))).forEach((o, k) => { o.ord = k; });
  for (const b of bs) if (b.page) { b.win.bw = Math.floor(b.w - b.off); delete b.win.pre; }
  ST.shift = 0;
  for (const b of bs) {
    const us = stLayout().units;
    if (!b.page) continue;
    const u = us.find((x) => x.kind === "col" && x.win === b.win && !x.hide && x.open) || us.find((x) => x.kind === "win" && x.win === b.win);
    if (u?.open && u.x != null && b.x - u.x >= 1) b.win.pre = Math.floor(b.x - u.x);
  }
}
function stDrop(sx) {
  const d = ST.drag; ST.drag = null; $("#vStage").classList.remove("dragging"); if (!d) return null; d.el.classList.remove("held");
  if (d.moved && d.n.type !== "win") {          // it stays where you put it; dropped onto another window it is wired into that one
    const A = stArena(), left = parseFloat(d.el.style.left), top = parseFloat(d.el.style.top), cx = left + ST_CW / 2;
    const over = (ST.units || []).find((u) => u.kind === "win" && !u.hide && u.x != null && cx >= u.x && cx <= u.x + (u.open ? u.w : ST_TAB));
    if (over && over.win.id !== d.n.win) { d.n.win = over.win.id; delete d.n.fx; delete d.n.fy; }
    else if (over) { delete d.n.fx; delete d.n.fy; }                         // onto its own window: back beside it
    else {
      const u = (ST.units || []).find((x) => (d.n.win ? x.kind === "win" && x.win.id === d.n.win : x.kind === "shelf"));
      d.n.fx = left - (u?.x ?? 0); d.n.fy = top / A.h;
    }
  }
  if (d.n.type === "win" && d.n.mini) { if (d.moved) { const A = stArena(); d.n.fx = parseFloat(d.el.style.left) / A.w; d.n.fy = parseFloat(d.el.style.top) / A.h; } }
  else if (d.n.type === "win") { stSettle(d); if (d.moved && stWs(d.n)) stWsGather(d.n.id); if (d.up) { $("#vStage").classList.remove("maxhint"); stRender(); stSave(); stMax(d.n, true); return d; } }
  if (d.fromList && !d.moved) { ST.nodes = ST.nodes.filter((x) => x !== d.n); stRender(); stOpen(d.n.key); return null; }
  stRender(); stSave(); stContexts(); return d;
}

/* ------------------------------------------------ pulling a wire from a pin: a card into a window, or one window into another */
function stWireStart(e, pin) {
  const node = ST.nodes.find((x) => x.id === pin.closest(".stnode")?.dataset.nid); if (!node) return false;
  const r = $("#starena").getBoundingClientRect(), b = pin.getBoundingClientRect(), x0 = b.left + b.width / 2 - r.left + stSL(), y0 = b.top + b.height / 2 - r.top;
  const kind = pin.classList.contains("stin") ? "in" : pin.classList.contains("stout") ? "out" : "card";
  ST.wire = { kind, n: node, pin: kind === "card" ? ST_PIN(node) : Number(pin.dataset.pin), x0, y0, x: x0, y: y0, back: kind === "in" };
  $("#vStage").classList.add("dragging", "wiring"); stWires(); return true;
}
function stWireEnd(cx, cy) {
  const g = ST.wire; ST.wire = null; $("#vStage").classList.remove("dragging", "wiring"); if (!g) return;
  const hit = document.elementsFromPoint(cx, cy).find((x) => x.closest?.(".stnode, .sttab"));
  const tn = hit?.closest(".stnode"), tab = hit?.closest(".sttab");
  const t = tn ? ST.nodes.find((x) => x.id === tn.dataset.nid) : tab ? ST.nodes.find((x) => x.id === tab.dataset.stunfold) : null;
  const tin = hit?.closest(".stin"), link = (from, to, pin) => { if (from === to) return; to.links = (to.links || []).filter((l) => !(l.from === from.id && l.pin === pin)); to.links.push({ from: from.id, pin }); };
  if (g.kind === "card") { if (t?.type === "win") g.n.win = t.id; else if (!t && Math.hypot(g.x - g.x0, g.y - g.y0) > 40) g.n.win = null; }
  else if (g.kind === "out" && t?.type === "win") link(g.n, t, tin ? Number(tin.dataset.pin) : g.pin);
  else if (g.kind === "in" && t?.type === "win") link(t, g.n, g.pin);
  else if (g.kind === "in" && t && t.type !== "win") t.win = g.n.id;
  stRender(); stSave(); stContexts();
}

/* ------------------------------------------------ each window's context: the cards wired into it */
function stContextOf(win) { return ST.nodes.filter((n) => n.win === win.id).sort((a, b) => ST_PIN(a) - ST_PIN(b)); }
function stNodeText(n) {
  const K = S.forest?.knowledge || [], P = S.forest?.personal;
  if (n.type === "world") { const k = K.find((x) => x.system === "world"); return k ? `World knowledge (the user's world model): ${[k.gist, k.brief].filter(Boolean).join("\n")}` : ""; }
  if (n.type === "self") return P ? "Self knowledge (the user's personal model):\n" + ["background", "goals", "preferences", "abilities", "state"].map((d) => P[d]?.summary ? `- ${d}: ${P[d].summary}` : "").filter(Boolean).join("\n") : "";
  if (n.type === "note") return n.text ? `The user's note: ${n.text}` : "";
  if (n.type === "skill") return `Skill «${n.title}» — follow it where it applies:\n${(n.body || n.sub || "").slice(0, 8000)}`;
  if (n.type === "doc") return `Document «${n.title}»: ${n.sub || ""}`;
  if (n.type === "file") return `File: ${n.path || n.title}`;
  if (n.type === "conv") return stConvText(n.key, n.title || stTitle(n.key)) || `Another conversation of the user, «${n.title || stTitle(n.key)}»: ${n.sub || ""}`;
  if (n.type === "topic") return `World-tree topic «${n.title}»: ${n.sub || ""}`;
  return "";
}
ST.lt = {};                                       // what another window hands over through a wire, fetched once per conversation
function stConvData(key) {                       // what a conversation asked and used, fetched once
  const c = ST.lt[key]; if (c === undefined) { ST.lt[key] = null; api(`/v1/users/${S.uid}/chats/${encodeURIComponent(key)}/context`).then((r) => { ST.lt[key] = r; stContexts(); }).catch(() => { delete ST.lt[key]; }); }
  return c || null;
}
function stConvText(key, t) {
  const c = stConvData(key); if (!c) return "";
  return `Another conversation of the user, «${t}». What was asked there:\n` + (c.questions || []).slice(-15).map((q) => `- ${String(q.text || "").slice(0, 300)}`).join("\n");
}
function stLinkText(l) {
  const a = ST.nodes.find((x) => x.id === l.from); if (!a?.key) return "";
  const c = stConvData(a.key); if (!c) return ""; const t = stTitle(a.key), x = c.context || {};
  if (l.pin === 0) return stConvText(a.key, t);
  if (l.pin === 1) return `What the conversation «${t}» worked with:\n` + [x.topic && `topic: ${x.topic.title}`, x.attachments?.length && `attachments: ${x.attachments.join(", ")}`, x.read?.length && `read: ${x.read.join(", ")}`, x.changed?.length && `changed: ${x.changed.join(", ")}`, x.web?.length && `web: ${x.web.join(", ")}`, x.datasets?.length && `datasets: ${x.datasets.map((d) => d.title).join(", ")}`].filter(Boolean).join("\n");
  return `Skills and tools the conversation «${t}» used: ${[...(x.skills || []), ...(x.tools || [])].join(", ") || "none"}`;
}
function stContexts() {                          // send each window's wired-in context to its conversation, when it changed
  clearTimeout(ST.ct); ST.ct = setTimeout(() => {
    for (const w of stWins()) {
      const ctx = stContextOf(w), text = [...ctx.map(stNodeText), ...(w.links || []).map(stLinkText)].filter(Boolean).join("\n\n");
      const c = document.querySelector(`[data-stctxn="${w.id}"]`); const k = ctx.length + (w.links || []).length; if (c) c.textContent = k ? L(`← ${k} 个上下文`, `← ${k} in context`) : "";
      if (!w.key || w.sent === text) continue;
      w.sent = text; api(`/v1/users/${S.uid}/chat-context`, { method: "PUT", body: { key: w.key, text } }).catch(() => { w.sent = null; });
    }
    stSave();
  }, 300);
}

/* ------------------------------------------------ windows */
function stOpen(key, at) {
  let n = key && ST.nodes.find((x) => x.type === "win" && x.key === key);
  if (!n) {
    const card = key && ST.nodes.find((x) => x.type === "conv" && x.key === key);
    const wins = stWins(), after = at?.win ? wins.findIndex((w) => w.id === at.win) : card?.win ? wins.findIndex((w) => w.id === card.win) : wins.length - 1;
    if (card) ST.nodes = ST.nodes.filter((c) => c !== card);
    n = { id: stId(), type: "win", key: key || null }; wins.splice(after + 1, 0, n); wins.forEach((o, k) => { o.ord = k; }); ST.nodes.push(n);
    const by = at?.win && ST.nodes.find((w) => w.id === at.win); if (stWs(by)) { n.ws = by.ws; stWsGather(n.id); }   // opened beside a page at work: it joins in
  }
  n.mini = false; ST.focus = n.id; stRender(); stSave(); stContexts(); stShow(n.id);
  document.querySelector(`.stnode[data-nid="${n.id}"]`)?.animate?.([{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }], { duration: 260 });
  return n;
}
function stOpenAt(key, x) {                         // a page opened where you dropped it: among the others by where it landed
  const centres = (ST.units || []).filter((u) => u.kind === "win" && !u.hide && u.x != null).map((u) => ({ w: u.win, c: u.x + (u.open ? u.w : ST_TAB) / 2 }));
  const n = stOpen(key); n.mini = false;
  const rest = stWins().filter((w) => w !== n && !w.mini), at = rest.filter((w) => (centres.find((c) => c.w === w)?.c ?? -1) < x).length;
  rest.splice(at, 0, n); rest.forEach((o, i) => { o.ord = i; });
  ST.focus = n.id; stRender(); stSave(); stShow(n.id);
}
function stShow(id) {                              // move only as far as it takes to bring the page wholly into the arena (which already excludes the sidebar)
  const n = ST.nodes.find((x) => x.id === id), p = ST.pos?.get(id), a = $("#starena");
  if (!p || !a || p.tab || !n || n.mini || n.max || ST.drag || ST.pan) return;   // a small page floats, a full-screen one is the screen
  const W = a.clientWidth, sl = a.scrollLeft, l = p.x - ST_PADX, r = p.x + p.w + ST_PADX;
  const left = r - l > W || l < sl ? l : r > sl + W ? r - W : sl;                 // wider than the stage: its left edge
  if (Math.abs(left - sl) < 1) return;
  if (left + W > a.scrollWidth) stGrow(left + W);
  a.scrollTo({ left: Math.max(0, left), behavior: "smooth" });
}
function stFocus(id, render) { if (ST.focus === id && !render) return; ST.focus = id; if (render) stRender(); else document.querySelectorAll(".stnode.t-win").forEach((el) => el.classList.toggle("focus", el.dataset.nid === id)); if (render) stShow(id); }
function stMiniLook(e, mini) {
  e.classList.toggle("mini", mini);
  const mb = e.querySelector('[data-stw="min"]'); if (mb && mb.dataset.m !== String(mini)) { mb.dataset.m = String(mini); mb.textContent = mini ? "▭" : "–";
    mb.title = mini ? L("恢复成大窗口", "Back to a full window") : L("缩成小页面（拖动移动，四边四角调大小）", "Make it a small page (drag to move, pull edges and corners to size it)"); }
}
function stMini(n, on) {                          // – : the window becomes a small live page (its own size, kept); ▭ : back to full
  n.mini = on; if (on && ST.focus === n.id) ST.focus = stWins().find((w) => w !== n && !w.mini)?.id || n.id;
  ST.shift = null; stRender(); stSave();
}
function stClose(n) { if (n.pad) { stPadOut(); store.set("pga_pad_off", "1"); } ST.nodes = ST.nodes.filter((x) => x !== n); if (ST.focus === n.id) ST.focus = stWins()[0]?.id || null; stRender(); stSave(); stContexts(); }
function stMax(n, on) {
  const el = document.querySelector(`.stnode[data-nid="${n.id}"] .stwin`); if (!el) return;
  n.max = on; el.classList.toggle("max", on); $("#vStage").classList.toggle("hasmax", on);
  try { el.querySelector("iframe").contentDocument.documentElement.classList.toggle("efull", on); } catch {}
}
setInterval(() => {                               // a new conversation in a window gets its key once you send; titles follow
  for (const n of ST.nodes.filter((x) => x.type === "win")) {
    const el = document.querySelector(`.stnode[data-nid="${n.id}"]`), f = el?.querySelector("iframe"); let k = null; try { k = f?.contentWindow?.S?.chat || null; } catch {}
    if (k && k !== n.key) { n.key = k; n.sent = null; stSave(); stContexts(); }
    const t = el?.querySelector(".stwt"); if (t && n.key) { const s = stTitle(n.key); if (t.textContent !== s) t.textContent = s; }
  }
}, 2500);

/* ------------------------------------------------ right-click: add any node, wired into the window you clicked beside */
function stMenu(sx, sy) {
  const r = $("#starena").getBoundingClientRect(), x = sx - r.left + stSL();
  let best = null, bd = Infinity; for (const u of ST.units || []) { if (u.hide || u.x == null) continue; const c = u.x + (u.open ? u.w : ST_TAB) / 2, d = Math.abs(x - c); if (d < bd) { bd = d; best = u; } }
  const win = best && best.kind !== "shelf" ? best.win : null, at = { win: win?.id || null };
  document.querySelector(".stmenu")?.remove();
  const m = document.createElement("div"); m.className = "cvpal cvmenu stmenu card"; m.style.left = Math.min(sx, innerWidth - 260) + "px"; m.style.top = Math.min(sy, innerHeight - 330) + "px";
  m.innerHTML = `<div class="stmh">${win ? L(`连给「${esc(stTitle(win.key).slice(0, 18))}」`, `Into “${esc(stTitle(win.key).slice(0, 20))}”`) : L("放在未连接的架子上", "On the unwired shelf")}</div>`
    + [["conv", "💬", 0], ["topic", "🌳", 0], ["doc", "📚", 1], ["file", "📎", 1], ["note", "📝", 1], ["skill", "✦", 2], ["win", "▢"], ...(ST.nodes.some((x) => x.pad) ? [] : [["pad", "🗒"]])].map(([t, i, p]) => `<button data-stadd="${t}">${i} ${t === "win" ? L("新对话窗口", "New conversation window") : t === "pad" ? L("笔记页", "Notepad page") : L(...ST_T[t].slice(0, 2)) + (t === "note" ? "" : "…")}${p != null ? `<em>${L(...ST_PINS[p])}</em>` : ""}</button>`).join("");
  m.dataset.at = JSON.stringify(at); document.body.appendChild(m);
}
async function stAdd(type, at) {
  if (type === "win") { const n = stOpen(null, at); return n; }
  if (type === "pad") { store.set("pga_pad_off", "0"); const n = stPadNode(-1); ST.nodes.push(n); stWins().forEach((o, k) => { o.ord = k; }); ST.focus = n.id; stRender(); stSave(); return n; }
  if (type === "note") { const n = { id: stId(), type, win: at.win, text: "" }; ST.nodes.push(n); stRender(); stSave(); stContexts(); setTimeout(() => document.querySelector(`[data-stnote="${n.id}"]`)?.focus(), 50); return n; }
  let rows = [];
  if (type === "skill" || type === "file") { let pal = { skills: [], images: [] }; try { pal = await api(`/v1/users/${S.uid}/canvas-palette`); } catch {}
    rows = type === "skill" ? [...(S.forest?.knowledge || []).filter((k) => k.kind === "skill").map((k) => ({ title: k.title, sub: k.gist || "", doc: k.id })), ...pal.skills.map((x) => ({ title: x.name, sub: `${x.source === "hermes" ? "Hermes" : "Claude Code"} · ${x.description}`, path: x.path }))]
      : pal.images.map((x) => ({ title: x.name, sub: L("上传过的图片", "an uploaded picture"), path: x.path })); }
  if (type === "doc") rows = (S.forest?.knowledge || []).filter((k) => !["user", "world"].includes(k.system) && k.kind !== "skill").map((k) => ({ title: k.title, sub: k.gist || "", doc: k.id }));
  if (type === "conv") rows = recentItems().slice(0, 400).map((x) => { const leaf = W.nodes.find((n) => n.ref === x.item); return { title: x.title || x.item, sub: [leaf ? worldPath(leaf).slice(1, -1).map((p) => p.title).join(" › ") : "", leaf?.gist || "", ago(x.last)].filter(Boolean).join(" · "), key: x.item }; });
  if (type === "topic") rows = W.nodes.filter((n) => n.kind === "topic" && !n.hidden).map((n) => ({ title: n.title, sub: `${"  ".repeat(Math.max(0, (n.depth || 1) - 1))}${(n.summary || "").slice(0, 120)}`, world: n.id }));
  modal(`<h2>${L("加一个", "Add a")} ${L(...ST_T[type].slice(0, 2))}</h2><input id="stPick" placeholder="${L("搜…", "Search…")}" style="width:100%;margin:6px 0 10px">
    <div class="stpick" id="stPickList">${rows.map((r, i) => `<div class="stpr" data-stpick="${i}" data-q="${esc((r.title + " " + r.sub).toLowerCase())}"><b>${esc(r.title)}</b><span>${esc(String(r.sub).slice(0, 120))}</span></div>`).join("") || `<div class="cvdim">${L("这里还没有可加的", "Nothing to add here yet")}</div>`}</div>`);
  $("#stPick")?.focus();
  $("#stPick")?.addEventListener("input", (ev) => { const q = ev.target.value.toLowerCase(); $("#stPickList").querySelectorAll(".stpr").forEach((r) => { r.hidden = q && !r.dataset.q.includes(q); }); });
  $("#stPickList").addEventListener("click", async (ev) => {
    const el = ev.target.closest("[data-stpick]"); if (!el) return; const r = rows[Number(el.dataset.stpick)]; document.querySelector(".modal")?.remove();
    const n = { id: stId(), type, win: at.win, title: r.title, sub: r.sub, ...(r.key ? { key: r.key } : {}), ...(r.path ? { path: r.path } : {}), ...(r.doc ? { doc: r.doc } : {}), ...(r.world ? { world: r.world } : {}) };
    if (type === "skill" && r.path) { try { n.body = (await api(`/v1/users/${S.uid}/canvas-skill?path=${encodeURIComponent(r.path)}`)).text; } catch {} }
    if (type === "topic") n.sub = (W.byId.get(r.world)?.summary || "").slice(0, 600);
    ST.nodes.push(n); stRender(); stSave(); stContexts();
    document.querySelector(`.stnode[data-nid="${n.id}"]`)?.animate?.([{ opacity: 0, transform: "scale(.8)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
  });
}

/* ------------------------------------------------ the bar */
/* ------------------------------------------------ moving along the stage: held (middle button anywhere, or the left one on empty
   ground) it slides under the pointer; the map at the top shows the whole row and takes you anywhere on it */
function stPanStart(sx) { const a = $("#starena"); if (!a) return; ST.pan = { x: sx, sl: a.scrollLeft }; $("#vStage").classList.add("panning", "dragging"); }
function stPanMove(sx) {
  const p = ST.pan, a = $("#starena"); if (!p || !a) return;
  const want = Math.max(0, p.sl - (sx - p.x)); if (want + a.clientWidth > a.scrollWidth) stGrow(want + a.clientWidth);   // past the end: more stage
  a.scrollLeft = want;
}
function stPanEnd() { if (!ST.pan) return; ST.pan = null; $("#vStage").classList.remove("panning", "dragging"); stMap(); }
try { if (window.webkit?.messageHandlers?.pga && !Q.get("embed")) document.documentElement.classList.add("deskapp"); } catch {}   // the desktop app: its top strip moves the window
window.stPanStart = stPanStart; window.stPanMove = stPanMove; window.stPanEnd = stPanEnd;
function stMap() {                                 // the minimap: every part of the row in miniature, and the part you see
  const a = $("#starena"), v = $("#vStage"); if (!a || !v || S.view !== "stage") return;
  let m = $("#stmap");
  if (!m) { v.insertAdjacentHTML("beforeend", `<label class="stmap" id="stmap"><div class="stmi" id="stmi"></div><div class="stmv" id="stmv"></div></label><button class="stlbar" id="stlbar" title="${L("所有对话：点一下在左边打开", "All conversations: click to open them at the left")}">☰ ${L("所有对话", "All conversations")} <em></em></button><span class="stmapacts"><button class="stb stsync stmapbtn" data-stsync title="${L("导入：现在把本机 Claude Code、Codex 等应用里的对话导进来", "Import: bring in the conversations from Claude Code, Codex and the other apps on this machine now")}">↻ ${L("导入", "Import")}</button><button class="stb sttidy stmapbtn" data-sttidy title="${L("整理：把新对话放进世界树、重写变了的主题总结、按标题把零散对话归成线", "Tidy: new conversations into the world tree, changed topics summarised again, loose ones joined into lines by title")}">✦ ${L("整理", "Tidy")}</button></span><div class="stmtip" id="stmtip" hidden></div>`); m = $("#stmap");
    m.addEventListener("pointerleave", () => { $("#stmtip").hidden = true; ST.mapHover = null; });
    m.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); try { m.setPointerCapture(e.pointerId); } catch {} ST.mapDrag = true; stMapGo(e.clientX); });
    m.addEventListener("pointermove", (e) => { if (ST.mapDrag) stMapGo(e.clientX); stMapTip(e.clientX); });
    const end = (e) => { ST.mapDrag = false;
      if (e.type !== "pointerup") return;
      const x = (e.clientX - m.getBoundingClientRect().left) / (Number(m.dataset.k) || 1);
      const hit = stWins().find((n) => { const p = ST.pos?.get(n.id); return p && x >= p.x && x <= p.x + p.w; });
      if (hit) { stFocus(hit.id); stShow(hit.id); }
    }; m.addEventListener("pointerup", end); m.addEventListener("pointercancel", end);
    a.addEventListener("scroll", () => requestAnimationFrame(stMapView)); }
  const T = Math.max(a.scrollWidth, a.clientWidth, 1), W = m.clientWidth || 1, k = W / T, H = m.clientHeight || 30;
  const box = (x, w, cls, title = "") => `<i class="${cls}" style="left:${(x * k).toFixed(1)}px;width:${Math.max(2, w * k).toFixed(1)}px" title="${esc(title)}"></i>`;
  let h = "";
  for (const w of stWins()) { const p = ST.pos?.get(w.id); if (!p) continue; const ws = stWs(w);
    h += box(p.x, p.w, (p.tab ? "mtab" : w.mini ? "mmini" : "mpage") + (w.id === ST.focus ? " on" : "") + (ws ? " mws" : ""), stTitle(w.key) + (ws ? " · " + ws.name : "")).replace("style=\"", ws ? `style="--wc:${ws.c};` : "style=\""); }
  for (const [id, w] of Object.entries(ST.ws || {})) {   // under each workspace on the map: one line in its colour
    const ps = stWins().filter((o) => o.ws === id && !o.mini).map((o) => ST.pos?.get(o.id)).filter(Boolean); if (!ps.length) continue;
    const l = Math.min(...ps.map((p) => p.x)), r = Math.max(...ps.map((p) => p.x + p.w)); h += box(l, r - l, "mwsline", w.name).replace("style=\"", `style="--wc:${w.c};`); }
  for (const n of ST.nodes) { if (n.type === "win" || n.rail) continue; const p = ST.pos?.get(n.id); if (p) h += box(p.x, p.w, "mcard"); }
  $("#stmi").innerHTML = h; m.dataset.k = k; m.style.setProperty("--mh", H + "px");
  stMapView();
}
function stMapTip(cx) {                           // over the map: the page there, by name, with a picture of it as it is now
  const m = $("#stmap"), tip = $("#stmtip"); if (!m || !tip) return;
  const k = Number(m.dataset.k) || 1, r = m.getBoundingClientRect(), x = (cx - r.left) / k;
  let hit = null;
  for (const w of stWins()) { const p = ST.pos?.get(w.id); if (p && x >= p.x - 4 / k && x <= p.x + p.w + 4 / k) { hit = { w, p }; if (!w.mini) break; } }
  if (!hit) { tip.hidden = true; ST.mapHover = null; return; }
  const id = hit.w.id;
  tip.style.left = Math.max(8, Math.min(innerWidth - 268, cx - 130)) + "px"; tip.style.top = r.bottom + 6 + "px"; tip.hidden = false;
  if (ST.mapHover === id) return; ST.mapHover = id;
  const t = hit.w.pad ? L("笔记", "Notes") : stTitle(hit.w.key);
  tip.innerHTML = `<b>${esc(t)}</b><div class="stmthumb" id="stmthumb"></div>`;
  try {                                           // a small picture of the page: its last few turns, as they stand
    const d = hit.w.el?.querySelector("iframe")?.contentDocument, ms = [...(d?.querySelectorAll("#cdlgIn .cmsg") || [])].slice(-4);
    if (!ms.length) throw 0;
    $("#stmthumb").innerHTML = ms.map((x) => `<div class="mt ${x.classList.contains("me") ? "me" : ""}">${esc((x.querySelector(".md, .body, .text")?.innerText || x.innerText || "").trim().slice(0, 140))}</div>`).join("");
  } catch { const b = $("#stmthumb"); if (b) b.innerHTML = `<div class="cvdim" style="padding:10px">${L("这一页还没打开", "Not opened yet")}</div>`; }
}
function stMapView() { const a = $("#starena"), m = $("#stmap"), b = $("#stmv"); if (!a || !m || !b) return; const k = Number(m.dataset.k) || 0;
  b.style.left = a.scrollLeft * k + "px"; b.style.width = Math.max(8, a.clientWidth * k) + "px"; }
function stMapGo(cx) {
  const a = $("#starena"), m = $("#stmap"); if (!a || !m) return; const k = Number(m.dataset.k) || 1, r = m.getBoundingClientRect();
  a.scrollLeft = Math.max(0, (cx - r.left) / k - a.clientWidth / 2); stMapView();
}
function stBar() {
  const bar = $("#stbar"); if (!bar) return;
  bar.innerHTML = `<span class="cvdim">${L("从接点拉线：卡片连进窗口，窗口右边连到另一个窗口左边 · 点线断开 · 右键加节点 · 放不下的收成横向标签", "Pull wires from the pins: a card into a window, one window's right into another's left · click a wire to cut it · right-click to add · what does not fit becomes tabs")}</span>
    <span class="grow"></span><button class="sm" data-st="new">＋ ${L("新对话", "New chat")}</button>`;
}

/* ------------------------------------------------ pointer */
function stCap(e) { try { $("#starena").setPointerCapture(e.pointerId); } catch {} }
function stBind() {
  const v = $("#vStage"), arena = $("#starena");
  arena.addEventListener("contextmenu", (e) => { if (e.target.closest(".stwin")) return; e.preventDefault(); stMenu(e.clientX, e.clientY); });
  arena.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });          // no autoscroll circle
  arena.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
  arena.addEventListener("pointerdown", (e) => {
    const ground = e.target === arena || ["stnodes", "stbars", "stwires"].includes(e.target.id) || e.target.classList?.contains("stground");
    if (e.button === 1 || (e.button === 0 && ground)) { e.preventDefault(); stPanStart(e.screenX); stCap(e); return; }   // the whole stage moves sideways
    if (e.button !== 0) return; document.querySelector(".stmenu")?.remove();
    const pin = e.target.closest(".stin, .stout, .stpin"); if (pin && stWireStart(e, pin)) { stCap(e); return; }
    const rz = e.target.closest("[data-rz]");
    if (rz) { e.preventDefault(); window.getSelection()?.removeAllRanges();     // no selecting the page while you pull an edge
      const n = ST.nodes.find((x) => x.id === rz.closest(".stnode").dataset.nid), el = rz.closest(".stnode"), l = parseFloat(el.style.left);
      const d = rz.dataset.rz;
      ST.rz = { n, d, x: e.clientX, y: e.clientY, w0: n.mini ? el.offsetWidth : n.bw || el.offsetWidth, h0: el.offsetHeight, t0: parseFloat(el.style.top), l0: l,
        edge: d.includes("e") ? l : l + el.offsetWidth,
        open: new Map((ST.units || []).map((u) => [u.kind + (u.win?.id || ""), u.open])) };   // the edge that stays
      if (!n.mini) { ST.rz.across = stEdgeHold(n.id, d); ST.rz.pre0 = n.pre || 0; ST.rz.off0 = stLayout().off; }
      v.classList.add("dragging", "resizing"); stCap(e); return; }
    if (e.target.closest("button, textarea, input, iframe, [data-doc], [data-stunfold]")) return;
    const el = e.target.closest(".stnode"); if (!el) return;
    const n = ST.nodes.find((x) => x.id === el.dataset.nid); if (!n || n.max || (n.type === "win" && !e.target.closest(".stwh"))) return;
    if (n.type === "win") stFocus(n.id); stGrab(n, e.screenX, e.screenY, e.clientX - el.getBoundingClientRect().left); stCap(e);
  });
  arena.addEventListener("pointermove", (e) => {
    if (ST.pan) { stPanMove(e.screenX); return; }
    if (ST.rz) { const r = ST.rz, dx = e.clientX - r.x, dy = e.clientY - r.y, A = stArena();
      if (r.n.mini) {                                // a small page: any edge or corner, the opposite one staying put
        if (r.d.includes("e") || r.d.includes("w")) { const w = Math.round(Math.max(200, Math.min(A.w - 16, r.w0 + (r.d.includes("e") ? dx : -dx))));
          r.n.mw = w; r.n.fx = (r.d.includes("w") ? r.l0 + r.w0 - w : r.l0) / A.w; }
        if (r.d.includes("n") || r.d.includes("s")) { const h = Math.round(Math.max(140, Math.min(A.h - 16, r.h0 + (r.d.includes("s") ? dy : -dy))));
          r.n.mh = h; r.n.fy = (r.d.includes("n") ? r.t0 + r.h0 - h : r.t0) / A.h; }
        stRender(); return;
      }
      if (r.d.includes("e") || r.d.includes("w")) {
        r.n.bw = Math.round(Math.max(320, Math.min(A.w - 80, r.w0 + (r.d.includes("e") ? dx : -dx))));
        if (r.d.includes("w") && r.across?.win) {     // between two pages: the one before gives the room, down to its least
          r.n.bw = Math.min(r.n.bw, r.w0 + r.across.w0 - 320); r.across.win.bw = r.across.w0 + r.w0 - r.n.bw; stRender(); return;
        }
        if (r.d.includes("w") && !r.across) {        // its outer left edge: a gap opens before it (or closes), nothing else moves
          const want = r.pre0 + r.w0 - r.n.bw; r.n.pre = Math.max(0, want); if (!r.n.pre) delete r.n.pre;
          if (want >= 0) { ST.shift = r.off0; stRender(); return; }
        }
        const lay = stLayout(), u = lay.units.find((x) => x.kind === "win" && x.win === r.n);         // only the edge you pull moves
        if (u && u.open && !r.across) ST.shift = lay.off + r.edge - (r.d.includes("e") ? u.x : u.x + u.w);
      }
      stRender();
      if (r.d.includes("w") && !r.across) {           // the row has no room to shift (wider than the screen): the stage scrolls instead, so the right edge stays under you
        const p = ST.pos?.get(r.n.id), a = $("#starena");
        if (p && a) { const by = p.x + p.w - r.edge; if (Math.abs(by) >= 1) { if (a.scrollLeft + by + a.clientWidth > a.scrollWidth) stGrow(a.scrollLeft + by + a.clientWidth); a.scrollLeft += by; r.edge += by; } }
      }
      return; }
    if (ST.wire) { const r = arena.getBoundingClientRect(); ST.wire.x = e.clientX - r.left + stSL(); ST.wire.y = e.clientY - r.top; stWires(); return; }
    if (ST.drag) stDragSoon(e.screenX, e.screenY);
  });
  arena.addEventListener("pointerup", (e) => {
    if (ST.pan) { stPanEnd(); return; }
    if (ST.wire) { stWireEnd(e.clientX, e.clientY); return; }
    if (ST.rz) { ST.rz = null; v.classList.remove("dragging", "resizing"); stSave(); return; }
    stDragFlush(); const d = stDrop(); if (d && !d.moved && d.n.type === "conv") stOpen(d.n.key, { win: d.n.win });
    else if (d && !d.moved && d.n.type === "win") stShow(d.n.id);
    else if (d && !d.moved && d.el.classList.contains("tab") && d.n.win) stFocus(d.n.win, true);
  });
  arena.addEventListener("dblclick", (e) => { const rz = e.target.closest("[data-rz]"); if (rz) { const n = ST.nodes.find((x) => x.id === rz.closest(".stnode").dataset.nid); if (n.mini) { delete n.mw; delete n.mh; } else { delete n.bw; delete n.pre; } ST.shift = null; stRender(); stSave(); } });
  arena.addEventListener("input", (e) => { const t = e.target.closest("[data-stnote]"); if (!t) return; const n = ST.nodes.find((x) => x.id === t.dataset.stnote); if (n) { n.text = t.value; stContexts(); } });
}
document.addEventListener("click", (e) => {
  if (S.view !== "stage") return;
  if (!e.target.closest(".stmenu")) document.querySelector(".stmenu")?.remove();
  const ws = e.target.closest("[data-stws]"); if (ws) { const m = ws.closest(".stmenu"), n = ST.nodes.find((x) => x.id === m.dataset.nid), op = ws.dataset.stws; m.remove(); if (!n) return;
    if (op === "rename") { const w = stWs(n), t = w && prompt(L("这个工作区叫什么？", "Name this workspace"), w.name); if (t?.trim()) { w.name = t.trim().slice(0, 40); stRender(); stSave(); } return; }
    stWsJoin(n, op === "out" ? null : op); return; }
  const add = e.target.closest("[data-stadd]"); if (add) { const m = add.closest(".stmenu"), at = JSON.parse(m.dataset.at); m.remove(); stAdd(add.dataset.stadd, at); return; }
  const sy = e.target.closest("[data-stsync]"); if (sy) { stSync(sy); return; }
  const td = e.target.closest("[data-sttidy]"); if (td) { stTidy(td); return; }
  if (e.target.closest("[data-stlistmin]")) { stDropToggle(false); return; }
  if (e.target.closest("#stlbar")) { stDropToggle(); return; }
  const uf = e.target.closest("[data-stunfold]"); if (uf) { const id = uf.dataset.stunfold; if (id === "shelf") { const w = stWins(); for (const o of w) o.bw = Math.min(o.bw || ST_WW, ST_WW); } else stFocus(id, true); return; }
  const cut = e.target.closest("[data-unlink]"); if (cut) { const [to, from, pin] = cut.dataset.unlink.split("|"), w = ST.nodes.find((x) => x.id === to); if (w) w.links = (w.links || []).filter((l) => !(l.from === from && l.pin === Number(pin))); stRender(); stSave(); stContexts(); return; }
  const del = e.target.closest("[data-stdel]"); if (del) { ST.nodes = ST.nodes.filter((x) => x.id !== del.dataset.stdel); stRender(); stSave(); stContexts(); return; }
  const w = e.target.closest("[data-stw]"); if (w) { const n = ST.nodes.find((x) => x.id === w.closest(".stnode").dataset.nid); if (!n) return;
    if (w.dataset.stw === "ws") { stWsMenu(w, n); return; }
    if (w.dataset.stw === "side") { n.side = n.side === false; w.classList.toggle("on", n.side); stSide(n); stSave(); return; }
    if (w.dataset.stw === "min") stMini(n, !n.mini); else if (w.dataset.stw === "close") stClose(n); else stMax(n, !n.max); return; }
  const t = e.target.closest("[data-st]"); if (t?.dataset.st === "new") stOpen(null);
});
document.addEventListener("keydown", (e) => { if (S.view !== "stage" || e.key !== "Escape") return; const n = ST.nodes.find((x) => x.max); if (n) stMax(n, false); });

/* a new window that is asked something right away (the notepad): type it into its composer and send */
async function stAsk(text) {
  if (S.view !== "stage") show("stage");
  const n = stOpen(null);
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const f = document.querySelector(`.stnode[data-nid="${n.id}"] iframe`); let cw; try { cw = f?.contentWindow; } catch {}
    const box = cw?.document?.querySelector("#chatText");
    if (box && typeof cw.chatSend === "function" && cw.S?.agents?.length) { box.value = text; await cw.chatSend(); break; }
  }
  for (let i = 0; i < 40; i++) { const f = document.querySelector(`.stnode[data-nid="${n.id}"] iframe`); let k = null; try { k = f?.contentWindow?.S?.chat; } catch {} if (k) { n.key = k; stSave(); return { w: n, key: k }; } await new Promise((r) => setTimeout(r, 250)); }
  return { w: n, key: null };
}
const _loadTimelineST = loadTimeline;              // titles fill in once every conversation is known
loadTimeline = async function (...a) { const r = await _loadTimelineST(...a); if (S.view === "stage") stRender(); return r; };
const _loadForestST = loadForest;
loadForest = async function (...a) { const r = await _loadForestST(...a); if (S.view === "stage") { stRender(); stContexts(); } return r; };

/* ------------------------------------------------ inside a window (the embedded conversation page) */
if (Q.get("embed") && Q.get("item")) {            // a conversation imported from another app
  const k = Q.get("item"), t0 = setInterval(() => { if (typeof recentItems === "function" && recentItems().some((y) => y.item === k)) { clearInterval(t0); openItem(k); } }, 400);
  setTimeout(() => clearInterval(t0), 20000);
}

if (Q.get("embed") && window.parent !== window) {
  const _oft = openFromTree;
  openFromTree = async function (n, el) { try { if (n.ref && window.parent.stOpen) { window.parent.stOpen(n.ref); return; } } catch {} return _oft(n, el); };
}

/* ------------------------------------------------ into the app */
const _showST = show;
show = function (view, opts) {
  if (view === "stage") { S.view = "stage"; closeCtx?.(); ["Home", "Tree", "Chats", "Notes", "Looks", "Graph"].forEach((v) => { const el = $("#v" + v); if (el) el.hidden = true; }); $("#vStage").hidden = false; history.replaceState(null, "", qs()); renderRail(); showStage(); return; }
  const st = $("#vStage"); if (st) st.hidden = true; return _showST(view, opts);
};
/* 返回: leaving the stage for the world tree (or another page) leaves a way back to the conversation you were on */
const _showBK = show;
show = function (view, opts) {
  if (view !== "stage" && S.view === "stage" && !Q.get("embed")) ST.back = { focus: ST.focus };
  const r = _showBK(view, opts); stBackBtn(view);
  document.querySelector(".app")?.classList.toggle("onstage", view === "stage"); stOver?.(); return r;
};
function stBackBtn(view) {
  document.querySelector("#stBack")?.remove();
  if (view === "stage" || !ST.back || Q.get("embed")) return;
  const w = ST.nodes.find((n) => n.id === ST.back.focus), t = w ? stTitle(w.key) : "";
  const b = document.createElement("button"); b.id = "stBack"; b.className = "sm stback";
  b.textContent = L("← 返回对话", "← Back to the conversation") + (t ? `「${t.slice(0, 24)}」` : "");
  b.addEventListener("click", () => { const f = ST.back?.focus; ST.back = null; show("stage"); if (f && ST.nodes.some((n) => n.id === f)) stFocus(f, true); });
  document.body.appendChild(b);
}
if (Q.get("embed") && window.parent !== window) {   // inside a page: held with the middle button, it is the stage that moves
  let panning = false;
  document.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); }, true);
  document.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); }, true);
  document.addEventListener("pointerdown", (e) => { if (e.button !== 1) return; try { if (!window.parent.stPanStart) return; e.preventDefault(); window.parent.stPanStart(e.screenX); panning = true; e.target.setPointerCapture?.(e.pointerId); } catch {} }, true);
  document.addEventListener("pointermove", (e) => { if (panning) { e.preventDefault(); try { window.parent.stPanMove(e.screenX); } catch {} } }, true);
  const stop = () => { if (!panning) return; panning = false; try { window.parent.stPanEnd(); } catch {} };
  document.addEventListener("pointerup", stop, true); document.addEventListener("pointercancel", stop, true);
}
if (Q.get("embed") && window.parent !== window) {   // inside a window: 全图 and the like open in the app around it, with the way back
  document.addEventListener("click", (e) => {
    const v = e.target.closest("[data-view]"); if (!v) return;
    try {
      const P = window.parent; if (!P.stOpen) return;
      const me = P.ST.nodes.find((n) => n.type === "win" && P.document.querySelector(`.stnode[data-nid="${n.id}"] iframe`)?.contentWindow === window);
      e.preventDefault(); e.stopPropagation();
      P.ST.focus = me?.id || P.ST.focus; P.show(v.dataset.view);
    } catch {}
  }, true);
}
const _renderTimelineST = renderTimeline;
renderTimeline = function (...a) { const r = _renderTimelineST(...a); if (S.view === "stage") requestAnimationFrame(stOver); return r; };
const _renderRailST = renderRail;
renderRail = function () { _renderRailST(); $("#toStage")?.classList.toggle("on", S.view === "stage"); $("#toChatsPage")?.classList.toggle("on", S.view === "chats"); };
