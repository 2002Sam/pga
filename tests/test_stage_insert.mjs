import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../src/pga/web/app-stage.js', import.meta.url), 'utf8');
function setup() {
  const nodes = ['left', 'source', 'right'].map((id, ord) => ({id, key:id, type:'win', ord, bw:500, g:'PGA'}));
  const ST = {nodes, focus:'source', pos:new Map([['left',{x:0,w:400}],['source',{x:430,w:500}],['right',{x:940,w:500}]])}, calls = [];
  const arena = {scrollLeft:430, clientWidth:1100, scrollWidth:3000, scrollTo(o) {calls.push(o); this.scrollLeft=o.left;}, classList:{add(){}, remove(){}}};
  const c = vm.createContext({ST, performance, stNavigationStop(){}, stShiftMotion:null, $:()=>arena, recentItems:()=>[],
    stWins:()=>nodes.slice().sort((a,b)=>a.ord-b.ord), stId:()=> 'new',
    stLayout:()=>({off:0, units:[]}), stFreezeWidths:()=>calls.push('freeze'),
    stWs:()=>null, stGroupOf:n=>n.creationGroup || {id:'pj:PGA'}, stHalfWidth:()=>500,
    stFocus:()=>calls.push('focus-and-scroll'),
    stRender:()=>{ calls.push('render'); ST.pos.set('new',{x:940,w:500}); }, stSave(){}, stContexts(){},
    document:{querySelector:()=>null, querySelectorAll:()=>[]}, window:{}, cancelAnimationFrame(){}, stRecallPage(){}, L:a=>a
  });
  for (const [start,end] of [['function stAnchor()', 'function stKeepAnchor('],['function stInsertRight(', 'function stOpenAt('],['function stShow(', 'function stNavigationStop('],['function stMapTime(', 'const ST_MAPAGES']])
    vm.runInContext(src.slice(src.indexOf(start), src.indexOf(end)), c);
  return {c, ST, calls, arena};
}
for (const key of [null, 'new-key']) test(`insert ${key || 'blank'} beside source without viewport navigation`,()=>{
  const {c,ST,calls,arena}=setup();
  const n = c.stOpen(key, key ? {win:'source'} : undefined);
  assert.deepEqual(ST.nodes.slice().sort((a,b)=>a.ord-b.ord).map(n=>n.id), ['left','source','new','right']);
  assert.equal(n.from,'source'); assert.equal(n.creationGroup.id,'pj:PGA');
  assert.equal(arena.scrollLeft,430); assert.equal(ST.focus,'new');
  assert.ok(calls.includes('freeze')); assert.ok(calls.includes('render'));
  assert.equal(calls.filter(x=>x.left!=null).length,1); assert.ok(!calls.includes('focus-and-scroll'));
});
test('reopening an existing conversation still navigates to it',()=>{
  const {c,ST,calls,arena}=setup();arena.scrollLeft=0;c.stOpen('right',{win:'source'});
  assert.equal(ST.nodes.length,3);assert.equal(arena.scrollLeft,340);assert.ok(!calls.includes('freeze'));
});
test('new page uses the visible page after panning away from focus and reveals its right edge',()=>{
  const {c,ST,arena}=setup();ST.focus='left';arena.clientWidth=505;
  assert.equal(c.stOpen(null).from,'source');
  assert.equal(arena.scrollLeft,940+500-arena.clientWidth);
});
test('a fresh draft stays beside its source in time order until the next exchange',()=>{
  const {c,ST}=setup(), rows=['left','source','right','draft'].map((item,i)=>({item,last:new Date([3000,2000,1000,4000][i]).toISOString()}));
  ST.mapMode='time'; c.recentItems=()=>rows;
  const n=c.stOpen('draft',{win:'source'}), recent=new Map(rows.map(row=>[row.item,row]));
  const order=()=>Array.from(c.stWins().sort(c.stMapTimeOrder(recent)),w=>w.id);
  assert.deepEqual(order(),['left','source','new','right']);
  n.runAt=5000;assert.deepEqual(order(),['new','left','source','right']);
});
test('activity updates do not reorder inserted windows',()=>{
  const nodes=[{id:'source',ord:0},{id:'new',ord:1},{id:'right',ord:2}];
  const c=vm.createContext({ST:{nodes},stWins:()=>nodes,stGroupOf:()=>({id:'PGA'}),recentItems:()=>nodes.map((n,i)=>({item:n.id,last:String(i)}))});
  vm.runInContext(src.slice(src.indexOf('function stGroupGather()'),src.indexOf('function stWsLook(')),c);
  vm.runInContext(src.slice(src.indexOf('const ST_KEEP ='),src.indexOf('// Use the full page as the reference')),c);
  assert.equal(c.stGroupGather(),false); assert.deepEqual(nodes.map(n=>n.ord),[0,1,2]);
});
