/* PGA app · two things for working with several agents at once.
   分屏: a second conversation beside the first — its own page in a frame (?embed=1), so each side has its own
   conversation, agent and composer, and both can be running at the same time.
   分工: a message with several points is split (pga/dispatch.py) into tasks that can be done at the same time; each
   becomes a branch of this conversation (so its agent sees what came before) and all are asked at once. A board in the
   conversation follows them; when they are done, one click merges their results back here. */

if (Q.get("embed")) document.documentElement.classList.add("embed");

/* ------------------------------------------------ 分屏 */
S.split = null;
function splitOpen(key) {
  const v = $("#vChats"); if (!v) return;
  let p = $("#cpane2");
  if (!p) { v.insertAdjacentHTML("beforeend", `<section class="cpane2" id="cpane2"><div class="p2h"><b>${L("分屏", "Split")}</b><select id="p2pick"></select><span class="grow"></span><button class="sm ghost" data-act="splitclose" title="${L("关掉分屏", "Close the split")}">×</button></div><iframe id="p2frame" title="split"></iframe></section>`); p = $("#cpane2"); }
  S.split = key || "";
  const items = recentItems().filter((x) => x.kind === "chat").slice(0, 60);
  $("#p2pick").innerHTML = `<option value="">${L("＋ 新对话", "+ New chat")}</option>` + items.map((x) => `<option value="${esc(x.item)}" ${x.item === key ? "selected" : ""}>${esc((x.title || "").slice(0, 40))}</option>`).join("");
  const q = new URLSearchParams({ view: "chats", embed: "1" }); if (AS_UID) q.set("as", AS_UID); if (key) q.set("c", key); if (Q.get("lang")) q.set("lang", Q.get("lang"));
  $("#p2frame").src = "/?" + q.toString();
  v.classList.add("split2");
}
function splitClose() { $("#cpane2")?.remove(); $("#vChats")?.classList.remove("split2"); S.split = null; }

/* ------------------------------------------------ 分工 */
S.dispatchOn = (() => { try { return localStorage.getItem("pga_dispatch") !== "0"; } catch { return true; } })();
S.dispatchLive = {};              // task key → running | done | error
S.dispatchPlan = null;            // the tasks proposed for the message you are about to send
const looksMulti = (t) => (t.match(/^\s*(?:\d{1,2}[.、)）]|[-*•·]|[a-zA-Z][.、)）]|[一二三四五六七八九十][、.])\s*\S/gm) || []).length >= 2 || (t.match(/(?:^|[\s：:，,；;。])\d{1,2}[.、)）]\s*\S/g) || []).length >= 2;
const dispatchTool = () => `<button class="ghost ctool ${S.dispatchOn ? "on2" : ""}" data-act="dispatchtoggle" title="${L("分工：一条消息里有好几个点时，拆给几个 agent 同时做", "Share out: a message with several points goes to several agents at once")}">${ICO('<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M12 15.5V12M12 12 7.5 8M12 12l4.5-4"/>')}</button>`;

