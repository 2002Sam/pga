/* 项目: a conversation belongs to the folder of the world tree it is filed in. On its page the right panel shows that
   project — its name (click to fold) and every conversation in it, the one you are in marked; the strip on the left lists
   what you asked lately across the whole project, your words only, newest first: click one and that conversation opens at
   that question. */

const PJ = { qs: {}, open: (() => { try { return localStorage.getItem("pga_pj_open") !== "0"; } catch { return true; } })() };
const pjKey = () => S.chat || (S.imp ? `c:${S.imp.cid}` : null);
function pjFolder(key) {                           // the folder a conversation is filed in (the leaf's parent topic)
  const leaf = key && W.nodes.find((n) => n.kind === "leaf" && n.ref === key);
  const f = leaf && W.byId.get(leaf.parent);
  return f && f.kind !== "root" ? f : null;
}
function pjLeaves(f) {                             // every conversation under the folder (and its subfolders), newest first
  const out = [], todo = [f.id];
  while (todo.length) { const id = todo.pop(); for (const n of W.nodes) if (n.parent === id) { if (n.kind === "leaf") { if (!n.hidden) out.push(n); } else todo.push(n.id); } }
  return out.sort((a, b) => String(b.last || "").localeCompare(String(a.last || "")));
}
function pjGo(key, run) {                          // open that conversation (on the stage: its page) at that question
  const here = pjKey();
  const jump = (doc) => { const t = run && doc?.getElementById(`t-${run}`); if (t) t.scrollIntoView({ block: "start", behavior: "smooth" }); };
  if (key === here) { jump(document); return; }
  try {
    const P = window.parent;
    if (P !== window && P.stOpen) { P.stOpen(key); if (run) setTimeout(() => { try { const w = P.ST.nodes.find((n) => n.type === "win" && n.key === key);
      jump(P.document.querySelector(`.stnode[data-nid="${w.id}"] iframe`)?.contentDocument); } catch {} }, 1800); return; }
  } catch {}
  if (key.startsWith("chat:")) { S.chat = key; S.imp = null; loadChat(key).then(() => setTimeout(() => jump(document), 300)); renderChat(); }
  else if (typeof openItem === "function") openItem(key);
}
async function pjRender() {
  const box = $("#ctree"), v = $("#vChats"); if (!box || !v || S.view !== "chats") return;
  if (!W.nodes.length) { await wtFetch(); if (!W.nodes.length) return; }
  const key = pjKey(), f = pjFolder(key);
  box.hidden = false;
  if (!f) {
    box.innerHTML = `<div class="pjh"><b>📁 ${L("项目", "Project")}</b></div><div class="cvdim pjnone">${L("这段对话还没放进世界树的哪个文件夹。点顶部的「✦ 整理」，它就会归到自己的项目里。", "This conversation is not in a folder of the world tree yet. ✦ Tidy at the top files it into its project.")}</div>`;
    v.classList.remove("hasqs"); $("#cqs")?.remove(); return;
  }
  const leaves = pjLeaves(f);
  box.innerHTML = `<div class="pjh" data-pjfold title="${L("点一下收起 / 展开", "Click to fold / unfold")}"><b>📁 ${esc(f.title)}</b><span class="pjc">${leaves.length}</span><span class="grow"></span><i>${PJ.open ? "⌄" : "›"}</i></div>`
    + (PJ.open ? `<div class="pjl">${leaves.map((n) => `<div class="pjr ${n.ref === key ? "on" : ""}" data-pjgo="${esc(n.ref)}" title="${esc(n.title)}">${esc(n.title)}</div>`).join("")}</div>` : "");
  pjStrip(f, key);
}
async function pjStrip(f, key) {                   // the left strip: the project's questions
  const v = $("#vChats"); let s = $("#cqs");
  if (!s) { v.insertAdjacentHTML("afterbegin", `<aside class="cqs" id="cqs"><div class="cqh"></div><div class="cql"></div></aside>`); s = $("#cqs"); }
  v.classList.add("hasqs");
  s.querySelector(".cqh").innerHTML = `<b>${L("这个项目里问过的", "Asked in this project")}</b><span class="cvdim">${esc(f.title)}</span>`;
  const c = PJ.qs[f.id];
  if (!c || Date.now() - c.t > 30000) {
    if (!c) s.querySelector(".cql").innerHTML = `<div class="cvdim" style="padding:8px">…</div>`;
    try { const r = await api(`/v1/users/${S.uid}/world/${f.id}/questions?limit=120`); PJ.qs[f.id] = { t: Date.now(), xs: r.questions || [] }; } catch { PJ.qs[f.id] = { t: Date.now(), xs: [] }; }
  }
  const xs = PJ.qs[f.id].xs; let day = "";
  s.querySelector(".cql").innerHTML = xs.map((q) => { const g = q.at ? dayGroup(q.at) : ""; const head = g !== day ? `<div class="cqg">${esc((day = g))}</div>` : "";
    return head + `<div class="cqi ${q.key === key ? "here" : ""}" data-pjgo="${esc(q.key)}" data-pjrun="${esc(q.run || "")}" title="${esc(q.title)}">${esc(q.text)}<span>${esc(q.title)}</span></div>`; }).join("")
    || `<div class="cvdim" style="padding:8px">${L("这个项目里还没有问题", "No questions in this project yet")}</div>`;
}
const _renderRightPJ = renderRight;
renderRight = function (...a) { const r = _renderRightPJ(...a); pjRender(); return r; };
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-pjfold]")) { PJ.open = !PJ.open; try { localStorage.setItem("pga_pj_open", PJ.open ? "1" : "0"); } catch {} pjRender(); return; }
  const g = e.target.closest("[data-pjgo]"); if (g) { e.preventDefault(); pjGo(g.dataset.pjgo, g.dataset.pjrun || ""); }
});
