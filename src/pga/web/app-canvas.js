/* PGA app · 无限画布, the default page. Every topic of the world tree has a board laid out like an Unreal Engine
   blueprint: input → assign → (branches) → output. The branches are the conversations and sub-topics under it, plus
   whatever you add. Nodes are conversations (any agent), skills (Hermes's own, Claude Code's), pictures you uploaded,
   notes and sub-boards. A wire carries what one node says into the next.

   Cooking is non-destructive (Houdini, ComfyUI):
   - a node remembers the signature of what it was cooked from (its own settings and what its inputs said);
   - when that changes, the node turns stale and so does everything after it, but nothing is redone or thrown away
     until you run it;
   - a re-run keeps the earlier outputs as versions;
   - a locked node keeps its output, and a bypassed node passes its inputs through.
   pga/canvas.py keeps the boards and syncs them with the world tree; see its docstring for the projects drawn on.

   Interaction (Blueprint, LiteGraph, Houdini):
   - right-click, double-click or Tab on empty space opens the node search;
   - dragging a wire off a pin into empty space opens it too, already wired;
   - right-click a node for its actions;
   - click a conversation to read it beside the board, double-click to open it;
   - F frames the board, Delete removes, ⌘Z undoes.

   The one copied function, `curve`, is Drawflow's createCurvature (jerosoler/Drawflow, MIT, Copyright (c) 2020 Jero
   Soler; see third_party/drawflow/LICENSE). Modified by PGA (2026-10-22): only the default "openclose" case, as an
   arrow function. */

const CV = { board: null, data: null, rev: 0, view: { x: 0, y: 0, z: 1 }, sel: new Set(), busy: {}, undo: [], redo: [], cooking: {},
  palette: null, pal: null, wire: null, drag: null, pan: null, box: null, link: null, mouse: { x: 0, y: 0 }, saveT: null, ready: null,
  tree: (() => { try { return localStorage.getItem("pga_cv_tree") === "1"; } catch { return false; } })(),
  world: Q.get("b") || (() => { try { return localStorage.getItem("pga_cv_world") || "top"; } catch { return "top"; } })() };
const KIND = {
  input: ["输入", "Input"], dispatch: ["指派", "Assign"], chat: ["对话", "Conversation"], output: ["输出", "Output"], watch: ["验收", "Watchdog"],
  note: ["笔记", "Note"], skill: ["技能", "Skill"], image: ["图片", "Picture"], board: ["子画布", "Sub-board"], group: ["分组", "Group"] };
const SOURCES = new Set(["input", "note", "skill", "image", "board", "group"]);       // nothing to cook: what they say is what they hold
const PIN_Y = 19;
const kname = (k) => L(...(KIND[k] || [k, k]));

/* ---- copied from jerosoler/Drawflow src/drawflow.js createCurvature (MIT), default case */
const curve = (start_pos_x, start_pos_y, end_pos_x, end_pos_y, curvature) => {
  const hx1 = start_pos_x + Math.abs(end_pos_x - start_pos_x) * curvature;
  const hx2 = end_pos_x - Math.abs(end_pos_x - start_pos_x) * curvature;
  return " M " + start_pos_x + " " + start_pos_y + " C " + hx1 + " " + start_pos_y + " " + hx2 + " " + end_pos_y + " " + end_pos_x + "  " + end_pos_y;
};
/* ---- end of copied code */

