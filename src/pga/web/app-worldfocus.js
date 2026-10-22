/* PGA app · the world tree's branch view: what used to be the separate canvas, now one level of the world tree laid out
   horizontally. There are two pages: the conversations by time (对话) and the world tree (世界树).

   - Clicking a node of the tree (3D or 2D) zooms into it while turning its branch level. That level opens as a row,
     left to right:
     · its ancestors, back to the root;
     · the level itself, with its summary and what you can do to it (add a sub-topic, rename, rewrite the summary,
       remove);
     · its sub-topics, and each conversation as what it asked → its answer;
     · on top, a new input → assign; at the end, the output.
   - Everything the canvas did works here: cooking, versions, groups, the watchdog, the conversation docked on the right.
   - ← 世界树 turns it back into the tree. */

/* ------------------------------------------------ going in and out */
async function wtEnter(n, from) {
  if (!n) return;
  const v = $("#vGraph"), r = v.getBoundingClientRect(), ox = (from?.x ?? r.left + r.width / 2) - r.left, oy = (from?.y ?? r.top + r.height / 2) - r.top;
  const ang = Math.max(-180, Math.min(180, from?.angle || 0));
  CV.enter = { ox, oy, ang };
  const world = n.kind === "root" ? "top" : n.id;
  if (v.animate && S.view === "graph") {         // into the node: closer, and the branch turns level
    await v.animate([{ transformOrigin: `${ox}px ${oy}px`, transform: "none", opacity: 1 },
                     { transformOrigin: `${ox}px ${oy}px`, transform: `rotate(${-ang}deg) scale(2.6)`, opacity: 0 }], { duration: 360, easing: "cubic-bezier(.5,0,.75,0)" }).finished.catch(() => {});
  }
  CV.world = world; CV.want = n.kind === "leaf" ? n.id : "here";
  show("canvas");
  const c = $("#vCanvas");
  c.animate?.([{ transformOrigin: `${ox}px ${oy}px`, transform: `rotate(${ang}deg) scale(.28)`, opacity: 0 },
                { transformOrigin: `${ox}px ${oy}px`, transform: "none", opacity: 1 }], { duration: 520, easing: "cubic-bezier(.2,.8,.2,1)" });
  await CV.ready;
  if (n.kind === "leaf") { const c = CV.data?.nodes.find((x) => x.world === n.id && x.kind === "chat"); if (c) peek(c, true); }    // a conversation: its row, and the conversation itself on the right
}
async function wtLeave() {
  const c = $("#vCanvas"), e = CV.enter || { ox: c.clientWidth / 2, oy: c.clientHeight / 2, ang: 0 };
  if (c.animate) await c.animate([{ transformOrigin: `${e.ox}px ${e.oy}px`, transform: "none", opacity: 1 },
                                  { transformOrigin: `${e.ox}px ${e.oy}px`, transform: `rotate(${e.ang}deg) scale(.3)`, opacity: 0 }], { duration: 320, easing: "cubic-bezier(.5,0,.75,0)" }).finished.catch(() => {});
  peekClose?.(true);
  show("graph");
  $("#vGraph").animate?.([{ transformOrigin: `${e.ox}px ${e.oy}px`, transform: `rotate(${-e.ang}deg) scale(2.4)`, opacity: 0 },
                          { transformOrigin: `${e.ox}px ${e.oy}px`, transform: "none", opacity: 1 }], { duration: 480, easing: "cubic-bezier(.2,.8,.2,1)" });
}

