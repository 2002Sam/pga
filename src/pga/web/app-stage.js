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

const ST = { nodes: [], focus: null, drag: null, positionMarks: {}, markHistory: [], markIndex: -1 };
window.ST = ST;                                     // a window's page reaches its stage through this (返回, 全图)
const ST_CATW = 22, ST_LINE = 6, ST_GAP = 18, ST_CW = 190, ST_CH = 78, ST_WW = 660, ST_TAB = 150, ST_TH = 30, ST_PADX = 12, ST_LW = 224;
const ST_SMALL = 320;                               // the width of a narrowed page: smallish, still a whole page
const ST_MINI = { w: 300, h: 210 };                 // a window made small (–): a little page you can pull to any size
const ST_T = {
  world: ["世界知识", "World knowledge", "#6fa8ff"], self: ["自我知识", "Self knowledge", "#e9b35f"], note: ["计划", "Plan", "#a1a1aa"],
  skill: ["技能", "Skill", "#e9b35f"], doc: ["资料", "Document", "#7fcf9f"], file: ["文件", "File", "#5fc9c0"], conv: ["对话", "Conversation", "#8fb4ff"],
  topic: ["世界树主题", "Topic", "#d6a75c"], win: ["对话窗口", "Window", "#8fb4ff"] };
const ST_PIN = (n) => (["conv", "topic"].includes(n.type) ? 0 : n.type === "skill" ? 2 : 1);      // which input: conversations, data, skills
const ST_PINS = [["对话引用", "Conversations"], ["数据引用", "Data"], ["技能引用", "Skills"]];
const ST_OUTS = [["拉线：把这段对话问过的交给另一个窗口", "Pull a wire: what was asked here, into another window"], ["拉线：把这段对话读过、改过的交给另一个窗口", "Pull a wire: what this conversation read and changed"], ["拉线：把这段对话用过的技能交给另一个窗口", "Pull a wire: the skills this conversation used"]];
const stTitle = (key) => (key ? S.chats?.find((c) => c.key === key)?.title || pjRecentByKey(key)?.title || ST.nodes.find((n) => n.key === key && n.title)?.title || key : L("新对话", "New chat"));   // prefer the latest name while the timeline refreshes
const stNodeTitle = n => n.file ? n.title || n.file.path : n.readingKey && n.title ? n.title : stTitle(n.key);
const stId = () => Math.random().toString(36).slice(2, 9);
const stSL = () => $("#starena")?.scrollLeft || 0;             // the stage scrolls sideways: arena coordinates include it
const stArena = () => { const a = $("#starena"); return a ? { w: a.clientWidth, h: a.clientHeight } : { w: 1000, h: 700 }; };
// Two new conversations fit side by side, allowing for the stage margins and gap.
const stHalfWidth = () => Math.min(Math.max(1, stArena().w - 2 * ST_PADX), Math.max(ST_SMALL, Math.floor((stArena().w - 2 * ST_PADX - ST_GAP) / 2)));
const stWins = () => ST.nodes.filter((n) => n.type === "win" && !n.managerParked).sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
function stSave() { if (!$("#vStage")?.dataset.ready) return;   // a conversation's own page (the frame in a window) runs this file too: only the stage writes the stage
  try { localStorage.setItem("pga_st4", JSON.stringify({ v: 5, pmPages: 1, nodes: ST.nodes.map(({ max, sent, run, el, _stageSuspended, _pgRestoring, ...n }) => n), ws: ST.ws })); } catch {} }
/* each page's state: an agent still answering in it (it breathes on the map), or done since you last looked
   (numbered: 1 the latest to finish) */
const stBusy = (n) => { try { return !!ST.liveByKey?.get(n.key)?.running || n.dispatchState === "running" || !!n.el?.querySelector("iframe")?.contentWindow?.S?.sending; } catch { return false; } };
window.stBusy = stBusy;
function stApplyLive(rows) {
  const byKey = new Map(), prefix = S.uid + ':';
  for (const r of rows) {
    const tag = String(r.tags?.conversation || '');
    if (!tag.startsWith(prefix)) continue;
    const key = tag.slice(prefix.length), old = byKey.get(key);
    if (!old || (r.running !== old.running ? r.running : r.started > old.started)) byKey.set(key, r);
  }
  const active = JSON.stringify([...byKey].filter(([, row]) => row.running).map(([key]) => key).sort());
  if (active !== ST.liveActiveKeys) ST.liveMapPending = true;
  ST.liveActiveKeys = active;
  ST.liveByKey = byKey; ST.liveCheckedAt = Date.now();
}
async function stPollLive() {
  if (S.view !== 'stage' || !S.uid || ST.livePolling) return;
  ST.livePolling = true;
  try { stApplyLive(await liveSnap()); } catch {} finally { ST.livePolling = false; }
}
setInterval(stPollLive, 1600);
function stSeen(n) {                                 // finished in front of you: the page you are on, wholly in view
  const p = ST.pos?.get(n.id), a = $("#starena");
  return S.view === "stage" && !document.hidden && document.hasFocus() && ST.focus === n.id && !!p && !!a
    && (n.mini || (n.screenPin && !n.el?.hidden) || (p.x >= a.scrollLeft - 4 && p.x + p.w <= a.scrollLeft + a.clientWidth + 4));
}
function stDoneNotice(n) {                           // a page finished while you were elsewhere: say so, and take you there on a click
  notice({ kind: "done", key: n.key, title: stNodeTitle(n), text: L("做完了 · 点一下查看", "Done · click to see it"), onClick: () => { stFocus(n.id); stShow(n.id); } });
}
function stStat() {                                  // page id and conversation key → { run } or { num }
  const out = new Map();
  stWins().filter((w) => w.done).sort((a, b) => b.done - a.done).forEach((w, i) => out.set(w.id, { num: i + 1 }));
  for (const w of stWins()) if (w.run) out.set(w.id, { run: true, at: w.runAt });
  for (const w of stWins()) if (w.key && out.has(w.id)) out.set(w.key, out.get(w.id));
  return out;
}
function stTalkOrder(wins, recent) {               // Most recent conversation is #1 independently in each project.
  const t = (w) => w.runAt || Date.parse(recent?.get(w.key)?.last || "") || 0;
  const out = new Map(), counts = new Map();
  wins.filter((w) => w.key && !w.pad && !w.memo && !w.knowledge && t(w)).sort((a, b) => t(b) - t(a)).forEach((w) => {
    const group = stGroupOf(w)?.id || "ungrouped";
    const seq = (counts.get(group) || 0) + 1;
    counts.set(group, seq);
    out.set(w.id, { seq, at: t(w) });
  });
  return out;
}
window.stTalkOrder = stTalkOrder;
const stLastAsk = (n) => { try { const ms = n.el?.querySelector("iframe")?.contentDocument?.querySelectorAll("#cdlgIn .cmsg.me"); const x = ms?.[ms.length - 1]; return x ? (x.querySelector(".md, .body, .text, .ct")?.innerText || x.innerText || "").trim() : ""; } catch { return ""; } };   // the last thing you asked there
const stDraft = (n) => { try { return (n.el?.querySelector("iframe")?.contentDocument?.querySelector("#chatText")?.value || "").trim(); } catch { return ""; } };   // typed, not sent yet
const stDur = (ms) => { const t = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(t / 60); return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}` : `${m}:${String(t % 60).padStart(2, "0")}`; };
setInterval(() => { if (S.stageMotion || S.stageDormant) return;
  document.querySelectorAll("[data-runat]").forEach((e) => { e.textContent = stDur(Date.now() - Number(e.dataset.runat)); });
}, 1000);   // how long a page has been answering
setInterval(() => {
  let changed = !!ST.statusPaintPending, sent = !!ST.statusInputsPending;
  const wins = stWins();
  if (!wins.length) return;
  // A map click/pan can leave DOM focus in the previous iframe. Status polling
  // must never turn that stale browser focus back into a navigation command.
  for (const n of wins) if (n.done && !n.run && stSeen(n)) { delete n.done; changed = true; window.stSaw?.(n.key); }   // finished, and now in front of you: its number goes (and the manager may archive it: app-recycle.js)
  for (const n of wins) { if (n.pad || n.memo || n.knowledge || n.file) continue; const b = stBusy(n);
    if (b === !!n.run) continue; changed = true; n.run = b;
    if (b) { delete n.done; n.runAt = ST.liveByKey?.get(n.key)?.started * 1000 || Date.now(); sent = true; } else { n.completedAt = ST.liveByKey?.get(n.key)?.finished * 1000 || Date.now(); if (!stSeen(n)) { n.done = n.completedAt; stDoneNotice(n); } else window.stSaw?.(n.key); } }
  // Keep completion tracking alive during a gesture, but merge its layout and
  // cross-frame draft reads into the next idle status tick.
  if (S.stageMotion || S.view !== "stage" || document.hidden) { ST.statusPaintPending = changed; ST.statusInputsPending = sent; return; }
  ST.statusPaintPending = ST.statusInputsPending = false;
  const sig = wins.map((n) => (n.pad || n.memo || n.knowledge || n.file ? "" : stDraft(n))).join("\u0001");
  const typed = sig !== ST.draftSig; ST.draftSig = sig;
  if (sent) { stInputs(true); setTimeout(() => stInputs(true), 1500); }   // you just sent something: "what I typed" gets it now, not a minute later
  if (changed) { stSave(); stRender(); stMap(); stListItems(); for (const n of wins) if (n.par && n.el) stKidLook(n.el, n); }
  else if (typed || ST.liveMapPending) stMap();                         // only something typed: the drafts are drawn on the map alone (redrawing the stage and the list on every pause in your typing is what made it lag)
  ST.liveMapPending = false;
}, 800);

/* ------------------------------------------------ the page */
function showStage() {
  document.title = "PGA";
  const v = $("#vStage");
  stLoadPositionMarks();
  if (!v.dataset.ready) {
    v.dataset.ready = "1";
    v.innerHTML = `<div class="stground"></div><div class="stdockdrag" aria-hidden="true"></div><div class="stcornerdrag" title="${L('拖动窗口', 'Drag window')}"></div><div class="stbar card" id="stbar"></div>
      <div class="starena" id="starena" tabindex="-1"><svg class="stwires" id="stwires"></svg><div id="stnodes"></div><div id="stbars"></div></div>`;
    let saved = null; try { saved = JSON.parse(localStorage.getItem("pga_st4") || "null"); } catch {}
    if (saved?.nodes?.length) ST.nodes = saved.nodes; else stDefault();
    ST.ws = saved?.ws || {}; ST.spaceRight = 0;   // blank pulled past either end is not kept across reloads
    if (saved && saved.v !== 5) for (const w of ST.nodes) if (w.type === "win") { delete w.bw; delete w.pre; }   // narrowed by the old fit-the-screen rule: natural again
    if (!ST.nodes.some((n) => n.pad) && store.get("pga_pad_off") !== "1") ST.nodes.push(stPadNode(-1));       // the plan page is a page here
    ST.focus = stWins()[0]?.id || null;
    if (typeof stPmInit === "function") stPmInit(saved);
    stBind(); new ResizeObserver(() => stRender()).observe($("#starena"));
  }
  stBar(); stRender(); stContexts();
  pgStart();
}
function stDefault() {                            // one window, the latest conversation, with world and self knowledge wired in
  recentItems().slice(0, 1).forEach((r, i) => ST.nodes.push({ id: stId(), type: "win", key: r.item, ord: i, bw: stHalfWidth(), side: false }));
  const first = ST.nodes[0]?.id || null;
  ST.nodes.push({ id: "world", type: "world", win: first }, { id: "self", type: "self", win: first });
}

/* ------------------------------------------------ 分支树: ⑂ on a page's head grows one copy of its conversation, standing one
   above another to its right, wired to it. Each is a conversation of its own that knows everything before the fork, and
   you carry on in each with the same model and settings as its parent. Branch one of them and its own branches
   grow further right; turning to a branch shows what grew from it. Branches live in their parent: par / kids / sel. */
const ST_FORKGAP = 4;                               // room for the wires between a page and its branches
// ‹ at the left end of each window's title bar: back to the conversation before this one — the window it branched from,
// else the conversation it grew from, else the one it showed before in this window
function stPrev(n) {
  const up = n.par && ST.nodes.find((x) => x.id === n.par && x.type === "win"); if (up) return { win: up.id, key: up.key };
  if (n.from && n.from !== n.key) return { key: n.from };
  try { const C = document.querySelector(`.stnode[data-nid="${n.id}"] iframe`)?.contentWindow?.S;
    const k = C?.chatCtx?.[n.key]?.branch?.from || C?.chatBack?.at(-1); if (k && k !== n.key) return { key: k }; } catch {}
  return null;
}
function stBackLook(e, n) {
  const head = e.querySelector(".stwh"); if (!head || n.pad || n.memo || n.knowledge || n.file) return;
  let b = head.querySelector('[data-stw="back"]');
  if (!b) { b = document.createElement("button"); b.className = "stb stwback"; b.dataset.stw = "back"; b.textContent = "‹"; head.prepend(b); }
  const t = stPrev(n); b.hidden = !t;
  if (t) b.title = L("回到之前的对话", "Back to the conversation before") + (t.key ? `「${stTitle(t.key).slice(0, 40)}」` : "");
}
// Layout ownership is independent of the immutable fork/context origin.
function stCanParent(n, parent) {
  const seen = new Set();
  for (let p = parent; p; p = ST.nodes.find(x => x.id === p.par)) {
    if (p.id === n.id || (p.key && p.key === n.key) || seen.has(p.id)) return false;
    seen.add(p.id);
  }
  return true;
}
function stSetParent(n, parent) {
  if (!stCanParent(n, parent)) return false;
  if ((n.par || null) === (parent?.id || null)) return true;
  const old = ST.nodes.find(x => x.id === n.par);
  if (old) {
    old.kids = (old.kids || []).filter(id => id !== n.id);
    if (old.sel === n.id) old.sel = old.kids[0];
  }
  delete n.par; delete n.branchDocked; delete n.branchWeight;
  delete n.mini; delete n.small; delete n.big;
  if (parent) {
    n.par = parent.id;
    parent.kids = [...new Set([...(parent.kids || []), n.id])];
    parent.sel = n.id; delete parent.kidsCollapsed;
  } else n.ord = Math.max(0, ...stWins().map(w => w.ord || 0)) + 1;
  ST.focus = n.id; stRender(); stSave(); stShow(n.id);
  return true;
}
function stParentDialog(n) {
  const choices = stWins().filter(p => !p.pad && !p.memo && !p.knowledge && stCanParent(n, p));
  modal(`<h2>${L("更换上层会话", "Change parent conversation")}</h2>
    <p>${L("调整画布归属；原分支历史上下文保持不变。", "Changes canvas ownership; original fork context stays unchanged.")}</p>
    <input id="stParentSearch" placeholder="${L("搜索会话", "Search conversations")}" style="width:100%">
    <div id="stParentChoices" class="stpick"><button class="stpr" data-parent-choice="-1">${L("无上层 · 移到顶层", "No parent · Move to top level")}</button>
    ${choices.map((p,i) => `<button class="stpr" data-parent-choice="${i}">${esc(stTitle(p.key))}${p.id === n.par ? ' ✓' : ''}</button>`).join('')}</div>`);
  $("#stParentSearch").focus();
  $("#stParentSearch").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    $("#stParentChoices").querySelectorAll("button").forEach(b => { b.hidden = b.dataset.parentChoice !== '-1' && !b.textContent.toLowerCase().includes(q); });
  });
  $("#stParentChoices").addEventListener("click", e => {
    const b = e.target.closest("[data-parent-choice]"); if (!b) return;
    const i = Number(b.dataset.parentChoice), parent = i < 0 ? null : choices[i];
    if (parent && !ST.nodes.includes(parent)) return;
    if (stSetParent(n, parent)) document.querySelector(".modal")?.remove();
  });
}
function stGoBack(n) {
  const t = stPrev(n); if (!t) return;
  const w = t.win || ST.nodes.find((x) => x.type === "win" && x.key === t.key)?.id;
  if (w) { stFocus(w, true); stShow(w); } else if (t.key) stOpen(t.key, { win: n.id });
}
// Collapsing a layer keeps its frames and conversations alive; only layout visibility changes.
function stLayerLook(e, n) {
  const fork = e.querySelector('[data-stw="fork"]'); if (!fork) return;
  let b = e.querySelector('[data-stw="layer"]');
  if (!b) { b = document.createElement("button"); b.className = "stb"; b.dataset.stw = "layer"; fork.after(b); }
  const count = stKids(n).length; b.hidden = !count;
  let layout = e.querySelector('[data-stw="branchLayout"]');
  if (!layout) { layout = document.createElement("button"); layout.className = "stb"; layout.dataset.stw = "branchLayout"; b.after(layout); }
  const related = stRelatedChildren(n);
  layout.hidden = related.length < 2;
  layout.textContent = n.branchLayout === "column" ? L("子对话：竖排", "Children: vertical") : L("子对话：横排", "Children: horizontal");
  layout.title = n.branchLayout === "column" ? L("切换为左右横排", "Switch to horizontal") : L("切换为上下并列", "Switch to vertical");
  b.textContent = n.kidsCollapsed ? `▸ ${count}` : `▾ ${count}`;
  b.title = n.kidsCollapsed ? L("展开右侧分支层", "Expand branch layer") : L("折叠右侧分支层（包括更深的分支）", "Collapse branch layer (including descendants)");
  b.setAttribute("aria-label", b.title); b.setAttribute("aria-expanded", String(!n.kidsCollapsed));
}
// Overview reordering and title dragging may promote children to standalone windows.
// Layout controls must also find these windows through their preserved provenance.
function stRelatedChildren(n) {
  return ST.nodes.filter(k => k.type === "win" && k !== n &&
    (k.par === n.id || (!k.par && (k.branchParent === n.id || k.branchFrom === n.key))));
}
function stToggleBranchLayout(n) {
  const children = stRelatedChildren(n);
  if (children.length < 2) return;
  n.branchLayout = n.branchLayout === "column" ? "row" : "column";
  n.kids = children.map(k => k.id); n.kidsCollapsed = false;
  for (const k of children) {
    k.par = n.id; k.mini = false; k.branchDocked = false;
    delete k.tidyLinear; // Explicit branch layout controls take over from global tidy.
    delete k.branchWeight;
  }
  ST.shift = null; stRender(); stSave();
  // Keep the changed group visible, rather than leaving its old horizontal offset.
  stShow(children[0].id);
}
function stBranchUnits(par, kids) {
  const groups = par.branchLayout === "column" && !kids.some(k => k.fullscreen) ? [kids] : kids.map(k => [k]);
  return groups.map(wins => ({kind:"stack", par, wins, nodes:wins, w:Math.max(ST_MINW, par.kw || ST_WW), open:true}));
}
function stToggleLayer(n) {
  if (!stKids(n).length) return;
  n.kidsCollapsed = !n.kidsCollapsed;
  if (n.kidsCollapsed) {
    const seen = new Set(); let focused = ST.nodes.find((x) => x.id === ST.focus);
    while (focused?.par && !seen.has(focused.id)) {
      seen.add(focused.id);
      if (focused.par === n.id) { ST.focus = n.id; break; }
      focused = ST.nodes.find((x) => x.id === focused.par);
    }
  }
  ST.shift = null; stRender(); stSave();
}
// Manual proportions belong to the windows, never to the selected child.
function stBranchHeights(wins, room) {
  const weights = wins.map(k => Math.max(0.001, Number(k.branchWeight) || 1));
  const total = weights.reduce((a, b) => a + b, 0);
  return weights.map(w => Math.max(1, room * w / total));
}
function stResizeBranchPair(r, dy) {
  const total = r.topHeight + r.bottomHeight, min = Math.min(90, total / 3);
  const h = Math.max(min, Math.min(total - min, r.topHeight + dy));
  r.top.branchWeight = h; r.bottom.branchWeight = total - h;
}
function stDetachBranch(n) {
  stFreezeWidths();
  const parent = ST.nodes.find(x => x.id === n.par); if (!parent) return;
  const width = Math.max(ST_MINW, n.small ? parent.kw || ST_WW : ST.pos?.get(n.id)?.w || parent.kw || ST_WW);
  parent.kids = (parent.kids || []).filter(id => id !== n.id);
  if (parent.sel === n.id) parent.sel = stKids(parent)[0]?.id;
  n.from = parent.key; n.branchFrom = parent.key; n.branchParent = parent.id;
  delete n.par; delete n.branchDocked; delete n.branchWeight;
  n.bw = width; delete n.small; delete n.big;
  const order = stWins().filter(w => w !== n), at = order.indexOf(parent);
  order.splice(at + 1, 0, n); order.forEach((w, i) => { w.ord = i; });
  ST.focus = n.id; ST.shift = null; stRender(); stSave();
}
// A tucked branch keeps its iframe mounted, including drafts and active streams.
function stDockBranch(n) {
  const parent = ST.nodes.find(x => x.id === n.par && x.type === "win");
  if (!parent) return;
  stKidKeep(n, true); n.branchDocked = true;
  if (parent.sel === n.id) parent.sel = stKids(parent)[0]?.id;
  ST.shift = null; stFocus(parent.id, true); stSave(); stShow(parent.id);
}
function stBranchDockLook(e, n) {
  // Branch navigation lives in the conversation controls, not over the side panel.
  e.querySelector('.stbranchdock')?.remove();
}
const ST_KSCROLL = new Map();                        // where a branch was reading when it folded
function stKidKeep(k, folding) {                     // folding: remember where it was; opening: back there once it has its height
  if (folding && k.file) k.el?.querySelector('iframe')?.contentDocument?.querySelector('video')?.pause();
  const box = () => { try { return k.el?.querySelector("iframe")?.contentDocument?.querySelector(k.managerProject ? "#pmdoc" : "#cdlg"); } catch { return null; } };
  if (folding) { const b = box(); if (b) ST_KSCROLL.set(k.id, b.scrollTop); return; }
  const top = ST_KSCROLL.get(k.id); if (top == null) return; ST_KSCROLL.delete(k.id);
  requestAnimationFrame(() => requestAnimationFrame(() => { const b = box(); if (b) b.scrollTop = top; }));
}
function stCompletionTime(at) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
function stKidLook(e, k) {                           // a folded branch still shows when it is answering, or has answered and you have not looked
  const h = e.querySelector(".stwh"); if (!h) return; h.title = e.classList.contains("stkfold") ? L("点一下展开这一支", "Click to open this branch") : "";
  let st = h.querySelector(".stkst"); if (!st) { st = document.createElement("em"); st.className = "stkst"; h.querySelector(".stwt")?.after(st); }
  st.className = "stkst" + (k.run ? " run" : k.done ? " done" : ""); st.textContent = k.dispatchState === "error" ? L("执行失败", "failed") : k.run ? L("正在回答…", "answering…") : k.completedAt ? L("完成 ", "Done ") + stCompletionTime(k.completedAt) : k.done ? L("答完了", "answered") : "";
}
const ST_KH = new Map();                             // how tall each branch stands now (not kept)
function stShortLook(k, h) {                         // a short branch: its conversation's own head and folder line give their room to the conversation
  if (h != null) ST_KH.set(k.id, h); try { k.el?.querySelector("iframe")?.contentDocument?.documentElement.classList.toggle("stshort", (ST_KH.get(k.id) ?? 999) < 460); } catch {}
}
const stKids = (w) => (w?.kids || []).map((id) => ST.nodes.find((x) => x.id === id)).filter((k) => k && !k.mini && !k.branchDocked);
async function branchBackendReady() {
  if (S.branchBackendReady) return true;
  try { S.branchBackendReady = !!(await api('/v1/version')).branch_copy; } catch {}
  if (!S.branchBackendReady) toast(L('更新正在等待后台重载，稍后再试', 'The update is waiting for a server reload. Please try again shortly.'));
  return !!S.branchBackendReady;
}
function branchOptions(win = window, fallback = "auto") {
  const state = win.S || {}, key = state.chat || state.lineTarget || "";
  return { agent: win.document.querySelector('#chatAgent')?.value || state.chatAgent || fallback,
    model: win.document.querySelector('#chatModel')?.value || state.chatModel?.[key] || state.impData?.model || "",
    effort: win.document.querySelector('#chatEffort')?.value || state.chatEffort?.[key] || "" };
}
async function stFork(n) {
  const cw = n.el?.querySelector('iframe')?.contentWindow;
  if (typeof cw?.startSplit === 'function') await cw.startSplit();
}
// 从这里继续: the new page stands to the right of its source at once and starts loading while the server makes the branch;
// then it turns to the branch in place (no reload) and shows. Neither page folds away to make room for the other.
window.stBranchAt = async (n, from, upto) => {
  const cw = n.el?.querySelector("iframe")?.contentWindow, options = cw ? branchOptions(cw) : null;   // the branch starts on the agent, model and effort its source was using
  (ST.stageOpen ||= new Set()).add(n.id);
  const child = stOpen(null, { win: n.id, pending: true, branchFrom: from });
  ST.stageOpen.add(child.id); child.from = from;
  if (String(upto).startsWith("question:")) stShow(child.id, true);
  try {
    const r = await api(`/v1/users/${S.uid}/chats/branch`, {body:{from, upto, ...(options ? {options} : {})}});
    const choice = r.replay?.options || options;
    if (choice) store.set("pga_chat_choice:" + S.uid + ":" + r.key, JSON.stringify(choice));
    if (r.replay) sessionStorage.setItem(questionReplayKey(r.key), r.replay.text);
    Object.assign(child, { key: r.key, branchKey: r.key, branchPoint: r.upto ?? upto, title: r.title }); if (!child.title) delete child.title; stSave();
    stTurnTo(child, r.key);
    cw?.chatBranchCreated?.(from, r, upto);          // the mark on the source's turn; it redraws the source's map too
    stWires();
    return child;
  } catch (err) {
    ST.nodes = ST.nodes.filter((x) => x !== child); ST.stageOpen.delete(child.id); if (ST.focus === child.id) ST.focus = n.id;
    stRender(); stSave(); toast(err.message);
  }
};
// A page opened before its conversation existed turns to it in place: set while the page is still starting, its own start
// loads it; once started, it is loaded now. The page shows when its conversation is there.
function stTurnTo(n, key) {
  const el = n.el, f = el?.querySelector("iframe"); if (!el || !f) return;
  const t = el.querySelector(".stwt"); if (t) t.textContent = stTitle(key);
  const shown = () => { if (n.key === key) el.classList.remove("stpending"); };
  let tries = 0, set = false;
  const step = () => {
    if (!el.isConnected || n.key !== key) return;
    let cw = null; try { cw = f.contentWindow; } catch {}
    const C = cw?.S;
    if (!set && C && typeof cw.loadChat === "function") {
      set = true;
      Object.assign(C, { lineView: null, imp: null, treeItem: null, chat: key, tlSel: key, scrollChat: true });
      try { const q = new URLSearchParams(cw.location.search); q.set("c", key); cw.history.replaceState(null, "", "?" + q); } catch {}
      if (C.booted) { cw.renderChat?.(); Promise.resolve(cw.loadChat(key)).finally(shown); return; }
    }
    if (set && C?.booted && C.chatTurns && key in C.chatTurns) { shown(); return; }
    if (++tries > 400) { if (!set) stFrame(n, el); shown(); return; }   // ~12 s without the page starting: load it the plain way
    setTimeout(step, 30);
  };
  step();
}
// Opening an existing conversation from a branch tick changes only its view, never forks it again.
function stToggleChatBranch(parent, key, info = {}) {
  if (!parent || !key || key === parent.key) return;
  const arena = $("#starena"), before = parent.el?.getBoundingClientRect();
  const scrollLeft = arena?.scrollLeft || 0;
  try {
  const ancestors = new Set();
  for (let p = parent; p && !ancestors.has(p.id); p = ST.nodes.find(x => x.id === p.par)) {
    ancestors.add(p.id);
    if (p.key === key) { stFocus(p.id, true); stShow(p.id); return; }
  }
  let child = ST.nodes.find(x => x.type === 'win' && x.key === key && x.par === parent.id);
  if (child) {
    if (child.small) { stMini(child, false); return; }
    if (!child.branchDocked && !parent.kidsCollapsed && ST.pos?.has(child.id)) stDockBranch(child);
    else { stFocus(child.id, true); stShow(child.id); }
    return;
  }
  // A previously opened standalone window can become the branch view without reloading its iframe.
  child = ST.nodes.find(x => x.type === 'win' && x.key === key && !x.par && !ancestors.has(x.id));
  const fresh = !child;
  if (!child) child = {id: stId(), type:'win', key, title:info.title || stTitle(key), side:false, ord:0};
  Object.assign(child, {par:parent.id, branchKey:key, branchFrom:parent.key, branchPoint:info.upto});
  delete child.branchDocked; delete child.mini; delete child.big;
  if (fresh) stAttach(parent, [child], true);
  else {
    parent.kids = [...new Set([...(parent.kids || []), child.id])];
    stFocus(child.id, true); stSave(); stShow(child.id);
  }
  } finally {
    // Keep the source under the pointer, even if adding a column recentres the row.
    const after = parent.el?.getBoundingClientRect();
    if (arena) arena.scrollTo({left: before && after ? arena.scrollLeft + after.left - before.left : scrollLeft, behavior:"instant"});
  }
}
window.stToggleChatBranch = stToggleChatBranch;
function stAttach(n, made, keepParent = false) {                        // branch windows made: they stand to the right of this one, the first in front
  if (!n.kids?.length && !n.kw) n.kw = stHalfWidth();
  ST.nodes.push(...made); n.kids = [...(n.kids || []), ...made.map((x) => x.id)]; n.sel = made[0].id; delete n.kidsCollapsed;
  for (let c = n, up; c.par && (up = ST.nodes.find((x) => x.id === c.par)); c = up) up.sel = c.id;   // the way to them is the chosen one all along
  try { const cw = n.el?.querySelector('iframe')?.contentWindow; cw?.convMap?.(); if (!keepParent) cw?.loadChat?.(n.key); } catch {}
  ST.focus = made[0].id; stRender(); stSave(); stContexts(); if (!keepParent) stShow(made[0].id);
}
/* 第二意见: the server made the conversation (a branch from just before the question, on this one's topic); here it is a
   branch window on the right, answered by another agent, and the same question is sent into it */
window.stSecondAt = async (n, r) => {
  if ((n.kids || []).length >= 6) { toast(L("一段对话最多分 6 支", "At most 6 branches from one conversation")); return; }
  const root = n.root || stTitle(n.key).slice(0, 50), have = (n.kids || []).length, tag = n.tag ? `${n.tag}.${have + 1}` : String.fromCharCode(65 + have);
  const k = { id: stId(), type: "win", key: r.key, branchKey: r.key, branchFrom: r.from || n.key, branchPoint: r.upto, par: n.id, from: n.from || n.key, title: r.title, tag, root, side: false, ord: 0, agent: r.agent, ...(n.ws ? { ws: n.ws } : {}) };
  stAttach(n, [k]);
  await stSendInto(k, r.question);
  toast(L(`在右边开了「第二意见」：${typeof agentLabel === "function" ? agentLabel(r.agent) : r.agent} 在回答同一个问题`, `“Second opinion” on the right: ${typeof agentLabel === "function" ? agentLabel(r.agent) : r.agent} is answering the same question`));
};
async function stSendInto(n, text) {                // type into a page's composer and send, once its conversation has loaded
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const f = document.querySelector(`.stnode[data-nid="${n.id}"] iframe`); let cw; try { cw = f?.contentWindow; } catch {}
    const box = cw?.document?.querySelector("#chatText");
    if (box && typeof cw.chatSend === "function" && cw.S?.agents?.length) { box.value = text; await cw.chatSend(); return true; }
  }
  return false;
}
async function stGrowBranches(n, from, upto, k, agents, copy = false, options = null) {
  if (!options) { try { options = branchOptions(n.el?.querySelector("iframe")?.contentWindow || window, n.agent); } catch { options = { agent: n.agent || "auto" }; } }
  if ((n.kids || []).length + k > 6) { toast(L("一段对话最多分 6 支", "At most 6 branches from one conversation")); return; }
  const root = n.root || stTitle(n.key).slice(0, 50), have = (n.kids || []).length, made = [];   // named A, B, C; their own branches A.1, A.2…
  if (k > 1) toast(L(`正在分出 ${k} 支…`, `Making ${k} branches…`));
  for (let i = 0; i < k; i++) {
    try { const tag = n.tag ? `${n.tag}.${have + i + 1}` : String.fromCharCode(65 + have + i), title = `${root} · ${L("分支", "branch")} ${tag}`;
      const r = await api(`/v1/users/${S.uid}/chats/branch`, { body: { from, upto, title_from_reply: true, branch_tag: tag, copy, options } });   // one after another: each writes your settings
      made.push({ id: stId(), type: "win", key: r.key, branchKey: r.key, branchFrom: r.from || n.key, branchPoint: r.upto, par: n.id, from: n.from || n.key, title: r.title || title, tag, root, side: false, ord: 0, agent: agents[i] || options.agent || n.agent || "auto", ...(n.ws ? { ws: n.ws } : {}) }); }
    catch (err) { toast(err.message); break; }
  }
  if (!made.length) return;
  stAttach(n, made);
  toast(made.length > 1 ? L(`分出了 ${made.length} 支：每支都记得分叉之前的全部内容，各自接着聊`, `${made.length} branches: each knows everything before the fork; carry on in each`)
    : L(`在右边分出了「分支 ${made[0].tag}」：它记得到这里为止的内容`, `“Branch ${made[0].tag}” on the right: it knows everything up to here`));
}

/* ------------------------------------------------ the plan page (常驻计划) is a page of the stage, not a sidebar: a window
   whose content is the plan page itself (app-pad.js), moved in and out of it */
const stPadNode = (ord) => ({ id: "pad", type: "win", pad: true, ord, bw: 320 });
function stPadIn(e) {
  const p = $("#pad"), box = e.querySelector(".stpadbox"); if (!p || !box) return;
  box.appendChild(p); if (typeof PAD === "object") { PAD.open = true; padLayout?.(); }
}
function stPadOut() {                               // the page closed: the plan page waits, unseen, until it is a page again
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
/* the group a page belongs to: its workspace if you put it in one, else its project (the folder it ran in); one colour each,
   and the row keeps each group's pages side by side (in the order the groups first appear) */
const stGroupRaw = (w, depth = 0) => {
  if (w?.knowledge && depth < 12) {
    const source = ST.nodes.find(n => n.key === w.knowledgeSource && !n.knowledge);
    if (source) return stGroupRaw(source, depth + 1);
  }
  const ws = stWs(w);
  const up = w?.par && depth < 12 ? ST.nodes.find((x) => x.id === w.par) : null;          // a branch stands in its parent's group (it is drawn under it, so it cannot make a group of its own)
  if (up && up !== w) return stGroupRaw(up, depth + 1);
  if (!w || w.pad || w.memo || w.knowledge || !w.key || typeof pjName !== "function") return ws ? { id: "ws:" + w.ws, name: ws.name, c: ws.c } : w?.creationGroup || null;
  const assigned = typeof PJ !== "undefined" ? PJ.catalog?.of?.[typeof pjCanonical === "function" ? pjCanonical(w.key) : w.key] : null;
  if (!assigned && w.creationGroup) return w.creationGroup;
  const n = w.managerProject || assigned || pjName(pjRecentByKey(w.key) || (w.from && pjRecentByKey(w.from)) || {});   // a copy: with what it was copied from
  return { id: "pj:" + n, name: n.split("/").filter(Boolean).pop() || n, c: `hsl(${hueOf(n)} 62% 60%)` };
};
const stGroupOf = w => {
  const g = stGroupRaw(w.memoSource ? (ST.nodes.find(n=>n.key===w.memoSource) || w) : w);
  return g ? {...g, c: ST.groupColors?.get(g.id) || g.c} : null;
};
window.stProjectColor = key => { const n = ST.nodes.find(n => n.key === key); return n ? stGroupOf(n)?.c : null; };
function stGroupPalette(groups, visible) {
  const byId = new Map(groups.map(g => [g.id,g])), neighbors = new Map([...byId.keys()].map(id=>[id,new Set()]));
  for (const row of [groups,visible]) {
    const ids=row.map(g=>g.id).filter((id,i,all)=>i===0||id!==all[i-1]);
    for(let i=1;i<ids.length;i++){neighbors.get(ids[i])?.add(ids[i-1]);neighbors.get(ids[i-1])?.add(ids[i]);}
  }
  const swatches = globalThis.PGAShell?.categoryPalette?.();
  const palette = globalThis.document?.documentElement.dataset?.categoryPalette;
  if ((palette === "blues" || palette === "orchard") && swatches) {
    const assigned = new Map(), counts = new Map(swatches.map(color => [color, 0]));
    for (const id of byId.keys()) {
      const adjacent = [...neighbors.get(id)].map(other => assigned.get(other));
      const conflicts = color => adjacent.filter(value => value === color).length;
      const [color] = [...swatches].sort((a, b) => conflicts(a) - conflicts(b) || counts.get(a) - counts.get(b));
      assigned.set(id, color);
      counts.set(color, counts.get(color) + 1);
    }
    return assigned;
  }
  const hues=new Map(), distance=(a,b)=>Math.min(Math.abs(a-b),360-Math.abs(a-b));
  // Warm daily conversations and cool research stay recognisably different.
  const preferred=g=>g.name==='日常对话'?30:g.name==='论文思考'?210:((hueOf(g.id)%360)+360)%360;
  const ordered=[...byId.values()].sort((a,b)=>Number(['日常对话','论文思考'].includes(b.name))-Number(['日常对话','论文思考'].includes(a.name)));
  for(const g of ordered){
    const used=[...neighbors.get(g.id)].filter(id=>hues.has(id)).map(id=>hues.get(id));
    const score=h=>used.length?Math.min(...used.map(x=>distance(x,h))):180;
    let h=preferred(g);
    if(score(h)<80) h=Array.from({length:12},(_,i)=>i*30).sort((a,b)=>score(b)-score(a)||distance(a,h)-distance(b,h))[0];
    hues.set(g.id,h);
  }
  return new Map([...hues].map(([id,h]) => [id, swatches
    ? swatches[Math.floor(h / 60) % swatches.length]
    : `hsl(${h} 22% 57%)`]));

}
function stGroupColors() {
  const groups=stWins().map(w=>stGroupRaw(w)).filter(Boolean);
  const visible=groups.filter(g=>!ST.groupFold?.[g.id]&&(!ST.groupSolo||g.id===ST.groupSolo));
  ST.groupColors=stGroupPalette(groups,visible);
}
window.stGroupOf = stGroupOf;
function stGroupHidden(w) {
  const id = stGroupOf(w)?.id;
  return !!(ST.groupFold?.[id] || (ST.groupSolo && id !== ST.groupSolo));
}
function stGroupToggle() { return; } // Temporarily disabled along with the category controls.
document.addEventListener('click', e => {
  const b = e.target.closest('[data-stgroupfold], [data-stgroupsolo]'); if (!b) return;
  e.preventDefault(); e.stopImmediatePropagation(); stMapHideTip();
  stGroupToggle(b.dataset.stgroupfold || b.dataset.stgroupsolo, b.hasAttribute('data-stgroupsolo'));
}, true);
// The stage keeps the order it has: a category stays where it stands when you talk in it (moving the one talked to
// to the front redrew the whole stage on every send). By category, each category's pages stand together, its manager
// first; by time, each page follows its own latest exchange. The bar draws the stage as it stands.
function stGroupGather() {
  if (ST.drag || ST.pan || ST.rz || ST.branchResize) return false;
  if (ST.pinRestoring) return false;
  if (ST.mapMode === "time") return stTimeSort();
  const ws = stWins(), first = new Map(), at = new Map();
  // Where a category stands is where its first page stands; a branch (made with order 0, it stands by its page anyway) does not pull it forward.
  ws.forEach((w, i) => { const g = stGroupOf(w)?.id || w.id; if (!w.par && !(w.managerProject && w.screenPin) && !first.has(g)) first.set(g, i); });
  ws.forEach((w, i) => at.set(w, first.get(stGroupOf(w)?.id || w.id) ?? i));
  let moved = false;
  // Pin the manager first within its category; preserve the order of ordinary conversations.
  stManagerBesideOrder(ws.map((w, i) => ({ w, i })).sort((a, b) => at.get(a.w) - at.get(b.w) || Number(!!b.w.managerProject) - Number(!!a.w.managerProject) || a.i - b.i).map(({w}) => w), ws).forEach((w, k) => { if (w.ord !== k) { w.ord = k; moved = true; } if (w.overviewOrder != null && w.overviewOrder !== k) { w.overviewOrder = k; moved = true; } });
  return moved;
}
function stTimeSort() {                              // Every page follows its own exchange time, independent of category or parent.
  const ws = stWins(), recent = new Map(recentItems().map(x => [x.item, x]));
  let moved = false;
  stManagerBesideOrder([...ws].sort(stMapTimeOrder(recent)), ws)
    .forEach((w, k) => { if (w.ord !== k) moved = true; w.ord = k; if (w.overviewOrder != null) w.overviewOrder = k; });
  return moved;
}
// Explicitly opened managers follow their source in both category and time order.
function stManagerBesideOrder(wins, original = wins) {
  const pinned = original.find(w => w.managerProject && w.screenPin);
  const slot = original.indexOf(pinned);
  for (const manager of wins.filter(w => w.managerProject && w.managerBeside && w !== pinned)) {
    const source = wins.find(w => w.id === manager.managerBeside && w !== manager && !w.managerProject);
    if (!source || stGroupOf(source)?.id !== stGroupOf(manager)?.id) { delete manager.managerBeside; continue; }
    wins.splice(wins.indexOf(manager), 1);
    wins.splice(wins.indexOf(source), 0, manager);
  }
  if (pinned) {
    wins.splice(wins.indexOf(pinned), 1);
    wins.splice(slot, 0, pinned);
  }
  return wins;
}
function stWsLook(e, n) {                           // a page's head in its workspace's colour
  const w = stWs(n), b = e.querySelector('[data-stw="ws"]');
  const g = stGroupOf(n);
  if (g && e.dataset.categoryColor !== g.c) {
    e.dataset.categoryColor = g.c;
    e.style.setProperty("--wc", g.c);
  } else if (!g && e.dataset.categoryColor) {
    delete e.dataset.categoryColor;
    e.style.removeProperty("--wc");
  }
  e.classList.toggle("inws", !!w); e.classList.toggle("ingrp", !w && !!g);
  if (b) b.title = w ? L(`工作区「${w.name}」· 点一下换或移出`, `Workspace “${w.name}” · click to change or leave`) : L("放进一个工作区", "Put it in a workspace");
}

/* ------------------------------------------------ the layout: a row that always fits the screen */
const ST_MINW = 300, ST_FIT = 560;                  // the least a page gets from an edge or a squeeze; the least it gives to fit the screen
const stDock = (n) => ["world", "self"].includes(n.type) && n.fx == null;    // world and self knowledge live in the 所有对话 panel
function stPanel() {                                // history and tools live in an on-demand settings panel
  if (!ST.lp) { try { ST.lp = JSON.parse(localStorage.getItem("pga_st_lp") || "null"); } catch {} ST.lp = ST.lp || {}; ST.listOpen = false; ST.lp.open = false; }
  return ST.lp;
}
// Attach document units after their source's visible column, before any deeper branches.
// Category layout keeps a knowledge page next to its conversation.
function stKnowledgeUnits(units) {
  const attached = new Map(), moved = new Set();
  for (const u of units) {
    if (u.kind !== "win" || !u.win.knowledge) continue;
    const source = units.find(x => x.kind === "win" && !x.win.knowledge && x.win.key === u.win.knowledgeSource
      || x.kind === "stack" && x.wins.some(w => w.key === u.win.knowledgeSource));
    if (!source) continue;
    const docs = attached.get(source) || []; docs.push(u); attached.set(source, docs);
    moved.add(u.win);
  }
  const result = [];
  for (const u of units) {
    if (moved.has(u.win)) continue;
    result.push(u);
    for (const doc of (attached.get(u) || []).sort((a,b) => (b.win.knowledgeOpened || 0) - (a.win.knowledgeOpened || 0))) {
      const col = units.find(x => x.kind === "col" && x.win === doc.win);
      if (col) result.push(col);
      result.push(doc);
    }
  }
  units.splice(0, units.length, ...result);
}
function stLayout() {
  const A = { ...stArena() }, all = stWins(), ids = new Set(all.map((w) => w.id));
  // Persistent wires are hidden; use the full arena height for conversations.
  for (const w of all) { if (w.par && !ids.has(w.par)) delete w.par; if (w.kids) { w.kids = w.kids.filter((id) => ids.has(id)); if (!w.kids.length) { delete w.kids; delete w.sel; delete w.kw; } } }   // a branch whose parent went: a page of its own
  const byTime = ST.mapMode === "time";
  const wins = all.filter((w) => (!w.screenPin || w.small) && !w.mini && (byTime ? !w.branchDocked : (!w.par || w.tidyLinear) && !(typeof stTidyHidden === 'function' && stTidyHidden(w))));
  ST.nodes = ST.nodes.filter((n) => !n.rail || ids.has(n.win));                                   // a wire from the history column goes with its window
  for (const n of ST.nodes) if (n.type !== "win" && n.win && !ids.has(n.win)) n.win = null;       // its window is gone: unwired
  for (const w of wins) if (w.links) w.links = w.links.filter((l) => ids.has(l.from) && l.from !== w.id);
  const shelf = ST.nodes.filter((n) => n.type !== "win" && !n.win && !n.rail && !stDock(n));
  const units = [];                                 // 所有对话 is a sidebar outside the stage: the stage itself moves over for it
  if (shelf.length) units.push({ kind: "shelf", nodes: shelf, w: ST_CW, open: true });
  for (const w of wins) { const col = ST.nodes.filter((n) => n.win === w.id && !n.rail && !stDock(n)); units.push({ kind: "col", win: w, nodes: col, w: ST_CW, open: true, hide: !col.length }); units.push({ kind: "win", win: w, w: Math.max(ST_MINW, w.bw || ST_MINW), open: true, flex: !w.bw && !w.big });
    for (let p = w, kids = byTime ? [] : stKids(w).filter(k => !k.screenPin && !k.tidyLinear); kids.length && !p.kidsCollapsed; p = kids.find((k) => k.id === p.sel) || kids[0], kids = stKids(p).filter(k => !k.screenPin && !k.tidyLinear))   // its branches, one above another; then the branches of the one you chose
      units.push(...stBranchUnits(p, kids)); }
  if (!byTime && !all.some(n => n.overviewOrder != null)) stKnowledgeUnits(units);
  for (const memo of all.filter(n=>!byTime && n.memoSource)) {
    const target=units.find(u=>u.kind==='win'&&u.win.key===memo.memoSource || u.kind==='stack'&&u.wins.some(w=>w.key===memo.memoSource));
    const unit=units.find(u=>u.kind==='win'&&u.win===memo);
    if(target&&unit){units.splice(units.indexOf(unit),1);units.splice(units.indexOf(target)+1,0,unit);}
  }

  // A source may be a branch column; keep its manager beside that column too.
  for (const manager of all.filter(w => w.managerProject && w.managerBeside)) {
    const target = units.find(u => u.kind === 'win' && u.win.id === manager.managerBeside || u.kind === 'stack' && u.wins.some(w => w.id === manager.managerBeside));
    const unit = units.find(u => u.kind === 'win' && u.win === manager);
    if (target && unit) { units.splice(units.indexOf(unit), 1); units.splice(units.indexOf(target), 0, unit); target.managerBefore = true; unit.managerNext = true; }
  }

  for (const u of units) if (u.win ? stGroupHidden(u.win) : u.par ? stGroupHidden(u.par) : !!ST.groupSolo) u.hide = true;
  const folded = (ST.folded = stFoldPick().folded);
  for (const w of wins) if (w.small) folded.add(w.id);
  for (const u of units) if (folded.has(byTime || u.win?.tidyLinear ? u.win?.id : stRootOf(u.win || u.par)?.id)) { if (u.kind === "win") { u.line = true; u.flex = false; } else u.hide = true; }
  for (let i = 0; i < units.length; i++) { const u = units[i]; if (byTime || !u.line || u.hide) continue;   // A run of folded pages: one unit of thin lines.
    let j = i + 1; const wins = [u.win]; for (; j < units.length; j++) { const v = units[j]; if (v.hide) continue; if (!v.line || (stGroupOf(v.win)?.id || "") !== (stGroupOf(u.win)?.id || "")) break; wins.push(v.win); v.hide = true; v.merged = true; }
    units[i] = { kind: "lines", wins, w: wins.length * ST_LINE + (wins.length - 1) * 4, open: true }; }
  // A manually collapsed window occupies its line, not an invisible full-width frame.
  for (const u of units) {
    if (u.kind === "win" && u.win.small) { u.w = ST_LINE; u.flex = false; }
    if (u.kind === "stack" && u.wins.every(n => n.small)) u.w = ST_LINE;
  }
  // A category whose every page is folded becomes one marker; clicking restores its open pages.
  const cats = new Map();
  for (const u of units) { if (u.hide || !["win", "lines", "stack"].includes(u.kind)) continue;
    const ws = u.kind === "lines" ? u.wins : u.kind === "stack" ? u.wins : [u.win], ids = new Set(ws.map((w) => stGroupOf(w)?.id || ""));
    for (const id of ids) { const c = cats.get(id) || { units: [], wins: [], shut: true }; c.units.push(u); cats.set(id, c);
      if (ids.size > 1) c.shut = false;                                          // a run of lines shared with the next category: leave both as they are
      for (const w of ws) if ((stGroupOf(w)?.id || "") === id) { c.wins.push(w); if (!(w.small || u.kind === "lines")) c.shut = false; } } }
  ST.catShut = new Set();
  for (const [id, c] of cats) {
    if (byTime) continue;
    if (!c.shut) ST.catOpen?.delete(id); // Opening a page resets the temporary category peek.
    if (!id || !c.shut || ST.catOpen?.has(id)) continue;
    const g = stGroupOf(c.wins[0]); ST.catShut.add(id);
    c.units.forEach((u, i) => { if (i) { u.hide = true; u.merged = true; } else { const k = units.indexOf(u); if (u.kind === "win") { u.hide = true; units.splice(k + 1, 0, { kind: "cat", g, wins: c.wins, w: ST_CATW, open: true }); } else units[k] = { kind: "cat", g, wins: c.wins, w: ST_CATW, open: true }; } }); }
  if (!byTime && all.some(w => w.tidyLinear) && typeof stTidyUnits === 'function') stTidyUnits(units);
  // Nothing is squeezed or folded to fit the screen: a page keeps its width, and what does not fit runs on to the right —
  // the stage scrolls sideways. A page you did not size starts at ST_WW (never wider than the screen); while the row is
  // a little too wide those pages give, down to ST_FIT, and while there is room to spare they share it.
  const colOpen = (w) => units.some((c) => c.kind === "col" && c.win === w && !c.hide && c.open);
  const preOf = (u) => u.managerBefore ? 0 : (u.kind === "stack" ? u.par.tidyCompact ? 0 : Math.min(u.par.branchGap ?? ST_FORKGAP, ST_FORKGAP) : u.kind === "col" || (u.kind === "win" && !colOpen(u.win)) ? u.win.pre || 0 : 0);
  const gapAfter = u => (u.win?.tidyCompact || u.par?.tidyCompact || u.wins?.every(w => w.tidyCompact)) ? 8 : u.managerNext ? 6 : ST_GAP;
  const width = () => { let t = 0, lastGap = 0, run = false; for (const u of units) { if (u.hide) continue; if (u.open) { lastGap = gapAfter(u); t += preOf(u) + u.w + lastGap; run = false; } else if (!run) { lastGap = ST_GAP; t += ST_TAB + lastGap; run = true; } } return t - lastGap; };
  const room = Math.max(1, A.w - 2 * ST_PADX);
  for (const u of units) if (u.kind === "win" || u.kind === "stack") u.w = Math.min(u.w, room);
  // Exact requested width, including when restoring a wider window to the default size.
  for (const u of units) if ((u.kind === "win" && u.win.big && !u.win.small) || (u.kind === "stack" && u.wins.some(n => n.big && !n.small))) {
    const enlarged = u.kind === "win" ? u.win : u.wins.find(n => n.big && !n.small);
    u.w = enlarged.fullscreen ? room : Math.min(room, enlarged.bigWidth || Math.round(A.w * 0.5));
  }
  const flex = units.filter((u) => u.kind === "win" && u.open && !u.hide && u.flex);
  for (const u of flex) u.w = Math.min(room, Math.max(ST_MINW, Math.min(ST_WW, room)));
  if (flex.length && width() > room) { const cut = (width() - room) / flex.length; for (const u of flex) u.w = Math.max(Math.min(u.w, ST_FIT), u.w - cut); }
  if (flex.length && width() < room) { const add = (room - width()) / flex.length; for (const u of flex) u.w += add; }
  // Give zoomed document windows some extra viewport space after normal stage sizing.
  for (const u of units) {
    if (u.hide || !u.open || (u.kind !== 'win' && u.kind !== 'stack')) continue;
    const pages = u.wins || [u.win];
    const zoom = Math.max(1, ...pages.map(n => n.small ? 1 : n.el?.pdfReaderZoom || 1));
    if (zoom <= 1) continue;
    u.pdfBaseWidth = u.w;
    u.w = Math.min(room, Math.round(u.w * (1 + Math.min(.35, (zoom - 1) / 2))));
  }
  const free = Math.max(0, room - width()), off = ST.shift == null ? free / 2 : Math.max(0, Math.min(free, ST.shift));   // centred, unless an edge you pulled holds it
  const edgeSpace = Math.ceil((typeof innerWidth === "number" ? innerWidth : A.w) / 2);
  ST.edgeSpace = edgeSpace;
  let x = ST_PADX + edgeSpace + off + (ST.sortLead || 0);
  let run = null;
  for (const u of units) { if (u.hide) continue; if (u.open) { x += preOf(u); u.x = x; x += u.w + gapAfter(u); run = null; continue; }
    if (!run) { run = { x, tabs: [] }; x += ST_TAB + ST_GAP; } u.x = run.x; u.run = run; }
  ST.span = ST_PADX * 2 + edgeSpace * 2 + off + width() + (ST.sortLead || 0);             // how far the row reaches: the stage scrolls to it
  return { units, A, off };
}

/* ------------------------------------------------ drawing */
function stWinHtml(n) {
  if (n.file) return stFileHtml(n);
  if (n.knowledge) return knowledgeWinHtml(n);
  if (n.memo) return memoWinHtml(n);
  if (n.pad) return `<div class="stwin stpadwin">${["e", "w", "n", "s", "ne", "nw", "se", "sw"].map((d) => `<i class="rz rz-${d}" data-rz="${d}"></i>`).join("")}
    <div class="stwh" data-stfocus="${n.id}"><b class="stwt">${L("计划", "Plans")}</b><span class="grow"></span>
      <button class="stb stwsb" data-stw="ws">●</button><button class="stb" data-stw="min" title="${L("缩成小页面", "Make it a small page")}">–</button><button class="stb" data-stw="max" title="${L("最大化（Esc 还原）", "Maximise (Esc restores)")}">▢</button><button class="stb" data-stw="close" title="${L("关掉计划页（可从台面 ⋯ → 添加节点恢复）", "Close the plan page page (restore it from More tools → Add node)")}">×</button></div>
    <div class="stpadbox"></div></div>`;
  return `<div class="stwin">${["e", "w", "n", "s", "ne", "nw", "se", "sw"].map((d) => `<i class="rz rz-${d}" data-rz="${d}" title="${L("拖动改大小，双击还原", "Drag to resize, double-click to reset")}"></i>`).join("")}
    <div class="stwh" data-stfocus="${n.id}"><b class="stwt">${esc(stNodeTitle(n))}</b>${n.agent ? `<span class="stkidag">${esc(typeof agentLabel === "function" ? agentLabel(n.agent) : n.agent)}</span>` : ""}<em class="stctxn" data-stctxn="${n.id}"></em><span class="grow"></span>
      <details class="chat-action-menu st-window-menu"><summary class="stb" title="${L('窗口工具：分屏、知识汇总、工作区', 'Window tools: split, knowledge, workspace')}">⋯</summary><div class="chat-action-panel">      <button class="stb" data-stw="fork" title="${L("Branch：同一窗口内双 Agent 分屏", "Branch: two agents in this window")}">${L('双 Agent 分屏', 'Split with two agents')}</button><button class="stb ${n.captureKnowledge ? "on" : ""}" data-stw="knowledge" aria-pressed="${!!n.captureKnowledge}" title="${L("知识汇总：开启后发送时打开实时文档并保存文件", "Knowledge: save a live document with each message")}">${L('自动知识汇总', 'Capture knowledge')}</button><button class="stb stwsb" data-stw="ws">${L('工作区…', 'Workspace…')}</button></div></details><button class="stb ${n.side === false ? "" : "on"}" data-stw="side" title="${L("右侧栏：环境、上下文、世界树", "Side panel: environment, context, world tree")}">◧</button><button class="stb" data-stw="min" title="${L("缩成小页面", "Make it a small page")}">–</button><button class="stb" data-stw="max" title="${L("最大化（Esc 还原）", "Maximise (Esc restores)")}">▢</button><button class="stb" data-stw="close" title="${L("关掉这个窗口（对话还在）", "Close the window (the conversation stays)")}">×</button></div>
    <button type="button" class="stmanager-global" data-stw="global" aria-controls="stlist" aria-expanded="${!!ST.listOpen}" aria-label="${L('全局历史与设置', 'Global history and settings')}" title="${L('全局历史与设置', 'Global history and settings')}" ${n.managerProject || n.key?.startsWith('chat:pm-') ? '' : 'hidden'}><span aria-hidden="true">▸</span></button>
    <button type="button" class="stmanager-entry" data-stw="manager" aria-label="${L('将管理员移到紧贴左侧', 'Move the manager immediately to the left')}" title="${L('管理员 · 移到紧贴左侧', 'Manager · move beside this conversation')}" ${n.managerProject || n.key?.startsWith('chat:pm-') ? 'hidden' : ''}><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M10 4v16m-4-5-2-3 2-3"/></svg><span>${L('管理员', 'Manager')}</span></button>
    <iframe title="conversation"></iframe><div class="stloading" role="status" aria-live="polite" hidden>
      <div class="stloading-body"><div class="stloading-status"><i aria-hidden="true"></i><span></span></div>
      <svg class="stloading-cat" viewBox="0 0 180 142" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
  <ellipse cx="87" cy="112" rx="44" ry="4" fill="currentColor" opacity=".08"/>
  <g stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
    <path class="cat-tail" d="M111 103c29 9 44-5 39-19-3-9-14-9-17-2"/>
    <path d="M63 69c-11 15-12 28-6 36 8 10 53 10 60 0 5-8 0-27-10-37" fill="currentColor" fill-opacity=".08"/>
    <path d="M60 49 58 24 77 34c7-2 15-2 22 0l20-10-3 27c6 11 2 25-10 30-11 5-34 5-44-2-10-7-11-20-2-30Z" fill="currentColor" fill-opacity=".12"/>
    <path d="m64 34 8 5m36 0 6-5" opacity=".5"/>
    <g class="cat-eyes"><path d="M71 54v4m31-4v4" stroke-width="4"/></g>
    <path d="m84 62 3 2 3-2m-3 2v3m0 0c-2 4-6 3-7 1m7-1c2 4 6 3 7 1" stroke-width="1.8"/>
    <path d="m61 63-12-2m13 7-11 2m61-7 12-2m-13 7 11 2" stroke-width="1.5" opacity=".6"/>
    <path d="M73 88v16m26-16v16m-33 3c0-6 14-6 14 0m14 0c0-6 14-6 14 0"/>
    <path d="m82 37 1 5m9-5-1 5" opacity=".5"/>
  </g>
  <g fill="currentColor">
    <g class="cat-print cat-print-1" transform="translate(62 130)"><ellipse rx="3.5" ry="2.7"/><circle cx="-4" cy="-4" r="1.5"/><circle cx="0" cy="-5.5" r="1.5"/><circle cx="4" cy="-4" r="1.5"/></g>
    <g class="cat-print cat-print-2" transform="translate(87 130)"><ellipse rx="3.5" ry="2.7"/><circle cx="-4" cy="-4" r="1.5"/><circle cx="0" cy="-5.5" r="1.5"/><circle cx="4" cy="-4" r="1.5"/></g>
    <g class="cat-print cat-print-3" transform="translate(112 130)"><ellipse rx="3.5" ry="2.7"/><circle cx="-4" cy="-4" r="1.5"/><circle cx="0" cy="-5.5" r="1.5"/><circle cx="4" cy="-4" r="1.5"/></g>
  </g>
