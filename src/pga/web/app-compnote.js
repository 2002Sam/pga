/* 输入框 (the composer) moves — press and hold anywhere on it (on its text or buttons a moment longer, so typing and
   clicking stay as they are) and it lifts under your pointer:
   - in its page it is pulled toward the gap between two messages it is near (a line shows where); let go and it settles
     there, the text before it above and the rest below;
   - past the edge of the page it becomes a 随记 (note) of its own, still in your hand, floating over the whole app. It
     keeps the composer's look; ☰ unfolds all you have asked in this conversation as one document. Hold it the same way
     to move it; brought back over its conversation it is pulled in (the line shows where) and let go it snaps back into
     the page as the composer. What you send from it goes to its conversation. */
const CM = { at: (() => { try { return JSON.parse(localStorage.getItem("pga_comp_at") || "{}"); } catch { return {}; } })() };
const cmKey = () => S.chat || (S.imp ? `c:${S.imp.cid}` : null);
const cmHost = () => { try { if (window.parent !== window && window.parent.cnOpen) return window.parent; } catch {} return window; };
function cmNotes() { try { return JSON.parse(localStorage.getItem("pga_cn") || "{}"); } catch { return {}; } }
function cmSaveNotes(x) { try { localStorage.setItem("pga_cn", JSON.stringify(x)); } catch {} }
const cmBlocks = () => [...($("#cdlgIn")?.children || [])].filter((x) => !x.classList.contains("cslot") && x.offsetHeight > 0);

/* ------------------------------------------------ inside a conversation: its place between messages, or out of the page */
function cmApply() {
  const k = cmKey(); if (!$("#vChats")) return;
  const out = !!(k && cmNotes()[k]?.open); document.documentElement.classList.toggle("compout", out);
  if (out) { const h = cmHost(); try { if (!h.document.querySelector(`.cnote[data-cn="${CSS.escape(k)}"]`)) h.cnOpen({ key: k, title: cmTitle(), src: window }); else h.cnSrc?.(k, window); } catch {} }
  if (!$("#cback")) $(".cpane")?.insertAdjacentHTML("beforeend", `<div class="cback" id="cback"><span>${L("输入框在随记里", "The composer is in a note")}</span><button class="sm" data-cmback>${L("↩ 放回这里", "↩ Put it back here")}</button></div>`);
  if (!CM.drag || CM.drag.note) cmPlace(k && !out ? CM.at[k] : null);    // not while it is in your hand
}
function cmPlace(at) {                             // between messages: an empty slot in the text the composer sits on
  const box = $("#cdlgIn"), comp = $("#ccomp"); if (!box || !comp) return;
  let slot = box.querySelector(".cslot");
  if (at == null) { slot?.remove(); document.documentElement.classList.remove("cinline"); comp.style.top = ""; return; }
  const bs = cmBlocks(); at = Math.max(0, Math.min(bs.length, at));
  if (!slot) { slot = document.createElement("div"); slot.className = "cslot"; }
  if (at >= bs.length) box.appendChild(slot); else if (bs[at] !== slot.nextElementSibling) box.insertBefore(slot, bs[at]);
  document.documentElement.classList.add("cinline");
  slot.style.height = comp.offsetHeight + 16 + "px";
  cmFollow();
}
function cmFollow() {                              // the composer rides on its slot as the conversation scrolls (kept within view)
  const slot = $("#cdlgIn .cslot"), comp = $("#ccomp"), dlg = $("#cdlg"), pane = $(".cpane"); if (!slot || !comp || !dlg || !pane || (CM.drag && !CM.drag.note)) return;
  const p = pane.getBoundingClientRect(), d = dlg.getBoundingClientRect(), s = slot.getBoundingClientRect();
  const top = Math.max(d.top, Math.min(d.bottom - comp.offsetHeight, s.top + 8));
  comp.style.top = top - p.top + "px";
}
const cmTitle = () => (S.chat ? (S.chats || []).find((c) => c.key === S.chat)?.title : S.impData?.title) || $("#chead h1")?.textContent || "";
const _renderChatCM = renderChat;
renderChat = function (...a) { const r = _renderChatCM(...a); try { cmApply(); } catch {} return r; };
document.addEventListener("scroll", (e) => { if (e.target?.id === "cdlg") cmFollow(); }, true);
window.addEventListener("resize", () => { const k = cmKey(); if (k && CM.at[k] != null) cmPlace(CM.at[k]); });

