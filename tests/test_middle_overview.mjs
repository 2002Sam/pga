import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../src/pga/web/app-stage.js', import.meta.url), 'utf8');
test('picking up a page with a folded category on the stage: its upright name is one part of the row, its pages keep together', () => {
  const page = id => ({ id, el: { hidden: false } }), a = page('a'), b = page('b'), held = page('held');
  const marker = { style: { left: '1300px' } }, other = { style: { left: '40px' } };
  const units = [{ kind: 'win', win: a, x: 12, w: 600, open: true }, { kind: 'win', win: held, x: 630, w: 600, open: true },
    { kind: 'cat', g: { id: 'pj:B' }, wins: [b, page('b2')], x: 1300, w: 22, open: true }];
  const c = vm.createContext({ ST: { units }, ST_TAB: 150, document: { querySelector: () => null, querySelectorAll: s => s === '#stbars > .stcatfold' ? [marker, other] : [] } });
  vm.runInContext(src.slice(src.indexOf('function stGroups('), src.indexOf('/* Dragging translates rigid pages.')), c);
  const gs = c.stGroups(held);
  const cat = gs.find(g => g.key === 'cat');
  assert.ok(cat, 'the folded category is in the row');
  assert.deepEqual([...cat.wins], ['b', 'b2']); assert.equal(cat.els.length, 1); assert.equal(cat.els[0], marker); assert.equal(cat.x, 1300);
});
test('a page that cannot be picked up leaves nothing held, so the press moves the stage instead', () => {
  const classes = new Set(), stage = new Set(['dragging']);
  const el = { classList: { add: (...x) => x.forEach(y => classes.add(y)), remove: (...x) => x.forEach(y => classes.delete(y)) }, setAttribute() {} };
  const n = { id: 'n', type: 'win' };
  const c = vm.createContext({ ST: { nodes: [n] }, console: { error() {} }, document: { querySelectorAll: () => [] },
    $: () => ({ classList: { remove: x => stage.delete(x) } }),
    stGrab: () => { c.ST.drag = { n, el }; classes.add('held'); }, stDockStart: () => { throw new TypeError('boom'); } });
  vm.runInContext(src.slice(src.indexOf('function stMiddleGrab('), src.indexOf('function stMiddleFrameGrab(')), c);
  assert.equal(c.stMiddleGrab(n, 0, 0, 0), false);
  assert.equal(c.ST.drag, null); assert.equal(classes.has('held'), false); assert.equal(stage.has('dragging'), false);
});
