/* 做梦 (pga.dream): while you are away PGA looks back over a few conversations and proposes tidying; nothing changes until
   you approve it here. The moon in the stage bar shows how many proposals wait. */

const DRM = { list: [], settings: { on: true } };
const DR_T = { group: ["归到一起", "Group"], archive: ["归档", "Archive"], insight: ["写进自我知识", "Into self knowledge"] };
const DR_DIM = { background: ["背景", "Background"], goals: ["目标", "Goals"], preferences: ["偏好", "Preferences"], abilities: ["能力", "Abilities"], state: ["状态", "State"] };

async function drLoad() {
  try { const r = await api(`/v1/users/${S.uid}/dreams`); DRM.list = r.dreams || []; DRM.settings = r.settings || DRM.settings; } catch {}
  drBadge();
}
function drPending() { return DRM.list.reduce((t, d) => t + (d.ops || []).filter((o) => o.status === "pending").length, 0); }
function drBadge() {
  const b = document.querySelector("[data-st='dream']"); if (!b) return;
  const n = drPending(); b.innerHTML = `🌙 ${L("梦", "Dreams")}${n ? ` <em class="drn">${n}</em>` : ""}`;
}
function drOp(d, o) {
  const st = o.status === "pending" ? `<span class="grow"></span><input class="drwhy" data-drwhy="${d.id}:${o.i}" placeholder="${L("不同意的理由（可选）", "Why not (optional)")}">
      <button class="sm" data-drok="${d.id}:${o.i}">${L("同意", "Approve")}</button><button class="sm ghost" data-drno="${d.id}:${o.i}">${L("不要", "Reject")}</button>`
    : `<span class="grow"></span><em class="drst ${o.status}">${o.status === "done" ? L("已执行", "Done") : L("没采纳", "Rejected")}${o.reason ? ` · ${esc(o.reason)}` : ""}</em>`;
  const what = o.type === "insight" ? `${L(...DR_DIM[o.dim] || ["", ""])}：${esc(o.text || o.label)}` : esc(o.label || "");
  return `<div class="drop ${o.status}"><div class="drl"><b>${L(...DR_T[o.type] || [o.type, o.type])}</b><span>${what}</span></div>
    ${o.why ? `<div class="drw">${esc(o.why)}</div>` : ""}<div class="dra">${st}</div></div>`;
}
function drHtml() {
  const ds = DRM.list;
  return `<h2>🌙 ${L("梦", "Dreams")}</h2>
    <p class="cvdim" style="margin:4px 0 10px">${L("你离开一段时间后（每天最多一次），PGA 会挑几段对话、顺着它们联想到的对话回顾一遍，写下看到了什么，并提出整理建议。只有你同意的才会执行；不同意时写的理由，下次做梦会读到。",
      "After you have been away a while (once a day at most) PGA looks back over a few conversations and what they lead to, writes what it saw, and proposes tidying. Only what you approve is done; your reasons for saying no are read next time.")}</p>
    <div class="drbar"><label><input type="checkbox" id="drOn" ${DRM.settings.on ? "checked" : ""}> ${L("离开时自动做梦", "Dream while I am away")}</label><span class="grow"></span>
      <button class="sm" id="drNow">${L("现在做一次", "Dream now")}</button></div>
    <div class="drlist">${ds.length ? ds.map((d) => `<div class="drd card"><div class="drh"><b>${esc(ago(d.at))}</b><span class="cvdim">${L("从", "From")} ${d.seeds.map((x) => `«${esc(x.title.slice(0, 24))}»`).join("、")}${d.recalled.length ? L(` 联想到 ${d.recalled.length} 段`, ` · led to ${d.recalled.length}`) : ""}</span></div>
      <p class="drn2">${esc(d.narrative)}</p>${(d.ops || []).map((o) => drOp(d, o)).join("") || `<div class="cvdim">${L("这次没有要整理的", "Nothing to tidy this time")}</div>`}</div>`).join("")
      : `<div class="cvdim">${L("还没有做过梦。", "No dreams yet.")}</div>`}</div>`;
}
async function drOpen() { await drLoad(); const m = modal(drHtml()); m.classList.add("drmodal"); }
async function drDecide(key, approve) {
  const [id, i] = key.split(":"), why = document.querySelector(`[data-drwhy="${key}"]`)?.value || "";
  try { await api(`/v1/users/${S.uid}/dreams/${id}/ops/${i}`, { body: { approve, reason: why } }); } catch (e) { toast(e.message); return; }
  await drLoad(); const box = document.querySelector(".drmodal .box"); if (box) box.innerHTML = drHtml();
  if (approve && typeof loadForest === "function") loadForest();
}
document.addEventListener("click", async (e) => {
  if (e.target.closest("[data-st='dream']")) { drOpen(); return; }
  const ok = e.target.closest("[data-drok]"); if (ok) { drDecide(ok.dataset.drok, true); return; }
  const no = e.target.closest("[data-drno]"); if (no) { drDecide(no.dataset.drno, false); return; }
  if (e.target.closest("#drNow")) {
    const b = e.target.closest("#drNow"); b.disabled = true; b.textContent = L("正在做梦…", "Dreaming…");
    try { await api(`/v1/users/${S.uid}/dreams`, { method: "POST", body: {} }); } catch (err) { toast(err.message); }
    await drLoad(); const box = document.querySelector(".drmodal .box"); if (box) box.innerHTML = drHtml();
  }
});
document.addEventListener("change", async (e) => {
  if (e.target.id !== "drOn") return;
  try { DRM.settings = await api(`/v1/users/${S.uid}/dream-settings`, { method: "PUT", body: { on: e.target.checked } }); } catch (err) { toast(err.message); }
});
const _stBarDR = stBar;                              // the moon goes in the stage bar
stBar = function () { _stBarDR(); const nb = document.querySelector("#stbar [data-st='new']"); if (nb && !document.querySelector("[data-st='dream']")) { nb.insertAdjacentHTML("beforebegin", `<button class="sm ghost" data-st="dream"></button>`); drBadge(); } };
if (S.uid && !Q.get("embed")) { drLoad(); setInterval(drLoad, 10 * 60 * 1000); }