/* ------------------------------------------------ the graph */
const cvNode = (id) => CV.data?.nodes.find((n) => n.id === id);
const cvIns = (id) => CV.data.edges.filter((e) => e.toNode === id).map((e) => cvNode(e.fromNode)).filter(Boolean).sort((a, b) => a.y - b.y);
const cvOuts = (id) => CV.data.edges.filter((e) => e.fromNode === id).map((e) => cvNode(e.toNode)).filter(Boolean);
const fnv = (s) => { let h = 0x811c9dc5; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
const nid = () => Math.random().toString(36).slice(2, 10);
const isRef = (n) => n.kind === "chat" && n.seeded && !n.task;                // a conversation already under the topic: it stands on its own
const askOf = (n) => (n.askIn ? cvNode(n.askIn) : null);                       // …with the question it answered in the input before it
const edited = (n) => { const q = askOf(n); return !!q && !!(q.text || "").trim() && (q.text || "").trim() !== (n.ask0 || "").trim(); };
function outOf(n) {
  if (!n) return "";
  if (n.bypass) return cvIns(n.id).map(outOf).filter(Boolean).join("\n\n");
  if (n.kind === "input" || n.kind === "note") return n.text || "";
  if (n.kind === "image") return `[${L("图片", "picture")}: ${n.title}]`;
  return n.out || "";
}
function inSig(n) {
  const own = JSON.stringify([n.kind, n.text || "", n.agent || "", n.path || "", n.world || "", !!n.bypass]);
  if (isRef(n)) return fnv(own + "|" + (askOf(n)?.text || ""));
  return fnv(own + "|" + cvIns(n.id).filter((u) => !u.gone).map((u) => u.id + ":" + fnv(outOf(u))).join("|"));
}
function state(n) {
  if (CV.busy[n.id]) return "running";
  if (SOURCES.has(n.kind)) return "fresh";
  if (n.lock) return "locked";
  if (n.err) return "error";
  if (!n.cin) return "new";
  return n.cin === inSig(n) ? "fresh" : "stale";
}
const canCook = (n) => !SOURCES.has(n.kind) && !n.lock && !n.gone && (!!(n.text || "").trim() && n.kind === "chat" || (isRef(n) ? edited(n) : cvIns(n.id).some((u) => !u.gone && (outOf(u) || u.kind === "image"))));
function dirty(n, memo = new Map()) {          // stale itself, or something before it is (Houdini's dirty flag, propagated)
  if (memo.has(n.id)) return memo.get(n.id); memo.set(n.id, false);
  const s = state(n); let d = (s === "stale" || (s === "new" && canCook(n)));
  if (!d && !isRef(n) && !n.lock) d = cvIns(n.id).some((u) => dirty(u, memo));
  memo.set(n.id, d); return d;
}

/* ------------------------------------------------ loading and keeping a board */
async function cvOpen(world, focus) {
  CV.world = world || "top"; CV.want = focus || null;
  if (S.view !== "canvas") show("canvas"); else await cvLoad(CV.world, CV.want);
  await CV.ready;
}
async function cvLoad(world, focus) {
  CV.ready = (async () => {
    let b; try { b = await api(`/v1/users/${S.uid}/canvas?world=${encodeURIComponent(world)}`); } catch (err) { toast(err.message); if (world !== "top") return cvLoad("top"); return; }
    CV.board = b; CV.data = b.data; CV.rev = b.rev; CV.world = b.world; CV.sel.clear(); CV.undo = []; CV.redo = []; CV.busy = {};
    try { localStorage.setItem("pga_cv_world", b.world); } catch {}
    cvTree();
    history.replaceState(null, "", qs());
    let changed = false;
    for (const n of CV.data.nodes) {
      if (n.seeded && n.cin == null && !SOURCES.has(n.kind)) { n.cin = inSig(n); changed = true; }       // what the tree already says counts as cooked
      if (n.running) { CV.busy[n.id] = true; resume(n); }
    }
    if (typeof padApply === "function" && padApply(b.world)) changed = true;
    cvRender(true);
    if (typeof branchLayout === "function") { await wtFetch(); branchLayout(); }     // the board as a level branch of the world tree
    else if ((CV.data.laid | 0) < 3) { relayout(); CV.data.laid = 3; changed = true; }
    if (CV.peek && !cvNode(CV.peek)) peekClose(true);                  // the conversation open on the right was on another board
    CV.want = null;
    if (!focus && world !== b.world) focus = world;                       // a conversation was asked for: its topic's board, at its row
    const f = cvNode(focus) || CV.data.nodes.find((n) => focus && (n.world === focus || n.key === focus) && n.kind !== "board") || cvNode(hotNode());   // a conversation clicked in the world tree: its row
    if (f) { cvFocus(f.id); if (f.kind === "chat" && f.key && !f.seeded) peek(f, true); } else cvFit();
    if (changed) cvSave();
  })();
  return CV.ready;
}
function cvSave(now) {
  clearTimeout(CV.saveT);
  const go = async () => {
    if (!CV.board) return; CV.data.view = { ...CV.view };
    const data = { ...CV.data, nodes: CV.data.nodes.filter((n) => !n.eph), edges: CV.data.edges.filter((e) => !e.eph) };     // the branch around the board is drawn, not kept
    try { const r = await api(`/v1/users/${S.uid}/canvas/${CV.board.id}`, { method: "PUT", body: { data, rev: CV.rev } }); CV.rev = r.rev; cvStatus(L("已保存", "Saved")); }
    catch (err) { if (/another window|409/.test(err.message)) { toast(L("这块画布在另一个窗口里改过了，已重新载入", "This board changed in another window; reloaded")); cvLoad(CV.world); } else cvStatus(err.message); }
  };
  if (now) return go(); CV.saveT = setTimeout(go, 700);
}
function cvStatus(t) { const el = $("#cvSt"); if (el) { el.textContent = t; clearTimeout(cvStatus.t); cvStatus.t = setTimeout(() => { el.textContent = ""; }, 2500); } }
function snap() { CV.undo.push(JSON.stringify({ nodes: CV.data.nodes, edges: CV.data.edges })); if (CV.undo.length > 80) CV.undo.shift(); CV.redo = []; }
function undo(back = true) {
  const from = back ? CV.undo : CV.redo, to = back ? CV.redo : CV.undo; if (!from.length) return;
  to.push(JSON.stringify({ nodes: CV.data.nodes, edges: CV.data.edges }));
  const d = JSON.parse(from.pop()); CV.data.nodes = d.nodes; CV.data.edges = d.edges; cvRender(true); cvSave();
}

/* ------------------------------------------------ drawing */
function showCanvas() {
  document.title = L("画布 · PGA", "Canvas · PGA");
  const v = $("#vCanvas");
  if (!v.dataset.ready) {
    v.dataset.ready = "1";
    v.innerHTML = `<section class="cvmain"><div class="cv" id="cv"><div class="cvw" id="cvw"><svg class="cve" id="cve"><g id="cveg"></g><path id="cvwire" class="cvwire" d=""/></svg><div id="cvn"></div></div><div class="cvbox" id="cvbox" hidden></div></div>
      <div class="cvbar card" id="cvbar"></div><aside class="cvtree card" id="cvtree"></aside></section>
      <aside class="cvside" id="cvside" hidden><i class="cvsgrip" id="cvsGrip"></i><div class="p2h" id="cvsh"></div><iframe id="cvsf" title="conversation"></iframe></aside>`;
    try { const w = Number(localStorage.getItem("pga_cv_side")); if (w) v.style.setProperty("--cvsw", w + "px"); } catch {}
    cvBind(); sideGrip();
  }
  if (!S.acc?.["*new"] && typeof loadAcc === "function") loadAcc("");
  wtFetch().then(cvTree);
  if (!CV.board || CV.board.world !== CV.world || CV.want) cvLoad(CV.world, CV.want); else { cvRender(true); cvApplyView(); }
}
function cvApplyView() {
  const w = $("#cvw"), cv = $("#cv"); if (!w) return; const { x, y, z } = CV.view;
  w.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  const g = 24 * z; cv.style.backgroundSize = `${g}px ${g}px`; cv.style.backgroundPosition = `${x}px ${y}px`;
  cv.classList.toggle("far", z < .55);
}
const toWorld = (cx, cy) => { const r = $("#cv").getBoundingClientRect(); return { x: (cx - r.left - CV.view.x) / CV.view.z, y: (cy - r.top - CV.view.y) / CV.view.z }; };
function unstack() {                             // nodes in one column must not overlap once their real heights are known
  const cols = new Map(); let moved = false;
  for (const n of CV.data.nodes) { if (n.kind === "group" || hidden(n)) continue; const k = Math.round(n.x / 60); if (!cols.has(k)) cols.set(k, []); cols.get(k).push(n); }
  for (const col of cols.values()) {
    col.sort((a, b) => a.y - b.y);
    for (let i = 1; i < col.length; i++) { const p = col[i - 1], h = document.querySelector(`[data-nid="${p.id}"]`)?.offsetHeight || 150; if (col[i].y < p.y + h + 18) { col[i].y = Math.round(p.y + h + 18); moved = true; } }
  }
  return moved;
}
function relayout() {                            // a row per conversation (question → answer) and sub-topic, under the new input and assign
  const X = { in: 0, assign: 340, out: 1040 }, h = (n) => document.querySelector(`[data-nid="${n.id}"]`)?.offsetHeight || 160;
  const seeded = CV.data.nodes.filter((n) => n.seeded && !X[n.id] && n.id !== "out");
  for (const n of CV.data.nodes) if (X[n.id] != null) n.x = X[n.id]; else if (n.seeded) n.x = n.kind === "input" ? 340 : 680;
  const lead = seeded.filter((n) => n.kind !== "input").sort((a, b) => (a.row ?? 1e9) - (b.row ?? 1e9) || a.y - b.y);
  lead.forEach((n, i) => { n.row = i; const q = askOf(n); if (q) q.row = i; });
  cvRender(true);
  for (const id of ["in", "assign"]) if (cvNode(id)) cvNode(id).y = 0;
  const top = Math.max(0, ...["in", "assign"].map((id) => (cvNode(id) ? h(cvNode(id)) : 0))) + 70;
  let y = top;
  for (const n of lead) { const row = [n, askOf(n)].filter(Boolean); row.forEach((m) => { m.y = y; }); y += Math.max(...row.map(h)) + 22; }
  const o = cvNode("out"); if (o) o.y = Math.round(Math.min(top + 500, top + Math.max(0, (y - top) / 2 - h(o) / 2)));
  cvRender(true);
}
function tidy() {
  unstack();
  const br = CV.data.nodes.filter((n) => n.seeded && (n.kind === "chat" || n.kind === "board"));      // keep input, assign and output level with the middle of the branches
  if (br.length) { const mid = (Math.min(...br.map((n) => n.y)) + Math.max(...br.map((n) => n.y + 150))) / 2;
    for (const n of CV.data.nodes) if (["in", "assign", "out"].includes(n.id)) n.y = Math.round(mid - 70); }
  cvRender(true);
}
function fitTo(ns, zmin, zmax, anchor, ax = .5) {   // frame these nodes; too many to read at zmin: centre on the anchor instead
  const cv = $("#cv"); ns = ns.filter(Boolean); if (!ns.length || !cv) { CV.view = { x: 80, y: 200, z: 1 }; cvApplyView(); return; }
  const els = ns.map((n) => [n, document.querySelector(`[data-nid="${n.id}"]`)]);
  const x0 = Math.min(...ns.map((n) => n.x)), y0 = Math.min(...ns.map((n) => n.y));
  const x1 = Math.max(...els.map(([n, el]) => n.x + (el?.offsetWidth || n.width || 260))), y1 = Math.max(...els.map(([n, el]) => n.y + (el?.offsetHeight || 140)));
  const r = cv.getBoundingClientRect(), padL = CV.tree ? 250 : 36, padT = 68, W = r.width - padL - 36, H = r.height - padT - 36;
  const z = Math.max(zmin, Math.min(zmax, W / (x1 - x0 + 1), H / (y1 - y0 + 1))), a = anchor || ns[0];
  const ae = document.querySelector(`[data-nid="${a.id}"]`);
  CV.view = { z, x: (x1 - x0) * z <= W ? padL + (W - (x1 - x0) * z) / 2 - x0 * z : padL + W * ax - (a.x + (ae?.offsetWidth || a.width || 260) / 2) * z,
    y: (y1 - y0) * z <= H ? padT + (H - (y1 - y0) * z) / 2 - y0 * z : padT + H * .42 - (a.y + (ae?.offsetHeight || 140) / 2) * z };
  animView();
}
function cvFit(ids) { fitTo(ids?.length ? ids.map(cvNode) : CV.data?.nodes || [], ids?.length ? .2 : .3, 1.1, cvNode("in"), .3); }
function hotNode() {                              // where the work is: the node that ran last (in the last three days), else the input
  const t = (n) => Math.max(n.runAt || 0, Date.parse(n.at || "") || 0);
  const hot = CV.data.nodes.filter((n) => !n.gone && t(n)).sort((a, b) => t(b) - t(a))[0];
  return hot && t(hot) > Date.now() - 3 * 86400e3 ? hot.id : cvNode("in") ? "in" : CV.data.nodes[0]?.id;
}
function hops(from) {                             // distance along the wires, either way
  const d = new Map(from.map((id) => [id, 0])), q = [...from];
  while (q.length) { const x = q.shift(); for (const e of CV.data.edges) { const y = e.fromNode === x ? e.toNode : e.toNode === x ? e.fromNode : null; if (y && !d.has(y)) { d.set(y, d.get(x) + 1); q.push(y); } } }
  return d;
}
function cvFocus(id) {                            // the node and what is wired to it, up to two steps, framed at a readable size
  const n = cvNode(id); if (!n) return; const d = hops([id]);
  const near = [...d.keys()].filter((k) => d.get(k) <= 2).map(cvNode).filter((m) => m && !m.gone)
    .sort((a, b) => d.get(a.id) - d.get(b.id) || Math.abs(a.y - n.y) - Math.abs(b.y - n.y)).slice(0, 7);
  CV.sel = new Set([id]); cvRender(); fitTo(near, .62, 1, n, .5);
}
function animView() { const w = $("#cvw"); w?.classList.add("anim"); cvApplyView(); setTimeout(() => w?.classList.remove("anim"), 380); cvSave(); }

const stIcon = { running: `<span class="spin"></span>`, stale: "●", new: "○", fresh: "✓", error: "⚠", locked: "🔒" };
function nodeHtml(n) {
  const s = state(n), d = !SOURCES.has(n.kind) && s !== "stale" && dirty(n), runs = !SOURCES.has(n.kind);
  const agents = S.agents.map((a) => `<option value="${esc(a.name)}" ${a.name === n.agent ? "selected" : ""}>${esc(agentLabel(a.name))}</option>`).join("");
  const out = outOf(n), hv = (n.hist || []).length;
  let body = "";
  const qOf = n.askOf ? cvNode(n.askOf) : null, qEdited = qOf && edited(qOf);
  if (n.kind === "input" && n.askOf) body = `<textarea class="cvt" data-f="text" rows="4">${esc(n.text || "")}</textarea><div class="cvdim">${qEdited ? L("改过了：运行右边的对话，会从这一问之前分出一段新对话重问，原来的对话不动", "Edited: running the conversation asks again in a branch from before this question; the original stays") : L("这段对话问的（最后一问）。改了再运行，就从这里分支重问", "What this conversation asked (its last question). Edit and run to ask again in a branch")}</div>`;
  else if (n.kind === "input" || n.kind === "note") body = `<textarea class="cvt" data-f="text" rows="${n.kind === "input" ? 4 : 3}" placeholder="${n.kind === "input" ? L("写下要做的事：交给「指派」拆分，或直接连一个对话", "What to do: wire it to Assign to split it, or straight to a conversation") : L("笔记：连到哪个节点，哪个节点就读到它", "A note: whatever it is wired to reads it")}">${esc(n.text || "")}</textarea>`;
  else if (n.kind === "chat") body = `<div class="cvrow"><select data-f="agent"><option value="auto" ${!n.agent || n.agent === "auto" ? "selected" : ""}>${L("自动选 agent", "Auto")}</option>${agents}</select>${n.key ? `<button class="sm ghost" data-cva="peek" title="${L("在旁边看这段对话", "Read it beside the board")}">${L("看对话", "Read")}</button>` : ""}</div>
      <textarea class="cvt" data-f="text" rows="2" placeholder="${isRef(n) ? L("接着这段对话再问一句…（可空）", "Ask this conversation one more thing… (optional)") : L("要问它的话（可空：只用连进来的内容）", "What to ask (optional: just what is wired in)")}">${esc(n.text || "")}</textarea>
      ${out ? `${n.askIn || n.ask ? `<div class="cvlab">${L("回答", "Answer")}${n.turns > 1 ? ` · ${L(`共 ${n.turns} 轮`, `${n.turns} turns`)}` : ""}</div>` : ""}<div class="cvo ${n.open ? "open" : ""}">${md(out.length > 4000 && !n.open ? out.slice(0, 4000) + "…" : out)}</div>` : ""}${n.err ? `<div class="cverr">${esc(n.err)}</div>` : ""}`;
  else if (n.kind === "dispatch") body = `<div class="cvdim">${L("把连进来的话拆成几件可以同时做的事，每件派给一个 agent", "Splits what is wired in into things to do at once, one agent each")}</div>${(n.tasks || []).length ? `<ol class="cvtasks">${n.tasks.map((t) => `<li>${esc(t.title)}</li>`).join("")}</ol>` : ""}${n.err ? `<div class="cverr">${esc(n.err)}</div>` : ""}`;
  else if (n.kind === "output") body = `<textarea class="cvt" data-f="text" rows="1" placeholder="${L("汇总成什么（可空）", "Merge into what (optional)")}">${esc(n.text || "")}</textarea>${out ? `<div class="cvo ${n.open ? "open" : ""}">${md(out)}</div>` : `<div class="cvdim">${L("把连进来的各分支合成一个回答", "Merges the branches wired in into one answer")}</div>`}${n.err ? `<div class="cverr">${esc(n.err)}</div>` : ""}`;
  else if (n.kind === "skill") body = `<div class="cvdim">${esc(n.text || "")}</div><div class="cvsrc">${esc(n.source || "")}${n.category ? " · " + esc(n.category) : ""}</div>`;
  else if (n.kind === "image") body = `<img class="cvimg" src="/v1/users/${S.uid}/canvas-image?path=${encodeURIComponent(n.path)}" alt="">`;
  else if (n.kind === "watch") body = watchBody(n);
  else if (n.kind === "board") body = `${n.out ? `<div class="cvo">${esc(n.out)}</div>` : ""}<div class="cvrow"><button class="sm" data-cva="enter">${L("进入", "Enter")} ›</button>${n.count ? `<span class="cvdim">${L(`${n.count} 段对话`, `${n.count} conversations`)}</span>` : ""}${n.plan ? `<span class="pill">${L("计划", "plan")}</span>` : ""}</div>`;
  const tag = n.kind === "chat" && n.who === "agent" ? `<span class="cvtag">agent</span>` : "";
  return `<div class="cvh"><i class="pin in" data-pin="in"></i><span class="cvk">${kname(n.kind)}</span><span class="cvti" title="${esc(n.title || "")}">${esc(n.title || kname(n.kind))}</span>${tag}
      ${hv ? `<span class="cvv" data-cva="hist" title="${L("之前的版本", "Earlier versions")}">v${hv + 1}</span>` : ""}${n.bypass ? `<span class="cvtag">${L("旁路", "bypass")}</span>` : ""}
      ${runs ? `<span class="cvs ${s} ${d ? "dirty" : ""}" title="${{ running: L("运行中", "running"), stale: L("输入变了：需要重新运行", "inputs changed: run again"), new: L("还没运行", "not run yet"), fresh: L("是最新的", "up to date"), error: L("出错了", "failed"), locked: L("锁定：保留现在的结果", "locked: keeps its result") }[s]}${d ? L("；上游有要更新的", "; something before it needs a run") : ""}">${stIcon[s]}${CV.busy[n.id] && n.runAt ? `<em>${Math.round((Date.now() - n.runAt) / 1000)}s</em>` : ""}</span><button class="cvrun" data-cva="run" title="${L("运行（先运行上游过期的）", "Run (stale nodes before it first)")}">▶</button>` : ""}
      <i class="pin out" data-pin="out"></i></div><div class="cvb">${body}</div><i class="cvrs" data-rs="1"></i>`;
}
function cvRender(full) {
  const box = $("#cvn"); if (!box || !CV.data) return;
  const keep = new Set(CV.data.nodes.filter((n) => n.kind !== "group").map((n) => n.id));
  box.querySelectorAll(".cvnode").forEach((el) => { if (!keep.has(el.dataset.nid)) el.remove(); });
  renderGroups();
  for (const n of CV.data.nodes) {
    if (n.kind === "group") continue;
    let el = box.querySelector(`[data-nid="${n.id}"]`);
    if (!el) { el = document.createElement("div"); el.className = "cvnode"; el.dataset.nid = n.id; box.appendChild(el); full = true; }
    const sig = fnv(JSON.stringify(n) + state(n) + (CV.busy[n.id] ? Math.floor(Date.now() / 1000) : "") + dirty(n) + S.agents.length);
    if (el.dataset.sig !== sig && !el.contains(document.activeElement)) { el.innerHTML = nodeHtml(n); el.dataset.sig = sig; }
    el.className = `cvnode k-${n.kind} ${hidden(n) ? "hid" : ""} ${CV.sel.has(n.id) ? "sel" : ""} ${n.gone ? "gone" : ""} ${n.bypass ? "byp" : ""} ${CV.link === n.id ? "linking" : ""}`;
    el.style.left = n.x + "px"; el.style.top = n.y + "px"; el.style.width = (n.width || 260) + "px";
  }
  cvEdges(); cvBar();
}
function pinPos(n, side) {
  const g = hidden(n); if (g) return { x: g.x + (side === "out" ? GROUP_MIN.w : 0), y: g.y + 22 };            // inside a folded group: its edge
  const el = document.querySelector(`[data-nid="${n.id}"]`); return { x: n.x + (side === "out" ? (el?.offsetWidth || n.width || 260) : 0), y: n.y + PIN_Y };
}
function cvEdges() {
  const g = $("#cveg"); if (!g) return;
  g.innerHTML = CV.data.edges.map((e) => {
    const a = cvNode(e.fromNode), b = cvNode(e.toNode); if (!a || !b) return "";
    const ga = hidden(a), gb = hidden(b); if (ga && ga === gb) return "";                                      // both inside one folded group
    const p = pinPos(a, "out"), q = pinPos(b, "in"), live = CV.busy[b.id] || CV.busy[a.id];
    return `<path class="cvedge k-${a.kind} ${live ? "live" : ""} ${a.gone || b.gone ? "gone" : ""} ${CV.selEdge === e.id ? "sel" : ""}" data-eid="${e.id}" d="${curve(p.x, p.y, q.x, q.y, .5)}"/>`;
  }).join("");
}
function cvBar() {
  const bar = $("#cvbar"); if (!bar || !CV.board) return;
  const memo = new Map(), stale = CV.data.nodes.filter((n) => canCook(n) && dirty(n, memo) && ["stale", "new"].includes(state(n))).length;
  const running = Object.keys(CV.busy).length;
  bar.innerHTML = `<div class="cvcr">${(CV.board.crumbs || []).map((c, i, a) => i === a.length - 1 ? `<b>${esc(c.world === "top" ? L("顶层", "Top") : c.title)}</b>` : `<a href="#" data-cvopen="${c.world}">${esc(c.world === "top" ? L("顶层", "Top") : c.title)}</a><span>›</span>`).join("")}</div>
    <div class="cvtools"><button class="sm ${stale ? "primary" : ""}" data-cvt="runall" ${stale ? "" : "disabled"} title="${L("只运行过期的和还没运行的节点（按上下游顺序）", "Runs only nodes that are stale or not run yet, upstream first")}">▶ ${L(`运行过期的${stale ? ` (${stale})` : ""}`, `Run stale${stale ? ` (${stale})` : ""}`)}</button>
      <button class="sm ghost" data-cvt="add" title="${L("加节点（也可以右键、双击空白处或按 Tab）", "Add a node (or right-click, double-click empty space, Tab)")}">＋ ${L("节点", "Node")}</button>
      <button class="sm ghost" data-cvt="fit" title="${L("看全整块画布（F）", "Frame the board (F)")}">⤢</button>
      <button class="sm ghost" data-cvt="undo" ${CV.undo.length ? "" : "disabled"} title="${L("撤销（⌘Z）", "Undo (⌘Z)")}">↶</button>
      <button class="sm ghost" data-cvt="export" title="${L("导出成 .canvas（JSON Canvas，Obsidian 能打开）", "Export as .canvas (JSON Canvas, opens in Obsidian)")}">⇩</button>
      <button class="sm" data-cvt="back" title="${L("回到整棵世界树", "Back to the whole world tree")}">← ${L("世界树", "World tree")}</button>
      ${running ? `<span class="cvdim"><span class="spin"></span> ${L(`${running} 个在跑`, `${running} running`)}</span>` : ""}<span class="cvdim" id="cvSt"></span></div>`;
}
function cvTree() {
  const box = $("#cvtree"); if (!box) return; box.hidden = !CV.tree; if (!CV.tree) return;
  const topics = W.nodes.filter((n) => n.kind !== "leaf" && n.kind !== "aim" && !n.hidden), kids = new Map();
  for (const n of topics) if (n.parent) { if (!kids.has(n.parent)) kids.set(n.parent, []); kids.get(n.parent).push(n); }
  const root = topics.find((n) => n.kind === "root"), cur = CV.world;
  const row = (n, d) => { const id = n.kind === "root" ? "top" : n.id, ks = kids.get(n.id) || [];
    return `<div class="cvtr ${id === cur ? "cur" : ""}" style="--d:${d}" data-cvopen="${id}"><span>${esc(n.kind === "root" ? L("顶层", "Top") : n.title)}</span>${n.count ? `<em>${n.count}</em>` : ""}</div>${d < 3 ? ks.map((k) => row(k, d + 1)).join("") : ""}`; };
  box.innerHTML = `<div class="cvth"><b>${L("世界树", "World tree")}</b><span class="cvdim">${L("点一层，跳到它的蓝图", "Click a level to jump to its blueprint")}</span><button class="sm ghost" data-cvt="tree">×</button></div>
    <div class="cvtl">${root ? row(root, 0) : `<div class="cvdim">${L("世界树还没有生成：到「世界树」页生成", "Not built yet: build it on the world tree page")}</div>`}</div>`;
}
setInterval(() => { if (S.view === "canvas" && Object.keys(CV.busy).length) cvRender(); }, 1000);

/* ------------------------------------------------ editing */
function addNode(kind, at, extra = {}) {
  snap();
  const n = { id: nid(), kind, x: Math.round(at.x), y: Math.round(at.y), width: kind === "output" ? 300 : kind === "image" ? 220 : 270, title: extra.title || kname(kind), ...extra };
  if (kind === "chat" && !n.agent) n.agent = "auto";
  CV.data.nodes.push(n);
  if (CV.wire?.from) { link(CV.wire.from, n.id); CV.wire = null; }
  cvRender(); cvSave(); return n;
}
function link(from, to) {
  if (from === to || CV.data.edges.some((e) => e.fromNode === from && e.toNode === to)) return;
  const seen = new Set(), up = (id) => { if (id === from) return true; if (seen.has(id)) return false; seen.add(id); return cvOuts(id).some((n) => up(n.id)); };
  if (up(to)) { toast(L("这样会连成一个圈：数据要从左往右流", "That would make a loop: what flows must go one way")); return; }
  CV.data.edges.push({ id: "e" + nid(), fromNode: from, toNode: to, fromSide: "right", toSide: "left" });
}
function removeSel() {
  if (!CV.sel.size && !CV.selEdge) return; snap();
  if (CV.selEdge) CV.data.edges = CV.data.edges.filter((e) => e.id !== CV.selEdge);
  CV.data.nodes = CV.data.nodes.filter((n) => !CV.sel.has(n.id));
  CV.data.edges = CV.data.edges.filter((e) => !CV.sel.has(e.fromNode) && !CV.sel.has(e.toNode));
  CV.sel.clear(); CV.selEdge = null; cvRender(); cvSave();
  toast(L("删掉了：⌘Z 能撤回", "Removed: ⌘Z brings it back"));
}
function duplicate(id) {
  const n = cvNode(id); if (!n) return; const { id: _, cin, out, hist, run, key, ...rest } = n;
  const c = addNode(n.kind, { x: n.x + 30, y: n.y + 160 }, { ...rest, seeded: false, gone: false, task: n.task ? n.task + " ′" : undefined });
  CV.sel = new Set([c.id]); cvRender();
}


/* ------------------------------------------------ 分组: a frame that holds nodes (JSON Canvas's group, Blueprint's collapsed graph,
   Houdini's subnet). What is inside moves and runs together; folded, it stands as one node and the wires meet its edges. */
const GROUP_MIN = { w: 260, h: 64 };
function members(g) {
  if (g.collapsed) return (g.inside || []).map(cvNode).filter(Boolean);
  return CV.data.nodes.filter((n) => n.kind !== "group" && n.x >= g.x && n.y >= g.y && n.x + (n.width || 260) / 2 <= g.x + g.width && n.y + 40 <= g.y + g.height);
}
function hidden(n) { return n.kind === "group" ? null : CV.data.nodes.find((g) => g.kind === "group" && g.collapsed && (g.inside || []).includes(n.id)) || null; }
function makeGroup(ids, at) {
  snap();
  const ns = (ids || []).map(cvNode).filter((n) => n && n.kind !== "group");
  let g;
  if (ns.length) {
    const box = (n) => document.querySelector(`[data-nid="${n.id}"]`);
    const x0 = Math.min(...ns.map((n) => n.x)) - 24, y0 = Math.min(...ns.map((n) => n.y)) - 54;
    const x1 = Math.max(...ns.map((n) => n.x + (box(n)?.offsetWidth || n.width || 260))) + 24, y1 = Math.max(...ns.map((n) => n.y + (box(n)?.offsetHeight || 160))) + 24;
    g = { id: nid(), kind: "group", x: Math.round(x0), y: Math.round(y0), width: Math.round(x1 - x0), height: Math.round(y1 - y0), title: L("一组", "Group") };
  } else g = { id: nid(), kind: "group", x: Math.round(at.x), y: Math.round(at.y), width: 620, height: 380, title: L("一组", "Group") };
  CV.data.nodes.unshift(g); cvRender(); cvSave();
  setTimeout(() => { const v = prompt(L("这一组叫什么？", "Name this group"), ""); if (v) { g.title = v.trim(); cvRender(); cvSave(); } }, 30);
  return g;
}
function groupFold(g) {
  snap();
  if (!g.collapsed) { g.inside = members(g).map((n) => n.id); g.open = { w: g.width, h: g.height }; g.collapsed = true; }
  else { g.collapsed = false; if (g.open) { g.width = g.open.w; g.height = g.open.h; } g.inside = []; }
  cvRender(); cvSave();
}
function groupState(g) {
  const ms = members(g), st = ms.map(state);
  return { n: ms.length, running: st.filter((x) => x === "running").length, stale: ms.filter((m) => canCook(m) && dirty(m)).length };
}
function renderGroups() {
  const box = $("#cvn"); const gs = CV.data.nodes.filter((n) => n.kind === "group"), keep = new Set(gs.map((g) => g.id));
  box.querySelectorAll(".cvgroup").forEach((el) => { if (!keep.has(el.dataset.gid)) el.remove(); });
  for (const g of gs) {
    let el = box.querySelector(`[data-gid="${g.id}"]`);
    if (!el) { el = document.createElement("div"); el.className = "cvgroup"; el.dataset.gid = g.id; box.prepend(el); }
    const st = groupState(g);
    el.className = `cvgroup ${g.collapsed ? "folded" : ""} ${CV.sel.has(g.id) ? "sel" : ""}`;
    el.style.left = g.x + "px"; el.style.top = g.y + "px";
    el.style.width = (g.collapsed ? GROUP_MIN.w : g.width) + "px"; el.style.height = (g.collapsed ? GROUP_MIN.h : g.height) + "px";
    el.innerHTML = `<div class="gh"><span class="cvk">${kname("group")}</span><b>${esc(g.title || "")}</b><span class="cvdim">${L(`${st.n} 个节点`, `${st.n} nodes`)}${st.running ? ` · <span class="spin"></span> ${st.running}` : ""}${st.stale ? ` · <span class="gst">${L(`${st.stale} 个过期`, `${st.stale} stale`)}</span>` : ""}</span><span class="grow"></span>
      <button class="cvrun" data-gact="run" title="${L("运行组里过期的节点", "Run what is stale inside")}">▶</button><button class="cvrun" data-gact="fold" title="${g.collapsed ? L("展开", "Unfold") : L("折叠成一个节点", "Fold into one node")}">${g.collapsed ? "▸" : "▾"}</button></div>${g.collapsed ? `<i class="pin in gpin"></i><i class="pin out gpin"></i>` : `<i class="grs" data-grs="1"></i>`}`;
  }
}
async function groupRun(g) {
  const ms = members(g), todo = ms.filter((n) => canCook(n) && dirty(n));
  const sinks = todo.filter((n) => !cvOuts(n.id).some((o) => todo.includes(o)));
  await Promise.all(sinks.map((n) => cook(n.id)));
}

/* ------------------------------------------------ cooking */
async function cook(id, opts = {}) {
  if (CV.cooking[id]) return CV.cooking[id];
  const n = cvNode(id); if (!n) return;
  const p = (async () => {
    for (const u of cvIns(id)) if (!u.gone && !u.lock && !isRef(n) && dirty(u) && canCook(u)) await cook(u.id);
    if (!opts.force && state(n) === "fresh") return;                        // what it was cooked from came out the same
    if (!canCook(n)) { if (n.kind === "chat") { n.err = L("这个节点还没有内容：在节点里写要问的话，或者连一个输入进来", "Nothing to ask yet: write in the node or wire something in"); cvRender(); } return; }
    const sig = inSig(n); n.err = null; CV.busy[id] = true; n.running = true; n.runAt = Date.now(); cvRender(); cvSave();
    try {
      if (n.kind === "chat") await cookChat(n);
      else if (n.kind === "dispatch") await cookDispatch(n, opts);
      else if (n.kind === "output") await cookOutput(n);
      else if (n.kind === "watch") await cookWatch(n);
      n.cin = sig;
      if (isRef(n)) n.cin = inSig(n);                                     // its question now reads what it was asked
    } catch (err) { n.err = err.message; }
    finally { delete CV.busy[id]; n.running = false; cvRender(); if (unstack()) cvRender(); cvSave(); if (CV.peek === id) peekReload(n); if (typeof padSync === "function") padSync(); }
  })();
  CV.cooking[id] = p; try { await p; } finally { delete CV.cooking[id]; }
}
function keepVersion(n) { if (n.out) n.hist = [...(n.hist || []), { out: n.out, at: n.at, run: n.run, agent: n.used, key: n.key, ask: n.ask0 }].slice(-12); }
function inputText(n, seen = new Set()) {         // the words that started this branch: the nearest input before it
  if (seen.has(n.id)) return ""; seen.add(n.id);
  for (const u of cvIns(n.id)) { if (u.kind === "input" && u.text) return u.text; const t = inputText(u, seen); if (t) return t; }
  return "";
}
async function imageData(path) {
  const b = await fetch(`/v1/users/${S.uid}/canvas-image?path=${encodeURIComponent(path)}`).then((r) => r.blob());
  return await new Promise((ok) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.readAsDataURL(b); });
}
async function cookRef(n) {                      // an existing conversation: an edited question asks again in a branch; a new line carries it on
  const q = askOf(n), own = (n.text || "").trim(), base = n.base || n.key, again = edited(n);
  let key = n.key, history = [], turns = [];
  if (base?.startsWith("chat:") || S.allChats?.some((c) => c.key === base)) { try { turns = (await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(again ? base : key)}`)).turns || []; } catch {} }
  else if (base?.startsWith("c:")) { try { turns = ((await api(`/v1/users/${S.uid}/imported/${base.slice(2)}`)).turns || []).map((t) => ({ ...t, role: t.role === "user" ? "user" : "agent" })); } catch {} }   // imported from another app: carried on as a new PGA conversation
  const hist = (ts) => ts.slice(-12).map((t) => ({ role: t.role === "user" ? "user" : "assistant", text: t.text }));
  let text;
  if (again) {
    const lastQ = turns.map((t) => t.role).lastIndexOf("user");
    history = hist(lastQ > 0 ? turns.slice(0, lastQ) : []);
    key = null;
    if (n.prev && base?.startsWith("chat:")) { try { key = (await api(`/v1/users/${S.uid}/chats/branch`, { body: { from: base, upto: n.prev } })).key; } catch {} }
    if (!key) { key = `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; if (!turns.length && n.out) history = [{ role: "assistant", text: n.out }]; }
    text = [q.text.trim(), own].filter(Boolean).join("\n\n");
  } else {
    history = hist(turns);
    if (!key?.startsWith("chat:") && !S.allChats?.some((c) => c.key === key)) { history = n.out ? [{ role: "assistant", text: n.out }] : []; n.was = n.was || key; key = `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
    text = own;
  }
  const lastRun = turns.filter((t) => t.run).pop()?.run;
  const acc = S.acc?.[key] || S.acc?.["*new"] || {};
  n.base = base; n.key = key; cvSave(true);
  if (!CV.peek || CV.peek === n.id) setTimeout(() => peek(n, true), 600);
  const r = await api(`/v1/users/${S.uid}/agents/ask`, { body: { text, agent: n.agent || "auto", conversation: key, history,
    world: CV.world !== "top" ? CV.world : undefined, access: acc.access || "read", folder: acc.folder || "", mcp: !!acc.mcp } });
  if (!r?.text && r?.error) throw new Error(r.error);
  keepVersion(n); n.out = r.text || ""; n.used = r.agent; n.run = r.run_id; n.at = new Date().toISOString();
  if (again) { n.ask0 = q.text; n.turns = (history.filter((t) => t.role === "user").length || 0) + 1; }
  else { q && (q.text = own); n.ask0 = own; n.text = ""; n.prev = lastRun || n.prev; n.base = key; n.turns = (n.turns || 1) + 1; }
  loadChats(); loadTimeline?.();
}
async function cookChat(n) {
  if (isRef(n)) return cookRef(n);
  const ups = isRef(n) ? [] : cvIns(n.id).filter((u) => !u.gone && u.id !== n.from), ctx = [], images = [];
  for (const u of ups) {
    if (u.kind === "image") { try { images.push({ name: u.title, data: await imageData(u.path) }); ctx.push(`[${L("附上了图片", "picture attached")}: ${u.title}]`); } catch {} continue; }
    if (u.kind === "skill") { ctx.push(`<skill name="${u.title}" source="${u.source || ""}">\n${(u.out || "").slice(0, 12000)}\n</skill>\n${L(`请按上面这个技能（${u.title}）来做。`, `Follow the skill above (${u.title}).`)}`); continue; }
    if (u.kind === "dispatch") {
      const sib = cvOuts(u.id).filter((x) => x.task), i = sib.indexOf(n);
      const orig = inputText(u);
      if (orig) ctx.push(`${L("原来的消息", "The original message")}:\n${orig}`);
      if (n.task && sib.length > 1) ctx.push(L(`（这是从上面那条消息里拆出来的第 ${i + 1} 项，共 ${sib.length} 项：${sib.map((x, j) => `${j + 1}. ${x.task}`).join("；")}。其余各项另有 agent 在同时处理。只做你这一项；不要改动和这一项无关的地方，也不要撤销别人的改动。）`,
        `(This is item ${i + 1} of ${sib.length} split from the message above: ${sib.map((x, j) => `${j + 1}. ${x.task}`).join("; ")}. Other agents are doing the other items at the same time. Do only yours; do not touch what is not part of it, nor undo others' changes.)`));
      continue;
    }
    const t = outOf(u); if (t) ctx.push(u.kind === "input" ? t : `【${kname(u.kind)} · ${u.title}】\n${t.slice(0, 12000)}`);
  }
  const own = (n.text || "").trim();
  const text = own ? [own, ...(ctx.length ? [L("—— 连进来的内容 ——", "—— What is wired in ——"), ...ctx] : [])].join("\n\n") : ctx.join("\n\n");     // the ask first: it also names the conversation
  if (!text) throw new Error(L("没有要问的内容", "Nothing to ask"));
  let key = n.key, history = [];
  if (key && key.startsWith("chat:")) { try { const r = await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(key)}`); history = (r.turns || []).slice(-12).map((t) => ({ role: t.role === "user" ? "user" : "assistant", text: t.text })); } catch {} }
  else { if (key && n.out) { history = [{ role: "assistant", text: n.out }]; n.was = n.was || key; } key = `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }
  const acc = S.acc?.[key] || S.acc?.["*new"] || {};
  n.key = key; n.ask = text.slice(0, 400); cvSave(true);
  if (n.pad || !CV.peek || CV.peek === n.id) setTimeout(() => peek(n, true), 600);        // its conversation opens on the right as it starts
  const r = await api(`/v1/users/${S.uid}/agents/ask`, { body: { text, agent: n.agent || "auto", conversation: key, history, images,
    world: CV.world !== "top" ? CV.world : undefined, access: acc.access || "read", folder: acc.folder || "", mcp: !!acc.mcp } });
  if (!r?.text && r?.error) throw new Error(r.error);
  keepVersion(n); n.out = r.text || ""; n.used = r.agent; n.run = r.run_id; n.at = new Date().toISOString();
  if (!n.title || n.title === kname("chat")) n.title = (own || n.task || text).replace(/\s+/g, " ").slice(0, 28);
  loadChats(); loadTimeline?.();
}
async function resume(n) {                       // a run that was going when the page was closed: its answer lands in its conversation
  if (!n.key) { delete CV.busy[n.id]; n.running = false; return; }
  const since = n.runAt || 0;
  for (let i = 0; i < 400 && CV.data?.nodes.includes(n); i++) {
    try {
      const r = await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(n.key)}`);
      const a = (r.turns || []).filter((t) => t.role === "agent" && new Date(t.at).getTime() > since - 5000).pop();
      if (a) { keepVersion(n); n.out = a.text || ""; n.err = !a.text && a.error && a.error !== "None" ? a.error : null; n.run = a.run; n.used = a.agent; n.cin = inSig(n); break; }
    } catch {}
    await new Promise((ok) => setTimeout(ok, 6000));
  }
  delete CV.busy[n.id]; n.running = false; cvRender(); cvSave();
}
async function cookDispatch(n, opts) {
  const text = cvIns(n.id).filter((u) => !u.gone).map(outOf).filter(Boolean).join("\n\n").trim();
  if (!text) throw new Error(L("先在「输入」里写下要做的事，连到这里", "Write what to do in an Input and wire it here"));
  const r = await api(`/v1/users/${S.uid}/chats/split`, { body: { text, context: CV.board?.title || "" } });
  const tasks = (r.tasks || []).length ? r.tasks : [{ title: text.replace(/\s+/g, " ").slice(0, 24), text }];
  keepVersion(n); n.tasks = tasks.map((t) => ({ title: t.title, kind: t.kind })); n.out = tasks.map((t, i) => `${i + 1}. ${t.title}`).join("\n");
  const kids = cvOuts(n.id).filter((x) => x.task);
  const outs = [...new Set(cvOuts(n.id).flatMap((k) => cvOuts(k.id)))].filter((x) => x.kind === "output");     // where its branches flow together
  const bottom = Math.max(n.y, ...cvOuts(n.id).map((k) => k.y + 170));
  let y = kids.length ? Math.max(...kids.map((k) => k.y)) + 190 : bottom + 20;
  const mine = [];
  for (const t of tasks) {
    let k = kids.find((x) => x.task === t.title);
    if (k) { if (k.text !== t.text) k.text = t.text; k.gone = false; }
    else { k = { id: nid(), kind: "chat", x: n.x + 380, y, width: 280, title: t.title, task: t.title, text: t.text, agent: "auto" }; y += 190; CV.data.nodes.push(k); link(n.id, k.id); }
    for (const o of outs) link(k.id, o.id);
    mine.push(k);
  }
  for (const k of kids) if (!mine.includes(k)) k.gone = true;          // no longer one of the tasks: greyed out, still there
  cvRender(); cvSave();
  if (opts.noRun) return;
  setTimeout(async () => {                       // the branches run at the same time; then whatever merges them
    await Promise.all(mine.map((k) => cook(k.id)));
    for (const o of outs) if (canCook(o) && dirty(o)) cook(o.id);
  }, 0);
}
async function cookOutput(n) {
  const ins = cvIns(n.id).filter((u) => !u.gone && outOf(u)), asked = ins.filter((u) => !u.seeded);     // what was asked here, if anything; else what the topic already holds
  const parts = (asked.length ? asked : ins).map((u) => ({ title: u.title, text: outOf(u) }));
  const r = await api(`/v1/users/${S.uid}/canvas/merge`, { body: { question: (n.text || "").trim() || inputText(n), parts } });
  keepVersion(n); n.out = r.text; n.at = new Date().toISOString();
}
async function runStale() {
  const memo = new Map(), todo = CV.data.nodes.filter((n) => canCook(n) && dirty(n, memo));
  const sinks = todo.filter((n) => !cvOuts(n.id).some((o) => todo.includes(o)));      // cooking the ends cooks what they need first
  await Promise.all(sinks.map((n) => cook(n.id)));
}
async function derive(id) {                      // a new conversation growing out of this one: it sees everything before
  const n = cvNode(id); if (!n) return;
  let key;
  if (n.kind === "chat" && n.key?.startsWith("chat:")) {
    try { let run = n.run; if (!run) { const r = await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(n.key)}`); run = (r.turns || []).filter((t) => t.run).pop()?.run; }
      if (run) key = (await api(`/v1/users/${S.uid}/chats/branch`, { body: { from: n.key, upto: run } })).key; } catch (err) { toast(err.message); }
  }
  const below = cvOuts(id).filter((x) => x.from === id).length;
  const c = addNode("chat", { x: n.x + (n.width || 270) + 110, y: n.y + below * 190 }, { key, from: key ? id : undefined, agent: n.agent || "auto", title: L("接着问", "Follow-up") });
  link(id, c.id); CV.sel = new Set([c.id]); cvRender(); cvSave();
  setTimeout(() => document.querySelector(`[data-nid="${c.id}"] textarea`)?.focus(), 50);
}

