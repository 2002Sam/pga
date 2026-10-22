/* PGA app · 世界树, its 层级 mode (pga/worldtree.py): every conversation in one tree of topics, drawn as rings — the world in
   the middle, broad activities around it, topics further out, conversations on the outer ring. Click a conversation and you
   are in it; click a topic to read its summary and its parts, talk to the whole topic, grow it one level down, or point a
   motivation at it. In a conversation, the row above the composer picks the level the agent reads: this conversation, or
   a topic above it (pga.worldtree.context). */
const W = { data: null, nodes: [], byId: new Map(), root: null, collapsed: new Set(), poll: null, hues: new Map(),
  showAgent: (() => { try { return localStorage.getItem("pga_world_agent") === "1"; } catch { return false; } })(),    // a motivation's own thinking: detailed, hard to read at a glance
  showGist: (() => { try { return localStorage.getItem("pga_world_gist") !== "0"; } catch { return true; } })() };
const wShown = (n) => !n.hidden && (n.kind !== "leaf" || W.showAgent || n.who !== "agent");
Object.assign(GT, {
  wroot: { zh: "世界", en: "World", c: () => cssv("--text") }, wtopic: { zh: "主题", en: "Topic", c: () => "#b48cff" },
  wleaf: { zh: "对话", en: "Conversation", c: () => "#8fb4ff" }, waim: { zh: "抱负", en: "Motivation", c: () => cssv("--accent") || "#e2b46a" },
  wplan: { zh: "计划中的方向", en: "Planned direction", c: () => "#f6ad55" },
});
const wtype = (n) => ({ root: "wroot", topic: "wtopic", leaf: "wleaf", aim: "waim", plan: "wplan" })[n.kind] || "wtopic";

