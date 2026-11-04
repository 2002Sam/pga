/* PGA app · what agents may do in a conversation, and its folder. Plain scripts sharing one global scope, loaded in order by app.html. */
/* ------------------------------------------------ what agents may do here: your control, per conversation (auto until you change it) */
const ACC = { read: ["只读", "Read only", "读文件、搜索、上网查；不改任何东西", "Reads, searches and looks things up; changes nothing"],
              auto: ["自动", "Auto", "可读写文件、运行命令；需要审批的操作会弹窗，等你同意后执行，可直接把本对话设为完全权限", "Reads and can write files and run commands. Operations requiring approval wait for your decision; the prompt can grant full access to this conversation"],
              full: ["完全批准", "Full approval", "所有操作都直接批准，不拦，像在终端里跳过全部权限检查；只在你信得过的文件夹里用", "Everything is approved without asking, like skipping every permission check in your terminal; use it only in a folder you trust"] };
S.acc = {};
const treeKey = () => `tree:${S.aim === "you" ? "you" : S.aim}`;
function accBtn(key) {
  const a = S.acc[key || "*new"];
  if (!a) { loadAcc(key); return `<button class="ghost acc" data-acc="${esc(key)}">…</button>`; }
  const fold = a.folder ? a.folder.split("/").filter(Boolean).pop() : "";
  return `<button class="ghost acc ${a.access}" data-acc="${esc(key)}" title="${esc(L(ACC[a.access][2], ACC[a.access][3]) + (a.folder ? " · " + a.folder : "") + (a.mcp ? " · MCP" : ""))}">${L(ACC[a.access][0], ACC[a.access][1])}${fold ? " · " + esc(fold) : ""}${a.mcp ? " · MCP" : ""}</button>`;
}
async function loadAcc(key) {
  if (S.acc["_l" + key]) return; S.acc["_l" + key] = 1;
  try { const r = await api(`/v1/users/${S.uid}/access?key=${encodeURIComponent(key || "")}`); S.acc[key || "*new"] = r.current; S.mcpServers = r.mcp_servers; }
  catch { S.acc[key || "*new"] = { access: "auto", folder: "", mcp: false }; }
  document.querySelectorAll(`[data-acc="${CSS.escape(key)}"]`).forEach((b) => { b.outerHTML = accBtn(key); });
  const f = S.acc[key || "*new"]?.folder || S.acc[key || "*new"]?.resolved_folder;                       // the folder chip above the composer, now that we know it
  if (f) document.querySelectorAll(`[data-pickdir="${CSS.escape(key)}"]`).forEach((x) => { x.textContent = "📁 " + (f.split("/").filter(Boolean).pop() || f); x.title = f; });
}
function showAcc(key) {
  const a = S.acc[key || "*new"] || { access: "auto", folder: "", mcp: false };
  modal(`<h2>${L("这里的 agent 能做什么", "What agents may do here")}</h2>
    <div class="muted" style="margin-bottom:12px">${key.startsWith("tree:") ? L("对这棵树上你发起的对话生效。", "For the conversations you start on this tree.") : key ? L("只对这段对话生效。", "For this conversation only.") : L("对这段新对话生效。", "For this new conversation.")} ${L("PGA 自己的长期运行不受影响，始终只读。", "PGA's own long-running work is not affected and stays read-only.")}</div>
    ${Object.entries(ACC).map(([k, v]) => `<label class="opt"><input type="radio" name="accLvl" value="${k}" ${a.access === k ? "checked" : ""}><span><b style="font-weight:500">${L(v[0], v[1])}</b><div class="d">${L(v[2], v[3])}</div></span></label>`).join("")}
    <div class="label" style="margin-top:12px">${L("工作文件夹", "Working folder")}</div>
    <div style="display:flex;gap:6px;margin:6px 0 4px"><input type="text" id="accFolder" style="flex:1" placeholder="${L("留空：这段对话自己的空文件夹（例如 ~/Documents/PGA/pga）", "Empty: this conversation's own empty folder (e.g. ~/Documents/PGA/pga)")}" value="${esc(a.folder || "")}"><button class="sm" id="accBrowse">${L("选择…", "Browse…")}</button></div><div id="dirBox"></div>
    <div class="dimt" style="font-size:12px;margin-bottom:10px">${L("在这个文件夹里，agent 能读到你的 CLAUDE.md 和项目配置。", "In this folder agents read your CLAUDE.md and project settings.")}</div>
    <label class="opt"><input type="checkbox" id="accMcp" ${a.mcp ? "checked" : ""}><span>${L("使用你自己的 MCP 工具", "Use your own MCP tools")}<div class="d">${(S.mcpServers || []).length ? esc(S.mcpServers.join(", ")) : L("你的 Claude Code 里没有配置 MCP 服务器（~/.claude.json）", "No MCP servers in your Claude Code config (~/.claude.json)")}${L(" · 目前对 Claude Code 生效", " · applies to Claude Code for now")}</div></span></label>
    <label class="opt"><input type="checkbox" id="accDef"><span>${L("也设为以后新对话的默认", "Also the default for new conversations")}</span></label>
    <div class="form" style="border:0;background:none;padding:0"><div class="row"><button class="ghost" data-closemodal="1">${L("取消", "Cancel")}</button><button class="primary" id="accSave" data-key="${esc(key)}">${L("保存", "Save")}</button></div></div>`);
}
/* the folder a conversation works in, straight from the composer: recent ones, browse, or none */
async function folderMenu(anchor, key) {
  document.querySelector(".fmenu")?.remove();
  const cur = (S.acc[key || "*new"] || {}).folder || "", xs = await api(`/v1/users/${S.uid}/dirs/recent`).catch(() => []);
  const m = document.createElement("div"); m.className = "ctx fmenu"; m.dataset.key = key || "";
  m.innerHTML = `<div class="ch">${L("这段对话在哪个文件夹里工作", "Where this conversation works")}</div>
    ${xs.map((x) => `<button data-setdir="${esc(x.path)}" class="${x.path === cur ? "on" : ""}" title="${esc(x.path)}">📁 ${esc(x.name)}<kbd>${x.from === "project" ? L("项目", "project") : ""}</kbd></button>`).join("")}
    <hr><button data-browsedir="1">${L("浏览其它文件夹…", "Browse for another…")}</button><button data-setdir="">${L("不用文件夹（这段对话自己的空目录）", "No folder (this chat's own empty one)")}</button>`;
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect(), h = m.getBoundingClientRect();
  m.style.left = Math.min(r.left, innerWidth - h.width - 8) + "px"; m.style.top = Math.max(8, r.top - h.height - 6) + "px";
}
async function setFolder(key, path) {
  document.querySelector(".fmenu")?.remove();
  if (!key && S.view === "chats" && !S.lineView) { S.chat = `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; key = S.chat; history.replaceState(null, "", qs()); }
  const cur = S.acc[key || "*new"] || { access: "auto", mcp: false };
  try { const r = await api(`/v1/users/${S.uid}/access`, { method: "PUT", body: { key: key || undefined, access: cur.access || "auto", mcp: !!cur.mcp, folder: path } });
    S.acc[key || "*new"] = r; toast(path ? L(`之后在 ${path.split("/").pop()} 里工作`, `Now working in ${path.split("/").pop()}`) : L("不用文件夹了", "No folder now"));
    if (S.view === "tree") renderCont(); else renderChat(); }
  catch (err) { toast(err.message); }
}
/* picking a folder: browse your home folder level by level */
async function browseDirs(path) {
  const box = $("#dirBox"); if (!box) return;
  const d = await api(`/v1/users/${S.uid}/dirs?path=${encodeURIComponent(path || "")}`).catch(() => null); if (!d) return;
  box.innerHTML = `<div class="dirs"><div class="dh"><b title="${esc(d.path)}">${esc(d.path.replace(d.home, "~") || "~")}</b>${d.git ? `<span class="pill">git</span>` : ""}${d.claude_md ? `<span class="pill">CLAUDE.md</span>` : ""}<span class="grow"></span><button class="sm primary" data-usedir="${esc(d.path)}">${L("用这个文件夹", "Use this folder")}</button></div>
    ${d.parent ? `<div class="dr" data-dir="${esc(d.parent)}">↑ ${L("上一级", "Up")}</div>` : ""}${d.dirs.map((x) => `<div class="dr" data-dir="${esc(d.path + "/" + x)}">📁 ${esc(x)}</div>`).join("") || `<div class="dimt" style="padding:6px">${L("这里没有子文件夹", "No folders inside")}</div>`}</div>`;
}
async function saveAcc(key) {
  if (!key && S.view === "chats" && !S.lineView) { S.chat = `chat:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; key = S.chat; }
  const body = { key: key || undefined, access: document.querySelector('input[name=accLvl]:checked')?.value || "auto", folder: $("#accFolder").value.trim(), mcp: $("#accMcp").checked, as_default: $("#accDef").checked };
  try { const r = await api(`/v1/users/${S.uid}/access`, { method: "PUT", body }); S.acc[key || "*new"] = r; if (body.as_default) S.acc["*new"] = r;
    document.querySelector(".modal")?.remove(); toast(L(`已设为「${ACC[r.access][0]}」`, `Set to “${ACC[r.access][1]}”`));
    if (S.view === "tree") renderCont(); else renderChat(); }
  catch (err) { toast(err.message); }
}


