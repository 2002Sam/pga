/* PGA app · a category's manager as a document (inside the manager's own frame; app-manager.js builds the panes).
   - You write on one sheet. A blank line (Enter twice) sends the paragraph above it; ⌘↵ sends the whole draft.
   - The manager splits the paragraph (pga.dispatch.split, with the category's conversations as candidates) and hands
     each part to itself, to a conversation already in the category, or to a new conversation that grows from here.
   - Each part is a comment to the right of its paragraph: who has it, how far it is, what came back. Clicking a comment
     pulls its conversation beside the manager on the stage.
   Sent paragraphs are the manager conversation's own turns (a note each) and the parts its dispatch entries, so the
   document is the conversation, read differently. */

const PD = { pending: [], live: {}, errors: {}, open: new Set(), sig: "" };
// Keep the choice outside the DOM: manager refreshes must not reset a question's strength.
const pdEffortChoices = new Map();
const pdEffortLabel = effort => L(['自动','快速','中等','高','极高'][Math.max(0, PD_EFFORTS.indexOf(effort))], ['Auto','Quick','Medium','High','Extra high'][Math.max(0, PD_EFFORTS.indexOf(effort))]);
const PD_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh'];
function pdEffortControl() {
  return `<label class="pd-effort"><span>${L('思考强度', 'Reasoning')}</span><input type="range" min="0" max="4" step="1" value="0" data-pd-effort aria-label="${L('思考强度', 'Reasoning')}" aria-valuetext="${L('自动', 'Auto')}"><output>${L('自动', 'Auto')}</output><span class="pd-effort-ticks">${['自动','快速','中等','高','极高'].map((t,i)=>`<button type="button" data-pd-effort-step="${i}">${L(t,['Auto','Quick','Medium','High','Extra high'][i])}</button>`).join('')}</span></label>`;
}
function pdEffortSet(control, value) {
  pdEffortChoices.set(pdKey(), PD_EFFORTS[value] || '');
  const input = control.querySelector('[data-pd-effort]');
  input.value = String(value);
  const label = L(['自动','快速','中等','高','极高'][value], ['Auto','Quick','Medium','High','Extra high'][value]);
  input.setAttribute('aria-valuetext', label); control.querySelector('output').textContent = label;
}
function pdEffortTake() {
  const effort = pdEffortChoices.get(pdKey()) || '';
  pdEffortChoices.delete(pdKey());
  document.querySelectorAll('.pd-effort').forEach(control => pdEffortSet(control, 0));
  return effort;
}
document.addEventListener('input', e => {
  if (e.target.matches?.('[data-pd-effort]')) pdEffortSet(e.target.closest('.pd-effort'), Number(e.target.value));
});
document.addEventListener('click', e => {
  const step = e.target.closest('[data-pd-effort-step]');
  if (step) { e.preventDefault(); pdEffortSet(step.closest('.pd-effort'), Number(step.dataset.pdEffortStep)); }
});
const PD_MARK = "〔管理员任务 #";                       // a part the manager answers itself: asked in its own conversation, shown as a comment
const pdKey = () => S.chat;
const pdOn = () => !!document.querySelector("#pmdoc");
const pdDraftKey = () => "pga_pmdoc_draft:" + pdKey();
const pdTitle = (k) => PM.m?.names.get(k) || PM.m?.by.get(k)?.title || (typeof stTitle === "function" ? stTitle(k) : "") || L("新对话", "New conversation");
const pdPlain = (t) => String(t || "").replace(/```[\s\S]*?```/g, " ").replace(/[#*_`>|-]+/g, " ").replace(/\s+/g, " ").trim();

/* ------------------------------------------------ what the document holds */
function pdModel() {
  const key = pdKey(), turns = S.chatTurns[key] || [], entries = S.chatDispatch?.[key] || [];
  const answer = new Map(), mine = new Map();
  for (const t of turns) {
    if (t.role !== "user" && t.run) answer.set(t.run, t);
    const m = t.role === "user" && String(t.text || "").startsWith(PD_MARK) && String(t.text).slice(PD_MARK.length).match(/^(\w+)〕/);
    if (m) mine.set(m[1], t.run);
  }
  const rows = [];
  for (const t of turns) {
    if (t.role !== "user" || String(t.text || "").startsWith(PD_MARK)) continue;
    const entry = entries.find((e) => e.run === t.run);
    const notes = entry ? entry.tasks.map((x, i) => pdTaskNote(entry, x, i, answer, mine)) : answer.has(t.run) ? [pdAnswerNote(answer.get(t.run), t.run)] : [];
    rows.push({ id: t.run || t.at, text: t.text, at: t.at, notes });
  }
  for (const p of PD.pending) rows.push({ id: p.id, text: p.text, notes: [{ id: p.id + ":p", who: L("管理员", "Manager"), st: p.error ? "error" : "running", title: p.error ? L("没能分配", "Could not assign") : p.phase, body: p.error || "" }] });
  return rows;
}
function pdAnswerNote(a, id) {
  return { id: "a:" + id, who: L("管理员", "Manager"), st: a.error && !a.text ? "error" : "done", title: L("管理员的回复", "The manager's reply"), body: a.text || a.error || "" };
}
function pdTaskNote(entry, x, i, answer, mine) {
  const id = entry.id + ":" + i;
  if (x.manager) {
    const run = mine.get(entry.id), a = run && answer.get(run);
    const st = a ? (a.error && !a.text ? "error" : "done") : PD.live[entry.id] === "error" ? "error" : "running";
    return { id, who: L("管理员", "Manager"), key: pdKey(), st, title: x.title, body: "" };
  }
  const s = typeof taskState === "function" ? taskState(x.key) : { st: "running" };
  const sw = S.dispatchSwitch?.[x.key], name = (a) => typeof agentLabel === "function" ? agentLabel(a) : a;
  const why = sw ? L(`${sw.failed.map((f) => name(f.agent)).join("、")} 没完成${sw.to ? `，已改由 ${name(sw.to)} 处理` : "，后面的 agent 也都没完成"}`,
    `${sw.failed.map((f) => name(f.agent)).join(", ")} failed${sw.to ? `; ${name(sw.to)} took over` : "; no agent could finish it"}`) : x.why || "";
  return { id, key: x.key, who: x.from ? L(`接着「${pdTitle(x.from)}」`, `Continuing “${pdTitle(x.from)}”`) : L("新对话", "New conversation"), agent: s.last?.agent || x.agent, why, st: PD.errors[x.key] ? "error" : s.st, title: x.title, body: PD.errors[x.key] || s.last?.text || s.last?.error || "" };
}

/* ------------------------------------------------ drawing */
function pdNoteHtml(n) {
  const open = false, text = "", short = "";
  const state = n.st === "running" ? `<span class="spin"></span>` : n.st === "error" ? "⚠" : "✓";
  return `<div class="pdnote ${n.st}${n.key ? " link" : ""}" ${n.key ? `data-pdgo="${esc(n.key)}" title="${L("点击：把这段对话拉到管理员旁边", "Click: pull this conversation beside the manager")}"` : ""}>
    <div class="pdnh"><span class="pdst">${state}</span><b>${esc(n.who)}</b>${n.agent && n.agent !== "auto" ? `<em>${esc(agentLabel(n.agent))}</em>` : ""}</div>
    <div class="pdnt">${esc(n.title || "")}</div>
    ${n.why ? `<div class="pdwhy" title="${esc(n.why)}">${esc(n.why)}</div>` : ""}
    ${text ? (open ? `<div class="pdnb md">${md(text)}</div>` : `<div class="pdnb">${esc(short)}${pdPlain(text).length > 220 ? "…" : ""}</div>`) : n.st === "running" ? `<div class="pdnb dim">${L("处理中…", "Working…")}</div>` : ""}
    ${n.key ? `<a class="pdresultlink" href="?v=chats&c=${encodeURIComponent(n.key)}" data-pdgo="${esc(n.key)}">${L("查看处理对话", "View task conversation")} ↗</a>` : ""}
    ${text && pdPlain(text).length > 220 ? `<button class="pdmore" data-pdmore="${esc(n.id)}">${open ? L("收起", "Less") : L("展开全文", "Read all")}</button>` : ""}</div>`;
}
window.pdRender = function () {
  const box = document.querySelector("#pmdoc");
  if (!box) {
    const row = document.querySelector('#chatText')?.closest('.cbar');
    if (String(S.chat || '').startsWith('chat:pm-') && row && !row.querySelector('.pd-effort')) { row.insertAdjacentHTML('beforeend', pdEffortControl()); pdEffortSet(row.querySelector('.pd-effort'), Math.max(0, PD_EFFORTS.indexOf(pdEffortChoices.get(pdKey()) || ''))); }
    return;
  }
  if (!box.querySelector(".pdpaper")) {
    box.innerHTML = `<div class="pdpaper"><div class="pdrows"></div>
      <div class="pdrow pddraftrow"><div class="pdpara"><textarea id="pdDraft" rows="3" placeholder="${L("写下要做的事。空一行（连按两次 Enter）就把上面这段交给管理员；⌘↵ 发送全部。", "Write what needs doing. A blank line (Enter twice) hands the paragraph above to the manager; ⌘↵ sends everything.")}"></textarea></div>
      <div class="pdnotes">${pdEffortControl()}<div class="pdhint">${L("管理员会把每段话分给合适的对话或 agent，进度和结果以批注出现在这里。", "The manager hands each paragraph to the right conversation or agent; progress and results appear here as comments.")}</div></div></div></div>`;
    const ta = box.querySelector("#pdDraft");
    try { ta.value = localStorage.getItem(pdDraftKey()) || ""; } catch {}
    pdFit(ta); pdWire(ta);
    const control = box.querySelector('.pd-effort');
    pdEffortSet(control, Math.max(0, PD_EFFORTS.indexOf(pdEffortChoices.get(pdKey()) || '')));
  }
  const rows = pdModel(), sig = JSON.stringify([rows, [...PD.open]]);
  if (sig === PD.sig) return; PD.sig = sig;
  const list = box.querySelector(".pdrows"), stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  list.innerHTML = rows.length ? rows.map((r) => `<div class="pdrow" data-pdrow="${esc(r.id || "")}"><div class="pdpara">${esc(r.text)}</div><div class="pdnotes">${r.notes.map(pdNoteHtml).join("")}</div></div>`).join("")
    : `<div class="pdempty">${L("这是管理员的文档。在下面写下需求，管理员会安排给这个分类里的对话处理。", "This is the manager's document. Write below; the manager hands the work to this category's conversations.")}</div>`;
  if (stick) box.scrollTop = box.scrollHeight;
};
const pdFit = (ta) => { ta.style.height = "auto"; ta.style.height = Math.max(72, ta.scrollHeight) + "px"; };
function pdWire(ta) {
  ta.addEventListener("input", () => { pdFit(ta); try { localStorage.setItem(pdDraftKey(), ta.value); } catch {} });
  ta.addEventListener("keydown", (e) => {
    if (e.isComposing || e.key !== "Enter") return;
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); const t = ta.value.trim(); if (t) { pdTake(ta, ta.value.length); pdSend(t); } return; }
    if (e.shiftKey) return;
    const at = ta.selectionStart, before = ta.value.slice(0, at);
    if (ta.selectionEnd !== at || !/\n[ \t]*$/.test(before)) return;      // the second Enter: the line it ends is empty
    const para = before.split(/\n[ \t]*\n/).pop().trim(); if (!para) return;
    e.preventDefault(); pdTake(ta, at, para); pdSend(para);
  });
}
function pdTake(ta, at, para) {                     // the sent paragraph leaves the draft; the rest stays where it was
  const before = ta.value.slice(0, at), after = ta.value.slice(at).replace(/^\n+/, "");
  const keep = para ? before.slice(0, before.lastIndexOf(para)).replace(/\s+$/, "") : "";
  ta.value = keep ? keep + "\n\n" + after : after; ta.setSelectionRange(keep ? keep.length + 2 : 0, keep ? keep.length + 2 : 0);
  pdFit(ta); try { localStorage.setItem(pdDraftKey(), ta.value); } catch {}
}

