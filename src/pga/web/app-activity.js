/* PGA app · the activity panel on the right of a conversation: everything the agents did in it, in one place — what is
   happening right now, the conversation's tree (its turns, versions, branches), each agent call (model, time, tokens),
   usage by agent, the context the next answer reads (window, cache, the level of the world tree, pinned knowledge, your
   instructions, access and folder), and the files, commands, web pages and screen an agent read or touched. Built from
   what the conversation already carries (chats_one: each answer's `how`); nothing extra is fetched. */
const CA_KIND = { read: ["📄", L("读", "read")], search: ["🔍", L("搜", "search")], command: ["⌘", L("命令", "command")], edit: ["✎", L("改", "edit")],
  web: ["🌐", L("网页", "web")], delegate: ["◆", L("子任务", "subtask")], other: ["•", L("其他", "other")] };
const SCREEN = /screenshot|computer|screen|desktop|browser|navigate|click|playwright|chrome/i;
const caK = (n) => kfmt(n || 0);

function renderActivity() {
  const box = $("#cactBody"); if (!box) return;
  if (S.view !== "chats") return;
  const key = S.chat, turns = (key && S.chatTurns[key]) || [], agents = turns.filter((t) => t.role === "agent" && t.run);
  if (S.lineView || S.imp || S.treeItem) {
    box.innerHTML = `<section class="cact-s"><h4>${L("这段对话", "This conversation")}</h4><div class="ca-empty">${S.imp ? L("从其它应用导入的对话：每一步操作在回答上方的「工作过程」里展开。", "Imported from another app: each step is under “how it got there” above its answer.") : L("一条线上有好几段对话：点上面任意一段的标签，接着那段说，这里就显示那段的细节。", "A line holds several conversations: pick one by its label to see its details here.")}</div></section>`;
    return;
  }
  if (!key) { box.innerHTML = `<section class="cact-s"><h4>${L("agent 在做什么", "What the agents do")}</h4><div class="ca-empty">${L("开始一段对话后，这里会显示每一次 agent 调用、用量、上下文和它读写过的文件。", "Once a conversation starts: every agent call, usage, context, and the files it read or wrote.")}</div></section>`; return; }
  let html = "";
  // now
  const lv = S.live?.run;
  if (S.sending || S.regenBusy) {
    const { steps, words } = parseSteps(lv?.text);
    html += `<section class="cact-s ca-live"><h4>${L("正在进行", "Running now")}<span>${liveSecs()}s</span></h4>
      <div class="ca-row"><b>${esc(lv?.agent ? agentLabel(lv.agent) : L("正在分配 agent…", "Picking an agent…"))}</b><em>${esc(lv?.env?.model || "")}</em>
        <small>${steps.length ? esc(`${steps.length} ${L("步", "steps")} · ${steps[steps.length - 1].tool} ${steps[steps.length - 1].target || ""}`) : words ? L("正在写回答", "Writing") : L("在想", "Thinking")}</small></div></section>`;
  }
  // calls
  const tot = { calls: agents.length, secs: 0, in: 0, cached: 0, out: 0 }, by = {};
  for (const t of agents) {
    const h = t.how || {}, u = h.usage || {};
    tot.secs += h.seconds || 0; tot.in += u.input || 0; tot.cached += u.cached || 0; tot.out += u.output || 0;
    const a = t.agent || "?", b = by[a] = by[a] || { calls: 0, in: 0, cached: 0, out: 0, secs: 0, model: t.model || h.model || "" };
    b.calls++; b.in += u.input || 0; b.cached += u.cached || 0; b.out += u.output || 0; b.secs += h.seconds || 0;
  }
  html += `<section class="cact-s"><h4>${L("agent 调用", "Agent calls")}<span>${L(`${tot.calls} 次 · ${Math.round(tot.secs)}s`, `${tot.calls} · ${Math.round(tot.secs)}s`)}</span></h4>
    ${agents.slice(-12).reverse().map((t, i) => { const h = t.how || {}, u = h.usage || {}, n = agents.length - i;
      return `<div class="ca-row" data-ca-turn="${esc(t.run)}"><b>#${n} ${esc(agentLabel(t.agent || "AI"))}</b><em>${h.seconds != null ? h.seconds + "s" : ""}</em>
        <small>${esc([t.model || h.model, u.input ? `${L("读", "in")} ${caK(u.input)}${u.cached ? ` (${Math.round(u.cached / u.input * 100)}% ${L("缓存", "cached")})` : ""}` : "", u.output ? `${L("写", "out")} ${caK(u.output)}` : "", (h.actions || []).length ? `${h.actions.length} ${L("步", "steps")}` : "", t.error ? "⚠ " + t.error : "", h.continued ? L("接着上次的会话", "resumed") : ""].filter(Boolean).join(" · "))}</small></div>`; }).join("")
      || `<div class="ca-empty">${L("还没有回答。", "No answers yet.")}</div>`}
    ${agents.length > 12 ? `<div class="ca-empty">${L(`…还有更早的 ${agents.length - 12} 次`, `… ${agents.length - 12} earlier`)}</div>` : ""}</section>`;
  // usage by agent
  if (Object.keys(by).length) {
    const max = Math.max(...Object.values(by).map((b) => b.in + b.out), 1);
    html += `<section class="cact-s"><h4>${L("用量", "Usage")}<span>${L(`读 ${caK(tot.in)} · 写 ${caK(tot.out)}`, `in ${caK(tot.in)} · out ${caK(tot.out)}`)}${tot.in ? ` · ${Math.round(tot.cached / tot.in * 100)}% ${L("缓存", "cached")}` : ""}</span></h4>
      ${Object.entries(by).map(([a, b]) => `<div class="ca-row"><b>${esc(agentLabel(a))}</b><em>${b.calls}×</em>
        <div style="grid-column:1/-1"><div class="ca-bar"><i style="width:${((b.in + b.out) / max * 100).toFixed(0)}%"></i></div></div>
        <small>${esc([b.model, `${L("读", "in")} ${caK(b.in)}`, b.cached ? `${L("缓存", "cached")} ${caK(b.cached)}` : "", `${L("写", "out")} ${caK(b.out)}`, `${Math.round(b.secs)}s`].filter(Boolean).join(" · "))}</small></div>`).join("")}
      <div style="margin-top:6px"><a href="#" id="usageBtn">${L("所有 agent 的额度与用量 →", "All agents' quota and usage →")}</a></div></section>`;
  }
  // context
  const last = agents[agents.length - 1], lh = last?.how || {}, lu = lh.usage || {}, win = lh.window || 0;
  const w = S.chatWorld?.[key], lvl = w?.talks_to ? (w.path || []).find((x) => x.id === w.talks_to) : null, acc = S.acc?.[key] || S.acc?.["*new"];
  const K = S.forest?.knowledge || [];
  html += `<section class="cact-s"><h4>${L("上下文", "Context")}${win && lu.input ? `<span>${caK(lu.input)} / ${caK(win)}</span>` : ""}</h4>
    ${win && lu.input ? `<div class="ca-bar"><i style="width:${Math.min(100, lu.input / win * 100).toFixed(0)}%"></i></div><div class="ca-bar"><i class="c" style="width:${Math.min(100, (lu.cached || 0) / win * 100).toFixed(0)}%"></i></div>
      <div class="ca-empty">${L(`上一次回答读了 ${caK(lu.input)}（窗口的 ${Math.round(lu.input / win * 100)}%），其中 ${caK(lu.cached || 0)} 来自缓存`, `Last answer read ${caK(lu.input)} (${Math.round(lu.input / win * 100)}% of the window), ${caK(lu.cached || 0)} from cache`)}</div>` : ""}
    <div class="ca-row"><b>${L("层级", "Level")}</b><em>${esc(lvl ? (lvl.kind === "root" ? L("整个世界", "Everything") : lvl.title) : L("只这段对话", "This conversation"))}</em></div>
    <div class="ca-row"><b>${L("历史", "History")}</b><em>${L(`最近 ${Math.min(12, turns.length)} 条`, `last ${Math.min(12, turns.length)}`)}</em></div>
    ${S.chatSys?.[key] ? `<div class="ca-row"><b>${L("你的设定", "Your instructions")}</b><em>${caK(S.chatSys[key].length)} ${L("字", "chars")}</em></div>` : ""}
    ${(S.chatRefs || []).length ? `<div class="ca-row"><b>${L("引用的知识", "Pinned knowledge")}</b><em>${S.chatRefs.length}</em><small>${esc(S.chatRefs.map((id) => K.find((k) => k.id === id)?.title || "").filter(Boolean).join("、"))}</small></div>` : ""}
    ${acc ? `<div class="ca-row"><b>${L("权限", "Access")}</b><em>${esc(acc.access || "read")}</em>${acc.folder ? `<small>📁 ${esc(acc.folder.replace(/^\/Users\/[^/]+/, "~"))}</small>` : ""}</div>` : ""}</section>`;
  // what the agents read and touched
  const files = new Map(), cmds = [], web = [], screen = [];
  for (const t of agents) for (const x of (t.how?.actions || [])) {
    const k = x.kind || "other", target = String(x.target || "");
    if (SCREEN.test(x.tool) || SCREEN.test(target.slice(0, 30))) screen.push(x);
    else if (k === "read" || k === "edit" || k === "search") { const f = files.get(target) || { kinds: new Set(), n: 0 }; f.kinds.add(k); f.n++; files.set(target, f); }
    else if (k === "command") cmds.push(x); else if (k === "web") web.push(x);
  }
  const fl = [...files.entries()].sort((a, b) => b[1].n - a[1].n);
  html += `<section class="cact-s"><h4>${L("文件", "Files")}<span>${fl.length}</span></h4>
    ${fl.slice(0, 30).map(([f, x]) => `<div class="ca-file"><span>${[...x.kinds].map((k) => CA_KIND[k][0]).join("")}</span><code title="${esc(f)}">${esc(f)}</code><em>${x.n > 1 ? x.n + "×" : ""}</em></div>`).join("") || `<div class="ca-empty">${L("没有读写文件。", "No files read or written.")}</div>`}</section>`;
  if (cmds.length) html += `<section class="cact-s"><h4>${L("命令", "Commands")}<span>${cmds.length}</span></h4>${cmds.slice(-15).reverse().map((x) => `<div class="ca-file"><span>⌘</span><code title="${esc(x.target)}">${esc(x.target)}</code></div>`).join("")}</section>`;
  if (web.length) html += `<section class="cact-s"><h4>${L("网页", "Web")}<span>${web.length}</span></h4>${web.slice(-15).reverse().map((x) => `<div class="ca-file"><span>🌐</span><code title="${esc(x.target)}">${esc(x.target)}</code></div>`).join("")}</section>`;
  html += `<section class="cact-s"><h4>${L("桌面与屏幕", "Desktop and screen")}<span>${screen.length}</span></h4>${screen.slice(-15).reverse().map((x) => `<div class="ca-file"><span>🖥</span><code title="${esc(x.target)}">${esc(x.tool)} ${esc(x.target)}</code></div>`).join("") || `<div class="ca-empty">${L("这段对话里 agent 没有看屏幕或操作桌面。", "No screen or desktop use in this conversation.")}</div>`}</section>`;
  box.innerHTML = html;
}
const _rcAct = renderChat;
renderChat = function () { _rcAct(); renderActivity(); };
setInterval(() => { if (S.view === "chats" && (S.sending || S.regenBusy)) renderActivity(); }, 1000);
document.addEventListener("click", (e) => {
  const r = e.target.closest("[data-ca-turn]"); if (!r) return;
  const el = document.getElementById("t-" + r.dataset.caTurn); if (!el) return;
  const w = $("#cdlg"); w.scrollTo({ top: el.getBoundingClientRect().top - w.getBoundingClientRect().top + w.scrollTop - 12, behavior: "smooth" });
});
