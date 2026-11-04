/* PGA app · 备忘 (memos): ＋ 新备忘 at the top right adds a page to the stage — full height, beside the conversations.
   - A memo is a Markdown file (pga/memos.py), written as one sheet of text: blank lines are just blank lines. The dot on the
     right (or ⌘↵) opens a conversation from the paragraph the cursor is in.
   - Paste a picture (⌘V) or drop one in: it becomes its own paragraph.
   - ⌘C on a conversation (hover it in the list, or focus its window) or a document copies a reference to it; ⌘V in a memo
     turns that into a link you can click to open it again. (The reference is also plain text: pga://<kind>/<key>.)
   The page is a node of the stage (app-stage.js, n.memo); closing it keeps the memo. Embedded windows only contribute the ⌘C part. */

const MM = { wins: [], data: new Map(), z: 70, hover: null };
const MM_EMBED = document.documentElement.classList.contains("embed") || window.parent !== window;
const mmStore = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const MM_ICON = { conv: "💬", doc: "📚" };
const mmImg = (name) => `/v1/users/${S.uid}/memo-images/${name}`;

function memoBtns() {
  if (MM_EMBED) return "";
  return `<button class="sm" data-memo="new">＋ ${L("新备忘", "New memo")}</button><button class="sm ghost" data-memo="list" title="${L("所有备忘", "All memos")}">📝</button><button class="sm ghost" data-nettest title="${L("网络测试：看看这台电脑现在能不能连上 Claude、OpenAI、GitHub 等", "Network test: can this machine reach Claude, OpenAI, GitHub…")}">🌐</button>`;
}

/* ------------------------------------------------ text <-> paragraphs */
function mmParse(text) {
  const out = [];
  for (const p of String(text || "").split(/\n[ \t]*\n\s*/)) {
    const t = p.replace(/^\s+|\s+$/g, ""); if (!t) continue;
    let m;
    if ((m = t.match(/^!\[\]\(img\/([\w.]+)\)$/))) out.push({ t: "img", v: m[1] });
    else if ((m = t.match(/^\[\[ref:(\w+):([^|\]]+)\|([^\]]*)\]\]$/))) out.push({ t: "ref", kind: m[1], key: m[2], title: m[3] });
    else if (out.length && out[out.length - 1].t === "text") out[out.length - 1].v += "\n\n" + t;   // paragraphs of text stay one sheet
    else out.push({ t: "text", v: t });
  }
  return out.length ? out : [{ t: "text", v: "" }];
}
function mmText(blocks) {
  return blocks.map((b) => b.t === "img" ? `![](img/${b.v})` : b.t === "ref" ? `[[ref:${b.kind}:${b.key}|${b.title}]]` : b.v.replace(/^\s+|\s+$/g, "")).filter(Boolean).join("\n\n") + "\n";
}
const mmHash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
const mmSentKey = (w, b) => w.id + ":" + mmHash(b.t === "ref" ? b.kind + b.key : b.v);

