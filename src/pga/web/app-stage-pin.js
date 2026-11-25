/* Keep the same DOM/iframe mounted. Fixed positioning is independent of scroll events,
   so trackpad, wheel, map navigation and right-drag all leave the pinned page still. */
function stPinToggle(n) {
  const arena = $('#starena'), el = n.el;
  if (!arena || !el) return;
  stReorderStop();
  if (n.screenPin) {
    const saved = n.screenPin, wins = stWins().filter(w => w !== n);
    let at = wins.findIndex(w => w.id === saved.next);
    if (at < 0) { const prev = wins.findIndex(w => w.id === saved.prev); at = prev < 0 ? Math.min(saved.index || 0, wins.length) : prev + 1; }
    wins.splice(at, 0, n); wins.forEach((w, i) => { w.ord = i; });
    delete n.screenPin;
    el.classList.remove('st-screen-pinned');
    ST.pinRestoring = true;
    try { stRender(); stShow(n.id); } finally { ST.pinRestoring = false; }
  } else {
    const wins = stWins(), index = wins.indexOf(n), r = el.getBoundingClientRect();
    n.screenPin = {x: 0, y: 2, width: r.width, index, prev: wins[index - 1]?.id, next: wins[index + 1]?.id};
    stRender();
  }
  stSave();
}
function stPinApply() {
  const arena = $('#starena'); if (!arena) return;
  for (const n of stWins()) {
    const el = n.el, head = el?.querySelector('.stwh'); if (!head) continue;
    let button = head.querySelector('[data-stw="pin"]');
    if (!button) {
      button = document.createElement('button'); button.type = 'button'; button.className = 'stb st-screen-pin'; button.dataset.stw = 'pin';
      head.insertBefore(button, head.querySelector('[data-stw="min"]'));
    }
    button.textContent = n.screenPin ? L('已固定', 'Pinned') : L('固定', 'Pin');
    button.title = n.screenPin ? L('解除固定，随台面移动', 'Unpin to move with the canvas') : L('独立固定在最左侧', 'Detach to the left edge');
    button.setAttribute('aria-pressed', String(!!n.screenPin));
    button.classList.toggle('on', !!n.screenPin);
    el.classList.toggle('st-screen-pinned', !!n.screenPin && !n.small);
  }
  stPinPlace(arena);
}
function stPinPlace(arena) {
  const pins = stWins().filter(n => n.screenPin && !n.small);
  const a = arena.getBoundingClientRect();
  let offset = 0;
  for (const n of pins) {
    const p = ST.pos?.get(n.id); if (!p || p.tab) continue;
    const el = n.el, pin = n.screenPin;
    const w = Math.min(pin.resizedWidth || pin.width || n.bw || ST_MINW, arena.clientWidth / pins.length), h = Math.min(p.h, arena.clientHeight);
    p.w = w;
    const x = offset; offset += w;
    const y = 2;
    el.style.setProperty('--screen-pin-x', a.left + x + 'px');
    el.style.setProperty('--screen-pin-y', a.top + y + 'px');
    el.style.setProperty('--screen-pin-w', w + 'px');
    el.style.setProperty('--screen-pin-h', h + 'px');
  }
}
// Navigate other pages into the largest unpinned portion of the arena when possible.
function stPinViewport(n, arena) {
  let ranges = [[0, arena.clientWidth]];
  const a = arena.getBoundingClientRect();
  for (const w of stWins()) {
    if (w === n || !w.screenPin || w.small || !w.el || w.el.hidden) continue;
    const r = w.el.getBoundingClientRect(), left = r.left - a.left, right = r.right - a.left;
    ranges = ranges.flatMap(([l, h]) => right <= l || left >= h ? [[l, h]] : [[l, Math.max(l, left)], [Math.min(h, right), h]]).filter(([l, h]) => h > l);
  }
  const best = ranges.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]))[0];
  return best && best[1] - best[0] >= Math.min(ST_SMALL, ST.pos?.get(n.id)?.w || ST_SMALL) ? best : [0, arena.clientWidth];
}
window.addEventListener('resize', () => requestAnimationFrame(stPinApply));
