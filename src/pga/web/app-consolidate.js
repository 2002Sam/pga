/* PGA app · 归档整理 (pga.consolidate): the 🗃 on each folder of 所有对话 tidies that folder down to about ten conversations;
   the 🗂 at the top of 所有对话 tidies the folders themselves.
   - Folder: only pinned conversations stay. The older ones are grouped by what they
     are about; each group you keep ticked is written up as one new conversation and its originals are archived (nothing is
     deleted: 已归档 puts them back, and every tidy has an undo). You see the groups before anything changes.
   - Top level: folders proposed for merging into broader ones, or renaming; the ones you made yourself are never merged away.
   - 整理记录 under each window: past tidies of that folder (or of the folders), each still undoable. */

const CONS = { busy: false };
const consErr = (e) => /^not now/.test(e.message) ? L("现在没有可用的模型额度或模型连不上，稍后再试", "No model budget or the model cannot be reached right now: try later") : e.message;

function consProtect() {
  const M = typeof stMarks === "function" ? stMarks() : {};                 // only pinned ones stay out of a tidy
  return Object.keys(M).filter((k) => M[k] && M[k].pin);
}
const consWhen = (iso) => (typeof ago === "function" ? ago(iso) : String(iso).slice(0, 10));

async function consFolder(name) {
  if (CONS.busy) return;
  const m = modal(`<h2>🗃 ${L("整理", "Tidy")}「${esc(name)}」</h2><div class="muted" id="consBody">${L("正在看这个文件夹里的对话…（要让模型读标题，需要几十秒）", "Looking through this folder… (a model reads the titles: this takes a little)")}</div>`);
  consHistory(m, name);
  let p; try { p = await api(`/v1/users/${S.uid}/consolidate/plan`, { body: { project: name, protect: consProtect() } }); }
  catch (e) { $("#consBody", m).textContent = consErr(e); return; }
  const body = $("#consBody", m);
  const keepList = (p.keep || []).map((k) => `<div class="cvdim" style="padding:2px 0">${esc(k.title || "")} · ${esc(consWhen(k.last))}</div>`).join("");
  if (p.note === "within") { body.innerHTML = L(`这个文件夹里一共 ${p.total} 个对话，没有超过 ${p.limit} 个，不用整理。`, `${p.total} conversations here, within ${p.limit}: nothing to tidy.`); return; }
  if (p.note === "recent") { body.innerHTML = L(`这个文件夹里有 ${p.total} 个对话，但都是你置顶的，没有可以整理的。`, `${p.total} conversations here, but all pinned: nothing to tidy.`) + `<details style="margin-top:8px"><summary>${L("保留的", "Kept")}</summary>${keepList}</details>`; return; }
  const n = p.groups.reduce((a, g) => a + g.members.length, 0);
  const how = { tree: L("分组依据：世界树里的主题，取放得下的最细一层（没有调用模型）。", "Grouped by world-tree topic, at the finest level that fits (no model call)."),
    model: L("分组依据：世界树里的主题；主题比位置多，模型把讲同一件事的合并了。", "Grouped by world-tree topic; there were more topics than room, so a model merged the ones about the same matter."),
    rule: L("分组依据：世界树里的主题；模型暂时用不了，按相近的主题（同一个上级优先）合并。", "Grouped by world-tree topic; the model was not available, so close topics were merged by rule."),
    none: L("这些对话还没进世界树，先放成一组；到世界树里整理后分得会更准。", "These are not on the world tree yet, so they form one group; build the tree first for a better split.") }[p.by] || "";
  body.innerHTML = `<div style="line-height:1.7">${L(`共 ${p.total} 个对话。<b>保留 ${p.keep.length} 个</b>（只有置顶的不参与）；其余 <b>${n} 个</b>分成下面 ${p.groups.length} 组，每组合成一个对话，原对话归档（随时能放回）。不想合的取消勾选，组名可以改。`,
    `${p.total} conversations. <b>${p.keep.length} stay</b> (only pinned ones stay out); the other <b>${n}</b> fall into ${p.groups.length} groups below, each written up as one conversation with its originals archived (you can put them back). Untick what you do not want merged; names can be edited.`)}</div>
    <div class="cvdim" style="margin-top:4px">${how}${p.placed ? L(` 其中 ${p.placed} 个原来不在世界树上，这次先放上去了。`, ` ${p.placed} were not on the tree yet and were placed first.`) : ""}</div>
    <details style="margin:6px 0 10px"><summary class="cvdim">${L("保留的 " + p.keep.length + " 个", p.keep.length + " staying")}</summary>${keepList}</details>
    ${p.groups.map((g) => `<div class="consg" data-cg="${g.id}"><label class="opt"><input type="checkbox" checked><input class="consn" value="${esc(g.title)}" maxlength="60"><span class="cvdim">${L(`${g.members.length} 段`, `${g.members.length}`)}</span></label>
      <div class="cvdim" style="padding-left:24px;font-size:.92em">${consHow(g)}</div>
      <details><summary class="cvdim">${L("包含哪些", "What is in it")}</summary>${g.members.map((x) => `<div class="cvdim" style="padding:1px 0 1px 8px">${esc(x.gist || x.title || "")} · ${esc(consWhen(x.last))}</div>`).join("")}</details></div>`).join("")}
    <div class="row" style="margin-top:14px;display:flex;gap:8px"><button class="ghost" data-closemodal="1">${L("取消", "Cancel")}</button><button class="primary" id="consGo">${L("开始整理", "Tidy")}</button></div>`;
  $("#consGo", m).onclick = async () => {
    const todo = [...m.querySelectorAll(".consg")].filter((d) => d.querySelector("input[type=checkbox]").checked).map((d) => ({ g: p.groups.find((x) => x.id === d.dataset.cg), title: d.querySelector(".consn").value.trim() }));
    if (!todo.length) { toast(L("没有勾选的组", "No group ticked")); return; }
    CONS.busy = true; const done = [];
    for (let i = 0; i < todo.length; i++) {
      body.innerHTML = `<div>${L(`正在整理第 ${i + 1} / ${todo.length} 组：「${esc(todo[i].title)}」…`, `Group ${i + 1} of ${todo.length}: “${esc(todo[i].title)}”…`)}</div><div class="cvdim">${L("模型在读这些对话并写成一份笔记，每组大约半分钟。关掉这个窗口不会中断。", "A model reads them and writes the note, about half a minute a group. Closing this window does not stop it.")}</div>`;
      try { done.push(await api(`/v1/users/${S.uid}/consolidate/apply`, { body: { project: name, title: todo[i].title || todo[i].g.title, members: todo[i].g.members.map((x) => x.key) } })); }
      catch (e) { toast(`「${todo[i].title}」: ${consErr(e)}`); }
    }
    CONS.busy = false; consRefresh();
    body.innerHTML = done.length ? `<div style="line-height:1.7">${L(`整理好了：${done.reduce((a, d) => a + d.n, 0)} 个对话合成了 ${done.length} 个新对话（标题前有 🗃），原对话已归档。`, `Done: ${done.reduce((a, d) => a + d.n, 0)} conversations became ${done.length} new ones (marked 🗃); the originals are archived.`)}</div>
      ${done.map((d) => `<div class="item"><div class="x">🗃 ${esc(d.title)} <span class="cvdim">${L(`${d.n} 段`, `${d.n}`)}</span></div><button class="sm" data-consopen="${esc(d.key)}">${L("打开", "Open")}</button><button class="sm ghost" data-consundo="${d.id}">${L("撤销", "Undo")}</button></div>`).join("")}
      <div class="row" style="margin-top:12px"><button class="ghost" data-closemodal="1">${L("关闭", "Close")}</button></div>` : L("没有整理成功。", "Nothing was tidied.");
  };
}

const consHow = (g) => ({ tree: L("世界树：", "World tree: ") + esc(g.path || g.title), model: L("模型合并了：", "Merged by a model: ") + esc(g.path || ""),
  rule: L("按规则合并了：", "Merged by rule: ") + esc(g.path || ""), untreed: L("还没进世界树（模型暂时用不了，没能先放上去）", "Not on the world tree (it could not be placed just now)") }[g.how] || "");

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
  const o = e.target.closest("[data-consopen]"); if (o) { document.querySelector(".modal")?.remove(); if (typeof S !== "undefined" && S.view !== "stage") show("stage"); stOpen(o.dataset.consopen); return; }
  const u = e.target.closest("[data-consundo]"); if (u) {
    u.disabled = true;
    try { await api(`/v1/users/${S.uid}/consolidate/undo`, { body: { id: u.dataset.consundo } }); u.textContent = L("已撤销", "Undone"); consRefresh(); } catch (er) { toast(er.message); u.disabled = false; }
  }
}, true);