/* ------------------------------------------------ pages of the stage (a memo is a full-height page, like a conversation) */
const memoNodeTitle = (n) => "📝 " + (MM.titles[n.memo] || L("备忘", "Memo"));
function memoWinHtml(n) {
  return `<div class="stwin stmemowin">${["e", "w", "n", "s", "ne", "nw", "se", "sw"].map((d) => `<i class="rz rz-${d}" data-rz="${d}"></i>`).join("")}
    <div class="stwh" data-stfocus="${n.id}"><b class="stwt">📝 <span class="memot">${L("备忘", "Memo")}</span></b><span class="memost"></span><span class="grow"></span>
      <button class="stb stwsb" data-stw="ws">●</button><button class="stb" data-stw="min" title="${L("缩成小页面", "Make it a small page")}">–</button><button class="stb" data-stw="max" title="${L("最大化（Esc 还原）", "Maximise (Esc restores)")}">▢</button><button class="stb" data-stw="close" title="${L("关掉这一页（备忘已保存，可从 📝 再打开）", "Close the page (the memo is kept; reopen it from 📝)")}">×</button></div>
    <div class="memob"></div></div>`;
}
MM.titles = {};
async function memoNew() {
  let r; try { r = await api(`/v1/users/${S.uid}/memos`, { method: "POST", body: {} }); } catch (e) { toast(e.message); return; }
  memoShow(r.id, true);
}
function memoShow(id, focus) {                                     // the memo's page on the stage: brought up, or added at the end of the row
  if (S.view !== "stage") show("stage");
  let n = ST.nodes.find((x) => x.memo === id);
  if (!n) { n = { id: "memo-" + id, type: "win", memo: id, ord: stWins().length, bw: 440 }; ST.nodes.push(n); stWins().forEach((o, k) => { o.ord = k; }); }
  n.mini = false; ST.focus = n.id; stRender(); stSave(); stShow(n.id);
  if (focus) setTimeout(() => n.el?.querySelector?.("textarea")?.focus() || document.querySelector(`.stnode[data-nid="${n.id}"] textarea`)?.focus(), 80);
}
async function memoMount(n, el) {                                  // the page was drawn: load the memo into it
  const id = n.memo;
  let w = MM.wins.find((x) => x.id === id);
  if (w) { w.el = el; memoBody(w); memoHead(w); return; }
  const t0 = setInterval(async () => {
    if (!S.uid) return; clearInterval(t0);
    let r; try { r = await api(`/v1/users/${S.uid}/memos/${id}`); } catch { toast(L("这个备忘找不到了，已拿掉它的页面", "That memo is gone; its page was removed")); ST.nodes = ST.nodes.filter((x) => x !== n); stRender(); stSave(); return; }
    if (MM.wins.find((x) => x.id === id)) return;
    w = { id, rev: r.rev, blocks: mmParse(r.text), el, saveT: null, dirty: false };
    MM.wins.push(w); memoBody(w); memoHead(w);
    el.addEventListener("keydown", (e) => { if (!(e.metaKey || e.ctrlKey)) e.stopPropagation(); });
    el.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault(); });
    el.addEventListener("drop", (e) => { const fs = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/")); if (!fs.length) return; e.preventDefault(); memoImages(w, fs, w.blocks.length - 1); });
  }, 150);
}
async function memoUnmount(id) { const w = MM.wins.find((x) => x.id === id); if (!w) return; await memoSave(w); MM.wins = MM.wins.filter((x) => x !== w); }
function memoTitle(w) { const b = w.blocks.find((x) => (x.t === "text" && x.v.trim()) || x.t === "ref"); return b ? (b.t === "ref" ? b.title : b.v.trim().split("\n")[0]).slice(0, 40) : ""; }
function memoHead(w) { MM.titles[w.id] = memoTitle(w); const t = w.el?.querySelector(".memot"); if (t) t.textContent = MM.titles[w.id] || L("新备忘", "New memo"); }
function memoStatus(w, t) { const s = w.el?.querySelector(".memost"); if (s) s.textContent = t; }