/* ------------------------------------------------ holding: shared by the composer and the note */
const CM_HOLD = 260;
const cmHot = (t) => t.closest?.("textarea, input, select, button, a, label, [contenteditable], .chip, .refs, .atts, .impchip, .cnp");
function cmPress(e, start) {                       // a press: on an empty part it moves at once; on text or a button only after a hold
  const p = { x: e.clientX, y: e.clientY, id: e.pointerId, hot: !!cmHot(e.target), start, on: false };
  if (p.hot) p.t = setTimeout(() => { if (!p.on && !p.dead) { p.on = true; start(p); } }, CM_HOLD); else e.preventDefault();
  return p;
}
function cmPressMove(p, e) {                       // true once the press has become a move
  if (p.on) return true;
  if (Math.hypot(e.clientX - p.x, e.clientY - p.y) < 5) return false;
  clearTimeout(p.t); p.dead = true; if (p.hot) return false;    // on text or a button that was a selection or a click
  p.on = true; p.start(p); return true;
}
const cmFrame = () => { try { return window.frameElement; } catch { return null; } };
function cmToHost(x, y) {                          // a point in this page → the app around it
  const f = cmFrame(); if (!f || cmHost() === window) return { x, y };
  const r = f.getBoundingClientRect(), s = r.width / (f.offsetWidth || r.width) || 1;
  return { x: r.left + x * s, y: r.top + y * s };
}
function cmNearest(cy, d) {                        // the landing place nearest to a height: before a message, or the bottom
  const bs = cmBlocks(); let best = { at: null, y: d.bottom - 3 }, bd = Math.abs(cy - (d.bottom - 40));
  for (let i = 0; i < bs.length; i++) {
    const r = bs[i].getBoundingClientRect(); if (r.bottom < d.top - 300) continue; if (r.top > d.bottom + 300) break;
    const y = i ? (bs[i - 1].getBoundingClientRect().bottom + r.top) / 2 : r.top - 4; if (y < d.top + 4 || y > d.bottom - 4) continue;
    const dd = Math.abs(cy - y); if (dd < bd) { bd = dd; best = { at: i, y }; }
  }
  return best;
}
function cmLine(best) {                            // where it will land
  const pane = $(".cpane"); if (!best || !pane) { CM.line?.remove(); CM.line = null; return; }
  if (!CM.line) { CM.line = document.createElement("div"); CM.line.className = "cmline"; pane.appendChild(CM.line); }
  CM.line.style.top = best.y - pane.getBoundingClientRect().top - 1.5 + "px"; CM.line.classList.toggle("bottom", best.at == null);
}

