import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/pga/web/app-stage.js', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('../src/pga/web/app.css', import.meta.url), 'utf8');
test('placing category captions never measures them, so folding cannot make the stage height oscillate', () => {
  const c = vm.createContext({ST: {mapPosition: 'top'}});
  vm.runInContext(source.slice(source.indexOf('function stCategoryPlace('), source.indexOf('// Use the same vertical projection')), c);
  const labels = [550, 28, 0].map((width, i) => ({
    style: {left: width + 'px', width: '40px'},
    label: {textContent: '分类名称' + i}, querySelector() {return this.label;},
    get offsetWidth() {throw Error('must not measure labels');}
  }));
  const row = {children: labels, style: {}, getBoundingClientRect: () => ({bottom: 50})};
  let bottom = '', writes = 0;
  const stage = {style: {getPropertyValue: () => bottom, setProperty: (_, v) => {bottom = v; writes++;}}, getBoundingClientRect: () => ({top: 0})};
  const inner = {querySelectorAll: () => labels, querySelector: () => row, closest: () => stage};
  c.stCategoryPlace(inner);
  c.stCategoryPlace(inner);
  assert.equal(row.style.height, '22px');
  assert.equal(writes, 1, 'the stage is resized once, not on every draw');
  assert.ok(labels.every(el => el.label.title === el.label.textContent));
  assert.ok(labels.every((el, i) => el.style.left === [550, 28, 0][i] + 'px'), 'placement made when drawn is kept');
});
function drawBar(nodes, mode, barWidth, pos = new Map(nodes.filter(w => !w.small).map((w, i) => [w.id, {x: i * 600, w: 580}]))) {
  let html = '';
  const inner = {style: {}, clientHeight: 22, querySelectorAll: () => [], querySelector: () => null, get innerHTML() {return html;}, set innerHTML(v) {html = v;}};
  const stage = {querySelector: () => null, appendChild() {}};
  const els = {'#starena': {scrollWidth: 4000, clientWidth: 1000}, '#vStage': stage, '#stmi': inner,
    '#stmap': {parentElement: stage, clientWidth: barWidth, clientHeight: 30, dataset: {}, style: {setProperty() {}}, classList: {toggle() {}}}};
  const recent = [{item: 'a1', title: 'A1', last: '2026-11-08T03:00:00Z'}, {item: 'b1', title: 'B1', last: '2026-11-08T02:00:00Z'}, {item: 'a2', title: 'A2', last: '2026-11-01T01:00:00Z'}];
  const c = vm.createContext({ST: {nodes, mapMode: mode, pos},
    S: {view: 'stage'}, window: {}, ST_MAPFOLD: 16, ST_GAP: 18, ST_WW: 660, $: id => els[id], L: a => a, esc: String, ago: () => 'ago', stWins: () => nodes, stStat: () => new Map(),
    stGroupOf: w => ({id: 'pj:' + w.g, name: w.g, c: 'red'}), stDraft: () => '', stMapBand: () => ({top: 0, height: 1}), stPanelTools() {}, stMapPositionApply() {}, stMapLayout() {},
    stFoldedAll: () => false, stMapView() {}, recentItems: () => recent});
  vm.runInContext(source.slice(source.indexOf('const ST_KEEP ='), source.indexOf('// Use the full page as the reference')), c);
  vm.runInContext(source.slice(source.indexOf('function stTalkOrder('), source.indexOf('const stLastAsk =')), c);
  vm.runInContext(source.slice(source.indexOf('function stMapBackgroundRuns('), source.indexOf('// Use the same vertical projection')), c);
  c.ST.mapMode = mode;
  c.stMap();
  return html;
}
test('each category caption aligns horizontally with its own colour band; a folded-away category has none', () => {
  const nodes = [{id: 'a1', key: 'a1', type: 'win', g: 'A'}, {id: 'a2', key: 'a2', type: 'win', g: 'A'},
    {id: 'b1', key: 'b1', type: 'win', g: 'B'}, {id: 'c1', key: 'c1', type: 'win', g: 'C', small: true}];
  const html = drawBar(nodes, 'cat', 150);
  const bands = [...html.matchAll(/<i class="mwsline" style="--wc:red;left:([\d.]+)px;width:([\d.]+)px" title="(\w)"/g)].map(m => [m[3], m[1], m[2]]);
  const captions = [...html.matchAll(/class="pj-actions stcategory( \w+)?" style="--wc:red;left:([\d.]+)px;width:([\d.]+)px">.*?<button class="stcatmin" data-stcatfold="pj:(\w)"/g)].map(m => [m[4], m[2], m[3], (m[1] || '').trim()]);
  // three 580px pages in 150px: (150 - 2 hairlines of 2px) / 1740 each, so 48.7px slots
  assert.deepEqual(bands, [['A', '0.0', '99.3'], ['B', '101.3', '48.7']]);
  assert.deepEqual(captions.map(x => x.slice(0, 3)), bands, 'same left and width as the band above');
  assert.deepEqual(captions.map(x => x[3]), ['mid', 'tight'], 'narrow bands use a compact caption');
  assert.doesNotMatch(html, /data-sttidycat|data-rcons|data-mapexpand/);
  const actions = [...html.matchAll(/<span class="pj-actions stcategory[^>]*>(.*?)<\/span>/g)]
    .map(match => [...match[1].matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(button => button[1]));
  assert.deepEqual(actions, [['－', 'A', '＋'], ['－', 'B', '＋']]);
  assert.ok(!html.includes('data-stcatfold="pj:C"'), 'no caption for a category with nothing on the bar');
  assert.match(html, /data-stmapmode="time"[^>]*>分类</);
});
test('interleaved categories and mixed branch stacks each get disjoint caption space', () => {
  const names = ['世界模型分块与融合', 'PGA', '世界模型分块与融合', 'PGA'];
  const nodes = names.map((g, i) => ({id: 'n' + i, key: 'n' + i, type: 'win', g}));
  const pos = new Map(nodes.map((w, i) => [w.id, {x: Math.min(i, 2) * 600, y: i * 10, w: 580}]));
  const html = drawBar(nodes, 'cat', 184, pos);
  const labels = [...html.matchAll(/class="pj-actions stcategory[^"]*" style="--wc:red;left:([\d.]+)px;width:([\d.]+)px">.*?data-pjmap="([^"]+)"/g)];
  assert.deepEqual(labels.map(m => m[3]), names);
  assert.deepEqual(labels.map(m => [Number(m[1]), Number(m[2])]), [[0,60],[62,60],[124,30],[154,30]]);
});
test('by time: newest first, each slot keeps its category colour, captions name the stretch of time', () => {
  // by time the stage itself stands newest first (stGroupGather), and the bar draws it as it stands
  const nodes = [{id: 'a1', key: 'a1', type: 'win', g: 'A'}, {id: 'b1', key: 'b1', type: 'win', g: 'B'}, {id: 'a2', key: 'a2', type: 'win', g: 'A'}];
  const html = drawBar(nodes, 'time', 300);
  const slots = [...html.matchAll(/<i class="mpage mws[^"]*" style="--wc:red;left:([\d.]+)px[^"]*" title="(\w+) · /g)].map(m => m[2]);
  assert.deepEqual(slots, ['A1', 'B1', 'A2']);
  assert.equal([...html.matchAll(/class="mwsline"/g)].length, 3, 'a colour line under every slot, not one band across interleaved categories');
  assert.equal([...html.matchAll(/class="stcategory stmapage/g)].length >= 1, true);
  assert.ok(!html.includes('data-stcatfold'), 'category controls belong to the category view');
  assert.ok(!html.includes('class="mseq'), 'no per-category order badges: the order is the time');
  assert.match(html, /data-stmapmode="cat"[^>]*>时间</);
});
test('captions are placed absolutely in a row that does not scroll', () => {
  assert.match(css, /#vStage #stmi \.stcategoryrow \{[^}]*display:block;[^}]*overflow:visible/s);
  assert.match(css, /#vStage #stmi \.stcategoryrow > \.stcategory \{[^}]*position:absolute;[^}]*min-width:0/s);
  assert.doesNotMatch(source, /row\.scrollLeft \+=/);
});
test('the bar is the stage in miniature: its order, and each page width in proportion, whatever the sort would say', () => {
  // stage: B's page first, then A's two; A's second page is twice as wide
  const nodes = [{id: 'b1', key: 'b1', type: 'win', g: 'B'}, {id: 'a1', key: 'a1', type: 'win', g: 'A'}, {id: 'a2', key: 'a2', type: 'win', g: 'A'}];
  const html = drawBar(nodes, 'cat', 404, new Map([['b1', {x: 0, w: 500}], ['a1', {x: 518, w: 500}], ['a2', {x: 1036, w: 1000}]]));
  assert.deepEqual([...html.matchAll(/<i class="mpage mws[^"]*" style="--wc:red;left:([\d.]+)px[^"]*" title="(\w+) · /g)].map(m => m[2]), ['B1', 'A1', 'A2'], 'stage order, not by latest exchange');
  const slots = [...html.matchAll(/<i class="mpage[^"]*" style="--wc:red;left:([\d.]+)px;width:([\d.]+)px"/g)].map(m => [Number(m[1]), Number(m[2])]);
  assert.equal(slots.length, 3);
  for (let i = 1; i < 3; i++) assert.ok(slots[i][0] > slots[i - 1][0] + slots[i - 1][1], 'slots in order, never overlapping');
  assert.deepEqual(slots.map(x => x[1]), [100, 100, 200], 'each slot as wide as its page, in proportion');
  assert.deepEqual(slots.map(x => x[0]), [0, 102, 204], 'a 2px hairline between slots');
});
test('a stack of branches is one column of the bar, in bands as on the stage', () => {
  let html = '';
  const inner = {style: {}, clientHeight: 22, querySelectorAll: () => [], querySelector: () => null, get innerHTML() {return html;}, set innerHTML(v) {html = v;}};
  const stage = {querySelector: () => null, appendChild() {}};
  const els = {'#starena': {scrollWidth: 4000, clientWidth: 1000, clientHeight: 400}, '#vStage': stage, '#stmi': inner,
    '#stmap': {parentElement: stage, clientWidth: 202, clientHeight: 30, dataset: {}, style: {setProperty() {}}, classList: {toggle() {}}}};
  const nodes = [{id: 'p', key: 'p', type: 'win', g: 'A', kids: ['k1', 'k2']}, {id: 'k1', key: 'k1', type: 'win', g: 'A', par: 'p'}, {id: 'k2', key: 'k2', type: 'win', g: 'A', par: 'p'}];
  const c = vm.createContext({ST: {nodes, pos: new Map([['p', {x: 0, w: 600}], ['k1', {x: 604, y: 8, w: 600, h: 190, kid: true}], ['k2', {x: 604, y: 208, w: 600, h: 190, kid: true}]])},
    S: {view: 'stage'}, window: {}, ST_GAP: 18, ST_WW: 660, $: id => els[id], L: a => a, esc: String, ago: () => 'ago', stWins: () => nodes, stStat: () => new Map(),
    stGroupOf: w => ({id: 'pj:' + w.g, name: w.g, c: 'red'}), stDraft: () => '', stPanelTools() {}, stMapPositionApply() {}, stMapLayout() {}, stFoldedAll: () => false, stMapView() {}, recentItems: () => []});
  vm.runInContext(source.slice(source.indexOf('const ST_KEEP ='), source.indexOf('// Use the full page as the reference')), c);
  vm.runInContext(source.slice(source.indexOf('function stTalkOrder('), source.indexOf('const stLastAsk =')), c);
  vm.runInContext(source.slice(source.indexOf('function stMapBackgroundRuns('), source.indexOf('function stMapHit(')), c);
  c.stMap();
  assert.equal(c.ST.mapCols.length, 2, 'the page, and its stack of branches');
  const k1 = c.ST.mapPos.get('k1'), k2 = c.ST.mapPos.get('k2');
  assert.equal(k1.x, k2.x); assert.equal(k1.kid, true);
  assert.equal([...html.matchAll(/class="mbranch" style="top:([\d.]+)%/g)].length, 2);
});
