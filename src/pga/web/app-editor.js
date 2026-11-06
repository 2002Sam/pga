/* PGA's file viewer: a side panel that feels like VS Code for text and Chrome for everything else.
   - Tabs as in Chrome: an icon, the name, × (● while edited), middle-click closes, drag to reorder, ⌘W / ⌃W closes,
     ⌘⇧T reopens the last one closed, ⌃Tab / ⌃⇧Tab move between them.
   - Code and text open in Monaco (VS Code's own editor): line numbers, highlighting, ⌘F find, folding, minimap; edit and
     ⌘S saves (refused if the file changed on disk meanwhile — then you choose). A link like `app.py:42` lands on line 42.
     A file changed elsewhere reloads by itself while you have not edited it.
   - Markdown, CSV and SVG: the rendered view, or their source in the editor. Pictures zoom (pinch / ⌘-wheel / buttons /
     click for 1:1) and pan. PDFs in the browser's own viewer. Word, sheets and slides as before (pga.docview).
   - A status bar like VS Code's; a path bar with copy, Show in Finder and Open in its app; the panel's width is draggable.
   pga.api: files/view, files/stat, files/save, files/open (reveal). Monaco is served locally; if it fails,
   a basic editable textarea still supports saving. The workspace docks beside the conversation, never over it. */
const FILE_PANEL = { entries: new Map(), active: null, host: null, closed: [] };
const MONACO_BASE = new URL("/ui/vendor/monaco/0.52.2/min/", location.origin).href;
const FP_LANG = { py: "python", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  json: "json", jsonl: "json", ipynb: "json", md: "markdown", html: "html", htm: "html", svelte: "html", vue: "html", css: "css", scss: "scss", less: "less",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini", xml: "xml", svg: "xml", sql: "sql", swift: "swift", go: "go",
  rs: "rust", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", java: "java", kt: "kotlin", rb: "ruby", php: "php", lua: "lua", r: "r",
  scala: "scala", dart: "dart", cs: "csharp", m: "objective-c", sh: "shell", zsh: "shell", bash: "shell", graphql: "graphql", proto: "protobuf" };
const FP_ICON = { py: ["Py", "#3572A5"], js: ["JS", "#e8c547"], mjs: ["JS", "#e8c547"], cjs: ["JS", "#e8c547"], jsx: ["JSX", "#61dafb"],
  ts: ["TS", "#3178c6"], tsx: ["TSX", "#3178c6"], json: ["{}", "#cbcb41"], jsonl: ["{}", "#cbcb41"], ipynb: ["NB", "#f37626"], md: ["M↓", "#519aba"],
  html: ["<>", "#e34c26"], css: ["#", "#563d7c"], scss: ["#", "#c6538c"], yaml: ["Y", "#cb171e"], yml: ["Y", "#cb171e"], toml: ["T", "#9c4221"],
  sql: ["DB", "#e38c00"], sh: ["$", "#89e051"], zsh: ["$", "#89e051"], go: ["Go", "#00add8"], rs: ["Rs", "#dea584"], swift: ["Sw", "#f05138"],
  java: ["J", "#b07219"], c: ["C", "#555"], cpp: ["C+", "#f34b7d"], txt: ["≡", "#8a8a93"], log: ["≡", "#8a8a93"], tex: ["TeX", "#3d6117"],
  csv: ["▦", "#2f9e5f"], tsv: ["▦", "#2f9e5f"], xlsx: ["▦", "#1d6f42"], xls: ["▦", "#1d6f42"], ods: ["▦", "#1d6f42"], docx: ["W", "#2b579a"],
  doc: ["W", "#2b579a"], rtf: ["W", "#2b579a"], odt: ["W", "#2b579a"], pptx: ["P", "#d24726"], ppt: ["P", "#d24726"], odp: ["P", "#d24726"],
  pdf: ["PDF", "#e5252a"], png: ["▣", "#a074c4"], jpg: ["▣", "#a074c4"], jpeg: ["▣", "#a074c4"], gif: ["▣", "#a074c4"], webp: ["▣", "#a074c4"],
  svg: ["◇", "#ffb13b"], zip: ["⧉", "#8a8a93"] };
const fpExt = (p) => (String(p).match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
const fpSize = (n) => n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
const fpHome = (p) => String(p || "").replace(/^\/Users\/[^/]+/, "~");
const fpIcon = (ext, web) => { if (web) return `<span class="fp-ico" style="--c:#4c8bf5">◍</span>`; const [t, c] = FP_ICON[ext] || ["·", "#8a8a93"]; return `<span class="fp-ico" style="--c:${c}">${esc(t)}</span>`; };

/* ------------------------------------------------ Monaco, loaded the first time a text file opens */
let FP_MONACO = null;
function fpMonaco() {
  if (window.monaco?.editor) return Promise.resolve(window.monaco);
  if (FP_MONACO) return FP_MONACO;
  FP_MONACO = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("timeout")), 5000);
    window.MonacoEnvironment = { getWorkerUrl: () => "data:text/javascript;charset=utf-8," + encodeURIComponent(
      `self.MonacoEnvironment={baseUrl:'${MONACO_BASE}'};importScripts('${MONACO_BASE}vs/base/worker/workerMain.js');`) };
    const s = document.createElement("script"); s.src = MONACO_BASE + "vs/loader.js";
    s.onerror = () => { clearTimeout(timer); reject(Error("load")); };
    s.onload = () => {
      window.require.config({ paths: { vs: MONACO_BASE + "vs" } });
      window.require(["vs/editor/editor.main"], () => {
        clearTimeout(timer);
        if (window.define) window.define.amd = undefined;   // libraries loaded later (mermaid, d3) stay plain globals, not AMD modules
        resolve(window.monaco);
      }, (e) => { clearTimeout(timer); reject(e); });
    };
    document.head.append(s);
  }).catch((e) => { FP_MONACO = null; throw e; });
  return FP_MONACO;
}
const fpTheme = () => (document.documentElement.dataset.theme === "light" ? "vs" : "vs-dark");
window.addEventListener("pga:theme", () => { if (window.monaco?.editor) window.monaco.editor.setTheme(fpTheme()); });

