import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../src/pga/web/app-stage.js', import.meta.url), 'utf8');
const helpers = src.slice(src.indexOf('try { ST.mapPosition ='), src.indexOf('function stMapLayout('));
function harness(saved, blocked = false) {
  const storage = new Map(saved == null ? [] : [['pga_map_position', saved]]);
  const attrs = {}, button = {setAttribute(k,v){attrs[k]=v;}}, classes = new Set();
  const v = {classList:{toggle(k,on){on ? classes.add(k) : classes.delete(k);}},querySelector(){return button;}};
  let renders = 0, hides = 0;
  const ctx = { ST:{}, L:zh=>zh, localStorage:{getItem(k){if(blocked) throw Error();return storage.get(k);},setItem(k,v){if(blocked) throw Error();storage.set(k,v);}},stMapHideTip(){hides++;},stRender(){renders++;} };
  vm.runInNewContext(helpers, ctx);
  return {ctx, storage, attrs, button, classes, v, get renders(){return renders;},get hides(){return hides;}};
}
test('position defaults to top and restores only valid bottom preference', () => {
  assert.equal(harness().ctx.ST.mapPosition,'top');
  assert.equal(harness('bottom').ctx.ST.mapPosition,'bottom');
  assert.equal(harness('invalid').ctx.ST.mapPosition,'top');
});
test('switching persists preference, cancels dragging and refreshes layout', () => {
  const h=harness(); h.ctx.ST.mapDrag={moved:true};
  h.ctx.stMapPositionSet('bottom');h.ctx.stMapPositionApply(h.v);
  assert.equal(h.storage.get('pga_map_position'),'bottom');
  assert.equal(h.ctx.ST.mapDrag,null);assert.equal(h.renders,1);assert.equal(h.hides,1);
  assert.ok(h.classes.has('map-bottom'));assert.equal(h.button.textContent,'↑');
  assert.equal(h.attrs['aria-pressed'],'true');assert.equal(h.attrs['aria-label'],'导航条移到顶部');
  h.ctx.stMapPositionSet('top');h.ctx.stMapPositionApply(h.v);
  assert.equal(h.storage.get('pga_map_position'),'top');assert.ok(!h.classes.has('map-bottom'));
  assert.equal(h.button.textContent,'↓');assert.equal(h.attrs['aria-pressed'],'false');
});
test('unavailable localStorage does not prevent switching', () => {
  const h=harness(null,true);h.ctx.stMapPositionSet('bottom');
  assert.equal(h.ctx.ST.mapPosition,'bottom');assert.equal(h.renders,1);
});
test('bottom captions do not overwrite the canvas top inset', () => {
  const h=harness('bottom');let writes=0;
  const row={children:[{}],style:{},getBoundingClientRect(){throw Error('must not measure bottom captions as a top inset');}};
  const inner={querySelectorAll:()=>[],querySelector:()=>row,closest:()=>({style:{setProperty(){writes++;}}})};
  vm.runInNewContext(src.slice(src.indexOf('function stCategoryPlace('),src.indexOf('// Use the same vertical projection')),h.ctx);
  h.ctx.stCategoryPlace(inner);assert.equal(writes,0);assert.equal(row.style.height,'22px');
});
test('position control is wired independently of map navigation', () => {
  assert.match(src,/type="button" class="stb stmapbtn" data-stmapposition/);
  assert.match(src,/closest\('\[data-stmapposition\]'\).*e\.stopPropagation\(\); stMapPositionSet/);
});
