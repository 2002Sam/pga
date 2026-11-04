/* PGA app · 页面. A page is a saved state of the whole stage: which conversations stand on it and where (order, widths,
   small pages, wires, workspaces), how far each had got (its turns, where you were reading, what you had typed and not
   sent) and when — kept on the server (pga.pages), so it is the same in the desktop app and a browser tab.
   You work on one page at a time. The one you are on is the live stage (pga_st4, as before) and is saved back to its
   page as you go; switching puts it away and lays out another. A conversation may stand on several pages. */

const PG = { list: [], cur: localStorage.getItem("pga_page_cur") || null, ready: false, sig: "", pending: new Map() };
window.PG = PG;
const pgUrl = (id) => `/v1/users/${S.uid}/pages` + (id ? "/" + encodeURIComponent(id) : "");
const pgCur = () => PG.list.find((p) => p.id === PG.cur) || null;
const pgName = (p) => p?.name || L("页面", "Page");

/* ------------------------------------------------ how far a conversation had got, read off its window */
function pgProg(n, recent) {
  const old = n.prog || null;
  if (PG.pending.has(n.id) || n._pgRestoring) return PG.pending.get(n.id) || old;
  try {
    const d = n.el?.querySelector("iframe")?.contentDocument, box = d?.querySelector("#cdlg");
    if (n.managerProject && d?.querySelector("#chatText")) return { ...old, draft: d.querySelector("#chatText").value.slice(0, 4000), msgs: 0, msg: 0, end: false, title: n.title };
    const ms = [...(d?.querySelectorAll("#cdlgIn .cmsg") || [])]; if (!box || !ms.length || !box.clientHeight) return old;   // not opened yet, or folded away: as it was
    const top = box.getBoundingClientRect().top;
    // Message bottoms are ordered: locate the reading position without measuring
    // every earlier message in a long conversation.
    let lo = 0, hi = ms.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1;
      if (ms[mid].getBoundingClientRect().bottom > top + 1) hi = mid; else lo = mid + 1; }
    const i = lo < ms.length ? lo : 0;
    const it = recent ? recent.get(n.key) : recentItems().find((y) => y.item === n.key);
    return { turns: ms.filter((m) => m.classList.contains("me")).length, msgs: ms.length,
      msg: i, off: Math.round(top - ms[i].getBoundingClientRect().top),                  // the message at the top of the window, and how far into it
      end: box.scrollHeight - box.scrollTop - box.clientHeight < 40,                     // at the latest words
      draft: (d.querySelector("#chatText")?.value || "").slice(0, 4000), last: it?.last || old?.last || null, title: it?.title || stTitle(n.key) };
  } catch { return old; }
}
function pgSnap() {                                 // the stage as it stands, every conversation with how far it had got
  const recent = new Map(recentItems().map(x => [x.item, x]));
  for (const n of stWins()) if (!n.pad && n.key) { const p = pgProg(n, recent); if (p) n.prog = p; }
  const a = $("#starena");
  return { v: 5, nodes: ST.nodes.map(({ max, sent, run, runAt, done, el, _pgRestoring, ...n }) => JSON.parse(JSON.stringify(n))),
    ws: JSON.parse(JSON.stringify(ST.ws || {})), view: { groupFold: ST.groupFold || {}, groupSolo: ST.groupSolo || null, sl: Math.round(a?.scrollLeft || 0), focus: ST.focus, list: !!ST.listOpen, listTop: $("#stli")?.scrollTop || 0 } };
}

