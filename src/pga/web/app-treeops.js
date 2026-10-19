/* PGA app · the node menu and the things you do on a tree. Plain scripts sharing one global scope, loaded in order by app.html. */
/* ------------------------------------------------ the right-click menu */
const linksOf = (n) => (S.tree?.nodes || []).filter((o) => (n.links || []).includes(o.id) || (o.links || []).includes(n.id));
function closeCtx() { document.querySelector(".ctx")?.remove(); }
function openCtx(x, y, id) {
  closeCtx(); const n = nodeOf(id); if (!n) return;
  const mine = n.kind !== "segment", m = document.createElement("div"); m.className = "ctx";
  m.innerHTML = `<div class="ch">${esc(n.title)}</div>
    <button data-cx="continue">${L("从这里继续对话", "Continue the conversation here")}<kbd>↵</kbd></button>
    <button data-cx="branch">${L("从这里分支", "Branch from here")}</button>
    <button data-cx="details">${L("查看详情", "Details")}</button>
    <hr><button data-cx="edit">${L("编辑标题和概括…", "Edit title and summary…")}</button>
    <button data-cx="exchange-pick">${L("和别的分支交流…", "Exchange with another branch…")}</button>
    <button data-cx="distill">${n.dataset ? L("重新沉淀为知识", "Distill again") : L("沉淀为知识", "Distill into knowledge")}</button>
    ${YOU() ? "" : `<button data-cx="focus">${S.tree?.focus === n.id ? L("不再让 PGA 沿这里想", "Stop following this branch") : L("让 PGA 沿这里想", "Let PGA follow this branch")}</button>`}
    <hr><button data-cx="move">${L("移到…", "Move to…")}</button>${linksOf(n).map((o) => `<button data-cx="unlink:${o.id}">${L("断开与「", "Unlink “")}${esc(o.title.slice(0, 14))}${L("」的链接", "”")}</button>`).join("")}${n.pos ? `<button data-cx="unpos">${L("放回原位", "Put back in place")}</button>` : ""}<button data-cx="hide">${n.hidden ? L("显示", "Show") : L("隐藏", "Hide")}</button>
    ${n.parent && n.kind === "segment" ? `<button data-cx="merge">${L("合并到上一级", "Merge into parent")}</button>` : ""}<button data-cx="markdown">${L("下载 Markdown", "Download Markdown")}</button>
    ${mine ? `<hr><button class="danger" data-cx="delete">${L("删除", "Delete")}</button>` : ""}`;
  m.dataset.node = id; document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + "px"; m.style.top = Math.min(y, innerHeight - r.height - 8) + "px";
}
async function ctxDo(op, id) {
  closeCtx(); if (S.node !== id) select(id);
  if (op === "continue") { S.drawer = false; renderDrawer(); renderHead(); $("#tnText")?.focus(); return; }
  if (op === "details") { S.drawer = true; renderDrawer(); renderHead(); return; }
  if (op === "branch") { branchFrom(id); return; }
  if (op.startsWith("unlink:")) { try { await api(`/v1/thought-nodes/${id}/links/${op.slice(7)}`, { method: "DELETE" }); await loadTree(true); drawTree(false); toast(L("已断开", "Unlinked")); } catch (err) { toast(err.message); } return; }
  if (op === "unpos") { try { await api(`/v1/thought-nodes/${id}`, { method: "PATCH", body: { pos: null } }); await loadTree(true); drawTree(false); } catch (err) { toast(err.message); } return; }
  if (op === "focus") { const on = S.tree?.focus === id; focusOn(on ? "" : id); return; }
  if (["hide", "merge", "delete", "distill", "markdown"].includes(op)) { quickOp(op); return; }
  openOp(op);
}
async function openOp(op) {
  S.op = op || null; S.drawer = true; renderDrawer(); renderHead();
  if (op === "exchange-pick") {
    const f = await forest().catch(() => null), sel = $("#fOther");
    if (f && sel) sel.innerHTML = `<option value="">${L("（别的树的节点）", "(a node in another tree)")}</option>` + [...f.trees, ...(f.you ? [f.you] : [])].filter((x) => x.id !== S.aim && x.nodes.length)
      .map((x) => `<optgroup label="${esc(x.text.slice(0, 30))}">${x.nodes.map((m) => `<option value="${x.id}|${m.id}">${esc(m.title)}</option>`).join("")}</optgroup>`).join("");
  }
  if (op === "branch") $("#fBranch")?.focus();
  if (op === "edit") $("#fTitle")?.focus();
}
async function focusOn(id) {
  try { await api(`/v1/aims/${S.aim}/tree/focus`, { body: { node_id: id || null } }); toast(id ? L("之后 PGA 会沿这条分支想", "PGA will follow this branch") : L("已取消", "Stopped")); await loadTree(true); renderCont(); }
  catch (err) { toast(err.message); }
}