/* Native tool approval: polling continues while the ask request waits on the agent. */
let accApprovalPolling = false;
setInterval(async () => {
  if (!S.uid || accApprovalPolling || document.querySelector('.modal')) return;
  const key = S.lineView ? S.lineTarget : S.chat;
  if (!key) return;
  accApprovalPolling = true;
  try {
    const rows = await liveSnap(), conv = `${S.uid}:${key}`;
    const row = rows.find(r => r.running && r.approval?.conversation === conv);
    if (!row) return;
    const a = row.approval;
    modal(`<h2>${L('允许这次操作？','Allow this operation?')}</h2><div class="muted">${L('自动权限：操作正在等待你的决定。','Auto access: this operation is waiting for your decision.')}</div>
      <pre style="max-height:40vh;overflow:auto;white-space:pre-wrap">${esc(JSON.stringify(a.details, null, 2))}</pre>
      <div class="row"><button data-tool-approval="deny" data-id="${esc(a.id)}">${L('拒绝','Deny')}</button><button data-tool-approval="allow" data-id="${esc(a.id)}">${L('允许这次','Allow once')}</button><button class="primary" data-tool-approval="full" data-id="${esc(a.id)}">${L('本对话改为完全权限','Full access for this conversation')}</button></div>`);
  } catch (e) { console.warn('approval poll', e); }
  finally { accApprovalPolling = false; }
}, 1000);
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-tool-approval]'); if (!b || b.disabled) return;
  const box = b.closest('.modal'); box?.querySelectorAll('button').forEach(x => x.disabled = true);
  try {
    const r = await api(`/v1/users/${S.uid}/approvals/${encodeURIComponent(b.dataset.id)}`, {method:'POST', body:{decision:b.dataset.toolApproval}});
    if (r.access) S.acc[r.key] = r.access;
    box?.remove();
    if (r.access) document.querySelectorAll('[data-acc]').forEach(x => { if (x.dataset.acc === r.key) x.outerHTML = accBtn(r.key); });
  } catch (err) { toast(err.message); box?.querySelectorAll('button').forEach(x => x.disabled = false); }
});
