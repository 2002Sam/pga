/* PGA app · 外观社区: every look side by side with a live preview, your own adjustments on top of the one you use, looks
   you saved, and share codes (a look as one line of text, to pass to someone or take from someone). The looks themselves
   are in skins.css; shell.js applies them before the first paint. Your look also goes to your preferences, so another
   browser picks it up. */
const LKS = PGAShell.looks;
S.lkSaved = null;

const ACCENTS = [["", L("跟随风格", "The look's own")], ["#e2b46a", L("金", "Gold")], ["#2f6fe4", L("蓝", "Blue")], ["#7c5cff", L("紫", "Violet")],
  ["#2f9e5f", L("绿", "Green")], ["#e0557a", L("玫红", "Rose")], ["#ea7a2f", L("橙", "Orange")], ["#6b7280", L("灰", "Grey")]];
const BTNS = [["", L("跟随风格", "The look's own")], ["solid", L("实心", "Solid")], ["soft", L("柔和", "Soft")], ["outline", L("描边", "Outline")], ["gradient", L("渐变", "Gradient")]];
const DENS = [["compact", L("紧凑", "Compact")], ["normal", L("适中", "Normal")], ["roomy", L("宽松", "Roomy")]];

function lkPreview(skin, mode) {               // a small working copy of the app, in that look
  return `<div class="lkprev" data-skin="${skin}" data-theme="${mode}" aria-hidden="true">
    <div class="lkp-rail"><b>PGA</b><span class="on"></span><span></span><span></span></div>
    <div class="lkp-main">
      <div class="chat"><div class="cmsg right me"><div class="cbody"><div class="cb"><div class="ct">${L("这周先做哪件？", "What first this week?")}</div></div></div></div>
        <div class="cmsg left"><div class="cav" style="--h:210">C</div><div class="cbody"><div class="cb"><div class="ct">${L("先把实验拆成三块：数据、基线、消融。", "Split the experiments in three: data, baselines, ablations.")}</div></div></div></div></div>
      <div class="lkp-comp"><input type="text" value="${L("写点什么…", "Write something…")}" readonly tabindex="-1"><button class="primary sm" tabindex="-1">${L("发送", "Send")}</button></div>
      <div class="lkp-row"><span class="seg"><button class="on" tabindex="-1">${L("按线", "Lines")}</button><button tabindex="-1">${L("按时间", "Time")}</button></span><button class="sm" tabindex="-1">${L("取消", "Cancel")}</button></div>
    </div></div>`;
}
function lkCard(name, desc, l, { cur, saved, i } = {}) {
  const x = LKS.SKINS[l.skin] || LKS.SKINS.aurora, mode = x.prefer || document.documentElement.dataset.theme || "dark";
  return `<div class="lkcard ${cur ? "cur" : ""}">${lkPreview(l.skin, mode)}
    <div class="lkc-b"><div class="lkc-t"><b>${esc(name)}</b>${cur ? `<span class="pill">${L("在用", "In use")}</span>` : ""}</div><div class="lkc-d">${esc(desc)}</div>
      <div class="lkc-a">${cur ? "" : `<button class="sm primary" data-lkuse="${saved ? "s" + i : l.skin}">${L("用这套", "Use this")}</button>`}
        <button class="sm ghost" data-lkcode="${saved ? "s" + i : l.skin}">${L("分享码", "Share code")}</button>${saved ? `<button class="sm ghost" data-lkdel="${i}">${L("删除", "Delete")}</button>` : ""}</div></div></div>`;
}
const sameLook = (a, b) => JSON.stringify({ ...LKS.LOOK0, ...a }) === JSON.stringify({ ...LKS.LOOK0, ...b });
async function showLooks() {
  document.title = L("外观社区 · PGA", "Appearance · PGA");
  if (S.lkSaved == null) { try { S.lkSaved = (await api(`/v1/users/${S.uid}`)).preferences?.looks_saved || []; } catch { S.lkSaved = []; } }
  renderLooks();
}
function renderLooks() {
  const box = $("#looksBody"); if (!box || S.view !== "looks") return;
  const l = LKS.look(), keep = box.querySelector(".lkcfg")?.scrollTop;
  const seg = (key, opts, val) => `<span class="seg">${opts.map(([k, n]) => `<button class="${String(val) === String(k) ? "on" : ""}" data-lkset="${key}" data-v="${esc(k)}">${n}</button>`).join("")}</span>`;
  const range = (key, min, max, step, val, show) => `<span class="lkrange"><input type="range" min="${min}" max="${max}" step="${step}" value="${val}" data-lkrange="${key}"><em>${show}</em></span>`;
  const theme = PGAShell.L ? (localStorage.getItem("pga_theme") || "dark") : "dark";
  box.innerHTML = `<div class="lkhero"><h1>${L("外观社区", "Appearance gallery")}</h1>
      <p>${L("PGA 自带的几套风格和你自己存下的都在这里。点「用这套」立刻换上，右边还能按你的习惯继续调。每一套都能变成一串分享码：发给别人，或者把别人的贴进来。", "PGA's own looks and the ones you saved. “Use this” switches at once; adjust it on the right. Every look turns into a share code: send it to someone, or paste theirs.")}</p></div>
    <div class="lkwrap"><div class="lkleft">
      <div class="sect"><h3>${L("PGA 自带", "Built in")}</h3><span>${L("预览就是真的界面元素，不是图片", "The previews are the real interface, not pictures")}</span></div>
      <div class="lkgal">${Object.entries(LKS.SKINS).map(([k, x]) => lkCard(L(x.zh, x.en), L(x.zhd, x.end), { ...LKS.LOOK0, skin: k }, { cur: l.skin === k && sameLook(l, { ...LKS.LOOK0, skin: k }) })).join("")}</div>
      <div class="sect"><h3>${L("我的风格", "Mine")}</h3><span>${L("在右边调好后「存成我的风格」，或者导入别人的分享码", "Adjust on the right and save it, or import someone's share code")}</span></div>
      <div class="lkgal">${(S.lkSaved || []).map((s, i) => lkCard(s.name, `${L(LKS.SKINS[s.look.skin]?.zh || "", LKS.SKINS[s.look.skin]?.en || "")}${s.look.accent ? " · " + s.look.accent : ""}${s.look.btn ? " · " + (BTNS.find((b) => b[0] === s.look.btn) || [0, ""])[1] : ""}`, s.look, { cur: sameLook(l, s.look), saved: true, i })).join("")
        || `<div class="empty lkempty">${L("还没有存过。", "Nothing saved yet.")}</div>`}</div>
      <div class="sect"><h3>${L("组件一览", "Every component")}</h3><span>${L("现在这套风格下，各种控件长什么样", "What each control looks like in the look you use now")}</span></div>
      ${lkSheet()}
    </div>
    <aside class="lkcfg card">
      <div class="lkh"><b>${L("自由调节", "Adjust")}</b><span class="dimt">${L(`基于「${LKS.SKINS[l.skin]?.zh}」`, `on “${LKS.SKINS[l.skin]?.en}”`)}</span></div>
      <label>${L("明暗", "Light or dark")}</label>${seg("theme", [["dark", L("深色", "Dark")], ["light", L("浅色", "Light")], ["system", L("跟随系统", "System")]], theme)}
      <label>${L("强调色", "Accent")}</label><div class="lksw">${ACCENTS.map(([c, n]) => `<button class="sw ${l.accent === c ? "on" : ""}" data-lkset="accent" data-v="${c}" title="${n}" style="${c ? `--c:${c}` : ""}">${c ? "" : "∅"}</button>`).join("")}
        <input type="color" data-lkcolor value="${l.accent || "#e2b46a"}" title="${L("自己挑", "Pick any")}"></div>
      <label>${L("主按钮", "Main buttons")}</label>${seg("btn", BTNS, l.btn)}
      <label>${L("圆角", "Corners")}</label>${range("rk", 0, 2.5, 0.1, l.rk, (+l.rk).toFixed(1) + "×")}
      <label>${L("立体感（阴影）", "Depth (shadows)")}</label>${range("sk", 0, 2, 0.25, l.sk, +l.sk === 0 ? L("无", "none") : (+l.sk).toFixed(2) + "×")}
      <label>${L("对话文字大小", "Conversation text")}</label>${range("fs", 12, 19, 0.5, l.fs || 14.5, l.fs ? l.fs + "px" : L("跟随风格", "the look's"))}
      <label>${L("疏密", "Spacing")}</label>${seg("density", DENS, l.density)}
      <label>${L("效果", "Effects")}</label><div class="lkfx">
        ${[["glow", L("背景光晕", "Background light")], ["glass", L("毛玻璃", "Frosted glass")], ["motion", L("动效", "Motion")]].map(([k, n]) => `<label class="lktog"><input type="checkbox" data-lkfx="${k}" ${l[k] ? "checked" : ""}><i></i>${n}</label>`).join("")}</div>
      <div class="lkacts"><button class="sm" data-lkact="reset">${L("恢复这套的默认", "Reset this look")}</button><button class="sm primary" data-lkact="save">${L("存成我的风格…", "Save as mine…")}</button>
        <button class="sm ghost" data-lkact="code">${L("复制分享码", "Copy share code")}</button><button class="sm ghost" data-lkact="import">${L("导入分享码…", "Import a share code…")}</button></div>
    </aside></div>`;
  if (keep) box.querySelector(".lkcfg").scrollTop = keep;
}
function lkSheet() {
  return `<div class="lksheet"><div class="card lks-card"><div class="lks-h"><b>${L("卡片", "Card")}</b><span class="dimt">≡</span></div><input type="text" placeholder="${L("输入框", "A field")}"><div class="lks-f">${L("载入中", "Loading")}<span class="spin"></span></div></div>
    <div class="lks-btns"><button class="primary">${L("主按钮", "Primary")}</button><button>${L("普通", "Default")}</button><button class="on">${L("按下", "Pressed")}</button><button disabled>${L("不可用", "Disabled")}</button><button class="ghost">${L("文字按钮", "Ghost")}</button><button class="sm">${L("小按钮", "Small")}</button></div>
    <div class="lks-ctl"><select><option>${L("下拉选择", "A dropdown")}</option></select><span class="seg"><button class="on">${L("一", "One")}</button><button>${L("二", "Two")}</button><button>${L("三", "Three")}</button></span>
      <label class="lktog"><input type="checkbox" checked><i></i>${L("开关", "Toggle")}</label><input type="range" value="40"></div>
    <div class="card lks-toast"><b>${L("提示", "A notice")}</b><span>${L("存进笔记了", "Saved into the note")}</span><span class="pill">✓</span></div>
    <div class="card lks-rows">${[["⌂", L("表格行", "Table row")], ["◎", L("悬停", "Hover")], ["✓", L("选中", "Selected")]].map(([i, n], k) => `<div class="lks-r ${k === 2 ? "on" : ""}"><span>${i}</span>${n}<label class="lktog"><input type="checkbox" ${k === 2 ? "checked" : ""}><i></i></label></div>`).join("")}</div></div>`;
}
const lkCode = (l) => "PGA-LOOK:" + btoa(unescape(encodeURIComponent(JSON.stringify(l))));
function lkFromCode(code) {
  const m = String(code || "").trim().match(/^PGA-LOOK:([A-Za-z0-9+/=]+)$/); if (!m) return null;
  try { const x = JSON.parse(decodeURIComponent(escape(atob(m[1])))); if (!x || typeof x !== "object" || !LKS.SKINS[x.skin]) return null;
    const out = {}; for (const k of Object.keys(LKS.LOOK0)) if (k in x) out[k] = x[k];
    if (out.accent && !/^#[0-9a-f]{3,8}$/i.test(out.accent)) delete out.accent;              // a share code is data: only known keys and plain values
    for (const k of ["rk", "sk", "fs"]) if (k in out) out[k] = Math.max(0, Math.min(k === "fs" ? 24 : 3, Number(out[k]) || 0));
    for (const k of ["glow", "glass", "motion"]) if (k in out) out[k] = !!out[k];
    if (out.btn && !BTNS.some((b) => b[0] === out.btn)) delete out.btn; if (out.density && !DENS.some((d) => d[0] === out.density)) delete out.density;
    return { name: typeof x.name === "string" ? x.name.slice(0, 40) : "", look: out };
  } catch { return null; }
}
let LKT = null;
function lkSync() {                           // your look and saved looks follow you to another browser
  if (AS_UID) return;
  clearTimeout(LKT); LKT = setTimeout(() => api(`/v1/users/${S.uid}/preferences`, { method: "PATCH", body: { preferences: { look: LKS.look(), ...(S.lkSaved ? { looks_saved: S.lkSaved } : {}) } } }).catch(() => {}), 600);
}
function lkSet(patch) { LKS.setLook({ ...LKS.look(), ...patch }, { mode: false }); renderLooks(); }
window.addEventListener("pga:look", () => { lkSync(); if (S.view === "looks") renderLooks(); });
document.addEventListener("click", async (e) => {
  if (!e.target.closest("#looksBody")) return;
  const b = e.target.closest("[data-lkset], [data-lkuse], [data-lkcode], [data-lkdel], [data-lkact]"); if (!b) return;
  if (b.dataset.lkset === "theme") { localStorage.setItem("pga_theme", b.dataset.v); PGAShell.apply(); window.dispatchEvent(new Event("pga:theme")); renderLooks(); return; }
  if (b.dataset.lkset) { const k = b.dataset.lkset; lkSet({ [k]: b.dataset.v }); return; }
  if (b.dataset.lkuse) { const u = b.dataset.lkuse; LKS.setLook(u[0] === "s" && /^s\d+$/.test(u) ? S.lkSaved[+u.slice(1)].look : { ...LKS.LOOK0, skin: u }); renderLooks(); toast(L("换好了", "Switched")); return; }
  if (b.dataset.lkcode) { const u = b.dataset.lkcode, s = /^s\d+$/.test(u) ? S.lkSaved[+u.slice(1)] : null;
    const code = lkCode({ ...(s ? s.look : { ...LKS.LOOK0, skin: u }), name: s ? s.name : L(LKS.SKINS[u].zh, LKS.SKINS[u].en) });
    copyText(code, b); toast(L("分享码复制好了：发给别人，对方在「导入分享码」里贴进来", "Share code copied: they paste it under “Import a share code”")); return; }
  if (b.dataset.lkdel) { if (!confirm(L("删除这套风格？", "Delete this look?"))) return; S.lkSaved.splice(+b.dataset.lkdel, 1); lkSync(); renderLooks(); return; }
  const a = b.dataset.lkact;
  if (a === "reset") lkSet({ ...LKS.LOOK0, skin: LKS.look().skin });
  else if (a === "save") { const name = prompt(L("给这套风格起个名字", "Name this look"), ""); if (!name) return; S.lkSaved = [...(S.lkSaved || []), { name: name.slice(0, 40), look: LKS.look() }]; lkSync(); renderLooks(); toast(L("存好了", "Saved")); }
  else if (a === "code") { copyText(lkCode({ ...LKS.look(), name: L("我的风格", "My look") }), b); toast(L("分享码复制好了", "Share code copied")); }
  else if (a === "import") { const x = lkFromCode(prompt(L("把分享码贴在这里（PGA-LOOK: 开头）", "Paste the share code (starts with PGA-LOOK:)"), ""));
    if (!x) { toast(L("这不是一个能用的分享码", "That is not a share code PGA can read")); return; }
    S.lkSaved = [...(S.lkSaved || []), { name: x.name || L("导入的风格", "Imported look"), look: { ...LKS.LOOK0, ...x.look } }]; LKS.setLook({ ...LKS.LOOK0, ...x.look }); lkSync(); renderLooks(); toast(L("导入好了，已经换上", "Imported and in use")); }
});
document.addEventListener("input", (e) => {
  const r = e.target.closest?.("[data-lkrange]"); if (r) { const k = r.dataset.lkrange; LKS.setLook({ ...LKS.look(), [k]: Number(r.value) }, { mode: false });
    r.nextElementSibling.textContent = k === "rk" ? (+r.value).toFixed(1) + "×" : k === "sk" ? (+r.value === 0 ? L("无", "none") : (+r.value).toFixed(2) + "×") : r.value + "px"; return; }
  const c = e.target.closest?.("[data-lkcolor]"); if (c) { LKS.setLook({ ...LKS.look(), accent: c.value }, { mode: false }); return; }
});
document.addEventListener("change", (e) => {
  const f = e.target.closest?.("[data-lkfx]"); if (f) lkSet({ [f.dataset.lkfx]: f.checked });
  if (e.target.closest?.("[data-lkrange], [data-lkcolor]")) renderLooks();
});
(async () => {                                // a look saved in your preferences, on a browser that has none yet
  if (localStorage.getItem("pga_look") || !S.uid) return;
  try { const p = (await api(`/v1/users/${S.uid}`)).preferences || {}; if (p.look && LKS.SKINS[p.look.skin]) LKS.setLook(p.look, { mode: false }); S.lkSaved = p.looks_saved || []; } catch {}
})();
