/* PGA app · a category's manager as a document (inside the manager's own frame; app-manager.js builds the panes).
   - You write on one sheet. Enter sends the paragraph the cursor is in (Shift+Enter inserts a new line); ⌘↵ sends the whole draft.
   - The server splits and schedules independent tasks, recording each one before launching its worker.
   - Assigned paragraphs link to the destination conversation that shows their output.
   Sent paragraphs are the manager conversation's own turns (a note each) and the parts its dispatch entries, so the
   document is the conversation, read differently. */

const PD = { pending: [], live: {}, errors: {}, open: new Set(), sig: "" };
const pdContinuing = new Set();
function pdNotice(t) {                              // a task the manager handed out came back: a reminder card, as for any page (app-core.js notice)
  const bad = S.dispatchLive[t.key] === "error";
  notice({ kind: bad ? "warn" : "done", key: t.key, project: PM.name, prio: 2, title: L(`管理员 · ${t.title || pdTitle(t.key)}`, `Manager · ${t.title || pdTitle(t.key)}`),
    text: bad ? L(`这一项没做成：${PD.errors[t.key] || ""}`, `This one failed: ${PD.errors[t.key] || ""}`).replace(/[：:] $/, "") : L("这一项做完了 · 点一下查看", "This one is done · click to see it"),
    onClick: () => { try { const top = window.top; top.stOpen?.(t.key); } catch {} } });
}
// Keep the choice outside the DOM: manager refreshes must not reset a question's strength.
const pdEffortChoices = new Map();
const pdConversationChoices = new Map();
const pdChoiceKey = () => S.uid + ':' + pdKey();
function pdConversationControl() {
  const defaults = PM.data?.defaults || {};
  return `<div class="pd-defaults">${Object.values(defaults).map(x => `<a href="?view=chats&c=${encodeURIComponent(x.key)}" data-pdgo="${esc(x.key)}">${esc(x.title)} ↗</a>`).join('')}</div>`;
}
function pdConversationSet(on) {
  pdConversationChoices.set(pdChoiceKey(), on);
  document.querySelectorAll('[data-pd-create]').forEach(b => { b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on); });
}
const PD_EFFORTS = [
  ['', '自动', 'Auto'], ['none', '关闭', 'Off'], ['minimal', '极低', 'Minimal'],
  ['low', '低', 'Low'], ['medium', '中', 'Medium'], ['high', '高', 'High'],
  ['xhigh', '极高', 'Extra high'], ['max', 'Max', 'Max'], ['ultra', 'Ultra', 'Ultra'],
];
function pdEffortControl() {
  return `<label class="pd-effort"><span>${L('思考强度', 'Reasoning')}</span><input type="range" min="0" max="${PD_EFFORTS.length - 1}" step="any" value="0" data-pd-effort aria-label="${L('思考强度', 'Reasoning')}" aria-valuetext="${L('自动', 'Auto')}"><output>${L('自动', 'Auto')}</output></label>`;
}
function pdEffortSet(control, value) {
  pdEffortChoices.set(pdKey(), value);
  const input = control.querySelector('[data-pd-effort]');
  input.value = String(value);
  const [, zh, en] = PD_EFFORTS[Math.round(value)];
  const label = L(zh, en);
  input.setAttribute('aria-valuetext', label);
  control.querySelector('output').textContent = label;
}
function pdEffortTake() {
  const [effort] = PD_EFFORTS[Math.round(pdEffortChoices.get(pdKey()) || 0)];
  pdEffortChoices.delete(pdKey());
  document.querySelectorAll('.pd-effort').forEach(control => pdEffortSet(control, 0));
  return effort;
}
document.addEventListener('input', e => {
  if (e.target.matches?.('[data-pd-effort]')) pdEffortSet(e.target.closest('.pd-effort'), Number(e.target.value));
});
document.addEventListener('click', e => {
  if (e.target.closest('[data-pd-create]')) { e.preventDefault(); pdConversationSet(!pdConversationChoices.get(pdChoiceKey())); return; }
});
const PD_MARK = "〔管理员任务 #";                       // a part the manager answers itself: asked in its own conversation, shown as a comment
const pdKey = () => S.chat;
const pdOn = () => !!document.querySelector("#pmdoc");
function pdVisible() {                           // category managers stay mounted in the stage pane; hidden documents need not poll
  if (!pdOn() || document.hidden) return false;
  try { for (let e = window.frameElement; e; e = e.parentElement) if (e.hidden) return false; } catch {}
  return true;
}
const pdDraftKey = () => "pga_pmdoc_draft:" + pdKey();
const pdTitle = (k) => PM.m?.names.get(k) || PM.m?.by.get(k)?.title || (typeof stTitle === "function" ? stTitle(k) : "") || L("新对话", "New conversation");
const pdPlain = (t) => String(t || "").replace(/```[\s\S]*?```/g, " ").replace(/[#*_`>|-]+/g, " ").replace(/\s+/g, " ").trim();
const pdActivityState = (a) => a.status === 'SUCCEEDED' ? 'done' : a.status === 'FAILED' ? 'error' : 'running';

/* ------------------------------------------------ what the document holds */
function pdModel() {
  const key = pdKey(), turns = S.chatTurns[key] || [], entries = S.chatDispatch?.[key] || [];
  const answer = new Map(), mine = new Map();
  for (const t of turns) {
    if (t.role !== "user" && t.run) answer.set(t.run, t);
    const m = t.role === "user" && String(t.text || "").startsWith(PD_MARK) && String(t.text).slice(PD_MARK.length).match(/^(\w+)〕/);
    if (m) mine.set(m[1], t.run);
  }
  // Match shared-conversation tasks by their durable task ID. Legacy one-off tasks
  // use their first input; later inputs and steering remain separate rows.
  const activity = PD.activity || [], firstInput = new Map(), represented = new Set();
  const byTask = new Map(activity.filter(a => a.manager_task_id && !String(a.id || '').includes(':steer:')).map(a => [a.manager_task_id, a]));
  for (const a of activity) {
    if (String(a.id || '').includes(':steer:')) continue;
    const first = firstInput.get(a.key);
    if (!first || String(a.at || '').localeCompare(String(first.at || '')) < 0) firstInput.set(a.key, a);
  }
  const rows = [];
  for (const t of turns) {
    if (t.role !== "user" || String(t.text || "").startsWith(PD_MARK)) continue;
    const entry = entries.find((e) => e.run === t.run);
    const notes = entry ? entry.tasks.map((x, i) => {
      const a = !x.manager && (x.task_id ? byTask.get(x.task_id) : firstInput.get(x.key));
      if (a) represented.add(a.id);
      return pdTaskNote(entry, x, i, answer, mine, a);
    }) : answer.has(t.run) ? [pdAnswerNote(answer.get(t.run), t.run)] : [];
    if (entry?.tasks.length > 1) {
      entry.tasks.forEach((task, i) => rows.push({id:(t.run || t.at) + ':' + i,
        text:task.text || task.title, original:t.text, pictures:i === 0 ? t.manager_pictures : null, at:t.at, notes:[notes[i]]}));
    } else rows.push({ id: t.run || t.at, text: t.text, pictures:t.manager_pictures, at: t.at, notes });
  }
  for (const a of activity) {
    if (represented.has(a.id)) continue;
    rows.push({id: 'activity:' + a.id, text: a.text, at: a.at, notes: [{
      ...pdConversationInfo(a.key), id: a.id, key: a.key, run: String(a.id || '').includes(':') ? '' : a.id, find: a.text, who: pdTitle(a.key), title: L(`在「${pdTitle(a.key)}」`, `In “${pdTitle(a.key)}”`), why: pdPlain(a.answer).slice(0, 300),
      st: pdActivityState(a), unread: a.result_unread, archived: a.archived, body:a.answer || a.error || '',
      dispatched:!!a.manager_task_id && !String(a.id).includes(':steer:'), taskId:a.manager_task_id, worker:a.worker, agent:a.agent, model:a.model, effort:a.effort, requested_effort:a.requested_effort,
      progress:a.progress || [], standalone:a.create_conversations === true
    }]});
  }
  rows.sort((a,b) => String(a.at || '').localeCompare(String(b.at || '')));
  for (const p of PD.pending.filter(p => p.key === key && p.uid === S.uid)) rows.push({ id: p.id, text: p.text, pictures:p.body?.images?.map(im=>({url:im.data, paragraph:im.paragraph || 0})), notes: [{ id: p.id + ":p", who: L("管理员", "Manager"), st: p.error ? "error" : "running", title: p.error ? L("没能分配", "Could not assign") : p.phase, retry: p.error ? p.id : "", body: p.error || "" }] });
  return rows;
}
function pdAnswerNote(a, id) {
  return { id: "a:" + id, key:pdKey(), who: L("管理员", "Manager"), dispatched:!!a.manager_task_id && !String(a.id).includes(':steer:'), taskId:a.manager_task_id, worker:a.worker, agent:a.agent, model:a.model, effort:a.effort,
    progress:a.progress || [], st: a.error && !a.text ? "error" : "done", title: L("管理员已回复", "The manager replied"), body: a.text || a.error || "" };
}
function pdConversationInfo(key) {
  const [conversationKind, destination] = Object.entries(PM.data?.defaults || {}).find(([, d]) => d.key === key) || [];
  return {conversationKind, conversationTitle: destination?.title || pdTitle(key)};
}
function pdTaskNote(entry, x, i, answer, mine, activity) {
  const id = entry.id + ":" + i;
  if (x.manager) {
    const run = mine.get(entry.id), a = run && answer.get(run);
    const st = a ? (a.error && !a.text ? "error" : "done") : PD.live[entry.id] === "error" ? "error" : "running";
    return { id, key:pdKey(), who: L("管理员", "Manager"), st, title: x.title, body: a ? a.text || a.error || "" : "" };
  }
  const s = !x.task_id && typeof taskState === "function" ? taskState(x.key) : { st: "running" };
  const sw = S.dispatchSwitch?.[x.key], name = (a) => typeof agentLabel === "function" ? agentLabel(a) : a;
  const why = sw ? L(`${sw.failed.map((f) => name(f.agent)).join("、")} 没完成${sw.to ? `，已改由 ${name(sw.to)} 处理` : "，后面的 agent 也都没完成"}`,
    `${sw.failed.map((f) => name(f.agent)).join(", ")} failed${sw.to ? `; ${name(sw.to)} took over` : "; no agent could finish it"}`) : x.why || "";
  const reports = activity?.dispatch_reports || sw?.failed?.map(f => ({...f, to:sw.to})) || [];
  const report = reports.map(f => `${name(f.agent)}：${f.error || "执行失败"}；${f.to ? `已切换 ${name(f.to)}` : "无可用替补，已停止"}`).join("；");
  const check = activity?.start_check;
  return { ...pdConversationInfo(x.key), report: [report, check ? `10 秒回查：${check.message}` : "", reports.length ? (activity?.status === 'SUCCEEDED' ? '替换后已完成' : activity?.status === 'FAILED' ? '替换后仍失败' : '替换任务处理中') : ""].filter(Boolean).join(" · "), id, key: x.key, worker:x.worker || activity?.worker, taskId:x.task_id, dispatched:true, run: activity?.id || '', find: activity?.text || x.text || x.title, who: L('管理员', 'Manager'), agent: activity?.agent || s.last?.agent || x.agent, why,
    model:activity?.model || s.last?.model, effort:activity ? activity.effort : s.last?.actual_effort || s.last?.how?.effort,
    requested_effort:activity?.requested_effort || x.effort || entry.effort,
    progress:activity?.progress || s.last?.progress || [], standalone:x.create_conversations === true || entry.create_conversations === true,
    st: x.task_id ? (activity ? pdActivityState(activity) : "running") : PD.errors[x.key] ? "error" : activity ? pdActivityState(activity) : s.st, title: x.title, unread: activity?.result_unread, archived: activity?.archived,
    body: PD.errors[x.key] || (activity ? activity.answer || activity.error : s.last?.text || s.last?.error) || "" };
}

/* ------------------------------------------------ drawing */
function pdTargetAttrs(n) {
  return n?.key ? `data-pdgo="${esc(n.key)}" data-pdrun="${esc(n.run || '')}" data-pdfind="${esc(String(n.find || '').slice(0, 200))}"` : '';
}
function pdScrollBind(box) {
  if (box._pdScroll) return;
  const key = 'pga_pm_scroll:' + S.uid + ':' + pdKey();
  let saved;
  try { saved = JSON.parse(localStorage.getItem(key)); } catch {}
  box._pdScroll = saved && Number.isFinite(saved.top) ? {top:Math.max(0,saved.top), bottom:!!saved.bottom} : {top:0,bottom:true};
  const button = document.createElement('button');
  button.className = 'pd-to-bottom'; button.type = 'button'; button.hidden = true;
  button.textContent = L('↓ 一键到底', '↓ Jump to bottom');
  button.addEventListener('click', () => window.pdScrollBottom());
  box.parentNode.appendChild(button); box._pdBottomButton = button;
  box._pdSaveScroll = () => { try { localStorage.setItem(key, JSON.stringify(box._pdScroll)); } catch {} };
  box.addEventListener('scroll', () => {
    if (!box.clientHeight) return;
    if (box.scrollTop !== box._pdProgramTop) {
      box._pdScroll = {top:box.scrollTop, bottom:box.scrollHeight-box.clientHeight-box.scrollTop < 40};
      box._pdSaveScroll();
    }
    pdScrollButton(box);
  }, {passive:true});
  const observer = new ResizeObserver(() => pdScrollRestore(box));
  observer.observe(box); observer.observe(box.querySelector('.pdhistory-content'));
  box._pdScrollObserver = observer;
}
function pdScrollButton(box) {
  if (box._pdBottomButton) box._pdBottomButton.hidden = !box.clientHeight || box.scrollHeight-box.clientHeight-box.scrollTop < 40;
}
function pdScrollRestore(box) {
  if (!box?._pdScroll || !box.clientHeight) return;
  box.scrollTop = box._pdScroll.bottom ? box.scrollHeight : box._pdScroll.top;
  box._pdProgramTop = box.scrollTop;
  pdScrollButton(box);
}
window.pdRestoreScroll = function () {
  pdRender(); pdScrollRestore(document.querySelector('#pmdoc .pdhistory'));
};
window.pdScrollBottom = function () {
  const box = document.querySelector('#pmdoc .pdhistory'); if (!box) return;
  pdScrollBind(box); box._pdScroll = {top:0,bottom:true};
  pdScrollRestore(box); box._pdSaveScroll();
};
function pdExecution(n) {
  const agent = n.agent && n.agent !== 'auto' ? (typeof agentLabel === 'function' ? agentLabel(n.agent) : n.agent) : L('待分配', 'Pending');
  const value = n.effort || n.requested_effort;
  const level = PD_EFFORTS.find(([key]) => key === value);
  const label = value === 'default' ? L('模型默认', 'Model default') : level && value ? L(level[1], level[2]) : value;
  const effort = n.effort ? label : label ? L('请求值 · ', 'Requested · ') + label
    : n.st === 'running' ? L('等待上报', 'Awaiting report') : L('未记录', 'Unrecorded');
  return `<div class="pdexecution">${esc([agent, n.model, L('推理强度：', 'Reasoning effort: ') + effort].filter(Boolean).join(' · '))}</div>`;
}
function pdNoteHtml(n) {
  const state = n.st === 'running' ? `<span class="spin"></span>` : n.st === 'error' ? '⚠' : '✓';
  const status = n.st === 'running' ? L('等待或处理中', 'Queued or working') : n.st === 'error' ? L('未完成', 'Not completed') : L('已完成', 'Done');
  const label = n.conversationTitle || n.title || (n.key ? pdTitle(n.key) : status);
  return `<div class="pdnote pdroute ${n.st}" ${pdTargetAttrs(n)}><span class="pdst" title="${esc(status)}">${state}</span>
    ${n.key ? `<a class="pdresultlink" href="?view=chats&c=${encodeURIComponent(n.key)}" ${pdTargetAttrs(n)} title="${esc(label)} · ${esc(status)}">${esc(label)} ↗</a>` : `<span>${esc(label)}${n.st === 'error' && n.body ? ' · ' + esc(n.body) : ''}</span>`}
    ${n.st === 'done' && n.unread ? `<strong class="pd-unread">${L('待查看', 'Unread')}</strong>` : ''}
    ${n.retry ? `<button type="button" class="pdretry" data-pdretry="${esc(n.retry)}" aria-label="${L('重新分配', 'Retry assignment')}" title="${L('重新分配', 'Retry assignment')}">↻</button>` : ''}
    </div>`;
}
function pdRowHtml(r) {
  const target = r.notes.find(n => n.key);
  const original = r.original ? `<details class="pdoriginal"><summary>${L("完整需求", "Original request")}</summary>${esc(r.original)}</details>` : '';
  const paragraphs = (r.original || r.text || '').split(/\n(?:[^\S\n]*\n)+/);
  const gallery = !r.pictures?.length ? '' : paragraphs.map((paragraph,i) => {
    const images = r.pictures.filter(pic=>pic.paragraph === i);
    if (!images.length) return '';
    return `<div class="pd-gallery">${paragraphs.length > 1 ? `<div>${esc(paragraph)}</div>` : ''}<div class="thumbs">${images.map(pic=>`<img loading="lazy" src="${esc(pic.url)}" alt="${L('附图','Attached image')}">`).join('')}</div></div>`;
  }).join('');
  const rowId = `data-pdrow="${esc(r.id || '')}" ${pdTargetAttrs(target)}`;
  if (target?.conversationTitle) {
    const color = target.conversationKind === 'execute' ? 'var(--blue)' : target.conversationKind === 'qa' ? 'var(--green)' : `hsl(${hueOf(target.key)} 55% 55%)`;
    const text = esc(r.text);
    return `<div class="pdrow pdassigned" ${rowId}><div class="pdpara pdbar" style="--pd-color:${color}" data-pdworker="${esc(target.worker || '')}" ${pdTargetAttrs(target)}>
      <span class="pdbar-text" title="${text}">${text}</span>${pdNoteHtml(target)}</div>${target.dispatched || target.taskId ? pdExecution(target) : ''}${original}${gallery}</div>`;
  }
  return `<div class="pdrow" ${rowId}><div class="pdpara" ${pdTargetAttrs(target)}>${esc(r.text)}</div>${original}${gallery}<div class="pdnotes">${r.notes.map(n => pdNoteHtml(n) + (n.dispatched || n.taskId ? pdExecution(n) : '')).join('')}</div></div>`;
}
window.pdRender = function () {
  if (S.stageDormant || S.stageMotion) { PD.renderPending = true; return; }
  PD.renderPending = false;
  const box = document.querySelector("#pmdoc");
  if (!box) {
    const row = document.querySelector('#chatText')?.closest('.cbar');
    if (String(S.chat || '').startsWith('chat:pm-') && row && !row.querySelector('.pd-effort')) { row.insertAdjacentHTML('beforeend', pdEffortControl() + pdConversationControl()); pdEffortSet(row.querySelector('.pd-effort'), pdEffortChoices.get(pdKey()) || 0); }
    return;
  }
  const activityKey = S.uid + ':' + PM.name + ':' + pdKey();
  if (PD.activityKey !== activityKey) {
    PD.activityKey = activityKey; PD.activity = []; PD.sig = '';
    pdRefreshActivity();
  }
  if (!box.querySelector(".pdpaper")) {
    PD.sig = '';
    box.innerHTML = `<div class="pdpaper"><div class="pdhistory"><div class="pdhistory-content">${pdConversationControl()}<div class="pdrows"></div><div class="pdpreviews"></div></div></div>
      <div class="pdrow pddraftrow"><div class="pdpara"><textarea id="pdDraft" rows="3" placeholder="${L("Enter 发送这一段，Shift+Enter 换行；点击下方空白写下一段。", "Enter sends this paragraph; Shift+Enter adds a line. Click below to write the next paragraph.")}"></textarea></div>
      <div class="pdnotes"><div class="atts pdatts"></div><button type="button" class="pdattach" data-pdattach title="${L("附上图片或文档（也可以粘贴或拖进来）", "Attach images or documents (or paste / drop them)")}">📎 ${L("附件", "Attach")}</button>${pdEffortControl()}<button type="button" class="pdsend" data-pdsend>${L("发送", "Send")}</button></div></div></div>`;
    const ta = box.querySelector("#pdDraft");
    try { ta.value = localStorage.getItem(pdDraftKey()) || ""; } catch {}
    pdWire(ta); pdAttWire(box); if (pdParts.has(pdChoiceKey())) pdRenderParts(ta);
    const control = box.querySelector('.pd-effort');
    pdEffortSet(control, pdEffortChoices.get(pdKey()) || 0);
  }
  const shortcuts = box.querySelector('.pd-defaults');
  if (shortcuts) {
    const html = pdConversationControl();
    if (shortcuts.outerHTML !== html) shortcuts.outerHTML = html;
  }
  const history = box.querySelector(".pdhistory");
  pdScrollBind(history);
  pdRefreshDrafts();
  const rows = pdModel();
  const sig = JSON.stringify([rows, [...PD.open]]);
  if (sig === PD.sig) { pdScrollButton(history); return; } PD.sig = sig;
  const anchor = pdEditorAnchor(history);
  const list = box.querySelector(".pdrows");
  list.innerHTML = rows.length ? rows.map(pdRowHtml).join("")
    : `<div class="pdempty">${L("在下方写下需求；点击任务入口切换到对应对话。", "This is the manager's document. Write below; the manager hands the work to this category's conversations.")}</div>`;
  if (anchor) {
    pdRestoreEditor(history, anchor);
    if (!history._pdScroll.bottom) history._pdScroll.top = history.scrollTop;
  }
  pdScrollRestore(history);
};
const pdFit = (ta) => {
  const style = getComputedStyle(ta), signature = [ta.value, ta.clientWidth, style.font, style.lineHeight].join('\0');
  if (ta._pdFitSignature === signature) return;
  ta._pdFitSignature = signature;
  // Measure out of flow: shrinking the live textarea temporarily clamps its parent's scroll position.
  const probe = ta.cloneNode(false);
  probe.setAttribute('aria-hidden', 'true');
  probe.tabIndex = -1; probe.value = ta.value;
  Object.assign(probe.style, {position:'absolute', visibility:'hidden', pointerEvents:'none', height:'0px', minHeight:'0px', width:style.width});
  ta.parentNode.appendChild(probe);
  const height = Math.max(72, probe.scrollHeight + (ta.offsetHeight - ta.clientHeight));
  probe.remove();
  if (ta.style.height !== height + 'px') ta.style.height = height + 'px';
};
function pdEditorAnchor(box) {
  const input = document.activeElement;
  return box.contains(input) && input?.matches('textarea') ? {input, top:input.getBoundingClientRect().top} : null;
}
function pdRestoreEditor(box, anchor) {
  if (anchor?.input.isConnected) box.scrollTop += anchor.input.getBoundingClientRect().top - anchor.top;
}
// Read the live composers, including IME text and programmatic clears after sending.
// Drafts remain local previews: never write them to history or dispatch them to an agent.
function pdDraftRows() {
  const host = pmHost(), rows = [];
  if (!PM.name || typeof host.stGroupOf !== 'function') return rows;
  for (const n of host.ST?.nodes || []) {
    if (n.type !== 'win' || n.managerProject || n.key?.startsWith('chat:pm-') || host.stGroupOf(n)?.id !== 'pj:' + PM.name) continue;
    try {
      const frame = n.el?.querySelector('iframe'), state = frame?.contentWindow?.S;
      if (!state || state.uid !== S.uid || (state.chat && n.key && state.chat !== n.key)) continue;
      const text = frame.contentDocument?.querySelector('#chatText')?.value || '';
      if (text.trim()) rows.push({id:n.id, key:n.key, text, title:pdTitle(n.key)});
    } catch {} // inaccessible or unloading frames have no preview
  }
  return rows;
}
function pdRefreshDrafts() {
  if (S.stageDormant || S.stageMotion || !pdVisible()) return;
  const box = document.querySelector('#pmdoc .pdhistory'), list = box?.querySelector('.pdpreviews');
  if (!list) return;
  const anchor = pdEditorAnchor(box);
  const rows = pdDraftRows();
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  const wanted = new Set(rows.map(r => r.id));
  for (const el of list.querySelectorAll('[data-pdpreview]')) {
    if (!wanted.has(el.dataset.pdpreview)) {
      const source = pdDraftSource(el.dataset.pdpreview), input = el.querySelector('[data-pdedit]');
      if (el.contains(document.activeElement) && source) {
        if (!input._pdComposing && input.value !== source.input.value) input.value = source.input.value;
      } else el.remove();
    }
  }
  for (const r of rows) {
    let el = [...list.children].find(e => e.dataset.pdpreview === r.id);
    if (!el) {
      el = document.createElement('div'); el.className = 'pdrow'; el.dataset.pdpreview = r.id;
      el.innerHTML = `<div class="pdpara"><textarea data-pdedit rows="2"></textarea></div><div class="pdnotes"><div class="pdnote draft"><div class="pdnh"><span class="pdst">✎</span><span class="pdnt"></span><button type="button" data-pddraftsend>${L('发送', 'Send')}</button></div></div></div>`;
      list.appendChild(el);
    }
    const input = el.querySelector('[data-pdedit]');
    if (input.value !== r.text && !input._pdComposing) input.value = r.text;
    input.setAttribute('aria-label', L('未发送 · ', 'Unsent · ') + r.title);
    el.querySelector('.pdnt').textContent = L('未发送 · ', 'Unsent · ') + r.title;
    pdFit(input);
  }
  if (anchor) pdRestoreEditor(box, anchor);
  else if (box._pdScroll?.bottom ?? stick) box.scrollTop = box.scrollHeight;
  pdScrollButton(box);
}
function pdDraftSource(id) {
  const host = pmHost(), n = host.ST?.nodes.find(n => n.id === id);
  if (!n || n.managerProject || host.stGroupOf?.(n)?.id !== 'pj:' + PM.name) return null;
  try {
    const w = n.el?.querySelector('iframe')?.contentWindow, input = w?.document.querySelector('#chatText');
    if (!input || w.S?.uid !== S.uid || (w.S.chat && n.key && w.S.chat !== n.key)) return null;
    return {w, input};
  } catch { return null; }
}
function pdEditDraft(input) {
  const source = pdDraftSource(input.closest('[data-pdpreview]').dataset.pdpreview);
  if (!source) return;
  source.input.value = input.value; source.w.S.chatDraft = input.value;
  source.input.dispatchEvent(new source.w.Event('input', {bubbles:true}));
  pdFit(input);
}
document.addEventListener('input', e => { if (e.target.matches?.('[data-pdedit]')) pdEditDraft(e.target); });
document.addEventListener('compositionstart', e => { if (e.target.matches?.('[data-pdedit]')) e.target._pdComposing = true; });
document.addEventListener('compositionend', e => { if (e.target.matches?.('[data-pdedit]')) { e.target._pdComposing = false; pdEditDraft(e.target); } });
document.addEventListener('click', async e => {
  const button = e.target.closest('[data-pddraftsend]'); if (!button || button.disabled) return;
  const row = button.closest('[data-pdpreview]'), source = pdDraftSource(row.dataset.pdpreview);
  if (!source) return;
  pdEditDraft(row.querySelector('[data-pdedit]'));
  button.disabled = true;
  try {
    const send = source.w.S.lineView ? source.w.lineSend : source.w.S.imp ? source.w.impSend : source.w.chatSend;
    await send?.call(source.w);
  } catch (err) { toast(err.message); }
  finally { button.disabled = false; if (!source.input.value.trim()) row.remove(); pdRefreshDrafts(); }
});
setInterval(pdRefreshDrafts, 150);
function pdWire(ta) {
  ta.addEventListener("input", () => { try { localStorage.setItem(pdDraftKey(), ta.value); } catch {} });
  ta.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229 || e.repeat || e.key !== "Enter") return;
    if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { // Enter: current paragraph
      e.preventDefault(); const p = pdParaAt(ta.value, ta.selectionStart); if (!p.text) return;
      pdTake(ta, p.end, p.start); pdSend(p.text); return;
    }
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); const t = ta.value.trim(); if (t) { pdTake(ta, ta.value.length); pdSend(t); } }
  });
}
/* Attachments of the next send: pictures and documents go with every task it is split into (agents/ask takes them). */
const pdParts = new Map();
function pdRenderPartFiles(input, part) {
  let pics = input.nextElementSibling;
  if (!pics?.matches('.atts')) pics = null;
  if (!part.files.length) { pics?.remove(); return; }
  if (!pics) {
    pics = document.createElement('div'); pics.className = 'atts'; input.after(pics);
  }
  pics.innerHTML = part.files.map((a,i)=>`<span class="att">${a.type.startsWith('image/') && a.data ? `<img src="${esc(a.data)}" alt="${esc(a.name)}">` : esc(a.name)}<button type="button" data-pdremove="${i}" data-part-index="${input.dataset.part}" aria-label="${L('移除附件','Remove attachment')}">×</button></span>`).join('');
}
function pdRenderParts(ta, focus = 0, caret = null) {
  const parts = pdParts.get(pdChoiceKey());
  let list = ta.parentElement.querySelector('.pd-parts');
  if (!parts?.length) { list?.remove(); ta.hidden = false; return; }
  ta.hidden = true;
  if (!list) { list = document.createElement('div'); list.className = 'pd-parts'; ta.after(list); }
  list.replaceChildren();
  for (const [index, part] of parts.entries()) {
    const input = document.createElement('textarea');
    input.rows = 1; input.value = part.text; input.dataset.part = index;
    input.setAttribute('aria-label', L('草稿段落','Draft paragraph'));
    list.append(input);
    pdRenderPartFiles(input, part);
    if (index === focus && caret !== null) { input.focus(); input.setSelectionRange(caret,caret); }
  }
}
function pdSyncParts(ta,parts) {
  ta.value = parts.map(p=>p.text).join('\n\n');
  try { localStorage.setItem(pdDraftKey(),ta.value); } catch {}
}
function pdSendParts(ta,index) {
  const parts = pdParts.get(pdChoiceKey());
  if (!parts) return false;
  const selected = index == null ? parts : parts.slice(index,index+1);
  if (selected.some(p=>p.files.some(a=>!a.data))) { toast(L('附件正在读取','Loading attachment')); return true; }
  if (selected.some(p=>p.files.length && !p.text.trim())) { toast(L('请在附图所在段落输入文字','Add text to the paragraph with the attachment')); return true; }
  const used = selected.filter(p=>p.text.trim());
  if (!used.length) return true;
  const images=[], files=[];
  used.forEach((p,paragraph)=>p.files.forEach(a=>(a.type.startsWith('image/') ? images : files).push({name:a.name,data:a.data,paragraph})));
  const remaining = parts.filter(p=>!selected.includes(p));
  pdSyncParts(ta,remaining);
  if (remaining.some(p=>p.files.length)) pdParts.set(pdChoiceKey(),remaining);
  else pdParts.delete(pdChoiceKey());
  pdRenderParts(ta,Math.max(0,Math.min(index || 0,remaining.length-1)),0);
  if (!ta.hidden) ta.focus();
  pdSend(used.map(p=>p.text.trim()).join('\n\n'),{images,files}); return true;
}
function pdAttWire(box) {
  if (box._pdAtt) return; box._pdAtt = true;
  const ta = box.querySelector('#pdDraft');
  let active = 0;
  function add(files, fromPaste = false) {
    const key = pdChoiceKey();
    let parts = pdParts.get(key);
    let caret = null;
    if (!parts) {
      const split = /\n(?:[^\S\n]*\n)+/g;
      const gaps = [...ta.value.matchAll(split)].filter(m=>m.index+m[0].length<=ta.selectionStart);
      active = gaps.length;
      const last = gaps.at(-1);
      if (fromPaste) caret = ta.selectionStart - (last ? last.index + last[0].length : 0);
      parts = ta.value.split(split).map(text=>({text,files:[]}));
    }
    active = Math.min(active,parts.length-1);
    const part = parts[active];
    const previousCount = part.files.length;
    for (const file of [...files].slice(0,Math.max(0,6-parts.reduce((n,p)=>n+p.files.length,0)))) {
      if (file.size>20e6) { toast(L('附件超过 20 MB','Attachment exceeds 20 MB')); continue; }
      const item = {name:file.name || 'pasted.png',type:file.type || 'application/octet-stream'};
      part.files.push(item);
      const reader = new FileReader();
      reader.onload = ()=>{item.data=reader.result; finishRead(item);};
      reader.onerror = ()=>{finishRead(item, true); toast(L('读取附件失败','Could not read attachment'));};
      reader.readAsDataURL(file);
    }
    if (part.files.length === previousCount) return;
    if (!pdParts.has(key)) {
      pdParts.set(key,parts);
      pdRenderParts(ta,active,caret);
    } else {
      const input = box.querySelector(`textarea[data-part="${active}"]`);
      pdRenderPartFiles(input, part);
      if (fromPaste) input.focus();
    }

    function finishRead(item, failed = false) {
      // Editing can split or merge paragraphs while the clipboard image is loading.
      const current = pdParts.get(key);
      const index = current?.findIndex(p=>p.files.includes(item)) ?? -1;
      if (index < 0) return;
      const owner = current[index];
      if (failed) owner.files.splice(owner.files.indexOf(item),1);
      if (key !== pdChoiceKey()) return;
      const input = document.querySelector(`#pmdoc textarea[data-part="${index}"]`);
      if (input) pdRenderPartFiles(input, owner);
    }
  }
  box.addEventListener('focusin',e=>{if(e.target.matches('textarea[data-part]'))active=Number(e.target.dataset.part);});
  box.addEventListener('input',e=>{
    const input=e.target;if(!input.matches('textarea[data-part]'))return;
    const parts=pdParts.get(pdChoiceKey()), i=Number(input.dataset.part), part=parts[i];
    part.text=input.value;
    const split=/\n(?:[^\S\n]*\n)+/g, chunks=input.value.split(split);
    if (chunks.length>1 && !e.isComposing) {
      const next=[...input.value.matchAll(split)].filter(m=>m.index+m[0].length<=input.selectionStart);
      const offset=next.length ? next.at(-1).index+next.at(-1)[0].length : 0;
      const keep=chunks.findIndex(text=>text.trim());
      parts.splice(i,1,...chunks.map((text,j)=>({text,files:j===Math.max(0,keep)?part.files:[]})));
      pdRenderParts(ta,i+next.length,input.selectionStart-offset);
    }
    pdSyncParts(ta,parts);
  });
  box.addEventListener('keydown',e=>{
    if (!e.target.matches('textarea[data-part]')) return;
    const input=e.target, i=Number(input.dataset.part), parts=pdParts.get(pdChoiceKey());
    if (e.key==='Backspace' && i>0 && input.selectionStart===0 && input.selectionEnd===0 && !e.isComposing) {
      e.preventDefault();
      const before=parts[i-1], caret=before.text.length;
      before.text+=parts[i].text; before.files.push(...parts[i].files); parts.splice(i,1);
      pdSyncParts(ta,parts); pdRenderParts(ta,i-1,caret); return;
    }
    if (e.key!=='Enter' || e.isComposing || e.keyCode===229 || e.repeat) return;
    if(e.ctrlKey || e.metaKey || (!e.shiftKey && !e.altKey)){e.preventDefault();pdSendParts(ta,e.metaKey||e.ctrlKey?null:Number(e.target.dataset.part));}
  });
  box.addEventListener('paste',e=>{
    if (!e.target.matches('#pdDraft,textarea[data-part]')) return;
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length || (e.clipboardData.getData('text/plain') && !files.some(f=>f.type.startsWith('image/')))) return;
    e.preventDefault();
    add(files, true);
  });
  box.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();e.stopPropagation();}});
  box.addEventListener('drop',e=>{if(e.dataTransfer?.files.length){e.preventDefault();e.stopPropagation();if(e.target.matches('textarea[data-part]'))active=Number(e.target.dataset.part);document.body.classList.remove('dropping');add(e.dataTransfer.files);}});
  box.addEventListener('click',e=>{
    if(e.target.closest('[data-pdattach]')){const picker=document.createElement('input');picker.type='file';picker.multiple=true;picker.onchange=()=>add(picker.files);picker.click();}
    const btn=e.target.closest('[data-pdremove]');
    if(btn){
      const index = Number(btn.dataset.partIndex), part = pdParts.get(pdChoiceKey())[index];
      part.files.splice(Number(btn.dataset.pdremove),1);
      pdRenderPartFiles(box.querySelector(`textarea[data-part="${index}"]`), part);
    }
  });
}
// Reuse the trailing empty paragraph; repeated blank clicks must not add empty rows.
function pdNextParagraph(ta) {
  const parts = pdParts.get(pdChoiceKey());
  if (parts?.length) {
    if (parts.at(-1).text.trim() || parts.at(-1).files.length) parts.push({text:'',files:[]});
    pdSyncParts(ta,parts);
    pdRenderParts(ta,parts.length-1,parts.at(-1).text.length);
    ta.parentElement.querySelector('.pd-parts textarea:last-of-type')?.scrollIntoView({block:'nearest'});
  } else {
    if (ta.value.trim() && !/\n[^\S\n]*\n\s*$/.test(ta.value)) ta.value += '\n\n';
    ta.dispatchEvent(new Event('input',{bubbles:true}));
    ta.focus({preventScroll:true});
    ta.setSelectionRange(ta.value.length,ta.value.length);
    ta.scrollIntoView({block:'nearest'});
  }
}
function pdParaAt(v, c) {                            // paragraphs are separated by blank lines
  let start = 0;
  for (const gap of v.matchAll(/\n(?:[^\S\n]*\n)+/g)) {
    const next = gap.index + gap[0].length;
    if (c < next || (c === next && !v.slice(next).trim())) {
      return {start, end:gap.index, text:v.slice(start, gap.index).trim()};
    }
    start = next;
  }
  return {start, end:v.length, text:v.slice(start).trim()};
}
function pdTake(ta, end, start = 0) {
  let left = ta.value.slice(0, start);
  const right = ta.value.slice(end).replace(/^\n(?:[^\S\n]*\n)*/, '');
  if (!right) left = left.replace(/\n(?:[^\S\n]*\n)*$/, '');
  ta.value = left + right;
  ta.setSelectionRange(left.length, left.length);
  try { localStorage.setItem(pdDraftKey(), ta.value); } catch {}
}