/* ------------------------------------------------ the manager at work
   pga.manager_dispatch plans (DeepSeek, ~1 s) and schedules (your ranking, quota, load; agents with tools outside
   日常对话). Each job runs in a new conversation: grown from this note, or branched from the end of the conversation
   whose context it needs. If the server has not answered in 2.9 s the paragraph goes out whole, agent "auto" (the
   same ranking, applied when it is sent). */
const PD_BUDGET = 2900;
function pdFallback(text) { return [{ title: text.slice(0, 24), text, agent: null, why: L("分配超时：发送时按你的排序自动选择", "Assignment timed out: picked by your ranking when sent") }]; }
async function pdPlan(text, context) {
  let timer;
  const candidates = [...(PM.data?.conversations || [])].filter((c) => c.key !== pdKey())
    .sort((a, b) => String(b.last || "").localeCompare(String(a.last || ""))).slice(0, 20).map((c) => ({ key: c.key, title: c.title }));
  try {
    return await Promise.race([
      api(`/v1/users/${S.uid}/chats/manager-plan`, { body: { text, context, project: PM.name || "", candidates } }),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ tasks: pdFallback(text), fallback: true, late: true }), PD_BUDGET); })
    ]);
  } catch { return { tasks: pdFallback(text), fallback: true }; }
  finally { clearTimeout(timer); }
}
async function pdSend(text) {
  const key = pdKey(); if (!key || !text) return;
  const effort = pdEffortTake();
  const p = { id: "p" + Date.now().toString(36), text, phase: L("正在分配…", "Assigning…") };
  PD.pending.push(p); pdRender();
  try {
    const context = (S.chatTurns[key] || []).filter((t) => t.role === "user").slice(-3).map((t) => String(t.text).slice(0, 500)).join("\n");
    const plan = await pdPlan(text, context), tasks = plan.tasks?.length ? plan.tasks : pdFallback(text);
    const who = (t) => t.agent ? (typeof agentLabel === "function" ? agentLabel(t.agent) : t.agent) : L("自动", "auto");
    p.phase = L(`已分配（${plan.fallback ? "按整段" : "DeepSeek 拆分"} · 按你的排序）：${tasks.map((t) => t.title + " → " + who(t)).join("；")}。正在创建对话…`,
      `Assigned (by your ranking): ${tasks.map((t) => t.title + " → " + who(t)).join("; ")}. Creating conversations…`); pdRender();
    const note = await api(`/v1/users/${S.uid}/chats/note`, { body: { conversation: key, text } });
    const entry = { id: Math.random().toString(36).slice(2, 10), text, effort, run: note.run, tasks: [] };
    // Every job has a fresh conversation; one that needs an existing conversation's context grows from its end.
    // Each job gets a clean conversation of its own in this category (its folder and permissions come with it), not a
    // branch of the manager: a branch would carry the manager's history as a folded block at its top.
    for (const t of tasks) {
      let made, scoped = false;
      try { made = PM.name ? (await api(`/v1/users/${S.uid}/conversation-projects`, { body: { project: PM.name, create: true } })).key : null; scoped = !!made; } catch { made = null; }
      if (!made) made = (await api(`/v1/users/${S.uid}/chats/branch`, { body: { from: key, upto: note.run, title: t.title } })).key;
      else await api(`/v1/users/${S.uid}/chats/title`, { method: "PUT", body: { key: made, title: t.title } }).catch(() => {});
      entry.tasks.push({ title: t.title, key: made, agent: t.agent || "auto", why: (t.why || "") + (effort ? " · " + L("请求思考强度：", "Requested reasoning: ") + pdEffortLabel(effort) : ""), from: t.context || "", text: t.text, tools: !!t.tools, fallback: t.fallback || [], scoped });
    }
    await api(`/v1/users/${S.uid}/chats/dispatch`, { method: "PUT", body: { key, entry, run: note.run } });
    PD.pending = PD.pending.filter((x) => x !== p);
    await loadChat(key); boardRefresh(key);
    const host = pmHost(), source = host.ST?.nodes.find((n) => n.key === key), ws = plan.workspace || {};
    let after = source;
    for (const t of entry.tasks) {
      // The task window must display the same choice as the dispatched request.
      if (effort) {
        try { localStorage.setItem('pga_chat_choice:' + S.uid + ':' + t.key, JSON.stringify({agent:t.agent, model:'', effort})); } catch {}
      }
      if (host.stOpen) after = host.stOpen(t.key, after ? { win: after.id } : undefined) || after;
      S.dispatchLive[t.key] = "running";
      const body = { conversation: t.key, agent: t.agent, text: t.text === text ? text : t.text + "\n\n原始需求（仅作为背景与约束，只执行上面分配的任务）：\n" + text,
        failover: true, fallback: t.fallback, ...(effort ? { effort } : {}) };                // it fails: the next agent by the same rules takes it
      // Held to this category on the server: its context, the web, nothing else of PGA (pga.project_context.scope_of).
      if (t.scoped && PM.name) {
        // Title/view updates also write user preferences. Reconfirm membership after those finish.
        await api(`/v1/users/${S.uid}/conversation-projects`, {body:{key:t.key, project:PM.name}});
        body.scope = PM.name;
      }
      // A job that needs an existing conversation's context: the server reads that conversation's latest turns, if it is of this category.
      if (t.from) body.history_from = t.from;
      // The task's window shows its question while the agent works (app-live.js watches runs it did not start).
      try { const top = window.top; (top.__pgaPendingAsk ||= {})[t.key] = body.text; } catch {}
      // An agent with tools works in the category's project folder unless the conversation it grew from had its own.
      if (t.tools && ws.folder) {
        try { await loadAcc(t.key, true); } catch {}
        const a = S.acc?.[t.key];
        Object.assign(body, { access: "write", folder: ws.folder, mcp: false });
      }
      api(`/v1/users/${S.uid}/agents/ask`, { body })
        .then((r) => {
          S.dispatchLive[t.key] = r?.ok === false || r?.error ? "error" : "done";
          if (S.dispatchLive[t.key] === "error") PD.errors[t.key] = r?.error || L("任务执行失败", "Task failed");
          const failed = (r?.tried || []).filter((x) => x.agent && x.agent !== r?.agent && x.error);
          if (failed.length) (S.dispatchSwitch ||= {})[t.key] = { failed, to: r?.ok ? r.agent : null };
        })
        .catch(err => { S.dispatchLive[t.key] = "error"; PD.errors[t.key] = err.message || String(err); pdRender(); })
        .finally(() => { dispatchWindowRefresh(t.key, S.dispatchLive[t.key]); boardRefresh(key); });
    }
  } catch (err) { p.error = err.message; if (!PD.pending.includes(p)) PD.pending.push(p); pdRender(); }
}
// The normal manager composer uses the same dispatch policy as its document input.
const pdOriginalSend = chatSend;
chatSend = async function (...args) {
  if (!String(S.chat || '').startsWith('chat:pm-')) return pdOriginalSend(...args);
  const input=document.querySelector('#chatText'), text=input?.value.trim();
  if (!text) return;
  if (S.att?.length) { toast(L('请先将附件加入项目资料，再分配任务','Add attachments to project context before assigning')); return; }
  input.value=''; S.chatDraft='';
  return pdSend(text);
};
window.pdBeside = function (key) {                   // the conversation stands right beside the manager on the stage
  const host = pmHost(); if (!key) return;
  const source = pdKey();
  host.document.querySelector('#pmfullscreen')?._close?.();
  if (typeof host.stBringBeside === 'function') {
    if (host.S?.view !== 'stage') host.show?.('stage');
    return host.stBringBeside(key, source);
  }
  return mgGo(key);
};

document.addEventListener("click", (e) => {
  if (!pdOn()) return;
  const more = e.target.closest("[data-pdmore]");
  if (more) { const id = more.dataset.pdmore; PD.open.has(id) ? PD.open.delete(id) : PD.open.add(id); pdRender(); return; }
  const link = e.target.closest('a[data-pdgo]');
  if (link) { e.preventDefault(); pdBeside(link.dataset.pdgo); return; }
  if (e.target.closest("a, button")) return;
  const go = e.target.closest("[data-pdgo]"); if (go) pdBeside(go.dataset.pdgo);
});
setInterval(() => { if (pdOn()) pdRender(); }, 3000);   // dispatched parts report in via taskState (app-dispatch.js polls them)