</svg>
      <button class="sm ghost" data-stw="retry" hidden>${L("重试", "Retry")}</button></div></div></div>${ST_PINS.map((p, i) => `<i class="stin" style="top:${(i * 2 + 1) / 6 * 100}%" data-pin="${i}" title="${L("拉一根线到别的窗口或卡片", "Pull a wire to another window or card")}"></i><i class="stout" style="top:${(i * 2 + 1) / 6 * 100}%" data-pin="${i}" title="${L(...ST_OUTS[i])}"></i>`).join("")}`;
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
  const x = Math.max(w || 0, ST.span || 0, ST.spaceRight || 0);
  for (const id of ["stnodes", "stbars", "stwires"]) { const e = document.getElementById(id); if (e) e.style.width = Math.ceil(x) + "px"; }
}
// Evict only page views; conversation data and server-side runs remain intact.
function stLimitPages(limit = 99) {
  limit = Math.max(1, Math.min(99, limit));
  // Explicit global tidy keeps every folded view recoverable on this page.
  const pages = stWins().filter(w => !w.tidyLinear && !w.pad && !w.memo && !w.knowledge && !w.file && !w.managerProject && !w.key?.startsWith("chat:pm-"));
  const groupOf = w => (typeof stGroupOf === "function" ? stGroupOf(w)?.id : null) || "ungrouped";
  const time = w => Math.max(w.lastUsedAt || 0, w.openedAt || 0, w.runAt || 0, w.completedAt || 0);
  const groups = new Map(), gone = new Set();
  let changed = false;
  for (const w of pages) { const id = groupOf(w); if (!groups.has(id)) groups.set(id, []); groups.get(id).push(w); }
  // Each category independently retains ten views and shows at most five.
  // Explicitly opening a view gives it priority; older views leave the stage only.
  for (const ws of groups.values()) {
    ws.sort((a,b) => Number(b.id === ST.focus) - Number(a.id === ST.focus) || time(b) - time(a));
    for (const [i,w] of ws.entries()) {
      if (w.managerFoldManaged || (typeof stAutoCloseProtected === 'function' && stAutoCloseProtected(w))) continue;
      if (i >= 10) { gone.add(w.id); continue; }
      if (i >= 5 && (!w.small || w.mini)) {
        w.small = true; w.mini = false; changed = true;
      }
    }
  }
  if (!gone.size) return changed;
  for (const w of pages) if (gone.has(w.id)) {
    if (stRememberPage(w) === false) { gone.delete(w.id); continue; }
    const frame = w.el?.querySelector('iframe');
    if (frame) { clearTimeout(frame._pgaWatch); if (typeof stFrame === 'function') stFrame.pending?.delete(frame); }
    if (typeof window !== 'undefined') window.pgCancelRestore?.(w);
    if (w.managerProject) (ST.pmTried ||= new Set()).add(w.managerProject);
  }
  if (!gone.size) return changed;
  const removed = new Map(pages.filter(w => gone.has(w.id)).map(w => [w.id, w]));
  ST.nodes = ST.nodes.filter(w => !gone.has(w.id));
  for (const w of ST.nodes) {
    if (gone.has(w.par)) {
      const parent = removed.get(w.par);
      w.from ||= parent?.key; w.branchFrom ||= parent?.key;
      delete w.par; delete w.branchDocked;
    }
    if (w.kids) w.kids = w.kids.filter(id => !gone.has(id));
    if (gone.has(w.sel)) w.sel = w.kids?.[0];
    if (gone.has(w.win)) delete w.win;
    if (w.links) w.links = w.links.filter(link => !gone.has(link.from));
  }
  for (const id of gone) { ST.stageOpen?.delete(id); if (typeof PG !== "undefined") PG.pending?.delete(id); }
  if (gone.has(ST.focus)) ST.focus = pages.filter(w => !gone.has(w.id)).sort((a,b) => time(b) - time(a))[0]?.id || null;
  return true;
}
function stRememberPage(n) {
  if (!n.key || typeof S === "undefined" || !S.uid) return false;
  try {
    const prog = (typeof pgProg === "function" ? pgProg(n) : null) || n.prog || {};
    const draft = n.el?.querySelector("iframe")?.contentDocument?.querySelector("#chatText")?.value;
    if (draft != null) prog.draft = draft; // eviction must not truncate a long unsent draft
    localStorage.setItem(`pga:retired:${S.uid}:${n.key}`, JSON.stringify(prog));
    return true;
  } catch { return false; } // keep the view when its reading state cannot be saved
}
function stRecallPage(n) {
  if (!n.key || typeof S === "undefined" || !S.uid) return;
  try {
    const prog = JSON.parse(localStorage.getItem(`pga:retired:${S.uid}:${n.key}`) || "null");
    if (prog) { n.prog = prog; if (typeof PG !== "undefined") PG.pending.set(n.id, prog); localStorage.removeItem(`pga:retired:${S.uid}:${n.key}`); }
  } catch {}
}
/* every category on the stage has its manager page (app-manager.js), folded to a line until you open it; close it and it stays closed */
const stPmOff = () => { try { return new Set(JSON.parse(localStorage.getItem("pga_pm_off") || "[]")); } catch { return new Set(); } };
function stPmOffSet(name, off) { const s = stPmOff(); if (off) s.add(name); else s.delete(name); try { localStorage.setItem("pga_pm_off", JSON.stringify([...s])); } catch {} }
function stEnsureManagers() {
  // Managers are opened on demand. Merely visiting a category must not create a page.
}
// When the stage reorders itself (a category or a page talked to moves to the front), the page you are on keeps its
// place on the screen; the others move round it. Without one in view, the page in the middle of the screen keeps its.
function stAnchor() {
  const a = $("#starena"); if (!a || !ST.pos) return null;
  const sl = a.scrollLeft, mid = sl + a.clientWidth / 2, shown = (p) => p && !p.tab && p.x < sl + a.clientWidth && p.x + p.w > sl;
  const open = stWins().filter((w) => !w.mini && !w.screenPin && shown(ST.pos.get(w.id)));
  const activeManager = open.find(w => w.managerBeside && w.id === ST.focus);
  const managerSource = activeManager ? stWins().find(w => w.id === activeManager.managerBeside)?.key : typeof MP !== 'undefined' && MP.open ? MP.source : null;
  const w = open.find((w) => managerSource && w.key === managerSource) || open.find((w) => w.id === ST.focus) || open.sort((x, y) => { const d = (n) => { const p = ST.pos.get(n.id); return Math.max(0, p.x - mid, mid - p.x - p.w); }; return d(x) - d(y); })[0];
  return w ? { id: w.id, dx: ST.pos.get(w.id).x - sl } : null;
}
function stKeepAnchor(anchor) {
  const a = $("#starena"), p = anchor && ST.pos?.get(anchor.id); if (!a || !p || p.tab) return;
  const left = Math.max(0, p.x - anchor.dx);
  if (Math.abs(left - a.scrollLeft) < 1) return;
  if (left + a.clientWidth > a.scrollWidth) stGrow(left + a.clientWidth);
  a.scrollTo({ left, behavior: "instant" });
}

const ST_AUTO_MARKS = 5;
// Marks span saved pages. Keep them per user, independently of a page's layout.
function stReadPositionMarks(key) {
  try {
    const marks = JSON.parse(localStorage.getItem(key));
    if (marks && typeof marks === 'object' && !Array.isArray(marks)) return marks;
  } catch {}
  return {};
}
function stLoadPositionMarks() {
  if (!S.uid || ST.markOwner === S.uid) return;
  ST.markOwner = S.uid;
  ST.positionMarks = {};
  ST.markHistory = []; ST.markIndex = -1; ST.selectedMark = null;
  for (const [digit, mark] of Object.entries(stReadPositionMarks(`pga:flags:${S.uid}`))) {
    if (/^[1-9]\d*$/.test(digit) && mark?.digit === digit && typeof mark.id === 'string')
      ST.positionMarks[digit] = mark;
  }
  ST.savedMarks = JSON.stringify(ST.positionMarks);
}
function stSavePositionMarks() {
  if (!ST.markOwner || ST.markOwner !== S.uid) return;
  const snapshot = JSON.stringify(ST.positionMarks);
  if (snapshot === ST.savedMarks) return;
  try {
    const key = `pga:flags:${S.uid}`;
    // Apply only this window's edits so unrelated flags from another window survive.
    const saved = stReadPositionMarks(key);
    const before = JSON.parse(ST.savedMarks);
    for (const digit of new Set([...Object.keys(before), ...Object.keys(ST.positionMarks)])) {
      const mark = ST.positionMarks[digit];
      if (JSON.stringify(before[digit]) === JSON.stringify(mark)) continue;
      if (mark) saved[digit] = mark;
      else delete saved[digit];
    }
    localStorage.setItem(key, JSON.stringify(saved));
    ST.savedMarks = snapshot;
  } catch {}
}
function stMarkChat(n) {
  return n?.type === 'win' && !n.file && !n.knowledge && !n.memo && !n.pad;
}
function stMarkNode(mark) {
  const original = mark.page === PG.cur && ST.nodes.find(n => n.id === mark.id);
  if (mark.resource) {
    const r = mark.resource;
    const matches = n => n?.type === 'win' && (r.file ?
      !!n.file && n.file.uid === r.file.uid && n.file.path === r.file.path && !!n.file.web === !!r.file.web :
      r.memo ? n.memo === r.memo : r.knowledge ? n.knowledge === r.knowledge : r.pad && n.pad);
    return matches(original) ? original : ST.nodes.find(matches);
  }
  if (stMarkChat(original) && (!mark.key || original.key === mark.key)) return original;
  return mark.key && ST.nodes.find(n => stMarkChat(n) && n.key === mark.key);
}
function stMarkAssignChatKey(n, key) {
  if (!key) return;
  for (const mark of Object.values(ST.positionMarks)) {
    if (!mark.resource && !mark.key && mark.page === PG.cur && mark.id === n.id) { mark.key = key; stSavePositionMarks(); }
  }
}
function* stMarkAncestors(n) {
  const seen = new Set([n.id]);
  while (n.par) {
    n = ST.nodes.find(w => w.id === n.par);
    if (!n || seen.has(n.id)) break;
    seen.add(n.id);
    yield n;
  }
}
function stMarkSlot(n) {
  return n && (ST.pos?.get(n.id) || ST.foldPositions?.get(n.id));
}
function stMarkOrder(a, b) {
  return (a.page || '').localeCompare(b.page || '') || a.x - b.x || (a.y || 0) - (b.y || 0);
}
function stNumberAutoMarks(marks, targets) {
  // Keep the shortcut for a closed or off-page chat until it has a live slot again.
  const numberedHere = mark => mark.auto && targets.get(mark).slot;
  const automatic = marks.filter(numberedHere).sort(stMarkOrder);
  if (!automatic.length) return;
  const fixed = new Set(marks.filter(mark => !numberedHere(mark)).map(mark => mark.digit));
  let number = 1;
  for (const mark of automatic) {
    while (fixed.has(String(number))) number++;
    const digit = String(number++);
    if (mark.digit === digit) continue;
    if (ST.positionMarks[mark.digit] === mark) delete ST.positionMarks[mark.digit];
    mark.digit = digit; ST.positionMarks[digit] = mark;
    if (ST.selectedMark === mark) stSelectMark(mark);
  }
}
function stSelectMark(mark) {
  ST.selectedMark = mark;
  const button = $('#stmarkdelete');
  if (!button) return;
  button.hidden = !mark;
  if (mark) {
    button.textContent = L(`0 删除 ${mark.digit}`, `0 Delete ${mark.digit}`);
    button.title = L(`删除标记 ${mark.digit}（按 0）`, `Delete mark ${mark.digit} (press 0)`);
  }
}
function stVisitMark(mark, index) {
  if (ST.positionMarks[mark.digit] !== mark) return;
  if (index != null) { ST.markIndex = index; return; }
  if (ST.markHistory[ST.markIndex] === mark) return;
  ST.markHistory.splice(ST.markIndex + 1);
  ST.markHistory.push(mark); ST.markIndex = ST.markHistory.length - 1;
}
function stDeleteSelectedMark() {
  const mark = ST.selectedMark;
  if (!mark) return;
  delete ST.positionMarks[mark.digit];
  stSavePositionMarks();
  // Keep a gap at the cursor so either direction still reaches its neighbour.
  const back = ST.markHistory.slice(0, ST.markIndex).filter(m => m && m !== mark);
  const forward = ST.markHistory.slice(ST.markIndex + 1).filter(m => m && m !== mark);
  const current = ST.markHistory[ST.markIndex];
  ST.markHistory = [...back, current === mark ? null : current, ...forward];
  ST.markIndex = back.length;
  stSelectMark(null); stMap();
}

function stSelectedMarkChat(frame, target) {
  const id = (frame?.closest('.stnode') || target.closest?.('.stnode'))?.dataset.nid || ST.focus;
  const n = ST.nodes.find(w => w.id === id);
  return n?.type === 'win' ? n : null;
}
function stAdjacentMark(direction, frame, target) {
  const marks = Object.values(ST.positionMarks).filter(mark => mark.page === PG.cur).sort(stMarkOrder);
  const arena = $('#starena');
  if (!arena || !marks.length) return;
  const source = stSelectedMarkChat(frame, target);
  const selected = ST.selectedMark;
  const current = ST.navigation?.mark || (selected && source && stMarkNode(selected) === source ? selected :
    marks.find(mark => source && stMarkNode(mark) === source));
  if (current && marks.includes(current)) return marks[marks.indexOf(current) + direction];
  const slot = stMarkSlot(source);
  const x = slot ? slot.x + slot.w / 2 : arena.scrollLeft + arena.clientWidth / 2;
  if (direction < 0) marks.reverse();
  return marks.find(mark => direction * (mark.x - x) > 0);
}
function stPositionMarkKey(e, frame) {
  const key = e.key, target = e.composedPath()[0], arrow = key.startsWith('Arrow');
  if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey ||
      target.isContentEditable || target.closest?.('input, textarea, select, [role="textbox"], .monaco-editor, .cm-editor, [role="dialog"], dialog') ||
      ((key === ' ' || arrow) && target.closest?.('button, summary, a, video, audio, [role="menu"], [role="listbox"], [role="slider"], [role="tablist"]'))) {
    if (ST.selectedMark) stSelectMark(null);
    return;
  }
  if (key === '0') {
    if (!ST.selectedMark) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!e.repeat) stDeleteSelectedMark();
    return;
  }
  if (S.view !== 'stage' && !ST.positionMarks[key]) return;
  if (arrow && !Object.keys(ST.positionMarks).length) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.repeat || ST.returningToMark) return;
  clearTimeout(ST.pageClickTimer);
  if (key === 'ArrowUp' || key === 'ArrowDown') {
    const step = key === 'ArrowUp' ? -1 : 1;
    let index = ST.markIndex + step;
    while (index >= 0 && index < ST.markHistory.length && !ST.markHistory[index]) index += step;
    stReturnToMark(ST.markHistory[index], index);
    return;
  }
  if (arrow) { stReturnToMark(stAdjacentMark(key === 'ArrowLeft' ? -1 : 1, frame, target)); return; }
  if (ST.positionMarks[key]) { stReturnToMark(ST.positionMarks[key]); return; }
  const n = stSelectedMarkChat(frame, target);
  if (!n) { toast(L('请先选中一个页面', 'Select a page first')); return; }
  const here = Object.values(ST.positionMarks).filter(mark => stMarkNode(mark) === n);
  const last = ST.selectedMark || ST.markHistory[ST.markIndex];
  const existing = here.includes(last) ? last : here[0];
  const reading = stMarkChat(n) ? pgMarkReading(n) : null;
  const slot = stMarkSlot(n), arena = $('#starena');
  const offset = slot && arena ? slot.x - arena.scrollLeft : null;
  const view = offset != null && offset < arena.clientWidth && offset + slot.w > 0 ? {offset} : {};
  if (existing && (key === ' ' || !reading)) {
    if (key === ' ') {
      if (reading) existing.reading = reading;
      Object.assign(existing, view);
      stSavePositionMarks();
    }
    stSelectMark(existing); stVisitMark(existing); return;
  }
  let digit = key;
  if (key === ' ') {
    let number = 1;
    while (number <= ST_AUTO_MARKS && ST.positionMarks[number]) number++;
    if (number > ST_AUTO_MARKS) {
      toast(L('1–5 号标记已满，可按 6–9 加标，或选中标记后按 0 删除', 'Marks 1–5 are full. Use 6–9 to add a mark, or select one and press 0 to delete it.'));
      return;
    }
    digit = String(number);
  }
  const mark = {...view, page:PG.cur, id:n.id, key:n.key || null, title:stNodeTitle(n), managerProject:n.managerProject,
    digit, auto:key === ' ', x:slot ? slot.x + slot.w / 2 : 0, y:slot?.y || 0};
  if (reading) mark.reading = reading;
  if (!stMarkChat(n)) {
    const {file, memo, memoSource, planId, planProject, knowledge, knowledgeSource, pad, bw} = n;
    mark.resource = {file, memo, memoSource, planId, planProject, knowledge, knowledgeSource, pad, bw};
    mark.title = n.title || n.el?.querySelector('.stwt,.memot')?.textContent || mark.title;
  }
  ST.positionMarks[digit] = mark;
  stSavePositionMarks();
  stSelectMark(mark); stVisitMark(mark); stMap();
}

async function stReturnToMark(mark, historyIndex) {
  if (!mark) return;
  if (ST.returningToMark) {
    ST.nextMark = {mark, historyIndex};
    return;
  }
  stSelectMark(mark);
  ST.returningToMark = true;
  try {
    if (S.view !== 'stage') show('stage');
    let n = stMarkNode(mark);
    if (!n && mark.page !== PG.cur && PG.list.some(p => p.id === mark.page)) {
      await pgGo(mark.page);
      if (PG.cur !== mark.page) return;
      await new Promise(requestAnimationFrame);
      n = stMarkNode(mark);
    }
    stShiftStop(); stReorderStop(); stNavigationStop();
    if (stEdgeWheel.motion) { cancelAnimationFrame(stEdgeWheel.motion.frame); stEdgeWheel.motion = null; }
    const a = $('#starena'); if (!a) return;
    const from = a.scrollLeft;
    if (n) {
      if (n.managerParked) stPmActivate(n);
      n.mini = false;
      // A child of a folded branch needs its ancestors visible to be reachable.
      for (const parent of stMarkAncestors(n)) {
        if (parent.small) { delete parent.small; stKidKeep(parent, false); }
        parent.mini = false;
      }
      stFocus(n.id, true);
    } else if (mark.resource) {
      const r = mark.resource;
      if (r.file) {
        const f = r.file;
        try { n = await stOpenFile(f.path, f.key, f.uid, f.web, f.origin); }
        catch (error) { toast(error.message); return; }
      } else {
        const id = ST.nodes.some(w => w.id === mark.id) ? stId() : mark.id;
        n = {id, type:'win', title:mark.title, ord:stWins().length, ...r};
        if (r.pad) store.set('pga_pad_off', '0');
        ST.nodes.push(n);
        stFocus(id, true); stSave();
      }
    } else {
      n = stOpen(mark.key, {managerProject:mark.managerProject});
    }
    mark.page = PG.cur; mark.id = n.id;
    stReorderStop();
    a.scrollTo({left:from, behavior:'instant'});
    stShow(n.id, true, mark);
    a.focus({preventScroll:true});
    if (mark.reading) pgReturnToReading(n, mark.reading);
    stVisitMark(mark, historyIndex); stMap();
  } finally {
    ST.returningToMark = false;
    const next = ST.nextMark;
    ST.nextMark = null;
    if (next && ST.positionMarks[next.mark.digit] === next.mark)
      await stReturnToMark(next.mark, next.historyIndex);
  }
}
function stReorderStop() {
  clearTimeout(ST.sortAlignTimer); ST.sortAlignTimer = null;
  for (const n of ST.nodes) {
    const e = n.el;
    if (!e?._sortAnimation) continue;
    e._sortAnimation.cancel(); e._sortCleanup?.(); e._sortAnimation = null;
  }
}
// FLIP, as in Motion/Sortable: measure the visible pose, commit layout, animate
// only the visual offset. Never restart an animation for an unchanged layout.
function stReorderStart(box) {
  if (ST.managerPlacing || ST.drag || ST.pan || ST.rz || ST.branchResize || ST.overview || ST.mapMode !== 'time' || typeof box.querySelectorAll !== 'function') return null;
  const frames = [], arena = $('#starena');
  box.querySelectorAll(':scope > .stnode').forEach(e => {
    if (e.hidden || !e.animate || ST.nodes.find(n => n.id === e.dataset.nid)?.screenPin) return;
    frames.push({e, rect:e.getBoundingClientRect(), layout:[e.style.left,e.style.top,e.style.width,e.style.height].join('|'),
      scroll:arena.scrollLeft, transition:e.style.transition});
  });
  // Separate reads and writes; avoid a layout flush for each conversation.
  for (const f of frames) f.e.style.transition = 'none';
  return frames;
}
function stReorderEnd(frames, anchor) {
  if (!frames) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const arena = $('#starena'), viewport = arena.getBoundingClientRect(), changed = [];
  for (const f of frames) {
    const {e} = f, layout=[e.style.left,e.style.top,e.style.width,e.style.height].join('|');
    if (!reduce && !e.hidden && layout === f.layout && arena.scrollLeft === f.scroll) {
      e.style.transition = f.transition; continue;
    }
    e._sortAnimation?.cancel(); e._sortCleanup?.(); e._sortAnimation = null;
    changed.push(f);
  }
  if (changed.some(f => f.layout !== [f.e.style.left,f.e.style.top,f.e.style.width,f.e.style.height].join('|'))) {
    clearTimeout(ST.sortAlignTimer); ST.sortAlignTimer = null;
  }
  const plans = changed.map(f => ({...f, to:f.e.getBoundingClientRect()}));
  for (const {e, rect:from, to, transition} of plans) {
    e.style.transition = transition;
    let dx=from.left-to.left, dy=from.top-to.top;
    if (reduce || e.hidden || Math.abs(dx)+Math.abs(dy)<1) continue;
    const visible = r => r.right>viewport.left && r.left<viewport.right;
    if (!visible(from) && !visible(to)) continue;
    // Offscreen arrivals/exits travel only near the edge, not across the whole desk.
    const far = Math.abs(dx)>viewport.width;
    const exiting=far&&!visible(to);
    if (far&&!exiting) dx=Math.sign(dx)*Math.min(96,viewport.width*.12);
    const lift = dx>0 ? -10 : 6, z=e.style.zIndex;
    e.style.zIndex=dx>0?'8':'2';
    const duration=far?240:340;
    const keyframes=exiting ? [
      {translate:`${dx}px ${dy}px`,opacity:1},
      {translate:`${dx-Math.sign(dx)*48}px ${dy}px`,opacity:0}
    ] : [
      {translate:`${dx}px ${dy}px`,opacity:far&&visible(to)?0:1},
      {translate:`${dx*.45}px ${dy*.45+lift}px`,opacity:1,offset:.5},
      {translate:'0px 0px',opacity:1}
    ];
    const animation=e.animate(keyframes,{duration,easing:'cubic-bezier(.4,0,.2,1)'});
    e._sortAnimation=animation;
    const cleanup=()=>{if(e._sortAnimation!==animation)return;e.style.zIndex=z;e._sortAnimation=null;e._sortCleanup=null;};
    e._sortCleanup=cleanup;animation.onfinish=cleanup;animation.oncancel=cleanup;
    ST.movedAt=Math.max(ST.movedAt||0,performance.now()+duration);
  }
  // Automatic time sorting must never navigate away from the anchored page.
  clearTimeout(ST.sortAlignTimer); ST.sortAlignTimer = null;
}
function stRender() {
  if (ST.drag?.dock || ST.overview) return;
  if (typeof stPmSingle === "function") stPmSingle();
  // Category filtering is temporarily disabled; old snapshots must not hide pages.
  ST.groupFold = {}; ST.groupSolo = null;
  const box = $("#stnodes"), bars = $("#stbars"); if (!box) return;
  if (stLimitPages()) stSave();
  const reorder = stReorderStart(box);
  const anchor = ST.sortAnchor || stAnchor(), regathered = stGroupGather();
  ST.sortAnchor = null;
  if (regathered) stSave();
  stGroupColors();
  stSideList(); // Keep the settings overlay in sync before updating stage navigation.
  if (reorder && anchor && stWins().find(n => !n.small && !n.mini && !n.screenPin)?.id === anchor.id) {
    ST.sortLead = Math.max(ST.sortLead || 0, anchor.dx - ST_PADX - Math.ceil(innerWidth / 2));
  }
  const { units, A } = stLayout(), keep = new Set(ST.nodes.map((n) => n.id)), held = ST.drag?.n;
  const managerSource = ST.nodes.find(n => n.type === 'win' && n.managerProject && !n.managerParked && !n.small && !n.mini)?.managerBeside;
  box.querySelectorAll(":scope > .stnode").forEach((el) => { if (!keep.has(el.dataset.nid)) el.remove(); });
  const el = (n) => { const home = box;
    let e = box.querySelector(`:scope > .stnode[data-nid="${n.id}"]`);
    if (!e) { e = document.createElement("div"); e.className = `stnode t-${n.type}`; e.dataset.nid = n.id; e.innerHTML = n.type === "win" ? stWinHtml(n) : stCardHtml(n); home.appendChild(e); if (n.type === "win") { if (n.pad) stPadIn(e); else if (n.memo) memoMount(n, e); else if (n.knowledge) knowledgeMount(n, e); else if (n.file) stFileFrame(n, e); else stFrame(n, e); } }
    else if (n.type !== "win" && n.type !== "note" && e.dataset.sig !== (n.title || "") + (S.forest ? 1 : 0)) e.innerHTML = stCardHtml(n);
    if (e.parentElement !== home) home.appendChild(e);
    if (n.type === "win") { stLayerLook(e, n); stBackLook(e, n); stBranchDockLook(e, n);
      const f = e.querySelector("iframe"); if (!n.pad && !n.memo && !n.knowledge && !n.file && f && !f.hasAttribute("src") && !stFrame.pending?.has(f)) stFrame(n, e);
    }
    if (n.type === 'win') {
      e.classList.toggle('st-manager-page', !!n.managerProject);
      const globalEntry = e.querySelector('[data-stw="global"]');
      if (globalEntry) { globalEntry.hidden = !(n.managerProject || n.key?.startsWith('chat:pm-')); globalEntry.setAttribute('aria-expanded', String(!!ST.listOpen)); }
      const entry = e.querySelector('[data-stw="manager"]');
      if (entry) {
        entry.hidden = !!n.managerProject || !!n.key?.startsWith('chat:pm-');
        entry.classList.toggle('on', n.id === managerSource);
        entry.setAttribute('aria-expanded', String(n.id === managerSource));
        entry.title = n.id === managerSource ? L('收起管理员', 'Collapse manager') : L('在左侧展开管理员', 'Open manager on the left');
        entry.setAttribute('aria-label', entry.title);
      }
    }
    e.dataset.sig = (n.title || "") + (S.forest ? 1 : 0); return e; };
  const rid = (ST.rid = (ST.rid || 0) + 1);
  let moved = false;                                   // pages sliding to new places: their transition is motion too
  const place = (e, x, y, w, h, show = true) => { e.dataset.r = rid; if (e === held?.el) return; if (show && !e.hidden && (e.style.left !== x + "px" || e.style.width !== w + "px")) moved = true; e.style.left = x + "px"; e.style.top = y + "px"; e.style.width = w + "px"; e.style.height = h + "px"; e.hidden = !show; };
  let barHtml = ""; const pos = new Map(), foldedSlots = new Map(), runs = new Set();
  for (const u of units) {
    if (u.kind === "win") {
      const e = el(u.win); u.win.el = e;
      if (u.hide || !u.open) { place(e, -9999, 0, u.w, A.h, false); if (!u.hide) { const t = stNodeTitle(u.win);
        u.run.tabs.push({ win: u.win.id, html: (y) => `<div class="sttab win" style="left:${u.x}px;top:${y}px;width:${ST_TAB}px;height:${ST_TH}px" data-stunfold="${u.win.id}" title="${esc(t)}"><span>▢ ${esc(t.slice(0, 40))}</span></div>` }); runs.add(u.run); } continue; }
      const wy = 2, mh = A.h - wy; e.classList.remove("stkid", "stkfold", "sel"); stShortLook(u.win, mh); stMiniLook(e, false);
      place(e, u.x, wy, u.w, mh); e.classList.toggle("focus", u.win.id === ST.focus); stWsLook(e, u.win); stSmallLook(e, u.win);
      e.classList.toggle("hascol", units.some((c) => c.kind === "col" && c.win === u.win && !c.hide && c.open));      // its column covers the input labels
      pos.set(u.win.id, { x: u.x, y: wy, w: u.w, h: mh }); continue;
    }
    if (u.kind === "cat") {   // a folded category: its name, upright, and how many pages are in it
      for (const w of u.wins) foldedSlots.set(w.id, {x:u.x, y:8, w:u.w});
      barHtml += `<button class="stcatfold" style="left:${u.x}px;top:8px;width:${ST_CATW}px;height:${A.h - 8}px;--wc:${esc(u.g?.c || "var(--line-3)")}" data-stcat="${esc(u.g?.id || "")}" title="${esc(L(`${u.g?.name} · ${u.wins.length} 个对话都已折叠，点开`, `${u.g?.name} · all ${u.wins.length} folded, click to open`))}"><span>${esc(u.g?.name || "")}</span><em>${u.wins.length}</em></button>`;
      continue;
    }
    if (u.kind === "lines" && !u.hide) { // Category-coloured thin lines; hover for the name, click to open.
      u.wins.forEach((w, i) => { const x = u.x + i * (ST_LINE + 4); foldedSlots.set(w.id, {x, y:8, w:ST_LINE}); barHtml += `<button class="stfoldline" style="left:${x}px;top:8px;width:${ST_LINE}px;height:${A.h - 8}px;--wc:${esc(stGroupOf(w)?.c || 'var(--line-3)')}" data-stunfold="${esc(w.id)}" title="${esc((w.file ? w.title : stTitle(w.key)))}" aria-label="${esc(L('打开：', 'Open: ') + (w.file ? w.title : stTitle(w.key)))}"><span class="stline-title">${esc((w.file ? w.title : stTitle(w.key)))}</span></button>`; });
      continue;
    }
    if (u.kind === "lines" || (u.kind === "stack" && u.hide)) continue;
    if (u.kind === "stack") {
      const gap = 10, heights = stBranchHeights(u.wins, Math.max(1, A.h - 8 - gap * (u.wins.length - 1)));
      const chosen = u.wins.find(k => k.id === u.par.sel) || u.wins[0]; let y = 8;
      u.wins.forEach((k, i) => {
        const e = el(k), h = heights[i]; k.el = e;
        stMiniLook(e, false); stShortLook(k, h);
        if (e.classList.contains("stkfold")) stKidKeep(k, false);
        place(e, u.x, y, u.w, h);
        e.classList.add("stkid"); e.classList.remove("stkfold"); stKidLook(e, k);
        e.classList.toggle("sel", k === chosen); e.classList.toggle("focus", k.id === ST.focus);
        stWsLook(e, k); stSmallLook(e, k);
        pos.set(k.id, {x:u.x, y, w:u.w, h, kid:true}); y += h + gap;
      });
      continue;
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
  let k = 0;                                       // small pages: where you left them, else stacked in the lower right corner
  for (const w of stWins().filter((x) => x.mini && !stGroupHidden(x))) {
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
  // Detached pages stay mounted, but consume no space in the scrolling row.
  for (const n of stWins().filter(n => n.screenPin && !n.small)) {
    const e = el(n); n.el = e;
    const w = Math.min(n.screenPin.resizedWidth || n.screenPin.width || n.bw || ST_MINW, A.w);
    place(e, 0, 2, w, A.h - 2);
    stMiniLook(e, false); stWsLook(e, n);
    pos.set(n.id, {x: 0, y: 2, w, h: A.h - 2});
  }
  for (const [id, w] of Object.entries(ST.ws || {})) {   // a band above a workspace's pages in the row, in its colour
    const ps = stWins().filter((o) => o.ws === id && !o.mini).map((o) => pos.get(o.id)).filter((p) => p && !p.tab); if (!ps.length) continue;
    const l = Math.min(...ps.map((p) => p.x)), r = Math.max(...ps.map((p) => p.x + p.w));
    barHtml += `<div class="stwsband" style="left:${l}px;width:${r - l}px;--wc:${ST.groupColors?.get("ws:" + id) || w.c}" title="${esc(w.name)}"></div>`; }
  for (const n of stWins()) {
    n.el?.classList.toggle("conversation-expanded", !!n.big);
    // Migrate saved full-screen windows back into the scrollable canvas.
    if (n.el?.hasAttribute("popover")) {
      n.el.hidePopover(); n.el.removeAttribute("popover");
    }
    const button = n.el?.querySelector('[data-stw="max"]');
    if (button) {
      button.title = n.fullscreen ? L("还原（Esc）", "Restore (Esc)") : L("铺满台面，保留顶部导航（双击 50%，三击 90%）", "Fill canvas, keep navigation (double-click: 50%, triple-click: 90%)");
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-pressed", String(!!n.fullscreen));
    }
  }
  bars.innerHTML = barHtml;
  bars.querySelectorAll(".stfoldline").forEach(stBindSummaryHover);

  box.querySelectorAll(".stnode").forEach((e) => { if (e.dataset.r !== String(rid) && e !== held?.el) e.hidden = true; });   // cards of a small page wait unseen
  ST.pos = pos; ST.foldPositions = foldedSlots; ST.units = units; window.stPinApply?.(); requestAnimationFrame(stMap); if (!ST.drag) stGrow();
  if (moved && !ST.managerPlacing) ST.movedAt = Math.max(ST.movedAt || 0, performance.now() + 280);   // until the .28 s slide has ended
  if (typeof stPmRendered === "function") stPmRendered();
  if (regathered || reorder) stKeepAnchor(anchor);
  stReorderEnd(reorder, anchor);
  if (ST.drag?.groups && ST.drag.moved && ST.drag.lx != null) stDragTo(ST.drag.lx, ST.drag.ly);   // redrawn mid-drag: preserve the translated positions
  else stWires();
  stScheduleFrameLoads();
}
const stPinY = (w, i) => (w.tab ? w.y + w.h / 2 : w.y + w.h * (i * 2 + 1) / 6);
const stCurve = (x0, y0, x1, y1) => { const k = Math.max(40, Math.abs(x1 - x0) / 2); return `M ${x0} ${y0} C ${x0 + k} ${y0}, ${x1 - k} ${y1}, ${x1} ${y1}`; };
// Straight edge-to-edge branch connections. Horizontal spacing only changes length.
function stBranchLine(a, b, laneY) {
  const x1 = a.x + a.w / 2, x2 = b.x + b.w / 2;
  const startY = a.y + a.h, endY = b.y + b.h;
  const y = Math.max(startY, endY) + 12;
  const lane = Math.max(y, laneY ?? y);
  // Stacked children leave through the gutter beside their bottom corner so
  // the vertical segment does not disappear behind the sibling below them.
  const start = a.kid ? `M ${a.x + 8} ${startY} V ${startY + 4} H ${a.x - 6} V ${lane}` : `M ${x1} ${startY} V ${lane}`;
  const end = b.kid ? `H ${b.x - 6} V ${endY + 4} H ${b.x + 8} V ${endY}` : `H ${x2} V ${endY}`;
  return {x1, x2, y:lane, endY, path:`${start} ${end}`};
}
function stWires() {                              // each card into the input of its band; windows into each other, right pin to left pin
  const svg = $("#stwires"); if (!svg || !ST.pos) return; let h = "";
  const bottoms = stWins().map(w => ST.pos.get(w.id)).filter(p => p && !p.tab).map(p => p.y + p.h);
  const floor = Math.max(0, ...bottoms) + 12; let wireIndex = 0;
  const route = (a, b) => stBranchLine(a, b, floor + (wireIndex++ % 3) * 6);
  for (const n of ST.nodes) {
    if (n.type === "win" || !n.win) continue; const p = ST.pos.get(n.id), w = ST.pos.get(n.win); if (!p || !w || ST.drag?.n === n) continue;
    const right = p.x + p.w / 2 > w.x + 24, x0 = right ? p.x : p.x + p.w, y0 = p.y + p.h / 2;
    h += `<path class="stwire z${p.zone}" d="${right ? `M ${x0} ${y0} C ${x0 - 60} ${y0}, ${w.x - 60} ${stPinY(w, p.zone)}, ${w.x} ${stPinY(w, p.zone)}` : stCurve(x0, y0, w.x, stPinY(w, p.zone))}"/><circle class="stball z${p.zone}" cx="${x0}" cy="${y0}" r="5"/>`;
  }
  const windows = stWins();
  const byId = new Map(windows.map(w => [w.id, w]));
  const byKey = new Map(windows.filter(w => w.key).map(w => [w.key, w]));
  for (const child of windows) {
    const feed = child.key?.startsWith("chat:mt-") && executionFeedOf(child.key);
    const sourceKey = child.branchFrom || (child.branchKey && child.from)
      || child.knowledgeSource || child.memoSource || child.file?.key;
    const parent = byKey.get(feed) || byId.get(child.par) || byId.get(child.branchParent)
      || byId.get(child.file?.sourceId) || byKey.get(sourceKey);
    if (!parent || parent === child || child.small || parent.small) continue;
    const a = ST.pos.get(parent.id), b = ST.pos.get(child.id);
    if (!a || !b || a.tab || b.tab) continue;

    const key = child.key || child.id;
    const color = feed ? sourceRailColor(key) : railPairColor(key);
    const right = b.x >= a.x + a.w;
    let path;
    if (right || b.x + b.w <= a.x) {
      const frame = parent.el?.querySelector('iframe');
      const anchor = frame?.contentWindow?.convMapAnchor?.(child.branchPoint, key);
      const top = Math.max(a.y, b.y), bottom = Math.min(a.y + a.h, b.y + b.h);
      const startY = anchor ? a.y + frame.getBoundingClientRect().top - parent.el.getBoundingClientRect().top + anchor.y
        : bottom > top ? (top + bottom) / 2 : a.y + a.h / 2;
      const endY = Math.max(b.y + 8, Math.min(startY, b.y + b.h - 8));
      path = `M ${right ? a.x + a.w : a.x} ${startY} L ${right ? b.x : b.x + b.w} ${endY}`;
    } else path = route(a, b).path;
    h += `<path class="stwire fork page-source${feed ? " task-source" : ""}" style="stroke:${color}" d="${path}"/>`;
  }
  for (const b of stWins()) for (const l of b.links || []) {
    const a = ST.pos.get(l.from), t = ST.pos.get(b.id); if (!a || !t) continue;
    const d = route(a, t).path;
    h += `<path class="stwire link z${l.pin}" d="${d}"/><path class="sthit" d="${d}" data-unlink="${b.id}|${l.from}|${l.pin}"><title>${L("点一下断开这根线", "Click to cut this wire")}</title></path>`;
  }
  const g = ST.wire; if (g) h += `<path class="stwire tmp z${g.pin}" d="${g.back ? stCurve(g.x, g.y, g.x0, g.y0) : stCurve(g.x0, g.y0, g.x, g.y)}"/><circle class="stball z${g.pin}" cx="${g.x}" cy="${g.y}" r="5"/>`;
  svg.innerHTML = h;
  if (!ST.parentRailsPending) {
    ST.parentRailsPending = true;
    requestAnimationFrame(() => { ST.parentRailsPending = false; for (const n of stWins()) { try { n.el?.querySelector('iframe')?.contentWindow?.updateParentRail?.(); } catch {} } });
  }
  stOver();
}
// Passing a window during a glide must not boot another whole application.
// Keep a small recently viewed set warm; never boot the windows we only pass by.
function stScheduleFrameLoads(delay = 100) {
  clearTimeout(stFrame.timer);
  if (ST.frameMoving || ST.navigation || ST.drag || ST.pan || ST.overview || (typeof stShiftMotion !== "undefined" && stShiftMotion)) return;
  stFrame.timer = setTimeout(() => {
    if (S.view !== "stage" || document.hidden || ST.frameMoving || ST.navigation || ST.drag || ST.pan || ST.overview || (typeof stShiftMotion !== "undefined" && stShiftMotion)) return;
    // A page booting mid-motion stalls it for 0.1–0.3 s: load once the stage has been still for a moment.
    const still = performance.now() - (ST.movedAt || -Infinity);
    if (still < 140) { stScheduleFrameLoads(160 - still); return; }
    const arena = $("#starena"); if (!arena) return;
    const a = arena.getBoundingClientRect(), ready = [], now = performance.now(), frames = new Map();
    const left = arena.scrollLeft || 0, viewport = arena.clientWidth || a.right - a.left;
    // Measure once per window, before mutating any iframe or placeholder.
    for (const n of stWins()) {
      if (n.pad || n.memo || n.knowledge) continue;
      const f = n.el?.querySelector("iframe"); if (!f?.isConnected) continue;
      // Use stage geometry: querying inside each offscreen iframe can force its layout.
      const pos = ST.pos?.get(n.id), drawable = !n.el.hidden && !n.small && !ST.folded?.has(n.id);
      const r = pos && !n.screenPin ? {left:a.left + pos.x - left, right:a.left + pos.x + pos.w - left,
        top:a.top + (pos.y || 0), bottom:a.top + (pos.y || 0) + (pos.h ?? a.bottom-a.top),
        width:pos.w, height:pos.h ?? a.bottom-a.top} : f.getBoundingClientRect();
      const visible = drawable && !!(r.width && r.height && r.right > a.left && r.left < a.right && r.bottom > a.top && r.top < a.bottom);
      try { const w = f.contentWindow, state = w?.S; if (state) {
        const paused = state.stageDormant || state.stageMotion;
        state.stageDormant = !visible; state.stageMotion = false;
        if (visible && paused) w.pgaStageActivated?.();
      } } catch {}
      if ((visible || f._pgaInView) && f.hasAttribute("src")) f._pgaSeenAt = now;
      f._pgaInView = visible;
      frames.set(f, {n, f, visible, near:drawable && r.right > a.left - viewport * .75 && r.left < a.right + viewport * .75,
        distance: Math.abs((r.left + r.right - a.left - a.right) / 2)});
    }
    // A bounded working set survives quick round trips across several categories.
    // Recently started documents also get a grace period so short visits cannot thrash them.
    const warm = new Set([...frames.values()].filter(({n, f, visible}) => !n.file && !visible && f.hasAttribute("src") && f._pgaSeenAt != null && now - f._pgaSeenAt < 300000)
      .sort((x,y) => y.f._pgaSeenAt - x.f._pgaSeenAt).slice(0,12).map(x => x.f));
    // A suspended conversation is resumed only when its window is back in view.
    // stFrame restores the normal load handler and page-state restoration path.
    let suspended = false;
    for (const {n, visible} of frames.values()) {
      if (n.file || !n._stageSuspended) continue;
      if (visible) {
        delete n._stageSuspended; stFrame(n, n.el);
      }
    }
    // Unload distant, idle app instances after saving their scroll position and
    // draft. A live selection or request keeps its document mounted.
    for (const {n, f, visible} of frames.values()) {
      if (n.file || !f.hasAttribute("src") || n._stageSuspended || n.id === ST.focus || visible || warm.has(f)
        || (f._pgaStartedAt != null && now - f._pgaStartedAt < 10000)) continue;
      try {
        const sel = f.contentWindow?.getSelection?.();
        const active = f.contentDocument?.activeElement;
        const state = f.contentWindow?.S, key = n.key || state?.chat;
        const live = ST.liveByKey?.get(key);
        let queued = state?.followups?.[key]?.length > 0;
        if (!queued && key && state?.uid) try { queued = JSON.parse(localStorage.getItem(`pga:followups:${state.uid}:${key}`) || "[]").length > 0; } catch {}
        const draft = f.contentDocument?.querySelector("#chatText")?.value || state?.chatDraft || "";
        const restoringDraft = window.PG?.pending?.get(n.id)?.draft;
        // Managers own a separate unsaved document, attachment store and task poller.
        // Leave them resident until that state has an explicit snapshot format.
        if (n.managerProject || n.key?.startsWith("chat:pm-") || n._pgRestoring || restoringDraft || stBusy(n) || (live && !live.finished) || state?.sending || state?.regenBusy || state?.knowledgePreparing || state?.followupDraining || state?.remoteRun || state?.followupActive || queued || state?.att?.length || draft.length > 0 || (sel && !sel.isCollapsed) || (active && !["BODY", "HTML"].includes(active.tagName)) || typeof pgProg !== "function") continue;
        const progress = pgProg(n, null) || (!draft ? { turns: 0, msgs: 0, msg: 0, off: 0, end: true, draft: "", title: stNodeTitle(n) } : null);
        if (!progress) continue;
        n.prog = progress; window.PG?.pending?.set(n.id, progress); n._stageSuspended = true; suspended = true;
        if (f._pgaStageLoad) f.removeEventListener("load", f._pgaStageLoad);
        f._pgaStageLoad = null;
        clearTimeout(f._pgaWatch); f._pgaLoading = null;
        window.pgCancelRestore?.(n);
        f.removeAttribute("src");
        stFrameLoading(n, "queued");
      } catch {}
    }
    if (suspended) { stSave(); window.pgLocalSave?.(); }
    for (const [f, url] of stFrame.pending || []) {
      if (!f.isConnected) { stFrame.pending.delete(f); continue; }
      const entry = frames.get(f); if (!entry) continue;
      const {n, visible, near, distance} = entry;
      if (n.file && !visible) continue;
      const savedDraft = n && (n.prog?.draft || window.PG?.pending?.get(n.id)?.draft);
      if (savedDraft || visible || (near && still >= 700)) ready.push({n, f, url, visible,
        priority: visible ? (n.id === ST.focus ? -1 : distance) : savedDraft ? 1e8 : 1e9 + distance});
    }
    ready.sort((x,y) => x.priority - y.priority);
    const inFlight = [...frames.values()].filter(({n, f}) => n.file
      ? f._pgaFileStarted != null && now - f._pgaFileStarted < 8000
      : f._pgaLoading && f._pgaWatch && now - f._pgaLoading.at < 8000);
    // A slow preload outside the viewport must not hold the newly selected page
    // behind it. Allow one foreground load beside it, never a boot burst.
    const foreground = ready[0]?.visible && inFlight.length < 2 && !inFlight.some(x => x.visible);
    if (ready.length && (!inFlight.length || foreground)) {
      const {n, f, url} = ready[0]; stFrame.pending.delete(f);
      if (n.file) { f._pgaFileStarted = now; f.src = url; }
      else stFrameStart(f, url);
    }
    if (ready.length || inFlight.length) stScheduleFrameLoads(180);
    else if (still < 700 && [...frames.values()].some(({f, near}) => near && stFrame.pending?.has(f))) stScheduleFrameLoads(720 - still);
    else if (warm.size || [...frames.values()].some(({f}) => f.hasAttribute('src'))) stScheduleFrameLoads(10000);
  }, delay);
}
function stFrame(n, el, force = false) {
  n.el = el; // A new window may not yet have reached stRender's placement pass.
  if (typeof readingRepairNode === 'function') readingRepairNode(n);
  // Restored snapshots may contain a stale display key; the fork identity wins.
  if (n.branchKey) n.key = n.branchKey;
  const q = new URLSearchParams({ view: "chats", embed: "1" });
  if (n.key) { if (S.allChats?.some((c) => c.key === n.key) || n.key.startsWith("chat:") || n.key.startsWith("run:")) q.set("c", n.key); else q.set("item", n.key); }
  if (n.managerProject && n.key?.startsWith("chat:pm-")) q.set("manager", n.managerProject);
  if (AS_UID) q.set("as", AS_UID); if (Q.get("lang")) q.set("lang", Q.get("lang")); if (n.agent) q.set("agent", n.agent);   // a branch: answered by the agent it was given
  const f = el.querySelector("iframe"), url = "/?" + q;
  if (!force && f.hasAttribute('src') && f._pgaURL === url && f._pgaNodeId === n.id && f._pgaStageLoad) return;
  f._pgaURL = url;
  f._pgaNodeId = n.id;
  clearTimeout(f._pgaWatch); f._pgaLoading = null;
  stFrameLoading(n, "queued");
  if (f._pgaStageLoad) f.removeEventListener("load", f._pgaStageLoad);
  f._pgaStageLoad = () => {
    if (stFrame.pending?.has(f) || f.contentDocument?.URL === "about:blank") return;
    const current = ST.nodes.find(w => w.id === n.id); if (!current) return;
    try { stHold(f, current); stSide(current); stShortLook(current); f.contentWindow.knowledgeSyncButtons?.(); } catch {}
    try { if (typeof pgWatchScroll === "function") pgWatchScroll(f.contentDocument); } catch {}
    window.pgRestore?.(current, f);
    stFrameWatch(f);
  };
  f.addEventListener("load", f._pgaStageLoad);   // reused frames bind once and restore the current snapshot
  if (!f.hasAttribute("src") && (document.hidden || n.id !== ST.focus || n._stageSuspended || ST.frameMoving || ST.navigation || ST.drag || ST.pan || ST.overview || (typeof stShiftMotion !== "undefined" && stShiftMotion))) {
    (stFrame.pending ||= new Map()).set(f, url); stScheduleFrameLoads();
  } else {
    stFrame.pending?.delete(f); stFrameStart(f, url);
  }
}
function stFrameLoading(n, status, phase = "page") {
  const box = n.el?.querySelector(".stloading"); if (!box) return;
  box.hidden = status === "ready";
  if (box.dataset.state === status && box.dataset.phase === phase) return;
  box.dataset.state = status; box.dataset.phase = phase;
  const header = n.el.querySelector(".stwh"); if (header) box.style.top = header.offsetHeight + "px";
  const text = status === "error" ? L("对话读取失败，请重试；草稿保留", "Could not read this conversation. Retry; your draft is kept.")
    : status === "slow" ? (phase === "history" ? L("正在等待对话记录，可重试读取", "Still waiting for conversation history. You can retry the read.") : L("页面初始化较慢，可重试", "The page is taking longer to start. You can retry."))
    : status === "queued" ? L("正在准备对话…", "Preparing conversation…")
    : phase === "history" ? L("正在读取对话记录…", "Reading conversation history…")
    : phase === "paint" ? L("正在显示对话…", "Rendering conversation…") : L("正在打开页面…", "Opening the page…");
  box.querySelector(".stloading-status span").textContent = status === "ready" ? "" : text;
  box.querySelector("button").hidden = !["error", "slow"].includes(status);
  n.el.querySelector("iframe")?.setAttribute("aria-busy", String(status !== "ready"));
}
function stFrameRetry(n) {
  const f = n.el?.querySelector('iframe'), w = f?.contentWindow, state = w?.S;
  // Once the app is running, retry only the read. Keep its draft, attachments,
  // scroll position and running work in the same document.
  if (state?.booted && state.chat === n.key && n.key?.startsWith('chat:') && typeof w.loadChat === 'function') {
    f._pgaLoading = {at:performance.now(), previous:null};
    stFrameLoading(n, 'loading', 'history');
    w.loadChat(n.key, {force:true});
    stFrameWatch(f);
    return;
  }
  stFrame(n, n.el, true);
}
function stFrameStart(f, url) {
  clearTimeout(f._pgaWatch);
  f._pgaStartedAt = performance.now();
  f._pgaLoading = {at: f._pgaStartedAt, previous: f.contentDocument};
  const n = ST.nodes.find(n => n.id === f._pgaNodeId); if (n) stFrameLoading(n, "loading");
  f.loading = "eager"; f.src = url;
  stFrameWatch(f);
}
function stFrameWatch(f) {
  clearTimeout(f._pgaWatch);
  const n = ST.nodes.find(n => n.id === f._pgaNodeId), pending = f._pgaLoading;
  if (!pending || !f.isConnected || !f.hasAttribute("src") || !n || n.el?.querySelector("iframe") !== f || !n.el.querySelector(".stloading")) return;
  let ready = false, error = false, phase = 'page';
  try {
    const d = f.contentDocument, s = f.contentWindow?.S;
    if (d && d !== pending.previous && d.URL !== "about:blank" && s?.booted) {
      phase = 'history';
      if (n.key?.startsWith("chat:")) {
        error = s.chat === n.key && !!s.chatLoadErrors?.[n.key];
        const hasHistory = s.chat === n.key && Array.isArray(s.chatTurns?.[n.key]);
        if (hasHistory) phase = 'paint';
        // A failed refresh must not cover the readable history already in memory.
        ready = hasHistory && !s.stageChatRenderPending;
      } else if (n.key) {
        error = !!s.impData?.error;
        ready = !!(s.imp?.key === n.key && s.impData?.id === s.imp.cid && !error) || s.treeItem?.item === n.key;
      } else ready = !!d.querySelector("#chatText");
    }
  } catch {}
  if (ready) { f._pgaLoading = null; stFrameLoading(n, "ready"); stScheduleFrameLoads(); return; }
  const slow = performance.now() - pending.at > 8000;
  stFrameLoading(n, error ? "error" : slow ? "slow" : "loading", phase);
  // Watch data readiness, not just iframe.onload (which precedes API responses).
  // A late successful response can still clear the slow/error state. Disposed
  // or replaced documents lose this timer at the next tick.
  f._pgaWatch = setTimeout(() => stFrameWatch(f), error || slow ? 1000 : 100);
}
const ST_DBL_SKIP = "summary, .chat-action-menu, [data-pdgo], input, textarea, select, button, a, video, [contenteditable], #ccomp, .cm-editor, .monaco-editor, .fp-img, .cnote, [data-pjmap], .stwt, .memot, .md, .ct, .wtext, pre, p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote";   // text belongs to selection; only window whitespace enlarges
function stHold(f, n) {                          // inside a conversation: press and hold (~0.25 s, still), then move the window
  const cw = f.contentWindow, doc = cw.document;
  if (doc._pgaStageHold === n.id) return; // Reused frames keep one binding across snapshot restores.
  doc._pgaStageHold = n.id;
  stRightPanBind(doc, f);
  stMiddlePanBind(doc, f);
  const current = () => ST.nodes.find(w => w.id === n.id);
  let h = null, dragged = false;
  stPageClickBind(doc, () => dragged ? null : current(), () => cw.getSelection());
  doc.addEventListener("keydown", (e) => {
    const n = current(); if (!n) return;
    if (e.key === "Escape") { clearTimeout(stSizeTimer); stSizeTimer = null; }
    if (e.key === "Escape" && ST.listOpen) { stDropToggle(false, true); e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.key === "Escape" && typeof stMoreClose === "function" && stMoreClose(true)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (e.key === "Escape" && n.big) { stMax(n, false); return; }
    stFocus(n.id);
  }, true);
  doc.addEventListener("pointerdown", (e) => {
    const n = current(); if (!n) return;
    dragged = false; stFocus(n.id);
    if (n.par || n.screenPin) return;                                // a branch is not carried about on its own
    if (e.button !== 0 || e.target.closest(ST_DBL_SKIP + ", #pmview")) return;
    h = { sx: e.screenX, sy: e.screenY, on: false, t: setTimeout(() => { if (!h) return; h.on = true; doc.documentElement.classList.add("stgrab");
      try { doc.documentElement.setPointerCapture(e.pointerId); } catch {} const target = current(); if (target) stGrab(target, h.sx, h.sy, e.clientX); cw.getSelection()?.removeAllRanges(); }, 250) };
  }, true);
  doc.addEventListener("pointermove", (e) => {
    if (!h) return;
    if (!h.on) { if (Math.hypot(e.screenX - h.sx, e.screenY - h.sy) > 5) { clearTimeout(h.t); h = null; } return; }
    e.preventDefault(); cw.getSelection()?.removeAllRanges(); stDragSoon(e.screenX, e.screenY);
  }, true);
  const end = () => { if (!h) return; clearTimeout(h.t); const was = h.on; dragged = was; h = null; doc.documentElement.classList.remove("stgrab"); if (was) { stDragFlush(); stDrop(); } };
  doc.addEventListener("pointerup", end, true); doc.addEventListener("pointercancel", end, true);
  doc.addEventListener("selectstart", (e) => { if (h?.on) e.preventDefault(); }, true);
  doc.addEventListener("click", (e) => {
    if (ST.listOpen && !e.defaultPrevented) stDropToggle(false);
    if (!e.defaultPrevented && typeof stMoreClose === "function" && stMoreClose()) return;
    const n = current(); if (n && e.detail >= 2 && !e.target.closest(ST_DBL_SKIP)) stClickSize(n, e, cw.getSelection());
  }, true);   // dismiss the overlay and keep double-click sizing in the existing frame listener
  const st = doc.createElement("style"); st.textContent = "html.stgrab, html.stgrab * { cursor: grabbing !important; user-select: none !important; }"; doc.head.appendChild(st);
}
// Delay single-click navigation only on the current page to keep double-click selection and resizing stable.
function stPageClickBind(surface, nodeAt, selection) {
  let down = null, moved = false, previous;
  const cancel = () => { clearTimeout(ST.pageClickTimer); ST.pageClickTimer = null; };
  surface.addEventListener("pointerdown", e => {
    previous = ST.focus;
    cancel(); down = {x:e.screenX, y:e.screenY}; moved = e.button !== 0;
  }, true);
  surface.addEventListener("pointermove", e => {
    if (down && Math.hypot(e.screenX - down.x, e.screenY - down.y) > 5) moved = true;
  }, true);
  surface.addEventListener("pointercancel", () => { moved = true; down = null; cancel(); }, true);
  surface.addEventListener("wheel", cancel, {passive:true, capture:true});
  surface.addEventListener("keydown", cancel, true);
  surface.addEventListener("click", e => {
    const from = down ? previous : ST.focus;
    cancel(); down = null;
    if (e.detail !== 1 || moved || ST.drag || ST.pan || e.target.closest("[data-pdgo], input, textarea, select, button, a, video, [contenteditable], #ccomp, .cm-editor, .monaco-editor, .fp-img, [data-rz], [data-stunfold], [data-doc]")) return;
    const n = nodeAt(e); if (!n || selection()?.toString()) return;
    const reveal = () => {
      ST.pageClickTimer = null;
      if (!ST.drag && !ST.pan && !selection()?.toString() && ST.nodes.some(x => x.id === n.id)) {
        stShiftStop();
        if (stEdgeWheel.motion) { cancelAnimationFrame(stEdgeWheel.motion.frame); stEdgeWheel.motion = null; }
        stShow(n.id, true);   // reveal only the clipped edge; a fully visible page stays put
      }
    };
    if (from !== n.id) {
      stFocus(n.id);
      reveal();
      $('#starena')?.focus({preventScroll:true});
    }
    else ST.pageClickTimer = setTimeout(reveal, 300);
  }, true);
}
function stDragSoon(sx, sy) {                      // one move per frame, however fast the pointer reports
  ST.nx = [sx, sy]; if (!ST.raf) ST.raf = requestAnimationFrame(() => { ST.raf = 0; if (ST.nx) stDragTo(...ST.nx); });
}
function stDragFlush() { if (ST.raf) { cancelAnimationFrame(ST.raf); ST.raf = 0; if (ST.nx) stDragTo(...ST.nx); } ST.nx = null; }


/* ------------------------------------------------ The settings button opens this overlay on demand.
   It keeps the history index and tools close at hand without taking width from the horizontal stage. */
function stSideList() {
  const v = $("#vStage"), lp = stPanel(), open = !!ST.listOpen, w = Math.max(280, Math.min(520, lp.w || 360));
  let box = $("#stlist");
  if (!box) {
    v.insertAdjacentHTML("beforeend", `<aside class="stlist side" id="stlist"><i class="lrz lrz-e" data-lrz="e" title="${L("拖动改宽度", "Drag to resize")}"></i>
      <div class="stlh"><b>${L("历史与设置", "History and settings")}</b><em class="cvdim" id="stln"></em><span class="grow"></span>
      <button class="stb" id="stlstruct" title="${L("整理上层结构：合并 / 改名文件夹", "Tidy the folders: merge or rename them")}">🗂</button><button class="stb" id="stlmk" data-rk="only" title="${L("只看标注和置顶的", "Only the marked and pinned")}">★</button><button class="stb" data-stlistmin title="${L("关闭设置面板", "Close settings panel")}">‹</button></div><input id="stlq" placeholder="${L("搜对话…", "Search…")}"><div class="stli" id="stli"></div>
      <div class="stmy" id="stmy"><i class="stmysep" data-mysep title="${L("拖动改高度 · 双击还原", "Drag to resize · double-click to reset")}"></i><button type="button" class="stmyh" id="stmytoggle" aria-controls="stmyl" aria-expanded="false"><span class="stfoldarrow">▸</span><b>${L("我的输入", "What I typed")}</b><em class="cvdim" id="stmyn"></em></button><div class="stmyl" id="stmyl" hidden></div></div><details class="sttools" id="sttools"><summary title="${L("工具与设置", "Tools and settings")}" aria-label="${L("工具与设置", "Tools and settings")}"><span aria-hidden="true">⚙</span></summary><div id="sttoolsbody"><fieldset class="sttidyrules"><legend>${L("全局对话整理规则","Global conversation tidy rules")}</legend>
        <label>${L("每个分类保持展开的对话数","Conversations to keep open per category")} <input data-rule="keep" type="number" required min="1" max="${ST_KEEP}" value="${stTidyRules().keep}"></label>
        <label>${L("其余对话最小化保留天数（超期关闭）","Days to keep other chats minimized before closing")} <input data-rule="days" type="number" required min="0" value="${stTidyRules().days}"></label></fieldset></div></details></aside>`);
    box = $("#stlist"); box.style.width = w + "px";
    box.querySelector('.sttidyrules').addEventListener('change', e => {
      const input = e.target, rules = stTidyRules(), key = input.dataset.rule;
      if (!key) return;
      if (!input.reportValidity() || !Number.isSafeInteger(input.valueAsNumber)) { input.value = rules[key]; return; }
      rules[key] = input.valueAsNumber;
      try { localStorage.setItem('pga_tidy_rules', JSON.stringify(rules)); }
      catch { input.value = stTidyRules()[key]; toast(L('设置保存失败','Could not save settings')); }
    });
    const close = box.querySelector("[data-stlistmin]");
    close.textContent = "×"; close.title = L("关闭设置面板", "Close settings panel"); close.setAttribute("aria-label", close.title);
    $("#stmytoggle").addEventListener("click", () => {
      stPanel().myOpen = !stPanel().myOpen; stPanelSave(); stMyHeight();
      if (stPanel().myOpen) { stInputs(); stInputsDraw(); }
    });
    const settings = $("#sttools"); settings.open = stPanel().toolsOpen ?? true;
    settings.addEventListener("toggle", () => { stPanel().toolsOpen = settings.open; stPanelSave(); });
    document.addEventListener("click", (e) => {
      if (!ST.listOpen || S.view !== "stage" || e.defaultPrevented || e.target.closest?.("#stlist, #stlbar")) return;
      stDropToggle(false);
    });
    $("#stlq").addEventListener("input", (e) => { ST.q = e.target.value.toLowerCase(); stListItems(); stInputsDraw(); });
    box.querySelector("[data-lrz]").addEventListener("pointerdown", (e) => {     // resize the overlay without changing the canvas
      if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); e.target.setPointerCapture(e.pointerId);
      ST.lmove = { x: e.clientX, w0: box.offsetWidth }; v.classList.add("dragging", "resizing");
    });
    const sep = box.querySelector("[data-mysep]");                              // the line above 我的输入: up or down, the list above following
    sep.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); sep.setPointerCapture(e.pointerId);
      ST.mymove = { y: e.clientY, h0: $("#stmy").offsetHeight }; sep.classList.add("on");
    });
    sep.addEventListener("dblclick", () => { delete stPanel().myh; stPanelSave(); stMyHeight(); });
    box.addEventListener("pointermove", (e) => {
      const y = ST.mymove; if (y) { stPanel().myh = Math.round(Math.max(60, Math.min(box.clientHeight - 160, y.h0 - (e.clientY - y.y)))); stMyHeight(); return; }
      const m = ST.lmove; if (!m) return; stPanel().w = Math.max(280, Math.min(520, m.w0 + e.clientX - m.x)); box.style.width = stPanel().w + "px";
    });
    const end = () => {
      if (ST.mymove) { ST.mymove = null; sep.classList.remove("on"); stPanelSave(); }
      if (!ST.lmove) return; ST.lmove = null; v.classList.remove("dragging", "resizing"); stPanelSave();
    };
    box.addEventListener("pointerup", end); box.addEventListener("pointercancel", end);
  }
  stPanelTools(); stMyHeight(); box.style.width = w + "px"; box.hidden = !open; v.classList.remove("chats-open"); v.style.setProperty("--chats-w", "0px");
  const bar = $("#stlbar"); if (bar) { bar.hidden = false; bar.textContent = "⚙"; bar.setAttribute("aria-expanded", String(open)); bar.setAttribute("aria-controls", "stlist"); bar.title = L("设置与历史", "Settings and history"); bar.setAttribute("aria-label", bar.title); }
  if (!open) return;
  const sig = String(recentItems().length) + (recentItems()[0]?.item || "") + (recentItems()[0]?.title || "") + stWins().map((w) => w.key).join();
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
function stTidyRules() {
  const defaults = {keep: 2, days: 3};
  try {
    const saved = JSON.parse(localStorage.getItem('pga_tidy_rules'));
    if (Number.isSafeInteger(saved?.keep) && saved.keep >= 1 && saved.keep <= ST_KEEP
      && Number.isSafeInteger(saved.days) && saved.days >= 0) return saved;
  } catch {}
  return defaults;
}
function stTidyCategory(category) {
  const {keep, days} = stTidyRules(), cutoff = Date.now() - days * 86400000;
  const recent = new Map(recentItems().map(x => [x.item, x]));
  const categoryWins = stWins().filter(w => stGroupOf(w)?.id === category);
  const wins = categoryWins.filter(w => w.key && !w.managerProject && !w.key.startsWith('chat:pm-')
    && !w.file && !w.pad && !w.memo && !w.knowledge);
  const times = new Map(wins.map(w => [w, stMapTime(w, recent)]));
  if (wins.length && wins.every(w => times.get(w) > 0 && times.get(w) < cutoff)) {
    const visible = categoryWins.filter(w => !w.mini);
    const open = visible.filter(w => !w.small);
    ST.foldCatIds ||= {};
    const restore = new Set(ST.foldCatIds[category] || []);
    for (const w of open) {
      restore.add(w.id);
      stKidKeep(w, true);
      w.small = true;
    }
    ST.foldCatIds[category] = restore.size ? [...restore] : visible.map(w => w.id);
    ST.catOpen?.delete(category);
    ST.mapExpanded?.delete(category);
    stRender(); stSave(); stListItems(); window.pgLocalSave?.();
    toast(L('该分类的对话均已超过保留期限，已全部折叠','All conversations are past the retention period. Category folded.'));
    return;
  }
  const ranks = wins.map(w => w.ord).sort((a,b) => a-b);
  wins.sort((a,b) => times.get(b) - times.get(a));
  const width = Math.max(1, Math.floor((stArena().w - 2 * ST_PADX - 8) / 2));
  let closed = 0, folded = 0;
  for (const [i,w] of wins.entries()) {
    const small = i >= keep, time = times.get(w);
    if (small && time > 0 && time < cutoff && stRememberPage(w)) {
      stClose(w, {deferRender:true}); closed++; continue;
    }
    if (small !== !!w.small) stKidKeep(w, small);
    if (small) folded++;
    Object.assign(w, {ord:ranks[i], bw:width, kw:width, tidyCompact:true, tidyLinear:true, mini:false, small});
    for (const k of ['big','fullscreen','bigWidth','pre','branchGap','fx','fy','branchDocked','kidsCollapsed']) delete w[k];
  }
  if (ST.foldCatIds) delete ST.foldCatIds[category];
  if (ST.foldAllIds) {
    const ids = new Set(wins.map(w => w.id));
    ST.foldAllIds = ST.foldAllIds.filter(id => !ids.has(id));
  }
  stRender(); stSave(); if (closed) stContexts();
  stListItems(); window.pgLocalSave?.();
  toast(L(`已展开 ${Math.min(keep,wins.length)} 个对话，最小化 ${folded} 个，关闭 ${closed} 个`,
    `Opened ${Math.min(keep,wins.length)}, minimized ${folded}, closed ${closed}`));
}
document.addEventListener('click', e => {
  const b=e.target.closest('[data-sttidycat]'); if(!b)return;
  e.preventDefault();e.stopImmediatePropagation();stTidyCategory(b.dataset.sttidycat);
},true);
window.stTidyCategory=stTidyCategory;
function stDropToggle(open, restoreFocus = false) { // update the settings overlay without laying out the stage again
  const lp = stPanel(); ST.listOpen = lp.open = open ?? !ST.listOpen; stPanelSave();
  clearTimeout(ST.listFocusTimer); ST.listFocusTimer = null;
  const focusEpoch = ST.listFocusEpoch = (ST.listFocusEpoch || 0) + 1;
  stSideList();
  document.querySelectorAll('[data-stw="global"]').forEach(b => b.setAttribute('aria-expanded', String(!!ST.listOpen)));
  const button = $("#stlbar"); if (button) button.setAttribute("aria-expanded", String(!!ST.listOpen));
  if (ST.listOpen) {
    ST.listFocusTimer = setTimeout(() => { if (ST.listFocusEpoch !== focusEpoch) return; ST.listFocusTimer = null; if (ST.listOpen) $("#stlq")?.focus(); }, 30);
  } else if (restoreFocus) button?.focus();
}
function stMyHeight() {
  const box = $("#stlist"), lp = stPanel(); if (!box) return;
  const open = !!lp.myOpen;
  box.classList.toggle("myclosed", !open);
  box.classList.toggle("myset", open && !!lp.myh);
  if (lp.myh) box.style.setProperty("--myh", lp.myh + "px");
  const list = $("#stmyl"), toggle = $("#stmytoggle");
  if (list) list.hidden = !open;
  if (toggle) { toggle.setAttribute("aria-expanded", String(open)); toggle.querySelector(".stfoldarrow").textContent = open ? "▾" : "▸"; }
}
function stPanelTools() {
  const body = $("#sttoolsbody"); if (!body) return;
  const foot = document.querySelector(".rail > .foot");
  // Move the original controls, retaining IDs, listeners and settings state.
  if (foot && S.view === "stage") body.appendChild(foot);
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
/* 我的输入: the bottom third of 所有对话 (the line above it drags) — what you typed lately, in any conversation, newest
   first, up to four lines each with your paragraphs kept (your words only).
   Click one: its conversation opens, at that question. Fetched again a minute later at most, and after an import. */
async function stInputs(force) {
  if (!$("#stmyl") || (!force && ST.inAt && Date.now() - ST.inAt < 60000)) return;
  ST.inAt = Date.now();
  try { ST.inputs = (await api(`/v1/users/${S.uid}/inputs?limit=80`)).inputs || []; } catch { ST.inAt = 0; return; }
  stInputsDraw();
}
const stInputText = (t) => {                       // your paragraphs kept, blank lines and long runs of spaces folded, the rest cut (four lines show)
  t = String(t || "").trim().replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n");
  return t.length > 280 ? t.slice(0, 280) + "…" : t;
};
function stInputsDraw() {
  const box = $("#stmyl"); if (!box || !ST.inputs) return; const q = ST.q || "";
  const xs = ST.inputs.filter((x) => !q || x.text.toLowerCase().includes(q) || (x.title || "").toLowerCase().includes(q));
  box.innerHTML = (ST.inputsExpanded ? xs : xs.slice(0, 3)).map((x) => `<div class="stmyr" data-inkey="${esc(x.key)}" data-inrun="${esc(x.run || "")}" title="${esc(x.text + "\n— " + (x.title || ""))}"><b>${esc(stInputText(x.text))}</b><span>${x.at ? ago(x.at) : ""}</span></div>`).join("")
    || `<div class="cvdim" style="padding:6px 8px">${q ? L("没有找到", "Nothing found") : L("最近还没有输入", "Nothing typed lately")}</div>`;
  if (xs.length > 3) box.insertAdjacentHTML("beforeend", `<button class="txt" data-stinputs-more>${ST.inputsExpanded ? L("收起", "Show less") : L(`显示更多（${xs.length - 3}）`, `Show more (${xs.length - 3})`)}</button>`);
  const n = $("#stmyn"); if (n) n.textContent = String(xs.length);
}
document.addEventListener("click", (e) => {
  const r = S.view === "stage" && e.target.closest?.("#stmy [data-inkey]"); if (!r) return;
  e.preventDefault(); e.stopPropagation(); pjOpenOn(window, r.dataset.inkey, r.dataset.inrun, r.dataset.inrun ? "" : r.title);
}, true);
document.addEventListener("click", e => {
  const more = e.target.closest("[data-stproject-more]");
  if (more) { e.preventDefault(); ST.projectLimits ||= {}; const name = more.dataset.stprojectMore; ST.projectLimits[name] = ST.projectLimits[name] > 3 ? 3 : Infinity; stListItems(); }
  if (e.target.closest("[data-stinputs-more]")) { e.preventDefault(); ST.inputsExpanded = !ST.inputsExpanded; stInputsDraw(); }
});
function stListItems() {                           // every past conversation, newest first, one tight row each
  const box = $("#stli"); if (!box) return;
  if (!W.nodes.length && !ST.wtAsked) { ST.wtAsked = true; wtFetch().then(() => W.nodes.length && stListItems()); }
  const M = stMarks(), q = ST.q || "", fd = ST.folder && W.byId?.get(ST.folder);
  const xs = recentItems().filter((x) => (!q || (x.title || "").toLowerCase().includes(q) || (M[x.item]?.mark || "").toLowerCase().includes(q))
    && (!ST.onlyMarked || M[x.item]) && (!fd || stFolderOf(x.item).some((f) => f.id === fd.id)));
  const pinned = xs.filter((x) => M[x.item]?.pin).sort((a, b) => M[b.item].pin - M[a.item].pin), rest = xs.filter((x) => !M[x.item]?.pin);
  const SS = stStat(), have = new Map(xs.map((x) => [x.item, x]));
  const opened = [...new Set(stWins().filter((w) => w.key && !w.pad).map((w) => w.key))]     // the pages open on the stage, latest first
    .map((k) => {
      const item = have.get(k) || (!q && !ST.onlyMarked && !fd ? { item:k, title:stTitle(k) } : null);
      if (!item) return null;
      const time = Math.max(Date.parse(item.last || '') || 0, ...stWins().filter(w=>w.key===k).map(w=>Math.max(w.runAt || 0,w.completedAt || 0)));
      return {...item, last:time ? new Date(time).toISOString() : item.last};
    }).filter(Boolean).sort((a, b) => String(b.last || "").localeCompare(String(a.last || "")));
  const row = (x, open) => { const m = M[x.item] || {}, s = SS.get(x.item);
    const st = s?.run ? `<i class="rst run" title="${L("正在处理…", "Working…")}"></i>${s.at ? `<i class="rtime" data-runat="${s.at}">${stDur(Date.now() - s.at)}</i>` : ""}` : s?.num ? `<i class="rst num" title="${L("做完了，还没看", "Done, not seen yet")}">${s.num}</i>` : "";
    return `<div class="ritem ${m.pin ? "pinned" : ""} ${m.mark ? "marked" : ""}" data-ritem="${esc(x.item)}" title="${esc((x.title || "") + " · " + (x.agent ? agentLabel(x.agent) : "PGA") + (x.last ? " · " + ago(x.last) : ""))}">
      <div class="rline">${st}<b>${esc(x.title || L("新对话", "New chat"))}</b>${m.mark ? `<i class="rmark">${esc(m.mark)}</i>` : ""}${open && x.last ? `<i class="rago">${esc(ago(x.last))}</i>` : ""}
        <span class="racts"><button data-rk="project" title="${L('归入分类', 'Move to category')}">📂</button><button data-rk="pin" title="${m.pin ? L("取消置顶", "Unpin") : L("置顶", "Pin to the top")}">${m.pin ? "⊗" : "📌"}</button><button data-rk="mark" title="${m.mark ? L("改标注（清空就去掉）", "Change the mark (empty removes it)") : L("标注", "Mark it")}">★</button></span></div></div>`; };
  let html = "";
  if (pinned.length) html += `<div class="rgrp">📌 ${L("置顶", "Pinned")}</div>` + pinned.map((x) => row(x)).join("");
  for (const g of pjGroups(rest.slice(0, 400))) {   // every conversation under its project (the folder it ran in), the latest project first
    const shut = !q && pjShut(g.name);
    const order = new Map(stWins().filter(w => w.key && !w.mini && ST.pos?.has(w.id)).map((w,i) => [w.key,i]));
    const items = g.items.slice().sort((a,b) => (order.get(a.item) ?? Infinity) - (order.get(b.item) ?? Infinity));
    const limit = q ? Infinity : (ST.projectLimits?.[g.name] || 3);
    html += pjHead(g, shut) + (shut ? "" : items.slice(0, limit).map(x => row(x)).join("")
      + (items.length > 3 ? `<button class="txt" data-stproject-more="${esc(g.name)}">${limit >= items.length ? L("收起至 3 条", "Show 3") : L(`显示更多（${items.length - limit}）`, `Show more (${items.length - limit})`)}</button>` : ""));
  }
  if (opened.length) html += `<div class="rgrp">▢ ${L("打开的 · 按时间", "Open · by time")}</div>` + opened.map((x) => row(x, true)).join("");
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
function stOver(updateMarks = true) {                              // the wires from the history column to the windows, drawn over the whole app
  let svg = $("#stover");
  if (!svg) { document.body.insertAdjacentHTML("beforeend", `<svg id="stover" class="stover"></svg>`); svg = $("#stover"); }
  if (S.view !== "stage" || $("#vStage")?.classList.contains("hasmax")) { svg.innerHTML = ""; return; }
  if (updateMarks) stRailMarks();
  if (!ST.rw && !ST.nodes.some(n => n.rail)) { if (svg.innerHTML) svg.innerHTML = ""; return; }
  const list = $("#stli")?.getBoundingClientRect(), ar = $("#starena")?.getBoundingClientRect(); if (!list || !ar || $("#stlist")?.hidden) { svg.innerHTML = ""; return; }
  let h = "";
  const from = (key) => { const r = stRailRow(key)?.getBoundingClientRect(); if (!r) return null;
    const y = Math.max(list.top + 4, Math.min(list.bottom - 4, r.top + r.height / 2)); return { x: r.right - 9, y, out: y !== r.top + r.height / 2 }; };
  const visible = (w) => ar.left + w.x - stSL() + 4 >= ar.left;     // a page scrolled away to the left: no wire across the stage to it
  for (const n of ST.nodes) {
    if (!n.rail) continue; const a = from(n.key), w = ST.pos?.get(n.win); if (!a || !w || !visible(w)) continue;
    const x1 = ar.left + w.x - stSL(), y1 = ar.top + stPinY(w, 0), d = stCurve(a.x, a.y, x1, y1);
    h += `<path class="stwire z0 ${a.out ? "faint" : ""}" d="${d}"/><path class="sthit" d="${d}" data-unrail="${n.id}"><title>${esc(stNodeTitle(n))} · ${L("点一下断开", "click to cut")}</title></path>`;
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
    if (op === "project") { pjAssignDialog(key, rk); }
    else if (op === "pin") stMarkSet(key, (o) => { o.pin = o.pin ? 0 : Date.now(); });
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
// A gesture shares one quiet-period timer. Only the minimap follows every paint;
// frame lifecycle work and embedded conversation painting wait for the gesture to finish.
function stFrameMotion(moving) {
  if (ST.frameMoving === moving) return;
  ST.frameMoving = moving;
  S.stageMotion = moving;
  $("#vStage")?.classList?.toggle('scrolling', moving);
  if (moving && typeof stMapHideTip === 'function') stMapHideTip();
  for (const n of ST.nodes.filter(n => n.type === 'win')) {
    try { const w = n.el?.querySelector('iframe')?.contentWindow, state = w?.S;
      if (state) {
        state.stageMotion = moving; if (n.managerParked || n.el?.hidden) state.stageDormant = true;
        if (!moving && !state.stageDormant) w.pgaStageActivated?.();
      }
    } catch {}
  }
}
function stWhenIdle() {
  return new Promise(resolve => {
    const check = () => {
      if (S.view !== 'stage' || (!ST.frameMoving && !ST.navigation && !ST.drag && !ST.pan
        && !(typeof stShiftMotion !== 'undefined' && stShiftMotion) && performance.now() - (ST.movedAt || -Infinity) >= 140)) resolve();
      else setTimeout(check, 80);
    };
    check();
  });
}
window.stWhenIdle = stWhenIdle;
function stScrollSettled() {
  clearTimeout(ST.scrollEndTimer);
  if (ST.navigation || ST.drag || ST.pan || (typeof stShiftMotion !== 'undefined' && stShiftMotion)) {
    ST.scrollEndTimer = setTimeout(stScrollSettled, 100); return;
  }
  stFrameMotion(false);
  stScheduleFrameLoads(0);
  stOver(false);
}
let stScrollFrame = 0;
function stScheduleScroll(e) {
  if (e?.target && e.target.id !== "starena") return;
  if (S.view !== 'stage') return;
  // This scroll belongs to a completed manager jump, not a user gesture.
  const managerJump = ST.managerScrollLeft;
  delete ST.managerScrollLeft;
  if (managerJump != null && Math.abs(($("#starena")?.scrollLeft || 0) - managerJump) < 1) {
    stScheduleFrameLoads(0);
    if (!stScrollFrame) stScrollFrame = requestAnimationFrame(() => { stScrollFrame = 0; stMapView(); });
    return;
  }
  ST.movedAt = Math.max(ST.movedAt || 0, performance.now());
  stFrameMotion(true);
  clearTimeout(stFrame.timer);
  clearTimeout(ST.scrollEndTimer); ST.scrollEndTimer = setTimeout(stScrollSettled, 180);
  if (stScrollFrame) return;
  stScrollFrame = requestAnimationFrame(() => { stScrollFrame = 0; if (typeof stPmScrolled === "function") stPmScrolled(); stMapView(); });
}
document.addEventListener("scroll", stScheduleScroll, {capture: true, passive: true});
window.addEventListener("resize", () => { if (S.view === "stage") requestAnimationFrame(stOver); });

/* the side panel inside a window: the conversation page's own right panel (environment, context, world tree) */
function stSide(n) {
  const f = document.querySelector(`.stnode[data-nid="${n.id}"] iframe`);
  try {
    const root = f.contentDocument.documentElement, side = n.side !== false;
    if (root.classList.contains("eside") === side) return;
    root.classList.toggle("eside", side);
    if (f.contentWindow.S?.booted) f.contentWindow.renderChat?.();
  } catch {}
}

/* ------------------------------------------------ moving: a card to another window or the shelf; a window along the row */
function stFreezeWidths() {
  for (const u of ST.units || []) {
    if (!u.open || u.hide) continue;
    if (u.kind === "win" && !u.win.small) u.win.bw = u.pdfBaseWidth ?? u.w;
    if (u.kind === "stack" && !u.wins.every(n => n.small)) u.par.kw = u.pdfBaseWidth ?? u.w;
  }
}
function stMiddleGrab(node, sx, sy, gx) {
  if (ST.overview) { stDockCancel(); return true; }
  const n = typeof node === "string" ? ST.nodes.find(x => x.id === node) : node;
  // Enlarged/full-width pages still live on the canvas and can be reordered.
  if (!n || n.type !== "win" || n.screenPin) return false;
  // Keep the branch stack and all neighbours intact until release.
  ST.focus = n.id;
  document.querySelectorAll(".stnode.t-win").forEach(el => el.classList.toggle("focus", el.dataset.nid === n.id));
  try {
    stGrab(n, sx, sy, gx);
    if (ST.drag) { ST.drag.middle = true; if (typeof stDockStart === "function") stDockStart(ST.drag); }
  } catch (err) {                                   // a page that cannot be picked up leaves nothing held: the press moves the stage instead
    console.error(err);
    const d = ST.drag; ST.drag = null;
    d?.el?.classList.remove("held", "st-dock-held"); d?.dock?.layer?.remove(); d?.dock?.hidden?.forEach((el) => el.classList.remove("st-dock-muted"));
    if (d?.dock && d.dock.styles != null) d.el.setAttribute("style", d.dock.styles);
    $("#vStage")?.classList.remove("dragging");
    return false;
  }
  return !!ST.drag;
}
function stMiddleFrameGrab(frame, sx, sy, gx) {
  const id = frame?.closest('.stnode')?.dataset.nid;
  return id ? stMiddleGrab(id, sx, sy, gx) : false;
};
function stGrab(n, sx, sy, gx = 40) {
  if (n.screenPin) return;               // gx: where on the page you hold it
  const e = document.querySelector(`.stnode[data-nid="${n.id}"]`); if (!e) return;
  if (typeof stReorderStop === 'function') stReorderStop();
  ST.drag = { n, el: e, sx, sy, gx, s0: stSL(), l0: parseFloat(e.style.left), t0: parseFloat(e.style.top), moved: false };
  e.classList.add("held"); $("#vStage").classList.add("dragging");
  if (n.type === "win" && !n.mini) { stFreezeWidths(); // what is in the row besides it: still, until the page you drag touches it
    const g = ST.drag.groups = stGroups(n), mid = ST.drag.l0 + e.offsetWidth / 2;
    for (const x of g) x.side = x.x + x.w / 2 > mid ? 1 : -1;
    const c = (ST.units || []).find((u) => u.kind === "col" && u.win === n && !u.hide && u.open);
    ST.drag.slot = { x: ST.drag.l0 - (c ? ST_CW + ST_GAP : 0), e: ST.drag.l0 + e.offsetWidth };
  }
}
function stEdgeHold(id, side) {
  const us = (ST.units || []).filter(u => !u.hide && u.x != null && u.open);
  const i = us.findIndex(u => (u.kind === "win" && u.win.id === id) || (u.kind === "stack" && u.wins.some(w => w.id === id)));
  if (i < 0) return null;
  const unit = us[i];
  // Freeze the actual widths before resizing, so automatic fitting cannot move neighbours.
  for (const u of us) {
    if (u.kind === "win" && !u.win.small) u.win.bw = u.w;
    if (u.kind === "stack" && !u.wins.every(n => n.small)) u.par.kw = u.w;
  }
  const gap = u => {
    if (u?.kind === "stack") return {owner:u.par, field:"branchGap", value:u.par.branchGap ?? ST_FORKGAP};
    if (u?.kind === "col" || (u?.kind === "win" && !us.some(c => c.kind === "col" && c.win === u.win)))
      return {owner:u.win, field:"pre", value:u.win.pre || 0};
    return null;
  };
  return {owner:unit.kind === "stack" ? unit.par : unit.win, field:unit.kind === "stack" ? "kw" : "bw",
    pages:unit.kind === "stack" ? unit.wins : [unit.win],
    width:unit.w, before:gap(unit), after:gap(us[i + 1]), leading:gap(us[0]),
    scroll: typeof stSL === "function" ? stSL() : 0};
}
function stResizeIntoGap(r, dx, maxWidth) {
  const hold = r.across; if (!hold) return false;
  const west = r.d.includes("w");
  let width = Math.round(Math.max(Math.min(320, hold.width), Math.min(Math.max(maxWidth, hold.width), hold.width + (west ? -dx : dx))));

  const delta = width - hold.width, gap = west ? hold.before : hold.after;
  // An enlarged page's layout override otherwise ignores the manual width.
  // Start from its painted width; only an actual resize leaves enlarged mode.
  if (delta) for (const n of hold.pages || []) { delete n.big; delete n.fullscreen; delete n.bigWidth; }
  hold.owner[hold.field] = width;
  if (west && hold.leading) {
    // Translate the preceding row, preserving every gutter and the opposite edge.
    const offset = hold.leading.value + (r.off0 || 0) - delta;
    hold.leading.owner[hold.leading.field] = Math.max(0, offset);
    r.scrollTarget = hold.scroll + Math.max(0, -offset);
    ST.shift = 0;
  } else {
    if (gap) gap.owner[gap.field] = Math.max(0, gap.value - delta);
    ST.shift = r.off0;
  }
  return true;
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
    else if (u.kind === "lines") gs.push({ key: "lines", x: u.x, w: u.w, wins: u.wins.map((w) => w.id),
      els: [...document.querySelectorAll("#stbars > .stfoldline")].filter((t) => { const l = parseFloat(t.style.left); return l >= u.x - 1 && l <= u.x + u.w; }) });
    else if (u.kind === "cat") gs.push({ key: "cat", x: u.x, w: u.w, wins: u.wins.map((w) => w.id),   // a folded category: its upright name moves, its pages keep together
      els: [...document.querySelectorAll("#stbars > .stcatfold")].filter((t) => Math.abs(parseFloat(t.style.left) - u.x) < 1) });
    else gs.push({ key: u.kind, par: u.par, x: u.x, w: u.w, els: els((u.nodes || []).map((x) => x.id)) });
  }
  for (const g of runs.values()) { g.els = [...document.querySelectorAll("#stbars > .sttab")].filter((t) => Math.abs(parseFloat(t.style.left) - g.x) < 1);
    g.els.push(...[...document.querySelectorAll("#stnodes > .stnode.tab")].filter((t) => !t.hidden && Math.abs(parseFloat(t.style.left) - g.x) < 1)); gs.push(g); }
  for (const g of gs) { g.off = g.off || 0; g.cx = g.x; g.cw = g.w; g.o = g.els.map((el) => ({ el, l: parseFloat(el.style.left) })); }
  return gs;
}
/* Dragging translates rigid pages. Overlaps push neighbours aside; crossing
   their original midpoint reorders them, without ever changing any width. */
function stPush(d, l, w) {
  const G = ST_GAP, mid = l + w / 2, gs = d.groups || [];
  for (const g of gs) {
    g.side = mid > g.x + g.w / 2 ? -1 : 1;
    g.cx = g.x; g.cw = g.w;
  }
  let edge = l - (d.l0 - d.slot.x) - G;
  for (const g of gs.filter(g => g.side < 0).sort((a,b) => b.x - a.x)) {
    g.cx = Math.min(g.x, edge - g.w); edge = g.cx - G;
  }
  edge = l + w + G;
  for (const g of gs.filter(g => g.side > 0).sort((a,b) => a.x - b.x)) {
    g.cx = Math.max(g.x, edge); edge = g.cx + g.w + G;
  }
  for (const g of gs) {
    const dx = g.cx - g.x;
    if (g.page) { g.pel.style.left = g.cx + g.off + "px"; g.pel.style.width = g.cw - g.off + "px"; const p = ST.pos?.get(g.win.id); if (p) { p.x = g.cx + g.off; p.w = g.cw - g.off; } }
    for (const o of g.o) { o.el.style.transform = dx ? `translateX(${dx}px)` : ""; const id = o.el.dataset.nid || o.el.dataset.stunfold, p = id && ST.pos?.get(id); if (p) p.x = o.l + dx; }
  }
}
function stDragTo(sx, sy) {
  if (ST.drag?.dock) { stDockMove(ST.drag, sx, sy); return; }
  const d = ST.drag; if (!d) return;
  if (Math.hypot(sx - d.sx, sy - d.sy) > 4) d.moved = true; d.lx = sx; d.ly = sy;
  const A = stArena(), w = d.el.offsetWidth, sl = stSL();
  const big = d.n.type === "win" && !d.n.mini;                     // a page as wide as the stage still moves: up to 60% of it may hang
  const lo = big ? sl - w * 0.6 : sl, hi = big ? sl + A.w - w * 0.4 : Math.max(sl, sl + A.w - w);   // past an edge, the rest stays in view
  const raw = d.l0 + sx - d.sx + sl - d.s0, l = Math.max(lo, Math.min(hi, raw)); d.el.style.left = l + "px";
  const px = raw + d.gx - sl;                     // held at an edge of the stage: it scrolls that way, the page along with it
  d.v = big && !d.middle ? (px > A.w - 48 ? Math.min(24, (px - A.w + 48) / 2) : px < 48 && sl > 0 ? -Math.min(24, (48 - px) / 2) : 0) : 0;
  if (d.v && !d.auto) d.auto = requestAnimationFrame(function step() {
    const D = ST.drag; if (!D || !D.v) { if (D) D.auto = 0; return; }
    const a = $("#starena"), b = a.scrollLeft; a.scrollLeft = Math.max(0, b + D.v);
    if (a.scrollLeft === b && D.v > 0) stGrow(a.scrollLeft + a.clientWidth + 40);   // at the end of the row: there is more stage
    D.auto = requestAnimationFrame(step); stDragTo(D.lx, D.ly);
  });
  if (d.n.type !== "win" || d.n.mini) d.el.style.top = Math.max(0, Math.min(A.h - d.el.offsetHeight, d.t0 + sy - d.sy)) + "px";
  if (big) {
    if (!d.middle) stPush(d, l, w);
    const me = ST.pos?.get(d.n.id);                // its wired cards come along, keeping their place beside it
    if (me) { const dx = l - me.x; me.x = l;
      for (const n of ST.nodes) { if (n.win !== d.n.id || stDock(n) || n.rail) continue; const p = ST.pos.get(n.id), e = document.querySelector(`.stnode[data-nid="${n.id}"]`); if (!p || !e || e.hidden) continue; p.x += dx; e.style.left = p.x + "px"; } }
  }
  if (!big) { const p = ST.pos?.get(d.n.id); if (p) { p.x = l; p.y = parseFloat(d.el.style.top); } }
  stWires();
}
function stSettle(d) {                             // a page let go: everything stays as it is now — the order, each width, the gaps
  for (const g of d.groups || []) for (const o of g.o) o.el.style.transform = "";
  if (!d.moved) return;
  const A = stArena(), G = ST_GAP, l = parseFloat(d.el.style.left), w = d.el.offsetWidth;
  const mc = (ST.units || []).find((u) => u.kind === "col" && u.win === d.n && !u.hide && u.open), doff = mc ? ST_CW + G : 0;
  const bs = (d.groups || []).map((g) => ({ key: g.key, win: g.win, par: g.par, x: g.cx, w: g.w, off: g.off, page: g.page, side: g.side, wins: g.wins || [] }));
  // Keep every measured width. Resolve collisions by translation even when the
  // canvas must grow; dropping a page must not silently resize it or a neighbour.
  const x = Math.max(ST_PADX + (ST.edgeSpace || 0), l - doff);
  bs.push({ key: "win", win: d.n, x, w: w + doff, off: doff, page: true, side: 0, wins: [d.n.id] });
  bs.sort((a, b) => a.side - b.side || a.x - b.x);
  let c = ST_PADX + (ST.edgeSpace || 0); for (const b of bs) { b.x = Math.max(b.x, c); c = b.x + b.w + G; }   // only what still overlaps moves on to the right
  // the order of the pages, then their widths and gaps, written so the next layout puts them exactly here
  const seq = bs.flatMap((b) => b.wins), wins = stWins().filter((o) => !o.mini);
  wins.sort((p, q) => (seq.includes(p.id) ? seq.indexOf(p.id) : 1e4 + wins.indexOf(p)) - (seq.includes(q.id) ? seq.indexOf(q.id) : 1e4 + wins.indexOf(q))).forEach((o, k) => { o.ord = k; });
  for (const b of bs) {
    if (b.page) { b.win.bw = b.w - b.off; delete b.win.pre; }
    if (b.key === "stack" && b.par) { b.par.kw = b.w; b.par.branchGap = 0; }
  }
  ST.shift = 0;
  for (const b of bs) {
    const us = stLayout().units;
    if (b.key === "stack" && b.par) {
      const u = us.find(u => u.kind === "stack" && u.par === b.par);
      if (u) b.par.branchGap = Math.max(0, b.x - u.x);
    }
    if (!b.page) continue;
    const u = us.find((x) => x.kind === "col" && x.win === b.win && !x.hide && x.open) || us.find((x) => x.kind === "win" && x.win === b.win);
    if (u?.open && u.x != null && b.x - u.x >= 1) b.win.pre = Math.floor(b.x - u.x);
  }
}
function stDrop(sx) {
  if (ST.drag?.dock) return stDockRelease(ST.drag);
  const d = ST.drag; ST.drag = null; $("#vStage").classList.remove("dragging"); if (!d) return null; if (d.auto) cancelAnimationFrame(d.auto); d.el.classList.remove("held");
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
  if (d.middle && d.moved && !d.n.mini) {
    const left = parseFloat(d.el.style.left);
    if (d.n.par) {
      stDetachBranch(d.n);
      // Rebuild the normal drop geometry only after the held gesture is over.
      stGrab(d.n, d.sx, d.sy, d.gx);
      const detached = ST.drag; ST.drag = null;
      if (detached) { d.groups = detached.groups; d.slot = detached.slot; d.l0 = detached.l0; }
      d.el.style.left = left + "px";
      d.el.classList.remove("held"); $("#vStage").classList.remove("dragging");
    }
    stPush(d, left, d.el.offsetWidth);
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
function stBringBeside(key, sourceKey) {
  if (!key) return;
  const source = ST.nodes.find(n => n.type === "win" && n.key === sourceKey);
  const n = stOpen(key, source ? {win:source.id} : undefined);
  if (!n || !source || n === source) return n;
  // Move the existing node, retaining its iframe, draft, running task and descendants.
  if (n.par) {
    const parent = ST.nodes.find(w => w.id === n.par);
    n.from ||= parent?.key;
    if (parent?.sel === n.id) delete parent.sel;
    delete n.par; delete n.branchDocked; delete n.branchWeight;
  }
  if (source.managerProject) {
    source.managerBeside = n.id;
    (ST.stageOpen ||= new Set()).add(source.id);
  }
  const wins = stWins().filter(w => w !== n);
  wins.splice(wins.indexOf(source) + 1, 0, n);
  wins.forEach((w,i) => { w.ord = i; if (w.overviewOrder != null) w.overviewOrder = i; });
  delete n.small; n.mini = false;
  (ST.stageOpen ||= new Set()).add(n.id);
  stFocus(n.id, true);
  if (source.screenPin && source.managerProject) {
    const arena = $("#starena"), pos = ST.pos.get(n.id);
    if (arena && pos) {
      const [inset] = stPinViewport(n, arena);
      const left = pos.x - inset - 6;
      if (left < 0) {
        ST.sortLead = (ST.sortLead || 0) - left;
        stRender();
      }
      arena.scrollTo({left:Math.max(0, left), behavior:"instant"});
    }
  }
  stSave(); stContexts();
  return n;
}
window.stBringBeside = stBringBeside;
function stInsertRight(wins, n, source) {
  // In category view a branch is drawn in its root's column group.
  const after = source?.par && !source.tidyLinear && ST.mapMode !== 'time' ? stRootOf(source) : source;
  wins.splice(after ? wins.indexOf(after) + 1 : wins.length, 0, n);
  wins.forEach((w, i) => { w.ord = i; if (w.overviewOrder != null) w.overviewOrder = i; });
  if (source && ST.mapMode === 'time' && !n.managerProject && !n.key?.startsWith('chat:pm-')) {
    const recent = new Map(recentItems().map(x => [x.item, x]));
    n.initialPlacement = {time: stPlacementTime(source, recent), last: recent.get(n.key)?.last};
  }
}
function stOpen(key, at) {
  let n = key && ST.nodes.find((x) => x.type === "win" && x.key === key);
  const fresh = !n;
  const sourceId = at?.win || (!key || at?.project ? stAnchor()?.id || ST.focus : null);
  const by = ST.nodes.find(w => w.type === "win" && w.id === sourceId);
  const beside = !!by && !!at?.managerProject && at.managerBeside === by.id;
  const sourcePos = beside && ST.pos?.get(by.id), sourceArena = beside && $("#starena");
  const anchor = sourcePos && sourceArena ? {id:by.id, dx:sourcePos.x - sourceArena.scrollLeft} : null;
  if (beside) {
    stNavigationStop(); stShiftStop();
    if (stEdgeWheel.motion) { cancelAnimationFrame(stEdgeWheel.motion.frame); stEdgeWheel.motion = null; }
    sourceArena?.scrollTo({left:sourceArena.scrollLeft, behavior:'instant'});
    const p = n && ST.pos?.get(n.id);
    // A second click on the same ready position is a focus action, not another
    // insertion, animation or iframe navigation.
    if (n && n.managerBeside === by.id && !n.managerParked && !n.small && !n.mini && p && sourceArena
      && p.x >= sourceArena.scrollLeft && p.x + p.w <= sourceArena.scrollLeft + sourceArena.clientWidth) {
      stFocus(n.id); if (typeof stPmReady === "function") stPmReady(n); stScheduleFrameLoads(0); return n;
    }
  }
  const insert = (fresh || beside) && !!by;
  if (insert) {
    const layout = stLayout();
    stFreezeWidths();
    // Preserve the row's existing leading space when insertion consumes its free room.
    const first = layout.units.find(u => !u.hide && u.open);
    if (layout.off && first?.win) first.win.pre = (first.win.pre || 0) + layout.off;
    ST.shift = 0;
    const arena = $("#starena");
    if (arena) arena.scrollTo({left: arena.scrollLeft, behavior: "instant"});
    if (stShiftMotion) { cancelAnimationFrame(stShiftMotion.frame); stGlideEnd(); }
  }
  if (!n) {
    const card = key && ST.nodes.find((x) => x.type === "conv" && x.key === key);
    const wins = stWins();
    if (card) ST.nodes = ST.nodes.filter((c) => c !== card);
    n = { id: stId(), type: "win", key: key || null, side: false };
    stInsertRight(wins, n, by || wins.find(w => w.id === card?.win));
    ST.nodes.push(n);
    if (by && (!at?.project || stGroupOf(by)?.id === 'pj:' + at.project)) {
      n.from = by.key || by.from; n.creationGroup = stGroupOf(by); if (stWs(by)) n.ws = by.ws;
    }
    if (at?.branchFrom) n.branchFrom = at.branchFrom;   // a branch: by time it stands just after what it grew from
  }
  if (at?.taskTitle && !n.title) n.title = at.taskTitle;
  if (at?.managerProject && key?.startsWith("chat:pm-")) {
    n.managerProject = at.managerProject; stPmOffSet(at.managerProject, false); delete n.small;
    n.title = `${at.managerProject} · ${L("管理员", "Manager")}`;
  }
  if (at?.pinnedFrom) {
    const previous = at.pinnedFrom;
    n.screenPin = {...previous.screenPin};
    n.ord = previous.ord;
    n.bw = previous.bw;
    n.overviewOrder = previous.overviewOrder;
    delete n.managerBeside;
  }
  if (n.managerProject && typeof stPmActivate === "function") stPmActivate(n);
  if (beside) {
    n.managerBeside = by.id;
    delete n.small; delete n.par; delete n.screenPin; delete n.big; delete n.fullscreen; delete n.bigWidth;
    n.bw = Math.min(n.bw || 400, 440);
    const wins = stWins().filter(w => w !== n);
    wins.splice(wins.indexOf(by), 0, n);
    wins.forEach((w, i) => { w.ord = i; if (w.overviewOrder != null) w.overviewOrder = i; });
    (ST.stageOpen ||= new Set()).add(n.id);
    ST.stageOpen.add(by.id);
  }
  n.mini = false; n.lastUsedAt = n.openedAt = Date.now(); if (fresh && !at?.pinnedFrom) n.bw = beside ? Math.min(400, stHalfWidth()) : stHalfWidth();   // new conversations occupy half the stage; existing sizes stay as set
  if (beside && anchor) {
    // Make room on the left in one placement. Retain the source's screen
    // position when there is room; otherwise move it only by the missing room.
    anchor.dx = Math.max(anchor.dx, n.bw + 6 + ST_PADX);
  }
  const group = stGroupOf(n)?.id;
  if (fresh) { stRecallPage(n); if (group?.startsWith("pj:")) ST.pmTried?.delete(group.slice(3)); }
  if (group && ST.groupFold) delete ST.groupFold[group];
  if (ST.groupSolo && ST.groupSolo !== group) ST.groupSolo = null;
  if (at?.pending) n.title = L("从这里继续…", "Carrying on…");
  if (beside && anchor) {
    stGroupGather();
    const unit = stLayout().units.find(u => u.kind === 'win' && u.win === by || u.kind === 'stack' && u.wins.includes(by));
    // Moving a manager from before the source can exhaust the left scroll space.
    // Retain enough leading space for the requested on-screen placement.
    if (unit?.x < anchor.dx) ST.sortLead = (ST.sortLead || 0) + anchor.dx - unit.x;
    ST.sortAnchor = anchor;
  }
  if (insert) {
    ST.focus = n.id;
    // Insertion bypasses stFocus: keep the toolbar on the manager just opened,
    // rather than letting its next click reopen the previous category.
    if (beside && typeof stPmFollow === 'function') stPmFollow(n);
    const v = $("#vStage"), before = beside ? new Map() : stRects();
    if (beside) {
      before.delete(n.el); ST.managerPlacing = true;
      if (typeof stReorderStop === 'function') stReorderStop();
    }
    v?.classList.add("inserting");
    try { stRender(); } finally { ST.managerPlacing = false; }
    if (at?.pending) { n.el?.classList.add("stpending"); n.el?.querySelector(".stwin")?.setAttribute("data-pending", L("正在从这里分出新对话…", "Branching from here…")); const t = n.el?.querySelector(".stwt"); if (t) t.textContent = n.title; }
    if (beside && anchor) stKeepAnchor(anchor);
    if (!beside) stSlide(before);
    // Commit the manager's final geometry without a FLIP/entrance animation.
    // Flush once while transitions are disabled, before removing the class.
    if (beside && v) void v.offsetWidth;
    v?.classList.remove("inserting");
  } else if (n.managerProject) {
    // A category entry with no expanded source uses the same instant path.
    const v = $("#vStage");
    stNavigationStop(); stShiftStop();
    if (stEdgeWheel.motion) { cancelAnimationFrame(stEdgeWheel.motion.frame); stEdgeWheel.motion = null; }
    if (typeof stReorderStop === "function") stReorderStop();
    v?.classList.add("inserting"); ST.managerPlacing = true;
    try { stFocus(n.id, true); }
    finally { ST.managerPlacing = false; if (v) void v.offsetWidth; v?.classList.remove("inserting"); }
  } else stFocus(n.id, true);
  stSave(); stContexts(); if (!beside) stShow(n.id);
  if (n.managerProject) {
    n.el?._managerEntrance?.cancel();
    if (typeof stPmReady === "function") stPmReady(n);
    return n;
  }
  // Opacity and transform only: they run off the main thread, so the new page loading cannot make them stutter.
  const surface = document.querySelector(`.stnode[data-nid="${n.id}"]`);
  if (beside) surface?._managerEntrance?.cancel();
  const entrance = surface?.animate?.(insert ? [{ opacity: 0, transform: `translateX(-${beside ? 12 : 28}px)` }, { opacity: 1, transform: "none" }] : [{ opacity: 0 }, { opacity: 1 }], { duration: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : beside ? 180 : 260, easing: "cubic-bezier(.2,.8,.2,1)" });
  if (beside && surface) surface._managerEntrance = entrance;
  return n;
}
// Pages moved over by one put in among them slide to their new place (it was set at once, without the left transition).
const stRects = () => new Map([...document.querySelectorAll("#stnodes > .stnode:not([hidden])")].map((el) => [el, el.getBoundingClientRect().left]));
function stSlide(before, duration = 260) {
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  for (const [el, x] of before) {
    if (!el.isConnected || el.hidden) continue;
    const dx = x - el.getBoundingClientRect().left;   // reading it applies the new place at once
    el._insertAnimation?.cancel();
    if (!still && Math.abs(dx) > 1) el._insertAnimation = el.animate?.([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration, easing: "cubic-bezier(.2,.8,.2,1)" });
  }
}
function stOpenAt(key, x) {                         // a page opened where you dropped it: among the others by where it landed
  const centres = (ST.units || []).filter((u) => u.kind === "win" && !u.hide && u.x != null).map((u) => ({ w: u.win, c: u.x + (u.open ? u.w : ST_TAB) / 2 }));
  const n = stOpen(key);
  const rest = stWins().filter((w) => w !== n && !w.mini), at = rest.filter((w) => (centres.find((c) => c.w === w)?.c ?? -1) < x).length;
  rest.splice(at, 0, n); rest.forEach((o, i) => { o.ord = i; });
  ST.focus = n.id; stRender(); stSave(); stShow(n.id);
}
function stShow(id, animate = false, mark) {                              // move only as far as it takes to bring the page wholly into the arena (which already excludes the sidebar)
  stNavigationStop();
  const n = ST.nodes.find((x) => x.id === id), p = ST.pos?.get(id), a = $("#starena");
  if (!p || !a || p.tab || !n || n.mini || n.max || n.screenPin || ST.drag || ST.pan || ST.overview) return;   // a small page floats, a full-screen one is the screen
  const sl = a.scrollLeft;
  const [vleft, vright] = typeof stPinViewport === "function" ? stPinViewport(n, a) : [0, a.clientWidth], W = vright - vleft;
  // The arena already excludes sidebars. Move by exactly the hidden portion;
  // a page wider than the viewport can only reveal its leading edge.
  let left = Math.max(0, p.w > W || p.x < sl + vleft ? p.x - vleft : p.x + p.w > sl + vright ? p.x + p.w - vright : sl);
  if (Number.isFinite(mark?.offset) && mark.offset < vright && mark.offset + p.w > vleft)
    left = Math.max(0, p.x - mark.offset);
  if (Math.abs(left - sl) < 1) return;
  if (left + W > a.scrollWidth) stGrow(left + W);
  const now = performance.now(), rapid = ST.showAt != null && now - ST.showAt < 180;
  const far = Math.abs(left - sl) > W;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (animate && !reduced) stNavigationStart(a, Math.max(0, left), {mark});
  else a.scrollTo({ left: Math.max(0, left), behavior: n.managerProject || reduced || far || rapid ? "instant" : "smooth" });
  ST.showAt = now;
}
function stNavigationStop() {
  const motion = ST.navigation; if (!motion) return;
  cancelAnimationFrame(motion.frame); ST.navigation = null;
  $("#vStage")?.classList?.remove("navigating");
  stScheduleFrameLoads();
}
function stNavigationStart(arena, left, options = {}) {
  stNavigationStop();
  const from = arena.scrollLeft, distance = left - from;
  const motion = ST.navigation = {arena, last:from, frame:0, mark:options.mark};
  $("#vStage")?.classList?.add("navigating");
  clearTimeout(stFrame.timer);
  const start = performance.now(), screens = Math.abs(distance) / Math.max(1, arena.clientWidth);
  const duration = options.mark ? Math.min(520, 280 + screens * 45) : Math.min(420, 220 + screens * 45);
  arena.scrollTo({left:from, behavior:"instant"});
  const tick = now => {
    if (ST.navigation !== motion) return;
    if (S.view !== "stage" || !arena.isConnected || ST.drag || ST.pan || Math.abs(arena.scrollLeft - motion.last) > 2) { stNavigationStop(); return; }
    const t = Math.min(1, Math.max(0, (now - start) / duration));
    const progress = options.mark ? (1 - Math.cos(Math.PI * t)) / 2 : 1 - (1 - t) ** 3;
    arena.scrollTo({left:from + distance * progress, behavior:"instant"});
    motion.last = arena.scrollLeft;
    if (t < 1) motion.frame = requestAnimationFrame(tick); else stNavigationStop();
  };
  motion.frame = requestAnimationFrame(tick);
}
// Top-bar clicks glide for at most 420 ms, with no intermediate frame loads.
// A repeated click starts at the current position, never at the old destination.
function stMapNavigate(id) {
  const arena = $("#starena"), left = arena?.scrollLeft || 0;
  stShiftStop();
  if (stEdgeWheel.motion) { cancelAnimationFrame(stEdgeWheel.motion.frame); stEdgeWheel.motion = null; }
  stFocus(id);
  if (arena) { arena.scrollTo({left, behavior:"instant"}); arena.focus?.({preventScroll:true}); }
  stShow(id, true);
}
// The return tick reveals its parent with one canvas transition. Opening/focusing
// may navigate synchronously; reset that intermediate offset before the next paint.
function stReturnParent(key) {
  const arena = $("#starena"), left = arena?.scrollLeft || 0;
  const node = stOpen(key);
  if (arena && node) {
    arena.scrollTo({left, behavior:"instant"});
    stShow(node.id, true);
  }
  return node;
}
window.stReturnParent = stReturnParent;
function stFocus(id, render) {
  const n0 = ST.nodes.find((x) => x.id === id), up = n0?.par && ST.nodes.find((x) => x.id === n0.par);
  if (n0) { n0.lastUsedAt = Date.now(); stSave(); }
  if (n0?.memo && n0.mini) { n0.mini = false; render = true; }
  if (n0?.small) { delete n0.small; stKidKeep(n0, false); render = true; }
  const root = n0 && stRootOf(n0); if (root && ST.folded?.has(root.id)) { (ST.stageOpen ||= new Set()).add(root.id); render = true; }
  let revealed = false;
  const seen = new Set();
  for (let child = n0; child && !seen.has(child.id);) {
    seen.add(child.id);
    if (child.branchDocked) { delete child.branchDocked; stKidKeep(child, false); revealed = true; }
    const parent = ST.nodes.find(x => x.id === child.par);
    if (!parent) break;
    if (parent.kidsCollapsed || parent.sel !== child.id) { delete parent.kidsCollapsed; parent.sel = child.id; revealed = true; }
    child = parent;
  }
  if (revealed) { render = true; stSave(); }
  if (up && up.sel !== id) { up.sel = id; render = true; stSave(); }      // a branch you turned to: what grew from it shows to its right
  if (n0?.done) { delete n0.done; window.stSaw?.(n0.key); stSave(); requestAnimationFrame(stMap); stListItems(); if (!render) stRender(); }   // looked at: its number goes
  const sameFocus = ST.focus === id;
  ST.focus = id;
  if (!sameFocus && n0?.type === "win") {
    try { n0.el?.querySelector("iframe")?.contentWindow?.chatReadVisibleResults?.(); } catch {}
  }
  if (typeof stPmFollow === "function") stPmFollow(n0);   // update the project and active styling after focus changes
  if (sameFocus && !render) return;
  if (render) stRender(); else document.querySelectorAll(".stnode.t-win").forEach((el) => el.classList.toggle("focus", el.dataset.nid === id));
  if (render) stShow(id);
}
function stMiniLook(e, mini) {
  e.classList.toggle("mini", mini);
  const mb = e.querySelector('[data-stw="min"]'); if (mb && mb.dataset.m !== String(mini)) { mb.dataset.m = String(mini); mb.textContent = mini ? "▭" : "–";
    mb.title = mini ? L("恢复成大窗口", "Back to a full window") : L("缩成小页面（拖动移动，四边四角调大小）", "Make it a small page (drag to move, pull edges and corners to size it)"); }
}
function stOpenCollapsed(n, anchor) {
  document.querySelector('#stsummary')?._cleanup?.();
  n.mini = false;
  stMini(n, false);
  stFocus(n.id, true);
}
function stBindSummaryHover(chip) {
  let timer;
  chip.addEventListener('pointerenter', e => {
    clearTimeout(timer);
    if (e.buttons || ST.rightPan || ST.frameMoving) return;
    timer = setTimeout(() => {
      const id = chip.dataset.stexpand || chip.dataset.stunfold;
      const node = ST.nodes.find(x => x.id === id);
      if (node && chip.isConnected && !ST.drag && !ST.pan && !ST.rightPan && !ST.frameMoving) stSummaryOpen(node, chip, true);
    }, 220);
  });
  chip.addEventListener('pointerleave', () => clearTimeout(timer));
  chip.addEventListener('pointerdown', () => clearTimeout(timer));
}
function stSmallLook(e, n) {
  e.classList.toggle("small", !!n.small);
  let chip = e.querySelector('.stcollapsed-name');
  if (!chip) {
    chip = document.createElement('button'); chip.className = 'stcollapsed-name';
    e.appendChild(chip);
    stBindSummaryHover(chip);
  }
  delete chip.dataset.stpreview;
  chip.dataset.stexpand = n.id;
  chip.hidden = !n.small;
  const title = n.memo ? memoNodeTitle(n) : stNodeTitle(n);
  chip.innerHTML = `<span class="stline-title">${esc(title)}</span>`;
  chip.title = L('打开：', 'Open: ') + title;
  chip.setAttribute('aria-label', chip.title);
  chip.classList.toggle('memo-collapsed', !!n.memo);
  chip.style.setProperty('--collapsed-color', n.memo ? 'var(--memo-collapsed-color)' : stGroupOf(n)?.c || 'var(--accent)');
  chip.setAttribute('aria-expanded', String(!n.small));
  const mb = e.querySelector('[data-stw="min"]');
  if (mb) { mb.textContent = n.small ? "▭" : "–"; mb.title = L("收起为竖线，点击展开", "Collapse to a vertical line; click to open"); }
}
function stSummaryData(n) {
  if (n.file) return {title: n.title, summary: n.file.path, excerpts: []};
  const item = recentItems().find(x => x.item === n.key);
  const chat = (S.chats || []).find(x => x.key === n.key);
  const summary = String(chat?.summary || item?.summary || '').trim();
  let excerpts = [];
  try {
    const doc = n.el?.querySelector('iframe')?.contentDocument;
    excerpts = [...(doc?.querySelectorAll('#cdlgIn .cmsg') || [])].slice(-3).map(el => ({
      role: el.classList.contains('me') ? L('你', 'You') : L('回答', 'Reply'),
      text: (el.querySelector('.md, .body, .text')?.innerText || el.innerText || '').trim().slice(0, 900)
    })).filter(x => x.text);
  } catch {}
  return {title:stNodeTitle(n), summary:summary.slice(0,1800), excerpts};
}
function stSummaryOpen(n, anchor, hover = false) {
  document.querySelector('#stsummary')?._cleanup?.();
  const data = stSummaryData(n), panel = document.createElement('section');
  panel.id = 'stsummary'; panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', L('对话概要','Conversation summary'));
  panel.innerHTML = `<header><b>${esc(data.title)}</b><button data-summary-close aria-label="${L('关闭','Close')}">×</button></header>
    <small>${n.run ? L('正在处理','Running') : n.completedAt ? L('最近完成：','Last completed: ') + stCompletionTime(n.completedAt) : L('对话概要','Conversation summary')}</small>
    <div class="stsummary-body">${data.summary ? `<p>${esc(data.summary)}</p>` : ''}${data.excerpts.length ? `<h4>${L('最近内容节选','Recent excerpts')}</h4>` + data.excerpts.map(x=>`<article><b>${esc(x.role)}</b><p>${esc(x.text)}</p></article>`).join('') : !data.summary ? `<p>${L('暂无可用概要，展开对话查看完整内容。','No summary available. Open the conversation to read it.')}</p>` : ''}</div>
    <footer><button data-summary-restore>${L('展开完整对话','Open full conversation')}</button></footer>`;
  document.body.appendChild(panel);
  if (!data.summary && !data.excerpts.length && n.key) {
    const body = panel.querySelector('.stsummary-body');
    body.textContent = L('正在读取最近内容…', 'Loading recent content…');
    const imported = /^(c:|imp:)/.test(n.key);
    const url = imported ? `/v1/users/${S.uid}/imported/${encodeURIComponent(n.key.replace(/^(c:|imp:)/, ''))}` : `/v1/users/${S.uid}/chats/${encodeURIComponent(n.key)}`;
    api(url).then(r => {
      if (!panel.isConnected) return;
      const turns = (r.turns || []).slice(-3).filter(t => t.text);
      body.innerHTML = turns.length ? `<h4>${L('最近内容节选','Recent excerpts')}</h4>` + turns.map(t => `<article><b>${esc(t.role === 'user' ? L('你','You') : L('回答','Reply'))}</b><p>${esc(String(t.text).slice(0, 1200))}</p></article>`).join('') : `<p>${esc(String(r.summary || r.excerpt || L('这段对话暂无内容。','This conversation is empty.')).slice(0,1800))}</p>`;
      panel.style.top = Math.max(8, Math.min(parseFloat(panel.style.top), window.innerHeight - panel.offsetHeight - 8)) + 'px';
    }).catch(() => { if (panel.isConnected) body.textContent = L('读取失败，请展开对话查看。','Could not load content. Open the conversation to read it.'); });
  }
  const r = anchor.getBoundingClientRect();
  panel.style.left = Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8)) + 'px';
  panel.style.top = Math.max(8, Math.min(r.bottom + 8, window.innerHeight - panel.offsetHeight - 8)) + 'px';
  let closeTimer;
  const keep = () => clearTimeout(closeTimer);
  const leave = () => { keep(); closeTimer = setTimeout(() => cleanup(), 220); };
  const cleanup = () => { keep(); anchor.removeEventListener('pointerenter', keep); anchor.removeEventListener('pointerleave', leave); panel.remove(); document.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', outside, true); if (!hover && anchor.isConnected) anchor.focus({preventScroll:true}); };
  panel._cleanup = cleanup;
  const key = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); cleanup(); } };
  const outside = e => { if (!panel.contains(e.target) && !anchor.contains(e.target)) cleanup(); };
  panel.querySelector('[data-summary-close]').onclick = cleanup;
  panel.querySelector('[data-summary-restore]').onclick = () => { cleanup(); stMini(n, false); stFocus(n.id, true); };
  document.addEventListener('keydown', key, true); document.addEventListener('pointerdown', outside, true);
  if (hover) {
    anchor.addEventListener('pointerenter', keep); anchor.addEventListener('pointerleave', leave);
    panel.addEventListener('pointerenter', keep); panel.addEventListener('pointerleave', leave);
  } else panel.querySelector('[data-summary-close]').focus({preventScroll:true});
}
function stFoldSet(ws, mark) {                      // fold these windows and remember which ones, so the same − opens just them again
  const open = ws.filter((w) => !w.mini && !w.small);
  const back = (mark ? ST[mark] : null) || [];
  const shut = back.map((id) => ST.nodes.find((x) => x.id === id)).filter((w) => w?.small);
  if (!open.length && shut.length) {                // everything already folded by it: open them back up
    for (const w of shut) { w.lastUsedAt = Date.now(); delete w.small; stKidKeep(w, false); }
    if (mark) delete ST[mark];
  } else {
    if (!open.length) return;
    for (const w of open) { stKidKeep(w, true); w.small = true; }
    if (mark) ST[mark] = [...new Set([...shut.map((w) => w.id), ...open.map((w) => w.id)])];   // ones you opened by hand in between fold back with the rest
  }
  ST.catOpen?.clear(); ST.mapExpanded?.clear();
  document.querySelector('#stsummary')?._cleanup?.();
  stRender(); stSave(); stMap();
}
function stFoldAll() { stFoldSet(stWins(), "foldAllIds"); }   // − on the top bar: every window to its line, and again to open them all back
function stSetProjectChatsFolded(project, folded) {
  const category = 'pj:' + project;
  for (const w of stWins()) {
    if (w.managerProject || w.key?.startsWith('chat:pm-') || w.pad || w.memo || w.file || w.knowledge
      || stGroupOf(w)?.id !== category) continue;
    if (!!w.small !== folded) stKidKeep(w, folded);
    w.managerFoldManaged = true;
    w.small = folded;
    if (!folded) {
      w.mini = false;
      delete w.branchDocked;
      delete w.kidsCollapsed;
      if (w.par) w.tidyLinear = true;
    }
  }
  stRender(); stSave(); stMap();
}
function stFoldCat(id) {                            // − before a category's name: just that category
  ST.foldCatIds ||= {};
  const k = "_fc"; ST[k] = ST.foldCatIds[id];
  stFoldSet(stWins().filter((w) => stGroupOf(w)?.id === id), k);
  if (ST[k]) ST.foldCatIds[id] = ST[k]; else delete ST.foldCatIds[id];
  delete ST[k]; stMap();
}
const stFoldedAll = () => (ST.foldAllIds || []).some((id) => ST.nodes.find((x) => x.id === id)?.small) && !stWins().some((w) => !w.mini && !w.small);
function stMini(n, on) { // Preserve saved geometry; collapsed layout uses only the line width.
  if (on === !!n.small) return;
  document.querySelector('#stsummary')?._cleanup?.();
  stKidKeep(n, on);
  if (!on) n.lastUsedAt = Date.now();
  if (on) n.small = true;
  else delete n.small;
  stRender(); stSave(); stMap();
}
function stClose(n, options = {}) {
  if (n.file && !stFileCanClose(n)) return;
  if (ST.positionMarks && stMarkChat(n)) {
    stMarkAssignChatKey(n, n.key || n.el?.querySelector('iframe')?.contentWindow?.S?.chat);
  }
  if (n.managerProject) stPmOffSet(n.managerProject, true);
  if (n.pad) { stPadOut(); store.set("pga_pad_off", "1"); }
  if (n.memo) memoUnmount(n.memo);
  // Closing a view does not close its descendants or change their conversation history.
  const children = ST.nodes.filter(x => x.par === n.id);
  for (const child of children) {
    if (!child.from) child.from = n.key;
    if (!child.branchFrom) child.branchFrom = n.key;
    const width = ST.pos?.get(child.id)?.w;
    if (width) child.bw = width;
    delete child.par; delete child.branchDocked; delete child.branchWeight;
  }
  ST.nodes = ST.nodes.filter(x => x.id !== n.id);
  for (const x of ST.nodes) {
    if (x.kids) x.kids = x.kids.filter(id => id !== n.id);
    if (x.sel === n.id) x.sel = x.kids?.[0];
    if (x.win === n.id) delete x.win;
    if (x.links) x.links = x.links.filter(link => link.from !== n.id);
  }
  ST.stageOpen?.delete(n.id);
  if (ST.focus === n.id) ST.focus = children[0]?.id || stWins()[0]?.id || null;
  const frame = n.el?.querySelector?.('iframe');
  if (frame) { clearTimeout(frame._pgaWatch); stFrame.pending?.delete(frame); }
  if (typeof window !== 'undefined') window.pgCancelRestore?.(n);
  if (!options.deferRender) { stRender(); stSave(); stContexts(); }
}
function stPDFReaderZoom(frame, zoom, center) {
  const host = frame.closest('.stnode');
  if (!host) return 0;
  const node = ST.nodes.find(n => n.el === host);
  if (!node) return 0;
  if ((host.pdfReaderZoom || 1) !== zoom) {
    host.pdfReaderZoom = zoom;
    stRender();
  }
  const unit = ST.units?.find(u => !u.hide && (u.kind === 'win' && u.win === node || u.kind === 'stack' && u.wins.includes(node)));
  if (!unit || node.small || node.mini || node.screenPin) return 0;
  if (center && !ST.overview && !ST.drag && !ST.pan) {
    const arena = $('#starena');
    const [left, right] = stPinViewport(node, arena);
    stNavigationStop();
    stScrollTo(unit.x + unit.w / 2 - (left + right) / 2);
  }
  return zoom <= 1 || unit.pdfBaseWidth == null ? 0 : Math.max(0, host.offsetWidth - unit.pdfBaseWidth);
}
function stMax(n, on, ratio) { // Enlarge the existing frame without reloading its conversation; ratio sets an exact share of the stage.
  if (!on && !n.big || on && !ratio && n.fullscreen) return;
  if (on) {
    for (const other of stWins()) if (other !== n) { delete other.big; delete other.bigWidth; delete other.fullscreen; }
    const available = stArena().w;
    n.bigWidth = ratio ? Math.round(available * ratio) : Math.max(1, available - 2 * ST_PADX);
    if (n.small) stMini(n, false);
    n.big = true; n.fullscreen = !ratio; ST.focus = n.id;
  } else { delete n.big; delete n.bigWidth; delete n.fullscreen; }
  stRender(); stSave(); stMap(); if (on) stShow(n.id);
}
// Double-click window whitespace: 50% of the stage; triple-click: 0.9. Text keeps native selection. Esc restores.
const ST_DBL = 0.5, ST_TRI = 0.9;
let stSizeTimer = null;
function stClickSize(n, e, sel) {
  if (e.detail < 2 || e.detail > 3 || n.mini) return;
  if (e.detail === 2) { n.lastDoubleClickAt = n.lastUsedAt = Date.now(); stSave(); }
  clearTimeout(stSizeTimer);
  sel?.removeAllRanges();
  // Keep the target stationary until a possible third click has arrived.
  const apply = () => { stSizeTimer = null; const target = ST.nodes.find(w => w.id === n.id && w.key === n.key); if (target) stMax(target, true, e.detail === 3 ? ST_TRI : ST_DBL); };
  if (e.detail === 3) apply();
  else stSizeTimer = setTimeout(apply, 500);
}
async function stRepairBranchKeys() {
  if (ST.branchKeysRepairing || !S.chats?.length) return;
  ST.branchKeysRepairing = true;
  try {
    for (const n of stWins().filter(x => x.par)) {
      const matches = S.chats.filter(c => c.title === n.title);
      const oldKey = n.key;
      if (typeof readingRepairNode === 'function') readingRepairNode(n);
      const own = n.readingKey || n.branchKey || (matches.length === 1 ? matches[0].key : n.key);
      if (!own) continue;
      const changed = own !== oldKey;
      n.branchKey = own; n.key = own;
      if (changed && n.el) stFrame(n, n.el);
      const parent = ST.nodes.find(x => x.id === n.par);
      if (parent?.key === own) {
        const detail = await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(own)}`).catch(() => null);
        const source = detail?.branch?.from;
        if (source && source !== own) {
          parent.key = source;
          if (parent.par) parent.branchKey = source;
          if (parent.el) stFrame(parent, parent.el);
        }
      }
    }
    ST.branchKeysReady = true; stSave();
  } finally { ST.branchKeysRepairing = false; }
}
setInterval(() => {                               // a new conversation in a window gets its key once you send; titles follow
  if (S.view !== 'stage' || S.stageMotion) return;
  if (!ST.branchKeysReady || stWins().some(n => n.par && !n.branchKey)) { stRepairBranchKeys(); return; }
  for (const n of ST.nodes.filter((x) => x.type === "win")) {
    const el = document.querySelector(`.stnode[data-nid="${n.id}"]`), f = el?.querySelector("iframe"); let k = null; try { k = f?.contentWindow?.S?.chat || null; } catch {}
    if (typeof readingRepairNode === 'function') readingRepairNode(n);
    if (n.readingKey && k && k !== n.readingKey) { if (f.contentWindow?.S?.booted) stFrame(n, el); continue; }
    if (n.par && n.branchKey && k && k !== n.branchKey) { n.key = n.branchKey; stFrame(n, el); continue; }
    if (k && k !== n.key) { if (!n.key) stMarkAssignChatKey(n, k); n.key = k; if (Object.keys(ST.positionMarks).length) requestAnimationFrame(stMap); n.sent = null; if (!k.startsWith("chat:pm-")) delete n.managerProject; stSave(); stContexts(); }
    const t = el?.querySelector(".stwt"); if (t && n.key) { const s = stNodeTitle(n); if (t.textContent !== s) t.textContent = s; }
  }
}, 2500);

