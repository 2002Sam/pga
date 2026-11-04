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
  if (PJ.catalog && !window.ST?.q && !window.ST?.onlyMarked && !window.ST?.folder) for (const name of PJ.catalog.names)
    if (!by.has(name)) by.set(name, {name,items:[],last:''});
  return [...by.values()].sort((a, b) => (a.name === PJN) - (b.name === PJN) || String(b.last).localeCompare(String(a.last)));
}
PJ.fold = (() => { try { return JSON.parse(localStorage.getItem("pga_pj_fold_v2") || "null"); } catch { return null; } })();
function pjShut(name) { return PJ.fold?.[name] ?? true; }
function pjHead(g, shut) {
  return `<div class="rproj" data-rproj="${esc(g.name)}" title="${L("点一下收起 / 展开", "Click to fold / unfold")}"><span class="rpn">${esc(g.name)}</span><span class="rpc">${g.items.length}</span><button class="rmgr" data-pjmgr="${esc(g.name)}" title="${L("管理员：这个分类的对话树、关系图和管理员 agent", "Manager: this category's tree, graph and manager agent")}">◎</button><button class="rnew" data-pjnew="${esc(g.name)}" title="${L('在这个分类中新建对话', 'New conversation in this category')}">＋</button><button class="rcons" data-rcons="${esc(g.name)}" title="${L("整理这个文件夹：近三天用过的不动，其余相近的合并成一个对话、原对话归档", "Tidy this folder: the last three days stay; similar older ones are merged into one and archived")}">🗃</button><i>${shut ? "▸" : "▾"}</i></div>`;
}
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-rcons], [data-pjnew], [data-pjmgr]")) return;
  const h = e.target.closest("[data-rproj]"); if (!h) return;
  e.preventDefault(); e.stopPropagation(); const n = h.dataset.rproj;
  if (window.ST?.projectLimits) delete ST.projectLimits[n];
  PJ.fold = { ...(PJ.fold || {}), [n]: !pjShut(n) }; try { localStorage.setItem("pga_pj_fold_v2", JSON.stringify(PJ.fold)); } catch {}
  if (typeof stListItems === "function" && $("#stli")) stListItems(); pjStrip();
}, true);
PJ.fill = () => {                                  // the four latest projects start open
  const xs = typeof recentItems === "function" ? recentItems() : [], next = pjGroups(xs).slice(0, 4).map((g) => g.name).join("|");
  if (next === PJ.recentSig) return; PJ.recentSig = next; PJ.recent = new Set(next ? next.split("|") : []);
  if (xs.length) setTimeout(() => { if (typeof stListItems === "function" && $("#stli")) stListItems(); pjStrip(); }, 0);
};
setInterval(() => PJ.fill(), 5000);