/* ------------------------------------------------ the node search (Blueprint's palette, Houdini's Tab menu) */
async function palette(cx, cy, at) {
  CV.pal = { at: at || toWorld(cx, cy), q: "", i: 0 };
  if (!CV.palette) { try { CV.palette = await api(`/v1/users/${S.uid}/canvas-palette`); } catch { CV.palette = { skills: [], images: [] }; } }
  document.querySelector(".cvpal")?.remove();
  const el = document.createElement("div"); el.className = "cvpal card";
  el.style.left = Math.min(cx, innerWidth - 360) + "px"; el.style.top = Math.min(cy, innerHeight - 440) + "px";
  el.innerHTML = `<input id="cvq" placeholder="${L("搜节点、agent、技能、图片、对话、主题…", "Search nodes, agents, skills, pictures, conversations, topics…")}" autocomplete="off"><div class="cvpl" id="cvpl"></div>`;
  document.body.appendChild(el); palList(); $("#cvq").focus();
}
function palItems() {
  const q = (CV.pal?.q || "").toLowerCase(), hit = (...xs) => !q || xs.some((x) => String(x || "").toLowerCase().includes(q));
  const fresh = Date.now() / 1000 - 14 * 86400, out = [];
  const add = (sec, label, sub, make) => out.push({ sec, label, sub, make });
  for (const k of ["input", "dispatch", "chat", "output", "watch", "note", "group"]) if (hit(kname(k), k, k === "group" ? "包含 框 子图" : k === "watch" ? "看门狗 检查 审核" : "")) add(L("基本", "Basics"), kname(k), { input: L("一段要做的事", "Something to do"), dispatch: L("拆成几件同时做", "Split into things to do at once"), chat: L("问一个 agent", "Ask an agent"), output: L("合成一个回答", "Merge into one answer"), watch: L("连进来的都停下后，派一个 agent 核对它们是否真的做完；没做完就让它接着做", "Once everything wired in has stopped, an agent checks it is really done, and sends back what is not"), note: L("给连到的节点看的笔记", "A note for whatever it is wired to"), group: L("一个框：框住的节点一起移动、一起运行，可以折叠成一个节点", "A frame: what is inside moves and runs together, and folds into one node") }[k], (at) => k === "group" ? makeGroup(null, at) : addNode(k, at, k === "watch" ? { agent: "auto", auto: true, rounds: 0, max: 3 } : {}));
  for (const a of S.agents) if (hit(a.name, "agent")) add("Agent", L(`对话 · ${a.name}`, `Ask · ${a.name}`), S.acctOf?.[a.name] || "", (at) => addNode("chat", at, { agent: a.name, title: a.name }));
  for (const s of CV.palette?.skills || []) if (hit(s.name, s.description, s.category, s.source)) add(L("技能", "Skills"), s.name, `${s.source === "hermes" ? "Hermes" : "Claude Code"}${s.category ? " · " + s.category : ""}${s.mtime > fresh ? " · " + L("新", "new") : ""} — ${s.description}`, async (at) => {
    let t = ""; try { t = (await api(`/v1/users/${S.uid}/canvas-skill?path=${encodeURIComponent(s.path)}`)).text; } catch {}
    addNode("skill", at, { title: s.name, text: s.description, source: s.source, category: s.category, path: s.path, out: t }); });
  for (const k of (S.forest?.knowledge || []).filter((k) => !["user", "world"].includes(k.system))) if (hit(k.title, k.gist)) add(L("知识库", "Library"), k.title, k.gist || "", (at) => addNode("note", at, { title: k.title, text: [k.gist, k.brief].filter(Boolean).join("\n\n"), doc: k.id }));
  for (const im of CV.palette?.images || []) if (hit(im.name, "图片", "image", "picture")) add(L("上传过的图片", "Uploaded pictures"), im.name, new Date(im.mtime * 1000).toLocaleDateString(), (at) => addNode("image", at, { title: im.name, path: im.path }), im.path);
  for (const x of (typeof recentItems === "function" ? recentItems() : []).slice(0, 300)) if (q && hit(x.title, x.item)) add(L("已有的对话", "Conversations"), x.title || x.item, ago(x.at), (at) => addNode("chat", at, { key: x.item, title: (x.title || "").slice(0, 60), seeded: false, agent: x.agent || "auto", out: "" }));
  for (const w of W.nodes.filter((w) => w.kind === "topic" || w.kind === "plan")) if (q && hit(w.title, w.summary)) add(L("世界树的主题", "Topics"), w.title, (w.summary || "").slice(0, 80), (at) => addNode("board", at, { world: w.id, title: w.title, out: (w.summary || "").slice(0, 600), count: w.count }));
  return out.slice(0, 120);
}
function palList() {
  const box = $("#cvpl"); if (!box) return; const xs = palItems(); CV.pal.items = xs; CV.pal.i = Math.min(CV.pal.i, Math.max(0, xs.length - 1));
  let sec = ""; box.innerHTML = xs.map((x, i) => `${x.sec !== sec ? `<div class="cvps">${esc((sec = x.sec))}</div>` : ""}<div class="cvpi ${i === CV.pal.i ? "on" : ""}" data-pi="${i}"><b>${esc(x.label)}</b><span>${esc(String(x.sub || "").slice(0, 120))}</span></div>`).join("")
    || `<div class="cvdim" style="padding:10px">${L("没有找到", "Nothing found")}</div>`;
  box.querySelector(".cvpi.on")?.scrollIntoView({ block: "nearest" });
}
async function palPick(i) {
  const x = CV.pal?.items?.[i]; if (!x) return; const at = CV.pal.at, wire = CV.wire, skillFor = CV.skillFor, before = new Set(CV.data.nodes.map((n) => n.id));
  palClose(); CV.wire = wire; await x.make(at); CV.wire = null;
  const made = CV.data.nodes.find((n) => !before.has(n.id));
  if (made && skillFor) { link(made.id, skillFor); cvRender(); cvSave(); }
}
function palClose() { document.querySelector(".cvpal")?.remove(); CV.pal = null; CV.wire = null; CV.skillFor = null; const w = $("#cvwire"); if (w) w.setAttribute("d", ""); }