/* ------------------------------------------------ add a node from the toolbar to the focused window */
function stAddMenu(anchor) {
  const win = stWins().find(n => n.id === ST.focus);
  document.querySelector(".stmenu")?.remove();
  const m = document.createElement("div"); m.className = "cvpal cvmenu stmenu card";
  m.innerHTML = `<div class="stmh">${win ? L(`连给「${esc(stTitle(win.key).slice(0, 18))}」`, `Into “${esc(stTitle(win.key).slice(0, 20))}”`) : L("放在未连接的架子上", "On the unwired shelf")}</div>`
    + [["conv", "💬", 0], ["topic", "🌳", 0], ["doc", "📚", 1], ["file", "📎", 1], ["note", "📝", 1], ["skill", "✦", 2], ["win", "▢"], ...(ST.nodes.some((x) => x.pad) ? [] : [["pad", "🗒"]])].map(([t, i, p]) => `<button data-stadd="${t}">${i} ${t === "win" ? L("新对话窗口", "New conversation window") : t === "pad" ? L("计划页", "Plan page") : L(...ST_T[t].slice(0, 2)) + (t === "note" ? "" : "…")}${p != null ? `<em>${L(...ST_PINS[p])}</em>` : ""}</button>`).join("");
  m.dataset.at = JSON.stringify({win:win?.id || null}); document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(r.right - m.offsetWidth, innerWidth - m.offsetWidth - 4)) + "px";
  m.style.top = Math.max(4, r.bottom + 4 + m.offsetHeight <= innerHeight ? r.bottom + 4 : r.top - m.offsetHeight - 4) + "px";
  m.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    e.preventDefault(); e.stopPropagation(); m.remove(); anchor.focus();
  });
  m.querySelector("button")?.focus({preventScroll:true});
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
/* ------------------------------------------------ moving along the stage: held (right button anywhere, or the left one on empty
   ground) it slides under the pointer; the map at the top shows the whole row and takes you anywhere on it */
