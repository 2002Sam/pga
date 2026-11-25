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
// A lost HTTP response must not keep a finished native run in the composer forever.
async function liveRequest(path, opts = {}) {
  if (path.endsWith('/agents/ask') && opts.body) {
    const p=opts.body, o=S.agentOpts?.[p.agent];
    window.mrRemember?.({agent:p.agent,model:p.model||o?.default_model||'',effort:p.effort||o?.default_effort||''});
  }
  const watch = S.live;
  if (!watch) return api(path, opts);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let release;
  const ended = new Promise(resolve => { release = watch.release = () => {
    resolve({ok:false, stopped:true, error:L('任务已结束，已重新同步对话；追加队列已暂停', 'Task ended; conversation refreshed and follow-ups paused')});
    controller?.abort();
  }; });
  try { return await Promise.race([api(path, {...opts, ...(controller ? {signal:controller.signal} : {})}), ended]); }
  finally { if (watch.release === release) delete watch.release; }
}
async function recoverLive(watch) {
  if (S.live !== watch || watch.recovering || !watch.run) return;
  // The display tolerates a small clock skew and can briefly pick up the
  // previous turn. That turn is not proof that this new request has ended.
  if (watch.run.started && watch.run.started * 1000 < watch.t0) return;
  watch.recovering = true;
  try {
    // Confirm through HTTP, not the shared stream cache (which may have disconnected).
    const rows = await api('/v1/agents/live');
    if (S.live !== watch) return;
    const tag = watch.run.tags?.conversation;
    if (rows.some(r => !r.finished && (r.id === watch.run.id || (tag && r.tags?.conversation === tag)))) return;
    if (watch.release) watch.release();
    else if (watch.key) {
      const key = watch.key;
      stopLive(); S.sending = false; S.remoteRun = null;
      await drainFollowups(key, false); await loadChat(key);
    }
  } catch (err) { toast(err.message); }
  finally { watch.recovering = false; }
}
async function requestLiveStop(lid) {
  const watch = S.live;
  try {
    const result = await api(`/v1/agents/live/${encodeURIComponent(lid)}/stop`, {method:'POST'});
    if (result?.running === false && watch?.run?.id === lid) await recoverLive(watch);
    else toast(L('正在停止，已输出的内容会保留', 'Stopping; existing output is kept'));
  } catch (err) {
    // Older servers return 409 for an already finished or expired run.
    if (watch?.run?.id === lid) await recoverLive(watch);
    toast(err.message);
  }
}
/* every window on the stage watches its own answer, but they share one fetch of what is running: one request per
   half second instead of one per window, so many answers at once don't starve the browser's few connections */
