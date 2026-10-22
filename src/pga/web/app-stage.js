/* PGA app · the stage. Conversations are windows on an infinite canvas, at three sizes:
   - smallest: a node on the canvas, among every other conversation (left to right by time, in bands by world-tree
     topic);
   - middle: on a band between two horizontal rails. Up to four sit side by side, and more slide along the rails, left
     and right. Above and below each window, on the rails, ride the conversations it is linked to by the context you
     pick (time, content, data, with how far it reaches), and they move with it;
   - largest: filling the whole app, the conversation page itself.
   Each window is the conversation page (?view=chats&embed=1), so each has its own agent, composer and live answer. */

const ST = { wins: [], focus: null, off: 0, cv: { x: 0, y: 0, z: 1 }, ctx: {},
  axis: (() => { try { return localStorage.getItem("pga_st_axis") || "time"; } catch { return "time"; } })(),
  range: (() => { try { return Number(localStorage.getItem("pga_st_range")) || 6; } catch { return 6; } })() };
const ST_GAP = 14, ST_MIN_W = 320, ST_MAX_PER = 4;
const stItem = (key) => recentItems().find((x) => x.item === key);
const stTitle = (key) => (key ? stItem(key)?.title || S.chats?.find((c) => c.key === key)?.title || key : L("新对话", "New chat"));
const stId = () => Math.random().toString(36).slice(2, 9);
function stSave() { try { localStorage.setItem("pga_st_wins", JSON.stringify(ST.wins.map((w) => ({ key: w.key, mode: w.mode === "max" ? "mid" : w.mode, w: w.w, h: w.h, top: w.top })).slice(-24))); } catch {} }

/* ------------------------------------------------ the page */
function showStage() {
  document.title = "PGA";
  const v = $("#vStage");
  if (!v.dataset.ready) {
    v.dataset.ready = "1";
    v.innerHTML = `<div class="stcv" id="stcv"><div class="stcw" id="stcw"></div></div>
      <div class="stbar card" id="stbar"></div>
      <section class="band" id="band"><i class="rail top"></i><i class="rail bot"></i><div class="track" id="track"></div>
        <button class="slide l" data-st="left" title="${L("往左滑", "Slide left")}">‹</button><button class="slide r" data-st="right" title="${L("往右滑", "Slide right")}">›</button></section>`;
    stBind();
    let saved = []; try { saved = JSON.parse(localStorage.getItem("pga_st_wins") || "[]"); } catch {}
    ST.wins = saved.filter((x) => x.key).map((x) => ({ id: stId(), key: x.key, mode: x.mode === "min" ? "min" : "mid", ...(x.w ? { w: x.w } : {}), ...(x.h ? { h: x.h, top: x.top || 0 } : {}) }));
    if (!ST.wins.some((w) => w.mode === "mid")) { const r = recentItems()[0]; if (r) ST.wins.push({ id: stId(), key: r.item, mode: "mid" }); }
    ST.focus = ST.wins.find((w) => w.mode === "mid")?.id || null;
    wtFetch().then(() => { stCanvas(); stLayout(); });
  }
  stBar(); stCanvas(); stLayout();
}

