/* PGA app · 常驻笔记, a notepad on the left of every page that never changes under you.

   - Write freely; a blank line (two Enters) starts a new idea.
   - When an idea is ready, ⌘↵ or the button hands it to an agent: it starts a conversation of its own, which opens in
     the conversations page, and lands in the world tree like any other.
   - The page itself is kept verbatim as a Markdown file (pga/pad.py: notes/pad/<you>/pad.md, with earlier versions in
     history/). PGA never writes into it.
   - Ideas already handed out are marked in place.
   - Edit one after handing it out and it is marked "edited"; handing it out again asks its conversation the new
     version. */

const PAD = { text: "", rev: 0, sent: [], path: "", open: (() => { try { return localStorage.getItem("pga_pad") !== "0"; } catch { return true; } })(),
  agent: (() => { try { return localStorage.getItem("pga_pad_agent") || "auto"; } catch { return "auto"; } })(), saveT: null, loaded: false,
  w: (() => { try { return Number(localStorage.getItem("pga_pad_w")) || 300; } catch { return 300; } })() };

function paraRanges(t) {                          // each idea: where it starts and ends in the page
  const out = [], re = /\n[ \t]*\n\s*/g; let last = 0, m;
  const push = (a, b) => { while (a < b && /\s/.test(t[a])) a++; while (b > a && /\s/.test(t[b - 1])) b--; if (b > a) out.push({ start: a, end: b, text: t.slice(a, b) }); };
  while ((m = re.exec(t))) { push(last, m.index); last = m.index + m[0].length; }
  push(last, t.length); return out;
}
const grams = (s) => { const g = new Set(); s = s.replace(/\s+/g, ""); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
const like = (a, b) => { const x = grams(a), y = grams(b); if (!x.size || !y.size) return 0; let n = 0; for (const g of x) if (y.has(g)) n++; return n / (x.size + y.size - n); };

/* which handed-out idea each paragraph is (the text as sent, or the paragraph it became when you edited it) */
function padMatch() {
  const ps = paraRanges(PAD.text), used = new Set(), of = new Map();
  for (const s of PAD.sent) { const i = ps.findIndex((p, j) => !used.has(j) && p.text === s.text); if (i >= 0) { used.add(i); of.set(i, s); } }
  for (const s of PAD.sent) {
    if ([...of.values()].includes(s)) continue;
    let best = -1, sc = .5; ps.forEach((p, j) => { if (!used.has(j)) { const v = like(p.text, s.text); if (v > sc) { sc = v; best = j; } } });
    if (best >= 0) { used.add(best); of.set(best, s); if (s.text !== ps[best].text) { s.text = ps[best].text; s.pending = true; padEdited(s); } }
  }
  return { ps, of };
}
function padEdited() { padSaveSent(); }         // an idea you changed after handing it out: marked, sent again when you say
function padState(s) { return s.pending ? "stale" : s.st || "done"; }
function padSync() { padSaveSent(); padPaint(); }

/* ------------------------------------------------ the panel */
function padMount() {
  if (document.documentElement.classList.contains("embed") || $("#pad")) return;
  const app = $(".app");
  app.insertAdjacentHTML("afterbegin", `<aside class="pad" id="pad"><i class="padgrip" id="padGrip"></i>
    <div class="padh"><button class="ghost padrail" id="padRail" title="${L("对话列表和导航（⌘⇧S）", "Conversations and navigation (⌘⇧S)")}"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button><b>${L("笔记", "Notepad")}</b><span class="padst" id="padSt"></span><button class="ghost padfold" id="padFold" title="${L("收起 / 展开笔记", "Fold / unfold the notepad")}">«</button></div>
    <div class="pade"><div class="padbg" id="padBg" aria-hidden="true"></div><textarea id="padText" spellcheck="false" placeholder="${L("随手写。空一行就是一个新想法。\n\n写完一段，按 ⌘↵ 或下面的按钮交给 agent，回答和它做的事出现在左边的画布上。\n\n这一页原样保存成一个文件，PGA 不会改它。", "Write freely. A blank line starts a new idea.\n\nWhen one is ready, ⌘↵ or the button below hands it to an agent; its answer and what it did appear on the canvas on the left.\n\nThis page is kept verbatim as a file; PGA never changes it.")}"></textarea></div>
    <div class="padf"><select id="padAgent"></select><button class="sm primary" id="padSend" title="${L("把光标所在的这个想法交给 agent（⌘↵）", "Hand the idea under the cursor to an agent (⌘↵)")}">${L("交给 agent", "Hand to agent")} ▸</button><button class="sm ghost" id="padAll" title="${L("每个还没交出的想法各交给一个 agent，同时做", "Each idea not yet handed out goes to its own agent, at the same time")}">${L("没交出的都交出去", "Hand out the rest")}</button></div>
    <div class="padl" id="padList"></div></aside>`);
  app.classList.add("haspad"); padLayout();
  $("#padText").addEventListener("input", () => { PAD.text = $("#padText").value; padPaint(); padSave(); });
  $("#padText").addEventListener("scroll", () => { $("#padBg").scrollTop = $("#padText").scrollTop; });
  $("#padText").addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); padSend(); } });
  $("#padText").addEventListener("keyup", padPaint); $("#padText").addEventListener("click", padPaint);
  $("#padAgent").addEventListener("change", (e) => { PAD.agent = e.target.value; try { localStorage.setItem("pga_pad_agent", PAD.agent); } catch {} });
  $("#padGrip").addEventListener("pointerdown", (e) => {
    e.preventDefault(); app.classList.add("resizing");
    const mv = (ev) => { PAD.w = Math.round(Math.max(240, Math.min(innerWidth * .5, ev.clientX - app.getBoundingClientRect().left))); padLayout(); };
    const up = () => { document.removeEventListener("pointermove", mv); document.removeEventListener("pointerup", up); app.classList.remove("resizing"); try { localStorage.setItem("pga_pad_w", PAD.w); } catch {} };
    document.addEventListener("pointermove", mv); document.addEventListener("pointerup", up);
  });
  const w = setInterval(() => { if (S.uid) { clearInterval(w); padLoad(); } }, 200);
}
function padLayout() { const app = $(".app"); app.style.setProperty("--padw", (PAD.open ? PAD.w : 34) + "px"); app.classList.toggle("padmin", !PAD.open); const f = $("#padFold"); if (f) f.textContent = PAD.open ? "«" : "»"; }
async function padLoad() {
  try { const r = await api(`/v1/users/${S.uid}/pad`); PAD.text = r.text; PAD.rev = r.rev; PAD.sent = r.sent || []; PAD.path = r.path; PAD.loaded = true; } catch { return; }
  const t = $("#padText"); if (t && document.activeElement !== t) t.value = PAD.text;
  padAgents(); padPaint(); padStatus(PAD.path ? L("保存在 ", "Kept in ") + PAD.path.replace(/^.*\/notes\//, "notes/") : "");
}
function padAgents() { const sel = $("#padAgent"); if (!sel) return; sel.innerHTML = `<option value="auto">${L("自动选 agent", "Auto")}</option>` + S.agents.map((a) => `<option value="${esc(a.name)}" ${a.name === PAD.agent ? "selected" : ""}>${esc(agentLabel(a.name))}</option>`).join(""); }
function padStatus(t) { const el = $("#padSt"); if (el) { el.textContent = t; el.title = PAD.path || ""; } }
function padSave() {
  clearTimeout(PAD.saveT); padStatus(L("…", "…"));
  PAD.saveT = setTimeout(async () => {
    try { const r = await api(`/v1/users/${S.uid}/pad`, { method: "PUT", body: { text: PAD.text, rev: PAD.rev } }); PAD.rev = r.rev; PAD.saveT = null; padStatus(L("已保存", "Saved")); }
    catch (err) { PAD.saveT = null; if (/another window/.test(err.message)) { toast(L("笔记在另一个窗口改过了：已载入那边的版本（这边刚写的在 history/ 里没有，复制一下再刷新）", "The notepad changed in another window: loaded that version")); padLoad(); } else padStatus(err.message); }
  }, 700);
}
function padSaveSent() { clearTimeout(PAD.sentT); PAD.sentT = setTimeout(() => api(`/v1/users/${S.uid}/pad`, { method: "PUT", body: { sent: PAD.sent } }).catch(() => {}), 400); }
function padPaint() {
  const bg = $("#padBg"), t = $("#padText"); if (!bg || !t) return;
  const { ps, of } = padMatch(), caret = t.selectionStart ?? 0, cur = padCurrent(ps, caret);
  let h = "", at = 0;
  ps.forEach((p, i) => { const s = of.get(i); h += esc(PAD.text.slice(at, p.start)); h += `<mark class="${s ? "p-" + padState(s) : ""} ${p === cur ? "cur" : ""}">${esc(p.text)}</mark>`; at = p.end; });
  bg.innerHTML = h + esc(PAD.text.slice(at)) + "\n "; bg.scrollTop = t.scrollTop;
  const lab = { done: L("已回答", "answered"), run: L("在做", "working"), err: L("出错", "failed"), stale: L("改过，待重跑", "edited, run again"), gone: L("节点已删", "node removed") };
  $("#padList").innerHTML = ps.length ? ps.map((p, i) => { const s = of.get(i), st = s ? padState(s) : "";
    return `<div class="padi ${p === cur ? "cur" : ""}" data-padi="${i}"><span class="pdot ${st ? "p-" + st : ""}"></span><span class="pt">${esc(p.text.replace(/\s+/g, " ").slice(0, 60))}</span>${s ? `<em>${esc(s.agent || "")} · ${lab[st] || ""}</em>` : `<button class="sm ghost" data-padgo="${i}">${L("交出", "Hand out")}</button>`}</div>`; }).join("")
    : `<div class="padx">${L("还没有想法。", "No ideas yet.")}</div>`;
}
function padCurrent(ps, caret) { return ps.find((p) => caret >= p.start && caret <= p.end) || [...ps].reverse().find((p) => p.end <= caret) || ps[0] || null; }

/* ------------------------------------------------ handing an idea to an agent */
async function padSend(idx) {
  const t = $("#padText"); PAD.text = t.value;
  const { ps, of } = padMatch(), p = idx != null ? ps[idx] : padCurrent(ps, t.selectionStart ?? 0);
  if (!p) { toast(L("先写一个想法", "Write an idea first")); return; }
  const was = of.get(ps.indexOf(p));
  if (was?.key && !was.pending) { padLocate(was); toast(L("这个想法已经交出去了：这是它的对话", "Already handed out: here is its conversation")); return; }
  const s = was?.key ? was : { id: Math.random().toString(36).slice(2, 10), key: null, agent: PAD.agent };
  const text = was?.key ? L(`（我改了这个想法，新的版本是：）\n${p.text}`, `(I changed this idea; the new version:)\n${p.text}`) : p.text;
  Object.assign(s, { text: p.text, at: new Date().toISOString(), st: "run", pending: false });
  if (!was) PAD.sent.push(s);
  padSaveSent(); padPaint();
  if (was?.key) {                                 // asked again in its own conversation, its window brought up
    padLocate(s);
    const acc = S.acc?.["*new"] || {};
    return api(`/v1/users/${S.uid}/agents/ask`, { body: { text, agent: s.agent || "auto", conversation: s.key, access: acc.access || "read", folder: acc.folder || "", mcp: !!acc.mcp } })
      .then((r) => { s.st = r?.error && !r?.text ? "err" : "done"; }).catch(() => { s.st = "err"; }).finally(padSync);
  }
  const r = await stAsk(text);                    // a window of its own on the stage, the question already sent
  s.key = r.key; s.st = r.key ? "done" : "err"; padSync();
}
async function padSendAll() {
  const { ps, of } = padMatch(), todo = ps.map((p, i) => i).filter((i) => !of.has(i));
  if (!todo.length) { toast(L("每个想法都已经交出去了", "Every idea is already handed out")); return; }
  if (todo.length > 6 && !confirm(L(`要同时交出 ${todo.length} 个想法、开 ${todo.length} 个 agent 对话吗？`, `Hand out ${todo.length} ideas to ${todo.length} agents at once?`))) return;
  const jobs = []; for (const i of todo) { jobs.push(padSend(i)); await new Promise((ok) => setTimeout(ok, 120)); }
  await Promise.all(jobs);
}
async function padLocate(s) { if (s.key) { if (S.view !== "stage") show("stage"); stOpen(s.key); } }
document.addEventListener("click", (e) => {
  if (e.target.closest("#padSend")) { padSend(); return; }
  if (e.target.closest("#padAll")) { padSendAll(); return; }
  if (e.target.closest("#padRail")) { setMini(!S.mini); return; }
  if (e.target.closest("#padFold")) { PAD.open = !PAD.open; try { localStorage.setItem("pga_pad", PAD.open ? "1" : "0"); } catch {} padLayout(); return; }
  const go = e.target.closest("[data-padgo]"); if (go) { padSend(Number(go.dataset.padgo)); return; }
  const it = e.target.closest("[data-padi]"); if (it) {
    const i = Number(it.dataset.padi), { ps, of } = padMatch(), s = of.get(i), t = $("#padText");
    if (ps[i]) { t.focus(); t.setSelectionRange(ps[i].start, ps[i].start); const lh = parseFloat(getComputedStyle(t).lineHeight) || 20; t.scrollTop = Math.max(0, PAD.text.slice(0, ps[i].start).split("\n").length * lh - 60); padPaint(); }
    if (s) padLocate(s);
  }
});
setInterval(() => { if (PAD.loaded && document.activeElement !== $("#padText") && !PAD.saveT) padLoad(); }, 60000);
window.addEventListener("focus", () => { if (PAD.loaded && document.activeElement !== $("#padText")) padLoad(); });
const _bootAgentsPad = setInterval(() => { if (S.agents.length) { padAgents(); clearInterval(_bootAgentsPad); } }, 500);
padMount();