function memoBody(w, focusAt) {
  const body = w.el.querySelector(".memob"), sent = mmStore.get("pga_memo_sent", {});
  body.innerHTML = w.blocks.map((b, i) => {
    const dot = `<button class="mdot ${sent[mmSentKey(w, b)] ? "sent" : ""}" data-mdot="${i}" tabindex="-1" title="${L("点这里：用光标所在的那一段开一个新对话（也可以按 ⌘↵）", "Click: start a conversation from the paragraph the cursor is in (or ⌘↵)")}"></button>`;
    const c = b.t === "img" ? `<img src="${esc(mmImg(b.v))}" alt="">`
      : b.t === "ref" ? `<a class="mref" data-mref="${i}" title="${esc(b.kind + "://" + b.key)}">${MM_ICON[b.kind] || "🔗"} ${esc(b.title || b.key)}</a>`
      : `<textarea rows="1" spellcheck="false" data-mta="${i}" placeholder="${i === 0 ? L("随手写，就像一个文本文件。⌘↵ 用光标所在的那一段开一个对话；⌘V 可以贴图片，或贴在别处 ⌘C 复制的对话", "Write freely, as in a text file. ⌘↵ starts a conversation from the paragraph the cursor is in. ⌘V pastes a picture, or a conversation you copied with ⌘C") : ""}"></textarea>`;
    return `<div class="mb ${b.t}" data-mb="${i}"><div class="mbc">${c}</div>${dot}</div>`;
  }).join("");
  body.querySelectorAll("textarea").forEach((ta) => { const i = Number(ta.dataset.mta); ta.value = w.blocks[i].v; memoFit(ta); memoWire(w, ta, i); });
  if (focusAt) { const ta = body.querySelector(`[data-mta="${focusAt.i}"]`); if (ta) { ta.focus(); ta.setSelectionRange(focusAt.pos ?? ta.value.length, focusAt.pos ?? ta.value.length); } }
}
const memoFit = (ta) => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; };

function memoWire(w, ta, i) {
  ta.addEventListener("input", () => {
    const b = w.blocks[i]; b.v = ta.value;
    memoFit(ta); memoChanged(w);
  });
  ta.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;               // choosing characters with an input method
    const b = w.blocks[i];
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {          // ⌘↵: a conversation from the paragraph the cursor is in
      e.preventDefault(); e.stopPropagation(); memoAskAt(w, i, ta.selectionStart);
    } else if (e.key === "Backspace" && !ta.value && w.blocks.length > 1 && ta.selectionStart === 0) {
      e.preventDefault(); w.blocks.splice(i, 1);
      const prev = Math.max(0, i - 1); memoBody(w, w.blocks[prev].t === "text" ? { i: prev } : null); memoChanged(w);
    } else if (e.key === "ArrowUp" && ta.selectionStart === 0 && i > 0) { w.el.querySelector(`[data-mta="${i - 1}"]`)?.focus(); }
    else if (e.key === "ArrowDown" && ta.selectionStart === ta.value.length) { w.el.querySelector(`[data-mta="${i + 1}"]`)?.focus(); }
  });
  ta.addEventListener("paste", (e) => memoPaste(w, i, e));
  const keep = () => { (w.caret ||= {})[i] = ta.selectionStart; }; ta.addEventListener("keyup", keep); ta.addEventListener("mouseup", keep); ta.addEventListener("blur", keep);
}

/* the paragraph (between blank lines) a position falls in: what the dot or ⌘↵ starts a conversation from */
function mmParaAt(v, pos) {
  const ps = []; const re = /[^\n]*\S[^\n]*(?:\n(?![ \t]*\n)[^\n]*)*/g; let m;
  while ((m = re.exec(v))) ps.push({ s: m.index, e: m.index + m[0].length, t: m[0].trim() });
  return (ps.find((p) => pos >= p.s && pos <= p.e) || [...ps].reverse().find((p) => p.e <= pos) || ps[0] || { t: v.trim() }).t;
}
async function memoAskAt(w, i, pos) {
  const b = w.blocks[i]; const text = mmParaAt(b.v, pos); if (!text) return;
  const res = await stAsk(text);
  if (res?.key) { const s = mmStore.get("pga_memo_sent", {}); s[mmSentKey(w, b)] = res.key; mmStore.set("pga_memo_sent", s); memoBody(w, { i, pos }); }
}

