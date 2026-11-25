import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../desktop/Resources/context-menu.js', import.meta.url), 'utf8');
function desktopMenu() {
  const handlers = new Map(), menus = [];
  let time = 1000;
  const surface = {closest: () => null};
  vm.runInNewContext(source, {
    window: {webkit: {messageHandlers: {pga: {postMessage: m => menus.push(m.kind)}}}},
    addEventListener: (name, fn) => handlers.set(name, fn),
    performance: {now: () => time}, getSelection: () => ''
  });
  const emit = (name, args = {}) => {
    const e = {button:2, pointerId:1, screenX:10, screenY:10, timeStamp:time, target:surface,
      preventDefault() { this.defaultPrevented = true; }, ...args};
    handlers.get(name)(e);
    return e;
  };
  return {emit, menus, wait: ms => { time += ms; }};
}

test('the float menu opens once on short clicks, whether WebKit sends contextmenu before or after release', () => {
  for (const early of [true, false]) {
    const h = desktopMenu();
    h.emit('pointerdown');
    if (early) assert(h.emit('contextmenu').defaultPrevented);
    assert.equal(h.menus.length, 0);
    h.wait(80); h.emit('pointerup'); h.emit('contextmenu');
    assert.deepEqual(h.menus, ['menu']);
  }
});
test('holds, movement, wheel and cancelled presses suppress early and release menus', () => {
  for (const gesture of ['hold', 'drag', 'wheel', 'cancel', 'blur']) {
    const h = desktopMenu();
    h.emit('pointerdown'); h.emit('contextmenu');
    if (gesture === 'hold') h.wait(500);
    if (gesture === 'drag') h.emit('pointermove', {screenX:30});
    if (gesture === 'wheel') h.emit('wheel');
    if (gesture === 'cancel') h.emit('pointercancel');
    if (gesture === 'blur') h.emit('blur');
    h.emit('pointerup'); assert(h.emit('contextmenu').defaultPrevented);
    assert.equal(h.menus.length, 0, gesture);
    assert(!h.emit('contextmenu', {target:{closest: () => true}}).defaultPrevented);
    h.emit('contextmenu', {button:0}); assert.equal(h.menus.length, 1, 'keyboard menu is available');
  }
});