function nodeMenu(cx, cy, id) {
  const n = cvNode(id); if (!n) return; document.querySelector(".cvpal")?.remove();
  const it = (a, t, dis) => `<button data-cvm="${a}" ${dis ? "disabled" : ""}>${t}</button>`;
  const el = document.createElement("div"); el.className = "cvpal cvmenu card"; el.dataset.id = id;
  el.style.left = Math.min(cx, innerWidth - 240) + "px"; el.style.top = Math.min(cy, innerHeight - 380) + "px";
  el.innerHTML = [!SOURCES.has(n.kind) && it("run", state(n) === "fresh" ? L("重新运行（保留之前的版本）", "Run again (keeps the earlier version)") : L("运行", "Run")),
    it("derive", L("派生新节点：从这里接着问", "Derive: carry on from here")), it("link", L("链接到另一个节点…", "Link to another node…")),
    n.kind === "chat" && it("skill", L("调用技能…", "Use a skill…")),
    n.key && it("peek", L("在旁边看这段对话", "Read it beside the board")), n.key && it("open", L("全屏打开这段对话", "Open the conversation")),
    n.kind === "board" && it("enter", L("进入子画布", "Enter the sub-board")),
    (n.hist || []).length && it("hist", L(`之前的版本（${n.hist.length}）`, `Earlier versions (${n.hist.length})`)),
    (n.out || "").length > 600 && it("expand", n.open ? L("收起", "Collapse") : L("展开全部", "Show all")),
    !SOURCES.has(n.kind) && it("bypass", n.bypass ? L("取消旁路", "Stop bypassing") : L("旁路：直接把输入传下去", "Bypass: pass inputs through")),
    !SOURCES.has(n.kind) && it("lock", n.lock ? L("解锁", "Unlock") : L("锁定：保留现在的结果", "Lock: keep this result")),
    CV.sel.size > 1 && it("pack", L(`把选中的 ${CV.sel.size} 个打包成一组（⌘G）`, `Group the ${CV.sel.size} selected (⌘G)`)),
    it("dup", L("复制", "Duplicate")), it("del", L("删除（⌘Z 可撤回）", "Delete (⌘Z to undo)"))].filter(Boolean).join("");
  document.body.appendChild(el);
}
async function nodeAct(a, id, el) {
  const n = cvNode(id); if (!n) return;
  if (a === "run") cook(id, { force: true });
  else if (a === "derive") derive(id);
  else if (a === "link") { CV.link = id; cvRender(); toast(L("点另一个节点，把它们连起来（Esc 取消）", "Click another node to link them (Esc cancels)")); }
  else if (a === "skill") { const r = el?.getBoundingClientRect?.() || { left: 200, top: 200 }; CV.wire = null; await palette(r.left, r.top, { x: n.x - 330, y: n.y + 40 }); CV.skillFor = id; $("#cvq").placeholder = L("搜一个技能，接到这个对话上", "Search a skill to wire into this conversation"); }
  else if (a === "peek") peek(n);
  else if (a === "open") { openItem(n.key) ; if (!recentItems().some((y) => y.item === n.key)) { S.chat = n.key; show("chats"); } }
  else if (a === "enter") cvOpen(n.world);
  else if (a === "hist") versions(n);
  else if (a === "expand") { n.open = !n.open; cvRender(); cvSave(); }
  else if (a === "bypass") { snap(); n.bypass = !n.bypass; cvRender(); cvSave(); }
  else if (a === "lock") { snap(); n.lock = !n.lock; cvRender(); cvSave(); }
  else if (a === "dup") duplicate(id);
  else if (a === "pack") makeGroup([...CV.sel]);
  else if (a === "del") { CV.sel = new Set([id]); removeSel(); }
}
function versions(n) {
  const all = [...(n.hist || []), { out: n.out, at: n.at, agent: n.used, cur: true }];
  modal(`<h2>${L("这个节点的各个版本", "This node's versions")}</h2><div class="muted" style="font-size:13px;margin-bottom:10px">${L("每次重新运行，之前的结果都留在这里；选一个版本作为它现在的输出，后面的节点会变成过期。", "Each run keeps the earlier result here; pick one as its output now, and what comes after turns stale.")}</div>
    ${all.map((v, i) => `<div class="cvver ${v.cur ? "cur" : ""}"><div class="cvvh"><b>v${i + 1}</b><span class="cvdim">${esc(v.agent || "")} ${v.at ? when(v.at) : ""}</span><span class="grow"></span>${v.cur ? `<span class="pill">${L("现在用的", "in use")}</span>` : `<button class="sm" data-cvver="${i}" data-id="${n.id}">${L("用这个版本", "Use this one")}</button>`}</div><div class="cvo open">${md(String(v.out || "").slice(0, 3000))}</div></div>`).reverse().join("")}`);
}
function peek(n, quiet) {                         // the conversation, docked on the right: the conversation page itself (?embed=1), to read and carry on
  if (!n?.key) { if (!quiet) toast(L("它还没开始：先运行", "Not started yet: run it first")); return; }
  const prev = cvNode(CV.peek); if (prev && prev !== n) syncFromChat(prev);
  CV.peek = n.id; $("#cvside").hidden = false; $("#vCanvas").classList.add("side");
  $("#cvsh").innerHTML = `<b title="${esc(n.title || "")}">${esc(n.title || "")}</b><span class="cvdim">${esc(n.used || (n.agent !== "auto" ? n.agent : "") || "")}</span><span class="grow"></span><button class="sm ghost" data-cvd="focus" title="${L("在画布上找到它", "Find it on the canvas")}">◎</button><button class="sm ghost" data-cvd="open">${L("全屏打开", "Open")}</button><button class="sm ghost" data-cvd="close" title="${L("收起", "Close")}">×</button>`;
  const f = $("#cvsf");
  if (f.dataset.key !== n.key) {
    const q = new URLSearchParams({ view: "chats", embed: "1" }); if (S.allChats?.some((c) => c.key === n.key) || n.key.startsWith("chat:")) q.set("c", n.key); else q.set("item", n.key);
    if (AS_UID) q.set("as", AS_UID); if (Q.get("lang")) q.set("lang", Q.get("lang"));
    f.src = "/?" + q; f.dataset.key = n.key;
  }
  setTimeout(() => { const el = document.querySelector(`[data-nid="${n.id}"]`), m = $("#cv").getBoundingClientRect();      // the canvas just got narrower: keep the node in sight
    if (el) { const r = el.getBoundingClientRect(); if (r.right > m.right - 10 || r.left < m.left || r.top > m.bottom - 40 || r.bottom < m.top + 60) cvFocus(n.id); } }, 60);
}
function peekClose(skipSync) {
  if (!skipSync) syncFromChat(cvNode(CV.peek));
  CV.peek = null; const f = $("#cvsf"); if (f) { f.dataset.key = ""; f.src = "about:blank"; }
  $("#cvside") && ($("#cvside").hidden = true); $("#vCanvas")?.classList.remove("side");
}
function peekReload(n) { const f = $("#cvsf"); if (f && n?.key && f.dataset.key === n.key) f.src = f.src; }
async function syncFromChat(n) {                  // you carried on in the conversation on the right: the node shows its latest answer (the old one kept as a version)
  if (!n?.key || n.seeded || CV.busy[n.id]) return;
  try { const r = await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(n.key)}`); const a = (r.turns || []).filter((t) => t.role === "agent" && t.text).pop();
    if (a && a.text !== n.out && (!n.at || Date.parse(a.at) > Date.parse(n.at) + 1000)) { keepVersion(n); n.out = a.text; n.at = a.at; n.run = a.run; n.used = a.agent; cvRender(); cvSave(); } } catch {}
}
function sideGrip() {
  $("#cvsGrip").addEventListener("pointerdown", (e) => {
    e.preventDefault(); const v = $("#vCanvas"); $(".app").classList.add("resizing"); $("#cvsf").style.pointerEvents = "none";
    const mv = (ev) => { const r = v.getBoundingClientRect(), w = Math.round(Math.max(320, Math.min(r.width - 320, r.right - ev.clientX))); v.style.setProperty("--cvsw", w + "px"); try { localStorage.setItem("pga_cv_side", w); } catch {} };
    const up = () => { document.removeEventListener("pointermove", mv); document.removeEventListener("pointerup", up); $(".app").classList.remove("resizing"); $("#cvsf").style.pointerEvents = ""; cvRender(); };
    document.addEventListener("pointermove", mv); document.addEventListener("pointerup", up);
  });
}
setInterval(() => { if (S.view === "canvas" && CV.peek && !document.hidden) syncFromChat(cvNode(CV.peek)); }, 20000);
if (Q.get("embed") && Q.get("item")) {            // a conversation that is not a PGA chat (an imported session), opened in the docked panel
  const k = Q.get("item"), t = setInterval(() => { if (typeof recentItems === "function" && recentItems().some((y) => y.item === k)) { clearInterval(t); openItem(k); } }, 400);
  setTimeout(() => clearInterval(t), 20000);
}

/* ------------------------------------------------ pointer and keys */
function cvBind() {
  const cv = $("#cv");
  cv.addEventListener("wheel", (e) => {
    if (e.target.closest(".cvo, textarea, .cvtasks") && !e.ctrlKey) { const s = e.target.closest(".cvo, textarea, .cvtasks"); if (s.scrollHeight > s.clientHeight) return; }
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {                 // pinch or ⌘-wheel: zoom where the pointer is
      const r = cv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top, z0 = CV.view.z, z = Math.max(.12, Math.min(2.2, z0 * Math.exp(-e.deltaY * .0075)));
      CV.view = { z, x: mx - (mx - CV.view.x) * z / z0, y: my - (my - CV.view.y) * z / z0 };
    } else { CV.view.x -= e.deltaX; CV.view.y -= e.deltaY; }
    cvApplyView(); clearTimeout(CV.vt); CV.vt = setTimeout(() => cvSave(), 800);
  }, { passive: false });
  cv.addEventListener("pointerdown", (e) => {
    CV.mouse = { x: e.clientX, y: e.clientY };
    if (e.button === 1 || (e.button === 0 && !e.target.closest(".cvnode") && !e.target.closest(".cvedge"))) {
      if (CV.link) { CV.link = null; cvRender(); }
      if (e.shiftKey && e.button === 0) { const p = toWorld(e.clientX, e.clientY); CV.box = { x0: p.x, y0: p.y, cx: e.clientX, cy: e.clientY }; }
      else { CV.pan = { x: e.clientX, y: e.clientY, vx: CV.view.x, vy: CV.view.y, moved: false }; cv.classList.add("panning"); }
      cv.setPointerCapture(e.pointerId); return;
    }
    const gh = e.target.closest(".cvgroup .gh"), gr = e.target.closest("[data-grs]");
    if ((gh || gr) && e.button === 0 && !e.target.closest("button")) {
      const g = cvNode(e.target.closest(".cvgroup").dataset.gid); snap();
      if (gr) CV.grs = { g, x: e.clientX, y: e.clientY, w: g.width, h: g.height };
      else { const ms = members(g); CV.sel = new Set([g.id]); CV.drag = { x: e.clientX, y: e.clientY, ids: [g.id, ...ms.map((m) => m.id)], start: [g, ...ms].map((n) => [n.x, n.y]), moved: false, id: g.id }; }
      cv.setPointerCapture(e.pointerId); e.preventDefault(); cvRender(); return;
    }
    const pin = e.target.closest("[data-pin]"), el = e.target.closest(".cvnode");
    if (pin && el && e.button === 0) {
      const id = el.dataset.nid;
      if (pin.dataset.pin === "out") CV.wire = { from: id };
      else { const ed = CV.data.edges.filter((x) => x.toNode === id).pop(); if (ed) { snap(); CV.data.edges = CV.data.edges.filter((x) => x !== ed); CV.wire = { from: ed.fromNode }; cvEdges(); } else CV.wire = { to: id }; }
      e.preventDefault(); cv.setPointerCapture(e.pointerId); return;
    }
    if (e.target.closest("[data-rs]") && el) { const n = cvNode(el.dataset.nid); CV.rs = { n, x: e.clientX, w: n.width || 260 }; snap(); cv.setPointerCapture(e.pointerId); e.preventDefault(); return; }
    if (el && e.button === 0 && !e.target.closest("textarea, select, input, button, a, .cvo.open")) {
      const id = el.dataset.nid;
      if (CV.link && CV.link !== id) { snap(); link(CV.link, id); CV.link = null; cvRender(); cvSave(); return; }
      if (e.shiftKey || e.metaKey) { CV.sel.has(id) ? CV.sel.delete(id) : CV.sel.add(id); } else if (!CV.sel.has(id)) CV.sel = new Set([id]);
      CV.selEdge = null;
      CV.drag = { x: e.clientX, y: e.clientY, ids: [...CV.sel], start: [...CV.sel].map((i) => { const n = cvNode(i); return [n.x, n.y]; }), moved: false, id };
      cv.setPointerCapture(e.pointerId); cvRender();
    }
  });
  cv.addEventListener("pointermove", (e) => {
    CV.mouse = { x: e.clientX, y: e.clientY };
    if (CV.pan) { const dx = e.clientX - CV.pan.x, dy = e.clientY - CV.pan.y; if (Math.abs(dx) + Math.abs(dy) > 3) CV.pan.moved = true; CV.view.x = CV.pan.vx + dx; CV.view.y = CV.pan.vy + dy; cvApplyView(); return; }
    if (CV.box) { const b = $("#cvbox"), r = cv.getBoundingClientRect(); b.hidden = false; Object.assign(b.style, { left: Math.min(CV.box.cx, e.clientX) - r.left + "px", top: Math.min(CV.box.cy, e.clientY) - r.top + "px", width: Math.abs(e.clientX - CV.box.cx) + "px", height: Math.abs(e.clientY - CV.box.cy) + "px" }); return; }
    if (CV.rs) { CV.rs.n.width = Math.max(180, Math.round(CV.rs.w + (e.clientX - CV.rs.x) / CV.view.z)); cvRender(); return; }
    if (CV.grs) { const g = CV.grs.g; g.width = Math.max(300, Math.round(CV.grs.w + (e.clientX - CV.grs.x) / CV.view.z)); g.height = Math.max(160, Math.round(CV.grs.h + (e.clientY - CV.grs.y) / CV.view.z)); renderGroups(); return; }
    if (CV.wire && (CV.wire.from || CV.wire.to)) {
      const p = toWorld(e.clientX, e.clientY), w = $("#cvwire");
      if (CV.wire.from) { const a = pinPos(cvNode(CV.wire.from), "out"); w.setAttribute("d", curve(a.x, a.y, p.x, p.y, .5)); }
      else { const b = pinPos(cvNode(CV.wire.to), "in"); w.setAttribute("d", curve(p.x, p.y, b.x, b.y, .5)); }
      return;
    }
    if (CV.drag) {
      const dx = (e.clientX - CV.drag.x) / CV.view.z, dy = (e.clientY - CV.drag.y) / CV.view.z;
      if (!CV.drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      if (!CV.drag.moved) { snap(); CV.drag.moved = true; }
      CV.drag.ids.forEach((id, i) => { const n = cvNode(id); n.x = Math.round(CV.drag.start[i][0] + dx); n.y = Math.round(CV.drag.start[i][1] + dy); const el = document.querySelector(`[data-nid="${id}"], [data-gid="${id}"]`); if (el) { el.style.left = n.x + "px"; el.style.top = n.y + "px"; } });
      cvEdges();
    }
  });
  cv.addEventListener("pointerup", async (e) => {
    if (CV.pan) { const moved = CV.pan.moved; CV.pan = null; cv.classList.remove("panning"); if (moved) cvSave(); else if (!e.target.closest(".cvnode")) { CV.sel.clear(); CV.selEdge = null; cvRender(); } return; }
    if (CV.box) {
      const p = toWorld(e.clientX, e.clientY), x0 = Math.min(p.x, CV.box.x0), x1 = Math.max(p.x, CV.box.x0), y0 = Math.min(p.y, CV.box.y0), y1 = Math.max(p.y, CV.box.y0);
      CV.sel = new Set(CV.data.nodes.filter((n) => n.x < x1 && n.x + (n.width || 260) > x0 && n.y < y1 && n.y + 80 > y0).map((n) => n.id));
      CV.box = null; $("#cvbox").hidden = true; cvRender(); return;
    }
    if (CV.rs) { CV.rs = null; cvSave(); return; }
    if (CV.grs) { CV.grs = null; cvRender(); cvSave(); return; }
    if (CV.wire && (CV.wire.from || CV.wire.to)) {
      const over = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.classList?.contains("cvnode"));
      const w = CV.wire;
      if (over) { const id = over.dataset.nid; snap(); if (w.from) link(w.from, id); else link(id, w.to); CV.wire = null; $("#cvwire").setAttribute("d", ""); cvRender(); cvSave(); return; }
      if (w.from) { await palette(e.clientX, e.clientY); CV.wire = w; return; }      // dropped on empty space: pick what to make there, already wired
      CV.wire = null; $("#cvwire").setAttribute("d", ""); return;
    }
    if (CV.drag) {
      const d = CV.drag; CV.drag = null;
      if (d.moved) { cvSave(); return; }
      const n = cvNode(d.id);
      if (n?.kind === "chat" && n.key && !e.target.closest(".cvrow")) peek(n);              // one click: read the conversation beside the board
    }
  });
  cv.addEventListener("dblclick", (e) => {
    const el = e.target.closest(".cvnode");
    if (!el) { if (!e.target.closest(".cvedge")) palette(e.clientX, e.clientY); return; }
    if (e.target.closest("textarea, select, input, button")) return;
    const n = cvNode(el.dataset.nid);
    if (n?.kind === "board") cvOpen(n.world);
    else if (n?.key) nodeAct("open", n.id);
    else if (n) { const v = prompt(L("节点名字", "Node name"), n.title || ""); if (v != null) { snap(); n.title = v.trim() || kname(n.kind); cvRender(); cvSave(); } }
  });
  cv.addEventListener("contextmenu", (e) => {
    e.preventDefault(); palClose();
    const ed = e.target.closest(".cvedge"); if (ed) { CV.selEdge = ed.dataset.eid; CV.sel.clear(); cvEdges(); const m = document.createElement("div"); m.className = "cvpal cvmenu card"; m.style.left = e.clientX + "px"; m.style.top = e.clientY + "px"; m.innerHTML = `<button data-cvedel="${ed.dataset.eid}">${L("删除这根连线", "Remove this wire")}</button>`; document.body.appendChild(m); return; }
    const ge = e.target.closest(".cvgroup .gh"); if (ge) { const id = ge.parentElement.dataset.gid; const m = document.createElement("div"); m.className = "cvpal cvmenu card"; m.dataset.id = id; m.style.left = e.clientX + "px"; m.style.top = e.clientY + "px";
      m.innerHTML = `<button data-gm="run">${L("运行组里过期的节点", "Run what is stale inside")}</button><button data-gm="fold">${cvNode(id)?.collapsed ? L("展开", "Unfold") : L("折叠成一个节点", "Fold into one node")}</button><button data-gm="rename">${L("改名", "Rename")}</button><button data-gm="ungroup">${L("解散（节点留下）", "Ungroup (nodes stay)")}</button>`; document.body.appendChild(m); return; }
    const el = e.target.closest(".cvnode"); if (el) { if (!CV.sel.has(el.dataset.nid)) { CV.sel = new Set([el.dataset.nid]); cvRender(); } nodeMenu(e.clientX, e.clientY, el.dataset.nid); return; }
    palette(e.clientX, e.clientY);
  });
  cv.addEventListener("click", (e) => { const ed = e.target.closest(".cvedge"); if (ed) { CV.selEdge = ed.dataset.eid; CV.sel.clear(); cvRender(); } });
  cv.addEventListener("focusin", (e) => { if (e.target.matches(".cvt")) snap(); });
  cv.addEventListener("input", (e) => {
    const el = e.target.closest(".cvnode"), f = e.target.dataset.f; if (!el || !f) return; const n = cvNode(el.dataset.nid); if (!n) return;
    n[f] = e.target.value; if (f === "text" && n.kind === "input" && (!n.title || n.title === kname("input") || n.autoTitle)) { n.title = n.text.replace(/\s+/g, " ").slice(0, 24) || kname("input"); n.autoTitle = true; el.querySelector(".cvti").textContent = n.title; }
    clearTimeout(CV.it); CV.it = setTimeout(() => { cvRender(); cvSave(); }, 500);
  });
  cv.addEventListener("change", (e) => { const el = e.target.closest(".cvnode"), f = e.target.dataset.f; if (!el || !f) return; const n = cvNode(el.dataset.nid); if (n) { snap(); n[f] = e.target.value; cvRender(); cvSave(); } });
  cv.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && e.target.matches(".cvt")) { e.preventDefault(); const el = e.target.closest(".cvnode"); const n = cvNode(el.dataset.nid);
      n.text = e.target.value; e.target.blur(); if (n.kind === "input") { const nx = cvOuts(n.id).find(canCook); if (nx) cook(nx.id); else toast(L("把它连到「指派」或一个对话上再运行", "Wire it to Assign or a conversation to run it")); } else cook(n.id); }
  });
}
document.addEventListener("keydown", (e) => {
  if (S.view !== "canvas") return;
  if (CV.pal) {
    if (e.key === "Escape") { palClose(); return; }
    if (!document.querySelector(".cvpal #cvq")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); CV.pal.i = Math.max(0, Math.min((CV.pal.items || []).length - 1, CV.pal.i + (e.key === "ArrowDown" ? 1 : -1))); palList(); return; }
    if (e.key === "Enter") { e.preventDefault(); palPick(CV.pal.i); return; }
    return;
  }
  if (e.target.closest?.("input, textarea, select, [contenteditable]")) return;
  if (e.key === "Escape") { CV.link = null; CV.sel.clear(); document.querySelector(".cvmenu")?.remove(); cvRender(); return; }
  if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeSel(); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(!e.shiftKey); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d" && CV.sel.size === 1) { e.preventDefault(); duplicate([...CV.sel][0]); return; }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "g" && CV.sel.size) { e.preventDefault(); makeGroup([...CV.sel]); return; }
  if (e.key === "f" || e.key === "F") { cvFit([...CV.sel]); return; }
  if (e.key === "Tab") { e.preventDefault(); palette(CV.mouse.x || innerWidth / 2, CV.mouse.y || innerHeight / 2); }
});
document.addEventListener("input", (e) => { if (e.target.id === "cvq" && CV.pal) { CV.pal.q = e.target.value; CV.pal.i = 0; palList(); } });
document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".cvpal") && document.querySelector(".cvpal")) palClose(); }, true);
document.addEventListener("click", async (e) => {
  const op = e.target.closest("[data-cvopen]"); if (op) { e.preventDefault(); e.stopPropagation(); cvOpen(op.dataset.cvopen); return; }
  const pi = e.target.closest("[data-pi]"); if (pi) { await palPick(Number(pi.dataset.pi)); return; }
  const m = e.target.closest("[data-cvm]"); if (m) { const menu = m.closest(".cvmenu"), id = menu.dataset.id; const r = menu.getBoundingClientRect(); menu.remove(); nodeAct(m.dataset.cvm, id, { getBoundingClientRect: () => r }); return; }
  const ga = e.target.closest("[data-gact]"); if (ga) { const g = cvNode(ga.closest(".cvgroup").dataset.gid); if (g) ga.dataset.gact === "run" ? groupRun(g) : groupFold(g); return; }
  const gm = e.target.closest("[data-gm]"); if (gm) { const menu = gm.closest(".cvmenu"), g = cvNode(menu.dataset.id); menu.remove(); if (!g) return;
    if (gm.dataset.gm === "run") groupRun(g); else if (gm.dataset.gm === "fold") groupFold(g);
    else if (gm.dataset.gm === "rename") { const v = prompt(L("这一组叫什么？", "Name this group"), g.title || ""); if (v != null) { g.title = v.trim(); cvRender(); cvSave(); } }
    else { snap(); if (g.collapsed) groupFold(g); CV.data.nodes = CV.data.nodes.filter((n) => n !== g); cvRender(); cvSave(); } return; }
  const ed = e.target.closest("[data-cvedel]"); if (ed) { snap(); CV.data.edges = CV.data.edges.filter((x) => x.id !== ed.dataset.cvedel); ed.closest(".cvmenu").remove(); CV.selEdge = null; cvRender(); cvSave(); return; }
  const v = e.target.closest("[data-cvver]"); if (v) { const n = cvNode(v.dataset.id), i = Number(v.dataset.cvver); if (n?.hist?.[i]) { snap(); const h = n.hist[i]; n.hist[i] = { out: n.out, at: n.at, run: n.run, agent: n.used }; n.out = h.out; n.at = h.at; n.run = h.run; n.used = h.agent; cvRender(); cvSave(); document.querySelector(".modal")?.remove(); } return; }
  const a = e.target.closest("[data-cva]"); if (a && S.view === "canvas") { const el = a.closest(".cvnode"); if (el) { e.stopPropagation(); nodeAct(a.dataset.cva, el.dataset.nid, a); } return; }
  const d = e.target.closest("[data-cvd]"); if (d) { const n = cvNode(CV.peek); if (d.dataset.cvd === "focus" && n) { cvFocus(n.id); return; } if (d.dataset.cvd === "open" && n) nodeAct("open", n.id); peekClose(); return; }
  const t = e.target.closest("[data-cvt]"); if (!t) return;
  const k = t.dataset.cvt;
  if (k === "runall") runStale();
  else if (k === "add") { const r = t.getBoundingClientRect(); const c = $("#cv").getBoundingClientRect(); palette(r.left, r.bottom + 6, toWorld(c.left + c.width / 2, c.top + c.height / 2)); }
  else if (k === "fit") cvFit();
  else if (k === "undo") undo(true);
  else if (k === "back") wtLeave();
  else if (k === "tree") { CV.tree = !CV.tree; try { localStorage.setItem("pga_cv_tree", CV.tree ? "1" : "0"); } catch {} cvTree(); cvBar(); }
  else if (k === "export") cvExport();
});
function cvExport() {      // JSON Canvas 1.0: text and file nodes, edges right → left
  const nodes = CV.data.nodes.map((n) => { const el = document.querySelector(`[data-nid="${n.id}"]`), base = { id: n.id, x: n.x, y: n.y, width: el?.offsetWidth || n.width || 260, height: el?.offsetHeight || 160 };
    if (n.kind === "group") return { ...base, width: n.width, height: n.height, type: "group", label: n.title || "" };
    return n.kind === "image" ? { ...base, type: "file", file: n.path } : { ...base, type: "text", text: `## ${n.title || kname(n.kind)}\n\n${n.text ? n.text + "\n\n" : ""}${n.out && n.kind !== "skill" ? n.out : ""}`.trim() }; });
  const doc = { nodes, edges: CV.data.edges.map((e) => ({ id: e.id, fromNode: e.fromNode, fromSide: "right", toNode: e.toNode, toSide: "left" })) };
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" })); a.download = `${(CV.board?.title || "board").replace(/[\\/:*?"<>|]/g, "_")}.canvas`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ------------------------------------------------ into the page: the default view, a rail entry */
const _showCv = show;
show = function (view, opts) {
  if (view === "canvas") { S.view = "canvas"; closeCtx?.(); ["Home", "Tree", "Chats", "Notes", "Looks", "Graph"].forEach((v) => { const el = $("#v" + v); if (el) el.hidden = true; }); $("#vCanvas").hidden = false; history.replaceState(null, "", qs()); renderRail(); showCanvas(); return; }
  $("#vCanvas").hidden = true; return _showCv(view, opts);
};
const _renderRailCv = renderRail;
renderRail = function () { _renderRailCv(); $("#toGraph")?.classList.toggle("on", S.view === "graph" || S.view === "canvas");
  document.querySelectorAll(".padnav [data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === S.view || (b.dataset.view === "graph" && S.view === "canvas"))); };
window.addEventListener("pga:look", () => { if (S.view === "canvas") cvRender(true); });
