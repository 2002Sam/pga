/* PGA app · the rest of what Open WebUI does, made PGA's way: several agents answering at once and read side by side,
   web pages and web search, running code (JavaScript in a sandboxed frame, Python with Pyodide in a worker), notes, and
   the conversation map — a tree bar beside every conversation (its turns, the versions of an answer, the branches that
   grew from it). Loaded after app-compose.js. */

/* ------------------------------------------------ several agents at once */
S.multi = []; S.web = false; S.sideBy = {};
/* who answers is kept for the conversation (S.chatMulti, on the server): every message in it gets that many answers until
   you turn it off. Three different agents, or one agent three times; or tick your own. */
S.chatMulti = {};
const MULTI_TRIO = ["chatgpt", "claude", "deepseek"];
function multiTrio() {                             // ChatGPT, Claude and DeepSeek — or the nearest there are
  const have = S.agents.map((a) => a.name), out = MULTI_TRIO.filter((n) => have.includes(n));
  for (const n of have) if (out.length < 3 && !out.includes(n)) out.push(n);
  return out;
}
const multiSame = (xs) => xs.length > 1 && new Set(xs).size === 1;
async function multiSave(say = true) {             // the conversation keeps it; a conversation not started yet keeps it from its first message
  if (S.multi.length < 2) S.multi = [];
  const key = S.chat;
  if (key) { try { const r = await api(`/v1/users/${S.uid}/chat-multi`, { method: "PUT", body: { key, agents: S.multi } }); S.chatMulti[key] = r.agents; S.multi = [...r.agents]; } catch (err) { toast(err.message); } }
  renderChat();
  if (say) toast(S.multi.length > 1 ? L(`这段对话之后每条消息都会要 ${S.multi.length} 个回答：${multiNames(S.multi)}`, `Every message here now gets ${S.multi.length} answers: ${multiNames(S.multi)}`) : L("恢复成一次一个回答", "Back to one answer at a time"));
}
const multiNames = (xs) => multiSame(xs) ? L(`${agentLabel(xs[0])} × ${xs.length}`, `${agentLabel(xs[0])} × ${xs.length}`) : xs.map((n) => agentLabel(n)).join("、");
async function pickMulti(anchor) {
  await new Promise((r) => setTimeout(r, 0));      // after this click: the page closes open menus on every click
  document.querySelector(".fmenu")?.remove();
  const m = document.createElement("div"); m.className = "ctx fmenu mmenu";
  const trio = multiTrio(), same = multiSame(S.multi), on = (xs) => S.multi.length === xs.length && S.multi.every((x, i) => x === xs[i]);
  m.innerHTML = `<div class="ch">${L("这段对话：每条消息同时要几个回答，并排放（会记住）", "This conversation: several answers to every message, side by side (kept)")}</div>
    <button class="mpre ${on(trio) ? "on" : ""}" data-mpreset="trio">${L("三个不同的 agent", "Three different agents")}<span class="dimt">${esc(trio.map((n) => agentLabel(n)).join(" · "))}</span></button>
    <div class="mpre ${same ? "on" : ""}">${L("同一个 agent 答三次", "One agent, three times")}<select data-msame><option value="">${L("选一个…", "Pick one…")}</option>${S.agents.map((a) => `<option value="${esc(a.name)}" ${same && S.multi[0] === a.name ? "selected" : ""}>${esc(agentLabel(a.name))}</option>`).join("")}</select></div>
    <button class="mpre ${S.multi.length < 2 ? "on" : ""}" data-mpreset="off">${L("一次一个回答", "One answer at a time")}</button>
    <hr><div class="ch">${L("或者自己勾：", "Or tick your own:")}</div>
    ${S.agents.map((a) => `<label class="mrow"><input type="checkbox" data-magent="${esc(a.name)}" ${S.multi.includes(a.name) ? "checked" : ""}> ${esc(agentLabel(a.name))}<span class="dimt">${esc((a.role || "").split("·")[0])}</span></label>`).join("")}
    <hr><button data-act="multidone">${L("好了", "Done")}</button>`;
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect(), h = m.getBoundingClientRect();
  m.style.left = Math.min(r.left, innerWidth - h.width - 8) + "px"; m.style.top = Math.max(8, r.top - h.height - 6) + "px";
}
const moreTools = () => `<button type="button" class="ghost ctool ${S.multi.length > 1 ? "on2" : ""}" data-act="multi" aria-label="${L('多模型回答','Multiple answers')}" aria-pressed="${S.multi.length>1}" title="${S.multi.length > 1 ? L(`多模型回答：每条消息生成 ${S.multi.length} 个版本，点开可修改`, `Multiple answers: ${S.multi.length} versions per message; click to change`) : L("多模型回答：同一问题生成多个回答版本", "Multiple answers: several versions for the same question")}">${MI.multi}${S.multi.length > 1 ? `<small>${S.multi.length}</small>` : ""}</button>
  <button type="button" class="ghost ctool ${S.web ? "on2" : ""}" data-act="web" aria-label="${L('联网搜索','Web search')}" aria-pressed="${!!S.web}" title="${L("联网搜索：先查资料再回答", "Web search: look it up before answering")}">${MI.web}</button>`;
/* the first agent answers in the conversation itself; the others answer the same question with the same history at the
   same time, and are then filed under the first answer as its versions — so they read side by side */
