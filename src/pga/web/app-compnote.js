/* 输入框 (the composer) moves:
   - its grip drags it up and down through the conversation: it settles between two messages, the text before it stays
     above and the rest flows on tightly below it — the words themselves do not move while you drag;
   - dragged out of the page, it becomes a 随记 (note) of its own, floating over the whole app: move it by its head, size
     it from its corner. A note shows either all you have asked in this conversation as one document (the others faint,
     the one you pick in full, your draft last) or just the text you are writing. What you send from it goes to its
     conversation; 放回 puts the composer back where it was. */

const CM = { at: (() => { try { return JSON.parse(localStorage.getItem("pga_comp_at") || "{}"); } catch { return {}; } })() };
const cmKey = () => S.chat || (S.imp ? `c:${S.imp.cid}` : null);
const cmHost = () => { try { if (window.parent !== window && window.parent.cnOpen) return window.parent; } catch {} return window; };
function cmNotes() { try { return JSON.parse(localStorage.getItem("pga_cn") || "{}"); } catch { return {}; } }
function cmSaveNotes(x) { try { localStorage.setItem("pga_cn", JSON.stringify(x)); } catch {} }
const cmBlocks = () => [...($("#cdlgIn")?.children || [])].filter((x) => !x.classList.contains("cslot") && x.offsetHeight > 0);

/* ------------------------------------------------ inside a conversation: the grip, its place between messages, out of the page */
function cmApply() {
  const k = cmKey(); if (!$("#vChats")) return;
  const out = !!(k && cmNotes()[k]?.open); document.documentElement.classList.toggle("compout", out);
  const inner = $("#ccomp > .inner");
  if (inner && !inner.querySelector(".cgrip")) inner.insertAdjacentHTML("afterbegin", `<div class="cgrip" title="${L("上下拖动输入框，放到两段对话之间；拖出页面，它就成了一张悬浮的随记", "Drag the composer between two messages; drag it out of the page and it becomes a floating note")}"><i></i></div>`);
  if (out) { const h = cmHost(); try { if (!h.document.querySelector(`.cnote[data-cn="${CSS.escape(k)}"]`)) h.cnOpen({ key: k, title: cmTitle(), src: window }); else h.cnSrc?.(k, window); } catch {} }
  if (!$("#cback")) $(".cpane")?.insertAdjacentHTML("beforeend", `<div class="cback" id="cback"><span>${L("输入框在随记里", "The composer is in a note")}</span><button class="sm" data-cmback>${L("↩ 放回这里", "↩ Put it back here")}</button></div>`);
  cmPlace(k && !out ? CM.at[k] : null);
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
  const slot = $("#cdlgIn .cslot"), comp = $("#ccomp"), dlg = $("#cdlg"), pane = $(".cpane"); if (!slot || !comp || !dlg || !pane) return;
  const p = pane.getBoundingClientRect(), d = dlg.getBoundingClientRect(), s = slot.getBoundingClientRect();
  const top = Math.max(d.top, Math.min(d.bottom - comp.offsetHeight, s.top + 8));
  comp.style.top = top - p.top + "px";
}
const cmTitle = () => (S.chat ? (S.chats || []).find((c) => c.key === S.chat)?.title : S.impData?.title) || $("#chead h1")?.textContent || "";
const _renderChatCM = renderChat;
renderChat = function (...a) { const r = _renderChatCM(...a); try { cmApply(); } catch {} return r; };
document.addEventListener("scroll", (e) => { if (e.target?.id === "cdlg") cmFollow(); }, true);
window.addEventListener("resize", () => { const k = cmKey(); if (k && CM.at[k] != null) cmPlace(CM.at[k]); });