async function loadWorld() {
  try { W.data = await api(`/v1/users/${S.uid}/world`); } catch (err) { toast(err.message); return; }
  api(`/v1/users/${S.uid}/facts`).then((f) => { W.facts = f; if (S.view === "graph" && G.mode !== "net") drawWorldBar();
    clearTimeout(W.fpoll); if (f.filling?.state === "running") W.fpoll = setTimeout(() => { if (S.view === "graph") loadWorld(); }, 4000); }).catch(() => {});
  W.nodes = W.data.nodes.map((n) => ({ ...n, label: n.title, type: wtype(n) }));
  W.byId = new Map(W.nodes.map((n) => [n.id, n]));
  if (G.sel && !W.byId.has(G.sel)) G.sel = null;
  layoutWorld(); drawWorldBar(); drawWorldSide(); if (G.mode === "3d") w3Build(); else drawWorld();
  const b = W.data.building;
  clearTimeout(W.poll);
  if (b?.state === "running") W.poll = setTimeout(() => { if (S.view === "graph" && G.mode !== "net") loadWorld(); }, 2500);
}
function layoutWorld() {
  const top = W.nodes.find((n) => n.kind === "root"); W.root = null;
  if (!top) return;
  const kids = (id) => W.nodes.filter((n) => n.parent === id && wShown(n));
  const build = (n) => ({ node: n, children: W.collapsed.has(n.id) ? [] : kids(n.id).sort((a, b) => (a.kind === "leaf") - (b.kind === "leaf")).map(build) });
  const h = d3.hierarchy(build(top), (d) => d.children);
  const leaves = h.leaves().length, R = Math.max(320, leaves * 11 / (2 * Math.PI));
  d3.cluster().size([2 * Math.PI, R]).separation((a, b) => (a.parent === b.parent ? 1 : 2) / Math.max(1, a.depth))(h);
  // topics sit at their own level, not pushed to the rim: radius by depth, leaves on the rim
  const RING = [0, 0.36, 0.6, 0.8, 0.9];
  h.each((d) => { if (d.data.node.kind !== "leaf") d.y = R * (RING[Math.min(d.depth, 4)]); });
  W.R = R;
  W.hues = new Map(); (h.children || []).forEach((c, i, xs) => W.hues.set(c.data.node.id, Math.round((i / xs.length) * 300 + 20)));
  h.each((d) => { const n = d.data.node; n.angle = d.x; n.radius = d.y; n.x = Math.cos(d.x - Math.PI / 2) * d.y; n.y = Math.sin(d.x - Math.PI / 2) * d.y;
    n.hue = d.depth === 0 ? null : W.hues.get(d.ancestors().reverse()[1]?.data.node.id); n.hidden = W.collapsed.has(n.id) ? kids(n.id).length : 0; });
  W.root = h;
  if (!W.fitted && G.zoom) {                                  // the whole tree in view the first time
    W.fitted = true; const cv = $("#gcv"), k = Math.min(cv.clientWidth, cv.clientHeight) / (2 * R + 260);
    d3.select(cv).call(G.zoom.transform, d3.zoomIdentity.translate(cv.clientWidth / 2 + 120, cv.clientHeight / 2 + 20).scale(k));
  }
}
const wR = (n) => (n.kind === "root" ? 16 : n.kind === "leaf" ? 2.6 + Math.min(3, (n.turns || 1) / 30) : n.kind === "aim" ? 8 : 9 - Math.min(4, n.radius / 160) + Math.min(4, (n.count || 0) / 25));
function wColor(n, a = 1) {
  if (n.kind === "root") return cssv("--text");
  if (n.kind === "aim") return cssv("--accent") || "#e2b46a";
  if (n.kind === "plan") return "#f6ad55";
  return n.hue == null ? "#8fb4ff" : `hsla(${n.hue}, ${n.kind === "leaf" ? 55 : 65}%, ${n.kind === "leaf" ? 66 : 62}%, ${a})`;
}
function worldPick(px, py) {
  if (!G.t || !W.root) return null;
  const [x, y] = G.t.invert([px, py]); let best = null, bd = Infinity;
  W.root.each((d) => { const n = d.data.node, dd = Math.hypot(n.x - x, n.y - y); if (dd < wR(n) + 5 / G.t.k && dd < bd) { bd = dd; best = n; } });
  return best;
}
function drawWorld() {
  const cv = $("#gcv"); if (!cv || !G.t) return;
  const ctx = cv.getContext("2d"), dpr = devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cv.width / dpr, cv.height / dpr);
  if (!W.root) return;
  ctx.save(); ctx.translate(G.t.x, G.t.y); ctx.scale(G.t.k, G.t.k);
  const focus = G.sel || G.hover, q = G.q.trim().toLowerCase();
  const onPath = new Set(); if (focus) { const f = W.root.find((d) => d.data.node.id === focus); f?.ancestors().forEach((a) => onPath.add(a.data.node.id)); f?.descendants().forEach((a) => onPath.add(a.data.node.id)); }
  const hit = q ? new Set(W.nodes.filter((n) => n.title.toLowerCase().includes(q)).map((n) => n.id)) : null;
  const text = cssv("--text") || "#eee", dim = cssv("--dim") || "#888", bg = cssv("--bg") || "#000";
  // rings for the levels
  const radii = [...new Set(W.root.descendants().filter((d) => d.data.node.kind !== "leaf" && d.depth > 0).map((d) => Math.round(d.y)))];
  ctx.strokeStyle = cssv("--line") || "rgba(255,255,255,.06)"; ctx.lineWidth = 1 / G.t.k; ctx.setLineDash([2 / G.t.k, 6 / G.t.k]);
  radii.forEach((r) => { ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.stroke(); }); ctx.setLineDash([]);
  const link = d3.linkRadial().angle((d) => d.x).radius((d) => d.y).context(ctx);
  for (const l of W.root.links()) {
    const n = l.target.data.node, lit = !focus || (onPath.has(n.id) && onPath.has(l.source.data.node.id));
    ctx.globalAlpha = hit ? (hit.has(n.id) ? 0.7 : 0.05) : lit ? (focus ? 0.85 : n.kind === "leaf" ? 0.22 : 0.45) : 0.05;
    ctx.strokeStyle = wColor(n); ctx.lineWidth = (n.kind === "leaf" ? 0.7 : 1.4) / Math.sqrt(G.t.k);
    ctx.beginPath(); link(l); ctx.stroke();
  }
  for (const d of W.root.descendants()) {
    const n = d.data.node, r = wR(n), faded = (focus && !onPath.has(n.id)) || (hit && !hit.has(n.id));
    ctx.globalAlpha = faded ? 0.15 : 1;
    if (n.kind === "root" || (n.kind === "topic" && d.depth === 1)) { ctx.shadowColor = wColor(n); ctx.shadowBlur = n.kind === "root" ? 26 : 14; }
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, 7);
    if (n.kind === "plan") { ctx.setLineDash([3 / G.t.k, 3 / G.t.k]); ctx.strokeStyle = wColor(n); ctx.lineWidth = 1.5 / G.t.k; ctx.stroke(); ctx.setLineDash([]); }
    else { ctx.fillStyle = wColor(n); ctx.fill(); }
    ctx.shadowBlur = 0;
    if (n.stale && n.kind === "topic") { ctx.beginPath(); ctx.arc(n.x + r * .8, n.y - r * .8, 2.2 / Math.sqrt(G.t.k), 0, 7); ctx.fillStyle = "#f6ad55"; ctx.fill(); }
    if (n.hidden) { ctx.fillStyle = bg; ctx.font = `600 ${Math.max(8, 10 / Math.sqrt(G.t.k))}px ${cssv("--font")}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText("+", n.x, n.y); }
    if (n.id === G.sel) { ctx.lineWidth = 2.5 / G.t.k; ctx.strokeStyle = text; ctx.beginPath(); ctx.arc(n.x, n.y, r + 3 / G.t.k, 0, 7); ctx.stroke(); }
  }
  // labels: topics always (by size), conversations on the rim when close enough or in focus
  for (const d of W.root.descendants()) {
    const n = d.data.node; if (n.kind === "root") continue;
    const leaf = n.kind === "leaf", show = n.id === focus || (hit ? hit.has(n.id) : leaf ? G.t.k > 1.35 || (focus && onPath.has(n.id) && G.t.k > 0.7)
      : focus ? onPath.has(n.id) : d.depth === 1 || (d.depth === 2 && G.t.k > 0.75) || G.t.k > 1.2);
    if (!show) continue;
    const fs = Math.max(8, (leaf ? 10.5 : d.depth === 1 ? 15 : d.depth === 2 ? 12.5 : 11.5) / Math.sqrt(G.t.k));
    ctx.font = `${leaf ? 400 : d.depth === 1 ? 700 : 600} ${fs}px ${cssv("--font") || "sans-serif"}`;
    ctx.globalAlpha = (focus && !onPath.has(n.id)) || (hit && !hit.has(n.id)) ? 0.25 : 1;
    const s = (n.title.length > (leaf ? 26 : 14) ? n.title.slice(0, leaf ? 25 : 13) + "…" : n.title) + (n.hidden ? ` (${n.hidden})` : "");
    ctx.lineWidth = 3 / G.t.k; ctx.strokeStyle = bg; ctx.fillStyle = leaf ? dim : text;
    if (leaf) {                                            // along the ray, outwards
      const a = n.angle - Math.PI / 2, flip = Math.cos(a) < 0;
      ctx.save(); ctx.translate(n.x, n.y); ctx.rotate(flip ? a + Math.PI : a); ctx.textAlign = flip ? "right" : "left"; ctx.textBaseline = "middle";
      const off = (flip ? -1 : 1) * (wR(n) + 4); ctx.strokeText(s, off, 0); ctx.fillText(s, off, 0); ctx.restore();
    } else {                                                // beside the node, on its outer side
      const a = n.angle - Math.PI / 2, c = Math.cos(a), off = wR(n) + 5;
      ctx.textAlign = c > 0.25 ? "left" : c < -0.25 ? "right" : "center"; ctx.textBaseline = "middle";
      const lx = n.x + c * off, ly = n.y + Math.sin(a) * off + (Math.abs(c) <= 0.25 ? Math.sign(Math.sin(a)) * fs * 0.6 : 0);
      ctx.strokeText(s, lx, ly); ctx.fillText(s, lx, ly);
    }
  }
  ctx.fillStyle = text; ctx.globalAlpha = 1; ctx.font = `700 ${Math.max(10, 16 / Math.sqrt(G.t.k))}px ${cssv("--font")}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.strokeStyle = bg; ctx.lineWidth = 4 / G.t.k; ctx.strokeText(L("世界", "World"), 0, wR(W.root.data.node) + 14); ctx.fillText(L("世界", "World"), 0, wR(W.root.data.node) + 14);
  ctx.restore(); ctx.globalAlpha = 1;
}
function drawWorldBar() {
  const d = W.data || {}, b = d.building, topics = W.nodes.filter((n) => n.kind === "topic").length, leaves = W.nodes.filter((n) => n.kind === "leaf").length;
  const prog = b?.state === "running" ? `<div class="wbuild"><span class="spin"></span>${esc({ start: L("开始…", "Starting…"), taxonomy: L("正在读所有对话、分出层级…", "Reading every conversation, drawing the levels…"), assign: L(`正在把对话放到各自的位置（${b.done}/${b.total}）…`, `Placing conversations (${b.done}/${b.total})…`), summaries: L("正在从下往上写每一层的概括…", "Summarising each level, bottom up…") }[b.step] || b.step)}</div>`
    : b?.state === "deferred" || b?.state === "error" ? `<div class="wbuild bad">${esc(L("这次没生成成：", "Not built this time: ") + (b.error || ""))}</div>` : "";
  const F = W.facts || {}, ff = F.filling;
  const factRow = d.built ? `<div class="wfrow dimt">${L(`事实图谱：${F.facts ?? "…"} 条现在成立，${F.invalidated ?? 0} 条已被推翻`, `Facts: ${F.facts ?? "…"} hold now, ${F.invalidated ?? 0} superseded`)}
      ${ff?.state === "running" ? `<span class="wbuild"><span class="spin"></span>${L(`正在读（${ff.done}/${ff.total}）${esc(ff.now || "")}`, `Reading (${ff.done}/${ff.total})`)}</span>`
        : F.pending ? `<button class="sm ghost" data-wact="facts" title="${L("把最近 30 天的对话读进事实图谱：每段对话约 2–3 次模型调用（DeepSeek）；平时每 10 分钟自己读几段", "Read the last 30 days of conversations into the fact graph: about 2–3 model calls each (DeepSeek); it also reads a few every 10 minutes")}">${L(`读入最近的对话（还有 ${F.pending} 段）`, `Read recent conversations (${F.pending} to go)`)}</button>` : ""}</div>` : "";
  $("#gbar").innerHTML = `<div class="gh"><b>${L("世界树", "World tree")}</b>${modeSeg()}<span class="dimt" id="gcount">${d.built ? L(`${topics} 个主题 · ${leaves} 段对话`, `${topics} topics · ${leaves} conversations`) : ""}</span></div>
    ${d.built ? `<div class="grow2"><input type="text" id="gq" placeholder="${L("找一个主题或对话…", "Find a topic or conversation…")}" value="${esc(G.q)}">
      <button class="sm ghost" data-wact="place" title="${L("新对话现在就放到各自的位置（平时每 10 分钟自己做一次）", "Place new conversations now (it also happens every 10 minutes)")}">${L("整理新对话", "Place new ones")}</button>
      <button class="sm ghost" data-wact="rebuild" title="${L("从头重新分层（你手动移动过的会被覆盖）", "Rebuild from scratch (your own moves are lost)")}">${L("重新生成", "Rebuild")}</button></div>
      ${factRow}
      <div class="wsw"><label class="lktog"><input type="checkbox" data-wsw="agent" ${W.showAgent ? "checked" : ""}><i></i>${L(`agent 自己的对话（${W.nodes.filter((x) => x.kind === "leaf" && x.who === "agent" && !x.hidden).length}）`, `Agents' own conversations (${W.nodes.filter((x) => x.kind === "leaf" && x.who === "agent" && !x.hidden).length})`)}</label>
        <label class="lktog"><input type="checkbox" data-wsw="gist" ${W.showGist ? "checked" : ""}><i></i>${L("显示主旨", "Show gists")}</label></div>
      <div class="ghint dimt">${G.mode === "3d" ? L("拖动旋转、滚轮拉近 · 点任意节点：它变成旋转中心，周围高亮，右边看详情 · 双击对话进入", "Drag to turn, scroll to zoom · click any node: it becomes the centre, its surroundings light up · double-click a conversation to open it") + "</div><div hidden>" : ""}${L("点对话直接进去 · 点主题看概括、和它对话、往下长 · 双击主题收起或展开 · 橙点表示概括待更新", "Click a conversation to open it · click a topic to read it, talk to it, grow it · double-click a topic to fold it · an orange dot: summary to be refreshed")}</div>`
      : `<div class="wempty">${L("世界树还没有生成。生成时，模型（DeepSeek）会读你所有对话的标题和开头片段，分出「进行研究 › 世界模型研究」这样的层级，再从下往上为每一层写概括；大约要调用十几次。之后每段新对话会自己挂到对应的位置。", "The world tree is not built yet. A model (DeepSeek) reads the titles and openings of all your conversations, draws levels like “Research › World models”, then summarises each level bottom-up — around a dozen calls. Afterwards every new conversation finds its own place.")}
        <div style="margin-top:10px"><button class="primary sm" data-wact="build" ${b?.state === "running" ? "disabled" : ""}>${L("生成世界树", "Build the world tree")}</button></div></div>`}
    ${prog}`;
}
function worldPath(n) { const out = [n]; while (out[0].parent && W.byId.get(out[0].parent)) out.unshift(W.byId.get(out[0].parent)); return out; }
function drawWorldSide() {
  const box = $("#gside"), n = W.byId.get(G.sel);
  if (!n || G.mode === "net") { box.hidden = true; return; }
  box.hidden = false;
  const kids = W.nodes.filter((x) => x.parent === n.id && wShown(x)), topics = kids.filter((x) => x.kind !== "leaf"), convs = kids.filter((x) => x.kind === "leaf");
  const nAgent = W.nodes.filter((x) => x.parent === n.id && x.kind === "leaf" && x.who === "agent" && !x.hidden).length;
  const crumbs = worldPath(n).map((x) => `<a href="#" data-wsel="${x.id}">${esc(x.kind === "root" ? L("世界", "World") : x.title)}</a>`).join(" › ");
  const aims = (S.forest?.trees || []).filter((t) => t.task);
  box.innerHTML = `<div class="gs-h"><i style="background:${wColor(n)}"></i><span>${esc(L(GT[n.type].zh, GT[n.type].en))}${n.count ? L(` · ${n.count} 段对话`, ` · ${n.count} conversations`) : ""}</span><span class="grow"></span><button class="sm ghost" data-gclose="1">×</button></div>
    <div class="wcrumb">${crumbs}</div><h3>${esc(n.kind === "root" ? L("世界", "World") : n.title)}</h3>
    ${n.kind === "leaf" && n.gist ? `<div class="wgist">${L("主旨：", "Gist: ")}${esc(n.gist)}</div>` : ""}
    ${n.summary ? `<div class="gs-sub md">${md(n.summary)}</div>` : n.kind === "leaf" && n.excerpt ? `<div class="gs-sub">${esc(n.excerpt)}</div>` : ""}
    <div class="gs-acts">${n.kind === "leaf" || n.kind === "aim" ? `<button class="sm primary" data-wact="open">${n.kind === "aim" ? L("打开这棵树", "Open the tree") : L("打开这段对话", "Open the conversation")}</button>` : ""}
      ${n.kind !== "leaf" ? `<button class="sm primary" data-wact="talk" title="${L("开一段新对话，agent 读的是这一层的概括、它的各部分，以及和你问的最相关的那几段对话", "A new conversation where the agent reads this level's summary, its parts, and the conversations closest to what you ask")}">${L("和这个主题对话", "Talk to this topic")}</button>` : ""}
      ${n.kind === "topic" || n.kind === "root" || n.kind === "plan" ? `<button class="sm" data-wact="expand" title="${L("让模型提出下一层值得做的几个方向", "Let a model suggest the next level of directions")}">${L("往下长一层", "Grow a level")}</button>` : ""}
      ${n.kind !== "leaf" ? `<button class="sm ghost" data-wact="ctx">${L("agent 会读到什么", "What an agent reads")}</button>` : ""}
      ${n.kind === "topic" || n.kind === "plan" ? `<button class="sm ghost" data-wact="rename">${L("改名", "Rename")}</button>` : ""}</div>
    <div class="gs-acts wcrud">${n.kind !== "leaf" ? `<button class="sm ghost" data-wact="addtopic">${L("＋ 子主题", "+ Subtopic")}</button>` : ""}
      ${n.kind === "topic" || n.kind === "root" || n.kind === "plan" ? `<button class="sm ghost" data-wact="resum">${L("改概括", "Edit summary")}</button>` : ""}
      ${n.kind === "leaf" ? `<button class="sm ghost" data-wact="regist">${L("改主旨", "Edit gist")}</button>` : ""}
      ${n.kind !== "root" ? `<select class="wmove" data-wmove="1"><option value="">${L("移到…", "Move to…")}</option>${W.nodes.filter((x) => (x.kind === "topic" || x.kind === "root" || x.kind === "plan") && x.id !== n.id && !worldPath(x).some((y) => y.id === n.id))
          .map((x) => `<option value="${x.id}">${esc((x.kind === "root" ? L("世界", "World") : "  ".repeat(Math.max(0, worldPath(x).length - 2)) + x.title))}</option>`).join("")}</select>` : ""}
      ${n.kind !== "root" ? `<button class="sm ghost danger" data-wact="remove">${n.kind === "leaf" ? L("移出世界树", "Take out of the tree") : L("删除主题", "Delete topic")}</button>` : ""}</div>
    ${n.kind !== "leaf" && aims.length ? `<div class="wfocus"><span class="label">${L("让抱负在这一层往下想", "Point a motivation here")}</span><select data-wfocus="1"><option value="">${L("选一个抱负…", "Choose a motivation…")}</option>${aims.map((t) => `<option value="${t.id}">${esc(t.text.slice(0, 30))}</option>`).join("")}</select></div>` : ""}
    <div class="wfacts" id="wfacts"></div>
    ${topics.length ? `<div class="gs-g"><div class="label">${L("下面的主题", "Topics under it")} · ${topics.length}</div>${topics.map((x) => `<div class="gs-n" data-wsel="${x.id}"><i style="background:${wColor(x)}"></i><span>${esc(x.title)}</span><em>${x.kind === "plan" ? L("计划", "planned") : x.kind === "aim" ? L("抱负", "motivation") : x.count ? x.count : ""}</em></div>`).join("")}</div>` : ""}
    ${convs.length || nAgent ? `<div class="gs-g"><div class="label">${L("对话", "Conversations")} · ${convs.length}${nAgent && !W.showAgent ? L(`（另有 ${nAgent} 段 agent 自己的对话，已隐藏）`, ` (${nAgent} of agents' own hidden)`) : ""}</div>${convs.slice().sort((a, b) => String(b.last || "").localeCompare(String(a.last || ""))).slice(0, 60).map((x) => `<div class="gs-n wconv ${x.who === "agent" ? "agent" : ""}" data-wopen="${x.id}" title="${L("点一下进入这段对话", "Click to open")}"><i style="background:${wColor(x)}"></i><span>${esc(x.title)}${W.showGist && x.gist ? `<small>${esc(x.gist)}</small>` : ""}</span><em>${x.who === "agent" ? "agent · " : ""}${x.last ? esc(ago(x.last)) : ""}</em><button class="sm ghost" data-wsel="${x.id}" title="${L("看这段对话在树上的位置、改主旨、移动", "Its place, gist, move")}">⋯</button></div>`).join("")}${convs.length > 60 ? `<div class="dimt">… ${convs.length - 60}</div>` : ""}</div>` : ""}`;
}
const fday = (iso) => (iso ? new Date(iso).toLocaleDateString(EN ? "en-GB" : "zh-CN", { year: "numeric", month: "short", day: "numeric" }) : "");
async function loadFacts(n) {
  const box = $("#wfacts"); if (!box) return;
  const r = await api(`/v1/world/${n.id}/facts`).catch(() => null);
  if (!box.isConnected || G.sel !== n.id || !r) return;
  if (!r.current.length && !r.superseded.length) { box.innerHTML = `<div class="dimt wfnote">${L("这里还没有读出事实。", "No facts read here yet.")}</div>`; return; }
  box.innerHTML = `<div class="gs-g"><div class="label">${L("现在成立的事实", "What holds now")} · ${r.current.length}</div>
      ${r.current.map((f) => `<div class="wfact"><span>${esc(f.fact)}</span><em>${esc(L("自 ", "since ") + fday(f.valid_at))}</em></div>`).join("") || `<div class="dimt">—</div>`}</div>
    ${r.superseded.length ? `<details class="gs-g wold"><summary class="label">${L("已被推翻", "No longer true")} · ${r.superseded.length}</summary>
      ${r.superseded.map((f) => `<div class="wfact old"><s>${esc(f.fact)}</s><em>${esc(fday(f.valid_at))} – ${esc(fday(f.invalid_at || f.expired_at))}</em>${f.replaced_by ? `<div class="wrep">→ ${esc(f.replaced_by.fact)}</div>` : ""}</div>`).join("")}</details>` : ""}`;
}
async function openLeaf(n) {
  const o = n.open || {}, key = n.ref || "";
  if (n.kind === "aim" || (o.tree && !o.node && key.startsWith("aim:"))) { show("tree", { aim: o.tree || key.slice(4) }); return; }
  if (o.tree && o.node) { show("tree", { aim: o.tree, node: o.node }); return; }
  if (o.chat || key.startsWith("chat:")) { S.lineView = null; S.imp = null; S.treeItem = null; S.chat = o.chat || key; show("chats"); return; }
  show("chats"); await loadTimeline();
  const x = (S.tl?.sessions || []).find((y) => y.item === key);
  if (x) openSession(x.id); else toast(L("这段对话现在不在「所有对话」里（可能已归档）", "This conversation is not in the list (archived?)"));
}
const _drawSideW = drawWorldSide;
drawWorldSide = function () { _drawSideW(); const n = W.byId.get(G.sel); if (n && G.mode !== "net" && n.kind !== "leaf") loadFacts(n); };
function worldClick(n) {
  if (!n) { G.sel = null; drawWorldSide(); drawWorld(); return; }
  if (n.kind === "leaf") { openLeaf(n); return; }                 // a conversation: straight into it
  G.sel = n.id; drawWorldSide(); drawWorld();
  const cv = $("#gcv"), [sx, sy] = G.t.apply([n.x, n.y]), room = cv.clientWidth - 380;   // keep it clear of the side panel
  if (sx > room - 40 || sx < 40 || sy < 40 || sy > cv.clientHeight - 40)
    d3.select(cv).transition().duration(450).call(G.zoom.transform, d3.zoomIdentity.translate(room / 2 - n.x * G.t.k, cv.clientHeight / 2 - n.y * G.t.k).scale(G.t.k));
}
function worldDbl(n) {
  if (n.kind === "leaf" || n.kind === "root") return;
  W.collapsed.has(n.id) ? W.collapsed.delete(n.id) : W.collapsed.add(n.id); layoutWorld(); drawWorld();
}
async function talkTo(n) {
  const key = `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  try { await api(`/v1/users/${S.uid}/chat-world`, { method: "PUT", body: { key, node: n.id } }); } catch (err) { toast(err.message); return; }
  S.chatWorld = { ...(S.chatWorld || {}), [key]: { leaf: null, talks_to: n.id, path: worldPath(n).map((x) => ({ id: x.id, title: x.title, kind: x.kind })) } };
  S.lineView = null; S.imp = null; S.treeItem = null; S.chat = key; S.chatTurns[key] = [];
  show("chats"); setTimeout(() => $("#chatText")?.focus(), 200);
  toast(L(`在和「${n.kind === "root" ? "世界" : n.title}」这一层对话：agent 读的是它的概括和各部分`, `Talking to “${n.title}”: the agent reads its summary and parts`));
}
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-wact], [data-wsel], [data-wopen], [data-wlevel]"); if (!t) return;
  e.preventDefault();
  if (t.dataset.wlevel !== undefined) { await setLevel(t.dataset.wlevel); return; }
  if (t.dataset.wsel) { G.sel = t.dataset.wsel; drawWorldSide(); drawWorld(); return; }
  if (t.dataset.wopen) { const n = W.byId.get(t.dataset.wopen); if (n) openLeaf(n); return; }
  const a = t.dataset.wact, n = W.byId.get(G.sel);
  if (a === "build" || a === "rebuild") {
    if (a === "rebuild" && !confirm(L("从头重新生成世界树？你手动移动、改名过的会被覆盖。", "Rebuild the world tree from scratch? Your own moves and names are lost."))) return;
    try { await api(`/v1/users/${S.uid}/world/build`, { method: "POST" }); } catch (err) { toast(err.message); }
    await loadWorld();
  } else if (a === "facts") { try { await api(`/v1/users/${S.uid}/facts/fill`, { body: { days: 30, limit: 80 } }); toast(L("开始读了：每段对话读完，它的事实就会出现在对应主题下面", "Reading: each conversation's facts appear under its topic as soon as it is done")); } catch (err) { toast(err.message); } await loadWorld();
  } else if (a === "place") {
    t.disabled = true; try { const r = await api(`/v1/users/${S.uid}/world/place`, { method: "POST" }); toast(L(`放好了 ${r.placed} 段新对话，更新了 ${r.summarised} 个概括`, `Placed ${r.placed}, refreshed ${r.summarised} summaries`)); } catch (err) { toast(err.message); }
    await loadWorld();
  } else if (!n) return;
  else if (a === "open") openLeaf(n);
  else if (a === "talk") talkTo(n);
  else if (a === "expand") { t.disabled = true; try { const made = await api(`/v1/world/${n.id}/expand`, { method: "POST" }); toast(L(`长出了 ${made.length} 个方向`, `${made.length} directions`)); W.collapsed.delete(n.id); } catch (err) { toast(err.message); } await loadWorld(); }
  else if (a === "ctx") { const r = await api(`/v1/world/${n.id}/context`).catch((err) => ({ context: err.message }));
    modal(`<h2>${L("和这一层对话时，agent 读到的", "What an agent reads at this level")}</h2><div class="muted" style="font-size:13px;margin-bottom:10px">${L("放在对话的开头（不变的部分，能命中缓存）；你每问一句，再把这一层下面和问题最相关的几段对话附在问题后面。", "At the start of the conversation (unchanging, so it caches); with each question, the conversations under it closest to the question go after it.")}</div><pre class="ctxpre">${esc(r.context)}</pre>`); }
  else if (a === "addtopic") { const v = prompt(L("新主题的名字", "Name of the new topic"), ""); if (!v) return;
    try { const r = await api(`/v1/world/${n.id}/children`, { body: { title: v } }); await loadWorld(); G.sel = r.id; drawWorldSide(); if (G.mode === "3d") w3Build(); } catch (err) { toast(err.message); } }
  else if (a === "resum") { editText(L("改这一层的概括（之后自动更新不会覆盖你写的）", "Edit this level's summary (later updates keep yours)"), n.summary || "", async (v) => { await api(`/v1/world/${n.id}`, { method: "PATCH", body: { summary: v } }); await loadWorld(); }); }
  else if (a === "regist") { const v = prompt(L("这段对话的主旨（一句话）", "This conversation's gist (one line)"), n.gist || ""); if (v == null) return; await api(`/v1/world/${n.id}`, { method: "PATCH", body: { gist: v } }).catch((err) => toast(err.message)); await loadWorld(); }
  else if (a === "remove") { if (!confirm(n.kind === "leaf" ? L("把这段对话移出世界树？（它还在「所有对话」里）", "Take this conversation out of the tree? (It stays in your conversations.)") : L(`删除主题「${n.title}」？它下面的主题和对话会移到上一层。`, `Delete “${n.title}”? What is under it moves up a level.`))) return;
    try { await api(`/v1/world/${n.id}`, { method: "DELETE" }); G.sel = n.parent; await loadWorld(); } catch (err) { toast(err.message); } }
  else if (a === "rename") { const v = prompt(L("新名字", "New name"), n.title); if (!v) return; await api(`/v1/world/${n.id}`, { method: "PATCH", body: { title: v } }).catch((err) => toast(err.message)); await loadWorld(); }
});
function editText(title, value, save) {
  modal(`<h2>${esc(title)}</h2><textarea id="wedit" style="width:100%;min-height:160px">${esc(value)}</textarea><div class="row2"><span class="grow"></span><button class="ghost" data-closemodal="1">${L("取消", "Cancel")}</button><button class="primary" id="weditGo">${L("保存", "Save")}</button></div>`);
  $("#weditGo").onclick = async () => { try { await save($("#wedit").value); document.querySelector(".modal")?.remove(); toast(L("改好了", "Saved")); } catch (err) { toast(err.message); } };
}
document.addEventListener("change", async (e) => {
  const sw = e.target.closest?.("[data-wsw]");
  if (sw) { const k = sw.dataset.wsw; if (k === "agent") W.showAgent = sw.checked; else W.showGist = sw.checked;
    try { localStorage.setItem(k === "agent" ? "pga_world_agent" : "pga_world_gist", sw.checked ? "1" : "0"); } catch {}
    layoutWorld(); drawWorldBar(); drawWorldSide(); if (G.mode === "3d") w3Build(); else drawWorld(); return; }
  const mv = e.target.closest?.("[data-wmove]");
  if (mv && mv.value) { const n = W.byId.get(G.sel); if (!n) return;
    try { await api(`/v1/world/${n.id}`, { method: "PATCH", body: { parent: mv.value } }); toast(L("移好了", "Moved")); await loadWorld(); } catch (err) { toast(err.message); } return; }
  const s = e.target.closest?.("[data-wfocus]"); if (!s || !s.value) return;
  const n = W.byId.get(G.sel); if (!n) return;
  try { await api(`/v1/aims/${s.value}/perpetual`, { method: "PATCH", body: { settings: { world_focus: n.id } } });
    toast(L(`这个抱负以后在「${n.title}」这一层往下想；先「往下长一层」，它会按长出来的方向逐个做`, `That motivation now works on “${n.title}”; grow a level and it takes the directions one by one`)); }
  catch (err) { toast(err.message); }
  s.value = "";
});

/* in a conversation: which level the agent reads — this conversation, or a topic above it */
async function setLevel(id) {
  const key = S.chat, w = S.chatWorld?.[key]; if (!key || !w) return;
  try { await api(`/v1/users/${S.uid}/chat-world`, { method: "PUT", body: { key, node: id || "" } }); } catch (err) { toast(err.message); return; }
  w.talks_to = id || null;
  const n = (w.path || []).find((x) => x.id === id);
  toast(id ? L(`接下来 agent 读的是「${n?.kind === "root" ? "世界" : n?.title}」这一层：它的概括、各部分，和与你问题最相关的对话`, `From now the agent reads “${n?.title}”: its summary, parts and the closest conversations`) : L("回到只看这段对话", "Back to this conversation only"));
  renderChat();
}
function worldLevelRow() {
  const key = S.chat, w = S.chatWorld?.[key], box = $("#ccomp .inner");
  if (S.lineView || S.imp || !key || !box || !w || !(w.path || []).length) return;
  const path = w.path, leaf = w.leaf, cur = w.talks_to || leaf || null;
  const opts = path.filter((x) => x.id !== leaf).reverse();
  box.insertAdjacentHTML("afterbegin", `<div class="wlevel"><span class="dimt">${L("对话的层级：", "Level: ")}</span>
    ${leaf ? `<button class="sm ${!w.talks_to ? "on" : ""}" data-wlevel="">${L("只这段对话", "This conversation")}</button>` : ""}
    ${opts.map((x, i) => `${i || leaf ? `<span class="sep">‹</span>` : ""}<button class="sm ${w.talks_to === x.id ? "on" : ""}" data-wlevel="${x.id}" title="${L("让 agent 读这一层的概括和各部分", "Let the agent read this level")}">${esc(x.kind === "root" ? L("整个世界", "Everything") : x.title)}</button>`).join("")}</div>`);
}
function worldHello() {                         // a new conversation with a topic: say which, and what it holds
  const key = S.chat, w = S.chatWorld?.[key];
  if (S.lineView || S.imp || !w?.talks_to || (S.chatTurns[key] || []).length) return;
  const n = (w.path || []).find((x) => x.id === w.talks_to), full = W.byId.get(w.talks_to);
  const box = $("#cdlgIn"); if (!box || !n) return;
  box.innerHTML = `<div class="chello"><h2>${esc(n.kind === "root" ? L("整个世界", "Everything") : n.title)}</h2><div>${L("你在和世界树上的这一层对话：agent 读的是它的概括、它下面的各部分，以及和你每句问话最相关的那几段对话。", "You are talking to this level of the world tree: the agent reads its summary, its parts, and the conversations closest to each question.")}</div>
    ${full?.summary ? `<div class="whello md">${md(full.summary)}</div>` : ""}</div>`;
}
const _rcWorld = renderChat;
renderChat = function () { _rcWorld(); worldLevelRow(); worldHello(); };
