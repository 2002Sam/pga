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
/* every window on the stage watches its own answer, but they share one fetch of what is running: one request per
   half second instead of one per window, so many answers at once don't starve the browser's few connections */
function liveSnap() {
  let h = window; try { if (window.top !== window && window.top.document) h = window.top; } catch {}
  const c = h.__pgaLive || (h.__pgaLive = {}), now = Date.now();
  if (h.WebSocket && !c.socket && now >= (c.retryAt || 0)) {
    const ws = c.socket = new h.WebSocket(`${h.location.protocol === "https:" ? "wss:" : "ws:"}//${h.location.host}/v1/agents/live-stream`);
    ws.onmessage = e => { try { const data = JSON.parse(e.data); if (Array.isArray(data)) { c.data = data; c.received = Date.now(); } } catch {} };
    ws.onerror = () => ws.close();
    ws.onclose = () => { if (c.socket === ws) { c.socket = null; c.received = 0; c.retryAt = Date.now() + 5000; } };
  }
  if (c.received && now - c.received < 15000) return Promise.resolve(c.data);
  // Fallback for older servers/disconnections; never overlap a slow HTTP request.
  if (c.pending || (c.p && now - c.at < 500)) return c.p;
  c.at = now; c.pending = true;
  return (c.p = api(`/v1/agents/live`).catch(e => { c.at = 0; throw e; }).finally(() => { c.pending = false; }));
}
// Keep DOM nodes, selection, details state and scroll containers between updates.
function patchLiveNode(target, fresh) {
  if (target.isEqualNode(fresh)) return;
  if (target.nodeType !== fresh.nodeType || target.nodeName !== fresh.nodeName) { target.replaceWith(fresh); return; }
  if (target.nodeType === 3) { target.data = fresh.data; return; }
  if (target.nodeType !== 1) return;
  for (const a of [...target.attributes]) if (!(target.tagName === "DETAILS" && a.name === "open") && !fresh.hasAttribute(a.name)) target.removeAttribute(a.name);
  for (const a of [...fresh.attributes]) if (!(target.tagName === "DETAILS" && a.name === "open") && target.getAttribute(a.name) !== a.value) target.setAttribute(a.name, a.value);
  const old = [...target.childNodes], next = [...fresh.childNodes];
  for (let i = 0; i < Math.max(old.length, next.length); i++) {
    if (!next[i]) old[i].remove();
    else if (!old[i]) target.appendChild(next[i]);
    else patchLiveNode(old[i], next[i]);
  }
}
/* Cache expensive markdown/tool formatting separately from clocks and status. Each
   lane owns its cache; keeping only this render's entries bounds memory growth. */