function stScrollTo(want) {                          // the stage begins at its first page: dragging stops there, no blank grows on the left
  const a = $("#starena"); if (!a) return;
  want = Math.max(0, want);
  const end = want + a.clientWidth;
  if (end > Math.max(a.scrollWidth || 0, ST.spaceRight || 0)) {
    ST.spaceRight = end;
    stGrow();
  }
  a.scrollLeft = want;
}
function stPanStart(sx, pointerId) { if (typeof stReorderStop === 'function') stReorderStop(); const a = $("#starena"); if (!a) return; ST.pan = { x: sx, pointerId, sl: a.scrollLeft, max: Math.max(0, a.scrollWidth - a.clientWidth) }; $("#vStage").classList.add("panning", "dragging"); }
let stPanFrame = 0, stPanX = 0;
function stPanMove(sx) {
  if (!ST.pan) return;
  stPanX = sx; if (typeof stPmUser === "function") stPmUser();
  if (!stPanFrame) stPanFrame = requestAnimationFrame(() => { stPanFrame = 0; stPanApply(stPanX); });
}
function stPanApply(sx) {
  const p = ST.pan; if (!p) return;
  const left = p.sl - (sx - p.x) * (p.gain || 1);
  if (p.bounded) $("#starena").scrollLeft = Math.max(0, Math.min(p.max, left));
  else stScrollTo(left);
}
function stPanEnd() {
  const pan = ST.pan; if (!pan) return;
  if (stPanFrame) { cancelAnimationFrame(stPanFrame); stPanFrame = 0; stPanApply(stPanX); }
  stSave(); ST.pan = null; $("#vStage").classList.remove("panning", "dragging");
  if (!pan.bounded) stMap();
  stScheduleFrameLoads();
}
try { if (window.webkit?.messageHandlers?.pga && !Q.get("embed")) document.documentElement.classList.add("deskapp"); } catch {}   // the desktop app: its top strip moves the window
window.stPanStart = stPanStart; window.stPanMove = stPanMove; window.stPanEnd = stPanEnd;
// Middle press opens the reorder preview; releasing keeps the overview available.
// One owner across the arena, conversation frames and file-reader frames.
function stMiddlePanBind(surface, frame = null) {
  if (surface._pgaMiddlePanBound) return;
  surface._pgaMiddlePanBound = true;
  const doc = surface.ownerDocument || surface, view = doc.defaultView;
  const stop = e => { e.preventDefault(); e.stopImmediatePropagation(); };
  const finish = (cancelled = false, event = null) => {
    const state = ST.middlePan; if (!state) return;
    ST.middlePan = null;
    try { state.capture?.releasePointerCapture(state.id); } catch {}
    if (cancelled) stDockCancel();
    else if (ST.drag?.dock) { if (event) stDragSoon(event.screenX, event.screenY); stDragFlush(); stDrop(); }
  };
  surface.addEventListener('pointerdown', e => {
    if (e.button !== 1 || S.view !== 'stage' || ST.drag || ST.pan || ST.rz || ST.branchResize || ST.rightPan || ST.middlePan) return;
    if (ST.overview) { stop(e); stDockCancel(); return; }
    const fileSurface = !!frame?.closest?.('.stfilewin');
    if (e.target.closest?.('a, input, select, button') || (!fileSurface && e.target.closest?.('textarea, [contenteditable], .cm-editor, .monaco-editor'))) return;
    const el = frame?.closest?.('.stnode') || e.target.closest?.('.stnode');
    if (el && ST.nodes.find(n => n.id === el.dataset.nid)?.screenPin) { stop(e); return; }
    const node = ST.nodes.find(n => n.id === el?.dataset.nid && !n.screenPin)
      || ST.nodes.find(n => n.id === ST.focus && !n.screenPin && n.el && !n.el.hidden)
      || stWins().find(n => !n.screenPin && n.el && !n.el.hidden);
    clearTimeout(ST.pageClickTimer); ST.pageClickTimer = null;
    stShiftStop();
    if (stEdgeWheel.motion) { cancelAnimationFrame(stEdgeWheel.motion.frame); stEdgeWheel.motion = null; }
    const nodeLeft = node?.el?.getBoundingClientRect?.().left;
    ST.middlePan = {id:e.pointerId, x:e.screenX, y:e.screenY, doc, node,
      gx:nodeLeft != null ? e.clientX + (frame?.getBoundingClientRect?.().left || 0) - nodeLeft : frame ? e.clientX : 40, moved:false};
    if (!node || !stMiddleGrab(node, e.screenX, e.screenY, ST.middlePan.gx)) { ST.middlePan = null; return; }
    try { ST.middlePan.capture = doc.documentElement; doc.documentElement.setPointerCapture(e.pointerId); } catch {}
    stop(e);
  }, true);
  doc.addEventListener('pointermove', e => {
    const state = ST.middlePan; if (!state || state.id !== e.pointerId) return;
    if (!(e.buttons & 4)) { finish(true); return; }
    stop(e); stDragSoon(e.screenX, e.screenY);
  }, true);
  doc.addEventListener('pointerup', e => {
    if (ST.middlePan?.id !== e.pointerId || e.button !== 1) return;
    stop(e); finish(false, e);
  }, true);
  doc.addEventListener('pointercancel', e => { if (ST.middlePan?.id === e.pointerId) finish(true); }, true);
  doc.addEventListener('lostpointercapture', e => { if (ST.middlePan?.capture === e.target) finish(true); }, true);
  doc.addEventListener('keydown', e => { if (e.key === 'Escape' && ST.middlePan) { finish(true); stop(e); } }, true);
  view.addEventListener('blur', () => { if (ST.middlePan?.doc === doc && !doc.hasFocus()) finish(true); });
  view.addEventListener('pagehide', () => { if (ST.middlePan?.doc === doc) finish(true); });
  for (const type of ['mousedown', 'auxclick']) surface.addEventListener(type, e => { if (e.button === 1 && !e.target.closest?.('a')) e.preventDefault(); }, true);
}
const stPageEditors = new WeakMap();
// Resolve the current editor at release time: chat rendering can replace its textarea.
function stToggleComposerFocus(leave = false) {
  const stage = S.view === 'stage';
  if (!stage && S.view !== 'chats') return false;
  const active = document.activeElement;
  const card = stage && active?.closest('.stnode');
  const node = stage && ST.nodes.find(n => n.id === (card?.dataset.nid || ST.focus));
  if (stage && !node?.el) return false;
  const frame = stage && node.el.querySelector('iframe');
  const scope = frame ? frame.contentDocument : stage ? node.el : document;
  const owner = scope?.ownerDocument || scope;
  if (!owner || [document, owner].some(d => Array.from(d.querySelectorAll('.modal, dialog[open]'))
      .some(el => el.getClientRects().length))) return false;
  const editors = 'textarea, [contenteditable="true"], input[type="text"], input:not([type])';
  let current = owner.activeElement;
  while (current?.tagName === 'IFRAME' && current.contentDocument?.activeElement)
    current = current.contentDocument.activeElement;
  if (current?._pgaComposing) return false;
  const inside = stage ? (frame ? active === frame : card === node.el && (active === card || active.matches(editors))) :
    current?.matches('#chatText, #tnText, #editText');
  if (stage && ST.focus !== node.id) stFocus(node.id);
  if (leave || inside) {
    const target = stage ? $('#starena') : document.querySelector('#cdlg');
    if (!target) return false;
    if (stage && inside && current?.matches(editors)) stPageEditors.set(node.el, current);
    target.tabIndex = -1;
    target.focus({preventScroll:true});
  } else {
    const visible = el => el?.isConnected && !el.disabled && el.getClientRects().length;
    const preferred = stage && stPageEditors.get(node.el);
    const primary = Array.from(scope.querySelectorAll('#chatText, #tnText, #editText, #padText, [data-plan-text]')).find(visible);
    const editor = visible(preferred) ? preferred : primary || Array.from(scope.querySelectorAll(editors)).find(visible);
    const target = editor || frame || (stage && node.el);
    if (!target) return false;
    if (!editor && !frame) target.tabIndex = -1;
    target.focus({preventScroll:true});
  }
  return true;
}