/* ------------------------------------------------ the infinite canvas underneath */
function stCanvas() {
  const box = $("#stcw"); if (!box) return;
  const items = recentItems().slice(0, 500), now = Date.now();
  const groupOf = (key) => { let n = W.nodes.find((x) => x.ref === key); while (n && n.parent && W.byId.get(n.parent)?.kind !== "root") n = W.byId.get(n.parent); return n?.kind === "root" ? null : n; };
  const groups = []; const gi = (g) => { const k = g?.id || "_"; let i = groups.findIndex((x) => x.id === k); if (i < 0) { groups.push({ id: k, title: g?.title || L("未归类", "Unsorted") }); i = groups.length - 1; } return i; };
  const parked = new Set(ST.wins.filter((w) => w.mode === "min").map((w) => w.key)), open = new Set(ST.wins.filter((w) => w.mode !== "min").map((w) => w.key));
  const dots = items.map((x, i) => {
    const days = Math.max(0, (now - new Date(x.last || now).getTime()) / 864e5), g = gi(groupOf(x.item));
    return { x, px: -Math.log2(1 + days) * 260, py: g * 130 + ((i * 37) % 90) };
  });
  box.innerHTML = groups.map((g, i) => `<div class="stlane" style="top:${i * 130 - 18}px"><span>${esc(g.title)}</span></div>`).join("")
    + [0, 1, 7, 30, 120, 365].map((d) => `<div class="sttick" style="left:${-Math.log2(1 + d) * 260}px"><span>${d === 0 ? L("现在", "now") : d === 1 ? L("1 天前", "1 day") : L(`${d} 天前`, `${d} days`)}</span></div>`).join("")
    + dots.map((d) => `<div class="stdot ${parked.has(d.x.item) ? "parked" : ""} ${open.has(d.x.item) ? "open" : ""}" data-stkey="${esc(d.x.item)}" style="left:${d.px}px;top:${d.py}px" title="${esc(d.x.title || "")}"><i></i>${parked.has(d.x.item) || open.has(d.x.item) ? `<span>${esc((d.x.title || "").slice(0, 26))}</span>` : ""}</div>`).join("");
  ST.dots = new Map(dots.map((d) => [d.x.item, d]));
  if (!ST.cvSet) { const r = $("#stcv").getBoundingClientRect(); ST.cv = { x: r.width - 140, y: 90, z: 1 }; ST.cvSet = true; }
  stCvApply();
}
function stCvApply() { const w = $("#stcw"); if (w) w.style.transform = `translate(${ST.cv.x}px, ${ST.cv.y}px) scale(${ST.cv.z})`; const c = $("#stcv"); if (c) { const g = 24 * ST.cv.z; c.style.backgroundSize = `${g}px ${g}px`; c.style.backgroundPosition = `${ST.cv.x}px ${ST.cv.y}px`; } }
function stDotRect(key) { const el = document.querySelector(`.stdot[data-stkey="${CSS.escape(key)}"]`); return el ? el.getBoundingClientRect() : null; }

/* ------------------------------------------------ windows on the band */
function stOpen(key, opts = {}) {
  let w = key && ST.wins.find((x) => x.key === key);
  const from = key ? stDotRect(key) : null;
  if (w) { w.mode = "mid"; }
  else {
    w = { id: stId(), key: key || null, mode: "mid", fresh: !key };
    const at = opts.after ? ST.wins.findIndex((x) => x.id === opts.after) + 1 : ST.wins.length;
    ST.wins.splice(at || ST.wins.length, 0, w);
  }
  ST.focus = w.id; stSave(); stLayout({ grow: w.id, from });
  stShowFocus(); stCanvas();
  return w;
}
function stClose(id) { const el = document.querySelector(`.stw[data-wid="${id}"]`); const done = () => { ST.wins = ST.wins.filter((w) => w.id !== id); if (ST.focus === id) ST.focus = ST.wins.find((w) => w.mode === "mid")?.id || null; stSave(); stLayout(); stCanvas(); };
  if (el?.animate) el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.9) translateY(30px)" }], { duration: 220 }).finished.then(done); else done(); }