/* ------------------------------------------------ the panel */
function filePanel() {
  if (FILE_PANEL.host) return FILE_PANEL.host;
  const panel = document.createElement("section");
  panel.id = "pgaFilePanel"; panel.hidden = true; panel.tabIndex = -1; panel.setAttribute("aria-label", L("文件工作区", "File workspace"));
  panel.innerHTML = `<div class="fp-resize" title="${L("拖动改变宽度", "Drag to resize")}"></div>
    <div class="fp-tabbar"><nav class="filetabs" role="tablist" aria-label="${L("打开的文件", "Open files")}"></nav>
      <div class="fp-tabacts"><button class="fp-ib" data-file-expand title="${L("展开 / 还原", "Expand / restore")}">⛶</button><button class="fp-ib" data-file-hide title="${L("收起查看器", "Hide the viewer")}">✕</button></div></div>
    <div class="fp-crumbs"><span class="fp-path"></span><span class="grow"></span>
      <button class="fp-tb fp-save" data-file-save disabled title="${L("保存（⌘S / Ctrl+S）", "Save (⌘S / Ctrl+S)")}">${L("保存", "Save")}</button>
      <button class="fp-ib" data-file-reload title="${L("重新载入文件", "Reload file")}" aria-label="${L("重新载入文件", "Reload file")}">↻</button>
      <button class="fp-ib" data-file-copy title="${L("复制路径", "Copy path")}" aria-label="${L("复制路径", "Copy path")}">⧉</button>
      <button class="fp-ib" data-file-reveal title="${L("在 Finder 中显示", "Show in Finder")}" aria-label="${L("在 Finder 中显示", "Show in Finder")}">⌕</button>
      <button class="fp-tb" data-file-system>${L("用系统应用打开", "Open externally")}</button></div>
    <div class="fp-banner" hidden></div>
    <div class="fileframes"></div>
    <footer class="fp-status"><span class="fp-sl"></span><span class="grow"></span><span class="fp-sr"></span></footer>`;
  const w = Number(localStorage.getItem("pga_filepanel_w")); if (w >= 360) FILE_PANEL.width = w;
  panel.querySelector("[data-file-hide]").onclick = () => fpDock(false);
  panel.querySelector("[data-file-expand]").onclick = () => { panel.classList.toggle("expanded"); fpSyncDock(); };
  panel.querySelector("[data-file-save]").onclick = () => { const en = fpActive(); if (en) fpSave(en); };
  panel.querySelector("[data-file-reload]").onclick = () => { const en = fpActive(); if (!en) return;
    if (en.dirty && !confirm(L("放弃未保存的修改并重新载入？", "Discard unsaved changes and reload?"))) return;
    if (en.info?.text != null) fpReload(en, true);
    else en.body.querySelectorAll("iframe").forEach((f) => { f.src = f.src; });
  };
  panel.querySelector("[data-file-copy]").onclick = (e) => { const en = fpActive(); if (en) (typeof copyText === "function" ? copyText(en.web || en.path, e.currentTarget) : navigator.clipboard?.writeText(en.web || en.path)); toast(L("路径已复制", "Path copied")); };
  panel.querySelector("[data-file-reveal]").onclick = () => fpSystem(true);
  panel.querySelector("[data-file-system]").onclick = () => fpSystem(false);
  // width: drag the left edge
  const grip = panel.querySelector(".fp-resize");
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault(); grip.setPointerCapture(e.pointerId); panel.classList.add("resizing");
    panel.classList.remove("expanded");
    const right = panel.getBoundingClientRect().right;
    const move = (ev) => { FILE_PANEL.width = Math.max(360, Math.min(innerWidth - 360, right - ev.clientX)); fpSyncDock(); };
    const up = () => { grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); grip.removeEventListener("pointercancel", up);
      panel.classList.remove("resizing"); localStorage.setItem("pga_filepanel_w", String(Math.round(FILE_PANEL.width || panel.clientWidth))); fpLayout(); };
    grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up, { once: true }); grip.addEventListener("pointercancel", up, { once: true });
  });
  // tabs: click, middle-click, ×, drag to reorder
  const tabs = panel.querySelector(".filetabs");
  tabs.addEventListener("click", (e) => { const t = e.target.closest(".fp-tab"); if (!t) return; if (e.target.closest(".fp-x")) { fpClose(t.dataset.id); return; } selectFile(t.dataset.id); });
  tabs.addEventListener("keydown", (e) => { if (e.metaKey || e.ctrlKey || e.altKey || !e.target.matches(".fp-tab")) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); fpCycle(e.key === "ArrowRight" ? 1 : -1); }
    else if (e.key === "Home" || e.key === "End") { e.preventDefault(); const all = [...tabs.querySelectorAll(".fp-tab")]; selectFile((e.key === "Home" ? all[0] : all.at(-1))?.dataset.id); }
  });
  tabs.addEventListener("auxclick", (e) => { const t = e.target.closest(".fp-tab"); if (t && e.button === 1) { e.preventDefault(); fpClose(t.dataset.id); } });
  tabs.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });
  tabs.addEventListener("dragstart", (e) => { const t = e.target.closest(".fp-tab"); if (!t) return; FILE_PANEL.dragging = t; t.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
  tabs.addEventListener("dragover", (e) => { const d = FILE_PANEL.dragging, t = e.target.closest(".fp-tab"); if (!d || !t || t === d) return; e.preventDefault();
    const r = t.getBoundingClientRect(); tabs.insertBefore(d, e.clientX < r.left + r.width / 2 ? t : t.nextSibling); });
  tabs.addEventListener("dragend", () => { FILE_PANEL.dragging?.classList.remove("dragging"); FILE_PANEL.dragging = null; });
  tabs.addEventListener("wheel", (e) => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { tabs.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
  document.body.append(panel); FILE_PANEL.host = panel;
  return panel;
}
const fpActive = () => FILE_PANEL.entries.get(FILE_PANEL.active);
function fpLayout() { for (const en of FILE_PANEL.entries.values()) en.editor?.layout(); }
function fpSyncDock() {
  const panel = FILE_PANEL.host, shown = !!panel && !panel.hidden;
  const full = panel?.classList.contains("expanded") || innerWidth < 760;
  const width = full ? innerWidth : Math.max(360, Math.min(innerWidth - 360, FILE_PANEL.width || Math.round(innerWidth * .52)));
  document.documentElement.classList.toggle("file-docked", shown);
  document.documentElement.classList.toggle("file-dock-full", shown && full);
  document.documentElement.classList.toggle("file-dock-compact", shown && innerWidth - width < 1100);
  document.documentElement.style.setProperty("--file-dock-width", (shown ? width : 0) + "px");
  if (panel) { panel.style.width = width + "px"; panel.querySelector("[data-file-expand]").setAttribute("aria-pressed", String(full)); }
  requestAnimationFrame(() => { fpLayout(); if (typeof stMap === "function") stMap(); });
}
function fpDock(shown) {
  const panel = filePanel(); panel.hidden = !shown; fpSyncDock();
  if (shown) panel.focus({ preventScroll: true });
}
window.addEventListener("resize", () => { if (FILE_PANEL.host && !FILE_PANEL.host.hidden) fpSyncDock(); });
window.addEventListener("beforeunload", (e) => {
  if ([...FILE_PANEL.entries.values()].some((en) => en.dirty || en.saving)) { e.preventDefault(); e.returnValue = ""; }
});
async function fpSystem(reveal) {
  const en = fpActive(); if (!en) return;
  if (en.web) { window.open(en.web, "_blank", "noopener"); return; }   // a link: in the browser
  try { await api(`/v1/users/${en.uid}/files/open`, { body: { path: en.path, key: en.key, reveal } }); }
  catch (err) { toast(err.message); }
}
function fpTab(id, html, title) {
  const panel = filePanel(), tab = document.createElement("div");
  tab.className = "fp-tab"; tab.dataset.id = id; tab.setAttribute("role", "tab"); tab.tabIndex = -1; tab.draggable = true; tab.title = title || "";
  tab.innerHTML = `${html}<button class="fp-x" tabindex="-1" title="${L("关闭（⌘W）", "Close (⌘W)")}">×</button>`;
  panel.querySelector(".filetabs").append(tab); return tab;
}
function selectFile(id) {
  const panel = filePanel(), entry = FILE_PANEL.entries.get(id); if (!entry) return;
  FILE_PANEL.active = id; fpDock(true);
  for (const [key, item] of FILE_PANEL.entries) { item.tab.classList.toggle("on", key === id); item.tab.setAttribute("aria-selected", String(key === id)); item.tab.tabIndex = key === id ? 0 : -1; item.body.hidden = key !== id; }
  entry.tab.focus({ preventScroll: true });
  entry.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
  const parts = fpHome(entry.web || entry.path).split("/").filter(Boolean);
  panel.querySelector(".fp-path").innerHTML = entry.web ? `<span>${esc(entry.web)}</span>` :
    parts.map((p, i) => `<span class="${i === parts.length - 1 ? "last" : ""}">${esc(p)}</span>`).join(`<i>›</i>`);
  panel.querySelector(".fp-path").title = entry.web || entry.path;
  panel.querySelector("[data-file-system]").textContent = entry.web ? L("在浏览器打开", "Open in browser") : L("在系统应用中编辑", "Edit externally");
  panel.querySelector("[data-file-reveal]").hidden = !!entry.web;
  panel.querySelector("[data-file-system]").hidden = !entry.web && entry.info?.kind === "text" && !entry.info?.markdown && FP_LANG[entry.ext];
  fpBanner(entry); fpStatus(entry);
  if (entry.editor) requestAnimationFrame(() => entry.editor.layout());
  if (entry.info?.kind === "text" || entry.info?.text != null) fpCheck(entry);
}
async function fpClose(id) {
  const entry = FILE_PANEL.entries.get(id); if (!entry) return;
  if (entry.dirty && !confirm(L(`「${entry.name}」有没保存的修改，仍要关闭吗？`, `“${entry.name}” has unsaved changes. Close anyway?`))) return;
  const order = [...filePanel().querySelectorAll(".fp-tab")].map((t) => t.dataset.id), i = order.indexOf(id);
  FILE_PANEL.closed.push(entry.web ? { web: entry.web, uid: entry.uid } : { path: entry.path, key: entry.key, uid: entry.uid });
  FILE_PANEL.closed = FILE_PANEL.closed.slice(-20);
  entry.resizeObserver?.disconnect(); entry.editor?.dispose(); entry.model?.dispose(); entry.tab.remove(); entry.body.remove(); FILE_PANEL.entries.delete(id);
  if (FILE_PANEL.active === id) {
    const next = order[i + 1] || order[i - 1];
    if (next && FILE_PANEL.entries.has(next)) selectFile(next); else { FILE_PANEL.active = null; fpDock(false); }
  }
}
function fpCycle(dir) {
  const order = [...filePanel().querySelectorAll(".fp-tab")].map((t) => t.dataset.id); if (order.length < 2) return;
  selectFile(order[(order.indexOf(FILE_PANEL.active) + dir + order.length) % order.length]);
}
function fpReopen() {
  const last = FILE_PANEL.closed.pop(); if (!last) return;
  if (last.web) openPgaUrl(last.web, last.uid); else openPgaFile(last.path, last.key, last.uid);
}
document.addEventListener("keydown", (e) => {
  const panel = FILE_PANEL.host; if (!panel || panel.hidden) return;
  const inside = panel.contains(document.activeElement); if (!inside) return;
  const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
  if (mod && !e.shiftKey && k === "w") { e.preventDefault(); e.stopPropagation(); if (FILE_PANEL.active) fpClose(FILE_PANEL.active); }
  else if (mod && e.shiftKey && k === "t") { e.preventDefault(); e.stopPropagation(); fpReopen(); }
  else if (e.ctrlKey && k === "tab") { e.preventDefault(); e.stopPropagation(); fpCycle(e.shiftKey ? -1 : 1); }
  else if (mod && e.altKey && (k === "arrowright" || k === "arrowleft")) { e.preventDefault(); fpCycle(k === "arrowright" ? 1 : -1); }
  else if (mod && !e.shiftKey && k === "s") { e.preventDefault(); e.stopPropagation(); const en = fpActive(); if (en?.model) fpSave(en); }
}, true);

/* ------------------------------------------------ status bar and banner */
function fpStatus(en) {
  const panel = filePanel(); if (FILE_PANEL.active !== en.id) return;
  const sl = panel.querySelector(".fp-sl"), sr = panel.querySelector(".fp-sr"), i = en.info || {};
  const save = panel.querySelector("[data-file-save]");
  save.hidden = !i.editable; save.disabled = !en.model || !en.dirty || !!en.saving;
  save.textContent = en.saving ? L("保存中…", "Saving…") : L("保存", "Save");
  panel.querySelector("[data-file-reload]").hidden = !!en.web;
  if (en.editor && en.model) {
    const pos = en.editor.getPosition() || { lineNumber: 1, column: 1 }, sel = en.editor.getSelection();
    const picked = sel && !sel.isEmpty() ? en.model.getValueInRange(sel).length : 0;
    sl.innerHTML = en.saving ? L("正在保存…", "Saving…") : en.dirty ? `<b class="fp-dirty">● ${L("未保存", "Unsaved")}</b> · ⌘S ${L("保存", "to save")}` : (i.editable ? L("已保存", "Saved") : L("只读", "Read only"));
    sr.textContent = [L(`行 ${pos.lineNumber}，列 ${pos.column}`, `Ln ${pos.lineNumber}, Col ${pos.column}`), picked ? L(`已选 ${picked}`, `${picked} selected`) : "",
      `${en.model.getLineCount()} ${L("行", "lines")}`, "UTF-8", i.eol || "LF", (en.lang || "plaintext").replace(/^\w/, (c) => c.toUpperCase()), fpSize(i.size)].filter(Boolean).join("  ·  ");
  } else if (en.basic) {
    sl.textContent = en.saving ? L('正在保存…','Saving…') : en.dirty ? L('● 未保存 · ⌘S 保存','● Unsaved · ⌘S saves') : i.editable ? L('已保存','Saved') : L('只读','Read only');
    sr.textContent = L('基础编辑器','Basic editor') + ' · UTF-8 · ' + fpSize(i.size);
  } else if (en.img) {
    sl.textContent = en.img.w ? `${en.img.w} × ${en.img.h} px` : "";
    sr.textContent = [en.img.w ? `${Math.round(en.img.scale * 100)}%` : "", fpSize(i.size)].filter(Boolean).join("  ·  ");
  } else {
    sl.textContent = en.web ? (en.webInfo?.site || "") : { document: "PDF / Word", sheet: L("表格", "Sheet"), slides: L("幻灯片", "Slides"), external: "" }[i.kind] || "";
    sr.textContent = [i.editable ? L("可编辑 · 点击「编辑」", "Editable · choose Edit") : i.kind && i.text == null ? L("预览 · 可在系统应用中编辑", "Preview · edit in system app") : "", fpSize(i.size)].filter(Boolean).join(" · ");
  }
}
function fpBanner(en) {
  const b = filePanel().querySelector(".fp-banner"); if (FILE_PANEL.active !== en.id) return;
  if (!en.conflict) { b.hidden = true; return; }
  b.hidden = false;
  b.innerHTML = en.conflict === "save" ? `${L("这个文件在你打开之后被别处修改过了。", "The file changed on disk after you opened it.")}<span class="grow"></span><button data-fpfix="overwrite">${L("用我的覆盖", "Overwrite with mine")}</button><button data-fpfix="reload">${L("放弃我的，重新载入", "Discard mine and reload")}</button>`
    : `${L("文件在别处被修改了，而你这里也有没保存的修改。", "The file changed on disk, and you have unsaved edits here.")}<span class="grow"></span><button data-fpfix="keep">${L("保留我的", "Keep mine")}</button><button data-fpfix="reload">${L("载入新的", "Load theirs")}</button>`;
  b.onclick = async (e) => { const a = e.target.closest("[data-fpfix]")?.dataset.fpfix; if (!a) return;
    if (a === "overwrite") await fpSave(en, true); else if (a === "reload") await fpReload(en, true); else { en.conflict = null; fpBanner(en); } };
}

/* ------------------------------------------------ text in the editor: edit, save, follow changes on disk */
async function fpEditor(en, host, text, opts = {}) {
  host.innerHTML = `<div class="fp-empty">${L('正在加载编辑器…', 'Loading editor…')}</div>`;
  let monaco;
  try { monaco = await fpMonaco(); }
  catch {
    if (!FILE_PANEL.entries.has(en.id)) return;
    en.fallback = true;
    const wrap = document.createElement('div'); wrap.className = 'fp-basic';
    const notice = document.createElement('div'); notice.className = 'fp-basic-note';
    notice.textContent = L('高级编辑器暂不可用，已切换基础编辑器。仍可编辑并用 ⌘S 保存。', 'Advanced editor unavailable. Basic editing and save remain available.');
    const ta = document.createElement('textarea'); ta.value = text; ta.readOnly = !en.info.editable;
    ta.spellcheck = false; ta.wrap = opts.wrap ? 'soft' : 'off'; ta.setAttribute('aria-label', en.name);
    if (ta.readOnly) notice.textContent = L('高级编辑器暂不可用，此文件为只读。', 'Advanced editor unavailable. This file is read only.');
    wrap.append(notice, ta); host.replaceChildren(wrap); en.basic = ta;
    let version = 1;
    en.model = {getValue:()=>ta.value, getAlternativeVersionId:()=>version, getLineCount:()=>ta.value.split('\n').length, dispose(){}};
    en.saved = version;
    en.basicReplace = value => { ta.value=value; version++; };
    ta.addEventListener('input',()=>{ version++; en.dirty=true; en.tab.classList.add('dirty'); fpStatus(en); en.onEdit?.(); });
    if (en.info.line) fpGo(en,en.info.line,en.info.column);
    fpStatus(en); return;
  }
  if (!FILE_PANEL.entries.has(en.id)) return;
  const box = document.createElement("div"); box.className = "fp-monaco"; host.replaceChildren(box);
  en.model = monaco.editor.createModel(text, en.lang || "plaintext");
  en.saved = en.model.getAlternativeVersionId();
  en.editor = monaco.editor.create(box, {
    model: en.model, theme: fpTheme(), automaticLayout: true, readOnly: !en.info.editable,
    fontFamily: "'SF Mono', Menlo, Monaco, 'Cascadia Code', Consolas, monospace", fontSize: 13, lineHeight: 20,
    minimap: { enabled: true, renderCharacters: false, maxColumn: 80 }, scrollBeyondLastLine: false, smoothScrolling: true,
    wordWrap: opts.wrap ? "on" : "off", renderWhitespace: "selection", bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true }, stickyScroll: { enabled: true }, cursorSmoothCaretAnimation: "on",
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false }, fixedOverflowWidgets: true, padding: { top: 8 } });
  en.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => fpSave(en));
  en.editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.KeyZ, () => en.editor.updateOptions({ wordWrap: en.editor.getOption(monaco.editor.EditorOption.wordWrap) === "on" ? "off" : "on" }));
  en.model.onDidChangeContent(() => { const d = en.model.getAlternativeVersionId() !== en.saved; if (d !== en.dirty) { en.dirty = d; en.tab.classList.toggle("dirty", d); } fpStatus(en); en.onEdit?.(); });
  en.editor.onDidChangeCursorPosition(() => fpStatus(en)); en.editor.onDidChangeCursorSelection(() => fpStatus(en));
  if (en.info.line) fpGo(en, en.info.line, en.info.column);
  fpStatus(en);
}
function fpGo(en, line, column) {
  if (en.basic) {
    const lines=en.basic.value.split('\n'), row=Math.max(1,Math.min(line,lines.length));
    const at=lines.slice(0,row-1).reduce((n,s)=>n+s.length+1,0)+Math.min((column||1)-1,lines[row-1].length);
    en.basic.focus(); en.basic.setSelectionRange(at,at); en.basic.scrollTop=(row-1)*20; return;
  }
  if (!en.editor) return;
  const ln = Math.max(1, Math.min(line, en.model.getLineCount())), col = column || 1;
  en.editor.revealLineInCenter(ln); en.editor.setPosition({ lineNumber: ln, column: col }); en.editor.focus();
  en.flash = en.editor.deltaDecorations(en.flash || [], [{ range: new monaco.Range(ln, 1, ln, 1), options: { isWholeLine: true, className: "fp-hit" } }]);
  setTimeout(() => { if (en.editor) en.flash = en.editor.deltaDecorations(en.flash || [], []); }, 2200);
}
async function fpSave(en, force = false) {
  if (!en.model || !en.info.editable || en.saving) return;
  en.saving = true; fpStatus(en);
  const text = en.model.getValue(), version = en.model.getAlternativeVersionId();
  try {
    const r = await api(`/v1/users/${en.uid}/files/save`, { body: { path: en.path, key: en.key, text, mtime: en.info.mtime, force } });
    en.info.mtime = r.mtime; en.info.size = r.size; en.info.text = text; en.saved = version; en.dirty = en.model.getAlternativeVersionId() !== version;
    en.tab.classList.toggle("dirty", en.dirty); en.conflict = null; fpBanner(en);
    en.body.querySelectorAll(".fp-img img").forEach((im) => { im.src = en.info.url + "?t=" + Date.now(); });   // an SVG: the picture follows its source
    en.onSave?.();
    toast(L(`已保存「${en.name}」`, `Saved ${en.name}`));
  } catch (err) {
    if (/409|别处/.test(err.message)) { en.conflict = "save"; fpBanner(en); } else toast(err.message);
  } finally { en.saving = false; fpStatus(en); }
}
async function fpReload(en, discard) {
  const version = en.model?.getAlternativeVersionId(), mtime = en.info.mtime;
  let info; try { info = await api(`/v1/users/${en.uid}/files/view`, { body: { path: en.path, key: en.key } }); } catch (err) { toast(err.message); return; }
  if (!FILE_PANEL.entries.has(en.id) || info.text == null || en.saving || en.info.mtime !== mtime) return;
  // Never discard typing that arrived while this read was in flight, even after an explicit reload.
  if (en.model?.getAlternativeVersionId() !== version || (en.dirty && !discard)) { en.conflict = "disk"; fpBanner(en); return; }
  en.info = { ...en.info, ...info, line: undefined };
  if (en.basic) {
    en.basicReplace(info.text); en.saved=en.model.getAlternativeVersionId(); en.dirty=false; en.tab.classList.remove('dirty');
  } else if (en.model) {
    const view = en.editor.saveViewState();
    en.model.pushEditOperations([], [{ range: en.model.getFullModelRange(), text: info.text }], () => null);
    en.saved = en.model.getAlternativeVersionId(); en.dirty = false; en.tab.classList.remove("dirty");
    if (view) en.editor.restoreViewState(view);
  }
  en.onReload?.(info);
  en.conflict = null; fpBanner(en); fpStatus(en);
}
async function fpCheck(en) {                          // changed on disk? (the active text tab, every few seconds while shown)
  if (en.checking || en.web || !en.info?.mtime) return;
  en.checking = true;
  try {
    const st = await api(`/v1/users/${en.uid}/files/stat`, { body: { path: en.path, key: en.key } });
    if (String(st.mtime) !== String(en.info.mtime) && !en.saving) {
      if (en.dirty) { if (en.conflict !== "disk" && en.conflict !== "save") { en.conflict = "disk"; fpBanner(en); } }
      else await fpReload(en);
    }
  } catch {} finally { en.checking = false; }
}
setInterval(() => { const en = fpActive(); if (en && !FILE_PANEL.host?.hidden && document.visibilityState === "visible" && (en.info?.kind === "text" || en.info?.text != null)) fpCheck(en); }, 3000);