// Handle assigned numbers before a child page handles the same key as selection.
function stAssignedMarkKey(e) {
  if (!/^[1-9]$/.test(e.key) || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey ||
      e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
  const target = e.composedPath()[0];
  if (target.isContentEditable || target.closest?.('textarea:not([readonly]), input:not([readonly]), select, [role="textbox"]:not([aria-readonly="true"]), [role="dialog"], dialog')) return;
  stLoadPositionMarks();
  const mark = ST.positionMarks[e.key];
  if (!mark) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (e.repeat) return;
  if (ST.overview) stDockCancel();
  stReturnToMark(mark);
}
// AppKit handles modifier-only gestures for native windows. Browsers deliver DOM key events.
function stBindComposerToggle(doc, frame) {
  doc.addEventListener('keydown', e => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || e.repeat ||
        e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || S.view !== 'stage') return;
    const card = frame?.closest('.stnode') || e.target.closest?.('.stnode');
    const node = card && ST.nodes.find(n => n.id === card.dataset.nid);
    if (!node || stMarkChat(node) || doc.querySelector('[role="dialog"], dialog[open], .modal')) return;
    if (stToggleComposerFocus(true)) { e.preventDefault(); e.stopPropagation(); }
  }, !frame);
  if (window.PGA_NATIVE?.composerShortcut) return;
  let ready = false;
  const reset = () => { ready = false; };
  const modifier = e => e.key === 'Control' || e.key === 'Shift';
  doc.addEventListener('keydown', e => {
    if (!e.repeat) ready = modifier(e) && e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && !e.isComposing;
  }, true);
  doc.addEventListener('keyup', e => {
    const toggle = ready && modifier(e) && !e.altKey && !e.metaKey && !e.isComposing;
    reset();
    if (toggle && stToggleComposerFocus()) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  doc.defaultView.addEventListener('blur', reset);
  doc.addEventListener('pointerdown', reset, true);
  doc.addEventListener('compositionstart', reset, true);
}

// Right-button drag pans the canvas; holding right also modifies the wheel.
// Delay context menus until release on platforms that dispatch them on mouse-down.
function stRightPanBind(surface, frame = null, accepts = () => true) {
  if (surface._pgaRightPanBound) return;
  surface._pgaRightPanBound = true;
  const doc = surface.ownerDocument || surface, view = doc.defaultView;
  view.addEventListener('keydown', stAssignedMarkKey, true);
  stBindComposerToggle(doc, frame);
  const managerTarget = target => doc.documentElement.classList.contains?.('pmworkspace')
    || frame?.closest?.('.st-manager-page') || target.closest?.('.st-manager-page, [data-stw="manager"], #stpmopen, #managerPanel');
  const stopEvent = e => { e.preventDefault(); e.stopImmediatePropagation(); };
  const finish = (cancelled = false, release = null) => {
    const state = ST.rightPan; if (!state) return;
    ST.rightPan = null;
    state.doc.documentElement.classList.remove('st-right-panning');
    try { state.capture?.releasePointerCapture(state.id); } catch {}
    const now = performance.now();
    const held = Number.isFinite(release?.timeStamp) && Number.isFinite(state.downTime)
      ? release.timeStamp - state.downTime : now - state.start;
    if (cancelled || state.moved || state.wheeled || state.slipped || held >= 500) {
      if (state.moved) stPanEnd();
      ST.rightPanMenuUntil = now + 300;
    } else if (state.menu) {
      ST.rightPanMenuUntil = performance.now() + 300;
      const {target, init} = state.menu;
      if (!target.isConnected) return;
      if (state.editorMenu && state.view.fpStageContextMenu?.(target, init.clientX, init.clientY)) return;
      const event = new state.view.MouseEvent('contextmenu', init);
      Object.defineProperty(event, '_pgaRightPanReplay', {value:true});
      target.dispatchEvent(event);
    }
  };
  surface.addEventListener('pointerdown', e => {
    if (ST.selectedMark && !e.target.closest?.('[data-stmark], #stmarkdelete')) stSelectMark(null);
    if (e.button !== 2 || !accepts(e.target) || (frame && S.view !== 'stage') || ST.drag || ST.pan || ST.overview || ST.rz || ST.branchResize || ST.middlePan) return;
    const dragOnly = managerTarget(e.target);
    const menuOnly = S.view !== 'stage';
    const editor = e.target.closest?.('.monaco-editor');
    const localMenu = !dragOnly && !menuOnly && !editor && !e.target.closest?.('[data-railfork]') && !!(e.target.closest?.('input, textarea, select, a, [contenteditable], .cm-editor') || view.getSelection()?.toString());
    clearTimeout(ST.pageClickTimer); ST.pageClickTimer = null;
    ST.rightPanMenuUntil = 0;
    ST.rightPan = {id:e.pointerId, x:e.screenX, y:e.screenY, start:performance.now(), downTime:e.timeStamp, dragOnly, moved:false, menuOnly, localMenu, editorMenu:!!editor, doc, view, frame};
    document.querySelector('#stsummary')?._cleanup?.();
    if (typeof stMapHideTip === 'function') stMapHideTip();
    if (dragOnly) stopEvent(e);
    else if (!editor && !localMenu) e.stopImmediatePropagation(); // Let an ordinary Monaco right click resolve its own caret/selection.
  }, true);
  doc.addEventListener('pointermove', e => {
    const state = ST.rightPan; if (!state || e.pointerId !== state.id) return;
    if (!(e.buttons & 2)) { finish(true); return; }
    if (state.menuOnly) {
      if (Math.hypot(e.screenX - state.x, e.screenY - state.y) >= 6) state.slipped = true;
      return;
    }
    if (state.wheeled) { stopEvent(e); return; }
    if (!state.moved) {
      if (Math.abs(e.screenY - state.y) >= 6) state.slipped = true;
      if (Math.abs(e.screenX - state.x) < 6) return;
      stShiftStop();
      if (stEdgeWheel.motion) { cancelAnimationFrame(stEdgeWheel.motion.frame); stEdgeWheel.motion = null; }
      stPanStart(state.x);
      if (!ST.pan) { finish(true); return; }
      state.moved = true; ST.pan.gain = 1.6; ST.pan.bounded = true;
      document.querySelector('.stmenu')?.remove();
      state.doc.documentElement.classList.add('st-right-panning');
      try { state.capture = state.doc.documentElement; state.capture.setPointerCapture(state.id); } catch {}
    }
    stopEvent(e); stPanMove(e.screenX);
  }, true);
  doc.addEventListener('pointerup', e => {
    const state = ST.rightPan; if (!state || e.pointerId !== state.id || e.button !== 2) return;
    if (state.moved) { stPanMove(e.screenX); stopEvent(e); }
    finish(false, e);
  }, true);
  doc.addEventListener('pointercancel', e => { if (ST.rightPan?.id === e.pointerId) finish(true); }, true);
  doc.addEventListener('lostpointercapture', e => { if (ST.rightPan?.capture === e.target) finish(true); }, true);
  doc.addEventListener('keydown', e => {
    if (/^[0-9 ]$|^Arrow(Left|Right|Up|Down)$/.test(e.key)) { stPositionMarkKey(e, frame); return; }
    if (ST.selectedMark) stSelectMark(null);
    if (e.key === 'Escape' && ST.rightPan) { finish(true); stopEvent(e); }
  }, true);
  doc.addEventListener('wheel', () => { if (ST.selectedMark) stSelectMark(null); }, {capture:true, passive:true});
  view.addEventListener('blur', () => { if (ST.rightPan?.doc === doc && !doc.hasFocus()) finish(true); });
  view.addEventListener('pagehide', () => { if (ST.rightPan?.doc === doc) finish(true); });
  if (!frame) surface.addEventListener('wheel', () => { if (ST.rightPan?.menuOnly) ST.rightPan.wheeled = true; }, {passive:true, capture:true});
  surface.addEventListener('contextmenu', e => {
    if (e.button !== 2 || !accepts(e.target)) return;
    if (ST.rightPan?.dragOnly || managerTarget(e.target)) { stopEvent(e); return; }
    if (e._pgaRightPanReplay) return;
    const state = ST.rightPan;
    if (state) {
      if (state.localMenu && !state.moved && !state.wheeled && !state.slipped && performance.now() - state.start < 500) return;
      stopEvent(e);
      if (!state.moved && !state.wheeled) state.menu = {target:e.target, init:{bubbles:true,cancelable:true,view,
        button:2,buttons:0,clientX:e.clientX,clientY:e.clientY,screenX:e.screenX,screenY:e.screenY}};
    } else if (performance.now() < (ST.rightPanMenuUntil || 0)) stopEvent(e);
  }, true);
}

// The compact map has its own projection; filtering never closes or moves stage windows.
const ST_KEEP = 5;                                  // At most five expanded conversations per category.
const stFoldable = (w) => w.type === "win" && !w.mini && !w.par && !w.pad && !w.memo && !w.knowledge;   // managers follow the same fold rules as other pages
function stRootOf(n) { for (let i = 0; n?.par && i < 50; i++) { const p = ST.nodes.find((x) => x.id === n.par); if (!p) break; n = p; } return n; }
function stFoldPick(recent = new Map(recentItems().map(x => [x.item, x]))) {
  const time = w => Math.max(w.openedAt || 0, w.runAt || 0, w.completedAt || 0, Date.parse(recent.get(w.key)?.last || '') || 0);
  const groups = new Map(), folded = new Set(), count = new Map();
  for (const w of stWins()) if (stFoldable(w)) { const id = stGroupOf(w)?.id || ''; if (!groups.has(id)) groups.set(id, []); groups.get(id).push(w); }
  for (const [id, ws] of groups) {
    const open = ws.filter(w => !w.small && !w.managerProject && !w.key?.startsWith('chat:pm-'));
    open.sort((a,b) => Number(b.id === ST.focus) - Number(a.id === ST.focus) || time(b) - time(a));
    for (const w of open.slice(ST_KEEP)) { if (w.managerFoldManaged) continue; folded.add(w.id); count.set(id, (count.get(id) || 0) + 1); }
  }
  return { folded, count, total: new Map([...groups].map(([id, ws]) => [id, ws.length])) };
}
// Rank categories by actual conversation activity, including folded/closed chats.
// Merely opening or focusing an old window must not make its category newest.
function stMapCategoryOrder(wins, recent) {
  const times = new Map(), order = new Map(), opened = new Map();
  const add = (w, at) => {
    const id = stGroupOf(w)?.id || '';
    if (!order.has(id)) order.set(id, order.size);
    times.set(id, Math.max(times.get(id) || 0, at));
  };
  for (const w of wins) { add(w, Math.max(w.runAt || 0, w.completedAt || 0, Date.parse(recent?.get(w.key)?.last || '') || 0)); const id = stGroupOf(w)?.id || ''; opened.set(id, Math.max(opened.get(id) || 0, w.openedAt || 0)); }
  for (const [key, item] of recent || []) {
    const w = wins.find(w => w.key === key) || {key, type: 'win'};
    add(w, Date.parse(item.last || '') || 0);
  }
  // A category nobody has talked in yet (one just made) ranks by when it was opened.
  const time = id => times.get(id) || opened.get(id) || 0;
  return (a, b) => {
    const ga = stGroupOf(a)?.id || '', gb = stGroupOf(b)?.id || '';
    return time(gb) - time(ga) || order.get(ga) - order.get(gb);
  };
}
// The bar's 按时间 mode: the latest exchange first. Opening a window is not an exchange, so it only places windows that never had one.
function stMapTime(w, recent, depth = 0) {
  const key = w.key || w.memoSource || w.knowledgeSource;
  const own = Math.max(w.runAt || 0, w.completedAt || 0, Date.parse(recent?.get(key)?.last || '') || 0);
  if (own) return own;
  // A branch not talked in yet stands just after what it grew from, not first because it was just opened.
  const src = w.branchFrom && depth < 8 && ST.nodes.find((n) => n.type === 'win' && n !== w && n.key === w.branchFrom);
  return src ? stMapTime(src, recent, depth + 1) - 1 : w.openedAt || 0;
}
function stPlacementTime(w, recent) {
  const placement = w.initialPlacement;
  if (placement && !w.runAt && !w.completedAt && recent.get(w.key)?.last === placement.last) return placement.time;
  return stMapTime(w, recent);
}
function stMapTimeOrder(recent) {
  return (a, b) => stPlacementTime(b, recent) - stPlacementTime(a, recent);
}
const ST_MAPAGES = [[3600e3, '1 小时内', 'Last hour'], [0, '今天', 'Today'], [-1, '昨天', 'Yesterday'], [-6, '近 7 天', 'This week'], [-Infinity, '更早', 'Earlier']];
function stMapAge(t, now = Date.now()) {            // which stretch of time a conversation's last exchange falls in
  if (now - t < ST_MAPAGES[0][0]) return 0;
  const day = d => new Date(d).setHours(0, 0, 0, 0), days = Math.round((day(t) - day(now)) / 864e5);
  return ST_MAPAGES.findIndex(([d], i) => i && days >= d);
}
function stMapSelection(wins, recent, mode = ST.mapMode) {
  const pick = stFoldPick(recent);
  const groups = new Map(), collapsed = new Map();
  for (const w of wins) {
    const g = stGroupOf(w); if (!g || w.mini) continue;
    if (!groups.has(g.id)) groups.set(g.id, {g, wins: []});
    groups.get(g.id).wins.push(w);
  }
  for (const [id, group] of groups) if (group.wins.every(w => w.small)) collapsed.set(id, group.g);
  const selected = [];
  for (const w of wins) {
    // A line on the canvas has no slot (or hit target) in the top bar, nor has a branch tucked into its page.
    if (w.small || w.mini || w.branchDocked) continue;
    // Once the stage is drawn, only what stands open on it: a branch under a folded or tucked page is not there either.
    const at = ST.pos?.get(w.id); if (ST.pos && (!at || at.tab)) continue;
    let parent = w, hidden = false;
    for (let i = 0; mode !== 'time' && !w.tidyLinear && parent?.par && i < 50; i++) {
      parent = ST.nodes.find(n => n.id === parent.par);
      if (parent?.small || parent?.mini || parent?.kidsCollapsed || parent?.branchDocked) { hidden = true; break; }
    }
    if (!hidden && (w.memo || !pick.folded.has(mode === 'time' || w.tidyLinear ? w.id : stRootOf(w).id))) selected.push(w);
  }
  selected.sort(mode === 'time' ? stMapTimeOrder(recent) : stMapCategoryOrder(wins, recent));
  // Once drawn, the bar is the stage left to right (a stack of branches top to bottom), whatever the sort says.
  if (ST.pos) selected.sort((a, b) => { const p = ST.pos.get(a.id), q = ST.pos.get(b.id); return p.x - q.x || (p.y || 0) - (q.y || 0); });
  return { selected, collapsed, counts: pick.total, folded: pick.count };
}
// The bar as a picture of the stage: each column of the stage (a page, or a stack of branches) gets a slot as wide as
// the page, in proportion; what has no slot (folded lines, a folded category, the gaps) closes up to a hairline.
const ST_MAPGAP = 2;
function stMapColumns(wins) {
  const cols = []; let x = 0;
  for (const w of wins) {
    const p = ST.pos?.get(w.id), sx = p ? p.x : x, sw = Math.max(1, p ? p.w : ST_WW), last = cols[cols.length - 1];
    if (last && Math.abs(last.sx - sx) < 1) last.wins.push(w); else cols.push({ sx, sw, wins: [w] });
    x = sx + sw + ST_GAP;
  }
  return cols;
}
function stMapProject(cols, W) {
  const gap = cols.length > 1 ? Math.min(ST_MAPGAP, W / cols.length / 8) : 0, total = cols.reduce((t, c) => t + c.sw, 0);
  const k = Math.max(0, W - gap * (cols.length - 1)) / Math.max(1, total);
  let bx = 0;
  for (const c of cols) { c.bx = bx; c.bw = c.sw * k; bx += c.bw + gap; }
  return cols;
}
// A point of the stage on the bar, and back: in proportion inside a page; a gap between two pages, with whatever is
// folded in it, maps onto the hairline between their slots. Monotone, so the part you see is always one frame.
function stMapX(x, cols = ST.mapCols || []) {
  if (!cols.length || x <= cols[0].sx) return 0;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i], n = cols[i + 1], e = c.sx + c.sw;
    if (x <= e) return c.bx + (x - c.sx) / c.sw * c.bw;
    if (!n) return c.bx + c.bw;
    if (x < n.sx) return c.bx + c.bw + (x - e) / Math.max(1, n.sx - e) * (n.bx - c.bx - c.bw);
  }
  return 0;
}
function stMapSX(b, cols = ST.mapCols || []) {
  if (!cols.length) return 0;
  if (b <= cols[0].bx) return cols[0].sx;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i], n = cols[i + 1], e = c.bx + c.bw;
    if (b <= e) return c.sx + (b - c.bx) / Math.max(1e-6, c.bw) * c.sw;
    if (!n) return c.sx + c.sw;
    if (b < n.bx) return c.sx + c.sw + (b - e) / Math.max(1e-6, n.bx - e) * (n.sx - c.sx - c.sw);
  }
  return 0;
}
function stMapModeSet(mode) {                       // 分类 ⇄ 时间, kept across reloads
  mode = mode === 'time' ? 'time' : 'cat';
  const anchor = stAnchor();                         // the page you are on keeps its place on the screen
  // Preserve category order and parent relationships for the way back.
  if (mode === 'time' && ST.mapMode !== 'time') { for (const w of stWins()) w.catOrd = w.ord ?? 0; ST.mapMode = mode; stTimeSort(); }
  if (mode === 'cat' && ST.mapMode === 'time') {
    stWins().map((w, i) => ({ w, i })).sort((a, b) => (a.w.catOrd ?? 1e6 + a.i) - (b.w.catOrd ?? 1e6 + b.i)).forEach(({ w }, k) => { w.ord = k; delete w.catOrd; });
  }
  ST.mapMode = mode;
  try { localStorage.setItem('pga_map_mode', ST.mapMode); } catch {}
  ST.sortAnchor = anchor;
  stMapHideTip(); stRender(); stKeepAnchor(anchor); stSave();   // the stage itself takes the new order; the bar follows it
}
try { ST.mapMode = localStorage.getItem('pga_map_mode') === 'time' ? 'time' : 'cat'; } catch { ST.mapMode = 'cat'; }
function stMapOpenCategory(id) {
  const ws = stWins().filter(w => stGroupOf(w)?.id === id && !w.mini);
  if (!ws.length || ws.some(w => !w.small)) return;
  ST.foldCatIds ||= {};
  // The global minus remembers which pages were open; keep previously folded pages folded.
  const globalBack = (ST.foldAllIds || []).filter(key => ws.some(w => w.id === key));
  if (globalBack.length) ST.foldCatIds[id] = globalBack;
  // After a refresh the saved fold list may be absent; the category must still reopen.
  if (!ST.foldCatIds[id]?.some(key => ws.some(w => w.id === key))) ST.foldCatIds[id] = ws.map(w => w.id);
  stFoldCat(id);
  if (globalBack.length) {
    ST.foldAllIds = ST.foldAllIds.filter(key => !globalBack.includes(key));
    if (!ST.foldAllIds.length) delete ST.foldAllIds;
  }
}
// Use the full page as the reference for centring; give navigation a separate row when tools leave too little room.
try { ST.mapPosition = localStorage.getItem('pga_map_position') === 'bottom' ? 'bottom' : 'top'; } catch { ST.mapPosition = 'top'; }
function stMapPositionSet(position) {
  ST.mapPosition = position === 'bottom' ? 'bottom' : 'top';
  try { localStorage.setItem('pga_map_position', ST.mapPosition); } catch {}
  ST.mapDrag = null;
  stMapHideTip();
  stRender();
}
function stMapPositionApply(v) {
  const bottom = ST.mapPosition === 'bottom';
  v.classList.toggle('map-bottom', bottom);
  const button = v.querySelector('[data-stmapposition]');
  if (button) {
    button.textContent = bottom ? '↑' : '↓';
    button.title = bottom ? L('导航条移到顶部', 'Move navigation to top') : L('导航条移到底部', 'Move navigation to bottom');
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(bottom));
  }
}
function stToolbarVisibility(v, button, hidden) {
  v.classList.toggle('toolbar-hidden', hidden);
  button.textContent = hidden ? L('展开', 'Show') : L('收起', 'Hide');
  button.title = hidden ? L('展开导航栏', 'Show navigation bar') : L('收起导航栏', 'Hide navigation bar');
  button.setAttribute('aria-label', button.title);
  button.setAttribute('aria-expanded', String(!hidden));
}
function stMapLayout(m, v, cols = ST.mapCols || [], markCount = 0) {
  const vr = v.getBoundingClientRect();
  const centre = document.documentElement.classList.contains("file-docked") ? vr.left + vr.width / 2 : window.innerWidth / 2;
  const actions = v.querySelector('.stmapacts'), actionsWidth = actions?.getBoundingClientRect().width || 80;
  const rightTools = v.querySelector('#stbar')?.getBoundingClientRect();
  const edge = document.documentElement.classList.contains("deskapp") ? 128 : 14;
  // Settings and page selection stay at the left; everyday actions stay at the right.
  let lo = vr.left + edge + 36 + actionsWidth + 80;
  let hi = (rightTools?.left ?? vr.left + vr.width - 14) - 40;
  const compact = hi - lo < 240;
  v.classList?.toggle('map-stacked', compact);
  if (compact) { lo = vr.left + 78; hi = vr.left + vr.width - 40; }
  // Small windows give navigation its own row instead of shrinking it to nothing.
  const natural = cols.reduce((sum, c) => sum + c.sw / ST_WW * 96 + ST_MAPGAP, 0);
  const width = Math.max(0, Math.min(hi - lo, 960, Math.max(natural || 48, markCount * 20)));
  const left = Math.max(lo, Math.min(hi - width, centre - width / 2));
  m.style.width = width + "px";
  m.style.left = (left - vr.left) + "px";
  m.style.top = compact ? "42px" : "6px";
  if (actions) actions.style.left = (edge + 36) + "px";
}
const ST_MAPFOLD = 16;
const ST_MAPCTL = '[data-stmark], .stcategoryrow, [data-stmapmode], [data-stcatopen], [data-stfoldall], [data-stcatfold], [data-pjcategory], [data-pjnew], [data-pjmap], [data-stgroupfold], [data-stgroupsolo]';   // the bar's own controls: a press there is not a jump
function stMapBackgroundRuns(visible, wins, live) {
  const shown = new Set(visible.map(w => w.key));
  const keys = new Set(wins.filter(w => w.run && w.key).map(w => w.key));
  for (const [key, row] of live || []) if (row.running) keys.add(key);
  return [...keys].filter(key => !shown.has(key));
}
function stMap() {                                 // the minimap: every part of the row in miniature, and the part you see
  const a = $("#starena"), v = $("#vStage"); if (!a || !v || S.view !== "stage") return;
  let m = $("#stmap");
  if (!m) { v.insertAdjacentHTML("beforeend", `<div class="stmap" id="stmap"><div class="stmi" id="stmi"></div><div class="stmv" id="stmv"></div></div><button class="stlbar" id="stlbar" aria-controls="stlist" aria-expanded="${!!ST.listOpen}" aria-label="${L('设置与历史','Settings and history')}" title="${L('设置与历史','Settings and history')}">⚙</button><span class="stmapacts"><button type="button" class="stb stmapbtn" data-sttoolbar-toggle aria-controls="stmap stbar stlbar stpgb"></button><button class="stb stmapbtn stpgb" id="stpgb" data-pgopen title="${L("页面：整个台面的快照，保存、切换、管理", "Pages: snapshots of the whole stage — save, switch, manage")}"></button><button type="button" class="stb stmapbtn" data-stmapposition aria-label="${L('导航条移到底部', 'Move navigation to bottom')}">↓</button><button type="button" class="stb stmapbtn" id="stmarkdelete" hidden></button><details class="stbackgroundruns" hidden><summary></summary><div></div></details></span><div class="stmtip" id="stmtip" hidden></div>`); m = $("#stmap");
    v.querySelector('#stmarkdelete').addEventListener('click', stDeleteSelectedMark);
    const toggle = v.querySelector('[data-sttoolbar-toggle]');
    stToolbarVisibility(v, toggle, store.get('pga_stage_toolbar_hidden') === '1');
    toggle.addEventListener('click', () => {
      const hidden = !v.classList.contains('toolbar-hidden');
      if (hidden) {
        stMapHideTip();
        v.querySelector('.stbackgroundruns').open = false;
        if (ST.listOpen) stDropToggle(false);
      }
      stToolbarVisibility(v, toggle, hidden);
      store.set('pga_stage_toolbar_hidden', hidden ? '1' : '0');
    });
    m.addEventListener('click', e => {
      const button = e.target.closest('[data-stmark]');
      if (button) { e.stopPropagation(); stReturnToMark(ST.positionMarks[button.dataset.stmark]); }
    });
    m.addEventListener("pointerleave", () => { $("#stmtip").hidden = true; ST.mapHover = null; });
    m.addEventListener("wheel", (e) => {              // the wheel over the map: one page along per notch, faster as it spins
      e.preventDefault(); e.stopPropagation();
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX; if (!d) return;
      const now = performance.now(), fresh = now - (ST.wt || 0) > 150; ST.wt = now;
      if (fresh) { ST.wacc = 0; stStep(Math.sign(d)); return; }
      ST.wacc = (ST.wacc || 0) + d; if (Math.abs(ST.wacc) >= 60) { stStep(Math.sign(ST.wacc)); ST.wacc = 0; }
    }, { passive: false });
    m.addEventListener("pointerdown", (e) => { if (e.button !== 0) return; if (e.target.closest(ST_MAPCTL)) { stMapHideTip(); e.stopPropagation(); return; } stMapHideTip(); e.preventDefault(); e.stopPropagation(); try { m.setPointerCapture(e.pointerId); } catch {} ST.mapDrag = stMapDragStart(e.clientX); });
    m.addEventListener("pointermove", (e) => { if ((e.buttons & 2) || e.target.closest(ST_MAPCTL)) { stMapHideTip(); return; } if (ST.mapDrag) { stMapGo(e.clientX); return; } stMapTip(e.clientX, e.clientY); });
    const end = (e) => { if (e.type === "pointerup" && e.button !== 0) return; const d = ST.mapDrag; ST.mapDrag = null;
      if (e.type !== "pointerup" || !d || d.moved || e.target.closest(ST_MAPCTL)) return;   // a drag carried the stage: it stays where you let go
      const hit = stMapHit(e.clientX, e.clientY)?.w;
      if (hit) stMapNavigate(hit.id);
    }; m.addEventListener("pointerup", end); m.addEventListener("pointercancel", end);
    v.querySelector(".stbackgroundruns").addEventListener("click", e => {
      const button = e.target.closest("[data-running-key]");
      if (button) { e.currentTarget.open = false; stOpen(button.dataset.runningKey); }
    });
    window.pgBtn?.(); }
  stPanelTools();
  // Restore the pre-October-30 top bar: map and tools are separate stage children.
  stMapPositionApply(v);
  const settingsButton = $("#stlbar"); if (settingsButton) {
    settingsButton.textContent = "⚙";
    settingsButton.title = L("设置与历史", "Settings and history");
    settingsButton.setAttribute("aria-label", settingsButton.title);
    settingsButton.setAttribute("aria-controls", "stlist");
    settingsButton.setAttribute("aria-expanded", String(!!ST.listOpen));
  }
  for (const control of [v.querySelector(".stmapacts"), m, $("#stbar")])
    if (control && control.parentElement !== v) v.appendChild(control);
  $("#sttoolbar")?.remove();
  const recent = new Map(recentItems().map(x => [x.item, x]));
  const stageWins = stWins();
  const selection = stMapSelection(stageWins, recent);
  ST.mapWins = selection.selected;                   // only what stands open on the stage has a slot, in the stage's order
  window.stPmUpdateProjects?.(stageWins, ST.mapWins, recent);
  const chats = new Map((S.chats || []).map(c => [c.key, c]));
  const titles = new Map();
  for (const n of ST.nodes) if (n.key && n.title && !titles.has(n.key)) titles.set(n.key, n.title);
  const titleFor = key => key ? recent.get(key)?.title || chats.get(key)?.title || titles.get(key) || key : L("新对话", "New chat");
  const background = stMapBackgroundRuns(ST.mapWins, stWins(), ST.liveByKey);
  const indicator = v.querySelector(".stbackgroundruns");
  if (indicator) {
    indicator.hidden = !background.length;
    if (!background.length) indicator.open = false;
    else {
      indicator.querySelector("summary").textContent = L("运行中 ", "Running ") + background.length;
      const menu = indicator.querySelector("div");
      const items = background.map(key => `<button type="button" data-running-key="${esc(key)}">${esc(titleFor(key))}</button>`).join("");
      if (menu._items !== items) { menu.innerHTML = items; menu._items = items; }
    }
  }
  const cols = stMapColumns(ST.mapWins);
  const marks = Object.values(ST.positionMarks || {});
  const targets = new Map();
  for (const mark of marks) {
    const n = stMarkNode(mark);
    let slot = stMarkSlot(n);
    const folded = n && (!slot || n.small || n.mini || slot.tab || ST.foldPositions?.has(n.id));
    if (n) {
      for (const parent of stMarkAncestors(n)) {
        if (slot) break;
        slot = stMarkSlot(parent);
      }
      mark.key ||= n.key;
      mark.id = n.id; mark.page = PG.cur;
      if (slot) { mark.x = slot.x + slot.w / 2; mark.y = slot.y; }
    }
    targets.set(mark, {n, slot, folded});
  }
  if (marks.length) { stNumberAutoMarks(marks, targets); stSavePositionMarks(); }
  stMapLayout(m, v, cols, marks.length);
  const W = m.clientWidth || 1, k = 1, H = m.clientHeight || 30;   // slots are placed in the bar's own pixels
  ST.mapCols = stMapProject(cols, W);
  ST.mapPos = new Map();
  for (const c of cols) for (const w of c.wins) { const p = ST.pos?.get(w.id); ST.mapPos.set(w.id, p?.kid ? { x: c.bx, w: c.bw, kid: true, y: p.y, h: p.h } : { x: c.bx, w: c.bw }); }
  $("#stmi").style.width = W + "px";
  m.scrollLeft = 0;
  const box = (x, w, cls, title = "") => `<i class="${cls}" style="left:${(x * k).toFixed(1)}px;width:${Math.max(2, w * k).toFixed(1)}px" title="${esc(title)}"></i>`;

  let h = "";
  // Spread nearby labels just enough to keep each number individually clickable.
  // Marks on another saved page sit at the right end until that page is opened.
  let foldedHtml = '';
  const foldedLabels = [];
  const labels = marks.map(mark => {
    const {n, slot, folded} = targets.get(mark);
    const elsewhere = mark.page !== PG.cur;
    const closed = !n && !elsewhere;
    const mapSlot = n && ST.mapPos.get(n.id);
    const x = elsewhere ? W : mapSlot ? mapSlot.x + mapSlot.w / 2 : stMapX(mark.x);
    const title = L(`对话标记 ${mark.digit}`, `Conversation mark ${mark.digit}`) + ' · ' +
      (n ? stNodeTitle(n) : mark.title) + (closed ? L(' · 点击重新打开', ' · Click to reopen') : '');
    if (slot && folded) {
      // Neighbouring folded lines can be narrower than a number. Stagger their buttons.
      let y = slot.y;
      while (foldedLabels.some(p => Math.abs(p.x - mark.x) < 20 && Math.abs(p.y - y) < 16)) y += 16;
      foldedLabels.push({x:mark.x, y});
      foldedHtml += `<button type="button" class="st-fold-mark" data-stfoldmark="${mark.digit}" title="${esc(title)}" aria-label="${esc(title)}" style="left:${mark.x}px;top:${y}px">${mark.digit}</button>`;
    }
    return {digit:mark.digit, x, title, closed};
  }).sort((a, b) => a.x - b.x || Number(a.digit) - Number(b.digit));
  let foldedLayer = $('#stfoldmarks');
  if (foldedHtml && !foldedLayer) {
    $('#stbars').insertAdjacentHTML('beforeend', '<div id="stfoldmarks"></div>');
    foldedLayer = $('#stfoldmarks');
  }
  if (foldedLayer && foldedLayer._html !== foldedHtml) {
    foldedLayer.innerHTML = foldedHtml; foldedLayer._html = foldedHtml;
  }
  const step = Math.min(20, W / Math.max(1, labels.length));
  let next = step / 2;
  for (const [i, label] of labels.entries()) {
    const right = W - (labels.length - i - 0.5) * step;
    const left = Math.max(next, Math.min(label.x, right));
    next = left + step;
    h += `<button type="button" class="st-position-mark${label.closed ? ' closed' : ''}" data-stmark="${label.digit}" title="${esc(label.title)}" aria-label="${esc(label.title)}" style="left:${left}px;width:${step}px">${label.digit}</button>`;
  }
  const SEQ = stTalkOrder(ST.mapWins, recent); ST.seq = SEQ;
  const SS = stStat(), IH = Math.max(1, $("#stmi")?.clientHeight || H - 8), fitted = new Set(), lifted = new Map();   // a branch's band too thin for a line of text: its stack gets one label, over its whole height
  for (const w of ST.mapWins) { const p = ST.mapPos.get(w.id); if (!p) continue; const g = stGroupOf(w), s = SS.get(w.id);
    if (w._mapCategory) {
      const cat = w._mapCategory;
      h += `<button class="mcatcollapsed" data-stcatopen="${esc(cat.id)}" style="left:${(p.x * k).toFixed(1)}px;width:${Math.max(3, p.w * k).toFixed(1)}px;--wc:${cat.c}" title="${esc(cat.name)}" aria-label="${esc(L('展开分类：', 'Open category: ') + cat.name)}"></button>`;
      continue;
    }
    const band = stMapBand(p), bh = band.height * IH, fits = !p.kid || bh >= 9;
    if (p.kid) h += `<span class="mbranch" style="top:${band.top * 100}%;height:${band.height * 100}%">`;
    h += box(p.x, p.w, (p.tab ? "mtab" : w.mini ? "mmini" : "mpage") + (w.id === ST.focus ? " on" : "") + (g ? " mws" : "") + (s?.run ? " run" : ""), (w.pad ? L("计划", "Plans") : w.knowledge ? knowledgeTitle(w) : w.memo ? memoNodeTitle(w) : w.file ? w.title : titleFor(w.key)) + (g ? " · " + g.name : "")).replace("style=\"", g ? `style="--wc:${g.c};` : "style=\"");
    const dr = !w.pad && !w.memo && !w.knowledge && !s?.run ? stDraft(w) : "";
    let lab = "";
    if (dr) lab = `<span class="mdraft" style="left:${(p.x * k).toFixed(1)}px;width:${Math.max(0, p.w * k).toFixed(1)}px" title="${esc(dr)}">${esc(dr.slice(0, 120))}</span>`;
    if (!dr && !s?.run && !s?.num && !w.pad && !w.mini && w.key) { const it = recent.get(w.key), tt = titleFor(w.key) + (it?.last ? " · " + ago(it.last) : "") + (w.completedAt ? " · " + L("完成 ", "Done ") + stCompletionTime(w.completedAt) : "");   // the finish time lives in the tooltip: on the map it sat on top of the title
      lab = `<span class="mdraft mlabel" style="left:${(p.x * k).toFixed(1)}px;width:${Math.max(0, p.w * k).toFixed(1)}px" title="${esc(tt)}">${esc(tt)}</span>`; }
    if (w.memo || w.file) {
      const title = w.file ? `▤ ${w.title}` : memoNodeTitle(w);
      lab = `<span class="mdraft mlabel" style="left:${(p.x * k).toFixed(1)}px;width:${Math.max(0, p.w * k).toFixed(1)}px" title="${esc(title)}">${esc(title)}</span>`;
    }
    if (w.small && !dr) lab = "";                     // a folded sliver is too narrow for its title: the tooltip has it
    if (lab && w.id === ST.focus) lab = lab.replace('class="mdraft', 'class="mdraft page-focused');
    if (lab && fits) { h += p.kid ? lab.replace("style=\"", `style="--bh:${bh.toFixed(1)}px;`) : lab; if (p.kid) fitted.add(p.x); }
    else if (lab) { const r = (dr ? 2 : 0) + (w.id === ST.focus ? 1 : 0), o = lifted.get(p.x); if (!o || r > o.r) lifted.set(p.x, { r, lab }); }   // what you are typing first, then the one you are on
    if (s?.run && s.at) h += `<b class="mtime" data-runat="${s.at}" style="left:${((p.x + p.w / 2) * k).toFixed(1)}px">${stDur(Date.now() - s.at)}</b>`;
    const q = SEQ.get(w.id); if (q && !p.kid && ST.mapMode !== "time") h += `<b class="mseq${q.seq === 1 ? " last" : ""}" style="left:${(p.x * k + 2).toFixed(1)}px">${q.seq}</b>`;   // the order you talked to them: 1 the latest
    if (s?.num) h += `<b class="mnum" style="left:${((p.x + p.w / 2) * k).toFixed(1)}px">${s.num}</b>`;   // done, not seen yet: 1 the latest
    if (p.kid) h += `</span>`;
  }
  for (const [x, o] of lifted) if (!fitted.has(x)) h += o.lab;
  // Each caption sits exactly under its own slots (no measuring: it is cut to fit), and only what has a slot gets one.
  const under = (l, r) => { const width = (r - l) * k; return { style: `left:${(l * k).toFixed(1)}px;width:${width.toFixed(1)}px`, fit: width < 64 ? " tight" : width < 110 ? " mid" : "" }; };
  const byTime = ST.mapMode === "time";
  let row = "";
  if (byTime) {                                     // 按时间: newest first, each slot in its category's colour; the row names the stretch of time
    const now = Date.now(), ages = [];
    for (const w of ST.mapWins) { const p = ST.mapPos.get(w.id), g = stGroupOf(w), age = stMapAge(stMapTime(w, recent), now), last = ages[ages.length - 1];
      if (g) h += box(p.x + 3, p.w - 6, "mwsline", g.name).replace("style=\"", `style="--wc:${g.c};`);
      if (last?.age === age) last.r = p.x + p.w; else ages.push({ age, l: p.x, r: p.x + p.w }); }
    row = ages.map((a) => { const u = under(a.l, a.r), t = L(ST_MAPAGES[a.age][1], ST_MAPAGES[a.age][2]); return `<span class="stcategory stmapage${u.fit}" style="${u.style}" title="${esc(t)}"><span>${esc(t)}</span></span>`; }).join("");
  } else {
    const bands = stMapCategoryBands(cols);
    for (const g of bands) h += box(g.l, g.r - g.l, "mwsline", g.name).replace("style=\"", `style="--wc:${g.c};`);
    row = bands.map((g) => {
      const u = under(g.l, g.r), project = g.id.startsWith('pj:');
      const name = project
        ? `<button data-pjmap="${esc(g.id.slice(3))}">${esc(g.name)}</button>`
        : `<span>${esc(g.name)}</span>`;
      const add = project ? `<button data-pjnew="${esc(g.id.slice(3))}" aria-label="${L('新建对话','New conversation')}" title="${L('新建对话','New conversation')}">＋</button>` : '';
      return `<span class="pj-actions stcategory${u.fit}" style="--wc:${g.c};${u.style}"><button class="stcatmin" data-stcatfold="${esc(g.id)}" aria-label="${L('收起这个分类', 'Fold this category')}" title="${L('收起这个分类', 'Fold this category')}">－</button>${name}${add}</span>`;
    }).join("");
  }
  const modeTip = byTime ? L("顶部条按时间排：最近交流的在最左。点一下改回按分类", "The bar is by time, latest on the left. Click for by category") : L("顶部条按分类排。点一下改为按时间：最近交流的在最左", "The bar is by category. Click for by time, latest on the left");
  h += `<span class="stcategoryrow${byTime ? " bytime" : ""}">${row}</span><button class="stcategory-add stmapmode${byTime ? " on" : ""}" data-stmapmode="${byTime ? "cat" : "time"}" title="${modeTip}" aria-label="${modeTip}">${byTime ? L("时间", "Time") : L("分类", "Cat.")}</button>${(() => { const t = stFoldedAll() ? L('全部展开', 'Open everything') : L('全部折叠', 'Fold everything'); return `<button class="stcategory-add stfoldall${stFoldedAll() ? ' on' : ''}" data-stfoldall title="${t}" aria-label="${t}">${stFoldedAll() ? '＋' : '－'}</button>`; })()}<button class="stcategory-add" data-pjcategory title="${L('新增分区（带管理员）', 'Add a section (with its manager)')}" aria-label="${L('新增分区', 'Add section')}">＋</button>`;   // at the bar's right end
  const inner = $("#stmi"), changed = inner._mapHTML !== h;
  if (changed && inner.querySelector(".pjrename")) return;   // a category name being typed: leave the bar as it is until you are done
  if (changed) { inner.innerHTML = h; inner._mapHTML = h; }
  if (changed || inner._mapTop !== m.offsetTop) { stCategoryPlace(inner); inner._mapTop = m.offsetTop; }
  m.dataset.k = k; m.style.setProperty("--mh", H + "px"); m.classList.toggle("bytime", byTime);
  stMapView();
}
// A caption occupies one continuous stretch of the bar. Different categories
// stacked in the same column share its caption space from left to right.
function stMapCategoryBands(cols) {
  const bands = [];
  let last;
  for (const col of cols) {
    const categories = new Map();
    for (const w of col.wins) {
      const group = !w.mini && !w._mapCategory && stGroupOf(w);
      if (group) categories.set(group.id, group);
    }
    if (!categories.size) { last = null; continue; }
    const width = col.bw / categories.size;
    let left = col.bx;
    for (const group of categories.values()) {
      const right = left + width;
      if (last?.id === group.id) last.r = right;
      else { last = { ...group, l: left, r: right }; bands.push(last); }
      left = right;
    }
  }
  return bands;
}
function stCategoryPlace(inner) {
  // Captions are placed under their slots when drawn and cut to fit: measuring them into lanes made the
  // stage height and the captions oscillate as folded bands and controls changed width.
  for (const el of inner.querySelectorAll(".stcategoryrow > .stcategory")) {
    const label = el.querySelector("[data-pjmap], :scope > span");
    if (label) label.title = label.textContent;
  }
  const row = inner.querySelector(".stcategoryrow");
  if (row) row.style.height = row.children.length ? "22px" : "0px";
  const stage = inner.closest?.('#vStage');
  if (stage && row && ST.mapPosition !== 'bottom') {
    const bottom = Math.ceil(row.getBoundingClientRect().bottom - stage.getBoundingClientRect().top + 2);
    if (stage.style.getPropertyValue('--stmap-bottom') !== bottom + 'px') stage.style.setProperty('--stmap-bottom', bottom + 'px');
  }
}
// Use the same vertical projection for drawing and pointer targeting.
function stMapBand(p) {
  const height = Math.max(1, $("#starena")?.clientHeight || 1);
  return p.kid ? { top: p.y / height, height: p.h / height } : { top: 0, height: 1 };
}
function stMapHit(cx, cy) {
  const m = $("#stmap"), inner = $("#stmi"); if (!m || !inner) return null;
  const k = Number(m.dataset.k) || 1, r = m.getBoundingClientRect(), ir = inner.getBoundingClientRect();
  const x = (cx - r.left + m.scrollLeft) / k, y = cy == null ? null : (cy - ir.top) / Math.max(1, ir.height);
  for (const w of (ST.mapWins || stWins())) {
    const p = (ST.mapPos || ST.pos)?.get(w.id); if (!p || x < p.x || x > p.x + p.w) continue;
    const band = stMapBand(p);
    if (p.kid && y != null && (y < band.top || y > band.top + band.height)) continue;
    return { w, p };
  }
  return null;
}
function stMapHideTip() {
  globalThis.historyPreview?.closeFor($("#stmap"));
  const tip = $("#stmtip"); if (tip) tip.hidden = true;
  ST.mapHover = null;
}
function stProjectJump(project, cx, cy) {
  stMapHideTip();
  const hit = stMapHit(cx, cy)?.w;
  const matches = w => stGroupOf(w)?.id === 'pj:' + project;
  const target = hit && matches(hit) ? hit : stWins().find(matches);
  if (target) stMapNavigate(target.id);
}
function stMapTip(cx, cy) {                           // over the map: the page there, by name, with a picture of it as it is now
  if (ST.rightPan || ST.frameMoving || ST.navigation || ST.drag || ST.pan) { stMapHideTip(); return; }
  const m = $("#stmap"), tip = $("#stmtip"); if (!m || !tip) return;
  if (document.querySelector('.modal') || (cy != null && document.elementFromPoint(cx, cy)?.closest(ST_MAPCTL))) { stMapHideTip(); return; }
  const k = Number(m.dataset.k) || 1, r = m.getBoundingClientRect(), x = (cx - r.left) / k;
  const hit = stMapHit(cx, cy);
  if (!hit) { stMapHideTip(); return; }
  if (hit.w.key && !hit.w.file && !hit.w.memo && !hit.w.pad && !hit.w.knowledge) {
    tip.hidden = true;
    historyPreview.show(m, hit.w.key, {title:stNodeTitle(hit.w), x:cx});
    return;
  }
  historyPreview.closeFor(m);
  const id = hit.w.id;
  tip.style.left = Math.max(8, Math.min(innerWidth - 268, cx - 130)) + "px";
  const bottom = ST.mapPosition === 'bottom';
  tip.style.top = bottom ? 'auto' : r.bottom + 6 + 'px';
  tip.style.bottom = bottom ? Math.max(8, innerHeight - r.top + 6) + 'px' : 'auto';
  tip.hidden = false;
  if (ST.mapHover === id) return; ST.mapHover = id;
  const t = hit.w.pad ? L("计划", "Plans") : hit.w.knowledge ? knowledgeTitle(hit.w) : hit.w.memo ? memoNodeTitle(hit.w) : stNodeTitle(hit.w);
  const dr = !hit.w.pad && !hit.w.memo && !hit.w.knowledge ? stDraft(hit.w) : "";   // something typed: show just that, not the conversation behind it
  if (dr) { tip.innerHTML = `<b>${esc(t)}</b><div class="stmthumb"><div class="mt me">${esc(dr.slice(0, 400))}</div></div>`; return; }
  const q = ST.seq?.get(id), ask = stLastAsk(hit.w);
  tip.innerHTML = `<b>${q ? `#${q.seq} · ` : ""}${esc(t)}</b>${q || ask ? `<div class="stmask">${q ? L(`本项目内第 ${q.seq} 近和你说过话 · ${ago(new Date(q.at).toISOString())}`, `#${q.seq} most recent in this project · ${ago(new Date(q.at).toISOString())}`) : ""}${ask ? `<span>${L("你上次问：", "You last asked: ")}${esc(ask.slice(0, 160))}</span>` : ""}</div>` : ""}<div class="stmthumb" id="stmthumb"></div>`;
  try {                                           // a small picture of the page: its last few turns, as they stand
    const d = hit.w.el?.querySelector("iframe")?.contentDocument, ms = [...(d?.querySelectorAll("#cdlgIn .cmsg") || [])].slice(-4);
    if (!ms.length) throw 0;
    $("#stmthumb").innerHTML = ms.map((x) => `<div class="mt ${x.classList.contains("me") ? "me" : ""}">${esc((x.querySelector(".md, .body, .text")?.innerText || x.innerText || "").trim().slice(0, 140))}</div>`).join("");
  } catch { const b = $("#stmthumb"); if (b) b.innerHTML = `<div class="cvdim" style="padding:10px">${L("这一页还没打开", "Not opened yet")}</div>`; }
}
function stMapView() {
  const a = $("#starena"), m = $("#stmap"), b = $("#stmv"); if (!a || !m || !b) return;
  if (m.scrollLeft) m.scrollLeft = 0;
  // The bar is the stage in its own order, so what is on the screen is one stretch of it: one frame, the same share of
  // each slot as of its page, sliding as smoothly as the stage scrolls.
  const cols = ST.mapCols || [], l = stMapX(a.scrollLeft, cols), r = stMapX(a.scrollLeft + a.clientWidth, cols);
  if (!b._pgaMapReady) {
    b._pgaMapReady = true; b.style.left = '0px';
    m.querySelectorAll(".stmv.more").forEach((f) => f.remove());
  }
  if (b.hidden !== !cols.length) b.hidden = !cols.length;
  // Translate the single viewport marker without relaying out the map every frame.
  const transform = `translate3d(${l.toFixed(1)}px,0,0)`, width = Math.max(2, r - l).toFixed(1) + "px";
  if (b.style.transform !== transform) b.style.transform = transform;
  if (b.style.width !== width) b.style.width = width;
}
// Dragging along the bar carries the stage with it: the point of the stage under the pointer stays where you took
// hold of the frame (outside the frame: in the middle of the screen).
function stMapDragStart(cx) {
  const a = $("#starena"), m = $("#stmap"); if (!a || !m) return null;
  const bx = cx - m.getBoundingClientRect().left, sx = stMapSX(bx), sl = a.scrollLeft, W = a.clientWidth;
  return { x: cx, moved: false, at: sx >= sl && sx <= sl + W ? (sx - sl) / Math.max(1, W) : .5 };
}
function stMapGo(cx) {
  const d = ST.mapDrag, a = $("#starena"), m = $("#stmap"); if (!d || !a || !m) return;
  if (!d.moved && Math.abs(cx - d.x) < 4) return;
  d.moved = true; if (typeof stPmUser === "function") stPmUser(); stShiftStop(); if (stEdgeWheel.motion) { cancelAnimationFrame(stEdgeWheel.motion.frame); stEdgeWheel.motion = null; }
  const sx = stMapSX(cx - m.getBoundingClientRect().left), max = Math.max(0, a.scrollWidth - a.clientWidth);
  a.scrollTo({ left: Math.max(0, Math.min(max, sx - d.at * a.clientWidth)), behavior: "instant" });
  stMapView();
}
function stStep(dir) {                              // stop at either end; navigation never wraps
  // Along the bar as it is drawn: its order, and never onto a conversation folded off it.
  const ws = ST.mapWins?.length ? ST.mapWins : stWins().filter((w) => !w.mini); if (!ws.length) return;
  let i = ws.findIndex((w) => w.id === ST.focus);
  if (i < 0) {                                      // the page you were on folded: start from the one in the middle of the screen
    const a = $("#starena"), x = (a?.scrollLeft || 0) + (a?.clientWidth || 0) / 2;
    const off = (w) => { const p = ST.pos?.get(w.id); return p ? Math.max(0, p.x - x, x - p.x - p.w) : Infinity; };
    i = ws.reduce((best, w, j) => (off(w) < off(ws[best]) ? j : best), 0); dir = 0;
  }
  const n = ws[Math.max(0, Math.min(ws.length - 1, i + dir))];
  if (n.id === ST.focus) return;
  stFocus(n.id); stShow(n.id); stMap();
  const p = (ST.mapPos || ST.pos)?.get(n.id), m = $("#stmap"); if (p && m) stMapTip(m.getBoundingClientRect().left + (p.x + p.w / 2) * (Number(m.dataset.k) || 1));
}
// Navigation never reorders pages: the map keeps the same geometry at both ends.
function stEdgeWheel(dx, dy) {
  if (Math.abs(dx) <= Math.abs(dy) || ST.drag || ST.pan || ST.rz) return false;
  const a = $("#starena"); if (!a || S.view !== "stage") return false;
  const max = Math.max(0, a.scrollWidth - a.clientWidth); if (!max) return false;
  stShiftStop(); if (typeof stPmUser === "function") stPmUser();
  ST.movedAt = performance.now();
  // Accumulate precision-trackpad events without adding synthetic inertia.
  // Keep subpixel deltas until the next paint, including the final small tail.
  let m = stEdgeWheel.motion;
  if (!m || m.arena !== a) m = stEdgeWheel.motion = {arena:a, target:a.scrollLeft, last:a.scrollLeft, frame:0};
  if (a.scrollLeft !== m.last) m.target = a.scrollLeft;
  m.target = Math.max(0, Math.min(max, Math.max(0, Math.min(max, m.target)) + dx));
  if (!m.frame) m.frame = requestAnimationFrame(() => {
    m.frame = 0;
    if (stEdgeWheel.motion !== m || S.view !== "stage" || ST.drag || ST.pan || ST.rz) return;
    // A click or other navigation since the wheel event owns the new position.
    if (a.scrollLeft !== m.last) { m.target = m.last = a.scrollLeft; return; }
    const left = Math.max(0, Math.min(a.scrollWidth - a.clientWidth, m.target));
    if (left !== a.scrollLeft) a.scrollTo({left, behavior:"instant"});
    m.last = a.scrollLeft;
  });
  m.last = a.scrollLeft;
  return true;
}
window.stEdgeWheel = stEdgeWheel;
// Shift-wheel pans the stage from any window, including its embedded conversation.
// The stage follows the wheel's target on a critically damped spring: it eases in and out without overshoot, and
// notches in quick succession run together into one glide. A lone notch moves at least a tenth of the screen (macOS
// reports a slow notch as ~4px); a stream of events (trackpad, free-spinning wheel) keeps its own distances.
let stShiftMotion = null, stGlideFrame = 16.7;     // the frame interval glides have been getting, smoothed
let stGlideLast = {at:-Infinity, stream:false};      // the last event, outliving a glide that settled between two of them
function stShiftStop() {
  if (typeof stNavigationStop === "function") stNavigationStop();
  if (stShiftMotion) { cancelAnimationFrame(stShiftMotion.frame); stGlideEnd(); }
}
window.stShiftStop = stShiftStop;
function stGlideEnd() {
  stShiftMotion = null; ST.movedAt = performance.now();
  $("#vStage")?.classList?.remove("gliding");
  if (typeof stScheduleFrameLoads === "function") stScheduleFrameLoads();
}
function stGlide(a, px, kind) {                      // send the stage px further along; one glide per gesture
  const now = performance.now(); ST.movedAt = now;
  // A gesture has one owner. A queued ordinary swipe must not run after this takes over.
  if (stEdgeWheel.motion) {
    cancelAnimationFrame(stEdgeWheel.motion.frame); stEdgeWheel.motion = null;
    stGlideLast = {at:-Infinity, stream:false};
  }
  let m = stShiftMotion;
  if (!m || m.arena !== a || m.kind !== kind || Math.abs(a.scrollLeft - m.last) > 2) {
    stShiftStop();
    // Cancel click-navigation's native smooth scroll before taking wheel ownership.
    a.scrollTo?.({left:a.scrollLeft, behavior:"instant"});
    m = stShiftMotion = {arena:a, kind, target:a.scrollLeft, x:a.scrollLeft, v:0, last:a.scrollLeft, direction:0, frame:0, time:0, at:stGlideLast.at, boost:0, stream:stGlideLast.stream};
    $("#vStage")?.classList?.add("gliding");
  }
  if (typeof stPmUser === "function") stPmUser();
  const dir = Math.sign(px), gap = now - m.at; m.at = now;
  // Reversal discards the old tail immediately.
  if (dir !== m.direction) { m.target = m.x; m.v = 0; m.boost = 0; }
  m.direction = dir;
  // Trackpads send an event a frame; a slow app delivers them a frame apart all the same, so measure in frames.
  // A busy paint can delay one trackpad event. Once a stream is established,
  // wait for a genuine pause before magnifying a small delta into a wheel notch.
  if (gap < Math.max(m.stream ? 110 : 40, stGlideFrame * 1.6)) {
    if (!m.stream) { m.target -= m.boost; m.boost = 0; }
    m.stream = true;
  } else {
    const step = Math.max(80, Math.min(140, a.clientWidth / 10));
    m.stream = false; m.boost = Math.abs(px) < step ? dir * step - px : 0; px += m.boost;
  }
  m.target = Math.max(0, Math.min(Math.max(0, a.scrollWidth - a.clientWidth), m.target + px));
  stGlideLast = {at:now, stream:m.stream};
  if (!m.frame) m.frame = requestAnimationFrame(stGlideStep);
  return true;
}
function stShiftWheel(e) {
  const a = $("#starena"), right = ST.rightPan;
  if (right?.dragOnly) return true;
  if (right?.moved && ST.pan && !e.ctrlKey && !e.metaKey) stPanEnd();
  if (!(e.shiftKey || right) || e.ctrlKey || e.metaKey || !a || S.view !== "stage" || ST.drag || ST.pan || ST.rz || ST.branchResize) {
    if (stShiftMotion?.kind !== "strip" || ST.drag || ST.pan || ST.rz || ST.branchResize) stShiftStop();
    return false;
  }
  // WebKit/Chromium may already translate Shift-wheel to deltaX. Never add both.
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  const scale = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? a.clientWidth : 1;
  if (!delta) return true;
  if (right && !right.wheeled) {
    right.wheeled = true; right.menu = null;
    document.querySelector?.('.stmenu')?.remove();
  }
  return stGlide(a, delta * scale, "shift");
}
function stGlideStep(now) {
  const m = stShiftMotion; if (!m) return;
  m.frame = 0;
  const a = m.arena;
  // A click or other navigation since the last frame owns the new position.
  if (S.view !== "stage" || ST.drag || ST.pan || ST.rz || ST.branchResize || !a.isConnected || Math.abs(a.scrollLeft - m.last) > 2) { stGlideEnd(); return; }
  m.target = Math.max(0, Math.min(Math.max(0, a.scrollWidth - a.clientWidth), m.target));
  if (m.time) stGlideFrame += (Math.min(100, now - m.time) - stGlideFrame) * .3;
  const dt = (m.time ? Math.min(50, Math.max(1, now - m.time)) : 16.7) / 1000; m.time = now;
  // Exact step of x'' = -w²(x - target) - 2w·x': stable at any frame rate, settles in ~0.3 s (a stream: ~0.13 s).
  const w = m.stream ? 45 : 20, e0 = m.x - m.target, c = m.v + w * e0, k = Math.exp(-w * dt);
  let e = (e0 + c * dt) * k; m.v = (m.v - w * c * dt) * k;
  const done = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || (Math.abs(e) < .5 && Math.abs(m.v) < 30);
  if (done) e = 0;
  m.x = m.target + e;
  a.scrollLeft = m.x; m.last = a.scrollLeft; ST.movedAt = now;
  // Scroll listeners already batch the minimap and overlay once per frame.
  if (done) stGlideEnd(); else m.frame = requestAnimationFrame(stGlideStep);
}
window.stShiftWheel = stShiftWheel;
// The desktop's isolated reader is a sibling native view, outside this DOM.
// Its trusted event monitor forwards only explicit stage-navigation gestures.
window.stNativeWheel = function (data) {
  if (!data || S.view !== 'stage' || !(data.shiftKey || data.rightButton) || data.ctrlKey || data.metaKey
    || !Number.isFinite(data.deltaX) || !Number.isFinite(data.deltaY)) return false;
  return stShiftWheel({deltaX:data.deltaX, deltaY:data.deltaY, deltaMode:[0,1,2].includes(data.deltaMode) ? data.deltaMode : 0,
    shiftKey:true, ctrlKey:false, metaKey:false});
};
// Letting go of Shift lets the glide settle where the wheel sent it; a press or leaving the app stops it there.
// Pointer events stay inside the iframe under them: release its parent's motion too.
function stShiftRelease() {
  stShiftStop();
  try { if (window.parent !== window) window.parent.stShiftStop?.(); } catch {}
}
document.addEventListener("pointerdown", stShiftRelease, true);
window.addEventListener("blur", stShiftRelease);
document.addEventListener("visibilitychange", () => { if (document.hidden) stShiftRelease(); });
// Top and bottom strips turn an ordinary wheel into fast horizontal canvas travel, on the same glide.
function stBoundaryWheel(e, y = e.clientY) {
  const v = $("#vStage"), a = $("#starena");
  if (!v || !a || S.view !== "stage" || ST.drag || ST.pan || ST.rz || e.ctrlKey) return false;
  // Horizontal swipes follow the horizontal scroller, including over the edge strips.
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return false;
  const r = v.getBoundingClientRect();
  if (y < r.top || y > r.bottom || (y > r.top + 44 && y < r.bottom - 28)) return false;
  const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (!d || a.scrollWidth <= a.clientWidth) return false;
  const scale = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? a.clientWidth : 2.5;
  return stGlide(a, d * scale, "strip");
}
window.stBoundaryWheel = stBoundaryWheel;