/* ------------------------------------------------ saving */
function memoChanged(w) {
  w.dirty = true; memoHead(w); memoStatus(w, "…"); clearTimeout(w.saveT);
  w.saveT = setTimeout(() => memoSave(w), 700);
}
async function memoSave(w) {
  clearTimeout(w.saveT); w.saveT = null; if (!w.dirty) return; w.dirty = false;
  try { const r = await api(`/v1/users/${S.uid}/memos/${w.id}`, { method: "PUT", body: { text: mmText(w.blocks), rev: w.rev } }); w.rev = r.rev; if (!w.dirty) memoStatus(w, L("已保存", "Saved")); }
  catch (err) {
    w.dirty = true;
    if (/another window/.test(err.message)) { toast(L("这个备忘在另一个窗口改过了：已载入那边的版本", "This memo changed in another window: loaded that version")); const r = await api(`/v1/users/${S.uid}/memos/${w.id}`).catch(() => null); if (r) { w.rev = r.rev; w.blocks = mmParse(r.text); w.dirty = false; memoBody(w); memoHead(w); } }
    else memoStatus(w, err.message);
  }
}
window.addEventListener("beforeunload", () => MM.wins.forEach((w) => { if (w.dirty) fetch(`/v1/users/${S.uid}/memos/${w.id}`, { method: "PUT", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: mmText(w.blocks), rev: w.rev }) }); }));

/* ------------------------------------------------ pictures and references */
const memoReadFile = (f) => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(f); });
async function memoImages(w, files, at) {
  for (const f of files) {
    if (f.size > 12e6) { toast(L("图片超过 12 MB", "The picture is over 12 MB")); continue; }
    try { const r = await api(`/v1/users/${S.uid}/memo-images`, { body: { data: await memoReadFile(f) } }); memoInsert(w, at, { t: "img", v: r.name }); at++; }
    catch (e) { toast(e.message); }
  }
}
function memoInsert(w, at, ...bs) {                                // after paragraph `at`; an empty text paragraph there is replaced
  const cur = w.blocks[at];
  if (cur && cur.t === "text" && !cur.v.trim()) { w.blocks.splice(at, 1, ...bs); at--; } else w.blocks.splice(at + 1, 0, ...bs);
  if (w.blocks[w.blocks.length - 1].t !== "text") w.blocks.push({ t: "text", v: "" });
  memoBody(w); memoChanged(w);
}
function memoRefs(dt) {
  try { const j = dt.getData("application/x-pga-ref"); if (j) return [JSON.parse(j)]; } catch {}
  const t = dt.getData("text/plain") || "", out = [], re = /([^\n]*?)\s*pga:\/\/(\w+)\/(\S+)/g; let m;
  while ((m = re.exec(t))) out.push({ kind: m[2], key: decodeURIComponent(m[3]), title: m[1].trim() });
  return out;
}
function memoSplitAt(w, i, ta) {                                // a picture or reference pasted mid-text goes where the cursor is: the text splits around it
  const b = w.blocks[i], pos = ta?.selectionStart ?? b?.v?.length ?? 0; if (b?.t !== "text") return i;
  const head = b.v.slice(0, pos).replace(/\s+$/, ""), tail = b.v.slice(ta?.selectionEnd ?? pos).replace(/^\s+/, "");
  if (!head || !tail) return head ? i : i - 1 < 0 ? (b.v = tail, w.blocks.splice(i, 0, { t: "text", v: "" }), i) : i - 1;
  b.v = head; w.blocks.splice(i + 1, 0, { t: "text", v: tail }); return i;
}
function memoPaste(w, i, e) {
  const dt = e.clipboardData; if (!dt) return;
  const imgs = [...dt.files].filter((f) => f.type.startsWith("image/"));
  if (imgs.length || memoRefs(dt).length) i = memoSplitAt(w, i, e.target);
  if (imgs.length) { e.preventDefault(); memoImages(w, imgs, i); return; }
  const refs = memoRefs(dt);
  if (refs.length) { e.preventDefault(); memoInsert(w, i, ...refs.map((r) => ({ t: "ref", kind: r.kind, key: r.key, title: String(r.title || r.key).replace(/[|\]\n]/g, " ").slice(0, 80) }))); }
}