/* ------------------------------------------------ pictures: fit, 1:1, zoom about the pointer, pan */
function fpImage(en, url) {
  const wrap = document.createElement("div"); wrap.className = "fp-img";
  wrap.innerHTML = `<div class="fp-imgtools"><button data-z="-">−</button><button data-z="fit">${L("适应", "Fit")}</button><button data-z="1">1:1</button><button data-z="+">＋</button></div><img alt="${esc(en.name)}" draggable="false">`;
  const img = wrap.querySelector("img"), s = en.img = { scale: 1, x: 0, y: 0, w: 0, h: 0, fit: true };
  const apply = () => { img.style.transform = `translate(${s.x}px, ${s.y}px) scale(${s.scale})`; wrap.classList.toggle("big", s.scale > fitScale()); fpStatus(en); };
  const fitScale = () => { const r = wrap.getBoundingClientRect(); return s.w ? Math.min(1, (r.width - 32) / s.w, (r.height - 32) / s.h) : 1; };
  const center = (scale) => { const r = wrap.getBoundingClientRect(); s.scale = scale; s.x = (r.width - s.w * scale) / 2; s.y = (r.height - s.h * scale) / 2; apply(); };
  const zoomAt = (k, cx, cy) => { const r = wrap.getBoundingClientRect(), px = cx - r.left, py = cy - r.top, n = Math.max(0.05, Math.min(16, s.scale * k));
    s.x = px - (px - s.x) * (n / s.scale); s.y = py - (py - s.y) * (n / s.scale); s.scale = n; s.fit = false; apply(); };
  img.onload = () => { s.w = img.naturalWidth || 800; s.h = img.naturalHeight || 600; center(fitScale()); };
  img.onerror = () => { wrap.innerHTML = `<p class="filehint">${L("这张图片打不开", "Could not show this picture")}</p>`; };
  img.src = url;
  en.resizeObserver = new ResizeObserver(() => { if (s.fit && s.w && !wrap.hidden && wrap.clientWidth) center(fitScale()); });
  en.resizeObserver.observe(wrap);
  wrap.addEventListener("wheel", (e) => { e.preventDefault();
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);   // pinch, or ⌘ + wheel
    else { s.x -= e.deltaX; s.y -= e.deltaY; s.fit = false; apply(); } }, { passive: false });
  let drag = null;
  wrap.addEventListener("pointerdown", (e) => { if (e.target.closest(".fp-imgtools") || e.button !== 0) return; drag = { x: e.clientX, y: e.clientY, x0: s.x, y0: s.y, moved: false }; wrap.setPointerCapture(e.pointerId); });
  wrap.addEventListener("pointermove", (e) => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.hypot(dx, dy) > 3) drag.moved = true; if (drag.moved) { s.x = drag.x0 + dx; s.y = drag.y0 + dy; s.fit = false; apply(); } });
  wrap.addEventListener("pointerup", (e) => { const d = drag; drag = null; if (d && !d.moved && e.target === img) { if (Math.abs(s.scale - 1) < 0.01 && fitScale() < 1) { s.fit = true; center(fitScale()); } else zoomAt(1 / s.scale, e.clientX, e.clientY); } });
  wrap.querySelector(".fp-imgtools").addEventListener("click", (e) => { const z = e.target.closest("[data-z]")?.dataset.z; if (!z) return; const r = wrap.getBoundingClientRect();
    if (z === "fit") { s.fit = true; center(fitScale()); } else if (z === "1") { s.fit = false; center(1); } else zoomAt(z === "+" ? 1.25 : 0.8, r.left + r.width / 2, r.top + r.height / 2); });
  return wrap;
}

