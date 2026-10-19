/* PGA app · an agent at work, usage and context. Plain scripts sharing one global scope, loaded in order by app.html. */
/* ------------------------------------------------ like Claude Code: what is happening while it works, and what it cost */
/* an agent's name, with the account it signs in with when you named one (claude · a@x.com) */
const agentLabel = (n) => (S.acctOf?.[n] ? `${n} · ${S.acctOf[n]}` : n);
const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(n || 0));
function usageJs(u) {                       // Claude: input without the cache; Codex: input with it, per turn under "last"
  if (!u) return null; const x = u.last || u.total || u;
  const cached = x.cache_read_input_tokens ?? x.cachedInputTokens ?? x.cached ?? 0, written = x.cache_creation_input_tokens ?? x.cacheWriteInputTokens ?? x.written ?? 0;
  let inp = x.input_tokens ?? x.inputTokens ?? x.input ?? 0; if ("cache_read_input_tokens" in x || "cache_creation_input_tokens" in x) inp += cached + written;
  return { input: inp, cached, output: x.output_tokens ?? x.outputTokens ?? x.output ?? 0, window: u.modelContextWindow };
}
let LIVE = null, TICK = null;
/* what an agent is doing right now, the way Claude Code shows it: each tool call as a step (done ✓, current spinning),
   its to-do list, the words as they stream in, a running clock and token count. `match` is a chat key, or a test on
   the run's conversation tag (a tree branch is only known once it exists). */
function startLive(match) {
  stopLive(); const t0 = Date.now(), test = typeof match === "function" ? match : (c) => c.endsWith(":" + match);
  S.live = { key: typeof match === "string" ? match : null, run: null, t0, seen: 0 };
  const poll = async () => {
    try { const xs = await api(`/v1/agents/live`);
      const mine = xs.filter((r) => test(String(r.tags?.conversation || "")) && r.started * 1000 >= t0 - 3000).pop();
      if (mine && S.live) S.live.run = mine;
    } catch {}
    const box = document.getElementById("workCard"); if (box && S.live) { box.outerHTML = workCard(); const w = box.closest?.(".dlg") || $("#cdlg"); }
  };
  LIVE = setInterval(poll, 600); poll();
  TICK = setInterval(() => { const el = document.querySelector("#workCard .wt"); if (el && S.live) el.textContent = liveSecs() + "s"; }, 200);
}
function stopLive() { if (LIVE) clearInterval(LIVE); if (TICK) clearInterval(TICK); LIVE = TICK = null; S.live = null; }
const liveSecs = () => { const lv = S.live || {}; const t = lv.run ? (lv.run.finished || Date.now() / 1000) - lv.run.started : (Date.now() - (lv.t0 || Date.now())) / 1000; return Math.max(0, t).toFixed(1); };
const TOOLKIND = (tool) => (/^(Read|Glob|LS|NotebookRead)$/.test(tool) ? "read" : /^(Grep|ToolSearch)$/.test(tool) ? "search" : /^(Bash|BashOutput|\$)$/.test(tool) ? "cmd"
  : /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) ? "edit" : /^(WebSearch|WebFetch|（搜索）)$/.test(tool) ? "web" : /^(Task|Agent)$/.test(tool) ? "agent" : /^TodoWrite$/.test(tool) ? "todo" : "other");