/* ------------------------------------------------ the composer in its page */
document.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || CM.drag || CM.press || document.documentElement.classList.contains("compout") || !e.target.closest?.("#ccomp")) return;
  if (e.target.closest("select, option, input[type=range]")) return;     // a menu opens under a still pointer: never taken for a hold
  CM.press = cmPress(e, cmLift);
}, true);
document.addEventListener("pointermove", (e) => {
  const p = CM.press;
  if (p && !cmPressMove(p, e)) { if (p.dead) CM.press = null; return; }
  const m = CM.drag; if (!m) return;
  e.preventDefault(); m.px = e.clientX; m.py = e.clientY;
  if (!m.raf) m.raf = requestAnimationFrame(() => { m.raf = 0; cmMove(); });
}, true);
const cmEnd = () => {
  const p = CM.press; CM.press = null; if (p) { clearTimeout(p.t); p.dead = true; }
  const m = CM.drag; if (!m) return; cancelAnimationFrame(m.raf); m.raf = 0; cmMove(); cmLand();
};
document.addEventListener("pointerup", cmEnd, true); document.addEventListener("pointercancel", cmEnd, true);
function cmLift(p) {
  const comp = $("#ccomp"), pane = $(".cpane"); if (!comp || !pane || !$("#cdlg")) return;
  const r = comp.getBoundingClientRect(), pr = pane.getBoundingClientRect();
  try { document.documentElement.setPointerCapture(p.id); } catch {}
  document.activeElement?.blur?.(); getSelection()?.removeAllRanges();
  CM.drag = { k: cmKey(), dx: p.x - r.left, dy: p.y - r.top, h: r.height, px: p.x, py: p.y, at: CM.at[cmKey()] ?? null };
  comp.style.top = r.top - pr.top + "px";
  document.documentElement.classList.add("cmoving", "cmlift");
  cmMove();
}
function cmMove() {
  const m = CM.drag; if (!m) return;
  if (m.note) { const p = cmToHost(m.px, m.py); try { cmHost().cnDragTo(m.note, p.x, p.y, m.ox, m.oy); } catch {} return; }
  const pane = $(".cpane"), dlg = $("#cdlg"), comp = $("#ccomp"); if (!pane || !dlg || !comp) return;
  const pr = pane.getBoundingClientRect();
  if (m.px < pr.left - 24 || m.px > pr.right + 24 || m.py < pr.top - 24 || m.py > pr.bottom + 24) { cmOut(m); return; }   // out of the page
  const d = dlg.getBoundingClientRect();
  if (m.py < d.top + 36) dlg.scrollTop -= 14; else if (m.py > d.bottom - 36 && m.py < d.bottom + 24) dlg.scrollTop += 14;   // near an edge: it scrolls
  const raw = m.py - m.dy, best = cmNearest(raw + m.h / 2, d);
  const target = best.at == null ? d.bottom - m.h : best.y - m.h / 2;
  const pull = Math.max(0, 1 - Math.abs(raw - target) / 80) * .6;            // near a landing place it is pulled toward it
  comp.style.top = raw + (target - raw) * pull - pr.top + "px";
  comp.classList.toggle("snap", pull > .3); m.at = best.at; cmLine(best);
}
function cmLand() {
  const m = CM.drag; CM.drag = null; document.documentElement.classList.remove("cmoving");
  if (m.note) { try { cmHost().cnDragEnd(m.note); } catch {} return; }
  const comp = $("#ccomp"); if (!comp) return; const before = comp.getBoundingClientRect().top;
  cmLine(null); comp.classList.remove("snap"); document.documentElement.classList.remove("cmlift");
  if (m.k) { if (m.at == null) delete CM.at[m.k]; else CM.at[m.k] = m.at; try { localStorage.setItem("pga_comp_at", JSON.stringify(CM.at)); } catch {} }
  cmPlace(m.at);
  const dy = before - comp.getBoundingClientRect().top;                      // it settles from where you let go
  comp.animate?.([{ transform: `translateY(${dy}px) scale(1.01)` }, { transform: "none" }], { duration: 240, easing: "cubic-bezier(.2,.8,.2,1)" });
}
function cmOut(m) {                                // past the edge: a note, still held
  cmLine(null); $("#ccomp")?.classList.remove("snap");
  if (!m.k) { CM.drag = null; document.documentElement.classList.remove("cmoving", "cmlift"); cmPlace(null); toast(L("先发一句，这段对话有了名字再拿出来", "Send something first, so the conversation has a name")); return; }
  const at = cmToHost(m.px, m.py), ox = Math.min(m.dx, 200), oy = Math.min(m.dy, 24);
  const ns = cmNotes(); ns[m.k] = { ...(ns[m.k] || {}), open: true, x: Math.max(0, at.x - ox), y: Math.max(0, at.y - oy) }; cmSaveNotes(ns);
  document.documentElement.classList.remove("cmlift"); document.documentElement.classList.add("compout"); cmPlace(null);
  let el = null; try { el = cmHost().cnOpen({ key: m.k, title: cmTitle(), src: window }); } catch {}
  if (!el) { CM.drag = null; return; }
  m.note = el; m.ox = ox; m.oy = oy; el.classList.add("lift");
  el.animate?.([{ transform: "scale(.96)", opacity: .5 }, { transform: "none", opacity: 1 }], { duration: 160, easing: "ease-out" });
  cmMove();
}
function cmGap(x, y) {                             // asked by a note held over this page: where the composer would land (null: nowhere)
  const pane = $(".cpane"), dlg = $("#cdlg");
  if (x == null || !pane || !dlg || $("#vChats")?.hidden) { cmLine(null); return null; }
  const pr = pane.getBoundingClientRect(); if (x < pr.left || x > pr.right || y < pr.top || y > pr.bottom) { cmLine(null); return null; }
  const best = cmNearest(y, dlg.getBoundingClientRect()); cmLine(best); return { at: best.at };
}
function cmBack(at) {                              // the composer back in the page, where its note was let go
  cmLine(null); const k = cmKey();
  if (k) { if (at == null) delete CM.at[k]; else CM.at[k] = at; try { localStorage.setItem("pga_comp_at", JSON.stringify(CM.at)); } catch {} }
  document.documentElement.classList.remove("compout"); cmApply();
  $("#ccomp")?.animate?.([{ transform: "scale(.96)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" });
  $("#chatText")?.focus();
}
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-cmback]")) { const k = cmKey(); if (k) { try { cmHost().cnClose(k); } catch { const ns = cmNotes(); delete ns[k]; cmSaveNotes(ns); } } document.documentElement.classList.remove("compout"); cmApply(); }
});
document.addEventListener("change", (e) => { const c = e.target.closest("#impResume"); if (c) c.closest(".impchip")?.classList.toggle("on", c.checked); });