function stRefresh() {
  stSave();
  if (typeof pgLocalSave === "function") pgLocalSave();
  window.location.reload();
}
function stMorePlace() {
  const details = $("#stmore"), trigger = details?.querySelector("summary"), panel = $("#stmoremenu");
  if (!details?.open || !trigger || !panel) return;
  const r = trigger.getBoundingClientRect(), box = panel.getBoundingClientRect(), width = box.width || 218, height = Math.min(innerHeight - 16, box.height || panel.scrollHeight || 360);
  panel.style.left = Math.max(8, Math.min(innerWidth - width - 8, r.right - width)) + "px";
  panel.style.top = (r.bottom + height + 8 <= innerHeight ? r.bottom + 6 : Math.max(8, r.top - height - 6)) + "px";
}
function stMoreClose(restoreFocus = false) {
  const details = $("#stmore"); if (!details?.open) return false;
  details.open = false;
  const trigger = details.querySelector("summary"); trigger?.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger?.focus();
  return true;
}
function stBar() {
  const bar = $("#stbar"); if (!bar) return;
  bar.innerHTML = `<span class="cvdim">${L("从接点拉线：卡片连进窗口，窗口右边连到另一个窗口左边 · 点线断开 · 放不下的收成横向标签", "Pull wires from the pins: a card into a window, one window's right into another's left · click a wire to cut it · what does not fit becomes tabs")}</span>
    <span class="grow"></span><button type="button" class="sm" data-st="refresh" aria-label="${L('刷新界面', 'Reload interface')}" title="${L('刷新界面', 'Reload interface')}"><svg class="st-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M12.9 6.2a5.1 5.1 0 1 0 .15 3.3M13 2.7v3.7H9.3"/></svg></button><button type="button" class="sm" data-st="new"><svg class="st-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8 3v10M3 8h10"/></svg>${L("新对话", "New chat")}</button>
      <button type="button" class="sm" data-st="models">${L("模型与 API", "Models & API")}</button>
    <details class="stmore" id="stmore"><summary class="sm" aria-label="${L("更多工具", "More tools")}" aria-haspopup="true" aria-controls="stmoremenu" aria-expanded="false" title="${L("更多工具", "More tools")}"><svg class="st-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M3 8h.15M8 8h.15M13 8h.15" stroke-width="2.5"/></svg></summary><div class="cvpal cvmenu stmore-menu" id="stmoremenu" aria-label="${L("更多工具", "More tools")}">
      <button class="sm" data-act="tomorrowplan">${L("列明日计划", "Plan tomorrow")}</button>
      ${typeof memoBtns === "function" ? memoBtns() : ""}
      <button type="button" class="sm" data-staddmenu>＋ ${L("添加节点", "Add node")}</button>
      <button type="button" class="sm" data-browser-new>↗ ${L("打开网页", "Open a web page")}</button>
      <hr data-more-sep>
      <button class="sm" data-stsync title="${L("导入本机其他应用的对话", "Import conversations from other apps on this machine")}">↻ ${L("导入", "Import")}</button>
      <button class="sm" data-pjpicker>${L("项目 ＋", "Project +")}</button>
      <hr data-more-sep>
      <button class="sm strefresh-icon" data-st="refresh" aria-label="${L('刷新界面', 'Reload interface')}" title="${L("刷新界面（⌘R / Ctrl+R）", "Reload interface (⌘R / Ctrl+R)")}">↻ ${L("刷新", "Refresh")}</button>
    </div></details>`;
  const more = $("#stmore"), trigger = more?.querySelector("summary");
  const menu = $("#stmoremenu"), allMemos = menu?.querySelector('[data-memo="list"]'), netTest = menu?.querySelector("[data-nettest]");
  if (allMemos) allMemos.textContent = `📝 ${L("所有备忘", "All memos")}`;
  if (netTest) { netTest.textContent = `🌐 ${L("网络测试", "Network test")}`; const lastSep = menu.querySelectorAll("[data-more-sep]")[1]; if (lastSep) menu.insertBefore(netTest, lastSep.nextSibling); }
  more?.addEventListener("toggle", () => { trigger?.setAttribute("aria-expanded", String(more.open)); if (more.open) stMorePlace(); });
}

