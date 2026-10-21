/* PGA app · the bars on the left, and home. Plain scripts sharing one global scope, loaded in order by app.html. */
/* ------------------------------------------------ the bars on the left */
function renderRail() {
  const F = S.forest || { trees: [] }, working = (S.live || []).filter((r) => r.running).length;
  $("#pulse").innerHTML = `<span class="dot ${working ? "on" : ""}"></span>${working ? L(`${working} 在工作`, `${working} working`) : ""}`;
  const maxN = Math.max(8, ...F.trees.map((t) => (t.nodes || []).length), (F.you?.nodes || []).length);
  const width = (n) => `${Math.max(4, Math.round(100 * Math.min(1, n / maxN)))}%`;
  const chats = S.chats || [];
  const bar = (id, name, sub, cls, fill, extra = "", ini = "") => `<a class="rb ${cls} ${(S.view === "tree" && S.aim === id) || (id === "chats" && S.view === "chats") ? "on" : ""}" href="${id === "chats" ? "?view=chats" : "?tree=" + id}" data-bar="${id}">
      <span class="rt" data-ini="${esc(ini || [...String(name)][0] || "·")}" title="${esc(name)}">${extra}<span class="n">${esc(name)}</span></span><span class="line"><i style="width:${fill}"></i></span>${sub ? `<span class="rs">${sub}</span>` : ""}</a>`;
  let html = `<div class="grp"><span class="label">${L("对话", "Conversations")}</span></div>`
    + bar("chats", L("所有对话", "All conversations"), chats.length ? L(`${chats.length} 段 · 最近 ${ago(chats[0].last_at)}`, `${chats.length} · latest ${ago(chats[0].last_at)}`) : L("一次性的提问，不用长成树", "One-off questions, no tree needed"), "chat", chats.length ? width(Math.min(maxN, chats.length)) : "4%", "", L("日", "D"))
    + (false && F.you ? bar("you", L("你的对话树", "Your conversation tree"), L(`${(F.you.nodes || []).length} 个节点`, `${(F.you.nodes || []).length} nodes`) + (F.you.pending ? L(` · ${F.you.pending} 轮待整理`, ` · ${F.you.pending} to place`) : ""), "mine", width((F.you.nodes || []).length), "", L("你", "Y")) : "")
    + `<div class="grp"><span class="label">${L("抱负 · 每一棵树", "Motivations · the trees")}</span><button class="ghost" id="plant" title="${L("新的抱负", "New motivation")}">+</button></div>`
    + (S.planting ? `<div class="plantbox"><textarea id="seedText" placeholder="${L("一个长期的抱负：你想让 PGA 一直朝什么方向努力？", "A long-range motivation: what should PGA keep working towards?")}"></textarea>
        <div class="row"><button class="sm ghost" id="seedCancel">${L("取消", "Cancel")}</button><button class="sm primary" id="seedGo">${L("种下", "Plant")}</button></div></div>` : "")
    + F.trees.map((t) => {
      const on = t.task?.status === "running", n = (t.nodes || []).filter((x) => x.kind !== "bud").length;
      const sub = [t.task ? (on ? (t.task.auto_idle ? L("你不在，自动生长中", "growing while you are away") : L("生长中", "growing")) : L("已暂停", "paused")) : L("还没开始", "not started"), L(`${n} 个节点`, `${n} nodes`), t.task ? L(`张力 ${t.task.pressure.toFixed(2)}`, `pressure ${t.task.pressure.toFixed(2)}`) : ""].filter(Boolean).join(" · ");
      return bar(t.id, t.text, sub, on ? "run" : "", width(n), `<span class="dot ${on ? "on" : ""}"></span>`).replace('<span class="n">', `${t.for_you ? `<span class="badge" title="${L("等你回答", "waiting for you")}">${t.for_you}</span>` : ""}<span class="n">`);
    }).join("");
  $("#bars").innerHTML = html;
  $("#toLib").classList.toggle("on", S.view === "home"); $("#toNotes")?.classList.toggle("on", S.view === "notes"); $("#toGraph")?.classList.toggle("on", S.view === "graph");
}
async function loadForest() {
  S.forest = await api(`/v1/users/${S.uid}/forest${EN ? "?lang=en" : ""}`);
  try { S.live = await api(`/v1/agents/live`); } catch { S.live = []; }
  if (!document.activeElement?.matches?.("#seedText")) renderRail();
  if (S.view === "home") renderHome();
}
async function loadChats() { try { S.allChats = await api(`/v1/users/${S.uid}/chats?archived=true&limit=300`); S.chats = S.allChats.filter((c) => !c.archived); } catch { S.chats = S.chats || []; } renderRail(); if (S.view === "chats") renderChatList(); }

