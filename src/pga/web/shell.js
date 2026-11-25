/* What every page shares: the theme (dark / light / follow the system), the look (skins.css) with your adjustments, the
   language, and the settings menu that changes them. Loaded in <head> so all of it is there before the first paint. */
(function () {
  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const light = matchMedia("(prefers-color-scheme: light)");
  const pref = () => get("pga_theme") || "dark";
  function apply() { const p = pref(); document.documentElement.dataset.theme = p === "system" ? (light.matches ? "light" : "dark") : p; }
  apply(); light.addEventListener?.("change", apply);

  // The stage owns focus and category colours; the frame paints the page content.
  const stagePage = window.frameElement?.closest(".stnode.t-win");
  if (stagePage) {
    document.documentElement.classList.add("stage-page");
    const syncPage = () => {
      const root = document.documentElement, color = stagePage.dataset.categoryColor;
      root.classList.toggle("stage-page-focused", stagePage.classList.contains("focus"));
      root.toggleAttribute("data-stage-category", !!color);
      if (color) root.style.setProperty("--wc", color);
      else root.style.removeProperty("--wc");
    };
    const observer = new MutationObserver(syncPage);
    function watchPage() {
      syncPage();
      observer.observe(stagePage, { attributes: true, attributeFilter: ["class", "data-category-color"] });
    }
    watchPage();
    window.addEventListener("pagehide", () => observer.disconnect());
    window.addEventListener("pageshow", event => { if (event.persisted) watchPage(); });
  }

  /* looks: which one (data-skin on <html>), and your adjustments on top (data-* switches and CSS variables) */
  const SKINS = {
    aurora: { zh: "极光玻璃", en: "Aurora glass", prefer: "dark", zhd: "深色底上的金蓝光晕、毛玻璃面板、浮起的输入框", end: "Gold and blue light on deep glass panels, a floating composer" },
    soft: { zh: "柔和浮雕", en: "Soft relief", prefer: "light", zhd: "一种灰色材质，按钮浮起、按下凹陷，输入框压进表面", end: "One grey material: buttons stand up and sink in, fields are pressed into it" },
    classic: { zh: "简洁", en: "Plain", prefer: null, zhd: "最早的样子：平面、细边框、没有特效", end: "The first look: flat, hairlines, no effects" },
    paper: { zh: "纸墨", en: "Paper and ink", prefer: "light", zhd: "暖色纸面、墨色文字、衬线体阅读", end: "Warm paper, ink, serif reading text" },
    mist: { zh: "山湖晨雾", en: "Misty lake", prefer: "light", zhd: "晨雾山湖做底、毛玻璃卡片，鼠尾草绿、天蓝与雾粉", end: "A mountain lake at dawn behind frosted glass; sage, sky blue and blush" },
    mono: { zh: "终端", en: "Terminal", prefer: "dark", zhd: "等宽字体、直角、荧光绿", end: "Monospace, square corners, phosphor green" },
  };
  const LOOK0 = { skin: "aurora", accent: "", btn: "", rk: 1, sk: 1, fs: 0, density: "normal", sb: "", glow: true, glass: true, motion: true };
  function look() { try { return { ...LOOK0, ...JSON.parse(get("pga_look") || "{}") }; } catch { return { ...LOOK0 }; } }
  const uiFont = () => Math.max(10, Math.min(20, Number(get("pga_ui_font")) || 14));
  function applyLook(l = look(), el = document.documentElement) {
    const d = el.dataset, st = el.style, opt = (k, v) => { if (v == null || v === "") delete d[k]; else d[k] = String(v); };
    d.skin = SKINS[l.skin] ? l.skin : "aurora";
    d.palette = get("pga_palette") || "earth";
    st.setProperty("--ui-font-scale", String(uiFont() / 14));
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
  function setConversationArt(key) {
    const root = document.documentElement;
    if (!key) { delete root.dataset.earthArt; return; }
    let h = 2166136261;
    for (const c of String(key)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
    root.dataset.earthArt = String((h >>> 0) % 6);
  }
  const Q = new URLSearchParams(location.search);
  setConversationArt(Q.get('c') || Q.get('item'));
  const LANG = Q.get("lang") || get("pga_lang") || "zh";
  const L = (zh, en) => (LANG === "en" ? en : zh);
  const as = Q.get("as") ? `?as=${encodeURIComponent(Q.get("as"))}` : "";

  // Background, panel, text, accent and secondary accent, in each display mode.
  const palettes = {
    nord: { name: L("北境冰川", "Nord"), dark: ["#2e3440","#3b4252","#eceff4","#88c0d0","#a3be8c"], light: ["#e5e9f0","#f6f8fb","#2e3440","#34677a","#516c42"] },
    solar: { name: L("沙丘青墨", "Solarized"), dark: ["#002b36","#073642","#eee8d5","#65c5ba","#d9ab48"], light: ["#eee8d5","#fdf6e3","#334d54","#146d69","#976410"] },
    mocha: { name: L("暮紫摩卡", "Mocha"), dark: ["#181825","#1e1e2e","#cdd6f4","#cba6f7","#f5c2e7"], light: ["#e6e5ef","#eff1f5","#4c4f69","#7837bf","#a34275"] },
    earth: { name: L("敦煌", "Dunhuang"), swatch: ["#e9d4af","#b56543","#6cb4a5"] },
    original: { name: L("原版", "Original"), swatch: ["var(--bg)","var(--panel)","var(--accent)"] },
  };
  const categoryPalettes = {
    orchard: {
      name: L("珊瑚果园","Coral orchard"),
      colors: ["#ea928a","#f29163","#d6a252","#6bb9ac","#9bb551"],
    },
    blues: { name: L("三色蓝","Distinct blues"), colors: ["#55cce9","#284994","#8272e5"] },
    linen: { name: L("亚麻手账","Linen"), colors: ["#b38a70","#a69d74","#829c86","#7893a6","#93899e","#ae8990"] },
    coast: { name: L("潮汐海岸","Coast"), colors: ["#b89a79","#a3ac8c","#75a5a0","#6489a1","#848ba5","#ac909e"] },
    bloom: { name: L("旧书花笺","Pressed flowers"), colors: ["#c29480","#ac9c78","#91a493","#8294ad","#a18ca9","#bb899b"] },
  };
  const categoryKey = () => {
    const key = get("pga_category_palette");
    return Object.hasOwn(categoryPalettes, key) ? key : "orchard";
  };
  const categoryPalette = () => categoryPalettes[categoryKey()].colors;
  function syncCategoryPalette() {
    document.documentElement.dataset.categoryPalette = categoryKey();
  }
  syncCategoryPalette();
  window.addEventListener("pga:palette", syncCategoryPalette);
  function categoryGrid() {
    const label = L("分类标签配色","Category tab colors");
    return `<div class="sl">${label}</div><div class="palette-grid" role="group" aria-label="${label}">
      ${Object.entries(categoryPalettes).map(([key, p]) => `<button type="button" data-category-pick="${key}" aria-pressed="${categoryPalette() === p.colors}">
        <span class="palette-sample" aria-hidden="true">${p.colors.map(c => `<i style="background:${c}"></i>`).join("")}</span>
        <span>${p.name}</span></button>`).join("")}</div>`;
  }
  const paletteCSS = Object.entries(palettes).flatMap(([key, palette]) =>
    ["light", "dark"].filter(mode => palette[mode]).map(mode => {
      const [bg, panel, text, accent, second] = palette[mode];
      const rgb = hex => hex.slice(1).match(/../g).map(pair => parseInt(pair,16)).join(",");
      return `html[data-palette="${key}"][data-theme="${mode}"] {
        --bg:${bg}; --canvas:${bg}; --rail:${bg}; --panel:${panel}; --pop:${panel}; --inset:${bg};
        --text:${text}; --accent:${accent}; --accent-2:${second}; --accent-3:${second};
        --accent-soft:color-mix(in srgb,var(--accent) 14%,transparent); --onprimary:${bg};
        --raised:color-mix(in srgb,${panel} 92%,${text}); --hover:color-mix(in srgb,${panel} 86%,${text});
        --muted:color-mix(in srgb,${text} 82%,${bg}); --dim:color-mix(in srgb,${text} 72%,${bg});
        --t1:var(--text); --t2:var(--muted); --t3:var(--dim); --tbg:var(--bg); --tb1:var(--panel); --tb2:var(--raised);
        --ti:${rgb(text)}; --tbgr:${rgb(bg)}; --t3r:${rgb(text)};
        --grad:linear-gradient(120deg,var(--accent),${second}); --grad-soft:var(--accent-soft);
      }
      html[data-palette="${key}"] :is(body,#vStage) {background:var(--bg) !important;}`;
    })).join("\n");
  function paletteGrid() {
    const mode = document.documentElement.dataset.theme;
    const current = document.documentElement.dataset.palette;
    return `<div class="sl">${L("配色方案","Color palette")}</div><div class="palette-grid" role="group" aria-label="${L("配色方案","Color palette")}">
      ${Object.entries(palettes).map(([key, palette]) => {
        const colors = palette.swatch || [palette[mode][0],palette[mode][3],palette[mode][4]];
        return `<button type="button" data-palette-pick="${key}" aria-pressed="${current === key}">
          <span class="palette-sample" aria-hidden="true">${colors.map(c => `<i style="background:${c}"></i>`).join("")}</span>
          <span>${palette.name}</span></button>`;
      }).join("")}</div>`;
  }

  const CSS = `${paletteCSS}
.shell-pop .palette-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:6px; margin-bottom:12px; }
.shell-pop .palette-grid button { display:grid; position:relative; align-content:center; justify-items:center; gap:8px; width:100%; height:auto; aspect-ratio:1; padding:4px; border:1px solid var(--line-2); border-radius:9px; background:var(--panel); color:var(--text); font-size:12px; }
.shell-pop .palette-grid button[aria-pressed=true] { border-color:var(--accent); }
.shell-pop .palette-grid button[aria-pressed=true]::after { content:"✓"; position:absolute; top:2px; right:5px; color:var(--accent); }
.palette-sample { display:flex; width:76%; height:15px; overflow:hidden; border-radius:4px; border:1px solid var(--line-2); }
.palette-sample i { flex:1; }
.shell { position: relative; } .shell-pop { position: absolute; right: 0; top: 36px; z-index: 60; width: 280px; max-height: calc(100vh - 64px); overflow-y: auto; padding: 12px; border-radius: 12px;
  background: var(--panel); border: 1px solid var(--line-2); box-shadow: 0 18px 48px rgba(0,0,0,.28); font-size: calc(13px * var(--ui-font-scale, 1)); color: var(--text); }
.shell-pop .sl { font-size: calc(11px * var(--ui-font-scale, 1)); font-weight: 500; letter-spacing: .06em; text-transform: uppercase; color: var(--dim); margin: 2px 0 6px; }
.shell-pop .sg { display: flex; padding: 2px; border-radius: 8px; background: var(--raised); border: 1px solid var(--line); margin-bottom: 12px; }
.shell-pop .sg button { flex: 1; height: 26px; border: 0; background: transparent; color: var(--muted); font-size: calc(12px * var(--ui-font-scale, 1)); border-radius: 6px; padding: 0 6px; }
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
        ${categoryGrid()}
        ${paletteGrid()}
        <label class="sl" for="shell-ui-font">${L("页面字体大小", "Interface font size")}</label>
        <div class="sg" style="align-items:center;gap:6px;padding:6px">
          <input id="shell-ui-font" data-ui-font type="range" min="10" max="20" step="1" value="${uiFont()}" aria-label="${L('页面字体大小', 'Interface font size')}" style="min-width:0;flex:1">
          <output data-ui-font-value>${uiFont()}px</output>
          <button data-ui-font-reset>${L('默认', 'Reset')}</button>
        </div>
        <label class="sl" for="shell-font-size">${L("对话字体大小", "Conversation font size")}</label>
        <div class="sg" style="align-items:center;gap:6px;padding:6px">
          <input id="shell-font-size" data-font-size type="range" min="12" max="24" step="0.5" value="${look().fs || 14.5}" aria-label="${L('对话字体大小', 'Conversation font size')}" style="min-width:0;flex:1">
          <output data-font-value>${look().fs ? look().fs + 'px' : L('默认', 'Default')}</output>
          <button data-font-reset title="${L('恢复默认字号', 'Reset font size')}">${L('默认', 'Reset')}</button>
        </div>
        <div class="sl">${L("语言", "Language")}</div><div class="sg">${[["zh", "中文"], ["en", "English"]].map(([k, n]) => `<button data-lang-pick="${k}" class="${LANG === k ? "on" : ""}">${n}</button>`).join("")}</div>
        <hr><a class="lkgo" href="/${as ? as + "&" : "?"}view=looks">${L("外观社区 · 自由调节…", "Appearance gallery · adjust freely…")}</a><a href="/agents${as}">${L("Agent 与连接", "Agents and connections")}</a><a href="/archive/console${as}">${L("旧的工作台和星空（存档）", "The old workbench and sky (archive)")}</a>`;
    };
    el.addEventListener("input", (e) => {
      if (e.target.matches("[data-ui-font]")) {
        set("pga_ui_font", String(Math.max(10, Math.min(20, Number(e.target.value) || 14)))); applyLook();
        pop.querySelector("[data-ui-font-value]").textContent = uiFont() + "px"; return;
      }
      if (!e.target.matches("[data-font-size]")) return;
      const fs = Math.max(12, Math.min(24, Number(e.target.value) || 14.5));
      setLook({...look(), fs}, {mode:false});
      pop.querySelector("[data-font-value]").textContent = fs + "px";
    });
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.shell) { pop.hidden = !pop.hidden; if (!pop.hidden) draw(); return; }
      if (b.hasAttribute("data-ui-font-reset")) { set("pga_ui_font", "14"); applyLook(); draw(); return; }
      if (b.hasAttribute("data-font-reset")) { setLook({...look(), fs:0}, {mode:false}); draw(); return; }
      if (b.dataset.themePick) { set("pga_theme", b.dataset.themePick); apply(); draw(); window.dispatchEvent(new Event("pga:theme")); return; }
      if (b.dataset.categoryPick) {
        set("pga_category_palette", b.dataset.categoryPick);
        draw(); pop.querySelector('[data-category-pick][aria-pressed="true"]')?.focus();
        window.dispatchEvent(new Event("pga:palette")); return;
      }
      if (b.dataset.palettePick) { set("pga_palette", b.dataset.palettePick); applyLook(); draw(); pop.querySelector('[data-palette-pick][aria-pressed="true"]')?.focus(); window.dispatchEvent(new Event("pga:palette")); return; }
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
  window.addEventListener("storage", (e) => { if (e.key === "pga_category_palette") window.dispatchEvent(new Event("pga:palette")); if (e.key === "pga_look" || e.key === "pga_palette" || e.key === "pga_ui_font") { applyLook(); if (e.key === "pga_palette") window.dispatchEvent(new Event("pga:palette")); } if (e.key === "pga_theme") apply(); });   // other tabs follow
  window.PGAShell = { mount, L, LANG, apply, categoryPalette, setConversationArt, looks: { SKINS, LOOK0, look, applyLook, setLook } };
})();
