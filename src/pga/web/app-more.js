/* PGA app · the rest of what Open WebUI does, made PGA's way: several agents answering at once and read side by side,
   web pages and web search, running code (JavaScript in a sandboxed frame, Python with Pyodide in a worker), notes, and
   the conversation map — a tree bar beside every conversation (its turns, the versions of an answer, the branches that
   grew from it). Loaded after app-compose.js. */

/* ------------------------------------------------ several agents at once */
S.multi = []; S.web = false; S.sideBy = {};
async function pickMulti(anchor) {
  document.querySelector(".fmenu")?.remove();
  const m = document.createElement("div"); m.className = "ctx fmenu";
  m.innerHTML = `<div class="ch">${L("同时问几个 agent，回答并排放", "Ask several agents at once, side by side")}</div>
    ${S.agents.map((a) => `<label class="mrow"><input type="checkbox" data-magent="${esc(a.name)}" ${S.multi.includes(a.name) ? "checked" : ""}> ${esc(agentLabel(a.name))}<span class="dimt">${esc((a.role || "").split("·")[0])}</span></label>`).join("")}
    <hr><button data-act="multidone">${L("好了", "Done")}</button>`;
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect(), h = m.getBoundingClientRect();
  m.style.left = Math.min(r.left, innerWidth - h.width - 8) + "px"; m.style.top = Math.max(8, r.top - h.height - 6) + "px";
}
const moreTools = () => `<button class="ghost ctool ${S.multi.length > 1 ? "on2" : ""}" data-act="multi" title="${L("同时问几个 agent", "Ask several agents at once")}">${MI.multi}${S.multi.length > 1 ? `<small>${S.multi.length}</small>` : ""}</button>
  <button class="ghost ctool ${S.web ? "on2" : ""}" data-act="web" title="${L("联网：先上网查再回答（只交给能上网的 agent）", "Web: look it up first (only agents that can browse)")}">${MI.web}</button>`;
/* the first agent answers in the conversation itself; the others answer the same question with the same history at the
   same time, and are then filed under the first answer as its versions — so they read side by side */
