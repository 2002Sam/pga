/* PGA app · the tree by hand, pane borders, and boot. Plain scripts sharing one global scope, loaded in order by app.html. */
/* ------------------------------------------------ the tree by hand: + for a new node, drag to move or link, swipe to cut */
const DR = {};
/* the borders between panes: hold and drag; each width is remembered */
const SPLITS = { railw: [".app", 180, 420], treew: ["#vTree", 240, -380], tlw: ["#vChats", 260, -380] };
function applySplits() { for (const k of Object.keys(SPLITS)) { const v = store.get("pga_split_" + k); if (v) $(SPLITS[k][0]).style.setProperty("--" + k, v + "px"); } }
document.addEventListener("pointerdown", (e) => {
  const sp = e.target.closest?.(".split"); if (!sp || e.button !== 0) return;
  e.preventDefault(); const k = sp.dataset.split, [sel, min, maxR] = SPLITS[k], box = $(sel), r = box.getBoundingClientRect();
  $(".app").classList.add("resizing"); sp.classList.add("on");
  const move = (ev) => { const max = maxR < 0 ? r.width + maxR : maxR, v = Math.round(Math.max(min, Math.min(max, ev.clientX - r.left))); box.style.setProperty("--" + k, v + "px"); store.set("pga_split_" + k, v); };
  const up = () => { document.removeEventListener("pointermove", move); document.removeEventListener("pointerup", up); $(".app").classList.remove("resizing"); sp.classList.remove("on");
    if (S.view === "tree" && S.tree) drawTree(false); if (S.view === "chats") renderTimeline(); };
  document.addEventListener("pointermove", move); document.addEventListener("pointerup", up);
});
function setMini(on) {
  S.mini = on; store.set("pga_rail_mini", on ? "1" : "0");
  $(".app").classList.toggle("mini", on); $("#fold").textContent = "«"; $("#fold").title = on ? L("展开", "Expand") : L("收起", "Collapse");
  setTimeout(() => { if (S.tree && S.view === "tree") drawTree(false); if (S.view === "chats") renderTimeline(); }, 230);
}
function branchFrom(id) {
  if (!nodeOf(id)) return;
  if (S.node !== id) select(id);
  S.branchFrom = id; S.bud = null; S.drawer = false; renderDrawer(); renderHead(); renderCont(); $("#tnText")?.focus();
}
const svgScale = () => { const r = $("#treeSvg").getBoundingClientRect(); return (S.layout?.W || r.width) / (r.width || 1); };
const nodeAt = (x, y, not) => { for (const el of document.elementsFromPoint(x, y)) { const g = el.closest?.("[data-tnode]"); if (g && g.dataset.tnode !== not) return g.dataset.tnode; } return null; };
$("#treeSvg").addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  const g = e.target.closest(".tn");
  if (g) { Object.assign(DR, { node: g.dataset.tnode, x0: e.clientX, y0: e.clientY, moving: false }); return; }
});
document.addEventListener("pointermove", (e) => {
  if (DR.node) {
    if (!DR.moving && Math.hypot(e.clientX - DR.x0, e.clientY - DR.y0) < 6) return;
    DR.moving = true; closeCtx();
    const k = svgScale(), dx = (e.clientX - DR.x0) * k, dy = (e.clientY - DR.y0) * k, n = S.layout.by.get(DR.node); if (!n) return;
    document.querySelectorAll(`[data-tnode="${CSS.escape(DR.node)}"]`).forEach((el) => {
      if (el.classList.contains("tn")) { el.setAttribute("transform", `translate(${n.x + dx},${n.y + (S.layout.flip ? -dy : dy)})`); el.classList.add("drag"); }
      else if (el.tagName === "text") el.setAttribute("transform", `translate(${dx},${dy})`);
    });
    const over = nodeAt(e.clientX, e.clientY, DR.node);
    document.querySelectorAll(".tn.drop").forEach((x) => x.classList.remove("drop"));
    if (over) document.querySelector(`.tn[data-tnode="${CSS.escape(over)}"]`)?.classList.add("drop");
    DR.over = over;
    let tip = $(".dragtip"); if (!tip) { tip = document.createElement("div"); tip.className = "dragtip"; document.body.appendChild(tip); }
    tip.textContent = over ? L(`放开：链接到「${(nodeOf(over)?.title || "").slice(0, 16)}」`, `Release: link to “${(nodeOf(over)?.title || "").slice(0, 20)}”`) : L("放开：移到这里", "Release: move it here");
    tip.style.left = e.clientX + 14 + "px"; tip.style.top = e.clientY + 14 + "px";
  }
});
document.addEventListener("pointerup", async (e) => {
  if (DR.node) {
    const id = DR.node, moved = DR.moving, over = DR.over; DR.node = null; DR.moving = false; DR.over = null; $(".dragtip")?.remove();
    if (moved) {
      DR.suppress = true; setTimeout(() => { DR.suppress = false; }, 50);
      const n = nodeOf(id), k = svgScale(), dx = (e.clientX - DR.x0) * k, dy = (e.clientY - DR.y0) * k;
      try {
        if (over) { await api(`/v1/thought-nodes/${id}/links`, { body: { to: over } }); toast(L("已链接：从其中一个继续时，agent 会读到另一个", "Linked: continuing from one, agents read the other")); }
        else { const p = n?.pos || { dx: 0, dy: 0 }; await api(`/v1/thought-nodes/${id}`, { method: "PATCH", body: { pos: { dx: (p.dx || 0) + dx, dy: (p.dy || 0) + (S.layout.flip ? -dy : dy) } } }); }
      } catch (err) { toast(err.message); }
      await loadTree(true); drawTree(false);
    }
  }
});

async function boot() {
  setMini(store.get("pga_rail_mini") === "1"); applySplits();
  if (!S.uid) { try { S.uid = (await api("/healthz")).owner; } catch {} }
  await Promise.all([loadForest().catch(() => {}), loadChats(), api(`/v1/users/${S.uid}/console`).then((d) => { S.agents = (d.agents || []).filter((a) => a.enabled !== false && a.name !== "?"); }).catch(() => {}),
    api(`/v1/agents`).then((d) => { const A = d.agents || {}; S.acctOf = Object.fromEntries(Object.entries(A).map(([k, v]) => [k, v.account || ""])); }).catch(() => {})]);
  show(S.view === "tree" && !S.aim ? "home" : S.view);
  setInterval(() => { loadForest().catch(() => {}); if (S.view === "tree") loadTree(true).catch(() => {}); if (S.view === "chats" && !S.sending) { loadChats(); loadTimeline(); } }, 20000);
}
boot();
