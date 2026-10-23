/* PGA app · the stage: an infinite canvas with one horizontal axis through the middle, like a blueprint.

   Everything you work with sits on the axis, left to right, wired in a line:
   - world knowledge and self knowledge (fixed size);
   - the conversation windows, always the full height of the app;
   - whatever you add with a right-click: a note, a skill, a document, a file, another conversation, a world-tree
     topic, a new window.
   What sits between a window and the window before it is that conversation's context: its agents read it with every
   question (PUT /chat-context). Drag a card in front of a window and it is in; drag it out and it is not.

   Off the axis (drag a card well above or below it) a card is just kept on the canvas, out of every context.
   Drag empty space to move along the canvas, scroll to move, ⌘ + scroll to zoom. Windows keep the full height at every
   zoom; their width is only what you drag their edges to. Nothing moves on its own: things push each other aside only
   while you move something, and a card dropped onto another settles beside it. */

const ST = { nodes: [], cam: { x: 0, y: 0, z: 1 }, focus: null, drag: null, raf: 0 };
const ST_GAP = 34, ST_CW = 176, ST_CH = 108, ST_WW = 420, ST_AXIS = 130;          // ST_AXIS: within this of the axis, a card is on it
const ST_T = {
  world: ["世界知识", "World knowledge", "#6fa8ff"], self: ["自我知识", "Self knowledge", "#e9b35f"], note: ["笔记", "Note", "#a1a1aa"],
  skill: ["技能", "Skill", "#e9b35f"], doc: ["资料", "Document", "#7fcf9f"], file: ["文件", "File", "#5fc9c0"], conv: ["对话", "Conversation", "#8fb4ff"],
  topic: ["世界树主题", "Topic", "#d6a75c"], win: ["对话窗口", "Window", "#8fb4ff"] };
const stTitle = (key) => (key ? recentItems().find((x) => x.item === key)?.title || S.chats?.find((c) => c.key === key)?.title || key : L("新对话", "New chat"));
const stId = () => Math.random().toString(36).slice(2, 9);
const stArena = () => { const a = $("#starena"); return a ? { w: a.clientWidth, h: a.clientHeight } : { w: 1000, h: 700 }; };
const stW = (n) => (n.type === "win" ? n.bw || ST_WW : ST_CW), stH = (n) => (n.type === "win" ? stArena().h / ST.cam.z - 8 / ST.cam.z : ST_CH);
const onAxis = (n) => n.type === "win" || Math.abs(n.y) < ST_AXIS;
function stSave() { try { localStorage.setItem("pga_st2", JSON.stringify({ nodes: ST.nodes.map(({ el, max, sent, ...n }) => n), cam: { x: ST.cam.x, z: ST.cam.z } })); } catch {} }     // a maximised window is not kept maximised

/* ------------------------------------------------ the page */
function showStage() {
  document.title = "PGA";
  const v = $("#vStage");
  if (!v.dataset.ready) {
    v.dataset.ready = "1";
    v.innerHTML = `<div class="stground" id="stground"></div><div class="stbar card" id="stbar"></div>
      <div class="starena" id="starena"><div class="stworld" id="stworld"><i class="staxis"></i><svg class="stwires" id="stwires"></svg><div id="stnodes"></div></div></div>`;
    let saved = null; try { saved = JSON.parse(localStorage.getItem("pga_st2") || "null"); } catch {}
    if (saved?.nodes?.length) { ST.nodes = saved.nodes.map(({ max, sent, ...n }) => n); ST.cam.x = saved.cam?.x ?? 40; ST.cam.z = saved.cam?.z || 1; }
    else stDefault();
    ST.focus = ST.nodes.find((n) => n.type === "win")?.id || null;
    stBind(); new ResizeObserver(() => stRender()).observe($("#starena"));
  }
  stBar(); stRender(); stContexts();
}
function stDefault() {                            // the two foundations, then the latest conversations, along the axis
  let x = ST_CW / 2 + 20;
  const put = (n) => { const w = stW(n); n.x = x + w / 2 - ST_CW / 2; x = n.x + w / 2 + ST_GAP + ST_CW / 2; ST.nodes.push(n); };
  put({ id: "world", type: "world", y: 0 }); put({ id: "self", type: "self", y: 0 });
  recentItems().slice(0, 2).forEach((r) => put({ id: stId(), type: "win", key: r.item, y: 0 }));
  ST.cam.x = 30; ST.cam.z = 1;
}