/* ------------------------------------------------ one view of an entry, with switches when there is more than one way to see it */
function fileModes(body, modes, hint, en) {
  const bar = document.createElement("div"); bar.className = "filemodes";
  const stage = document.createElement("div"); stage.className = "filestage";
  const made = new Map();
  const show = (m) => {
    bar.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.m === m.id));
    for (const [id, n] of made) n.hidden = id !== m.id;
    if (!made.has(m.id)) { const n = document.createElement("div"); n.className = "filemode"; stage.append(n); made.set(m.id, n); const c = m.make(n); if (c instanceof Node) n.append(c); }
    else m.shown?.(made.get(m.id));
    note.textContent = m.note || ""; if (en) { en.mode = m.id; requestAnimationFrame(() => en.editor?.layout()); fpStatus(en); }
  };
  const note = document.createElement("span"); note.className = "filemodenote";
  for (const m of modes) { const b = document.createElement("button"); b.dataset.m = m.id; b.textContent = m.label; b.disabled = !!m.off; if (m.off) b.title = m.off; b.onclick = () => show(m); bar.append(b); }
  bar.append(note);
  if (modes.length > 1 || hint) body.append(bar);
  if (hint) note.dataset.hint = hint;
  body.append(stage); show(modes.find((m) => !m.off) || modes[0]);
}
function fileFrame(url, title, loading) {
  const wrap = document.createElement("div"); wrap.className = "fileframe";
  const f = document.createElement("iframe"); f.title = title || ""; f.src = url;
  if (loading) { const l = document.createElement("div"); l.className = "fileloading"; l.innerHTML = `<span class="spin"></span> ${esc(loading)}`; wrap.append(l); f.addEventListener("load", () => l.remove()); }
  wrap.append(f); return wrap;
}

