/* PGA app · the chat experience learned from Open WebUI (reimplemented, not copied — see notes/open-webui-study.md):
   rich answers (highlighted code with copy and preview, KaTeX math, Mermaid diagrams), an action bar on every message
   (copy, regenerate with versions, rate, read aloud, edit = a new branch), a composer with attachments, voice input,
   "/" prompts, "@" agents and ↑ history, search across everything you said, rename and export, and keyboard shortcuts.
   Plain script in the app's shared global scope, loaded after app-live.js and before app-events.js. */

/* ------------------------------------------------ rich answers */
let MATH_ON = false;
function mathExtensions() {               // $…$, $$…$$, \(…\), \[…\] → KaTeX, inside marked (so markdown does not eat the math)
  if (MATH_ON || !window.marked || !window.katex) return;
  MATH_ON = true;
  const tex = (t, display) => { try { return katex.renderToString(t, { displayMode: display, throwOnError: false }); } catch { return esc(t); } };
  marked.use({ extensions: [
    { name: "mathBlock", level: "block", start: (src) => { const i = src.search(/\$\$|\\\[/); return i < 0 ? undefined : i; },
      tokenizer(src) { const m = /^\$\$([\s\S]+?)\$\$/.exec(src) || /^\\\[([\s\S]+?)\\\]/.exec(src); if (m) return { type: "mathBlock", raw: m[0], text: m[1].trim() }; },
      renderer: (t) => `<div class="mathb">${tex(t.text, true)}</div>` },
    { name: "mathInline", level: "inline", start: (src) => { const i = src.search(/\$(?!\s)|\\\(/); return i < 0 ? undefined : i; },
      tokenizer(src) { const m = /^\$(?![\s$])([^$\n]+?)(?<!\s)\$(?!\d)/.exec(src) || /^\\\(([\s\S]+?)\\\)/.exec(src); if (m) return { type: "mathInline", raw: m[0], text: m[1] }; },
      renderer: (t) => tex(t.text, false) },
  ] });
}
let MERMAID = null;
function loadMermaid() {
  if (MERMAID) return MERMAID;
  MERMAID = new Promise((ok) => { const s = document.createElement("script"); s.src = "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js";
    s.onload = () => { mermaid.initialize({ startOnLoad: false, theme: document.documentElement.dataset.theme === "light" ? "default" : "dark", securityLevel: "strict" }); ok(window.mermaid); };
    s.onerror = () => ok(null); document.head.appendChild(s); });
  return MERMAID;
}
const PREVIEWABLE = /^(html|svg|xml)$/i;
function enhance(root) {                   // code blocks: highlight, a header with the language, copy and (for HTML/SVG) preview
  mathExtensions();
  for (const code of root.querySelectorAll("pre > code:not([data-done])")) {
    code.dataset.done = "1";
    const pre = code.parentElement, lang = ((code.className.match(/language-([\w+-]+)/) || [])[1] || "").toLowerCase();
    if (lang === "mermaid") {
      const box = document.createElement("div"); box.className = "mermaid"; box.textContent = code.textContent; pre.replaceWith(box);
      loadMermaid().then((m) => m && m.run({ nodes: [box] }).catch(() => { box.classList.add("bad"); }));
      continue;
    }
    if (window.hljs) { try { if (lang && hljs.getLanguage(lang)) hljs.highlightElement(code); else if (!lang && code.textContent.length < 20000) hljs.highlightElement(code); } catch {} }
    const hd = document.createElement("div"); hd.className = "codehd";
    hd.innerHTML = `<span>${esc(lang || (code.result?.language) || "code")}</span><span class="grow"></span>${PREVIEWABLE.test(lang) || /^\s*<(!doctype|html|svg)/i.test(code.textContent) ? `<button data-act="preview">${L("预览", "Preview")}</button>` : ""}<button data-act="copycode">${L("复制", "Copy")}</button>`;
    pre.classList.add("codeblk"); pre.insertBefore(hd, code);
  }
}
new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1 && (n.querySelector?.("pre > code:not([data-done])") || n.matches?.("pre"))) { enhance(n.matches?.("pre") ? n.parentElement : n); } })
  .observe(document.body, { childList: true, subtree: true });

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch { const a = document.createElement("textarea"); a.value = t; document.body.appendChild(a); a.select(); document.execCommand("copy"); a.remove(); }
  toast(L("已复制", "Copied"));
}
function preview(code) {
  modal(`<div class="pvh"><b>${L("预览", "Preview")}</b><span class="dimt">${L("在隔离的框里运行，不能读你的页面", "Runs in an isolated frame; it cannot read your page")}</span></div>
    <iframe class="pvf" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>`);
  const f = document.querySelector(".modal .pvf"); f.srcdoc = code;
  document.querySelector(".modal .box").classList.add("wide");
}