/* ------------------------------------------------ drawing */
function stApply() {
  const A = stArena(), w = $("#stworld"), g = $("#stground"); if (!w) return;
  ST.cam.y = A.h / 2;                             // the axis stays in the middle of the app
  w.style.transform = `translate(${ST.cam.x}px, ${ST.cam.y}px) scale(${ST.cam.z})`;
  const s = 24 * ST.cam.z; g.style.backgroundSize = `${s}px ${s}px`; g.style.backgroundPosition = `${ST.cam.x}px ${ST.cam.y}px`;
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
    <i class="stpin l"></i><i class="stpin r"></i>`;
}
function stWinHtml(n) {
  return `<div class="stwin">${["e", "w"].map((d) => `<i class="rz rz-${d}" data-rz="${d}" title="${L("拖动改宽度，双击还原", "Drag to change the width, double-click to reset")}"></i>`).join("")}
    <div class="stwh" data-stfocus="${n.id}"><b class="stwt">${esc(stTitle(n.key))}</b><em class="stctxn" data-stctxn="${n.id}"></em><span class="grow"></span>
      <button class="stb" data-stw="min" title="${L("最小化：变成一张对话卡片，留在原处", "Minimise: a card in its place")}">–</button><button class="stb" data-stw="max" title="${L("最大化（Esc 还原）", "Maximise (Esc restores)")}">▢</button><button class="stb" data-stw="close" title="${L("关掉这个窗口（对话还在）", "Close the window (the conversation stays)")}">×</button></div>
    <iframe title="conversation"></iframe></div><i class="stpin l"></i><i class="stpin r"></i>`;
}
function stRender() {
  const box = $("#stnodes"); if (!box) return; stApply();
  const keep = new Set(ST.nodes.map((n) => n.id));
  box.querySelectorAll(".stnode").forEach((el) => { if (!keep.has(el.dataset.nid)) el.remove(); });
  for (const n of ST.nodes) {
    let el = box.querySelector(`.stnode[data-nid="${n.id}"]`);
    if (!el) { el = document.createElement("div"); el.className = `stnode t-${n.type}`; el.dataset.nid = n.id; el.innerHTML = n.type === "win" ? stWinHtml(n) : stCardHtml(n); box.appendChild(el); if (n.type === "win") stFrame(n, el); }
    else if (n.type !== "win" && n.type !== "note" && el.dataset.sig !== (n.title || "") + (S.forest ? 1 : 0)) { el.innerHTML = stCardHtml(n); }
    el.dataset.sig = (n.title || "") + (S.forest ? 1 : 0);
    const w = stW(n), h = stH(n);
    el.style.width = w + "px"; el.style.height = h + "px"; el.style.left = n.x - w / 2 + "px"; el.style.top = (n.type === "win" ? -h / 2 : n.y - h / 2) + "px";
    el.classList.toggle("off", !onAxis(n)); el.classList.toggle("focus", n.id === ST.focus); el.classList.toggle("held", ST.drag?.n === n);
  }
  stWires();
}
function stWires() {                              // the wires along the axis, a pin at every end, flowing into each window
  const svg = $("#stwires"); if (!svg) return;
  const line = ST.nodes.filter(onAxis).sort((a, b) => a.x - b.x); let h = "";
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1], x0 = a.x + stW(a) / 2, x1 = b.x - stW(b) / 2, y0 = a.type === "win" ? 0 : a.y, y1 = b.type === "win" ? 0 : b.y;
    if (x1 <= x0) continue;
    const into = b.type === "win", from = a.type === "win", mx = (x0 + x1) / 2;
    h += `<path class="stwire ${into ? "into" : ""} ${from ? "from" : ""}" d="M ${x0} ${y0} C ${mx} ${y0}, ${mx} ${y1}, ${x1} ${y1}"/><circle class="stball" cx="${x0}" cy="${y0}" r="6"/><circle class="stball ${into ? "into" : ""}" cx="${x1}" cy="${y1}" r="6"/>`;
  }
  svg.innerHTML = h;
}
function stFrame(n, el) {
  const q = new URLSearchParams({ view: "chats", embed: "1" });
  if (n.key) { if (S.allChats?.some((c) => c.key === n.key) || n.key.startsWith("chat:")) q.set("c", n.key); else q.set("item", n.key); }
  if (AS_UID) q.set("as", AS_UID); if (Q.get("lang")) q.set("lang", Q.get("lang"));
  const f = el.querySelector("iframe"); f.src = "/?" + q;
  f.addEventListener("load", () => { try { stHold(f, n); } catch {} });
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

/* ------------------------------------------------ moving things: the others make way, only while you move */
function stGrab(n, sx, sy) { ST.drag = { n, sx, sy, x0: n.x, y0: n.y, moved: false }; $("#vStage").classList.add("dragging"); stRender(); }
function stDragTo(sx, sy) {
  const d = ST.drag; if (!d) return; const z = ST.cam.z;
  if (Math.hypot(sx - d.sx, sy - d.sy) > 4) d.moved = true;
  d.n.x = d.x0 + (sx - d.sx) / z; if (d.n.type !== "win") d.n.y = d.y0 + (sy - d.sy) / z;
  stPush(d.n); stRender();
}
function stDrop() {
  const d = ST.drag; ST.drag = null; $("#vStage").classList.remove("dragging"); if (!d) return null;
  if (d.n.type !== "win" && Math.abs(d.n.y) < ST_AXIS) d.n.y = 0;          // close to the axis: on it
  stPush(d.n, true); stRender(); stSave(); stContexts(); return d;
}
function stPush(moving, settle) {                 // overlaps are pushed apart sideways (on the axis) or every way (off it)
  for (let it = 0; it < (settle ? 30 : 6); it++) {
    let any = false;
    for (const a of ST.nodes) for (const b of ST.nodes) {
      if (a === b || a.id > b.id) continue;
      const ax = onAxis(a), bx = onAxis(b);
      const ah = a.type === "win" ? 1e6 : ST_CH, bh = b.type === "win" ? 1e6 : ST_CH;
      const ox = (stW(a) + stW(b)) / 2 + 18 - Math.abs(a.x - b.x), oy = (ah + bh) / 2 + 14 - Math.abs((a.type === "win" ? b.y : a.y) - (b.type === "win" ? a.y : b.y));
      if (ox <= 0 || oy <= 0 || (ax !== bx && a.type !== "win" && b.type !== "win")) continue;
      any = true;
      const fixedA = a === moving, fixedB = b === moving, dir = Math.sign(b.x - a.x || 1);
      if (ox <= oy || a.type === "win" || b.type === "win" || (ax && bx)) {
        if (fixedA) b.x += dir * ox; else if (fixedB) a.x -= dir * ox; else { a.x -= dir * ox / 2; b.x += dir * ox / 2; }
      } else { const dy = Math.sign(b.y - a.y || 1); if (fixedA) b.y += dy * oy; else if (fixedB) a.y -= dy * oy; else { a.y -= dy * oy / 2; b.y += dy * oy / 2; } }
    }
    if (!any) break;
  }
}

/* ------------------------------------------------ each window's context: what is wired in front of it */
function stContextOf(win) {
  const line = ST.nodes.filter(onAxis).sort((a, b) => a.x - b.x), i = line.indexOf(win); const out = [];
  for (let j = i - 1; j >= 0 && line[j].type !== "win"; j--) out.unshift(line[j]);
  return out;
}
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
    for (const w of ST.nodes.filter((n) => n.type === "win")) {
      const ctx = stContextOf(w), text = ctx.map(stNodeText).filter(Boolean).join("\n\n");
      const c = document.querySelector(`[data-stctxn="${w.id}"]`); if (c) c.textContent = ctx.length ? L(`← ${ctx.length} 个节点的上下文`, `← ${ctx.length} in context`) : "";
      if (!w.key || w.sent === text) continue;
      w.sent = text; api(`/v1/users/${S.uid}/chat-context`, { method: "PUT", body: { key: w.key, text } }).catch(() => { w.sent = null; });
    }
    stSave();
  }, 300);
}

/* ------------------------------------------------ windows */
function stOpen(key, at) {                        // a window for a conversation: where it is asked, or after the last window
  let n = key && ST.nodes.find((x) => x.type === "win" && x.key === key);
  if (!n) {
    const card = key && ST.nodes.find((x) => x.type === "conv" && x.key === key);
    const last = ST.nodes.filter(onAxis).sort((a, b) => b.x - a.x)[0];
    const x = at?.x ?? card?.x ?? (last ? last.x + stW(last) / 2 + ST_GAP + ST_WW / 2 : ST_WW / 2);
    if (card) ST.nodes = ST.nodes.filter((c) => c !== card);
    n = { id: stId(), type: "win", key: key || null, x, y: 0 }; ST.nodes.push(n);
    stPush(n, true);
  }
  ST.focus = n.id; stRender(); stReveal(n); stSave(); stContexts(); return n;
}
function stReveal(n) { const A = stArena(), z = ST.cam.z, l = ST.cam.x + (n.x - stW(n) / 2) * z, r = ST.cam.x + (n.x + stW(n) / 2) * z;
  if (l < 20) ST.cam.x += 20 - l; else if (r > A.w - 20) ST.cam.x -= r - (A.w - 20); stApply(); }
function stFocus(id) { if (ST.focus === id) return; ST.focus = id; document.querySelectorAll(".stnode.t-win").forEach((el) => el.classList.toggle("focus", el.dataset.nid === id)); }
function stMin(n) { const card = { id: stId(), type: "conv", key: n.key, title: stTitle(n.key), x: n.x, y: 0 }; ST.nodes = ST.nodes.map((x) => (x === n ? card : x)); if (!n.key) ST.nodes = ST.nodes.filter((x) => x !== card); stPush(card, true); stRender(); stSave(); stContexts(); }
function stClose(n) { ST.nodes = ST.nodes.filter((x) => x !== n); stRender(); stSave(); stContexts(); }
function stMax(n, on) {
  const el = document.querySelector(`.stnode[data-nid="${n.id}"] .stwin`); if (!el) return;
  n.max = on; el.classList.toggle("max", on); $("#vStage").classList.toggle("hasmax", on);
  $("#stworld").style.transform = on ? "none" : ""; if (!on) stApply();          // no transform above it: the big window fills the app
  try { el.querySelector("iframe").contentDocument.documentElement.classList.toggle("efull", on); } catch {}
}
setInterval(() => {                               // a new conversation in a window gets its key once you send; titles follow
  for (const n of ST.nodes.filter((x) => x.type === "win")) {
    const el = document.querySelector(`.stnode[data-nid="${n.id}"]`), f = el?.querySelector("iframe"); let k = null; try { k = f?.contentWindow?.S?.chat || null; } catch {}
    if (k && k !== n.key) { n.key = k; n.sent = null; stSave(); stContexts(); }
    const t = el?.querySelector(".stwt"); if (t && n.key) { const s = stTitle(n.key); if (t.textContent !== s) t.textContent = s; }
  }
}, 2500);

/* ------------------------------------------------ right-click: add any node where you clicked */
function stMenu(sx, sy) {
  const r = $("#starena").getBoundingClientRect(), at = { x: (sx - r.left - ST.cam.x) / ST.cam.z, y: (sy - r.top - ST.cam.y) / ST.cam.z };
  if (Math.abs(at.y) < ST_AXIS) at.y = 0;
  document.querySelector(".stmenu")?.remove();
  const m = document.createElement("div"); m.className = "cvpal cvmenu stmenu card"; m.style.left = Math.min(sx, innerWidth - 250) + "px"; m.style.top = Math.min(sy, innerHeight - 330) + "px";
  m.innerHTML = `<div class="stmh">${at.y === 0 ? L("加到中轴上（放在窗口左边就是它的上下文）", "On the axis (left of a window: its context)") : L("放在画布上（不进任何上下文）", "On the canvas (in no context)")}</div>`
    + [["note", "📝"], ["skill", "✦"], ["doc", "📚"], ["file", "📎"], ["conv", "💬"], ["topic", "🌳"], ["win", "▢"]].map(([t, i]) => `<button data-stadd="${t}">${i} ${t === "win" ? L("新对话窗口", "New conversation window") : L(...ST_T[t].slice(0, 2)) + (t === "note" ? "" : "…")}</button>`).join("");
  m.dataset.at = JSON.stringify(at); document.body.appendChild(m);
}
async function stAdd(type, at) {
  if (type === "win") { const n = stOpen(null, at); return n; }
  if (type === "note") { const n = { id: stId(), type, x: at.x, y: at.y, text: "" }; ST.nodes.push(n); stPush(n, true); stRender(); stSave(); setTimeout(() => document.querySelector(`[data-stnote="${n.id}"]`)?.focus(), 50); return n; }
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
    const n = { id: stId(), type, x: at.x, y: at.y, title: r.title, sub: r.sub, ...(r.key ? { key: r.key } : {}), ...(r.path ? { path: r.path } : {}), ...(r.doc ? { doc: r.doc } : {}), ...(r.world ? { world: r.world } : {}) };
    if (type === "skill" && r.path) { try { n.body = (await api(`/v1/users/${S.uid}/canvas-skill?path=${encodeURIComponent(r.path)}`)).text; } catch {} }
    if (type === "topic") n.sub = (W.byId.get(r.world)?.summary || "").slice(0, 600);
    ST.nodes.push(n); stPush(n, true); stRender(); stSave(); stContexts();
    document.querySelector(`.stnode[data-nid="${n.id}"]`)?.animate?.([{ opacity: 0, transform: "scale(.8)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
  });
}

/* ------------------------------------------------ the bar */
function stBar() {
  const bar = $("#stbar"); if (!bar) return;
  bar.innerHTML = `<span class="cvdim">${L("右键空白处加节点 · 放在窗口左边的节点就是这段对话的上下文 · 拖空白处移动，⌘+滚轮缩放", "Right-click to add · what sits left of a window is its context · drag empty space to move, ⌘+scroll to zoom")}</span>
    <span class="grow"></span><button class="sm ghost" data-st="home" title="${L("回到最左边", "Back to the start")}">⟲</button><button class="sm" data-st="new">＋ ${L("新对话", "New chat")}</button>`;
}

/* ------------------------------------------------ pointer */
function stCap(e) { try { $("#starena").setPointerCapture(e.pointerId); } catch {} }
function stBind() {
  const v = $("#vStage"), arena = $("#starena");
  arena.addEventListener("wheel", (e) => {
    if (e.target.closest("textarea, .stpick")) return; e.preventDefault();
    if (e.ctrlKey || e.metaKey) { const r = arena.getBoundingClientRect(), mx = e.clientX - r.left, z0 = ST.cam.z, z = Math.max(.35, Math.min(1.4, z0 * Math.exp(-e.deltaY * .006)));
      ST.cam.x = mx - (mx - ST.cam.x) * z / z0; ST.cam.z = z; stRender(); }
    else { ST.cam.x -= Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY; stApply(); }
    clearTimeout(ST.wt); ST.wt = setTimeout(stSave, 400);
  }, { passive: false });
  arena.addEventListener("contextmenu", (e) => { if (e.target.closest(".stnode")) return; e.preventDefault(); stMenu(e.clientX, e.clientY); });
  arena.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return; document.querySelector(".stmenu")?.remove();
    const rz = e.target.closest("[data-rz]");
    if (rz) { const n = ST.nodes.find((x) => x.id === rz.closest(".stnode").dataset.nid); ST.rz = { n, d: rz.dataset.rz, x: e.clientX, w0: stW(n), x0: n.x }; v.classList.add("dragging"); stCap(e); return; }
    if (e.target.closest("button, textarea, input, iframe, [data-doc]")) return;
    const el = e.target.closest(".stnode");
    if (el) { const n = ST.nodes.find((x) => x.id === el.dataset.nid); if (!n || n.max || (n.type === "win" && !e.target.closest(".stwh"))) return;
      if (n.type === "win") stFocus(n.id); stGrab(n, e.screenX, e.screenY); stCap(e); return; }
    ST.pan = { x: e.clientX, cx: ST.cam.x }; v.classList.add("panning"); stCap(e);
  });
  arena.addEventListener("pointermove", (e) => {
    if (ST.rz) { const r = ST.rz, dx = (e.clientX - r.x) / ST.cam.z, w = Math.max(300, r.w0 + (r.d === "e" ? dx : -dx)); r.n.bw = Math.round(w); r.n.x = r.x0 + (r.d === "e" ? 1 : -1) * (w - r.w0) / 2; stPush(r.n); stRender(); return; }
    if (ST.drag) { stDragTo(e.screenX, e.screenY); return; }
    if (ST.pan) { ST.cam.x = ST.pan.cx + e.clientX - ST.pan.x; stApply(); }
  });
  arena.addEventListener("pointerup", () => {
    if (ST.rz) { ST.rz = null; v.classList.remove("dragging"); stSave(); return; }
    if (ST.pan) { ST.pan = null; v.classList.remove("panning"); stSave(); return; }
    const d = stDrop(); if (d && !d.moved && d.n.type === "conv") stOpen(d.n.key);       // a click on a conversation card opens it
  });
  arena.addEventListener("dblclick", (e) => { const rz = e.target.closest("[data-rz]"); if (rz) { const n = ST.nodes.find((x) => x.id === rz.closest(".stnode").dataset.nid); delete n.bw; stPush(n, true); stRender(); stSave(); } });
  arena.addEventListener("input", (e) => { const t = e.target.closest("[data-stnote]"); if (!t) return; const n = ST.nodes.find((x) => x.id === t.dataset.stnote); if (n) { n.text = t.value; stContexts(); } });
}
document.addEventListener("click", (e) => {
  if (S.view !== "stage") return;
  const add = e.target.closest("[data-stadd]"); if (add) { const m = add.closest(".stmenu"), at = JSON.parse(m.dataset.at); m.remove(); stAdd(add.dataset.stadd, at); return; }
  const del = e.target.closest("[data-stdel]"); if (del) { ST.nodes = ST.nodes.filter((x) => x.id !== del.dataset.stdel); stRender(); stSave(); stContexts(); return; }
  const w = e.target.closest("[data-stw]"); if (w) { const n = ST.nodes.find((x) => x.id === w.closest(".stnode").dataset.nid); if (!n) return;
    if (w.dataset.stw === "min") stMin(n); else if (w.dataset.stw === "close") stClose(n); else stMax(n, !n.max); return; }
  const t = e.target.closest("[data-st]"); if (!t) return;
  if (t.dataset.st === "new") stOpen(null);
  else if (t.dataset.st === "home") { ST.cam.x = 30; ST.cam.z = 1; stRender(); stSave(); }
  if (!e.target.closest(".stmenu")) document.querySelector(".stmenu")?.remove();
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

/* ------------------------------------------------ into the app */
const _showST = show;
show = function (view, opts) {
  if (view === "stage") { S.view = "stage"; closeCtx?.(); ["Home", "Tree", "Chats", "Notes", "Looks", "Graph"].forEach((v) => { const el = $("#v" + v); if (el) el.hidden = true; }); $("#vStage").hidden = false; history.replaceState(null, "", qs()); renderRail(); showStage(); return; }
  const st = $("#vStage"); if (st) st.hidden = true; return _showST(view, opts);
};
const _renderRailST = renderRail;
renderRail = function () { _renderRailST(); $("#toStage")?.classList.toggle("on", S.view === "stage"); $("#toChatsPage")?.classList.toggle("on", S.view === "chats"); };