/* ------------------------------------------------ the note itself, floating over the app that holds it */
const CN = { src: {}, q: {} };
function cnSrc(key, win) { CN.src[key] = win; }
function cnClose(key) {
  document.querySelector(`.cnote[data-cn="${CSS.escape(key)}"]`)?.remove();
  const ns = cmNotes(); delete ns[key]; cmSaveNotes(ns);
  try { CN.src[key]?.document.documentElement.classList.remove("compout"); } catch {}
  delete CN.src[key];
}
function cnOpen({ key, title, src }) {             // it keeps the composer's own look: the same box, the text, the send button
  CN.src[key] = src;
  let el = document.querySelector(`.cnote[data-cn="${CSS.escape(key)}"]`);
  const st = cmNotes()[key] || {};
  if (!el) {
    document.body.insertAdjacentHTML("beforeend", `<div class="cnote cont" data-cn="${esc(key)}"><div class="inner">
      <div class="cndoc"></div>
      <textarea class="cntx" rows="1" placeholder="${L("写点什么…（Enter 发送，Shift+Enter 换行）", "Write something… (Enter sends, Shift+Enter for a new line)")}"></textarea>
      <div class="cbar"><button class="ghost ctool" data-cndoc title="${L("展开 / 收起你在这段对话里问过的全部内容", "Show / hide everything you asked in this conversation")}">☰</button><span class="cnt"></span><span class="dimt cnhint"></span>
        <span class="grow"></span><button class="ghost ctool" data-cnback title="${L("放回对话里", "Back into the conversation")}">↩</button><span class="sendg"><button class="primary" data-cnsend>${L("发送", "Send")}</button></span></div></div></div>`);
    el = document.querySelector(`.cnote[data-cn="${CSS.escape(key)}"]`);
    Object.assign(el.style, { left: (st.x ?? 120) + "px", top: (st.y ?? 120) + "px", width: (st.w || 520) + "px", height: (st.h || 168) + "px" });
    const tx = el.querySelector(".cntx");
    try { tx.value = src.document.querySelector("#chatText")?.value || st.text || ""; } catch { tx.value = st.text || ""; }
    tx.addEventListener("input", () => { try { const t = CN.src[key]?.document.querySelector("#chatText"); if (t) t.value = tx.value; } catch {} const ns = cmNotes(); if (ns[key]) { ns[key].text = tx.value; cmSaveNotes(ns); } });
    tx.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); cnSend(key); } });
    new ResizeObserver(() => { const ns = cmNotes(); if (ns[key]) { ns[key].w = el.offsetWidth; ns[key].h = el.offsetHeight; cmSaveNotes(ns); } }).observe(el);
  }
  const t = typeof stTitle === "function" ? stTitle(key) : title;          // on the stage it knows every conversation's name
  el.querySelector(".cnt").textContent = t ? String(t).slice(0, 30) : ""; el.title = L("按住任意处拖动", "Press and hold anywhere to move it");
  cnShowDoc(key, !!st.doc);
  return el;
}
function cnShowDoc(key, on) {                       // what you asked here, as one document: folded away unless you open it
  const el = document.querySelector(`.cnote[data-cn="${CSS.escape(key)}"]`); if (!el) return;
  el.classList.toggle("doc", on); el.querySelector("[data-cndoc]")?.classList.toggle("on", on);
  const ns = cmNotes(); ns[key] = { ...(ns[key] || {}), open: true, doc: on }; delete ns[key].mode; cmSaveNotes(ns);
  if (on) { if (el.offsetHeight < 320) el.style.height = "360px"; cnDoc(key); } else el.querySelector(".cnhint").textContent = "";
}
async function cnDoc(key, fresh) {                 // everything you asked here, as one document
  const el = document.querySelector(`.cnote[data-cn="${CSS.escape(key)}"]`); if (!el) return;
  const box = el.querySelector(".cndoc");
  if (!CN.q[key] || fresh) { box.innerHTML = `<div class="dimt">…</div>`;
    try { CN.q[key] = (await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(key)}/context`)).questions || []; } catch { CN.q[key] = []; } }
  const qs = CN.q[key], sel = CN.sel?.[key] ?? qs.length - 1;
  box.innerHTML = qs.map((q, i) => `<p class="cnp ${i === sel ? "sel" : ""}" data-cnp="${i}" title="${L("点一下选中；双击放进草稿", "Click to pick; double-click to put it in the draft")}">${esc(q.text)}</p>`).join("")
    || `<div class="dimt">${L("这段对话里你还没问过什么。", "Nothing asked here yet.")}</div>`;
  el.querySelector(".cnhint").textContent = qs.length ? L(`${qs.length} 段输入`, `${qs.length} inputs`) : "";
  box.querySelector(".cnp.sel")?.scrollIntoView({ block: "nearest" });
}
function cnSend(key) {
  const el = document.querySelector(`.cnote[data-cn="${CSS.escape(key)}"]`), tx = el?.querySelector(".cntx"), text = (tx?.value || "").trim();
  if (!text) { toast(L("先写点什么", "Write something first")); return; }
  const w = CN.src[key];
  try {
    const d = w.document, t = d.querySelector("#chatText"); t.value = text;
    (d.querySelector("#chatSend") || d.querySelector("#impSend")).click();
    tx.value = ""; const ns = cmNotes(); if (ns[key]) { ns[key].text = ""; cmSaveNotes(ns); }
    setTimeout(() => { if (el.classList.contains("doc")) cnDoc(key, true); else delete CN.q[key]; }, 1500);
  } catch { toast(L("这段对话的页面没开着：先把它打开", "The conversation is not open: open it first")); }
}
document.addEventListener("click", (e) => {
  const n = e.target.closest(".cnote"); if (!n) return; const key = n.dataset.cn;
  if (e.target.closest("[data-cndoc]")) { cnShowDoc(key, !n.classList.contains("doc")); return; }
  if (e.target.closest("[data-cnback]")) { cnClose(key); return; }
  if (e.target.closest("[data-cnsend]")) { cnSend(key); return; }
  const p = e.target.closest("[data-cnp]"); if (p) { CN.sel = { ...(CN.sel || {}), [key]: Number(p.dataset.cnp) }; cnDoc(key); }
});
document.addEventListener("dblclick", (e) => {
  const p = e.target.closest(".cnote [data-cnp]"); if (!p) return; const n = p.closest(".cnote"), tx = n.querySelector(".cntx");
  tx.value = (CN.q[n.dataset.cn] || [])[Number(p.dataset.cnp)]?.text || ""; tx.dispatchEvent(new Event("input")); tx.focus();
});
/* holding a note: it moves under the pointer; over its own conversation it is pulled in, and let go there it is the composer again */
document.addEventListener("pointerdown", (e) => {
  const n = e.target.closest?.(".cnote"); if (!n || e.button !== 0 || CN.press || CN.drag) return;
  const r = n.getBoundingClientRect(); if (e.clientX > r.right - 18 && e.clientY > r.bottom - 18) return;      // its corner sizes it
  CN.press = cmPress(e, (p) => {
    CN.drag = { n, ox: p.x - n.offsetLeft, oy: p.y - n.offsetTop, x: p.x, y: p.y }; n.classList.add("lift");
    document.documentElement.classList.add("cmoving"); try { document.documentElement.setPointerCapture(p.id); } catch {} document.activeElement?.blur?.();
  });
}, true);
document.addEventListener("pointermove", (e) => {
  const p = CN.press;
  if (p && !cmPressMove(p, e)) { if (p.dead) CN.press = null; return; }
  const m = CN.drag; if (!m) return;
  e.preventDefault(); m.x = e.clientX; m.y = e.clientY;
  if (!m.raf) m.raf = requestAnimationFrame(() => { m.raf = 0; cnDragTo(m.n, m.x, m.y, m.ox, m.oy); });
}, true);
const cnEnd = () => {
  const p = CN.press; CN.press = null; if (p) { clearTimeout(p.t); p.dead = true; }
  const m = CN.drag; if (!m) return; CN.drag = null; cancelAnimationFrame(m.raf);
  cnDragTo(m.n, m.x, m.y, m.ox, m.oy); document.documentElement.classList.remove("cmoving"); cnDragEnd(m.n);
};
document.addEventListener("pointerup", cnEnd, true); document.addEventListener("pointercancel", cnEnd, true);
function cnDragTo(el, x, y, ox, oy) {
  el.style.left = Math.max(0, Math.min(innerWidth - el.offsetWidth, x - ox)) + "px"; el.style.top = Math.max(0, Math.min(innerHeight - el.offsetHeight, y - oy)) + "px";   // it stays on screen
  let dock = null; try { dock = cnOver(CN.src[el.dataset.cn], x, y); } catch {}
  el.classList.toggle("snap", !!dock); el._dock = dock;
}
function cnOver(src, x, y) {                       // a point of the app over the conversation the note came from → where it would land there
  if (!src || src.closed) return null;
  if (src === window) return src.cmGap(x, y);
  const f = [...document.querySelectorAll("iframe")].find((i) => i.contentWindow === src); if (!f || !f.offsetParent) return null;
  const r = f.getBoundingClientRect(), s = r.width / (f.offsetWidth || r.width) || 1;
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) { src.cmGap(null); return null; }
  return src.cmGap((x - r.left) / s, (y - r.top) / s);
}
function cnDragEnd(el) {
  el.classList.remove("lift", "snap"); const key = el.dataset.cn, dock = el._dock; el._dock = null;
  if (dock) { cnDock(key, dock.at); return; }
  try { CN.src[key]?.cmGap(null); } catch {}
  const ns = cmNotes(); if (ns[key]) { ns[key].x = el.offsetLeft; ns[key].y = el.offsetTop; cmSaveNotes(ns); }
}
function cnDock(key, at) {                         // let go over its conversation: it drops into the page and is the composer again
  const el = document.querySelector(`.cnote[data-cn="${CSS.escape(key)}"]`), src = CN.src[key];
  el?.animate?.([{ transform: "none", opacity: 1 }, { transform: "translateY(10px) scale(.94)", opacity: 0 }], { duration: 150, easing: "ease-in", fill: "forwards" });
  setTimeout(() => { cnClose(key); try { src?.cmBack(at); } catch {} }, 150);
}