function stMin(id) {                              // the window shrinks into its node on the canvas
  const w = ST.wins.find((x) => x.id === id); if (!w) return;
  const el = document.querySelector(`.stw[data-wid="${id}"] .stwin`), to = w.key ? stDotRect(w.key) : null;
  const finish = () => { w.mode = "min"; if (ST.focus === id) ST.focus = ST.wins.find((x) => x.mode === "mid")?.id || null; stSave(); stLayout(); stCanvas(); };
  if (el?.animate && to) { const r = el.getBoundingClientRect();
    el.animate([{ transformOrigin: "0 0", transform: "none", opacity: 1 }, { transformOrigin: "0 0", transform: `translate(${to.left - r.left}px, ${to.top - r.top}px) scale(${Math.max(.02, to.width / r.width)})`, opacity: .2 }], { duration: 380, easing: "cubic-bezier(.5,0,.75,0)" }).finished.then(finish);
  } else finish();
}
function stMax(id, on = true) {                   // the whole app; the conversation page with its right panel
  const w = ST.wins.find((x) => x.id === id); if (!w) return;
  const el = document.querySelector(`.stw[data-wid="${id}"] .stwin`); if (!el) return;
  const r0 = el.getBoundingClientRect();
  w.mode = on ? "max" : "mid"; ST.focus = id;
  el.classList.toggle("max", on); $("#vStage").classList.toggle("hasmax", on);
  try { el.querySelector("iframe").contentDocument.documentElement.classList.toggle("efull", on); } catch {}
  const r1 = el.getBoundingClientRect();
  el.animate?.([{ transformOrigin: "0 0", transform: `translate(${r0.left - r1.left}px, ${r0.top - r1.top}px) scale(${r0.width / r1.width}, ${r0.height / r1.height})` }, { transformOrigin: "0 0", transform: "none" }], { duration: 380, easing: "cubic-bezier(.2,.8,.2,1)" });
  stBar();
}
function stLayout(opts = {}) {
  const band = $("#band"), track = $("#track"); if (!band || !track) return;
  const mids = ST.wins.filter((w) => w.mode !== "min");
  band.classList.toggle("empty", !mids.length);
  const keep = new Set(mids.map((w) => w.id));
  track.querySelectorAll(".stw").forEach((el) => { if (!keep.has(el.dataset.wid)) el.remove(); });
  const bw = band.clientWidth - 2 * 44, per = Math.max(1, Math.min(ST_MAX_PER, mids.length, Math.floor((bw + ST_GAP) / (ST_MIN_W + ST_GAP))));
  const ww = mids.length === 1 ? Math.min(980, bw) : Math.floor((bw - (per - 1) * ST_GAP) / per);
  ST.ww = ww; ST.per = per;
  mids.forEach((w, i) => {
    let el = track.querySelector(`.stw[data-wid="${w.id}"]`);
    if (!el) {                                    // put in its place; the others are never moved (moving a frame reloads it)
      el = document.createElement("div"); el.className = "stw"; el.dataset.wid = w.id; el.innerHTML = stWinHtml(w);
      track.insertBefore(el, track.children[i] || null); stFrame(w, el);
    }
    el.style.width = (w.w || ww) + "px"; el.classList.toggle("focus", ST.focus === w.id);
    const win = el.querySelector(".stwin"); win.style.top = w.top ? w.top + "px" : ""; win.style.height = w.h ? w.h + "px" : ""; win.classList.toggle("sized", !!w.h);
  });
  const widths = mids.map((w) => w.w || ww), lefts = widths.map((_, i) => widths.slice(0, i).reduce((a, b) => a + b + ST_GAP, 0));
  const total = widths.reduce((a, b) => a + b, 0) + Math.max(0, mids.length - 1) * ST_GAP;
  ST.lefts = lefts;
  const fi = Math.max(0, mids.findIndex((w) => w.id === ST.focus));
  const maxOff = Math.max(0, total - bw);
  if (opts.keep !== true && mids.length) {       // keep the focused window in view
    const left = lefts[fi], wf = widths[fi];
    if (left < ST.off) ST.off = left; else if (left + wf > ST.off + bw) ST.off = left + wf - bw;
  }
  ST.off = Math.max(0, Math.min(maxOff, ST.off));
  track.style.left = 44 + (total < bw ? (bw - total) / 2 : 0) - ST.off + "px";     // left, not a transform: a maximised window must be free to fill the app
  band.querySelector(".slide.l").hidden = ST.off <= 0; band.querySelector(".slide.r").hidden = ST.off >= maxOff;
  if (opts.grow) { const el = track.querySelector(`.stw[data-wid="${opts.grow}"]`), f = opts.from;
    if (el?.animate) { if (f) { const r = el.getBoundingClientRect(); el.animate([{ transformOrigin: "0 0", transform: `translate(${f.left - r.left}px, ${f.top - r.top}px) scale(.03)`, opacity: .3 }, { transformOrigin: "0 0", transform: "none", opacity: 1 }], { duration: 460, easing: "cubic-bezier(.2,.8,.2,1)" }); }
      else el.animate([{ opacity: 0, transform: "translateY(40px) scale(.96)" }, { opacity: 1, transform: "none" }], { duration: 360, easing: "cubic-bezier(.2,.8,.2,1)" }); } }
  mids.forEach((w) => stCtx(w));
  stBar();
}
function stWinHtml(w) {
  return `<div class="stctx top" data-ctx="top"></div>
    <div class="stmid"><div class="stwin">${["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((d) => `<i class="rz rz-${d}" data-rz="${d}" title="${L("拖动改大小，双击还原", "Drag to resize, double-click to reset")}"></i>`).join("")}<div class="stwh" data-stfocus="${w.id}"><b class="stwt">${esc(stTitle(w.key))}</b><span class="grow"></span>
      <button class="stb" data-stw="min" title="${L("最小化：变成画布上的一个节点", "Minimise: a node on the canvas")}">–</button><button class="stb" data-stw="max" title="${L("最大化：占满整个窗口（Esc 还原）", "Maximise: the whole window (Esc restores)")}">▢</button><button class="stb" data-stw="close" title="${L("关掉这个窗口（对话还在）", "Close the window (the conversation stays)")}">×</button></div>
      <iframe title="conversation"></iframe></div></div>
    <div class="stctx bot" data-ctx="bot"></div>`;
}
function stFrame(w, el) {
  const q = new URLSearchParams({ view: "chats", embed: "1" });
  if (w.key) { if (S.allChats?.some((c) => c.key === w.key) || w.key.startsWith("chat:")) q.set("c", w.key); else q.set("item", w.key); }
  if (AS_UID) q.set("as", AS_UID); if (Q.get("lang")) q.set("lang", Q.get("lang"));
  const f = el.querySelector("iframe"); f.src = "/?" + q;
  f.addEventListener("load", () => { try { stHold(f, w); } catch {} });
}
function stHold(f, w) {                          // inside a conversation: press and hold (~0.3 s, still), then move to slide the rails
  const cw = f.contentWindow, doc = cw.document; let h = null;
  doc.addEventListener("pointerdown", (e) => {
    stFocus(w.id);
    if (e.button !== 0 || e.target.closest("input, textarea, select, button, a, [contenteditable], .cbar")) return;
    h = { sx: e.screenX, sy: e.screenY, off: ST.off, on: false, t: setTimeout(() => { if (!h) return; h.on = true; doc.documentElement.classList.add("stgrab"); $("#band").classList.add("sliding"); cw.getSelection()?.removeAllRanges(); }, 300) };
  }, true);
  doc.addEventListener("pointermove", (e) => {
    if (!h) return;
    if (!h.on) { if (Math.hypot(e.screenX - h.sx, e.screenY - h.sy) > 5) { clearTimeout(h.t); h = null; } return; }     // moved before the hold: selecting text
    e.preventDefault(); cw.getSelection()?.removeAllRanges(); ST.off = h.off + (h.sx - e.screenX); stLayout({ keep: true });
  }, true);
  const end = () => { if (!h) return; clearTimeout(h.t); const was = h.on; h = null; doc.documentElement.classList.remove("stgrab"); $("#band").classList.remove("sliding"); if (was) stSnap(); };
  doc.addEventListener("pointerup", end, true); doc.addEventListener("pointercancel", end, true);
  doc.addEventListener("selectstart", (e) => { if (h?.on) e.preventDefault(); }, true);
  const st = doc.createElement("style"); st.textContent = "html.stgrab, html.stgrab * { cursor: grabbing !important; user-select: none !important; }"; doc.head.appendChild(st);
}
/* free size: drag an edge or a corner; the window keeps its place on the rails, the others make room */
function stResizeStart(e, rz) {
  const el = rz.closest(".stw"), w = ST.wins.find((x) => x.id === el.dataset.wid); if (!w || w.mode === "max") return;
  const win = el.querySelector(".stwin"), mid = el.querySelector(".stmid");
  ST.rz = { w, d: rz.dataset.rz, x: e.clientX, y: e.clientY, w0: el.offsetWidth, h0: win.offsetHeight, t0: win.offsetTop, H: mid.clientHeight, off: ST.off };
  $("#band").setPointerCapture(e.pointerId); $("#band").classList.add("resizing"); e.preventDefault(); stFocus(w.id);
}
function stResizeMove(e) {
  const r = ST.rz, dx = e.clientX - r.x, dy = e.clientY - r.y, bw = $("#band").clientWidth - 88;
  if (r.d.includes("e")) r.w.w = Math.round(Math.max(300, Math.min(bw, r.w0 + dx)));
  if (r.d.includes("w")) { r.w.w = Math.round(Math.max(300, Math.min(bw, r.w0 - dx))); ST.off = r.off + (r.w.w - r.w0); }      // the right edge stays put
  if (r.d.includes("s")) r.w.h = Math.round(Math.max(220, Math.min(r.H - r.t0, r.h0 + dy)));
  if (r.d.includes("n")) { const t = Math.max(0, Math.min(r.t0 + r.h0 - 220, r.t0 + dy)); r.w.top = Math.round(t); r.w.h = Math.round(r.h0 + (r.t0 - t)); }
  stLayout({ keep: true });
}
function stResizeEnd() { ST.rz = null; $("#band").classList.remove("resizing"); stSave(); }
function stFocus(id) { if (ST.focus === id) return; ST.focus = id; document.querySelectorAll(".stw").forEach((el) => el.classList.toggle("focus", el.dataset.wid === id)); stShowFocus(); }
function stShowFocus() { const w = ST.wins.find((x) => x.id === ST.focus); document.querySelectorAll(".stdot.focus").forEach((d) => d.classList.remove("focus")); if (w?.key) document.querySelector(`.stdot[data-stkey="${CSS.escape(w.key)}"]`)?.classList.add("focus"); }
setInterval(() => {                               // a new conversation in a window gets its key once you send; titles follow
  for (const w of ST.wins) {
    const f = document.querySelector(`.stw[data-wid="${w.id}"] iframe`); let k = null; try { k = f?.contentWindow?.S?.chat || null; } catch {}
    if (k && k !== w.key) { w.key = k; w.fresh = false; stSave(); stCtx(w); stCanvas(); }
    const t = document.querySelector(`.stw[data-wid="${w.id}"] .stwt`); if (t && w.key) { const s = stTitle(w.key); if (t.textContent !== s) t.textContent = s; }
  }
}, 2500);

