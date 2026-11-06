/* PGA app · one tree: its drawing, its dialogue, the drawer. Plain scripts sharing one global scope, loaded in order by app.html. */
/* ------------------------------------------------ a tree */
async function loadProc() {
  if (YOU()) { S.proc = null; return; }
  try { S.proc = await api(`/v1/users/${S.uid}/console/aims/${S.aim}`); } catch { S.proc = null; }
}
async function loadTree(quiet) {
  if (!S.aim) return;
  const aim = S.aim;
  let tree; try { [tree] = await Promise.all([api(treeApi()), loadProc()]); } catch (e) { if (!quiet) $("#dlgIn").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (aim !== S.aim) return;
  S.tree = tree;
  document.title = `${S.tree.aim?.text?.slice(0, 30) || L("你的对话树", "Your conversation tree")} · PGA`;
  const nodes = (S.tree.nodes || []).filter((n) => n.kind !== "bud");
  if (!S.node || !nodes.some((n) => n.id === S.node)) S.node = (nodes.find((n) => n.tip) || nodes[nodes.length - 1])?.id || null;
  history.replaceState(null, "", qs());
  renderBar(); drawTree(!quiet); renderHead();
  if (!quiet) { renderDialog(); renderCont(); renderDrawer(); if (S.node) loadNode(S.node); scrollToSeam(); }
}
async function loadNode(id, force) {
  if (S.detail[id] && !force) { renderAll(); return; }
  try { S.detail[id] = await api(`/v1/thought-nodes/${id}?full=true${EN ? "&lang=en" : ""}`); } catch (e) { S.detail[id] = { error: e.message }; }
  if (EN) translateTurns(id);
  if (S.node === id) renderAll();
}
function renderAll() { renderHead(); renderDialog(); renderDrawer(); }
async function forest() { if (!S.forest) S.forest = await api(`/v1/users/${S.uid}/forest${EN ? "?lang=en" : ""}`); return S.forest; }

/* the English pages: the dialogue is written in Chinese — each piece is translated once (and kept by the server) */
async function translateTurns(id) {
  const d = S.detail[id]; if (!d?.notes || d._tr) return; d._tr = "running";
  const cjk = /[㐀-鿿]/, jobs = [];
  for (const x of d.notes) {
    const dd = x.data || {};
    const add = (get, set) => { const t = get(); if (t && cjk.test(t)) jobs.push([t, set]); };
    add(() => x.text, (v) => { x.text = v; });
    add(() => dd.why, (v) => { dd.why = v; }); add(() => dd.question, (v) => { dd.question = v; }); add(() => dd.assumption, (v) => { dd.assumption = v; });
    for (const s of dd.samples || []) add(() => s.answer, (v) => { s.answer = v; });
    for (const s of dd.ideas || []) add(() => s.idea, (v) => { s.idea = v; });
    (dd.agreed || []).forEach((a, i) => add(() => a, (v) => { dd.agreed[i] = v; }));
  }
  d._trTotal = jobs.length; d._trDone = 0;
  for (let i = 0; i < jobs.length; i += 20) {
    const part = jobs.slice(i, i + 20);
    try { const r = await api(`/v1/users/${S.uid}/i18n`, { body: { texts: part.map(([t]) => t), lang: "en" } }); r.texts.forEach((v, k) => v && part[k][1](v)); } catch { break; }
    d._trDone = Math.min(jobs.length, i + 20);
    renderDialog(); if (S.drawer) renderBody();
  }
  d._tr = "done"; renderDialog(); if (S.drawer) renderBody();
}

function renderRunPills() {
  const T = S.tree, t = T.task, P = S.proc || {};
  if (YOU()) return "";
  const waiting = [P.checkpoint ? L("检查点", "Checkpoint") : "", T.for_you ? L(`${T.for_you} 个问题等你`, `${T.for_you} for you`) : ""].filter(Boolean).join(" · ");
  return t ? `<span class="pill"><span class="dot ${t.status === "running" ? "on" : ""}"></span><b>${t.status === "running" ? L("运行中", "Running") : t.status === "paused" ? L("已暂停", "Paused") : L("已停止", "Stopped")}</b>${t.status === "running" ? " · " + esc(EN ? t.phase : t.phase_zh || t.phase) : ""}${t.auto_idle ? `<span class="dimt" title="${L("你不在时自动开始的：你一操作就会暂停", "Started on its own while you were away: pauses as soon as you do anything")}"> · ${L("你不在时自动运转", "running while you are away")}</span>` : ""}</span>
      <span class="pill" title="${L("张力", "Pressure")} ${t.pressure.toFixed(2)}: ${Object.entries(t.parts || {}).filter(([, v]) => typeof v === "number").map(([k, v]) => `${k} ${v.toFixed(2)}`).join(", ")}"><span class="meter"><i style="width:${Math.round(t.pressure * 100)}%"></i></span></span>
      ${waiting ? `<button class="sm accent" id="waitBtn">${esc(waiting)}</button>` : ""}
      <button class="sm ghost" id="setBtn" title="${L("运行设置", "Run settings")}">⚙</button>
      ${T.project ? `<button class="sm ${t.status === "running" ? "" : "primary"}" id="runBtn">${t.status === "running" ? L("暂停", "Pause") : L("开始", "Start")}</button>` : ""}`
    : `<span class="pill">${L("还没有在长期运行", "Not running yet")}${T.project ? "" : L("：先在存档的工作台里给它选一个工作文件夹", " — pick a working folder first")}</span>${T.project ? `<button class="sm primary" id="runBtn">${L("开始", "Start")}</button>` : ""}`;
}
function renderHead() {
  if (!S.tree) return;
  const n = nodeOf(S.node), keepQ = document.activeElement?.id === "search";
  $("#dh").innerHTML = `<div class="dh2">${n ? `<span class="kind">${kindLabel(n)}</span>` : ""}<h1 title="${esc((YOU() ? L("你的对话树", "Your conversation tree") : S.tree.aim?.text || "") + " / " + (n?.title || ""))}">${esc(n?.title || "")}</h1>
      ${YOU() ? "" : renderRunPills()}
      <input type="text" id="search" placeholder="${L("搜索对话", "Search")}" value="${esc(S.search)}">
      <button class="sm ${S.drawer ? "" : "ghost"}" id="drawerBtn" title="${L("概览、行为、多次生成、代码、知识和节点操作", "Overview, behaviour, samples, code, knowledge and node actions")}">${S.drawer ? L("收起详情", "Hide details") : L("详情 ▸", "Details ▸")}</button></div>`;
  if (keepQ) { const s = $("#search"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
}
function renderBar() {
  const T = S.tree, nodes = (T.nodes || []).filter((n) => n.kind !== "bud"), old = nodes.filter((n) => n.kind === "segment" && n.style !== 2 && !n.edited).length;
  const hidden = nodes.filter((n) => n.hidden).length, turns = nodes.reduce((a, n) => a + (n.turns || 0), 0);
  $("#bar").innerHTML = `<span class="seg"><button class="${S.mode === "thought" ? "on" : ""}" data-mode="thought">${L("思维", "Thought")}</button><button class="${S.mode === "behavior" ? "on" : ""}" data-mode="behavior">${L("行为", "Behaviour")}</button></span>
    <button class="sm ghost" id="dirBtn" title="${L("切换树的生长方向", "Switch which way the tree grows")}">${S.dir === "down" ? L("↓ 向下长", "↓ Grows down") : L("↑ 向上长", "↑ Grows up")}</button>
    <span class="num">${L(`${nodes.length} 个节点 · ${turns} 轮`, `${nodes.length} nodes · ${turns} turns`)}</span>
    ${S.mode === "behavior" ? `<span class="keys"><span><i style="border-color:#7aa7e6"></i>${L("读", "read")}</span><span><i style="border-color:#6cc4b6"></i>${L("查", "search")}</span><span><i style="border-color:#d6a75c"></i>${L("命令", "cmd")}</span><span><i style="border-color:#e58c7e"></i>${L("改", "edit")}</span><span><i style="border-color:#f0d38c"></i>${L("提交", "commit")}</span></span>`
      : `<span class="keys"><span><i style="border-color:#7fcf9f"></i>${L("你的分支", "yours")}</span><span><i style="border-radius:1px;transform:rotate(45deg);border-style:dashed"></i>${L("影子路线", "shadow")}</span></span>`}
    ${T.pending ? `<span class="act" id="curate">${L(`整理 ${T.pending} 轮新对话`, `Place ${T.pending} new turns`)}</span>` : ""}
    ${old ? `<span class="act" id="rewrite">${L(`重写 ${old} 个概括`, `Rewrite ${old} summaries`)}</span>` : ""}
    ${hidden ? `<label><input type="checkbox" id="showHidden" ${S.showHidden ? "checked" : ""}> ${L(`显示隐藏的 ${hidden} 个`, `Show ${hidden} hidden`)}</label>` : ""}`;
  $("#hint").textContent = L("点节点看对话，输入框接着这段对话往下说；点节点旁的分叉图标从那里分支 · 拖动节点移动，拖到另一个节点上链接 · 右键看更多", "Click a node to read it; the composer continues that conversation; the fork icon beside a node branches from there · drag to move, drop on a node to link · right-click for more");
}
function drawTree(scroll) {
  const side = $("#treeSide");
  const L0 = PGATree.draw($("#treeSvg"), S.tree, Math.max(380, side.clientWidth), { sel: { id: S.node, bud: S.bud }, seen: S.seen, aimText: S.tree.aim?.text, labelChars: EN ? 26 : 15, showHidden: S.showHidden, mode: S.mode, plus: S.bud == null, dir: S.dir });
  if (scroll) { const n = L0.list.find((x) => x.id === S.node) || L0.list[L0.list.length - 1]; if (n) side.scrollTop = Math.max(0, n.sy - side.clientHeight * .42); }
  S.layout = L0;
}
function select(id, bud = null) {
  if (!id) return;
  if (S.op === "exchange-pick" && id !== S.node) { S.exWith = id; S.op = "exchange"; S.drawer = true; renderDrawer(); return; }
  S.node = id; S.bud = bud; if (S.op !== null && S.op !== "exchange") S.op = null; if (S.branchFrom !== id) S.branchFrom = null;
  history.replaceState(null, "", qs());
  drawTree(false); renderHead(); renderDialog(); renderCont(); renderDrawer(); loadNode(id);
  scrollToSeam();
}
/* the dialogue as one conversation: from the root down to this node, and on while it does not fork */
function chainOf(id) {
  const all = (S.tree?.nodes || []).filter((n) => n.kind !== "bud"), by = new Map(all.map((n) => [n.id, n]));
  const kidsOf = (x) => all.filter((k) => k.parent === x.id && (S.showHidden || !k.hidden)).sort((a, b) => a.seq - b.seq);
  const up = []; for (let x = by.get(id), i = 0; x && i < 400; x = by.get(x.parent), i++) up.unshift(x);
  const down = []; let cur = by.get(id);
  for (let i = 0; cur && i < 400; i++) { const k = kidsOf(cur); if (k.length !== 1) break; cur = k[0]; down.push(cur); }
  return { nodes: [...up, ...down], fork: cur ? kidsOf(cur) : [] };
}
function loadChain() {
  const { nodes } = chainOf(S.node), todo = nodes.filter((n) => !S.detail[n.id] && !n._loading);
  let i = 0;
  const next = async () => {
    const n = todo[i++]; if (!n) return;
    n._loading = true;
    try { S.detail[n.id] = await api(`/v1/thought-nodes/${n.id}?full=true${EN ? "&lang=en" : ""}`); } catch (e) { S.detail[n.id] = { error: e.message }; }
    if (EN && n.id === S.node) translateTurns(n.id);
    renderDialog(); if (n.id === S.node) { scrollToSeam(); renderDrawer(); }
    return next();
  };
  for (let k = 0; k < 4; k++) next();
}
function scrollToSeam() {
  requestAnimationFrame(() => { const el = document.getElementById("seam-" + S.node), box = $("#dlg"); if (el && box) box.scrollTo({ top: el.offsetTop - 8, behavior: "smooth" }); });
}
const nodeOf = (id) => (S.tree?.nodes || []).find((n) => n.id === id);
const kindLabel = (n) => (n.scope === "user" && n.kind === "segment" ? L("一段对话", "Conversation") : { user: L("你的分支", "Your branch"), exchange: L("交流", "Exchange"), segment: L("一段思路", "Line of thought") }[n.kind] || "");

/* the big dialogue: the whole conversation from the root to here, a line between nodes */
function renderDialog() {
  const box = $("#dlgIn"), wrap = $("#dlg");
  if (!S.tree) return;
  const n = nodeOf(S.node);
  if (!n) { box.innerHTML = `<div class="empty">${L("这棵树还没有长出节点。", "This tree has no nodes yet.")}${S.tree?.pending ? L("点左上的「整理」。", " Use “Place new turns” at the top left.") : ""}</div>`; return; }
  const keep = wrap.dataset.node === n.id ? wrap.scrollTop : null;
  const q = S.search.trim().toLowerCase(), keepNote = (x) => !q || x.text.toLowerCase().includes(q) || String(x.data?.code || "").toLowerCase() === q;
  const { nodes, fork } = chainOf(n.id), missing = nodes.some((x) => !S.detail[x.id]);
  if (missing) setTimeout(loadChain, 0);
  const name = PGATree.cast(nodes.flatMap((x) => S.detail[x.id]?.notes || []));
  const d0 = S.detail[n.id];
  const parts = nodes.map((x, i) => {
    const dd = S.detail[x.id], cur = x.id === n.id, notes = (dd?.notes || []).filter(keepNote);
    const untranslated = EN && dd?.notes && !dd._tr && dd.notes.some((m) => /[㐀-鿿]/.test(m.text));
    return `<div class="seam ${cur ? "cur" : ""}" id="seam-${x.id}" data-ctxnode="${x.id}"><span class="sn num">${i + 1}</span><a href="#" data-go="${x.id}" class="st">${esc(x.title)}</a>
        <span class="sm num">${L(`${x.turns} 轮`, `${x.turns} turns`)}${x.first_at ? " · " + esc(when(x.first_at)) : ""}</span>${untranslated ? `<a href="#" data-trnode="${x.id}" class="sm">Translate</a>` : ""}</div>
      ${x.shift && i > 0 ? `<div class="seamwhy">${esc(x.shift)}</div>` : ""}
      ${!dd ? `<div class="dimt" style="font-size:12.5px;padding:8px 0">${L("载入…", "Loading…")}</div>` : dd.error ? `<div class="dimt">${esc(dd.error)}</div>` : notes.length ? PGATree.chat(notes, { md, name }) : `<div class="dimt" style="font-size:12.5px;padding:6px 0 14px">${q ? L("这一段没有符合的。", "Nothing matches in this stretch.") : x.kind === "segment" ? L("这一段还没有对话。", "No dialogue in this stretch yet.") : L("这条分支还空着：在下面写点什么，它就开始长。", "This branch is still empty: write below and it starts to grow.")}</div>`}`;
  }).join("");
  const forkNote = fork.length > 1 ? `<div class="fork-end"><span>${L(`这里分叉成 ${fork.length} 条，选一条接着看：`, `It forks into ${fork.length} branches here — pick one to read on:`)}</span>${fork.map((k) => `<button class="chip ${k.kind}" data-go="${k.id}">${esc(k.title.length > 22 ? k.title.slice(0, 21) + "…" : k.title)}</button>`).join("")}</div>` : "";
  box.innerHTML = (EN && d0?._tr === "running" ? `<div class="trnote">Translating the dialogue into English… ${d0._trDone || 0} / ${d0._trTotal || 0}</div>` : "")
    + `<div class="chainhead">${L(`从根到这里一共 ${nodes.length} 段，是一条连续的对话；节点之间用线隔开。`, `${nodes.length} stretches from the root, read as one conversation; a line marks each node.`)}</div>${parts}${forkNote}`
    + (S.sending && S.view === "tree" ? `<div class="mine-q">${md(S.draft || "")}</div>` + workCard() : "");
  wrap.dataset.node = n.id; if (keep != null) wrap.scrollTop = keep;
}

/* the drawer: one node's details and what you can do with it */
function renderDrawer() {
  $("#drawer").classList.toggle("on", S.drawer);
  if (!S.drawer || !S.tree) return;
  const n = nodeOf(S.node);
  if (!n) { $("#nh").innerHTML = ""; $("#tabs").innerHTML = ""; $("#body").innerHTML = ""; return; }
  const d = S.detail[n.id], bud = S.bud != null ? (n.buds || [])[S.bud] : null;
  const list = S.layout?.list || [], i = list.findIndex((x) => x.id === n.id), mine = n.kind !== "segment";
  $("#nh").innerHTML = `<div class="top"><div class="crumb">${(d?.path || []).slice(0, -1).map((x) => `<a href="#" data-go="${x.id}">${esc(x.title.length > 14 ? x.title.slice(0, 13) + "…" : x.title)}</a>`).join(" / ") || "&nbsp;"}</div><button class="sm ghost" id="drawerClose">✕</button></div>
    <div class="t"><span class="kind">${bud ? L("灵感", "Idea") : kindLabel(n)}</span><h2>${esc(bud ? bud.idea : n.title)}</h2></div>
    ${bud ? "" : `<div class="tools">
      <button class="sm" data-op="edit">${L("编辑", "Edit")}</button><button class="sm" data-op="branchhere">${L("从这里分支", "Branch from here")}</button>
      <button class="sm" data-op="exchange-pick">${L("和别的分支交流", "Exchange")}</button><button class="sm" data-op="distill">${n.dataset ? L("重新沉淀", "Distill again") : L("沉淀为知识", "Distill")}</button>
      <button class="sm" data-op="move">${L("移到…", "Move…")}</button><button class="sm" data-op="hide">${n.hidden ? L("显示", "Show") : L("隐藏", "Hide")}</button>
      ${n.parent && n.kind === "segment" ? `<button class="sm" data-op="merge">${L("合并到上一级", "Merge up")}</button>` : ""}<button class="sm" data-op="markdown">Markdown</button>
      ${mine ? `<button class="sm danger" data-op="delete">${L("删除", "Delete")}</button>` : ""}</div>`}
    <div class="navr">${n.parent ? `<button class="chip" data-go="${n.parent}">↓ ${L("父节点", "Parent")}</button>` : ""}
      ${i > 0 ? `<button class="chip" data-go="${list[i - 1].id}">${L("上一个", "Previous")}</button>` : ""}${i >= 0 && i < list.length - 1 ? `<button class="chip" data-go="${list[i + 1].id}">${L("下一个", "Next")}</button>` : ""}
      ${(d?.children || []).map((c) => `<button class="chip ${c.kind}" data-go="${c.id}">↑ ${esc(c.title.length > 14 ? c.title.slice(0, 13) + "…" : c.title)}</button>`).join("")}
      ${n.with ? `<button class="chip exchange" data-goaim="${n.with_aim}" data-gonode="${n.with}">↔ ${esc((n.with_title || "").slice(0, 16))}</button>` : ""}</div>
    ${opForm(n)}`;
  const notes = d?.notes || [], sampled = notes.filter((x) => x.kind === "answer" && x.data?.samples?.length), g = d?.git || {};
  const tabs = [["overview", L("概览", "Overview"), ""], ["behavior", L("行为", "Behaviour"), n.behavior?.runs || ""],
    ...(YOU() ? [] : [["samples", L("多次生成", "Samples"), sampled.length || ""]]), ["code", L("代码", "Code"), (g.commits || []).length + (g.files || []).length || ""],
    ["knowledge", L("知识", "Knowledge"), (n.dataset ? 1 : 0) + (n.refs || []).length || ""]];
  if (!tabs.some(([k]) => k === S.tab)) S.tab = "overview";
  $("#tabs").innerHTML = tabs.map(([k, nm, c]) => `<button class="${S.tab === k ? "on" : ""}" data-tab="${k}">${nm}${c ? `<small>${c}</small>` : ""}</button>`).join("");
  renderBody();
}
function renderBody() {
  const n = nodeOf(S.node); if (!n || !S.drawer) return;
  const d = S.detail[n.id], bud = S.bud != null ? (n.buds || [])[S.bud] : null, body = $("#body"), keep = body.dataset.node === n.id + S.tab ? body.scrollTop : 0;
  body.innerHTML = !d ? `<div class="empty">${L("载入这个节点…", "Loading this node…")}</div>` : d.error ? `<div class="empty">${esc(d.error)}</div>`
    : (bud && S.tab === "overview" ? budHtml(n, bud) : { overview: overviewHtml, behavior: behaviorHtml, samples: samplesHtml, code: codeHtml, knowledge: knowledgeHtml }[S.tab](n, d));
  body.dataset.node = n.id + S.tab; body.scrollTop = keep;
  if (S.tab === "knowledge") fillKnowledge(n);
  if (S.tab === "behavior" && !S.beh[n.id]) api(`/v1/thought-nodes/${n.id}/behavior`).then((b) => { S.beh[n.id] = b; if (S.node === n.id && S.tab === "behavior") renderBody(); }).catch((e) => { S.beh[n.id] = { error: e.message }; });
}
function opForm(n) {
  if (S.op === "edit") return `<div class="form"><input type="text" id="fTitle" value="${esc(n.title)}" placeholder="${L("标题：一个短语", "Title: a short phrase")}">
    <textarea id="fSummary" placeholder="${L("问：…\n发现：…\n定：…", "Asked: …\nFound: …\nNext: …")}">${esc(n.summary)}</textarea>
    <textarea id="fKeys" style="min-height:60px" placeholder="${L("关键想法，每行一条", "Key thoughts, one per line")}">${esc((n.key_thoughts || []).join("\n"))}</textarea>
    <div class="row"><span class="dimt" style="font-size:12px;margin-right:auto">${L("你改过的内容，整理者以后不会覆盖", "What you change here, the curator will not overwrite")}</span><button class="ghost" data-op="">${L("取消", "Cancel")}</button><button class="primary" data-do="edit">${L("保存", "Save")}</button></div></div>`;
  if (S.op === "branch") return `<div class="form"><input type="text" id="fBranch" placeholder="${L("新分支要往哪个方向想？", "Which direction should the new branch take?")}">
    <div class="row"><button class="ghost" data-op="">${L("取消", "Cancel")}</button><button class="primary" data-do="branch">${L("长出分支", "Grow it")}</button></div></div>`;
  if (S.op === "move") {
    const sub = new Set(); const kids = (id) => (S.tree.nodes || []).filter((x) => x.parent === id).forEach((x) => { sub.add(x.id); kids(x.id); }); sub.add(n.id); kids(n.id);
    return `<div class="form"><select id="fParent"><option value="">${L("根（直接长在根上）", "The root")}</option>${(S.tree.nodes || []).filter((x) => !sub.has(x.id)).map((x) => `<option value="${x.id}" ${x.id === n.parent ? "selected" : ""}>${esc(x.title)}</option>`).join("")}</select>
      <div class="row"><button class="ghost" data-op="">${L("取消", "Cancel")}</button><button class="primary" data-do="move">${L("移过去", "Move")}</button></div></div>`;
  }
  if (S.op === "exchange-pick") return `<div class="form"><div class="muted" style="font-size:13px">${L("在左边的树上点另一个节点，或者从别的树里选：", "Click another node on the tree, or pick one from another tree:")}</div><select id="fOther"><option value="">${L("（别的树的节点）", "(a node in another tree)")}</option></select>
    <div class="row"><button class="ghost" data-op="">${L("取消", "Cancel")}</button><button class="primary" data-do="pick-other">${L("用这个", "Use this")}</button></div></div>`;
  if (S.op === "exchange") { const o = nodeOf(S.exWith) || S.exOther; return `<div class="form"><div style="font-size:13px">${L(`让「${esc(n.title)}」和「${esc(o?.title || "另一个节点")}」交流：一个 agent 同时读两条思路，写出双方能互相借鉴什么、哪里冲突、合起来下一步做什么。`, `Let “${esc(n.title)}” and “${esc(o?.title || "the other node")}” talk: an agent reads both lines of thought and writes what each can take from the other, where they conflict, and a joint next step.`)}</div>
    <textarea id="fExText" style="min-height:52px" placeholder="${L("（可选）你特别想让它们讨论什么", "(optional) what they should discuss")}"></textarea>
    <div class="row"><button class="ghost" data-op="">${L("取消", "Cancel")}</button><button class="primary" data-do="exchange" ${S.sending ? "disabled" : ""}>${S.sending ? L("交流中…", "Talking…") : L("开始交流", "Start")}</button></div></div>`; }
  return "";
}
function overviewHtml(n, d) {
  const notes = d.notes || [], by = (k) => notes.filter((x) => x.kind === k).length, insp = notes.filter((x) => x.data?.inspiration).length;
  const shadows = (n.shadows || []);
  return `<div class="metarow num"><span>${esc(when(n.first_at))}${n.last_at ? " – " + esc(when(n.last_at)) : ""}</span>${n.codes?.length ? `<span>${esc(n.codes.join("–"))}</span>` : ""}
      ${n.proposals?.length ? `<span>${L("改进提案", "Proposals")} ${esc(n.proposals.join(", "))}</span>` : ""}${n.edited ? `<span>${L("你改过", "edited by you")}</span>` : ""}</div>
    ${n.shift ? `<div class="shift">${esc(n.shift)}</div>` : ""}
    ${n.summary ? PGATree.summary(n.summary) : `<div class="dimt">${n.kind === "segment" ? L("还没有概括。", "No summary yet.") : L("这条分支还空着：在下面写点什么，它就开始长。", "This branch is still empty: write below and it starts to grow.")}</div>`}
    ${n.key_thoughts?.length ? `<div class="sec label">${L("关键想法", "Key thoughts")}</div><ul class="points">${n.key_thoughts.map((k) => `<li>${esc(k)}</li>`).join("")}</ul>` : ""}
    ${shadows.length ? `<div class="sec label">${L("影子路线 · 分叉时没有走、之后会重新考虑的结论", "Shadow paths · conclusions not taken when it forked, revisited later")}</div>${shadows.map((x) => `<div class="item dash"><div class="x"><b>${esc(x.alt || "")}</b> ${esc(x.conclusion)}<div class="s">${L("前提", "Assumption")}: ${esc(x.assumption || "—")} · ${{ shadow: L("待重新考虑", "kept for later"), promoted: L("已被提上来", "promoted"), dropped: L("已放下", "dropped") }[x.status] || ""}</div></div></div>`).join("")}` : ""}
    ${(n.buds || []).length ? `<div class="sec label">${L("花苞 · 只有部分样本想到的灵感", "Buds · ideas only some samples had")}</div>${n.buds.map((b, i) => `<div class="item"><div class="x">${esc(b.idea)}</div><button class="sm" data-bud="${i}">${L("从这里长出分支", "Grow a branch")}</button></div>`).join("")}` : ""}
    <div class="sec label">${L("数字", "Numbers")}</div><div class="stats"><div><b>${notes.length}</b><span>${L("轮对话", "turns")}</span></div><div><b>${by("question")}</b><span>${L("提问", "questions")}</span></div><div><b>${by("answer")}</b><span>${L("回答", "answers")}</span></div><div><b>${n.open}</b><span>${L("还开着", "open")}</span></div>
      <div><b>${by("insight") - insp}</b><span>${L("发现", "findings")}</span></div><div><b>${insp}</b><span>${L("灵感", "ideas")}</span></div><div><b>${n.samples || 0}</b><span>${L("次生成", "samples")}</span></div><div><b>${n.spread != null ? n.spread.toFixed(2) : "—"}</b><span>${L("平均分歧", "mean spread")}</span></div></div>
    <div class="sec label">${L("最近几轮", "Latest turns")} · <a href="#" data-tab="turns">${L(`看全部 ${notes.length} 轮`, `all ${notes.length}`)}</a></div>${PGATree.chat(notes.slice(-5), { md })}`;
}
function budHtml(n, bud) {
  return `<div class="shift">${esc(bud.idea)}</div><div class="muted">${L(`这个想法出现在「${esc(n.title)}」的多次生成里，只有一部分样本想到了它。在下面写下你想沿它问什么，它就长成一条你的分支。`, `This idea came up in some of the samples in “${esc(n.title)}”. Write what you want to ask along it and it grows into a branch of yours.`)}</div>`;
}
function behaviorHtml(n) {
  const B = S.beh[n.id];
  if (!B) return `<div class="empty" style="padding:20px 0">${L("读取这一段里 agent 的动作…", "Reading what the agents did…")}</div>`;
  if (B.error) return `<div class="empty">${esc(B.error)}</div>`;
  return cacheLine(B.cache) + `<div class="muted" style="font-size:13px;margin-bottom:14px">${L("行为树：这一段里每个 agent 做了什么。往下依次是 agent、它的每次运行（哪一步、回答哪个问题、结果如何）、运行里的每个动作。", "Behaviour tree: what each agent did here — each agent, each of its runs (step, question, outcome), and the actions in each run.")}</div>` + PGATree.behaviorTree(B, n);
}
const kTok = (n) => (n >= 10000 ? (EN ? `${(n / 1000).toFixed(0)}k` : `${(n / 10000).toFixed(1)} 万`) : String(n));
function cacheLine(c) {
  if (!c || !c.calls) return "";
  const pct = Math.round((c.hit || 0) * 100);
  return `<div class="cache"><div class="ch1"><b>${L("提示词缓存", "Prompt cache")}</b><span>${L(`${c.calls} 次调用 · 读入 ${kTok(c.input)} token，其中 ${kTok(c.cached)} 来自缓存`, `${c.calls} calls · ${kTok(c.input)} tokens read, ${kTok(c.cached)} from the cache`)}</span><b class="num">${pct}%</b></div>
    <div class="cbarx"><i style="width:${pct}%"></i></div></div>`;
}
function samplesHtml(n, d) {
  const xs = (d.notes || []).filter((x) => x.kind === "answer" && x.data?.samples?.length);
  if (!xs.length) return `<div class="empty" style="padding:20px 0">${L("这一段的回答都只生成了一次。多次生成是之后才打开的；它只在不确定、有分歧、又重要的问题上触发。", "Every answer here was generated once. Several samples came later, and only for questions that are uncertain, contested and important.")}</div>`;
  return PGATree.chat(xs.flatMap((x) => [{ ...x, kind: "question", text: x.data.question || "", data: { code: x.data.code }, agent: "lead", role: "lead" }, x]).filter((x) => x.text), { md });
}
function codeHtml(n, d) {
  const g = d.git || {};
  if (!g.repo && !g.head) return `<div class="empty" style="padding:20px 0">${L("这个抱负的工作文件夹不是 git 仓库，或这段时间之前还没有提交。", "This motivation's folder is not a git repository, or there were no commits yet.")}</div>`;
  return `<div class="metarow"><span>${L("仓库", "Repository")} <a href="${esc(g.repo)}" target="_blank" rel="noopener">${esc((g.repo || "").replace("https://github.com/", ""))}</a></span>
      ${g.head ? `<span>${L("这段结束时的代码", "Code at the end")} <a href="${esc(g.head_url)}" target="_blank" rel="noopener">${esc(g.head)}</a></span>` : ""}</div>
    <div class="sec label">${L("这段时间的提交", "Commits meanwhile")}</div>${(g.commits || []).map((c) => `<div class="commit"><a href="${esc(c.url || "#")}" target="_blank" rel="noopener">${esc(c.sha.slice(0, 7))}</a><span>${esc(c.subject)}</span><time>${esc(when(c.at))}</time></div>`).join("") || `<div class="dimt">${L("没有新的提交。", "None.")}</div>`}
    <div class="sec label">${L("回答里引用的文件 · 链接指向当时的版本", "Files the answers relied on · links point to that version")}</div>${(g.files || []).map((f) => `<div class="file"><a href="${esc(f.url || "#")}" target="_blank" rel="noopener">${esc(f.path)}</a><span>${L(`${f.refs} 次`, `${f.refs}×`)}</span></div>`).join("") || `<div class="dimt">${L("没有。", "None.")}</div>`}`;
}
const SYS = { user: ["个人模型", "Personal model"], world: ["世界模型", "World model"], aim: ["抱负知识", "Motivation"], branch: ["思路", "Line of thought"] };
const sysName = (b) => (SYS[b.system] ? L(...SYS[b.system]) : b.source === "upload" ? L("文档", "Document") : b.source === "web" ? L("网页", "Web page") : b.kind === "note" ? L("笔记", "Note") : b.kind === "skill" ? L("技能", "Skill") : L("数据集", "Dataset"));
function kcard(b, extra = "") {
  return `<div class="kcard"><div class="kt"><span class="ty">${esc(sysName(b))}</span><b>${esc(b.title)}</b>${b.compiled_at ? `<span class="dimt" style="font-size:12px">${esc(ago(b.compiled_at))}</span>` : ""}</div>
    ${b.gist ? `<div class="kg">${esc(b.gist)}</div>` : ""}<div class="ka"><button class="sm" data-doc="${b.id}">${L("看全文", "Read")}</button><a href="/v1/bodies/${b.id}/markdown" target="_blank" rel="noopener"><button class="sm ghost">Markdown</button></a>${extra}</div></div>`;
}
function knowledgeHtml(n) {
  const K = S.tree.knowledge || {};
  return `<div class="label" style="margin-bottom:8px">${L("这个节点参考的知识 · 从这里继续（以及从它长出去的分支）都会读到", "Knowledge this node refers to · read when continuing from here and from what grows from it")}</div><div id="kRefs"><div class="dimt">…</div></div>
    <div class="sec label">${L("这段思路沉淀出的知识", "Distilled from this line of thought")}</div><div id="kNode">${n.dataset ? `<div class="dimt">…</div>` : `<div class="dimt" style="font-size:13px">${L("还没有沉淀。点上面的「沉淀为知识」：把这段思路连同它长出去的分支写成一份数据集，别的树可以直接参考。", "Not distilled yet. “Distill” writes this line of thought (and what grew from it) into a dataset other trees can use.")}</div>`}</div>
    <div class="sec label">${L("这棵树每一轮都会读到的", "What this tree reads every round")}</div>
    ${K.user ? kcard(K.user) : ""}${K.world ? kcard(K.world) : ""}${(K.references || []).map((b) => kcard(b, `<button class="sm ghost" data-unref="${b.id}">${L("不再参考", "Stop using")}</button>`)).join("")}
    ${(K.datasets || []).filter((b) => b.id !== n.dataset).map((b) => kcard(b)).join("")}${(K.skills || []).map((b) => kcard(b)).join("")}`;
}
async function fillKnowledge(n) {
  const f = await forest().catch(() => null), rbox = $("#kRefs");
  if (rbox && f) {
    const all = f.knowledge || [], mine = (n.refs || []).map((id) => all.find((k) => k.id === id)).filter(Boolean);
    rbox.innerHTML = (mine.map((b) => kcard(b, `<button class="sm ghost" data-unrefnode="${b.id}">${L("不再参考", "Remove")}</button>`)).join("") || `<div class="dimt" style="font-size:13px">${L("还没有。", "None yet.")}</div>`)
      + `<div class="ka" style="display:flex;gap:8px;margin-top:8px"><select id="refAdd"><option value="">${L("加一份知识…", "Add knowledge…")}</option>${all.filter((k) => !(n.refs || []).includes(k.id) && k.id !== n.dataset)
        .map((k) => `<option value="${k.id}">${esc(sysName(k) + " · " + k.title)}</option>`).join("")}</select><button class="sm" data-refadd="1">${L("参考", "Add")}</button></div>`;
  }
  if (!n.dataset) return;
  const b = f?.knowledge?.find((x) => x.id === n.dataset), box = $("#kNode"); if (!box) return;
  if (!b) { box.innerHTML = `<div class="dimt">${L("找不到这份数据集。", "Dataset not found.")}</div>`; return; }
  const others = (f.trees || []).filter((t) => t.id !== S.aim && !(b.used_by || []).includes(t.id));
  const moveTo = `<select id="moveTo"><option value="">${L("移到…", "Move to…")}</option>${[...(f.trees || []).map((t) => [t.id, t.text, t.nodes]), ["you", L("你的对话", "Your conversations"), f.you?.nodes || []]]
      .map(([id, text, ns]) => `<optgroup label="${esc(String(text).slice(0, 26))}">${ns.filter((x) => x.id !== n.id).map((x) => `<option value="${x.id}">${esc(x.title)}</option>`).join("")}</optgroup>`).join("")}</select><button class="sm" data-move="${b.id}">${L("移过去", "Move")}</button>`;
  box.innerHTML = kcard(b, (others.length ? `<select id="refTo"><option value="">${L("给哪棵树参考…", "Let a tree use it…")}</option>${others.map((t) => `<option value="${t.id}">${esc(t.text.slice(0, 26))}</option>`).join("")}</select><button class="sm" data-ref="${b.id}">${L("给它参考", "Use")}</button>` : "") + moveTo)
    + ((b.used_by || []).length ? `<div class="dimt" style="font-size:12px">${L("正在参考它的树：", "Used by: ")}${b.used_by.map((id) => esc((f.trees.find((t) => t.id === id)?.text || "").slice(0, 20))).join(", ")}</div>` : "");
}
function renderCont() {
  const n = nodeOf(S.node), box = $("#tnText"); if (box) S.draft = box.value;
  if (!n) { $("#cont").innerHTML = ""; return; }
  const bud = S.bud != null ? (n.buds || [])[S.bud] : null, K = S.forest?.knowledge || [];
  const bf = S.branchFrom && nodeOf(S.branchFrom), end = chainEnd();
  $("#cont").innerHTML = `<div class="inner">${bf ? `<div class="budbar"><span>${L(`从「${esc(bf.title)}」分出一条新分支：写下新方向的第一句`, `Branching from “${esc(bf.title)}”: write the first line of the new direction`)}</span><a href="#" id="unbranch">${L("取消", "Cancel")}</a></div>` : ""}${bud ? `<div class="budbar"><span>${L("沿这个灵感长出分支：", "Grow a branch along this idea: ")}${esc(bud.idea)}</span><a href="#" data-go="${n.id}">${L("取消", "Cancel")}</a></div>` : ""}
    <div class="refs">${S.contRefs.map((id) => { const k = K.find((x) => x.id === id); return k ? `<span class="chip on">${esc(k.title.slice(0, 18))}&nbsp;<a href="#" data-crefdel="${id}" style="color:inherit">×</a></span>` : ""; }).join("")}${S.tree?.focus === n.id && !YOU() ? `<span style="color:var(--accent)">${L("PGA 正沿着这里想", "PGA is following this branch")}</span><a href="#" data-focus="">${L("取消", "Stop")}</a>` : ""}</div>
    ${envBar(treeKey(), [])}<div class="cbar"><select id="crefAdd" class="kpick" title="${L("引用知识", "Use knowledge")}"><option value="">＋</option>${K.filter((k) => !S.contRefs.includes(k.id)).map((k) => `<option value="${k.id}">${esc(sysName(k) + " · " + k.title)}</option>`).join("")}</select>
      <textarea id="tnText" rows="1" placeholder="${bud ? L("沿这个灵感，你想问什么？", "What do you want to ask along this idea?") : bf ? L("新分支的第一句…（Enter 发送，Shift+Enter 换行）", "The new branch's first line… (Enter sends, Shift+Enter for a new line)") : L(`继续这段对话…（Enter 发送，Shift+Enter 换行）`, `Continue this conversation… (Enter sends, Shift+Enter for a new line)`)}" title="${bf ? "" : esc(L(`接在「${end?.title || ""}」后面`, `After “${end?.title || ""}”`))}">${esc(S.draft || "")}</textarea>
      <button class="ghost" id="ctxBtn" style="height:36px" title="${L("这次会带上什么上下文", "What context this message carries")}">${L("上下文", "Context")}</button>
      ${accBtn(treeKey())}<select id="tnAgent"><option value="auto">${L("自动", "Auto")}</option>${S.agents.map((a) => `<option value="${esc(a.name)}">${esc(agentLabel(a.name))}</option>`).join("")}</select>
      <button class="primary" id="send" ${S.sending ? "disabled" : ""}>${S.sending ? "…" : bud || bf ? L("分支", "Branch") : L("发送", "Send")}</button></div></div>`;
  autoGrow($("#tnText"));
}
// Input events can arrive several times within a frame (including IME input).
// Measure only the final value; direct callers still use synchronous autoGrow.
const growPending = new WeakSet();
function autoGrowSoon(t) {
  if (!t || t._pgaComposing || growPending.has(t)) return;
  growPending.add(t);
  requestAnimationFrame(() => { growPending.delete(t); if (t.isConnected && !t._pgaComposing) autoGrow(t); });
}
function autoGrow(t) {                               // the composer grows with what you type (up to 240 px) and shrinks back when you delete
  if (!t) return;
  const n = t.value.length, nl = t.value.split("\n").length, longer = n >= (t._agLen ?? 0) && nl >= (t._agNl ?? 0); t._agLen = n; t._agNl = nl;
  if (longer && t.style.height && (parseFloat(t.style.height) >= 240 || t.scrollHeight <= t.clientHeight)) return;   // typing on and it still fits: nothing to redo
  t.style.height = "36px"; t.style.height = Math.min(240, t.scrollHeight + 2) + "px";   // (collapsing it to measure lays the page out twice: only when it may change)
}