/* A synchronous, tab-local checkpoint survives refresh even if the final PUT is cancelled. */
const pgLocalKey = () => `pga:scroll:${S.uid}:${PG.cur}`;
function pgLocalSave(snap = pgSnap()) {
  if (!PG.cur) return;
  try { sessionStorage.setItem(pgLocalKey(), JSON.stringify(snap)); } catch {}
}
function pgScheduleCheckpoint() {
  clearTimeout(PG.scrollTimer);
  if (PG.scrollIdle != null) { window.cancelIdleCallback?.(PG.scrollIdle); PG.scrollIdle = null; }
  const generation = PG.scrollGeneration = (PG.scrollGeneration || 0) + 1;
  PG.scrollTimer = setTimeout(() => {
    PG.scrollTimer = null;
    const save = () => { if (generation !== PG.scrollGeneration) return; PG.scrollIdle = null; if (PG.ready) pgLocalSave(); };
    if (window.requestIdleCallback) PG.scrollIdle = window.requestIdleCallback(save, {timeout:1500});
    else save();
  }, 600);
}
function pgWatchScroll(d) {
  if (!d || d.__pgScrollWatch) return;
  d.__pgScrollWatch = true;
  d.addEventListener("scroll", () => { if (PG.ready) pgScheduleCheckpoint(); }, {capture:true, passive:true});
  // Do not let a checkpoint queued by scrolling interrupt the next keystroke.
  d.addEventListener("input", () => { if (PG.ready && (PG.scrollTimer || PG.scrollIdle != null)) pgScheduleCheckpoint(); }, true);
}
pgWatchScroll(document);
addEventListener("beforeunload", () => { if (PG.ready) pgLocalSave(); });

/* ------------------------------------------------ the server */
async function pgPut(id, body) {
  const r = await api(pgUrl(id), { method: "PUT", body }), i = PG.list.findIndex((p) => p.id === id);
  if (i >= 0) PG.list[i] = r; else PG.list.unshift(r);
  PG.list.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || "")); return r;
}
async function pgSaveCur(force) {                   // the page you are on, saved back — only when it changed
  if (!PG.ready || !PG.cur) return;
  clearTimeout(PG.t); PG.t = null;
  const snap = pgSnap(), sig = JSON.stringify(snap);
  pgLocalSave(snap);
  if (!force && sig === PG.sig) return; PG.sig = sig;
  try { await pgPut(PG.cur, { snap }); pgBtn(); } catch (e) { PG.sig = ""; console.warn("page save", e); }
}
const _stSavePG = stSave;                           // every change to the stage: its page follows a moment later
stSave = function (...a) { const r = _stSavePG(...a); if (PG.ready && !PG.t) PG.t = setTimeout(() => pgSaveCur(), 2500); return r; };
setInterval(() => { if (PG.ready && S.view === "stage" && !document.hidden) pgSaveCur(); }, 20000);   // where you are reading changes without a stage change
addEventListener("pagehide", () => {                // leaving: the last state goes with a request that outlives the tab
  if (!PG.ready || !PG.cur) return;
  pgLocalSave();
  try { fetch(pgUrl(PG.cur), { method: "PUT", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ snap: pgSnap() }) }); } catch {}
});