/* ------------------------------------------------ the level, laid out as a branch */
function branchLayout() {
  if (!CV.data) return;
  CV.data.nodes = CV.data.nodes.filter((n) => !n.eph); CV.data.edges = CV.data.edges.filter((e) => !e.eph);
  const root = W.nodes.find((n) => n.kind === "root"), topic = CV.world === "top" ? root : W.byId.get(CV.world);
  const chain = []; for (let p = topic?.parent && W.byId.get(topic.parent); p; p = p.parent && W.byId.get(p.parent)) chain.unshift(p);
  const kids = topic ? W.nodes.filter((k) => k.parent === topic.id && !k.hidden) : [];
  const here = { id: "here", eph: true, here: true, kind: "board", world: CV.world, title: topic && topic.kind !== "root" ? topic.title : L("顶层", "Top"),
    out: topic?.summary || "", count: topic?.count || kids.filter((k) => k.kind === "leaf").length, width: 300, x: 0, y: 0 };
  const anc = chain.map((p, i) => ({ id: "anc-" + p.id, eph: true, kind: "board", world: p.kind === "root" ? "top" : p.id, title: p.kind === "root" ? L("顶层", "Top") : p.title,
    out: "", width: 230, x: -300 * (chain.length - i), y: 0 }));
  CV.data.nodes.push(...anc, here);
  const E = (a, b) => CV.data.edges.push({ id: `eph-${a}-${b}`, eph: true, fromNode: a, toNode: b });
  for (let i = 0; i < anc.length; i++) E(anc[i].id, anc[i + 1]?.id || "here");
  const X = { q: 380, row: 380, chat: 720, out: 1090 };
  const lead = CV.data.nodes.filter((n) => n.seeded && (n.kind === "board" || n.kind === "chat")).sort((a, b) => (!!a.gone - !!b.gone) || (a.row ?? 1e9) - (b.row ?? 1e9));
  const padIn = (c) => cvIns(c.id).find((u) => u.pad && u.kind === "input");
  const pads = CV.data.nodes.filter((n) => n.pad && n.kind === "chat").sort((a, b) => a.y - b.y);        // ideas handed out from the notepad: rows too
  for (const n of lead) { n.x = n.kind === "board" ? X.row : X.chat; const q = askOf(n); if (q) q.x = X.q; E("here", q ? q.id : n.id); }
  for (const c of pads) { c.x = X.chat; const q = padIn(c); if (q) { q.x = X.q; E("here", q.id); } }
  const tasks = cvNode("assign") ? cvOuts("assign").filter((k) => k.task) : [];
  if (tasks.length) X.out = 1460;
  for (const id of ["in", "assign", "out"]) { const n = cvNode(id); if (n) n.x = id === "in" ? X.q : id === "assign" ? X.chat : X.out; }
  if (cvNode("in")) E("here", "in");
  cvRender(true);
  const h = (n) => document.querySelector(`[data-nid="${n.id}"]`)?.offsetHeight || 150, mid = h(here) / 2;
  const rows = [...pads.map((c) => [c, padIn(c)].filter(Boolean)), ...lead.map((n) => [n, askOf(n)].filter(Boolean))], H = rows.reduce((t, r) => t + Math.max(...r.map(h)) + 22, 0);
  const top = (cvNode("in") ? Math.max(h(cvNode("in")), h(cvNode("assign") || here)) + 46 : 0);
  let y = Math.round(mid - (H + top) / 2) + top;
  for (const id of ["in", "assign"]) if (cvNode(id)) cvNode(id).y = y - top;
  for (const r of rows) { r.forEach((m) => { m.y = y; }); y += Math.max(...r.map(h)) + 22; }
  let ty = cvNode("assign")?.y ?? 0;
  for (const k of tasks) { k.x = 1090; k.y = ty; ty += h(k) + 22; }
  for (const a of anc) a.y = Math.round(mid - h(a) / 2);
  const o = cvNode("out"); if (o) o.y = Math.round(mid - h(o) / 2);
  cvRender(true);
}

