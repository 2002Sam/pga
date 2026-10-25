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
const ST_GAP = 18, ST_CW = 190, ST_CH = 78, ST_WW = 660, ST_TAB = 150, ST_TH = 30, ST_PADX = 12;
const ST_T = {
  world: ["世界知识", "World knowledge", "#6fa8ff"], self: ["自我知识", "Self knowledge", "#e9b35f"], note: ["笔记", "Note", "#a1a1aa"],
  skill: ["技能", "Skill", "#e9b35f"], doc: ["资料", "Document", "#7fcf9f"], file: ["文件", "File", "#5fc9c0"], conv: ["对话", "Conversation", "#8fb4ff"],
  topic: ["世界树主题", "Topic", "#d6a75c"], win: ["对话窗口", "Window", "#8fb4ff"] };
const ST_PIN = (n) => (["conv", "topic"].includes(n.type) ? 0 : n.type === "skill" ? 2 : 1);      // which input: conversations, data, skills
const ST_PINS = [["对话引用", "Conversations"], ["数据引用", "Data"], ["技能引用", "Skills"]];
const ST_OUTS = [["拉线：把这段对话问过的交给另一个窗口", "Pull a wire: what was asked here, into another window"], ["拉线：把这段对话读过、改过的交给另一个窗口", "Pull a wire: what this conversation read and changed"], ["拉线：把这段对话用过的技能交给另一个窗口", "Pull a wire: the skills this conversation used"]];
const stTitle = (key) => (key ? recentItems().find((x) => x.item === key)?.title || S.chats?.find((c) => c.key === key)?.title || key : L("新对话", "New chat"));
const stId = () => Math.random().toString(36).slice(2, 9);
const stArena = () => { const a = $("#starena"); return a ? { w: a.clientWidth, h: a.clientHeight } : { w: 1000, h: 700 }; };
const stWins = () => ST.nodes.filter((n) => n.type === "win").sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
function stSave() { try { localStorage.setItem("pga_st4", JSON.stringify({ nodes: ST.nodes.map(({ max, sent, ...n }) => n) })); } catch {} }

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

/* ------------------------------------------------ the layout: a row that always fits the screen */
function stLayout() {
  const A = stArena(), wins = stWins(), ids = new Set(wins.map((w) => w.id));
  for (const n of ST.nodes) if (n.type !== "win" && n.win && !ids.has(n.win)) n.win = null;       // its window is gone: back on the shelf
  for (const w of wins) if (w.links) w.links = w.links.filter((l) => ids.has(l.from) && l.from !== w.id);
  const shelf = ST.nodes.filter((n) => n.type !== "win" && !n.win);
  const units = [];                                 // 所有对话 live in the sidebar (the rail), not on the stage
  if (shelf.length) units.push({ kind: "shelf", nodes: shelf, w: ST_CW, open: true });
  for (const w of wins) { const col = ST.nodes.filter((n) => n.win === w.id); units.push({ kind: "col", win: w, nodes: col, w: ST_CW, open: true, hide: !col.length }); units.push({ kind: "win", win: w, w: w.bw || ST_WW, open: true }); }
  // what is folded becomes horizontal tabs; folded neighbours share one stack of tabs
  const width = () => { let t = -ST_GAP, run = false; for (const u of units) { if (u.hide) continue; if (u.open) { t += u.w + ST_GAP; run = false; } else if (!run) { t += ST_TAB + ST_GAP; run = true; } } return t; };
  const room = A.w - 2 * ST_PADX, fi = Math.max(0, wins.findIndex((w) => w.id === ST.focus));
  // too wide: fold the shelf, then the other windows' columns, then the other windows, farthest from the one you are on first
  const fold = (pred) => { for (const u of units.filter(pred)) { if (width() <= room) return; u.open = false; } };
  if (width() > room) fold((u) => u.kind === "shelf");
  if (width() > room) fold((u) => u.kind === "col" && u.win.id !== ST.focus);
  const far = units.filter((u) => u.kind === "win" && u.win.id !== ST.focus).sort((a, b) => Math.abs(wins.indexOf(b.win) - fi) - Math.abs(wins.indexOf(a.win) - fi));
  for (const u of far) { if (width() <= room) break; u.open = false; const c = units.find((x) => x.kind === "col" && x.win === u.win); if (c) c.hide = true; }
  if (width() > room) fold((u) => u.kind === "col");
  if (ST.rz?.open) for (const u of units) { const k = u.kind + (u.win?.id || ""); if (ST.rz.open.has(k)) u.open = ST.rz.open.get(k); }   // nothing folds or unfolds mid-pull
  const fw = units.find((u) => u.kind === "win" && u.open && u.win.id === ST.focus && !u.win.bw)
    || (!ST.focus && units.find((u) => u.kind === "win" && u.open && !u.win.bw));
  if (fw && width() < room) fw.w += room - width();           // the window you are on takes the rest of the space, unless you sized it
  const on = units.find((u) => u.kind === "win" && u.open && u.win.id === ST.focus) || units.find((u) => u.kind === "win" && u.open);
  if (on && width() > room) on.w = Math.max(360, on.w - (width() - room));   // still too wide: it gives way, so nothing ends off screen
  const free = Math.max(0, room - width()), off = ST.shift == null ? free / 2 : Math.max(0, Math.min(free, ST.shift));   // centred, unless an edge you pulled holds it
  let x = ST_PADX + off;
  let run = null;
  for (const u of units) { if (u.hide) continue; if (u.open) { u.x = x; x += u.w + ST_GAP; run = null; continue; }
    if (!run) { run = { x, tabs: [] }; x += ST_TAB + ST_GAP; } u.x = run.x; u.run = run; }
  return { units, A, off };
}