/* ------------------------------------------------ doing things in a tree */
async function refresh(id) { S.forest = null; if (id) delete S.detail[id]; await loadTree(true); renderAll(); renderCont(); if (S.node) loadNode(S.node, true); }
/* the composer continues the conversation you are reading (at its end); a branch starts from the node you picked */
const chainEnd = () => { const { nodes } = chainOf(S.node); return nodes[nodes.length - 1] || nodeOf(S.node); };
async function send() {
  const branching = S.branchFrom && nodeOf(S.branchFrom);
  const n = branching || (S.bud != null ? nodeOf(S.node) : chainEnd()), text = ($("#tnText")?.value || "").trim(); if (!n) return;
  if (!text) { toast(L("先写下你要从这里问什么", "Write what you want to ask first")); return; }
  const bud = S.bud != null ? (n.buds || [])[S.bud]?.idea : null;
  S.sending = true; S.draft = text; renderCont(); startLive((c) => c.includes(":node:")); renderDialog(); requestAnimationFrame(() => { const w = $("#dlg"); w.scrollTop = w.scrollHeight; });
  try {
    const r = await api(`/v1/thought-nodes/${n.id}/continue`, { body: { text, agent: $("#tnAgent")?.value || "auto", bud, refs: S.contRefs, branch: !!branching } });
    if (r.reply?.error && !r.reply?.text) toast(r.reply.error);
    S.draft = ""; S.branchFrom = null; delete S.detail[r.node.id];
    await loadTree(true); S.node = r.node.id; S.bud = null; history.replaceState(null, "", qs());
    drawTree(true); await loadNode(r.node.id, true);
  } catch (err) { toast(err.message); }
  finally { S.sending = false; stopLive(); renderCont(); renderDialog(); scrollToSeam(); }
}
async function doOp(kind) {
  const n = nodeOf(S.node); if (!n) return;
  try {
    if (kind === "edit") {
      await api(`/v1/thought-nodes/${n.id}`, { method: "PATCH", body: { title: $("#fTitle").value, summary: $("#fSummary").value, key_thoughts: $("#fKeys").value.split("\n").map((x) => x.trim()).filter(Boolean) } });
      S.op = null; toast(L("已保存", "Saved")); await refresh(n.id);
    } else if (kind === "branch") {
      const title = $("#fBranch").value.trim(); if (!title) { toast(L("写一句这条分支的方向", "Write the branch's direction")); return; }
      const b = await api(`/v1/thought-nodes/${n.id}/branch`, { body: { title } }); S.op = null; S.drawer = false; await loadTree(true); select(b.id); $("#tnText")?.focus(); toast(L("长出了一条空分支：在下面写点什么，它就开始长", "A new branch: write below and it starts to grow"));
    } else if (kind === "move") {
      await api(`/v1/thought-nodes/${n.id}`, { method: "PATCH", body: { parent_id: $("#fParent").value || null } }); S.op = null; toast(L("已移过去", "Moved")); await refresh(n.id);
    } else if (kind === "pick-other") {
      const v = $("#fOther").value; if (!v) { toast(L("在左边点一个节点，或从列表里选", "Click a node on the tree, or pick one")); return; }
      const [aim, id] = v.split("|"); S.exWith = id; S.exOther = ([...S.forest.trees, S.forest.you].find((t) => t && t.id === aim)?.nodes || []).find((x) => x.id === id); S.op = "exchange"; renderDrawer();
    } else if (kind === "exchange") {
      S.sending = true; renderDrawer();
      try { const r = await api(`/v1/thought-nodes/${n.id}/exchange`, { body: { with: S.exWith, text: $("#fExText")?.value || "" } });
        S.op = null; S.drawer = false; await loadTree(true); select(r.node.id); toast(L("交流完成", "Done")); }
      finally { S.sending = false; }
    }
  } catch (err) { toast(err.message); }
}
async function quickOp(op) {
  const n = nodeOf(S.node); if (!n) return;
  try {
    if (op === "hide") { await api(`/v1/thought-nodes/${n.id}`, { method: "PATCH", body: { hidden: !n.hidden } }); toast(n.hidden ? L("显示回来了", "Shown again") : L("已隐藏（连同它长出去的）", "Hidden, with what grew from it")); await refresh(n.id); }
    else if (op === "merge") { if (!confirm(L(`把「${n.title}」并进上一级？`, `Merge “${n.title}” into its parent?`))) return; const p = await api(`/v1/thought-nodes/${n.id}/merge`, { method: "POST" }); await loadTree(true); select(p.id); toast(L("已合并", "Merged")); }
    else if (op === "delete") { if (!confirm(L(`删除「${n.title}」？对话仍留在记录里，只是不再显示在树上。`, `Delete “${n.title}”? The dialogue stays on record; it just leaves the tree.`))) return; const parent = n.parent; await api(`/v1/thought-nodes/${n.id}`, { method: "DELETE" }); await loadTree(true); select(parent); toast(L("已删除", "Deleted")); }
    else if (op === "markdown") { window.open(`/v1/thought-nodes/${n.id}/markdown`, "_blank"); }
    else if (op === "distill") {
      toast(L("正在沉淀这段思路…", "Distilling this line of thought…")); const r = await api(`/v1/thought-nodes/${n.id}/distill`, { method: "POST" });
      toast(r.status === "compiled" ? L(`已沉淀成一份数据集（${r.words} 词）`, `Distilled into a dataset (${r.words} words)`) : r.status === "deferred" ? L("现在额度不够，稍后再试", "No budget right now; try later") : `${r.note || r.status}`);
      S.tab = "knowledge"; S.drawer = true; await refresh(n.id);
    }
  } catch (err) { toast(err.message); }
}