const TOOLICON = { read: "📄", search: "🔍", cmd: "⌘", edit: "✎", web: "🌐", agent: "◆", todo: "☑", other: "•" };
function parseSteps(text) {           // the live trace: "→ Tool target", "$ command", "（搜索）query" lines, the rest is words
  const steps = [], words = [];
  for (const l of String(text || "").split("\n")) {
    let m;
    if ((m = l.match(/^→ (\S+)\s*(.*)$/))) steps.push({ tool: m[1], target: m[2] });
    else if ((m = l.match(/^\$ (.*)$/))) steps.push({ tool: "Bash", target: m[1] });
    else if ((m = l.match(/^（搜索）(.*)$/))) steps.push({ tool: "WebSearch", target: m[1] });
    else words.push(l);
  }
  return { steps, words: words.join("\n").trim() };
}
const stepRow = (x, cls) => { const k = TOOLKIND(x.tool); return `<div class="step ${k} ${cls}"><span class="si">${cls.includes("cur") ? `<span class="spin"></span>` : TOOLICON[k]}</span><b>${esc(x.tool)}</b><code>${esc(String(x.target || "").slice(0, 200))}</code>${cls.includes("cur") ? "" : `<span class="ok">✓</span>`}</div>`; };
function workCard() {
  const lv = S.live || {}, r = lv.run, { steps, words } = parseSteps(r?.text);
  const u = usageJs(r?.usage), env = r?.env || {}, todos = r?.todos || [], writing = !!words && steps.length === 0 ? true : !!words;
  const status = !r ? L("正在分配 agent…", "Picking an agent…") : words && (!steps.length || r.text.trimEnd().endsWith(words.slice(-20))) ? L("正在写回答", "Writing") : steps.length ? L("正在用工具", "Using tools") : L("在想", "Thinking");
  const seen = lv.seen || 0; if (S.live) S.live.seen = steps.length;
  const fold = (env.cwd || "").replace(/^\/Users\/[^/]+/, "~");
  return `<div id="workCard" class="work"><div class="wh"><span class="pulse"></span><b>${esc(r?.agent ? agentLabel(r.agent) : "…")}</b>${env.model ? `<span class="wm">${esc(env.model)}</span>` : ""}
      <span class="wst shimmer">${esc(status)}</span><span class="grow"></span><span class="num wt">${liveSecs()}s</span>${u ? `<span class="num dimt">↑${kfmt(u.input)} ↓${kfmt(u.output)}</span>` : ""}
      ${r ? `<button class="sm ghost" data-stoplive="${r.id}">${L("停止", "Stop")}</button>` : ""}</div>
    ${fold || env.permission ? `<div class="wenv">${esc([fold, env.permission, env.tools ? L(`${env.tools} 个工具`, `${env.tools} tools`) : "", (env.mcp || []).length ? "MCP " + env.mcp.join(", ") : ""].filter(Boolean).join(" · "))}</div>` : ""}
    ${todos.length ? `<ul class="todo">${todos.map((t) => `<li class="${t.status}"><span>${t.status === "completed" ? "✓" : t.status === "in_progress" ? `<span class="spin"></span>` : "○"}</span>${esc(t.content)}</li>`).join("")}</ul>` : ""}
    ${steps.length ? `<div class="steps">${steps.length > 12 ? `<div class="dimt more">${L(`…前面还有 ${steps.length - 12} 步`, `… ${steps.length - 12} earlier`)}</div>` : ""}${steps.slice(-12).map((x, i, xs) => { const n = steps.length - xs.length + i;
      return stepRow(x, (n === steps.length - 1 && !words ? "cur" : "") + (n >= seen ? " new" : "")); }).join("")}</div>` : ""}
    ${words ? `<div class="wtext md">${md(words.slice(-1800))}<span class="caret"></span></div>` : ""}</div>`;
}
/* after the answer: the same steps, kept above it (folded when there are many) */
function procBlock(t) {
  const h = t.how || {}, acts = h.actions || []; if (!acts.length) return "";
  return `<details class="proc" ${acts.length <= 5 ? "open" : ""}><summary><span class="ok">✓</span>${L(`工作过程 · ${acts.length} 步`, `Worked · ${acts.length} steps`)}${h.seconds != null ? ` · ${h.seconds}s` : ""}</summary>
    <div class="steps">${acts.map((a) => stepRow({ tool: a.tool, target: a.target }, "")).join("")}</div></details>`;
}
/* under each answer: who, which model, how long, how many tokens (and how many came from the cache), new or continued session, and the steps it took */
function replyMeta(t) {
  const h = t.how || {}, u = h.usage, n = (h.actions || []).length;
  const bits = [t.model || h.model, h.seconds != null ? `${h.seconds}s` : "", u ? L(`读入 ${kfmt(u.input)}${u.input ? `（${Math.round(100 * u.cached / u.input)}% 缓存）` : ""} · 写出 ${kfmt(u.output)}`, `in ${kfmt(u.input)}${u.input ? ` (${Math.round(100 * u.cached / u.input)}% cached)` : ""} · out ${kfmt(u.output)}`) : "",
    h.via === "session" || h.via === "app-server" ? (h.continued ? L("接着上次的会话", "continued session") : L("新会话", "new session")) : ""].filter(Boolean);
  if (!bits.length && !n) return "";
  return bits.length ? `<div class="rmeta">${esc(bits.join(" · "))}</div>` : "";
}
/* above the composer: where the agent works and how full its context is */
function envBar(key, turns) {
  const a = S.acc[key || "*new"] || {}, last = [...(turns || [])].reverse().find((x) => x.role !== "user" && x.how);
  const u = last?.how?.usage, win = last?.how?.window || (String(last?.agent || "").startsWith("claude") ? 200000 : 258400), used = u?.input || 0, pct = Math.min(100, Math.round(100 * used / win));
  const fold = a.folder || L("这段对话自己的文件夹", "this chat's own folder");
  const big = used > 150000 && last?.run ? `<div class="bigctx">⚠ ${L(`这段对话每一轮要重读约 ${kfmt(used)} token（会话太长了），很耗额度。`, `Each turn here rereads about ${kfmt(used)} tokens (the session is long) and eats quota.`)}
    <button class="sm" data-cbranch="${esc(last.run)}" data-ckey="${esc(key)}">${L("压缩后新开一段", "Start fresh from here")}</button></div>` : "";
  return big + `<div class="envbar"><a href="#" data-pickdir="${esc(key)}" title="${esc(a.folder || L("点击选择 agent 工作的文件夹", "Click to pick the folder the agent works in"))}">📁 ${esc(fold.split("/").filter(Boolean).pop() || fold)}</a><span>${a.access ? L(ACC[a.access][0], ACC[a.access][1]) : ""}</span>${a.mcp ? "<span>MCP</span>" : ""}
    ${last ? `<span>${esc(agentLabel(last.agent || ""))}${last.model ? " · " + esc(last.model) : ""}</span>` : ""}<span class="grow"></span>
    <span class="ctxm" title="${L(`上下文：上一轮 agent 读入 ${kfmt(used)}，窗口 ${kfmt(win)}`, `Context: the agent read ${kfmt(used)} last turn, of a ${kfmt(win)} window`)}"><svg width="18" height="18" viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" class="rbg"/><circle cx="18" cy="18" r="14" class="rfg ${pct > 80 ? "hi" : ""}" stroke-dasharray="${(88 * pct / 100).toFixed(1)} 88" transform="rotate(-90 18 18)"/></svg>${pct}%</span>
    <a href="#" id="usageBtn">${L("用量", "Usage")}</a></div>`;
}
async function showUsage() {
  const [rt, c, sp] = await Promise.all([api(`/v1/agents/route?category=general`).catch(() => ({ ranking: [] })), api(`/v1/users/${S.uid}/cache?days=7`).catch(() => null),
    api(`/v1/users/${S.uid}/usage/split?days=3`).catch(() => null)]);
  const rows = Object.entries(sp?.agents || {}).sort((a, b) => (b[1].yours.input + b[1].background.input) - (a[1].yours.input + a[1].background.input));
  modal(`<h2>${L("用量", "Usage")}</h2><div class="muted" style="margin-bottom:12px">${L("每个 agent 还剩多少额度（自动选 agent 时按这个排）。", "How much each agent has left (auto routing goes by this).")}</div>
    ${(rt.ranking || []).map((x) => `<div class="dim" style="grid-template-columns:150px 1fr 120px;cursor:default"><span class="k">${esc(agentLabel(x.agent))}</span><span class="v">${esc(x.quota?.detail || "")}${x.quota?.resets_at ? L(" · 重置于 ", " · resets ") + esc(when(x.quota.resets_at)) : ""}${x.usable ? "" : ` · <span style="color:var(--bad)">${esc(x.why_not || L("不可用", "unavailable"))}</span>`}</span>
      <span class="conf" style="align-self:center"><i style="width:${Math.round((x.remaining ?? 0) * 100)}%"></i></span></div>`).join("")}
    ${sp ? `<div class="label" style="margin-top:18px">${L("最近 3 天 token 花在哪", "Where the tokens went, last 3 days")}</div>
      <table class="utab"><tr><th></th><th>${L("你的对话", "Your chats")}</th><th>${L("PGA 后台（树、知识、研究）", "PGA background (trees, knowledge, research)")}</th></tr>
      ${rows.map(([a, g]) => `<tr><td>${esc(agentLabel(a))}</td><td class="num">${g.yours.calls ? L(`${g.yours.calls} 次 · 读入 ${kfmt(g.yours.input)}`, `${g.yours.calls} · ${kfmt(g.yours.input)} in`) : "—"}</td><td class="num">${g.background.calls ? L(`${g.background.calls} 次 · 读入 ${kfmt(g.background.input)}`, `${g.background.calls} · ${kfmt(g.background.input)} in`) : "—"}</td></tr>`).join("")}</table>
      ${(sp.heavy || []).filter((x) => x.input > 200000).length ? `<div class="label" style="margin-top:14px">${L("最耗额度的对话", "The heaviest conversations")}</div>${sp.heavy.filter((x) => x.input > 200000).map((x) => `<div class="dim" style="grid-template-columns:1fr 160px;cursor:default"><span class="v">${esc(x.title || x.key)} · ${esc(agentLabel(x.agent))}</span><span class="num" style="text-align:right">${L(`${x.calls} 轮 · 读入 ${kfmt(x.input)}`, `${x.calls} turns · ${kfmt(x.input)} in`)}</span></div>`).join("")}
        <div class="dimt" style="font-size:12px;margin-top:4px">${L("续上一段很长的会话时，每一轮都会把整个会话重读一遍。用「压缩后新开一段」可以省很多。", "Resuming a very long session rereads all of it every turn; “Start fresh from here” saves a lot.")}</div>` : ""}
      <div class="label" style="margin-top:16px">${L("PGA 后台用不用你的订阅", "Does PGA's background use your subscriptions")}</div>
      <label class="opt"><input type="checkbox" data-bgset="long" data-to="${sp.long_tasks ? "0" : "1"}" ${sp.long_tasks ? "checked" : ""}><span>${L("后台工作可以交给 agent", "Background work may go to agents")}<div class="d">${L("关掉：整理树、知识库、研究都只用 PGA 自己的模型（DeepSeek），不碰任何订阅。", "Off: trees, knowledge and research use only PGA's own model (DeepSeek), never a subscription.")}</div></span></label>
      <label class="opt"><input type="checkbox" data-bgset="keep" data-to="${(sp.keep_for_me || []).includes("claude_local") ? "0" : "1"}" ${(sp.keep_for_me || []).includes("claude_local") ? "checked" : ""}><span>${L("Claude 的额度只留给我自己", "Keep Claude's quota for me")}<div class="d">${L("后台永远不用 Claude Code（claude、claude-2）。", "Background work never uses Claude Code (claude, claude-2).")}</div></span></label>` : ""}
    ${c?.all?.calls ? `<div class="label" style="margin-top:18px">${L("提示词缓存 · 最近 7 天", "Prompt cache · last 7 days")}</div>${cacheLine(c.all)}` : ""}`);
}