/* ------------------------------------------------ the context riding on the rails */
async function stCtx(w) {
  const el = document.querySelector(`.stw[data-wid="${w.id}"]`); if (!el) return;
  const top = el.querySelector(".stctx.top"), bot = el.querySelector(".stctx.bot");
  if (!w.key) { top.innerHTML = `<span class="stc dim">${L("新对话：发出第一句后，这里出现和它相关的对话", "A new chat: its links appear after the first message")}</span>`; bot.innerHTML = ""; return; }
  const items = recentItems(), me = items.findIndex((x) => x.item === w.key), leaf = W.nodes.find((x) => x.ref === w.key), R = ST.range;
  const chip = (x, cls = "") => `<button class="stc ${cls}" data-stopen="${esc(x.item)}" data-from="${w.id}" title="${esc(x.title || "")}">${esc((x.title || "").slice(0, 22))}<em>${esc(ago(x.last))}</em></button>`;
  let up = "", down = "";
  if (ST.axis === "time") {                       // the conversations just before and after it
    const before = me >= 0 ? items.slice(me + 1, me + 1 + Math.ceil(R / 2)) : [], after = me > 0 ? items.slice(Math.max(0, me - Math.floor(R / 2)), me) : [];
    up = `<span class="stl">${L("之前", "Before")}</span>` + before.map((x) => chip(x)).join("") || "";
    down = after.length ? `<span class="stl">${L("之后", "After")}</span>` + after.reverse().map((x) => chip(x)).join("") : `<span class="stl">${L("之后", "After")}</span><span class="stc dim">${L("这是最新的", "This is the latest")}</span>`;
  } else if (ST.axis === "content") {             // the same topic of the world tree, and the topic's path
    const sib = leaf ? W.nodes.filter((x) => x.parent === leaf.parent && x.kind === "leaf" && x.id !== leaf.id && !x.hidden).sort((a, b) => String(b.last || "").localeCompare(String(a.last || ""))).slice(0, R) : [];
    up = `<span class="stl">${L("同一主题", "Same topic")}</span>` + (sib.map((x) => chip({ item: x.ref, title: x.title, last: x.last })).join("") || `<span class="stc dim">${L("还没有放进世界树", "Not in the world tree yet")}</span>`);
    const path = leaf ? worldPath(leaf).slice(1, -1) : [];
    down = path.length ? `<span class="stl">${L("在世界树上", "In the tree")}</span>` + path.map((p) => `<span class="stc path">${esc(p.title)}</span>`).join("<i class='stsep'>›</i>") : "";
  } else {                                        // what it used: conversations it read, data, files, skills
    let c = ST.ctx[w.key];
    if (!c) { top.innerHTML = `<span class="stc dim"><span class="spin"></span></span>`; try { c = ST.ctx[w.key] = (await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(w.key)}/context`)).context || {}; } catch { c = ST.ctx[w.key] = {}; } }
    const conv = [...(c.related || []).map((x) => ({ item: x.ref, title: x.title })), ...(c.branched_from ? [{ item: c.branched_from.key, title: L("分支自 ", "Branched from ") + stTitle(c.branched_from.key) }] : [])].slice(0, R);
    const data = [...(c.datasets || []).map((x) => ["📚", x.title]), ...(c.attachments || []).map((x) => ["📎", x]), ...(c.skills || []).map((x) => ["✦", x]), ...(c.tools || []).map((x) => ["⚙", x]),
      ...(c.changed || []).map((x) => ["✎", x.split("/").pop()]), ...(c.read || []).map((x) => ["📄", x.split("/").pop()]), ...(c.web || []).map((x) => ["🌐", x.replace(/^https?:\/\//, "").slice(0, 30)])].slice(0, R * 2);
    up = `<span class="stl">${L("引用的对话", "Conversations used")}</span>` + (conv.map((x) => chip(x)).join("") || `<span class="stc dim">${L("没有", "none")}</span>`);
    down = `<span class="stl">${L("用到的数据", "Data used")}</span>` + (data.map(([i, t]) => `<span class="stc data" title="${esc(t)}">${i} ${esc(String(t).slice(0, 24))}</span>`).join("") || `<span class="stc dim">${L("没有记录", "nothing recorded")}</span>`);
  }
  for (const [box, html] of [[top, up], [bot, down]]) {
    if (box.dataset.sig === html) continue; box.dataset.sig = html; box.innerHTML = html;
    [...box.children].forEach((c, i) => c.animate?.([{ opacity: 0, transform: `translateX(${box === top ? -16 : 16}px)` }, { opacity: 1, transform: "none" }], { duration: 300, delay: i * 35, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" }));
  }
}

/* ------------------------------------------------ the bar: context, reach, new, overview */
function stBar() {
  const bar = $("#stbar"); if (!bar) return;
  const mids = ST.wins.filter((w) => w.mode !== "min").length, parked = ST.wins.filter((w) => w.mode === "min").length;
  bar.innerHTML = `<span class="seg stax">${[["time", L("时间", "Time")], ["content", L("内容", "Content")], ["data", L("数据", "Data")]].map(([k, t]) => `<button class="${ST.axis === k ? "on" : ""}" data-staxis="${k}">${t}</button>`).join("")}</span>
    <label class="strange" title="${L("上下文伸多远：显示几个相关的", "How far the context reaches")}">${L("范围", "Reach")}<input type="range" min="2" max="12" value="${ST.range}" id="stRange"><em>${ST.range}</em></label>
    <span class="grow"></span><span class="cvdim">${L(`${mids} 个窗口${parked ? ` · ${parked} 个最小化` : ""}`, `${mids} open${parked ? ` · ${parked} minimised` : ""}`)}</span>
    <button class="sm" data-st="new">＋ ${L("新对话", "New chat")}</button><button class="sm ghost" data-st="all" title="${L("全部最小化，看整张画布", "Minimise all and see the whole canvas")}">${L("全景", "Overview")}</button>`;
}

/* ------------------------------------------------ pointer: slide the rails, pan the canvas */
function stBind() {
  const band = $("#band"), cv = $("#stcv");
  band.addEventListener("wheel", (e) => {
    if (e.target.closest(".stwin")) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY; e.preventDefault();
    ST.off += d; stLayout({ keep: true }); stParallax(d);
  }, { passive: false });
  let drag = null;
  band.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const rz = e.target.closest("[data-rz]");
    if (rz) { stResizeStart(e, rz); return; }
    if (e.target.closest("button, input, iframe") || (e.target.closest(".stwin") && !e.target.closest(".stwh"))) return;
    drag = { x: e.clientX, off: ST.off, moved: false, head: e.target.closest(".stwh")?.dataset.stfocus };
    band.setPointerCapture(e.pointerId); band.classList.add("sliding");
  });
  band.addEventListener("pointermove", (e) => { if (ST.rz) { stResizeMove(e); return; } if (!drag) return; const d = drag.x - e.clientX; if (Math.abs(d) > 4) drag.moved = true; ST.off = drag.off + d; stLayout({ keep: true }); });
  band.addEventListener("pointerup", (e) => { if (ST.rz) { stResizeEnd(); return; } if (!drag) return; const d = drag; drag = null; band.classList.remove("sliding"); if (d.moved) stSnap(); else if (d.head) stFocus(d.head); });
  band.addEventListener("dblclick", (e) => { const rz = e.target.closest("[data-rz]"); if (!rz) return; const w = ST.wins.find((x) => x.id === rz.closest(".stw").dataset.wid); if (w) { delete w.w; delete w.h; delete w.top; stSave(); stLayout({ keep: true }); } });
  cv.addEventListener("wheel", (e) => { e.preventDefault();
    if (e.ctrlKey || e.metaKey) { const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, z0 = ST.cv.z, z = Math.max(.2, Math.min(3, z0 * Math.exp(-e.deltaY * .008))); ST.cv = { z, x: mx - (mx - ST.cv.x) * z / z0, y: my - (my - ST.cv.y) * z / z0 }; }
    else { ST.cv.x -= e.deltaX; ST.cv.y -= e.deltaY; } stCvApply(); }, { passive: false });
  let pan = null;
  cv.addEventListener("pointerdown", (e) => { if (e.target.closest(".stdot")) return; pan = { x: e.clientX, y: e.clientY, cx: ST.cv.x, cy: ST.cv.y }; cv.setPointerCapture(e.pointerId); });
  cv.addEventListener("pointermove", (e) => { if (!pan) return; ST.cv.x = pan.cx + e.clientX - pan.x; ST.cv.y = pan.cy + e.clientY - pan.y; stCvApply(); });
  cv.addEventListener("pointerup", () => { pan = null; });
  new ResizeObserver(() => stLayout({ keep: true })).observe(band);
}
function stSnap() { const ls = ST.lefts || [0]; ST.off = ls.reduce((best, l) => (Math.abs(l - ST.off) < Math.abs(best - ST.off) ? l : best), ls[0]); stLayout({ keep: true }); }
function stParallax(d) {                          // the context on the rails trails the windows a little as they slide
  document.querySelectorAll(".stctx").forEach((c) => c.animate?.([{ transform: `translateX(${Math.max(-40, Math.min(40, d * .6))}px)` }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" }));
}
function stSlide(dir) { const ls = ST.lefts || [0], i = ls.findIndex((l) => l >= ST.off - 2); ST.off = ls[Math.max(0, Math.min(ls.length - 1, (i < 0 ? ls.length - 1 : i) + dir))] ?? 0; stLayout({ keep: true }); stParallax(dir * 60); }

document.addEventListener("click", (e) => {
  if (S.view !== "stage") return;
  const t = e.target.closest("[data-st], [data-stw], [data-staxis], [data-stopen], [data-stkey], [data-stfocus]"); if (!t) return;
  if (t.dataset.stopen) { e.preventDefault(); stOpen(t.dataset.stopen, { after: t.dataset.from }); return; }
  if (t.dataset.stkey) { stOpen(t.dataset.stkey); return; }
  if (t.dataset.staxis) { ST.axis = t.dataset.staxis; try { localStorage.setItem("pga_st_axis", ST.axis); } catch {} stBar(); ST.wins.filter((w) => w.mode !== "min").forEach(stCtx); return; }
  if (t.dataset.stw) { const id = t.closest(".stw").dataset.wid, w = ST.wins.find((x) => x.id === id);
    if (t.dataset.stw === "min") stMin(id); else if (t.dataset.stw === "close") stClose(id); else stMax(id, w?.mode !== "max"); return; }
  if (t.dataset.stfocus && !e.target.closest("button")) { stFocus(t.dataset.stfocus); return; }
  const a = t.dataset.st;
  if (a === "new") stOpen(null);
  else if (a === "all") { ST.wins.forEach((w) => { w.mode = "min"; }); ST.focus = null; stSave(); stLayout(); stCanvas(); }
  else if (a === "left") stSlide(-1); else if (a === "right") stSlide(1);
});
document.addEventListener("input", (e) => { if (e.target.id !== "stRange") return; ST.range = Number(e.target.value); e.target.nextElementSibling.textContent = ST.range; try { localStorage.setItem("pga_st_range", ST.range); } catch {}
  clearTimeout(ST.rt); ST.rt = setTimeout(() => ST.wins.filter((w) => w.mode !== "min").forEach(stCtx), 200); });
document.addEventListener("keydown", (e) => { if (S.view !== "stage" || e.key !== "Escape") return; const w = ST.wins.find((x) => x.mode === "max"); if (w) stMax(w.id, false); });

/* a new window that is asked something right away (the notepad): type it into its composer and send */
async function stAsk(text) {
  if (S.view !== "stage") show("stage");
  const w = stOpen(null);
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const f = document.querySelector(`.stw[data-wid="${w.id}"] iframe`); let cw; try { cw = f?.contentWindow; } catch {}
    const box = cw?.document?.querySelector("#chatText");
    if (box && typeof cw.chatSend === "function" && cw.S?.agents?.length) { box.value = text; await cw.chatSend(); break; }
  }
  for (let i = 0; i < 40; i++) { const f = document.querySelector(`.stw[data-wid="${w.id}"] iframe`); let k = null; try { k = f?.contentWindow?.S?.chat; } catch {} if (k) { w.key = k; stSave(); return { w, key: k }; } await new Promise((r) => setTimeout(r, 250)); }
  return { w, key: null };
}

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