document.addEventListener("pointerdown", (e) => {
  const g = e.target.closest(".cgrip"); if (!g || e.button !== 0) return;
  e.preventDefault(); CM.drag = { k: cmKey() };
  try { g.setPointerCapture(e.pointerId); } catch {}
  document.documentElement.classList.add("cmoving");
});
document.addEventListener("pointermove", (e) => {
  const d = CM.drag; if (!d) return;
  const pane = $(".cpane")?.getBoundingClientRect(), dlg = $("#cdlg"); if (!pane || !dlg) return;
  if (e.clientX < pane.left - 30 || e.clientX > pane.right + 30 || e.clientY < pane.top - 30 || e.clientY > pane.bottom + 30) {   // out of the page
    CM.drag = null; document.documentElement.classList.remove("cmoving"); cmDetach(e); return; }
  const r = dlg.getBoundingClientRect();
  if (e.clientY < r.top + 30) dlg.scrollTop -= 14; else if (e.clientY > r.bottom - 30 && e.clientY < r.bottom + 10) dlg.scrollTop += 14;   // near an edge: it scrolls
  let at = null;
  if (e.clientY < r.bottom - 24) {                 // the gap between messages nearest to the pointer
    const bs = cmBlocks(); at = bs.length;
    for (let i = 0; i < bs.length; i++) { const b = bs[i].getBoundingClientRect(); if (e.clientY < b.top + b.height / 2) { at = i; break; } }
  }
  if (d.k) { if (at == null) delete CM.at[d.k]; else CM.at[d.k] = at; }
  cmPlace(at);
});
document.addEventListener("pointerup", () => {
  if (!CM.drag) return; CM.drag = null; document.documentElement.classList.remove("cmoving");
  try { localStorage.setItem("pga_comp_at", JSON.stringify(CM.at)); } catch {}
});
function cmDetach(e) {
  const k = cmKey(); if (!k) { toast(L("先发一句，这段对话有了名字再拿出来", "Send something first, so the conversation has a name")); return; }
  const h = cmHost(); let x = e.clientX, y = e.clientY;
  if (h !== window) { try { const f = [...h.document.querySelectorAll("iframe")].find((i) => i.contentWindow === window); const r = f.getBoundingClientRect(); x += r.left; y += r.top; } catch {} }
  const ns = cmNotes(); ns[k] = { ...(ns[k] || {}), open: true, x: Math.max(8, x - 160), y: Math.max(8, y - 20) }; cmSaveNotes(ns);
  document.documentElement.classList.add("compout");
  try { h.cnOpen({ key: k, title: cmTitle(), src: window }); } catch {}
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
function cnOpen({ key, title, src }) {
  CN.src[key] = src;
  let el = document.querySelector(`.cnote[data-cn="${CSS.escape(key)}"]`);
  const st = cmNotes()[key] || {}, mode = st.mode || "doc";
  if (!el) {
    document.body.insertAdjacentHTML("beforeend", `<div class="cnote card" data-cn="${esc(key)}"><div class="cnh"><b>${L("随记", "Note")}</b><span class="cnt"></span><span class="grow"></span>
      <span class="seg"><button data-cnmode="doc">${L("全部输入", "All I asked")}</button><button data-cnmode="text">${L("文字", "Text")}</button></span>
      <button class="sm ghost" data-cnback title="${L("放回对话里的输入框", "Back into the conversation")}">↩</button></div>
      <div class="cnb"><div class="cndoc"></div><textarea class="cntx" placeholder="${L("写下要说的，或者随手记…（⌘↵ 发送到这段对话）", "Write what to say, or a note… (⌘↵ sends it to this conversation)")}"></textarea></div>
      <div class="cnf"><span class="dimt cnhint"></span><span class="grow"></span><button class="sm primary" data-cnsend>${L("发送", "Send")}</button></div></div>`);
    el = document.querySelector(`.cnote[data-cn="${CSS.escape(key)}"]`);
    Object.assign(el.style, { left: (st.x ?? 120) + "px", top: (st.y ?? 120) + "px", width: (st.w || 380) + "px", height: (st.h || 420) + "px" });
    const tx = el.querySelector(".cntx");
    try { tx.value = src.document.querySelector("#chatText")?.value || st.text || ""; } catch { tx.value = st.text || ""; }
    tx.addEventListener("input", () => { try { const t = CN.src[key]?.document.querySelector("#chatText"); if (t) t.value = tx.value; } catch {} const ns = cmNotes(); if (ns[key]) { ns[key].text = tx.value; cmSaveNotes(ns); } });
    tx.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); cnSend(key); } });
    new ResizeObserver(() => { const ns = cmNotes(); if (ns[key]) { ns[key].w = el.offsetWidth; ns[key].h = el.offsetHeight; cmSaveNotes(ns); } }).observe(el);
  }
  const t = typeof stTitle === "function" ? stTitle(key) : title;          // on the stage it knows every conversation's name
  el.querySelector(".cnt").textContent = t ? `· ${String(t).slice(0, 30)}` : "";
  cnMode(key, mode);
  return el;
}
function cnMode(key, mode) {
  const el = document.querySelector(`.cnote[data-cn="${CSS.escape(key)}"]`); if (!el) return;
  el.classList.toggle("doc", mode === "doc"); el.querySelectorAll("[data-cnmode]").forEach((b) => b.classList.toggle("on", b.dataset.cnmode === mode));
  const ns = cmNotes(); ns[key] = { ...(ns[key] || {}), open: true, mode }; cmSaveNotes(ns);
  if (mode === "doc") cnDoc(key);
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
    setTimeout(() => cnDoc(key, true), 1500);
  } catch { toast(L("这段对话的页面没开着：先把它打开", "The conversation is not open: open it first")); }
}
document.addEventListener("click", (e) => {
  const n = e.target.closest(".cnote"); if (!n) return; const key = n.dataset.cn;
  const m = e.target.closest("[data-cnmode]"); if (m) { cnMode(key, m.dataset.cnmode); return; }
  if (e.target.closest("[data-cnback]")) { cnClose(key); return; }
  if (e.target.closest("[data-cnsend]")) { cnSend(key); return; }
  const p = e.target.closest("[data-cnp]"); if (p) { CN.sel = { ...(CN.sel || {}), [key]: Number(p.dataset.cnp) }; cnDoc(key); }
});
document.addEventListener("dblclick", (e) => {
  const p = e.target.closest(".cnote [data-cnp]"); if (!p) return; const n = p.closest(".cnote"), tx = n.querySelector(".cntx");
  tx.value = (CN.q[n.dataset.cn] || [])[Number(p.dataset.cnp)]?.text || ""; tx.dispatchEvent(new Event("input")); tx.focus();
});
document.addEventListener("pointerdown", (e) => {                 // a note moves by its head
  const h = e.target.closest(".cnote .cnh"); if (!h || e.target.closest("button") || e.button !== 0) return;
  const n = h.closest(".cnote"); e.preventDefault();
  CN.move = { n, x: e.clientX, y: e.clientY, l0: n.offsetLeft, t0: n.offsetTop }; try { h.setPointerCapture(e.pointerId); } catch {}
});
document.addEventListener("pointermove", (e) => {
  const m = CN.move; if (!m) return;
  m.n.style.left = Math.max(0, Math.min(innerWidth - 80, m.l0 + e.clientX - m.x)) + "px"; m.n.style.top = Math.max(0, Math.min(innerHeight - 40, m.t0 + e.clientY - m.y)) + "px";
});
document.addEventListener("pointerup", () => {
  const m = CN.move; if (!m) return; CN.move = null;
  const ns = cmNotes(), k = m.n.dataset.cn; if (ns[k]) { ns[k].x = m.n.offsetLeft; ns[k].y = m.n.offsetTop; cmSaveNotes(ns); }
});