function show(view, opts = {}) {
  S.view = view; closeCtx();
  ["Home", "Tree", "Chats", "Notes", "Looks", "Graph"].forEach((v) => { const el = $("#v" + v); if (el) el.hidden = v.toLowerCase() !== view; });
  $("#cmap") && (view !== "chats") && ($("#cmap").hidden = true);
  if (view === "tree" && opts.aim !== undefined && opts.aim !== S.aim) { S.aim = opts.aim; S.node = opts.node || null; S.bud = null; S.detail = {}; S.beh = {}; S.seen = new Set(); S.tree = null; S.drawer = false; S.op = null; }
  history.replaceState(null, "", qs()); renderRail();
  if (view === "home") { document.title = "PGA"; renderHome(); }
  if (view === "tree") { $("#dlgIn").innerHTML = `<div class="empty">…</div>`; loadTree(); }
  if (view === "notes") { showNotes(); return; }
  if (view === "looks") { showLooks(); return; }
  if (view === "graph") { showGraph(); return; }
  if (view === "chats") { document.title = L("所有对话 · PGA", "All conversations · PGA"); S.tlScrolled = false; renderTimeline(); loadTimeline(); renderChat(); if (S.chat) { S.tlSel = S.chat; loadChat(S.chat); } }
}

/* ------------------------------------------------ home: the two models and the library */
const DIMS = [["background", "背景", "Background"], ["goals", "目标", "Goals"], ["preferences", "偏好", "Preferences"], ["abilities", "能力", "Knowledge & skills"], ["state", "状态", "Current state"]];
async function fillCacheHome() {
  try { const c = await api(`/v1/users/${S.uid}/cache?days=7`); const box = $("#cacheHome"); if (!box || !c.all.calls) return;
    box.innerHTML = `<div class="sect"><h3>${L("提示词缓存 · 最近 7 天", "Prompt cache · last 7 days")}</h3><span>${L("agent 读入的内容里，有多少是模型厂商从缓存里直接给的（按缓存价计）", "How much of what the agents read the providers served from their caches (billed at the cache price)")}</span></div>
      <div class="card" style="margin-bottom:32px">${cacheLine(c.all)}${Object.entries(c.agents).filter(([, x]) => x.calls).map(([a, x]) => `<div class="dim" style="grid-template-columns:110px 1fr 56px;cursor:default"><span class="k">${esc(a)}</span><span class="v">${L(`${x.calls} 次 · 读入 ${kTok(x.input)}，缓存 ${kTok(x.cached)}`, `${x.calls} calls · ${kTok(x.input)} read, ${kTok(x.cached)} cached`)}</span><span class="num" style="text-align:right">${Math.round((x.hit || 0) * 100)}%</span></div>`).join("")}</div>`;
  } catch {}
}
function renderHome() {
  const D = S.forest; if (!D) { $("#homeBody").innerHTML = `<div class="empty">…</div>`; return; }
  const K = D.knowledge || [], world = K.find((k) => k.system === "world"), user = K.find((k) => k.system === "user"), P = D.personal;
  const names = new Map(D.trees.map((t) => [t.id, t.text])), TY = { aim: ["抱负知识", "Motivation"], branch: ["思路", "Line of thought"] };
  const rows = K.filter((k) => !["user", "world"].includes(k.system));
  $("#homeBody").innerHTML = `<h1>${L("模型与知识库", "Models and library")}</h1>
    <div class="intro">${L("左边每一条是一个项目：日常对话、你的对话树、每个抱负的思考树。点一条进去。下面是每一棵树每一轮都会读到的两个模型，和从树上沉淀出来的知识。", "Each bar on the left is one project: everyday chats, your conversation tree, each motivation's thought tree. Click one to open it. Below are the two models every tree reads each round, and the knowledge distilled from the trees.")}</div>
    <div class="models">
      <div class="card click world" data-doc="${world?.id || ""}">${world ? `<div class="mh"><span class="t">${L("世界模型", "World model")}</span><span class="s">${world.compiled_at ? ago(world.compiled_at) : L("还没有整理", "not compiled yet")}</span></div>
        <div class="g">${esc(world.gist || "")}</div>${world.brief ? `<div class="b">${esc(world.brief)}</div>` : ""}` : ""}</div>
      <div class="card"><div class="mh"><span class="t">${L("个人模型", "Personal model")}</span><span class="s">${user?.compiled_at ? ago(user.compiled_at) : ""}${user ? ` · <a href="#" data-doc="${user.id}" style="color:var(--muted)">${L("全文", "Full text")}</a>` : ""}</span></div>
        ${P ? `<div class="dims">${DIMS.map(([k, zh, en]) => { const x = P[k] || {}; return `<div class="dim" data-doc="${user?.id || ""}"><span class="k">${L(zh, en)}</span><span class="v">${esc(x.summary || L("还看不出来", "Not enough to tell yet"))}</span><span class="conf" title="${L("把握", "confidence")} ${Math.round((x.confidence || 0) * 100)}%"><i style="width:${Math.round((x.confidence || 0) * 100)}%"></i></span></div>`; }).join("")}</div>`
          : `<div class="dimt" style="font-size:13px">${L("还没有按五个维度整理过：背景、目标、偏好、能力、状态。", "Not compiled into its five dimensions yet.")} ${user ? `<a href="#" data-compile="${user.id}" style="color:var(--accent)">${L("现在整理", "Compile now")}</a>` : ""}</div>`}</div>
    </div>
    <div id="cacheHome"></div>
    <div style="display:flex;gap:8px;margin:0 0 10px"><button class="sm" data-act="upload">${L("＋ 上传文档到知识库", "+ Upload a document")}</button><span class="dimt" style="font-size:12px;align-self:center">${L("PDF、Word、Excel、PPT、Markdown、代码…在本机读成文字；对话里用 # 引用，只把相关的段落给 agent。", "PDF, Word, Excel, PPT, Markdown, code… read on this machine; cite with # in a chat — only the matching passages go to the agent.")}</span></div>
    <div class="sect"><h3>${L("知识库", "Library")}</h3><span>${L("从树上沉淀出的思路、数据集和技能；在树里右键一个节点就能沉淀", "Lines of thought, datasets and skills distilled from the trees; right-click a node in a tree to distill it")}</span></div>
    <div class="rows">${rows.map((k) => `<div class="lr" data-doc="${k.id}"><span class="ty">${TY[k.system] ? L(...TY[k.system]) : k.kind === "skill" ? L("技能", "Skill") : L("数据集", "Dataset")}</span>
      <span class="ti">${esc(k.title)}</span><span class="gi">${esc(k.gist || "")}</span><span class="us">${(k.used_by || []).length ? L("被参考：", "Used by: ") + k.used_by.map((id) => esc((names.get(id) || "").slice(0, 18))).join(", ") : k.aim_id ? esc((names.get(k.aim_id) || "").slice(0, 24)) : ""}</span></div>`).join("")
      || `<div class="empty">${L("还没有。", "Nothing yet.")}</div>`}</div>`;
  fillCacheHome();
}


/* you are back: the motivations that started on their own while you were away have paused (pga.idle via shell.js) */
window.addEventListener("pga:back", (e) => {
  toast(L(`欢迎回来：你不在时自动运转的 ${e.detail.length} 个抱负先停下了`, `Welcome back: ${e.detail.length} motivation(s) that ran while you were away have paused`));
  loadForest().catch(() => {}); if (S.view === "tree") loadTree(true).catch(() => {});
});
