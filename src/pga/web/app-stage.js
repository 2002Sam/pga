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
const ST_GAP = 18, ST_CW = 190, ST_CH = 78, ST_WW = 660, ST_TAB = 150, ST_TH = 30, ST_PADX = 12, ST_LW = 224;
const ST_SMALL = 320;                               // the width of a narrowed page: smallish, still a whole page
const ST_MINI = { w: 300, h: 210 };                 // a window made small (–): a little page you can pull to any size
const ST_T = {
  world: ["世界知识", "World knowledge", "#6fa8ff"], self: ["自我知识", "Self knowledge", "#e9b35f"], note: ["笔记", "Note", "#a1a1aa"],
  skill: ["技能", "Skill", "#e9b35f"], doc: ["资料", "Document", "#7fcf9f"], file: ["文件", "File", "#5fc9c0"], conv: ["对话", "Conversation", "#8fb4ff"],
  topic: ["世界树主题", "Topic", "#d6a75c"], win: ["对话窗口", "Window", "#8fb4ff"] };
const ST_PIN = (n) => (["conv", "topic"].includes(n.type) ? 0 : n.type === "skill" ? 2 : 1);      // which input: conversations, data, skills
const ST_PINS = [["对话引用", "Conversations"], ["数据引用", "Data"], ["技能引用", "Skills"]];
const ST_OUTS = [["拉线：把这段对话问过的交给另一个窗口", "Pull a wire: what was asked here, into another window"], ["拉线：把这段对话读过、改过的交给另一个窗口", "Pull a wire: what this conversation read and changed"], ["拉线：把这段对话用过的技能交给另一个窗口", "Pull a wire: the skills this conversation used"]];
const stTitle = (key) => (key ? recentItems().find((x) => x.item === key)?.title || S.chats?.find((c) => c.key === key)?.title || ST.nodes.find((n) => n.key === key && n.title)?.title || key : L("新对话", "New chat"));   // a copy not asked anything yet: the name it came with
const stId = () => Math.random().toString(36).slice(2, 9);
const stSL = () => $("#starena")?.scrollLeft || 0;             // the stage scrolls sideways: arena coordinates include it
const stArena = () => { const a = $("#starena"); return a ? { w: a.clientWidth, h: a.clientHeight } : { w: 1000, h: 700 }; };
// Two new conversations fit side by side, allowing for the stage margins and gap.
const stHalfWidth = () => Math.min(Math.max(1, stArena().w - 2 * ST_PADX), Math.max(ST_SMALL, Math.floor((stArena().w - 2 * ST_PADX - ST_GAP) / 2)));
const stWins = () => ST.nodes.filter((n) => n.type === "win").sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
function stSave() { if (!$("#vStage")?.dataset.ready) return;   // a conversation's own page (the frame in a window) runs this file too: only the stage writes the stage
  try { localStorage.setItem("pga_st4", JSON.stringify({ v: 5, nodes: ST.nodes.map(({ max, sent, run, el, ...n }) => n), ws: ST.ws })); } catch {} }
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
    if (!old || r.started > old.started) byKey.set(key, r);
  }
  ST.liveByKey = byKey;
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
    && (n.mini || (p.x >= a.scrollLeft - 4 && p.x + p.w <= a.scrollLeft + a.clientWidth + 4));
}
function stStat() {                                  // page id and conversation key → { run } or { num }
  const out = new Map();
  stWins().filter((w) => w.done).sort((a, b) => b.done - a.done).forEach((w, i) => out.set(w.id, { num: i + 1 }));
  for (const w of stWins()) if (w.run) out.set(w.id, { run: true, at: w.runAt });
  for (const w of stWins()) if (w.key && out.has(w.id)) out.set(w.key, out.get(w.id));
  return out;
}
const stDraft = (n) => { try { return (n.el?.querySelector("iframe")?.contentDocument?.querySelector("#chatText")?.value || "").trim(); } catch { return ""; } };   // typed, not sent yet
const stDur = (ms) => { const t = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(t / 60); return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}` : `${m}:${String(t % 60).padStart(2, "0")}`; };
setInterval(() => document.querySelectorAll("[data-runat]").forEach((e) => { e.textContent = stDur(Date.now() - Number(e.dataset.runat)); }), 1000);   // how long a page has been answering
setInterval(() => {
  let changed = false, sent = false;
  // A map click/pan can leave DOM focus in the previous iframe. Status polling
  // must never turn that stale browser focus back into a navigation command.
  for (const n of stWins()) if (n.done && !n.run && stSeen(n)) { delete n.done; changed = true; }   // finished, and now in front of you: its number goes
  for (const n of stWins()) { if (n.pad || n.memo || n.knowledge) continue; const b = stBusy(n);
    if (b === !!n.run) continue; changed = true; n.run = b;
    if (b) { delete n.done; n.runAt = ST.liveByKey?.get(n.key)?.started * 1000 || Date.now(); sent = true; } else { n.completedAt = ST.liveByKey?.get(n.key)?.finished * 1000 || Date.now(); if (!stSeen(n)) n.done = n.completedAt; } }
  const sig = stWins().map((n) => (n.pad || n.memo || n.knowledge ? "" : stDraft(n))).join("\u0001");
  const typed = sig !== ST.draftSig; ST.draftSig = sig;
  if (sent) { stInputs(true); setTimeout(() => stInputs(true), 1500); }   // you just sent something: "what I typed" gets it now, not a minute later
  if (changed) { stSave(); stRender(); stMap(); stListItems(); for (const n of stWins()) if (n.par && n.el) stKidLook(n.el, n); }
  else if (typed) stMap();                         // only something typed: the drafts are drawn on the map alone (redrawing the stage and the list on every pause in your typing is what made it lag)
}, 800);

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
    ST.ws = saved?.ws || {};
    if (saved && saved.v !== 5) for (const w of ST.nodes) if (w.type === "win") { delete w.bw; delete w.pre; }   // narrowed by the old fit-the-screen rule: natural again
    if (!ST.nodes.some((n) => n.pad) && store.get("pga_pad_off") !== "1") ST.nodes.push(stPadNode(-1));       // the notepad is a page here
    ST.focus = stWins()[0]?.id || null;
    stBind(); new ResizeObserver(() => stRender()).observe($("#starena"));
  }
  stBar(); stRender(); stContexts();
}
function stDefault() {                            // one window, the latest conversation, with world and self knowledge wired in
  recentItems().slice(0, 1).forEach((r, i) => ST.nodes.push({ id: stId(), type: "win", key: r.item, ord: i, bw: stHalfWidth() }));
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
  const head = e.querySelector(".stwh"); if (!head || n.pad || n.memo || n.knowledge) return;
  let b = head.querySelector('[data-stw="back"]');
  if (!b) { b = document.createElement("button"); b.className = "stb stwback"; b.dataset.stw = "back"; b.textContent = "‹"; head.prepend(b); }
  const t = stPrev(n); b.hidden = !t;
  if (t) b.title = L("回到之前的对话", "Back to the conversation before") + (t.key ? `「${stTitle(t.key).slice(0, 40)}」` : "");
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
    delete k.branchWeight;
  }
  ST.shift = null; stRender(); stSave();
  // Keep the changed group visible, rather than leaving its old horizontal offset.
  stShow(children[0].id);
}
function stBranchUnits(par, kids) {
  const groups = par.branchLayout === "column" ? [kids] : kids.map(k => [k]);
  return groups.map(wins => ({kind:"stack", par, wins, nodes:wins, w:par.kw || ST_WW, open:true}));
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
  const width = ST.pos?.get(n.id)?.w || parent.kw || ST_WW;
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
  let dock = e.querySelector('.stbranchdock');
  const kids = (n.kids || []).map(id => ST.nodes.find(x => x.id === id)).filter(k => k?.type === 'win');
  if (!kids.length) { dock?.remove(); return; }
  if (!dock) { dock = document.createElement('div'); dock.className = 'stbranchdock'; e.appendChild(dock); }
  const html = kids.map((k, i) => {
    const opened = !k.branchDocked && !n.kidsCollapsed;
    const status = k.run ? L('正在回答', 'Answering') : k.done ? L('已完成', 'Finished') : opened ? L('已展开', 'Expanded') : L('已收起', 'Minimized');
    const label = (opened ? L('收起子对话：', 'Collapse branch: ') : L('打开子对话：', 'Open branch: ')) + stTitle(k.key) + ' · ' + status;
    const color = railPairColor(k.key);
    return `<button style="--branch-color:${esc(color)}" class="stbranchdot${opened ? ' on' : ' collapsed'}${k.run ? ' run' : k.done ? ' done' : ''}" aria-expanded="${opened}" data-strestore="${esc(k.id)}" title="${esc(label)}" aria-label="${esc(label)}"><span aria-hidden="true"></span></button>`;
  }).join('');
  if (dock.innerHTML !== html) dock.innerHTML = html;
}
const ST_KSCROLL = new Map();                        // where a branch was reading when it folded
function stKidKeep(k, folding) {                     // folding: remember where it was; opening: back there once it has its height
  const box = () => { try { return k.el?.querySelector("iframe")?.contentDocument?.querySelector("#cdlg"); } catch { return null; } };
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
window.stBranchAt = async (n, from, upto) => {
  try {
    const r = await api(`/v1/users/${S.uid}/chats/branch`, {body:{from, upto}});
    n.el?.querySelector("iframe")?.contentWindow?.chatBranchCreated?.(from, r, upto);
    const child = stOpen(r.key, {win:n.id});
    Object.assign(child,{branchFrom:from,branchPoint:r.upto ?? upto,branchKey:r.key,from,title:r.title || child.title}); stSave();
    n.el?.querySelector("iframe")?.contentWindow?.convMap?.();
    stWires();
  } catch (err) { toast(err.message); }
};
// Opening an existing conversation from a branch tick changes only its view, never forks it again.
function stToggleChatBranch(parent, key, info = {}) {
  if (!parent || !key || key === parent.key) return;
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
  if (fresh) stAttach(parent, [child]);
  else {
    parent.kids = [...new Set([...(parent.kids || []), child.id])];
    stFocus(child.id, true); stSave(); stShow(child.id);
  }
}
window.stToggleChatBranch = stToggleChatBranch;
function stAttach(n, made) {                        // branch windows made: they stand to the right of this one, the first in front
  if (!n.kids?.length && !n.kw) n.kw = stHalfWidth();
  ST.nodes.push(...made); n.kids = [...(n.kids || []), ...made.map((x) => x.id)]; n.sel = made[0].id; delete n.kidsCollapsed;
  for (let c = n, up; c.par && (up = ST.nodes.find((x) => x.id === c.par)); c = up) up.sel = c.id;   // the way to them is the chosen one all along
  try { const cw = n.el?.querySelector('iframe')?.contentWindow; cw?.convMap?.(); cw?.loadChat?.(n.key); } catch {}
  ST.focus = made[0].id; stRender(); stSave(); stContexts(); stShow(made[0].id);
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

/* ------------------------------------------------ the notepad (常驻笔记) is a page of the stage, not a sidebar: a window
   whose content is the notepad itself (app-pad.js), moved in and out of it */
const stPadNode = (ord) => ({ id: "pad", type: "win", pad: true, ord, bw: 320 });
function stPadIn(e) {
  const p = $("#pad"), box = e.querySelector(".stpadbox"); if (!p || !box) return;
  box.appendChild(p); if (typeof PAD === "object") { PAD.open = true; padLayout?.(); }
}
function stPadOut() {                               // the page closed: the notepad waits, unseen, until it is a page again
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
  const n = w.managerProject || assigned || pjName(recentItems().find((y) => y.item === w.key) || (w.from && recentItems().find((y) => y.item === w.from)) || {});   // a copy: with what it was copied from
  return { id: "pj:" + n, name: n.split("/").filter(Boolean).pop() || n, c: `hsl(${hueOf(n)} 62% 60%)` };
};
const stGroupOf = w => {
  const g = stGroupRaw(w);
  return g ? {...g, c: ST.groupColors?.get(g.id) || g.c} : null;
};
window.stProjectColor = key => { const n = ST.nodes.find(n => n.key === key); return n ? stGroupOf(n)?.c : null; };
function stGroupPalette(groups, visible) {
  const byId = new Map(groups.map(g => [g.id,g])), neighbors = new Map([...byId.keys()].map(id=>[id,new Set()]));
  for (const row of [groups,visible]) {
    const ids=row.map(g=>g.id).filter((id,i,all)=>i===0||id!==all[i-1]);
    for(let i=1;i<ids.length;i++){neighbors.get(ids[i])?.add(ids[i-1]);neighbors.get(ids[i-1])?.add(ids[i]);}
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
  return new Map([...hues].map(([id,h])=>[id,`hsl(${h} 72% 60%)`]));
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
function stGroupGather() {
  if (ST.drag) return false;
  const ws = stWins(), first = new Map(), at = new Map();
  ws.forEach((w, i) => { const g = stGroupOf(w)?.id || w.id; if (!first.has(g)) first.set(g, i); at.set(w, first.get(g)); });
  let moved = false;
  // Keep established positions within each category, including freshly inserted conversations.
  ws.map((w, i) => ({ w, i })).sort((a, b) => at.get(a.w) - at.get(b.w) || a.i - b.i).forEach(({ w }, k) => { if (w.ord !== k) { w.ord = k; moved = true; } if (w.overviewOrder != null && w.overviewOrder !== k) { w.overviewOrder = k; moved = true; } });
  return moved;
}
function stWsLook(e, n) {                           // a page's head in its workspace's colour
  const w = stWs(n), b = e.querySelector('[data-stw="ws"]');
  const g = stGroupOf(n); if (g) e.style.setProperty("--wc", g.c); else e.style.removeProperty("--wc"); e.classList.toggle("inws", !!w); e.classList.toggle("ingrp", !w && !!g);
  if (b) b.title = w ? L(`工作区「${w.name}」· 点一下换或移出`, `Workspace “${w.name}” · click to change or leave`) : L("放进一个工作区", "Put it in a workspace");
}

/* ------------------------------------------------ the layout: a row that always fits the screen */
const ST_MINW = 300, ST_FIT = 560;                  // the least a page gets from an edge or a squeeze; the least it gives to fit the screen
const stDock = (n) => ["world", "self"].includes(n.type) && n.fx == null;    // world and self knowledge live in the 所有对话 panel
function stPanel() {                                // 所有对话: a panel of its own — docked at the left of the row, or wherever you dragged it
  if (!ST.lp) { try { ST.lp = JSON.parse(localStorage.getItem("pga_st_lp") || "null"); } catch {} ST.lp = ST.lp || {}; ST.listOpen = false; ST.lp.open = false; }
  return ST.lp;
}
// Attach document units after their source's visible column, before any deeper branches.
// Group/date sorting must not separate a knowledge page from its conversation.
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
  const wins = all.filter((w) => !w.mini && !w.par);   // small pages float, outside the row; branches stand in their parent's tree
  ST.nodes = ST.nodes.filter((n) => !n.rail || ids.has(n.win));                                   // a wire from the history column goes with its window
  for (const n of ST.nodes) if (n.type !== "win" && n.win && !ids.has(n.win)) n.win = null;       // its window is gone: unwired
  for (const w of wins) if (w.links) w.links = w.links.filter((l) => ids.has(l.from) && l.from !== w.id);
  const shelf = ST.nodes.filter((n) => n.type !== "win" && !n.win && !n.rail && !stDock(n));
  const units = [];                                 // 所有对话 is a sidebar outside the stage: the stage itself moves over for it
  if (shelf.length) units.push({ kind: "shelf", nodes: shelf, w: ST_CW, open: true });
  for (const w of wins) { const col = ST.nodes.filter((n) => n.win === w.id && !n.rail && !stDock(n)); units.push({ kind: "col", win: w, nodes: col, w: ST_CW, open: true, hide: !col.length }); units.push({ kind: "win", win: w, w: w.bw || ST_MINW, open: true, flex: !w.bw && !w.big });
    for (let p = w, kids = stKids(w); kids.length && !p.kidsCollapsed; p = kids.find((k) => k.id === p.sel) || kids[0], kids = stKids(p))   // its branches, one above another; then the branches of the one you chose
      units.push(...stBranchUnits(p, kids)); }
  if (!all.some(n => n.overviewOrder != null)) stKnowledgeUnits(units);
  for (const u of units) if (u.win ? stGroupHidden(u.win) : u.par ? stGroupHidden(u.par) : !!ST.groupSolo) u.hide = true;
  // Nothing is squeezed or folded to fit the screen: a page keeps its width, and what does not fit runs on to the right —
  // the stage scrolls sideways. A page you did not size starts at ST_WW (never wider than the screen); while the row is
  // a little too wide those pages give, down to ST_FIT, and while there is room to spare they share it.
  const colOpen = (w) => units.some((c) => c.kind === "col" && c.win === w && !c.hide && c.open);
  const preOf = (u) => (u.kind === "stack" ? Math.min(u.par.branchGap ?? ST_FORKGAP, ST_FORKGAP) : u.kind === "col" || (u.kind === "win" && !colOpen(u.win)) ? u.win.pre || 0 : 0);   // a gap before a page goes before its column; room for the wires before branches
  const width = () => { let t = -ST_GAP, run = false; for (const u of units) { if (u.hide) continue; if (u.open) { t += preOf(u) + u.w + ST_GAP; run = false; } else if (!run) { t += ST_TAB + ST_GAP; run = true; } } return t; };
  const room = Math.max(1, A.w - 2 * ST_PADX);
  for (const u of units) if (u.kind === "win" || u.kind === "stack") u.w = Math.min(u.w, room);
  for (const u of units) if ((u.kind === "win" && u.win.big) || (u.kind === "stack" && u.wins.some(n => n.big))) u.w = Math.min(room, Math.round(A.w * 0.7));
  const flex = units.filter((u) => u.kind === "win" && u.open && !u.hide && u.flex);
  for (const u of flex) u.w = Math.min(room, Math.max(ST_MINW, Math.min(ST_WW, room)));
  if (flex.length && width() > room) { const cut = (width() - room) / flex.length; for (const u of flex) u.w = Math.max(Math.min(u.w, ST_FIT), u.w - cut); }
  if (flex.length && width() < room) { const add = (room - width()) / flex.length; for (const u of flex) u.w += add; }
  const free = Math.max(0, room - width()), off = ST.shift == null ? free / 2 : Math.max(0, Math.min(free, ST.shift));   // centred, unless an edge you pulled holds it
  let x = ST_PADX + off;
  let run = null;
  for (const u of units) { if (u.hide) continue; if (u.open) { x += preOf(u); u.x = x; x += u.w + ST_GAP; run = null; continue; }
    if (!run) { run = { x, tabs: [] }; x += ST_TAB + ST_GAP; } u.x = run.x; u.run = run; }
  ST.span = ST_PADX * 2 + off + width();             // how far the row reaches: the stage scrolls to it
  return { units, A, off };
}

/* ------------------------------------------------ drawing */
function stWinHtml(n) {
  if (n.knowledge) return knowledgeWinHtml(n);
  if (n.memo) return memoWinHtml(n);
  if (n.pad) return `<div class="stwin stpadwin">${["e", "w", "n", "s", "ne", "nw", "se", "sw"].map((d) => `<i class="rz rz-${d}" data-rz="${d}"></i>`).join("")}
    <div class="stwh" data-stfocus="${n.id}"><b class="stwt">${L("笔记", "Notepad")}</b><span class="grow"></span>
      <button class="stb stwsb" data-stw="ws">●</button><button class="stb" data-stw="min" title="${L("缩成小页面", "Make it a small page")}">–</button><button class="stb" data-stw="max" title="${L("最大化（Esc 还原）", "Maximise (Esc restores)")}">▢</button><button class="stb" data-stw="close" title="${L("关掉笔记页（右键空白处可以再加回来）", "Close the notepad page (right-click the stage to add it again)")}">×</button></div>
    <div class="stpadbox"></div></div>`;
  return `<div class="stwin">${["e", "w", "n", "s", "ne", "nw", "se", "sw"].map((d) => `<i class="rz rz-${d}" data-rz="${d}" title="${L("拖动改大小，双击还原", "Drag to resize, double-click to reset")}"></i>`).join("")}
    <div class="stwh" data-stfocus="${n.id}"><b class="stwt">${esc(stTitle(n.key))}</b>${n.agent ? `<span class="stkidag">${esc(typeof agentLabel === "function" ? agentLabel(n.agent) : n.agent)}</span>` : ""}<em class="stctxn" data-stctxn="${n.id}"></em><span class="grow"></span>
      <button class="stb" data-stw="project" title="${L('归入分类', 'Move to category')}">${L('分类', 'Category')}</button><button class="stb" data-stw="fork" title="${L("Branch：同一窗口内双 Agent 分屏", "Branch: two agents in this window")}">⑂</button><button class="stb ${n.captureKnowledge ? "on" : ""}" data-stw="knowledge" aria-pressed="${!!n.captureKnowledge}" title="${L("知识汇总：开启后发送时打开实时文档并保存文件", "Knowledge: save a live document with each message")}">📚</button><button class="stb stwsb" data-stw="ws">●</button><button class="stb ${n.side === false ? "" : "on"}" data-stw="side" title="${L("右侧栏：环境、上下文、世界树", "Side panel: environment, context, world tree")}">◧</button><button class="stb" data-stw="min" title="${L("缩成小页面", "Make it a small page")}">–</button><button class="stb" data-stw="max" title="${L("最大化（Esc 还原）", "Maximise (Esc restores)")}">▢</button><button class="stb" data-stw="close" title="${L("关掉这个窗口（对话还在）", "Close the window (the conversation stays)")}">×</button></div>
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
function stGrow(w) {                               // the stage reaches as far as the row (further while a page is carried past its end)
  const x = Math.max(w || 0, ST.span || 0);
  for (const id of ["stnodes", "stbars", "stwires"]) { const e = document.getElementById(id); if (e) e.style.width = Math.ceil(x) + "px"; }
}
function stRender() {
  // Category filtering is temporarily disabled; old snapshots must not hide pages.
  ST.groupFold = {}; ST.groupSolo = null;
  const box = $("#stnodes"), bars = $("#stbars"); if (!box) return;
  if (stGroupGather()) stSave();
  stGroupColors();
  const { units, A } = stLayout(), keep = new Set(ST.nodes.map((n) => n.id)), held = ST.drag?.n;
  box.querySelectorAll(".stnode").forEach((el) => { if (!keep.has(el.dataset.nid)) el.remove(); });
  const el = (n) => { let e = box.querySelector(`.stnode[data-nid="${n.id}"]`);
    if (!e) { e = document.createElement("div"); e.className = `stnode t-${n.type}`; e.dataset.nid = n.id; e.innerHTML = n.type === "win" ? stWinHtml(n) : stCardHtml(n); box.appendChild(e); if (n.type === "win") { if (n.pad) stPadIn(e); else if (n.memo) memoMount(n, e); else if (n.knowledge) knowledgeMount(n, e); else stFrame(n, e); } }
    else if (n.type !== "win" && n.type !== "note" && e.dataset.sig !== (n.title || "") + (S.forest ? 1 : 0)) e.innerHTML = stCardHtml(n);
    if (e.parentElement !== box) box.appendChild(e);
    if (n.type === "win") { stLayerLook(e, n); stBackLook(e, n); stBranchDockLook(e, n); }
    e.dataset.sig = (n.title || "") + (S.forest ? 1 : 0); return e; };
  const rid = (ST.rid = (ST.rid || 0) + 1);
  const place = (e, x, y, w, h, show = true) => { e.dataset.r = rid; if (e === held?.el) return; e.style.left = x + "px"; e.style.top = y + "px"; e.style.width = w + "px"; e.style.height = h + "px"; e.hidden = !show; };
  let barHtml = ""; const pos = new Map(), runs = new Set();
  for (const u of units) {
    if (u.kind === "win") {
      const e = el(u.win); u.win.el = e;
      if (u.hide || !u.open) { place(e, -9999, 0, u.w, A.h, false); if (!u.hide) { const t = stTitle(u.win.key);
        u.run.tabs.push({ win: u.win.id, html: (y) => `<div class="sttab win" style="left:${u.x}px;top:${y}px;width:${ST_TAB}px;height:${ST_TH}px" data-stunfold="${u.win.id}" title="${esc(t)}"><span>▢ ${esc(t.slice(0, 40))}</span></div>` }); runs.add(u.run); } continue; }
      const wy = 8, mh = A.h - wy; e.classList.remove("stkid", "stkfold", "sel"); stShortLook(u.win, mh); stMiniLook(e, false);
      place(e, u.x, wy, u.w, mh); e.classList.toggle("focus", u.win.id === ST.focus); stWsLook(e, u.win); stSmallLook(e, u.win);
      e.classList.toggle("hascol", units.some((c) => c.kind === "col" && c.win === u.win && !c.hide && c.open));      // its column covers the input labels
      pos.set(u.win.id, { x: u.x, y: wy, w: u.w, h: mh }); continue;
    }
    if (u.kind === "stack" && u.hide) continue;
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
  stSideList();                                    // 所有对话, with world and self knowledge in its lower part
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
  for (const [id, w] of Object.entries(ST.ws || {})) {   // a band above a workspace's pages in the row, in its colour
    const ps = stWins().filter((o) => o.ws === id && !o.mini).map((o) => pos.get(o.id)).filter((p) => p && !p.tab); if (!ps.length) continue;
    const l = Math.min(...ps.map((p) => p.x)), r = Math.max(...ps.map((p) => p.x + p.w));
    barHtml += `<div class="stwsband" style="left:${l}px;width:${r - l}px;--wc:${ST.groupColors?.get("ws:" + id) || w.c}" title="${esc(w.name)}"></div>`; }
  for (const n of stWins()) {
    n.el?.classList.toggle("conversation-expanded", !!n.big);
    const button = n.el?.querySelector('[data-stw="max"]');
    if (button) {
      button.title = n.big ? L("还原（Esc）", "Restore (Esc)") : L("放大到页面 70%", "Expand to 70% of the page");
      button.setAttribute("aria-label", button.title);
      button.setAttribute("aria-pressed", String(!!n.big));
    }
  }
  bars.innerHTML = barHtml;
  box.querySelectorAll(".stnode").forEach((e) => { if (e.dataset.r !== String(rid) && e !== held?.el) e.hidden = true; });   // cards of a small page wait unseen
  ST.pos = pos; ST.units = units; requestAnimationFrame(stMap); if (!ST.drag) stGrow();
  if (ST.drag?.groups && ST.drag.moved && ST.drag.lx != null) stDragTo(ST.drag.lx, ST.drag.ly);   // redrawn mid-drag: preserve the translated positions
  else stWires();
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
  for (const p of stWins()) { const a = ST.pos.get(p.id); if (!a || a.tab || !p.kids) continue;   // a page to each of its branches; the chosen one bright
    const chosen = p.kids.includes(p.sel) ? p.sel : p.kids[0];
    for (const id of p.kids) { const t = ST.pos.get(id); if (!t?.kid) continue;
      const line = route(a, t);
      if (line) h += `<path class="stwire fork ${id === chosen ? "on" : ""}" d="${line.path}"/>`; } }

  // Free positioning does not sever a branch's provenance. Also recover old
  // detached snapshots whose source key survived but whose layout parent did not.
  for (const child of stWins().filter(n => !n.par && (n.branchParent || n.branchFrom || (n.branchKey && n.from)))) {
    const parent = stWins().find(n => n.id === child.branchParent)
      || stWins().find(n => n !== child && n.key === (child.branchFrom || child.from));
    const a = ST.pos.get(parent?.id), b = ST.pos.get(child.id);
    if (!a || !b || a.tab || b.tab) continue;
    const line = route(a, b);
    if (line) h += `<path class="stwire fork on" d="${line.path}"/>`;
  }

  for (const n of stWins().filter(n => n.knowledge)) {
    const source = stWins().find(w => w.key === n.knowledgeSource), a=ST.pos.get(source?.id), b=ST.pos.get(n.id);
    if(a && b) h += `<path class="stwire fork on" d="${route(a,b).path}"/>`;
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
function stFrame(n, el) {
  // Restored snapshots may contain a stale display key; the fork identity wins.
  if (n.branchKey) n.key = n.branchKey;
  const q = new URLSearchParams({ view: "chats", embed: "1" });
  if (n.key) { if (S.allChats?.some((c) => c.key === n.key) || n.key.startsWith("chat:")) q.set("c", n.key); else q.set("item", n.key); }
  if (n.managerProject && n.key?.startsWith("chat:pm-")) q.set("manager", n.managerProject);
  if (AS_UID) q.set("as", AS_UID); if (Q.get("lang")) q.set("lang", Q.get("lang")); if (n.agent) q.set("agent", n.agent);   // a branch: answered by the agent it was given
  const f = el.querySelector("iframe"); f.src = "/?" + q;
  f.addEventListener("load", () => { try { stHold(f, n); stSide(n); stShortLook(n); f.contentWindow.knowledgeSyncButtons?.(); } catch {} try { if (typeof pgWatchScroll === "function") pgWatchScroll(f.contentDocument); } catch {} window.pgRestore?.(n, f); });   // a page switched to: back where you were reading
}
function stHold(f, n) {                          // inside a conversation: press and hold (~0.25 s, still), then move the window
  const cw = f.contentWindow, doc = cw.document; let h = null, dragged = false;
  doc.addEventListener("keydown", () => stFocus(n.id), true);
  doc.addEventListener("pointerdown", (e) => {
    dragged = false; stFocus(n.id);
    if (n.par) return;                                // a branch is not carried about on its own
    if (e.button !== 0 || e.target.closest("input, textarea, select, button, a, [contenteditable], #ccomp, #pmview")) return;
    h = { sx: e.screenX, sy: e.screenY, on: false, t: setTimeout(() => { if (!h) return; h.on = true; doc.documentElement.classList.add("stgrab");
      try { doc.documentElement.setPointerCapture(e.pointerId); } catch {} stGrab(n, h.sx, h.sy, e.clientX); cw.getSelection()?.removeAllRanges(); }, 250) };
  }, true);
  doc.addEventListener("pointermove", (e) => {
    if (!h) return;
    if (!h.on) { if (Math.hypot(e.screenX - h.sx, e.screenY - h.sy) > 5) { clearTimeout(h.t); h = null; } return; }
    e.preventDefault(); cw.getSelection()?.removeAllRanges(); stDragSoon(e.screenX, e.screenY);
  }, true);
  const end = () => { if (!h) return; clearTimeout(h.t); const was = h.on; dragged = was; h = null; doc.documentElement.classList.remove("stgrab"); if (was) { stDragFlush(); stDrop(); } };
  doc.addEventListener("pointerup", end, true); doc.addEventListener("pointercancel", end, true);
  doc.addEventListener("click", () => { if (!dragged && !ST.drag && !ST.pan && !cw.getSelection()?.toString()) stShow(n.id); }, true);
  doc.addEventListener("selectstart", (e) => { if (h?.on) e.preventDefault(); }, true);
  const st = doc.createElement("style"); st.textContent = "html.stgrab, html.stgrab * { cursor: grabbing !important; user-select: none !important; }"; doc.head.appendChild(st);
}
function stDragSoon(sx, sy) {                      // one move per frame, however fast the pointer reports
  ST.nx = [sx, sy]; if (!ST.raf) ST.raf = requestAnimationFrame(() => { ST.raf = 0; if (ST.nx) stDragTo(...ST.nx); });
}
function stDragFlush() { if (ST.raf) { cancelAnimationFrame(ST.raf); ST.raf = 0; if (ST.nx) stDragTo(...ST.nx); } ST.nx = null; }


/* ------------------------------------------------ 所有对话 are the sidebar: on the stage it is a tight column of every past
   conversation, newest first. A click opens one as a window; pulling from it draws a wire into the window you drop it on
   (anywhere else on the stage: the one you are on) — it becomes that window's conversation reference. Wired ones show
   their wire from the column to the window; the dot at a row's end toggles its wire into the window you are on. */
/* It stands the full height at the left of the app; while it is open the stage starts after it (--chats-w), so no page
   is ever under it. ☰ at the top left opens it, ‹ in its head closes it, its right edge sets its width. */
function stSideList() {
  const v = $("#vStage"), lp = stPanel(), open = !!ST.listOpen, w = Math.max(180, Math.min(520, lp.w || 240));
  let box = $("#stlist");
  if (!box) {
    v.insertAdjacentHTML("beforeend", `<aside class="stlist side" id="stlist"><i class="lrz lrz-e" data-lrz="e" title="${L("拖动改宽度", "Drag to resize")}"></i>
      <div class="stlh"><b>${L("所有对话", "All conversations")}</b><em class="cvdim" id="stln"></em><span class="grow"></span>
      <button class="stb" id="stlstruct" title="${L("整理上层结构：合并 / 改名文件夹", "Tidy the folders: merge or rename them")}">🗂</button><button class="stb" id="stlmk" data-rk="only" title="${L("只看标注和置顶的", "Only the marked and pinned")}">★</button><button class="stb" data-stlistmin title="${L("收起（左上角 ☰ 再打开）", "Close (☰ at the top left opens it again)")}">‹</button></div><input id="stlq" placeholder="${L("搜对话…", "Search…")}"><div class="stli" id="stli"></div>
      <div class="stmy" id="stmy"><i class="stmysep" data-mysep title="${L("拖动改高度 · 双击还原", "Drag to resize · double-click to reset")}"></i><button type="button" class="stmyh" id="stmytoggle" aria-controls="stmyl" aria-expanded="false"><span class="stfoldarrow">▸</span><b>${L("我的输入", "What I typed")}</b><em class="cvdim" id="stmyn"></em></button><div class="stmyl" id="stmyl" hidden></div></div><details class="sttools" id="sttools"><summary>${L("工具与设置", "Tools and settings")}</summary><div id="sttoolsbody"></div></details></aside>`);
    box = $("#stlist");
    $("#stmytoggle").addEventListener("click", () => {
      stPanel().myOpen = !stPanel().myOpen; stPanelSave(); stMyHeight();
      if (stPanel().myOpen) { stInputs(); stInputsDraw(); }
    });
    const settings = $("#sttools"); settings.open = !!stPanel().toolsOpen;
    settings.addEventListener("toggle", () => { stPanel().toolsOpen = settings.open; stPanelSave(); });
    $("#stlq").addEventListener("input", (e) => { ST.q = e.target.value.toLowerCase(); stListItems(); stInputsDraw(); });
    box.querySelector("[data-lrz]").addEventListener("pointerdown", (e) => {     // its right edge: wider or narrower, the stage following
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
      const m = ST.lmove; if (!m) return; stPanel().w = Math.max(180, Math.min(520, m.w0 + e.clientX - m.x)); stRender();
    });
    const end = () => {
      if (ST.mymove) { ST.mymove = null; sep.classList.remove("on"); stPanelSave(); }
      if (!ST.lmove) return; ST.lmove = null; v.classList.remove("dragging", "resizing"); stPanelSave();
    };
    box.addEventListener("pointerup", end); box.addEventListener("pointercancel", end);
  }
  stPanelTools(); stMyHeight(); box.hidden = !open; v.classList.toggle("chats-open", open); v.style.setProperty("--chats-w", open ? w + "px" : "0px");
  const bar = $("#stlbar"); if (bar) { bar.hidden = false; bar.textContent = open ? "‹" : "›"; bar.setAttribute("aria-expanded", String(open)); bar.setAttribute("aria-controls", "stlist"); bar.title = open ? L("收起所有对话", "Collapse all conversations") : L("展开所有对话", "Expand all conversations"); bar.setAttribute("aria-label", bar.title); }
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
function stTidyLayout() {                         // ✦ first tidies the stage: every page side by side, two to a screen, wired ones together
  const A = stArena(), room = A.w - 2 * ST_PADX;                 // the open sidebar has already narrowed the stage
  const pw = Math.max(320, Math.floor((room - ST_GAP) / 2));
  const wins = stWins(), byKey = new Map(wins.filter((w) => w.key).map((w) => [w.key, w])), nb = new Map(wins.map((w) => [w.id, new Set()]));
  const tie = (a, b) => { if (a && b && a !== b && nb.has(a) && nb.has(b)) { nb.get(a).add(b); nb.get(b).add(a); } };
  for (const w of wins) for (const l of w.links || []) tie(w.id, l.from);                       // window to window
  for (const w of wins) if (stWs(w)) tie(w.id, wins.find((o) => o.ws === w.ws)?.id);            // one workspace
  for (const n of ST.nodes) if (n.type === "conv" && n.win) tie(n.win, byKey.get(n.key)?.id);   // a conversation wired in that is open too
  const order = [], seen = new Set(), at = new Map(wins.map((w, i) => [w.id, i]));
  const walk = (id) => { if (seen.has(id)) return; seen.add(id); order.push(id); [...nb.get(id)].sort((a, b) => at.get(a) - at.get(b)).forEach(walk); };
  wins.forEach((w) => walk(w.id));
  order.forEach((id, i) => { const w = wins.find((x) => x.id === id); w.ord = i; w.mini = false; w.bw = pw; delete w.pre; });
  stWsGather();
  ST.shift = null; stRender(); stSave();
  const a = $("#starena"); if (a) a.scrollTo({ left: 0, behavior: "smooth" });
  return wins.length;
}
async function stTidy(b) {                         // ✦: the stage laid out, then every conversation where it belongs
  if (b.classList.contains("on")) return;
  const pages = stTidyLayout();
  b.classList.add("on"); b.title = L("正在整理…", "Tidying…");
  let placed = 0, sums = 0, lines = 0, why = "";
  try { const r = await api(`/v1/users/${S.uid}/world/place`, { method: "POST" }); placed = r.placed || 0; sums = r.summarised || 0; if (r.why === "not built") why = L("世界树还没建", "the world tree is not built yet"); }
  catch (err) { why = err.message; }
  try { const r = await api(`/v1/users/${S.uid}/timeline/organize`, { body: { use_model: false } }); lines = r.new_lines || 0; } catch {}
  let filed = 0; try { const r = await api(`/v1/users/${S.uid}/projects/sort`, { method: "POST" }); filed = (r.ruled || 0) + (r.sorted || 0); } catch {}
  try { await loadTimeline(); if (typeof loadWorld === "function") loadWorld().catch?.(() => {}); } catch {}
  stRender();
  toast(L(`台面排好了：${pages} 个页面，一屏两个，连着线的挨在一起 · ${placed} 段对话放进世界树，${sums} 个主题重写了总结，${lines} 条新线 · ${filed} 段归进项目`, `Laid out: ${pages} pages, two to a screen, wired ones together · ${placed} into the world tree, ${sums} topics summarised, ${lines} new lines · ${filed} filed under projects`) + (why ? ` · ${why}` : ""));
  b.classList.remove("on"); b.title = L(`上次整理 ${new Date().toLocaleTimeString()} · 再点一次重新整理`, `Last tidied ${new Date().toLocaleTimeString()} · click to tidy again`);
}
function stDropToggle(open) {                       // 所有对话 open or closed, kept across reloads
  const lp = stPanel(); ST.listOpen = lp.open = open ?? !ST.listOpen; stPanelSave(); stRender();
  if (ST.listOpen) setTimeout(() => $("#stlq")?.focus(), 30);
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
  if (more) { e.preventDefault(); ST.projectLimits ||= {}; const name = more.dataset.stprojectMore; ST.projectLimits[name] = ST.projectLimits[name] > 6 ? 6 : Infinity; stListItems(); }
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
    const limit = ST.projectLimits?.[g.name] || 6;
    html += pjHead(g, shut) + (shut ? "" : items.slice(0, limit).map(x => row(x)).join("")
      + (items.length > 6 ? `<button class="txt" data-stproject-more="${esc(g.name)}">${limit >= items.length ? L("收起至 6 条", "Show 6") : L(`显示更多（${items.length - limit}）`, `Show more (${items.length - limit})`)}</button>` : ""));
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
    h += `<path class="stwire z0 ${a.out ? "faint" : ""}" d="${d}"/><path class="sthit" d="${d}" data-unrail="${n.id}"><title>${esc(stTitle(n.key))} · ${L("点一下断开", "click to cut")}</title></path>`;
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
    if (op === "project") { pjAssignDialog(key); }
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
let stScrollFrame = 0;
function stScheduleScroll() {
  if (stScrollFrame || S.view !== "stage") return;
  stScrollFrame = requestAnimationFrame(() => { stScrollFrame = 0; stMapView(); stOver(false); });
}
document.addEventListener("scroll", stScheduleScroll, {capture: true, passive: true});
window.addEventListener("resize", () => { if (S.view === "stage") requestAnimationFrame(stOver); });

/* the side panel inside a window: the conversation page's own right panel (environment, context, world tree) */
function stSide(n) {
  const f = document.querySelector(`.stnode[data-nid="${n.id}"] iframe`); try { f.contentDocument.documentElement.classList.toggle("eside", n.side !== false); f.contentWindow.renderChat?.(); } catch {}
}

/* ------------------------------------------------ moving: a card to another window or the shelf; a window along the row */
function stFreezeWidths() {
  for (const u of ST.units || []) {
    if (!u.open || u.hide) continue;
    if (u.kind === "win") u.win.bw = u.w;
    if (u.kind === "stack") u.par.kw = u.w;
  }
}
function stGrab(n, sx, sy, gx = 40) {               // gx: where on the page you hold it
  const e = document.querySelector(`.stnode[data-nid="${n.id}"]`); if (!e) return;
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
    if (u.kind === "win") u.win.bw = u.w;
    if (u.kind === "stack") u.par.kw = u.w;
  }
  const gap = u => {
    if (u?.kind === "stack") return {owner:u.par, field:"branchGap", value:u.par.branchGap ?? ST_FORKGAP};
    if (u?.kind === "col" || (u?.kind === "win" && !us.some(c => c.kind === "col" && c.win === u.win)))
      return {owner:u.win, field:"pre", value:u.win.pre || 0};
    return null;
  };
  return {owner:unit.kind === "stack" ? unit.par : unit.win, field:unit.kind === "stack" ? "kw" : "bw",
    width:unit.w, before:gap(unit), after:gap(us[i + 1])};
}
function stResizeIntoGap(r, dx, maxWidth) {
  const hold = r.across; if (!hold) return false;
  const west = r.d.includes("w");
  let width = Math.round(Math.max(Math.min(320, hold.width), Math.min(Math.max(maxWidth, hold.width), hold.width + (west ? -dx : dx))));
  if (west) width = Math.min(width, hold.width + (hold.before?.value || 0));
  const delta = width - hold.width, gap = west ? hold.before : hold.after;
  hold.owner[hold.field] = width;
  if (gap) gap.owner[gap.field] = Math.max(0, gap.value - delta);
  ST.shift = r.off0;
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
    else gs.push({ key: u.kind, par: u.par, x: u.x, w: u.w, els: els(u.nodes.map((x) => x.id)) });
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
  const d = ST.drag; if (!d) return;
  if (Math.hypot(sx - d.sx, sy - d.sy) > 4) d.moved = true; d.lx = sx; d.ly = sy;
  const A = stArena(), w = d.el.offsetWidth, sl = stSL();
  const big = d.n.type === "win" && !d.n.mini;                     // a page as wide as the stage still moves: up to 60% of it may hang
  const lo = big ? sl - w * 0.6 : sl, hi = big ? sl + A.w - w * 0.4 : Math.max(sl, sl + A.w - w);   // past an edge, the rest stays in view
  const raw = d.l0 + sx - d.sx + sl - d.s0, l = Math.max(lo, Math.min(hi, raw)); d.el.style.left = l + "px";
  const px = raw + d.gx - sl;                     // held at an edge of the stage: it scrolls that way, the page along with it
  d.v = big ? (px > A.w - 48 ? Math.min(24, (px - A.w + 48) / 2) : px < 48 && sl > 0 ? -Math.min(24, (48 - px) / 2) : 0) : 0;
  if (d.v && !d.auto) d.auto = requestAnimationFrame(function step() {
    const D = ST.drag; if (!D || !D.v) { if (D) D.auto = 0; return; }
    const a = $("#starena"), b = a.scrollLeft; a.scrollLeft = Math.max(0, b + D.v);
    if (a.scrollLeft === b && D.v > 0) stGrow(a.scrollLeft + a.clientWidth + 40);   // at the end of the row: there is more stage
    D.auto = requestAnimationFrame(step); stDragTo(D.lx, D.ly);
  });
  if (d.n.type !== "win" || d.n.mini) d.el.style.top = Math.max(0, Math.min(A.h - d.el.offsetHeight, d.t0 + sy - d.sy)) + "px";
  if (big) {
    stPush(d, l, w);
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
  const x = Math.max(ST_PADX, l - doff);
  bs.push({ key: "win", win: d.n, x, w: w + doff, off: doff, page: true, side: 0, wins: [d.n.id] });
  bs.sort((a, b) => a.side - b.side || a.x - b.x);
  let c = ST_PADX; for (const b of bs) { b.x = Math.max(b.x, c); c = b.x + b.w + G; }   // only what still overlaps moves on to the right
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
  const d = ST.drag; ST.drag = null; $("#vStage").classList.remove("dragging"); if (!d) return null; d.el.classList.remove("held");
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
function stOpen(key, at) {
  let n = key && ST.nodes.find((x) => x.type === "win" && x.key === key);
  const fresh = !n;
  const by = ST.nodes.find(w => w.type === "win" && w.id === (at?.win || (!key ? ST.focus : null)));
  const insert = fresh && !!by;
  if (insert) {
    const layout = stLayout();
    stFreezeWidths();
    // Preserve the row's existing leading space when insertion consumes its free room.
    const first = layout.units.find(u => !u.hide && u.open);
    if (layout.off && first?.win) first.win.pre = (first.win.pre || 0) + layout.off;
    ST.shift = 0;
    const arena = $("#starena");
    if (arena) arena.scrollTo({left: arena.scrollLeft, behavior: "instant"});
    if (stShiftMotion) { cancelAnimationFrame(stShiftMotion.frame); stShiftMotion = null; }
  }
  if (!n) {
    const card = key && ST.nodes.find((x) => x.type === "conv" && x.key === key);
    const wins = stWins(), after = by ? wins.findIndex((w) => w.id === by.id) : card?.win ? wins.findIndex((w) => w.id === card.win) : wins.length - 1;
    if (card) ST.nodes = ST.nodes.filter((c) => c !== card);
    n = { id: stId(), type: "win", key: key || null }; wins.splice(after + 1, 0, n); wins.forEach((o, k) => { o.ord = k; }); ST.nodes.push(n);
    if (by) { n.from = by.key || by.from; n.creationGroup = stGroupOf(by); if (stWs(by)) n.ws = by.ws; }   // opened beside a page at work: it joins in
  }
  if (at?.managerProject && key?.startsWith("chat:pm-")) {
    n.managerProject = at.managerProject;
    n.title = `${at.managerProject} · ${L("管理员", "Manager")}`;
  }
  n.mini = false; if (fresh) n.bw = stHalfWidth();   // new conversations occupy half the stage; existing sizes stay as set
  const group = stGroupOf(n)?.id;
  if (group && ST.groupFold) delete ST.groupFold[group];
  if (ST.groupSolo && ST.groupSolo !== group) ST.groupSolo = null;
  if (insert) { ST.focus = n.id; stRender(); } else stFocus(n.id, true);
  stSave(); stContexts(); if (!insert) stShow(n.id);
  document.querySelector(`.stnode[data-nid="${n.id}"]`)?.animate?.(insert ? [{ opacity: 0, clipPath: "inset(0 100% 0 0)" }, { opacity: 1, clipPath: "inset(0 0 0 0)" }] : [{ opacity: 0 }, { opacity: 1 }], { duration: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : 280, easing: "cubic-bezier(.2,.8,.2,1)" });
  return n;
}
function stOpenAt(key, x) {                         // a page opened where you dropped it: among the others by where it landed
  const centres = (ST.units || []).filter((u) => u.kind === "win" && !u.hide && u.x != null).map((u) => ({ w: u.win, c: u.x + (u.open ? u.w : ST_TAB) / 2 }));
  const n = stOpen(key);
  const rest = stWins().filter((w) => w !== n && !w.mini), at = rest.filter((w) => (centres.find((c) => c.w === w)?.c ?? -1) < x).length;
  rest.splice(at, 0, n); rest.forEach((o, i) => { o.ord = i; });
  ST.focus = n.id; stRender(); stSave(); stShow(n.id);
}
function stShow(id) {                              // move only as far as it takes to bring the page wholly into the arena (which already excludes the sidebar)
  const n = ST.nodes.find((x) => x.id === id), p = ST.pos?.get(id), a = $("#starena");
  if (!p || !a || p.tab || !n || n.mini || n.max || ST.drag || ST.pan) return;   // a small page floats, a full-screen one is the screen
  const W = a.clientWidth, sl = a.scrollLeft, l = p.x - ST_PADX, r = p.x + p.w + ST_PADX;
  const left = r - l > W || l < sl ? l : r > sl + W ? r - W : sl;                 // wider than the stage: its left edge
  if (Math.abs(left - sl) < 1) return;
  if (left + W > a.scrollWidth) stGrow(left + W);
  const now = performance.now(), rapid = ST.showAt != null && now - ST.showAt < 180;
  const far = Math.abs(left - sl) > W;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  a.scrollTo({ left: Math.max(0, left), behavior: far || rapid || reduced ? "instant" : "smooth" });
  ST.showAt = now;
}
function stFocus(id, render) {
  const n0 = ST.nodes.find((x) => x.id === id), up = n0?.par && ST.nodes.find((x) => x.id === n0.par);
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
  if (n0?.done) { delete n0.done; stSave(); requestAnimationFrame(stMap); stListItems(); if (!render) stRender(); }   // looked at: its number goes
  if (ST.focus === id && !render) return; ST.focus = id; if (render) stRender(); else document.querySelectorAll(".stnode.t-win").forEach((el) => el.classList.toggle("focus", el.dataset.nid === id)); if (render) stShow(id); }
function stMiniLook(e, mini) {
  e.classList.toggle("mini", mini);
  const mb = e.querySelector('[data-stw="min"]'); if (mb && mb.dataset.m !== String(mini)) { mb.dataset.m = String(mini); mb.textContent = mini ? "▭" : "–";
    mb.title = mini ? L("恢复成大窗口", "Back to a full window") : L("缩成小页面（拖动移动，四边四角调大小）", "Make it a small page (drag to move, pull edges and corners to size it)"); }
}
function stSmallLook(e, n) {
  e.classList.toggle("small", !!n.small);
  let chip = e.querySelector('.stcollapsed-name');
  if (!chip) {
    chip = document.createElement('button'); chip.className = 'stcollapsed-name';
    chip.dataset.stexpand = n.id; e.appendChild(chip);
  }
  chip.hidden = !n.small;
  chip.textContent = stTitle(n.key);
  chip.title = L('展开对话：', 'Expand conversation: ') + stTitle(n.key);
  chip.setAttribute('aria-expanded', String(!n.small));
  const mb = e.querySelector('[data-stw="min"]');
  if (mb) { mb.textContent = n.small ? "▭" : "–"; mb.title = L("折叠为名称标签", "Collapse to a named tab"); }
}
function stMini(n, on) { // Keep the layout slot and viewport unchanged; only hide the contents.
  if (on === !!n.small) return;
  stKidKeep(n, on);
  if (on) n.small = true;
  else delete n.small;
  stRender(); stSave(); stMap();
}
function stClose(n) {
  const gone = new Set([n.id]), walk = (w) => (w.kids || []).forEach((id) => { const k = ST.nodes.find((x) => x.id === id); if (k && !gone.has(id)) { gone.add(id); walk(k); } }); walk(n);
  if (gone.size > 1 && !confirm(L(`连同从它长出来的 ${gone.size - 1} 个分支窗口一起关掉？（对话本身都还在）`, `Close it with the ${gone.size - 1} branch windows grown from it? (The conversations stay)`))) return;
  if (n.pad) { stPadOut(); store.set("pga_pad_off", "1"); }
  for (const x of ST.nodes) if (gone.has(x.id) && x.memo) memoUnmount(x.memo);
  ST.nodes = ST.nodes.filter((x) => !gone.has(x.id));
  const up = n.par && ST.nodes.find((x) => x.id === n.par);
  if (up) { up.kids = (up.kids || []).filter((id) => id !== n.id); if (up.sel === n.id) up.sel = up.kids[0]; }
  if (gone.has(ST.focus)) ST.focus = up?.id || stWins()[0]?.id || null; stRender(); stSave(); stContexts(); }
function stMax(n, on) { // Enlarge the existing frame without reloading its conversation.
  if (on === !!n.big) return;
  if (on) {
    for (const other of stWins()) if (other !== n) delete other.big;
    if (n.small) stMini(n, false);
    n.big = true; ST.focus = n.id;
  } else delete n.big;
  stRender(); stSave(); stMap(); if (on) stShow(n.id);
}
async function stRepairBranchKeys() {
  if (ST.branchKeysRepairing || !S.chats?.length) return;
  ST.branchKeysRepairing = true;
  try {
    for (const n of stWins().filter(x => x.par)) {
      const matches = S.chats.filter(c => c.title === n.title);
      const own = n.branchKey || (matches.length === 1 ? matches[0].key : n.key);
      if (!own) continue;
      const changed = own !== n.key;
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
  if (!ST.branchKeysReady || stWins().some(n => n.par && !n.branchKey)) { stRepairBranchKeys(); return; }
  for (const n of ST.nodes.filter((x) => x.type === "win")) {
    const el = document.querySelector(`.stnode[data-nid="${n.id}"]`), f = el?.querySelector("iframe"); let k = null; try { k = f?.contentWindow?.S?.chat || null; } catch {}
    if (n.par && n.branchKey && k && k !== n.branchKey) { n.key = n.branchKey; stFrame(n, el); continue; }
    if (k && k !== n.key) { n.key = k; n.sent = null; if (!k.startsWith("chat:pm-")) delete n.managerProject; stSave(); stContexts(); }
    const t = el?.querySelector(".stwt"); if (t && n.key) { const s = stTitle(n.key); if (t.textContent !== s) t.textContent = s; }
  }
}, 2500);

/* ------------------------------------------------ right-click: add any node, wired into the window you clicked beside */
function stMenu(sx, sy) {
  const r = $("#starena").getBoundingClientRect(), x = sx - r.left + stSL();
  let best = null, bd = Infinity; for (const u of ST.units || []) { if (u.hide || u.x == null) continue; const c = u.x + (u.open ? u.w : ST_TAB) / 2, d = Math.abs(x - c); if (d < bd) { bd = d; best = u; } }
  const win = best && best.kind !== "shelf" ? best.win : null, at = { win: win?.id || null };
  document.querySelector(".stmenu")?.remove();
  const m = document.createElement("div"); m.className = "cvpal cvmenu stmenu card"; m.style.left = Math.min(sx, innerWidth - 260) + "px"; m.style.top = Math.min(sy, innerHeight - 330) + "px";
  m.innerHTML = `<div class="stmh">${win ? L(`连给「${esc(stTitle(win.key).slice(0, 18))}」`, `Into “${esc(stTitle(win.key).slice(0, 20))}”`) : L("放在未连接的架子上", "On the unwired shelf")}</div>`
    + [["conv", "💬", 0], ["topic", "🌳", 0], ["doc", "📚", 1], ["file", "📎", 1], ["note", "📝", 1], ["skill", "✦", 2], ["win", "▢"], ...(ST.nodes.some((x) => x.pad) ? [] : [["pad", "🗒"]])].map(([t, i, p]) => `<button data-stadd="${t}">${i} ${t === "win" ? L("新对话窗口", "New conversation window") : t === "pad" ? L("笔记页", "Notepad page") : L(...ST_T[t].slice(0, 2)) + (t === "note" ? "" : "…")}${p != null ? `<em>${L(...ST_PINS[p])}</em>` : ""}</button>`).join("");
  m.dataset.at = JSON.stringify(at); document.body.appendChild(m);
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
/* ------------------------------------------------ moving along the stage: held (middle button anywhere, or the left one on empty
   ground) it slides under the pointer; the map at the top shows the whole row and takes you anywhere on it */
function stPanStart(sx) { const a = $("#starena"); if (!a) return; ST.pan = { x: sx, sl: a.scrollLeft, max: Math.max(0, a.scrollWidth - a.clientWidth) }; $("#vStage").classList.add("panning", "dragging"); }
let stPanFrame = 0, stPanX = 0;
function stPanMove(sx) {
  if (!ST.pan) return;
  stPanX = sx;
  if (!stPanFrame) stPanFrame = requestAnimationFrame(() => { stPanFrame = 0; stPanApply(stPanX); });
}
function stPanApply(sx) {
  const p = ST.pan, a = $("#starena"); if (!p || !a) return;
  const max = p.max, want = p.sl - (sx - p.x);
  a.scrollLeft = Math.max(0, Math.min(max, want));
  // Re-anchor at the boundary so reversing the pointer responds immediately.
  if (want < 0 || want > max) { p.sl = a.scrollLeft; p.x = sx; }
  stMapView();
}
function stPanEnd() { if (!ST.pan) return; if (stPanFrame) { cancelAnimationFrame(stPanFrame); stPanFrame = 0; stPanApply(stPanX); } ST.pan = null; $("#vStage").classList.remove("panning", "dragging"); stMap(); }
try { if (window.webkit?.messageHandlers?.pga && !Q.get("embed")) document.documentElement.classList.add("deskapp"); } catch {}   // the desktop app: its top strip moves the window
window.stPanStart = stPanStart; window.stPanMove = stPanMove; window.stPanEnd = stPanEnd;
function stMap() {                                 // the minimap: every part of the row in miniature, and the part you see
  const a = $("#starena"), v = $("#vStage"); if (!a || !v || S.view !== "stage") return;
  let m = $("#stmap");
  if (!m) { v.insertAdjacentHTML("beforeend", `<div class="stmap" id="stmap"><div class="stmi" id="stmi"></div><div class="stmv" id="stmv"></div></div><button class="stlbar" id="stlbar" aria-controls="stlist" aria-expanded="${!!ST.listOpen}" aria-label="${L('展开或收起所有对话','Toggle all conversations')}" title="${L('展开或收起所有对话','Toggle all conversations')}">${ST.listOpen ? '‹' : '›'}</button><span class="stmapacts"><button class="stb stmapbtn stpgb" id="stpgb" data-pgopen title="${L("页面：整个台面的快照，保存、切换、管理", "Pages: snapshots of the whole stage — save, switch, manage")}"></button><button class="stb stsync stmapbtn" data-stsync title="${L("导入：现在把本机 Claude Code、Codex 等应用里的对话导进来", "Import: bring in the conversations from Claude Code, Codex and the other apps on this machine now")}">↻ ${L("导入", "Import")}</button><button class="stb sttidy stmapbtn" data-sttidy title="${L("整理：把新对话放进世界树、重写变了的主题总结、按标题把零散对话归成线", "Tidy: new conversations into the world tree, changed topics summarised again, loose ones joined into lines by title")}">✦ ${L("整理", "Tidy")}</button></span><div class="stmtip" id="stmtip" hidden></div>`); m = $("#stmap");
    m.addEventListener("pointerleave", () => { $("#stmtip").hidden = true; ST.mapHover = null; });
    m.addEventListener("wheel", (e) => {              // the wheel over the map: one page along per notch, faster as it spins
      e.preventDefault(); e.stopPropagation();
      const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX; if (!d) return;
      const now = performance.now(), fresh = now - (ST.wt || 0) > 150; ST.wt = now;
      if (fresh) { ST.wacc = 0; stStep(Math.sign(d)); return; }
      ST.wacc = (ST.wacc || 0) + d; if (Math.abs(ST.wacc) >= 60) { stStep(Math.sign(ST.wacc)); ST.wacc = 0; }
    }, { passive: false });
    m.addEventListener("pointerdown", (e) => { if (e.target.closest('[data-pjnew], [data-pjmap], [data-stgroupfold], [data-stgroupsolo]')) { stMapHideTip(); e.stopPropagation(); return; } stMapHideTip(); e.preventDefault(); e.stopPropagation(); try { m.setPointerCapture(e.pointerId); } catch {} ST.mapDrag = true; stMapGo(e.clientX); });
    m.addEventListener("pointermove", (e) => { if (e.target.closest('[data-pjnew], [data-pjmap], [data-stgroupfold], [data-stgroupsolo]')) { stMapHideTip(); return; } if (ST.mapDrag) { stMapGo(e.clientX); return; } stMapTip(e.clientX, e.clientY); });
    const end = (e) => { ST.mapDrag = false;
      if (e.type !== "pointerup" || e.target.closest('[data-pjnew], [data-pjmap], [data-stgroupfold], [data-stgroupsolo]')) return;
      const x = (e.clientX - m.getBoundingClientRect().left) / (Number(m.dataset.k) || 1);
      const hit = stMapHit(e.clientX, e.clientY)?.w;
      if (hit) { stFocus(hit.id); stShow(hit.id); }
    }; m.addEventListener("pointerup", end); m.addEventListener("pointercancel", end);
    window.pgBtn?.(); }
  stPanelTools();
  // Restore the pre-October-30 top bar: map and tools are separate stage children.
  for (const control of [v.querySelector(".stmapacts"), m, $("#stbar")])
    if (control && control.parentElement !== v) v.appendChild(control);
  $("#sttoolbar")?.remove();
  const T = Math.max(a.scrollWidth, a.clientWidth, 1), W = m.clientWidth || 1;
  const k = W / T, H = m.clientHeight || 30;
  $("#stmi").style.width = W + "px";
  m.scrollLeft = 0;
  const box = (x, w, cls, title = "") => `<i class="${cls}" style="left:${(x * k).toFixed(1)}px;width:${Math.max(2, w * k).toFixed(1)}px" title="${esc(title)}"></i>`;
  // Resolve the history once per draw, rather than sorting it for every tile.
  const recent = new Map(recentItems().map(x => [x.item, x]));
  const chats = new Map((S.chats || []).map(c => [c.key, c]));
  const titles = new Map();
  for (const n of ST.nodes) if (n.key && n.title && !titles.has(n.key)) titles.set(n.key, n.title);
  const titleFor = key => key ? recent.get(key)?.title || chats.get(key)?.title || titles.get(key) || key : L("新对话", "New chat");
  let h = "";
  const SS = stStat(), groups = new Map(), IH = Math.max(1, $("#stmi")?.clientHeight || H - 8), fitted = new Set(), lifted = new Map();   // a branch's band too thin for a line of text: its stack gets one label, over its whole height
  for (const w of stWins()) { const p = ST.pos?.get(w.id); if (!p) continue; const g = stGroupOf(w), s = SS.get(w.id);
    const band = stMapBand(p), bh = band.height * IH, fits = !p.kid || bh >= 9;
    if (p.kid) h += `<span class="mbranch" style="top:${band.top * 100}%;height:${band.height * 100}%">`;
    h += box(p.x, p.w, (p.tab ? "mtab" : w.mini ? "mmini" : "mpage") + (w.id === ST.focus ? " on" : "") + (g ? " mws" : "") + (s?.run ? " run" : ""), (w.pad ? L("笔记", "Notes") : w.knowledge ? knowledgeTitle(w) : w.memo ? memoNodeTitle(w) : titleFor(w.key)) + (g ? " · " + g.name : "")).replace("style=\"", g ? `style="--wc:${g.c};` : "style=\"");
    const dr = !w.pad && !w.memo && !w.knowledge && !s?.run ? stDraft(w) : "";
    let lab = "";
    if (dr) lab = `<span class="mdraft" style="left:${(p.x * k).toFixed(1)}px;width:${Math.max(0, p.w * k).toFixed(1)}px" title="${esc(dr)}">${esc(dr.slice(0, 120))}</span>`;
    if (!dr && !s?.run && !s?.num && !w.pad && !w.mini && w.key) { const it = recent.get(w.key), tt = titleFor(w.key) + (it?.last ? " · " + ago(it.last) : "") + (w.completedAt ? " · " + L("完成 ", "Done ") + stCompletionTime(w.completedAt) : "");   // the finish time lives in the tooltip: on the map it sat on top of the title
      lab = `<span class="mdraft mlabel" style="left:${(p.x * k).toFixed(1)}px;width:${Math.max(0, p.w * k).toFixed(1)}px" title="${esc(tt)}">${esc(tt)}</span>`; }
    if (lab && fits) { h += p.kid ? lab.replace("style=\"", `style="--bh:${bh.toFixed(1)}px;`) : lab; if (p.kid) fitted.add(p.x); }
    else if (lab) { const r = (dr ? 2 : 0) + (w.id === ST.focus ? 1 : 0), o = lifted.get(p.x); if (!o || r > o.r) lifted.set(p.x, { r, lab }); }   // what you are typing first, then the one you are on
    if (s?.run && s.at) h += `<b class="mtime" data-runat="${s.at}" style="left:${((p.x + p.w / 2) * k).toFixed(1)}px">${stDur(Date.now() - s.at)}</b>`;
    if (s?.num) h += `<b class="mnum" style="left:${((p.x + p.w / 2) * k).toFixed(1)}px">${s.num}</b>`;   // done, not seen yet: 1 the latest
    if (p.kid) h += `</span>`;
    if (g && !w.mini) { const o = groups.get(g.id) || { ...g, l: p.x, r: p.x + p.w }; o.l = Math.min(o.l, p.x); o.r = Math.max(o.r, p.x + p.w); groups.set(g.id, o); } }
  for (const [x, o] of lifted) if (!fitted.has(x)) h += o.lab;
  for (const g of groups.values()) h += box(g.l, g.r - g.l, "mwsline", g.name).replace("style=\"", `style="--wc:${g.c};`);
  const categories = new Map();
  for (const w of stWins()) { const g = stGroupOf(w); if (g) categories.set(g.id, g); }
  // Labels use the same projected category bounds as the colour band above.
  const catAt = g => groups.has(g.id) ? (groups.get(g.id).l + groups.get(g.id).r) * k / 2 : Infinity;
  h += '<span class="stcategoryrow">' + [...categories.values()].sort((a, b) => catAt(a) - catAt(b)).map(g => {
    const x = catAt(g);
    return `<span class="pj-actions stcategory" data-x="${isFinite(x) ? x.toFixed(1) : ''}" style="--wc:${g.c}">${g.id.startsWith('pj:') ? `<button data-pjmap="${esc(g.id.slice(3))}">${esc(g.name)}</button><button data-pjnew="${esc(g.id.slice(3))}" title="${L('新建对话','New conversation')}">＋</button>` : `<span>${esc(g.name)}</span>`}</span>`;
  }).join('') + '</span>';
  for (const n of ST.nodes) { if (n.type === "win" || n.rail) continue; const p = ST.pos?.get(n.id); if (p) h += box(p.x, p.w, "mcard"); }
  const inner = $("#stmi"); if (inner._mapHTML !== h) { inner.innerHTML = h; inner._mapHTML = h; stCategoryPlace(inner); } m.dataset.k = k; m.style.setProperty("--mh", H + "px");
  stMapView();
}
function stCategoryPlace(inner) {
  const ends = [];
  for (const el of inner.querySelectorAll(".stcategoryrow > .stcategory")) {
    const width = el.offsetWidth;
    // Keep the centre anchored to its tiles. Crowded labels move down, never
    // sideways underneath a different category. Hidden groups follow at the end.
    const x = el.dataset.x === "" ? Math.max(0, ...ends) : Number(el.dataset.x) - width / 2;
    let lane = 0;
    while (ends[lane] != null && ends[lane] + 8 > x) lane++;
    el.style.left = x + "px"; el.style.top = (lane * 20) + "px";
    ends[lane] = x + width;
  }
  const row = inner.querySelector(".stcategoryrow");
  if (row) row.style.height = Math.max(16, ends.length * 20) + "px";
  // Keep wrapped category controls above the conversation windows.
  inner.closest?.("#vStage")?.style.setProperty("--stmap-bottom", (28 + Math.max(16, ends.length * 20)) + "px");
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
  for (const w of stWins()) {
    const p = ST.pos?.get(w.id); if (!p || x < p.x || x > p.x + p.w) continue;
    const band = stMapBand(p);
    if (p.kid && y != null && (y < band.top || y > band.top + band.height)) continue;
    return { w, p };
  }
  return null;
}
function stMapHideTip() {
  const tip = $("#stmtip"); if (tip) tip.hidden = true;
  ST.mapHover = null;
}
function stProjectJump(project, cx, cy) {
  stMapHideTip();
  const hit = stMapHit(cx, cy)?.w;
  const matches = w => stGroupOf(w)?.id === 'pj:' + project;
  const target = hit && matches(hit) ? hit : stWins().find(matches);
  if (target) { stFocus(target.id); stShow(target.id); }
}
function stMapTip(cx, cy) {                           // over the map: the page there, by name, with a picture of it as it is now
  const m = $("#stmap"), tip = $("#stmtip"); if (!m || !tip) return;
  if (document.querySelector('.modal') || (cy != null && document.elementFromPoint(cx, cy)?.closest('[data-pjnew], [data-pjmap], [data-stgroupfold], [data-stgroupsolo]'))) { stMapHideTip(); return; }
  const k = Number(m.dataset.k) || 1, r = m.getBoundingClientRect(), x = (cx - r.left) / k;
  const hit = stMapHit(cx, cy);
  if (!hit) { tip.hidden = true; ST.mapHover = null; return; }
  const id = hit.w.id;
  tip.style.left = Math.max(8, Math.min(innerWidth - 268, cx - 130)) + "px"; tip.style.top = r.bottom + 6 + "px"; tip.hidden = false;
  if (ST.mapHover === id) return; ST.mapHover = id;
  const t = hit.w.pad ? L("笔记", "Notes") : hit.w.knowledge ? knowledgeTitle(hit.w) : hit.w.memo ? memoNodeTitle(hit.w) : stTitle(hit.w.key);
  const dr = !hit.w.pad && !hit.w.memo && !hit.w.knowledge ? stDraft(hit.w) : "";   // something typed: show just that, not the conversation behind it
  if (dr) { tip.innerHTML = `<b>${esc(t)}</b><div class="stmthumb"><div class="mt me">${esc(dr.slice(0, 400))}</div></div>`; return; }
  tip.innerHTML = `<b>${esc(t)}</b><div class="stmthumb" id="stmthumb"></div>`;
  try {                                           // a small picture of the page: its last few turns, as they stand
    const d = hit.w.el?.querySelector("iframe")?.contentDocument, ms = [...(d?.querySelectorAll("#cdlgIn .cmsg") || [])].slice(-4);
    if (!ms.length) throw 0;
    $("#stmthumb").innerHTML = ms.map((x) => `<div class="mt ${x.classList.contains("me") ? "me" : ""}">${esc((x.querySelector(".md, .body, .text")?.innerText || x.innerText || "").trim().slice(0, 140))}</div>`).join("");
  } catch { const b = $("#stmthumb"); if (b) b.innerHTML = `<div class="cvdim" style="padding:10px">${L("这一页还没打开", "Not opened yet")}</div>`; }
}
function stMapView() { const a = $("#starena"), m = $("#stmap"), b = $("#stmv"); if (!a || !m || !b) return; const k = Number(m.dataset.k) || 0;
  b.style.left = a.scrollLeft * k + "px"; b.style.width = Math.max(8, a.clientWidth * k) + "px";
  m.scrollLeft = 0;
}
function stMapGo(cx) {
  const a = $("#starena"), m = $("#stmap"); if (!a || !m) return; const k = Number(m.dataset.k) || 1, r = m.getBoundingClientRect();
  a.scrollLeft = Math.max(0, (cx - r.left + m.scrollLeft) / k - a.clientWidth / 2); stMapView();
}
function stStep(dir) {                              // stop at either end; navigation never wraps
  const ws = stWins().filter((w) => !w.mini); if (!ws.length) return;
  const i = ws.findIndex((w) => w.id === ST.focus), n = ws[Math.max(0, Math.min(ws.length - 1, i < 0 ? 0 : i + dir))];
  if (n.id === ST.focus) return;
  stFocus(n.id); stShow(n.id); stMap();
  const p = ST.pos?.get(n.id), m = $("#stmap"); if (p && m) stMapTip(m.getBoundingClientRect().left + (p.x + p.w / 2) * (Number(m.dataset.k) || 1));
}
// Navigation never reorders pages: the map keeps the same geometry at both ends.
function stEdgeWheel(dx, dy) {
  if (Math.abs(dx) <= Math.abs(dy) || ST.drag || ST.pan || ST.rz) return false;
  const a = $("#starena"); if (!a || S.view !== "stage") return false;
  const max = Math.max(0, a.scrollWidth - a.clientWidth); if (!max) return false;
  // Safari can report rubber-band offsets outside the scroll range.
  const current = Math.max(0, Math.min(max, a.scrollLeft)), want = current + dx;
  const left = Math.max(0, Math.min(max, want));
  // Explicit instant also cancels any pending navigation animation.
  a.scrollTo({left, behavior: "instant"});
  stScheduleScroll();
  return true;
}
window.stEdgeWheel = stEdgeWheel;
// Shift-wheel pans the stage from any window, including its embedded conversation.
let stShiftMotion = null;
function stShiftWheel(e) {
  const a = $("#starena");
  if (!e.shiftKey || e.ctrlKey || e.metaKey || !a || S.view !== "stage" || ST.drag || ST.pan || ST.rz) return false;
  // WebKit/Chromium may already translate Shift-wheel to deltaX. Never add both.
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  const scale = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? a.clientWidth : 1;
  if (!delta) return true;
  let m = stShiftMotion;
  if (!m || m.arena !== a) {
    m = stShiftMotion = {arena:a, target:a.scrollLeft, last:a.scrollLeft, direction:0, frame:0, time:0};
  }
  // Reversal and other navigation discard the old tail immediately.
  if (Math.abs(a.scrollLeft - m.last) > 2 || Math.sign(delta) !== m.direction) m.target = a.scrollLeft;
  m.direction = Math.sign(delta);
  m.target = Math.max(0, Math.min(a.scrollWidth - a.clientWidth, m.target + delta * scale));
  m.smooth = (e.deltaMode !== 0 || Math.abs(delta) >= 32) && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!m.frame) m.frame = requestAnimationFrame(stShiftStep);
  return true;
}
function stShiftStep(now) {
  const m = stShiftMotion; if (!m) return;
  m.frame = 0;
  const a = m.arena;
  if (S.view !== "stage" || ST.drag || ST.pan || ST.rz || !a.isConnected || Math.abs(a.scrollLeft - m.last) > 2) { stShiftMotion = null; return; }
  m.target = Math.max(0, Math.min(Math.max(0, a.scrollWidth - a.clientWidth), m.target));
  const dt = m.time ? Math.min(50, now - m.time) : 16.7; m.time = now;
  const remaining = m.target - a.scrollLeft;
  const next = !m.smooth || Math.abs(remaining) < 1 ? m.target : a.scrollLeft + remaining * (1 - Math.exp(-dt / 35));
  a.scrollLeft = next; m.last = a.scrollLeft;
  // Scroll listeners already batch the minimap and overlay once per frame.
  if (Math.abs(m.target - m.last) >= 1) m.frame = requestAnimationFrame(stShiftStep);
  else { a.scrollLeft = m.target; stShiftMotion = null; }
}
window.stShiftWheel = stShiftWheel;
// Top and bottom strips turn an ordinary wheel into fast horizontal canvas travel.
function stBoundaryWheel(e, y = e.clientY) {
  const v = $("#vStage"), a = $("#starena");
  if (!v || !a || S.view !== "stage" || ST.drag || ST.pan || ST.rz || e.ctrlKey) return false;
  // Horizontal swipes use stEdgeWheel everywhere, including the edge strips.
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return false;
  const r = v.getBoundingClientRect();
  if (y < r.top || y > r.bottom || (y > r.top + 44 && y < r.bottom - 28)) return false;
  const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
  if (!d || a.scrollWidth <= a.clientWidth) return false;
  const scale = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? a.clientWidth : 2.5;
  a.scrollLeft = Math.max(0, Math.min(a.scrollWidth - a.clientWidth, a.scrollLeft + d * scale));
  stMapView(); return true;
}
window.stBoundaryWheel = stBoundaryWheel;

function stRefresh() {
  stSave();
  if (typeof pgLocalSave === "function") pgLocalSave();
  window.location.reload();
}
function stBar() {
  const bar = $("#stbar"); if (!bar) return;
  bar.innerHTML = `<span class="cvdim">${L("从接点拉线：卡片连进窗口，窗口右边连到另一个窗口左边 · 点线断开 · 右键加节点 · 放不下的收成横向标签", "Pull wires from the pins: a card into a window, one window's right into another's left · click a wire to cut it · right-click to add · what does not fit becomes tabs")}</span>
    <span class="grow"></span><button class="sm" data-st="refresh" title="${L("刷新界面（⌘R / Ctrl+R）", "Reload interface (⌘R / Ctrl+R)")}">⟳ ${L("刷新", "Refresh")}</button><button class="sm" data-pjpicker>${L("项目 ＋", "Project +")}</button><button class="sm" data-st="new">＋ ${L("新对话", "New chat")}</button>${typeof memoBtns === "function" ? memoBtns() : ""}`;
}

/* ------------------------------------------------ pointer */
function stCap(e) { try { $("#starena").setPointerCapture(e.pointerId); } catch {} }
function stBind() {
  const v = $("#vStage"), arena = $("#starena");
  v.addEventListener("wheel", (e) => {
    if (stShiftWheel(e) || stBoundaryWheel(e)) { e.preventDefault(); e.stopPropagation(); }
  }, { passive: false, capture: true });
  arena.addEventListener("wheel", (e) => {
    if (stEdgeWheel(e.deltaX, e.deltaY)) e.preventDefault();
  }, { passive: false });
  arena.addEventListener("contextmenu", (e) => { if (e.target.closest(".stwin")) return; e.preventDefault(); stMenu(e.clientX, e.clientY); });
  arena.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });          // no autoscroll circle
  arena.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
  arena.addEventListener("pointerdown", (e) => {
    const ground = e.target === arena || ["stnodes", "stbars", "stwires"].includes(e.target.id) || e.target.classList?.contains("stground");
    if (e.button === 1 || (e.button === 0 && ground)) { e.preventDefault(); stPanStart(e.screenX); stCap(e); return; }   // the whole stage moves sideways
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
      ST.rz = { n, d, x: e.clientX, y: e.clientY, w0: n.mini || n.par ? el.offsetWidth : n.bw || el.offsetWidth, h0: el.offsetHeight, t0: parseFloat(el.style.top), l0: l,
        edge: d.includes("e") ? l : l + el.offsetWidth,
        open: new Map((ST.units || []).map((u) => [u.kind + (u.win?.id || ""), u.open])) };   // the edge that stays
      if (!n.mini) { ST.rz.off0 = stLayout().off; ST.rz.across = stEdgeHold(n.id, d); ST.rz.pre0 = n.pre || 0; }
      v.classList.add("dragging", "resizing"); stCap(e); return; }
    if (e.target.closest("button, textarea, input, iframe, [data-doc], [data-stunfold]")) return;
    const el = e.target.closest(".stnode"); if (!el) return;
    const n = ST.nodes.find((x) => x.id === el.dataset.nid); if (!n || n.max || (n.type === "win" && !e.target.closest(".stwh"))) return;
    if (n.par) { stFocus(n.id); if (n.type === "win") { ST.pull = { n, x0: e.clientX, y0: e.clientY, sx: e.screenX, sy: e.screenY, gx: e.clientX - el.getBoundingClientRect().left }; stCap(e); } return; }   // A click focuses; a deliberate title drag detaches it into its own column.
    if (n.type === "win") stFocus(n.id); stGrab(n, e.screenX, e.screenY, e.clientX - el.getBoundingClientRect().left); stCap(e);
  });
  arena.addEventListener("pointermove", (e) => {
    if (ST.branchResize) { stResizeBranchPair(ST.branchResize, e.clientY - ST.branchResize.y); stRender(); return; }
    if (ST.pull) {
      const p = ST.pull;
      if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < 12) return;
      ST.pull = null; stDetachBranch(p.n); stGrab(p.n, p.sx, p.sy, p.gx); stDragSoon(e.screenX, e.screenY); return;
    }
    if (ST.pan) { stPanMove(e.screenX); return; }
    if (ST.rz) { const r = ST.rz, dx = e.clientX - r.x, dy = e.clientY - r.y, A = stArena();
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
      }
      return; }
    if (ST.wire) { const r = arena.getBoundingClientRect(); ST.wire.x = e.clientX - r.left + stSL(); ST.wire.y = e.clientY - r.top; stWires(); return; }
    if (ST.drag) stDragSoon(e.screenX, e.screenY);
  });
  arena.addEventListener("pointerup", (e) => {
    if (ST.branchResize) { ST.branchResize = null; v.classList.remove('dragging', 'resizing'); stSave(); return; }
    if (ST.pull) { ST.pull = null; return; }
    if (ST.pan) { stPanEnd(); return; }
    if (ST.wire) { stWireEnd(e.clientX, e.clientY); return; }
    if (ST.rz) { ST.rz = null; v.classList.remove("dragging", "resizing"); stSave(); return; }
    stDragFlush(); const d = stDrop(); if (d && !d.moved && d.n.type === "conv") stOpen(d.n.key, { win: d.n.win });
    else if (d && !d.moved && d.n.type === "win") stShow(d.n.id);
    else if (d && !d.moved && d.el.classList.contains("tab") && d.n.win) stFocus(d.n.win, true);
  });
  arena.addEventListener("pointercancel", () => {
    ST.pull = null;
    if (ST.branchResize) { ST.branchResize = null; v.classList.remove('dragging', 'resizing'); stSave(); }
    if (ST.drag) { stDragFlush(); stDrop(); }
  });
  arena.addEventListener("dblclick", (e) => { const rz = e.target.closest("[data-rz]"); if (rz) { const n = ST.nodes.find((x) => x.id === rz.closest(".stnode").dataset.nid); if (n.mini) { delete n.mw; delete n.mh; } else if (n.par) { const up = ST.nodes.find((x) => x.id === n.par); if (up) delete up.kw; } else { delete n.bw; delete n.pre; } ST.shift = null; stRender(); stSave(); } });
  arena.addEventListener("input", (e) => { const t = e.target.closest("[data-stnote]"); if (!t) return; const n = ST.nodes.find((x) => x.id === t.dataset.stnote); if (n) { n.text = t.value; stContexts(); } });
}
document.addEventListener("click", (e) => {
  if (S.view !== "stage") return;
  if (!e.target.closest(".stmenu")) document.querySelector(".stmenu")?.remove();
  const ws = e.target.closest("[data-stws]"); if (ws) { const m = ws.closest(".stmenu"), n = ST.nodes.find((x) => x.id === m.dataset.nid), op = ws.dataset.stws; m.remove(); if (!n) return;
    if (op === "rename") { const w = stWs(n), t = w && prompt(L("这个工作区叫什么？", "Name this workspace"), w.name); if (t?.trim()) { w.name = t.trim().slice(0, 40); stRender(); stSave(); } return; }
    stWsJoin(n, op === "out" ? null : op); return; }
  const fk = e.target.closest("[data-stfork]"); if (fk) { const m = fk.closest(".stmenu"), n = ST.nodes.find((x) => x.id === m.dataset.nid); m.remove(); if (n) stFork(n, fk.dataset.stfork); return; }
  const add = e.target.closest("[data-stadd]"); if (add) { const m = add.closest(".stmenu"), at = JSON.parse(m.dataset.at); m.remove(); stAdd(add.dataset.stadd, at); return; }
  const sy = e.target.closest("[data-stsync]"); if (sy) { stSync(sy); return; }
  const td = e.target.closest("[data-sttidy]"); if (td) { stTidy(td); return; }
  if (e.target.closest("[data-stlistmin]")) { stDropToggle(false); return; }
  if (e.target.closest("#stlbar")) { stDropToggle(); return; }
  const uf = e.target.closest("[data-stunfold]"); if (uf) { const id = uf.dataset.stunfold; if (id === "shelf") { const w = stWins(); for (const o of w) o.bw = Math.min(o.bw || ST_WW, ST_WW); } else stFocus(id, true); return; }
  const cut = e.target.closest("[data-unlink]"); if (cut) { const [to, from, pin] = cut.dataset.unlink.split("|"), w = ST.nodes.find((x) => x.id === to); if (w) w.links = (w.links || []).filter((l) => !(l.from === from && l.pin === Number(pin))); stRender(); stSave(); stContexts(); return; }
  const del = e.target.closest("[data-stdel]"); if (del) { ST.nodes = ST.nodes.filter((x) => x.id !== del.dataset.stdel); stRender(); stSave(); stContexts(); return; }
  const expand = e.target.closest('[data-stexpand]');
  if (expand) { const n = ST.nodes.find(n => n.id === expand.dataset.stexpand); if (n) stMini(n, false); return; }
  const restore = e.target.closest('[data-strestore]');
  if (restore) { const child = ST.nodes.find(n => n.id === restore.dataset.strestore), parent = ST.nodes.find(n => n.id === child?.par);
    if (parent && child) stToggleChatBranch(parent, child.key); return; }
  const w = e.target.closest("[data-stw]"); if (w) { const n = ST.nodes.find((x) => x.id === w.closest(".stnode").dataset.nid); if (!n) return;
    if (w.dataset.stw === "project") { pjAssignDialog(n.key); return; }
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
    if (w.dataset.stw === "side") { n.side = n.side === false; w.classList.toggle("on", n.side); stSide(n); stSave(); return; }
    if (w.dataset.stw === "min") { stMini(n, !n.small); } else if (w.dataset.stw === "close") stClose(n); else stMax(n, !n.big); return; }
  const t = e.target.closest("[data-st]");
  if (t?.dataset.st === "refresh") { stRefresh(); return; }
  if (t?.dataset.st === "new") stOpen(null);
});
document.addEventListener("keydown", (e) => { if (S.view !== "stage" || e.key !== "Escape") return; const n = ST.nodes.find((x) => x.big); if (n) stMax(n, false); });

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
  if (view !== "stage") {
    const foot = document.querySelector("#sttoolsbody > .foot"), rail = document.querySelector(".app > .rail");
    if (foot && rail) rail.appendChild(foot);
  }
  const r = _showBK(view, opts); stBackBtn(view);
  document.querySelector(".app")?.classList.toggle("onstage", view === "stage"); stOver?.(); return r;
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
if (Q.get("embed") && window.parent !== window) {   // inside a page: held with the middle button, it is the stage that moves
  let panning = false;
  document.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); }, true);
  document.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); }, true);
  document.addEventListener("pointerdown", (e) => { if (e.button !== 1) return; try { if (!window.parent.stPanStart) return; e.preventDefault(); window.parent.stPanStart(e.screenX); panning = true; e.target.setPointerCapture?.(e.pointerId); } catch {} }, true);
  document.addEventListener("pointermove", (e) => { if (panning) { e.preventDefault(); try { window.parent.stPanMove(e.screenX); } catch {} } }, true);
  const stop = () => { if (!panning) return; panning = false; try { window.parent.stPanEnd(); } catch {} };
  document.addEventListener("pointerup", stop, true); document.addEventListener("pointercancel", stop, true);
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
