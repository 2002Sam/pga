/* PGA app · everyday chats, lines and the time tree, imported conversations. Plain scripts sharing one global scope, loaded in order by app.html. */
/* ------------------------------------------------ everyday chats, on the time tree */
const chatOf = (k) => (S.chats || []).find((c) => c.key === k);
const hueOf = (x) => { let h = 7; for (const c of String(x)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const CONN = { claude_code: "claude", codex: "codex", hermes: "hermes", workbuddy: "workbuddy", codebuddy: "workbuddy" };
function pollTidy(n = 0) { setTimeout(async () => { await loadTimeline(); if (S.tl?.pending && n < 40) pollTidy(n + 1); else if (n) toast(L("整理完了", "Tidied")); }, 6000); }
async function loadTimeline() {
  try { S.tl = await api(`/v1/users/${S.uid}/timeline?days=120`); } catch { S.tl = S.tl || { sessions: [], lines: {} }; }
  renderTimeline();                                    // the list lives in the rail now: every view shows it
}
const renderChatList = () => renderTimeline();
/* rows go by time; each line holds a lane while it keeps talking (next session within a day); when it comes back later
   it takes a free lane and a path is drawn from where it stopped */
function tlLayout() {
  const T = S.tl || { sessions: [] }, ss = T.sessions || [], rows = [], ROW = 48, DAY = 34;
  const nextOf = new Map(), byLine = new Map();
  ss.forEach((x, i) => { if (!byLine.has(x.line)) byLine.set(x.line, []); byLine.get(x.line).push(i); });
  for (const idx of byLine.values()) idx.forEach((i, k) => nextOf.set(i, idx[k + 1]));
  const held = new Map(), free = [], last = new Map(), segs = [], arcs = [], pts = [];
  let y = 18, lanes = 0, day = "";
  const take = () => { free.sort((a, b) => a - b); return free.length ? free.shift() : lanes++; };
  ss.forEach((x, i) => {
    const d = new Date(x.at), dk = d.toDateString();
    if (dk !== day) { day = dk; rows.push({ day: d, y: y + DAY / 2 }); y += DAY; }
    let lane = held.get(x.line);
    const prev = last.get(x.line);
    if (lane === undefined) { lane = take(); if (prev) arcs.push({ from: prev, line: x.line, toY: y + ROW / 2, toLane: lane }); }
    else if (prev) segs.push({ lane, y1: prev.y, y2: y + ROW / 2, line: x.line });
    const p = { i, lane, y: y + ROW / 2, s: x }; pts.push(p); last.set(x.line, p);
    const nx = nextOf.get(i);
    if (nx !== undefined && new Date(ss[nx].at) - new Date(x.end || x.at) < 24 * 3600e3) held.set(x.line, lane);
    else { held.delete(x.line); free.push(lane); }
    y += ROW;
  });
  return { rows, pts, segs, arcs, lanes: Math.max(1, lanes), H: y + 30 };
}
const tlMode = () => store.get("pga_tl_mode") || "lines";
const tlFolded = () => store.get("pga_tl_fold") === "1";
const TLICON = {   // three lanes running into one, and one opening into three
  gather: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 2v3c0 2 5 3 5 5v4M13 2v3c0 2-5 3-5 5M8 2v12"/></svg>`,
  spread: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M8 2v4c0 2-5 3-5 5v3M8 6c0 2 5 3 5 5v3M8 2v12"/></svg>`,
};
/* gathered: every conversation once (its latest stretch), in time order, on one line */
function tlFoldLayout() {
  const T = S.tl || { sessions: [] }, latest = new Map(), rows = [], pts = [], ROW = 48, DAY = 34;
  for (const x of T.sessions || []) { const p = latest.get(x.item); latest.set(x.item, { s: x, n: (p?.n || 0) + 1, turns: (p?.turns || 0) + (x.turns || 0) }); }
  const xs = [...latest.values()].sort((a, b) => (a.s.end || a.s.at).localeCompare(b.s.end || b.s.at));
  let y = 18, day = "";
  for (const v of xs) {
    const d = new Date(v.s.end || v.s.at), dk = d.toDateString();
    if (dk !== day) { day = dk; rows.push({ day: d, y: y + DAY / 2 }); y += DAY; }
    pts.push({ lane: 0, y: y + ROW / 2, s: { ...v.s, at: v.s.end || v.s.at, turns: v.turns }, n: v.n }); y += ROW;
  }
  const segs = pts.length > 1 ? [{ lane: 0, y1: pts[0].y, y2: pts[pts.length - 1].y, line: "__all__" }] : [];
  return { rows, pts, segs, arcs: [], lanes: 1, H: y + 30, folded: true };
}
/* the gathering: every lane slides onto the first one and the joins fade, then the gathered view takes its place
   (spreading out plays it backwards) */
function tlFoldToggle() {
  const svg = $("#tlSvg"), going = !tlFolded(), dx = (el) => -(+el.dataset.lane || 0) * 18;
  const done = () => { store.set("pga_tl_fold", going ? "1" : ""); renderTimeline();
    const s2 = $("#tlSvg"), w = $(".tlwrap"); if (!s2) return;
    if (w) w.scrollTop = S.dir !== "down" ? 0 : w.scrollHeight;          // the two layouts differ in height: back to the latest
    if (going) { s2.classList.add("tlin"); setTimeout(() => s2.classList.remove("tlin"), 500); return; }
    const els = s2.querySelectorAll("[data-lane]"); s2.classList.add("tlspread");
    els.forEach((el) => { el.style.transform = `translateX(${dx(el)}px)`; });
    requestAnimationFrame(() => requestAnimationFrame(() => { els.forEach((el) => { el.style.transform = ""; }); setTimeout(() => s2.classList.remove("tlspread"), 520); })); };
  if (!svg || !going) { done(); return; }
  svg.classList.add("tlgather");
  svg.querySelectorAll("[data-lane]").forEach((el) => { el.style.transform = `translateX(${dx(el)}px)`; });
  setTimeout(done, 460);
}
document.addEventListener("click", (e) => { if (e.target.closest("#tlFold")) { e.preventDefault(); tlFoldToggle(); } });
function renderTimeline() { if (tlMode() === "lines") renderLines(); else renderTimeAxis(); }
const tlHead = () => `<div class="ch"><button class="ghost sm" data-act="search" title="${L("搜索所有对话", "Search everything")} (${MOD} K)">${I.search}</button><span class="seg"><button class="${tlMode() === "lines" ? "on" : ""}" data-tlmode="lines">${L("按线", "Lines")}</button><button class="${tlMode() === "time" ? "on" : ""}" data-tlmode="time">${L("按时间", "Time")}</button></span>${tlMode() === "time" ? `<button class="sm ghost tlfoldb ${tlFolded() ? "on" : ""}" id="tlFold" title="${tlFolded() ? L("展开回一条条线", "Spread back into lines") : L("把所有对话收拢到一条线上，每段对话一个点，快速挑一段", "Gather every conversation onto one line, one point each, to pick one quickly")}" aria-label="${tlFolded() ? L("展开", "Spread") : L("收拢", "Gather")}">${tlFolded() ? TLICON.spread : TLICON.gather}</button>` : ""}<span class="grow"></span>
  <button class="sm ghost" id="tlImport" title="${L("导入别的应用里的对话，并把它们整理到一条条线上", "Bring in conversations from other apps and tidy them into lines")}">${L("导入与整理", "Import & tidy")}</button><button class="sm" id="newChat">${L("＋ 新对话", "+ New chat")}</button>${typeof memoBtns === "function" ? memoBtns() : ""}</div>`;
/* one row per line (one piece of ongoing work), the latest first; the strip under it marks the days it was active */
function renderLines() {
  const box = $("#clist"); if (!box) return;
  const T = S.tl, nArch = (S.allChats || []).filter((c) => c.archived).length + (T?.hidden || []).length;
  if (!T) { box.innerHTML = tlHead() + `<div class="empty">…</div>`; return; }
  const by = new Map();
  for (const x of T.sessions || []) {
    const g = by.get(x.line) || { id: x.line, items: new Set(), agents: new Set(), days: new Set(), first: x.at, last: x.end || x.at, turns: 0 };
    g.items.add(x.item); if (x.agent && x.agent !== "-") g.agents.add(x.kind === "tree" ? L("树", "tree") : x.agent);
    g.days.add(x.at.slice(0, 10)); g.turns += x.turns || 0; if ((x.end || x.at) > g.last) g.last = x.end || x.at; if (x.at < g.first) g.first = x.at;
    by.set(x.line, g);
  }
  const rows = [...by.values()].sort((a, b) => (a.last < b.last ? 1 : -1)), DAYS = 60, today = new Date(); today.setHours(0, 0, 0, 0);
  const col = (line) => { const m = T.lines[line] || {}; return m.kind === "single" ? "var(--dim)" : `hsl(${hueOf(line)} 55% 58%)`; };
  const strip = (g) => { let r = ""; for (const d of g.days) { const k = Math.round((today - new Date(d + "T00:00:00")) / 864e5); if (k >= 0 && k < DAYS) r += `<rect x="${DAYS - 1 - k}" y="0" width="1" height="4"/>`; }
    return `<svg class="strip" viewBox="0 0 ${DAYS} 4" preserveAspectRatio="none" style="fill:${col(g.id)}"><rect class="bg" x="0" y="1.6" width="${DAYS}" height=".8"/>${r}</svg>`; };
  const keep = $(".lrows", box)?.scrollTop, now = Date.now(), W = (g) => (T.lines[g.id] || {}).weight || 0;
  /* drawn like the time view: a dot (bigger = weightier), the title, one quiet line of facts, the strip of active days */
  const row = (g) => { const m = T.lines[g.id] || {}, r = Math.max(3.5, Math.min(8, 3 + W(g) * .9));
    const facts = [m.kind !== "single" ? L(...(LK[m.kind] || LK.single)) : "", L(`${g.items.size} 段`, `${g.items.size} conv.`), g.days.size > 1 ? L(`${g.days.size} 天`, `${g.days.size} days`) : "",
      m.chars ? L(`你写了 ${kfmt(m.chars)} 字`, `you wrote ${kfmt(m.chars)} chars`) : "", [...g.agents].slice(0, 2).join(", "), ago(g.last)].filter(Boolean).join(" · ");
    return `<div class="lrow ${S.tlLine === g.id ? "on" : ""}" data-tline="${esc(g.id)}"><svg class="ldot" width="18" height="18"><circle cx="9" cy="9" r="${r.toFixed(1)}" style="stroke:${col(g.id)}"/></svg>
      <div class="lbody"><div class="lt">${esc(m.title || "")}</div><div class="lm">${esc(facts)}</div>${g.days.size > 1 ? strip(g) : ""}</div></div>`; };
  const pins = T.pinned || [], rest = rows.filter((g) => !pins.includes(g.id)), P = pins.map((id) => rows.find((g) => g.id === id)).filter(Boolean);
  const long = rest.filter((g) => (T.lines[g.id] || {}).kind !== "single" && g.days.size >= 2).sort((a, b) => W(b) - W(a));
  const recent = rest.filter((g) => !long.includes(g) && now - new Date(g.last) < 7 * 864e5);
  const older = rest.filter((g) => !long.includes(g) && !recent.includes(g)).sort((a, b) => W(b) - W(a)), MORE = 6;
  const grp = (title, hint, xs) => (xs.length ? `<div class="lgrp">${title}<span>${hint}</span></div>${xs.map(row).join("")}` : "");
  box.innerHTML = tlHead() + `<div class="lrows">${grp(L("置顶", "Pinned"), "", P)}
    ${grp(L("长期的事", "Long-running"), L("按分量：持续多久、回来几天、你写了多少", "by weight: how long, how many days, how much you wrote"), long)}
    ${grp(L("最近 7 天", "Last 7 days"), "", recent)}
    ${older.length ? `<div class="lgrp">${L("更早的零散对话", "Older one-offs")}<span>${L("按分量", "by weight")}</span></div>${(S.showLoose ? older : older.slice(0, MORE)).map(row).join("")}
      ${older.length > MORE ? `<div class="lgrp fold" id="looseToggle">${S.showLoose ? L("收起", "Show fewer") : L(`还有 ${older.length - MORE} 段 ▾`, `${older.length - MORE} more ▾`)}</div>` : ""}` : ""}</div>
    <div class="tlfoot">${T.pending ? `<span>${L("正在整理…", "Tidying…")}</span>` : T.organized_at ? `<span>${L("上次整理 ", "Tidied ")}${esc(ago(T.organized_at))}</span>` : ""}<span class="dimt">${L(`细条：最近 ${DAYS} 天里活跃的日子`, `Strip: active days in the last ${DAYS}`)}</span>${nArch ? `<a href="#" id="archList">${L(`已归档 ${nArch}`, `${nArch} archived`)}</a>` : ""}</div>`;
  if (keep != null) $(".lrows", box).scrollTop = keep;
}
function renderTimeAxis() {
  const box = $("#clist"); if (!box) return;
  const T = S.tl, nArch = (S.allChats || []).filter((c) => c.archived).length + (T?.hidden || []).length;
  const head = tlHead();
  if (!T) { box.innerHTML = head + `<div class="empty">…</div>`; return; }
  if (!(T.sessions || []).length) { box.innerHTML = head + `<div class="empty" style="padding:20px 14px">${L("最近还没有对话。", "No conversations lately.")}</div>`; return; }
  const G = tlFolded() ? tlFoldLayout() : tlLayout(), W = Math.max(320, box.clientWidth || 360), LX = (l) => 22 + l * 18, labelX = LX(Math.min(G.lanes, 12)) + 10;
  const flip = S.dir !== "down", Y = (y) => (flip ? G.H - y : y), maxCh = Math.max(8, Math.floor((W - labelX - 14) / 12.5));
  const sel = S.tlSel, selLine = S.tlLine || (T.sessions.find((x) => x.item === sel) || {}).line, dimOf = (line) => (selLine ? (line === selLine ? "on" : "dim") : "");
  const col = (line) => { if (line === "__all__") return "var(--muted)"; const m = T.lines[line] || {}; return m.kind === "single" ? "var(--dim)" : `hsl(${hueOf(line)} 55% 58%)`; };
  let g = "";
  for (const r of G.rows) g += `<text class="tlday" x="${labelX}" y="${Y(r.y) + 4}">${esc(r.day.toLocaleDateString(EN ? "en-GB" : "zh-CN", { month: "short", day: "numeric", weekday: "short" }))}</text><line class="tlrule" x1="${labelX + 84}" x2="${W - 10}" y1="${Y(r.y)}" y2="${Y(r.y)}"/>`;
  let hits = "";                                                   // wide invisible strokes: a click on a line picks the line
  for (const sg of G.segs) { const at = `x1="${LX(sg.lane)}" x2="${LX(sg.lane)}" y1="${Y(sg.y1)}" y2="${Y(sg.y2)}"`;
    g += `<line class="tlseg ${G.folded ? "all" : dimOf(sg.line)}" data-lane="${sg.lane}" ${at} style="stroke:${col(sg.line)}"/>`;
    if (!G.folded) hits += `<line class="tlhit" data-tline="${esc(sg.line)}" ${at}><title>${esc(T.lines[sg.line]?.title || "")}</title></line>`; }
  for (const a of G.arcs) { const x1 = LX(a.from.lane), y1 = Y(a.from.y), x2 = LX(a.toLane), y2 = Y(a.toY), dy = (y2 - y1) * .5;
    const d = `M ${x1} ${y1} C ${x1 + 18} ${y1 + dy * .25}, ${x2 + 18} ${y2 - dy * .25}, ${x2} ${y2}`;
    g += `<path class="tlarc ${dimOf(a.line)}" data-lane="${a.toLane}" d="${d}" style="stroke:${col(a.line)}"/>`;
    hits += `<path class="tlhit" data-tline="${esc(a.line)}" d="${d}"><title>${esc(L("接着之前的对话：", "Picks up: ") + (T.lines[a.line]?.title || ""))}</title></path>`; }
  g += hits;
  for (const p of G.pts) {
    const x = p.s, r = Math.max(3.5, Math.min(7.5, 3 + Math.sqrt(x.turns || 1) * .7)), on = x.item === sel, line = T.lines[x.line] || {};
    const t = x.title || L("（没有标题）", "(untitled)"), short = t.length > maxCh ? t.slice(0, maxCh - 1) + "…" : t;
    const when2 = new Date(x.at).toLocaleTimeString(EN ? "en-GB" : "zh-CN", { hour: "2-digit", minute: "2-digit" });
    const meta = [when2, x.kind === "tree" ? L("树", "tree") : x.agent && x.agent !== "-" ? x.agent : "", line.kind !== "single" ? "· " + line.title : "", x.turns > 1 ? L(`${x.turns} 轮`, `${x.turns} turns`) : "",
      p.n > 1 ? L(`${p.n} 段`, `${p.n} stretches`) : ""].filter(Boolean).join(" ");
    g += `<g class="tlpt ${x.kind} ${on ? "on" : ""} ${selLine && x.line !== selLine && !G.folded ? "dim" : ""}" data-ts="${esc(x.id)}"><circle data-lane="${p.lane}" cx="${LX(p.lane)}" cy="${Y(p.y)}" r="${r.toFixed(1)}" style="${line.kind !== "single" ? `stroke:${col(x.line)}` : ""}"/>
      <text x="${labelX}" y="${Y(p.y) - 1}">${esc(short)}<tspan class="tm" x="${labelX}" dy="14">${esc(meta.length > maxCh * 1.4 ? meta.slice(0, Math.floor(maxCh * 1.4)) + "…" : meta)}</tspan></text></g>`;
  }
  const keep = $(".tlwrap", box)?.scrollTop;
  box.innerHTML = head + `<div class="tlwrap"><svg id="tlSvg" width="${W}" height="${G.H}" viewBox="0 0 ${W} ${G.H}">${g}</svg></div>`
    + `<div class="tlfoot">${T.pending ? `<span>${L("正在整理…", "Tidying…")}</span>` : T.organized_at ? `<span>${L("上次整理 ", "Tidied ")}${esc(ago(T.organized_at))}</span>` : ""}${nArch ? `<a href="#" id="archList">${L(`已归档 ${nArch}`, `${nArch} archived`)}</a>` : ""}</div>`;
  const w = $(".tlwrap", box);
  if (!S.tlScrolled) { S.tlScrolled = true; if (w) w.scrollTop = flip ? 0 : w.scrollHeight; } else if (w && keep != null) w.scrollTop = keep;
}
const tlSess = (id) => (S.tl?.sessions || []).find((x) => x.id === id);
function openSession(id) {
  const x = tlSess(id); if (!x) return;
  S.tlSel = x.item; S.tlLine = x.line; S.lineOpen = false; loadLine(x.line);
  const many = new Set((S.tl?.sessions || []).filter((y) => y.line === x.line).map((y) => y.item)).size > 1;
  if (many) { S.lineView = x.line; S.focusItem = x.item; S.focusDone = false; S.chat = null; S.imp = null; S.treeItem = null; renderTimeline(); renderChat(); return; }
  S.lineView = null;
  if (x.kind === "tree") { S.chat = null; S.imp = null; S.treeItem = x; renderTimeline(); renderChat(); return; }
  S.treeItem = null;
  if (x.kind === "chat") { S.imp = null; S.chat = x.item; history.replaceState(null, "", qs()); renderTimeline(); renderChat(); loadChat(S.chat); return; }
  S.chat = null; S.imp = { cid: x.ref.conversation, key: x.item, line: x.line }; renderTimeline(); renderChat(); loadImported(x.ref.conversation);
}
/* a click on a line: the line and all its points light up; the card shows the whole line, its latest conversation below */
function pickLine(id) {
  const xs = (S.tl?.sessions || []).filter((x) => x.line === id); if (!xs.length) return;
  openSession(xs[xs.length - 1].id);
  if (S.lineView === id) S.focusItem = "__end__";              // a whole line opens at its latest words
}
/* a whole line as one dialogue: its conversations in time order, a divider before each (which app, which day) */
S.impCache = {}; S.nodeNotes = {};
function itemNotes(x) {
  if (x.kind === "chat") { const t = S.chatTurns[x.key]; return t && t.flatMap((u) => u.role === "user" ? [{ agent: "you", kind: "question", text: u.text, at: u.at, data: {} }]
    : [{ agent: u.agent && u.agent !== "-" ? u.agent : "AI", kind: "answer", text: u.text || (u.error ? "⚠ " + u.error : ""), at: u.at, data: {} }]); }
  if (x.kind === "import") { const d = S.impCache[x.ref.conversation]; return d && [{ kind: "conversation", agent: d.agent, text: `${d.title}\n${d.excerpt}`, at: d.started_at || d.updated_at, data: { messages: d.messages, project: d.project } }]; }
  const d = S.nodeNotes[x.ref.node]; return d && (d.notes || []).slice(-30);
}
function loadLineItems(d) {
  const todo = d.items.filter((x) => itemNotes(x) == null && !x._loading); let i = 0;
  const next = async () => { const x = todo[i++]; if (!x) return; x._loading = true;
    try {
      if (x.kind === "chat") S.chatTurns[x.key] = (await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(x.key)}`)).turns;
      else if (x.kind === "import") S.impCache[x.ref.conversation] = await api(`/v1/users/${S.uid}/imported/${x.ref.conversation}`);
      else S.nodeNotes[x.ref.node] = await api(`/v1/thought-nodes/${x.ref.node}?full=true`);
    } catch { if (x.kind === "chat") S.chatTurns[x.key] = []; else if (x.kind === "import") S.impCache[x.ref.conversation] = { title: x.title, excerpt: "", agent: x.agent }; else S.nodeNotes[x.ref.node] = { notes: [] }; }
    if (S.lineView === d.line) renderLineDialog(); return next(); };
  for (let k = 0; k < 4; k++) next();
}
/* a whole line as ONE dialogue, every message in time order whichever conversation it came from; a slim label marks
   where the speaker's conversation changes. Imported conversations only keep excerpts: their opening turns sit at the
   time they started, the closing ones at their last update. Click a label (or a message) to carry on that conversation. */
function lineEntries(d) {
  const out = [];
  d.items.forEach((x, n) => {
    if (x.kind === "chat") (S.chatTurns[x.key] || []).forEach((t, i) => out.push({ at: t.at || x.first, x, n, i, turn: t }));
    else if (x.kind === "import") {
      const c = S.impCache[x.ref.conversation]; if (!c) return;
      if ((c.turns || []).length) {               // read in full: every turn at its own time
        c.turns.filter((t) => t.role !== "aside").forEach((t, i) => out.push({ at: t.at || c.started_at || x.first, x, n, i, conv: { who: t.role === "user" ? "user" : "agent", text: t.text }, agent: c.agent }));
        return;
      }
      let late = false;
      PGATree.convTurns(c.excerpt || "").forEach((t, i) => { if (t.gap) { late = true; out.push({ at: c.updated_at || x.last, x, n, i, gap: t.gap }); return; }
        out.push({ at: late ? c.updated_at || x.last : c.started_at || x.first, x, n, i, conv: t, agent: c.agent }); });
    } else ((S.nodeNotes[x.ref.node] || {}).notes || []).slice(-30).forEach((m, i) => out.push({ at: m.at || x.first, x, n, i, note: m }));
  });
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.n - b.n || a.i - b.i));
}
function renderLineDialog() {
  const id = S.lineView, d = S.lineD?.[id], m = S.tl?.lines?.[id] || {};
  $("#chead").innerHTML = `<span class="kind">${L(...(LK[m.kind] || LK.single))}</span><h1>${esc(m.title || d?.title || "")}</h1>${d ? `<span class="pill">${L(`${d.items.length} 段对话 · 按时间排`, `${d.items.length} conversations · by time`)}</span>` : ""}` + headActs();
  if (!d) { $("#cdlgIn").innerHTML = `<div class="empty">…</div>`; $("#ccomp").innerHTML = ""; return; }
  loadLineItems(d);
  const wrap = $("#cdlg"), keep = wrap.dataset.line === id ? wrap.scrollTop : null, loading = d.items.filter((x) => itemNotes(x) == null).length;
  if (!S.lineTarget || !d.items.some((x) => x.key === S.lineTarget)) S.lineTarget = d.items[d.items.length - 1].key;
  const es = lineEntries(d);
  let html = "", prev = null, buf = [];
  const flush = () => { if (!buf.length) return; const x = buf[0].x;
    if (x.kind === "chat") html += chatTurnsHtml(buf.map((e) => e.turn), x.key);
    else if (x.kind === "import") {             // one stretch at a time, so a time shows only where there was a pause
      let run = [];
      const put = () => { if (run.length) html += `<div style="display:contents" data-file-key="${esc(x.key)}">${PGATree.chat(run, { md, name: (m) => m.agent })}</div>`; run = []; };
      for (const e of buf) {
        if (e.gap) { put(); html += `<div class="ctime">${esc(e.gap)}</div>`; continue; }
        run.push(e.conv.who === "user" ? { agent: "you", kind: "question", text: e.conv.text, at: e.at, data: {} } : { agent: e.agent || "AI", kind: "answer", text: e.conv.text, at: e.at, data: {} });
      }
      put();
    }
    else html += PGATree.chat(buf.map((e) => e.note), { md });
    buf = []; };
  for (const e of es) {
    if (!prev || prev.x.key !== e.x.key || new Date(e.at) - new Date(prev.at) > 6 * 3600e3) {
      flush();
      const x = e.x, app = x.kind === "tree" ? L("树上的分支", "tree branch") : x.kind === "chat" ? "PGA" : x.agent, on = x.key === S.lineTarget;
      html += `<div class="lseg ${on ? "on" : ""}" data-ltarget="${esc(x.key)}" title="${L("点一下：接着这段对话说", "Click: carry on this conversation")}"><i style="background:hsl(${hueOf(x.key)} 55% 58%)"></i><b>${esc(x.title.slice(0, 60))}</b><span>${esc(app)} · ${esc(when(e.at))}</span><em>${on ? L("正在接着这段", "carrying on this one") : L("接着这段说", "carry on this one")}</em></div>`;
    }
    buf.push(e); prev = e;
  }
  flush();
  $("#cdlgIn").innerHTML = lineCard(true) + (loading ? `<div class="trnote">${L(`还在载入 ${loading} 段对话…`, `Loading ${loading} more conversations…`)}</div>` : "") + html + (S.sending ? workCard() : "");
  wrap.dataset.line = id;
  if (!S.focusDone && !loading) { S.focusDone = true; const el = S.focusItem && S.focusItem !== "__end__" ? document.querySelector(`.lseg[data-ltarget="${CSS.escape(S.focusItem)}"]:last-of-type`) : null;
    requestAnimationFrame(() => wrap.scrollTo({ top: el ? el.getBoundingClientRect().top - wrap.getBoundingClientRect().top + wrap.scrollTop - 8 : wrap.scrollHeight })); }
  else if (S.scrollChat) { S.scrollChat = false; requestAnimationFrame(() => { wrap.scrollTop = wrap.scrollHeight; }); }
  else if (keep != null) wrap.scrollTop = keep;
  const tg = d.items.find((x) => x.key === S.lineTarget), box = $("#chatText"); if (box) S.chatDraft = box.value;
  if (tg.kind === "tree") { $("#ccomp").innerHTML = `<div class="inner" style="text-align:center"><button class="primary" data-opentree="${esc(tg.ref.tree)}" data-node="${esc(tg.ref.node)}">${L(`到树上接着「${esc(tg.title.slice(0, 16))}」说`, `Carry on “${esc(tg.title.slice(0, 20))}” on the tree`)}</button></div>`; return; }
  $("#ccomp").innerHTML = `<div class="inner">${envBar(tg.kind === "chat" ? tg.key : "", tg.kind === "chat" ? S.chatTurns[tg.key] || [] : [])}
    <div class="ltgt"><i style="background:hsl(${hueOf(tg.key)} 55% 58%)"></i>${L("接着：", "Carrying on: ")}<b>${esc(tg.title.slice(0, 40))}</b><span>${L("（点上面任意一段的标签可以换）", "(click any label above to switch)")}</span></div>
    ${followupHtml()}${attsHtml()}<div class="cbar">${composeTools()}<textarea id="chatText" rows="1" placeholder="${esc(L("你的回应、下一步计划，或者接着问…（Enter 发送，Shift+Enter 换行）", "Your response, next step, or a question… (Enter sends, Shift+Enter for a new line)"))}">${esc(S.chatDraft || "")}</textarea>
      ${accBtn(tg.kind === "chat" ? tg.key : "")}<select id="chatAgent"><option value="auto">${L("自动", "Auto")}</option>${S.agents.map((a) => `<option value="${esc(a.name)}" ${a.name === S.chatAgent ? "selected" : ""}>${esc(agentLabel(a.name))}</option>`).join("")}</select>${effortSel(tg.kind === "chat" ? tg.key : "")}${branchCountTool()}${typeof knowledgeTool === "function" ? knowledgeTool() : ""}
      <button class="ghost" id="lineNote" ${S.sending ? "disabled" : ""} title="${L("只记下来，不问 agent：之后接着聊时 agent 会读到", "Just write it down, no agent: agents read it when the conversation goes on")}">${L("只记下来", "Just note")}</button>
      <button class="primary" id="lineSend">${S.sending || S.regenBusy ? L("追加", "Queue") : L("发送", "Send")}</button></div></div>`;
  autoGrow($("#chatText")); compactComposer();
}
async function lineSend(noteOnly) {
  if (!noteOnly && (S.sending || S.regenBusy)) return queueFollowup();
  if (composerBusy()) return;
  const d = S.lineD?.[S.lineView]; if (!d) return;
  const tg = d.items.find((x) => x.key === S.lineTarget) || d.items[d.items.length - 1], text = ($("#chatText")?.value || "").trim();
  if (!text) { toast(L("先写点什么", "Write something first")); return; }
  const line = S.lineView;
  if (noteOnly) {                                             // your own words, kept in that conversation; no agent
    const key = tg.kind === "chat" ? tg.key : null;
    try { const r = await api(`/v1/users/${S.uid}/chats/note`, { body: { conversation: key, text, line } }); S.chatDraft = ""; $("#chatText").value = ""; S.lineTarget = r.key;
      toast(L("记下了：之后接着这段聊时，agent 会读到", "Noted: agents read it when this goes on")); } catch (err) { toast(err.message); return; }
  } else if (tg.kind === "chat") { S.chat = tg.key; await chatSend(); }
  else if (tg.kind === "import") { S.impData = S.impCache[tg.ref.conversation] || await api(`/v1/users/${S.uid}/imported/${tg.ref.conversation}`); S.imp = { cid: tg.ref.conversation, key: tg.key, line }; S.lineView = null; await impSend(); S.lineTarget = S.chat; }
  S.lineView = line; S.chat = null; S.imp = null; S.scrollChat = true; await loadTimeline(); await loadLine(line); renderChat();
}
async function loadLine(id) {
  if (!id) return;
  try { S.lineD = { ...(S.lineD || {}), [id]: await api(`/v1/users/${S.uid}/timeline/line?id=${encodeURIComponent(id)}`) }; } catch { return; }
  if (S.tlLine === id && S.view === "chats") renderChat();
}
const LK = { tree: ["树", "Tree"], project: ["项目", "Project"], topic: ["话题", "Topic"], single: ["一段对话", "One conversation"] };
/* the whole line on top of the dialogue: what it was about (your conversation tree's summaries), its conversations, pull it out */
function lineCard(compact) {
  const id = S.tlLine, d = S.lineD?.[id]; if (!id || !d) return "";
  const many = d.items.length > 1 && !compact, aim = id.startsWith("aim:") ? id.slice(4) : id === "you" ? "you" : d.extracted;
  const span = d.first ? `${when(d.first)}${d.last && d.last.slice(0, 10) !== d.first.slice(0, 10) ? " – " + when(d.last) : ""}` : "";
  const sum = d.summary || (!many && d.items[0]?.summary) || "";
  return `<details class="lcard" ${S.lineOpen ? "open" : ""}><summary><span class="kind">${L(...(LK[d.kind] || LK.single))}</span><b>${esc(d.title)}</b><span class="dimt num">${esc(span)} · ${L(`${d.items.length} 段对话`, `${d.items.length} conversations`)}</span></summary>
    <div class="lsum">${sum ? PGATree.summary(sum) : `<span class="dimt">${L("还没有整条线的概括。", "No summary of the whole line yet.")}</span>`}</div>
    ${(d.steps || []).length ? `<div class="label" style="margin-top:12px">${L("一步一步", "Step by step")}${d.steps_at ? ` · ${esc(ago(d.steps_at))}` : ""}</div><ol class="steps">${d.steps.map((x) => `<li><b>${esc(x.title)}</b>${x.summary ? `<div class="ss">${esc(x.summary)}</div>` : ""}${(x.children || []).length ? `<ul>${x.children.map((c) => `<li><b>${esc(c.title)}</b>${c.summary ? ` · ${esc(c.summary)}` : ""}</li>`).join("")}</ul>` : ""}</li>`).join("")}</ol>` : ""}
    ${many ? `<div class="litems">${d.items.map((x, i) => `<div class="li ${x.key === S.tlSel ? "on" : ""}" data-litem="${esc(x.key)}"><span class="dimt num">${esc(when(x.first))}</span><span class="lt">${esc(x.title)}</span>${x.summary && x.summary !== d.items[i - 1]?.summary ? `<span class="ls">${esc(x.summary.replace(/\n+/g, " · ").slice(0, 140))}</span>` : ""}</div>`).join("")}</div>` : ""}
    <div class="lact"><button class="sm" id="lineSteps">${(d.steps || []).length ? L("重新压缩成步骤", "Redo the steps") : L("压缩成步骤", "Compress into steps")}</button>${many || !d.summary ? `<button class="sm" id="lineSum">${d.summary ? L("重新概括", "Summarize again") : L("概括这条线", "Summarize this line")}</button>` : ""}
      ${aim ? `<button class="sm primary" data-opentree="${esc(aim)}" data-node="${esc(S.treeItem?.ref?.node || "")}">${L("打开这棵树", "Open the tree")}</button>`
        : `<button class="sm primary" id="lineOut" title="${L("把这条线变成一棵自己的树：每段对话一个节点，按时间连起来；之后可以在树上分支、沉淀", "Turn this line into a tree of its own: one node per conversation, chained in time; then branch and distill on it")}">${L("抽离成一棵树", "Pull out as a tree")}</button>`}
      <span class="grow"></span>${compact ? "" : `<a href="#" id="lineClear" class="dimt" style="font-size:12px">${L("取消高亮", "Clear highlight")}</a>`}</div></details>`;
}
async function loadImported(cid) {
  try { S.impData = await api(`/v1/users/${S.uid}/imported/${cid}`); } catch (e) { S.impData = { error: e.message }; }
  if (S.imp?.cid === cid) renderChat();
}
function openTlCtx(x0, y0, id) {
  closeCtx(); const x = tlSess(id); if (!x) return;
  const line = S.tl.lines[x.line] || {}, m = document.createElement("div"); m.className = "ctx";
  m.innerHTML = `<div class="ch">${esc(x.title)}</div><button data-tx="open">${x.kind === "tree" ? L("打开这棵树", "Open the tree") : L("打开", "Open")}</button>
    ${x.kind !== "tree" ? `<hr><button data-tx="join">${L("接到另一条线上…", "Join another line…")}</button>${x.line !== x.item ? `<button data-tx="alone">${L("单独成一条线", "Put it on a line of its own")}</button>` : ""}` : ""}
    ${line.kind === "topic" || line.kind === "project" ? `<button data-tx="rename">${L(`重命名这条线「${esc(line.title.slice(0, 12))}」…`, `Rename the line “${esc(line.title.slice(0, 14))}”…`)}</button>` : ""}
    ${x.kind !== "tree" ? `<hr><button data-tx="hide">${x.kind === "chat" ? L("归档", "Archive") : L("从时间树里隐藏", "Hide from the time tree")}</button>` : ""}`;
  m.dataset.ts = id; document.body.appendChild(m);
  const r = m.getBoundingClientRect(); m.style.left = Math.min(x0, innerWidth - r.width - 8) + "px"; m.style.top = Math.min(y0, innerHeight - r.height - 8) + "px";
}
async function tlDo(op, id) {
  closeCtx(); const x = tlSess(id); if (!x) return;
  try {
    if (op === "open") { openSession(id); return; }
    if (op === "alone") { await api(`/v1/users/${S.uid}/timeline/items`, { method: "PUT", body: { key: x.item, line: x.item } }); }
    if (op === "rename") { const t = prompt(L("这条线叫什么？", "Name this line"), S.tl.lines[x.line]?.title || ""); if (!t) return; await api(`/v1/users/${S.uid}/timeline/lines`, { method: "PUT", body: { line: x.line, title: t } }); }
    if (op === "hide") { await api(`/v1/users/${S.uid}/chats/archive`, { body: { key: x.item, archived: true } }); toast(L("已收起：在左下角「已归档」里能找回", "Put away: find it under “archived” at the bottom")); await loadChats(); }
    if (op === "join") {
      const lines = Object.values(S.tl.lines).filter((l) => l.kind !== "single" && l.id !== x.line);
      const trees = (S.forest?.trees || []).filter((t) => !lines.some((l) => l.id === `aim:${t.id}`)).map((t) => ({ id: `aim:${t.id}`, title: t.text }));
      modal(`<h2>${L("接到哪条线上？", "Join which line?")}</h2><div class="muted" style="margin-bottom:12px">${esc(x.title)}</div>
        <select id="joinTo" style="width:100%;height:34px"><option value="">${L("选一条线…", "Pick a line…")}</option>${[...lines, ...trees].map((l) => `<option value="${esc(l.id)}">${esc(l.title.slice(0, 50))}</option>`).join("")}</select>
        <div class="form" style="border:0;background:none;padding:0"><div class="row"><button class="ghost" data-closemodal="1">${L("取消", "Cancel")}</button><button class="primary" id="joinGo" data-key="${esc(x.item)}">${L("接上", "Join")}</button></div></div>`);
      return;
    }
    await loadTimeline();
  } catch (err) { toast(err.message); }
}
function moveDialog(key, line) {
  const items = key ? [key] : [...new Set((S.tl?.sessions || []).filter((x) => x.line === line).map((x) => x.item))];
  const lines = Object.values(S.tl?.lines || {}).filter((l) => l.kind !== "single" && l.id !== line);
  const trees = (S.forest?.trees || []).filter((t) => !lines.some((l) => l.id === `aim:${t.id}`)).map((t) => ({ id: `aim:${t.id}`, title: t.text }));
  modal(`<h2>${key ? L("把这段对话放到哪条线上？", "Put this conversation on which line?") : L(`把这条线的 ${items.length} 段对话并到哪条线上？`, `Merge this line's ${items.length} conversations into which line?`)}</h2>
    <select id="joinTo" style="width:100%;height:34px;margin:10px 0"><option value="">${L("选一条线…", "Pick a line…")}</option>${[...lines, ...trees].map((l) => `<option value="${esc(l.id)}">${esc(l.title.slice(0, 50))}</option>`).join("")}</select>
    <div class="form" style="border:0;background:none;padding:0"><div class="row"><button class="ghost" data-closemodal="1">${L("取消", "Cancel")}</button><button class="primary" id="moveGo" data-keys="${esc(items.join("\n"))}">${L("放过去", "Move")}</button></div></div>`);
}
async function archiveHere(key, line) {
  const items = key ? [key] : [...new Set((S.tl?.sessions || []).filter((x) => x.line === line).map((x) => x.item))].filter((k) => !k.startsWith("n:"));
  if (!items.length) { toast(L("树上的对话不能归档，到树上去隐藏", "Conversations on a tree are hidden on the tree")); return; }
  if (items.length > 1 && !confirm(L(`归档这条线的 ${items.length} 段对话？在「已归档」里能找回。`, `Archive this line's ${items.length} conversations? You can bring them back from “archived”.`))) return;
  for (const k of items) await api(`/v1/users/${S.uid}/chats/archive`, { body: { key: k, archived: true } }).catch(() => {});
  toast(L("已归档", "Archived")); S.chat = null; S.imp = null; S.lineView = null; S.tlLine = null; S.tlSel = null;
  await loadChats(); await loadTimeline(); renderChat();
}
async function showImport() {
  const h = await api(`/v1/users/${S.uid}/hub`).catch(() => ({ agents: [] }));
  const T = S.tl || {};
  modal(`<h2>${L("导入与整理", "Import and tidy")}</h2>
    <div class="muted" style="margin-bottom:14px">${L("PGA 只读你本机上其他 AI 应用留下的对话记录（Claude Code、Codex、WorkBuddy、Hermes…），不改动它们。网页版 ChatGPT、Claude 的对话可以在「Agent 与连接」里上传导出文件。", "PGA only reads the conversation records other AI apps keep on this machine (Claude Code, Codex, WorkBuddy, Hermes…) and never changes them. ChatGPT and Claude web conversations can be uploaded as export files under “Agents and connections”.")}</div>
    <div class="label">${L("来源", "Sources")}</div>
    ${(h.agents || []).map((a) => `<div class="dim" style="grid-template-columns:150px 1fr 110px;cursor:default"><span class="k">${esc(a.name)}</span><span class="v">${L(`${a.conversation_count} 段对话 · ${a.message_count} 条消息`, `${a.conversation_count} conversations · ${a.message_count} messages`)}${a.last_activity_at ? L(" · 最近 ", " · latest ") + esc(ago(a.last_activity_at)) : ""}</span><span class="dimt" style="font-size:12px;text-align:right">${a.last_synced_at ? L("同步于 ", "synced ") + esc(ago(a.last_synced_at)) : L("还没同步", "not synced")}</span></div>`).join("") || `<div class="dimt">${L("还没有连接任何应用。", "No apps linked yet.")}</div>`}
    <div style="display:flex;gap:8px;margin:12px 0 22px"><button id="hubSync">${L("现在同步本机的对话", "Sync this machine's conversations now")}</button><a href="/agents${asq}"><button class="ghost">${L("上传导出文件 →", "Upload an export →")}</button></a></div>
    <div class="label">${L("整理", "Tidy")}</div>
    <div style="font-size:13.5px;line-height:1.75;margin:6px 0 10px">${L("把零散的对话整理到一条条线上：在同一个项目文件夹里的会话自动接到那个项目（和用这个文件夹的抱负）；标题相同的先合成一条；剩下的交给模型读标题和开头，判断哪些是在接着之前的工作，哪些属于同一个话题。拿不准的不动。整理的结果随时可以在时间树上右键改。", "Gathers loose conversations onto lines: sessions held in one project folder join that project (and the motivation using that folder); identical titles join at once; a model reads the rest (titles and openings) and decides which continue earlier work and which share a topic. Anything unclear is left alone. Right-click on the time tree to change any of it.")}</div>
    <div class="dimt" style="font-size:12.5px;margin-bottom:12px">${T.pending ? L("正在整理…", "Tidying…") : T.organized_at ? L("上次整理：", "Last tidied: ") + esc(ago(T.organized_at)) : L("还没整理过。", "Not tidied yet.")}</div>
    <div class="form" style="border:0;background:none;padding:0"><div class="row"><button class="ghost" data-closemodal="1">${L("关闭", "Close")}</button><button class="primary" id="tidyGo">${L("开始整理", "Tidy now")}</button></div></div>`);
}
function showArchived() {
  const xs = (S.allChats || []).filter((c) => c.archived), hid = S.tl?.hidden || [];
  modal(`<h2>${L("已归档", "Archived")}</h2>${xs.map((c) => `<div class="item"><div class="x">${esc(c.title || "")}<div class="s">${esc(ago(c.last_at))}</div></div><button class="sm" data-arch="${esc(c.key)}" data-to="0">${L("放回", "Restore")}</button></div>`).join("")}
    ${hid.length ? `<div class="item"><div class="x">${L(`${hid.length} 段从时间树里隐藏的导入对话`, `${hid.length} imported conversations hidden from the time tree`)}</div><button class="sm" id="unhideAll">${L("全部放回", "Restore all")}</button></div>` : ""}
    ${xs.length || hid.length ? "" : `<div class="dimt">${L("没有。", "Nothing.")}</div>`}`);
}
function renderImported() {
  const d = S.impData && S.impData.id === S.imp.cid ? S.impData : null, line = S.tl?.lines?.[S.imp.line];
  $("#chead").innerHTML = `<span class="kind">${L("导入的对话", "Imported")}</span><h1>${esc(d?.title || "…")}</h1>${line && line.kind !== "single" ? `<span class="pill">${esc(line.title.slice(0, 24))}</span>` : ""}` + headActs();
  $("#cdlgIn").innerHTML = lineCard() + (!d ? `<div class="empty">…</div>` : d.error ? `<div class="empty">${esc(d.error)}</div>`
    : `<div class="trnote">${esc([d.agent, d.model, d.project, d.started_at && when(d.started_at), d.updated_at && d.updated_at !== d.started_at && "→ " + when(d.updated_at)].filter(Boolean).join(" · "))}${(d.turns || []).length
        ? L(` · 共 ${d.messages} 条消息，从 ${esc(d.agent)} 的记录里完整读出`, ` · ${d.messages} messages, read in full from ${esc(d.agent)}'s own history`)
        : L(` · 共 ${d.messages} 条消息，PGA 保留了开头和结尾的摘录`, ` · ${d.messages} messages; PGA keeps excerpts from the start and the end`)}</div>`
      + ((d.turns || []).length ? impTurnsHtml(d)
        : PGATree.chat([{ kind: "conversation", agent: d.agent, text: `${d.title}\n${d.excerpt}`, at: d.started_at || d.updated_at, data: { messages: d.messages, project: d.project } }], { md })
          + `<div class="macts"><button class="txt" data-cbranch="all" data-ckey="imp:${esc(d.id)}" title="${L("带着这段摘录分出一段新对话", "Branch with this excerpt")}">${L("从这里继续", "Carry on here")}</button></div>`));
  const conn = d?.agent_type, guess = CONN[conn] && S.agents.some((a) => a.name === CONN[conn]) ? CONN[conn] : "auto";
  $("#ccomp").innerHTML = `<div class="inner">${followupHtml()}${attsHtml()}<div class="cbar">${composeTools()}<textarea id="chatText" rows="1" placeholder="${L("在 PGA 里接着这段对话说…（Enter 发送，Shift+Enter 换行）", "Carry on this conversation in PGA… (Enter sends, Shift+Enter for a new line)")}"></textarea>
    <select id="chatAgent"><option value="auto">${L("自动", "Auto")}</option>${S.agents.map((a) => `<option value="${esc(a.name)}" ${a.name === guess ? "selected" : ""}>${esc(agentLabel(a.name))}</option>`).join("")}</select>
    ${branchCountTool()}${typeof knowledgeTool === "function" ? knowledgeTool() : ""}<span class="sendg"><button class="ghost polishb" id="polishBtn" title="${L("润色：按你的用户画像改写成几个版本，挑一个再发", "Polish: rewritten a few ways with what PGA knows about you; pick one, then send")}">✨</button><button class="primary" id="impSend" ${S.sending ? "disabled" : ""}>${S.sending ? "…" : L("接着聊", "Carry on")}</button></span></div>
    ${d ? `<label class="impmode"><input type="checkbox" id="impResume" ${impResume(d) ? "checked" : ""}><b>${L(`续上原会话（${d.messages} 条消息）`, `Resume the session (${d.messages} messages)`)}</b>
      <span>${L("勾上：原会话还在就在它原来的文件夹里接着用（有缓存时更省）；不在了先读概括，没有概括读全文，之后一直保持这段会话 · 不勾：只带最后几轮", "On: the session itself, in its own folder, while it is still here (cached when warm); else its summary, or its whole text, read once, then kept going · Off: only the last turns")}</span></label>` : ""}</div>`;
  autoGrow($("#chatText")); compactComposer();
}
/* an imported conversation in full: your turns (with the pictures you sent), its answers, and above each answer how it got
   there — every tool call, its commentary and thinking, screenshots — folded like Claude Code's; time and tokens below */
function impTurnsHtml(d) {
  let out = "", aside = [], k = 0;                  // k: turns so far (yours and its answers): where 从这里继续 branches
  const carry = (n, before) => `<div class="macts${before ? " right" : ""}"><button class="txt" data-cbranch="${n}" data-ckey="imp:${esc(d.id)}" title="${before ? L("从这一问之前分出一段新对话，接着从这里聊", "Branch just before this question and carry on from here") : L("从这个回答之后分出一段新对话", "Branch after this answer")}">${L("从这里继续", "Carry on here")}</button></div>`;
  const src = { session: d.session, kind: d.source || "claude" };
  const flush = () => {
    if (!aside.length) return;
    out += `<details class="proc aside"><summary><span>💭</span>${L(`${esc(d.agent)} 的自言自语 · ${aside.length} 条`, `${esc(d.agent)} thinking aloud · ${aside.length}`)}</summary>
      <div class="asides">${aside.map((t) => `<div class="md">${md(t.text)}</div>`).join("")}</div></details>`;
    aside = [];
  };
  for (const t of d.turns) {
    if (t.role === "aside") { aside.push(t); continue; }
    flush();
    if (!(t.text || "").trim()) continue;            // as the branch counts them (pga.chats.imported_turns)
    k += 1;
    out += t.role === "user" ? PGATree.chat([{ agent: "you", kind: "question", text: t.text, at: t.at, data: {} }], { md }) + (d.session ? thumbs(src, t.images) : "") + (k > 1 ? carry(k - 1, true) : "")
      : (t.how && d.session ? howBlock(t.how, src) : "") + PGATree.chat([{ agent: d.agent, kind: "answer", text: t.text, at: t.at, data: {} }], { md, name: (x) => x.agent })
        + (t.how ? howMeta(t.how) : "") + carry(k);
  }
  flush();
  return `<div style="display:contents" data-file-key="imp:${esc(d.id)}">${out}</div>`;
}
/* carrying on an imported conversation: Codex / Claude Code resume the very session; others get its excerpt as history;
   the new chat goes on the same line, so the time tree draws the path from the old conversation to now */
/* carrying on keeps the old conversation going (its session where it is still here — and its cache — else its summary
   or whole text, read once); off: only its last turns as history */
const impResume = (d) => (S.impResumeOf?.[d.id] ?? true);
async function impSend() {
  if (composerBusy()) return;
  const text = ($("#chatText")?.value || "").trim(); if (!text) { toast(L("先写点什么", "Write something first")); return; }
  const d = S.impData, imp = S.imp; if (!d || !imp) return;
  const capture = typeof knowledgeEnabled === "function" && knowledgeEnabled();
  const agent = $("#chatAgent")?.value || "auto", name = agent !== "auto" ? agent : CONN[d.agent_type];
  let key = null;
  const resume = $("#impResume") ? $("#impResume").checked : impResume(d);
  if (name && resume) { try { key = (await api(`/v1/users/${S.uid}/agents/${encodeURIComponent(name)}/past/${d.id}/continue`, { method: "POST", body: { line: imp.line || "" } })).conversation; } catch {} }
  key = key || `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  await api(`/v1/users/${S.uid}/timeline/items`, { method: "PUT", body: { key, line: imp.line } }).catch(() => {});
  const turns = [];
  for (const line of String(d.excerpt || "").split("\n")) { const m = line.match(/^(User|Assistant)\s*:\s?(.*)$/); if (m) turns.push({ role: m[1] === "User" ? "user" : "agent", text: m[2] }); else if (turns.length) turns[turns.length - 1].text += "\n" + line; }
  if (composerBusy()) return;
  if (capture) knowledgeSet(true, key);
  S.chatTurns[key] = turns.slice(-6); S.chat = key; S.imp = null; S.tlSel = key;
  S.chatAgent = agent !== "auto" ? agent : name || "auto";
  if (d.model && (agent === "auto" || agent === CONN[d.agent_type])) S.chatModel = { ...(S.chatModel || {}), [key]: d.model };   // the model it was imported with
  renderChat(); $("#chatText").value = text; await chatSend(); S.chatTurns[key] = (S.chatTurns[key] || []);
}
function renderChat() {
  const readingBox = $("#cdlg"), readingTop = readingBox?.scrollTop || 0;
  const following = !readingBox || readingBox.scrollHeight - readingTop - readingBox.clientHeight < 80;
  if (S.lineView) { renderLineDialog(); return; }
  if (S.imp) { renderImported(); return; }
  if (S.treeItem) {
    const x = S.treeItem;
    $("#chead").innerHTML = `<span class="kind">${L("树上的对话", "On a tree")}</span><h1>${esc(x.title)}</h1>`;
    $("#cdlgIn").innerHTML = lineCard() + `<div class="chello" style="margin-top:6vh"><div>${L("这段对话长在一棵树上。", "This conversation grew on a tree.")}</div><button class="primary" style="margin-top:12px" data-opentree="${esc(x.ref.tree)}" data-node="${esc(x.ref.node)}">${L("到树上的这个节点", "Go to this node on the tree")}</button></div>`;
    $("#ccomp").innerHTML = ""; return;
  }
  const c = chatOf(S.chat), turns = S.chatTurns[S.chat] || [];
  const cc = (S.allChats || []).find((x) => x.key === S.chat);
  $("#chead").innerHTML = `<span class="kind">${L("日常对话", "Everyday chat")}</span><h1>${esc(cc?.title || S.chatCtx?.[S.chat]?.title || (S.chat ? L("新对话", "New chat") : L("和 agent 随便聊", "Talk to an agent")))}</h1>
`;
  $("#chead").innerHTML += headActs();
  const notes = turns;
  $("#cdlgIn").innerHTML = (S.chat ? lineCard() : "") + branchCtx(S.chat) + (!S.chat && !notes.length ? `<div class="chello"><h2>${L("问点什么", "Ask anything")}</h2><div>${L("一次性的、日常的问题在这里问：不会长成树。哪天它变成了一个长期的方向，再把它种成一棵树。", "Everyday, one-off questions go here and do not grow a tree. If one turns into a long-range direction, plant it as a tree.")}</div></div>`
    : (S.chatSplits?.[S.chat] ? splitHtml(turns) : chatTurnsHtml(turns)) + (S.sending && S.view === "chats" ? workCard() : ""));
  const K = S.forest?.knowledge || [], box = $("#chatText"); if (box) S.chatDraft = box.value;
  $("#ccomp").innerHTML = `<div class="inner">${envBar(S.chat || "", turns)}<div class="refs">${S.chatRefs.map((id) => { const k = K.find((x) => x.id === id); return k ? `<span class="chip on">${esc(k.title.slice(0, 18))}&nbsp;<a href="#" data-chrefdel="${id}" style="color:inherit">×</a></span>` : ""; }).join("")}</div>
    ${followupHtml()}${attsHtml()}<div class="cbar"><select id="chrefAdd" class="kpick" title="${L("引用知识", "Use knowledge")}"><option value="">＋</option>${K.filter((k) => !S.chatRefs.includes(k.id)).map((k) => `<option value="${k.id}">${esc(sysName(k) + " · " + k.title)}</option>`).join("")}</select>
      ${composeTools()}<textarea id="chatText" rows="1" placeholder="${L("写点什么…（Enter 发送，Shift+Enter 换行）", "Write something… (Enter sends, Shift+Enter for a new line)")}">${esc(S.chatDraft || "")}</textarea>
      ${accBtn(S.chat || "")}<select id="chatAgent"><option value="auto">${L("自动", "Auto")}</option>${S.agents.map((a) => `<option value="${esc(a.name)}" ${a.name === S.chatAgent ? "selected" : ""}>${esc(agentLabel(a.name))}</option>`).join("")}</select>${effortSel(S.chat || "")}${branchCountTool()}${typeof knowledgeTool === "function" ? knowledgeTool() : ""}
      <span class="sendg"><button class="ghost polishb" id="polishBtn" title="${L("润色：按你的用户画像改写成几个版本，挑一个再发", "Polish: rewritten a few ways with what PGA knows about you; pick one, then send")}">✨</button><button class="primary" id="chatSend">${S.sending || S.regenBusy ? L("追加", "Queue") : L("发送", "Send")}</button></span></div></div>`;
  autoGrow($("#chatText")); compactComposer();
  const box2 = $("#cdlg"); if (S.scrollChat || (S.sending && following)) { S.scrollChat = false; requestAnimationFrame(() => { box2.scrollTop = box2.scrollHeight; }); } else if (box2) box2.scrollTop = readingTop;
}
/* one turn at a time: the question, the answer (and who gave it, marked when the agent changes), then what you can do
   with the answer: a second opinion from another agent, or a branch from here */
function chatTurnsHtml(turns, key = S.chat) {
  let out = "", prevAgent = null;
  for (let i = 0; i < turns.length; i += 1) {
    const t = turns[i];
    if (t.role === "user") {
      if (t.note) { out += `<div class="mynote"><span>${L("你记下的", "Your note")}</span><div class="md">${md(t.text)}</div></div>`; continue; }
      if (S.editing && S.editing.run === t.run && S.editing.key === key) { out += editBox(t); continue; }
      out += (t.run ? `<a class="tanchor" id="t-${t.run}"></a>` : "") + PGATree.chat([{ agent: "you", kind: "question", text: t.text, at: t.at, data: {} }], { md }) + userActs(t, key, turns[i - 1]?.role === "agent" ? turns[i - 1].run : "");
      continue;
    }
    const who = t.agent && t.agent !== "-" ? agentLabel(t.agent) : "AI";
    if (prevAgent && who !== prevAgent) out += `<div class="swap">${L(`换成 ${esc(who)}：它看得到前面的全部对话`, `Now ${esc(who)}: it sees the whole conversation so far`)}</div>`;
    prevAgent = who;
    if (t.run) out += `<a class="tanchor" id="a-${esc(t.run)}"></a>`;
    out += t.second || (t.run && S.secondBusy === t.run) ? secondPairHtml(t)
      : typeof sideOn === "function" && sideOn(t) ? sideBySide(t)
      : procBlock(t) + PGATree.chat([{ agent: who, kind: "answer", text: t.text || (t.error ? "⚠ " + t.error : ""), at: t.at, data: {} }], { md, name: (x) => x.agent });
    if (!t.run) continue;
    out += replyMeta(t) + replyActs(t, key);
    if (S.regenBusy === t.run) out += workCard();

  }
  return `<div style="display:contents" data-file-key="${esc(key || "")}">${out}</div>`;
}
function secondHtml(first, x) {
  return `<div class="second"><div class="sh"><b>${L("第二意见", "Second opinion")}</b> · ${esc(x.agent)}${x.model ? ` <span class="dimt">${esc(x.model)}</span>` : ""}</div>
    ${x.answer ? `<div class="sx"><div class="label">${L("合起来看", "Taken together")}</div><div class="ct md" data-i18n="1">${md(x.answer)}</div><button type="button" class="trbtn" data-trsrc="${esc(x.answer)}" title="${L("翻译", "Translate")}">译</button></div>` : ""}
    ${(x.agree || []).length ? `<div class="sx"><div class="label">${L("两边都同意", "Both agree")}</div><ul>${x.agree.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>` : ""}
    ${(x.differ || []).length ? `<div class="sx"><div class="label">${L("不一样的地方", "Where they differ")}</div><table><tr><th></th><th>${esc(first)}</th><th>${esc(x.agent)}</th></tr>${x.differ.map((d) => `<tr><td>${esc(d.point)}</td><td>${esc(d.a)}</td><td>${esc(d.b)}</td></tr>`).join("")}</table></div>` : ""}
    <details><summary>${L(`${esc(x.agent)} 的原话`, `${esc(x.agent)}'s own answer`)}</summary><div class="ct md" data-i18n="1">${md(x.text)}</div><button type="button" class="trbtn" data-trsrc="${esc(x.text)}" title="${L("翻译", "Translate")}">译</button></details></div>`;
}
function branchCtx(key) {
  const c = S.chatCtx?.[key]; if (!c?.branch) return "";
  const parent = (S.allChats || []).find((x) => x.key === c.branch.from) || (c.parent_title ? { title: c.parent_title } : null);   // an imported one: its name from the server
  if (c.branch.copy) return `<details class="bctx"><summary>${L(`复制自「${esc(parent?.title || "另一段对话")}」：下面 ${Math.floor(c.context.length / 2)} 轮是原对话的内容，agent 都会读到；你在这里接着聊，原来那段不动`, `A copy of “${esc(parent?.title || "another chat")}”: its ${Math.floor(c.context.length / 2)} turns below, which the agent reads; carry on here, the original stays`)}</summary>
    <div class="bctxbody">${PGATree.chat(c.context.map((t) => ({ agent: t.role === "user" ? "you" : t.agent || "AI", kind: t.role === "user" ? "question" : "answer", text: t.text, at: null, data: {} })), { md, name: (x) => x.agent })}</div></details>`;
  return `<details class="bctx"><summary>${L(`从「${esc(parent?.title || "另一段对话")}」分出来的：前面 ${Math.floor(c.context.length / 2)} 轮是它的（点开看），agent 都会读到`, `Branched from “${esc(parent?.title || "another chat")}”: the ${Math.floor(c.context.length / 2)} turns before are its own (open to read); the agent reads them`)}</summary>
    <div class="bctxbody">${PGATree.chat(c.context.map((t) => ({ agent: t.role === "user" ? "you" : t.agent || "AI", kind: t.role === "user" ? "question" : "answer", text: t.text, at: null, data: {} })), { md, name: (x) => x.agent })}</div></details>`;
}
document.addEventListener('toggle', e => {
  if (!e.target.matches?.('details.bctx') || !e.target.open) return;
  const body = e.target.querySelector('.bctxbody');
  if (body) requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
}, true);
function stageNodeOf() {                            // the stage page this conversation is shown in, when it is in one
  try { const P = window.parent; if (P === window) return null;
    const n = P.ST.nodes.find((w) => w.type === "win" && w.el?.querySelector("iframe")?.contentWindow === window); return n ? { P, n } : null; } catch { return null; }
}
/* 第二意见: a conversation of its own, like 从这里继续 — a branch from just before this question, answered by another agent
   (the server picks the best other one for this kind of question), and on the same topic as this conversation. On the stage it is
   a branch window on the right; elsewhere the page turns to it. */
async function secondOpinion(run, key) { return startSplit(run, key); }
function secondPairHtml(t) {
  const x = t.second;
  const column = (agent, model, text) => `<section class="sbc"><div class="sbh"><b>${esc(agentLabel(agent || "AI"))}</b>${model ? `<span>${esc(model)}</span>` : ""}</div><div class="ct md">${md(text || "")}</div></section>`;
  return `<div class="sbs second-pair" style="--n:2">${column(t.agent, t.model, t.text || t.error)}${x ? column(x.agent, x.model, x.text) : `<section class="sbc" aria-live="polite"><div class="sbh"><b>${L("第二意见", "Second opinion")}</b></div><span class="spin"></span> ${L("另一个 agent 正在回答…", "Another agent is answering…")}</section>`}</div>`;
}
/* translate one piece of output in place: toggles between the original and a cached translation; direction is
   picked from the text itself (has CJK → English, else → Chinese), independent of the page's own language */
async function toggleTranslate(btn) {
  const box = btn.previousElementSibling?.classList?.contains("ct") ? btn.previousElementSibling : btn.closest(".sx, .cb")?.querySelector(".ct");
  if (!box) return;
  if (btn.dataset.state === "tr") { box.innerHTML = btn.dataset.orig; btn.dataset.state = ""; btn.classList.remove("on"); return; }
  if (btn.dataset.trHtml) { btn.dataset.orig = box.innerHTML; box.innerHTML = btn.dataset.trHtml; btn.dataset.state = "tr"; btn.classList.add("on"); return; }
  const src = btn.dataset.trsrc || ""; if (!src.trim()) return;
  btn.disabled = true;
  try {
    const lang = /[㐀-鿿]/.test(src) ? "en" : "zh";
    const r = await api(`/v1/users/${S.uid}/i18n`, { body: { texts: [src], lang } });
    const out = (r.texts || [])[0];
    if (!out) { toast(L("翻译失败", "Translation failed")); return; }
    btn.dataset.orig = box.innerHTML;
    btn.dataset.trHtml = box.classList.contains("md") ? md(out) : esc(out);
    box.innerHTML = btn.dataset.trHtml;
    btn.dataset.state = "tr"; btn.classList.add("on");
  } catch (err) { toast(err.message); }
  finally { btn.disabled = false; }
}
/* on the stage, 从这里继续 grows a branch window to the right of this one, in its tree (the stage makes it); elsewhere the
   page turns to the new branch */
function branchCountTool() {
  return `<select id="branchCount" aria-label="Branch"><option value="">${L('分屏 / 第二意见', 'Split / second opinion')}</option><option value="2">${L('双 Agent 分屏', 'Two agents')}</option></select>`;
}
async function branchCopies() { return startSplit(); }
function stageBranch(from, upto) {
  try { const P = window.parent; if (P === window || typeof P.stBranchAt !== "function") return false;
    const n = P.ST.nodes.find((w) => w.type === "win" && w.el?.querySelector("iframe")?.contentWindow === window); if (!n) return false;
    P.stBranchAt(n, from, upto); return true; } catch { return false; }
}
// Record the successful fork on the source immediately, even when the child opens in another tab.
function chatBranchCreated(from, result, requestedPoint) {
  const child = {key:result.key, upto:String(result.upto ?? requestedPoint), title:result.title};
  S.chatKids ||= {};
  S.chatKids[from] = [...(S.chatKids[from] || []).filter(k => k.key !== child.key), child];
  if ((S.imp ? 'imp:' + S.imp.cid : S.chat) === from) {
    if (typeof convMap === 'function') convMap();
    if (typeof branchTree === 'function') branchTree();
  }
}
window.chatBranchCreated = chatBranchCreated;
async function chatBranch(run, from, tree = true) {
  if (stageBranch(from || S.chat, run)) return;
  const source = from || S.chat;
  const tab = window.open('about:blank', '_blank');
  if (!tab) { toast(L('请允许打开新标签页后重试', 'Allow a new tab and retry')); return; }
  try {
    const r = await api(`/v1/users/${S.uid}/chats/branch`, {body:{from:source,upto:run}});
    chatBranchCreated(source, r, run);
    const url = new URL(location.href); url.searchParams.set('view','chats'); url.searchParams.set('c',r.key);
    for (const p of ['embed','manager','tree','node','imp']) url.searchParams.delete(p);
    tab.location.replace(url.href);
  } catch (err) { tab.close(); toast(err.message); }
}

// Keep actions visible in a single compact row; model selection lives on the rail.
function compactComposer() {
  const bar=document.querySelector('#ccomp .cbar');
  if(!bar || bar.classList.contains('compact-composer'))return;
  const send=bar.querySelector('#chatSend, #lineSend, #impSend');if(!send)return;
  const text=bar.querySelector('textarea'), group=bar.querySelector('.sendg');
  if(group)group.replaceWith(...group.childNodes);
  const panel=document.createElement('div');panel.className='composer-options';
  for(const child of [...bar.children])if(child!==text&&child!==send)panel.append(child);
  bar.classList.add('compact-composer');bar.append(send,panel);
  const agent=panel.querySelector('#chatAgent');if(agent)agent.hidden=true;
  const model=panel.querySelector('#chatModel'), effort=panel.querySelector('#chatEffort'), usage=panel.querySelector('[data-inline-usage]');
  if(usage) {
    const pair=document.createElement('span');pair.className='composer-model-pair';panel.insertBefore(pair,usage);
    if(model)pair.append(model);
    else {const label=document.createElement('span');label.textContent=usage.dataset.model||'';pair.append(label);}
    if(effort)pair.append(effort);
    if(usage.dataset.model){usage.dataset.omitModel='1';const prefix=usage.dataset.model+' · ';if(usage.textContent.startsWith(prefix))usage.textContent=usage.textContent.slice(prefix.length);}
  }
  styleComposerSelects(panel);
}