/* ⌘C on a conversation or document anywhere in the app copies a reference to it */
document.addEventListener("mouseover", (e) => { MM.hover = e.target; }, true);
function memoCopyRef() {
  if (getSelection().toString()) return null;
  const a = document.activeElement; if (a && (/^(TEXTAREA|INPUT|SELECT)$/.test(a.tagName) || a.isContentEditable)) return null;
  if (MM_EMBED) {                                                  // inside a conversation window: that conversation
    const key = typeof S !== "undefined" ? S.chat : null; if (!key) return null;
    let title = ""; try { title = window.parent.stTitle?.(key) || ""; } catch {}
    return { kind: "conv", key, title: title || document.querySelector("#chead h1")?.textContent || key };
  }
  const h = MM.hover?.closest?.("[data-ritem]"); if (h) return { kind: "conv", key: h.dataset.ritem, title: h.getAttribute("title")?.split(" · ")[0] || h.querySelector("b")?.textContent || h.dataset.ritem };
  const d = MM.hover?.closest?.("[data-doc]"); if (d && d.dataset.doc) return { kind: "doc", key: d.dataset.doc, title: (d.querySelector(".t,b,.ti")?.textContent || d.textContent || "").trim().split("\n")[0].slice(0, 60) };
  if (typeof ST !== "undefined" && S.view === "stage") { const n = ST.nodes.find((x) => x.id === ST.focus && x.type === "win" && x.key); if (n) return { kind: "conv", key: n.key, title: stTitle(n.key) }; }
  if (S.view === "chats" && S.chat) return { kind: "conv", key: S.chat, title: document.querySelector("#chead h1")?.textContent || S.chat };
  return null;
}
document.addEventListener("copy", (e) => {
  const r = memoCopyRef(); if (!r || !e.clipboardData) return;
  e.preventDefault();
  e.clipboardData.setData("text/plain", `${r.title} pga://${r.kind}/${encodeURIComponent(r.key)}`);
  e.clipboardData.setData("application/x-pga-ref", JSON.stringify(r));
  try { (MM_EMBED ? window.parent : window).toast(L(`已复制「${String(r.title).slice(0, 20)}」的引用：到备忘里按 ⌘V`, `Copied a reference to “${String(r.title).slice(0, 20)}”: ⌘V in a memo`)); } catch {}
});

function memoOpenRef(b) {
  if (b.kind === "conv") { if (S.view !== "stage") show("stage"); stOpen(b.key); }
  else if (b.kind === "doc") showDoc(b.key);
  else toast(b.kind + "://" + b.key);
}

