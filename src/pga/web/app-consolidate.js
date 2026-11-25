/* Category consolidation keeps the selected transcripts together and can be undone. */
const CONS = { busy: false };
const consErr = (e) => /^not now/.test(e.message) ? L("现在没有可用的模型额度或模型连不上，稍后再试", "No model budget or the model cannot be reached right now: try later") : e.message;

function consProtect() {
  const M = typeof stMarks === "function" ? stMarks() : {};                 // only pinned ones stay out of a tidy
  return Object.keys(M).filter((k) => M[k] && M[k].pin);
}
const consWhen = (iso) => (typeof ago === "function" ? ago(iso) : String(iso).slice(0, 10));

async function consFolder(name) {
  if (CONS.busy) return;
  const m = modal(`<h2>${esc(name)} · ${L("整理合并", "Merge conversations")}</h2><div id="consBody">${L("正在读取分类里的对话…", "Loading conversations…")}</div>`);
  consHistory(m, name);
  const body = $("#consBody", m), pinned = new Set(consProtect());
  let members;
  try { ({members} = await api(`/v1/users/${S.uid}/consolidate/plan`, {body:{project:name, together:true}})); }
  catch (err) { body.textContent = consErr(err); return; }
  if (!Array.isArray(members)) { body.textContent = L("请重载 PGA 后端后重新打开整理合并。", "Reload the PGA server, then reopen Merge conversations."); return; }
  if (!members.length) { body.textContent = L("这个分类还没有可合并的对话。", "No conversations to merge in this category."); return; }
  const topics = new Map();
  for (const item of members) {
    if (!item.topic || pinned.has(item.key)) continue;
    if (!topics.has(item.topic_id)) topics.set(item.topic_id, []);
    topics.get(item.topic_id).push(item);
  }
  const groups = [];
  for (const items of topics.values()) {
    if (items.length < 2) continue;
    const count = Math.ceil(items.length / 6);
    for (let i = 0; i < count; i++) {
      groups.push(items.slice(Math.floor(i * items.length / count), Math.floor((i + 1) * items.length / count)));
    }
  }
  body.innerHTML = `<p>${L("每次合并一个主题，选 2 至 6 段对话。原对话会归档，可从汇总里单独打开。", "Merge 2–6 conversations on one topic. Archived originals can be opened from the summary.")}</p>
    <label>${L("选择一组","Choose a group")} <select class="cons-group">${groups.map((g,i) => `<option value="${i}">${esc(g[0].topic)} · ${esc(g[0].last?.slice(0,10) || "")} (${g.length})</option>`).join("")}<option value="">${L("手动选择","Select manually")}</option></select></label>
    <label>${L("汇总标题", "Title")} <input class="consn" maxlength="60"></label>
    <div class="cons-members"></div>
    <div class="row"><button class="ghost" data-closemodal="1">${L("取消", "Cancel")}</button><button class="primary" id="consGo">${L("整理合并", "Merge conversations")}</button></div>`;
  const selector = body.querySelector(".cons-group");
  selector.onchange = () => {
    const group = selector.value === "" ? null : groups[Number(selector.value)];
    body.querySelector(".consn").value = group?.[0].topic || "";
    body.querySelector(".cons-members").innerHTML = (group || members).map(item => `<label class="opt"><input type="checkbox" data-member="${esc(item.key)}" ${group ? "checked" : ""}><span>${esc(item.title || item.key)}${pinned.has(item.key) ? " ★" : ""}</span></label>`).join("");
  };
  selector.onchange();
  $("#consGo", m).onclick = async () => {
    if (CONS.busy) return;
    const keys = [...body.querySelectorAll("[data-member]:checked")].map(input => input.dataset.member);
    if (keys.length < 2 || keys.length > 6) { toast(L("每组请选择 2 至 6 段对话", "Select 2–6 conversations per group")); return; }
    const title = body.querySelector(".consn").value.trim() || members.find(item => item.key === keys[0])?.title || name;
    CONS.busy = true;
    const go = $("#consGo", m);
    go.disabled = true; go.textContent = L("正在合并…", "Merging…");
    try {
      const result = await api(`/v1/users/${S.uid}/consolidate/apply`, {body:{project:name, title, members:keys, together:true}});
      consRefresh();
      body.innerHTML = `<p>${L(`已将 ${result.n} 段对话合并到「${esc(result.title)}」。`, `Merged ${result.n} conversations into “${esc(result.title)}”.`)}</p><button class="primary" data-consopen="${esc(result.key)}">${L("打开汇总", "Open merged conversation")}</button> <button class="ghost" data-consundo="${esc(result.id)}">${L("撤销", "Undo")}</button>`;
    } catch (err) { toast(consErr(err)); go.disabled = false; go.textContent = L("整理合并", "Merge conversations"); }
    finally { CONS.busy = false; }
  };
}

/* 整理记录: every tidy stays undoable from here, not only from the window it was done in. */
async function consHistory(m, project) {
  let log = []; try { log = (await api(`/v1/users/${S.uid}/consolidate`)).log || []; } catch { return; }
  if (project !== undefined) log = log.filter((e) => e.kind === "group" ? e.project === project : false);
  else log = log.filter((e) => e.kind === "structure");
  if (!log.length) return;
  const box = document.createElement("details"); box.style.marginTop = "14px";
  box.innerHTML = `<summary class="cvdim">${L(`整理记录（${log.length}）`, `Past tidies (${log.length})`)}</summary>` + log.map((e) => `<div class="item"><div class="x">${e.kind === "group" ? "🗃" : "🗂"} ${esc(e.title || "")} <span class="cvdim">${L(`${e.n} 个`, `${e.n}`)} · ${esc(consWhen(e.at))}</span></div>`
    + (e.kind === "group" && !e.undone ? `<button class="sm" data-consopen="${esc(e.key)}">${L("打开", "Open")}</button>` : "")
    + (e.undone ? `<span class="cvdim">${L("已撤销", "Undone")}</span>` : `<button class="sm ghost" data-consundo="${e.id}">${L("撤销", "Undo")}</button>`) + `</div>`).join("");
  (m.querySelector(".box") || m).appendChild(box);
}

