/* 项目: conversations are shown by project — the folder each ran in. On a conversation's page the strip on the left lists
   every project (name ▾) with its conversations; this one's project is open, and under this conversation are the
   questions you asked in it (click one: it scrolls there). 所有对话 on the stage groups the same way. A refreshed
   page starts at its latest words. */

const PJ = { qs: {}, open: (() => { try { return localStorage.getItem("pga_pj_open") !== "0"; } catch { return true; } })() };
const pjKey = () => S.chat || (S.imp ? `c:${S.imp.cid}` : null);
function pjGo(key, run, text) {                    // open that conversation (on the stage: its page) at that question
  if (key === pjKey()) { pjJump(run, text); return; }
  try { const P = window.parent; if (P !== window && P.stOpen) { pjOpenOn(P, key, run, text); return; } } catch {}
  if (key.startsWith("chat:")) { S.chat = key; S.imp = null; loadChat(key).then(() => setTimeout(() => pjJump(run, text), 300)); renderChat(); }
  else if (typeof openItem === "function") { openItem(key); pjOpenOn(null, key, run, text); }
}
/* scroll this page to one of your questions: its turn (PGA's own conversations) or, in an imported one, the question of
   yours that starts with the same words; true when found. The page then stays there (no jump to the latest words). */
const pjFlat = (t) => String(t || "").replace(/[\s*_#`>\[\]()|-]+/g, "").toLowerCase();
window.pjJump = (run, text, again) => {
  let t = run && document.getElementById(`t-${run}`);
  if (!t && text) { const want = pjFlat(text).slice(0, 28); if (want) t = [...document.querySelectorAll("#cdlg .cmsg.question .ct, #cdlg .cmsg.me .ct")].find((e) => pjFlat(e.textContent).startsWith(want))?.closest(".cmsg"); }
  if (!t) return false;
  const r = t.getBoundingClientRect(); if (again && r.top >= 0 && r.top < innerHeight - 40) return true;   // still in view
  PJ.jumped = true; t.scrollIntoView({ block: "center" }); t.classList.add("pjhit"); setTimeout(() => t.classList.remove("pjhit"), 2600);
  return true;
};
/* open a conversation and, once its page has loaded, go to that question. P: the stage's window (its page is an iframe
   there), or null for this page. */
function pjOpenOn(P, key, run, text) {
  if (P) P.stOpen(key);
  if (!run && !text) return;
  let k = 0, found = 0;
  const go = () => { let ok = false; try {
    let w = window;
    if (P) { const n = P.ST.nodes.find((x) => x.type === "win" && x.key === key); w = P.document.querySelector(`.stnode[data-nid="${n?.id}"] iframe`)?.contentWindow; }
    ok = !!w?.pjJump?.(run, text, found > 0); } catch {}
    if (ok) { if (++found < 4) setTimeout(go, 800); return; }      // looked at again a few times: a page still loading may re-render
    if (++k < 25) setTimeout(go, 400); };
  setTimeout(go, 300);
}
/* every conversation under its project: the folder it ran in (Claude Code's / Codex's working folder; PGA's own chats without
   one are 日常对话), the most recently used project first, each folded or open as you left it */
const PJN = L("日常对话", "Everyday chats");
const pjName = (x) => { const p = (x?.project || "").trim(); return !p || p === "日常对话" || /^(scratch-|pga-agent-|tmp|new-chat$)/i.test(p) ? PJN : p; };   // PGA's own scratch folders are no project
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
  const g = e.target.closest("[data-pjgo]"); if (g) { e.preventDefault(); pjGo(g.dataset.pjgo, g.dataset.pjrun || "", g.dataset.pjrun ? "" : g.title); }
});
setTimeout(() => { try { pjRender(); } catch {} }, 1500);   // once the page has settled (its first render may come before the world tree is in)

(function () {                                   // after a refresh: the latest words, unless you scroll first
  let touched = false; const mark = () => { touched = true; };
  addEventListener("wheel", mark, { passive: true, once: true }); addEventListener("keydown", mark, { once: true });
  for (const t of [400, 1200, 2500, 4500]) setTimeout(() => { if (touched || PJ.jumped) return; const d = $("#cdlg"); if (d) d.scrollTop = d.scrollHeight; }, t);
})();