function liveFormatCache(state) {
  const previous = state.formatted || new Map(), next = new Map();
  state.formatted = next;
  return (key, value, render) => {
    const old = previous.get(key);
    const entry = old?.value === value ? old : {value, html:render()};
    next.set(key, entry);
    return entry.html;
  };
}
function livePaintFrame(watch) {
  if (typeof requestAnimationFrame !== 'function' || document.hidden) return Promise.resolve();
  if (!watch.frame) watch.frame = new Promise(resolve => requestAnimationFrame(() => { watch.frame = null; resolve(); }));
  return watch.frame;
}
function composerBusy() {
  if (!S.sending && !S.regenBusy && !S.knowledgePreparing) return false;
  toast(S.knowledgePreparing ? L("正在准备上下文，输入已保留，请稍后发送。", "Preparing context. Your draft is kept; send it shortly.") : L("当前回答还在运行，可以继续输入并排队发送。", "The current answer is running. You can keep typing and queue a follow-up."));
  return true;
}
/* Follow-ups wait for the current answer; never overwrite its live watcher or draft. */
function followupKey() { return S.lineView ? S.lineTarget : S.chat; }
function followupStore(key) { return `pga:followups:${S.uid}:${key}`; }
function followups(key = followupKey()) {
  if (!key) return [];
  S.followups ||= {};
  if (!S.followups[key]) {
    try { S.followups[key] = JSON.parse(localStorage.getItem(followupStore(key)) || '[]').map(x => ({...x, paused: true, ...(x.steerState === 'sending' ? {steerState:x.steerRun ? 'uncertain' : undefined} : {})})); }
    catch { S.followups[key] = []; }
  }
  return S.followups[key];
}
function followupSave(key) {
  localStorage.setItem(followupStore(key), JSON.stringify(followups(key)));
}
function followupHtml(key = followupKey()) {
  const xs = followups(key);
  const notice = (S.sending || S.regenBusy) && S.followupDelivered?.[key] ? `<div class="followup-hint" role="status">${L('已插入当前任务：', 'Inserted into current task: ')}${esc(S.followupDelivered[key])}</div>` : '';
  if (!xs.length) return notice + (S.sending || S.regenBusy ? `<div class="followup-hint">${L('可以继续输入 · Enter 排队，当前回答结束后自动发送', 'Keep typing · Enter queues a message to send after this answer')}</div>` : '');
  return notice + `<div class="followups"><div>${L("追加消息 · 自动依次处理，也可插入当前任务", "Follow-ups · queued, or insert into the current task")}</div>${xs.map((x,i) => {
    const active = S.followupActive === x.id, inserting = x.steerState === 'sending';
    const state = active ? L('正在处理', 'Processing') : inserting ? L('正在插入…', 'Inserting…') : x.steerState === 'uncertain' ? L('送达待确认 · 已暂停', 'Delivery unconfirmed · paused') : x.paused ? L('已暂停 · 重试前请检查回答', 'Paused · check answer before retry') : L('等待处理', 'Waiting');
    const unsupported = x.at?.length || S.chatSplits?.[key];
    const insert = !active && (S.sending || S.regenBusy || x.steerRun) ? `<button class="ghost" data-followup-steer="${esc(x.id)}" data-followup-key="${esc(key)}" ${inserting || unsupported ? 'disabled' : ''} title="${L(unsupported ? '附件和双 Agent 消息请继续排队发送' : '将文字补充到当前 Agent，沿用正在执行任务的模型与权限', unsupported ? 'Attachments and split messages remain queued' : 'Send text to the current agent, keeping its model and permissions')}">${x.steerState === 'uncertain' ? L('核实送达', 'Check delivery') : L('插入当前任务', 'Insert now')}</button>` : '';
    return `<div class="followup"><span>${i+1}. ${esc(x.text)}${x.at?.length ? ` · 📎 ${x.at.length}` : ''}</span><small>${state}</small>${insert}<button class="ghost" data-followup-remove="${esc(x.id)}" data-followup-key="${esc(key)}" ${active || inserting ? 'disabled' : ''}>${x.steerState === 'uncertain' ? L('移除记录', 'Dismiss') : L('撤回', 'Withdraw')}</button></div>`;
  }).join('')}${xs.some(x=>x.paused && !x.steerRun && x.id !== S.followupActive) ? `<button class="ghost" data-followup-resume="${esc(key)}">${L("继续处理队列", "Resume queue")}</button>` : ''}</div>`;
}
async function steerFollowup(key, id) {
  const xs = followups(key), item = xs.find(x=>x.id===id);
  if (!item || item.id === S.followupActive || item.steerState === 'sending') return;
  if (item.at?.length || S.chatSplits?.[key]) { toast(L('附件和双 Agent 消息暂时只支持排队发送', 'Attachments and split messages can only be queued')); return; }
  const wasPaused = item.paused;
  item.paused = true; item.steerState = 'sending';
  let requested = false;
  try {
    followupSave(key); renderChat();
    if (!item.steerRun) {
      const runs = await api('/v1/agents/live');
      const matches = runs.filter(r=>r.running && r.tags?.conversation === `${S.uid}:${key}`);
      if (matches.length !== 1 || !matches[0].can_steer) throw Error(L('当前任务已结束或此 Agent 连接不支持插入；消息保留在队列', 'The task ended or this connection cannot accept input; message kept in queue'));
      item.steerRun = matches[0].id;
      item.steerWasPaused = wasPaused;
      followupSave(key); // pin the exact run before sending; never retry against a newer task
    }
    requested = true;
    const result = await api(`/v1/users/${S.uid}/agents/live/${encodeURIComponent(item.steerRun)}/steer`, {body:{conversation:key,message_id:item.id,text:item.text}});
    if (result.status === 'accepted') {
      xs.splice(xs.indexOf(item),1);
      (S.followupDelivered ||= {})[key] = item.text;
      followupSave(key);
      toast(L('已插入正在执行的任务', 'Inserted into the running task'));
    } else if (result.status === 'rejected') {
      item.paused = item.steerWasPaused || !!S.followupBlocked?.[key]; delete item.steerRun; delete item.steerState; delete item.steerWasPaused;
      followupSave(key); toast(result.error);
    } else {
      item.steerState = 'uncertain'; followupSave(key);
      toast(L('送达尚未确认，已暂停这条消息，避免重复发送', 'Delivery unconfirmed; paused to avoid duplicates'));
    }
  } catch (err) {
    if (requested || item.steerRun) item.steerState = 'uncertain';
    else { item.paused = wasPaused || !!S.followupBlocked?.[key]; delete item.steerState; }
    try { followupSave(key); } catch {}
    toast(err.message);
  } finally {
    if (followupKey()===key) renderChat();
    // If the original answer ended during this request, unblock the remaining queue.
    if (!S.sending && !S.regenBusy && !S.followupDraining) drainFollowups(key);
  }
}
function queueFollowup() {
  const key = followupKey(), text = ($('#chatText')?.value || '').trim();
  if (!key || S.knowledgePreparing) { composerBusy(); return; }
  if (!text) return;
  const xs = followups(key);
  const item = {id: Date.now().toString(36)+Math.random().toString(36).slice(2), text,
    agent: $('#chatAgent')?.value || S.chatAgent || 'auto', model: S.chatModel?.[key],
    effort: $('#chatEffort')?.value || S.chatEffort?.[key], at: [...(S.att || [])],
    refs: [...(S.chatRefs || [])], web: !!S.web, splitTarget:S.splitTargets?.[key] || 'both',
    paused: !!(S.live?.key && S.live.key !== key),
    capture: typeof knowledgeEnabled === 'function' && knowledgeEnabled()};
  xs.push(item);
  try { followupSave(key); }
  catch { xs.pop(); toast(L("队列保存失败，草稿和附件已保留。", "Could not save the queue; draft and attachments kept.")); return; }
  S.att = []; S.chatDraft = ''; $('#chatText').value = '';
  renderChat(); $('#chatText')?.focus();
}
async function drainFollowups(key, allow) {
  S.followupBlocked ||= {};
  if (allow !== undefined) S.followupBlocked[key] = !allow;
  const xs = followups(key);
  if (!xs.length) return;
  if (S.followupBlocked[key]) { xs.forEach(x=>x.paused=true); followupSave(key); if (followupKey()===key) renderChat(); return; }
  if (!xs.length || xs[0].paused || S.sending || S.regenBusy || S.followupDraining) return;
  S.followupDraining = true;
  try {
    while (xs.length && !xs[0].paused) {
      const item = xs[0]; let knowledge = null;
      S.sending = true; S.followupActive = item.id;
      if (S.followupDelivered) delete S.followupDelivered[key];
      try {
        // Fetch after the previous answer is saved, so this turn sees its complete result.
        const chat = await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(key)}`);
        const hist = [...(chat.context || []), ...(chat.turns || [])].slice(-12).map(t=>({role:t.role==='user'?'user':'assistant',text:t.text}));
        const agent = item.agent === 'auto' ? ([...(chat.turns || [])].reverse().find(t=>t.agent)?.agent || 'auto') : item.agent;
        if (item.capture && !chat.split) knowledge = await knowledgePrepare(key, item.text, agent);
        const body = {text:item.text,conversation:key,agent,history:hist,refs:item.refs,web:item.web,
          images:item.at.filter(x=>x.type.startsWith('image/')).map(({name,data})=>({name,data})),
          files:item.at.filter(x=>!x.type.startsWith('image/')).map(({name,data})=>({name,data})),
          ...(item.model ? {model:item.model}:{}), ...(item.effort ? {effort:item.effort}:{}),
          ...(knowledge ? {knowledge_id:knowledge.id}:{})};
        // Persist as paused before requesting: a reload must never replay an uncertain request.
        item.paused = true; followupSave(key);
        if (followupKey()===key) { startLive(key); renderChat(); }
        const lanes = chat.split?.lanes.filter(l=>!item.splitTarget || item.splitTarget==='both' || l.key===item.splitTarget);
        if (lanes && followupKey()===key) startLive(c=>lanes.some(l=>c.endsWith(':'+l.key)));
        const results = lanes ? await Promise.all(lanes.map(l=>api(`/v1/users/${S.uid}/agents/ask`, {body:{...body,conversation:l.key,agent:l.agent,history:undefined}}).catch(e=>({error:e.message})))) : [await api(`/v1/users/${S.uid}/agents/ask`, {body})];
        const r = results.find(x=>x.error || x.ok===false || x.stopped) || results[0];
        if (r.error || r.ok === false || r.stopped) throw Error(r.error || L('回答已停止，队列暂停', 'Answer stopped; queue paused'));
        xs.shift(); followupSave(key);
      } catch (err) {
        xs.forEach(x=>x.paused=true); followupSave(key);
        toast(L('追加消息未确认完成，队列已暂停：', 'Follow-up not confirmed; queue paused: ') + err.message);
        break;
      } finally {
        stopLive();
        if (knowledge) knowledgeHost().knowledgeRefresh(knowledge.id);
        await loadChat(key); await loadChats(); loadTimeline();
        S.sending = false; S.followupActive = null;
      }
    }
  } finally { S.sending = false; S.followupActive = null; S.followupDraining = false; if (followupKey()===key) renderChat(); }
}
document.addEventListener('click', async e => {
  const insert = e.target.closest('[data-followup-steer]');
  if (insert) { await steerFollowup(insert.dataset.followupKey, insert.dataset.followupSteer); return; }
  const remove = e.target.closest('[data-followup-remove]'), resume = e.target.closest('[data-followup-resume]');
  if (remove) {
    const key=remove.dataset.followupKey, xs=followups(key), i=xs.findIndex(x=>x.id===remove.dataset.followupRemove);
    if (xs[i]?.steerState === 'sending') return;
    if (i===0 && S.followupDraining) { toast(L('这条消息已开始处理，请使用停止按钮', 'This message is processing; use Stop')); return; }
    if (i>=0) xs.splice(i,1); followupSave(key); renderChat();
  }
  if (resume) {
    if (S.sending || S.regenBusy || S.followupDraining) { toast(L('请等当前回答结束后再恢复', 'Wait for the current answer before resuming')); return; }
    const key=resume.dataset.followupResume;
    try {
      const live = await api('/v1/agents/live');
      if (live.some(r=>r.running && String(r.tags?.conversation || '').endsWith(':'+key))) {
        toast(L('这段对话仍在运行，结束后再恢复队列', 'This conversation is still running; resume after it finishes')); return;
      }
    } catch (err) { toast(err.message); return; }
    (S.followupBlocked ||= {})[key] = false;
    followups(key).forEach(x=>{if (!x.steerRun) x.paused=false;}); followupSave(key); renderChat(); drainFollowups(key);
  }
});
/* what an agent is doing right now, the way Claude Code shows it: each tool call as a step (done ✓, current spinning),
   its to-do list, the words as they stream in, a running clock and token count. `match` is a chat key, or a test on
   the run's conversation tag (a tree branch is only known once it exists). */
function startLive(match, since) {
  stopLive(); const t0 = since || Date.now(), test = typeof match === "function" ? match : (c) => c.endsWith(":" + match);
  const watch = S.live = { key: typeof match === "string" ? match : null, run: null, t0, seen: 0 };
  if (typeof match === "function" && S.chatSplits?.[S.chat]) {
    watch.lanes = Object.fromEntries(S.chatSplits[S.chat].lanes.filter(l => S.splitPending?.[l.key]).map(l =>
      [l.key, {key:l.key, agent:l.agent, t0, seen:0}]));
  }
  let requested = 0, applied = 0;
  const poll = async () => {
    const order = ++requested;
    try { const xs = await liveSnap();
      const matches = xs.filter((r) => test(String(r.tags?.conversation || "")) && r.started * 1000 >= t0 - 3000);
      const mine = watch.key && watch.run ? matches.find((r) => r.id === watch.run.id) : matches.at(-1);
      if (S.live !== watch || order < applied) return; // stale replies must never rewind the display
      applied = order;
      if (mine) watch.run = mine;
      for (const lane of Object.values(watch.lanes || {})) {
        const runs = matches.filter(r => String(r.tags?.conversation || '').endsWith(':' + lane.key));
        const run = lane.run ? runs.find(r => r.id === lane.run.id) : runs.at(-1);
        if (run) lane.run = run;
      }
    } catch {}
    if (S.live !== watch) return;
    await livePaintFrame(watch);
    if (S.live !== watch || order < applied) return;
    /* swap the card only when what it shows changed, and without replaying its entrance, so polling doesn't make it blink */
    const dlg = document.getElementById("cdlg");
    const stick = !dlg || dlg.scrollTop + dlg.clientHeight >= dlg.scrollHeight - 80;
    let painted = false;
    for (const state of (watch.lanes ? Object.values(watch.lanes) : [watch])) {
    const id = watch.lanes ? splitWorkId(state.key) : "workCard";
    const box = document.getElementById(id); if (box && S.live) {
      // Ignore the clock: its own timer updates it without reparsing markdown
      // or replacing tool details while the user is typing or reading.
      const r = state.run;
      const content = JSON.stringify([r?.id, r?.text, r?.steps, r?.todos, r?.env, r?.usage, r?.phase, r?.queue_reason, r?.compaction, r?.running, r?.agent]);
      if (content === state.content && box === state.box) continue;
      state.content = content;
      const html = workCard(state, id).replace('class="work"', 'class="work still"'); if (html === state.html && box === state.box) continue; state.html = html;
      const tx = box.querySelector(".wtext"), top = tx ? tx.scrollTop : 0, atEnd = tx ? tx.scrollTop + tx.clientHeight >= tx.scrollHeight - 4 : true;
      const toolScroll = new Map([...box.querySelectorAll(".tool-live-output")].map(el => [el.dataset.toolout,
        { top: el.scrollTop, follow: el.scrollTop + el.clientHeight >= el.scrollHeight - 8 }]));
      const folds = new Map([...box.querySelectorAll("details[data-procfold]")].map(el => [el.dataset.procfold, el.open]));
      const template = document.createElement("template"); template.innerHTML = html;
      patchLiveNode(box, template.content.firstElementChild); state.box = box;
      box.querySelectorAll("details[data-procfold]").forEach(el => { if (folds.has(el.dataset.procfold)) el.open = folds.get(el.dataset.procfold); });
      box.querySelectorAll(".tool-live-output").forEach(el => { const old = toolScroll.get(el.dataset.toolout); el.scrollTop = !old || old.follow ? el.scrollHeight : old.top; });
      painted = true; const nx = box.querySelector(".wtext"); if (nx) nx.scrollTop = atEnd ? nx.scrollHeight : top;
    }
    }
    if (painted && stick && dlg) dlg.scrollTop = dlg.scrollHeight;
  };
  LIVE = setInterval(poll, 100); poll();
  TICK = setInterval(() => { if (S.live !== watch) return; if (watch.lanes) {
    for (const lane of Object.values(watch.lanes)) {
      const clock = document.getElementById(splitWorkId(lane.key))?.querySelector('.wt');
      if (clock) clock.textContent = liveSecs(lane) + 's';
    }
    return;
  } document.querySelectorAll("#workCard .wt, .ca-live h4 > span").forEach((el) => { el.textContent = liveSecs() + "s"; }); }, 200);
}
function stopLive() { if (LIVE) clearInterval(LIVE); if (TICK) clearInterval(TICK); LIVE = TICK = null; S.live = null; }
const liveSecs = (lv = S.live || {}) => { const t = lv.run ? (lv.run.finished || Date.now() / 1000) - lv.run.started : (Date.now() - (lv.t0 || Date.now())) / 1000; return Math.max(0, t).toFixed(1); };
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
function splitWorkId(key) { return 'splitWork-' + encodeURIComponent(key); }
function splitWorkCard(key) {
  const lv = S.live?.lanes?.[key] || {key, t0:S.live?.t0};
  return workCard(lv, splitWorkId(key));
}
function workCard(lv = S.live || {}, id = "workCard") {
  const r = lv.run, parsed = parseSteps(r?.text), words = parsed.words.replace(/<PGA_KNOWLEDGE\s+id=["'][^"']+["']>[\s\S]*?(?:<\/PGA_KNOWLEDGE>|$)/g, '').trim();
  const rich = (r?.steps || []).length > 0, steps = rich ? r.steps : parsed.steps;
  const u = usageJs(r?.usage), env = r?.env || {}, todos = r?.todos || [], writing = !!words && steps.length === 0 ? true : !!words;
  const status = !r ? L("正在分配 agent…", "Picking an agent…") : r.phase === "queued" ? (r.queue_reason === "conversation" ? L("等待本对话上一条回答完成", "Waiting for this conversation's previous answer") : L("排队中 · 等待空闲名额", "Queued · waiting for capacity")) : r.compaction?.status === "running" ? L("正在压缩上下文", "Compacting context") : words && (!steps.length || r.text.trimEnd().endsWith(words.slice(-20))) ? L("正在写回答", "Writing") : steps.length ? L("正在用工具", "Using tools") : L("在想", "Thinking");
  const seen = lv.seen || 0; lv.seen = steps.length;
  const format = liveFormatCache(lv);
  const renderStep = (x, n) => format('step:' + n,
    JSON.stringify([x, rich, r?.id, r?.running, n >= seen, n === steps.length - 1 && !words]), () => rich
    ? howStep({ ...x, secs: x.secs ?? null }, { live: r.id }, (x.t === "tool" && x.secs == null && r.running !== false ? "cur" : "") + (n >= seen ? " new" : ""))
    : stepRow(x, (n === steps.length - 1 && !words ? "cur" : "") + (n >= seen ? " new" : "")));
  const earlier = steps.length > 5 ? steps.length - 3 : 0;
  const fold = (env.cwd || "").replace(/^\/Users\/[^/]+/, "~");
  return `<div id="${esc(id)}" class="work"><div class="wh"><span class="pulse"></span><b>${esc(r?.agent ? agentLabel(r.agent) : lv.agent ? agentLabel(lv.agent) : "…")}</b>${env.model ? `<span class="wm">${esc(env.model)}</span>` : ""}
      <span class="wst shimmer">${esc(status)}</span><span class="grow"></span><span class="num wt">${liveSecs(lv)}s</span>${u ? `<span class="num dimt">↑${kfmt(u.input)} ↓${kfmt(u.output)}</span>` : ""}
      ${r ? `<button class="sm ghost" data-stoplive="${r.id}">${L("停止", "Stop")}</button>` : ""}</div>
    ${fold || env.permission ? `<div class="wenv">${esc([fold, env.permission, env.tools ? L(`${env.tools} 个工具`, `${env.tools} tools`) : "", (env.mcp || []).length ? "MCP " + env.mcp.join(", ") : ""].filter(Boolean).join(" · "))}</div>` : ""}
    ${todos.length ? `<ul class="todo">${todos.map((t) => `<li class="${t.status}"><span>${t.status === "completed" ? "✓" : t.status === "in_progress" ? `<span class="spin"></span>` : "○"}</span>${esc(t.content)}</li>`).join("")}</ul>` : ""}
    ${steps.length ? `<div class="steps">${earlier ? `<details class="proc" data-procfold="earlier"><summary>${L(`前面的过程 · ${earlier} 步 · 点击展开`, `Earlier progress · ${earlier} steps · expand`)}</summary>${steps.slice(0, earlier).map(renderStep).join("")}</details>` : ""}${steps.slice(earlier).map((x, i) => renderStep(x, earlier + i)).join("")}</div>` : ""}
    ${generatedPictures(steps, {live: r?.id})}${words ? `<div class="wtext md">${format("words", words, () => md(words))}<span class="caret"></span></div>` : ""}</div>`;
}
/* after the answer: the same steps, kept above it (folded when there are many) */
/* ------------------------------------------------ how an answer got there, like Claude Code: every step, read from its session */
const dur = (s) => (s == null ? "" : s < 60 ? `${(+s).toFixed(s < 10 ? 1 : 0)}s` : s < 3600 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`);
/* where a step's record is: {kind, session} for a kept session (claude | codex | hermes), {live} while it runs; a step of a
   run that was put together from several sessions says its own ("kind:session") */
const srcOf = (st, src) => { if (st && typeof st.src === "string") { const i = st.src.indexOf(":"); return { kind: st.src.slice(0, i), session: st.src.slice(i + 1) }; } return src || {}; };
const imgUrl = (src, ref) => (src.live ? `/v1/agents/live/${src.live}/image/${ref}` : `/v1/users/${S.uid}/transcripts/${encodeURIComponent(src.session)}/image?ref=${ref}&kind=${src.kind || "claude"}`);
const thumbs = (src, refs) => ((refs || []).length ? `<div class="thumbs">${refs.map((r) => `<img loading="lazy" src="${imgUrl(src, r)}" data-zoom="${esc(imgUrl(src, r))}" alt="">`).join("")}</div>` : "");
function generatedPictures(steps, src) {
  const urls = new Set();
  for (const st of steps || []) {
    // Calls are sometimes wrapped in exec; its title contains the image-generation call.
    // Keep browser screenshots and images read for reference in the work log.
    if (st.error || !/image[_-]?gen|generatedImage|generate[_-]?image|text2im/i.test([st.tool, st.server, st.title].join(" "))) continue;
    const sx = srcOf(st, src);
    if (!sx.live && !sx.session) continue;
    for (const ref of st.images || []) urls.add(imgUrl(sx, ref));
  }
  if (!urls.size) return "";
  return `<div class="generated-pictures" aria-label="${L("生成的图片", "Generated images")}">${[...urls].map(url => `<a href="${esc(url)}" data-zoom="${esc(url)}" title="${L("点击查看大图", "View full image")}"><img class="pga-output-image" src="${esc(url)}" alt="${L("生成的图片", "Generated image")}" loading="lazy" decoding="async"></a>`).join("")}</div>`;
}
/* code shown the way the page shows code (highlighted, with copy): a fence longer than any run of backticks inside */
const fenced = (lang, code) => { const n = Math.max(3, ...(String(code).match(/`+/g) || []).map((x) => x.length + 1)); return md(`${"`".repeat(n)}${lang || ""}\n${code}\n${"`".repeat(n)}`); };
function howStep(st, src, cls = "") {
  if (st.t === "note") {
    const text = String(st.text || ""), body = `<div class="snote md">${md(text)}</div>`;
    return text.length > 500 || text.split("\n").length > 8
      ? `<details class="proc" data-procfold="note:${esc(text.slice(0, 100))}"><summary>${L("过程说明 · 点击展开", "Progress note · expand")} · ${esc(text.trim().split("\n")[0].slice(0, 80))}</summary>${body}</details>` : body;
  }
  if (st.t === "think") return `<details class="sthink"><summary>💭 ${esc(st.text.split("\n")[0].slice(0, 110))}${st.text.length > 110 ? "…" : ""}</summary><div class="md">${md(st.text)}</div></details>`;
  const k = TOOLKIND(st.tool), sx = srcOf(st, src), open = sx.session && st.ref, cur = cls.includes("cur");
  return `<div class="hstep">
    <div class="step ${k} ${cls} ${open ? "can" : ""}" ${open ? `data-step="${esc(st.ref)}" data-out="${esc(st.out || "")}" data-sess="${esc(sx.session)}" data-kind="${esc(sx.kind || "claude")}"` : ""} title="${esc(st.server ? st.server + " · " + st.tool : st.tool)}">
      <span class="si">${cur ? `<span class="spin"></span>` : TOOLICON[k]}</span><b>${esc(st.tool)}</b><code>${esc(st.title || "")}</code>
      ${st.diff ? `<span class="dstat"><i>+${st.diff[0]}</i> <s>−${st.diff[1]}</s></span>` : ""}
      ${st.secs != null ? `<span class="num dimt">${dur(st.secs)}</span>` : ""}${cur ? "" : st.error ? `<span class="bad">✗</span>` : `<span class="ok">✓</span>`}</div>
    ${st.output ? `<pre class="tool-live-output" data-toolout="${esc(st.id || '')}" style="max-height:240px;overflow:auto;white-space:pre-wrap">${esc(st.output)}</pre>` : ""}${thumbs(sx, st.images)}</div>`;
}
function howBlock(h, src, open = false) {
  const xs = h.steps || [], tools = xs.filter((x) => x.t === "tool").length; if (!xs.length) return "";
  const bad = xs.filter((x) => x.error).length, pics = xs.reduce((n, x) => n + (x.images || []).length, 0);
  return `<details class="proc how" ${open ? "open" : ""}><summary><span class="ok">✓</span>${L(`工作过程 · ${tools} 步`, `Worked · ${tools} steps`)}${h.seconds != null ? ` · ${dur(h.seconds)}` : ""}${pics ? ` · 🖼 ${pics}` : ""}${bad ? ` · <span class="bad">${L(`${bad} 步出错`, `${bad} failed`)}</span>` : ""}</summary>
    <div class="steps">${xs.map((x) => howStep(x, src)).join("")}</div></details>${generatedPictures(xs, src)}`;
}
/* under an answer: model · time · calls · tokens in (how much from the cache) and out */
function howMeta(h) {
  const u = h.usage, bits = [h.model, h.seconds != null ? dur(h.seconds) : "", u?.calls ? L(`${u.calls} 次调用`, `${u.calls} calls`) : "",
    u ? L(`读入 ${kfmt(u.input)}${u.input ? `（${Math.round((100 * u.cached) / u.input)}% 缓存）` : ""} · 写出 ${kfmt(u.output)}`, `in ${kfmt(u.input)}${u.input ? ` (${Math.round((100 * u.cached) / u.input)}% cached)` : ""} · out ${kfmt(u.output)}`) : "",
    u?.context ? L(`上下文 ${kfmt(u.context)}`, `context ${kfmt(u.context)}`) : ""].filter(Boolean);
  return bits.length ? `<div class="rmeta">${esc(bits.join(" · "))}</div>` : "";
}
/* a step in full (its input and what came back) opens under it; a screenshot opens large */
document.addEventListener("click", async (e) => {
  const z = e.target.closest("[data-zoom]"); if (z) { e.preventDefault(); modal(`<img class="zoomimg" src="${esc(z.dataset.zoom)}" alt="">`); return; }
  const s = e.target.closest("[data-step]"); if (!s) return;
  const box = s.parentElement, had = box.querySelector(".sdetail"); if (had) { had.remove(); return; }
  const d = document.createElement("div"); d.className = "sdetail"; d.textContent = "…"; box.appendChild(d);
  try {
    const kind = s.dataset.kind || "claude";
    const r = await api(`/v1/users/${S.uid}/transcripts/${encodeURIComponent(s.dataset.sess)}/step?ref=${s.dataset.step}${s.dataset.out ? `&out=${s.dataset.out}` : ""}&kind=${kind}`);
    const v = r.view || {}, what = v.kind === "diff" ? L("改动", "Changes") : v.path ? L("写入", "Wrote") : L("输入", "Input");
    d.innerHTML = `<div class="label">${what}${v.path ? ` · <code>${esc(String(v.path).replace(/^\/Users\/[^/]+/, "~"))}</code>` : ""}</div>${fenced(v.kind === "diff" ? "diff" : v.lang, v.code || "")}`
      + (r.output || !r.images.length ? `<div class="label">${r.error ? L("出错", "Error") : L("输出", "Output")}</div>${r.output && r.output_lang && !r.error ? fenced(r.output_lang, r.output)
        : `<pre class="${r.error ? "bad" : ""}">${esc(r.output || L("（没有输出）", "(no output)"))}${r.cut ? "\n…" : ""}</pre>`}` : "")
      + thumbs({ session: s.dataset.sess, kind }, r.images);
  } catch (err) { d.textContent = err.message; }
});
function procBlock(t) {
  const h = t.how || {}; if ((h.steps || []).length) return howBlock(h, h.src || {});
  const acts = h.actions || []; if (!acts.length) return "";
  return `<details class="proc" ${acts.length <= 5 ? "open" : ""}><summary><span class="ok">✓</span>${L(`工作过程 · ${acts.length} 步`, `Worked · ${acts.length} steps`)}${h.seconds != null ? ` · ${h.seconds}s` : ""}</summary>
    <div class="steps">${acts.map((a) => stepRow({ tool: a.tool, target: a.target }, "")).join("")}</div></details>`;
}
/* under each answer: who, which model, how long, how many tokens (and how many came from the cache), new or continued session, and the steps it took */
function replyMeta(t) {
  const h = t.how || {}, u = h.usage, n = (h.actions || []).length;
  const bits = [t.model || h.model, h.seconds != null ? `${h.seconds}s` : "", u ? L(`读入 ${kfmt(u.input)}${u.input ? `（${Math.round(100 * u.cached / u.input)}% 缓存）` : ""} · 写出 ${kfmt(u.output)}`, `in ${kfmt(u.input)}${u.input ? ` (${Math.round(100 * u.cached / u.input)}% cached)` : ""} · out ${kfmt(u.output)}`) : "",
    h.compaction?.status === "completed" ? L("本轮已压缩上下文", "Context compacted this turn") : "",
    h.via === "session" || h.via === "app-server" ? (h.continued ? L("接着上次的会话", "continued session") : L("新会话", "new session")) : ""].filter(Boolean);
  if (!bits.length && !n) return "";
  return bits.length ? `<div class="rmeta">${esc(bits.join(" · "))}</div>` : "";
}
/* above the composer: where the agent works and how full its context is */
function envBar(key, turns) {
  const a = S.acc[key || "*new"] || {}, last = [...(turns || [])].reverse().find((x) => x.role !== "user" && x.how);
  // Aggregate input across tool calls is not the size of a single context.
  const u = last?.how?.usage, win = last?.how?.window, used = u?.context;
  const known = Number.isFinite(used) && used > 0, hasWindow = Number.isFinite(win) && win > 0;
  const pct = known && hasWindow ? Math.min(100, Math.round(100 * used / win)) : null;
  const fold = a.folder || a.resolved_folder || L("目录待确认", "Folder pending");
  // This is a historical measurement, not a live overflow or compaction failure.
  return `<div class="envbar"><a href="#" data-pickdir="${esc(key)}" title="${esc(a.folder || a.resolved_folder || L("点击选择 agent 工作的文件夹", "Click to pick the folder the agent works in"))}">📁 ${esc(fold.split("/").filter(Boolean).pop() || fold)}</a>${a.access ? `<a href="#" class="envacc ${a.access}" data-accedit="${esc(key)}" title="${esc(L("点击修改这段对话的权限：", "Click to change this conversation's permissions: ") + L(ACC[a.access][2], ACC[a.access][3]))}">${L(ACC[a.access][0], ACC[a.access][1])}</a>` : ""}${a.mcp ? "<span>MCP</span>" : ""}
    <span class="grow"></span>
    <span class="ctxm" title="${known ? L(`最近一次输入上下文约 ${kfmt(used)} token`, `Last measured input context: ${kfmt(used)} tokens`) : L("暂无单次上下文数据；累计输入量不代表上下文长度", "Context unknown; aggregate input is not context size")}"><svg width="18" height="18" viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" class="rbg"/><circle cx="18" cy="18" r="14" class="rfg ${pct > 80 ? "hi" : ""}" stroke-dasharray="${(88 * pct / 100).toFixed(1)} 88" transform="rotate(-90 18 18)"/></svg>${pct != null ? pct + "%" : known ? kfmt(used) : L("上下文未知", "Context unknown")}</span>
    <button class="ghost" data-chat-memo="${esc(key)}" title="打开关联备忘录" aria-label="打开关联备忘录">📝</button>
    </div>`;
}
/* Shared across the stage's frames: one request per minute, not one per conversation. */
function modelUsageCache() {
  let host = window;
  try { if (window.parent.location.origin === window.location.origin) host = window.parent; } catch {}
  const all = host.pgaModelUsageCache || (host.pgaModelUsageCache = {});
  return all[S.uid] || (all[S.uid] = { at: 0 });
}
function inlineUsageText(cache, agent, model) {
  if (!cache.data) return L("模型用量 · ", "Model usage · ") + (cache.error ? L("暂时无法读取", "unavailable") : L("读取中…", "loading…"));
  const sp = cache.data, quota = cache.ranking?.find(x => x.agent === agent)?.quota;
  const rows = (sp.models || []).filter(m => (!agent || agent === "auto" || m.agent === agent) && (!model || m.model === model));
  let text = rows.map(m => {
    const a = m.yours, b = m.background;
    return `${m.model === "unknown" ? L("未记录模型", "Model unrecorded") : m.model} · ${L("7天", "7d")} ↓${kfmt((a.input || 0) + (b.input || 0))} ↑${kfmt((a.output || 0) + (b.output || 0))}`;
  }).join("　 /　 ");
  if (!text) text = `${model || (agent && agent !== "auto" ? agentLabel(agent) : L("模型用量", "Model usage"))} · ${Array.isArray(sp.models) ? L("7天内暂无记录", "No records in 7d") : L("统计待后端重启", "Stats pending backend restart")}`;
  if (quota) text += `　· ${quota.source === "observed" ? L("额度估算：", "Quota estimate: ") : L("账户额度：", "Account quota: ")}${quota.detail || L("未知", "unknown")}`;
  if (cache.error) text += L(" · 更新失败，显示上次记录", " · update failed, showing previous data");
  return text;
}
function paintInlineUsage() {
  const cache = modelUsageCache();
  document.querySelectorAll("[data-inline-usage]").forEach(el => {
    const text = inlineUsageText(cache, el.dataset.agent, el.dataset.model), prefix=el.dataset.model+' · ';
    el.textContent = el.dataset.omitModel && text.startsWith(prefix) ? text.slice(prefix.length) : text;
  });
}
async function refreshInlineUsage() {
  if (!S.uid || document.hidden || !document.querySelector("[data-inline-usage]")) return;
  const cache = modelUsageCache();
  if (!cache.pending && Date.now() - cache.at > 60000) {
    cache.at = Date.now();
    cache.pending = Promise.all([
      api(`/v1/users/${S.uid}/usage/split?days=7`),
      api(`/v1/agents/route?category=general`).catch(() => ({ranking: []}))
    ]).then(([data, rt]) => { cache.data = data; cache.ranking = rt.ranking; cache.error = false; })
      .catch(() => { cache.error = true; }).finally(() => { cache.pending = null; });
  }
  if (cache.pending) await cache.pending;
  paintInlineUsage();
}
function inlineModelUsage(key, last) {
  const agent = S.chatAgent || "auto";
  const model = S.chatModel?.[key] || S.agentOpts?.[agent]?.default_model || "";
  last = last || [...(S.chatTurns?.[key] || [])].reverse().find(t => t.role === "agent");
  const shownAgent = agent === "auto" ? last?.agent || "auto" : agent;
  const shownModel = agent === "auto" ? last?.model || "" : model;
  setTimeout(refreshInlineUsage, 0);
  return `<span class="model-usage-inline" data-inline-usage data-agent="${esc(shownAgent)}" data-model="${esc(shownModel)}" title="${L("PGA 最近7天已完成运行的累计 token：↓输入（包含缓存），↑输出。每分钟更新；账户额度可能由多个模型共享。", "PGA completed runs over 7 days: ↓input (including cache), ↑output. Updated every minute; account quota may be shared across models.")}">${esc(inlineUsageText(modelUsageCache(), shownAgent, shownModel))}</span>`;
}
setInterval(refreshInlineUsage, 15000);
let usageDays = 7;
function modelUsageTable(sp) {
  if (!sp) return `<div class="muted">${L("用量读取失败，请刷新重试。", "Usage unavailable. Please refresh.")}</div>`;
  if (!Array.isArray(sp.models)) return `<div class="muted">${L("模型统计需要重启 PGA 后端后生效。", "Restart the PGA backend to enable model totals.")}</div>`;
  return `<div style="overflow-x:auto"><table class="utab"><tr><th>${L("模型 / agent", "Model / agent")}</th><th>${L("次数", "Runs")}</th><th>${L("输入", "Input")}</th><th>${L("其中缓存读取", "Cached input")}</th><th>${L("输出", "Output")}</th></tr>${sp.models.map(m => {
    const a = m.yours, b = m.background;
    return `<tr><td>${esc(m.model === "unknown" ? L("未记录模型", "Model unrecorded") : m.model)}<div class="muted">${esc(agentLabel(m.agent))}</div></td><td class="num" title="${L(`对话 ${a.calls} · 后台 ${b.calls}`, `Chats ${a.calls} · background ${b.calls}`)}">${a.calls + b.calls}</td>${["input", "cached", "output"].map(k => `<td class="num">${kfmt((a[k] || 0) + (b[k] || 0))}</td>`).join("")}</tr>`;
  }).join("") || `<tr><td colspan="5">${L("所选时间内还没有已记录的模型用量", "No recorded model usage in this period")}</td></tr>`}</table></div>`;
}
async function showUsage(days = usageDays) {
  usageDays = [1, 3, 7, 30].includes(Number(days)) ? Number(days) : 7;
  const requestedDays = usageDays;
  const [rt, c, sp] = await Promise.all([api(`/v1/agents/route?category=general`).catch(() => ({ ranking: [] })), api(`/v1/users/${S.uid}/cache?days=7`).catch(() => null),
    api(`/v1/users/${S.uid}/usage/split?days=${requestedDays}`).catch(() => null)]), rated = await api(`/v1/users/${S.uid}/ratings`).catch(() => ({}));
  if (requestedDays !== usageDays) return;
  const rows = Object.entries(sp?.agents || {}).sort((a, b) => (b[1].yours.input + b[1].background.input) - (a[1].yours.input + a[1].background.input));
  modal(`<h2>${L("模型用量", "Model usage")}</h2>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">${[1, 7, 30].map(d => `<button class="sm ${d === usageDays ? "on" : "ghost"}" data-usage-days="${d}">${L(`最近 ${d} 天`, `Last ${d} days`)}</button>`).join("")}<button class="sm ghost" data-usage-days="${usageDays}">${L("刷新", "Refresh")}</button></div>
    ${modelUsageTable(sp)}
    <div class="muted" style="font-size:12px;margin:8px 0 18px">${L("仅统计 PGA 已记录的运行，完成后更新；包含对话和后台工作，不含其他应用。输入包含缓存，不等于费用或上下文长度。历史记录缺少模型名时单独列出。", "Recorded PGA runs only, updated on completion; includes chats and background work, excludes other apps. Input includes cache, not cost or context size. Missing model names are listed separately.")}${sp?.updated_at ? " · " + esc(when(sp.updated_at)) : ""}</div>
    <div class="label">${L("账户额度 · 同一账户的模型可能共用", "Account quota · may be shared across models")}</div><div class="muted" style="margin-bottom:12px">${L("供应商返回的额度与 PGA 本地估算分开标注；未返回不代表无限。", "Provider quota and PGA estimates are labelled separately; unavailable does not mean unlimited.")}</div>
    ${(rt.ranking || []).map((x) => `<div class="dim" style="grid-template-columns:150px 1fr 120px;cursor:default"><span class="k">${esc(agentLabel(x.agent))}</span><span class="v">${esc(x.quota?.source === "observed" ? L("PGA 本地估算 · ", "PGA estimate · ") : "")}${esc(x.quota?.detail || L("额度未知", "Quota unknown"))}${x.quota?.resets_at ? L(" · 重置于 ", " · resets ") + esc(when(x.quota.resets_at)) : ""}${x.usable ? "" : ` · <span style="color:var(--bad)">${esc(x.why_not || L("不可用", "unavailable"))}</span>`}</span>
      ${x.quota?.remaining != null && x.quota?.source !== "observed" && x.quota?.source !== "deepseek_balance" ? `<span title="${L("剩余额度", "Remaining quota")}">${Math.round(x.quota.remaining * 100)}% ${L("剩余", "left")}</span>` : `<span class="muted">${x.quota?.source === "observed" ? L("估算", "Estimate") : "—"}</span>`}</div>`).join("")}
    ${sp ? `<div class="label" style="margin-top:18px">${L(`最近 ${usageDays} 天 token 花在哪`, `Where the tokens went, last ${usageDays} days`)}</div>
      <table class="utab"><tr><th></th><th>${L("你的对话", "Your chats")}</th><th>${L("PGA 后台（树、知识、研究）", "PGA background (trees, knowledge, research)")}</th></tr>
      ${rows.map(([a, g]) => `<tr><td>${esc(agentLabel(a))}</td><td class="num">${g.yours.calls ? L(`${g.yours.calls} 次 · 读入 ${kfmt(g.yours.input)}`, `${g.yours.calls} · ${kfmt(g.yours.input)} in`) : "—"}</td><td class="num">${g.background.calls ? L(`${g.background.calls} 次 · 读入 ${kfmt(g.background.input)}`, `${g.background.calls} · ${kfmt(g.background.input)} in`) : "—"}</td></tr>`).join("")}</table>
      ${(sp.heavy || []).filter((x) => x.input > 200000).length ? `<div class="label" style="margin-top:14px">${L("最耗额度的对话", "The heaviest conversations")}</div>${sp.heavy.filter((x) => x.input > 200000).map((x) => `<div class="dim" style="grid-template-columns:1fr 160px;cursor:default"><span class="v">${esc(x.title || x.key)} · ${esc(agentLabel(x.agent))}</span><span class="num" style="text-align:right">${L(`${x.calls} 轮 · 读入 ${kfmt(x.input)}`, `${x.calls} turns · ${kfmt(x.input)} in`)}</span></div>`).join("")}
        <div class="dimt" style="font-size:12px;margin-top:4px">${L("读入量会累计一轮中的多次调用，并包含缓存读取，不等于单次上下文长度或实际费用。", "Input totals include multiple calls and cached reads; they are not a context measurement or actual cost.")}</div>` : ""}
      <div class="label" style="margin-top:16px">${L("PGA 后台用不用你的订阅", "Does PGA's background use your subscriptions")}</div>
      <label class="opt"><input type="checkbox" data-bgset="long" data-to="${sp.long_tasks ? "0" : "1"}" ${sp.long_tasks ? "checked" : ""}><span>${L("后台工作可以交给 agent", "Background work may go to agents")}<div class="d">${L("关掉：整理树、知识库、研究都只用 PGA 自己的模型（DeepSeek），不碰任何订阅。", "Off: trees, knowledge and research use only PGA's own model (DeepSeek), never a subscription.")}</div></span></label>
      <label class="opt"><input type="checkbox" data-bgset="keep" data-to="${(sp.keep_for_me || []).includes("claude_local") ? "0" : "1"}" ${(sp.keep_for_me || []).includes("claude_local") ? "checked" : ""}><span>${L("Claude 的额度只留给我自己", "Keep Claude's quota for me")}<div class="d">${L("后台永远不用 Claude Code（claude、claude-2）。", "Background work never uses Claude Code (claude, claude-2).")}</div></span></label>` : ""}
    ${Object.keys(rated).length ? `<div class="label" style="margin-top:18px">${L("你的评价 · 自动选 agent 时会算进去", "Your ratings · auto routing counts them")}</div>
      <table class="utab"><tr><th>${L("哪类问题", "Kind")}</th><th>${L("agent · 👍 / 👎", "agent · 👍 / 👎")}</th></tr>${Object.entries(rated).map(([cat, xs]) => `<tr><td>${esc(cat)}</td><td>${Object.entries(xs).map(([a, [g, b]]) => `${esc(agentLabel(a))} ${g}/${b}`).join(" · ")}</td></tr>`).join("")}</table>` : ""}
    ${c?.all?.calls ? `<div class="label" style="margin-top:18px">${L("提示词缓存 · 最近 7 天", "Prompt cache · last 7 days")}</div>${cacheLine(c.all)}` : ""}`);
}

/* the right-hand header: pin the line, put it on another line, archive */
function headActs() {
  const key = S.lineView ? null : S.chat || S.imp?.key, line = S.lineView || (S.tl?.sessions || []).find((x) => x.item === key)?.line;
  if (!key && !line) return "";
  const pinned = (S.tl?.pinned || []).includes(line);
  return `<span class="grow"></span>${line ? `<button class="sm ghost" data-pin="${esc(line)}" data-to="${pinned ? "0" : "1"}">${pinned ? L("取消置顶", "Unpin") : L("置顶", "Pin")}</button>` : ""}
    <button class="sm ghost" data-moveto="${esc(key || "")}" data-line="${esc(line || "")}">${L("放到…", "Move to…")}</button>
    ${key && !S.lineView ? `<button class="sm ghost" data-act="rename" data-key="${esc(key)}">${L("重命名", "Rename")}</button>${S.chat === key && (S.chatTurns[key] || []).some((t) => t.run) ? `<button class="sm ghost" data-act="copychat" data-key="${esc(key)}" title="${L("复制整段对话：在副本里接着聊，原来那段不动", "Copy the whole conversation: carry on in the copy, the original stays")}">⧉ ${L("复制", "Copy")}</button>` : ""}<button class="sm ghost ${S.chatSys?.[key] ? "on" : ""}" data-act="sysp" data-key="${esc(key)}" title="${L("给这段对话的设定：每个 agent 都会读到", "Instructions for this conversation: every agent reads them")}">${L("设定", "Instructions")}</button>` : ""}
    <span class="expm"><button class="sm ghost" data-act="export">${L("导出", "Export")} ▾</button><span class="expmenu" hidden><button data-act="exportmd">Markdown</button><button data-act="exportjson">JSON</button></span></span>
    <button class="sm ghost" data-archall="${esc(key || "")}" data-line="${esc(line || "")}">${L("归档", "Archive")}</button>`;
}
async function loadChat(key) {
  if (!key || key.startsWith("new:")) { renderChat(); return; }
  try { const r = await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(key)}`); if (r.options) S.chatLoadedChoices = {...(S.chatLoadedChoices || {}), [key]: r.options};
    if (r.options && !S.loadedBranchOptions?.[key] && !(typeof chatChoiceRead === "function" && chatChoiceRead(key))) {
      S.loadedBranchOptions = { ...(S.loadedBranchOptions || {}), [key]: true };
      S.chatModel = { ...(S.chatModel || {}), [key]: r.options.model || "" };
      S.chatEffort = { ...(S.chatEffort || {}), [key]: r.options.effort || "" };
      if (key === S.chat && r.options.agent) S.chatAgent = r.options.agent;
    }
    S.chatSplits ||= {}; S.chatSplits[key] = r.split || null;
    if (r.split) {
      await Promise.all(r.split.lanes.map(async lane => {
        const d = await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(lane.key)}`);
        S.chatTurns[lane.key] = d.turns;
      }));
    }
    S.chatTurns[key] = r.turns; S.chatCtx = { ...(S.chatCtx || {}), [key]: r.branch ? r : null }; S.chatSys = { ...(S.chatSys || {}), [key]: r.system || "" }; S.chatMulti = { ...(S.chatMulti || {}), [key]: r.multi || [] }; if (key === S.chat) S.multi = [...(r.multi || [])]; S.chatKids = { ...(S.chatKids || {}), [key]: r.children || [] }; S.chatMerges = { ...(S.chatMerges || {}), [key]: r.merges || null }; S.chatWorld = { ...(S.chatWorld || {}), [key]: r.world || null }; S.chatDispatch = { ...(S.chatDispatch || {}), [key]: r.dispatch || [] }; } catch (e) { toast(e.message); }
  if (S.chat === key || S.lineView) renderChat();
}
async function chatSend() {
  if (S.sending || S.regenBusy) return queueFollowup();
  if (composerBusy()) return;
  const text = ($("#chatText")?.value || "").trim(); if (!text) { toast(L("先写点什么", "Write something first")); return; }
  if (S.chatSplits?.[S.chat]) return splitSend();
  const capture = typeof knowledgeEnabled === "function" && knowledgeEnabled();
  if (!capture && S.multi?.length > 1 && typeof multiSend === "function") return multiSend();
  if (!S.chat) {
    const choice = typeof chatChoiceRead === "function" ? chatChoiceRead("") : null;
    S.chat = `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (choice) { S.chatAgent = choice.agent; S.chatModel = {...(S.chatModel || {}), [S.chat]: choice.model}; S.chatEffort = {...(S.chatEffort || {}), [S.chat]: choice.effort}; chatChoiceSave(S.chat); }
  }
  if (capture) knowledgeSet(true, S.chat);
  const key = S.chat, prev = S.chatTurns[key] || [], ctx = S.chatCtx?.[key]?.context || [];
  const hist = [...ctx, ...prev].slice(-12).map((t) => ({ role: t.role === "user" ? "user" : "assistant", text: t.text }));
  const agent = $("#chatAgent")?.value || "auto";
  let knowledge = null;
  if (capture) {
    S.knowledgePreparing = true;
    try { knowledge = await knowledgePrepare(key, text, agent); }
    catch (err) { toast(err.message); return; }
    finally { S.knowledgePreparing = false; }
  }
  const at = takeAtts(), natt = at.images.length + at.files.length;
  S.chatTurns[key] = [...prev, { role: "user", text: natt ? `${text}\n\n📎 ${L(`${natt} 个附件`, `${natt} attachment(s)`)}` : text, at: new Date().toISOString() }];
  S.sentHist = [...S.sentHist.filter((x) => x !== text), text].slice(-50);
  if (S.followupDelivered) delete S.followupDelivered[key];
  S.sending = true; S.chatDraft = ""; window.history.replaceState(null, "", qs()); startLive(key); renderChat(); $("#chatText").value = "";
  let continueQueue = false;
  try {
    const r = await api(`/v1/users/${S.uid}/agents/ask`, { body: { text, agent, ...(knowledge ? {knowledge_id: knowledge.id} : {}), conversation: key, history: hist, refs: S.chatRefs, images: at.images, files: at.files, web: !!S.web, ...(S.chatModel?.[key] ? { model: S.chatModel[key] } : {}), ...($("#chatEffort")?.value ? { effort: $("#chatEffort").value } : {}) } });
    continueQueue = !r?.error && r?.ok !== false && !r?.stopped;
    if (r?.error && !r?.text) toast(r.error);
  } catch (err) { toast(err.message); }
  finally { stopLive(); if (knowledge) knowledgeHost().knowledgeRefresh(knowledge.id); }
  S.scrollChat = true; await loadChats(); await loadChat(key); loadTimeline();
  S.sending = false;
  await drainFollowups(key, continueQueue);
  if (followupKey() === key) renderChat();
}


/* A run of this conversation that this page did not start — the category manager sends tasks from its own page, or
   another window sent it — is followed here like one of its own: its question, the live work card, the answer when
   it ends. Messages typed meanwhile queue as usual. */
setInterval(async () => {
  const key = S.chat;
  if (S.view !== "chats" || !key || S.lineView || S.imp || S.treeItem) return;
  if (S.sending && S.remoteRun !== key) return;
  let xs; try { xs = await liveSnap(); } catch { return; }
  const tag = `${S.uid}:${key}`, run = xs.find((r) => r.tags?.conversation === tag && !r.finished);
  if (S.remoteRun === key) {
    if (run) return;
    S.remoteRun = null; stopLive(); S.sending = false;
    try { delete window.top.__pgaPendingAsk?.[key]; } catch {}
    S.scrollChat = true; await loadChat(key);
    if (typeof drainFollowups === "function") drainFollowups(key, true);
    return;
  }
  if (!run || S.sending || S.remoteRun) return;
  S.remoteRun = key; S.sending = true;
  let asked = ""; try { asked = window.top.__pgaPendingAsk?.[key] || ""; } catch {}
  const turns = S.chatTurns[key] || [];
  if (asked && turns[turns.length - 1]?.text !== asked) S.chatTurns[key] = [...turns, { role: "user", text: asked, at: new Date((run.started || Date.now() / 1000) * 1000).toISOString() }];
  startLive(key, (run.started || Date.now() / 1000) * 1000); S.scrollChat = true; renderChat();
}, 1500);
