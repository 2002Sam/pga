// Talking to the native shell: messages out (open a conversation as a floating window, report what this window
// shows), calls in (files dropped from Finder, focus). In a plain browser the calls out fall back to navigation.
export function post(kind, data = {}) {
  const h = window.webkit?.messageHandlers?.pga;
  if (h) { h.postMessage({ kind, ...data }); return true; }
  if (kind === "open" || kind === "new") {
    const q = new URLSearchParams(location.search);
    q.set("mode", "float"); if (data.key) q.set("key", data.key); else q.delete("key");
    window.open("?" + q, "_blank", "width=440,height=600");
  }
  return false;
}

const handlers = {};
window.pgaNative = new Proxy({}, { get: (_, fn) => (...a) => handlers[fn]?.(...a) });
export function onNative(fn, h) { handlers[fn] = h; }

// Right-click anywhere (but in a text field, which keeps its own menu): the shell's menu of every node there is.
addEventListener("contextmenu", (e) => {
  if (!window.webkit?.messageHandlers?.pga || e.target.closest?.("textarea, input")) return;
  e.preventDefault(); post("menu");
});