/* ------------------------------------------------ laying a page out on the stage */
function pgApply(snap) {
  const was = new Map(stWins().map((n) => [n.id, n.key || (n.pad ? "pad" : "")]));
  ST.drag = ST.rz = ST.pan = ST.wire = null; ST.shift = null; document.querySelector(".stmenu")?.remove();
  ST.nodes = snap?.nodes || []; ST.ws = snap?.ws || {}; PG.pending.clear();
  for (const n of stWins()) { delete n.done; delete n.run;
    const key = n.key || (n.pad ? "pad" : ""), el = document.querySelector(`.stnode[data-nid="${n.id}"]`);
    if (was.has(n.id) && was.get(n.id) !== key) el?.remove();               // the same place, another conversation: a fresh window
    if (!n.pad && n.prog) PG.pending.set(n.id, n.prog); }
  if (!ST.nodes.some((n) => n.pad)) stPadOut();                              // the notepad is not on this page: it waits, kept
  const v = snap?.view || {}; ST.groupFold = v.groupFold || {}; ST.groupSolo = v.groupSolo || null;
  ST.focus = stWins().some((w) => w.id === v.focus) ? v.focus : stWins().find((w) => !w.pad)?.id || stWins()[0]?.id || null;
  if (typeof stDropToggle === "function" && !!v.list !== !!ST.listOpen) stDropToggle(!!v.list);
  _stSavePG(); stRender(); stContexts(); stListItems?.(); stMap?.();
  pgKick();
  requestAnimationFrame(() => { const a = $("#starena"); if (!a) return; const sl = v.sl || 0; if (sl + a.clientWidth > a.scrollWidth) stGrow?.(sl + a.clientWidth); a.scrollLeft = sl; const list = $("#stli"); if (list) list.scrollTop = v.listTop || 0; stMap?.(); });
}
function pgKick() {                                // windows already loaded (kept across the switch, or loaded before the pages came in): no load to wait for
  for (const n of stWins()) { const f = n.el?.querySelector("iframe"); try { if (PG.pending.has(n.id) && f?.contentDocument?.readyState === "complete" && f.contentDocument.querySelector("#cdlg")) pgRestore(n, f); } catch {} }
}
window.pgRestore = function (n, f) {               // a window of the page you switched to has loaded: back where you were reading, your draft back in
  // iframe load handlers may still hold the node from before pgApply replaced the snapshot.
  n = ST.nodes.find((x) => x.id === n.id) || n;
  const p = PG.pending.get(n.id); if (!p) return; PG.pending.delete(n.id);
  n.prog = p;
  const cw = f.contentWindow; let d; try { d = f.contentDocument; } catch { return; }
  n._pgRestoring = true; pgWatchScroll(d);
  if (!p.stay) try { cw.eval("typeof PJ === 'object' && (PJ.jumped = true)"); if (cw.S) { cw.S.focusDone = true; cw.S.scrollChat = false; } } catch {}   // its own "start at the latest words" stands down
  let touched = false; const mark = () => { touched = true; delete n._pgRestoring; };
  for (const ev of ["wheel", "keydown", "pointerdown"]) d.addEventListener(ev, mark, { capture: true, once: true, passive: true });
  const put = () => {                               // the message that was at the top, where it was — held while the conversation fills in
    const box = d.querySelector("#cdlg"), ms = [...d.querySelectorAll("#cdlgIn .cmsg")]; if (!box || !ms.length || !box.clientHeight || (p.msgs && ms.length < p.msgs)) return false;
    if (p.end) box.scrollTop = box.scrollHeight;
    else { const m = ms[Math.min(p.msg || 0, ms.length - 1)]; box.scrollTop += m.getBoundingClientRect().top - box.getBoundingClientRect().top + (p.off || 0); }
    return true;
  };
  const t0 = Date.now(); let restoredAt = null;
  const tick = () => {
    if (touched || p.stay || n.managerProject || !ST.nodes.includes(n)) { delete n._pgRestoring; return; }
    let restored = false; try { restored = put(); } catch {}
    if (restored && restoredAt == null) restoredAt = Date.now();
    // Slow history requests must not consume the restoration window before messages arrive.
    if (restoredAt == null || Date.now() - restoredAt < 6000) setTimeout(tick, 250);
    else delete n._pgRestoring;
  };
  setTimeout(tick, 150);
  const draft = () => { const t = d.querySelector("#chatText"); if (!t) return Date.now() - t0 < 6000 && setTimeout(draft, 250);
    if (p.draft && !t.value.trim()) { t.value = p.draft; try { cw.S.chatDraft = p.draft; } catch {} t.dispatchEvent(new Event("input", { bubbles: true })); } };
  setTimeout(draft, 150);
};