/* ------------------------------------------------ pointer */
function stCap(e, target = $("#starena")) { try { target.setPointerCapture(e.pointerId); } catch {} }
function stResizeEnd(pointerId) {
  const r = ST.rz;
  if (!r || (pointerId != null && r.pointerId != null && pointerId !== r.pointerId)) return false;
  ST.rz = null;
  $("#vStage")?.classList.remove("dragging", "resizing");
  try { const target = r.capture || $("#starena"); if (target?.hasPointerCapture?.(r.pointerId)) target.releasePointerCapture(r.pointerId); } catch {}
  stSave();
  return true;
}
function stBind() {
  const v = $("#vStage"), arena = $("#starena");
  const dockSpace = target => v.classList.contains('map-bottom') && target.matches('.stcornerdrag, .stdockdrag, #stbar, .stmapacts');
  const nativeWindow = () => window.PGA_NATIVE?.float === false && window.webkit?.messageHandlers?.pga;
  // The map, captions, menus and buttons own their gestures. Only the gaps act as a title bar.
  v.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.defaultPrevented || !dockSpace(e.target)) return;
    // The installed desktop bridge already handles double-clicks along the top edge.
    if (e.detail === 2 && e.clientY < 30 && e.target.matches('.stcornerdrag')) return;
    const bridge = nativeWindow();
    if (!bridge || (e.detail !== 1 && e.detail !== 2)) return;
    e.preventDefault();
    bridge.postMessage({kind:e.detail === 2 ? 'zoom' : 'drag'});
  });
  const startGroundPan = e => {
    if (e.isPrimary === false || ST.pan || ST.rz || ST.drag) return;
    e.preventDefault(); stPanStart(e.screenX, e.pointerId); stCap(e, arena);
  };
  v.addEventListener('pointerdown', e => {
    if (e.button === 0 && dockSpace(e.target) && !(e.pointerType === 'mouse' && nativeWindow())) startGroundPan(e);
  });
  stMiddlePanBind(arena);
  stPageClickBind(arena, e => {
    const el = e.target.closest(".stnode.t-win");
    return el && ST.nodes.find(n => n.id === el.dataset.nid);
  }, () => getSelection());
  v.addEventListener("wheel", (e) => {
    if (e.target.closest?.("#stmore, #stlist")) return;
    if (stShiftWheel(e) || stBoundaryWheel(e)) { e.preventDefault(); e.stopPropagation(); }
  }, { passive: false, capture: true });
  arena.addEventListener("wheel", (e) => {
    // The arena itself is a native overflow scroller. Only embedded documents
    // need to forward their deltas across a document boundary.
    if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      stPmUser();
      stGlideLast = {at:-Infinity, stream:false};
    }
  }, { passive: true });
  arena.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });          // no autoscroll circle
  arena.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
  arena.addEventListener("pointerdown", (e) => {
    const ground = e.target === arena || ["stnodes", "stbars", "stwires"].includes(e.target.id) || e.target.classList?.contains("stground");
    if (e.button === 0 && ground) { startGroundPan(e); return; }
    if (e.button !== 0) return; document.querySelector(".stmenu")?.remove();
    const split = e.target.closest('[data-stsplit]');
    if (split) {
      const top = ST.nodes.find(n => n.id === split.dataset.stsplit), bottom = ST.nodes.find(n => n.id === split.dataset.stbelow);
      if (!top || !bottom) return;
      for (const k of stKids(ST.nodes.find(n => n.id === top.par))) k.branchWeight = ST.pos.get(k.id)?.h || 1;
      ST.branchResize = {top, bottom, topHeight: top.branchWeight, bottomHeight: bottom.branchWeight, y: e.clientY};
      e.preventDefault(); v.classList.add('dragging', 'resizing'); stCap(e); return;
    }
    const pin = e.target.closest(".stin, .stout, .stpin"); if (pin && stWireStart(e, pin)) { stCap(e); return; }
    const rz = e.target.closest("[data-rz]");
    if (rz) { e.preventDefault(); window.getSelection()?.removeAllRanges();     // no selecting the page while you pull an edge
      const n = ST.nodes.find((x) => x.id === rz.closest(".stnode").dataset.nid), el = rz.closest(".stnode"), l = parseFloat(el.style.left);
      const d = rz.dataset.rz;
      if (ST.rz || (n.screenPin && d !== "e")) return;
      stReorderStop();
      if (n.screenPin) {
        ST.rz = {n, d, pointerId:e.pointerId, capture:rz, x:e.clientX, w0:el.getBoundingClientRect().width};
      } else {
        ST.rz = { n, d, pointerId:e.pointerId, capture:rz, x: e.clientX, y: e.clientY, w0: n.mini || n.par ? el.offsetWidth : n.bw || el.offsetWidth, h0: el.offsetHeight, t0: parseFloat(el.style.top), l0: l,
          edge: d.includes("e") ? l : l + el.offsetWidth,
          open: new Map((ST.units || []).map((u) => [u.kind + (u.win?.id || ""), u.open])) };   // the edge that stays
        if (!n.mini) { ST.rz.off0 = stLayout().off; ST.rz.across = stEdgeHold(n.id, d); ST.rz.pre0 = n.pre || 0; }
      }
      // Capture on the handle so click/double-click still target that handle.
      v.classList.add("dragging", "resizing"); stCap(e, rz); return; }
    if (e.target.closest("button, summary, .chat-action-menu, textarea, input, iframe, [data-doc], [data-stunfold]")) return;
    const el = e.target.closest(".stnode"); if (!el) return;
    const n = ST.nodes.find((x) => x.id === el.dataset.nid); if (!n || n.max || (n.type === "win" && !e.target.closest(".stwh"))) return;
    if (e.target.closest(".stwt, .memot")) { stFocus(n.id); return; } // selecting a title must not start a drag or capture its pointer
    if (n.screenPin) { stFocus(n.id); return; }
    if (n.par) { stFocus(n.id); if (n.type === "win") { ST.pull = { n, x0: e.clientX, y0: e.clientY, sx: e.screenX, sy: e.screenY, gx: e.clientX - el.getBoundingClientRect().left }; stCap(e, e.target.closest(".stwh")); } return; }   // A click focuses; a deliberate title drag detaches it into its own column.
    if (n.type === "win") stFocus(n.id); stGrab(n, e.screenX, e.screenY, e.clientX - el.getBoundingClientRect().left);
    // Capture on the header so the synthesized click still identifies its window.
    stCap(e, e.target.closest(".stwh") || arena);
  });
  arena.addEventListener("pointermove", (e) => {
    if (ST.branchResize) { stResizeBranchPair(ST.branchResize, e.clientY - ST.branchResize.y); stRender(); return; }
    if (ST.pull) {
      const p = ST.pull;
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 12) return;
      ST.pull = null; stDetachBranch(p.n); stGrab(p.n, p.sx, p.sy, p.gx); stDragSoon(e.screenX, e.screenY); return;
    }
    if (ST.pan) { if (ST.pan.pointerId == null || ST.pan.pointerId === e.pointerId) stPanMove(e.screenX); return; }
    if (ST.rz) { const r = ST.rz;
      if (r.pointerId != null && e.pointerId !== r.pointerId) return;
      const dx = e.clientX - r.x, dy = e.clientY - r.y, A = stArena();
      if (r.n.screenPin) {
        const count = stWins().filter(n => n.screenPin && !n.small).length;
        const width = Math.min(A.w / Math.max(1, count), Math.max(ST_MINW, r.w0 + dx));
        if (width !== ST.pos.get(r.n.id)?.w) {
          r.n.screenPin.resizedWidth = width;
          stPinPlace(arena);
        }
        return;
      }
      if (r.n.mini) {                                // a small page: any edge or corner, the opposite one staying put
        if (r.d.includes("e") || r.d.includes("w")) { const w = Math.round(Math.max(200, Math.min(A.w - 16, r.w0 + (r.d.includes("e") ? dx : -dx))));
          r.n.mw = w; r.n.fx = (r.d.includes("w") ? r.l0 + r.w0 - w : r.l0) / A.w; }
        if (r.d.includes("n") || r.d.includes("s")) { const h = Math.round(Math.max(140, Math.min(A.h - 16, r.h0 + (r.d.includes("s") ? dy : -dy))));
          r.n.mh = h; r.n.fy = (r.d.includes("n") ? r.t0 + r.h0 - h : r.t0) / A.h; }
        stRender(); return;
      }
      if (r.d.includes("e") || r.d.includes("w")) {
        stResizeIntoGap(r, dx, Math.max(320, A.w - 80));
        stRender();
        if (r.scrollTarget != null) { stScrollTo(r.scrollTarget); stMapView(); }
      }
      return; }
    if (ST.wire) { const r = arena.getBoundingClientRect(); ST.wire.x = e.clientX - r.left + stSL(); ST.wire.y = e.clientY - r.top; stWires(); return; }
    if (ST.drag) stDragSoon(e.screenX, e.screenY);
  });
  arena.addEventListener("pointerup", (e) => {
    if (ST.branchResize) { ST.branchResize = null; v.classList.remove('dragging', 'resizing'); stSave(); return; }
    if (ST.pull) { ST.pull = null; return; }
    if (ST.pan) { if (ST.pan.pointerId == null || ST.pan.pointerId === e.pointerId) stPanEnd(); return; }
    if (ST.wire) { stWireEnd(e.clientX, e.clientY); return; }
    if (ST.rz) { stResizeEnd(e.pointerId); return; }
    stDragFlush(); const d = stDrop(); if (d && !d.moved && d.n.type === "conv") stOpen(d.n.key, { win: d.n.win });

    else if (d && !d.moved && d.el.classList.contains("tab") && d.n.win) stFocus(d.n.win, true);
  });
  arena.addEventListener("pointercancel", (e) => {
    if (ST.pan?.pointerId === e.pointerId) { stPanEnd(); return; }
    if (stResizeEnd(e.pointerId)) return;
    if (ST.drag?.dock) { stDockCancel(); return; }
    ST.pull = null;
    if (ST.branchResize) { ST.branchResize = null; v.classList.remove('dragging', 'resizing'); stSave(); }
    if (ST.drag) { stDragFlush(); stDrop(); }
  });
  arena.addEventListener("lostpointercapture", e => {
    if (e.target === arena && ST.pan?.pointerId === e.pointerId) stPanEnd();
    if (e.target === (ST.rz?.capture || arena)) stResizeEnd(e.pointerId);
  });
  const endGroundGesture = () => { if (ST.pan?.pointerId != null) stPanEnd(); stResizeEnd(); };
  window.addEventListener("blur", endGroundGesture);
  document.addEventListener("visibilitychange", () => { if (document.hidden) endGroundGesture(); });
  arena.addEventListener("click", (e) => {   // window whitespace: double-click 0.5 of the stage, triple-click 0.9
    if (e.detail < 2) return;
    const win = e.target.closest(".stwin"), hn = win && ST.nodes.find((x) => x.id === win.closest(".stnode")?.dataset.nid);
    const readingTitle = hn?.readingKey && e.target.closest(".stwh .stwt");
    if (!readingTitle && e.target.closest(ST_DBL_SKIP + ", [data-rz]")) return;
    if (hn?.type === "win") stClickSize(hn, e, getSelection());
  });
  arena.addEventListener("dblclick", (e) => {   // resize handles: double-click resets the size
    const title = e.target.closest(".stwh .stwt, .stwh .memot");
    if (title && ST.nodes.find(n => n.id === title.closest(".stnode")?.dataset.nid)?.readingKey) { e.preventDefault(); return; }
    if (title) { const range = document.createRange(); range.selectNodeContents(title); const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(range); return; }
    const win = !e.target.closest(ST_DBL_SKIP + ", [data-rz]") && e.target.closest(".stwin");
    const hn = win && ST.nodes.find((x) => x.id === win.closest(".stnode")?.dataset.nid);
    if (hn?.type === "win" && !hn.mini) return;   // sized by the click handler above
    const rz = e.target.closest("[data-rz]"); if (!rz) return;
    const n = ST.nodes.find((x) => x.id === rz.closest(".stnode").dataset.nid); if (!n) return;
    if (n.screenPin) { delete n.screenPin.resizedWidth; stPinPlace(arena); stSave(); return; }
    if (n.mini) { delete n.mw; delete n.mh; }
    else {
      const up = n.par && ST.nodes.find((x) => x.id === n.par);
      if (up) delete up.kw; else { delete n.bw; delete n.pre; }
      for (const page of up ? stKids(up) : [n]) { delete page.big; delete page.fullscreen; delete page.bigWidth; }
    }
    ST.shift = null; stRender(); stSave();
  });
  arena.addEventListener("input", (e) => { const t = e.target.closest("[data-stnote]"); if (!t) return; const n = ST.nodes.find((x) => x.id === t.dataset.stnote); if (n) { n.text = t.value; stContexts(); } });
}
document.addEventListener("click", (e) => {
  if (S.view === "stage") {
    const inMore = e.target.closest?.("#stmore");
    if (!inMore) stMoreClose();
    else if (e.target.closest?.("#stmoremenu button")) queueMicrotask(() => stMoreClose(!!document.activeElement?.closest?.("#stmoremenu")));
  }
  if (S.view !== "stage") return;
  if (!e.target.closest(".stmenu")) document.querySelector(".stmenu")?.remove();
  if (e.target.closest("[data-staddmenu]")) { stAddMenu($("#stmore summary")); return; }
  const ws = e.target.closest("[data-stws]"); if (ws) { const m = ws.closest(".stmenu"), n = ST.nodes.find((x) => x.id === m.dataset.nid), op = ws.dataset.stws; m.remove(); if (!n) return;
    if (op === "rename") { const w = stWs(n), t = w && prompt(L("这个工作区叫什么？", "Name this workspace"), w.name); if (t?.trim()) { w.name = t.trim().slice(0, 40); stRender(); stSave(); } return; }
    stWsJoin(n, op === "out" ? null : op); return; }
  const fk = e.target.closest("[data-stfork]"); if (fk) { const m = fk.closest(".stmenu"), n = ST.nodes.find((x) => x.id === m.dataset.nid); m.remove(); if (n) stFork(n, fk.dataset.stfork); return; }
  const add = e.target.closest("[data-stadd]"); if (add) { const m = add.closest(".stmenu"), at = JSON.parse(m.dataset.at); m.remove(); stAdd(add.dataset.stadd, at); return; }
  const sy = e.target.closest("[data-stsync]"); if (sy) { stSync(sy); return; }
  if (e.target.closest("[data-stlistmin]")) { stDropToggle(false, true); return; }
  if (e.target.closest("#stlbar")) { stDropToggle(); return; }
  const foldedMark = e.target.closest('[data-stfoldmark]');
  if (foldedMark) { stReturnToMark(ST.positionMarks[foldedMark.dataset.stfoldmark]); return; }
  const linePreview = e.target.closest('.stfoldline[data-stunfold]');
  if (linePreview) { const n = ST.nodes.find(n => n.id === linePreview.dataset.stunfold); if (n) stOpenCollapsed(n, linePreview); return; }
  const uf = e.target.closest("[data-stunfold]"); if (uf) { const id = uf.dataset.stunfold; if (id === "shelf") { const w = stWins(); for (const o of w) o.bw = Math.min(o.bw || ST_WW, ST_WW); } else stFocus(id, true); return; }
  const cut = e.target.closest("[data-unlink]"); if (cut) { const [to, from, pin] = cut.dataset.unlink.split("|"), w = ST.nodes.find((x) => x.id === to); if (w) w.links = (w.links || []).filter((l) => !(l.from === from && l.pin === Number(pin))); stRender(); stSave(); stContexts(); return; }
  const del = e.target.closest("[data-stdel]"); if (del) { ST.nodes = ST.nodes.filter((x) => x.id !== del.dataset.stdel); stRender(); stSave(); stContexts(); return; }
  const preview = e.target.closest('[data-stpreview]');
  if (preview) { const n = ST.nodes.find(n => n.id === preview.dataset.stpreview); if (n) stOpenCollapsed(n, preview); return; }
  if (e.target.closest('[data-stfoldall]')) { stMapHideTip(); stFoldAll(); return; }
  const position = e.target.closest('[data-stmapposition]'); if (position) { e.preventDefault(); e.stopPropagation(); stMapPositionSet(ST.mapPosition === 'bottom' ? 'top' : 'bottom'); return; }
  const mm = e.target.closest('[data-stmapmode]'); if (mm) { stMapModeSet(mm.dataset.stmapmode); return; }
  const co = e.target.closest('[data-stcatopen]'); if (co) { e.preventDefault(); stMapHideTip(); stMapOpenCategory(co.dataset.stcatopen); return; }
  const cf = e.target.closest('[data-stcatfold]'); if (cf) { stMapHideTip(); stFoldCat(cf.dataset.stcatfold); return; }
  const cat = e.target.closest('[data-stcat]');
  if (cat) { stMapHideTip(); stMapOpenCategory(cat.dataset.stcat); return; }
  const expand = e.target.closest('[data-stexpand]');
  if (expand) { const n = ST.nodes.find(n => n.id === expand.dataset.stexpand); if (n) stOpenCollapsed(n, expand); return; }
  const restore = e.target.closest('[data-strestore]');
  if (restore) { const child = ST.nodes.find(n => n.id === restore.dataset.strestore), parent = ST.nodes.find(n => n.id === child?.par);
    if (parent && child) stToggleChatBranch(parent, child.key); return; }
  const w = e.target.closest("[data-stw]"); if (w) { const n = ST.nodes.find((x) => x.id === w.closest(".stnode").dataset.nid); if (!n) return;
    if (w.dataset.stw === "global") { e.preventDefault(); e.stopPropagation(); stDropToggle(); return; }
    if (w.dataset.stw === "manager") { e.preventDefault(); e.stopPropagation(); pmPanelStageOpen(n.id, true); return; }
    if (w.dataset.stw === "retry") { stFrameRetry(n); return; }
    if (w.dataset.stw === "pin") { stPinToggle(n); return; }
    if (w.dataset.stw === "parent") { stParentDialog(n); return; }
    if (w.dataset.stw === "project") { pjAssignDialog(n.key, w); return; }
    if (w.dataset.stw === "back") { stGoBack(n); return; }
    if (w.dataset.stw === "ws") { stWsMenu(w, n); return; }
    if (w.dataset.stw === "branchLayout") { stToggleBranchLayout(n); return; }
    if (w.dataset.stw === "layer") { stToggleLayer(n); return; }
    if (w.dataset.stw === "knowledge") {
      const cw=n.el?.querySelector('iframe')?.contentWindow;
      if(cw?.knowledgeToggle) cw.knowledgeToggle();
      return;
    }
    if (w.dataset.stw === "fork") { stFork(n); return; }
    if (w.dataset.stw === "side") {
      const cw = n.el?.querySelector('iframe')?.contentWindow;
      const managerOpen = cw?.document.getElementById('vChats')?.classList.contains('manager-side-open');
      if (managerOpen) cw.pmPanelClose?.(false);
      n.side = managerOpen || n.side === false;
      w.classList.toggle("on", n.side); stSide(n); stSave(); return;
    }
    if (w.dataset.stw === "min") { stMini(n, !n.small); } else if (w.dataset.stw === "close") stClose(n); else stMax(n, !n.fullscreen); return; }
  const t = e.target.closest("[data-st]");
  if (t?.dataset.st === "refresh") { stRefresh(); return; }
  if (t?.dataset.st === "models") openModelSettings();
  if (t?.dataset.st === "new") stOpen(null);
});
document.addEventListener("keydown", (e) => {
  if (S.view !== "stage" || e.key !== "Escape") return;
  if (ST.listOpen) { stDropToggle(false, true); e.preventDefault(); e.stopImmediatePropagation(); return; }
  if (stMoreClose(true)) { e.preventDefault(); e.stopImmediatePropagation(); return; }
  clearTimeout(stSizeTimer); stSizeTimer = null; const n = ST.nodes.find((x) => x.big); if (n) stMax(n, false);
});

