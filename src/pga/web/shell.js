/* What every page shares: the theme (dark / light / follow the system), the language, and the settings menu that changes
   them. Loaded in <head> so the right theme is there before the first paint. */
(function () {
  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
  const light = matchMedia("(prefers-color-scheme: light)");
  const pref = () => get("pga_theme") || "dark";
  function apply() { const p = pref(); document.documentElement.dataset.theme = p === "system" ? (light.matches ? "light" : "dark") : p; }
  apply(); light.addEventListener?.("change", apply);
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
.shell-pop hr { border: 0; border-top: 1px solid var(--line); margin: 6px 0; }`;
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
        <div class="sl">${L("语言", "Language")}</div><div class="sg">${[["zh", "中文"], ["en", "English"]].map(([k, n]) => `<button data-lang-pick="${k}" class="${LANG === k ? "on" : ""}">${n}</button>`).join("")}</div>
        <hr><a href="/agents${as}">${L("Agent 与连接", "Agents and connections")}</a><a href="/archive/console${as}">${L("旧的工作台和星空（存档）", "The old workbench and sky (archive)")}</a>`;
    };
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.shell) { pop.hidden = !pop.hidden; if (!pop.hidden) draw(); return; }
      if (b.dataset.themePick) { set("pga_theme", b.dataset.themePick); apply(); draw(); window.dispatchEvent(new Event("pga:theme")); return; }
      if (b.dataset.langPick) { set("pga_lang", b.dataset.langPick); const q = new URLSearchParams(location.search); q.delete("lang"); location.search = q.toString(); }
    });
    document.addEventListener("click", (e) => { if (!el.contains(e.target)) pop.hidden = true; });
  }
  window.PGAShell = { mount, L, LANG, apply };
})();
