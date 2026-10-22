/* PGA app · the conversation page laid out like Claude's: on the left every conversation, newest first; in the middle the
   conversation (with a button to the latest words); on the right, at the top, where this conversation runs (folder,
   machine, agent, access) and how full its context is; under it the world tree as nested folders, always there — open a
   topic to zoom into it, open a conversation and the page zooms into it from its row, no hard switch; the current
   conversation lists its turns, and you can carry on from any of them. The agents' details fold away under that. */

/* ------------------------------------------------ the left: every conversation, newest first */
const _hereKey = () => (S.lineView ? S.lineTarget : S.imp ? S.imp.key : S.treeItem ? S.treeItem.item : S.chat);
function recentItems() {
  const by = new Map();
  for (const x of S.tl?.sessions || []) {
    const r = by.get(x.item);
    if (!r) by.set(x.item, { ...x, last: x.end || x.at, n: 1 });
    else { r.n++; if ((x.end || x.at) > r.last) { r.last = x.end || x.at; r.id = x.id; } }
  }
  for (const c of S.chats || []) if (!by.has(c.key)) by.set(c.key, { item: c.key, id: null, kind: "chat", title: c.title, last: c.last_at, agent: c.agent || "", n: 1, ref: { chat: c.key } });
  return [...by.values()].sort((a, b) => String(b.last || "").localeCompare(String(a.last || "")));
}
const dayGroup = (iso) => { const d = new Date(iso), now = new Date(), days = Math.floor((new Date(now.toDateString()) - new Date(d.toDateString())) / 864e5);
  return days <= 0 ? L("今天", "Today") : days === 1 ? L("昨天", "Yesterday") : days < 7 ? L("最近 7 天", "Previous 7 days") : days < 30 ? L("最近 30 天", "Previous 30 days") : L("更早", "Older"); };
function renderRecent() {
  const box = $("#clist"); if (!box) return;
  const xs = recentItems(), here = _hereKey(), keep = box.querySelector(".rlist")?.scrollTop;
  let html = "", g = null;
  for (const x of xs) {
    const grp = x.last ? dayGroup(x.last) : L("更早", "Older");
    if (grp !== g) { g = grp; html += `<div class="rgrp">${esc(grp)}</div>`; }
    html += `<div class="ritem ${x.item === here ? "on" : ""}" data-ritem="${esc(x.item)}" title="${esc(x.title || "")}"><b>${esc(x.title || L("新对话", "New chat"))}</b>
      <span>${esc([x.kind === "tree" ? L("树", "tree") : x.kind === "import" ? (x.agent || L("导入", "imported")) : "PGA", x.last ? ago(x.last) : ""].filter(Boolean).join(" · "))}</span></div>`;
  }
  box.innerHTML = `<div class="ch"><button class="ghost sm" data-act="search" title="${L("搜索所有对话", "Search everything")}">${I.search}</button><span class="grow"></span>
      <button class="sm ghost" id="tlImport" title="${L("导入别的应用里的对话", "Bring in conversations from other apps")}">${L("导入", "Import")}</button><button class="sm" id="newChat">${L("＋ 新对话", "+ New chat")}</button></div>
    <div class="rlist">${html || `<div class="empty" style="padding:20px">${L("还没有对话", "No conversations yet")}</div>`}</div>`;
  if (keep) box.querySelector(".rlist").scrollTop = keep;
}
renderTimeline = renderRecent;
function openItem(key) {
  const x = recentItems().find((y) => y.item === key); if (!x) return;
  if (S.view !== "chats") show("chats");
  S.lineView = null; S.tlLine = null; S.tlSel = key;
  if (x.kind === "tree") { S.chat = null; S.imp = null; S.treeItem = x; renderRecent(); renderChat(); return; }
  S.treeItem = null;
  if (x.kind === "chat") { S.imp = null; S.chat = key; history.replaceState(null, "", qs()); renderRecent(); renderChat(); loadChat(key); return; }
  S.chat = null; S.imp = { cid: x.ref.conversation, key, line: x.line }; renderRecent(); renderChat(); loadImported(x.ref.conversation);
}

/* ------------------------------------------------ the middle: down to the latest words */
function toBottomButton() {
  const pane = $(".cpane"); if (!pane || $("#toBottom")) return;
  pane.insertAdjacentHTML("beforeend", `<button id="toBottom" class="tobottom" hidden title="${L("到最底下", "To the latest")}">↓</button>`);
  const d = $("#cdlg"); d.addEventListener("scroll", () => { $("#toBottom").hidden = d.scrollHeight - d.scrollTop - d.clientHeight < 240; });
}