/* ------------------------------------------------ opening a file */
async function openPgaFile(path, key, uid = S.uid) {
  // Conversation cards are frames: open in the surrounding PGA window rather than inside a tiny card.
  try { if (window.top !== window && typeof window.top.openPgaFile === "function") return window.top.openPgaFile(path, key, uid); } catch {}
  const panel = filePanel(), wasHidden = panel.hidden; fpDock(true);
  let info;
  try { info = await api(`/v1/users/${uid}/files/view`, { body: { path, key } }); }
  catch (err) { toast(err.message); if (!FILE_PANEL.entries.size || wasHidden) fpDock(!wasHidden); return; }
  const id = `${uid}:${info.path}`;
  if (FILE_PANEL.entries.has(id)) { selectFile(id); const en = FILE_PANEL.entries.get(id); if (info.line) { en.mode === "src" || !en.toSource ? fpGo(en, info.line, info.column) : en.toSource(info.line, info.column); } return; }
  const ext = fpExt(info.path), en = { id, uid, key, path: info.path, name: info.name, info, ext, lang: FP_LANG[ext] || "plaintext", dirty: false };
  en.tab = fpTab(id, `${fpIcon(ext)}<span class="fp-name">${esc(info.name)}</span>`, fpHome(info.path));
  en.body = document.createElement("div"); en.body.className = "fileview";
  panel.querySelector(".fileframes").append(en.body);
  FILE_PANEL.entries.set(id, en); selectFile(id);
  const body = en.body, source = (wrap) => ({ id: "src", label: L("编辑", "Edit"), note: info.editable ? L("可编辑 · ⌘S 保存", "Editable · ⌘S saves") : "", make: (n) => { fpEditor(en, n, en.info.text, { wrap }); } });
  if (info.kind === "external") {
    body.innerHTML = `<div class="fp-empty">${fpIcon(ext)}<b>${esc(info.name)}</b><p>${esc(info.message)}</p><button class="sm primary" data-fpext>${L("用系统应用打开", "Open externally")}</button></div>`;
    body.querySelector("[data-fpext]").onclick = () => fpSystem(false);
  } else if (info.kind === "image" && info.text != null) {           // SVG: the drawing, or its source
    fileModes(body, [{ id: "img", label: L("图片", "Picture"), make: () => fpImage(en, info.url), shown: () => fpStatus(en) }, source(true)], "", en);
    en.onEdit = () => { en.svgDirty = true; };
  } else if (info.kind === "image") {
    body.append(fpImage(en, info.url));
  } else if (info.kind === "text" && info.markdown) {
    let art;
    const render = () => { if (art) { art.innerHTML = md(en.model ? en.model.getValue() : en.info.text); art.querySelectorAll("pre code").forEach((c) => { try { hljs.highlightElement(c); } catch {} }); } };
    fileModes(body, [{ id: "view", label: L("预览", "Preview"), make: () => { art = document.createElement("article"); art.className = "filecontent md fp-md"; render(); return art; }, shown: render }, source(true)], "", en);
    en.onReload = () => render();
    en.toSource = (line, column) => { en.info.line = line; en.info.column = column; body.querySelector('.filemodes [data-m="src"]')?.click(); if (en.model) fpGo(en, line, column); };
    if (info.line) en.toSource(info.line, info.column);
  } else if (info.kind === "text" && /^(html|htm)$/.test(ext)) {
    let preview;
    const render = () => { if (preview) preview.srcdoc = en.model ? en.model.getValue() : en.info.text; };
    fileModes(body, [{id:'view', label:L('网页预览','Web preview'), note:L('隔离预览 · 不运行脚本','Sandboxed preview · scripts disabled'), make:()=>{
      const frame=document.createElement('div'); frame.className='fileframe';
      preview=document.createElement('iframe'); preview.title=en.name; preview.setAttribute('sandbox',''); preview.referrerPolicy='no-referrer';
      frame.append(preview); render(); return frame;
    }, shown:render}, source(false)], '', en);
    en.onReload=render;
  } else if (info.kind === "text") {
    await fpEditor(en, body, info.text, { wrap: /^(txt|log|tex|bib|csv|tsv)$/.test(ext) });
  } else if (info.kind === "sheet") {
    let frame;
    const table = { id: "table", label: L("表格", "Table"), make: () => { frame = fileFrame(info.url, info.name, L("正在读表格…", "Reading the sheet…")); return frame; } };
    en.onSave = en.onReload = () => { const f = frame?.querySelector("iframe"); if (f) f.src = en.info.url + "?t=" + Date.now(); };
    fileModes(body, info.text != null ? [table, source(false)] : [table], "", en);
  } else if (info.kind === "slides") {
    fileModes(body, [{ id: "pdf", label: L("幻灯片", "Slides"), make: () => fileFrame(info.url, info.name, L("正在把幻灯片转成可浏览的页面…第一次打开要几秒", "Turning the slides into pages… a few seconds the first time")) }], "", en);
  } else if (info.pdf_url !== undefined) {                       // Word: the text on a page, or as it would print
    fileModes(body, [
      { id: "read", label: L("阅读", "Reading"), note: info.text_only ? L("只有文字 · 完整排版看「版式」", "Text only · see Layout for the full layout") : L("可重新排版 · 图片和精确排版看「版式」", "Reflowed · pictures and exact layout in Layout"),
        make: () => fileFrame(info.url, info.name) },
      { id: "pdf", label: L("版式", "Layout"), off: info.pdf_url ? "" : L("需要 LibreOffice", "Needs LibreOffice"), note: L("和打印出来一样", "As it prints"),
        make: () => fileFrame(info.pdf_url, info.name, L("正在生成版式预览…第一次打开要几秒", "Laying it out… a few seconds the first time")) }], "", en);
  } else {
    body.append(fileFrame(info.url + (/\.pdf$/i.test(info.path) ? "#view=FitH" : ""), info.name));   // a PDF: the browser's own viewer
  }
  fpStatus(en);
}
window.openPgaFile = openPgaFile;

