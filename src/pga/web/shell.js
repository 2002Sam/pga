/* What every page shares: the theme (dark / light / follow the system), the look (skins.css) with your adjustments, the
   language, and the settings menu that changes them. Loaded in <head> so all of it is there before the first paint. */
(function () {
  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const light = matchMedia("(prefers-color-scheme: light)");
  const pref = () => get("pga_theme") || "dark";
  function apply() { const p = pref(); document.documentElement.dataset.theme = p === "system" ? (light.matches ? "light" : "dark") : p; }
  apply(); light.addEventListener?.("change", apply);

  /* looks: which one (data-skin on <html>), and your adjustments on top (data-* switches and CSS variables) */
  const SKINS = {
    aurora: { zh: "极光玻璃", en: "Aurora glass", prefer: "dark", zhd: "深色底上的金蓝光晕、毛玻璃面板、浮起的输入框", end: "Gold and blue light on deep glass panels, a floating composer" },
    soft: { zh: "柔和浮雕", en: "Soft relief", prefer: "light", zhd: "一种灰色材质，按钮浮起、按下凹陷，输入框压进表面", end: "One grey material: buttons stand up and sink in, fields are pressed into it" },
    classic: { zh: "简洁", en: "Plain", prefer: null, zhd: "最早的样子：平面、细边框、没有特效", end: "The first look: flat, hairlines, no effects" },
    paper: { zh: "纸墨", en: "Paper and ink", prefer: "light", zhd: "暖色纸面、墨色文字、衬线体阅读", end: "Warm paper, ink, serif reading text" },
    mono: { zh: "终端", en: "Terminal", prefer: "dark", zhd: "等宽字体、直角、荧光绿", end: "Monospace, square corners, phosphor green" },
  };
  const LOOK0 = { skin: "aurora", accent: "", btn: "", rk: 1, sk: 1, fs: 0, density: "normal", sb: "", glow: true, glass: true, motion: true };
  function look() { try { return { ...LOOK0, ...JSON.parse(get("pga_look") || "{}") }; } catch { return { ...LOOK0 }; } }
  function applyLook(l = look(), el = document.documentElement) {
    const d = el.dataset, st = el.style, opt = (k, v) => { if (v == null || v === "") delete d[k]; else d[k] = String(v); };
    d.skin = SKINS[l.skin] ? l.skin : "aurora";
    opt("btn", l.btn); opt("sb", l.sb); opt("density", l.density === "normal" ? "" : l.density);
    opt("glow", l.glow ? "" : "off"); opt("glass", l.glass ? "" : "off"); opt("motion", l.motion ? "" : "off");
    const v = (k, on, val) => { if (on) st.setProperty(k, val); else st.removeProperty(k); };
    opt("rk", +l.rk !== 1 ? "1" : ""); v("--rk", +l.rk !== 1, String(l.rk));
    opt("sk", +l.sk !== 1 ? String(+l.sk) : ""); v("--sk", +l.sk !== 1, String(l.sk));
    opt("fs", l.fs ? "1" : ""); v("--fs", !!l.fs, l.fs + "px");
    v("--accent", !!l.accent, l.accent); v("--accent-soft", !!l.accent, `color-mix(in srgb, ${l.accent} 13%, transparent)`);
  }
  function setLook(l, { mode = true } = {}) {
    const x = { ...LOOK0, ...l };
    if (mode && SKINS[x.skin]?.prefer && look().skin !== x.skin && pref() !== "system") { set("pga_theme", SKINS[x.skin].prefer); apply(); window.dispatchEvent(new Event("pga:theme")); }
    set("pga_look", JSON.stringify(x)); applyLook(x); window.dispatchEvent(new Event("pga:look"));
  }
  applyLook();
  const Q = new URLSearchParams(location.search);
  const LANG = Q.get("lang") || get("pga_lang") || "zh";
  const L = (zh, en) => (LANG === "en" ? en : zh);
  const as = Q.get("as") ? `?as=${encodeURIComponent(Q.get("as"))}` : "";

  const CSS = `
.shell { position: relative; } .shell-pop { position: absolute; right: 0; top: 36px; z-index: 60; width: 248px; padding: 12px; border-radius: 12px;
  background: var(--panel); border: 1px solid var(--line-2); box-shadow: 0 18px 48px rgba(0,0,0,.28); font-size: 13px; color: var(--text); }
.shell-pop .sl { font-size: 11px; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); margin: 2px 0 6px; }
.shell-pop .sg { display: flex; padding: 2px; border-radius: 8px; background: var(--raised); border: 1px solid var(--line); margin-bottom: 12px; }
.shell-pop .sg button { flex: 1; height: 26px; border: 0; background: transparent; color: var(--muted); font-size: 12px; border-radius: 6px; padding: 0 6px; }
.shell-pop .sg button.on { background: var(--panel); color: var(--text); box-shadow: 0 1px 2px rgba(0,0,0,.18); }
.shell-pop a { display: block; padding: 6px 2px; color: var(--muted); text-decoration: none; } .shell-pop a:hover { color: var(--text); }
.shell-pop hr { border: 0; border-top: 1px solid var(--line); margin: 6px 0; }
.shell-pop .sg.wrap { flex-wrap: wrap; gap: 2px; } .shell-pop .sg.wrap button { flex: 1 0 30%; }
.shell-pop a.lkgo { color: var(--accent); font-weight: 500; }`;
  const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);

  function mount(el) {
    if (!el) return;
    el.classList.add("shell");
    el.innerHTML = `<button class="ghost" data-shell="toggle">${L("设置", "Settings")}</button><div class="shell-pop" hidden></div>`;
    const pop = el.querySelector(".shell-pop");
    const draw = () => {
      const p = pref();
      pop.innerHTML = `<div class="sl">${L("外观", "Appearance")}</div><div class="sg">${[["dark", L("深色", "Dark")], ["light", L("浅色", "Light")], ["system", L("跟随系统", "System")]]
        .map(([k, n]) => `<button data-theme-pick="${k}" class="${p === k ? "on" : ""}">${n}</button>`).join("")}</div>
        <div class="sl">${L("风格", "Look")}</div><div class="sg wrap">${Object.entries(SKINS).map(([k, x]) => `<button data-skin-pick="${k}" class="${look().skin === k ? "on" : ""}" title="${L(x.zhd, x.end)}">${L(x.zh, x.en)}</button>`).join("")}</div>
        <div class="sl">${L("语言", "Language")}</div><div class="sg">${[["zh", "中文"], ["en", "English"]].map(([k, n]) => `<button data-lang-pick="${k}" class="${LANG === k ? "on" : ""}">${n}</button>`).join("")}</div>
        <hr><a class="lkgo" href="/${as ? as + "&" : "?"}view=looks">${L("外观社区 · 自由调节…", "Appearance gallery · adjust freely…")}</a><a href="/agents${as}">${L("Agent 与连接", "Agents and connections")}</a><a href="/archive/console${as}">${L("旧的工作台和星空（存档）", "The old workbench and sky (archive)")}</a>`;
    };
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.shell) { pop.hidden = !pop.hidden; if (!pop.hidden) draw(); return; }
      if (b.dataset.themePick) { set("pga_theme", b.dataset.themePick); apply(); draw(); window.dispatchEvent(new Event("pga:theme")); return; }
      if (b.dataset.skinPick) { setLook({ ...look(), skin: b.dataset.skinPick }); draw(); return; }
      if (b.dataset.langPick) { set("pga_lang", b.dataset.langPick); const q = new URLSearchParams(location.search); q.delete("lang"); location.search = q.toString(); }
    });
    document.addEventListener("click", (e) => { if (!el.contains(e.target)) pop.hidden = true; });
  }
  /* you are here: a key, a click, a scroll or coming back to the tab tells PGA, at most every 20 s, so motivations that
     started on their own while you were away pause at once (pga.idle). A test tab (?as=) does not count as you. */
  let seen = 0;
  const here = () => { const uid = get("pga_uid"); if (Q.get("as") || !uid || Date.now() - seen < 20000) return; seen = Date.now();
    fetch(`/v1/users/${uid}/activity`, { method: "POST" }).then((r) => r.ok && r.json()).then((r) => { if (r?.paused?.length) window.dispatchEvent(new CustomEvent("pga:back", { detail: r.paused })); }).catch(() => {}); };
  ["keydown", "pointerdown", "wheel", "touchstart"].forEach((ev) => addEventListener(ev, here, { passive: true, capture: true }));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") here(); });
  window.addEventListener("storage", (e) => { if (e.key === "pga_look") applyLook(); if (e.key === "pga_theme") apply(); });   // other tabs follow
  window.PGAShell = { mount, L, LANG, apply, looks: { SKINS, LOOK0, look, applyLook, setLook } };
})();
