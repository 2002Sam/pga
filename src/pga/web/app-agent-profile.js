/* PGA app · an agent's profile: click its avatar or name on any answer. Who it is and how it is connected, how it has
   done for you lately, where your ranking puts it — and what you can change: its introduction, standing instructions
   (given to it with every question), the kinds of work it takes, its traits, how many tasks it runs at once, its
   account label, on or off. pga.api: GET /v1/users/{uid}/agents/{name}/profile, PUT /v1/agents/{name}/profile. */
const APF_TRAITS = [["quality", L("质量", "Quality")], ["speed", L("速度", "Speed")], ["cost", L("成本", "Cost")]];
const APF_CAPS = { review: L("审阅", "Review"), research: L("调研", "Research"), write: L("写作", "Writing"), plan: L("规划", "Planning"), general: L("通用", "General") };
const apfHue = (n) => { let h = 7; for (const c of String(n)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const apfKind = (p) => ({ claude_local: "Claude Code", codex_local: "Codex", hermes_local: "Hermes", gemini_local: "Gemini CLI", llm: L("PGA 直接调用的模型", "A model PGA calls itself"),
  codebuddy_local: "WorkBuddy", opencode_local: "OpenCode", http: "HTTP", process: L("本机程序", "A local program") })[p.type] || p.adapter || p.type || "";
const APF_COLORS = ["#5E8B7E", "#2f6fe4", "#7c5cff", "#e0557a", "#ea7a2f", "#d6a75c", "#2F3E46", "#8a8a93"];

/* avatars: one style sheet per page (this one and each window's frame) draws every agent's avatar you set */
function apfAvatarCss(map) {
  return Object.entries(map || {}).map(([n, a]) => {
    const sel = `.cav[data-agentp="${n}"]`, text = String(a.text || "").replace(/["\\\n]/g, "");
    let css = a.color ? `${sel}{background:${a.color} !important;color:#fff !important}` : "";
    if (a.image) css += `${sel}{background:url("${a.image}") center/cover no-repeat ${a.color || "transparent"} !important;font-size:0 !important;color:transparent !important}`;
    else if (text) css += `${sel}{font-size:0 !important}${sel}::after{content:"${text}";font-size:13px;line-height:1;color:#fff}`;
    return css;
  }).join("\n");
}
window.apfAvatarsApply = (map) => {
  window.PGA_AVATARS = map || {};
  let st = document.getElementById("apfAvatarStyle");
  if (!st) { st = document.createElement("style"); st.id = "apfAvatarStyle"; document.head.appendChild(st); }
  st.textContent = apfAvatarCss(window.PGA_AVATARS);
};
async function apfAvatarsLoad(fresh) {
  let map = null;
  try { if (!fresh && window.top !== window && window.top.PGA_AVATARS) map = window.top.PGA_AVATARS; } catch {}
  if (!map) { try { map = (await api("/v1/agents/avatars")).avatars || {}; } catch { map = {}; } }
  window.apfAvatarsApply(map);
}
window.apfAvatarsRefresh = async () => {                 // after a change: this page, then every window's frame
  await apfAvatarsLoad(true);
  for (const f of document.querySelectorAll("iframe")) { try { f.contentWindow.apfAvatarsApply?.(window.PGA_AVATARS); } catch {} }
};
apfAvatarsLoad();
function apfAvatarHtml(name, a) {                      // the big one on the profile, drawn the same way
  const style = a?.image ? `background:url('${esc(a.image)}') center/cover no-repeat ${esc(a.color || "transparent")}` : a?.color ? `background:${esc(a.color)}` : "";
  return `<div class="apf-av${a?.image ? " img" : ""}" style="--h:${apfHue(name)};${style}" data-apfav title="${L("点击换头像（也可以把图片拖到这里）", "Click to change the avatar (or drop a picture here)")}">${a?.image ? "" : esc(a?.text || name.slice(0, 1).toUpperCase())}<i>✎</i></div>`;
}
function apfSquare(file) {                             // any picture → a 256 px square from its middle (a small GIF keeps moving)
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type)) return reject(Error(L("请选一张图片", "Pick a picture")));
    if (file.type === "image/gif" && file.size <= 380000) { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => reject(Error(L("读不出这张图片", "Could not read it"))); r.readAsDataURL(file); return; }
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.width, img.height), c = document.createElement("canvas"); c.width = c.height = 256;
      c.getContext("2d").drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, 256, 256); URL.revokeObjectURL(img.src);
      const png = c.toDataURL("image/png"); resolve(png.length < 500000 ? png : c.toDataURL("image/jpeg", 0.88));
    };
    img.onerror = () => reject(Error(L("读不出这张图片", "Could not read it"))); img.src = URL.createObjectURL(file);
  });
}
function apfAvatarEditor(box, p) {
  const cur = { ...(p.avatar || {}) }, draft = { image: undefined, text: cur.text || "", color: cur.color || "" };
  const ed = box.querySelector(".apf-avedit"), head = () => box.querySelector("[data-apfav]");
  const shown = () => ({ image: draft.image === undefined ? cur.image : draft.image, text: draft.text, color: draft.color });
  const redraw = () => { head().outerHTML = apfAvatarHtml(p.name, shown()); ed.querySelectorAll("[data-apfcol]").forEach((b) => b.classList.toggle("on", b.dataset.apfcol === draft.color)); };
  const take = async (file) => { try { draft.image = await apfSquare(file); ed.hidden = false; redraw(); } catch (err) { toast(err.message); } };
  box.addEventListener("click", (e) => {
    if (e.target.closest("[data-apfav]")) { ed.hidden = !ed.hidden; return; }
    const col = e.target.closest("[data-apfcol]"); if (col) { draft.color = col.dataset.apfcol; redraw(); return; }
    if (e.target.closest("#apfAvUp")) ed.querySelector("#apfAvFile").click();
    else if (e.target.closest("#apfAvNoImg")) { draft.image = null; redraw(); }
    else if (e.target.closest("#apfAvReset")) { draft.image = null; draft.text = ""; draft.color = ""; ed.querySelector("#apfAvText").value = ""; redraw(); }
  });
  ed.querySelector("#apfAvFile").addEventListener("change", (e) => take(e.target.files?.[0]));
  ed.querySelector("#apfAvText").addEventListener("input", (e) => { draft.text = e.target.value.trim(); redraw(); });
  ed.querySelector("#apfAvColor").addEventListener("input", (e) => { draft.color = e.target.value; redraw(); });
  box.addEventListener("dragover", (e) => { if (e.target.closest("[data-apfav]")) { e.preventDefault(); head().classList.add("drop"); } });
  box.addEventListener("dragleave", (e) => { if (e.target.closest("[data-apfav]")) head().classList.remove("drop"); });
  box.addEventListener("drop", (e) => { if (!e.target.closest("[data-apfav]")) return; e.preventDefault(); take(e.dataTransfer.files?.[0]); });
  ed.querySelector("#apfAvSave").addEventListener("click", async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    const body = { text: draft.text, color: draft.color, ...(draft.image !== undefined ? { image: draft.image } : {}) };
    try {
      const r = await api(`/v1/agents/${encodeURIComponent(p.name)}/avatar`, { method: "PUT", body });
      Object.assign(cur, r.avatar); p.avatar = r.avatar; draft.image = undefined; redraw(); ed.hidden = true;
      try { await (window.top.apfAvatarsRefresh || window.apfAvatarsRefresh)(); } catch { await window.apfAvatarsRefresh(); }
      toast(L("头像换好了", "Avatar changed"));
    } catch (err) { toast(err.message); }
    btn.disabled = false;
  });
}
const apfWhen = (iso) => { if (!iso) return L("没有", "never"); try { return typeof ago === "function" ? ago(iso) : new Date(iso).toLocaleString(); } catch { return iso; } };