async function pjRender() { pjStrip(); }
async function pjStrip() {                         // the project strip on the left of a conversation is switched off
  $("#cqs")?.remove(); $("#vChats")?.classList.remove("hasqs"); return;
}
async function pjStripOld() {                         // the strip on the left of a conversation: every project, this one open, its questions under it
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

// Categories are persisted on the user, separately from working folders and stage workspaces.
const pjCanonical = key => key?.startsWith('imp:') ? 'c:' + key.slice(4) : key;
const pjBaseRecent = recentItems;
let pjRecentMemo = null;                              // built once per change of the time tree, the chats or the categories: it is asked for
recentItems = function () {                            // many times a second (every title on the stage), and building it sorts every session
  const tl = S.tl, ch = S.chats, cat = PJ.catalog, m = pjRecentMemo;
  if (m && m.tl === tl && m.ch === ch && m.cat === cat) return m.xs.slice();
  const xs = pjRecentItems(); pjRecentMemo = { tl, ch, cat, xs }; return xs.slice();
};
function pjRecentItems() {
  const xs = pjBaseRecent(), catalog = PJ.catalog;
  if (!catalog) return xs;
  const seen = new Set(xs.map(x => pjCanonical(x.item)));
  for (const [key, draft] of Object.entries(catalog.drafts || {})) if (!seen.has(key))
    xs.push({item:key,kind:'chat',title:L('新对话','New chat'),last:draft.at,ref:{chat:key}});
  return xs.map(x => ({...x, project:catalog.of?.[pjCanonical(x.item)] || x.project}));
};
async function pjCatalog() {
  const catalog = await api(`/v1/users/${S.uid}/conversation-projects`);
  PJ.catalog = catalog; return catalog;
}
function pjRefreshViews() {
  if (typeof stRender === 'function' && S.view === 'stage') { stRender(); stListItems(); }
  if (typeof renderRecent === 'function') renderRecent();
}
async function pjCreate(project) {
  if (PJ.creating) return; PJ.creating = true;
  try {
    const r = await api(`/v1/users/${S.uid}/conversation-projects`, {body:{project,create:true}});
    await pjCatalog();
    PJ.fold = {...(PJ.fold || {}), [r.project]:false};
    try { localStorage.setItem('pga_pj_fold_v2', JSON.stringify(PJ.fold)); } catch {}
    const host = window.parent !== window && window.parent.stOpen ? window.parent : window;
    if (host.stOpen) {
      if (host !== window) await host.pjCatalog();
      if (host.S.view !== 'stage') host.show('stage');
      host.stOpen(r.key); host.pjRefreshViews();
    } else { S.chat = r.key; S.imp = null; await loadChat(r.key); }
    pjRefreshViews(); document.querySelector('.modal')?.remove();
  } catch (err) { toast(err.message); }
  finally { PJ.creating = false; }
}
async function pjAssignDialog(key) {
  if (!key) { toast(L('请先创建对话','Create a conversation first')); return; }
  try {
    const cat = await pjCatalog(), current = cat.of[pjCanonical(key)] || pjName(recentItems().find(x=>pjCanonical(x.item)===pjCanonical(key)));
    modal(`<h2>${L('归入分类','Move to category')}</h2><select id="pjCategory" style="width:100%">${cat.names.map(name=>`<option value="${esc(name)}" ${name===current?'selected':''}>${esc(name)}</option>`).join('')}</select>
      <div class="form"><div class="row"><button data-closemodal="1">${L('取消','Cancel')}</button><button class="primary" data-pjassign="${esc(key)}">${L('移入','Move')}</button></div></div>`);
  } catch (err) { toast(err.message); }
}
async function pjAssign(key, project) {
  const r = await api(`/v1/users/${S.uid}/conversation-projects`, {body:{key,project}});
  await pjCatalog();
  const host = window.parent !== window && window.parent.ST ? window.parent : window;
  if (host !== window) await host.pjCatalog();
  for (const n of host.ST?.nodes || []) if (pjCanonical(n.key) === r.key) {
    delete n.ws;
    const parent = n.par && host.ST.nodes.find(x => x.id === n.par);
    if (parent && host.stGroupOf(parent)?.id !== "pj:" + r.project) host.stDetachBranch(n);
  }
  host.stSave?.(); host.pjRefreshViews?.(); pjRefreshViews();
  toast(L('已移入「' + r.project + '」','Moved to ' + r.project));
}
document.addEventListener('click', async e => {
  const create = e.target.closest('[data-pjnew]');
  if (create) { window.stMapHideTip?.(); e.preventDefault(); e.stopImmediatePropagation(); await pjCreate(create.dataset.pjnew); return; }
  const move = e.target.closest('[data-pjassign]');
  if (move) {
    e.preventDefault(); e.stopImmediatePropagation(); if (move.disabled) return; move.disabled = true;
    try { await pjAssign(move.dataset.pjassign, $('#pjCategory').value); document.querySelector(".modal")?.remove(); }
    catch (err) { toast(err.message); move.disabled = false; }
  }
}, true);
setTimeout(async () => { if (!S.uid) return; try { await pjCatalog(); pjRefreshViews(); } catch {} }, 1600);

const pjLoadTimeline = loadTimeline;
loadTimeline = async function (...args) {
  if (S.uid) { try { await pjCatalog(); } catch {} }
  return pjLoadTimeline(...args);
};

// Keep map navigation on one click; defer it briefly so a double click only opens context.
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('[data-pjmap]')) clearTimeout(PJ.mapClick);
}, true);
document.addEventListener('click', e => {
  const button = e.target.closest('[data-pjmap]'); if (!button) return;
  e.preventDefault(); e.stopImmediatePropagation(); window.stMapHideTip?.();
  clearTimeout(PJ.mapClick);
  if (e.detail > 1) return;
  const project = button.dataset.pjmap, x = e.clientX, y = e.clientY;
  PJ.mapClick = setTimeout(() => window.stProjectJump?.(project, x, y), 260);
}, true);
document.addEventListener('dblclick', e => {
  const button = e.target.closest('[data-pjmap]'); if (!button) return;
  e.preventDefault(); e.stopImmediatePropagation(); clearTimeout(PJ.mapClick);
  window.stMapHideTip?.(); window.mgOpen ? window.mgOpen(button.dataset.pjmap, button) : pjShared(button.dataset.pjmap);   // the category's manager page (its context is a button there)
}, true);
document.addEventListener('pointerover', e => {
  if (e.target.closest('[data-pjnew], [data-pjmap]')) window.stMapHideTip?.();
}, true);