/* ------------------------------------------------ add, switch, rename, write over, delete */
async function pgGo(id) {
  if (id === PG.cur) return;
  await pgSaveCur(true);
  let p; try { p = await api(pgUrl(id)); } catch (e) { toast(L("打不开这个页面：", "Could not open the page: ") + e.message); return; }
  PG.cur = id; localStorage.setItem("pga_page_cur", id); PG.sig = "";
  pgApply(p.snap); PG.sig = JSON.stringify(ST.nodes) + JSON.stringify(ST.ws);
  pgBtn(); pgPanelDraw(); toast(L(`已切到「${pgName(p)}」`, `Now on “${pgName(p)}”`));
}
const pgId = () => Math.random().toString(36).slice(2, 10);
function pgNextName() { const ns = PG.list.map((p) => Number((/^(?:页面|Page) (\d+)$/.exec(p.name) || [])[1] || 0)); return L(`页面 ${Math.max(0, ...ns) + 1}`, `Page ${Math.max(0, ...ns) + 1}`); }
async function pgNew() {                            // an empty stage (the notepad only, unless you closed it)
  const id = pgId(), snap = { v: 5, nodes: store.get("pga_pad_off") === "1" ? [] : [stPadNode(-1)], ws: {}, view: {} };
  try { await pgPut(id, { name: pgNextName(), snap }); } catch (e) { toast(e.message); return; }
  await pgGo(id);
}
async function pgShot() {                           // a snapshot of the stage as it stands, kept under its own name; you stay where you are
  const now = new Date(), stamp = `${now.getMonth() + 1}-${now.getDate()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const name = prompt(L("这份快照叫什么？", "Name this snapshot"), `${pgName(pgCur())} · ${stamp}`); if (!name?.trim()) return;
  try { await pgPut(pgId(), { name: name.trim(), snap: pgSnap() }); toast(L(`已存成「${name.trim()}」，你还在当前页面`, `Saved as “${name.trim()}”; you are still on this page`)); } catch (e) { toast(e.message); }
  pgPanelDraw();
}
async function pgCopy(id) {
  const src = PG.list.find((p) => p.id === id); if (!src) return;
  try { const snap = id === PG.cur ? pgSnap() : (await api(pgUrl(id))).snap; await pgPut(pgId(), { name: L(`${pgName(src)} 副本`, `${pgName(src)} copy`), snap }); } catch (e) { toast(e.message); }
  pgPanelDraw();
}
async function pgRename(id) {
  const p = PG.list.find((x) => x.id === id), t = p && prompt(L("这个页面叫什么？", "Name this page"), p.name); if (!t?.trim()) return;
  try { await pgPut(id, { name: t.trim() }); } catch (e) { toast(e.message); }
  pgBtn(); pgPanelDraw();
}
async function pgOver(id) {                         // another page made what the stage is now
  const p = PG.list.find((x) => x.id === id); if (!p) return;
  if (!confirm(L(`用现在的台面覆盖「${pgName(p)}」？它原来的排法和进度会被替换。`, `Write the stage as it is now over “${pgName(p)}”? What it held is replaced.`))) return;
  try { await pgPut(id, { snap: pgSnap() }); toast(L(`「${pgName(p)}」已更新`, `“${pgName(p)}” updated`)); } catch (e) { toast(e.message); }
  pgPanelDraw();
}
async function pgDel(id) {
  const p = PG.list.find((x) => x.id === id); if (!p) return;
  if (PG.list.length < 2) { toast(L("至少要留一个页面", "Keep at least one page")); return; }
  if (!confirm(L(`删掉页面「${pgName(p)}」？里面的对话本身不会删，只是这一页的排法和进度没了。`, `Delete the page “${pgName(p)}”? Its conversations stay; only this arrangement goes.`))) return;
  if (id === PG.cur) await pgGo(PG.list.find((x) => x.id !== id).id);
  try { await api(pgUrl(id), { method: "DELETE" }); } catch {}
  PG.list = PG.list.filter((x) => x.id !== id); pgBtn(); pgPanelDraw();
}

/* ------------------------------------------------ the button on the map, and the panel it opens: every page, searchable */
window.pgBtn = function () { const b = $("#stpgb"); if (b) b.innerHTML = `▤ ${esc(pgName(pgCur()))} <em>▾</em>`; };
const pgTitle = (c) => { const t = c.key && stTitle(c.key); return t && t !== c.key ? t : c.prog?.title || t || L("新对话", "New chat"); };   // known now, else as it was when saved
function pgChatLine(c) {
  const p = c.prog || {}, t = pgTitle(c);
  const read = p.end ? L("读到最新", "at the latest") : p.msgs ? L(`读到 ${Math.round(((p.msg || 0) + 1) / p.msgs * 100)}%`, `read ${Math.round(((p.msg || 0) + 1) / p.msgs * 100)}%`) : "";
  const bits = [p.turns ? L(`${p.turns} 轮`, `${p.turns} turns`) : "", read, p.draft ? L("✎ 有草稿", "✎ draft") : "", p.last ? ago(p.last) : ""].filter(Boolean);
  return `<div class="pgchat" title="${esc(t + (p.draft ? "\n✎ " + p.draft.slice(0, 200) : ""))}"><span>${c.mini ? "▫ " : ""}${esc(t)}</span><em>${esc(bits.join(" · "))}</em></div>`;
}
function pgCard(p) {
  const on = p.id === PG.cur, chats = on ? stWins().filter((w) => !w.pad).map((w) => ({ key: w.key, mini: w.mini, w: w.bw, ws: w.ws, prog: pgProg(w) || w.prog })) : p.chats || [];
  const ws = on ? ST.ws || {} : p.ws || {}, row = chats.filter((c) => !c.mini), tot = row.reduce((s, c) => s + (c.w || 600), 0) || 1;
  const strip = row.map((c) => `<i style="flex:${(c.w || 600) / tot};${ws[c.ws] ? `--wc:${ws[c.ws].c}` : ""}" class="${ws[c.ws] ? "ws" : ""}"></i>`).join("");
  return `<div class="pgcard${on ? " on" : ""}" data-pggo="${esc(p.id)}">
    <div class="pgch"><b>${esc(pgName(p))}</b>${on ? `<span class="pgnow">${L("当前", "current")}</span>` : ""}<em>${L(`${chats.length} 个对话`, `${chats.length} chats`)} · ${esc(on ? L("自动保存", "saved as you go") : ago(p.updated_at))}</em>
      <span class="pgacts"><i data-pgop="rename" title="${L("重命名", "Rename")}">✎</i>${on ? "" : `<i data-pgop="over" title="${L("用现在的台面覆盖它", "Write the stage as it is now over it")}">⤓</i>`}<i data-pgop="copy" title="${L("复制一份", "Duplicate")}">⧉</i><i data-pgop="del" title="${L("删除", "Delete")}">×</i></span></div>
    ${strip ? `<div class="pgstrip">${strip}</div>` : ""}
    <div class="pgchats">${chats.slice(0, 6).map(pgChatLine).join("")}${chats.length > 6 ? `<div class="pgchat more">${L(`还有 ${chats.length - 6} 个…`, `${chats.length - 6} more…`)}</div>` : ""}${chats.length ? "" : `<div class="pgchat more">${L("空白页面", "Empty page")}</div>`}</div></div>`;
}
function pgPanelDraw() {
  const box = $("#pgpanel"); if (!box) return;
  const q = (box.querySelector("#pgq")?.value || "").trim().toLowerCase();
  const hit = (p) => !q || pgName(p).toLowerCase().includes(q) || (p.chats || []).some((c) => pgTitle(c).toLowerCase().includes(q));
  const list = [...PG.list].sort((a, b) => (b.id === PG.cur) - (a.id === PG.cur) || (b.updated_at || "").localeCompare(a.updated_at || "")).filter(hit);
  box.querySelector("#pglist").innerHTML = list.map(pgCard).join("") || `<div class="cvdim" style="padding:16px">${PG.ready ? L("没有找到", "Nothing found") : L("载入中…", "Loading…")}</div>`;
}
function pgPanel(btn) {
  if ($("#pgpanel")) { $("#pgpanel").remove(); return; }
  document.querySelector(".stmenu")?.remove();
  const b = btn.getBoundingClientRect(), m = document.createElement("div"); m.id = "pgpanel"; m.className = "pgpanel card";
  m.style.left = Math.max(8, Math.min(b.left, innerWidth - 480)) + "px"; m.style.top = b.bottom + 6 + "px";
  m.innerHTML = `<div class="pgh"><b>${L("页面", "Pages")}</b><span class="cvdim">${L("整个台面的快照：打开了哪些对话、怎么排的、每个读到哪。一次处理一个", "Snapshots of the whole stage: which conversations, how they stand, how far each got. One at a time")}</span></div>
    <div class="pgtools"><input id="pgq" placeholder="${L("搜页面名或里面的对话…", "Search pages or their conversations…")}"><button class="sm" data-pgnew>＋ ${L("新建空白", "New")}</button><button class="sm" data-pgshot title="${L("把现在的台面另存一份，你留在当前页面", "Keep the stage as it is now under a name; you stay on this page")}">📸 ${L("存快照", "Snapshot")}</button></div>
    <div class="pglist" id="pglist"></div>`;
  document.body.appendChild(m); m.querySelector("#pgq").addEventListener("input", pgPanelDraw); pgPanelDraw(); m.querySelector("#pgq").focus();
  if (PG.ready) api(pgUrl()).then((l) => { PG.list = l; pgPanelDraw(); }).catch(() => {});   // changed in another window meanwhile
}
document.addEventListener("click", (e) => {
  const open = e.target.closest("[data-pgopen]"); if (open) { pgPanel(open); return; }
  const box = $("#pgpanel"); if (!box) return;
  if (!e.target.closest("#pgpanel")) { if (!e.target.closest(".modal")) box.remove(); return; }
  if (e.target.closest("[data-pgnew]")) { pgNew(); return; }
  if (e.target.closest("[data-pgshot]")) { pgShot(); return; }
  const card = e.target.closest("[data-pggo]"); if (!card) return; const id = card.dataset.pggo, op = e.target.closest("[data-pgop]")?.dataset.pgop;
  if (op === "rename") pgRename(id); else if (op === "over") pgOver(id); else if (op === "copy") pgCopy(id); else if (op === "del") pgDel(id); else pgGo(id);
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && $("#pgpanel")) $("#pgpanel").remove(); });

/* ------------------------------------------------ starting: the pages from the server; the first time, the stage you had becomes 页面 1
   (and pages kept in this browser by the earlier version are carried over) */
async function pgInit() {
  let list; try { list = await api(pgUrl()); } catch { return; }
  if (!list.length) {
    let old = null; try { old = JSON.parse(localStorage.getItem("pga_pages") || "null"); } catch {}
    for (const p of old?.list || []) { let snap = null;
      if (p.id === old.cur) snap = pgSnap(); else try { snap = JSON.parse(localStorage.getItem("pga_pg_" + p.id) || "null"); } catch {}
      if (snap) try { await api(pgUrl(p.id), { method: "PUT", body: { name: p.name, snap } }); } catch {} }
    if (old?.list?.length) PG.cur = old.cur;
    else { PG.cur = pgId(); try { await api(pgUrl(PG.cur), { method: "PUT", body: { name: L("页面 1", "Page 1"), snap: pgSnap() } }); } catch {} }
    try { localStorage.removeItem("pga_pages"); for (const p of old?.list || []) localStorage.removeItem("pga_pg_" + p.id); } catch {}
    list = await api(pgUrl()).catch(() => []);
  }
  PG.list = list;
  const here = list.find((p) => p.id === PG.cur);
  if (!here) {                                      // new here (or the page went in another window): the page changed last
    PG.cur = list[0]?.id || null;
    if (PG.cur) try { pgApply((await api(pgUrl(PG.cur))).snap); } catch {}
  } else if (!stWins().some((w) => !w.pad) && here.chats?.length) {   // this browser lost its stage (cleared storage): the page brings it back
    try { pgApply((await api(pgUrl(PG.cur))).snap); } catch {}
  }
  else {
    let saved; try { saved = JSON.parse(sessionStorage.getItem(pgLocalKey()) || "null"); } catch {}
    if (saved) pgApply(saved);
    else {
      // pga_st4 stores the layout but not the arena scroll offset.
      try { pgApply((await api(pgUrl(PG.cur))).snap); } catch {
        for (const n of stWins()) if (!n.pad && n.prog) PG.pending.set(n.id, n.prog);
      }
    }
  }
  for (const n of stWins()) try { pgWatchScroll(n.el?.querySelector("iframe")?.contentDocument); } catch {}
  if (PG.cur) localStorage.setItem("pga_page_cur", PG.cur);
  pgKick();
  const s = pgSnap(); PG.sig = JSON.stringify(s.nodes) + JSON.stringify(s.ws);
  PG.ready = true; pgBtn(); pgPanelDraw();
}
{ const w = setInterval(() => { if (S.uid && $("#vStage")?.dataset.ready) { clearInterval(w); pgInit(); } }, 300); }