async function multiSend() {
  const text = ($("#chatText")?.value || "").trim(); if (!text) return;
  if (!S.chat) S.chat = `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const key = S.chat, prev = S.chatTurns[key] || [], ctx = S.chatCtx?.[key]?.context || [], names = [...S.multi];
  const hist = [...ctx, ...prev].slice(-12).map((t) => ({ role: t.role === "user" ? "user" : "assistant", text: t.text }));
  const at = takeAtts(), tag = Math.random().toString(36).slice(2, 8);
  S.chatTurns[key] = [...prev, { role: "user", text, at: new Date().toISOString() }];
  S.sentHist = [...S.sentHist.filter((x) => x !== text), text].slice(-50);
  S.sending = true; S.chatDraft = ""; history.replaceState(null, "", qs()); startLive((c) => c.endsWith(":" + key) || c.includes("multi:" + tag + ":")); S.liveMulti = names.slice(1); renderChat(); $("#chatText").value = "";
  const body = (agent, conversation) => ({ text, agent, conversation, history: hist, refs: S.chatRefs, images: at.images, files: at.files, web: S.web });
  const rs = await Promise.all(names.map((n, i) => api(`/v1/users/${S.uid}/agents/ask`, { body: body(n, i === 0 ? key : `multi:${tag}:${n}`) }).catch((e) => ({ error: e.message }))));
  S.sending = false; stopLive(); S.liveMulti = null;
  const root = rs[0]?.run_id, others = rs.slice(1).map((r) => r.run_id).filter(Boolean);
  if (root && others.length) { try { await api(`/v1/users/${S.uid}/chats/fold`, { body: { root, runs: others, key } }); } catch (err) { toast(err.message); } }
  rs.forEach((r, i) => { if (r.error && !r.text) toast(`${names[i]}: ${r.error}`); });
  if (root) S.sideBy[root] = true;
  S.scrollChat = true; await loadChats(); await loadChat(key); loadTimeline();
}
/* answers from different agents are read side by side unless you fold them back; versions of one agent's answer are flipped through */
const sideOn = (t) => (t.versions || []).length > 1 && (S.sideBy[t.run] ?? new Set(t.versions.map((v) => v.agent)).size > 1);
function sideBySide(t) {
  const vs = t.versions || [];
  return `<div class="sbs" style="--n:${Math.min(3, vs.length)}">${vs.map((v) => `<div class="sbc ${v.run === t.version ? "cur" : ""}"><div class="sbh"><b>${esc(agentLabel(v.agent || "AI"))}</b>${v.model ? `<span>${esc(v.model)}</span>` : ""}${v.how?.seconds != null ? `<span>${v.how.seconds}s</span>` : ""}<span class="grow"></span>
      ${v.run === t.version ? `<span class="pill">${L("在用这一版", "In use")}</span>` : `<button class="sm ghost" data-act="ver" data-run="${t.run}" data-v="${esc(v.run)}">${L("用这一版", "Use this")}</button>`}</div>
    <div class="ct md">${md(v.text || (v.error ? "⚠ " + v.error : ""))}</div></div>`).join("")}</div>`;
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
new MutationObserver(() => {               // a 运行 button on runnable code blocks (after app-compose.js added the header)
  for (const hd of document.querySelectorAll(".codehd:not([data-run])")) {
    hd.dataset.run = "1";
    const lang = hd.firstElementChild?.textContent || "";
    if (RUNNABLE.test(lang)) hd.insertAdjacentHTML("beforeend", `<button data-act="runcode">${L("运行", "Run")} ▶</button>`);
  }
}).observe(document.body, { childList: true, subtree: true });

/* ------------------------------------------------ notes */
S.notes = null; S.note = null;
async function loadNotes() { S.notes = await api(`/v1/users/${S.uid}/notes`).catch(() => []); return S.notes; }
async function showNotes() {
  document.title = L("笔记 · PGA", "Notes · PGA"); await loadNotes();
  if (!S.note && S.notes.length) S.note = S.notes[0].id;
  renderNotes();
}
function renderNotes() {
  const n = (S.notes || []).find((x) => x.id === S.note);
  $("#nlist").innerHTML = `<div class="ch"><b>${L("笔记", "Notes")}</b><span class="grow"></span><button class="sm" data-act="newnote">${L("＋ 新笔记", "+ New note")}</button></div>
    ${(S.notes || []).map((x) => `<div class="ni ${x.id === S.note ? "on" : ""}" data-note="${x.id}"><b>${esc(x.title)}</b><span>${esc(ago(x.at))} · ${kfmt(x.chars)} ${L("字", "chars")}</span></div>`).join("") || `<div class="empty" style="padding:20px 14px">${L("还没有笔记。写下想法、计划、摘抄；对话里用 # 引用，回复也能「存进笔记」。", "No notes yet. Ideas, plans, clippings; cite them with # in a chat, or save a reply into one.")}</div>`}`;
  $("#npane").innerHTML = n ? `<div class="nhd"><input type="text" id="ntitle" value="${esc(n.title)}"><span class="dimt" id="nsaved">${L("已保存", "Saved")}</span>
      <span class="seg"><button class="${S.nprev ? "" : "on"}" data-act="nedit">${L("编辑", "Edit")}</button><button class="${S.nprev ? "on" : ""}" data-act="nprev">${L("预览", "Preview")}</button></span>
      <button class="sm ghost" data-act="ndel">${L("删除", "Delete")}</button></div>
    ${S.nprev ? `<div class="nprev md">${md(n.text || "")}</div>` : `<textarea id="ntext" placeholder="${L("Markdown：标题、列表、代码、公式都能写", "Markdown: headings, lists, code and maths all work")}">${esc(n.text || "")}</textarea>`}`
    : `<div class="chello"><h2>${L("笔记", "Notes")}</h2><div>${L("点「新笔记」开始写。", "Press “New note” to start.")}</div></div>`;
}
let NT = null;
function saveNoteSoon() {
  clearTimeout(NT); const s = $("#nsaved"); if (s) s.textContent = L("正在保存…", "Saving…");
  NT = setTimeout(async () => {
    const id = S.note, text = $("#ntext")?.value, title = $("#ntitle")?.value;
    try { const r = await api(`/v1/notes/${id}`, { method: "PUT", body: { ...(text != null ? { text } : {}), title } }); const x = S.notes.find((y) => y.id === id); if (x) Object.assign(x, { title: r.title, text: r.text, at: r.at, chars: r.text.length });
      const s2 = $("#nsaved"); if (s2) s2.textContent = L("已保存", "Saved"); document.querySelectorAll(`.ni[data-note="${id}"] b`).forEach((b) => { b.textContent = r.title; }); }
    catch (err) { toast(err.message); }
  }, 700);
}
async function toNote(anchor, text) {
  await loadNotes(); document.querySelector(".fmenu")?.remove();
  const m = document.createElement("div"); m.className = "ctx fmenu"; m.dataset.text = text;
  m.innerHTML = `<div class="ch">${L("存进哪份笔记", "Save into which note")}</div><button data-tonote="">＋ ${L("新笔记", "New note")}</button>${S.notes.slice(0, 12).map((x) => `<button data-tonote="${x.id}">${esc(x.title)}</button>`).join("")}`;
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect(), h = m.getBoundingClientRect(); m.style.left = Math.min(r.left, innerWidth - h.width - 8) + "px"; m.style.top = Math.max(8, Math.min(r.bottom + 4, innerHeight - h.height - 8)) + "px";
}

/* ------------------------------------------------ the conversation map: a tree bar beside the conversation */
function convMap() {
  const box = $("#cmap"); if (!box) return;
  if (S.view !== "chats" || (!S.chat && !S.lineView)) { box.innerHTML = ""; box.hidden = true; return; }
  let nodes = [], title = "";
  if (S.lineView) {                          // a line: each stretch of a conversation, in time order
    title = L("这条线", "This line");
    [...document.querySelectorAll("#cdlgIn .lseg")].forEach((el, i) => { el.id = el.id || "seg-" + i;
      nodes.push({ id: el.id, label: el.querySelector("b")?.textContent || "", sub: el.querySelector("span")?.textContent || "", target: el.dataset.ltarget, on: el.classList.contains("on") }); });
  } else {
    const ts = S.chatTurns[S.chat] || [], c = S.chatCtx?.[S.chat], kids = S.chatKids?.[S.chat] || [];
    title = L("这段对话", "This conversation");
    if (c?.branch) nodes.push({ parent: c.branch.from, label: L("从另一段对话分出来", "Branched from another chat"), kind: "parent" });
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i]; if (t.role !== "user" || !t.run) continue;
      const a = ts[i + 1]?.role === "agent" ? ts[i + 1] : null;
      nodes.push({ id: "t-" + t.run, label: t.text, sub: a ? agentLabel(a.agent || "") : "", versions: a?.versions?.length || 0, run: t.run,
        kids: kids.filter((k) => k.upto === (a?.run || t.run)), live: S.sending && i === ts.length - 1 });
    }
    if (S.sending && ts[ts.length - 1]?.role === "user" && !ts[ts.length - 1].run) nodes.push({ id: "", label: ts[ts.length - 1].text, live: true });
  }
  if (!nodes.length) { box.innerHTML = ""; box.hidden = true; return; }
  box.hidden = false;
  const H = Math.max(160, ($("#cdlg")?.clientHeight || 500) - 90), step = Math.max(14, Math.min(34, (H - 70) / Math.max(1, nodes.length + nodes.reduce((a, n) => a + (n.kids?.length || 0) * .6, 0))));
  let y = 22, svg = "", rows = "", prevY = null;
  for (const n of nodes) {
    if (n.kind === "parent") { svg += `<path class="mpar" d="M 14 0 L 14 ${y}"/>`; rows += `<button class="mn par" style="top:${y - 9}px" data-mparent="${esc(n.parent)}" title="${esc(n.label)}">↰</button>`; prevY = y; y += step; continue; }
    if (prevY != null) svg += `<path class="mtr" d="M 14 ${prevY} L 14 ${y}"/>`;
    for (let v = 1; v < Math.min(4, n.versions); v++) svg += `<circle class="mver" cx="${14 - v * 6}" cy="${y}" r="2"/>`;
    rows += `<button class="mn ${n.live ? "live" : ""} ${n.on ? "tgt" : ""}" style="top:${y - 9}px" title="${esc(String(n.label || "").slice(0, 200))}" data-mgo="${esc(n.id)}" data-mtarget="${esc(n.target || "")}"><i></i><span class="ml">${esc(String(n.label || "").replace(/\s+/g, " ").slice(0, 60))}${n.sub ? `<em>${esc(n.sub)}</em>` : ""}${n.versions > 1 ? `<em>${L(`${n.versions} 个版本`, `${n.versions} versions`)}</em>` : ""}</span></button>`;
    prevY = y;
    for (const k of n.kids || []) {
      y += step * .7;
      svg += `<path class="mbr" d="M 14 ${prevY} C 14 ${prevY + 8}, 26 ${y - 6}, 30 ${y}"/>`;
      rows += `<button class="mn kid" style="top:${y - 9}px;left:24px" data-mchat="${esc(k.key)}"><i></i><span class="ml">↳ ${esc(k.title || L("一条分支", "a branch"))}</span></button>`;
    }
    y += step;
  }
  box.classList.toggle("wide", (box.parentElement?.clientWidth || 0) > 1480);
  box.innerHTML = `<div class="mh">${esc(title)}<span>${nodes.filter((n) => n.kind !== "parent").length}</span></div><div class="mb" style="height:${y}px"><svg width="60" height="${y}">${svg}</svg>${rows}</div>`;
  syncMap();
}
function syncMap() {                        // which turn you are reading
  const w = $("#cdlg"), box = $("#cmap"); if (!w || !box || box.hidden) return;
  const top = w.getBoundingClientRect().top + 80; let cur = null;
  for (const b of box.querySelectorAll("[data-mgo]")) { const el = b.dataset.mgo && document.getElementById(b.dataset.mgo); if (el && el.getBoundingClientRect().top <= top) cur = b; }
  box.querySelectorAll(".mn.on").forEach((b) => b.classList.remove("on")); (cur || box.querySelector("[data-mgo]"))?.classList.add("on");
}
document.addEventListener("scroll", (e) => { if (e.target.id === "cdlg") syncMap(); }, true);
const _renderChat = renderChat;
renderChat = function () {                  // the map follows whatever the chat pane shows
  _renderChat();
  if (S.sending && S.liveMulti?.length && !S.lineView) $("#workCard")?.insertAdjacentHTML("beforebegin", `<div class="mstrip"><span class="pulse"></span>${L("同时在答：", "Also answering: ")}${S.liveMulti.map((n) => `<b>${esc(agentLabel(n))}</b>`).join("")}<span class="dimt">${L("答完会并排放", "answers will sit side by side")}</span></div>`);
  const key = S.lineView || S.chat || "", n = document.querySelectorAll("#cdlgIn .chat").length;   // new messages rise in; old ones stay still
  if (FRESH.key === key && n > FRESH.n) [...document.querySelectorAll("#cdlgIn .chat")].slice(FRESH.n - n).forEach((el) => el.classList.add("fresh"));
  FRESH = { key, n };
  convMap();
};
let FRESH = { key: null, n: 0 };
const _renderLine = renderLineDialog;
renderLineDialog = function () { _renderLine(); if (S.lineView) convMap(); };

/* ------------------------------------------------ events of this module */
document.addEventListener("click", async (e) => {
  const mc = e.target.closest("[data-magent]"); if (mc) { const n = mc.dataset.magent; S.multi = mc.checked ? [...new Set([...S.multi, n])] : S.multi.filter((x) => x !== n); return; }
  const mg = e.target.closest("[data-mgo]"); if (mg) { const el = mg.dataset.mgo && document.getElementById(mg.dataset.mgo); if (el) { const w = $("#cdlg"); w.scrollTo({ top: el.getBoundingClientRect().top - w.getBoundingClientRect().top + w.scrollTop - 12, behavior: "smooth" }); } else if (mg.dataset.mtarget) { S.lineTarget = mg.dataset.mtarget; renderChat(); } return; }
  const mk = e.target.closest("[data-mchat], [data-mparent]"); if (mk) { S.chat = mk.dataset.mchat || mk.dataset.mparent; S.lineView = null; S.imp = null; history.replaceState(null, "", qs()); renderChat(); loadChat(S.chat); return; }
  const tn = e.target.closest("[data-tonote]"); if (tn) { const text = tn.closest(".fmenu").dataset.text; document.querySelector(".fmenu")?.remove();
    try { if (tn.dataset.tonote) await api(`/v1/notes/${tn.dataset.tonote}`, { method: "PUT", body: { text, append: true } }); else await api(`/v1/users/${S.uid}/notes`, { body: { text } });
      toast(L("存进笔记了", "Saved into the note")); S.notes = null; } catch (err) { toast(err.message); } return; }
  const ni = e.target.closest("[data-note]"); if (ni) { S.note = ni.dataset.note; renderNotes(); return; }
  const b = e.target.closest("[data-act]"); if (!b) return;
  const a = b.dataset.act;
  if (a === "multi") pickMulti(b);
  else if (a === "multidone") { document.querySelector(".fmenu")?.remove(); if (S.multi.length === 1) S.multi = []; renderChat(); toast(S.multi.length > 1 ? L(`下一条会同时问 ${S.multi.join("、")}`, `The next message goes to ${S.multi.join(", ")} at once`) : L("恢复成一次问一个", "Back to one agent at a time")); }
  else if (a === "web") { S.web = !S.web; renderChat(); toast(S.web ? L("联网：下一条会先上网查", "Web on: the next message looks it up first") : L("不联网了", "Web off")); }
  else if (a === "runcode") runCode(b.closest("pre"));
  else if (a === "sideby") { const t = (S.chatTurns[S.chat] || []).find((x) => x.role === "agent" && x.run === b.dataset.run); S.sideBy[b.dataset.run] = !(t ? sideOn(t) : S.sideBy[b.dataset.run]); renderChat(); }
  else if (a === "tonote") toNote(b, b.dataset.text || "");
  else if (a === "newnote") { try { const r = await api(`/v1/users/${S.uid}/notes`, { body: { title: L("新笔记", "New note"), text: "" } }); await loadNotes(); S.note = r.id; S.nprev = false; renderNotes(); $("#ntext")?.focus(); } catch (err) { toast(err.message); } }
  else if (a === "nedit") { S.nprev = false; renderNotes(); }
  else if (a === "nprev") { S.nprev = true; renderNotes(); }
  else if (a === "ndel") { if (!confirm(L("删除这份笔记？", "Delete this note?"))) return; try { await api(`/v1/bodies/${S.note}`, { method: "DELETE" }); S.note = null; await loadNotes(); S.note = S.notes[0]?.id || null; renderNotes(); } catch (err) { toast(err.message); } }
});
document.addEventListener("input", (e) => { if (e.target.id === "ntext" || e.target.id === "ntitle") saveNoteSoon(); });
const MI = { multi: ICO('<rect x="3" y="4" width="7" height="16" rx="2"/><rect x="14" y="4" width="7" height="16" rx="2"/>'), web: ICO('<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z"/>'),
  note: ICO('<path d="M5 3h10l4 4v14H5z"/><path d="M14 3v5h5"/><path d="M8 13h8M8 17h5"/>') };
