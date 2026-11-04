/* PGA app · 网络测试: 🌐 at the top right reaches a few well-known endpoints from the machine PGA runs on (with the proxy
   settings PGA itself uses) and shows which answered, how fast, and why the others did not (pga.netenv.probe). */
async function netTest() {
  const m = modal(`<h2>🌐 ${L("网络测试", "Network test")}</h2><div class="muted" id="netBody">${L("正在测试…（最多等 8 秒）", "Testing… (up to 8 seconds)")}</div>`);
  const body = $("#netBody", m);
  let r; try { r = await api("/v1/net/test"); } catch (e) { body.textContent = e.message; return; }
  const px = Object.entries(r.proxy || {}), sp = (r.system_proxy || {}).HTTPS_PROXY;
  const row = (x) => `<div class="item"><div class="x">${x.ok ? "🟢" : "🔴"} ${esc(x.name)}<div class="s">${x.ok ? L(`连通，HTTP ${x.status}`, `reachable, HTTP ${x.status}`) : esc(x.error)}</div></div><span class="cvdim">${x.ok ? x.ms + " ms" : L("失败 ", "failed ") + x.ms + " ms"}</span></div>`;
  const bad = r.results.filter((x) => !x.ok), foreign = r.results.filter((x) => x.name !== "百度");
  const hint = !bad.length ? L("都通。", "All reachable.")
    : foreign.every((x) => !x.ok) && r.results.find((x) => x.name === "百度")?.ok ? L("国内能通、国外全不通：多半是代理没生效。", "Domestic works, everything abroad fails: the proxy is probably not applied.")
    : r.results.every((x) => !x.ok) ? L("全部不通：先看这台电脑有没有联网。", "Nothing reachable: check this computer is online first.") : L("有些不通，见下面的原因。", "Some failed: reasons below.");
  body.innerHTML = `<div style="line-height:1.7;margin-bottom:8px"><b>${hint}</b></div>${r.results.map(row).join("")}
    <div class="cvdim" style="margin-top:10px;line-height:1.6">${px.length ? L("PGA 在用的代理：", "Proxy PGA uses: ") + px.map(([k, v]) => esc(k + "=" + v)).join(" · ") : L("PGA 没有设置代理环境变量。", "PGA has no proxy variables set.")}${sp ? "<br>" + L("系统代理：", "System proxy: ") + esc(sp) : ""}</div>
    <div class="row" style="margin-top:12px;display:flex;gap:8px"><button class="ghost" data-closemodal="1">${L("关闭", "Close")}</button><button id="netAgain">${L("再测一次", "Test again")}</button></div>`;
  $("#netAgain", m).onclick = netTest;
}
document.addEventListener("click", (e) => { if (e.target.closest("[data-nettest]")) { e.preventDefault(); netTest(); } }, true);
