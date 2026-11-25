import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('src/pga/web/app-stage.js', 'utf8');
const bindStart = source.indexOf('function stCap(');
const bindEnd = source.indexOf('\ndocument.addEventListener("click"', bindStart);
const bindSource = source.slice(bindStart, bindEnd);

function harness() {
  const arenaEvents = new Map(), documentEvents = new Map(), windowEvents = new Map();
  const classes = new Set();
  const classList = {
    add: (...names) => names.forEach(name => classes.add(name)),
    remove: (...names) => names.forEach(name => classes.delete(name)),
    contains: name => classes.has(name),
  };
  const arena = {addEventListener: (name, fn) => arenaEvents.set(name, fn), setPointerCapture(id) { this.captured = id; }, hasPointerCapture: () => false};
  const v = {classList, addEventListener() {}};
  const n = {id: 'doc', type: 'win', mini: true, bw: 420};
  const nodeEl = {dataset: {nid: n.id}, style: {left: '30px', top: '20px'}, offsetWidth: 420, offsetHeight: 300};
  const handle = {dataset: {rz: 'e'}, closest(selector) {
    if (selector.includes('[data-rz]')) return this;
    if (selector === '.stnode') return nodeEl;
    return null;
  }, setPointerCapture(id) { this.captured = id; }, hasPointerCapture(id) { return this.captured === id; }, releasePointerCapture(id) { if (this.captured === id) this.captured = null; }};
  const document = {addEventListener: (name, fn) => documentEvents.set(name, fn), querySelector: () => null};
  const window = {addEventListener: (name, fn) => windowEvents.set(name, fn), getSelection: () => null};
  let saves = 0;
  const ST = {nodes: [n], units: [], focus: n.id};
  const context = {
    ST, S: {view: 'stage'}, document, window,
    $: selector => selector === '#vStage' ? v : selector === '#starena' ? arena : null,
    stRightPanBind() {}, stMiddlePanBind() {}, stPageClickBind() {}, stReorderStop() {},
    stArena: () => ({w: 1200, h: 800}), stSave: () => saves++, stRender() {}, stMapView() {},
    stScrollTo() {}, stLayout: () => ({off: 0}), stEdgeHold: () => null,
    stResizeIntoGap() {}, stSL: () => 0, stPanEnd() {}, stWireEnd() {}, stDragFlush() {}, stDrop() {},
    stDockCancel() {}, stClickSize() {}, stContexts() {}, getSelection: () => null,
    ST_DBL_SKIP: '.skip', L: x => x, Math,
  };
  vm.runInNewContext(bindSource, context);
  context.stBind();
  const pointer = (pointerId, extra = {}) => ({
    pointerId, button: 0, clientX: 100, clientY: 100, screenX: 100, screenY: 100,
    target: handle, preventDefault() {}, stopPropagation() {}, ...extra,
  });
  return {ST, arena, arenaEvents, documentEvents, windowEvents, classes, n, handle, pointer, get saves() { return saves; }};
}

test('resize pointer cancellation clears only the matching pointer and dragging state', () => {
  const h = harness();
  h.arenaEvents.get('pointerdown')(h.pointer(7));
  assert(h.ST.rz, 'edge pointerdown starts resize');
  assert.equal(h.ST.rz.capture, h.handle, 'capture belongs to the edge handle so double-click stays targeted');
  assert.equal(h.handle.captured, 7);
  assert(h.classes.has('dragging') && h.classes.has('resizing'));

  h.arenaEvents.get('pointercancel')(h.pointer(8));
  assert(h.ST.rz, 'unrelated pointer cancellation must not end this resize');
  h.arenaEvents.get('pointercancel')(h.pointer(7));
  assert.equal(h.ST.rz, null);
  assert(!h.classes.has('dragging') && !h.classes.has('resizing'));
  assert.equal(h.saves, 1, 'cancel commits current in-progress dimensions once');
});

test('capturing the resize handle preserves the double-click reset target', () => {
  const h = harness();
  h.n.mw = 510; h.n.mh = 330;
  h.arenaEvents.get('pointerdown')(h.pointer(9));
  assert.equal(h.ST.rz.capture, h.handle);
  const dblclick = h.arenaEvents.get('dblclick');
  dblclick({target: h.handle});
  assert.equal(h.n.mw, undefined, 'double-clicking the captured edge restores default width');
  assert.equal(h.n.mh, undefined, 'double-clicking the captured edge restores default height');
  assert.equal(h.saves, 1);
});

test('lost pointer capture from the captured edge handle ends resize; unrelated loss is ignored', () => {
  const h = harness();
  h.arenaEvents.get('pointerdown')(h.pointer(11));
  const lost = h.arenaEvents.get('lostpointercapture');
  assert.equal(typeof lost, 'function', 'resize capture loss is observed');
  lost({pointerId: 11, target: h.arena});
  assert(h.ST.rz, 'loss of the old arena capture target is ignored');
  lost({pointerId: 11, target: {}});
  assert(h.ST.rz, 'capture loss from another target is ignored');
  lost({pointerId: 12, target: h.handle});
  assert(h.ST.rz, 'capture loss for another pointer is ignored');
  lost({pointerId: 11, target: h.handle});
  assert.equal(h.ST.rz, null);
  assert(!h.classes.has('dragging') && !h.classes.has('resizing'));
  assert.equal(h.saves, 1);
  assert.equal(h.handle.captured, null, 'ending resize releases the original capture target');
});

test('window blur forcibly clears an active resize and later pointerup is harmless', () => {
  const h = harness();
  h.arenaEvents.get('pointerdown')(h.pointer(13));
  const blur = h.windowEvents.get('blur');
  assert.equal(typeof blur, 'function', 'window blur cleanup is bound');
  blur();
  assert.equal(h.ST.rz, null);
  assert(!h.classes.has('dragging') && !h.classes.has('resizing'));
  h.arenaEvents.get('pointerup')(h.pointer(13));
  assert.equal(h.saves, 1, 'cleanup remains idempotent after blur');
});
