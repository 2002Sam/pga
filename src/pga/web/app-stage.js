/* PGA app · the stage: conversation windows as soft bodies, like water beads, squeezed together inside the app.

   Everything lives inside the app's own window and nothing is pushed off it lightly:
   - the open conversations (all one size, half the width and three quarters the height they had);
   - the two foundations, world knowledge and self knowledge, with what you stacked under them;
   - cards of the conversations linked to the one you are on (by time, content or data).
   Drag any of them, by its title bar, or by holding still inside a conversation for a moment, and the others are
   shoved aside and wobble back. The walls push back, and things squash a little when pressed. When there is no room,
   they shrink, and only what cannot shrink any further is squeezed out (a card first, never a window).

   Each window is the conversation page itself (?view=chats&embed=1), with its own agent, composer and live answer. */

const ST = { wins: [], focus: null, ctx: {}, bodies: new Map(), out: new Set(), raf: 0, idle: 0,
  axis: (() => { try { return localStorage.getItem("pga_st_axis") || "time"; } catch { return "time"; } })(),
  range: (() => { try { return Number(localStorage.getItem("pga_st_range")) || 6; } catch { return 6; } })() };
const ST_GAP = 12, ST_PAD = 10, ST_WIN_W = 300, ST_FW = 270, ST_CW = 170, ST_CH = 104;
const ST_MIN = { win: .45, found: .62, card: .62 };
const stItem = (key) => recentItems().find((x) => x.item === key);
const stTitle = (key) => (key ? stItem(key)?.title || S.chats?.find((c) => c.key === key)?.title || key : L("新对话", "New chat"));
const stId = () => Math.random().toString(36).slice(2, 9);
function stSave() { try { localStorage.setItem("pga_st_wins", JSON.stringify(ST.wins.map((w) => ({ key: w.key, mode: w.mode === "max" ? "mid" : w.mode, bw: w.bw, bh: w.bh })).slice(-24))); } catch {} }
const stEW = (b) => b.bw * (b.kind === "win" ? 1 : b.s), stEH = (b) => b.bh * b.s;     // a window keeps its width, only its height gives way
const stArena = () => { const a = $("#starena"); return a ? { w: a.clientWidth, h: a.clientHeight } : { w: 1000, h: 700 }; };
const stWinW = () => { const A = stArena(), n = Math.max(1, ST.wins.filter((w) => w.mode !== "min").length);      // the windows share all the width left by the foundations
  return Math.max(300, Math.floor((A.w - 2 * ST_PAD - (ST_CW + ST_GAP) - n * ST_GAP) / n)); };
const stWinH = () => Math.round(stArena().h * .75);

/* ------------------------------------------------ the page */
function showStage() {
  document.title = "PGA";
  const v = $("#vStage");
  if (!v.dataset.ready) {
    v.dataset.ready = "1";
    v.innerHTML = `<div class="stground"></div><div class="stbar card" id="stbar"></div><div class="starena" id="starena"><svg class="stlinks" id="stlinks"></svg></div>`;
    stBind(); new ResizeObserver(stResized).observe($("#starena"));
    let saved = []; try { saved = JSON.parse(localStorage.getItem("pga_st_wins") || "[]"); } catch {}
    ST.wins = saved.filter((x) => x.key && x.mode !== "min").slice(0, 6).map((x) => ({ id: stId(), key: x.key, mode: "mid", ...(x.bw ? { bw: x.bw, bh: x.bh } : {}) }));
    if (!ST.wins.length) { const r = recentItems()[0]; if (r) ST.wins.push({ id: stId(), key: r.item, mode: "mid" }); }
    ST.focus = ST.wins[0]?.id || null;
    wtFetch().then(() => stSync());
  }
  stBar(); stSync();
}