/* the right-hand header: pin the line, put it on another line, archive */
function headActs() {
  const key = S.lineView ? null : S.chat || S.imp?.key, line = S.lineView || (S.tl?.sessions || []).find((x) => x.item === key)?.line;
  if (!key && !line) return "";
  const pinned = (S.tl?.pinned || []).includes(line);
  return `<span class="grow"></span>${line ? `<button class="sm ghost" data-pin="${esc(line)}" data-to="${pinned ? "0" : "1"}">${pinned ? L("取消置顶", "Unpin") : L("置顶", "Pin")}</button>` : ""}
    <button class="sm ghost" data-moveto="${esc(key || "")}" data-line="${esc(line || "")}">${L("放到…", "Move to…")}</button>
    <button class="sm ghost" data-archall="${esc(key || "")}" data-line="${esc(line || "")}">${L("归档", "Archive")}</button>`;
}
async function loadChat(key) {
  if (!key || key.startsWith("new:")) { renderChat(); return; }
  try { const r = await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(key)}`); S.chatTurns[key] = r.turns; S.chatCtx = { ...(S.chatCtx || {}), [key]: r.branch ? r : null }; } catch (e) { toast(e.message); }
  if (S.chat === key || S.lineView) renderChat();
}
async function chatSend() {
  const text = ($("#chatText")?.value || "").trim(); if (!text) { toast(L("先写点什么", "Write something first")); return; }
  if (!S.chat) S.chat = `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const key = S.chat, prev = S.chatTurns[key] || [], ctx = S.chatCtx?.[key]?.context || [];
  const hist = [...ctx, ...prev].slice(-12).map((t) => ({ role: t.role === "user" ? "user" : "assistant", text: t.text }));
  S.chatTurns[key] = [...prev, { role: "user", text, at: new Date().toISOString() }];
  S.sending = true; S.chatDraft = ""; window.history.replaceState(null, "", qs()); startLive(key); renderChat(); $("#chatText").value = "";
  try {
    const r = await api(`/v1/users/${S.uid}/agents/ask`, { body: { text, agent: $("#chatAgent")?.value || "auto", conversation: key, history: hist, refs: S.chatRefs, ...(S.chatModel?.[key] ? { model: S.chatModel[key] } : {}) } });
    if (r?.error && !r?.text) toast(r.error);
  } catch (err) { toast(err.message); }
  finally { S.sending = false; stopLive(); }
  S.scrollChat = true; await loadChats(); await loadChat(key); loadTimeline();
}

