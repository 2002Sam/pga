// Float windows open the node menu on a short click. WKWebView can send contextmenu
// on press or after release, so only replay an early menu once the click is known.
(() => {
  const bridge = window.webkit?.messageHandlers?.pga;
  if (!bridge) return;
  const show = () => bridge.postMessage({kind:"menu"});
  const textMenu = target => target.closest("textarea, input, select, [contenteditable]") || String(getSelection() || "");
  let press = null, suppressUntil = 0;

  addEventListener("pointerdown", e => {
    if (e.button !== 2) return;
    suppressUntil = 0;
    press = textMenu(e.target) ? null : {id:e.pointerId, x:e.screenX, y:e.screenY, at:e.timeStamp};
  }, true);
  addEventListener("pointermove", e => {
    if (press?.id === e.pointerId && Math.hypot(e.screenX - press.x, e.screenY - press.y) >= 6) press.cancelled = true;
  }, true);
  addEventListener("wheel", () => { if (press) press.cancelled = true; }, {passive:true, capture:true});
  function cancel() {
    if (press) suppressUntil = performance.now() + 300;
    press = null;
  }
  addEventListener("pointercancel", cancel, true);
  addEventListener("blur", cancel);
  addEventListener("keydown", e => { if (e.key === "Escape") cancel(); }, true);
  addEventListener("pointerup", e => {
    if (e.button !== 2 || press?.id !== e.pointerId) return;
    const click = !press.cancelled && e.timeStamp - press.at < 500, deferred = press.deferred;
    cancel();
    if (click && deferred) show();
    if (click && !deferred) suppressUntil = 0;
  }, true);
  addEventListener("contextmenu", e => {
    if (e.defaultPrevented || textMenu(e.target)) return;
    e.preventDefault();
    if (e.button === 2 && press) press.deferred = true;
    else if (e.button !== 2 || performance.now() >= suppressUntil) show();
  });
})();