function liveSnap() {
  let h = window; try { if (window.top !== window && window.top.document) h = window.top; } catch {}
  // The shared request and its callbacks must outlive a reloaded/suspended chat frame.
  // A promise created by that frame can otherwise remain pending in the stage cache forever.
  if (h !== window && typeof h.liveSnap === 'function') return h.liveSnap();
  const c = h.__pgaLive || (h.__pgaLive = {}), now = Date.now();
  if (h.WebSocket && !c.socket && now >= (c.retryAt || 0)) {
    const ws = c.socket = new h.WebSocket(`${h.location.protocol === "https:" ? "wss:" : "ws:"}//${h.location.host}/v1/agents/live-stream?delta=1`);
    let initialized = false;
    ws.onmessage = e => { try {
      if (c.socket !== ws) return;
      const data = JSON.parse(e.data);
      if (Array.isArray(data)) { c.data = data; initialized = true; }
      else if (initialized && data?.type === 'live_delta' && Array.isArray(data.runs) && Array.isArray(data.removed) && Array.isArray(c.data)) {
        const rows = new Map(c.data.map(r => [r.id, r]));
        for (const id of data.removed) rows.delete(id);
        for (const row of data.runs) rows.set(row.id, row);
        c.data = [...rows.values()].sort((a,b) => a.started - b.started);
      } else return;
      c.received = Date.now();
    } catch {} };
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
  if (!xs.length) return "";
  return `<div class="followups"><div>${L("追加消息 · 自动依次处理，也可插入当前任务", "Follow-ups · queued, or insert into the current task")}</div>${xs.map((x,i) => {
    const active = S.followupActive === x.id, inserting = x.steerState === 'sending';
    const state = active ? L('正在处理', 'Processing') : inserting ? L('正在插入…', 'Inserting…') : x.steerState === 'uncertain' ? L('送达待确认 · 已暂停', 'Delivery unconfirmed · paused') : x.paused ? L('已暂停 · 重试前请检查回答', 'Paused · check answer before retry') : L('等待处理', 'Waiting');
    const unsupported = x.at?.length || S.chatSplits?.[key];
    const insert = !active && (S.sending || S.regenBusy || x.steerRun) ? `<button class="ghost" data-followup-steer="${esc(x.id)}" data-followup-key="${esc(key)}" ${inserting || unsupported ? 'disabled' : ''} title="${L(unsupported ? '附件和双 Agent 消息请继续排队发送' : '将文字补充到当前 Agent，沿用正在执行任务的模型与权限', unsupported ? 'Attachments and split messages remain queued' : 'Send text to the current agent, keeping its model and permissions')}">${x.steerState === 'uncertain' ? L('核实送达', 'Check delivery') : L('插入当前任务', 'Insert now')}</button>` : '';
    return `<div class="followup"><span>${i+1}. ${esc(x.text)}${x.at?.length ? ` · 📎 ${x.at.length}` : ''}</span><small>${state}</small>${insert}<button class="ghost" data-followup-remove="${esc(x.id)}" data-followup-key="${esc(key)}" ${active || inserting ? 'disabled' : ''}>${x.steerState === 'uncertain' ? L('移除记录', 'Dismiss') : L('撤回', 'Withdraw')}</button></div>`;
  }).join('')}${xs.some(x=>x.paused && !x.steerRun && x.id !== S.followupActive) ? `<button class="ghost" data-followup-resume="${esc(key)}">${L("继续处理队列", "Resume queue")}</button>` : ''}</div>`;
}
// Attach accepted steering to its question, before the work card and answer.
function steeringQuestion(key) {
  const turns = S.chatTurns[key] || [];
  return (S.regenBusy && turns.find(t => t.role === 'user' && t.run === S.regenBusy)) || turns.findLast(t => t.role === 'user');
}
function attachSteering(question, inputs, snapshot = false) {
  if (!question) return false;
  const marker = '\n\n[运行中补充]\n', stored = String(question.text || '').split(marker).slice(1);
  const seenText = new Map(); let changed = false;
  question.steeringIds ||= [];
  for (const input of inputs || []) {
    const n = (seenText.get(input.text) || 0) + 1; seenText.set(input.text, n);
    if (question.steeringIds.includes(input.id)) continue;
    question.steeringIds.push(input.id);
    // History already includes accepted inputs after reload. Do not duplicate them.
    if (snapshot && stored.filter(text => text === input.text).length >= n) continue;
    question.text += marker + input.text; changed = true;
  }
  return changed;
}
async function steerFollowup(key, id) {
  const xs = followups(key), item = xs.find(x=>x.id===id);
  if (!item || item.id === S.followupActive || item.steerState === 'sending') return;
  if (item.at?.length || S.chatSplits?.[key]) { toast(L('附件和双 Agent 消息暂时只支持排队发送', 'Attachments and split messages can only be queued')); return; }
  const turns = S.chatTurns[key] || [];
  const question = item.steerQuestion
    ? turns.find(t => t.role === 'user' && (item.steerQuestion.run ? t.run === item.steerQuestion.run : t.at === item.steerQuestion.at))
    : steeringQuestion(key);
  if (!item.steerRun && question) item.steerQuestion = {run:question.run, at:question.at};
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
      attachSteering(question, [{id:item.id, text:item.text}]);
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
function queueFollowup(insertNow = false) {
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
  if (insertNow && !item.paused && !item.at.length && !S.chatSplits?.[key]) return steerFollowup(key, item.id);
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
        const results = lanes ? await Promise.all(lanes.map(l=>api(`/v1/users/${S.uid}/agents/ask`, {body:{...body,conversation:l.key,agent:l.agent,history:undefined}}).catch(e=>({error:e.message})))) : [await (S.live?.key === key ? liveRequest : api)(`/v1/users/${S.uid}/agents/ask`, {body})];
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
/* One activity line while an agent works, with its trace, plan and usage available on demand.
   `match` is a chat key, or a test on
   the run's conversation tag (a tree branch is only known once it exists). */
function startLive(match, since, selection = {}) {
  stopLive(); const t0 = since || Date.now(), test = typeof match === "function" ? match : (c) => c.endsWith(":" + match);
  const watch = S.live = { ...selection, key: typeof match === "string" ? match : null, run: null, t0, seen: 0 };
  if (typeof match === "function" && S.chatSplits?.[S.chat]) {
    watch.lanes = Object.fromEntries(S.chatSplits[S.chat].lanes.filter(l => S.splitPending?.[l.key]).map(l =>
      [l.key, {key:l.key, agent:l.agent, effort:l.effort, t0, seen:0}]));
  } else if (typeof match === "function" && S.multiWork?.key === S.chat) {
    watch.lanes = Object.fromEntries(S.multiWork.lanes.map(l =>
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
      // A retry/failover in the same conversation has a new live id.
      const active = watch.key && matches.find(r => !r.finished && r.phase !== 'queued');
      if (active && (!mine || mine.finished)) watch.run = active;
      if (watch.key && watch.run?.started * 1000 >= watch.t0 && attachSteering(steeringQuestion(watch.key), watch.run.steering, true)) {
        if (followupKey() === watch.key) {
          if (document.hidden || S.stageDormant || S.stageMotion) watch.renderChatPending = true;
          else renderChat();
        }
      }
      if (watch.key && watch.run && !matches.some(r => !r.finished)) {
        watch.endedAt ||= Date.now();
        if (Date.now() - watch.endedAt >= 5000) void recoverLive(watch);
      } else watch.endedAt = null;
      for (const lane of Object.values(watch.lanes || {})) {
        const runs = matches.filter(r => String(r.tags?.conversation || '').endsWith(':' + lane.key));
        const run = lane.run ? runs.find(r => r.id === lane.run.id) : runs.at(-1);
        if (run) lane.run = run;
      }
    } catch {}
    if (S.live !== watch) return;
    // Continue receiving and recording live state while the stage is hidden or
    // moving; defer only DOM work. The next idle poll paints the newest snapshot.
    if (document.hidden || S.stageDormant || S.stageMotion) return;
    if (watch.renderChatPending && followupKey() === watch.key) {
      watch.renderChatPending = false;
      renderChat();
    }
    await livePaintFrame(watch);
    if (S.live !== watch || order < applied || document.hidden || S.stageDormant || S.stageMotion) return;
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
      const content = liveContentVersion(r);
      if (content === state.content && box === state.box) continue;
      state.content = content;
      painted = paintLiveCard(state, id, box) || painted;
    }
    }
    if (painted && stick && dlg) dlg.scrollTop = dlg.scrollHeight;
  };
  LIVE = setInterval(poll, 100); poll();
  TICK = setInterval(() => { if (S.live !== watch || document.hidden || S.stageDormant || S.stageMotion) return; if (watch.lanes) {
    for (const lane of Object.values(watch.lanes)) {
      const clock = document.getElementById(splitWorkId(lane.key))?.querySelector('.wt');
      if (clock) clock.textContent = liveSecs(lane) + 's';
      paintWorkEta(lane, splitWorkId(lane.key));
    }
    return;
  } document.querySelectorAll("#workCard .wt, .ca-live h4 > span").forEach((el) => { el.textContent = liveSecs() + "s"; }); paintWorkEta(watch, 'workCard'); }, 200);
}
function stopLive() { if (LIVE) clearInterval(LIVE); if (TICK) clearInterval(TICK); LIVE = TICK = null; S.live = null; }
const liveSecs = (lv = S.live || {}) => { const t = lv.run ? (lv.run.finished || Date.now() / 1000) - lv.run.started : (Date.now() - (lv.t0 || Date.now())) / 1000; return Math.max(0, t).toFixed(1); };
const TOOLKIND = (tool) => {
  const name = String(tool || "").split(/__|[.]/).at(-1);
  return /^(Read|Glob|LS|NotebookRead|read_file|list_directory)$/.test(name) ? "read"
    : /^(Grep|ToolSearch|search_files|file_search)$/.test(name) ? "search"
    : /^(Bash|BashOutput|exec_command|write_stdin|shell|terminal|commandExecution|\$)$/.test(name) ? "cmd"
    : /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|patch|write_file|edit_file|fileChange)$/.test(name) ? "edit"
    : /^(WebSearch|WebFetch|web_search|web_fetch|browse|（搜索）)$/.test(name) ? "web"
    : /^(Task|Agent|spawn_agent|send_message|wait_agent)$/.test(name) ? "agent"
    : /^(TodoWrite|update_plan)$/.test(name) ? "todo" : "other";
};
// Arguments, code and output belong in the disclosure, never in the activity label.
function workStepKind(step) {
  const kind = TOOLKIND(step?.tool);
  if (kind !== 'other') return kind;
  if (/(?:^|[._])exec$/.test(step?.tool || '')) {
    const call = String(step.title || step.target || '').match(/\b(?:apply_patch|write_file|edit_file|exec_command|write_stdin|read_file|search_files)\s*\(/);
    if (call) return TOOLKIND(call[0].replace(/\s*\($/, ''));
  }
  return 'other';
}
function workStatus(r, steps, words, rich) {
  if (!r) return L('正在准备…', 'Getting ready…');
  if (r.finished) return r.stopping ? L('已停止', 'Stopped') : r.ok === false ? L('运行失败', 'Failed') : L('已完成', 'Completed');
  if (r.stopping) return L('正在停止…', 'Stopping…');
  if (r.phase === 'queued') return r.queue_reason === 'conversation' ? L('等待上一条回答完成', 'Waiting for the previous answer') : L('正在排队', 'Queued');
  if (r.compaction?.status === 'running') return L('正在整理上下文', 'Compacting context');
  const active = rich ? steps.findLast(x => x.t === 'tool' && x.secs == null && !x.error) : null;
  const writing = words && (!steps.length || String(r.text || '').trimEnd().endsWith(words.slice(-20)));
  const step = active || (!writing ? steps.findLast(x => x.tool) : null);
  if (step) {
    if (step.error) return L('操作出错 · 查看详情', 'Action failed · view details');
    if (rich && !active && step.secs != null) {
      // Use user-facing progress only; never expose tool arguments or reasoning.
      const note = steps.findLast(x => x.t === 'note' && x.text)?.text;
      const task = (r.todos || []).find(x => x.status === 'in_progress')?.content;
      const brief = String(task || note || '').replace(/```[\s\S]*?(?:```|$)/g, '')
        .replace(/<[^>]*>/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/[*#`]/g, '').replace(/\s+/g, ' ').trim();
      const recent = ({edit:L('刚完成代码修改', 'Code changes completed'), cmd:L('命令已结束，正在处理结果', 'Command finished, reviewing results'),
        read:L('已读取文件，正在分析', 'Files read, analyzing'), search:L('已查找资料，正在整理', 'Search complete, reviewing'),
        web:L('网页搜索完成，正在整理', 'Web search complete, reviewing'), agent:L('子任务已返回', 'Subtask returned'),
        todo:L('已更新计划', 'Plan updated')})[workStepKind(step)];
      const detail = brief ? brief.slice(0, 60) + (brief.length > 60 ? '…' : '') : recent;
      return L('正在继续处理', 'Continuing') + (detail ? ' · ' + detail : '');
    }
    return ({edit:L('正在写代码', 'Writing code'), cmd:L('正在运行命令', 'Running a command'),
      read:L('正在读取文件', 'Reading files'), search:L('正在查找资料', 'Searching'), web:L('正在搜索网页', 'Searching the web'),
      agent:L('正在处理子任务', 'Working on a subtask'), todo:L('正在更新计划', 'Updating the plan'), other:L('正在使用工具', 'Using a tool')})[workStepKind(step)];
  }
  return writing ? L('正在写回答', 'Writing a response') : L('正在思考', 'Thinking');
}
const TOOLICON = { read: "📄", search: "🔍", cmd: "⌘", edit: "✎", web: "🌐", agent: "◆", todo: "☑", other: "•" };
// A compact tail of observed actions stays visible while the full trace is folded.
function workActionTrail(steps, run) {
  const tools = steps.filter(x => x.tool && (!x.t || x.t === 'tool'));
  if (!tools.length) return '';
  const visible = tools.slice(-3);
  const running = x => x.t === 'tool' && x.secs == null && !x.error && !run?.finished && !run?.stopping && run?.running !== false;
  const active = tools.findLast(running);
  if (active && !visible.includes(active)) visible[0] = active;
  const labels = {read:L('读取', 'Read'), edit:L('编辑', 'Edit'), cmd:L('运行命令', 'Run command'),
    search:L('搜索文件', 'Search files'), web:L('网页检索', 'Web lookup'), agent:L('子任务', 'Subtask'),
    todo:L('更新计划', 'Update plan'), other:L('调用工具', 'Tool call')};
  const rows = visible.map(step => {
    const kind = workStepKind(step);
    const tool = String(step.tool).split(/__|[.]/).at(-1);
    const target = String(step.title || step.target || '');
    let name = '';
    // Only these tools use a filename as their title. Shell input and patch bodies stay in details.
    if (/^(?:Read|NotebookRead|Edit|Write|MultiEdit|NotebookEdit|read_file|write_file|edit_file)$/.test(tool)
        && !/[\r\n]/.test(target)) name = target.split(/[/\\]/).at(-1);
    const label = kind === 'cmd' && /^(?:(?:python3? -m )?pytest|node --test|npm (?:run )?test|cargo test|go test)(?:\s|$)/.test(target)
      ? L('运行测试', 'Run tests') : labels[kind];
    const [state, status, mark] = step.error ? ['failed', L('失败', 'Failed'), '×']
      : step.secs != null ? ['done', L('完成', 'Done'), '✓']
      : running(step) ? ['active', L('进行中', 'In progress'), '●'] : ['recorded', L('已记录', 'Recorded'), '·'];
    return `<li class="action-${state}"><span class="action-mark" aria-hidden="true">${mark}</span><span class="action-label">${esc(label)}</span>${name ? `<code>${esc(name)}</code>` : ''}<small>${status}</small></li>`;
  });
  return `<ul class="work-actions" aria-label="${L('最近操作', 'Recent actions')}">${rows.join('')}</ul>`;
}
function workCodeSummary(r) {
  const measured = r?.code_progress;
  const completed = (r?.steps || []).filter(x => x.secs != null && !x.error && workStepKind(x) === 'edit');
  if (!measured) return {text:completed.length ? L(`已完成 ${completed.length} 次修改 · 行数待回报`, `${completed.length} edits · line count unavailable`) : L('改动统计待回报', 'Awaiting change statistics'),
    title:L('当前连接尚未提供可核实的行数统计。', 'This connection has not reported measurable line counts.')};
  const n = x => Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
  const added = n(measured.added), removed = n(measured.removed), files = n(measured.files);
  const text = added || removed || files ? L(`${measured.partial ? '已统计' : '改动'} +${added} −${removed} 行 · ${files} 文件`, `${measured.partial ? 'Measured' : 'Changes'} +${added} −${removed} lines · ${files} files`) : L('暂无改动记录', 'No recorded changes');
  const basis = measured.source === 'turn_diff' ? L('本轮已回报的净改动行数。', 'Reported net line changes in this turn.')
    : L('本次成功编辑累计写入／移除行数；重复修改会累计，并非仓库净差异。', 'Lines written/removed by successful edits in this run; repeated edits accumulate, not a repository net diff.');
  return {text, title:basis + (measured.partial ? L(' 部分修改未提供完整行数，仅统计已知部分。', ' Some changes lack full counts; only measured lines are included.') : '')};
}
function workEta(lv, now = Date.now() / 1000) {
  const r = lv.run;
  if (!r || r.finished || r.stopping) return {text:'',title:''};
  const waiting = r.approval ? L('等待确认', 'Awaiting approval') : r.phase === 'queued' ? L('排队中', 'Queued')
    : r.compaction?.status === 'running' ? L('整理上下文中', 'Compacting context') : '';
  if (waiting) { lv.eta = null; return {text:waiting,title:L('恢复执行后重新估算剩余时间。', 'Remaining time will be estimated after work resumes.')}; }
  const started = Number(r.work_started || r.started), elapsed = Math.max(0, now - started);
  const todos = (r.todos || []).filter(t => ['pending','in_progress','completed'].includes(t.status));
  const done = todos.filter(t => t.status === 'completed').length;
  if (todos.length && done === todos.length) { lv.eta = null; return {text:L('正在收尾', 'Wrapping up'), title:L('计划步骤已完成，等待最终结果。', 'Planned steps are complete; waiting for the final result.')}; }
  const identity = `${S.uid || ''}:${r.id}:${started}`;
  let signature, low, high, basis;
  if (todos.length > 1 && done > 0 && elapsed >= 15 && Number.isFinite(elapsed)) {
    signature = 'plan:' + JSON.stringify(todos.map(t => [t.content,t.status]));
    const remaining = elapsed / done * (todos.length - done);
    low = now + remaining * .6; high = now + remaining * 1.6;
    basis = L(`按本次计划进度估算（完成 ${done}/${todos.length} 步），步骤复杂度不同，时间可能变化。`, `Based on this plan (${done}/${todos.length} complete); steps vary in complexity, so timing may change.`);
  } else {
    // Use only this conversation, the same agent and (when known) model.
    const key = lv.key || (String(r.tags?.conversation || '').endsWith(':' + S.chat) ? S.chat : null);
    const samples = (S.chatTurns?.[key] || []).filter(t => t.role !== 'user' && !t.error && t.agent === r.agent
      && (!(t.model || t.how?.model) || !r.env?.model || (t.model || t.how?.model) === r.env.model))
      .slice(-12).map(t => t.how?.seconds).filter(s => Number.isFinite(s) && s >= 5 && s <= 86400).sort((a,b) => a-b);
    if (samples.length < 3 || !Number.isFinite(started)) { lv.eta = null; return {text:L('估算中', 'Estimating'),title:L('需要已完成的计划步骤，或本对话至少三次同一 Agent 的历史耗时。', 'Needs completed plan steps or at least three prior timings for this agent in this conversation.')}; }
    signature = 'history:' + samples.join(',');
    low = started + samples[Math.floor((samples.length - 1) * .25)] * .75;
    high = started + samples[Math.ceil((samples.length - 1) * .75)] * 1.5;
    basis = L(`参考本对话同一 Agent 的 ${samples.length} 次历史耗时，任务不同可能超出预估。`, `Based on ${samples.length} prior runs by this agent in this conversation; different tasks may exceed the estimate.`);
  }
  if (lv.eta?.identity !== identity || lv.eta.signature !== signature) lv.eta = {identity,signature,low,high,basis};
  const estimate = lv.eta, upper = estimate.high - now, lower = Math.max(0, estimate.low - now);
  if (upper <= 0) return {text:L('已超出预估', 'Beyond estimate'),title:estimate.basis + L(' 任务仍在运行，等待新进度重新估算。', ' Work is ongoing; a new progress update will revise the estimate.')};
  const unit = upper < 60 ? 10 : upper < 3600 ? 60 : 3600;
  const quantize = s => unit === 10 ? Math.max(10,Math.ceil(s/10)*10) : Math.max(1,Math.ceil(s/unit));
  const a = quantize(lower), b = quantize(upper), range = a === b ? String(b) : `${a}–${b}`;
  return {text:L(`还需约 ${range}${unit === 10 ? '秒' : unit === 60 ? '分钟' : '小时'}`, `About ${range}${unit === 10 ? 's' : unit === 60 ? 'm' : 'h'} left`),title:estimate.basis};
}
function paintWorkEta(lv, id) {
  const el = document.getElementById(id)?.querySelector('.work-eta'); if (!el) return;
  const eta = workEta(lv); if (el.textContent !== eta.text) el.textContent = eta.text;
  if (el.title !== eta.title) el.title = eta.title;
  el.hidden = !eta.text;
}
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
// Revisions avoid scanning megabytes of unchanged output on every polling tick.
// Older servers still use the complete signature, so mixed-version upgrades work.
function liveContentVersion(r) {
  if (r?.revision != null) return `${r.id}:${r.revision}`;
  return JSON.stringify([r?.id, r?.text, r?.steps, r?.todos, r?.env, r?.usage, r?.phase, r?.queue_reason, r?.compaction, r?.running, r?.agent, r?.finished, r?.stopping, r?.error, r?.code_progress, r?.work_started, r?.approval]);
}
function paintLiveCard(state, id, box) {
  const html = workCard(state, id).replace('class="work"', 'class="work still"');
  if (html === state.html && box === state.box) return false;
  state.html = html;
  const tx = box.querySelector('.wtext'), top = tx?.scrollTop || 0;
  const atEnd = !tx || tx.scrollTop + tx.clientHeight >= tx.scrollHeight - 4;
  const scrolls = new Map([...box.querySelectorAll('.tool-live-output')].map(el => [el.dataset.toolout,
    {top:el.scrollTop, follow:el.scrollTop + el.clientHeight >= el.scrollHeight - 8}]));
  const template = document.createElement('template'); template.innerHTML = html;
  patchLiveNode(box, template.content.firstElementChild); state.box = box;
  box.querySelectorAll('details[data-procfold]').forEach(el => {
    el.open = state.folds?.get(el.dataset.procfold) || false;
  });
  box.querySelectorAll('.tool-live-output').forEach(el => {
    const old = scrolls.get(el.dataset.toolout); el.scrollTop = !old || old.follow ? el.scrollHeight : old.top;
  });
  const nx = box.querySelector('.wtext'); if (nx) nx.scrollTop = atEnd ? nx.scrollHeight : top;
  return true;
}
const liveCardViews = new Map();
let liveCardSweep = null;
function scheduleLiveCardCleanup() {
  if (liveCardSweep || typeof setTimeout !== 'function' || !liveCardViews.size) return;
  liveCardSweep = setTimeout(() => {
    liveCardSweep = null;
    for (const id of liveCardViews.keys()) if (!document.getElementById?.(id)) liveCardViews.delete(id);
    scheduleLiveCardCleanup();
  }, 30000);
  liveCardSweep?.unref?.(); // Node-based UI tests should not stay alive for maintenance.
}
// toggle does not bubble; capture also handles keyboard and programmatic expansion.
document.addEventListener('toggle', e => {
  const detail = e.target;
  if (!detail.matches?.('details[data-procfold]')) return;
  const box = detail.closest('.work'), state = box && liveCardViews.get(box.id);
  if (!state || !detail.isConnected || state.folds?.get(detail.dataset.procfold) === detail.open) return;
  (state.folds ||= new Map()).set(detail.dataset.procfold, detail.open);
  state.html = null;
  paintLiveCard(state, box.id, box);
}, true);
function splitWorkId(key) { return 'splitWork-' + encodeURIComponent(key); }
function splitWorkCard(key) {
  const lv = S.live?.lanes?.[key] || {key, t0:S.live?.t0};
  return workCard(lv, splitWorkId(key));
}
// Group only neighboring tool rows so each note keeps its place in the trace.
function workGroups(steps, renderStep, folds, runId) {
  const isTool = step => step.t === 'tool' || (!step.t && step.tool);
  let html = '';
  for (let start = 0; start < steps.length;) {
    let end = start + 1;
    if (isTool(steps[start])) {
      while (end < steps.length && isTool(steps[end])) end++;
    }
    const count = end - start;
    if (count === 1) {
      html += renderStep(steps[start], start);
    } else {
      const key = `group:${runId}:${start}`, open = folds?.get(key);
      const chunk = steps.slice(start, end);
      const errors = chunk.filter(step => step.error).length;
      const title = L(`${count} 次工具调用`, `${count} tool calls`);
      const rows = !folds || open ? chunk.map((step, n) => renderStep(step, start + n)).join('') : '';
      html += `<details class="work-group" ${folds ? `data-procfold="${esc(key)}"` : ''} ${open ? 'open' : ''}><summary>${title}${errors ? ` · <span class="bad">${L(`${errors} 步出错`, `${errors} failed`)}</span>` : ''}</summary>${rows}</details>`;
    }
    start = end;
  }
  return html;
}
function runEffortLabel(value, agent) {
  const label = value ? (typeof EFF_ZH !== 'undefined' && EFF_ZH[value]) || value : '';
  return (agent ? agentLabel(agent) + ' · ' : '') + L('推理强度：' + (label || '未知'), 'Reasoning effort: ' + (value || 'unknown'));
}
// A rounded cat face stays legible at status-icon size; the head gently shakes while working.
function workLoadingCat(still = false) {
  return `<svg class="work-loading-cat${still ? ' work-cat-still' : ''}" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
    <g class="cat-head" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8 10 6.3 4.4Q6.1 3.3 7.2 3.8L12.3 7Q16 5.8 19.7 7L24.8 3.8Q25.9 3.3 25.7 4.4L24 10C26 12.1 27.1 14.7 26.9 17.6C26.7 23.5 22.4 26.5 16 26.5S5.3 23.5 5.1 17.6C4.9 14.7 6 12.1 8 10Z" fill="currentColor" stroke="#bd8755" stroke-width="1.1"/>
      <path d="m8.2 6.2.9 4 2.2-1.6Zm15.6 0-.9 4-2.2-1.6Z" fill="#db947d"/>
      <path d="M14 7.2v2.1m4-2.1v2.1" stroke="#d49b63" stroke-width="1.4"/>
      <ellipse cx="11.5" cy="15.8" rx="1.3" ry="1.7" fill="#594236"/>
      <ellipse cx="20.5" cy="15.8" rx="1.3" ry="1.7" fill="#594236"/>
      <path d="m14.4 19 1.6 1.4 1.6-1.4Z" fill="#b97769"/>
      <path d="M16 20.4v1m0 0q-1.5 2-3 0m3 0q1.5 2 3 0" stroke="#795345" stroke-width="1"/>
      <path d="m2 17.8 5 1m-4 3 4-1m23-3-5 1m4 3-4-1" stroke="#bd8755" stroke-width="1.1"/>
    </g>
  </svg>`;
}
function workCard(lv = S.live || {}, id = "workCard") {
  const r = lv.run, parsed = parseSteps(r?.text), words = parsed.words.replace(/<PGA_KNOWLEDGE\s+id=["'][^"']+["']>[\s\S]*?(?:<\/PGA_KNOWLEDGE>|$)/g, '').trim();
  const rich = (r?.steps || []).length > 0, steps = rich ? r.steps : parsed.steps;
  const u = usageJs(r?.usage), env = r?.env || {}, todos = r?.todos || [];
  const status = workStatus(r, steps, words, rich), finished = !!r?.finished;
  const code = workCodeSummary(r), eta = workEta(lv);
  const failed = steps.filter(x => x.error).length;
  const seen = lv.seen || 0; lv.seen = steps.length;
  const format = liveFormatCache(lv);
  const currentCard = document.getElementById?.(id);
  const runId = r?.id || id;
  if (lv.viewRunId !== runId) { lv.viewRunId = runId; lv.folds = new Map(); }
  lv.folds ||= new Map();
  // Only preserve disclosures belonging to this run, not the preceding answer.
  const progressKey = `progress:${runId}`;
  if (!lv.folds.has(progressKey)) lv.folds.set(progressKey, false);
  if (currentCard?.querySelector?.('.work-progress')?.dataset?.procfold === progressKey) {
    for (const el of currentCard.querySelectorAll('details[data-procfold]')) lv.folds.set(el.dataset.procfold, el.open);
  }
  if (!liveCardViews.has(id)) for (const key of liveCardViews.keys()) {
    if (!document.getElementById?.(key)) liveCardViews.delete(key);
  }
  liveCardViews.set(id, lv);
  scheduleLiveCardCleanup();
  const expanded = lv.folds.get(progressKey) || false;
  const toolFold = (x, n) => `tool:${runId}:${x.id || x.ref || x.at || n}`;
  const retainedFolds = new Set([progressKey, ...steps.map(toolFold)]);
  for (const key of lv.folds.keys()) {
    if (key.startsWith('tool:') && !retainedFolds.has(key)) lv.folds.delete(key);
  }
  const expandedTools = new Set([...lv.folds].filter(([, open]) => open).map(([key]) => key));
  const renderStep = (x, n) => format('step:' + n,
    JSON.stringify([rich && !expandedTools.has(toolFold(x, n)) && x.t === 'tool' ? [x.tool, x.secs, x.error, x.diff, workStepKind(x)] : x, rich, r?.id, r?.running, finished, n >= seen, n === steps.length - 1 && !words, expandedTools.has(toolFold(x, n)), toolFold(x, n)]), () => rich
    ? howStep({ ...x, secs: x.secs ?? null }, { live: r.id, foldKey: toolFold(x, n), expanded: expandedTools.has(toolFold(x, n)) }, (x.t === "tool" && x.secs == null && !finished && r.running !== false ? "cur" : "") + (n >= seen ? " new" : ""))
    : stepRow(x, (n === steps.length - 1 && !words && !finished ? "cur" : "") + (n >= seen ? " new" : "")));
  const fold = (env.cwd || "").replace(/^\/Users\/[^/]+/, "~");
  const fences = /(^|\n)(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)|$)/g;
  const detailText = steps.length ? (expanded ? Array.from(words.matchAll(fences), m => m[0]).join('\n') : '') : words;
  const progressText = detailText ? `<div class="wtext md">${format("words", detailText, () => md(detailText))}${finished ? '' : '<span class="caret"></span>'}</div>` : '';
  const prose = steps.length ? words.replace(fences, '\n').trim() : '';
  const counts = {};
  for (const step of steps) if (step.tool) {
    const kind = workStepKind(step);
    counts[kind] = (counts[kind] || 0) + 1;
  }
  const activity = [counts.cmd && L(`${counts.cmd} 次命令`, `Commands · ${counts.cmd}`),
    counts.web && L(`${counts.web} 次网页检索`, `Web lookups · ${counts.web}`)].filter(Boolean).join(' · ');
  const agent = r?.agent || lv.agent;
  const runEffort = env.effort || env.reasoning_effort || r?.effort || (agent === lv.agent && lv.effort);
  const configured = !runEffort && S.agentOpts?.[agent]?.default_effort;
  const effortText = runEffortLabel(runEffort || configured, agent)
    + (configured ? L('（配置默认值）', ' (configured default)') : '');
  const showCode = r?.code_progress?.files || r?.code_progress?.added || r?.code_progress?.removed || steps.some(x => workStepKind(x) === 'edit');
  return `<div id="${esc(id)}" class="work">${prose ? `<div class="work-prose">${esc(prose)}</div>` : ''}<details class="work-progress" data-procfold="progress:${esc(r?.id || id)}" ${expanded ? 'open' : ''}>
    <summary class="wh">${finished ? `<span class="${r.ok === false ? 'bad' : 'ok'}" aria-hidden="true">${r.ok === false ? '!' : '✓'}</span>` : workLoadingCat(r?.phase === 'queued' || r?.stopping)}
      <span class="work-state"><span class="wst" role="status" aria-live="polite" aria-atomic="true">${esc(status)}</span>
      ${failed ? `<span class="work-failed bad">${L(`${failed} 步出错`, `${failed} failed`)}</span>` : ''}</span>
      <span class="work-disclosure">${L('详情', 'Details')}<span class="work-chevron" aria-hidden="true">›</span></span>
      <span class="work-metrics"><span>${esc(effortText)}</span>${activity ? `<span>${esc(activity)}</span>` : ''}${showCode ? `<span class="work-code" title="${esc(code.title)}">${esc(code.text)}</span>` : ''}
      <span class="work-timing"><span class="num wt" title="${L('已用时间', 'Elapsed time')}">${liveSecs(lv)}s</span><span class="work-eta" title="${esc(eta.title)}" ${eta.text ? '' : 'hidden'}>${esc(eta.text)}</span></span></span></summary>
    <div class="work-detail">${expanded ? `<div class="wenv">${esc([r?.agent ? agentLabel(r.agent) : lv.agent ? agentLabel(lv.agent) : '', env.model, fold, env.permission,
      env.tools ? L(`${env.tools} 个工具`, `${env.tools} tools`) : '', (env.mcp || []).length ? 'MCP ' + env.mcp.join(', ') : '',
      u ? `↑${kfmt(u.input)} ↓${kfmt(u.output)}` : ''].filter(Boolean).join(' · '))}</div>
    ${todos.length ? `<ul class="todo">${todos.map((t) => `<li class="${esc(t.status)}"><span>${t.status === "completed" ? "✓" : t.status === "in_progress" ? `<span class="spin"></span>` : "○"}</span>${esc(t.content)}</li>`).join("")}</ul>` : ""}
    <div class="steps">${workGroups(steps, renderStep, lv.folds, runId)}</div>
    ${steps.length && words !== prose ? progressText : ''}${r?.error ? `<p class="bad">${esc(r.error)}</p>` : ''}` : ''}</div></details>
    ${expanded ? '' : workActionTrail(steps, r)}
    ${r ? `<button class="sm ghost work-stop" data-stoplive="${esc(r.id)}">${finished ? L('同步对话', 'Refresh') : L('停止', 'Stop')}</button>` : ''}
    ${generatedPictures(steps, {live: r?.id})}${!steps.length ? progressText : ''}</div>`;
}
/* after the answer: the same steps, kept above it and folded by default */
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
    if (!st.images?.length) continue;
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
  if (src?.live) {
    const kind = workStepKind(st);
    return `<details class="hstep tool-progress" data-procfold="${esc(src.foldKey || `tool:${src.live}:${st.id || st.ref || st.tool}`)}" ${src.expanded ? 'open' : ''}>
      <summary class="step ${kind} ${cls}"><span class="si">${cur ? '<span class="spin"></span>' : TOOLICON[kind]}</span><b>${esc(st.tool)}</b>
        ${st.diff ? `<span class="dstat"><i>+${st.diff[0]}</i> <s>−${st.diff[1]}</s></span>` : ''}
        ${st.secs >= 0.05 ? `<span class="num dimt">${dur(st.secs)}</span>` : ''}${cur ? '' : st.error ? '<span class="bad">✗</span>' : '<span class="ok">✓</span>'}
        <span class="tool-disclosure">${L('详情', 'Details')} <span class="tool-chevron" aria-hidden="true">›</span></span></summary>
      ${src.expanded ? `<div class="sdetail">${st.title || st.target ? `<div class="label">${L('代码 / 命令', 'Code / command')}</div><pre>${esc(st.title || st.target)}</pre>` : ''}
        ${st.output ? `<div class="label">${L('输出', 'Output')}</div><pre class="tool-live-output" data-toolout="${esc(src.foldKey || st.id || '')}">${esc(st.output)}</pre>` : ''}${thumbs(sx, st.images)}</div>` : ''}</details>`;
  }
  return `<div class="hstep">
    <div class="step ${k} ${cls} ${open ? "can" : ""}" ${open ? `data-step="${esc(st.ref)}" data-out="${esc(st.out || "")}" data-sess="${esc(sx.session)}" data-kind="${esc(sx.kind || "claude")}"` : ""} title="${esc(st.server ? st.server + " · " + st.tool : st.tool)}">
      <span class="si">${cur ? `<span class="spin"></span>` : TOOLICON[k]}</span><b>${esc(st.tool)}</b><code>${esc(st.title || "")}</code>
      ${st.diff ? `<span class="dstat"><i>+${st.diff[0]}</i> <s>−${st.diff[1]}</s></span>` : ""}
      ${st.secs >= 0.05 ? `<span class="num dimt">${dur(st.secs)}</span>` : ""}${cur ? "" : st.error ? `<span class="bad">✗</span>` : `<span class="ok">✓</span>`}</div>
    ${st.output ? `<pre class="tool-live-output" data-toolout="${esc(st.id || '')}" style="max-height:240px;overflow:auto;white-space:pre-wrap">${esc(st.output)}</pre>` : ""}${thumbs(sx, st.images)}</div>`;
}
function howBlock(h, src, open = false) {
  const xs = h.steps || [], tools = xs.filter((x) => x.t === "tool").length; if (!xs.length) return "";
  const bad = xs.filter((x) => x.error).length, pics = xs.reduce((n, x) => n + (x.images || []).length, 0);
  return `<details class="proc how" ${open ? "open" : ""}><summary><span class="ok">✓</span>${L(`工作过程 · ${tools} 步`, `Worked · ${tools} steps`)}${h.seconds != null ? ` · ${dur(h.seconds)}` : ""}${pics ? ` · 🖼 ${pics}` : ""}${bad ? ` · <span class="bad">${L(`${bad} 步出错`, `${bad} failed`)}</span>` : ""}</summary>
    <div class="steps">${workGroups(xs, x => howStep(x, src))}</div></details>${generatedPictures(xs, src)}`;
}
/* under an answer: model · time · calls · tokens in (how much from the cache) and out */
function howMeta(h) {
  const u = h.usage, bits = [h.model, runEffortLabel(h.effort), h.seconds != null ? dur(h.seconds) : "", u?.calls ? L(`${u.calls} 次调用`, `${u.calls} calls`) : "",
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
  return `<details class="proc"><summary><span class="ok">✓</span>${L(`工作过程 · ${acts.length} 步`, `Worked · ${acts.length} steps`)}${h.seconds != null ? ` · ${h.seconds}s` : ""}</summary>
    <div class="steps">${workGroups(acts, a => stepRow(a, ""))}</div></details>`;
}
/* under each answer: who, which model, how long, how many tokens (and how many came from the cache), new or continued session, and the steps it took */
function replyMeta(t) {
  const h = t.how || {}, u = h.usage, n = (h.actions || []).length;
  const bits = [t.model || h.model, runEffortLabel(h.effort || t.effort, t.agent), h.seconds != null ? `${h.seconds}s` : "", u ? L(`读入 ${kfmt(u.input)}${u.input ? `（${Math.round(100 * u.cached / u.input)}% 缓存）` : ""} · 写出 ${kfmt(u.output)}`, `in ${kfmt(u.input)}${u.input ? ` (${Math.round(100 * u.cached / u.input)}% cached)` : ""} · out ${kfmt(u.output)}`) : "",
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
function inlineQuotaText(cache, agent, now = Date.now()) {
  if (!agent || agent === 'auto') return L('额度：待选择 Agent', 'Quota: choose an agent');
  const q = cache.ranking?.find(x => x.agent === agent)?.quota;
  if (cache.quotaError) return L('额度读取失败 · 点此重试', 'Quota unavailable · retry');
  if (!q) return cache.at ? L('额度未知 · 重置时间未知', 'Quota unknown · reset unknown') : L('额度读取中…', 'Loading quota…');
  if (q.source === 'login') return L('额度不可读 · 需要登录', 'Quota unavailable · sign in');
  const estimated = q.source === 'observed', historical = q.source === 'codex_sessions';
  const valid = typeof q.remaining === 'number' && Number.isFinite(q.remaining);
  let amount = q.source === 'deepseek_balance' ? (q.detail || L('余额未知','Balance unknown')) :
    estimated ? L('账户额度未知（本地估算）', 'Account quota unknown (estimate)') :
    valid ? L(`剩余 ${Math.round(Math.max(0,Math.min(1,q.remaining))*100)}%`, `${Math.round(Math.max(0,Math.min(1,q.remaining))*100)}% left`) : L('额度未知','Quota unknown');
  if (historical) amount = L('记录：','Recorded: ') + amount;
  if (q.exhausted) amount += estimated ? L(' · 疑似限额',' · possible limit') : L(' · 已限额',' · limited');
  const reset = Date.parse(q.resets_at || '');
  let timer = L('重置时间未知','Reset unknown');
  if (Number.isFinite(reset)) {
    const minutes = Math.ceil((reset-now)/60000);
    if (minutes <= 0) timer = L('重置时间已到 · 待更新','Reset due · awaiting update');
    else {
      const days=Math.floor(minutes/1440), hours=Math.floor(minutes%1440/60), mins=minutes%60;
      const duration = [days ? L(`${days}天`,`${days}d`) : '', hours ? L(`${hours}小时`,`${hours}h`) : '', mins ? L(`${mins}分`,`${mins}m`) : ''].filter(Boolean).join(' ');
      timer = L(`${estimated?'预计 ':''}${duration}后重置`, `${estimated?'Estimated ':''}resets in ${duration}`);
    }
  }
  return amount + ' · ' + timer;
}
function inlineUsageText(cache, agent, model) {
  if (!cache.data) return L("模型用量 · ", "Model usage · ") + (cache.error ? L("暂时无法读取", "unavailable") : L("读取中…", "loading…"));
  if (!model) return `${agent && agent !== "auto" ? agentLabel(agent) : L("模型用量", "Model usage")} · ${L("尚未确定具体模型", "No specific model selected")}`;
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
function inlineUsageContent(cache, agent, model) {
  const label = (agent && agent !== "auto") ? agentLabel(agent) : L("自动选择", "Auto selected");
  const name = model || L("尚未确定具体模型", "No specific model selected");
  const sp = cache.data, hasModels = Array.isArray(sp?.models);
  const row = hasModels && model ? sp.models.find(m => m.agent === agent && m.model === model) : null;
  const total = key => row ? (row.yours?.[key] || 0) + (row.background?.[key] || 0) : 0;
  let usage = !sp ? (cache.error ? L("用量暂时无法读取。", "Usage is temporarily unavailable.") : L("正在读取最近 7 天用量…", "Loading the last 7 days…")) :
    !hasModels ? L("模型统计待后端重启后生效。", "Model totals will be available after a backend restart.") :
    !model ? L("尚未确定具体模型，因此不显示汇总 token 作为模型用量。", "No specific model is selected, so aggregate tokens are not shown as model usage.") :
    !row ? L("该模型最近 7 天暂无记录。", "No records for this model in the last 7 days.") :
    `${L("输入（含缓存）", "Input (including cache)")} ${kfmt(total("input"))} · ${L("缓存读取", "Cached input")} ${kfmt(total("cached"))} · ${L("输出", "Output")} ${kfmt(total("output"))}`;
  if (cache.error && sp) usage += L(" · 更新失败，显示上次记录", " · update failed; showing cached data");
  const quota = cache.ranking?.find(x => x.agent === agent)?.quota;
  const estimate = quota?.source === "observed";
  const quotaTitle = estimate ? L("PGA 本地估算", "PGA estimate") : L("账户共享额度", "Shared account quota");
  const quotaScope = estimate ? L("非供应商账户额度", "not provider account quota") : L("可能由多个模型共用", "may be shared by multiple models");
  let quotaText = cache.quotaError ? L("额度暂时无法读取。", "Quota is temporarily unavailable.") :
    quota ? (quota.detail || L("额度详情未知", "Quota details unavailable")) : L("额度未知", "Quota unknown");
  if (quota && quota.remaining != null && quota.source !== "observed" && quota.source !== "deepseek_balance") {
    quotaText += ` · ${Math.round(quota.remaining * 100)}% ${L("剩余", "remaining")}`;
  }
  if (quota?.exhausted) quotaText += ` · ${L("已耗尽", "exhausted")}`;
  if (quota?.resets_at) quotaText += ` · ${L("重置于", "resets")} ${when(quota.resets_at)}`;
  return `<header class="composer-usage-popover-head"><strong>${L("最近 7 天", "Last 7 days")}</strong><button type="button" class="composer-usage-close" data-inline-usage-close aria-label="${L("关闭用量详情", "Close usage details")}">×</button></header>
    <div class="composer-usage-current"><span>${esc(label)}</span><span>${esc(name)}</span></div>
    <div class="composer-usage-stats">${esc(usage)}</div>
    <div class="composer-usage-quota"><div class="composer-usage-quota-label">${esc(quotaTitle)} <span>${esc(quotaScope)}</span></div><div>${esc(quotaText)}</div>${cache.quotaError && cache.ranking?.find(x => x.agent === agent)?.quota?.detail ? `<div>${esc(cache.ranking.find(x => x.agent === agent).quota.detail)}</div>` : ""}</div>
    <div class="composer-usage-actions"><button type="button" data-inline-quota-refresh>${L("刷新额度", "Refresh quota")}</button><button type="button" class="composer-usage-details" data-inline-usage-details>${L("详细用量", "Detailed usage")}</button></div>
  `;
}
function inlineUsagePanel(cache, agent, model, isOpen = false) {
  return `<section class="composer-usage-popover" data-inline-usage-panel role="dialog" aria-label="${L("模型用量详情", "Model usage details")}" ${isOpen ? "" : "hidden"}>${inlineUsageContent(cache, agent, model)}</section>`;
}
function paintInlineUsage() {
  const cache = modelUsageCache();
  document.querySelectorAll("[data-inline-usage]").forEach(el => {
    const text = inlineUsageText(cache, el.dataset.agent, el.dataset.model);
    const quotaText = inlineQuotaText(cache, el.dataset.agent);
    const summary = el.querySelector?.('[data-inline-quota-summary]');
    if (summary) summary.textContent = quotaText;
    el.title = quotaText + '\n' + text;
    el.setAttribute("aria-label", `${L("查看模型用量", "View model usage")}: ${quotaText}; ${text}`);
    const panel = el.closest(".composer-usage-wrap")?.querySelector("[data-inline-usage-panel]");
    if (panel && !panel.hidden && panel.dataset.usageVersion !== String(cache.version || 0) && !panel.contains(document.activeElement)) {
      panel.innerHTML = inlineUsageContent(cache, el.dataset.agent, el.dataset.model);
      panel.dataset.usageVersion = String(cache.version || 0);
    }
  });
}
async function refreshInlineUsage() {
  if (!S.uid || document.hidden || !document.querySelector("[data-inline-usage]")) return;
  const cache = modelUsageCache();
  if (!cache.pending && Date.now() - cache.at > 60000) {
    cache.at = Date.now();
    cache.pending = Promise.all([
      api(`/v1/users/${S.uid}/usage/split?days=7`).catch(() => null),
      api(`/v1/agents/route?category=general`).catch(() => ({ranking: [], error: true}))
    ]).then(([data, rt]) => { if (data) cache.data = data; if (!rt.error) cache.ranking = rt.ranking; cache.error = !data; cache.quotaError = !!rt.error; cache.version = (cache.version || 0) + 1; })
      .catch(() => { cache.error = true; cache.version = (cache.version || 0) + 1; }).finally(() => { cache.pending = null; });
  }
  if (cache.pending) await cache.pending;
  if (S.stageDormant || S.stageMotion) { S.inlineUsagePaintPending = true; return; }
  paintInlineUsage();
}
function inlineModelUsage(key, last) {
  const agent = S.chatAgent || "auto";
  const model = S.chatModel?.[key] || S.agentOpts?.[agent]?.default_model || "";
  last = last || [...(S.chatTurns?.[key] || [])].reverse().find(t => t.role === "agent");
  const shownAgent = agent === "auto" ? last?.agent || "auto" : agent;
  const shownModel = agent === "auto" ? last?.model || "" : model;
  setTimeout(refreshInlineUsage, 0);
  const cache = modelUsageCache();
  return `<span class="composer-usage-wrap"><button type="button" class="composer-usage-button" data-inline-usage data-agent="${esc(shownAgent)}" data-model="${esc(shownModel)}" aria-haspopup="dialog" aria-expanded="false" title="${L("查看模型用量", "View model usage")}" aria-label="${L("查看模型用量", "View model usage")}"><svg class="composer-usage-icon" width="17" height="17" viewBox="0 0 18 18" aria-hidden="true"><path d="M3 14.5h12M4.5 12V8.5M9 12V4M13.5 12V6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><span class="composer-quota-summary" data-inline-quota-summary>${esc(inlineQuotaText(cache, shownAgent))}</span></button>${inlineUsagePanel(cache, shownAgent, shownModel)}</span>`;
}
setInterval(refreshInlineUsage, 15000);
function closeInlineUsage(wrap, restoreFocus = false) {
  const button = wrap?.querySelector("[data-inline-usage]"), panel = wrap?.querySelector("[data-inline-usage-panel]");
  if (!button || !panel) return;
  panel.hidden = true; button.setAttribute("aria-expanded", "false"); wrap.classList.remove("is-open");
  if (restoreFocus) button.focus();
}
function inlineUsageClick(e) {
  if (e.target.closest?.('[data-inline-quota-refresh]')) {
    const wrap = e.target.closest('.composer-usage-wrap');
    modelUsageCache().at = 0;
    refreshInlineUsage().then(() => {
      const button = wrap?.querySelector('[data-inline-usage]'), panel = wrap?.querySelector('[data-inline-usage-panel]');
      if (button && panel && !panel.hidden) {
        panel.innerHTML = inlineUsageContent(modelUsageCache(), button.dataset.agent, button.dataset.model);
        panel.dataset.usageVersion = String(modelUsageCache().version || 0);
        panel.querySelector('[data-inline-quota-refresh]')?.focus();
      }
    }); return;
  }
  const close = e.target.closest?.("[data-inline-usage-close]");
  if (close) { closeInlineUsage(close.closest(".composer-usage-wrap"), true); return; }
  const details = e.target.closest?.("[data-inline-usage-details]");
  if (details) { closeInlineUsage(details.closest(".composer-usage-wrap")); showUsage(7); return; }
  const button = e.target.closest?.("[data-inline-usage]");
  if (button) {
    const wrap = button.closest(".composer-usage-wrap"), panel = wrap?.querySelector("[data-inline-usage-panel]");
    if (!wrap || !panel) return;
    const open = panel.hidden;
    document.querySelectorAll(".composer-usage-wrap.is-open").forEach(other => closeInlineUsage(other));
    if (open) {
      panel.hidden = false; button.setAttribute("aria-expanded", "true"); wrap.classList.add("is-open");
      panel.innerHTML = inlineUsageContent(modelUsageCache(), button.dataset.agent, button.dataset.model);
      panel.dataset.usageVersion = String(modelUsageCache().version || 0);
      panel.querySelector("[data-inline-usage-close]")?.focus();
    } else closeInlineUsage(wrap);
    return;
  }
  if (!e.target.closest?.(".composer-usage-wrap"))
    document.querySelectorAll(".composer-usage-wrap.is-open").forEach(wrap => closeInlineUsage(wrap));
}
function inlineUsageKeydown(e) {
  if (e.key !== "Escape") return;
  const open = document.querySelector(".composer-usage-wrap.is-open");
  if (!open) return;
  e.preventDefault(); e.stopPropagation(); closeInlineUsage(open, true);
}
function inlineUsageFocusin(e) {
  const open = document.querySelector(".composer-usage-wrap.is-open");
  if (open && !open.contains(e.target)) closeInlineUsage(open);
}
if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("click", inlineUsageClick);
  document.addEventListener("keydown", inlineUsageKeydown);
  document.addEventListener("focusin", inlineUsageFocusin);
}
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
  return `<span class="grow"></span><details class="chat-action-menu"><summary class="sm ghost" aria-label="${L('对话管理', 'Manage conversation')}" title="${L('对话管理：置顶、移动、重命名、设定、导出和归档', 'Manage conversation: pin, move, rename, instructions, export and archive')}">⋯</summary><div class="chat-action-panel">
    <div class="chat-action-label">${L('整理对话', 'Organize')}</div>
    ${line ? `<button class="sm ghost" data-pin="${esc(line)}" data-to="${pinned ? "0" : "1"}">${pinned ? L("取消置顶", "Unpin") : L("置顶对话", "Pin conversation")}</button>` : ""}
    <button class="sm ghost" data-moveto="${esc(key || "")}" data-line="${esc(line || "")}">${L("移动到…", "Move to…")}</button>
    ${key && !S.lineView ? `<button class="sm ghost" data-act="rename" data-key="${esc(key)}">${L("重命名", "Rename")}</button>
    <button class="sm ghost ${S.chatSys?.[key] ? "on" : ""}" data-act="sysp" data-key="${esc(key)}" title="${L("给这段对话的设定：每个 agent 都会读到", "Instructions for this conversation: every agent reads them")}">${L("对话设定", "Conversation instructions")}${S.chatSys?.[key] ? ' ✓' : ''}</button>
    ${S.chat === key && (S.chatTurns[key] || []).some((t) => t.run) ? `<button class="sm ghost" data-act="copychat" data-key="${esc(key)}" title="${L("在副本里接着聊，原对话保留", "Continue in a copy; keep the original")}">${L("创建对话副本", "Duplicate conversation")}</button>` : ""}` : ""}
    <hr><div class="chat-action-label">${L('导出记录', 'Export')}</div>
    <button class="sm ghost" data-act="exportmd">${L('导出 Markdown', 'Export Markdown')}</button><button class="sm ghost" data-act="exportjson">${L('导出 JSON', 'Export JSON')}</button>
    <hr><button class="sm ghost" data-archall="${esc(key || "")}" data-line="${esc(line || "")}" title="${L('收起对话，可在已归档中恢复', 'Put away this conversation; restore it from the archive')}">${L("归档对话", "Archive conversation")}</button>
    </div></details>`;
}
function stageFrameVisible() {
  try { for (let e = window.frameElement; e; e = e.parentElement) if (e.hidden) return false; } catch {}
  return true;
}
function stageTryPendingChatRender(pending) {
  if (!pending || S.stageChatRenderPending !== pending || pending.waiting) return;
  pending.waiting = true;
  void (async () => {
    try { if (typeof pgStageIdleForPaint === "function") await pgStageIdleForPaint(); } catch {}
    finally { pending.waiting = false; }
    if (S.stageChatRenderPending !== pending || S.stageDormant || S.stageMotion || !stageFrameVisible()) return;
    if (S.chat !== pending.chat || S.lineView !== pending.lineView) { S.stageChatRenderPending = null; return; }
    S.stageChatRenderPending = null;
    renderChat();
  })();
}
function stageTryPendingUsagePaint() {
  if (!S.inlineUsagePaintPending || S.stageUsagePaintWaiting) return;
  S.stageUsagePaintWaiting = true;
  void (async () => {
    if (typeof pgStageIdleForPaint === "function") await pgStageIdleForPaint();
    S.stageUsagePaintWaiting = false;
    if (!S.inlineUsagePaintPending || S.stageDormant || S.stageMotion || !stageFrameVisible()) return;
    S.inlineUsagePaintPending = false;
    paintInlineUsage();
  })();
}
function stageTryPendingManagerPaint() {
  if (typeof PD === 'undefined' || !PD.renderPending || S.stageManagerPaintWaiting) return;
  S.stageManagerPaintWaiting = true;
  void (async () => {
    // Let the synchronous stage placement finish before sampling its idle epoch.
    await Promise.resolve();
    try { if (typeof pgStageIdleForPaint === "function") await pgStageIdleForPaint(); } catch {}
    finally { S.stageManagerPaintWaiting = false; }
    if (typeof PD === 'undefined' || !PD.renderPending || S.stageDormant || S.stageMotion || !stageFrameVisible()) return;
    if (typeof window.pdRender === 'function') window.pdRender();
  })();
}
function stageQueueChatRender() {
  const pending = S.stageChatRenderPending || {};
  pending.chat = S.chat; pending.lineView = S.lineView;
  pending.version = S.stageChatRenderVersion = (S.stageChatRenderVersion || 0) + 1;
  S.stageChatRenderPending = pending;
  stageTryPendingChatRender(pending);
}
window.pgaStageActivated = function () {
  if (S.stageDormant || S.stageMotion) return;
  window.chatReadVisibleResults?.();
  if (S.stageChatRenderPending) stageTryPendingChatRender(S.stageChatRenderPending);
  if (S.inlineUsagePaintPending) stageTryPendingUsagePaint();
  // Manager paint waits for both stage placement and motion to settle.
  stageTryPendingManagerPaint();
};
function loadChatRender() {
  const embedded = typeof EMBED !== "undefined" && EMBED && window !== window.top;
  if (embedded || S.stageDormant || S.stageMotion) { stageQueueChatRender(); return; }
  S.stageChatRenderPending = null; S.stageChatRenderVersion = (S.stageChatRenderVersion || 0) + 1;
  renderChat();
}
// Bound read requests only. Sending work to an agent is never retried here.
function chatHistoryRequest(key, signal) {
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, {once:true});
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 15000);
  const result = (async () => {
    try {
      const data = await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(key)}`, {signal:controller.signal});
      if (!Array.isArray(data?.turns)) throw new Error(L('对话记录格式异常，请重试', 'Invalid conversation response. Please retry.'));
      return data;
    } catch (err) {
      if (timedOut) throw new Error(L('读取对话记录超时，请重试；草稿已保留', 'Reading this conversation timed out. Retry; your draft is kept.'));
      throw err;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  })();
  return {controller, result};
}
async function loadChat(key, {force = false} = {}) {
  if (!key || key.startsWith("new:")) { loadChatRender(); return; }
  S.chatLoads ||= {};
  const previous = S.chatLoads[key];
  if (previous && !force) return previous.promise;
  previous?.controller.abort();
  const boot = S.chatBoot?.key === key ? S.chatBoot : null;
  if (boot) delete S.chatBoot;
  const request = boot || chatHistoryRequest(key);
  const uid = S.uid, load = {controller:request.controller || new AbortController()};
  S.chatLoads[key] = load;
  const current = () => S.chatLoads[key] === load && S.uid === uid;
  S.chatLoadErrors ||= {}; delete S.chatLoadErrors[key];
  load.promise = (async () => {
    try {
      const result = boot ? await boot.result : {data:await request.result};
      if (!current()) return;
      if (result.error) throw result.error;
      const r = result.data;
      if (r.qa_count != null) (S.qaCounts ||= {})[key] = r.qa_count;
      if (r.options) S.chatLoadedChoices = {...(S.chatLoadedChoices || {}), [key]: r.options};
      if (r.options && !S.loadedBranchOptions?.[key] && !(typeof chatChoiceRead === "function" && chatChoiceRead(key))) {
        S.loadedBranchOptions = { ...(S.loadedBranchOptions || {}), [key]: true };
        S.chatModel = { ...(S.chatModel || {}), [key]: r.options.model || "" };
        S.chatEffort = { ...(S.chatEffort || {}), [key]: r.options.effort || "" };
        if (key === S.chat && r.options.agent) S.chatAgent = r.options.agent;
      }
      S.readings ||= {}; S.readings[key] = r.reading || null;
      S.chatSplits ||= {}; S.chatSplits[key] = r.split || null;
      if (r.split) {
        const lanes = await Promise.all(r.split.lanes.map(async lane => ({key:lane.key,
          data:await chatHistoryRequest(lane.key, load.controller.signal).result})));
        if (!current()) return;
        for (const lane of lanes) S.chatTurns[lane.key] = lane.data.turns;
      }
      (S.chatSources ||= {})[key] = r.merges?.from || [];
      S.chatTurns[key] = r.turns;
      S.chatCtx = { ...(S.chatCtx || {}), [key]: r.branch ? r : null }; S.chatSys = { ...(S.chatSys || {}), [key]: r.system || "" }; S.chatMulti = { ...(S.chatMulti || {}), [key]: r.multi || [] }; if (key === S.chat) S.multi = [...(r.multi || [])]; S.chatKids = { ...(S.chatKids || {}), [key]: r.children || [] }; S.chatMerges = { ...(S.chatMerges || {}), [key]: r.merges || null }; S.chatWorld = { ...(S.chatWorld || {}), [key]: r.world || null }; S.chatDispatch = { ...(S.chatDispatch || {}), [key]: r.dispatch || [] };
      if (r.branch && key === S.chat && S.view === "chats") {
        const marker = questionReplayKey(key), pending = sessionStorage.getItem(marker);
        if (pending) {
          sessionStorage.removeItem(marker);
          if (!r.turns.length) void sendChatTurn(pending, false, r.options || {}).catch(err => toast(err.message));
        }
      }
    } catch (e) {
      if (!current()) return;
      S.chatLoadErrors[key] = e.message || String(e); toast(e.message);
    } finally {
      if (current()) {
        delete S.chatLoads[key];
        if (S.chat === key || S.lineView) loadChatRender();
      }
    }
  })();
  return load.promise;
}
function questionReplayKey(key) { return "pga_question_replay:" + S.uid + ":" + key; }
async function sendQaTask(key) {
  const input = $("#chatText"), text = input?.value.trim();
  if (!text) return;
  const reply = S.qaReply?.[key], attachments = S.att;
  const files = takeAtts(), effort = $("#chatEffort")?.value;
  input.value = ""; S.chatDraft = "";
  if (reply) delete S.qaReply[key];
  renderChat();
  try {
    const result = await api(`/v1/users/${S.uid}/agents/ask`, {body:{conversation:key, text,
      ...files, effort, reply_to:reply?.run}});
    const destinations = Object.values(result.defaults || {});
    const titles = [...new Set((result.entry?.tasks || []).map(t => destinations.find(d => d.key === t.key)?.title || t.title))];
    toast(L("已分配到 ", "Assigned to ") + titles.join("、"));
  } catch (err) {
    if (S.chat === key) {
      S.chatDraft = [text, $("#chatText")?.value].filter(Boolean).join("\n\n");
      if ($("#chatText")) $("#chatText").value = S.chatDraft;
      S.att = [...attachments, ...S.att];
      if (reply && !S.qaReply[key]) S.qaReply[key] = reply;
      renderChat();
    }
    toast(err.message);
  }
}
async function chatSend() {
  if (!S.lineView && !S.imp && typeof isQaFeed === "function" && isQaFeed(S.chat)) return sendQaTask(S.chat);
  if (S.readings?.[S.chat] && typeof readingSend === 'function') return readingSend();
  if (S.sending || S.regenBusy) return queueFollowup(true);
  if (composerBusy()) return;
  const text = ($("#chatText")?.value || "").trim(); if (!text) { toast(L("先写点什么", "Write something first")); return; }
  if (S.chatSplits?.[S.chat]) return splitSend();
  const capture = typeof knowledgeEnabled === "function" && knowledgeEnabled();
  if (!capture && S.multi?.length > 1 && typeof multiSend === "function") return multiSend();
  return sendChatTurn(text, capture);
}
async function sendChatTurn(text, capture, choice = null) {
  const replay = choice !== null;
  if (!S.chat) {
    const choice = typeof chatChoiceRead === "function" ? chatChoiceRead("") : null;
    S.chat = `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    if (choice) { S.chatAgent = choice.agent; S.chatModel = {...(S.chatModel || {}), [S.chat]: choice.model}; S.chatEffort = {...(S.chatEffort || {}), [S.chat]: choice.effort}; chatChoiceSave(S.chat); }
  }
  if (capture) knowledgeSet(true, S.chat);
  const key = S.chat, prev = S.chatTurns[key] || [], ctx = S.chatCtx?.[key]?.context || [];
  const hist = [...ctx, ...prev].slice(-12).map((t) => ({ role: t.role === "user" ? "user" : "assistant", text: t.text }));
  const agent = choice?.agent || $("#chatAgent")?.value || "auto";
  const model = choice ? choice.model : S.chatModel?.[key];
  const effort = choice ? choice.effort : $("#chatEffort")?.value ?? (agent === S.chatAgent ? S.chatEffort?.[key] : "");
  let knowledge = null;
  if (capture) {
    S.knowledgePreparing = true;
    try { knowledge = await knowledgePrepare(key, text, agent); }
    catch (err) { toast(err.message); return; }
    finally { S.knowledgePreparing = false; }
  }
  const at = replay ? {images:[], files:[]} : takeAtts(), natt = at.images.length + at.files.length;
  S.chatTurns[key] = [...prev, { role: "user", text: natt ? `${text}\n\n📎 ${L(`${natt} 个附件`, `${natt} attachment(s)`)}` : text, at: new Date().toISOString() }];
  S.sentHist = [...S.sentHist.filter((x) => x !== text), text].slice(-50);
  if (S.followupDelivered) delete S.followupDelivered[key];
  S.sending = true; S.chatDraft = ""; const box = $("#chatText"); if (box) box.value = ""; window.history.replaceState(null, "", qs()); startLive(key, undefined, {agent, effort}); renderChat();
  let continueQueue = false;
  try {
    const r = await liveRequest(`/v1/users/${S.uid}/agents/ask`, { body: { text, agent, ...(knowledge ? {knowledge_id: knowledge.id} : {}), conversation: key, history: hist, refs: replay ? [] : S.chatRefs, images: at.images, files: at.files, web: !replay && !!S.web, ...(model ? {model} : {}), ...(effort ? {effort} : {}), ...(replay ? {replay_question:true} : {}) } });
    continueQueue = !r?.error && r?.ok !== false && !r?.stopped;
    if (r?.error && !r?.text) toast(r.error);
  } catch (err) { toast(err.message); }
  finally { stopLive(); if (knowledge) knowledgeHost().knowledgeRefresh(knowledge.id); }
  try { S.scrollChat = true; await loadChats(); await loadChat(key); loadTimeline(); }
  catch (err) { toast(err.message); }
  finally { S.sending = false; }
  if (replay && !continueQueue && S.chat === key && !S.chatTurns[key]?.length && !S.chatDraft && $("#chatText")) {
    S.chatDraft = text; $("#chatText").value = text;
  }
  await drainFollowups(key, continueQueue);
  if (followupKey() === key) renderChat();
}


/* A run of this conversation that this page did not start — the category manager sends tasks from its own page, or
   another window sent it — is followed here like one of its own: its question, the live work card, the answer when
   it ends. Messages typed meanwhile queue as usual. */
setInterval(async () => {
  if (S.stageChatRenderPending && !S.stageDormant && !S.stageMotion) window.pgaStageActivated?.();
  const key = S.chat;
  if (S.view !== "chats" || !key || S.lineView || S.imp || S.treeItem) return;
  if (typeof isQaFeed === "function" && isQaFeed(key)) {
    if (document.hidden || S.stageDormant || S.stageMotion || S.qaChecking || S.chatLoads?.[key]) return;
    S.qaChecking = true;
    const uid = S.uid;
    try {
      const runs = await liveSnap().catch(() => null);
      if (key !== S.chat || uid !== S.uid) return;
      if (runs) {
        S.executionRuns = runs;
        paintExecutionMessages(key, runs);
        const bars = $("#execRuns"), html = executionBars(key, runs);
        if (bars && bars._rendered !== html) { bars.innerHTML = html; bars._rendered = html; }
      }
      if (Date.now() < (S.qaNextCheck || 0)) return;
      S.qaNextCheck = Date.now() + 4000;
      const count = await api(`/v1/users/${uid}/chats/${encodeURIComponent(key)}/qa-count`);
      if (key === S.chat && uid === S.uid && count !== S.qaCounts?.[key]) {
        const dialog = $("#cdlg");
        if (dialog && dialog.scrollHeight - dialog.clientHeight - dialog.scrollTop < 80) S.scrollChat = true;
        await loadChat(key);
      }
    } catch {} finally { S.qaChecking = false; }
    return;
  }
  if (S.sending && S.remoteRun !== key) return;
  let xs; try { xs = await liveSnap(); } catch { return; }
  const tag = `${S.uid}:${key}`, run = xs.find((r) => r.tags?.conversation === tag && !r.finished);
  if (S.remoteRun === key) {
    if (run) { S.remoteFinishedId = run.id; return; }
    S.remoteRun = null; stopLive(); S.sending = false;
    try { delete window.top.__pgaPendingAsk?.[key]; } catch {}
    S.scrollChat = true; await loadChat(key);
    const ended = xs.find(r => r.id === S.remoteFinishedId);
    if (typeof drainFollowups === "function") drainFollowups(key, !!ended?.ok && !ended.stopping);
    return;
  }
  if (!run || S.sending || S.remoteRun) return;
  S.remoteRun = key; S.sending = true;
  let asked = ""; try { asked = window.top.__pgaPendingAsk?.[key] || ""; } catch {}
  const turns = S.chatTurns[key] || [];
  if (asked && turns[turns.length - 1]?.text !== asked) S.chatTurns[key] = [...turns, { role: "user", text: asked, at: new Date((run.started || Date.now() / 1000) * 1000).toISOString() }];
  startLive(key, (run.started || Date.now() / 1000) * 1000); S.scrollChat = true; loadChatRender();
  S.remoteFinishedId = run.id;
}, 1500);
