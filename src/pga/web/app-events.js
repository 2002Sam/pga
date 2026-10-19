/* PGA app · clicks, keys and inputs. Plain scripts sharing one global scope, loaded in order by app.html. */
/* ------------------------------------------------ events */
document.addEventListener("contextmenu", (e) => {
  const lr = e.target.closest?.(".lrow[data-tline]");
  if (lr && S.view === "chats") { e.preventDefault(); const xs = (S.tl?.sessions || []).filter((x) => x.line === lr.dataset.tline); if (xs.length) openTlCtx(e.clientX, e.clientY, xs[xs.length - 1].id); return; }
  const ts = e.target.closest?.("[data-ts]");
  if (ts && S.view === "chats") { e.preventDefault(); openTlCtx(e.clientX, e.clientY, ts.dataset.ts); return; }
  const t = e.target.closest?.("[data-tnode], [data-ctxnode]");
  if (!t || S.view !== "tree") { closeCtx(); return; }
  e.preventDefault();
  const id = t.dataset.tnode || t.dataset.ctxnode; if (!id) return;
  if (id !== S.node) select(id);
  openCtx(e.clientX, e.clientY, id);
});
document.addEventListener("click", async (e) => {
  if (DR.suppress) { DR.suppress = false; return; }
  const cx = e.target.closest(".ctx button[data-cx]"); if (cx) { ctxDo(cx.dataset.cx, cx.closest(".ctx").dataset.node); return; }
  const tx = e.target.closest(".ctx button[data-tx]"); if (tx) { tlDo(tx.dataset.tx, tx.closest(".ctx").dataset.ts); return; }
  if (!e.target.closest(".ctx")) closeCtx();
  const trb = e.target.closest(".trbtn"); if (trb) { toggleTranslate(trb); return; }
  const t = e.target.closest("[data-bar], [data-view], [data-tnode], [data-tbud], [data-go], [data-goaim], [data-tab], [data-bud], [data-focus], [data-op], [data-do], [data-trnode], [data-doc], [data-compile], [data-ref], [data-unref], [data-mode], [data-refadd], [data-unrefnode], [data-move], [data-crefdel], [data-chrefdel], [data-answer], [data-drop], [data-cp], [data-closemodal], [data-chat], [data-arch], [data-plus], [data-ts], [data-setdir], [data-browsedir], [data-bgset], #accBrowse, [data-dir], [data-usedir], [data-pickdir], [data-stoplive], #usageBtn, #looseToggle, [data-second], [data-cbranch], [data-pin], [data-moveto], [data-archall], [data-acc], #accSave, [data-tline], [data-tlmode], #lineSend, #lineNote, [data-ltarget], #moveGo, [data-litem], [data-opentree], #lineClear, #lineSteps, #lineSum, #lineOut, #tlImport, #archList, #impSend, #hubSync, #tidyGo, #joinGo, #unhideAll, #unbranch, #archToggle, #fold, #send, #curate, #rewrite, #dirBtn, #ctxBtn, #runBtn, #waitBtn, #setBtn, #saveSettings, #drawerBtn, #drawerClose, #newChat, #chatSend, #plant, #seedGo, #seedCancel, #unfold, .trbtn");
  if (!t && e.target.closest?.("#tlSvg") && S.tlLine) { S.tlLine = null; S.tlSel = null; renderTimeline(); renderChat(); return; }
  if (!t) return;
  if (t.tagName === "A" || t.dataset.tab || t.dataset.go || t.dataset.goaim || t.dataset.bar || t.dataset.view) e.preventDefault();
  if (t.dataset.bar) { const id = t.dataset.bar; if (id === "chats") show("chats"); else show("tree", { aim: id }); return; }
  if (t.dataset.view) { show(t.dataset.view); return; }
  if (t.id === "plant") { S.planting = !S.planting; renderRail(); $("#seedText")?.focus(); return; }
  if (t.id === "seedCancel") { S.planting = false; renderRail(); return; }
  if (t.id === "seedGo") {
    const text = ($("#seedText")?.value || "").trim(); if (!text) { toast(L("写下这个抱负", "Write the motivation")); return; }
    try { const a = await api(`/v1/users/${S.uid}/aims`, { body: { text } }); S.planting = false; toast(L("种下了：选一个工作文件夹，按开始", "Planted: choose a folder, press Start")); await loadForest(); if (a?.id) show("tree", { aim: a.id }); } catch (err) { toast(err.message); }
    return;
  }
  if (t.id === "ctxBtn") { showContext(); return; }
  if (t.id === "dirBtn") { S.dir = S.dir === "down" ? "up" : "down"; store.set("pga_tree_dir", S.dir); renderBar(); drawTree(true); return; }
  if (t.id === "fold" || t.id === "unfold") { setMini(!S.mini); return; }
  if (t.closest?.("[data-ts]") && t.dataset.ts) { openSession(t.dataset.ts); return; }
  if (t.id === "tlImport") { showImport(); return; }
  if (t.dataset.tline) { pickLine(t.dataset.tline); return; }
  if (t.id === "looseToggle") { S.showLoose = !S.showLoose; renderTimeline(); return; }
  if (t.id === "accBrowse") { browseDirs($("#accFolder").value || ""); return; }
  if (t.dataset.dir) { browseDirs(t.dataset.dir); return; }
  if (t.dataset.usedir) { $("#accFolder").value = t.dataset.usedir; $("#dirBox").innerHTML = ""; return; }
  if (t.dataset.pickdir !== undefined) { e.preventDefault(); folderMenu(t, t.dataset.pickdir); return; }
  if (t.dataset.setdir !== undefined) { e.preventDefault(); setFolder(t.closest(".fmenu").dataset.key, t.dataset.setdir); return; }
  if (t.dataset.browsedir !== undefined) { e.preventDefault(); const k = t.closest(".fmenu").dataset.key; document.querySelector(".fmenu")?.remove(); await loadAcc(k); showAcc(k); setTimeout(() => browseDirs($("#accFolder")?.value || ""), 50); return; }
  if (t.dataset.stoplive) { api(`/v1/agents/live/${t.dataset.stoplive}/stop`, { method: "POST" }).then(() => toast(L("已让它停下，已经写出的内容会保留", "Stopping; what it wrote so far is kept"))).catch((err) => toast(err.message)); return; }
  if (t.id === "usageBtn") { showUsage(); return; }
  if (t.dataset.second) { secondOpinion(t.dataset.second, t.dataset.ckey); return; }
  if (t.dataset.cbranch) { chatBranch(t.dataset.cbranch, t.dataset.ckey); return; }
  if (t.dataset.pin) { try { const r = await api(`/v1/users/${S.uid}/timeline/pin`, { method: "PUT", body: { line: t.dataset.pin, pinned: t.dataset.to === "1" } }); S.tl.pinned = r.pinned; renderTimeline(); renderChat(); toast(t.dataset.to === "1" ? L("已置顶", "Pinned") : L("已取消置顶", "Unpinned")); } catch (err) { toast(err.message); } return; }
  if (t.dataset.moveto !== undefined) { moveDialog(t.dataset.moveto, t.dataset.line); return; }
  if (t.dataset.archall !== undefined) { archiveHere(t.dataset.archall, t.dataset.line); return; }
  if (t.dataset.tlmode) { store.set("pga_tl_mode", t.dataset.tlmode); S.tlScrolled = false; renderTimeline(); return; }
  if (t.id === "lineSend") { lineSend(); return; }
  if (t.id === "lineNote") { lineSend(true); return; }
  if (t.dataset.ltarget) { S.lineTarget = t.dataset.ltarget; renderChat(); $("#chatText")?.focus(); return; }
  if (t.dataset.acc !== undefined) { showAcc(t.dataset.acc); return; }
  if (t.id === "accSave") { saveAcc(t.dataset.key); return; }
  if (t.dataset.litem) { const x = (S.tl?.sessions || []).find((y) => y.item === t.dataset.litem); if (x) openSession(x.id); return; }
  if (t.dataset.opentree) { show("tree", { aim: t.dataset.opentree, node: t.dataset.node || null }); return; }
  if (t.id === "lineClear") { S.lineView = null; S.tlLine = null; S.tlSel = null; renderTimeline(); renderChat(); return; }
  if (t.id === "lineSteps") { t.disabled = true; t.textContent = L("压缩中…", "Compressing…"); S.lineOpen = true;
    try { await api(`/v1/users/${S.uid}/timeline/line/steps`, { body: { id: S.tlLine } }); await loadLine(S.tlLine); } catch (err) { toast(err.message); t.disabled = false; } return; }
  if (t.id === "lineSum") { t.disabled = true; t.textContent = L("概括中…", "Summarizing…");
    try { await api(`/v1/users/${S.uid}/timeline/line/summarize`, { body: { id: S.tlLine } }); await loadLine(S.tlLine); } catch (err) { toast(err.message); t.disabled = false; } return; }
  if (t.id === "lineOut") { const d = S.lineD?.[S.tlLine]; const title = prompt(L("这棵树叫什么？（也就是这个抱负）", "Name the tree (the motivation)"), d?.title || ""); if (!title) return;
    try { const r = await api(`/v1/users/${S.uid}/timeline/line/extract`, { body: { id: S.tlLine, title } });
      toast(L(`抽离好了：${r.nodes} 个节点`, `Pulled out: ${r.nodes} nodes`)); await loadForest(); show("tree", { aim: r.aim }); } catch (err) { toast(err.message); } return; }
  if (t.id === "archList") { showArchived(); return; }
  if (t.id === "impSend") { impSend(); return; }
  if (t.dataset.bgset) { const body = t.dataset.bgset === "long" ? { long_tasks: t.dataset.to === "1" } : { keep_for_me: t.dataset.to === "1" ? ["claude_local"] : [] };
    try { await api(`/v1/agents/background`, { method: "PUT", body }); showUsage(); } catch (err) { toast(err.message); } return; }
  if (t.id === "hubSync") { t.disabled = true; t.textContent = L("同步中…", "Syncing…");
    try { const r = await api(`/v1/users/${S.uid}/hub/sync`, { method: "POST" }); toast(L("同步好了", "Synced") + (r?.new != null ? ` · ${r.new}` : "")); await loadTimeline(); showImport(); } catch (err) { toast(err.message); } return; }
  if (t.id === "tidyGo") { try { const r = await api(`/v1/users/${S.uid}/timeline/organize`, { body: { use_model: true } });
      toast(L(`先按标题合了 ${r.new_lines} 条线；模型在后台读剩下的`, `${r.new_lines} lines from matching titles; a model reads the rest in the background`)); document.querySelector(".modal")?.remove(); pollTidy(); await loadTimeline(); } catch (err) { toast(err.message); } return; }
  if (t.id === "moveGo") { const to = $("#joinTo")?.value; if (!to) { toast(L("选一条线", "Pick a line")); return; }
    for (const k of t.dataset.keys.split("\n")) await api(`/v1/users/${S.uid}/timeline/items`, { method: "PUT", body: { key: k, line: to } }).catch(() => {});
    document.querySelector(".modal")?.remove(); toast(L("放过去了", "Moved")); await loadTimeline(); if (S.lineView) { S.lineView = to; S.tlLine = to; await loadLine(to); } renderChat(); return; }
  if (t.id === "joinGo") { const to = $("#joinTo")?.value; if (!to) { toast(L("选一条线", "Pick a line")); return; }
    try { await api(`/v1/users/${S.uid}/timeline/items`, { method: "PUT", body: { key: t.dataset.key, line: to } }); document.querySelector(".modal")?.remove(); toast(L("接上了", "Joined")); await loadTimeline(); } catch (err) { toast(err.message); } return; }
  if (t.id === "unhideAll") { for (const k of S.tl?.hidden || []) await api(`/v1/users/${S.uid}/chats/archive`, { body: { key: k, archived: false } }).catch(() => {}); document.querySelector(".modal")?.remove(); await loadTimeline(); return; }
  if (t.dataset.plus) { branchFrom(t.dataset.plus); return; }
  if (t.id === "unbranch") { S.branchFrom = null; renderCont(); return; }
  if (t.id === "archToggle") { S.showArch = !S.showArch; renderChatList(); return; }
  if (t.dataset.arch) {
    e.stopPropagation(); const key = t.dataset.arch, to = t.dataset.to === "1";
    try { await api(`/v1/users/${S.uid}/chats/archive`, { body: { key, archived: to } }); toast(to ? L("已归档：在列表底部的「已归档」里能找回", "Archived: find it under “archived” at the bottom of the list") : L("已放回对话列表", "Back in the list"));
      if (to && S.chat === key) { S.chat = null; history.replaceState(null, "", qs()); }
      await loadChats(); renderChat(); } catch (err) { toast(err.message); }
    return;
  }
  if (t.dataset.chat) { S.chat = t.dataset.chat; history.replaceState(null, "", qs()); renderChatList(); renderChat(); loadChat(S.chat); return; }
  if (t.id === "newChat") { S.chat = null; S.imp = null; S.tlSel = null; S.lineView = null; S.tlLine = null; renderTimeline(); S.chatDraft = ""; history.replaceState(null, "", qs()); renderChatList(); renderChat(); $("#chatText")?.focus(); return; }
  if (t.id === "chatSend") { chatSend(); return; }
  if (t.dataset.chrefdel) { S.chatRefs = S.chatRefs.filter((x) => x !== t.dataset.chrefdel); renderChat(); return; }
  if (t.id === "drawerBtn") { S.drawer = !S.drawer; if (!S.drawer) S.op = null; renderDrawer(); renderHead(); return; }
  if (t.id === "drawerClose") { S.drawer = false; S.op = null; renderDrawer(); renderHead(); return; }
  if (t.dataset.mode) { S.mode = t.dataset.mode; store.set("pga_tree_mode", S.mode); renderBar(); drawTree(false); return; }
  if (t.dataset.crefdel) { S.contRefs = S.contRefs.filter((x) => x !== t.dataset.crefdel); renderCont(); return; }
  if (t.dataset.tbud) { const [id, i] = t.dataset.tbud.split("|"); select(id, Number(i)); $("#tnText")?.focus(); return; }
  if (t.dataset.tnode) { select(t.dataset.tnode); return; }
  if (t.dataset.go) { select(t.dataset.go); return; }
  if (t.dataset.goaim) { if (t.dataset.goaim === S.aim) { select(t.dataset.gonode); return; } show("tree", { aim: t.dataset.goaim, node: t.dataset.gonode }); return; }
  if (t.dataset.tab) { if (t.dataset.tab === "turns") { S.drawer = false; renderDrawer(); renderHead(); return; } S.tab = t.dataset.tab; store.set("pga_drawer_tab", S.tab); renderDrawer(); return; }
  if (t.dataset.trnode) { translateTurns(t.dataset.trnode); return; }
  if (t.dataset.bud !== undefined) { S.bud = Number(t.dataset.bud); drawTree(false); renderAll(); renderCont(); $("#tnText")?.focus(); return; }
  if (t.dataset.refadd || t.dataset.unrefnode) {
    const n = nodeOf(S.node), add = $("#refAdd")?.value;
    const refs = t.dataset.unrefnode ? (n.refs || []).filter((x) => x !== t.dataset.unrefnode) : add ? [...(n.refs || []), add] : null;
    if (!refs) { toast(L("选一份知识", "Pick one")); return; }
    try { await api(`/v1/thought-nodes/${n.id}/refs`, { method: "PUT", body: { refs } }); toast(t.dataset.unrefnode ? L("不再参考", "Removed") : L("从这里继续时，agent 会读到它", "Agents will read it when continuing from here")); await refresh(n.id); } catch (err) { toast(err.message); }
    return;
  }
  if (t.dataset.move) { const to = $("#moveTo")?.value; if (!to) { toast(L("选一个节点", "Pick a node")); return; }
    try { await api(`/v1/bodies/${t.dataset.move}/move`, { body: { node_id: to } }); toast(L("已移过去", "Moved")); await refresh(S.node); } catch (err) { toast(err.message); } return; }
  if (t.dataset.op !== undefined) {
    const op = t.dataset.op;
    if (["hide", "merge", "delete", "distill", "markdown"].includes(op)) { quickOp(op); return; }
    if (op === "branchhere") { branchFrom(S.node); return; }
    if (!op) { S.op = null; renderDrawer(); return; }
    openOp(op); return;
  }
  if (t.dataset.do) { doOp(t.dataset.do); return; }
  if (t.dataset.compile) { toast(L("整理中…", "Compiling…")); try { const r = await api(`/v1/bodies/${t.dataset.compile}/compile`, { method: "POST" }); toast(r.status === "compiled" ? L("整理好了", "Done") : r.note || r.status); document.querySelector(".modal")?.remove(); await loadForest(); } catch (err) { toast(err.message); } return; }
  if (t.dataset.doc !== undefined) { showDoc(t.dataset.doc); return; }
  if (t.dataset.ref) { const to = $("#refTo")?.value; if (!to) { toast(L("选一棵树", "Pick a tree")); return; } try { await api(`/v1/aims/${to}/references`, { body: { body_id: t.dataset.ref } }); toast(L("那棵树之后每一轮都会读到它", "That tree will read it every round")); S.forest = null; renderDrawer(); } catch (err) { toast(err.message); } return; }
  if (t.dataset.unref) { try { await api(`/v1/aims/${S.aim}/references/${t.dataset.unref}`, { method: "DELETE" }); toast(L("不再参考", "Removed")); await refresh(); } catch (err) { toast(err.message); } return; }
  if (t.dataset.focus !== undefined) { focusOn(t.dataset.focus); return; }
  if (t.id === "send") { send(); return; }
  if (t.id === "waitBtn") { showWaiting(); return; }
  if (t.id === "setBtn") { showSettings(); return; }
  if (t.id === "saveSettings") { saveSettings(); return; }
  if (t.dataset.closemodal) { document.querySelector(".modal")?.remove(); return; }
  if (t.dataset.answer || t.dataset.drop) {
    const id = t.dataset.answer || t.dataset.drop, text = t.dataset.answer ? (document.querySelector(`textarea[data-q="${CSS.escape(id)}"]`)?.value || "").trim() : "";
    if (t.dataset.answer && !text) { toast(L("先写下你的回答", "Write your answer first")); return; }
    try { await api(`/v1/aims/${S.aim}/perpetual/answer`, { body: t.dataset.answer ? { note_id: id, text } : { note_id: id, drop: true } });
      toast(t.dataset.answer ? L("已回答：之后的每一轮都会读到", "Answered: every later round reads it") : L("已放下这个问题", "Skipped")); await loadTree(true);
      if ((S.proc?.for_you || []).length || S.proc?.checkpoint) showWaiting(); else document.querySelector(".modal")?.remove(); }
    catch (err) { toast(err.message); }
    return;
  }
  if (t.dataset.cp) {
    const cp = S.proc?.checkpoint; if (!cp) return;
    const text = ($("#cpText")?.value || "").trim();
    if (t.dataset.cp === "adjust" && !text) { toast(L("先写下你的意见", "Write your view first")); $("#cpText")?.focus(); return; }
    if (t.dataset.cp === "stop" && !confirm(L("停下：这个抱负会暂停，直到你按开始。", "Stop: this motivation pauses until you press Start."))) return;
    const approve = [...document.querySelectorAll("[data-cpp]")].filter((x) => x.checked).map((x) => x.dataset.cpp);
    const option = Number(document.querySelector('input[name=cpopt]:checked')?.value ?? 0);
    try { await api(`/v1/aims/${S.aim}/perpetual/checkpoint`, { body: { note_id: cp.id, decision: t.dataset.cp, text, option, approve } });
      toast({ continue: L("已同意，继续", "Continuing"), adjust: L("已按你的意见调整", "Adjusted"), stop: L("已停下", "Stopped") }[t.dataset.cp]); document.querySelector(".modal")?.remove(); await loadTree(true); }
    catch (err) { toast(err.message); }
    return;
  }
  if (t.id === "curate") { try { const r = await api(YOU() ? `/v1/users/${S.uid}/tree/curate` : `/v1/aims/${S.aim}/tree/curate`, { method: "POST", body: {} }); toast(L(`开始整理 ${r.pending} 轮对话`, `Placing ${r.pending} turns`)); } catch (err) { toast(err.message); } return; }
  if (t.id === "rewrite") { try { await api(YOU() ? `/v1/users/${S.uid}/tree/rewrite` : `/v1/aims/${S.aim}/tree/rewrite`, { method: "POST" }); toast(L("整理者在后台重写这些概括", "The curator is rewriting them in the background")); } catch (err) { toast(err.message); } return; }
  if (t.id === "runBtn") {
    const T = S.tree, on = T.task?.status === "running"; if (!T.project) return;
    try { await api(`/v1/users/${S.uid}/projects/${T.project.id}/run`, { body: { action: on ? "pause" : "start" } }); toast(on ? L("已暂停", "Paused") : L("开始了", "Started")); await loadTree(true); loadForest().catch(() => {}); }
    catch (err) { toast(err.message); }
  }
});
document.addEventListener("toggle", (e) => { if (e.target.classList?.contains("lcard")) S.lineOpen = e.target.open; }, true);
document.addEventListener("input", (e) => { if (e.target.id === "search") { S.search = e.target.value; renderDialog(); } if (e.target.id === "tnText" || e.target.id === "chatText") autoGrow(e.target); });
document.addEventListener("change", (e) => {
  if (e.target.id === "crefAdd" && e.target.value) { S.contRefs = [...S.contRefs, e.target.value]; renderCont(); return; }
  if (e.target.id === "chrefAdd" && e.target.value) { S.chatRefs = [...S.chatRefs, e.target.value]; renderChat(); return; }
  if (e.target.id === "chatAgent") { S.chatAgent = e.target.value; store.set("pga_chat_agent", S.chatAgent); return; }
  if (e.target.id === "showHidden") { S.showHidden = e.target.checked; drawTree(false); renderDialog(); }
});
document.addEventListener("keydown", (e) => {
  if (e.target.id === "tnText" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); return; }
  if (e.target.id === "chatText" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); S.lineView ? lineSend() : S.imp ? impSend() : chatSend(); return; }
  if (e.key === "Escape") { closeCtx(); document.querySelector(".modal")?.remove(); if (S.drawer) { S.drawer = false; S.op = null; renderDrawer(); renderHead(); } return; }
  if (e.target.closest?.("textarea, input, select") || S.view !== "tree") return;
  const list = S.layout?.list || [], i = list.findIndex((x) => x.id === S.node);
  if (e.key === "ArrowUp" && i < list.length - 1) { e.preventDefault(); select(list[i + 1].id); }
  if (e.key === "ArrowDown" && i > 0) { e.preventDefault(); select(list[i - 1].id); }
});
let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => S.tree && S.view === "tree" && drawTree(false), 150); });
window.addEventListener("pga:theme", () => { if (S.tree && S.view === "tree") drawTree(false); });