/* ------------------------------------------------ the right, top: where it runs, and its context */
function envCard() {
  const box = $("#cenv"); if (!box || S.view !== "chats") return;
  const key = S.chat, turns = (key && S.chatTurns[key]) || [], agents = turns.filter((t) => t.role === "agent" && t.run);
  const acc = (key && S.acc?.[key]) || S.acc?.["*new"] || {}, last = agents[agents.length - 1], h = last?.how || {}, u = h.usage || {};
  const win = h.window || 200000, used = u.input || 0, agentName = $("#chatAgent")?.value || S.chatAgent || "auto";
  const est = (s) => Math.round(String(s || "").length / 2.2);           // characters → tokens, roughly (Chinese ~1.5–2 chars a token)
  const parts = [
    [L("消息", "Messages"), turns.slice(-12).reduce((a, t) => a + est(t.text), 0), "var(--blue)"],
    [L("你的设定", "Instructions"), est(S.chatSys?.[key]), "var(--accent)"],
    [L("世界树层级", "World level"), S.chatWorld?.[key]?.talks_to ? 1500 : 0, "#b48cff"],
    [L("引用的知识", "Knowledge"), (S.chatRefs || []).length * 2500, "var(--green)"],
  ];
  const known = parts.reduce((a, p) => a + p[1], 0), sys = Math.max(0, used - known);
  if (used) parts.push([L("系统与工具", "System and tools"), sys, "#f08aa8"]);
  const total = used || known, pct = Math.min(100, total / win * 100);
  const folder = acc.folder ? acc.folder.replace(/^\/Users\/[^/]+/, "~") : L("这段对话自己的文件夹", "Its own folder");
  box.innerHTML = `<div class="ecard"><div class="eh">${L("环境", "Environment")}</div>
      <div class="erow"><span class="ei">💻</span>${L("这台电脑", "This computer")}<em>${esc(location.hostname)}</em></div>
      <div class="erow"><span class="ei">📁</span><span class="ef" title="${esc(acc.folder || "")}">${esc(folder)}</span><a href="#" data-pickdir="1">${L("换", "Change")}</a></div>
      <div class="erow"><span class="ei">◆</span>${esc(agentLabel(last?.agent || agentName))}<em>${esc(last?.model || h.model || "")}</em></div>
      <div class="erow"><span class="ei">🔒</span>${esc({ read: L("只读", "Read only"), write: L("可写文件", "May write"), full: L("完全访问", "Full access") }[acc.access || "read"] || acc.access)}${acc.mcp ? " · MCP" : ""}</div></div>
    <div class="ecard"><div class="eh">${L("上下文", "Context")}</div>
      <div class="eu"><b>${pct.toFixed(0)}% ${L("已用", "used")}</b><span>${kfmt(total)} / ${kfmt(win)}</span></div>
      <div class="ebar">${parts.filter((p) => p[1] > 0).map((p) => `<i style="width:${(p[1] / win * 100).toFixed(2)}%;background:${p[2]}"></i>`).join("")}</div>
      ${parts.map((p) => `<div class="erow"><span class="ed" style="background:${p[2]}"></span>${esc(p[0])}<em>${kfmt(p[1])}</em><em class="ep">${(p[1] / win * 100).toFixed(1)}%</em></div>`).join("")}
      <div class="erow dimt"><span class="ed" style="background:var(--line-3)"></span>${L("剩余", "Free")}<em>${kfmt(Math.max(0, win - total))}</em><em class="ep">${(100 - pct).toFixed(1)}%</em></div>
      ${u.cached ? `<div class="enote">${L(`上次回答读入的 ${Math.round(u.cached / Math.max(1, used) * 100)}% 来自缓存`, `${Math.round(u.cached / Math.max(1, used) * 100)}% of the last read came from cache`)}</div>` : ""}
      ${!used ? `<div class="enote">${L("还没有回答：用量是按文字估的", "No answer yet: estimated from the text")}</div>` : ""}</div>`;
}