async function multiSend() {
  if (composerBusy()) return;
  const text = ($("#chatText")?.value || "").trim(); if (!text) return;
  if (!S.chat) S.chat = `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const key = S.chat, prev = S.chatTurns[key] || [], ctx = S.chatCtx?.[key]?.context || [], names = [...S.multi];
  if (JSON.stringify(S.chatMulti[key] || []) !== JSON.stringify(names)) await multiSave(false);   // set before the conversation had a name: it keeps it now (before the asking: both write your settings)
  if (composerBusy()) return;
  let access;
  try { access = (await api(`/v1/users/${S.uid}/access?key=${encodeURIComponent(key)}`)).current; }
  catch (err) { toast(err.message); return; }
  const hist = [...ctx, ...prev].slice(-12).map((t) => ({ role: t.role === "user" ? "user" : "assistant", text: t.text }));
  const at = takeAtts(), tag = Math.random().toString(36).slice(2, 8);
  S.chatTurns[key] = [...prev, { role: "user", text, at: new Date().toISOString() }];
  S.sentHist = [...S.sentHist.filter((x) => x !== text), text].slice(-50);
  const lanes = names.map((agent, i) => ({agent, key:i === 0 ? key : `multi:${tag}:${agent}:${i}`, pending:true}));
  S.multiWork = {key, lanes};
  S.sending = true; S.chatDraft = ""; $("#chatText").value = ""; history.replaceState(null, "", qs()); startLive((c) => lanes.some(l => c.endsWith(':' + l.key))); renderChat();
  const body = (agent, conversation) => ({ ...access, text, agent, conversation, history: hist, refs: S.chatRefs, images: at.images, files: at.files, web: S.web });
  const rs = await Promise.all(lanes.map(async lane => {
    const result = await api(`/v1/users/${S.uid}/agents/ask`, {body:body(lane.agent, lane.key)}).catch(e => ({error:e.message}));
    lane.result = result; lane.pending = false;
    if (S.chat === key) renderChat();
    return result;
  }));
  const root = rs[0]?.run_id, others = rs.slice(1).map((r) => r.run_id).filter(Boolean);
  if (root && others.length) { try { await api(`/v1/users/${S.uid}/chats/fold`, { body: { root, runs: others, key } }); } catch (err) { toast(err.message); } }
  rs.forEach((r, i) => { if (r.error && !r.text) toast(`${names[i]}: ${r.error}`); });
  if (root) S.sideBy[root] = true;
  S.sending = false; stopLive(); S.multiWork = null;
  S.scrollChat = true; await loadChats(); await loadChat(key); loadTimeline();
  await drainFollowups(key, rs.every(r=>!r.error && r.ok !== false && !r.stopped));
}
/* Use conversation identities, not agent names: the same agent may answer twice. */
function multiWorkHtml() {
  const work = S.multiWork; if (!work || work.key !== S.chat) return workCard();
  return `<div class="multi-work split-columns" style="--multi-columns:${work.lanes.length}">${work.lanes.map((lane, i) => {
    const result = lane.result;
    return `<section class="split-lane"><header>${esc(agentLabel(result?.agent || lane.agent))} · ${i + 1}${lane.pending ? '' : `<span>${esc(runEffortLabel(result?.effort))}</span>`}<span>${lane.pending ? L('处理中', 'Working') : result?.error ? L('失败', 'Failed') : L('已完成', 'Completed')}</span></header><div class="split-lane-body">${lane.pending ? splitWorkCard(lane.key) : `<div class="ct md">${md(result?.text || '')}</div>${result?.error ? `<p role="alert">${esc(result.error)}</p>` : ''}`}</div></section>`;
  }).join('')}</div>`;
}
/* answers from different agents are read side by side unless you fold them back; versions of one agent's answer are flipped through */
/* answers kept from the side of a split you did not adopt (split_alt) stay folded behind the one in use */
const sideOn = (t) => (t.versions || []).length > 1 && (S.sideBy[t.run] ?? (!t.versions.some((v) => v.split_alt) && (t.versions.some((v) => v.multi) || new Set(t.versions.map((v) => v.agent)).size > 1)));
function sideBySide(t) {
  const vs = t.versions || [], c = t.council, rank = c?.ranking || [], agents = vs.filter((v) => v.agent !== "council");
  const busy = S.councilBusy === t.run;
  const head = `<div class="sbs-h"><span class="dimt">${L(`${agents.length} 个 agent 的回答`, `${agents.length} agents' answers`)}</span>
    ${rank.length ? `<span class="sbs-rank">${L("盲评排名：", "Blind ranking: ")}${rank.map((a, i) => `<b>${i + 1}. ${esc(agentLabel(a))}</b>`).join(" ")}</span>` : ""}
    <span class="grow"></span>${agents.length >= 2 ? `<button class="sm ${rank.length ? "ghost" : "primary"}" data-act="council" data-run="${t.run}" ${busy ? "disabled" : ""} title="${L("匿名互评打分，再把几个回答合成一个更好的（参考 LLM Council 和 Mixture-of-Agents）；结果也计入 agent 排行", "Blind review and ranking, then one merged answer (after LLM Council and Mixture-of-Agents); it also counts in the agents' Elo")}">${busy ? `<span class="spin"></span> ${L("评审中…", "Reviewing…")}` : rank.length ? L("再评一次", "Review again") : L("评审与合成", "Review and merge")}</button>` : ""}</div>
    ${c?.review ? `<details class="sbs-review"><summary>${L("评审意见", "The review")}</summary><div class="md">${md(c.review.replace(/Response ([A-Z])/g, (m, x) => c.labels?.[x] ? agentLabel(c.labels[x]) : m))}</div></details>` : ""}`;
  const seen = {}, twice = new Set(agents.map((v) => v.agent).filter((a, i, xs) => xs.indexOf(a) !== i));   // one agent more than once: #1, #2, #3
  return head + `<div class="sbs" style="--n:${Math.min(3, vs.length)}">${vs.map((v) => { const r = rank.indexOf(v.agent), no = twice.has(v.agent) ? ` #${(seen[v.agent] = (seen[v.agent] || 0) + 1)}` : "";
    return `<div class="sbc ${v.run === t.version ? "cur" : ""} ${v.agent === "council" ? "merged" : ""}"><div class="sbh">${r >= 0 ? `<span class="sbr">#${r + 1}</span>` : ""}<b>${v.agent === "council" ? L("合成", "Merged") : esc(agentLabel(v.agent || "AI")) + no}</b>${v.model ? `<span>${esc(v.model)}</span>` : ""}<span>${esc(runEffortLabel(v.how?.effort || v.effort))}</span>${v.how?.seconds != null ? `<span>${v.how.seconds}s</span>` : ""}<span class="grow"></span>
      ${v.run === t.version ? `<span class="pill">${L("在用这一版", "In use")}</span>` : `<button class="sm ghost" data-act="ver" data-run="${t.run}" data-v="${esc(v.run)}">${L("用这一版", "Use this")}</button>`}</div>
    <div class="ct md">${md(v.text || (v.error ? "⚠ " + v.error : ""))}</div></div>`; }).join("")}</div>`;
}
async function convene(run) {
  S.councilBusy = run; renderChat();
  try { const r = await api(`/v1/users/${S.uid}/chats/council`, { body: { run } }); toast(L(`评审完：${r.ranking.map((a) => agentLabel(a)).join(" > ")}，合成的一版放在最后`, `Reviewed: ${r.ranking.join(" > ")}; the merged answer is the last version`)); S.arena = null; }
  catch (err) { toast(err.message); }
  finally { S.councilBusy = null; await loadChat(S.chat); }
}

/* ------------------------------------------------ a web page into the knowledge base */
async function addWebPage(tree) {
  const url = prompt(L("网页地址（会在本机抓下来，读成文字存进知识库，并在这次对话里引用）", "Web address (fetched here, kept as text in the knowledge base, cited in this chat)"), "https://");
  if (!url || url === "https://") return;
  toast(L("正在抓取网页…", "Fetching the page…"));
  try { const r = await api(`/v1/users/${S.uid}/knowledge/web`, { body: { url } }); toast(L(`「${r.title.slice(0, 30)}」进了知识库（${kfmt(r.chars)} 字）`, `“${r.title.slice(0, 30)}” is in the knowledge base (${kfmt(r.chars)} chars)`));
    S.forest = null; await loadForest(); citeRef(r.id, tree); } catch (err) { toast(err.message); }
}

/* ------------------------------------------------ running code */
const RUNNABLE = /^(js|javascript|python|py)$/i;
let PYW = null;
function pyWorker() {                      // Pyodide in a worker: loaded the first time, then kept
  if (PYW) return PYW;
  const src = `importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js");
    let py = loadPyodide({ stdout: (s) => postMessage({ t: "out", s }), stderr: (s) => postMessage({ t: "err", s }) });
    onmessage = async (e) => { const p = await py; try { const r = await p.runPythonAsync(e.data.code); postMessage({ t: "done", r: r === undefined ? null : String(r) }); }
      catch (err) { postMessage({ t: "err", s: String(err) }); postMessage({ t: "done", r: null }); } };`;
  PYW = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  return PYW;
}
function runCode(pre) {
  const code = pre.querySelector("code")?.textContent || "", lang = (pre.querySelector("code").className.match(/language-([\w+-]+)/) || [])[1] || "";
  let box = pre.nextElementSibling; if (!box?.classList?.contains("runout")) { box = document.createElement("div"); box.className = "runout"; pre.after(box); }
  box.innerHTML = `<div class="rh"><span class="spin"></span>${L("运行中…", "Running…")}</div><pre></pre>`; const out = box.querySelector("pre");
  const put = (s, err) => { const sp = document.createElement("span"); if (err) sp.className = "err"; sp.textContent = s + "\n"; out.appendChild(sp); };
  const done = (ms) => { box.querySelector(".rh").innerHTML = `✓ ${L("运行完", "Done")} · ${ms}ms${out.textContent ? "" : L(" · 没有输出", " · no output")}`; };
  const t0 = performance.now();
  if (/^py/i.test(lang)) {
    if (!PYW) put(L("（第一次运行要先下载 Python 运行环境，约 10 MB）", "(the first run downloads the Python runtime, about 10 MB)"));
    const w = pyWorker();
    w.onmessage = (e) => { if (e.data.t === "out") put(e.data.s); else if (e.data.t === "err") put(e.data.s, true); else { if (e.data.r != null) put("→ " + e.data.r); done(Math.round(performance.now() - t0)); } };
    w.postMessage({ code });
    return;
  }
  const f = document.createElement("iframe"); f.sandbox = "allow-scripts"; f.style.display = "none";
  const id = Math.random().toString(36).slice(2);
  const onMsg = (e) => { if (e.data?.id !== id) return; if (e.data.t === "done") { window.removeEventListener("message", onMsg); f.remove(); done(Math.round(performance.now() - t0)); } else put(e.data.s, e.data.t === "err"); };
  window.addEventListener("message", onMsg);
  f.srcdoc = `<script>const send=(t,s)=>parent.postMessage({id:${JSON.stringify(id)},t,s},"*");const fmt=(a)=>a.map(x=>typeof x==="object"?JSON.stringify(x):String(x)).join(" ");
    console.log=(...a)=>send("out",fmt(a));console.error=(...a)=>send("err",fmt(a));console.warn=console.log;
    (async()=>{try{const r=await (async()=>{${code.replace(/<\/script/gi, "<\\/script")}\n})();if(r!==undefined)send("out","→ "+fmt([r]));}catch(e){send("err",String(e))}send("done")})();<\/script>`;
  document.body.appendChild(f);
  setTimeout(() => { if (document.body.contains(f)) { put(L("（10 秒没结束，停了）", "(stopped after 10 s)"), true); window.removeEventListener("message", onMsg); f.remove(); done(10000); } }, 10000);
}
function enhanceRunHeaders(root) {
  const headers = [...root.querySelectorAll(".codehd:not([data-run])")];
  if (root.matches?.(".codehd:not([data-run])")) headers.unshift(root);
  for (const hd of headers) {
    if (hd.dataset.run) continue;
    hd.dataset.run = "1";
    const lang = hd.firstElementChild?.textContent || "";
    if (RUNNABLE.test(lang)) hd.insertAdjacentHTML("beforeend", `<button data-act="runcode">${L("运行", "Run")} ▶</button>`);
  }
}
new MutationObserver(records => {
  // Timer text and other unrelated updates must not rescan the whole chat.
  const roots = new Set();
  for (const record of records) for (const n of record.addedNodes) if (n.nodeType === 1) roots.add(n);
  for (const root of roots) {
    if (!root.isConnected || [...roots].some(other => other !== root && other.contains(root))) continue;
    enhanceRunHeaders(root);
  }
}).observe(document.body, { childList: true, subtree: true });
enhanceRunHeaders(document.body);


/* ------------------------------------------------ notes */
S.notes = null; S.note = null;
async function loadNotes() {
  S.notes = await api(`/v1/users/${S.uid}/notes`);
  for (const row of S.notes) {
    const pending = planSaves.get(row.id)?.body;
    if (pending) Object.assign(row, pending, {chars: pending.text.length});
  }
  return S.notes;
}
async function showNotes() {
  document.title = L("计划 · PGA", "Plans · PGA");
  try { await loadNotes(); } catch (err) { toast(err.message); return; }
  if (!S.note && S.notes.length) S.note = S.notes[0].id;
  renderNotes();
}
function localTomorrow(now = new Date()) {
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12);
  return [day.getFullYear(), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0")].join("-");
}

async function openTomorrowPlan(seed = "") {
  if (S.view !== "stage") show("stage");
  await pgStart();
  const node = ST.nodes.find(n => n.id === ST.focus);
  const group = node && typeof stGroupRaw === "function" ? stGroupRaw(node)?.id : "";
  const project = node?.planProject ?? (node?.managerProject || (group?.startsWith("pj:") ? group.slice(3) : ""));
  const plan = await api(`/v1/users/${S.uid}/plans/tomorrow`, {
    body: {date: localTomorrow(), project, lang: EN ? "en" : "zh"}
  });
  showStagePlan(plan, node, seed);
}
function renderNotes() {
  const n = (S.notes || []).find((x) => x.id === S.note);
  $("#nlist").innerHTML = `<div class="ch"><b>${L("计划", "Plans")}</b><span class="grow"></span><button class="sm primary" data-act="tomorrowplan">${L("列明日计划", "Plan tomorrow")}</button><button class="sm" data-act="newnote">${L("＋ 新计划", "+ New plan")}</button></div>
    ${(S.notes || []).map((x) => `<div class="ni ${x.id === S.note ? "on" : ""}" data-note="${x.id}"><b>${esc(x.title)}</b><span>${esc(ago(x.at))} · ${kfmt(x.chars)} ${L("字", "chars")}</span></div>`).join("") || `<div class="empty" style="padding:20px 14px">${L("从「列明日计划」开始，或新建一份计划。", "Open tomorrow’s plan or create a plan.")}</div>`}`;
  $("#npane").innerHTML = n ? `<div class="nhd"><input type="text" id="ntitle" value="${esc(n.title)}"><span class="dimt" id="nsaved">${L("已保存", "Saved")}</span>
      <button class="sm" data-act="plan-draft">${L("AI 排程", "AI schedule")}</button>
      <span class="seg"><button class="${S.nprev ? "" : "on"}" data-act="nedit">${L("编辑", "Edit")}</button><button class="${S.nprev ? "on" : ""}" data-act="nprev">${L("预览", "Preview")}</button></span>
      <button class="sm ghost" data-act="ndel">${L("删除", "Delete")}</button></div>
    ${S.nprev ? `<div class="nprev md">${md(n.text || "")}</div>` : `<textarea id="ntext" placeholder="${L("Markdown：标题、列表、代码、公式都能写", "Markdown: headings, lists, code and maths all work")}">${esc(n.text || "")}</textarea>`}`
    : `<div class="chello"><h2>${L("计划", "Plans")}</h2><div>${L("点「新计划」开始写。", "Press “New plan” to start.")}</div></div>`;
}
const planSaves = new Map();
async function flushNote(id) {
  const entry = planSaves.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  if (entry.running) { await entry.running; return flushNote(id); }
  const body = entry.body;
  entry.running = api(`/v1/notes/${id}`, {method: "PUT", body: {...body, expected_at: entry.at}});
  try {
    const saved = await entry.running;
    entry.at = saved.at;
    if (body === entry.body) {
      planSaves.delete(id);
      Object.assign(entry.row, saved, {chars: saved.text.length});
      if (entry.status) entry.status.textContent = L("已保存", "Saved");
      syncStagePlan(saved);
      const row = S.notes?.find(x => x.id === id);
      if (row) Object.assign(row, saved, {chars: saved.text.length});
      if (S.note === id && $("#nsaved")) $("#nsaved").textContent = L("已保存", "Saved");
    }
  } finally { entry.running = null; }
  if (planSaves.has(id)) await flushNote(id);
}
function saveNoteSoon(row = S.notes?.find(x => x.id === S.note), body, status) {
  const id = row?.id;
  if (!row) return;
  body ??= {title: $("#ntitle").value, text: $("#ntext")?.value ?? row.text};
  status ??= $("#nsaved");
  Object.assign(row, body, {chars: body.text.length});
  const label = document.querySelector(`.ni[data-note="${id}"] b`);
  if (label) label.textContent = body.title;
  if (status) status.textContent = L("正在保存…", "Saving…");
  const entry = planSaves.get(id) || {at: row.at};
  planSaves.set(id, entry);
  Object.assign(entry, {body, row, status});
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => flushNote(id).catch(err => {
    if (entry.status) entry.status.textContent = L("保存失败", "Save failed");
    toast(err.message);
  }), 500);
}
async function toNote(anchor, text) {
  try { await loadNotes(); } catch (err) { toast(err.message); return; } document.querySelector(".fmenu")?.remove();
  const m = document.createElement("div"); m.className = "ctx fmenu"; m.dataset.text = text;
  m.innerHTML = `<div class="ch">${L("存进哪份计划", "Save to which plan")}</div><button data-tonote="">＋ ${L("新计划", "New plan")}</button>${S.notes.slice(0, 12).map((x) => `<button data-tonote="${x.id}">${esc(x.title)}</button>`).join("")}`;
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect(), h = m.getBoundingClientRect(); m.style.left = Math.min(r.left, innerWidth - h.width - 8) + "px"; m.style.top = Math.max(8, Math.min(r.bottom + 4, innerHeight - h.height - 8)) + "px";
}

/* ------------------------------------------------ the conversation map: a tree bar beside the conversation */
function convMapKids(key) {
  const kids = new Map((S.chatKids?.[key] || []).map(k => [k.key, {...k}]));
  try {
    const host = window.parent !== window ? window.parent : window;
    for (const n of host.ST?.nodes || []) if (n.branchFrom === key && n.branchPoint != null) {
      kids.set(n.key, {...kids.get(n.key), key:n.key, upto:n.branchPoint, title:kids.get(n.key)?.title || n.title, tag:n.tag});
    }
  } catch {}
  return [...kids.values()];
}
// The stage uses the same marker as the reader, so wires originate at the fork's turn.
window.convMapAnchor = function (point, key) {
  const box = $('#cmap'); if (!box || box.hidden) return null;
  // Siblings share a fork point, but each line must meet its own branch tick.
  const branch = key && [...box.querySelectorAll('[data-mchat]')].find(el => el.dataset.mchat === key);
  const row = point != null && [...box.querySelectorAll('[data-points]')].find(el => el.dataset.points.split(',').includes(String(point)));
  const source = key && [...box.querySelectorAll('[data-source-chat]')].find(el => el.dataset.sourceChat === key);
  const mark = branch || source || row; if (!mark) return null;
  const r = mark.getBoundingClientRect(), b = box.getBoundingClientRect();
  return {x:Math.min(b.right, r.right), y:Math.max(b.top + 2, Math.min(b.bottom - 2, r.top + r.height / 2))};
};
window.convMapPoint = function (point, key) { return window.convMapAnchor(point, key)?.y ?? null; };
function convMapWires() {
  try { if(window.parent !== window) window.parent.stWires?.(); } catch {}
}
const railBox = document.getElementById('cmap');
railBox?.addEventListener('scroll', () => { hideRailTip(); convMapWires(); }, {passive:true});
if (typeof ResizeObserver !== 'undefined' && railBox) new ResizeObserver(convMapWires).observe(railBox);
let railTip, railTipVersion = 0, railTipTimer;
const branchPreviewCache = new Map();
function hideRailTip() { ++railTipVersion; clearTimeout(railTipTimer); if (railTip) railTip.hidden = true; }
function showRailTip(mark, html) {
  if (!railTip) { railTip = document.createElement('div'); railTip.className = 'railpreview'; document.body.appendChild(railTip); }
  railTip.innerHTML = html ?? `<b>${esc(mark.dataset.previewTitle || '')}</b><p>${esc(mark.dataset.preview || '')}</p>`;
  railTip.hidden = false;
  const r = mark.getBoundingClientRect(), width = Math.min(340, innerWidth - 48);
  railTip.style.width = width + 'px';
  railTip.style.left = Math.max(8, r.left - width - 12) + 'px';
  railTip.style.top = Math.max(8, Math.min(innerHeight - railTip.offsetHeight - 8, r.top - 30)) + 'px';
}
function branchPreviewHtml(key, data, title, busy) {
  const turns = data?.turns || [];
  const question = [...turns].reverse().find(t => t.role === 'user');
  const answer = [...turns].reverse().find(t => t.role === 'agent' || t.role === 'assistant');
  const text = value => esc(String(value || '').slice(0, 360));
  const model = [answer?.agent, answer?.model].filter(Boolean).join(' · ');
  return `<b class="branch-preview-title" style="--pair-color:${railPairColor(key)}">${esc(title)}</b><div class="dimt">${esc(model)}${model ? ' · ' : ''}${busy ? L('正在回答','Answering') : relOpen(key) ? L('已打开','Open') : L('未打开','Not open')}</div>`
    + (question ? `<p><strong>${L('最近提问','Latest question')}</strong><br>${text(question.text)}</p>` : '')
    + (answer ? `<p><strong>${L('最近回答','Latest answer')}</strong><br>${text(answer.text || answer.error)}</p>` : `<p>${L('暂无回答','No answer yet')}</p>`);
}
function showBranchTip(mark) {
  hideRailTip(); const version = railTipVersion;
  const host = window.parent.ST ? window.parent : window;
  const node = host.ST?.nodes.find(n => n.key === mark.dataset.mchat || n.id === mark.dataset.strestore);
  const key = mark.dataset.sourceChat || mark.dataset.mchat || node?.key; if (!key) return;
  if (mark.dataset.sourceChat) {
    const member = S.chatSources?.[S.chat]?.find(source => source.key === key);
    const turns = member?.turns || (S.chatTurns[S.chat] || []).filter(turn => turn.thread === key);
    showRailTip(mark, branchPreviewHtml(key, {turns}, member?.title || mark.title, false));
    return;
  }
  const title = (S.allChats || []).find(c => c.key === key)?.title || node?.title || mark.title || key;
  showRailTip(mark, `<b>${esc(title)}</b><p>${L('正在读取分支详情…','Loading branch details…')}</p>`);
  railTipTimer = setTimeout(async () => {
    try {
      let live; try { live = node?.el?.querySelector('iframe')?.contentWindow?.S; } catch {}
      const cached = branchPreviewCache.get(key);
      let data = live?.chatTurns?.[key] ? {turns:live.chatTurns[key]} : S.chatTurns?.[key] ? {turns:S.chatTurns[key]} : cached && Date.now()-cached.at<30000 ? cached.data : null;
      if (!data) {
        data = await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(key)}`);
        branchPreviewCache.set(key,{data,at:Date.now()});
      }
      if (version !== railTipVersion || !mark.isConnected) return;
      showRailTip(mark, branchPreviewHtml(key,data,title,!!live?.sending));
    } catch (err) {
      if (version === railTipVersion && mark.isConnected) showRailTip(mark, `<b>${esc(title)}</b><p>${L('暂时无法读取详情','Unable to load details')}</p>`);
    }
  }, 180);
}
const railHoverSelector = '.railmark, .railbranch, .stbranchdot';
for (const type of ['pointerover','focusin']) document.addEventListener(type, e => {
  const m=e.target.closest(railHoverSelector); if (!m || m.contains(e.relatedTarget)) return;
  if (type === 'pointerover' && e.buttons) return;
  if (m.matches('.railbranch, .stbranchdot')) showBranchTip(m); else { hideRailTip(); showRailTip(m); }
});
document.addEventListener('pointerout', e => { const m=e.target.closest(railHoverSelector); if(m && !m.contains(e.relatedTarget)) hideRailTip(); });
window.addEventListener('pointerdown', hideRailTip, true);
document.addEventListener('focusout', hideRailTip);
document.addEventListener('click', hideRailTip);
function convMap() {
  const box = $("#cmap"); if (!box) return; box.classList.add("turnrail"); hideRailTip();
  if (S.view !== "chats" || (!S.chat && !S.lineView && !S.imp)) { box.innerHTML = ""; box.hidden = true; return; }
  let nodes = [], title = "", branches = [];
  if (S.lineView) {                          // a line: each stretch of a conversation, in time order
    title = L("这条线", "This line");
    [...document.querySelectorAll("#cdlgIn .lseg")].forEach((el, i) => { el.id = el.id || "seg-" + i;
      nodes.push({ id: el.id, label: el.querySelector("b")?.textContent || "", sub: el.querySelector("span")?.textContent || "", target: el.dataset.ltarget, on: el.classList.contains("on") }); });
  } else if (S.imp) {
    const messages = [...document.querySelectorAll('#cdlgIn .cmsg')];
    const kids = convMapKids('imp:' + S.imp.cid); branches = kids;
    messages.forEach((el, i) => {
      if (!el.classList.contains('me') && i > 0) return;
      el.id ||= 'import-turn-' + i;
      let end = i + 1; while (end < messages.length && !messages[end].classList.contains('me')) end++;
      nodes.push({id:el.id, label:el.querySelector('.ct')?.textContent || '',
        preview:messages[i + 1]?.querySelector('.ct')?.textContent || '', run:String(end), fork:String(end),
        points:Array.from({length:end-i},(_,j)=>String(i+j+1)), kids:kids.filter(k=>Number(k.upto)>i && Number(k.upto)<=end)});
    });
  } else {
    const ts = S.chatTurns[S.chat] || [], c = S.chatCtx?.[S.chat], kids = convMapKids(S.chat);
    branches = kids;
    title = L("这段对话", "This conversation");
    const beginning = kids.filter(k=>String(k.upto)==='0');
    if (beginning.length) {
      nodes.push({id:'cdlgIn',run:'0',label:L('对话起点','Start of conversation'),kids:beginning}); }
    const inherited = c?.context || [], start = Math.max(0, inherited.length - BRANCH_SHOWN);
    for (let i = start; i < inherited.length; i++) {
      const t = inherited[i];
      if (t.role !== 'user' && i !== start) continue;
      let end = i + 1;
      while (end < inherited.length && inherited[end].role !== 'user') end++;
      const point = `context:${end}`;
      const points = inherited.slice(i,end).flatMap((t,j)=>[`context:${i+j+1}`, ...(t.run ? [t.run] : [])]);
      nodes.push({id:`${t.role === 'user' ? 't' : 'a'}-context:${i+1}`, label:t.text || '',
        preview:inherited[end-1]?.role === 'assistant' ? inherited[end-1].text : '',
        run:point, fork:point, points, kids:kids.filter(k=>points.includes(k.upto))});
    }
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]; if (t.role !== 'user' || !t.run) continue;
      const answer = ts[i + 1]?.role === 'agent' ? ts[i + 1] : null;
      const point = answer?.run || t.run;
      nodes.push({id:'t-' + t.run, label:t.text || '', preview:answer?.text || '',
        run:point, fork:point, source:t.thread && S.chat.endsWith('-execute') ? t.thread : null, points:[t.run, point], kids:kids.filter(k=>k.upto===point),
        live:S.sending && i === ts.length - 1});
    }
    for (const source of S.chatSources?.[S.chat] || []) {
      const id = 'source-' + source.key;
      nodes.push({id, label:source.title, source:source.key, preview:""});

    }
    if (S.sending && ts[ts.length - 1]?.role === "user" && !ts[ts.length - 1].run) nodes.push({ id: "", label: ts[ts.length - 1].text, live: true });
  }
  // Branches from inherited history (or an unavailable origin) remain accessible.
  const shown = new Set(nodes.flatMap(n => (n.kids || []).map(k => k.key)));
  const remaining = branches.filter(k => !shown.has(k.key));
  if (remaining.length) nodes.push({id:'cdlgIn', label:L('其他分支','Other branches'), kids:remaining});
  if (!nodes.length) { box.innerHTML = ""; box.hidden = true; return; }
  box.hidden = false;
  box.classList.remove('wide');
  box.innerHTML = `<div class="railmarks">${nodes.map(n => n.kind === 'parent'
    ? `<button class="railparent" data-mparent="${esc(n.parent)}" title="${esc(n.label)}">↰</button>`
    : `<div class="railrow ${n.kind || ''}" data-point="${esc(n.run || '')}" data-points="${esc((n.points || [n.run || '']).join(','))}"${(n.kids || []).length ? ` data-kids="${esc(n.kids.filter(k => !String(k.key).startsWith('imp:')).map(k => k.key).join(','))}" data-kidtitles="${esc(n.kids.map(k => k.title || '').join('\n'))}"` : ''}>
        <button class="mn railmark ${n.live ? 'live' : ''}" data-mgo="${esc(n.id)}" data-mtarget="${esc(n.target || '')}" ${n.fork != null ? `data-railfork="${esc(n.fork)}" ${n.source ? `data-rail-source="${esc(n.source)}"` : ''}` : ''} title="${n.source || !n.fork ? L('定位到这里','Jump here') : L('点击定位，右键从这一轮之后继续','Click to locate, right-click to branch after this turn')}" aria-label="${esc(String(n.label).slice(0,100))}" data-preview-title="${esc(String(n.label).slice(0,240))}" data-preview="${esc(String(n.preview || n.sub || '').slice(0,400))}"><i></i></button>
        ${n.source ? `<button class="railbranch" data-source-chat="${esc(n.source)}" style="--pair-color:${sourceRailColor(n.source)}" title="${esc(n.label)}" aria-label="${esc(L('打开原对话：','Open source conversation: ') + n.label)}"></button>` : ''}
        ${(n.kids || []).map(k => `<button class="railbranch" data-mchat="${esc(k.key)}" style="--pair-color:${railPairColor(k.key)}" title="${esc(k.title || L('子对话','Branch'))}" aria-label="${esc(L('打开或收起子对话：','Toggle branch: ') + (k.title || k.key))}"></button>`).join('')}
      </div>`).join('')}</div>`;
  syncMap(); if (typeof relPaint === 'function') relPaint();
  requestAnimationFrame(convMapWires);
}
document.addEventListener('contextmenu', e => {
  const mark = e.target.closest('[data-railfork]'); if (!mark) return;
  e.preventDefault(); hideRailTip();
  if (mark.dataset.railSource) { openSourceChat(mark.dataset.railSource); return; }
  chatBranch(mark.dataset.railfork, S.imp ? 'imp:' + S.imp.cid : S.chat);
});
function railSelect(mark) {
  const rail = railIndex(); if (!rail) return;
  const at = rail.positions.get(mark) ?? -1, old = rail.selected;
  if (old === at) return;
  // Only the previous and current neighbourhoods can change.
  for (const center of [old, at]) {
    if (center < 0) continue;
    for (let i = center - 1; i <= center + 1; i++) {
      const tick = rail.marks[i]; if (!tick) continue;
      tick.classList.toggle('on', i === at);
      tick.classList.toggle('near', at >= 0 && Math.abs(i - at) === 1);
    }
  }
  rail.selected = at;
}
let railSyncFrame = 0;
function railIndex() {
  const list = $('#cmap')?.firstElementChild;
  if (!list) return null;
  // convMap replaces .railmarks as a unit whenever it rebuilds the rail.
  if (!list._pgaTurnIndex) {
    const marks = Array.from(list.querySelectorAll('[data-mgo]'));
    list._pgaTurnIndex = {marks, positions:new Map(marks.map((mark, i) => [mark, i])), selected:-1};
  }
  return list._pgaTurnIndex;
}
function syncMap() {
  if (railSyncFrame) return;
  railSyncFrame = requestAnimationFrame(() => {
    railSyncFrame = 0;
    const w = $('#cdlg'), box = $('#cmap'); if (!w || !box || box.hidden) return;
    const marks = railIndex()?.marks;
    if (!marks?.length) return;
    const top = w.getBoundingClientRect().top + 80;
    let lo = 0, hi = marks.length, current = marks[0];
    // This trailing branch group points to the conversation start and is out of turn order.
    const last = marks[hi - 1];
    if (hi > 1 && last.dataset.mgo === 'cdlgIn') {
      const start = document.getElementById('cdlgIn');
      if (start && start.getBoundingClientRect().top <= top) { railSelect(last); return; }
      hi--;
    }
    // Resolve only the search path against the current transcript, including refreshed or missing turns.
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      let i = mid, el;
      while (i < hi && !(el = document.getElementById(marks[i].dataset.mgo))) i++;
      if (i === hi || el.getBoundingClientRect().top > top) hi = mid;
      else { current = marks[i]; lo = i + 1; }
    }
    railSelect(current);
  });
}
document.addEventListener("scroll", (e) => { if (e.target.id === "cdlg") syncMap(); }, true);
let stageBranchUiPending = false;
const _renderChat = renderChat;
renderChat = function () {                  // the map follows whatever the chat pane shows
  _renderChat();
  if (S.stageDormant || S.stageMotion) { stageBranchUiPending = true; return; }
  if (S.sending && S.liveMulti?.length && !S.lineView) $("#workCard")?.insertAdjacentHTML("beforebegin", `<div class="mstrip"><span class="pulse"></span>${L("同时在答：", "Also answering: ")}${S.liveMulti.map((n) => `<b>${esc(agentLabel(n))}</b>`).join("")}<span class="dimt">${L("答完会并排放", "answers will sit side by side")}</span></div>`);
  const key = S.lineView || S.chat || "", n = document.querySelectorAll("#cdlgIn .chat").length;   // new messages rise in; old ones stay still
  // A few just arrived rise in; a conversation filling in as it opens appears at once (80 rising messages is just load).
  if (FRESH.key === key && n > FRESH.n && n - FRESH.n <= 4) [...document.querySelectorAll("#cdlgIn .chat")].slice(FRESH.n - n).forEach((el) => el.classList.add("fresh"));
  FRESH = { key, n };
  convMap();
  requestAnimationFrame(updateParentRail);
};
let FRESH = { key: null, n: 0 };
const _renderLine = renderLineDialog;
renderLineDialog = function () { _renderLine(); if (S.stageDormant || S.stageMotion) { stageBranchUiPending = true; return; } if (S.lineView) convMap(); };

/* ------------------------------------------------ the right, below: the branch tree of this conversation — where it grew from, what
   grew from it (branches, off the turn they left from), and what was folded into it or it into (merges, from 整理). Always on view. */
const branchFoldExpanded = new Map();
function branchTree() {
  const box = $("#cbr"); if (!box) return;
  const key = S.imp?.key || (S.imp?.cid ? 'imp:' + S.imp.cid : S.chat);
  if (S.view !== "chats" || !key || S.lineView) { box.hidden = true; box.innerHTML = ""; return; }
  const ts = S.imp ? (S.impData?.turns || []).map((t,i)=>({...t,run:String(i)})) : S.chatTurns[key] || [];
  const ctx = S.chatCtx?.[key], kids = convMapKids(key), mg = S.chatMerges?.[key] || {};
  const titleOf = (k, t) => t || (S.allChats || []).find((x) => x.key === k)?.title || L("一段对话", "A conversation");
  const turns = ts.filter((t) => t.role === "user" && t.run && !t.note).map((t) => ({ run: t.run, label: t.text }));
  const parent = ctx?.branch?.from ? { key: ctx.branch.from, title: titleOf(ctx.branch.from, ctx.parent_title) } : null;
  const from = (mg.from || []).map((m) => ({ key: m.key, title: titleOf(m.key, m.title) })), into = mg.into ? { key: mg.into.key, title: titleOf(mg.into.key, mg.into.title) } : null;
  box.hidden = false;
  const ROW = 22, X0 = 12, X1 = 28; let y = 14, svg = "", rows = "";
  const side = (cls, yy, label, attr, mark) => `<button class="cbn ${cls}" style="top:${yy - 10}px" ${attr} title="${esc(label)}"><i style="left:${X1 - 4}px"></i><span>${mark}${esc(String(label).replace(/\s+/g, " ").slice(0, 48))}</span></button>`;
  const open = (k) => (String(k).startsWith("imp:") ? "" : `data-mchat="${esc(k)}"`);
  const top = [];                                                        // what sits above the spine: the parent, what was folded in
  if (parent) top.push({ kind: "br", row: side("par", 0, parent.title, open(parent.key), "↰ "), key: parent.key, title: parent.title });
  for (const m of from) top.push({ kind: "mg", key: m.key, title: m.title });
  const spineTop = y + top.length * ROW;
  top.forEach((t, i) => { const yy = y + i * ROW, cls = t.kind === "mg" ? "mg" : "par";
    svg += `<path class="${t.kind === "mg" ? "cmg" : "cbb"}" d="M ${X1} ${yy} C ${X1} ${yy + 12}, ${X0} ${spineTop - 12}, ${X0} ${spineTop}"/>`;
    rows += side(cls, yy, t.title, open(t.key), t.kind === "mg" ? "⇢ " : "↰ "); });
  y = spineTop; const y0 = y;
  const rowsAt = [];
  const at = (run) => (turns.find((t) => t.run === run) ? run : turns[turns.length - 1]?.run);
  const kidsBy = {}; kids.forEach((k) => (kidsBy[at(k.upto)] ||= []).push(k));
  const expanded = branchFoldExpanded.get(key) || new Set();
  branchFoldExpanded.set(key, expanded);
  const visible = [];
  for (let i = 0; i < turns.length;) {
    if (kidsBy[turns[i].run]?.length) { visible.push(turns[i++]); continue; }
    const start = i;
    while (i < turns.length && !kidsBy[turns[i].run]?.length) i++;
    const group = turns.slice(start, i), id = String(group[0].run);
    visible.push({ fold: id, count: group.length, expanded: expanded.has(id) });
    if (expanded.has(id)) visible.push(...group);
  }
  for (const t of visible) {
    if (t.fold !== undefined) {
      rows += `<button class="cbn cbfold" style="top:${y - 10}px" data-cbfold="${esc(t.fold)}" aria-expanded="${t.expanded}"><span style="padding-left:${X1 + 14}px">${t.expanded ? "▾" : "▸"} ${L(`${t.count} 条无分支对话`, `${t.count} turns without branches`)} · ${t.expanded ? L("收起", "Collapse") : L("展开", "Expand")}</span></button>`;
      rowsAt.push(y); y += ROW; continue;
    }
    const go = (kidsBy[t.run] || []).find((k) => !String(k.key).startsWith("imp:"));      // a turn that has a branch opens it
    rows += `<button class="cbn spine" style="top:${y - 10}px" data-mgo="${S.imp ? 'import-turn-' : 't-'}${esc(t.run)}" ${go ? `data-mchat="${esc(go.key)}"` : ""} title="${esc(String(t.label).replace(/\s+/g, " ").slice(0, 200))}${go ? "\n" + L("点击打开它的分支", "Click to open its branch") : ""}"><i style="left:${X0 - 4}px"></i><span style="padding-left:${X1 + 14}px">${esc(String(t.label).replace(/\s+/g, " ").slice(0, 36))}</span></button>`;
    rowsAt.push(y);
    let ky = y;
    for (const k of kidsBy[t.run] || []) {
      ky += ROW;
      svg += `<path class="cbb" d="M ${X0} ${y} C ${X0} ${y + 10}, ${X1} ${ky - 12}, ${X1} ${ky}"/>`;
      rows += side("kid", ky, titleOf(k.key, k.title), open(k.key), "⑂ ");
    }
    y = Math.max(y, ky) + ROW;
  }
  if (!turns.length) {
    for (const k of kids) { rows += side("kid", y, titleOf(k.key,k.title), open(k.key), "⑂ "); y += ROW; }
    rows += `<div class="cbn spine end" style="top:${y - 10}px"><i style="left:${X0 - 4}px"></i><span style="padding-left:${X1 + 14}px">${L("这段对话", "This conversation")}</span></div>`; rowsAt.push(y); y += ROW; }
  const yEnd = rowsAt[rowsAt.length - 1];
  svg = `<path class="cts" d="M ${X0} ${y0} L ${X0} ${yEnd}"/>` + svg;
  if (into) {
    const yy = Math.max(y, yEnd + ROW);
    svg += `<path class="cmg" d="M ${X0} ${yEnd} C ${X0} ${yEnd + 12}, ${X1} ${yy - 12}, ${X1} ${yy}"/>`;
    rows += side("mg", yy, into.title, open(into.key), "⇢ ");
    y = yy + ROW;
  }
  box.innerHTML = `<div class="eh">${L("分支与合并", "Branches and merges")}<span class="grow"></span><span class="cblg"><b class="b"></b>${L("分支", "branch")}<b class="m"></b>${L("合并", "merge")}</span></div>
    <div class="cbpositions" aria-label="分支在 PGA 台面中的位置"></div><div class="cbbox"><div class="cbin" style="height:${y}px"><svg width="${X1 + 10}" height="${y}">${svg}</svg>${rows}</div></div>`;
  box.querySelectorAll("[data-cbfold]").forEach((button) => button.addEventListener("click", () => {
    const id = button.dataset.cbfold, scrollTop = box.querySelector(".cbbox")?.scrollTop || 0;
    expanded.has(id) ? expanded.delete(id) : expanded.add(id);
    branchTree();
    const scroller = box.querySelector(".cbbox"); if (scroller) scroller.scrollTop = scrollTop;
    [...box.querySelectorAll("[data-cbfold]")].find(b => b.dataset.cbfold === id)?.focus({preventScroll:true});
  }));
  const sc = box.querySelector(".cbbox"); if (sc) sc.scrollTop = sc.scrollHeight;      // the end of the conversation is where you are
  syncBranch(true); if (typeof relPaint === 'function') relPaint();
}
function syncBranch(first) {                 // the dot of the turn you are reading lights up, and the tree keeps it in view
  const w = $("#cdlg"), box = $("#cbr"); if (!w || !box || box.hidden) return;
  const btns = [...box.querySelectorAll(".cbn.spine[data-mgo]")]; if (!btns.length) return;
  const top = w.getBoundingClientRect().top + 80; let cur = btns[0];
  for (const b of btns) { const el = document.getElementById(b.dataset.mgo); if (el && el.getBoundingClientRect().top <= top) cur = b; }
  if (w.scrollTop + w.clientHeight >= w.scrollHeight - 4) cur = btns[btns.length - 1];
  if (cur.classList.contains("on")) return;
  box.querySelectorAll(".cbn.on").forEach((b) => b.classList.remove("on")); cur.classList.add("on");
  const sc = box.querySelector(".cbbox"), t = cur.offsetTop;
  if (sc && !first && (t < sc.scrollTop + 10 || t + 30 > sc.scrollTop + sc.clientHeight)) sc.scrollTo({ top: t - sc.clientHeight / 2, behavior: "smooth" });
}
document.addEventListener("scroll", (e) => { if (e.target.id === "cdlg") syncBranch(); }, true);
document.addEventListener("click", (e) => {  // jump to a turn: land on it and let it flash once
  const b = e.target.closest("#cbr .cbn.spine[data-mgo]"); if (!b || b.dataset.mchat) return;
  const a = document.getElementById(b.dataset.mgo), el = a?.nextElementSibling; if (!el) return;
  $("#cbr").querySelectorAll(".cbn.on").forEach((x) => x.classList.remove("on")); b.classList.add("on");
  el.classList.remove("tflash"); void el.offsetWidth; el.classList.add("tflash"); setTimeout(() => el.classList.remove("tflash"), 1600);
});
const _renderChat2 = renderChat;
renderChat = function () { _renderChat2(); if (S.stageDormant || S.stageMotion) { stageBranchUiPending = true; return; } try { branchTree(); } catch (e) { console.warn("branchTree", e); } };

/* ------------------------------------------------ events of this module */
document.addEventListener("click", async (e) => {
  const mc = e.target.closest("[data-magent]"); if (mc) { const n = mc.dataset.magent; S.multi = mc.checked ? [...new Set([...S.multi, n])] : [...new Set(S.multi)].filter((x) => x !== n); return; }
  const mp = e.target.closest("[data-mpreset]"); if (mp) { document.querySelector(".fmenu")?.remove(); S.multi = mp.dataset.mpreset === "trio" ? multiTrio() : []; multiSave(); return; }
  const mg = e.target.closest("[data-mgo]"); if (mg) { railSelect(mg); const el = mg.dataset.mgo && document.getElementById(mg.dataset.mgo); if (el) { const w = $("#cdlg"); w.scrollTo({ top: el.getBoundingClientRect().top - w.getBoundingClientRect().top + w.scrollTop - 12, behavior: "smooth" }); } else if (mg.dataset.mtarget) { S.lineTarget = mg.dataset.mtarget; renderChat(); } return; }
  const mk = e.target.closest("[data-mchat], [data-mparent]"); if (mk) {
    if (mk.dataset.mparent) { await returnToParent(mk.dataset.mparent, mk.dataset.parentPoint); return; }
    const key = mk.dataset.mchat || mk.dataset.mparent;
    try { const P = window.parent; if (P !== window && P.stOpen) {
      const source = P.ST.nodes.find(n => n.type === 'win' && n.el?.querySelector('iframe')?.contentWindow === window);
      const info = mk.dataset.mchat && convMapKids(S.imp ? 'imp:' + S.imp.cid : S.chat).find(k => k.key === key);
      if (info?.source_thread) { openSourceChat(key); return; }
      if (source && (info || mk.classList.contains("railbranch")) && P.stToggleChatBranch) { P.stToggleChatBranch(source, key, info || {}); return; }
      const n = P.ST.nodes.find(n=>n.key===key && n.type==='win');
      if (n) { P.stFocus(n.id, true); P.stShow(n.id); } else P.stOpen(key);
      return;
    } } catch {}
    S.chat = key; S.lineView = null; S.imp = null; history.replaceState(null, "", qs()); renderChat(); loadChat(S.chat); return; }
  const tn = e.target.closest("[data-tonote]"); if (tn) { const text = tn.closest(".fmenu").dataset.text; document.querySelector(".fmenu")?.remove();
    try { if (tn.dataset.tonote) await api(`/v1/notes/${tn.dataset.tonote}`, { method: "PUT", body: { text, append: true } }); else await api(`/v1/users/${S.uid}/notes`, { body: { text } });
      toast(L("存进计划了", "Saved to the plan")); S.notes = null; } catch (err) { toast(err.message); } return; }
  const ni = e.target.closest("[data-note]");
  if (ni) {
    const row = S.notes?.find(x => x.id === ni.dataset.note);
    if (row?.plan) {
      show("stage"); await pgStart();
      showStagePlan(row, ST.nodes.find(n => n.id === ST.focus));
    } else { S.note = ni.dataset.note; renderNotes(); }
    return;
  }
  const b = e.target.closest("[data-act]"); if (!b) return;
  const a = b.dataset.act;
  if (a === "multi") pickMulti(b);
  else if (a === "multidone") { document.querySelector(".fmenu")?.remove(); multiSave(); }
  else if (a === "splitgo") { const m = b.closest(".splitpick"), picks = m && SPLIT_PICK && splitPicked(m); if (!picks) return;
    const {run, key} = SPLIT_PICK; m.remove(); SPLIT_PICK = null; store.set(SPLIT_RIGHT, JSON.stringify(picks[1])); startSplit(run, key, picks); }
  else if (a === "splitadopt") splitAdopt(b.dataset.lane);
  else if (a === "copychat") chatCopy(b.dataset.key);
  else if (a === "web") { S.web = !S.web; renderChat(); toast(S.web ? L("联网：下一条会先上网查", "Web on: the next message looks it up first") : L("不联网了", "Web off")); }
  else if (a === "runcode") runCode(b.closest("pre"));
  else if (a === "council") convene(b.dataset.run);
  else if (a === "sideby") { const t = (S.chatTurns[S.chat] || []).find((x) => x.role === "agent" && x.run === b.dataset.run); S.sideBy[b.dataset.run] = !(t ? sideOn(t) : S.sideBy[b.dataset.run]); renderChat(); }
  else if (a === "tonote") toNote(b, b.dataset.text || "");
  else if (a === "plan-draft") planDraftDialog();
  else if (a === "tomorrowplan") { b.disabled = true; try { await openTomorrowPlan(b.closest("#pad") ? $("#padText").value : ""); } catch (err) { toast(err.message); } finally { b.disabled = false; } }
  else if (a === "newnote") { try { const r = await api(`/v1/users/${S.uid}/notes`, { body: { title: L("新计划", "New plan"), text: "" } }); await loadNotes(); S.note = r.id; S.nprev = false; renderNotes(); $("#ntext")?.focus(); } catch (err) { toast(err.message); } }
  else if (a === "nedit") { S.nprev = false; renderNotes(); }
  else if (a === "nprev") { S.nprev = true; renderNotes(); }
  else if (a === "ndel") { if (!confirm(L("删除这份计划？", "Delete this plan?"))) return; try { await api(`/v1/bodies/${S.note}`, { method: "DELETE" }); S.note = null; await loadNotes(); S.note = S.notes[0]?.id || null; renderNotes(); } catch (err) { toast(err.message); } }
});
document.addEventListener("input", (e) => { if (e.target.id === "ntext" || e.target.id === "ntitle") saveNoteSoon(); });
document.addEventListener("change", (e) => { const s = e.target.closest?.("[data-msame]"); if (!s?.value) return; document.querySelector(".fmenu")?.remove(); S.multi = [s.value, s.value, s.value]; multiSave(); });

/* ------------------------------------------------ a copy of the whole conversation: a branch after its last answer, under the same
   name (· 副本), with its instructions and answerers; you carry on in it and the original stays as it was. On the stage it
   opens as a window of its own beside this one. */
async function chatCopy(key) {
  const last = [...(S.chatTurns[key] || [])].reverse().find((t) => t.role === "user" && t.run);
  if (!last) { toast(L("这段对话还没有内容可以复制", "Nothing to copy here yet")); return; }
  try {
    const r = await api(`/v1/users/${S.uid}/chats/branch`, { body: { from: key, upto: last.run, copy: true } });
    const P = window.parent !== window && typeof window.parent.stOpen === "function" ? window.parent : null;
    if (P) { const by = P.ST?.nodes.find((w) => w.type === "win" && w.key === key), n = P.stOpen(r.key, by ? { win: by.id } : undefined);
      if (n) { n.from = key; if (r.title) n.title = r.title; P.stRender(); P.stSave(); P.stMap?.(); } }
    else { S.lineView = null; S.imp = null; S.chat = r.key; S.chatTurns[r.key] = []; history.replaceState(null, "", qs()); await loadChat(r.key); loadTimeline(); }
    toast(L("复制好了：副本里接着聊，原来那段不受影响", "Copied: carry on in the copy; the original stays as it was"));
  } catch (err) { toast(err.message); }
}
const MI = { multi: ICO('<path d="M7 3h14v12M4 6h14v12"/><rect x="1" y="9" width="14" height="12" rx="2"/>'), web: ICO('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/>'),
  note: ICO('<path d="M5 3h10l4 4v14H5z"/><path d="M14 3v5h5"/><path d="M8 13h8M8 17h5"/>') };

/* reasoning effort for the next message: choices come from /v1/agents/{name}/options (cached); "" = the agent's own default */
S.agentOpts = S.agentOpts || {}; S.chatEffort = S.chatEffort || {};
function effortSel(key) {
  const agent = S.chatAgent || "auto", o = S.agentOpts[agent];
  if (agent !== "auto" && o === undefined) { S.agentOpts[agent] = null; api(`/v1/agents/${encodeURIComponent(agent)}/options`).then((r) => { S.agentOpts[agent] = r; renderChat(); }).catch(() => {}); }
  const ms = o?.models || [], selectedModel = S.chatModel?.[key] || o?.default_model || "";
  const m = ms.find((x) => x.id === selectedModel), efs = m?.efforts || [];
  const name = (m?.label || selectedModel || L('自动选择','Auto')).replace(/[（(][^）)]*[）)]/g,'').trim();
  const modelTitle = `${agentLabel(agent)} · ${m?.label || selectedModel || L('自动选择','Auto')}`;
  const msel = `<button type="button" class="pga-select-trigger model-picker-trigger" data-model-picker aria-haspopup="dialog" aria-label="${esc(L('选择模型：','Choose model: ')+modelTitle)}" title="${esc(modelTitle+' · '+L('点击切换并测试','Click to switch and test'))}">${CI.model}<span class="composer-model-name">${esc(name)}</span><span class="composer-chevron" aria-hidden="true">⌄</span></button>`;
  const usage = inlineModelUsage(key);
  if (!efs.length) return msel + usage;
  const configured = o.default_effort || m?.default_effort;
  const defaultEffort = efs.some((e) => e.id === configured) ? configured : "";
  const cur = S.chatEffort[key] && efs.some((e) => e.id === S.chatEffort[key]) ? S.chatEffort[key] : "";
  return msel + usage + `<select id="chatEffort" class="kpick" data-default-effort="${esc(defaultEffort)}" title="${L("思考强度（越高越慢越贵）", "Reasoning effort (higher = slower, costlier)")}${defaultEffort ? L(" · 默认：", " · default: ") + (EFF_ZH[defaultEffort] || defaultEffort) : ""}"><option value="" disabled hidden ${cur || defaultEffort ? "" : "selected"}>${L("强度", "Effort")}</option>${efs.map((e) => `<option value="${esc(e.id)}" ${e.id === (cur || defaultEffort) ? "selected" : ""}>${esc(e.label)}</option>`).join("")}</select>`;
}
const EFF_ZH = { default: "模型默认", none: "关闭", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高", ultra: "极限" };

/* Branch is a persistent comparison inside this window. Continuation creates a tab.
   You choose who answers on each side (your quick presets — agent, model, effort — then any agent without one); the right
   side you chose last time is offered again. 采用 on a side carries the conversation on with it (pga.chats.adopt_split). */
const SPLIT_RIGHT = 'pga_split_right';
let SPLIT_PICK = null;
const splitSame = (a, b) => a.agent === b.agent && (a.model || '') === (b.model || '') && (a.effort || '') === (b.effort || '');
function splitChoices() {
  const have = new Set(S.agents.map(a => a.name));
  const presets = (typeof mrPresets === 'function' ? mrPresets() : []).filter(p => have.has(p.agent)).map(p => ({label:p.label, agent:p.agent, model:p.model, effort:p.effort}));
  const covered = new Set(presets.map(p => p.agent));
  return [...presets, ...S.agents.filter(a => !covered.has(a.name)).map(a => ({label:agentLabel(a.name), agent:a.name, model:'', effort:''}))];
}
function splitLaneLabel(l) {
  const preset = (typeof mrPresets === 'function' ? mrPresets() : []).find(p => splitSame(p, l));
  if (preset) return preset.label;
  const model = l.model ? (S.agentOpts?.[l.agent]?.models?.find(m => m.id === l.model)?.label || l.model) : '';
  return [agentLabel(l.agent), model, l.effort ? L(EFF_ZH[l.effort] || l.effort, l.effort) : ''].filter(Boolean).join(' · ');
}
function splitDefaults(run, key) {               // the choices, and who stands on each side to begin with: this window's own
  const choices = splitChoices();                // answerer on the left, the right side you chose last time on the right
  const original = (S.chatTurns?.[key] || []).find(t => t.run === run)?.agent;
  const here = typeof mrCurrent === 'function' ? mrCurrent() : {agent:S.chatAgent || 'auto', model:'', effort:''};
  const own = S.agents.some(a => a.name === here.agent) ? here : S.agents.some(a => a.name === original) ? {agent:original, model:'', effort:''} : null;
  let li = own ? choices.findIndex(c => splitSame(c, own)) : 0;
  if (own && li < 0) { choices.unshift({label:`${splitLaneLabel(own)}${L('（当前）', ' (current)')}`, ...own}); li = 0; }
  if (choices.length < 2) return null;
  let last = null; try { last = JSON.parse(store.get(SPLIT_RIGHT) || 'null'); } catch {}
  let ri = last ? choices.findIndex(c => splitSame(c, last)) : -1;
  if (ri < 0 || ri === li) ri = choices.findIndex((c, i) => i !== li && c.agent !== choices[li].agent);
  if (ri < 0) ri = li === 0 ? 1 : 0;
  return {choices, li, ri};
}
async function pickSplit(run, key, anchor) {
  await new Promise(r => setTimeout(r, 0));      // after this click: the page closes open menus on every click
  document.querySelector('.fmenu')?.remove();
  const d = splitDefaults(run, key);
  if (!d) { toast(L('需要两个可用的 Agent 或模型', 'Two agents or models are required')); return; }
  const {choices, li, ri} = d;
  const opts = (at) => choices.map((c, i) => `<option value="${i}" ${i === at ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
  const m = document.createElement('div'); m.className = 'ctx fmenu mmenu splitpick';
  m.innerHTML = `<div class="ch">${run ? L('第二意见：两边各答一次这个问题，之后各自续聊', 'Second opinion: both sides answer this question, then carry on') : L('双 Agent 分屏：两边各自回答、各自记住上下文', 'Two-agent split: each side answers and remembers on its own')}</div>
    <label class="mpre">${L('左边', 'Left')}<select data-splitside="0">${opts(li)}</select></label>
    <label class="mpre">${L('右边', 'Right')}<select data-splitside="1">${opts(ri)}</select></label>
    <p class="splitpick-warn" hidden>${L('两边选的一样，换一个', 'Both sides are the same: change one')}</p>
    <hr><button data-act="splitgo">${L('开始分屏', 'Start split')}</button>`;
  SPLIT_PICK = {run, key, choices};
  document.body.appendChild(m);
  const r = (anchor?.isConnected ? anchor : $('#ccomp') || document.body).getBoundingClientRect(), h = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(r.left, innerWidth - h.width - 8)) + 'px';
  m.style.top = (r.top - h.height - 6 >= 8 ? r.top - h.height - 6 : Math.min(innerHeight - h.height - 8, r.bottom + 6)) + 'px';
  m.querySelector('[data-splitside="1"]').focus();
}
function splitPicked(m) {
  const [a, b] = [...m.querySelectorAll('[data-splitside]')].map(x => SPLIT_PICK.choices[+x.value]);
  const same = splitSame(a, b);
  m.querySelector('.splitpick-warn').hidden = !same; m.querySelector('[data-act="splitgo"]').disabled = same;
  return same ? null : [a, b];
}
async function startSplit(run = null, key = S.chat, picks = null, anchor = null) {
  if (composerBusy() || S.splitStarting) return;
  if (S.chatSplits?.[key]) { toast(L('已经开启双 Agent 分屏，可直接在下方继续输入', 'Split is already active; continue below')); return; }
  if (!key || S.imp || S.lineView) { toast(L('请先打开一段普通对话再分屏', 'Open a conversation before splitting')); return; }
  if (!picks) return pickSplit(run, key, anchor);
  S.splitStarting = true;
  renderChat();
  try {
    const split = await api(`/v1/users/${S.uid}/chats/compare-start`, {body:{key, agents:picks.map(p => p.agent), options:picks.map(p => ({model:p.model || '', effort:p.effort || ''})), run}});
    S.chatSplits ||= {}; S.chatSplits[key] = split;
    await loadChat(key);
    if (split.question && key === S.chat) await splitSend(split.question);
  } catch (err) { toast(err.message); }
  finally { S.splitStarting = false; if (key === S.chat) renderChat(); }
}

function splitHtml(shared) {
  const key = S.chat, split = S.chatSplits[key], target = S.splitTargets?.[key] || 'both';
  return `<details class="split-shared"><summary>${L('分屏前的共享对话', 'Conversation before splitting')}</summary>${chatTurnsHtml(shared,key)}</details>
    <div class="split-toolbar"><b>${L('双 Agent · 独立上下文', 'Two agents · independent histories')}</b><label>${L('发送给', 'Send to')} <select data-split-target>${[['both',L('两侧同时','Both')],...split.lanes.map(l=>[l.key,splitLaneLabel(l)])].map(([v,t])=>`<option value="${esc(v)}" ${v===target?'selected':''}>${esc(t)}</option>`).join('')}</select></label></div>
    <div class="split-columns">${split.lanes.map(l=>`<section class="split-lane"><header>${splitSideSelect(l, split.lanes.indexOf(l))}<span class="grow">${S.splitPending?.[l.key]?L('回答中…','Answering…'):''}</span><button class="sm ghost" data-act="splitadopt" data-lane="${esc(l.key)}" ${S.sending || S.splitAdopting || S.splitSiding ? 'disabled' : ''} title="${esc(L(`用这一侧继续：结束分屏，之后这段对话只由 ${splitLaneLabel(l)} 回答；另一侧的回答留作可切换的版本`, `Carry on with this side: the split ends and ${splitLaneLabel(l)} answers from now on; the other side's answers stay as versions`))}">${L('采用', 'Adopt')}</button></header><div class="split-lane-body">${chatTurnsHtml(S.chatTurns[l.key]||[],l.key)}${S.splitPending?.[l.key] ? splitWorkCard(l.key) : ""}${S.splitErrors?.[l.key]?`<p role="alert">${esc(S.splitErrors[l.key])}</p>`:''}</div></section>`).join('')}</div>`;
}
document.addEventListener('change', e => {
  if (e.target.matches?.('[data-split-target]')) { S.splitTargets ||= {}; S.splitTargets[S.chat] = e.target.value; }
  if (e.target.matches?.('[data-splitside]') && SPLIT_PICK) splitPicked(e.target.closest('.splitpick'));
  if (e.target.matches?.('[data-splitwho]')) { try { splitSide(e.target.dataset.splitwho, JSON.parse(e.target.value)); } catch {} }
});
async function splitSend(explicitText) {
  if (composerBusy()) return;
  const key = S.chat, split = S.chatSplits?.[key]; if (!split) return;
  const text = explicitText || ($('#chatText')?.value || '').trim(); if (!text) return;
  const target = S.splitTargets?.[key] || 'both', lanes = split.lanes.filter(l=>target==='both'||l.key===target);
  const at = takeAtts(); S.sending = true; S.chatDraft = ''; S.splitPending ||= {}; S.splitErrors ||= {};
  if ($('#chatText')) $('#chatText').value = '';
  for (const lane of lanes) { S.splitPending[lane.key] = true; delete S.splitErrors[lane.key]; }
  startLive(c=>lanes.some(l=>c.endsWith(':'+l.key))); renderChat();
  let succeeded = true;
  try {
    await Promise.all(lanes.map(async lane => {
      try {
        const result = await api(`/v1/users/${S.uid}/agents/ask`, {body:{conversation:lane.key,agent:lane.agent,...(lane.model ? {model:lane.model} : {}),...(lane.effort ? {effort:lane.effort} : {}),text,images:at.images,files:at.files,web:!!S.web}});
        if (result.error || result.ok === false || result.stopped) { succeeded = false; S.splitErrors[lane.key] = result.error || L('回答已停止，可选择此侧重试', 'Stopped; select this side to retry'); }
        const d = await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(lane.key)}`); S.chatTurns[lane.key] = d.turns;
      } catch (err) { succeeded = false; S.splitErrors[lane.key] = err.message; }
      finally { S.splitPending[lane.key] = false; if (S.chat===key) renderChat(); }
    }));
  } finally {
    S.sending = false; stopLive(); S.scrollChat = true;
    await loadChat(key); await drainFollowups(key,succeeded); if (S.chat===key) renderChat();
  }
}

/* who answers on one side can be changed at any time: that side carries on with its own history (the new agent is given
   all of it); the next message there goes to the new one */
function splitSideSelect(l, i) {
  const options = splitChoices();
  if (!options.some(c => splitSame(c, l))) options.unshift({label:splitLaneLabel(l), agent:l.agent, model:l.model || '', effort:l.effort || ''});
  const busy = S.sending || S.splitPending?.[l.key] || S.splitAdopting || S.splitSiding;
  const side = i ? L('右边', 'Right side') : L('左边', 'Left side');
  return `<select class="split-who" data-splitwho="${esc(l.key)}" ${busy ? 'disabled' : ''} aria-label="${esc(side)}" title="${esc(L(`${side}由谁回答：随时可以换，新的会读到这一边前面的全部对话`, `${side}: change who answers at any time; the new one reads all of this side so far`))}">${options.map(c =>
    `<option value="${esc(JSON.stringify({agent:c.agent, model:c.model || '', effort:c.effort || ''}))}" ${splitSame(c, l) ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`;
}
async function splitSide(laneKey, pick) {
  const key = S.chat, split = S.chatSplits?.[key], i = split?.lanes.findIndex(l => l.key === laneKey) ?? -1;
  if (i < 0 || splitSame(split.lanes[i], pick)) return;
  const side = i ? L('右边', 'The right side') : L('左边', 'The left side');
  if (split.lanes.some((l, n) => n !== i && splitSame(l, pick))) { toast(L('另一边已经是它了，换一个', 'The other side already uses it: pick another')); renderChat(); return; }
  S.splitSiding = true; renderChat();
  try {
    const r = await api(`/v1/users/${S.uid}/chats/compare-side`, {method:'PUT', body:{key, lane:laneKey, ...pick}});
    S.chatSplits[key] = r;
    const label = splitLaneLabel(r.lanes[i]);
    toast(L(`${side}换成 ${label}：之后这一边由它回答，它会读到这一边前面的全部对话`, `${side} is now ${label}: it answers there from now on and reads all of that side so far`));
  } catch (err) { toast(err.message); }
  finally { S.splitSiding = false; if (S.chat === key) renderChat(); }
}
async function splitAdopt(laneKey) {
  const key = S.chat, lane = S.chatSplits?.[key]?.lanes.find(l => l.key === laneKey);
  if (!lane || S.sending || S.splitAdopting) return;
  const label = splitLaneLabel(lane);
  S.splitAdopting = true; renderChat();
  try {
    const r = await api(`/v1/users/${S.uid}/chats/compare-adopt`, {body:{key, lane:laneKey}});
    S.chatSplits[key] = null; S.multi = []; S.chatMulti = {...(S.chatMulti || {}), [key]: []};
    S.chatAgent = lane.agent;
    S.chatModel = {...(S.chatModel || {}), [key]: lane.model || ''}; S.chatEffort = {...(S.chatEffort || {}), [key]: lane.effort || ''};
    if (typeof chatChoiceSave === 'function') chatChoiceSave(key);
    S.scrollChat = true; await loadChat(key); loadChats();
    toast(L(`采用了 ${label}：之后这段对话都由它回答${r.moved ? '；分屏前那个回答之后原来的内容，放进了分支「原来的后续」' : ''}`,
      `Adopted ${label}: it answers from now on${r.moved ? '; what followed the redone answer is in the branch “原来的后续”' : ''}`));
  } catch (err) { toast(err.message); }
  finally { S.splitAdopting = false; if (S.chat === key) renderChat(); }
}

/* 分支与合并 and the turn rail share one colour per related conversation that is open on the stage: its row in the tree
   takes the colour, and the turn it grew from lights up in it on the rail (the colour of its own return tick). */
function relOpen(key) {
  try {
    const host = window.parent; if (host === window || !host.ST) return false;
    const n = host.ST.nodes.find(x => x.type === 'win' && x.key === key); if (!n || n.branchDocked || n.mini) return false;
    return !(n.par && host.ST.nodes.find(p => p.id === n.par)?.kidsCollapsed);
  } catch { return false; }
}
function branchPositionMarks(keys, nodes, positions, self) {
  const visible = nodes.filter(n => n.type === 'win' && !n.mini && !n.branchDocked &&
    !(n.par && nodes.find(p => p.id === n.par)?.kidsCollapsed) && positions?.get(n.id));
  if (!visible.length) return [];
  const left = Math.min(...visible.map(n => positions.get(n.id).x));
  const right = Math.max(...visible.map(n => { const p = positions.get(n.id); return p.x + p.w; }));
  return visible.filter(n => keys.has(n.key)).map(n => {
    const p = positions.get(n.id);
    return {key:n.key, title:n.title || n.key, left:100*(p.x-left)/Math.max(1,right-left),
      width:100*p.w/Math.max(1,right-left), color:railPairColor(n.key === self.parent ? self.key : n.key)};
  });
}
function relPositions(tree) {
  const strip = tree?.querySelector('.cbpositions'); if (!strip) return;
  let marks = [];
  try {
    const host = window.parent;
    const keys = new Set([...tree.querySelectorAll('.cbn[data-mchat]')].map(b => b.dataset.mchat));
    marks = branchPositionMarks(keys, host.ST?.nodes || [], host.ST?.pos, {key:S.chat,parent:S.chatCtx?.[S.chat]?.branch?.from});
  } catch {}
  const html = marks.map(m => `<button class="cbposition" data-mchat="${esc(m.key)}" title="${esc(m.title)}" aria-label="${esc(m.title)}" style="left:${m.left}%;width:${m.width}%;--pair-color:${m.color}"></button>`).join('');
  if (strip.innerHTML !== html) strip.innerHTML = html;
  strip.hidden = !marks.length;
}
function relPaint() {
  const tree = $('#cbr'), rail = $('#cmap'), me = S.chat;
  relPositions(tree);
  tree?.querySelectorAll('.cbn[data-mchat]').forEach(b => {
    const key = b.dataset.mchat, on = relOpen(key);
    b.classList.toggle('open', on);
    if (on) b.style.setProperty('--pair-color', railPairColor(b.classList.contains('par') ? me : key)); else b.style.removeProperty('--pair-color');
  });
  rail?.querySelectorAll('.railrow[data-kids]').forEach(row => {
    const open = row.dataset.kids.split(',').filter(k => k && relOpen(k)), mark = row.querySelector('.railmark');
    if (!mark) return;
    mark.classList.remove('paired');
    mark.style.removeProperty('--pair-color');
    row.querySelectorAll('.railbranch').forEach(b => {
      b.classList.toggle('open', open.includes(b.dataset.mchat));
      b.style.setProperty('--pair-color', railPairColor(b.dataset.mchat));
    });
  });
}
let relSig = '';
if (typeof setInterval === 'function') setInterval(() => {                           // a branch opened or closed on the stage: repaint, nothing else
  if (S.stageDormant || S.stageMotion) return;
  if (stageBranchUiPending) { stageBranchUiPending = false; try { convMap(); branchTree(); requestAnimationFrame(updateParentRail); } catch {} }
  const keys = [...document.querySelectorAll('#cbr .cbn[data-mchat]:not(.spine), #cmap .railrow[data-kids]')].flatMap(e => (e.dataset.mchat || e.dataset.kids).split(','));
  const sig = keys.map(k => k + (relOpen(k) ? 1 : 0)).join();
  if (sig !== relSig) { relSig = sig; relPaint(); } else relPositions($('#cbr'));
}, 1200);
// One deterministic color per parent-child edge, shared by both return ticks.
function sourceRailColor(key) {
  let hash = 2166136261;
  for (const ch of key) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  return `hsl(${(hash >>> 0) % 360} 72% 60%)`;
}
function railPairColor(key) {
  let hash = 2166136261;
  for (const ch of String(key)) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619);
  let hue = (hash >>> 0) % 360;
  // Persist the identity color independently of project colors and window order.
  try {
    const stored = JSON.parse(localStorage.getItem('pga_branch_colors_v1') || '{}');
    const colors = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
    if (Object.hasOwn(colors, key) && Number.isFinite(colors[key])) hue = colors[key];
    else {
      const used = Object.values(colors).filter(Number.isFinite);
      const distance = h => used.length ? Math.min(...used.map(v => Math.min(Math.abs(h-v),360-Math.abs(h-v)))) : 360;
      // Choose the most separated available hue, starting at the key's stable hash.
      let best = distance(hue);
      for (let step=1; step<360; step++) {
        const candidate=(hue+step)%360, score=distance(candidate);
        if (score>best) { best=score; colors[key]=candidate; }
      }
      hue = colors[key] ?? hue; colors[key] = hue;
      localStorage.setItem('pga_branch_colors_v1', JSON.stringify(colors));
    }
  } catch {}
  return `hsl(${hue} 72% 60%)`;
}
function railParentInfo() {
  if (S.view !== 'chats' || S.lineView || S.imp) return null;
  const feed = executionFeedOf(S.chat);
  if (feed) return {from:feed, point:S.chatTurns?.[S.chat]?.[0]?.run, title:L('执行', 'Execution')};
  const b = S.chatCtx?.[S.chat]?.branch;
  if (b?.from && !b.split_lane) return {from:b.from, point:b.upto, title:S.chatCtx[S.chat].parent_title};
  try {
    const host=window.parent, me=host.ST?.nodes.find(n=>n.el?.querySelector('iframe')?.contentWindow===window);
    const parent=host.ST?.nodes.find(n=>n.id===me?.par);
    const from=me?.branchFrom || parent?.key;
    if(from) return {from,point:me.branchPoint};
  } catch {}
  return null;
}
function parentRailPosition(parentY, frameTop, top, bottom) {
  return Math.max(top, Math.min(bottom, parentY - frameTop));
}
function updateParentRail() {
  const info=railParentInfo(); let tick=document.getElementById('railReturn');
  if (!info) { tick?.remove(); return; }
  if (!tick) { tick=document.createElement('button'); tick.id='railReturn'; tick.className='railreturn'; tick.innerHTML='<i></i>'; document.body.append(tick); }
  tick.dataset.mparent=info.from; tick.dataset.parentPoint=String(info.point || '0');
  let pairKey = S.chat;
  try {
    const me = window.parent.ST?.nodes.find(n => n.el?.querySelector('iframe')?.contentWindow === window);
    if (me?.key) pairKey = me.key;
  } catch {}
  tick.style.setProperty('--pair-color',executionFeedOf(pairKey) ? sourceRailColor(pairKey) : railPairColor(pairKey));
  tick.title=L('返回母对话','Return to parent')+(info.title ? ' · '+info.title : ''); tick.setAttribute('aria-label',tick.title);
  const pane=document.querySelector('.cpane'), bounds=pane?.getBoundingClientRect();
  if (!bounds) return;
  const rail=document.getElementById('cmap'), rb=rail && !rail.hidden ? rail.getBoundingClientRect() : null;
  const top=Math.max(8,bounds.top+8), bottom=Math.max(top,Math.min(bounds.bottom-8,innerHeight-16));
  let y=top+8;
  try {
    const host=window.parent, parent=host.ST?.nodes.find(n=>n.key===info.from && n.type==='win');
    const frame=parent?.el?.querySelector('iframe'), anchor=frame?.contentWindow?.convMapAnchor?.(info.point,S.chat);
    if (anchor && window.frameElement) y=parentRailPosition(frame.getBoundingClientRect().top+anchor.y,window.frameElement.getBoundingClientRect().top,top,bottom);
  } catch {}
  tick.style.top=(y-8)+'px'; tick.style.left='2px';
}
async function returnToParent(key, point) {
  try {
    const host=window.parent;
    if (host!==window && host.stOpen) {
      if (host.stReturnParent) {
        host.stReturnParent(key);
        if (point && executionFeedOf(S.chat) === key) pdJumpIn(host, key, point, '');
        return;
      }
      const node=host.stOpen(key); const frame=node.el?.querySelector('iframe');
      const locate=()=>{const doc=frame?.contentDocument; const target=doc?.getElementById('a-'+point)||doc?.getElementById('t-'+point)||doc?.getElementById('import-turn-'+Math.max(0,Number(point)-1));target?.scrollIntoView({block:'center',behavior:'smooth'});};
      if (frame?.contentWindow?.S?.chat===key) locate();
      else frame?.addEventListener('load',()=>{const cw=frame.contentWindow;Promise.resolve(cw.loadChat?.(key)).then(locate);},{once:true});
      return;
    }
  } catch {}
  S.chat=key;S.lineView=null;S.imp=null;history.replaceState(null,'',qs());await loadChat(key);
  (document.getElementById('a-'+point)||document.getElementById('t-'+point))?.scrollIntoView({block:'center',behavior:'smooth'});
}
window.updateParentRail=updateParentRail;
window.addEventListener('resize',updateParentRail);
