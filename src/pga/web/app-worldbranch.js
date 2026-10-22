/* PGA app · the world tree, close up. Clicking a node of the tree (3D or 2D) zooms into it and straightens its branch into
   a vertical spine:
   - its ancestors above it;
   - the level itself, with what you can do to it;
   - below, its sub-topics and conversations, each on a twig off the spine.

   A conversation opens one level further, into its segments: what you asked, grouped by matter (pga.segments). Each
   question there opens the conversation at that point, docked on the right.

   Every card has a back, its data tree: what the conversation read, cited and did. "数据树" turns all of them over.

   On the right edge, a strip with a mark for every question at this level (like DeepSeek's question index): hover for
   the question, click to go to it.

   "← 整棵树" turns the spine back into the tree. */

const WB = { id: null, open: new Set(), flip: new Set(), allFlip: false, det: {}, peek: null, from: null };
const wbTitle = (n) => (n.kind === "root" ? L("顶层", "Top") : n.title);
const wbKids = (n) => W.nodes.filter((k) => k.parent === n.id && !k.hidden && (W.showAgent !== false || k.who !== "agent"))
  .sort((a, b) => (a.kind === "leaf") - (b.kind === "leaf") || String(b.last || "").localeCompare(String(a.last || "")));
function wbScroll(id, where = "center") {        // scroll the spine itself, never the page around it
  const el = document.querySelector(`[data-wbn="${id}"]`), b = $("#wbBody"); if (!el || !b) return;
  const top = el.getBoundingClientRect().top - b.getBoundingClientRect().top + b.scrollTop;
  b.scrollTo({ top: Math.max(0, where === "start" ? top - 16 : top - b.clientHeight / 3), behavior: "smooth" });
}
const wbDay = (iso) => (iso ? new Date(iso).toLocaleDateString(EN ? "en-GB" : "zh-CN", { month: "short", day: "numeric" }) : "");