let pdSubmissionId = 0;
async function pdSend(text, at = {images:[],files:[]}) {
  const key = pdKey(); if (!key || !text) return;
  const effort = pdEffortTake();
  const p = { id: "p" + ++pdSubmissionId, key, uid:S.uid, text,
    body:{conversation:key, text, images:at.images, files:at.files, ...(effort ? {effort} : {})},
    phase:L("正在分配…", "Assigning…") };
  PD.pending.push(p);
  return pdSubmitPending(p);
}
function pdRetry(id) {
  const p = PD.pending.find(p => p.id === id && p.key === pdKey() && p.uid === S.uid);
  if (p?.error) return pdSubmitPending(p);
}
async function pdSubmitPending(p) {
  delete p.error;
  pdRender();
  let result;
  try {
    result = await api(`/v1/users/${p.uid}/chats/manager-submit`, {body:p.body});
  } catch (err) {
    p.error = err.message || L('提交失败', 'Submission failed');
    pdRender();
    return;
  }
  PD.pending = PD.pending.filter(x => x !== p);
  const {effort} = p.body;
  for (const t of result.entry.tasks) {
    if (effort) {
      try { localStorage.setItem('pga_chat_choice:' + p.uid + ':' + t.key, JSON.stringify({agent:t.agent, model:'', effort})); } catch {}
    }
  }
  if (p.key !== pdKey() || p.uid !== S.uid) return;
  if (result.defaults && PM.data) PM.data.defaults = result.defaults;
  const entry = result.entry;
  if (entry.run) {
    const turns = (S.chatTurns ||= {})[p.key] ||= [];
    if (!turns.some(t => t.run === entry.run && t.role === 'user')) {
      turns.push({role:'user', run:entry.run, text:p.text, at:entry.at, manager_pictures:result.manager_pictures});
    }
    const entries = (S.chatDispatch ||= {})[p.key] ||= [];
    if (!entries.some(e => e.run === entry.run)) entries.push(entry);
    pdRender();
  }
  try { await loadChat(p.key, {force:true}); boardRefresh(p.key); }
  catch (err) { toast(err.message); }
  pdRender();
}
// The normal manager composer uses the same dispatch policy as its document input.
const pdOriginalSend = chatSend;
chatSend = async function (...args) {
  if (!String(S.chat || '').startsWith('chat:pm-')) return pdOriginalSend(...args);
  const input=document.querySelector('#chatText'), text=input?.value.trim();
  if (!text) return;
  input.value=''; S.chatDraft='';
  const at = takeAtts(); rerenderComposer();
  return pdSend(text, at);
};
window.pdBeside = function (key, run, find) {       // the conversation stands right beside the manager on the stage, at the input it is about
  const host = pmHost(); if (!key) return;
  const source = typeof pmSourceKey === 'function' ? pmSourceKey() : pdKey();
  host.document.querySelector('#pmfullscreen')?._close?.();
  if (typeof Q !== 'undefined' && Q.get('pmpanel') && host === window.parent && host.S?.view === 'chats')
    return host.pjGo(key, run || '', find || '');
  if (typeof host.stBringBeside === 'function') {
    if (host.S?.view !== 'stage') host.show?.('stage');
    const n = host.stBringBeside(key, source);
    if (run || find) pdJumpIn(host, key, run, find);
    return n;
  }
  return run || find ? pjGo(key, run || "", find || "") : mgGo(key);
};
// Once its page has loaded, scroll the conversation to that input (pjJump, app-project.js): by its run, else by its first words.
// Looked at again a few times, as a page still loading re-renders.
function pdJumpIn(host, key, run, find) {
  let tries = 0, found = 0;
  const go = () => {
    let ok = false;
    try {
      const n = host.ST.nodes.find((x) => x.type === "win" && x.key === key);
      ok = !!n?.el?.querySelector("iframe")?.contentWindow?.pjJump?.(run || "", find || "", found > 0);
    } catch {}
    if (ok) { if (++found < 4) setTimeout(go, 800); return; }
    if (++tries < 30) setTimeout(go, 400);
  };
  setTimeout(go, 300);
}