/* ------------------------------------------------ the dot's menu, the list, clicks */
function memoMenu(x, y, html) {
  document.querySelector(".memomenu")?.remove();
  const m = document.createElement("div"); m.className = "memomenu card"; m.innerHTML = html; document.body.appendChild(m);
  m.style.left = Math.min(x, innerWidth - m.offsetWidth - 8) + "px"; m.style.top = Math.min(y, innerHeight - m.offsetHeight - 8) + "px"; m.style.zIndex = MM.z + 5; return m;
}
function memoDotMenu(w, i, btn) {
  const b = w.blocks[i], r = btn.getBoundingClientRect(), k = mmStore.get("pga_memo_sent", {})[mmSentKey(w, b)];
  const empty = b.t === "text" && !b.v.trim();
  const items = [
    b.t === "img" ? "" : empty ? "" : `<button data-mact="ask">💬 ${L("用这一段开新对话", "Start a conversation from this")}</button>`,
    k ? `<button data-mact="open">↗ ${L("打开之前开的那段对话", "Open the conversation started from it")}</button>` : "",
    b.t === "ref" ? `<button data-mact="follow">↗ ${L("打开这条引用", "Open this reference")}</button>` : "",
    `<button data-mact="add">＋ ${L("下面加一段", "Add a paragraph below")}</button>`,
    `<button data-mact="del" class="bad">✕ ${L("删除这一段", "Delete this paragraph")}</button>`].join("");
  const m = memoMenu(r.right + 4, r.top - 4, items);
  m.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-mact]")?.dataset.mact; if (!a) return; m.remove();
    if (a === "del") { w.blocks.splice(i, 1); if (!w.blocks.length) w.blocks.push({ t: "text", v: "" }); memoBody(w); memoChanged(w); }
    else if (a === "add") { w.blocks.splice(i + 1, 0, { t: "text", v: "" }); memoBody(w, { i: i + 1 }); }
    else if (a === "follow") memoOpenRef(b);
    else if (a === "open") { if (S.view !== "stage") show("stage"); stOpen(k); }
    else if (a === "ask") {
      const text = b.t === "ref" ? L(`关于「${b.title}」：`, `About “${b.title}”: `) : mmParaAt(b.v, w.caret?.[i] ?? 0);
      const res = await stAsk(text);
      if (res?.key) { const s = mmStore.get("pga_memo_sent", {}); s[mmSentKey(w, b)] = res.key; mmStore.set("pga_memo_sent", s); memoBody(w); }
    }
  });
}
async function memoList(btn) {
  let r; try { r = await api(`/v1/users/${S.uid}/memos`); } catch (e) { toast(e.message); return; }
  const rect = btn.getBoundingClientRect();
  const rows = r.memos.length ? r.memos.map((x) => `<div class="mrow"><button data-mopen="${x.id}">${esc(x.title || L("（空白备忘）", "(empty memo)"))}<em>${esc(ago ? ago(x.updated || x.ts * 1000) : "")}</em></button><button class="ghost" data-mdel="${x.id}" title="${L("删除（放进回收目录）", "Delete (moved to .trash)")}">✕</button></div>`).join("")
    : `<div class="muted" style="padding:8px 10px">${L("还没有备忘", "No memos yet")}</div>`;
  memoMenu(Math.max(8, rect.right - 280), rect.bottom + 6, rows);
}
document.addEventListener("click", async (e) => {
  const t = e.target;
  const mb = t.closest("[data-memo]"); if (mb) { mb.dataset.memo === "new" ? memoNew() : memoList(mb); return; }
  if (!t.closest(".memomenu") && !t.closest("[data-mdot]")) document.querySelector(".memomenu")?.remove();
  const op = t.closest("[data-mopen]"); if (op) { document.querySelector(".memomenu")?.remove(); memoShow(op.dataset.mopen); return; }
  const dl = t.closest("[data-mdel]"); if (dl) {
    if (!confirm(L("删除这个备忘？（文件会放进回收目录，不会彻底消失）", "Delete this memo? (The file goes to .trash, not erased)"))) return;
    const id = dl.dataset.mdel; await api(`/v1/users/${S.uid}/memos/${id}`, { method: "DELETE" }).catch((er) => toast(er.message));
    const n = ST.nodes.find((x) => x.memo === id); if (n) { MM.wins = MM.wins.filter((x) => x.id !== id); ST.nodes = ST.nodes.filter((x) => x !== n); stRender(); stSave(); } document.querySelector(".memomenu")?.remove(); return;
  }
  const memo = t.closest(".stnode"); if (!memo) return;
  const w = MM.wins.find((x) => "memo-" + x.id === memo.dataset.nid); if (!w) return;
  if (t.closest(".memob") && !t.closest("textarea, button, a, img")) {             // the page is one sheet: a click off the text writes at the end of the last paragraph
    const tas = [...memo.querySelectorAll(".memob textarea")], ta = tas[tas.length - 1];
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } else { w.blocks.push({ t: "text", v: "" }); memoBody(w, { i: w.blocks.length - 1 }); }
    return;
  }
  const dot = t.closest("[data-mdot]"); if (dot) { memoDotMenu(w, Number(dot.dataset.mdot), dot); return; }
  const rf = t.closest("[data-mref]"); if (rf) { memoOpenRef(w.blocks[Number(rf.dataset.mref)]); return; }
  const im = t.closest(".mb.img img"); if (im) { window.open(im.src, "_blank"); }
});