/* ------------------------------------------------ drawing */
function stWinHtml(n) {
  return `<div class="stwin">${["e", "w"].map((d) => `<i class="rz rz-${d}" data-rz="${d}" title="${L("拖动改宽度，双击还原", "Drag to change the width, double-click to reset")}"></i>`).join("")}
    <div class="stwh" data-stfocus="${n.id}"><b class="stwt">${esc(stTitle(n.key))}</b><em class="stctxn" data-stctxn="${n.id}"></em><span class="grow"></span>
      <button class="stb ${n.side === false ? "" : "on"}" data-stw="side" title="${L("右侧栏：环境、上下文、世界树", "Side panel: environment, context, world tree")}">◧</button><button class="stb" data-stw="min" title="${L("收成一张对话卡片", "Fold into a conversation card")}">–</button><button class="stb" data-stw="max" title="${L("最大化（Esc 还原）", "Maximise (Esc restores)")}">▢</button><button class="stb" data-stw="close" title="${L("关掉这个窗口（对话还在）", "Close the window (the conversation stays)")}">×</button></div>
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
function stRender() {
  const box = $("#stnodes"), bars = $("#stbars"); if (!box) return;
  const { units, A } = stLayout(), keep = new Set(ST.nodes.map((n) => n.id)), held = ST.drag?.n;
  box.querySelectorAll(".stnode").forEach((el) => { if (!keep.has(el.dataset.nid)) el.remove(); });
  const el = (n) => { let e = box.querySelector(`.stnode[data-nid="${n.id}"]`);
    if (!e) { e = document.createElement("div"); e.className = `stnode t-${n.type}`; e.dataset.nid = n.id; e.innerHTML = n.type === "win" ? stWinHtml(n) : stCardHtml(n); box.appendChild(e); if (n.type === "win") stFrame(n, e); }
    else if (n.type !== "win" && n.type !== "note" && e.dataset.sig !== (n.title || "") + (S.forest ? 1 : 0)) e.innerHTML = stCardHtml(n);
    e.dataset.sig = (n.title || "") + (S.forest ? 1 : 0); return e; };
  const place = (e, x, y, w, h, show = true) => { if (e === held?.el) return; e.style.left = x + "px"; e.style.top = y + "px"; e.style.width = w + "px"; e.style.height = h + "px"; e.hidden = !show; };
  let barHtml = ""; const pos = new Map(), runs = new Set();
  for (const u of units) {
    if (u.kind === "win") {
      const e = el(u.win); u.win.el = e;
      if (u.hide || !u.open) { place(e, -9999, 0, u.w, A.h, false); if (!u.hide) { const t = stTitle(u.win.key);
        u.run.tabs.push({ win: u.win.id, html: (y) => `<div class="sttab win" style="left:${u.x}px;top:${y}px;width:${ST_TAB}px;height:${ST_TH}px" data-stunfold="${u.win.id}" title="${esc(t)}"><span>▢ ${esc(t.slice(0, 40))}</span></div>` }); runs.add(u.run); } continue; }
      place(e, u.x, 8, u.w, A.h - 16); e.classList.toggle("focus", u.win.id === ST.focus);
      e.classList.toggle("hascol", units.some((c) => c.kind === "col" && c.win === u.win && !c.hide && c.open));      // its column covers the input labels
      pos.set(u.win.id, { x: u.x, y: 8, w: u.w, h: A.h - 16 }); continue;
    }
    const zones = [[], [], []]; u.nodes.forEach((n) => zones[u.kind === "shelf" ? 1 : ST_PIN(n)].push(n));
    if (u.hide || !u.open) {                      // folded: each card is a small horizontal tab, still wired in
      for (const n of u.nodes) { const e = el(n); if (u.hide) { place(e, -9999, 0, ST_CW, ST_CH, false); continue; } e.classList.add("tab"); e.classList.toggle("shelved", u.kind === "shelf"); u.run.tabs.push({ n, e, win: u.win?.id }); }
      if (!u.hide) runs.add(u.run); continue;
    }
    const zh = (A.h - 16) / 3;                    // three bands, each beside its input
    zones.forEach((zn, zi) => {
      const ch = Math.max(46, Math.min(ST_CH, (zh - 10) / Math.max(1, zn.length) - 8)), tot = zn.length * (ch + 8) - 8;
      let y = 8 + zi * zh + Math.max(4, (zh - tot) / 2);
      for (const n of zn) { const e = el(n); e.classList.remove("tab"); e.classList.toggle("short", ch < 66); e.classList.toggle("shelved", u.kind === "shelf");
        const yy = n.fy == null ? y : Math.max(4, Math.min(A.h - ch - 4, n.fy * A.h));    // where you put it, if you moved it up or down
        place(e, u.x, yy, ST_CW, ch); pos.set(n.id, { x: u.x, y: yy, w: ST_CW, h: ch, zone: zi, win: u.win?.id }); y += ch + 8; }
    });
    if (u.kind === "shelf") barHtml += `<div class="stshelf" style="left:${u.x - 4}px;width:${ST_CW + 8}px;height:${A.h - 8}px"><em>${L("未连接", "Unwired")}</em></div>`;
  }
  for (const r of runs) {                         // a stack of tabs, in the middle of the height
    const tot = r.tabs.length * (ST_TH + 6) - 6; let y = 8 + Math.max(0, (A.h - 16 - tot) / 2);
    for (const t of r.tabs) {
      if (t.n) { place(t.e, r.x, y, ST_TAB, ST_TH); pos.set(t.n.id, { x: r.x, y, w: ST_TAB, h: ST_TH, zone: ST_PIN(t.n), win: t.win }); }
      else { barHtml += t.html(y); if (t.win) pos.set(t.win, { x: r.x, y, w: ST_TAB, h: ST_TH, tab: true }); }
      y += ST_TH + 6;
    }
  }
  bars.innerHTML = barHtml;
  ST.pos = pos; ST.units = units;
  stWires();
}
const stPinY = (w, i) => (w.tab ? w.y + w.h / 2 : w.y + w.h * (i * 2 + 1) / 6);
const stCurve = (x0, y0, x1, y1) => { const k = Math.max(40, Math.abs(x1 - x0) / 2); return `M ${x0} ${y0} C ${x0 + k} ${y0}, ${x1 - k} ${y1}, ${x1} ${y1}`; };
function stWires() {                              // each card into the input of its band; windows into each other, right pin to left pin
  const svg = $("#stwires"); if (!svg || !ST.pos) return; let h = "";
  for (const n of ST.nodes) {
    if (n.type === "win" || !n.win) continue; const p = ST.pos.get(n.id), w = ST.pos.get(n.win); if (!p || !w || ST.drag?.n === n) continue;
    const x0 = p.x + p.w, y0 = p.y + p.h / 2;
    h += `<path class="stwire z${p.zone}" d="${stCurve(x0, y0, w.x, stPinY(w, p.zone))}"/><circle class="stball z${p.zone}" cx="${x0}" cy="${y0}" r="5"/>`;
  }
  for (const b of stWins()) for (const l of b.links || []) {
    const a = ST.pos.get(l.from), t = ST.pos.get(b.id); if (!a || !t) continue;
    const d = stCurve(a.x + a.w, stPinY(a, l.pin), t.x, stPinY(t, l.pin));
    h += `<path class="stwire link z${l.pin}" d="${d}"/><path class="sthit" d="${d}" data-unlink="${b.id}|${l.from}|${l.pin}"><title>${L("点一下断开这根线", "Click to cut this wire")}</title></path>`;
  }
  const g = ST.wire; if (g) h += `<path class="stwire tmp z${g.pin}" d="${g.back ? stCurve(g.x, g.y, g.x0, g.y0) : stCurve(g.x0, g.y0, g.x, g.y)}"/><circle class="stball z${g.pin}" cx="${g.x}" cy="${g.y}" r="5"/>`;
  svg.innerHTML = h;
}
function stFrame(n, el) {
  const q = new URLSearchParams({ view: "chats", embed: "1" });
  if (n.key) { if (S.allChats?.some((c) => c.key === n.key) || n.key.startsWith("chat:")) q.set("c", n.key); else q.set("item", n.key); }
  if (AS_UID) q.set("as", AS_UID); if (Q.get("lang")) q.set("lang", Q.get("lang"));
  const f = el.querySelector("iframe"); f.src = "/?" + q;
  f.addEventListener("load", () => { try { stHold(f, n); stSide(n); } catch {} });
}
function stHold(f, n) {                          // inside a conversation: press and hold (~0.3 s, still), then move the window
  const cw = f.contentWindow, doc = cw.document; let h = null;
  doc.addEventListener("pointerdown", (e) => {
    stFocus(n.id);
    if (e.button !== 0 || e.target.closest("input, textarea, select, button, a, [contenteditable], .cbar")) return;
    h = { sx: e.screenX, on: false, t: setTimeout(() => { if (!h) return; h.on = true; doc.documentElement.classList.add("stgrab"); stGrab(n, e.screenX, e.screenY); cw.getSelection()?.removeAllRanges(); }, 300) };
  }, true);
  doc.addEventListener("pointermove", (e) => {
    if (!h) return;
    if (!h.on) { if (Math.abs(e.screenX - h.sx) > 5) { clearTimeout(h.t); h = null; } return; }
    e.preventDefault(); cw.getSelection()?.removeAllRanges(); stDragTo(e.screenX, e.screenY);
  }, true);
  const end = () => { if (!h) return; clearTimeout(h.t); const was = h.on; h = null; doc.documentElement.classList.remove("stgrab"); if (was) stDrop(); };
  doc.addEventListener("pointerup", end, true); doc.addEventListener("pointercancel", end, true);
  doc.addEventListener("selectstart", (e) => { if (h?.on) e.preventDefault(); }, true);
  const st = doc.createElement("style"); st.textContent = "html.stgrab, html.stgrab * { cursor: grabbing !important; user-select: none !important; }"; doc.head.appendChild(st);
}


/* ------------------------------------------------ 所有对话 are the sidebar: on the stage a click opens one as a window,
   a drag (past a few pixels, so a click is never taken for one) puts it beside a window as a wired-in reference */
function stRailGrab(e, key) {
  const x = recentItems().find((y) => y.item === key); if (!x) return;
  const n = { id: stId(), type: "conv", key, title: x.title, win: null, fresh: true }; ST.nodes.push(n); stRender();
  const el = document.querySelector(`.stnode[data-nid="${n.id}"]`), r = $("#starena").getBoundingClientRect();
  el.hidden = false; el.classList.remove("tab"); el.style.left = e.clientX - r.left - ST_CW / 2 + "px"; el.style.top = e.clientY - r.top - ST_CH / 2 + "px"; el.style.width = ST_CW + "px"; el.style.height = ST_CH + "px";
  stGrab(n, e.screenX, e.screenY); ST.drag.fromList = true; ST.drag.moved = true;
}
document.addEventListener("pointerdown", (e) => {
  if (S.view !== "stage" || e.button !== 0) return;
  const it = e.target.closest("#clist [data-ritem]"); if (!it) return;
  ST.rp = { key: it.dataset.ritem, x: e.clientX, y: e.clientY, card: false };
}, true);
document.addEventListener("pointermove", (e) => {
  const p = ST.rp; if (!p) return;
  if (!p.card) { if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 8) return; p.card = true; window.getSelection()?.removeAllRanges(); stRailGrab(e, p.key); return; }
  e.preventDefault(); if (ST.drag) { const r = $("#starena").getBoundingClientRect(), d = ST.drag;
    d.el.style.left = e.clientX - r.left - ST_CW / 2 + "px"; d.el.style.top = e.clientY - r.top - ST_CH / 2 + "px"; stWires(); }
}, true);
document.addEventListener("pointerup", (e) => {
  const p = ST.rp; if (!p) return; ST.rp = null; ST.rpClick = true;
  if (p.card) stDrop(); else stOpen(p.key);
}, true);
document.addEventListener("click", (e) => {                     // the sidebar's own click (open in the chats page) is not wanted here
  if (ST.rpClick && e.target.closest("#clist [data-ritem]")) { e.stopPropagation(); e.preventDefault(); }
  ST.rpClick = false;
}, true);

/* the side panel inside a window: the conversation page's own right panel (environment, context, world tree) */
function stSide(n) {
  const f = document.querySelector(`.stnode[data-nid="${n.id}"] iframe`); try { f.contentDocument.documentElement.classList.toggle("eside", n.side !== false); f.contentWindow.renderChat?.(); } catch {}
}

/* ------------------------------------------------ moving: a card to another window or the shelf; a window along the row */
function stGrab(n, sx, sy) {
  const e = document.querySelector(`.stnode[data-nid="${n.id}"]`); if (!e) return;
  ST.drag = { n, el: e, sx, sy, l0: parseFloat(e.style.left), t0: parseFloat(e.style.top), moved: false };
  e.classList.add("held"); $("#vStage").classList.add("dragging");
  if (n.type === "win") {                          // where everything else stands now: they make way from here
    const mine = new Set([n.id, ...ST.nodes.filter((x) => x.win === n.id).map((x) => x.id)]);
    ST.drag.others = [...document.querySelectorAll("#stnodes > .stnode, #stbars > .sttab")].filter((x) => !x.hidden && !mine.has(x.dataset.nid))
      .map((x) => ({ el: x, x: parseFloat(x.style.left), w: x.offsetWidth, win: x.classList.contains("t-win") ? x.dataset.nid : x.dataset.stunfold }));
  }
}
function stDragTo(sx, sy) {
  const d = ST.drag; if (!d) return;
  if (Math.hypot(sx - d.sx, sy - d.sy) > 4) d.moved = true;
  const A = stArena(), w = d.el.offsetWidth;
  const lo = d.n.type === "win" ? -w * 0.6 : 0, hi = d.n.type === "win" ? A.w - w * 0.4 : A.w - w;   // a window may hang over the edge while it moves
  const l = Math.max(lo, Math.min(hi, d.l0 + sx - d.sx)); d.el.style.left = l + "px";
  if (d.n.type !== "win") d.el.style.top = Math.max(0, Math.min(A.h - d.el.offsetHeight, d.t0 + sy - d.sy)) + "px";
  if (d.n.type === "win") {
    const room = w + ST_GAP;                       // once it passes the middle of something, that slides over to the place it left
    for (const o of d.others || []) {
      const dx = o.x > d.l0 ? (l + w > o.x + o.w / 2 ? -room : 0) : (l < o.x + o.w / 2 ? room : 0);
      if (dx !== o.dx) { o.dx = dx; o.el.style.transform = dx ? `translateX(${dx}px)` : ""; }
    }
    const me = ST.pos?.get(d.n.id);                // its wired cards come along, keeping their place beside it
    if (me) { const dx = l - me.x; me.x = l;
      for (const n of ST.nodes) { if (n.win !== d.n.id) continue; const p = ST.pos.get(n.id), e = document.querySelector(`.stnode[data-nid="${n.id}"]`); if (!p || !e || e.hidden) continue; p.x += dx; e.style.left = p.x + "px"; } }
    for (const o of d.others || []) { const p = ST.pos?.get(o.el.dataset.nid || o.win); if (p) p.x = o.x + (o.dx || 0); }   // wires follow them
  }
  stWires();
}
function stSettle(d) {                             // a window let go: it takes the place among the windows where it was dropped
  const cx = parseFloat(d.el.style.left) + d.el.offsetWidth / 2, wins = stWins();
  const centre = new Map();
  for (const o of d.others || []) if (o.win && wins.some((x) => x.id === o.win) && !centre.has(o.win)) centre.set(o.win, o.x + o.w / 2);
  const rest = wins.filter((x) => x !== d.n), at = rest.filter((x) => centre.has(x.id) ? centre.get(x.id) < cx : wins.indexOf(x) < wins.indexOf(d.n)).length;
  rest.splice(at, 0, d.n); rest.forEach((o, k) => { o.ord = k; });
  for (const o of d.others || []) o.el.style.transform = "";
}
function stDrop(sx) {
  const d = ST.drag; ST.drag = null; $("#vStage").classList.remove("dragging"); if (!d) return null; d.el.classList.remove("held");
  if (d.moved && d.n.type !== "win") {          // whose column is it over: that window's (or the window itself); the shelf unwires it
    const r = $("#starena").getBoundingClientRect(), cx = parseFloat(d.el.style.left) + ST_CW / 2;
    let best = null, bd = Infinity;
    for (const u of ST.units || []) { if (u.hide || u.x == null || (d.fromList && u.kind === "shelf")) continue;
      const w = u.open ? u.w : ST_TAB, c = u.x + w / 2, dd = cx >= u.x && cx <= u.x + w && u.kind === "win" ? -1 : Math.abs(cx - c);   // over a window: that one
      if (dd < bd) { bd = dd; best = u; } }
    d.n.win = !best || ["shelf", "list"].includes(best.kind) ? null : best.win.id;
    d.n.fy = parseFloat(d.el.style.top) / stArena().h;                                   // it stays at the height you dropped it
    if (d.fromList && !d.n.win) ST.nodes = ST.nodes.filter((x) => x !== d.n);         // put back into the list: nothing made
  }
  if (d.n.type === "win") stSettle(d);
  if (d.fromList && !d.moved) { ST.nodes = ST.nodes.filter((x) => x !== d.n); stRender(); stOpen(d.n.key); return null; }
  stRender(); stSave(); stContexts(); return d;
}

/* ------------------------------------------------ pulling a wire from a pin: a card into a window, or one window into another */
function stWireStart(e, pin) {
  const node = ST.nodes.find((x) => x.id === pin.closest(".stnode")?.dataset.nid); if (!node) return false;
  const r = $("#starena").getBoundingClientRect(), b = pin.getBoundingClientRect(), x0 = b.left + b.width / 2 - r.left, y0 = b.top + b.height / 2 - r.top;
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
  if (n.type === "conv") return `Another conversation of the user, «${n.title || stTitle(n.key)}»: ${n.sub || ""}`;
  if (n.type === "topic") return `World-tree topic «${n.title}»: ${n.sub || ""}`;
  return "";
}
ST.lt = {};                                       // what another window hands over through a wire, fetched once per conversation
function stLinkText(l) {
  const a = ST.nodes.find((x) => x.id === l.from); if (!a?.key) return "";
  const c = ST.lt[a.key]; if (c === undefined) { ST.lt[a.key] = null; api(`/v1/users/${S.uid}/chats/${encodeURIComponent(a.key)}/context`).then((r) => { ST.lt[a.key] = r; stContexts(); }).catch(() => { delete ST.lt[a.key]; }); return ""; }
  if (!c) return ""; const t = stTitle(a.key), x = c.context || {};
  if (l.pin === 0) return `Another conversation of the user, «${t}». What was asked there:\n` + (c.questions || []).slice(-15).map((q) => `- ${String(q.text || "").slice(0, 300)}`).join("\n");
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
  }
  ST.focus = n.id; stRender(); stSave(); stContexts();
  document.querySelector(`.stnode[data-nid="${n.id}"]`)?.animate?.([{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }], { duration: 260 });
  return n;
}
function stFocus(id, render) { if (ST.focus === id && !render) return; ST.focus = id; if (render) stRender(); else document.querySelectorAll(".stnode.t-win").forEach((el) => el.classList.toggle("focus", el.dataset.nid === id)); }
function stMin(n) {                               // the window folds into a conversation card, wired into the window it sits next to
  const wins = stWins(), i = wins.indexOf(n), next = wins[i + 1] || wins[i - 1];
  ST.nodes = ST.nodes.filter((x) => x !== n); if (n.key) ST.nodes.push({ id: stId(), type: "conv", key: n.key, title: stTitle(n.key), win: next?.id || null });
  if (ST.focus === n.id) ST.focus = next?.id || null; stRender(); stSave(); stContexts();
}
function stClose(n) { ST.nodes = ST.nodes.filter((x) => x !== n); if (ST.focus === n.id) ST.focus = stWins()[0]?.id || null; stRender(); stSave(); stContexts(); }
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
  const r = $("#starena").getBoundingClientRect(), x = sx - r.left;
  let best = null, bd = Infinity; for (const u of ST.units || []) { if (u.hide || u.x == null) continue; const c = u.x + (u.open ? u.w : ST_TAB) / 2, d = Math.abs(x - c); if (d < bd) { bd = d; best = u; } }
  const win = best && best.kind !== "shelf" ? best.win : null, at = { win: win?.id || null };
  document.querySelector(".stmenu")?.remove();
  const m = document.createElement("div"); m.className = "cvpal cvmenu stmenu card"; m.style.left = Math.min(sx, innerWidth - 260) + "px"; m.style.top = Math.min(sy, innerHeight - 330) + "px";
  m.innerHTML = `<div class="stmh">${win ? L(`连给「${esc(stTitle(win.key).slice(0, 18))}」`, `Into “${esc(stTitle(win.key).slice(0, 20))}”`) : L("放在未连接的架子上", "On the unwired shelf")}</div>`
    + [["conv", "💬", 0], ["topic", "🌳", 0], ["doc", "📚", 1], ["file", "📎", 1], ["note", "📝", 1], ["skill", "✦", 2], ["win", "▢"]].map(([t, i, p]) => `<button data-stadd="${t}">${i} ${t === "win" ? L("新对话窗口", "New conversation window") : L(...ST_T[t].slice(0, 2)) + (t === "note" ? "" : "…")}${p != null ? `<em>${L(...ST_PINS[p])}</em>` : ""}</button>`).join("");
  m.dataset.at = JSON.stringify(at); document.body.appendChild(m);
}
async function stAdd(type, at) {
  if (type === "win") { const n = stOpen(null, at); return n; }
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
  arena.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return; document.querySelector(".stmenu")?.remove();
    const pin = e.target.closest(".stin, .stout, .stpin"); if (pin && stWireStart(e, pin)) { stCap(e); return; }
    const rz = e.target.closest("[data-rz]");
    if (rz) { e.preventDefault(); window.getSelection()?.removeAllRanges();     // no selecting the page while you pull an edge
      const n = ST.nodes.find((x) => x.id === rz.closest(".stnode").dataset.nid), el = rz.closest(".stnode"), l = parseFloat(el.style.left);
      ST.rz = { n, d: rz.dataset.rz, x: e.clientX, w0: n.bw || el.offsetWidth, edge: rz.dataset.rz === "e" ? l : l + el.offsetWidth,
        open: new Map((ST.units || []).map((u) => [u.kind + (u.win?.id || ""), u.open])) };   // the edge that stays
      v.classList.add("dragging", "resizing"); stCap(e); return; }
    if (e.target.closest("button, textarea, input, iframe, [data-doc], [data-stunfold]")) return;
    const el = e.target.closest(".stnode"); if (!el) return;
    const n = ST.nodes.find((x) => x.id === el.dataset.nid); if (!n || n.max || (n.type === "win" && !e.target.closest(".stwh"))) return;
    if (n.type === "win") stFocus(n.id); stGrab(n, e.screenX, e.screenY); stCap(e);
  });
  arena.addEventListener("pointermove", (e) => {
    if (ST.rz) { const r = ST.rz, dx = e.clientX - r.x; r.n.bw = Math.round(Math.max(320, Math.min(stArena().w - 80, r.w0 + (r.d === "e" ? dx : -dx))));
      const lay = stLayout(), u = lay.units.find((x) => x.kind === "win" && x.win === r.n);           // only the edge you pull moves
      if (u && u.open) ST.shift = lay.off + r.edge - (r.d === "e" ? u.x : u.x + u.w);
      stRender(); return; }
    if (ST.wire) { const r = arena.getBoundingClientRect(); ST.wire.x = e.clientX - r.left; ST.wire.y = e.clientY - r.top; stWires(); return; }
    if (ST.drag) stDragTo(e.screenX, e.screenY);
  });
  arena.addEventListener("pointerup", (e) => {
    if (ST.wire) { stWireEnd(e.clientX, e.clientY); return; }
    if (ST.rz) { ST.rz = null; v.classList.remove("dragging", "resizing"); stSave(); return; }
    const d = stDrop(); if (d && !d.moved && d.n.type === "conv") stOpen(d.n.key, { win: d.n.win });
    else if (d && !d.moved && d.el.classList.contains("tab") && d.n.win) stFocus(d.n.win, true);
  });
  arena.addEventListener("dblclick", (e) => { const rz = e.target.closest("[data-rz]"); if (rz) { const n = ST.nodes.find((x) => x.id === rz.closest(".stnode").dataset.nid); delete n.bw; ST.shift = null; stRender(); stSave(); } });
  arena.addEventListener("input", (e) => { const t = e.target.closest("[data-stnote]"); if (!t) return; const n = ST.nodes.find((x) => x.id === t.dataset.stnote); if (n) { n.text = t.value; stContexts(); } });
}
document.addEventListener("click", (e) => {
  if (S.view !== "stage") return;
  if (!e.target.closest(".stmenu")) document.querySelector(".stmenu")?.remove();
  const add = e.target.closest("[data-stadd]"); if (add) { const m = add.closest(".stmenu"), at = JSON.parse(m.dataset.at); m.remove(); stAdd(add.dataset.stadd, at); return; }
  const uf = e.target.closest("[data-stunfold]"); if (uf) { const id = uf.dataset.stunfold; if (id === "shelf") { const w = stWins(); for (const o of w) o.bw = Math.min(o.bw || ST_WW, ST_WW); } else stFocus(id, true); return; }
  const cut = e.target.closest("[data-unlink]"); if (cut) { const [to, from, pin] = cut.dataset.unlink.split("|"), w = ST.nodes.find((x) => x.id === to); if (w) w.links = (w.links || []).filter((l) => !(l.from === from && l.pin === Number(pin))); stRender(); stSave(); stContexts(); return; }
  const del = e.target.closest("[data-stdel]"); if (del) { ST.nodes = ST.nodes.filter((x) => x.id !== del.dataset.stdel); stRender(); stSave(); stContexts(); return; }
  const w = e.target.closest("[data-stw]"); if (w) { const n = ST.nodes.find((x) => x.id === w.closest(".stnode").dataset.nid); if (!n) return;
    if (w.dataset.stw === "side") { n.side = n.side === false; w.classList.toggle("on", n.side); stSide(n); stSave(); return; }
    if (w.dataset.stw === "min") stMin(n); else if (w.dataset.stw === "close") stClose(n); else stMax(n, !n.max); return; }
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
  const r = _showBK(view, opts); stBackBtn(view); return r;
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
const _renderRailST = renderRail;
renderRail = function () { _renderRailST(); $("#toStage")?.classList.toggle("on", S.view === "stage"); $("#toChatsPage")?.classList.toggle("on", S.view === "chats"); };