/* ------------------------------------------------ the right, below: the world tree as nested folders */
S.wtOpen = new Set((() => { try { return JSON.parse(localStorage.getItem("pga_wt_open") || "[]"); } catch { return []; } })());
async function wtFetch(force) {
  if (W.nodes.length && !force && Date.now() - (W.fetched || 0) < 60000) return;
  try { W.data = await api(`/v1/users/${S.uid}/world`); } catch { return; }
  W.nodes = W.data.nodes.map((n) => ({ ...n, label: n.title, type: wtype(n) })); W.byId = new Map(W.nodes.map((n) => [n.id, n])); W.fetched = Date.now();
}
function wtCurrent() {
  const key = _hereKey(); if (!key) return null;
  return W.nodes.find((n) => n.ref === key) || null;
}
function wtSaveOpen() { try { localStorage.setItem("pga_wt_open", JSON.stringify([...S.wtOpen].slice(-300))); } catch {} }
function worldPanel() {
  const box = $("#ctree"); if (!box || S.view !== "chats") return;
  if (!W.nodes.length) { box.innerHTML = `<div class="eh">${L("世界树", "World tree")}</div><div class="ca-empty">${W.data && !W.data.built ? L("世界树还没有生成：到「世界树」页生成", "Not built yet: build it on the world tree page") : "…"}</div>`; wtFetch().then(() => W.nodes.length && worldPanel()); return; }
  const cur = wtCurrent(), root = W.nodes.find((n) => n.kind === "root");
  if (cur && !W.autoOpened?.has(cur.id)) { worldPath(cur).forEach((x) => S.wtOpen.add(x.id)); (W.autoOpened = W.autoOpened || new Set()).add(cur.id); }
  const kids = (id) => W.nodes.filter((n) => n.parent === id && wShown(n)).sort((a, b) => (a.kind === "leaf") - (b.kind === "leaf") || String(b.last || "").localeCompare(String(a.last || "")));
  const turnsOf = () => { const ts = S.chatTurns[S.chat] || []; return ts.map((t, i) => ({ t, i })).filter(({ t }) => t.role === "user" && t.run); };
  const row = (n, d) => {
    const ks = n.kind === "leaf" ? [] : kids(n.id), open = S.wtOpen.has(n.id), isCur = cur && n.id === cur.id;
    const icon = n.kind === "leaf" ? (n.who === "agent" ? "◇" : "💬") : n.kind === "aim" ? "✦" : n.kind === "plan" ? "◌" : open ? "▾" : "▸";
    let h = `<div class="wtr ${n.kind} ${isCur ? "cur" : ""}" style="--d:${d}" data-wtr="${n.id}"><span class="wti">${icon}</span><span class="wtt">${esc(n.kind === "root" ? L("世界", "World") : n.title)}${W.showGist && n.gist && n.kind === "leaf" ? `<small>${esc(n.gist)}</small>` : ""}</span>${n.kind !== "leaf" && ks.length ? `<em>${ks.length}</em>` : ""}${n.kind !== "leaf" && n.kind !== "aim" ? `<button class="wtz" data-wbenter="${n.id}" title="${L("在世界树里放大这一层", "Up close in the world tree")}">⧉</button>` : ""}${n.kind !== "leaf" && n.kind !== "root" ? `<button class="wtz" data-wttalk="${n.id}" title="${L("和这一层对话", "Talk to this level")}">💬</button>` : ""}</div>`;
    if (isCur && S.chat && n.kind === "leaf") {                       // the conversation you are in: its turns, carry on from any
      const tt = turnsOf(), ts = S.chatTurns[S.chat] || [];
      h += `<div class="wtturns" style="--d:${d + 1}">${tt.map(({ t, i }) => { const prev = ts.slice(0, i).reverse().find((x) => x.role === "agent" && x.run);
        return `<div class="wtturn" data-wtgo="${t.run}"><span>${esc(String(t.text).replace(/\s+/g, " ").slice(0, 40))}</span><button class="sm ghost" ${prev ? `data-cbranch="${prev.run}" data-ckey="${esc(S.chat)}"` : `data-wtfresh="${esc(t.text.slice(0, 2000))}"`} title="${L("从这一问之前分出一段新对话，接着从这里聊", "Branch just before this question and carry on from here")}">${L("从这里继续", "Carry on here")}</button></div>`; }).join("")}</div>`;
    }
    if (open && ks.length) h += `<div class="wtkids ${W.zoomed === n.id ? "zoom" : ""}">${ks.map((k) => row(k, d + 1)).join("")}</div>`;
    return h;
  };
  const keep = box.querySelector(".wtlist")?.scrollTop;
  box.innerHTML = `<div class="eh">${L("世界树", "World tree")}<span class="grow"></span><a href="#" data-view="graph" title="${L("打开整棵世界树", "Open the whole tree")}">${L("全图", "Full view")} ↗</a></div>
    <div class="wtlist">${row(root, 0)}</div>`;
  W.zoomed = null;
  const list = box.querySelector(".wtlist"); if (keep != null) list.scrollTop = keep;
  const c = list.querySelector(".wtr.cur"); if (c && !W.scrolledTo?.includes(cur.id)) { c.scrollIntoView({ block: "center" }); W.scrolledTo = cur.id; }
}
/* opening a conversation from the tree: the conversation grows out of its row instead of a hard switch */
function zoomFrom(rect) {
  const pane = $("#cdlg"); if (!pane || !rect || !pane.animate) return;
  const r = pane.getBoundingClientRect(), sx = rect.width / r.width, sy = Math.max(.05, rect.height / r.height);
  pane.animate([{ transformOrigin: "0 0", transform: `translate(${rect.left - r.left}px, ${rect.top - r.top}px) scale(${sx}, ${sy})`, opacity: .2 },
                { transformOrigin: "0 0", transform: "none", opacity: 1 }], { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
}
async function openFromTree(n, el) {
  const rect = el?.getBoundingClientRect();
  if (n.kind === "aim") { show("tree", { aim: n.ref?.slice(4) || n.open?.tree }); return; }
  const key = n.ref; if (!key) return;
  if (key.startsWith("chat:") || n.open?.chat) { S.lineView = null; S.imp = null; S.treeItem = null; S.chat = n.open?.chat || key; history.replaceState(null, "", qs()); renderRecent(); renderChat(); loadChat(S.chat); }
  else openItem(key);
  requestAnimationFrame(() => zoomFrom(rect));
}
/* in the world tree page (3D / 2D) a conversation shrinks the tree away into the right panel, then the conversation opens */
const _openLeafFull = openLeaf;
openLeaf = async function (n) {
  const v = $("#vGraph");
  if (S.view === "graph" && v?.animate) {
    const a = v.animate([{ transform: "none", opacity: 1, transformOrigin: "100% 60%" }, { transform: "scale(.28)", opacity: 0, transformOrigin: "100% 60%" }],
      { duration: 380, easing: "cubic-bezier(.4,0,.2,1)" });
    await a.finished.catch(() => {});
  }
  if (n.ref && recentItems().some((y) => y.item === n.ref)) openItem(n.ref); else await _openLeafFull(n);   // that conversation itself, not its whole line
  const p = $("#ctree"); if (p?.animate) p.animate([{ opacity: 0, transform: "scale(1.15)" }, { opacity: 1, transform: "none" }], { duration: 380, easing: "cubic-bezier(.2,.8,.2,1)" });
};

function renderRight() { envCard(); worldPanel(); }
const _rcPanel = renderChat;
renderChat = function () { _rcPanel(); toBottomButton(); renderRight(); };

document.addEventListener("click", async (e) => {
  const ri = e.target.closest("[data-ritem]"); if (ri) { openItem(ri.dataset.ritem); return; }
  if (e.target.closest("#toBottom")) { const d = $("#cdlg"); d.scrollTo({ top: d.scrollHeight, behavior: "smooth" }); return; }
  const tk = e.target.closest("[data-wttalk]"); if (tk) { e.stopPropagation(); const n = W.byId.get(tk.dataset.wttalk); if (n) talkTo(n); return; }
  const fr = e.target.closest("[data-wtfresh]"); if (fr) { S.chat = null; S.imp = null; S.lineView = null; renderChat(); const b = $("#chatText"); if (b) { b.value = fr.dataset.wtfresh; b.focus(); } return; }
  const go = e.target.closest("[data-wtgo]"); if (go && !e.target.closest("button")) { const el = document.getElementById("t-" + go.dataset.wtgo); if (el) { const d = $("#cdlg"); d.scrollTo({ top: el.getBoundingClientRect().top - d.getBoundingClientRect().top + d.scrollTop - 12, behavior: "smooth" }); } return; }
  const r = e.target.closest("[data-wtr]"); if (!r || e.target.closest("button")) return;
  const n = W.byId.get(r.dataset.wtr); if (!n) return;
  if (n.kind === "leaf" || n.kind === "aim") { openFromTree(n, r); return; }
  if (S.wtOpen.has(n.id) && n.kind !== "root") S.wtOpen.delete(n.id); else { S.wtOpen.add(n.id); W.zoomed = n.id; }   // a topic: open it, zooming in
  wtSaveOpen(); worldPanel();
});
window.addEventListener("pga:look", () => renderRight());
setInterval(() => { if (S.view === "chats") wtFetch(true).then(() => worldPanel()); }, 120000);

/* the world tree page: its top-left panel folds to one line */
W.barMin = (() => { try { return localStorage.getItem("pga_gbar_min") === "1"; } catch { return false; } })();
const _dwb = drawWorldBar;
drawWorldBar = function () {
  _dwb(); const bar = $("#gbar"); if (!bar) return;
  bar.classList.toggle("min", !!W.barMin);
  bar.querySelector(".gh")?.insertAdjacentHTML("afterbegin", `<button class="sm ghost gfold" data-gmin="1" title="${W.barMin ? L("展开", "Expand") : L("收起", "Collapse")}">${W.barMin ? "▸" : "▾"}</button>`);
};
document.addEventListener("click", (e) => { if (!e.target.closest("[data-gmin]")) return; W.barMin = !W.barMin; try { localStorage.setItem("pga_gbar_min", W.barMin ? "1" : "0"); } catch {} drawWorldBar(); });
