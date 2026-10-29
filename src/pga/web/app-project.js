/* 项目: conversations are shown by project — the folder each ran in. On a conversation's page the strip on the left lists
   every project (name ▾) with its conversations; this one's project is open, and under this conversation are the
   questions you asked in it (click one: it scrolls there). 所有对话 on the stage groups the same way. A refreshed
   page starts at its latest words. */

const PJ = { qs: {}, open: (() => { try { return localStorage.getItem("pga_pj_open") !== "0"; } catch { return true; } })() };
const pjKey = () => S.chat || (S.imp ? `c:${S.imp.cid}` : null);
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
/* every conversation under its project: the folder it ran in (Claude Code's / Codex's working folder; PGA's own chats without
   one are 日常对话), the most recently used project first, each folded or open as you left it */
const PJN = L("日常对话", "Everyday chats");
const pjName = (x) => { const p = (x?.project || "").trim(); return !p || /^(scratch-|pga-agent-|tmp|new-chat$)/i.test(p) ? PJN : p; };   // PGA's own scratch folders are no project
function pjGroups(xs) {
  const by = new Map();
  for (const x of xs) { const n = pjName(x); if (!by.has(n)) by.set(n, { name: n, items: [], last: "" }); const g = by.get(n); g.items.push(x); if ((x.last || "") > g.last) g.last = x.last || ""; }
  return [...by.values()].sort((a, b) => (a.name === PJN) - (b.name === PJN) || String(b.last).localeCompare(String(a.last)));
}
PJ.fold = (() => { try { return JSON.parse(localStorage.getItem("pga_pj_fold") || "null"); } catch { return null; } })();
function pjShut(name) { if (!PJ.fold) { PJ.fold = { _auto: true }; } if (!PJ.recent?.size) PJ.fill?.(); return PJ.fold[name] ?? (PJ.fold._auto && !PJ.recent?.has(name)); }
function pjHead(g, shut) {
  return `<div class="rproj" data-rproj="${esc(g.name)}" title="${L("点一下收起 / 展开", "Click to fold / unfold")}"><span class="rpn">${esc(g.name)}</span><span class="rpc">${g.items.length}</span><i>${shut ? "▸" : "▾"}</i></div>`;
}
document.addEventListener("click", (e) => {
  const h = e.target.closest("[data-rproj]"); if (!h) return;
  e.preventDefault(); e.stopPropagation(); const n = h.dataset.rproj;
  PJ.fold = { ...(PJ.fold || {}), [n]: !pjShut(n) }; try { localStorage.setItem("pga_pj_fold", JSON.stringify(PJ.fold)); } catch {}
  if (typeof stListItems === "function" && $("#stli")) stListItems(); pjStrip();
}, true);
PJ.fill = () => {                                  // the four latest projects start open
  const xs = typeof recentItems === "function" ? recentItems() : [], next = pjGroups(xs).slice(0, 4).map((g) => g.name).join("|");
  if (next === PJ.recentSig) return; PJ.recentSig = next; PJ.recent = new Set(next ? next.split("|") : []);
  if (xs.length) setTimeout(() => { if (typeof stListItems === "function" && $("#stli")) stListItems(); pjStrip(); }, 0);
};
setInterval(() => PJ.fill(), 5000);

async function pjRender() { pjStrip(); }
async function pjStrip() {                         // the strip on the left of a conversation: every project, this one open, its questions under it
  const v = $("#vChats"); if (!v || S.view !== "chats") return;
  const key = pjKey(), xs = recentItems(); if (!xs.length) { clearTimeout(PJ.retry); PJ.retry = setTimeout(pjStrip, 2000); return; }
  let s = $("#cqs");
  if (!s) { v.insertAdjacentHTML("afterbegin", `<aside class="cqs" id="cqs"><div class="cqh"><b>${L("项目", "Projects")}</b></div><div class="cql"></div></aside>`); s = $("#cqs"); }
  v.classList.add("hasqs");
  const here = xs.find((x) => x.item === key), mine = here ? pjName(here) : null;
  const keep = s.querySelector(".cql").scrollTop;
  let html = "";
  for (const g of pjGroups(xs.slice(0, 400)).sort((a, b) => (b.name === mine) - (a.name === mine))) {   // the project you are in comes first
    const shut = g.name === mine ? PJ.fold?.[g.name] === true : pjShut(g.name);
    html += pjHead(g, shut);
    if (shut) continue;
    for (const x of g.items) {
      html += `<div class="cqi ${x.item === key ? "here" : ""}" data-pjgo="${esc(x.item)}" title="${esc(x.title || "")}">${esc(x.title || L("新对话", "New chat"))}</div>`;
      if (x.item === key && PJ.mine?.key === key) html += PJ.mine.qs.map((q) => `<div class="cqq" data-pjgo="${esc(key)}" data-pjrun="${esc(q.run || "")}" title="${esc(q.text)}">${esc(q.text)}</div>`).join("");
    }
  }
  s.querySelector(".cql").innerHTML = html;
  s.querySelector(".cql").scrollTop = keep;
  if (key && PJ.mine?.key !== key) {              // the questions of the conversation you are in, under its row
    PJ.mine = { key, qs: [] };
    try { const r = await api(`/v1/users/${S.uid}/chats/${encodeURIComponent(key)}/questions`); PJ.mine = { key, qs: (r.questions || []).filter((q) => !String(q.text).startsWith("[System")).slice(-30) }; pjStrip(); } catch {}
  }
}
const _renderRightPJ = renderRight;
renderRight = function (...a) { const r = _renderRightPJ(...a); pjStrip(); return r; };
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-pjgo]"); if (g) { e.preventDefault(); pjGo(g.dataset.pjgo, g.dataset.pjrun || ""); }
});
setTimeout(() => { try { pjRender(); } catch {} }, 1500);   // once the page has settled (its first render may come before the world tree is in)

(function () {                                   // after a refresh: the latest words, unless you scroll first
  let touched = false; const mark = () => { touched = true; };
  addEventListener("wheel", mark, { passive: true, once: true }); addEventListener("keydown", mark, { once: true });
  for (const t of [400, 1200, 2500, 4500]) setTimeout(() => { if (touched) return; const d = $("#cdlg"); if (d) d.scrollTop = d.scrollHeight; }, t);
})();