// Resolve the exact question before branching, so later replies never enter the edit branch.
function pdEditPoint(turns, run, find) {
  let i = run ? turns.findIndex(t => t.role === "user" && t.run === run) : -1;
  if (i < 0 && find) i = turns.findIndex(t => t.role === "user" && String(t.text || "").startsWith(find));
  if (i < 0) return null;
  const previous = turns.slice(0, i).reverse().find(t => t.role !== "user" && t.run);
  return { upto: previous?.run || "0", text: turns[i].text || "" };
}
async function pdWaitFor(read) {
  for (let i = 0; i < 120; i++) {
    const value = read(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(L("对话尚未加载完成，请稍后重试", "Conversation is still loading. Please retry."));
}
function pdContinueButtons(key, busy) {
  document.querySelectorAll('[data-pdcontinue]').forEach(b => {
    if (b.dataset.pdcontinue !== key) return;
    b.disabled = busy; b.setAttribute('aria-busy', String(busy));
    b.textContent = busy ? L('正在打开…', 'Opening…') : L('继续对话', 'Continue conversation');
  });
}
// Focus only after the original conversation has loaded. Never replace its
// draft, branch it, or send a new task merely because the user opens a reply.
function pdFocusComposer(w, key, uid) {
  if (w?.S?.uid !== uid || w.S.chat !== key || w.S.view !== 'chats') return false;
  if (w.S.chatLoadErrors?.[key]) throw new Error(w.S.chatLoadErrors[key]);
  if (!w.S.chatTurns?.[key] || w.S.chatLoads?.[key]) return false;
  const manager = key.startsWith('chat:pm-');
  const input = (manager && w.document.querySelector('.pd-parts textarea')) || w.document.querySelector(manager ? '#pdDraft' : '#chatText');
  if (!input || input.disabled || !input.getClientRects().length) return false;
  if (manager) input.scrollIntoView({block:'nearest'});
  else {
    const history = w.document.querySelector('#cdlg');
    if (history) history.scrollTop = history.scrollHeight;
  }
  input.focus({preventScroll:true});
  input.setSelectionRange(input.value.length, input.value.length);
  return true;
}
// Native manager windows open separate web views through the existing bridge.
// A short-lived focus request also reaches a newly created view after it loads,
// without requiring a desktop update or affecting other conversations' focus.
const pdNativeContinueKey = 'pga_continue_chat';
let pdNativeFocusing = '', pdContinueIntent = 0;
function pdTakeNativeContinue() {
  if (!window.PGA_NATIVE?.float || window.PGA_NATIVE.manager) return;
  let raw, request;
  try { raw = localStorage.getItem(pdNativeContinueKey); request = JSON.parse(raw); } catch { return; }
  if (!request || !Number.isFinite(request.at) || request.key !== pdKey() || Date.now() - request.at > 15000 || raw === pdNativeFocusing) return;
  pdNativeFocusing = raw;
  void pdWaitFor(() => {
    if (localStorage.getItem(pdNativeContinueKey) !== raw || Date.now() - request.at > 15000 || S.uid && S.uid !== request.uid) return true;
    return pdFocusComposer(window, request.key, request.uid);
  }).catch(err => toast(err.message)).finally(() => {
    try { if (localStorage.getItem(pdNativeContinueKey) === raw) localStorage.removeItem(pdNativeContinueKey); } catch {}
    if (pdNativeFocusing === raw) pdNativeFocusing = '';
  });
}
window.addEventListener?.('storage', e => { if (e.key === pdNativeContinueKey) pdTakeNativeContinue(); });
if (window.PGA_NATIVE?.float && !window.PGA_NATIVE.manager) setTimeout(pdTakeNativeContinue, 0);
async function pdContinue(key) {
  const uid = S.uid, id = uid + ':' + key;
  if (!key || pdContinuing.has(id)) return;
  const intent = ++pdContinueIntent;
  pdContinuing.add(id); pdContinueButtons(key, true);
  try {
    if (key === pdKey() && pdFocusComposer(window, key, uid)) return;
    if (window.PGA_NATIVE?.manager) {
      try { localStorage.setItem(pdNativeContinueKey, JSON.stringify({uid, key, at:Date.now(), intent})); } catch {}
    }
    const host = pmHost(), node = pdBeside(key);
    // The desktop manager's navigation bridge opens/focuses a native window.
    if (!node && window.PGA_NATIVE?.manager) return;
    await pdWaitFor(() => {
      if (S.uid !== uid || intent !== pdContinueIntent) return true;
      const n = node || host.ST?.nodes?.find(n => n.type === 'win' && n.key === key);
      if (n) {
        if (!host.ST?.nodes?.includes(n)) return true;
        return pdFocusComposer(n.el?.querySelector('iframe')?.contentWindow, key, uid);
      }
      return pdFocusComposer(host, key, uid);
    });
  } catch (err) { toast(err.message); }
  finally { pdContinuing.delete(id); if (S.uid === uid) pdContinueButtons(key, false); }
}
const pdEditing = new Set();
async function pdEditBranch(key, run, find) {
  const id = JSON.stringify([key, run, find]);
  if (pdEditing.has(id)) return;
  pdEditing.add(id);
  try {
    const host = pmHost(), n = pdBeside(key);
    if (!n || typeof host.stBranchAt !== "function") throw new Error(L("请在台面中打开管理员后重试", "Open the manager on the stage and retry."));
    const turns = await pdWaitFor(() => {
      const cw = n.el?.querySelector("iframe")?.contentWindow;
      return cw?.S?.chat === key && cw.S.chatTurns?.[key];
    });
    const point = pdEditPoint(turns, run, find);
    if (!point) throw new Error(L("未找到这条输入，暂时无法从这里修改", "Could not locate this input to edit."));
    const child = await host.stBranchAt(n, key, point.upto);
    if (!child) return;
    const cw = await pdWaitFor(() => {
      const w = child.el?.querySelector("iframe")?.contentWindow;
      return w?.S?.chat === child.key && w.S.chatTurns?.[child.key] && w.document.querySelector("#chatText") && w;
    });
    const input = cw.document.querySelector("#chatText");
    cw.S.chatDraft = input.value = point.text;
    input.dispatchEvent(new cw.Event("input", { bubbles: true }));
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  } catch (err) { toast(err.message); }
  finally { pdEditing.delete(id); }
}
let pdClickTimer;
document.addEventListener("click", (e) => {
  if (!pdOn()) return;
  // The whitespace below the document is a writing surface too.
  const box = e.target.closest('#pmdoc');
  const draft = box?.querySelector('.pd-parts textarea:last-of-type') || box?.querySelector('#pdDraft');
  const draftRow = draft?.closest('.pddraftrow');
  const blank = box && (e.target === box || e.target.matches('.pdpaper, .pddraftrow, .pddraftrow > .pdpara, .pd-parts'));
  if (blank && draftRow && e.clientY >= draftRow.getBoundingClientRect().top && !window.getSelection()?.toString()) {
    clearTimeout(pdClickTimer);
    e.preventDefault(); e.stopPropagation();
    pdNextParagraph(box.querySelector('#pdDraft'));
    return;
  }
  const retry = e.target.closest('[data-pdretry]');
  if (retry) { e.preventDefault(); void pdRetry(retry.dataset.pdretry); return; }
  const send = e.target.closest('[data-pdsend]');
  if (send) {
    const ta = document.querySelector('#pdDraft'), text = ta?.value.trim();
    if (pdSendParts(ta,null)) return;
    if (text) { pdTake(ta, ta.value.length); void pdSend(text); }
    return;
  }
  const process = e.target.closest('[data-pdprocess]');
  if (process) { e.preventDefault(); const id = process.dataset.pdprocess; PD.open.has(id) ? PD.open.delete(id) : PD.open.add(id); pdRender(); return; }
  const next = e.target.closest('[data-pdcontinue]');
  if (next) {
    clearTimeout(pdClickTimer); e.preventDefault(); e.stopPropagation();
    void pdContinue(next.dataset.pdcontinue); return;
  }
  const more = e.target.closest("[data-pdmore]");
  if (more) { const id = more.dataset.pdmore; PD.open.has(id) ? PD.open.delete(id) : PD.open.add(id); pdRender(); return; }
  const restore = e.target.closest("[data-pdrestore]");
  if (restore) {                                    // an archived task conversation back in the lists (app-recycle.js archived it)
    clearTimeout(pdClickTimer); e.preventDefault(); restore.disabled = true;
    api(`/v1/users/${S.uid}/chats/archive`, { body: { key: restore.dataset.pdrestore, archived: false } })
      .then(() => { toast(L("已恢复，管理员不会再自动归档它", "Restored; the manager will not archive it again")); return pdRefreshActivity(); })
      .catch((err) => { restore.disabled = false; toast(err.message); });
    return;
  }
  const link = e.target.closest('a[data-pdgo]');
  if (link) { clearTimeout(pdClickTimer); e.preventDefault(); pdBeside(link.dataset.pdgo, link.dataset.pdrun, link.dataset.pdfind); return; }
  if (e.target.closest("a, button, textarea, input, select, summary, .pdoriginal, .pd-gallery") || window.getSelection?.()?.toString()) return;
  const go = e.target.closest("[data-pdgo]"); if (!go) return;
  clearTimeout(pdClickTimer);
  const a = go.querySelector("a[data-pdgo]") || go;
  const { pdgo: key, pdrun: run, pdfind: find } = a.dataset;
  if (e.detail >= 2) return;
  pdClickTimer = setTimeout(() => pdBeside(key, run, find), 300);
});
document.addEventListener("dblclick", e => {
  if (!pdOn() || e.target.closest("a, button, textarea, input")) return;
  const para = e.target.closest(".pdpara[data-pdgo]"); if (!para) return;
  clearTimeout(pdClickTimer); e.preventDefault();
  const { pdgo, pdrun, pdfind } = para.dataset;
  void pdEditBranch(pdgo, pdrun, pdfind);
});
setInterval(() => { if (!S.stageDormant && !S.stageMotion && (pdOn() || PD.renderPending)) pdRender(); }, 3000);   // dispatched parts report in via taskState (app-dispatch.js polls them)

const pdActivityRequests = new Map();
async function pdRefreshActivity() {
  if (!pdVisible() || !PM.name) return;
  const name = PM.name, uid = S.uid, key = pdKey(), identity = uid + ':' + name + ':' + key;
  if (pdActivityRequests.has(identity)) return;
  pdActivityRequests.set(identity, true);
  try {
    const rows = await api('/v1/users/' + uid + '/project-activity?project=' + encodeURIComponent(name));
    if (PM.name === name && S.uid === uid && pdKey() === key && pdVisible()) {
      PD.activityKey = identity; PD.activity = Array.isArray(rows) ? rows : []; pdRender();
    }
  } catch (err) { console.warn('Manager activity refresh failed', err); }
  finally { pdActivityRequests.delete(identity); }
}
setInterval(pdRefreshActivity, 1000); // bounded polling also repairs missed updates after reconnecting