/* ------------------------------------------------ the bodies */
function stBody(id, kind, make, at) {            // a soft body: its element, centre, base size, scale, velocity
  let b = ST.bodies.get(id);
  if (!b) {
    const el = document.createElement("div"); el.className = `stbody k-${kind}`; el.dataset.bid = id; el.innerHTML = make();
    $("#starena").appendChild(el);
    const A = stArena();
    b = { id, kind, el, x: at?.x ?? A.w * (.3 + Math.random() * .4), y: at?.y ?? A.h * (.3 + Math.random() * .4), s: at?.s ?? .2, vx: 0, vy: 0, p: 0, px: 0, py: 0, sx: 1, sy: 1, born: performance.now() };
    ST.bodies.set(id, b);
  }
  return b;
}
function stDrop(id) {
  const b = ST.bodies.get(id); if (!b) return; ST.bodies.delete(id);
  b.el.animate?.([{ opacity: 1 }, { opacity: 0, transform: b.el.style.transform + " scale(.6)" }], { duration: 260 }).finished.then(() => b.el.remove()).catch(() => b.el.remove());
  if (!b.el.animate) b.el.remove();
}
function stSync() {                               // who is on the stage: windows, foundations, the linked cards
  if (!$("#starena")) return;
  const A = stArena(), want = new Set();
  // the foundations, at the left
  for (const [k, i] of [["world", 0], ["self", 1]]) {
    const id = "f-" + k; want.add(id);
    const b = stBody(id, "found", () => "", { x: 20 + ST_CW / 2, y: A.h / 2 - ST_CH / 2 - 8 + i * (ST_CH + 16), s: .3 });
    b.bw = ST_CW; b.bh = ST_CH;                     // the same size as the other cards
  }
  stFoundRender();
  // the windows
  ST.wins.filter((w) => w.mode !== "min").forEach((w, i) => {
    const id = "w-" + w.id; want.add(id);
    const b = stBody(id, "win", () => stWinHtml(w), { x: Math.min(A.w - 160, 2 * (ST_FW + ST_GAP) + 40 + ST_WIN_W / 2 + i * (ST_WIN_W + ST_GAP)), y: A.h / 2, s: .3 });
    if (!b.framed) { b.framed = true; b.win = w; stFrame(w, b.el); }
    b.bw = w.bw || stWinW(); b.bh = w.bh || stWinH();
    b.el.classList.toggle("focus", ST.focus === w.id);
  });
  // the cards: what the focused conversation links to, and the windows you minimised
  for (const c of stCards()) {
    const id = "c-" + c.item; want.add(id);
    const spot = ST.spot?.item === c.item ? ST.spot : null;
    const b = stBody(id, "card", () => "", spot ? { x: spot.x, y: spot.y, s: .2 } : c.from || { x: A.w - 100, y: 80 + Math.random() * (A.h - 160), s: .3 });
    b.card = c; b.bw = ST_CW; b.bh = ST_CH;
    b.el.innerHTML = `<div class="stcard ${c.parked ? "parked" : ""}" data-stkey="${esc(c.item)}" title="${esc(c.title || "")}"><i class="stcrel">${esc(c.rel)}</i><b>${esc((c.title || "").slice(0, 40))}</b><span>${esc((c.gist || "").slice(0, 46))}</span><em>${esc(agentLabel(c.agent || ""))} · ${esc(ago(c.last))}</em></div>`;
  }
  for (const id of [...ST.bodies.keys()]) if (!want.has(id)) stDrop(id);
  stSettle(); stBar();
}
function stCards() {
  const w = ST.wins.find((x) => x.id === ST.focus), open = new Set(ST.wins.filter((x) => x.mode !== "min").map((x) => x.key)), R = ST.range, out = [];
  const add = (x, rel, extra = {}) => { if (!x?.item || open.has(x.item) || out.some((y) => y.item === x.item)) return; const leaf = W.nodes.find((n) => n.ref === x.item); out.push({ ...x, rel, gist: leaf?.gist || "", ...extra }); };
  for (const p of ST.wins.filter((x) => x.mode === "min")) add(stItem(p.key) || { item: p.key, title: stTitle(p.key) }, L("最小化", "minimised"), { parked: true });
  if (w?.key) {
    const items = recentItems(), me = items.findIndex((x) => x.item === w.key), leaf = W.nodes.find((x) => x.ref === w.key);
    if (ST.axis === "time") {
      if (me >= 0) { items.slice(me + 1, me + 1 + Math.ceil(R / 2)).forEach((x) => add(x, L("之前", "before"))); items.slice(Math.max(0, me - Math.floor(R / 2)), me).forEach((x) => add(x, L("之后", "after"))); }
    } else if (ST.axis === "content") {
      (leaf ? W.nodes.filter((x) => x.parent === leaf.parent && x.kind === "leaf" && x.id !== leaf.id && !x.hidden) : []).sort((a, b) => String(b.last || "").localeCompare(String(a.last || ""))).slice(0, R)
        .forEach((x) => add(stItem(x.ref) || { item: x.ref, title: x.title, last: x.last }, L("同一主题", "same topic")));
    } else {
      const c = ST.ctx[w.key];
      if (!c) { ST.ctx[w.key] = {}; api(`/v1/users/${S.uid}/chats/${encodeURIComponent(w.key)}/context`).then((r) => { ST.ctx[w.key] = r.context || {}; stSync(); }).catch(() => {}); }
      else [...(c.related || []).map((x) => ({ item: x.ref, title: x.title })), ...(c.branched_from ? [{ item: c.branched_from.key, title: stTitle(c.branched_from.key) }] : [])].slice(0, R)
        .forEach((x) => add(stItem(x.item) || x, L("引用过", "used")));
    }
  }
  return out.filter((c) => !ST.out.has(c.item));
}