/* ------------------------------------------------ the action bar on each message */
const ICO = (d) => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const I = { copy: ICO('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'), regen: ICO('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  speak: ICO('<path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'),
  up: ICO('<path d="M7 11v9H4v-9z"/><path d="M7 11l4-8a2 2 0 0 1 3 2l-1 5h5a2 2 0 0 1 2 2.3l-1.2 6A2 2 0 0 1 16.8 20H7"/>'),
  down: ICO('<path d="M7 13V4H4v9z"/><path d="M7 13l4 8a2 2 0 0 0 3-2l-1-5h5a2 2 0 0 0 2-2.3l-1.2-6A2 2 0 0 0 16.8 4H7"/>'),
  edit: ICO('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'), clip: ICO('<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>'),
  mic: ICO('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>'), search: ICO('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>') };

const plain = (t) => String(t || "").replace(/```[\s\S]*?```/g, " ").replace(/[#*_`>|-]+/g, " ").replace(/\s+/g, " ").trim();
function userActs(t, key, prevRun) {
  if (!t.run) return "";
  return `<div class="macts right"><button data-act="copy" data-text="${esc(t.text)}" title="${L("复制", "Copy")}">${I.copy}</button>
    <button data-act="edit" data-run="${t.run}" data-key="${esc(key)}" data-prev="${esc(prevRun || "")}" title="${L("改一改再问：长成一条新分支，原来的不动", "Edit and ask again: grows a new branch, the original stays")}">${I.edit}</button></div>`;
}
function replyActs(t, key) {
  if (!t.run) return "";
  const vs = t.versions || [], i = Math.max(0, vs.findIndex((v) => v.run === t.version)), busy = S.regenBusy === t.run, sec = t.second, sb = S.secondBusy === t.run;
  return `<div class="macts">
    ${vs.length > 1 ? `<span class="vers"><button data-act="ver" data-run="${t.run}" data-v="${esc(vs[Math.max(0, i - 1)].run)}" ${i === 0 ? "disabled" : ""}>‹</button><span class="num">${i + 1}/${vs.length}</span><button data-act="ver" data-run="${t.run}" data-v="${esc(vs[Math.min(vs.length - 1, i + 1)].run)}" ${i === vs.length - 1 ? "disabled" : ""}>›</button></span>` : ""}
    <button data-act="copy" data-text="${esc(t.text)}" title="${L("复制", "Copy")}">${I.copy}</button>
    <button data-act="regen" data-run="${t.run}" data-key="${esc(key)}" ${busy ? "disabled" : ""} title="${L("重新生成：同样的问题再答一版，几版之间可以切换", "Regenerate: another version of this answer; flip between versions")}">${busy ? `<span class="spin"></span>` : I.regen}</button>
    <button data-act="speak" data-text="${esc(plain(t.text).slice(0, 4000))}" title="${L("朗读", "Read aloud")}">${I.speak}</button>
    <button data-act="rate" data-run="${esc(t.version || t.run)}" data-to="${t.rating === 1 ? 0 : 1}" class="${t.rating === 1 ? "on" : ""}" title="${L("好回答", "Good answer")}">${I.up}</button>
    <button data-act="rate" data-run="${esc(t.version || t.run)}" data-to="${t.rating === -1 ? 0 : -1}" class="${t.rating === -1 ? "on bad" : ""}" title="${L("不好的回答", "Bad answer")}">${I.down}</button>
    <span class="sep"></span>
    ${sec ? "" : `<button class="txt" data-second="${t.run}" data-ckey="${esc(key)}" ${sb ? "disabled" : ""}>${sb ? L("正在问另一个 agent…", "Asking another agent…") : L("第二意见", "Second opinion")}</button>`}
    <button class="txt" data-cbranch="${t.run}" data-ckey="${esc(key)}">${L("从这里分支", "Branch from here")}</button></div>`;
}
function editBox(t) {
  return `<div class="editbox"><textarea id="editText">${esc(t.text)}</textarea><div class="row2"><span class="dimt" style="font-size:12px">${L("改过的问题会长成一条新分支，原来那段保留在旁边。", "The edited question grows a new branch; the original stays beside it.")}</span><span class="grow"></span>
    <button class="ghost" data-act="editcancel">${L("取消", "Cancel")}</button><button class="primary" data-act="editsend">${L("发送", "Send")}</button></div></div>`;
}
async function regen(run, key) {
  S.regenBusy = run; renderChat(); startLive((c) => c.includes(":regen:" + run));
  try { const r = await api(`/v1/users/${S.uid}/chats/regen`, { body: { run, agent: $("#chatAgent")?.value || "auto" } }); if (r.error && !r.text) toast(r.error); }
  catch (err) { toast(err.message); }
  finally { S.regenBusy = null; stopLive(); await loadChat(key); }
}
async function editSend() {
  const e = S.editing; if (!e) return;
  const text = ($("#editText")?.value || "").trim(); if (!text) return;
  try {
    let key;
    if (e.prev) { const r = await api(`/v1/users/${S.uid}/chats/branch`, { body: { from: e.key, upto: e.prev } }); key = r.key; }
    else key = `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    S.editing = null; S.lineView = null; S.imp = null; S.chat = key; S.chatTurns[key] = []; history.replaceState(null, "", qs());
    await loadChat(key); loadTimeline(); renderChat(); $("#chatText").value = text; await chatSend();
  } catch (err) { toast(err.message); }
}
let SPEAKING = null;
function speak(text, btn) {
  if (!window.speechSynthesis) { toast(L("这个浏览器不能朗读", "This browser cannot read aloud")); return; }
  if (SPEAKING) { speechSynthesis.cancel(); SPEAKING.classList.remove("on"); const was = SPEAKING; SPEAKING = null; if (was === btn) return; }
  const u = new SpeechSynthesisUtterance(text); u.lang = /[㐀-鿿]/.test(text) ? "zh-CN" : "en-US";
  u.onend = u.onerror = () => { btn.classList.remove("on"); if (SPEAKING === btn) SPEAKING = null; };
  SPEAKING = btn; btn.classList.add("on"); speechSynthesis.speak(u);
}

/* ------------------------------------------------ the composer: attachments, voice, "/" prompts, "@" agents, ↑ history */
S.att = []; S.sentHist = []; S.prompts = null;
const composeTools = () => `<button class="ghost ctool" data-act="attach" title="${L("附件：图片和文档（也可以粘贴或拖进来）", "Attach images and documents (or paste / drop them)")}">${I.clip}</button>
  <button class="ghost ctool ${S.listening ? "on" : ""}" data-act="mic" title="${L("语音输入", "Voice input")}">${I.mic}</button>`;
const attsHtml = () => (S.att.length ? `<div class="atts">${S.att.map((a, i) => `<span class="att">${a.type.startsWith("image/") ? `<img src="${a.data}" alt="">` : "📄"}<span>${esc(a.name)}</span><button data-act="unattach" data-i="${i}">×</button></span>`).join("")}</div>` : "");
function rerenderComposer() { const t = $("#chatText")?.value; if (S.view === "chats") renderChat(); const n = $("#chatText"); if (n && t != null) { n.value = t; autoGrow(n); } }
async function addFiles(list) {
  for (const f of [...(list || [])].slice(0, 6 - S.att.length)) {
    if (f.size > 20e6) { toast(L(`${f.name} 太大（超过 20 MB）`, `${f.name} is over 20 MB`)); continue; }
    const data = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f); });
    S.att.push({ name: f.name || "pasted.png", type: f.type || "application/octet-stream", data, size: f.size });
  }
  rerenderComposer();
}
function takeAtts() {                      // for the request: pictures and documents, then the composer is empty again
  const a = S.att; S.att = [];
  return { images: a.filter((x) => x.type.startsWith("image/")).map((x) => ({ name: x.name, data: x.data })),
           files: a.filter((x) => !x.type.startsWith("image/")).map((x) => ({ name: x.name, data: x.data })) };
}
let REC = null;
function mic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast(L("这个浏览器不支持语音输入（Chrome、Safari 可以）", "Voice input needs Chrome or Safari")); return; }
  if (REC) { REC.stop(); return; }
  const box = $("#chatText") || $("#tnText"); if (!box) return;
  const base = box.value ? box.value + " " : "";
  REC = new SR(); REC.lang = EN ? "en-US" : "zh-CN"; REC.interimResults = true; REC.continuous = true;
  REC.onresult = (e) => { let s = ""; for (const r of e.results) s += r[0].transcript; const b = $("#chatText") || $("#tnText"); if (b) { b.value = base + s; autoGrow(b); } };
  REC.onend = () => { REC = null; S.listening = false; document.querySelectorAll('[data-act="mic"]').forEach((b) => b.classList.remove("on")); };
  REC.onerror = (e) => { toast(L("语音输入出错：", "Voice input: ") + (e.error || "")); };
  S.listening = true; document.querySelectorAll('[data-act="mic"]').forEach((b) => b.classList.add("on")); REC.start();
}
async function prompts() { if (S.prompts == null) S.prompts = await api(`/v1/users/${S.uid}/prompts`).catch(() => []); return S.prompts; }
let POP = null;                            // the "/" or "@" list above the composer: {box, kind, items, i, start}
function closePop() { document.querySelector(".cpop")?.remove(); POP = null; }
async function suggest(box) {
  const v = box.value, pos = box.selectionStart, before = v.slice(0, pos);
  let m = before.match(/(^|\s)@([\w.\-一-鿿]*)$/), items, kind;
  if (m) { kind = "@"; const q = m[2].toLowerCase(); items = S.agents.filter((a) => a.name.toLowerCase().includes(q) || agentLabel(a.name).toLowerCase().includes(q)).map((a) => ({ id: a.name, label: agentLabel(a.name), sub: a.role || "" })); }
  else if ((m = before.match(/^\/([\w\-一-鿿]*)$/))) { kind = "/"; const q = m[1].toLowerCase(), ps = await prompts();
    items = ps.filter((p) => p.command.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)).map((p) => ({ id: p.command, label: "/" + p.command, sub: p.title, text: p.text }));
    items.push({ id: "__manage", label: L("管理提示词库…", "Manage prompts…"), sub: L("新建、修改、删除", "add, edit, delete") }); }
  else if ((m = before.match(/(^|\s)#([\w\-一-鿿]*)$/))) { kind = "#"; const q = m[2].toLowerCase(), K = S.forest?.knowledge || [];
    items = K.filter((k) => (k.title || "").toLowerCase().includes(q)).slice(0, 30).map((k) => ({ id: k.id, label: k.title, sub: sysName(k) + (k.chars ? ` · ${kfmt(k.chars)} ${L("字", "chars")}` : "") }));
    items.push({ id: "__upload", label: L("上传一份文档…", "Upload a document…"), sub: L("读成文字存进知识库，并在这次对话里引用", "kept in the knowledge base and cited here") }); }
  if (!kind) { closePop(); return; }
  POP = { box, kind, items, i: 0, start: pos - m[0].length + (m[1] && kind !== "/" ? m[1].length : 0) };
  drawPop();
}
function drawPop() {
  document.querySelector(".cpop")?.remove(); if (!POP || !POP.items.length) { POP = null; return; }
  const el = document.createElement("div"); el.className = "cpop";
  el.innerHTML = `<div class="ph">${POP.kind === "@" ? L("交给哪个 agent", "Which agent") : POP.kind === "#" ? L("引用知识（只把相关段落给 agent）", "Cite knowledge (only matching passages go)") : L("提示词", "Prompts")}<span>↑↓ · Enter</span></div>` + POP.items.map((x, i) => `<div class="pi ${i === POP.i ? "on" : ""}" data-pi="${i}"><b>${esc(x.label)}</b><span>${esc(x.sub || "")}</span></div>`).join("");
  const r = POP.box.getBoundingClientRect(); el.style.left = r.left + "px"; el.style.bottom = innerHeight - r.top + 6 + "px"; el.style.width = Math.min(460, r.width) + "px";
  document.body.appendChild(el);
}
function choosePop(i) {
  const p = POP; if (!p) return; const x = p.items[i]; closePop(); if (!x) return;
  if (x.id === "__manage") { managePrompts(); return; }
  const v = p.box.value, pos = p.box.selectionStart;
  if (p.kind === "#") {
    p.box.value = v.slice(0, p.start) + v.slice(pos); p.box.focus();
    if (x.id === "__upload") { uploadDoc(p.box.id === "tnText"); return; }
    citeRef(x.id, p.box.id === "tnText"); return;
  }
  if (p.kind === "@") {
    const sel = $("#chatAgent") || $("#tnAgent"); if (sel) { sel.value = x.id; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    p.box.value = v.slice(0, p.start) + v.slice(pos); toast(L(`这条交给 ${x.label}`, `This goes to ${x.label}`));
  } else { p.box.value = x.text + v.slice(pos); }
  p.box.focus(); autoGrow(p.box);
}
async function managePrompts() {
  const ps = await prompts();
  const row = (p, i) => `<div class="prow" data-pr="${i}"><input type="text" class="pc" value="${esc(p.command)}" placeholder="${L("命令，如 总结", "command, e.g. summarize")}"><input type="text" class="pt" value="${esc(p.title)}" placeholder="${L("说明", "title")}">
    <textarea class="px" placeholder="${L("提示词内容", "The prompt")}">${esc(p.text)}</textarea><button class="ghost sm" data-act="pdel" data-i="${i}">${L("删除", "Delete")}</button></div>`;
  modal(`<h2>${L("提示词库", "Prompt library")}</h2><div class="muted" style="margin-bottom:12px">${L("在输入框开头打 / 就能选一条，选中后会把它填进输入框。", "Type / at the start of the composer to pick one; it fills the composer.")}</div>
    <div id="plist">${(ps.length ? ps : [{ command: "", title: "", text: "" }]).map(row).join("")}</div>
    <div class="form" style="border:0;background:none;padding:0"><div class="row"><button class="ghost" data-act="padd">${L("＋ 新的一条", "+ New prompt")}</button><span class="grow"></span><button class="ghost" data-closemodal="1">${L("取消", "Cancel")}</button><button class="primary" data-act="psave">${L("保存", "Save")}</button></div></div>`);
}
function readPrompts() { return [...document.querySelectorAll("#plist .prow")].map((r) => ({ command: r.querySelector(".pc").value.trim(), title: r.querySelector(".pt").value.trim(), text: r.querySelector(".px").value })); }

/* ------------------------------------------------ knowledge: upload a document, cite it with # */
function citeRef(id, tree) {
  const list = tree ? S.contRefs : S.chatRefs; if (!list.includes(id)) list.push(id);
  const k = (S.forest?.knowledge || []).find((x) => x.id === id); toast(L(`这次对话引用「${k?.title || ""}」`, `This conversation cites “${k?.title || ""}”`));
  const t = (tree ? $("#tnText") : $("#chatText"))?.value; if (tree) renderCont(); else renderChat();
  const n = tree ? $("#tnText") : $("#chatText"); if (n && t != null) { n.value = t; autoGrow(n); n.focus(); }
}
function uploadDoc(cite = null) {
  const i = document.createElement("input"); i.type = "file"; i.multiple = true;
  i.accept = ".pdf,.docx,.doc,.rtf,.odt,.xlsx,.pptx,.txt,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.html,.htm,.tex,.py,.js,.ts,.java,.c,.cpp,.go,.rs,.sql,.log";
  i.onchange = async () => {
    for (const f of i.files) {
      if (f.size > 30e6) { toast(L(`${f.name} 超过 30 MB`, `${f.name} is over 30 MB`)); continue; }
      toast(L(`正在读 ${f.name}…`, `Reading ${f.name}…`));
      const data = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(r.result); r.readAsDataURL(f); });
      try { const r = await api(`/v1/users/${S.uid}/knowledge/upload`, { body: { name: f.name, data } });
        toast(L(`「${r.title}」进了知识库：${kfmt(r.chars)} 字，${r.passages} 段`, `“${r.title}” is in the knowledge base: ${kfmt(r.chars)} chars, ${r.passages} passages`));
        S.forest = null; await loadForest(); if (cite !== null) citeRef(r.id, cite); }
      catch (err) { toast(err.message); }
    }
  };
  i.click();
}
async function editFact(body) { try { await api(`/v1/bodies/${body.id}/facts`, { method: "PUT", body }); S.forest = null; loadForest(); showDoc(body.id); } catch (err) { toast(err.message); } }
async function sysPrompt(key) {
  const cur = S.chatSys?.[key] ?? (await api(`/v1/users/${S.uid}/chat-system?key=${encodeURIComponent(key)}`).catch(() => ({ text: "" }))).text;
  modal(`<h2>${L("这段对话的设定", "Instructions for this conversation")}</h2><div class="muted" style="margin-bottom:10px">${L("比如「用英文回答」「你是严格的审稿人」「回答控制在三句话以内」。这段对话里每个 agent 都会读到；开新会话时生效。", "E.g. “answer in English”, “you are a strict reviewer”, “three sentences at most”. Every agent in this conversation reads them, from its next session.")}</div>
    <textarea id="sysText" style="width:100%;min-height:140px;background:var(--raised);border:1px solid var(--line-2);border-radius:10px;padding:10px 12px;color:var(--text)">${esc(cur || "")}</textarea>
    <div class="form" style="border:0;background:none;padding:0"><div class="row"><button class="ghost" data-closemodal="1">${L("取消", "Cancel")}</button><button class="primary" data-act="syssave" data-key="${esc(key)}">${L("保存", "Save")}</button></div></div>`);
  $("#sysText").focus();
}

/* ------------------------------------------------ search, rename, export */
function searchBox() {
  modal(`<input type="text" id="sq" class="sq" placeholder="${L("搜索你说过的话、agent 的回答、导入的对话…", "Search what you said, the answers, imported conversations…")}" autocomplete="off"><div id="sres" class="sres"><div class="dimt">${L("至少两个字", "Two characters at least")}</div></div>`);
  document.querySelector(".modal .box").classList.add("search"); $("#sq").focus();
}
let SQT = null;
async function runSearch(q) {
  const box = $("#sres"); if (!box) return;
  if (q.trim().length < 2) { box.innerHTML = `<div class="dimt">${L("至少两个字", "Two characters at least")}</div>`; return; }
  const xs = await api(`/v1/users/${S.uid}/chats-search?q=${encodeURIComponent(q)}`).catch(() => []);
  const hl = (s) => esc(s).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<mark>${m}</mark>`);
  box.innerHTML = xs.length ? xs.map((x, i) => `<div class="sr ${i === 0 ? "on" : ""}" data-sopen="${esc(x.key)}" data-cid="${esc(x.cid || "")}"><div class="st"><b>${hl(x.title || "")}</b><span>${esc(x.kind === "import" ? x.agent : "PGA · " + (x.agent || ""))} · ${esc(ago(x.at))}</span></div><div class="ss">${hl(x.snippet || "")}</div></div>`).join("")
    : `<div class="dimt">${L("没找到", "Nothing found")}</div>`;
}
function openFound(key, cid) {
  document.querySelector(".modal")?.remove();
  if (S.view !== "chats") show("chats");
  S.lineView = null; S.treeItem = null;
  if (cid) { const x = (S.tl?.sessions || []).find((y) => y.item === key); S.chat = null; S.imp = { cid, key, line: x?.line || key }; renderChat(); loadImported(cid); return; }
  S.imp = null; S.chat = key; S.tlSel = key; history.replaceState(null, "", qs()); renderTimeline(); renderChat(); loadChat(key);
}
async function renameChat(key) {
  const cur = (S.allChats || []).find((c) => c.key === key)?.title || "";
  const t = prompt(L("这段对话叫什么？（留空恢复成第一句话）", "Name this conversation (empty: back to its first message)"), cur); if (t === null) return;
  try { await api(`/v1/users/${S.uid}/chats/title`, { method: "PUT", body: { key, title: t } }); toast(L("改好了", "Renamed")); await loadChats(); await loadTimeline(); renderChat(); } catch (err) { toast(err.message); }
}
function exportChat(fmt) {
  const key = S.chat, turns = S.lineView ? [] : S.chatTurns[key] || [];
  let items = turns.map((t) => ({ role: t.role === "user" ? "user" : "assistant", agent: t.agent || "", text: t.text || "", at: t.at || "" }));
  let title = (S.allChats || []).find((c) => c.key === key)?.title || key || "PGA";
  if (S.lineView) { const d = S.lineD?.[S.lineView]; title = S.tl?.lines?.[S.lineView]?.title || title;
    items = lineEntries(d).filter((e) => e.turn || e.conv).map((e) => e.turn ? { role: e.turn.role === "user" ? "user" : "assistant", agent: e.turn.agent || "", text: e.turn.text || "", at: e.at, from: e.x.title }
      : { role: e.conv.who === "user" ? "user" : "assistant", agent: e.agent || "", text: e.conv.text, at: e.at, from: e.x.title }); }
  if (!items.length) { toast(L("这里没有可以导出的对话", "Nothing to export here")); return; }
  const body = fmt === "json" ? JSON.stringify({ title, exported_at: new Date().toISOString(), messages: items }, null, 2)
    : `# ${title}\n\n` + items.map((x) => `### ${x.role === "user" ? L("你", "You") : x.agent || "AI"}${x.at ? ` · ${when(x.at)}` : ""}${x.from ? ` · ${x.from}` : ""}\n\n${x.text}\n`).join("\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([body], { type: fmt === "json" ? "application/json" : "text/markdown" }));
  a.download = `${title.replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 60) || "chat"}.${fmt === "json" ? "json" : "md"}`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ------------------------------------------------ keyboard shortcuts */
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
const KEYS = [[`${MOD} ⇧ O`, L("新对话", "New chat")], [`${MOD} K`, L("搜索所有对话", "Search everything")], ["⇧ Esc", L("回到输入框", "Focus the composer")],
  [`${MOD} ⇧ S`, L("收起 / 展开左栏", "Toggle the sidebar")], [`${MOD} /`, L("这张快捷键表", "These shortcuts")], ["Esc", L("停止正在写的回答；关掉弹窗", "Stop the answer being written; close a dialog")],
  [`${MOD} ⇧ ;`, L("复制最后一个代码块", "Copy the last code block")], ["Enter / ⇧ Enter", L("发送 / 换行", "Send / new line")], ["/", L("（输入框开头）提示词库", "(at the start) prompt library")],
  ["@", L("交给某个 agent", "Hand it to an agent")], ["↑", L("（输入框为空时）上一条你发的话", "(empty composer) your last message")]];
function showKeys() { modal(`<h2>${L("快捷键", "Keyboard shortcuts")}</h2><div class="keys">${KEYS.map(([k, d]) => `<div><kbd>${esc(k)}</kbd><span>${esc(d)}</span></div>`).join("")}</div>`); }

/* ------------------------------------------------ events of this module */
document.addEventListener("click", async (e) => {
  const pi = e.target.closest("[data-pi]"); if (pi) { choosePop(Number(pi.dataset.pi)); return; }
  if (!e.target.closest(".cpop")) closePop();
  const so = e.target.closest("[data-sopen]"); if (so) { openFound(so.dataset.sopen, so.dataset.cid); return; }
  const fd = e.target.closest("[data-fdel]"); if (fd) { const [dim, list, i] = fd.dataset.fdel.split("|"); editFact({ id: fd.dataset.body, dim, remove: { list, i: Number(i) } }); return; }
  const fs = e.target.closest("[data-fsum]"); if (fs) { const t = prompt(L("用你自己的话写这一维：", "This dimension in your own words:"), fs.textContent.startsWith("（") ? "" : fs.textContent); if (t !== null) editFact({ id: fs.dataset.body, dim: fs.dataset.fsum, summary: t }); return; }
  const b = e.target.closest("[data-act]"); if (!b) return;
  const a = b.dataset.act;
  if (a === "copy") copyText(b.dataset.text || "");
  else if (a === "copycode") copyText(b.closest("pre")?.querySelector("code")?.textContent || "");
  else if (a === "preview") preview(b.closest("pre")?.querySelector("code")?.textContent || "");
  else if (a === "regen") regen(b.dataset.run, b.dataset.key);
  else if (a === "ver") { try { await api(`/v1/users/${S.uid}/chats/pick`, { body: { run: b.dataset.run, version: b.dataset.v } }); await loadChat(S.chat || S.lineTarget); } catch (err) { toast(err.message); } }
  else if (a === "rate") { try { await api(`/v1/users/${S.uid}/chats/rate`, { body: { run: b.dataset.run, rating: Number(b.dataset.to) } }); await loadChat(S.chat || S.lineTarget); } catch (err) { toast(err.message); } }
  else if (a === "speak") speak(b.dataset.text || "", b);
  else if (a === "edit") { S.editing = { run: b.dataset.run, key: b.dataset.key, prev: b.dataset.prev }; renderChat(); const t = $("#editText"); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }
  else if (a === "editcancel") { S.editing = null; renderChat(); }
  else if (a === "editsend") editSend();
  else if (a === "attach") { const i = document.createElement("input"); i.type = "file"; i.multiple = true; i.onchange = () => addFiles(i.files); i.click(); }
  else if (a === "unattach") { S.att.splice(Number(b.dataset.i), 1); rerenderComposer(); }
  else if (a === "mic") mic();
  else if (a === "padd") { const ps = readPrompts(); ps.push({ command: "", title: "", text: "" }); S.prompts = ps; managePrompts(); }
  else if (a === "pdel") { const ps = readPrompts(); ps.splice(Number(b.dataset.i), 1); S.prompts = ps; managePrompts(); }
  else if (a === "psave") { try { S.prompts = await api(`/v1/users/${S.uid}/prompts`, { method: "PUT", body: { prompts: readPrompts() } }); document.querySelector(".modal")?.remove(); toast(L("提示词库已保存", "Prompts saved")); } catch (err) { toast(err.message); } }
  else if (a === "rename") renameChat(b.dataset.key);
  else if (a === "export") { const m = b.nextElementSibling; if (m) m.hidden = !m.hidden; }
  else if (a === "exportmd") { b.parentElement.hidden = true; exportChat("md"); }
  else if (a === "exportjson") { b.parentElement.hidden = true; exportChat("json"); }
  else if (a === "search") searchBox();
  else if (a === "upload") uploadDoc(null);
  else if (a === "sysp") sysPrompt(b.dataset.key);
  else if (a === "syssave") { try { const r = await api(`/v1/users/${S.uid}/chat-system`, { method: "PUT", body: { key: b.dataset.key, text: $("#sysText").value } });
      S.chatSys = { ...(S.chatSys || {}), [b.dataset.key]: r.text }; document.querySelector(".modal")?.remove(); toast(r.text ? L("设定已保存", "Instructions saved") : L("设定已清空", "Instructions cleared")); renderChat(); } catch (err) { toast(err.message); } }
  else if (a === "keys") showKeys();
});
document.addEventListener("input", (e) => {
  if (e.target.id === "chatText" || e.target.id === "tnText") suggest(e.target);
  if (e.target.id === "sq") { clearTimeout(SQT); SQT = setTimeout(() => runSearch(e.target.value), 220); }
});
document.addEventListener("paste", (e) => {
  if (!["chatText", "editText"].includes(e.target.id)) return;
  const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); }
});
document.addEventListener("dragover", (e) => { if (S.view === "chats" && [...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); document.body.classList.add("dropping"); } });
document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) document.body.classList.remove("dropping"); });
document.addEventListener("drop", (e) => { if (S.view !== "chats" || !e.dataTransfer?.files?.length) return; e.preventDefault(); document.body.classList.remove("dropping"); addFiles(e.dataTransfer.files); });
/* captured before app-events.js sees the key: the "/" "@" list takes Enter, ↑ brings back your last message, the shortcuts */
document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase(), box = e.target.id === "chatText" || e.target.id === "tnText" ? e.target : null;
  if (POP && box) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopImmediatePropagation(); POP.i = (POP.i + (e.key === "ArrowDown" ? 1 : POP.items.length - 1)) % POP.items.length; drawPop(); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); e.stopImmediatePropagation(); choosePop(POP.i); return; }
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); closePop(); return; }
  }
  if (e.target.id === "sq") {
    const rs = [...document.querySelectorAll(".sres .sr")], i = rs.findIndex((r) => r.classList.contains("on"));
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && rs.length) { e.preventDefault(); rs[i]?.classList.remove("on"); const n = rs[(i + (e.key === "ArrowDown" ? 1 : rs.length - 1)) % rs.length]; n.classList.add("on"); n.scrollIntoView({ block: "nearest" }); return; }
    if (e.key === "Enter" && rs[Math.max(0, i)]) { e.preventDefault(); const r = rs[Math.max(0, i)]; openFound(r.dataset.sopen, r.dataset.cid); return; }
  }
  if (e.target.dataset?.fadd && e.key === "Enter" && e.target.value.trim()) { e.preventDefault(); editFact({ id: e.target.dataset.body, dim: e.target.dataset.fadd, add: e.target.value.trim() }); return; }
  if (e.target.id === "editText" && e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopImmediatePropagation(); editSend(); return; }
  if (box && e.key === "ArrowUp" && !box.value && S.sentHist.length) { e.preventDefault(); e.stopImmediatePropagation(); box.value = S.sentHist[S.sentHist.length - 1]; autoGrow(box); return; }
  if (mod && e.shiftKey && k === "o") { e.preventDefault(); show("chats"); $("#newChat")?.click(); setTimeout(() => $("#chatText")?.focus(), 60); return; }
  if (mod && !e.shiftKey && k === "k") { e.preventDefault(); searchBox(); return; }
  if (mod && e.shiftKey && k === "s") { e.preventDefault(); setMini(!S.mini); return; }
  if (mod && (k === "/" || e.code === "Slash")) { e.preventDefault(); showKeys(); return; }
  if (mod && e.shiftKey && (k === ";" || e.code === "Semicolon")) { e.preventDefault(); const cs = document.querySelectorAll("#cdlgIn pre code, #dlgIn pre code"); if (cs.length) copyText(cs[cs.length - 1].textContent); return; }
  if (e.shiftKey && e.key === "Escape") { e.preventDefault(); ($("#chatText") || $("#tnText"))?.focus(); return; }
  if (e.key === "Escape" && !document.querySelector(".modal") && S.live?.run && !S.live.run.finished) { api(`/v1/agents/live/${S.live.run.id}/stop`, { method: "POST" }).then(() => toast(L("已让它停下", "Stopping"))).catch(() => {}); }
}, true);