// A project has one shared page, reachable from its name on the stage map.
function pjSourceRows(sources) {
  return sources.map((s, i) => `<details class="pj-source"><summary>${i + 1}. ${esc(s.title)} <small>${esc((s.at || '').slice(0,16).replace('T',' '))}</small></summary>
    <div class="pj-excerpt">${esc(s.text)}</div>${s.key ? `<button data-pjsource="${esc(s.key)}" data-run="${esc(s.run || '')}">${L('打开原对话','Open source')}</button>` : ''}
    <button data-pjpin="${i}">${L('写入确认结论…','Add to confirmed notes…')}</button></details>`).join('') || `<p class="dimt">${L('暂无内容','No entries yet')}</p>`;
}
async function pjShared(project) {
  try {
    const data = await api(`/v1/users/${S.uid}/project-context?project=${encodeURIComponent(project)}`);
    PJ.shared = data; PJ.sources = data.recent || [];
    modal(`<div class="pj-shared"><h2>${esc(project)} · ${L('项目资料与记忆','Project context')}</h2>
      <div class="row"><button data-pjnew="${esc(project)}">＋ ${L('在此新建对话','New conversation')}</button><label><input type="checkbox" id="pjShareEnabled" ${data.enabled?'checked':''}> ${L('同项目对话自动使用','Use in project conversations')}</label></div>
      <p class="dimt">${L('保存后，下次提问使用最新内容。公共资料中的链接和路径只作索引；要共享正文，请粘贴或导入文本。','Changes apply on the next question. Links and paths are references; paste or import text to share its contents.')}</p>
      <label>${L('公共说明：目标、约定、工作方式','Instructions: goals and conventions')}<textarea id="pjInstructions" maxlength="6000" rows="3">${esc(data.instructions)}</textarea></label>
      <label>${L('公共资料：代码说明、参考资料、文档正文','Shared reference material')}<textarea id="pjResources" maxlength="24000" rows="5">${esc(data.resources)}</textarea></label>
      <label class="pj-file">${L('导入文本资料（TXT / Markdown / CSV / JSON）','Import text (TXT / Markdown / CSV / JSON)')} <input id="pjResourceFile" type="file" accept=".txt,.md,.csv,.json,.tex"></label>
      <label>${L('项目记忆：已确认结论、当前计划和待办','Memory: confirmed decisions, plans and tasks')}<textarea id="pjMemory" maxlength="10000" rows="6">${esc(data.memory)}</textarea></label>
      <p class="dimt">${L('此处由你确认保存；下面的近期摘录不会自动覆盖它。','These notes are confirmed by you; recent excerpts never overwrite them.')}</p>
      <div class="row"><button class="primary" data-pjsharedsave>${L('保存共享内容','Save shared context')}</button><span id="pjSaveStatus" role="status"></span><button data-closemodal="1">${L('关闭','Close')}</button></div>
      <h3>${L('项目内检索','Search this project')}</h3><div class="row"><input type="text" id="pjSearchText" placeholder="${L('输入问题或关键词','Question or keywords')}" maxlength="600"><button data-pjsearch>${L('查找','Search')}</button></div>
      <h3 id="pjSourceHeading">${L('近期进展 · 问答摘录，点击查看来源','Recent progress · excerpts with sources')}</h3><div id="pjSources">${pjSourceRows(PJ.sources)}</div></div>`);
  } catch (err) { toast(err.message); }
}
async function pjProjectPicker() {
  try {
    const cat = await pjCatalog();
    modal(`<h2>${L('选择项目','Choose project')}</h2><div class="pj-picker">${cat.names.map(name=>`<div class="row"><b>${esc(name)}</b><button data-pjnew="${esc(name)}">＋ ${L('新对话','New chat')}</button><button data-pjcontext="${esc(name)}">${L('资料与记忆','Context')}</button></div>`).join('')}</div>`);
  } catch (err) { toast(err.message); }
}
document.addEventListener('click', async e => {
  const picker = e.target.closest('[data-pjpicker]'), open = e.target.closest('[data-pjcontext]');
  if (picker || open) { e.preventDefault(); e.stopImmediatePropagation(); if (open) await pjShared(open.dataset.pjcontext); else await pjProjectPicker(); return; }
  const save = e.target.closest('[data-pjsharedsave]');
  if (save) {
    e.preventDefault(); if (save.disabled) return; save.disabled = true;
    const form = save.closest('.pj-shared'), snapshot = PJ.shared;
    try {
      const data = await api(`/v1/users/${S.uid}/project-context`, {method:'PUT', body:{project:snapshot.project,revision:snapshot.revision,
        enabled:$('#pjShareEnabled').checked,instructions:$('#pjInstructions').value,resources:$('#pjResources').value,memory:$('#pjMemory').value}});
      if (!form.isConnected || PJ.shared !== snapshot) return;
      PJ.shared = {...snapshot,...data}; $('#pjSaveStatus').textContent = L('已保存 · 下次提问生效','Saved · applies to the next question');
    } catch (err) { if (form.isConnected) form.querySelector('#pjSaveStatus').textContent = err.message; }
    finally { save.disabled = false; }
    return;
  }
  const search = e.target.closest('[data-pjsearch]');
  if (search) {
    const query = $('#pjSearchText').value.trim(); if (!query || search.disabled) return;
    search.disabled = true;
    const form = search.closest('.pj-shared'), project = PJ.shared.project;
    try {
      const data = await api(`/v1/users/${S.uid}/project-context/search?project=${encodeURIComponent(project)}&q=${encodeURIComponent(query)}`);
      if (!form.isConnected) return;
      PJ.sources = data.sources; $('#pjSourceHeading').textContent = L('检索结果 · 原文片段','Search results · source passages'); $('#pjSources').innerHTML = pjSourceRows(PJ.sources);
    } catch (err) { toast(err.message); }
    finally { search.disabled = false; }
    return;
  }
  const source = e.target.closest('[data-pjsource]');
  if (source) { document.querySelector('.modal')?.remove(); pjGo(source.dataset.pjsource, source.dataset.run, ''); return; }
  const pin = e.target.closest('[data-pjpin]');
  if (pin) {
    const s = PJ.sources?.[Number(pin.dataset.pjpin)], field = $('#pjMemory'); if (!s || !field) return;
    const added = `\n\n${s.title}\n${s.text}\n来源：${s.key || '项目资料'} ${s.run || ''}`;
    if (field.value.length + added.length > 10000) { toast(L('记忆内容过长，请先精简','Please shorten your memory notes first')); return; }
    field.value += added; field.focus(); field.scrollTop = field.scrollHeight;
    $('#pjSaveStatus').textContent = L('请编辑确认结论，再点击保存','Edit and confirm the notes, then save');
  }
}, true);
document.addEventListener('change', async e => {
  if (e.target.id !== 'pjResourceFile') return;
  const file = e.target.files[0]; if (!file) return;
  try {
    if (file.size > 100000 || !/\.(txt|md|csv|json|tex)$/i.test(file.name)) throw Error(L('请选择不超过 100 KB 的文本资料','Choose a text file under 100 KB'));
    const field = $('#pjResources'), text = await file.text(), next = field.value + '\n\n## ' + file.name + '\n' + text;
    if (!field.isConnected) return;
    if (next.length > 24000) throw Error(L('公共资料最多 24000 字符，请精简后导入','Shared references allow up to 24,000 characters'));
    field.value = next; $('#pjSaveStatus').textContent = L('资料已导入，点击保存后共享','Imported; save to share');
  } catch (err) { toast(err.message); }
  e.target.value = '';
});