/* ------------------------------------------------ the physics: water beads in a box */
function stKick() { ST.idle = 0; if (!ST.raf) ST.raf = requestAnimationFrame(stStep); }
function stStep() {
  ST.raf = 0; if (S.view !== "stage" || !$("#starena")) return;
  const A = stArena(), bs = [...ST.bodies.values()].filter((b) => !b.max), now = performance.now();
  for (const b of bs) { b.fx = 0; b.fy = 0; b.press = 0; b.cx = 0; b.cy = 0; }
  for (let it = 0; it < 3; it++) {
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {     // overlaps push apart, along the shorter way
      const a = bs[i], b = bs[j], aw = stEW(a) / 2, ah = stEH(a) / 2, bw = stEW(b) / 2, bh = stEH(b) / 2;
      const dx = b.x - a.x, dy = b.y - a.y, ox = aw + bw + ST_GAP - Math.abs(dx), oy = ah + bh + ST_GAP - Math.abs(dy);
      if (ox <= 0 || oy <= 0) continue;
      const ma = a.pin ? 0 : 1 / (stEW(a) * stEH(a) * (a.kind === "win" ? 4 : 1)), mb = b.pin ? 0 : 1 / (stEW(b) * stEH(b) * (b.kind === "win" ? 4 : 1)), m = ma + mb; if (!m) continue;
      if (ox < oy) { const d = ox * .35 * Math.sign(dx || 1); a.x -= d * ma / m; b.x += d * mb / m; a.vx -= d * ma / m * .05; b.vx += d * mb / m * .05; a.cx += ox; b.cx += ox; }
      else { const d = oy * .35 * Math.sign(dy || 1); a.y -= d * ma / m; b.y += d * mb / m; a.vy -= d * ma / m * .05; b.vy += d * mb / m * .05; a.cy += oy; b.cy += oy; }
      a.press += Math.min(ox, oy); b.press += Math.min(ox, oy);
    }
    for (const b of bs) {                         // the walls push back
      const hw = stEW(b) / 2, hh = stEH(b) / 2;
      const l = ST_PAD + hw - b.x, r = b.x + hw - (A.w - ST_PAD), t = ST_PAD + hh - b.y, d = b.y + hh - (A.h - ST_PAD);
      const k = b.pin ? .35 : .6;
      if (l > 0) { b.x += l * k; b.vx = Math.abs(b.vx) * .3; b.press += l; b.cx += l; }
      if (r > 0) { b.x -= r * k; b.vx = -Math.abs(b.vx) * .3; b.press += r; b.cx += r; }
      if (t > 0) { b.y += t * k; b.vy = Math.abs(b.vy) * .3; b.press += t; b.cy += t; }
      if (d > 0) { b.y -= d * k; b.vy = -Math.abs(b.vy) * .3; b.press += d; b.cy += d; }
    }
  }
  let energy = 0;
  for (const b of bs) {
    b.p = b.p * .9 + b.press * .1;                // how squeezed it has been lately
    const min = ST_MIN[b.kind], grow = now - b.born < 700;
    if (grow) b.s = Math.min(1, b.s + .06);       // coming in: grows to size
    else if (b.p > 5 && !b.pin && ST.busy && (b.kind === "win" || (b.wait = (b.wait || 0) + 1) > 45)) b.s = Math.max(min, b.s - .003 * Math.min(3, b.p / 5));     // windows give way in height; the small ones move first, then shrink
    else if (b.p < 2 && (b.wait = 0, b.s < 1)) { b.s = Math.min(1, b.s + .006); energy += 1; }      // room again: swells back
    if (b.kind === "card" && ST.busy && b.s <= min + .001 && b.p > 18) { b.squeezed = (b.squeezed || 0) + 1; if (b.squeezed > 70) { ST.out.add(b.card.item); stDrop(b.id); continue; } } else b.squeezed = 0;
    if (!b.pin) { b.x += b.vx; b.y += b.vy; b.vx *= .6; b.vy *= .6; }
    b.sx += ((1 - (ST.busy ? Math.min(.035, b.cx / 600) : 0)) - b.sx) * .2; b.sy += ((1 - (ST.busy ? Math.min(.035, b.cy / 600) : 0)) - b.sy) * .2;       // a slight squash where it is pressed, only while you move things
    energy += Math.abs(b.vx) + Math.abs(b.vy) + b.press + (grow ? 1 : 0) + Math.abs(1 - b.sx) * 40;
    if (b.kind === "win") {                        // a window really gets shorter (no shrunk text): its height is set, not scaled
      const h = Math.round(stEH(b)); b.el.style.width = b.bw + "px"; b.el.style.height = h + "px";
      b.el.style.transform = `translate(${b.x - b.bw / 2}px, ${b.y - h / 2}px) scale(${b.sx.toFixed(4)}, ${b.sy.toFixed(4)})`;
    } else {
      b.el.style.width = b.bw + "px"; b.el.style.height = b.bh + "px";
      b.el.style.transform = `translate(${b.x - b.bw / 2}px, ${b.y - b.bh / 2}px) scale(${(b.s * b.sx).toFixed(4)}, ${(b.s * b.sy).toFixed(4)})`;
    }
  }
  stLinks();
  ST.idle = energy < .6 ? ST.idle + 1 : 0;
  if (ST.idle < 30 || bs.some((b) => b.pin)) ST.raf = requestAnimationFrame(stStep);
}
setInterval(() => {                               // squeezed out: back in on its own once there is room
  if (S.view !== "stage" || ST.busy || !ST.out.size) return;
  const A = stArena(), bs = [...ST.bodies.values()], w = ST_CW * .7, h = ST_CH * .7;      // a free spot a shrunk card fits in
  const free = (x, y) => x - w / 2 > ST_PAD && x + w / 2 < A.w - ST_PAD && y - h / 2 > ST_PAD && y + h / 2 < A.h - ST_PAD
    && bs.every((b) => Math.abs(b.x - x) > (stEW(b) + w) / 2 + ST_GAP || Math.abs(b.y - y) > (stEH(b) + h) / 2 + ST_GAP);
  for (let y = h / 2 + ST_PAD + 4; y < A.h; y += 24) for (let x = A.w - w / 2 - ST_PAD - 4; x > 0; x -= 24)
    if (free(x, y)) { const k = [...ST.out].pop(); ST.out.delete(k); ST.spot = { item: k, x, y }; stSync(); return; }
}, 1500);
function stSettle(ms = 1400) {                   // something was opened, closed or the room changed: everything finds its place once
  ST.busy = true; clearTimeout(ST.bt); ST.bt = setTimeout(() => { if (!ST.drag && !ST.rz) ST.busy = false; stKick(); }, ms); stKick();
}
function stResized() {                           // the room changed size: windows and foundations follow it
  if (S.view !== "stage") return; const A = stArena(); if (A.h < 200) return;
  for (const b of ST.bodies.values()) { if (b.kind === "win") { if (!b.win?.bh) b.bh = stWinH(); if (!b.win?.bw) b.bw = stWinW(); } if (b.kind === "found") b.bh = Math.round(A.h * .86); }
  stKick();
}

