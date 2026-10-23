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

const ST = { nodes: [], focus: null, drag: null, q: "", list: (() => { try { return localStorage.getItem("pga_st_list") !== "0"; } catch { return true; } })() };
const ST_GAP = 18, ST_CW = 190, ST_CH = 78, ST_WW = 660, ST_BAR = 34, ST_PADX = 12, ST_LW = 240;
const ST_T = {
  world: ["世界知识", "World knowledge", "#6fa8ff"], self: ["自我知识", "Self knowledge", "#e9b35f"], note: ["笔记", "Note", "#a1a1aa"],
  skill: ["技能", "Skill", "#e9b35f"], doc: ["资料", "Document", "#7fcf9f"], file: ["文件", "File", "#5fc9c0"], conv: ["对话", "Conversation", "#8fb4ff"],
  topic: ["世界树主题", "Topic", "#d6a75c"], win: ["对话窗口", "Window", "#8fb4ff"] };
const ST_PIN = (n) => (["conv", "topic"].includes(n.type) ? 0 : n.type === "skill" ? 2 : 1);      // which input: conversations, data, skills
const ST_PINS = [["对话引用", "Conversations"], ["数据引用", "Data"], ["技能引用", "Skills"]];
const stTitle = (key) => (key ? recentItems().find((x) => x.item === key)?.title || S.chats?.find((c) => c.key === key)?.title || key : L("新对话", "New chat"));
const stId = () => Math.random().toString(36).slice(2, 9);
const stArena = () => { const a = $("#starena"); return a ? { w: a.clientWidth, h: a.clientHeight } : { w: 1000, h: 700 }; };
const stWins = () => ST.nodes.filter((n) => n.type === "win").sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
function stSave() { try { localStorage.setItem("pga_st3", JSON.stringify({ nodes: ST.nodes.map(({ max, sent, ...n }) => n) })); } catch {} }

/* ------------------------------------------------ the page */
function showStage() {
  document.title = "PGA";
  const v = $("#vStage");
  if (!v.dataset.ready) {
    v.dataset.ready = "1";
    v.innerHTML = `<div class="stground"></div><div class="stbar card" id="stbar"></div>
      <div class="starena" id="starena"><svg class="stwires" id="stwires"></svg><div id="stnodes"></div><div id="stbars"></div></div>`;
    let saved = null; try { saved = JSON.parse(localStorage.getItem("pga_st3") || "null"); } catch {}
    if (saved?.nodes?.length) ST.nodes = saved.nodes; else stDefault();
    ST.focus = stWins()[0]?.id || null;
    stBind(); new ResizeObserver(() => stRender()).observe($("#starena"));
  }
  stBar(); stRender(); stContexts();
}
function stDefault() {                            // the latest two conversations; world and self knowledge wired into the first
  recentItems().slice(0, 2).forEach((r, i) => ST.nodes.push({ id: stId(), type: "win", key: r.item, ord: i }));
  const first = ST.nodes[0]?.id || null;
  ST.nodes.push({ id: "world", type: "world", win: first }, { id: "self", type: "self", win: first });
}

/* ------------------------------------------------ the layout: a row that always fits the screen */
function stLayout() {
  const A = stArena(), wins = stWins(), ids = new Set(wins.map((w) => w.id));
  for (const n of ST.nodes) if (n.type !== "win" && n.win && !ids.has(n.win)) n.win = null;       // its window is gone: back on the shelf
  const shelf = ST.nodes.filter((n) => n.type !== "win" && !n.win);
  const units = [{ kind: "list", w: ST_LW, open: ST.list }];
  if (shelf.length) units.push({ kind: "shelf", nodes: shelf, w: ST_CW, open: true });
  for (const w of wins) { const col = ST.nodes.filter((n) => n.win === w.id); units.push({ kind: "col", win: w, nodes: col, w: ST_CW, open: true, hide: !col.length }); units.push({ kind: "win", win: w, w: w.bw || ST_WW, open: true }); }
  const width = () => units.filter((u) => !u.hide).reduce((t, u) => t + (u.open ? u.w : ST_BAR) + ST_GAP, -ST_GAP);
  const room = A.w - 2 * ST_PADX, fi = Math.max(0, wins.findIndex((w) => w.id === ST.focus));
  // too wide: fold the shelf, then the other windows' columns, then the other windows, farthest from the one you are on first
  const fold = (pred) => { for (const u of units.filter(pred)) { if (width() <= room) return; u.open = false; } };
  if (width() > room) fold((u) => u.kind === "shelf");
  if (width() > room) fold((u) => u.kind === "col" && u.win.id !== ST.focus);
  if (width() > room && !ST.listPin) fold((u) => u.kind === "list");      // opened from its bar: it stays, the other windows fold first
  const far = units.filter((u) => u.kind === "win" && u.win.id !== ST.focus).sort((a, b) => Math.abs(wins.indexOf(b.win) - fi) - Math.abs(wins.indexOf(a.win) - fi));
  for (const u of far) { if (width() <= room) break; u.open = false; const c = units.find((x) => x.kind === "col" && x.win === u.win); if (c) c.hide = true; }
  if (width() > room) fold((u) => u.kind === "col");
  if (width() > room) fold((u) => u.kind === "list");
  let x = ST_PADX + Math.max(0, (room - width()) / 2);
  for (const u of units) { if (u.hide) continue; u.x = x; x += (u.open ? u.w : ST_BAR) + ST_GAP; }
  return { units, A };
}