/* ------------------------------------------------ changing the tree from here */
const _nodeHtmlWF = nodeHtml;
nodeHtml = function (n) {
  let h = _nodeHtmlWF(n);
  if (n.here) h = h.replace(/<div class="cvrow"><button class="sm" data-cva="enter">[\s\S]*?<\/div>/, `<div class="cvrow cvwrap">
      <button class="sm" data-wf="add">＋ ${L("子主题", "Sub-topic")}</button><button class="sm ghost" data-wf="rename">${L("改名", "Rename")}</button>
      <button class="sm ghost" data-wf="summary">${L("改概括", "Summary")}</button>${CV.world !== "top" ? `<button class="sm ghost" data-wf="move">${L("移到…", "Move…")}</button><button class="sm ghost" data-wf="remove">${L("删除这一层", "Remove level")}</button>` : ""}</div>`);
  else if (n.eph) h = h.replace(/<div class="cvrow"><button class="sm" data-cva="enter">[\s\S]*?<\/div>/, `<div class="cvrow"><button class="sm" data-cva="enter">‹ ${L("回到这一层", "Back to this level")}</button></div>`);
  return h;
};
const _nodeMenuWF = nodeMenu;
nodeMenu = function (cx, cy, id) {
  const n = cvNode(id); if (n?.eph) return;
  _nodeMenuWF(cx, cy, id);
  const m = document.querySelector(".cvmenu"); if (!m || !n?.seeded || !n.world) return;
  const items = n.kind === "board"
    ? [["rename", L("改这个主题的名字", "Rename this topic")], ["move", L("移到别的主题下…", "Move under another topic…")], ["remove", L("删除这个主题（下面的上移一层）", "Remove this topic (what is under it moves up)")]]
    : [["gist", L("改这段对话的主旨", "Edit its gist")], ["move", L("移到别的主题下…", "Move to another topic…")], ["remove", L("移出世界树（对话还在）", "Take it out of the tree (the conversation stays)")]];
  m.insertAdjacentHTML("beforeend", `<hr>${items.map(([a, t]) => `<button data-wfn="${a}" data-wid="${n.world}">${t}</button>`).join("")}`);
};
async function wfAct(a, wid) {
  const n = W.byId.get(wid) || (wid === "top" ? W.nodes.find((x) => x.kind === "root") : null); if (!n) return;
  try {
    if (a === "add") { const v = prompt(L("新主题的名字", "Name of the new topic"), ""); if (!v) return; await api(`/v1/world/${n.id}/children`, { body: { title: v } }); }
    else if (a === "rename") { const v = prompt(L("新名字", "New name"), n.title); if (!v) return; await api(`/v1/world/${n.id}`, { method: "PATCH", body: { title: v } }); }
    else if (a === "summary") { const v = prompt(L("这一层的概括（之后自动更新不会覆盖你写的）", "This level's summary (later updates keep yours)"), n.summary || ""); if (v == null) return; await api(`/v1/world/${n.id}`, { method: "PATCH", body: { summary: v } }); }
    else if (a === "gist") { const v = prompt(L("这段对话的主旨（一句话）", "This conversation's gist (one line)"), n.gist || ""); if (v == null) return; await api(`/v1/world/${n.id}`, { method: "PATCH", body: { gist: v } }); }
    else if (a === "move") {
      const opts = W.nodes.filter((x) => x.kind !== "leaf" && x.id !== n.id && x.id !== n.parent);
      const names = opts.map((x, i) => `${i + 1}. ${"  ".repeat(Math.max(0, x.depth - 1))}${x.kind === "root" ? L("顶层", "Top") : x.title}`).join("\n");
      const v = prompt(L(`移到哪个主题下？输入编号：\n${names}`, `Move under which topic? Type its number:\n${names}`), ""); const to = opts[Number(v) - 1]; if (!to) return;
      await api(`/v1/world/${n.id}`, { method: "PATCH", body: { parent: to.id } });
    }
    else if (a === "remove") {
      if (!confirm(n.kind === "leaf" ? L("把这段对话移出世界树？（它还在「对话」里）", "Take this conversation out of the tree? (It stays in your chats.)") : L(`删除主题「${n.title}」？它下面的主题和对话会移到上一层。`, `Remove “${n.title}”? What is under it moves up a level.`))) return;
      await api(`/v1/world/${n.id}`, { method: "DELETE" });
      if (n.id === CV.world) { await wtFetch(true); return cvOpen(n.parent && W.byId.get(n.parent)?.kind !== "root" ? n.parent : "top"); }
      CV.data.nodes = CV.data.nodes.filter((x) => x.world !== n.id && !(x.askOf && cvNode(x.askOf)?.world === n.id));
    }
  } catch (err) { toast(err.message); return; }
  await wtFetch(true); await cvLoad(CV.world, CV.sel.size ? [...CV.sel][0] : "here");
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-wf]"); if (b) { e.stopPropagation(); wfAct(b.dataset.wf, CV.world === "top" ? "top" : CV.world); return; }
  const m = e.target.closest("[data-wfn]"); if (m) { m.closest(".cvmenu")?.remove(); wfAct(m.dataset.wfn, m.dataset.wid); }
}, true);