/* ------------------------------------------------ the windows */
function stOpen(key, opts = {}) {
  let w = key && ST.wins.find((x) => x.key === key);
  const card = key && ST.bodies.get("c-" + key);
  if (w) w.mode = "mid"; else { w = { id: stId(), key: key || null, mode: "mid" }; ST.wins.push(w); }
  ST.out.delete(key); ST.focus = w.id; stSave();
  if (card) { const id = "w-" + w.id; const b = stBody(id, "win", () => stWinHtml(w), { x: card.x, y: card.y, s: .25 }); b.framed = true; b.win = w; stFrame(w, b.el); }
  stSync(); return w;
}
function stClose(id) { ST.wins = ST.wins.filter((w) => w.id !== id); if (ST.focus === id) ST.focus = ST.wins.find((w) => w.mode === "mid")?.id || null; stSave(); stSync(); }
function stMin(id) { const w = ST.wins.find((x) => x.id === id); if (!w) return; w.mode = "min"; if (ST.focus === id) ST.focus = ST.wins.find((x) => x.mode === "mid")?.id || null; stSave(); stSync(); }
function stMax(id, on = true) {                   // the whole app; the conversation page with its right panel
  const w = ST.wins.find((x) => x.id === id), b = ST.bodies.get("w-" + id); if (!w || !b) return;
  w.mode = on ? "max" : "mid"; b.max = on; ST.focus = id;
  const win = b.el.querySelector(".stwin");
  if (on) { b.el.style.transform = "none"; b.el.style.left = "0"; b.el.style.top = "0"; }
  win.classList.toggle("max", on); $("#vStage").classList.toggle("hasmax", on);
  try { win.querySelector("iframe").contentDocument.documentElement.classList.toggle("efull", on); } catch {}
  win.animate?.([{ opacity: .4, transform: on ? "scale(.9)" : "scale(1.04)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" });
  stBar(); stKick();
}
function stWinHtml(w) {
  return `<div class="stwin">${["n", "s", "e", "w", "ne", "nw", "se", "sw"].map((d) => `<i class="rz rz-${d}" data-rz="${d}" title="${L("拖动改大小，双击还原", "Drag to resize, double-click to reset")}"></i>`).join("")}<div class="stwh" data-stfocus="${w.id}"><b class="stwt">${esc(stTitle(w.key))}</b><span class="grow"></span>
      <button class="stb" data-stw="min" title="${L("最小化：变成一张卡片", "Minimise: a card")}">–</button><button class="stb" data-stw="max" title="${L("最大化：占满整个窗口（Esc 还原）", "Maximise: the whole window (Esc restores)")}">▢</button><button class="stb" data-stw="close" title="${L("关掉这个窗口（对话还在）", "Close the window (the conversation stays)")}">×</button></div>
      <iframe title="conversation"></iframe></div>`;
}
function stFrame(w, el) {
  const q = new URLSearchParams({ view: "chats", embed: "1" });
  if (w.key) { if (S.allChats?.some((c) => c.key === w.key) || w.key.startsWith("chat:")) q.set("c", w.key); else q.set("item", w.key); }
  if (AS_UID) q.set("as", AS_UID); if (Q.get("lang")) q.set("lang", Q.get("lang"));
  const f = el.querySelector("iframe"); f.src = "/?" + q;
  f.addEventListener("load", () => { try { stHold(f, w); } catch {} });
}
function stHold(f, w) {                          // inside a conversation: press and hold (~0.3 s, still), then move the window
  const cw = f.contentWindow, doc = cw.document; let h = null;
  doc.addEventListener("pointerdown", (e) => {
    stFocus(w.id);
    if (e.button !== 0 || e.target.closest("input, textarea, select, button, a, [contenteditable], .cbar")) return;
    h = { sx: e.screenX, sy: e.screenY, on: false, t: setTimeout(() => { if (!h) return; h.on = true; doc.documentElement.classList.add("stgrab"); stGrab("w-" + w.id, h.sx, h.sy); cw.getSelection()?.removeAllRanges(); }, 300) };
  }, true);
  doc.addEventListener("pointermove", (e) => {
    if (!h) return;
    if (!h.on) { if (Math.hypot(e.screenX - h.sx, e.screenY - h.sy) > 5) { clearTimeout(h.t); h = null; } return; }     // moved before the hold: selecting text
    e.preventDefault(); cw.getSelection()?.removeAllRanges(); stDragTo(e.screenX, e.screenY);
  }, true);
  const end = () => { if (!h) return; clearTimeout(h.t); const was = h.on; h = null; doc.documentElement.classList.remove("stgrab"); if (was) stRelease(); };
  doc.addEventListener("pointerup", end, true); doc.addEventListener("pointercancel", end, true);
  doc.addEventListener("selectstart", (e) => { if (h?.on) e.preventDefault(); }, true);
  const st = doc.createElement("style"); st.textContent = "html.stgrab, html.stgrab * { cursor: grabbing !important; user-select: none !important; }"; doc.head.appendChild(st);
}

/* ------------------------------------------------ dragging a body: it follows the pointer, the rest is shoved aside */
function stGrab(id, sx, sy) {                     // screen coordinates (screenX/Y work across the frames)
  const b = ST.bodies.get(id); if (!b) return;
  ST.drag = { b, sx, sy, x0: b.x, y0: b.y, lx: sx, ly: sy, moved: false }; b.pin = true; b.vx = b.vy = 0;
  b.el.classList.add("held"); $("#vStage").classList.add("dragging"); ST.busy = true; clearTimeout(ST.bt); stKick();
}
function stDragTo(sx, sy) {
  const d = ST.drag; if (!d) return; const b = d.b;
  if (Math.hypot(sx - d.sx, sy - d.sy) > 4) d.moved = true;
  b.x = d.x0 + (sx - d.sx); b.y = d.y0 + (sy - d.sy); b.vx = (sx - d.lx) * .6; b.vy = (sy - d.ly) * .6; d.lx = sx; d.ly = sy; stKick();
}
function stRelease() {
  const d = ST.drag; ST.drag = null; if (!d) return; d.b.pin = false; d.b.el.classList.remove("held"); $("#vStage").classList.remove("dragging");
  clearTimeout(ST.bt); ST.bt = setTimeout(() => { ST.busy = false; stKick(); }, 500); stKick();
  return d;
}

/* free size: drag an edge or a corner of a window */
function stResizeStart(e, rz) {
  const b = ST.bodies.get(rz.closest(".stbody").dataset.bid); if (!b || b.kind !== "win" || b.max) return;
  ST.rz = { b, d: rz.dataset.rz, x: e.clientX, y: e.clientY, w0: b.bw, h0: b.bh, x0: b.x, y0: b.y }; b.pin = true;
  $("#vStage").classList.add("dragging"); ST.busy = true; clearTimeout(ST.bt); e.preventDefault(); stFocus(b.win.id); stKick();
}
function stResizeMove(e) {
  const r = ST.rz, b = r.b, A = stArena(), dx = (e.clientX - r.x) / b.s, dy = (e.clientY - r.y) / b.s;
  let w = r.w0, h = r.h0;
  if (r.d.includes("e")) w = r.w0 + dx; if (r.d.includes("w")) w = r.w0 - dx;
  if (r.d.includes("s")) h = r.h0 + dy; if (r.d.includes("n")) h = r.h0 - dy;
  w = Math.max(240, Math.min(A.w - 20, w)); h = Math.max(220, Math.min(A.h - 20, h));
  b.x = r.x0 + (r.d.includes("e") ? 1 : r.d.includes("w") ? -1 : 0) * (w - r.w0) * b.s / 2;      // the opposite edge stays put
  b.y = r.y0 + (r.d.includes("s") ? 1 : r.d.includes("n") ? -1 : 0) * (h - r.h0) * b.s / 2;
  b.bw = Math.round(w); b.bh = Math.round(h); b.win.bw = b.bw; b.win.bh = b.bh; stKick();
}
function stResizeEnd() { const r = ST.rz; ST.rz = null; if (r) r.b.pin = false; $("#vStage").classList.remove("dragging"); clearTimeout(ST.bt); ST.bt = setTimeout(() => { ST.busy = false; stKick(); }, 500); stSave(); stKick(); }
function stFocus(id) { if (ST.focus === id) return; ST.focus = id; for (const b of ST.bodies.values()) if (b.kind === "win") b.el.classList.toggle("focus", b.win?.id === id); clearTimeout(ST.ft); ST.ft = setTimeout(stSync, 250); }
setInterval(() => {                               // a new conversation in a window gets its key once you send; titles follow
  for (const w of ST.wins) {
    const f = ST.bodies.get("w-" + w.id)?.el.querySelector("iframe"); let k = null; try { k = f?.contentWindow?.S?.chat || null; } catch {}
    if (k && k !== w.key) { w.key = k; stSave(); stSync(); }
    const t = ST.bodies.get("w-" + w.id)?.el.querySelector(".stwt"); if (t && w.key) { const s = stTitle(w.key); if (t.textContent !== s) t.textContent = s; }
  }
}, 2500);

/* ------------------------------------------------ the two foundations: what PGA knows of the world and of you, with what you stack under them */
const ST_KIND = { skill: ["技能", "Skill"], doc: ["资料", "Library"], file: ["文件", "File"] };
function stStacks() { try { return JSON.parse(localStorage.getItem("pga_st_found") || "{}"); } catch { return {}; } }
function stFoundRender() {
  const K = S.forest?.knowledge || [], world = K.find((k) => k.system === "world"), self = K.find((k) => k.system === "user"), P = S.forest?.personal, st = stStacks();
  const card = (k, title, line, doc) => `<div class="stcard stfcard ${k}" title="${esc(line)}">
      <b class="stfk" ${doc ? `data-doc="${doc}"` : ""}>${title}</b><span>${esc(line.slice(0, 60))}</span>
      <em>${(st[k] || []).length ? L(`下面插了 ${(st[k] || []).length} 项`, `${(st[k] || []).length} stacked`) : L("还没插东西", "nothing stacked")}<button class="stfplus" data-ststack="${k}" title="${L("插入技能、资料或文件", "Insert a skill, a document or a file")}">＋</button></em></div>`;
  const html = {
    world: card("world", L("世界知识", "World knowledge"), world?.gist || world?.brief || L("还没有整理", "not compiled yet"), world?.id),
    self: card("self", L("自我知识", "Self knowledge"), P ? ["goals", "background", "abilities"].map((d) => P[d]?.summary).filter(Boolean)[0] || "" : L("还没有整理", "not compiled yet"), self?.id) };
  for (const k of ["world", "self"]) { const b = ST.bodies.get("f-" + k); if (b && b.el.dataset.sig !== html[k]) { b.el.dataset.sig = html[k]; b.el.innerHTML = html[k]; } }
}
function stLinks() {                              // both foundations feed every window: a root for each
  const svg = $("#stlinks"); if (!svg) return;
  const fw = ST.bodies.get("f-world"), fs = ST.bodies.get("f-self");
  const root = (f, b, cls) => { if (!f || !b) return ""; const x0 = f.x + stEW(f) / 2, y0 = f.y - stEH(f) / 2 + 40, x1 = b.x - stEW(b) / 2, y1 = b.y - stEH(b) / 2 + 18;
    return `<path class="${cls}" d="M ${x0} ${y0} C ${x0 + 90} ${y0}, ${x1 - 90} ${y1}, ${x1} ${y1}"/>`; };
  svg.innerHTML = [...ST.bodies.values()].filter((b) => b.kind === "win" && !b.max).map((b) => root(fw, b, "lw") + root(fs, b, "ls")).join("");
}
document.addEventListener("click", async (e) => {
  const un = e.target.closest("[data-stunstack]"); if (un) { e.stopPropagation(); const [k, i] = un.dataset.stunstack.split("|"), st = stStacks(); (st[k] || []).splice(Number(i), 1); localStorage.setItem("pga_st_found", JSON.stringify(st)); stFoundRender(); return; }
  const add = e.target.closest("[data-ststack]"); if (!add) return;
  const k = add.dataset.ststack;
  let pal = { skills: [], images: [] }; try { pal = await api(`/v1/users/${S.uid}/canvas-palette`); } catch {}
  const lib = (S.forest?.knowledge || []).filter((x) => !["user", "world"].includes(x.system));
  const rows = [...lib.map((x) => ({ type: x.kind === "skill" ? "skill" : "doc", id: x.id, title: x.title, sub: x.gist || "" })),
    ...pal.skills.map((x) => ({ type: "skill", id: x.path, title: x.name, sub: `${x.source === "hermes" ? "Hermes" : "Claude Code"} · ${x.description}` })),
    ...pal.images.map((x) => ({ type: "file", id: x.path, title: x.name, sub: L("上传过的图片", "an uploaded picture") }))];
  modal(`<h2>${k === "world" ? L("插到「世界知识」下面", "Insert under world knowledge") : L("插到「自我知识」下面", "Insert under self knowledge")}</h2>
    <input id="stPick" placeholder="${L("搜技能、资料、文件…", "Search skills, documents, files…")}" style="width:100%;margin:6px 0 10px">
    <div class="stpick" id="stPickList">${rows.map((r, i) => `<div class="stpr" data-stpick="${i}" data-q="${esc((r.title + " " + r.sub).toLowerCase())}"><i class="t-${r.type}">${L(...ST_KIND[r.type])}</i><b>${esc(r.title)}</b><span>${esc(r.sub.slice(0, 90))}</span></div>`).join("")}</div>`);
  const box = $("#stPickList");
  $("#stPick").addEventListener("input", (ev) => { const q = ev.target.value.toLowerCase(); box.querySelectorAll(".stpr").forEach((r) => { r.hidden = q && !r.dataset.q.includes(q); }); });
  box.addEventListener("click", (ev) => { const r = ev.target.closest("[data-stpick]"); if (!r) return; const st = stStacks(); (st[k] = st[k] || []).push(rows[Number(r.dataset.stpick)]);
    localStorage.setItem("pga_st_found", JSON.stringify(st)); document.querySelector(".modal")?.remove(); stFoundRender();
    document.querySelector(`.stfc.${k} .stfi:last-of-type`)?.animate?.([{ opacity: 0, transform: "translateY(-14px) scale(.96)" }, { opacity: 1, transform: "none" }], { duration: 380, easing: "cubic-bezier(.2,.8,.2,1)" }); });
});


/* ------------------------------------------------ the bar */
function stBar() {
  const bar = $("#stbar"); if (!bar) return;
  const mids = ST.wins.filter((w) => w.mode !== "min").length;
  bar.innerHTML = `<span class="cvdim">${L("旁边的卡片：", "Cards around:")}</span><span class="seg stax">${[["time", L("时间", "Time")], ["content", L("内容", "Content")], ["data", L("数据", "Data")]].map(([k, t]) => `<button class="${ST.axis === k ? "on" : ""}" data-staxis="${k}">${t}</button>`).join("")}</span>
    <label class="strange" title="${L("显示几张相关的对话卡片", "How many linked conversations to show")}">${L("范围", "Reach")}<input type="range" min="2" max="12" value="${ST.range}" id="stRange"><em>${ST.range}</em></label>
    <span class="grow"></span><span class="cvdim">${L(`${mids} 个窗口`, `${mids} open`)}${ST.out.size ? ` · <a href="#" data-st="unout">${L(`${ST.out.size} 张被挤出去了，放回来`, `${ST.out.size} squeezed out: bring back`)}</a>` : ""}</span>
    <button class="sm" data-st="new">＋ ${L("新对话", "New chat")}</button>`;
}

/* ------------------------------------------------ pointer */
function stBind() {
  const v = $("#vStage");
  v.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".stbar")) return;
    const rz = e.target.closest("[data-rz]"); if (rz) { stResizeStart(e, rz); v.setPointerCapture(e.pointerId); return; }
    if (e.target.closest("button, input, iframe, a, .stfb, .stfs")) return;
    const body = e.target.closest(".stbody"); if (!body) return;
    const b = ST.bodies.get(body.dataset.bid); if (!b || b.max) return;
    if (b.kind === "win" && !e.target.closest(".stwh")) return;
    ST.click = { key: b.card?.item, win: b.win?.id };
    stGrab(b.id, e.screenX, e.screenY); v.setPointerCapture(e.pointerId);
  });
  v.addEventListener("pointermove", (e) => { if (ST.rz) { stResizeMove(e); return; } if (ST.drag) stDragTo(e.screenX, e.screenY); });
  v.addEventListener("pointerup", () => {
    if (ST.rz) { stResizeEnd(); return; }
    const d = stRelease(); const c = ST.click; ST.click = null;
    if (d && !d.moved && c) { if (c.key) stOpen(c.key); else if (c.win) stFocus(c.win); }
  });
  v.addEventListener("dblclick", (e) => { const rz = e.target.closest("[data-rz]"); if (!rz) return; const b = ST.bodies.get(rz.closest(".stbody").dataset.bid); if (b?.win) { delete b.win.bw; delete b.win.bh; b.bw = stWinW(); b.bh = stWinH(); stSave(); stKick(); } });
}
document.addEventListener("click", (e) => {
  if (S.view !== "stage") return;
  const t = e.target.closest("[data-st], [data-stw], [data-staxis]"); if (!t) return;
  e.preventDefault();
  if (t.dataset.staxis) { ST.axis = t.dataset.staxis; try { localStorage.setItem("pga_st_axis", ST.axis); } catch {} stSync(); return; }
  if (t.dataset.stw) { const id = t.closest(".stbody").dataset.bid.slice(2), w = ST.wins.find((x) => x.id === id);
    if (t.dataset.stw === "min") stMin(id); else if (t.dataset.stw === "close") stClose(id); else stMax(id, w?.mode !== "max"); return; }
  const a = t.dataset.st;
  if (a === "new") stOpen(null);
  else if (a === "unout") { ST.out.clear(); stSync(); }
});
document.addEventListener("input", (e) => { if (e.target.id !== "stRange") return; ST.range = Number(e.target.value); e.target.nextElementSibling.textContent = ST.range; try { localStorage.setItem("pga_st_range", ST.range); } catch {}
  clearTimeout(ST.rt); ST.rt = setTimeout(stSync, 200); });
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

const _loadTimelineST = loadTimeline;              // the cards fill in once every conversation is known
loadTimeline = async function (...a) { const r = await _loadTimelineST(...a); if (S.view === "stage") stSync(); return r; };

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