window.agentProfile = async function (name) {
  try { if (window.top !== window && window.top.agentProfile) return window.top.agentProfile(name); } catch {}   // the whole window, not the frame
  if (!name || !S.uid) return;
  let p;
  try { p = await api(`/v1/users/${S.uid}/agents/${encodeURIComponent(name)}/profile`); }
  catch (err) { toast(L(`没有找到「${name}」的资料：${err.message}`, `No profile for ${name}: ${err.message}`)); return; }
  const caps = [...new Set([...Object.keys(p.categories || {}), ...(p.capabilities || [])])];
  const st = p.stats || {}, q = p.quota || {}, link = p.link || {};
  const rate = st.tries ? Math.round(100 * st.succeeded / st.tries) : null;
  const online = link.state ? link.state === "online" : p.available !== false;
  const box = modal(`<div class="apf">
    <div class="apf-head">
      ${apfAvatarHtml(p.name, p.avatar)}
      <div class="apf-id"><h2>${esc(p.name)}${p.account ? `<small>${esc(p.account)}</small>` : ""}</h2>
        <div class="apf-sub">${esc(apfKind(p))}${p.detail ? " · " + esc(p.detail) : ""}</div>
        <div class="apf-pills"><span class="apf-pill ${p.enabled ? (online ? "ok" : "warn") : "off"}">${!p.enabled ? L("已停用", "Off") : online ? esc(link.label || L("可用", "Available")) : esc(link.label || L("连不上", "Unreachable"))}</span>
          ${link.via_label ? `<span class="apf-pill">${esc(link.via_label)}</span>` : ""}${p.images ? `<span class="apf-pill">${L("能看图", "Sees images")}</span>` : ""}</div></div>
      <label class="lktog apf-on" title="${L("停用后它手上的事会停下，也不会再分到新任务", "Off: what it is doing stops and it gets nothing new")}"><input type="checkbox" id="apfOn" ${p.enabled ? "checked" : ""}><i></i>${L("启用", "On")}</label>
    </div>
    <div class="apf-avedit" hidden>
      <div class="apf-avrow"><button class="sm" id="apfAvUp">${L("上传图片", "Upload a picture")}</button><input type="file" id="apfAvFile" accept="image/*" hidden>
        <span class="dimt">${L("或把图片拖到头像上；会裁成正方形", "or drop one on the avatar; it is cropped square")}</span><span class="grow"></span><button class="sm ghost" id="apfAvNoImg">${L("去掉图片", "Remove picture")}</button></div>
      <div class="apf-avrow"><label>${L("文字", "Text")}</label><input type="text" id="apfAvText" maxlength="8" value="${esc(p.avatar?.text || "")}" placeholder="${L("一两个字或 emoji", "1–2 characters or an emoji")}">
        <label>${L("底色", "Colour")}</label>${APF_COLORS.map((c) => `<button class="apf-sw${p.avatar?.color === c ? " on" : ""}" data-apfcol="${c}" style="--c:${c}" title="${c}"></button>`).join("")}<input type="color" id="apfAvColor" value="${esc(p.avatar?.color || "#5E8B7E")}" title="${L("自己挑", "Pick any")}"></div>
      <div class="apf-avrow"><button class="sm ghost" id="apfAvReset">${L("恢复默认", "Back to default")}</button><span class="grow"></span><button class="sm primary" id="apfAvSave">${L("保存头像", "Save avatar")}</button></div>
    </div>
    <div class="apf-stats">
      <div><b>${st.tries || 0}</b><span>${L(`近 ${st.days || 30} 天做过`, `tries, ${st.days || 30} days`)}</span></div>
      <div><b>${rate == null ? "—" : rate + "%"}</b><span>${L("成功率", "succeeded")}</span></div>
      <div><b>${st.avg_s == null ? "—" : st.avg_s + "s"}</b><span>${L("平均用时", "average time")}</span></div>
      <div><b>${q.remaining == null ? "—" : Math.round(q.remaining * 100) + "%"}</b><span>${L("剩余用量", "usage left")}</span></div>
    </div>
    <div class="apf-meta">${L("最近一次：", "Last used: ")}${esc(apfWhen(st.last_at))}${st.failed ? L(` · 失败 ${st.failed} 次`, ` · ${st.failed} failed`) : ""}${st.cost_usd ? ` · $${st.cost_usd}` : ""}${q.detail ? " · " + esc(q.detail) : ""}</div>
    <div class="apf-sec"><h3>${L("在你的排序里", "In your ranking")}</h3><div class="apf-rank">${(p.ranking || []).map((r) => `<span class="${r.usable ? "" : "no"}" title="${esc(r.why_not || "")}">${esc(r.label)} <b>${r.position ? L(`第 ${r.position}`, `#${r.position}`) : "—"}</b>${r.usable ? "" : `<em>${L("暂不可用", "unavailable")}</em>`}</span>`).join("")}</div></div>
    <div class="apf-sec"><h3>${L("简介", "Introduction")}</h3><input type="text" id="apfRole" maxlength="120" value="${esc(p.role)}" placeholder="${L("一句话说它是谁、擅长什么", "Who it is and what it is good at, in a line")}"></div>
    <div class="apf-sec"><h3>${L("给它的固定要求", "Standing instructions")}<small>${L("每次提问都会带给它", "Given to it with every question")}</small></h3>
      <textarea id="apfInstr" maxlength="2000" rows="4" placeholder="${L("例如：回答先给结论；改代码前先说明要改哪些文件。", "e.g. Lead with the conclusion; say which files you will change before changing code.")}">${esc(p.instructions)}</textarea></div>
    <div class="apf-sec"><h3>${L("擅长的工作", "Takes these kinds of work")}<small>${L("决定它会被分到哪类任务", "Decides which tasks it is given")}</small></h3>
      <div class="apf-caps">${caps.map((c) => `<label><input type="checkbox" data-apfcap="${esc(c)}" ${(p.capabilities || []).includes(c) ? "checked" : ""}>${esc(p.categories?.[c] || APF_CAPS[c] || c)}</label>`).join("")}</div></div>
    <div class="apf-sec apf-grid"><div><h3>${L("特点（影响排序）", "Traits (used in ranking)")}</h3>${APF_TRAITS.map(([k, n]) => `<label class="apf-trait"><span>${n}</span><input type="range" min="1" max="5" step="1" data-apftrait="${k}" value="${p.traits?.[k] || 3}"><em>${p.traits?.[k] || 3}</em></label>`).join("")}</div>
      <div><h3>${L("同时最多做", "Runs at once")}</h3><input id="apfConc" type="number" min="1" max="16" value="${p.max_concurrent}"> ${L("个任务", "tasks")}
        <h3>${L("账号标签", "Account label")}</h3><input type="text" id="apfAcct" maxlength="80" value="${esc(p.account)}" placeholder="${L("例如它登录用的邮箱", "e.g. the e-mail it signs in with")}"></div></div>
    ${(p.models || []).length ? `<div class="apf-sec"><h3>${L("能用的模型", "Models")}</h3><div class="apf-models">${p.models.map((m) => `<span class="${m.id === p.default_model ? "on" : ""}">${esc(m.label)}</span>`).join("")}</div></div>` : ""}
    ${p.about_link ? `<details class="apf-sec"><summary>${L("怎么连接的", "How it is connected")}</summary><p class="dimt">${esc(p.about_link)}${link.detail ? "<br>" + esc(link.detail) : ""}</p></details>` : ""}
    <div class="apf-acts"><a href="/agents" target="_top">${L("Agent 与连接 →", "Agents and connections →")}</a><span class="grow"></span><button id="apfCancel">${L("关闭", "Close")}</button><button class="primary" id="apfSave">${L("保存", "Save")}</button></div>
  </div>`);
  box.classList.add("apfmodal"); apfAvatarEditor(box, p);
  box.addEventListener("input", (e) => { const t = e.target.closest("[data-apftrait]"); if (t) t.nextElementSibling.textContent = t.value; });
  box.querySelector("#apfCancel").onclick = () => box.remove();
  box.querySelector("#apfSave").onclick = async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    const body = { role: box.querySelector("#apfRole").value, instructions: box.querySelector("#apfInstr").value,
      capabilities: [...box.querySelectorAll("[data-apfcap]:checked")].map((x) => x.dataset.apfcap),
      traits: Object.fromEntries([...box.querySelectorAll("[data-apftrait]")].map((x) => [x.dataset.apftrait, Number(x.value)])),
      max_concurrent: Number(box.querySelector("#apfConc").value), account: box.querySelector("#apfAcct").value };
    try {
      await api(`/v1/agents/${encodeURIComponent(p.name)}/profile`, { method: "PUT", body });
      const on = box.querySelector("#apfOn").checked;
      if (on !== !!p.enabled) await api(`/v1/agents/${encodeURIComponent(p.name)}/enabled`, { body: { enabled: on } });
      if (S.acctOf) S.acctOf[p.name] = body.account.trim() || undefined;
      box.remove(); toast(L(`「${p.name}」的资料已保存`, `Saved ${p.name}'s profile`));
    } catch (err) { toast(err.message); btn.disabled = false; }
  };
};
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-agentp]"); if (!a) return;
  e.preventDefault(); e.stopPropagation(); window.agentProfile(a.dataset.agentp);
});