const _chatSendD = chatSend;
chatSend = async function () {
  if (S.sending || S.regenBusy) return queueFollowup();
  if (composerBusy() || S.dispatchPlan?.busy) return;
  const text = ($("#chatText")?.value || "").trim();
  if (S.chatSplits?.[S.chat]) return _chatSendD();
  if (S.dispatchOn && !S.multi?.length && text && looksMulti(text) && !S.dispatchPlan) {
    S.dispatchPlan = { text, busy: true, tasks: [] }; renderChat();
    try {
      const ctx = (S.chatTurns[S.chat] || []).slice(-6).map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${String(t.text).slice(0, 800)}`).join("\n");
      const r = await api(`/v1/users/${S.uid}/chats/split`, { body: { text, context: ctx } });
      if ((r.tasks || []).length < 2) { S.dispatchPlan = null; renderChat(); $("#chatText").value = text; return _chatSendD(); }
      S.dispatchPlan = { text, tasks: r.tasks.map((t) => ({ ...t, agent: "auto", on: true })) };
    } catch (err) { toast(err.message); S.dispatchPlan = null; renderChat(); $("#chatText").value = text; return _chatSendD(); }
    renderChat(); return;
  }
  return _chatSendD();
};
function planCard() {
  const p = S.dispatchPlan; if (!p) return "";
  if (p.busy) return `<div class="dplan"><span class="spin"></span> ${L("在看这条消息能拆成几件可以同时做的事…", "Seeing how this message splits into things to do at once…")}</div>`;
  const opts = (sel) => `<option value="auto" ${sel === "auto" ? "selected" : ""}>${L("自动", "Auto")}</option>` + S.agents.map((a) => `<option value="${esc(a.name)}" ${a.name === sel ? "selected" : ""}>${esc(agentLabel(a.name))}</option>`).join("");
  const n = p.tasks.filter((t) => t.on).length;
  return `<div class="dplan"><div class="dph"><b>${L(`拆成 ${p.tasks.length} 件事，可以同时做`, `${p.tasks.length} things that can run at once`)}</b><span class="dimt">${L("每件从这段对话分出一支，交给各自的 agent；看得到前面的内容", "each a branch of this conversation, with its own agent; each sees what came before")}</span></div>
    ${p.tasks.map((t, i) => `<div class="dpt"><input type="checkbox" data-dpon="${i}" ${t.on ? "checked" : ""}><input type="text" class="dptt" data-dptitle="${i}" value="${esc(t.title)}"><span class="dpk">${esc(t.kind)}</span><select data-dpagent="${i}">${opts(t.agent)}</select>
      <div class="dptx">${esc(t.text.length > 220 ? t.text.slice(0, 220) + "…" : t.text)}</div></div>`).join("")}
    <div class="row2"><span class="grow"></span><button class="ghost" data-act="dpone">${L("还是交给一个 agent", "Send to one agent instead")}</button><button class="ghost" data-act="dpcancel">${L("取消", "Cancel")}</button>
      <button class="primary" data-act="dpgo" ${n ? "" : "disabled"}>${L(`派给 ${n} 个 agent 同时做`, `Send to ${n} agents at once`)}</button></div></div>`;
}
// Mount the actual dispatched conversations; never create or submit a second task.
function dispatchStage(key, tasks) {
  try {
    const host = window.parent !== window ? window.parent : window;
    if (!host.ST || typeof host.stRender !== "function") return;
    const parent = host.ST.nodes.find((n) => n.type === "win" &&
      host.document.querySelector(`.stnode[data-nid="${n.id}"] iframe`)?.contentWindow === window)
      || host.ST.nodes.find((n) => n.type === "win" && n.key === key);
    if (!parent) return;
    parent.key = key;
    const added = [];
    for (const task of tasks) {
      if (host.ST.nodes.some((n) => n.key === task.key)) continue;
      const n = { id: host.stId(), type: "win", key: task.key, par: parent.id,
        dispatchState: "running", run: true, runAt: Date.now(), title: task.title, agent: task.agent || "auto", side: false, ord: 0,
        from: parent.from || key, ...(parent.ws ? { ws: parent.ws } : {}) };
      host.ST.nodes.push(n);
      parent.kids = [...(parent.kids || []), n.id];
      added.push(n);
    }
    if (!added.length) return;
    parent.sel = added[0].id;
    delete parent.kidsCollapsed;
    for (let n = parent, up; n.par && (up = host.ST.nodes.find((x) => x.id === n.par)); n = up) {
      up.sel = n.id; delete up.kidsCollapsed;
    }
    host.stRender(); host.stSave(); host.stShow(added[0].id);
  } catch (err) { console.warn("Unable to display dispatched task windows", err); }
}
function dispatchWindowRefresh(key, state) {
  try {
    const host = window.parent !== window ? window.parent : window;
    const n = host.ST?.nodes.find((n) => n.key === key);
    if (n && state) {
      n.dispatchState = state; n.run = false; n.completedAt = Date.now(); if (!host.stSeen?.(n)) n.done = n.completedAt;   // finished in front of you: no number
      host.stRender(); host.stSave();
    }
    const frame = n && host.document.querySelector(`.stnode[data-nid="${n.id}"] iframe`);
    const child = frame?.contentWindow;
    if (child?.S?.chat === key) child.loadChat(key)?.catch(() => {});
  } catch {}
}
async function dispatchGo() {
  const p = S.dispatchPlan; if (!p) return;
  const tasks = p.tasks.filter((t) => t.on); if (!tasks.length) return;
  if (!S.chat) S.chat = `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const key = S.chat, acc = S.acc?.[key] || S.acc?.["*new"] || {};
  S.dispatchPlan = null; $("#chatText").value = ""; S.chatDraft = "";
  let note;
  try { note = await api(`/v1/users/${S.uid}/chats/note`, { body: { conversation: key, text: p.text } }); } catch (err) { toast(err.message); return; }
  const hist = [...(S.chatCtx?.[key]?.context || []), ...(S.chatTurns[key] || [])].slice(-12).map((t) => ({ role: t.role === "user" ? "user" : "assistant", text: t.text }));
  hist.push({ role: "user", text: `[the user's own note] ${p.text}` });
  const titles = tasks.map((t, i) => `${i + 1}. ${t.title}`).join("；");
  const entry = { id: Math.random().toString(36).slice(2, 10), text: p.text, tasks: [], run: note.run };
  for (const [i, t] of tasks.entries()) {
    let tk;
    try { tk = (await api(`/v1/users/${S.uid}/chats/branch`, { body: { from: key, upto: note.run, title: t.title } })).key; } catch (err) { toast(err.message); continue; }
    entry.tasks.push({ title: t.title, key: tk, agent: t.agent });
    S.dispatchLive[tk] = "running";
    dispatchStage(key, [entry.tasks[entry.tasks.length - 1]]);
    const text = `${t.text}\n\n${L(`（这是从上面那条消息里拆出来的第 ${i + 1} 项，共 ${tasks.length} 项：${titles}。其余各项另有 agent 在同时处理。只做你这一项；不要改动和这一项无关的地方，也不要撤销别人的改动。）`,
      `(This is item ${i + 1} of ${tasks.length} split from the message above: ${titles}. Other agents are doing the other items at the same time. Do only yours; do not touch what is not part of it, nor undo others' changes.)`)}`;
    api(`/v1/users/${S.uid}/agents/ask`, { body: { text, agent: t.agent || "auto", conversation: tk, history: hist, access: acc.access || "auto", folder: acc.folder || "", mcp: !!acc.mcp } })
      .then((r) => { S.dispatchLive[tk] = r?.error && !r?.text ? "error" : "done"; })
      .catch(() => { S.dispatchLive[tk] = "error"; })
      .finally(() => { dispatchWindowRefresh(tk, S.dispatchLive[tk]); boardRefresh(key); loadTimeline(); });
  }
  try { await api(`/v1/users/${S.uid}/chats/dispatch`, { method: "PUT", body: { key, entry, run: note.run } }); } catch {}
  history.replaceState(null, "", qs()); await loadChat(key); loadTimeline();
  toast(L(`派出去了：${entry.tasks.length} 个 agent 在同时做`, `${entry.tasks.length} agents are on it`));
}

/* the board: each task's branch, its agent, how far it is, what it said */
S.taskTurns = {};
async function boardRefresh(key) {
  const ds = S.chatDispatch?.[key] || []; const keys = ds.flatMap((d) => d.tasks.map((t) => t.key));
  await Promise.all(keys.map(async (k) => { try { const r = await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(k)}`); S.taskTurns[k] = r.turns || []; } catch {} }));
  if (S.chat === key) renderChat();
}
function taskState(k) {
  const ts = S.taskTurns[k] || [], a = ts.filter((t) => t.role === "agent");
  const last = a[a.length - 1];
  if (S.dispatchLive[k] === "running" || (!a.length && S.dispatchLive[k] !== "error")) return { st: "running", last };
  return { st: last?.error && !last?.text ? "error" : "done", last };
}
function boards() {
  const key = S.chat, ds = S.chatDispatch?.[key] || []; if (!ds.length) return "";
  return ds.map((d) => { const states = d.tasks.map((t) => taskState(t.key)), done = states.filter((s) => s.st !== "running").length;
    return `<div class="dboard" data-dboard="${esc(d.id)}"><div class="dph"><b>${L(`分工给 ${d.tasks.length} 个 agent`, `Shared out to ${d.tasks.length} agents`)}</b><span class="dimt">${L(`${done}/${d.tasks.length} 完成`, `${done}/${d.tasks.length} done`)}</span><span class="grow"></span>
      ${done === d.tasks.length && !d.merged ? `<button class="sm primary" data-act="dpmerge" data-did="${esc(d.id)}">${L("把结果汇总回这里", "Merge the results here")}</button>` : d.merged ? `<span class="pill">${L("已汇总", "Merged")}</span>` : ""}</div>
      ${d.tasks.map((t, i) => { const s = states[i], txt = s.last?.text || s.last?.error || "";
        return `<div class="dbt ${s.st}"><span class="dbs">${s.st === "running" ? `<span class="spin"></span>` : s.st === "error" ? "⚠" : "✓"}</span><div class="dbb"><div class="dbh"><b>${esc(t.title)}</b><em>${esc(agentLabel(s.last?.agent || t.agent || "auto"))}</em>
          <span class="grow"></span><button class="sm ghost" data-dpopen="${esc(t.key)}">${L("打开", "Open")}</button><button class="sm ghost" data-dpsplit="${esc(t.key)}">${L("分屏打开", "Open beside")}</button></div>
          ${txt ? `<div class="dbx">${esc(txt.replace(/\s+/g, " ").slice(0, 260))}${txt.length > 260 ? "…" : ""}</div>` : ""}</div></div>`; }).join("")}</div>`; }).join("");
}
async function dispatchMerge(did) {
  const key = S.chat, d = (S.chatDispatch?.[key] || []).find((x) => x.id === did); if (!d) return;
  const parts = d.tasks.map((t, i) => { const s = taskState(t.key); return `## ${i + 1}. ${t.title}（${s.last?.agent || t.agent}）\n${String(s.last?.text || s.last?.error || "").slice(0, 6000)}`; }).join("\n\n");
  $("#chatText").value = L(`下面是刚才拆给几个 agent 同时做的各项结果。请汇总：每一项做了什么、结论是什么、彼此有没有冲突、还需要我决定或做什么。\n\n`, `Here are the results of the items that went to several agents at once. Summarise: what each did, the conclusions, any conflicts between them, and what still needs me.\n\n`) + parts;
  d.merged = "1"; try { await api(`/v1/users/${S.uid}/chats/dispatch`, { method: "PUT", body: { key, entry: d, run: d.run } }); } catch {}
  const was = S.dispatchOn; S.dispatchOn = false; await chatSend(); S.dispatchOn = was;
}

/* hooks into the chat page */
const _loadChatD = loadChat;
loadChat = async function (key) {
  await _loadChatD(key);
  const ds = S.chatDispatch?.[key] || [];
  if (ds.length && !ds.every((d) => d.tasks.every((t) => S.taskTurns[t.key]))) boardRefresh(key);
};
const _rcD = renderChat;
renderChat = function () {
  _rcD();
  if (S.view !== "chats" || S.lineView || S.imp || S.treeItem) return;
  const b = boards(); if (b) $("#cdlgIn")?.insertAdjacentHTML("beforeend", b);
  const pc = planCard(); if (pc) $("#ccomp .inner")?.insertAdjacentHTML("afterbegin", pc);
  const tools = $("#ccomp .cbar"); if (tools && !tools.querySelector('[data-act="dispatchtoggle"]')) tools.querySelector('[data-act="multi"]')?.insertAdjacentHTML("afterend", dispatchTool());
  const head = $("#chead"); if (head && !head.querySelector('[data-act="splitopen"]') && !document.documentElement.classList.contains("embed"))
    head.insertAdjacentHTML("beforeend", `<button class="sm ghost" data-act="splitopen" title="${L("在旁边再开一个对话，可以用另一个 agent", "Open another conversation beside this one, with another agent if you like")}">${L("分屏", "Split")}</button>`);
};
setInterval(() => { const key = S.chat; if (S.view === "chats" && key && (S.chatDispatch?.[key] || []).some((d) => d.tasks.some((t) => taskState(t.key).st === "running"))) boardRefresh(key); }, 6000);

document.addEventListener("click", async (e) => {
  const op = e.target.closest("[data-dpopen]"); if (op) { const k = op.dataset.dpopen; S.lineView = null; S.imp = null; S.treeItem = null; S.chat = k; history.replaceState(null, "", qs()); renderChat(); loadChat(k); return; }
  const sp = e.target.closest("[data-dpsplit]"); if (sp) { splitOpen(sp.dataset.dpsplit); return; }
  const b = e.target.closest("[data-act]"); if (!b) return;
  const a = b.dataset.act;
  if (a === "splitopen") splitOpen("");
  else if (a === "splitclose") splitClose();
  else if (a === "dispatchtoggle") { S.dispatchOn = !S.dispatchOn; try { localStorage.setItem("pga_dispatch", S.dispatchOn ? "1" : "0"); } catch {} renderChat(); toast(S.dispatchOn ? L("分工开：有好几个点的消息会先拆开，问你要不要并行", "Share out on: a message with several points is split first") : L("分工关", "Share out off")); }
  else if (a === "dpgo") dispatchGo();
  else if (a === "dpcancel") { const t = S.dispatchPlan?.text; S.dispatchPlan = null; renderChat(); if (t) $("#chatText").value = t; }
  else if (a === "dpone") { const t = S.dispatchPlan?.text; S.dispatchPlan = null; renderChat(); if (t) { $("#chatText").value = t; const was = S.dispatchOn; S.dispatchOn = false; await chatSend(); S.dispatchOn = was; } }
  else if (a === "dpmerge") dispatchMerge(b.dataset.did);
});
document.addEventListener("change", (e) => {
  const p = S.dispatchPlan; if (!p) return;
  const on = e.target.closest("[data-dpon]"); if (on) { p.tasks[+on.dataset.dpon].on = on.checked; renderChat(); return; }
  const ag = e.target.closest("[data-dpagent]"); if (ag) { p.tasks[+ag.dataset.dpagent].agent = ag.value; return; }
});
document.addEventListener("input", (e) => { const t = e.target.closest?.("[data-dptitle]"); if (t && S.dispatchPlan) S.dispatchPlan.tasks[+t.dataset.dptitle].title = t.value; });
document.addEventListener("change", (e) => { if (e.target.id === "p2pick") splitOpen(e.target.value); });