/* 网页阅读: a link opened inside PGA. The server fetches the page and takes out its article (pga.webread); the original page
   is offered beside it when the site lets itself be shown in a frame; ⌘-click (or the button) opens it in the browser. */
async function openPgaUrl(url, uid = S.uid) {
  try { if (window.top !== window && typeof window.top.openPgaUrl === "function") return window.top.openPgaUrl(url, uid); } catch {}
  const panel = filePanel(); fpDock(true);
  const id = "web:" + url;
  if (FILE_PANEL.entries.has(id)) { selectFile(id); return; }
  let host = url; try { host = new URL(url).hostname.replace(/^www\./, ""); } catch {}
  const en = { id, uid, web: url, path: url, name: host };
  en.tab = fpTab(id, `${fpIcon("", true)}<span class="fp-name">${esc(host)}</span>`, url);
  en.body = document.createElement("div"); en.body.className = "fileview";
  en.body.innerHTML = `<div class="fileloading"><span class="spin"></span> ${L("正在打开网页…", "Opening the page…")}</div>`;
  panel.querySelector(".fileframes").append(en.body);
  FILE_PANEL.entries.set(id, en); selectFile(id);
  const body = en.body;
  let r;
  try { r = await api(`/v1/users/${uid}/web/read`, { body: { url } }); }
  catch (err) {
    body.innerHTML = `<div class="filehint">${esc(err.message)}</div>`;
    const b = document.createElement("button"); b.textContent = L("在浏览器打开", "Open in browser"); b.className = "sm"; b.style.margin = "0 14px";
    b.onclick = () => window.open(url, "_blank", "noopener"); body.append(b); return;
  }
  body.replaceChildren();
  en.webInfo = r; en.web = r.final || url; en.name = r.title || host;
  en.tab.querySelector(".fp-name").textContent = (r.title || host).slice(0, 40); en.tab.title = r.final || url;
  if (r.icon) en.tab.querySelector(".fp-ico").innerHTML = `<img src="${esc(r.icon)}" alt="" onerror="this.parentNode.textContent='◍'">`;
  const original = { id: "orig", label: L("原网页", "Original"), off: r.frameable ? "" : L("这个网站不允许在别的页面里显示，请用浏览器打开", "This site does not allow being shown in a frame: open it in the browser"),
    note: L("原样显示 · 登录、交互以网站为准", "As the site shows it"), make: () => fileFrame(r.final || url, r.title, L("正在载入原网页…", "Loading…")) };
  if (r.kind === "document" || r.kind === "image") {
    fileModes(body, [{ id: "file", label: r.kind === "image" ? L("图片", "Picture") : "PDF", make: () => r.kind === "image" ? fpImage(en, r.url_view) : fileFrame(r.url_view, r.title) }], "", en);
  } else if (r.kind === "text") {
    fileModes(body, [{ id: "text", label: L("文本", "Text"), make: () => { const c = document.createElement(r.markdown ? "article" : "pre"); c.className = r.markdown ? "filecontent md" : "filecontent filetext"; if (r.markdown) c.innerHTML = md(r.text); else c.textContent = r.text; return c; } }], "", en);
  } else {
    const reader = { id: "read", label: L("阅读模式", "Reader"), note: r.thin ? L("这一页没抽出多少正文，可以看原网页", "Little text found here: try the original") : L(`约 ${r.minutes} 分钟读完`, `About ${r.minutes} min read`),
      make: () => {
        const a = document.createElement("article"); a.className = "filecontent webread";
        const clean = (h) => (window.DOMPurify ? DOMPurify.sanitize(h, { FORBID_TAGS: ["style", "form", "input"], FORBID_ATTR: ["style", "onerror", "onload"] }) : esc(h));
        a.innerHTML = `<div class="webcard">${r.image ? `<img class="webhero" src="${esc(r.image)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
          <div class="website"><img src="${esc(r.icon)}" alt="" onerror="this.remove()"><span>${esc(r.site || r.host)}</span>${r.byline ? `<span>· ${esc(r.byline)}</span>` : ""}${r.published ? `<span>· ${esc(String(r.published).slice(0, 10))}</span>` : ""}</div>
          <h1>${esc(r.title || r.host)}</h1>${r.description ? `<p class="webdesc">${esc(r.description)}</p>` : ""}</div>${clean(r.html || "")}`;
        a.querySelectorAll("img").forEach((im) => { im.referrerPolicy = "no-referrer"; im.loading = "lazy"; im.addEventListener("error", () => im.remove()); });
        return a;
      } };
    fileModes(body, r.thin && r.frameable ? [original, reader] : [reader, original], "", en);
  }
  if (FILE_PANEL.active === id) selectFile(id);
}
window.openPgaUrl = openPgaUrl;

/* a link to a web page in an answer, a note or a page read here opens in the reader, not over PGA; ⌘ / Ctrl / Shift-click,
   the middle button, or a link the app marks to open in a new tab, go to the browser as before */
document.addEventListener("click", (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.("a[href]"); if (!a || a.hasAttribute("data-local-file") || a.hasAttribute("download")) return;
  if (a.target === "_blank" && !a.closest(".webread")) return;
  let u; try { u = new URL(a.getAttribute("href"), location.href); } catch { return; }
  if (!/^https?:$/.test(u.protocol) || u.origin === location.origin) return;
  e.preventDefault(); e.stopPropagation();
  openPgaUrl(u.href);
}, true);