async function consStructure() {
  if (CONS.busy) return;
  const m = modal(`<h2>🗂 ${L("整理上层结构", "Tidy the folders")}</h2><div class="muted" id="consBody">${L("正在看所有文件夹…", "Looking at all the folders…")}</div>`);
  let p; try { p = await api(`/v1/users/${S.uid}/consolidate/structure/plan`, { method: "POST", body: {} }); } catch (e) { $("#consBody", m).textContent = consErr(e); return; }
  const body = $("#consBody", m), folders = `<details style="margin:6px 0"><summary class="cvdim">${L(`现有 ${p.folders.length} 个文件夹`, `${p.folders.length} folders now`)}</summary>${p.folders.map((f) => `<div class="cvdim" style="padding:1px 0 1px 8px">${esc(f.name)} · ${f.count}${f.own ? " · " + L("你建的", "yours") : ""} · ${esc(consWhen(f.last))}</div>`).join("")}</details>`;
  consHistory(m);
  if (p.note === "few") { body.innerHTML = L("现在文件夹很少，不用整理。", "Too few folders to tidy.") + folders; return; }
  if (!p.merges.length && !p.renames.length) { body.innerHTML = L("看了一遍，现在的文件夹分得还可以，没有要改的。", "Looked it over: the folders are fine as they are.") + folders; return; }
  body.innerHTML = `<div style="line-height:1.7">${L("建议这样调整（里面的对话不会被删除，只是换了归类；你自己建的文件夹不会被并掉）：", "Proposed changes (no conversation is deleted, only filed differently; folders you made are never merged away):")}</div>${folders}
    ${p.merges.map((x) => `<label class="opt consm" data-cm="${x.id}"><input type="checkbox" checked><span>🗂 ${L("合并", "Merge")} <b>${x.from.map(esc).join("、")}</b> → <b>${esc(x.to)}</b> <span class="cvdim">(${L(`${x.n} 个对话`, `${x.n} conversations`)})</span><br><span class="cvdim">${esc(x.why)}</span></span></label>`).join("")}
    ${p.renames.map((x) => `<label class="opt consm" data-cr="${x.id}"><input type="checkbox" checked><span>✎ ${L("改名", "Rename")} <b>${esc(x.from)}</b> → <b>${esc(x.to)}</b><br><span class="cvdim">${esc(x.why)}</span></span></label>`).join("")}
    <div class="row" style="margin-top:14px;display:flex;gap:8px"><button class="ghost" data-closemodal="1">${L("取消", "Cancel")}</button><button class="primary" id="consGo">${L("应用", "Apply")}</button></div>`;
  $("#consGo", m).onclick = async () => {
    const on = (sel, list, att) => [...m.querySelectorAll(sel)].filter((d) => d.querySelector("input").checked).map((d) => list.find((x) => x.id === d.dataset[att]));
    const merges = on(".consm[data-cm]", p.merges, "cm"), renames = on(".consm[data-cr]", p.renames, "cr");
    if (!merges.length && !renames.length) { toast(L("没有勾选", "Nothing ticked")); return; }
    try {
      const r = await api(`/v1/users/${S.uid}/consolidate/structure/apply`, { body: { merges, renames } });
      consRefresh();
      body.innerHTML = `<div style="line-height:1.7">${L(`调整好了，${r.moved} 个对话换了归类。`, `Done: ${r.moved} conversations filed differently.`)}</div><div class="row" style="margin-top:12px;display:flex;gap:8px"><button class="ghost" data-closemodal="1">${L("关闭", "Close")}</button><button class="sm ghost" data-consundo="${r.id}">${L("撤销", "Undo")}</button></div>`;
    } catch (e) { toast(consErr(e)); }
  };
}

async function consRefresh() {
  try { await Promise.all([typeof loadTimeline === "function" ? loadTimeline() : 0, typeof loadChats === "function" ? loadChats() : 0]); } catch {}
  if (typeof stListItems === "function" && $("#stli")) stListItems();
}

document.addEventListener("click", async (e) => {
  const f = e.target.closest("[data-rcons]"); if (f) { e.preventDefault(); e.stopPropagation(); consFolder(f.dataset.rcons); return; }
  if (e.target.closest("#stlstruct")) { e.preventDefault(); consStructure(); return; }
  const o = e.target.closest("[data-consopen]"); if (o) { document.querySelector(".modal")?.remove(); if (S.view === "stage") stOpen(o.dataset.consopen); else openSourceChat(o.dataset.consopen); return; }
  const u = e.target.closest("[data-consundo]"); if (u) {
    u.disabled = true;
    try { await api(`/v1/users/${S.uid}/consolidate/undo`, { body: { id: u.dataset.consundo } }); u.textContent = L("已撤销", "Undone"); consRefresh(); } catch (er) { toast(er.message); u.disabled = false; }
  }
}, true);
