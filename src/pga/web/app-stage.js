/* PGA app · the stage: conversation windows on an infinite canvas.

   One camera moves everything together: the dotted ground, every conversation's dot on it (left to right by time, in
   lanes by world-tree topic), the two rails, and the windows between them. Press and drag anywhere outside a
   conversation's text, or hold still inside it for a moment and then drag, to move freely.
   - At full size the windows ride the rails: you move left and right, as far as you like.
   - Zoomed out (pinch, or ⌘ and scroll), you move in every direction over the canvas, rails and all. Zooming back in
     sets them on the rails again.

   A window has three sizes:
   - smallest: its dot on the canvas;
   - middle: on the rails, up to four side by side, any size you drag its edges and corners to; on the rails above and
     below it ride the conversations it links to (time, content, data, and how far that reaches);
   - largest: the whole app, the conversation page itself.
   Each window is the conversation page (?view=chats&embed=1), with its own agent, composer and live answer. */

const ST = { wins: [], focus: null, cam: { x: 44, y: 64, z: 1 }, ctx: {}, H: 600, total: 0,
  axis: (() => { try { return localStorage.getItem("pga_st_axis") || "time"; } catch { return "time"; } })(),
  range: (() => { try { return Number(localStorage.getItem("pga_st_range")) || 6; } catch { return 6; } })() };
const ST_GAP = 14, ST_MIN_W = 320, ST_MAX_PER = 4, ST_TOP = 64, ST_BOT = 14;
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
    v.innerHTML = `<div class="stground" id="stground"></div>
      <div class="stworld" id="stworld"><div class="stdots" id="stdots"></div><i class="rail top"></i><i class="rail bot"></i><div class="track" id="track"></div></div>
      <div class="stbar card" id="stbar"></div>
      <button class="slide l" data-st="left" title="${L("往左一个窗口", "One window left")}">‹</button><button class="slide r" data-st="right" title="${L("往右一个窗口", "One window right")}">›</button>`;
    stBind();
    let saved = []; try { saved = JSON.parse(localStorage.getItem("pga_st_wins") || "[]"); } catch {}
    ST.wins = saved.filter((x) => x.key).map((x) => ({ id: stId(), key: x.key, mode: x.mode === "min" ? "min" : "mid", ...(x.w ? { w: x.w } : {}), ...(x.h ? { h: x.h, top: x.top || 0 } : {}) }));
    if (!ST.wins.some((w) => w.mode === "mid")) { const r = recentItems()[0]; if (r) ST.wins.push({ id: stId(), key: r.item, mode: "mid" }); }
    ST.focus = ST.wins.find((w) => w.mode === "mid")?.id || null;
    stLayout(); stHome(false);
    wtFetch().then(() => stCanvas());
  }
  stBar(); stLayout(); stCanvas();
}