/* what used to need the workbench: questions only you can answer, checkpoints, and the settings */
const PRESETS = { performance: [L("最高性能", "Best quality"), { w_perf: 2.5, w_pref: 1, w_balance: .5, w_cost: 0, w_speed: .3, temperature: .25 }],
                  balanced: [L("均衡", "Balanced"), { w_perf: 1, w_pref: 1, w_balance: 1, w_cost: .4, w_speed: .3, temperature: .35 }],
                  economy: [L("省钱", "Economical"), { w_perf: .6, w_pref: 1, w_balance: 2, w_cost: 2, w_speed: .2, temperature: .5 }] };
const LEVELS = [["free", L("完全自由", "Free"), L("它自己想、自己研究，验证过的改进自动上线（出问题会回滚）", "It thinks and researches on its own; verified improvements go live (and roll back if they regress)")],
  ["checkpoint", L("检查点", "Checkpoints"), L("每想几轮停下来，把发现和打算交给你决定", "Every few rounds it stops and hands you its findings and plans")], ["driven", L("用户驱动", "On request"), L("只在你提出要求时工作", "It works only when you ask")]];
function modal(html) { document.querySelector(".modal")?.remove(); const m = document.createElement("div"); m.className = "modal"; m.innerHTML = `<div class="box">${html}</div>`; m.addEventListener("click", (e) => { if (e.target === m) m.remove(); }); document.body.appendChild(m); return m; }
function showWaiting() {
  const P = S.proc || {}, cp = P.checkpoint;
  modal(`${cp ? `<h2>${L("检查点", "Checkpoint")}</h2><div class="muted" style="margin-bottom:12px">${L("它停下来了：这是它的发现和打算，你决定下一步。", "It stopped: here is what it found and plans. You decide what comes next.")}</div>
      <div class="label">${L("它发现了什么", "What it found")}</div><div style="margin:6px 0 14px">${esc(cp.summary || "")}</div>
      ${cp.direction ? `<div class="label">${L("接下来的整体思路", "Where it wants to go")}</div><div style="margin:6px 0 14px">${esc(cp.direction)}</div>` : ""}${cp.question ? `<div class="shift">${esc(cp.question)}</div>` : ""}
      ${(cp.options || []).map((o, i) => `<label class="opt"><input type="radio" name="cpopt" value="${i}" ${i === 0 ? "checked" : ""}><span>${esc(o.label)}${i === 0 ? ` <span class="dimt">${L("（它的建议）", "(its suggestion)")}</span>` : ""}<div class="d">${esc(o.detail || "")}</div></span></label>`).join("")}
      ${(cp.proposals || []).length ? `<div class="label" style="margin-top:12px">${L("要动手实现的改进（勾选才会做）", "Improvements to build (only the ticked ones)")}</div>${cp.proposals.map((p) => `<label class="opt"><input type="checkbox" data-cpp="${esc(p.code)}" ${p.recommend ? "checked" : ""}><span><b>${esc(p.code)}</b> ${esc(p.title)}<div class="d">${esc(p.why || p.change || "")}</div></span></label>`).join("")}` : ""}
      <div class="form"><textarea id="cpText" placeholder="${L("可选：你的看法或修正，会成为之后每一轮的指导", "Optional: your view or correction, read by every later round")}"></textarea>
      <div class="row"><button class="ghost" data-cp="stop">${L("停下", "Stop")}</button><button data-cp="adjust">${L("按我的意见调整后继续", "Adjust and continue")}</button><button class="primary" data-cp="continue">${L("同意，继续", "Continue")}</button></div></div>` : ""}
    ${(P.for_you || []).length ? `<h2 style="margin-top:${cp ? 24 : 0}px">${L("只有你能回答", "Only you can answer")}</h2>${P.for_you.map((q) => `<div class="form"><div>${esc(q.text)}</div>${q.data?.why ? `<div class="dimt" style="font-size:12.5px">${esc(q.data.why)}</div>` : ""}
      <textarea data-q="${q.id}" placeholder="${L("你的回答会成为这个抱负的指导，之后每一轮都会读到", "Your answer becomes guidance every later round reads")}"></textarea>
      <div class="row"><button class="ghost" data-drop="${q.id}">${L("不用回答", "Skip")}</button><button class="primary" data-answer="${q.id}">${L("回答", "Answer")}</button></div></div>`).join("")}` : ""}`);
}
async function showSettings() {
  const t = S.proc?.task; if (!t) { toast(L("这个抱负还没有在长期运行：先按开始", "Not running yet: press Start first")); return; }
  let preset = "balanced"; try { preset = (await api(`/v1/aims/${S.aim}/allocation`)).settings?.preset || "balanced"; } catch {}
  modal(`<h2>${L("设置", "Settings")}</h2><div class="muted" style="margin-bottom:12px">${L("这棵树的长期任务怎么跑。", "How this tree's long-running task works.")}</div>
    <div class="label">${L("驱动模式", "Drive mode")}</div>${LEVELS.map(([k, nm, d]) => `<label class="opt"><input type="radio" name="lvl" value="${k}" ${(t.autonomy || "checkpoint") === k ? "checked" : ""}><span><b style="font-weight:500">${nm}</b><div class="d">${d}</div></span></label>`).join("")}
    <div style="margin:4px 0 16px 26px;font-size:13px">${L("每想", "Stop every")} <input type="number" id="setEvery" min="1" max="50" value="${t.checkpoint_every || 6}" style="width:60px"> ${L("轮停下来一次", "rounds")}</div>
    <div class="label">${L("受控分叉 · 多次生成", "Controlled forking · samples")}</div>
    <div style="font-size:13px;margin:8px 0">${L("每个问题最多生成", "At most")} <input type="number" id="setSamples" min="1" max="5" value="${t.samples ?? 3}" style="width:60px"> ${L("次。实际次数由 P(fork)=f(不确定性, 分歧, 影响, 成本) 决定；分出明显不同的结论会留作影子路线，回顾时重新考虑。", "samples per question. How many is decided by P(fork) = f(uncertainty, disagreement, impact, cost); clearly different conclusions are kept as shadow paths and revisited.")}</div>
    <div style="font-size:13px;margin-bottom:16px">${L("提示词扰动强度", "Prompt perturbation")} <input type="range" id="setPerturb" min="0" max="1" step="0.1" value="${t.perturb ?? .5}" style="vertical-align:middle"> <span id="pv" class="num">${(t.perturb ?? .5).toFixed(1)}</span></div>
    <div class="label">${L("多 agent 分配", "How work is shared among agents")}</div><div style="display:flex;gap:6px;margin:8px 0 18px">${Object.entries(PRESETS).map(([k, [nm]]) => `<label class="chip ${k === preset ? "on" : ""}"><input type="radio" name="preset" value="${k}" ${k === preset ? "checked" : ""} style="display:none">${nm}</label>`).join("")}</div>
    <div class="form" style="border:0;background:none;padding:0"><div class="row"><button class="ghost" data-closemodal="1">${L("取消", "Cancel")}</button><button class="primary" id="saveSettings">${L("保存", "Save")}</button></div></div>`);
  document.querySelectorAll('input[name=preset]').forEach((r) => r.addEventListener("change", () => document.querySelectorAll('input[name=preset]').forEach((x) => x.parentElement.classList.toggle("on", x.checked))));
  $("#setPerturb").addEventListener("input", (e) => { $("#pv").textContent = Number(e.target.value).toFixed(1); });
}
async function saveSettings() {
  const lvl = document.querySelector('input[name=lvl]:checked')?.value, preset = document.querySelector('input[name=preset]:checked')?.value;
  const settings = { autonomy: lvl, checkpoint_every: Number($("#setEvery").value), samples: Number($("#setSamples").value), perturb: Number($("#setPerturb").value) };
  if (preset) settings.alloc = { preset, ...PRESETS[preset][1] };
  try { await api(`/v1/aims/${S.aim}/perpetual`, { method: "PATCH", body: { settings } }); document.querySelector(".modal")?.remove(); toast(L("已保存", "Saved")); await loadTree(true); }
  catch (err) { toast(err.message); }
}
async function showContext() {
  const n = nodeOf(S.node); if (!n) return;
  const q = ($("#tnText")?.value || "").trim();
  const r = await api(`/v1/thought-nodes/${n.id}/context?q=${encodeURIComponent(q)}&refs=${S.contRefs.join(",")}`).catch((e) => ({ error: e.message }));
  if (r.error) { toast(r.error); return; }
  modal(`<div class="ctxv"><h2>${L("这次发送会带上的上下文", "The context this message carries")}</h2>
    <div class="muted" style="font-size:13px">${r.continues ? L("你在自己的这条分支里接着聊：agent 的会话里已经有开头和之前的对话，这次只会收到你的新消息和它后面附带的内容。", "You are continuing your own branch: the agent's session already holds the opening and the earlier turns, so it only gets your new message and what follows it.")
      : L("这会开一条新分支：agent 先读开头，再读你的消息。从同一个节点开出的分支，开头一字不差，所以能命中模型厂商的提示词缓存。", "This starts a new branch: the agent reads the opening, then your message. Every branch started from this node opens with exactly the same text, so it can come from the provider's prompt cache.")}</div>
    <div class="lay"><b>${L("① 开头", "① Opening")}</b><span>${L(`约 ${r.opening_tokens} token · 从稳定到易变：目标、两个模型和引用的知识、从根到这里的路径、链接、代码、这个节点最近几轮`, `≈${r.opening_tokens} tokens · stable to changing: the goal, the two models and referenced knowledge, the path from the root, links, code, this node's latest turns`)}${r.continues ? L("（这次不会再发）", " (not sent again this time)") : ""}</span></div><pre>${esc(r.opening)}</pre>
    <div class="lay"><b>${L("② 你的消息", "② Your message")}</b><span>${esc(q || L("（还没写）", "(not written yet)"))}</span></div>
    <div class="lay"><b>${L("③ 消息后面附带", "③ After your message")}</b><span>${r.tail ? L(`约 ${r.tail_tokens} token · 这条消息引用的知识，和别的分支里相关的节点`, `≈${r.tail_tokens} tokens · knowledge pinned to this message, and related nodes from other branches`) : L("没有：写下问题后，这里会显示别的分支里相关的节点", "Nothing: once you write a question, related nodes from other branches show here")}</span></div>
    ${r.tail ? `<pre>${esc(r.tail)}</pre>` : ""}</div>`);
}
async function showDoc(id) {
  if (!id) return;
  const d = await api(`/v1/bodies/${id}/document${EN ? "?lang=en" : ""}`).catch((e) => ({ error: e.message }));
  const dims = d.dims ? `<div class="muted" style="font-size:12.5px;margin:-6px 0 8px">${L("可以直接改：加一条你自己说的、去掉不对的、改写概括。你改的会一直保留，重新整理也不会被覆盖。", "Edit it directly: add something about you, remove what is wrong, rewrite a summary. Your edits are kept through every rebuild.")}</div>` + DIMS.map(([k, zh, en]) => { const x = d.dims[k] || {};
      const li = (lst) => (x[lst] || []).map((v, i) => `<li>${esc(v)}<button class="xdel" data-fdel="${k}|${lst}|${i}" data-body="${id}" title="${L("去掉", "Remove")}">×</button></li>`).join("");
      return `<div class="dd"><div class="hh"><b>${L(zh, en)}</b><span class="label">${L("把握", "confidence")} ${Math.round((x.confidence || 0) * 100)}%</span></div>
      <div class="sm fsum" data-fsum="${k}" data-body="${id}" title="${L("点一下改写", "Click to rewrite")}">${esc(x.summary || L("（还没有概括，点一下写）", "(no summary yet — click to write one)"))}</div>
      ${(x.stated || []).length ? `<div class="label" style="margin-top:8px">${L("你说过的", "Stated")}</div><ul>${li("stated")}</ul>` : ""}
      ${(x.inferred || []).length ? `<div class="label" style="margin-top:8px">${L("推断的", "Inferred")}</div><ul>${li("inferred")}</ul>` : ""}
      <div class="fadd"><input type="text" placeholder="${L("加一条关于你的…（回车）", "Add something about you… (Enter)")}" data-fadd="${k}" data-body="${id}"></div></div>`; }).join("") : "";
  modal(d.error ? esc(d.error) : `<h2>${esc(d.title)}</h2><div class="muted" style="margin-bottom:14px">${esc(d.gist || "")}</div>
    ${dims || `${d.summary ? PGATree.summary(d.summary) : ""}<div class="md" style="margin-top:16px">${md(d.full || L("（还没有全文）", "(no full text yet)"))}</div>`}
    ${d.system && !d.compiled_at ? `<button class="primary" data-compile="${id}" style="margin-top:14px">${L("现在整理", "Compile now")}</button>` : ""}`);
}