/* a new window that is asked something right away (the plan page): type it into its composer and send */
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
  const k = Q.get("item"), t0 = setInterval(() => { if (S.booted && k.startsWith('c:')) { clearInterval(t0); openFound(k, k.slice(2)); }
    else if (typeof recentItems === "function" && recentItems().some((y) => y.item === k)) { clearInterval(t0); openItem(k); } }, 400);
  setTimeout(() => clearInterval(t0), 20000);
}

if (Q.get("embed") && window.parent !== window) {
  const _oft = openFromTree;
  openFromTree = async function (n, el) { try { if (n.ref && window.parent.stOpen) { window.parent.stOpen(n.ref); return; } } catch {} return _oft(n, el); };
}

// CSS hides the stage without changing the child documents' visibilityState.
function stPauseMountedFrames() {
  clearTimeout(stFrame.timer);
  for (const n of ST.nodes) {
    const f = n.el?.querySelector("iframe");
    if (!f) continue;
    if (f._pgaInView) f._pgaSeenAt = performance.now();
    f._pgaInView = false;
    try { if (f.contentWindow?.S) f.contentWindow.S.stageDormant = true; } catch {}
  }
}
document.addEventListener("visibilitychange", () => {
  if (S.view !== "stage") return;
  if (document.hidden) stPauseMountedFrames(); else stScheduleFrameLoads(0);
});

/* ------------------------------------------------ into the app */
const _showST = show;
show = function (view, opts) {
  if (view !== "stage" && ST.overview) window.stDockCancel?.();
  if (view === "stage") { S.view = "stage"; closeCtx?.(); ["Home", "Tree", "Chats", "Notes", "Looks", "Graph"].forEach((v) => { const el = $("#v" + v); if (el) el.hidden = true; }); $("#vStage").hidden = false; history.replaceState(null, "", qs()); renderRail(); showStage(); return; }
  if (S.view === "stage") stPauseMountedFrames();
  const st = $("#vStage"); if (st) st.hidden = true; return _showST(view, opts);
};
/* 返回: leaving the stage for the world tree (or another page) leaves a way back to the conversation you were on */
const _showBK = show;
show = function (view, opts) {
  if (view !== "stage" && S.view === "stage" && !Q.get("embed")) ST.back = { focus: ST.focus };
  if (view !== "stage") {
    const foot = document.querySelector("#sttoolsbody > .foot"), rail = document.querySelector(".app > .rail");
    if (foot && rail) rail.appendChild(foot);
  }
  const r = _showBK(view, opts); stBackBtn(view);
  document.querySelector(".app")?.classList.toggle("onstage", view === "stage"); stOver?.(); return r;
};
function stBackBtn(view) {
  document.querySelector("#stBack")?.remove();
  if (view === "stage" || Q.get("embed") || (!ST.back && view !== "looks")) return;   // 外观社区 opened by its own URL still gets a way back
  const w = ST.back && ST.nodes.find((n) => n.id === ST.back.focus), t = w ? (w.file ? w.title : stTitle(w.key)) : "";
  const b = document.createElement("button"); b.id = "stBack"; b.className = "sm stback";
  b.textContent = L("← 返回对话", "← Back to the conversation") + (t ? `「${t.slice(0, 24)}」` : "");
  b.addEventListener("click", () => { const f = ST.back?.focus; ST.back = null; show("stage"); if (f && ST.nodes.some((n) => n.id === f)) stFocus(f, true); });
  document.body.appendChild(b);
}
/* 外观社区 from the settings menu: switch views in place, so the stage (and the way back to it) stays */
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a.lkgo"); if (!a || Q.get("embed") || e.metaKey || e.ctrlKey || e.shiftKey) return;
  e.preventDefault(); a.closest(".shell-pop")?.setAttribute("hidden", ""); show("looks");
}, true);
if (Q.get("embed") && window.parent !== window) {   // inside a page: wheel gestures reach the surrounding stage
  document.addEventListener("wheel", (e) => {        // a sideways swipe reaches the stage unless a local control handles it
    if (e.ctrlKey || e.metaKey || e.target.closest?.(".pmviewport")) return;
    try {
      if (window.parent.stShiftWheel?.(e)) { e.preventDefault(); e.stopPropagation(); return; }
      const frame = window.frameElement;
      if (frame && (e.clientY <= 44 || e.clientY >= innerHeight - 28) && window.parent.stBoundaryWheel?.(e, frame.getBoundingClientRect().top + e.clientY)) {
        e.preventDefault(); e.stopPropagation(); return;
      }
    } catch {}
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    for (let el = e.target; el && el.nodeType === 1; el = el.parentElement) if (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(el).overflowX)) return;
    try { if (window.parent.stEdgeWheel?.(e.deltaX, e.deltaY)) e.preventDefault(); } catch {}
  }, { passive: false, capture: true });
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

window.addEventListener('pga:palette', () => { if (S.view === 'stage') stRender(); });

// In a standalone conversation, delay its own right-click actions too. Embedded
// documents are bound by the owning stage so a drag can cross window boundaries.
if (window === window.top) stRightPanBind(document, null, target => S.view === 'stage'
  ? target.closest?.('#vStage')
  : target.closest?.('[data-railfork], [data-tline], [data-ts], [data-tnode], [data-ctxnode]'));

for (const event of ['wheel','pointerdown','keydown']) document.addEventListener(event, () => {
  clearTimeout(ST.sortAlignTimer); ST.sortAlignTimer = null;
}, {capture:true,passive:true});