/* ------------------------------------------------ the camera */
function stApply() {
  const w = $("#stworld"), g = $("#stground"), { x, y, z } = ST.cam; if (!w) return;
  if (ST.wins.some((m) => m.mode === "max")) { w.style.transform = "none"; w.style.left = x + "px"; w.style.top = y + "px"; }   // no transform: the big window must be free to fill the app
  else { w.style.left = "0px"; w.style.top = "0px"; w.style.transform = `translate(${x}px, ${y}px) scale(${z})`; }
  w.style.setProperty("--iz", (1 / z).toFixed(3));                     // dots and rails keep their size on screen
  // the ground stays where it is: only the band of windows moves over it
  const zoomed = z < .99; if ($("#vStage").classList.contains("zoomed") !== zoomed) { $("#vStage").classList.toggle("zoomed", zoomed); stBar(); }
  const vw = $("#vStage").clientWidth, left = x, right = x + ST.total * z;
  $("#vStage .slide.l").hidden = !ST.lefts?.length || left >= 0; $("#vStage .slide.r").hidden = !ST.lefts?.length || right <= vw;
}
function stPanTo(x, y) { ST.cam.x = x; if (ST.cam.z < .99) ST.cam.y = y; stApply(); }
function stCamTo(to, ms = 420) {                  // a smooth move of the camera
  const from = { ...ST.cam }, t0 = performance.now(); cancelAnimationFrame(ST.camRaf);
  const step = (t) => { const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3);
    ST.cam = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, z: from.z + (to.z - from.z) * e }; stApply();
    if (k < 1) ST.camRaf = requestAnimationFrame(step); };
  ST.camRaf = requestAnimationFrame(step);
}
function stSettle() { if (ST.cam.z >= .99 && (ST.cam.z !== 1 || ST.cam.y !== ST_TOP)) stCamTo({ x: ST.cam.x, y: ST_TOP, z: 1 }, 300); }     // back on the rails
function stHome(anim = true) {                    // the windows centred on the rails
  const vw = $("#vStage").clientWidth, to = { x: ST.total < vw - 88 ? (vw - ST.total) / 2 : 44, y: ST_TOP, z: 1 };
  if (anim) stCamTo(to); else { ST.cam = to; stApply(); }
}
function stReveal(id) {                           // bring a window into view, as little movement as it takes
  const i = ST.wins.filter((w) => w.mode !== "min").findIndex((w) => w.id === id); if (i < 0 || !ST.lefts) return;
  const vw = $("#vStage").clientWidth, z = ST.cam.z, l = ST.cam.x + ST.lefts[i] * z, r = l + ST.widths[i] * z;
  let x = ST.cam.x; if (l < 44) x += 44 - l; else if (r > vw - 44) x -= r - (vw - 44);
  if (x !== ST.cam.x) stCamTo({ x, y: ST.cam.y, z });
}
function stZoomAt(sx, sy, z) {
  const r = $("#vStage").getBoundingClientRect(), mx = sx - r.left, my = sy - r.top, z0 = ST.cam.z;
  z = Math.max(.2, Math.min(1, z));
  ST.cam = { z, x: mx - (mx - ST.cam.x) * z / z0, y: my - (my - ST.cam.y) * z / z0 }; stApply();
  clearTimeout(ST.zt); ST.zt = setTimeout(stSettle, 250);
}

/* ------------------------------------------------ the canvas: every conversation, behind the windows */
function stCanvas() {                            // the other conversations, minimised, in the free space left and right of the windows
  const box = $("#stdots"); if (!box) return;
  const open = new Set(ST.wins.filter((w) => w.mode !== "min").map((w) => w.key));
  const items = recentItems().filter((x) => !open.has(x.item)).slice(0, 160);
  const newest = Math.max(0, ...ST.wins.filter((w) => w.mode !== "min" && w.key).map((w) => new Date(stItem(w.key)?.last || 0).getTime()));
  const right = items.filter((x) => new Date(x.last || 0).getTime() > newest).reverse(), left = items.filter((x) => new Date(x.last || 0).getTime() <= newest);
  const CW = 170, CH = 104, G = 12, top = 52, rows = Math.max(1, Math.floor((ST.H - 2 * top + G) / (CH + G)));
  const card = (x, i, side) => { const col = Math.floor(i / rows), row = i % rows;
    const px = side < 0 ? -(col + 1) * (CW + G) - 24 : ST.total + 24 + col * (CW + G) + G, py = top + row * (CH + G);
    const leaf = W.nodes.find((n) => n.ref === x.item), parked = ST.wins.some((w) => w.mode === "min" && w.key === x.item);
    return `<div class="stcard ${parked ? "parked" : ""}" data-stkey="${esc(x.item)}" style="left:${px}px;top:${py}px;width:${CW}px;height:${CH}px" title="${esc(x.title || "")}">
      <b>${esc((x.title || "").slice(0, 40))}</b><span>${esc((leaf?.gist || "").slice(0, 46))}</span><em>${esc(agentLabel(x.agent || ""))} · ${esc(ago(x.last))}</em></div>`; };
  box.innerHTML = left.map((x, i) => card(x, i, -1)).join("") + right.map((x, i) => card(x, i, 1)).join("")
    + (left.length ? `<div class="stside" style="left:${-24 - 2 * (CW + G)}px">${L("之前的对话 ←", "Earlier ←")}</div>` : "") + (right.length ? `<div class="stside" style="left:${ST.total + 36}px">${L("→ 之后的对话", "→ Later")}</div>` : "");
}
function stDotRect(key) { const el = document.querySelector(`.stcard[data-stkey="${CSS.escape(key)}"]`); return el ? el.getBoundingClientRect() : null; }

