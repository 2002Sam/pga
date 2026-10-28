/* Added by PGA 浮窗 to the browser version's own pages when it shows them (the full conversation page in a window, the
   whole app in 完整版). PGA's code is not changed: this only connects those pages to the desktop app.
   - tells the window which conversation it shows and what it is called (a new one has its key after the first message);
   - right-click (outside text fields): the desktop app's menu of every node there is;
   - what is wired into the window's left dot goes to its conversation's agents (PUT /chat-context), as on the stage;
   - focus: into the composer;
   - in 完整版, the stage has no dark bar across its top, and the window (which has no title bar) moves by the page's
     empty top edge. */
(() => {
  const N = window.PGA_NATIVE || {};
  const post = (m) => { try { webkit.messageHandlers.pga.postMessage(m); } catch (e) {} };
  const g = (name) => { try { return eval(name); } catch (e) { return undefined; } };   // the page's own globals (S, cmTitle)
  const Q = new URLSearchParams(location.search);
  const key = () => { const S = g("S"); return (S && S.chat) || Q.get("item") || ""; };
  const title = () => { const t = g("cmTitle"); try { return (typeof t === "function" && t()) || ""; } catch (e) { return ""; } };

  if (N.float) {
    let last = "";
    setInterval(() => {
      const k = key(), t = title(), sig = k + "|" + t;
      if (sig !== last) { last = sig; post({ kind: "state", key: k, title: t }); }
    }, 1200);
    addEventListener("load", () => post({ kind: "ready" }));
  }

  if (!N.float) {                                  // 完整版: no dark bar across the top of the stage — its hint goes, its two buttons stay in the corner
    const st = document.createElement("style");
    st.textContent = `#stbar { left: auto !important; right: 12px !important; top: 6px !important; padding: 0 !important; background: transparent !important;
        border: 0 !important; box-shadow: none !important; backdrop-filter: none !important; }
      #stbar > .cvdim, #stbar > .grow { display: none !important; }
      #vStage .starena { top: 38px !important; }
      .app:not(.onstage) { padding-top: 26px; } .app.onstage .rail .brand { padding-top: 34px; }`;   /* clear of the window's buttons (the strip moves the window) */
    document.head.appendChild(st);
    // the window has no title bar: its empty top edge moves it (a double-click zooms it)
    const free = (e) => e.clientY < 30 && !e.target.closest("button, a, input, textarea, select, label, [contenteditable], [data-rz], [data-lrz], .stwh, .stlh, .stnode, .padgrip, .split");
    addEventListener("mousedown", (e) => { if (e.button === 0 && e.detail === 1 && free(e)) { e.preventDefault(); post({ kind: "drag" }); } }, true);
    addEventListener("dblclick", (e) => { if (free(e)) post({ kind: "zoom" }); }, true);
    let bg = "";                                   // the window's strip at the top takes the page's colour (and follows the theme)
    const tell = () => { const c = getComputedStyle(document.querySelector(".app") || document.body).backgroundColor;
      if (c && c !== bg && !/rgba\(0, 0, 0, 0\)/.test(c)) { bg = c; post({ kind: "bg", color: c }); } };
    addEventListener("load", tell); setInterval(tell, 2000);
  }

  addEventListener("contextmenu", (e) => {
    if (!N.float || e.target.closest("textarea, input, [contenteditable]") || String(getSelection() || "")) return;
    e.preventDefault(); post({ kind: "menu" });
  });

  let inputs = [], sent = null;
  async function context() {
    const uid = N.uid, k = key(); if (!uid || !k) return;
    const parts = await Promise.all(inputs.map(async (x) => {
      if (x.type !== "conv") return x.text || "";
      if (!x.key) return "";
      try {
        const c = await (await fetch(`/v1/users/${uid}/chats/${encodeURIComponent(x.key)}/context`)).json();
        return `Another conversation of the user, «${x.title}». What was asked there:\n` + (c.questions || []).slice(-15).map((q) => `- ${String(q.text || "").slice(0, 300)}`).join("\n");
      } catch (e) { return ""; }
    }));
    const text = parts.filter(Boolean).join("\n\n");
    if (text === sent || (!text && sent === null)) return;
    try { await fetch(`/v1/users/${uid}/chat-context`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: k, text }) }); sent = text; } catch (e) {}
  }
  let lastKey = "";
  setInterval(() => { const k = key(); if (k && k !== lastKey) { lastKey = k; sent = null; if (inputs.length) context(); } }, 1500);   // a new conversation got its key

  window.pgaNative = {
    inputs: (xs) => { inputs = xs || []; context(); },
    focus: () => { const t = document.querySelector("#chatText"); if (t) t.focus(); },
    dropped: (paths) => { const t = document.querySelector("#chatText"); if (!t) return; t.value = (t.value ? t.value + "\n" : "") + paths.map((p) => "文件：" + p).join("\n"); t.dispatchEvent(new Event("input")); t.focus(); },
    dragging: () => {},
  };
})();