/* ------------------------------------------------ in and out of the close-up */
async function wtEnter(n, from) {
  if (!n) return;
  const leaf = n.kind === "leaf" ? n : null, level = leaf ? W.byId.get(n.parent) || n : n;
  if (S.view !== "graph") show("graph");
  let box = $("#wb");
  if (!box) { $("#vGraph").insertAdjacentHTML("beforeend", `<section class="wb" id="wb" hidden></section>`); box = $("#wb"); }
  const v = $("#vGraph").getBoundingClientRect(), ox = (from?.x ?? v.left + v.width / 2) - v.left, oy = (from?.y ?? v.top + v.height / 2) - v.top;
  WB.from = { ox, oy, ang: (from?.angle ?? 90) - 90 };                   // the branch's angle on screen; the spine stands at 90°
  if (G.mode === "3d" && typeof w3FlyTo === "function") w3FlyTo(n);
  $("#vGraph").classList.add("wbon");
  wbGo(level.id, { anim: false });
  if (leaf) { WB.open.add(leaf.id); wbLoad(leaf.id, true); }
  box.hidden = false;
  box.animate?.([{ transformOrigin: `${ox}px ${oy}px`, transform: `rotate(${WB.from.ang}deg) scale(.18)`, opacity: 0 },
                 { transformOrigin: `${ox}px ${oy}px`, transform: "none", opacity: 1 }], { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" });
  if (leaf) setTimeout(() => wbScroll(leaf.id), 560);
}
async function wtLeave() {
  const box = $("#wb"); if (!box || box.hidden) return; const f = WB.from || { ox: box.clientWidth / 2, oy: box.clientHeight / 2, ang: 0 };
  if (box.animate) await box.animate([{ transformOrigin: `${f.ox}px ${f.oy}px`, transform: "none", opacity: 1 },
                                      { transformOrigin: `${f.ox}px ${f.oy}px`, transform: `rotate(${f.ang}deg) scale(.18)`, opacity: 0 }], { duration: 340, easing: "cubic-bezier(.5,0,.75,0)" }).finished.catch(() => {});
  box.hidden = true; $("#vGraph").classList.remove("wbon"); WB.id = null; wbPeekClose();
}
function wbGo(id, opts = {}) {                    // another level: deeper slides up, back up slides down
  const prev = WB.id, n = W.byId.get(id); if (!n) return;
  const depth = (x) => (x ? x.depth || 0 : 0), down = depth(n) >= depth(W.byId.get(prev));
  WB.id = id; G.sel = id; wbRender();
  const col = $("#wbCol"); if (opts.anim !== false && prev && col?.animate) col.animate([{ transform: `translateY(${down ? 60 : -60}px)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" });
  $("#wbBody")?.scrollTo({ top: 0 });
  wbStrip();
}

/* ------------------------------------------------ drawing the spine */
function wbRender() {
  const box = $("#wb"), n = W.byId.get(WB.id); if (!box || !n) return;
  const chain = []; for (let p = n.parent && W.byId.get(n.parent); p; p = p.parent && W.byId.get(p.parent)) chain.unshift(p);
  const kids = wbKids(n), topics = kids.filter((k) => k.kind !== "leaf"), convs = kids.filter((k) => k.kind === "leaf");
  box.innerHTML = `<div class="wbbar"><button class="sm" data-wb="leave">← ${L("整棵树", "Whole tree")}</button>
      <span class="wbcr">${[...chain, n].map((p, i, a) => i === a.length - 1 ? `<b>${esc(wbTitle(p))}</b>` : `<a href="#" data-wbgo="${p.id}">${esc(wbTitle(p))}</a><span>›</span>`).join("")}</span>
      <span class="grow"></span>
      <button class="sm ghost ${WB.allFlip ? "on2" : ""}" data-wb="flipall" title="${L("把每张卡片翻到背面：它读过、引用过、用过什么", "Turn every card over: what it read, cited and used")}">${L("数据树", "Data tree")}</button>
      <button class="sm ghost" data-wb="index" title="${L("把你问过的所有问题汇总成一个文件，按主题、对话、分段排", "Every question you asked, in one file, by topic, conversation and segment")}">${L("问题索引文件", "Questions file")}</button></div>
    <div class="wbmain"><div class="wbbody" id="wbBody"><div class="wbcol" id="wbCol">
      ${chain.map((p) => `<div class="wbanc" data-wbgo="${p.id}"><i></i><span>${esc(wbTitle(p))}</span></div>`).join("")}
      <div class="wbhere"><i></i><div class="wbhc">
        <div class="wbht"><b>${esc(wbTitle(n))}</b><span class="cvdim">${L(`${topics.length} 个子主题 · ${convs.length} 段对话`, `${topics.length} sub-topics · ${convs.length} conversations`)}</span></div>
        ${n.summary ? `<div class="wbsum">${esc(n.summary)}</div>` : `<div class="cvdim">${L("还没有概括", "No summary yet")}</div>`}
        <div class="wbacts"><button class="sm" data-wbact="add">＋ ${L("子主题", "Sub-topic")}</button><button class="sm ghost" data-wbact="rename">${L("改名", "Rename")}</button><button class="sm ghost" data-wbact="summary">${L("改概括", "Summary")}</button>
          ${n.kind !== "root" ? `<button class="sm ghost" data-wbact="move">${L("移到…", "Move…")}</button><button class="sm ghost" data-wbact="remove">${L("删除这一层", "Remove level")}</button><button class="sm ghost" data-wbact="talk">💬 ${L("和这一层对话", "Talk to this level")}</button>` : ""}</div>
      </div></div>
      <div class="wbkids">${topics.map(wbTopic).join("")}${convs.map(wbConv).join("")}${kids.length ? "" : `<div class="cvdim wbempty">${L("这一层下面还没有东西", "Nothing under this level yet")}</div>`}</div>
    </div></div><aside class="wbq" id="wbQ"></aside><aside class="wbside" id="wbSide" hidden></aside></div>`;
  for (const id of WB.open) if (W.byId.get(id)?.parent === WB.id) wbLoad(id);
}
function wbTopic(k) {
  const sub = W.nodes.filter((x) => x.parent === k.id && !x.hidden);
  return `<div class="wbk wbt" data-wbn="${k.id}"><i></i><div class="wbc" data-wbgo="${k.id}">
    <div class="wbct"><b>${esc(k.title)}</b><span class="cvdim">${L(`${sub.filter((x) => x.kind !== "leaf").length} 个子主题 · ${k.count || sub.filter((x) => x.kind === "leaf").length} 段对话`, `${k.count || 0} conversations`)}</span><span class="grow"></span>
      <button class="wbm" data-wbmenu="${k.id}" title="${L("更多", "More")}">⋯</button></div>
    ${k.summary ? `<div class="wbsum s">${esc(k.summary)}</div>` : ""}</div></div>`;
}
function wbConv(k) {
  const open = WB.open.has(k.id), flip = WB.allFlip || WB.flip.has(k.id), d = WB.det[k.id];
  const front = `<div class="wbct"><b>${esc(k.title)}</b><span class="cvdim">${esc(agentLabel(k.agent || ""))} · ${wbDay(k.last)}${k.turns ? ` · ${L(`${k.turns} 轮`, `${k.turns} turns`)}` : ""}</span><span class="grow"></span>
      <button class="wbm" data-wbflip="${k.id}" title="${L("翻到背面：它的数据树", "Turn it over: its data tree")}">⟲</button><button class="wbm" data-wbmenu="${k.id}" title="${L("更多", "More")}">⋯</button></div>
    ${k.gist ? `<div class="wbgist">${esc(k.gist)}</div>` : k.excerpt ? `<div class="wbgist">${esc(k.excerpt)}</div>` : ""}
    <div class="wbrow"><button class="sm ghost" data-wbopen="${k.id}">${open ? "▾" : "▸"} ${L("分段与提问", "Segments and questions")}${d?.segments ? ` (${d.segments.length})` : ""}</button><button class="sm ghost" data-wbchat="${k.id}">${L("看对话", "Read")}</button></div>
    ${open ? `<div class="wbsegs">${d ? (d.segments || []).map((s, i) => `<div class="wbseg"><i></i><div><div class="wbst"><b>${esc(s.title || L(`第 ${i + 1} 段`, `Segment ${i + 1}`))}</b><span class="cvdim">${L(`${s.questions.length} 问`, `${s.questions.length} questions`)}</span></div>
        ${s.questions.map((q) => `<div class="wbqq" data-wbq="${k.id}" data-run="${q.run || ""}" title="${esc(q.text.slice(0, 600))}"><span>${esc(q.text.replace(/\s+/g, " ").slice(0, 120))}</span><em>${wbDay(q.at)}</em></div>`).join("")}</div></div>`).join("")
        || `<div class="cvdim">${L("这段对话里没有读到你的提问", "No questions found in this conversation")}</div>` : `<div class="cvdim"><span class="spin"></span> ${L("在按你的提问分段…", "Splitting by your questions…")}</div>`}</div>` : ""}`;
  const back = wbBack(k, d);
  return `<div class="wbk wbv ${flip ? "flip" : ""}" data-wbn="${k.id}"><i></i><div class="wbcard"><div class="wbc front">${front}</div><div class="wbc back">${back}</div></div></div>`;
}
function wbBack(k, d) {                          // the data tree behind a conversation
  const c = d?.context;
  const head = `<div class="wbct"><b>${L("数据树", "Data tree")} · ${esc(k.title)}</b><span class="grow"></span><button class="wbm" data-wbflip="${k.id}" title="${L("翻回正面", "Turn back")}">⟲</button></div>`;
  if (!c) return head + `<div class="cvdim">${d ? L("这是从别的应用导入的对话，PGA 读不到它用过什么", "Imported from another app: PGA cannot see what it used") : `<span class="spin"></span> ${L("在读它用过什么…", "Reading what it used…")}`}</div>`;
  const row = (label, xs, f = (x) => esc(x)) => xs?.length ? `<div class="wbdt"><span>${label}</span><div>${xs.map((x) => `<em>${f(x)}</em>`).join("")}</div></div>` : "";
  const any = c.topic || c.related.length || c.datasets.length || c.attachments.length || c.read.length || c.changed.length || c.web.length || c.skills.length || c.tools.length || c.branched_from;
  return head + (any ? [
    c.topic ? row(L("对着哪一层", "Talked to"), [c.topic], (x) => `<a href="#" data-wbgo="${esc(x.id)}">${esc(x.title)}</a>`) : "",
    c.branched_from ? row(L("分支自", "Branched from"), [c.branched_from], (x) => `<a href="#" data-wbref="${esc(x.key)}">${esc((recentItems().find((y) => y.item === x.key)?.title || x.key).slice(0, 40))}</a>`) : "",
    row(L("引用的对话", "Conversations used"), c.related, (x) => `<a href="#" data-wbref="${esc(x.ref)}">${esc(x.title)}</a>`),
    row(L("数据集", "Datasets"), c.datasets, (x) => esc(x.title)), row(L("附件", "Attachments"), c.attachments),
    row(L("技能", "Skills"), c.skills), row(L("MCP 工具", "MCP tools"), c.tools), row(L("读过的文件", "Files read"), c.read.slice(0, 12)),
    row(L("改过的文件", "Files changed"), c.changed.slice(0, 12)), row(L("网页", "Web pages"), c.web.slice(0, 8)),
    c.commands ? `<div class="wbdt"><span>${L("命令", "Commands")}</span><div><em>${L(`跑过 ${c.commands} 条`, `${c.commands} run`)}</em></div></div>` : ""].join("")
    : `<div class="cvdim">${L("它只用了对话本身：没有引用别的对话、数据或技能，也没有读写文件", "It used only the conversation itself")}</div>`);
}
async function wbLoad(id, split = true) {
  const k = W.byId.get(id); if (!k || k.kind !== "leaf") return;
  if (WB.det[id]?.context || (WB.det[id] && !split) || WB.det[id]?.loading) { wbRedraw(id); return; }
  WB.det[id] = { ...(WB.det[id] || {}), loading: true };
  try { WB.det[id] = await api(`/v1/world/${id}/detail?split=${split ? "true" : "false"}`); if (!WB.det[id].context && split) WB.det[id].context = null; }
  catch (err) { WB.det[id] = { segments: [], questions: [], context: null, error: err.message }; }
  wbRedraw(id); wbStrip();
}
function wbRedraw(id) { const el = document.querySelector(`[data-wbn="${id}"]`), k = W.byId.get(id); if (el && k) el.outerHTML = wbConv(k); }

/* ------------------------------------------------ the question strip (DeepSeek's index on the right) */
async function wbStrip() {
  const box = $("#wbQ"), n = W.byId.get(WB.id); if (!box || !n) return;
  const convs = wbKids(n).filter((k) => k.kind === "leaf").slice(0, 40);
  const need = convs.filter((k) => !WB.det[k.id]);
  for (let i = 0; i < need.length; i += 6) await Promise.all(need.slice(i, i + 6).map(async (k) => { try { WB.det[k.id] = WB.det[k.id] || await api(`/v1/world/${k.id}/detail?split=false`); } catch { WB.det[k.id] = { questions: [] }; } }));
  if (WB.id !== n.id) return;
  const marks = convs.map((k) => (WB.det[k.id]?.questions || []).filter((q) => !q.note).map((q) => `<i class="wbtick" data-wbq="${k.id}" data-run="${q.run || ""}" data-tip="${esc(q.text.replace(/\s+/g, " ").slice(0, 160))}" data-conv="${esc(k.title.slice(0, 40))}"></i>`).join("")).filter(Boolean);
  box.innerHTML = marks.length ? `<div class="wbqh">${L("提问", "Asked")}</div>${marks.map((m) => `<div class="wbqg">${m}</div>`).join("")}` : "";
}
function wbTip(el) {
  let t = $("#wbTip"); if (!t) { document.body.insertAdjacentHTML("beforeend", `<div class="wbtip card" id="wbTip" hidden></div>`); t = $("#wbTip"); }
  if (!el) { t.hidden = true; return; }
  const r = el.getBoundingClientRect(); t.hidden = false;
  t.innerHTML = `<b>${esc(el.dataset.tip)}</b><span>${esc(el.dataset.conv)}</span>`;
  t.style.top = Math.max(8, Math.min(innerHeight - 120, r.top - 20)) + "px"; t.style.left = Math.max(8, r.left - 340) + "px";
}

/* ------------------------------------------------ the conversation, docked on the right, at a question */
function wbPeek(id, run) {
  const k = W.byId.get(id); if (!k?.ref) return;
  const side = $("#wbSide"); if (!side) return; side.hidden = false; $("#wb").classList.add("side"); WB.peek = id;
  const q = new URLSearchParams({ view: "chats", embed: "1" });
  if (S.allChats?.some((c) => c.key === k.ref) || k.ref.startsWith("chat:")) q.set("c", k.ref); else q.set("item", k.ref);
  if (run) q.set("t", run); if (AS_UID) q.set("as", AS_UID); if (Q.get("lang")) q.set("lang", Q.get("lang"));
  side.innerHTML = `<div class="p2h"><b>${esc(k.title)}</b><span class="grow"></span><button class="sm ghost" data-wb="full">${L("全屏打开", "Open")}</button><button class="sm ghost" data-wb="unpeek">×</button></div><iframe src="/?${q}" title="conversation"></iframe>`;
}
function wbPeekClose() { const s = $("#wbSide"); if (s) { s.hidden = true; s.innerHTML = ""; } $("#wb")?.classList.remove("side"); WB.peek = null; }
if (Q.get("embed") && Q.get("t")) {               // opened at one question: scroll to it once its turns are on the page
  const want = Q.get("t"), t0 = Date.now(), iv = setInterval(() => {
    const el = document.getElementById("t-" + want), d = $("#cdlg");
    if (el && d) { clearInterval(iv); setTimeout(() => { d.scrollTo({ top: el.getBoundingClientRect().top - d.getBoundingClientRect().top + d.scrollTop - 12 }); el.nextElementSibling?.classList.add("wbflash"); }, 300); }
    if (Date.now() - t0 > 15000) clearInterval(iv);
  }, 300);
}

/* ------------------------------------------------ changing the tree from the spine */
async function wbAct(a, id) {
  const n = W.byId.get(id); if (!n) return;
  try {
    if (a === "add") { const v = prompt(L("新主题的名字", "Name of the new topic"), ""); if (!v) return; await api(`/v1/world/${n.id}/children`, { body: { title: v } }); }
    else if (a === "rename") { const v = prompt(L("新名字", "New name"), n.title); if (!v) return; await api(`/v1/world/${n.id}`, { method: "PATCH", body: { title: v } }); }
    else if (a === "summary") { editText(L("改这一层的概括（之后自动更新不会覆盖你写的）", "Edit this level's summary (later updates keep yours)"), n.summary || "", async (v) => { await api(`/v1/world/${n.id}`, { method: "PATCH", body: { summary: v } }); await wtFetch(true); wbRender(); }); return; }
    else if (a === "gist") { const v = prompt(L("这段对话的主旨（一句话）", "This conversation's gist (one line)"), n.gist || ""); if (v == null) return; await api(`/v1/world/${n.id}`, { method: "PATCH", body: { gist: v } }); }
    else if (a === "talk") { talkTo(n); return; }
    else if (a === "move") {
      const opts = W.nodes.filter((x) => x.kind !== "leaf" && x.id !== n.id && x.id !== n.parent && !x.hidden);
      const names = opts.map((x, i) => `${i + 1}. ${"  ".repeat(Math.max(0, (x.depth || 0) - 1))}${wbTitle(x)}`).join("\n");
      const v = prompt(L(`移到哪个主题下？输入编号：\n${names}`, `Move under which topic? Type its number:\n${names}`), ""); const to = opts[Number(v) - 1]; if (!to) return;
      await api(`/v1/world/${n.id}`, { method: "PATCH", body: { parent: to.id } });
    }
    else if (a === "remove") {
      if (!confirm(n.kind === "leaf" ? L("把这段对话移出世界树？（它还在「对话」里）", "Take this conversation out of the tree? (It stays in your chats.)") : L(`删除主题「${n.title}」？它下面的主题和对话会移到上一层。`, `Remove “${n.title}”? What is under it moves up a level.`))) return;
      await api(`/v1/world/${n.id}`, { method: "DELETE" });
      if (n.id === WB.id) { await wtFetch(true); await loadWorld?.(); wbGo(n.parent); return; }
    }
  } catch (err) { toast(err.message); return; }
  await wtFetch(true); if (typeof loadWorld === "function") loadWorld(); wbRender(); wbStrip();
}
function wbMenu(el, id) {
  document.querySelector(".wbmenu")?.remove(); const n = W.byId.get(id); if (!n) return;
  const items = n.kind === "leaf" ? [["chat", L("看这段对话", "Read it")], ["gist", L("改主旨", "Edit its gist")], ["move", L("移到别的主题下…", "Move to another topic…")], ["remove", L("移出世界树（对话还在）", "Take it out of the tree")]]
    : [["enter", L("进入这一层", "Go into it")], ["rename", L("改名", "Rename")], ["summary", L("改概括", "Summary")], ["move", L("移到别的主题下…", "Move…")], ["remove", L("删除（下面的上移一层）", "Remove (what is under it moves up)")]];
  const r = el.getBoundingClientRect(), m = document.createElement("div"); m.className = "cvpal cvmenu wbmenu card"; m.dataset.id = id;
  m.style.left = Math.min(r.left, innerWidth - 250) + "px"; m.style.top = Math.min(r.bottom + 4, innerHeight - 220) + "px";
  m.innerHTML = items.map(([a, t]) => `<button data-wbmi="${a}">${t}</button>`).join(""); document.body.appendChild(m);
}

/* ------------------------------------------------ clicks */
document.addEventListener("click", (e) => {
  if (!e.target.closest(".wbmenu") && !e.target.closest("[data-wbmenu]")) document.querySelector(".wbmenu")?.remove();
  const t = e.target.closest("[data-wb], [data-wbgo], [data-wbact], [data-wbmenu], [data-wbmi], [data-wbopen], [data-wbchat], [data-wbflip], [data-wbq], [data-wbref]"); if (!t) return;
  e.preventDefault();
  if (t.dataset.wbmenu) { e.stopPropagation(); wbMenu(t, t.dataset.wbmenu); return; }
  if (t.dataset.wbmi) { const id = t.closest(".wbmenu").dataset.id; t.closest(".wbmenu").remove(); if (t.dataset.wbmi === "enter") wbGo(id); else if (t.dataset.wbmi === "chat") wbPeek(id); else wbAct(t.dataset.wbmi, id); return; }
  if (t.dataset.wbflip) { const id = t.dataset.wbflip; WB.flip.has(id) ? WB.flip.delete(id) : WB.flip.add(id); if (!WB.det[id]?.context) wbLoad(id, true); const el = document.querySelector(`[data-wbn="${id}"]`); el?.classList.toggle("flip", WB.allFlip || WB.flip.has(id)); return; }
  if (t.dataset.wbgo) { wbGo(t.dataset.wbgo); return; }
  if (t.dataset.wbact) { wbAct(t.dataset.wbact, WB.id); return; }
  if (t.dataset.wbopen) { const id = t.dataset.wbopen; WB.open.has(id) ? WB.open.delete(id) : WB.open.add(id); wbRedraw(id); if (WB.open.has(id)) wbLoad(id, true); return; }
  if (t.dataset.wbchat) { wbPeek(t.dataset.wbchat); return; }
  if (t.dataset.wbq) { const id = t.dataset.wbq; if (!WB.open.has(id)) { WB.open.add(id); wbRedraw(id); wbLoad(id, true); }
    wbScroll(id); wbPeek(id, t.dataset.run); return; }
  if (t.dataset.wbref) { const leaf = W.nodes.find((x) => x.ref === t.dataset.wbref); if (leaf) { wbGo(leaf.parent); WB.open.add(leaf.id); wbLoad(leaf.id, true); setTimeout(() => wbScroll(leaf.id), 350); } else openItem(t.dataset.wbref); return; }
  const a = t.dataset.wb;
  if (a === "leave") wtLeave();
  else if (a === "flipall") { WB.allFlip = !WB.allFlip; if (WB.allFlip) wbKids(W.byId.get(WB.id)).filter((k) => k.kind === "leaf").slice(0, 30).forEach((k) => wbLoad(k.id, true)); wbRender(); wbStrip(); }
  else if (a === "unpeek") wbPeekClose();
  else if (a === "full") { const k = W.byId.get(WB.peek); if (k?.ref) { wtLeave(); openItem(k.ref); } }
  else if (a === "index") wbIndex();
});
document.addEventListener("pointerover", (e) => { const m = e.target.closest?.(".wbtick"); wbTip(m || null); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#wb")?.hidden && S.view === "graph" && !e.target.closest?.("input, textarea")) { if (WB.peek) wbPeekClose(); else wtLeave(); } });
async function wbIndex() {
  try { await api(`/v1/users/${S.uid}/inputs-index`, { method: "POST" }); } catch (err) { toast(err.message); return; }
  toast(L("在汇总你问过的所有问题…", "Gathering every question you asked…"));
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const r = await api(`/v1/users/${S.uid}/inputs-index`).catch(() => null);
    if (r?.state === "done") { modal(`<h2>${L("问题索引文件", "Questions file")}</h2><div class="muted" style="font-size:13px">${L(`汇总了 ${r.conversations} 段对话里的 ${r.questions} 个问题，按世界树的主题、对话、分段排列。`, `${r.questions} questions from ${r.conversations} conversations, by topic, conversation and segment.`)}</div><pre class="ctxpre">${esc(r.path)}</pre>`); return; }
    if (r?.state === "error") { toast(r.error); return; }
  }
}
const _showWB = show;
show = function (view, opts) { if (view !== "graph") { const b = $("#wb"); if (b && !b.hidden) { b.hidden = true; $("#vGraph")?.classList.remove("wbon"); WB.id = null; wbPeekClose(); } } return _showWB(view, opts); };
document.addEventListener("click", (e) => { const b = e.target.closest("[data-wbenter]"); if (!b) return; e.preventDefault(); e.stopPropagation(); const n = W.byId.get(b.dataset.wbenter); if (n) wtEnter(n); }, true);
const _renderRailWB = renderRail;
renderRail = function () { _renderRailWB();
  document.querySelectorAll(".padnav [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === S.view)); };