/* ------------------------------------------------ drawing */
function stWinHtml(n) {
  return `<div class="stwin">${["e", "w"].map((d) => `<i class="rz rz-${d}" data-rz="${d}" title="${L("拖动改宽度，双击还原", "Drag to change the width, double-click to reset")}"></i>`).join("")}
    <div class="stwh" data-stfocus="${n.id}"><b class="stwt">${esc(stTitle(n.key))}</b><em class="stctxn" data-stctxn="${n.id}"></em><span class="grow"></span>
      <button class="stb ${n.side === false ? "" : "on"}" data-stw="side" title="${L("右侧栏：环境、上下文、世界树", "Side panel: environment, context, world tree")}">◧</button><button class="stb" data-stw="min" title="${L("收成一张对话卡片", "Fold into a conversation card")}">–</button><button class="stb" data-stw="max" title="${L("最大化（Esc 还原）", "Maximise (Esc restores)")}">▢</button><button class="stb" data-stw="close" title="${L("关掉这个窗口（对话还在）", "Close the window (the conversation stays)")}">×</button></div>
    <iframe title="conversation"></iframe></div>${ST_PINS.map((p, i) => `<i class="stin" style="top:${(i * 2 + 1) / 6 * 100}%" data-pin="${i}" title="${L(...p)}"></i>`).join("")}`;
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
    <i class="stpin r"></i>`;
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
  let barHtml = ""; const pos = new Map();
  for (const u of units) {
    if (u.kind === "list") { stList(u, A); if (!u.open) barHtml += `<div class="stfold list" style="left:${u.x}px;height:${A.h - 16}px" data-stunfold="list"><span>${L("所有对话", "All conversations")}</span></div>`; continue; }
    if (u.kind === "win") {
      const e = el(u.win); u.win.el = e;
      if (u.hide || !u.open) { place(e, -9999, 0, u.w, A.h, false); if (!u.hide) barHtml += `<div class="stfold win" style="left:${u.x}px;height:${A.h - 16}px" data-stunfold="${u.win.id}" title="${esc(stTitle(u.win.key))}"><span>${esc(stTitle(u.win.key).slice(0, 40))}</span></div>`; continue; }
      place(e, u.x, 8, u.w, A.h - 16); e.classList.toggle("focus", u.win.id === ST.focus);
      e.classList.toggle("hascol", units.some((c) => c.kind === "col" && c.win === u.win && !c.hide && c.open));      // its column covers the input labels
      pos.set(u.win.id, { x: u.x, y: 8, h: A.h - 16 }); continue;
    }
    const zones = [[], [], []]; u.nodes.forEach((n) => zones[u.kind === "shelf" ? 1 : ST_PIN(n)].push(n));
    if (u.hide || !u.open) { u.nodes.forEach((n) => place(el(n), -9999, 0, ST_CW, ST_CH, false)); if (!u.hide && u.nodes.length) barHtml += `<div class="stfold" style="left:${u.x}px;height:${A.h - 16}px" data-stunfold="${u.kind === "shelf" ? "shelf" : u.win.id}"><span>${u.kind === "shelf" ? L(`未连接 ${u.nodes.length}`, `${u.nodes.length} unwired`) : L(`${u.nodes.length} 个上下文`, `${u.nodes.length} in context`)}</span></div>`; continue; }
    const zh = (A.h - 16) / 3;                    // three bands, each beside its input
    zones.forEach((zn, zi) => {
      const ch = Math.max(46, Math.min(ST_CH, (zh - 10) / Math.max(1, zn.length) - 8)), tot = zn.length * (ch + 8) - 8;
      let y = 8 + zi * zh + Math.max(4, (zh - tot) / 2);
      for (const n of zn) { const e = el(n); e.classList.toggle("short", ch < 66); e.classList.toggle("shelved", u.kind === "shelf"); place(e, u.x, y, ST_CW, ch); pos.set(n.id, { x: u.x, y, h: ch, zone: zi, win: u.win?.id }); y += ch + 8; }
    });
    if (u.kind === "shelf") barHtml += `<div class="stshelf" style="left:${u.x - 4}px;width:${ST_CW + 8}px;height:${A.h - 8}px"><em>${L("未连接", "Unwired")}</em></div>`;
  }
  bars.innerHTML = barHtml;
  ST.pos = pos; ST.units = units;
  stWires();
}
function stWires() {                              // each card into the input of its band on its window's left edge
  const svg = $("#stwires"); if (!svg || !ST.pos) return; let h = "";
  for (const n of ST.nodes) {
    if (n.type === "win" || !n.win) continue; const p = ST.pos.get(n.id), w = ST.pos.get(n.win); if (!p || !w || ST.drag?.n === n) continue;
    const x0 = p.x + ST_CW, y0 = p.y + p.h / 2, x1 = w.x, y1 = w.y + w.h * (p.zone * 2 + 1) / 6, mx = (x0 + x1) / 2;
    h += `<path class="stwire z${p.zone}" d="M ${x0} ${y0} C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1}"/><circle class="stball z${p.zone}" cx="${x0}" cy="${y0}" r="5"/>`;
  }
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


/* ------------------------------------------------ all conversations, at the left: click one to open it as a window, drag it
   beside a window to wire it in as a reference */
function stList(u, A) {
  let box = $("#stlist");
  if (!box) { $("#starena").insertAdjacentHTML("beforeend", `<aside class="stlist card" id="stlist"><div class="stlh"><b>${L("所有对话", "All conversations")}</b><span class="grow"></span><button class="stb" data-stlistfold title="${L("收起", "Fold")}">«</button></div><input id="stlq" placeholder="${L("搜对话…", "Search…")}"><div class="stli" id="stli"></div></aside>`); box = $("#stlist");
    $("#stlq").addEventListener("input", (e) => { ST.q = e.target.value.toLowerCase(); stListItems(); }); }
  box.hidden = !u.open; if (!u.open) return;
  box.style.left = u.x + "px"; box.style.height = A.h - 16 + "px";
  if (box.dataset.n !== String(recentItems().length) + ST.nodes.filter((n) => n.type === "win").map((n) => n.key).join()) stListItems();
}
function stListItems() {
  const box = $("#stli"); if (!box) return;
  const open = new Set(ST.nodes.filter((n) => n.type === "win").map((n) => n.key)), wired = new Set(ST.nodes.filter((n) => n.type === "conv").map((n) => n.key));
  const xs = recentItems().filter((x) => !ST.q || (x.title || "").toLowerCase().includes(ST.q)).slice(0, 300);
  let day = "";
  box.innerHTML = xs.map((x) => { const g = dayGroup(x.last); const head = g !== day ? `<div class="stlg">${esc((day = g))}</div>` : "";
    return head + `<div class="stlr ${open.has(x.item) ? "open" : ""} ${wired.has(x.item) ? "wired" : ""}" data-stli="${esc(x.item)}" title="${esc(x.title || "")}"><b>${esc((x.title || x.item).slice(0, 60))}</b><em>${esc(agentLabel(x.agent || ""))} · ${esc(ago(x.last))}</em></div>`; }).join("")
    || `<div class="cvdim" style="padding:8px">${L("没有找到", "Nothing found")}</div>`;
  $("#stlist").dataset.n = String(recentItems().length) + ST.nodes.filter((n) => n.type === "win").map((n) => n.key).join();
}
function stListGrab(e, key) {                     // dragging a conversation out of the list: a card that follows the pointer
  const x = recentItems().find((y) => y.item === key); if (!x) return;
  const n = { id: stId(), type: "conv", key, title: x.title, win: null, fresh: true }; ST.nodes.push(n); stRender();
  const el = document.querySelector(`.stnode[data-nid="${n.id}"]`), r = $("#starena").getBoundingClientRect();
  el.hidden = false; el.style.left = e.clientX - r.left - ST_CW / 2 + "px"; el.style.top = e.clientY - r.top - ST_CH / 2 + "px"; el.style.width = ST_CW + "px"; el.style.height = ST_CH + "px";
  stGrab(n, e.screenX, e.screenY); ST.drag.fromList = true;
}

/* the side panel inside a window: the conversation page's own right panel (environment, context, world tree) */
function stSide(n) {
  const f = document.querySelector(`.stnode[data-nid="${n.id}"] iframe`); try { f.contentDocument.documentElement.classList.toggle("eside", n.side !== false); f.contentWindow.renderChat?.(); } catch {}
}

/* ------------------------------------------------ moving: a card to another window or the shelf; a window along the row */
function stGrab(n, sx, sy) {
  const e = document.querySelector(`.stnode[data-nid="${n.id}"]`); if (!e) return;
  ST.drag = { n, el: e, sx, sy, l0: parseFloat(e.style.left), t0: parseFloat(e.style.top), moved: false };
  e.classList.add("held"); $("#vStage").classList.add("dragging");
}
function stDragTo(sx, sy) {
  const d = ST.drag; if (!d) return;
  if (Math.hypot(sx - d.sx, sy - d.sy) > 4) d.moved = true;
  const A = stArena(), w = d.el.offsetWidth;
  const l = Math.max(0, Math.min(A.w - w, d.l0 + sx - d.sx)); d.el.style.left = l + "px";
  if (d.n.type !== "win") d.el.style.top = Math.max(0, Math.min(A.h - d.el.offsetHeight, d.t0 + sy - d.sy)) + "px";
  if (d.n.type === "win") {                       // passing the middle of another window: they swap places, the others slide aside
    const wins = stWins(), cx = l + w / 2, i = wins.indexOf(d.n);
    const j = wins.findIndex((o) => o !== d.n && o.el && !o.el.hidden && Math.abs(cx - (parseFloat(o.el.style.left) + o.el.offsetWidth / 2)) < o.el.offsetWidth / 3);
    if (j >= 0) { wins.splice(i, 1); wins.splice(j, 0, d.n); wins.forEach((o, k) => { o.ord = k; }); stRender(); }
  }
  stWires();
}
function stDrop(sx) {
  const d = ST.drag; ST.drag = null; $("#vStage").classList.remove("dragging"); if (!d) return null; d.el.classList.remove("held");
  if (d.moved && d.n.type !== "win") {          // whose column is it over: that window's (or the window itself); the shelf unwires it
    const r = $("#starena").getBoundingClientRect(), cx = parseFloat(d.el.style.left) + ST_CW / 2;
    let best = null, bd = Infinity;
    for (const u of ST.units || []) { if (u.hide || u.x == null) continue; const w = u.open ? u.w : ST_BAR, c = u.x + w / 2, dd = Math.abs(cx - c); if (dd < bd) { bd = dd; best = u; } }
    d.n.win = !best || ["shelf", "list"].includes(best.kind) ? null : best.win.id;
    if (d.fromList && !d.n.win) ST.nodes = ST.nodes.filter((x) => x !== d.n);         // put back into the list: nothing made
  }
  if (d.fromList && !d.moved) { ST.nodes = ST.nodes.filter((x) => x !== d.n); stRender(); stOpen(d.n.key); return null; }
  stRender(); stSave(); stContexts(); return d;
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
function stContexts() {                          // send each window's wired-in context to its conversation, when it changed
  clearTimeout(ST.ct); ST.ct = setTimeout(() => {
    for (const w of stWins()) {
      const ctx = stContextOf(w), text = ctx.map(stNodeText).filter(Boolean).join("\n\n");
      const c = document.querySelector(`[data-stctxn="${w.id}"]`); if (c) c.textContent = ctx.length ? L(`← ${ctx.length} 个上下文`, `← ${ctx.length} in context`) : "";
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
  let best = null, bd = Infinity; for (const u of ST.units || []) { if (u.hide || u.x == null) continue; const c = u.x + (u.open ? u.w : ST_BAR) / 2, d = Math.abs(x - c); if (d < bd) { bd = d; best = u; } }
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
  bar.innerHTML = `<span class="cvdim">${L("左边是所有对话：点一下开成窗口，拖到某个窗口旁就成为它的引用 · 右键加节点 · 放不下的折成两边的竖条", "All conversations at the left: click to open, drag beside a window to wire it in · right-click to add · what does not fit folds into bars")}</span>
    <span class="grow"></span><button class="sm" data-st="new">＋ ${L("新对话", "New chat")}</button>`;
}

/* ------------------------------------------------ pointer */
function stCap(e) { try { $("#starena").setPointerCapture(e.pointerId); } catch {} }
function stBind() {
  const v = $("#vStage"), arena = $("#starena");
  arena.addEventListener("contextmenu", (e) => { if (e.target.closest(".stwin")) return; e.preventDefault(); stMenu(e.clientX, e.clientY); });
  arena.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return; document.querySelector(".stmenu")?.remove();
    const rz = e.target.closest("[data-rz]");
    if (rz) { const n = ST.nodes.find((x) => x.id === rz.closest(".stnode").dataset.nid); ST.rz = { n, d: rz.dataset.rz, x: e.clientX, w0: n.bw || ST_WW }; v.classList.add("dragging"); stCap(e); return; }
    if (e.target.closest("button, textarea, input, iframe, [data-doc], [data-stunfold]")) return;
    const li = e.target.closest("[data-stli]"); if (li) { stListGrab(e, li.dataset.stli); stCap(e); return; }
    const el = e.target.closest(".stnode"); if (!el) return;
    const n = ST.nodes.find((x) => x.id === el.dataset.nid); if (!n || n.max || (n.type === "win" && !e.target.closest(".stwh"))) return;
    if (n.type === "win") stFocus(n.id); stGrab(n, e.screenX, e.screenY); stCap(e);
  });
  arena.addEventListener("pointermove", (e) => {
    if (ST.rz) { const r = ST.rz, dx = e.clientX - r.x; r.n.bw = Math.round(Math.max(320, Math.min(stArena().w - 80, r.w0 + (r.d === "e" ? dx : -dx)))); stRender(); return; }
    if (ST.drag) stDragTo(e.screenX, e.screenY);
  });
  arena.addEventListener("pointerup", () => {
    if (ST.rz) { ST.rz = null; v.classList.remove("dragging"); stSave(); return; }
    const d = stDrop(); if (d && !d.moved && d.n.type === "conv") stOpen(d.n.key, { win: d.n.win });
  });
  arena.addEventListener("dblclick", (e) => { const rz = e.target.closest("[data-rz]"); if (rz) { const n = ST.nodes.find((x) => x.id === rz.closest(".stnode").dataset.nid); delete n.bw; stRender(); stSave(); } });
  arena.addEventListener("input", (e) => { const t = e.target.closest("[data-stnote]"); if (!t) return; const n = ST.nodes.find((x) => x.id === t.dataset.stnote); if (n) { n.text = t.value; stContexts(); } });
}
document.addEventListener("click", (e) => {
  if (S.view !== "stage") return;
  if (!e.target.closest(".stmenu")) document.querySelector(".stmenu")?.remove();
  const add = e.target.closest("[data-stadd]"); if (add) { const m = add.closest(".stmenu"), at = JSON.parse(m.dataset.at); m.remove(); stAdd(add.dataset.stadd, at); return; }
  if (e.target.closest("[data-stlistfold]")) { ST.list = false; ST.listPin = false; try { localStorage.setItem("pga_st_list", "0"); } catch {} stRender(); return; }
  const uf = e.target.closest("[data-stunfold]"); if (uf) { const id = uf.dataset.stunfold; if (id === "list") { ST.list = true; ST.listPin = true; try { localStorage.setItem("pga_st_list", "1"); } catch {} stRender(); $("#stlq")?.focus(); return; } if (id === "shelf") { const w = stWins(); for (const o of w) o.bw = Math.min(o.bw || ST_WW, ST_WW); } else stFocus(id, true); return; }
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
const _renderRailST = renderRail;
renderRail = function () { _renderRailST(); $("#toStage")?.classList.toggle("on", S.view === "stage"); $("#toChatsPage")?.classList.toggle("on", S.view === "chats"); };