/* ------------------------------------------------ windows on the rails */
function stOpen(key, opts = {}) {
  let w = key && ST.wins.find((x) => x.key === key);
  const from = key ? stDotRect(key) : null;
  if (w) w.mode = "mid";
  else {
    w = { id: stId(), key: key || null, mode: "mid", fresh: !key };
    const at = opts.after ? ST.wins.findIndex((x) => x.id === opts.after) + 1 : ST.wins.length;
    ST.wins.splice(at || ST.wins.length, 0, w);
  }
  ST.focus = w.id; stSave(); stLayout({ grow: w.id, from }); stShowFocus(); stCanvas();
  if (ST.cam.z < .99) stCamTo({ ...ST.cam, z: 1, y: ST_TOP }, 300);
  setTimeout(() => stReveal(w.id), 30);
  return w;
}
function stClose(id) { const el = document.querySelector(`.stw[data-wid="${id}"]`); const done = () => { ST.wins = ST.wins.filter((w) => w.id !== id); if (ST.focus === id) ST.focus = ST.wins.find((w) => w.mode === "mid")?.id || null; stSave(); stLayout(); stCanvas(); };
  if (el?.animate) el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.9) translateY(30px)" }], { duration: 220 }).finished.then(done); else done(); }
function stMin(id) {                              // the window shrinks into its dot on the canvas
  const w = ST.wins.find((x) => x.id === id); if (!w) return;
  const el = document.querySelector(`.stw[data-wid="${id}"] .stwin`), to = w.key ? stDotRect(w.key) : null;
  const finish = () => { w.mode = "min"; if (ST.focus === id) ST.focus = ST.wins.find((x) => x.mode === "mid")?.id || null; stSave(); stLayout(); stCanvas(); };
  if (el?.animate && to) { const r = el.getBoundingClientRect();
    el.animate([{ transformOrigin: "0 0", transform: "none", opacity: 1 }, { transformOrigin: "0 0", transform: `translate(${(to.left - r.left) / ST.cam.z}px, ${(to.top - r.top) / ST.cam.z}px) scale(${Math.max(.02, to.width / r.width)})`, opacity: .2 }], { duration: 380, easing: "cubic-bezier(.5,0,.75,0)" }).finished.then(finish);
  } else finish();
}
function stMax(id, on = true) {                   // the whole app; the conversation page with its right panel
  const w = ST.wins.find((x) => x.id === id); if (!w) return;
  const el = document.querySelector(`.stw[data-wid="${id}"] .stwin`); if (!el) return;
  const r0 = el.getBoundingClientRect();
  if (on && ST.cam.z !== 1) { ST.cam.z = 1; ST.cam.y = ST_TOP; }
  w.mode = on ? "max" : "mid"; ST.focus = id;
  el.classList.toggle("max", on); $("#vStage").classList.toggle("hasmax", on); stApply();
  try { el.querySelector("iframe").contentDocument.documentElement.classList.toggle("efull", on); } catch {}
  const r1 = el.getBoundingClientRect();
  el.animate?.([{ transformOrigin: "0 0", transform: `translate(${r0.left - r1.left}px, ${r0.top - r1.top}px) scale(${r0.width / r1.width}, ${r0.height / r1.height})` }, { transformOrigin: "0 0", transform: "none" }], { duration: 380, easing: "cubic-bezier(.2,.8,.2,1)" });
  stBar();
}
function stLayout(opts = {}) {
  const v = $("#vStage"), track = $("#track"); if (!v || !track) return;
  ST.H = Math.max(320, v.clientHeight - ST_TOP - ST_BOT);
  $("#stworld").style.height = ST.H + "px";
  const mids = ST.wins.filter((w) => w.mode !== "min");
  const keep = new Set(mids.map((w) => w.id));
  track.querySelectorAll(".stw").forEach((el) => { if (!keep.has(el.dataset.wid)) el.remove(); });
  const bw = v.clientWidth - 88, per = Math.max(1, Math.min(ST_MAX_PER, mids.length, Math.floor((bw + ST_GAP) / (ST_MIN_W + ST_GAP))));
  const ww = Math.min(mids.length === 1 ? 760 : 560, Math.floor((bw - (per - 1) * ST_GAP) / per));     // room left and right for the other conversations
  ST.ww = ww; ST.per = per;
  mids.forEach((w, i) => {
    let el = track.querySelector(`.stw[data-wid="${w.id}"]`);
    if (!el) {                                    // put in its place; the others are never moved (moving a frame reloads it)
      el = document.createElement("div"); el.className = "stw"; el.dataset.wid = w.id; el.innerHTML = stWinHtml(w);
      track.insertBefore(el, track.children[i] || null); stFrame(w, el);
    }
    el.style.width = (w.w || ww) + "px"; el.style.height = ST.H + "px"; el.classList.toggle("focus", ST.focus === w.id);
    const win = el.querySelector(".stwin"); win.style.top = w.top ? w.top + "px" : ""; win.style.height = w.h ? w.h + "px" : ""; win.classList.toggle("sized", !!w.h);
  });
  ST.widths = mids.map((w) => w.w || ww); ST.lefts = ST.widths.map((_, i) => ST.widths.slice(0, i).reduce((a, b) => a + b + ST_GAP, 0));
  ST.total = ST.widths.reduce((a, b) => a + b, 0) + Math.max(0, mids.length - 1) * ST_GAP;
  if (opts.grow) { const el = track.querySelector(`.stw[data-wid="${opts.grow}"]`), f = opts.from;
    if (el?.animate) { if (f) { const r = el.getBoundingClientRect(); el.animate([{ transformOrigin: "0 0", transform: `translate(${(f.left - r.left) / ST.cam.z}px, ${(f.top - r.top) / ST.cam.z}px) scale(.03)`, opacity: .3 }, { transformOrigin: "0 0", transform: "none", opacity: 1 }], { duration: 460, easing: "cubic-bezier(.2,.8,.2,1)" }); }
      else el.animate([{ opacity: 0, transform: "translateY(40px) scale(.96)" }, { opacity: 1, transform: "none" }], { duration: 360, easing: "cubic-bezier(.2,.8,.2,1)" }); } }
  mids.forEach((w) => stCtx(w));
  if (ST.cardsAt !== `${ST.total}|${ST.H}|${mids.length}`) { ST.cardsAt = `${ST.total}|${ST.H}|${mids.length}`; stCanvas(); }     // the cards beside the windows follow their edges
  stApply(); stBar();
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
    h = { sx: e.screenX, sy: e.screenY, cx: ST.cam.x, cy: ST.cam.y, on: false, t: setTimeout(() => { if (!h) return; h.on = true; doc.documentElement.classList.add("stgrab"); $("#vStage").classList.add("panning"); cw.getSelection()?.removeAllRanges(); }, 300) };
  }, true);
  doc.addEventListener("pointermove", (e) => {
    if (!h) return;
    if (!h.on) { if (Math.hypot(e.screenX - h.sx, e.screenY - h.sy) > 5) { clearTimeout(h.t); h = null; } return; }     // moved before the hold: selecting text
    e.preventDefault(); cw.getSelection()?.removeAllRanges(); stPanTo(h.cx + (e.screenX - h.sx), h.cy + (e.screenY - h.sy));
  }, true);
  const end = () => { if (!h) return; clearTimeout(h.t); const was = h.on; h = null; doc.documentElement.classList.remove("stgrab"); $("#vStage").classList.remove("panning"); if (was) stSettle(); };
  doc.addEventListener("pointerup", end, true); doc.addEventListener("pointercancel", end, true);
  doc.addEventListener("selectstart", (e) => { if (h?.on) e.preventDefault(); }, true);
  const st = doc.createElement("style"); st.textContent = "html.stgrab, html.stgrab * { cursor: grabbing !important; user-select: none !important; }"; doc.head.appendChild(st);
}
/* free size: drag an edge or a corner; the window keeps its place on the rails, the others make room */
function stResizeStart(e, rz) {
  const el = rz.closest(".stw"), w = ST.wins.find((x) => x.id === el.dataset.wid); if (!w || w.mode === "max") return;
  const win = el.querySelector(".stwin"), mid = el.querySelector(".stmid");
  ST.rz = { w, d: rz.dataset.rz, x: e.clientX, y: e.clientY, w0: el.offsetWidth, h0: win.offsetHeight, t0: win.offsetTop, H: mid.clientHeight, cx: ST.cam.x };
  $("#vStage").setPointerCapture?.(e.pointerId); $("#vStage").classList.add("resizing"); e.preventDefault(); stFocus(w.id);
}
function stResizeMove(e) {
  const r = ST.rz, z = ST.cam.z, dx = (e.clientX - r.x) / z, dy = (e.clientY - r.y) / z, bw = $("#vStage").clientWidth / z - 88;
  if (r.d.includes("e")) r.w.w = Math.round(Math.max(300, Math.min(bw, r.w0 + dx)));
  if (r.d.includes("w")) { r.w.w = Math.round(Math.max(300, Math.min(bw, r.w0 - dx))); ST.cam.x = r.cx - (r.w.w - r.w0) * z; }      // the right edge stays put
  if (r.d.includes("s")) r.w.h = Math.round(Math.max(220, Math.min(r.H - r.t0, r.h0 + dy)));
  if (r.d.includes("n")) { const t = Math.max(0, Math.min(r.t0 + r.h0 - 220, r.t0 + dy)); r.w.top = Math.round(t); r.w.h = Math.round(r.h0 + (r.t0 - t)); }
  stLayout();
}
function stResizeEnd() { ST.rz = null; $("#vStage").classList.remove("resizing"); stSave(); }
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
    <button class="sm" data-st="new">＋ ${L("新对话", "New chat")}</button><button class="sm ghost" data-st="${ST.cam.z < .99 ? "home" : "all"}" title="${ST.cam.z < .99 ? L("回到滑轨上（Esc）", "Back on the rails (Esc)") : L("缩小，看整张画布：可以上下左右自由移动", "Zoom out over the whole canvas, to move in every direction")}">${ST.cam.z < .99 ? L("回到滑轨", "Back on the rails") : L("全景", "Overview")}</button>`;
}

/* ------------------------------------------------ pointer: move freely, zoom, resize */
function stBind() {
  const v = $("#vStage");
  v.addEventListener("wheel", (e) => {
    if (e.target.closest(".stbar")) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) { stZoomAt(e.clientX, e.clientY, ST.cam.z * Math.exp(-e.deltaY * .008)); return; }
    if (ST.cam.z < .99) stPanTo(ST.cam.x - e.deltaX, ST.cam.y - e.deltaY);
    else stPanTo(ST.cam.x - (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY), ST.cam.y);
  }, { passive: false });
  let drag = null;
  v.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".stbar, .slide")) return;
    const rz = e.target.closest("[data-rz]"); if (rz) { stResizeStart(e, rz); return; }
    if (e.target.closest("button, input, iframe") || (e.target.closest(".stwin") && !e.target.closest(".stwh"))) return;
    drag = { sx: e.clientX, sy: e.clientY, cx: ST.cam.x, cy: ST.cam.y, moved: false, dot: e.target.closest(".stcard")?.dataset.stkey, head: e.target.closest(".stwh")?.dataset.stfocus };
    v.setPointerCapture(e.pointerId); v.classList.add("panning"); cancelAnimationFrame(ST.camRaf);
  });
  v.addEventListener("pointermove", (e) => {
    if (ST.rz) { stResizeMove(e); return; }
    if (!drag) return; const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.hypot(dx, dy) > 4) drag.moved = true;
    stPanTo(drag.cx + dx, drag.cy + dy);
  });
  v.addEventListener("pointerup", () => {
    if (ST.rz) { stResizeEnd(); return; }
    if (!drag) return; const d = drag; drag = null; v.classList.remove("panning");
    if (d.moved) { stSettle(); return; }
    if (d.dot) stOpen(d.dot); else if (d.head) stFocus(d.head);
  });
  v.addEventListener("dblclick", (e) => { const rz = e.target.closest("[data-rz]"); if (!rz) return; const w = ST.wins.find((x) => x.id === rz.closest(".stw").dataset.wid); if (w) { delete w.w; delete w.h; delete w.top; stSave(); stLayout(); } });
  new ResizeObserver(() => { stLayout(); stCanvas(); }).observe(v);
}
function stSlide(dir) {                           // one window along the rails
  const vw = $("#vStage").clientWidth, z = ST.cam.z, ls = ST.lefts || [];
  const cur = ls.findIndex((l) => ST.cam.x + l * z >= 40); const i = Math.max(0, Math.min(ls.length - 1, (cur < 0 ? ls.length - 1 : cur) + dir));
  stCamTo({ x: Math.min(44, vw - 44 - ST.total * z) > 44 ? ST.cam.x : 44 - (ls[i] || 0) * z, y: ST.cam.y, z });
}

document.addEventListener("click", (e) => {
  if (S.view !== "stage") return;
  const t = e.target.closest("[data-st], [data-stw], [data-staxis], [data-stopen]"); if (!t) return;
  if (t.dataset.stopen) { e.preventDefault(); stOpen(t.dataset.stopen, { after: t.dataset.from }); return; }
  if (t.dataset.staxis) { ST.axis = t.dataset.staxis; try { localStorage.setItem("pga_st_axis", ST.axis); } catch {} stBar(); ST.wins.filter((w) => w.mode !== "min").forEach(stCtx); return; }
  if (t.dataset.stw) { const id = t.closest(".stw").dataset.wid, w = ST.wins.find((x) => x.id === id);
    if (t.dataset.stw === "min") stMin(id); else if (t.dataset.stw === "close") stClose(id); else stMax(id, w?.mode !== "max"); return; }
  const a = t.dataset.st;
  if (a === "new") stOpen(null);
  else if (a === "all") { stCamTo({ x: ST.cam.x * .45 + $("#vStage").clientWidth * .3, y: ST_TOP + ST.H * .25, z: .45 }); }
  else if (a === "home") stHome();
  else if (a === "left") stSlide(-1); else if (a === "right") stSlide(1);
});
document.addEventListener("input", (e) => { if (e.target.id !== "stRange") return; ST.range = Number(e.target.value); e.target.nextElementSibling.textContent = ST.range; try { localStorage.setItem("pga_st_range", ST.range); } catch {}
  clearTimeout(ST.rt); ST.rt = setTimeout(() => ST.wins.filter((w) => w.mode !== "min").forEach(stCtx), 200); });
document.addEventListener("keydown", (e) => { if (S.view !== "stage" || e.key !== "Escape") return; const w = ST.wins.find((x) => x.mode === "max"); if (w) stMax(w.id, false); else if (ST.cam.z < .99) stHome(); });

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

const _loadTimelineST = loadTimeline;              // the canvas fills in once every conversation is known
loadTimeline = async function (...a) { const r = await _loadTimelineST(...a); if (S.view === "stage") stCanvas(); return r; };

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
