/* 提示词润色 (pga.polish): ✨ by the composer rewrites what you wrote a few ways with your personal model; pick one and it
   replaces your draft — nothing is sent until you press send. */
async function polishOpen() {
  const box = $("#chatText"), text = (box?.value || "").trim();
  if (!text) { toast(L("先写点什么，再润色", "Write something first, then polish")); return; }
  const m = modal(`<h2>✨ ${L("润色", "Polish")}</h2><p class="cvdim" style="margin:4px 0 10px">${L("按你的用户画像（自我知识）和这段对话改写，挑一个替换你的草稿。", "Rewritten with your personal model and this conversation; pick one to replace your draft.")}</p>
    <div class="plist" id="plist"><div class="cvdim">${L("正在润色…", "Polishing…")}</div></div>`);
  m.classList.add("pmodal");
  try {
    const r = await api(`/v1/users/${S.uid}/polish`, { body: { text, n: 3, conversation: S.chat || "" } });
    POL.versions = r.versions || [];
    $("#plist").innerHTML = POL.versions.map((v, i) => `<div class="pv card"><div class="pvh"><b>${esc(v.title || L(`版本 ${i + 1}`, `Version ${i + 1}`))}</b><span class="cvdim">${esc(v.why || "")}</span><span class="grow"></span>
      <button class="sm primary" data-puse="${i}">${L("用这个", "Use this")}</button></div><pre class="pvt">${esc(v.prompt)}</pre></div>`).join("")
      + `<div class="pv orig"><div class="pvh"><b>${L("原文", "Your draft")}</b><span class="grow"></span><button class="sm ghost" data-closemodal>${L("保持原样", "Keep mine")}</button></div><pre class="pvt">${esc(text)}</pre></div>`;
  } catch (e) { $("#plist").innerHTML = `<div class="cvdim">${esc(e.message)}</div>`; }
}
const POL = { versions: [] };
document.addEventListener("click", (e) => {
  if (e.target.closest("#polishBtn")) { e.preventDefault(); polishOpen(); return; }
  const u = e.target.closest("[data-puse]"); if (!u) return;
  const v = POL.versions[Number(u.dataset.puse)], box = $("#chatText"); if (!v || !box) return;
  box.value = v.prompt; S.chatDraft = v.prompt; autoGrow(box); document.querySelector(".modal")?.remove(); box.focus();
});
