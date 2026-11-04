import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../src/pga/web/app-stage.js', import.meta.url), 'utf8');
function setup() {
  const nodes = ['left', 'source', 'right'].map((id, ord) => ({id, key:id, type:'win', ord, bw:500, g:'PGA'}));
  const ST = {nodes, focus:'source'}, calls = [];
  const arena = {scrollLeft:430, scrollTo(o) {calls.push(o); this.scrollLeft=o.left;}};
  const c = vm.createContext({ST, stShiftMotion:null, $:()=>arena,
    stWins:()=>nodes.slice().sort((a,b)=>a.ord-b.ord), stId:()=> 'new',
    stLayout:()=>({off:0, units:[]}), stFreezeWidths:()=>calls.push('freeze'),
    stWs:()=>null, stGroupOf:n=>n.creationGroup || {id:'pj:PGA'}, stHalfWidth:()=>500,
    stFocus:()=>calls.push('focus-and-scroll'), stShow:()=>calls.push('scroll'),
    stRender:()=>calls.push('render'), stSave(){}, stContexts(){},
    document:{querySelector:()=>null}, window:{}, cancelAnimationFrame(){}
  });
  vm.runInContext(src.slice(src.indexOf('function stOpen(key, at)'), src.indexOf('function stOpenAt(')), c);
  return {c, ST, calls, arena};
}
for (const key of [null, 'new-key']) test(`insert ${key || 'blank'} beside source without viewport navigation`,()=>{
  const {c,ST,calls,arena}=setup();
  const n = c.stOpen(key, key ? {win:'source'} : undefined);
  assert.deepEqual(ST.nodes.slice().sort((a,b)=>a.ord-b.ord).map(n=>n.id), ['left','source','new','right']);
  assert.equal(n.from,'source'); assert.equal(n.creationGroup.id,'pj:PGA');
  assert.equal(arena.scrollLeft,430); assert.equal(ST.focus,'new');
  assert.ok(calls.includes('freeze')); assert.ok(calls.includes('render'));
  assert.ok(!calls.includes('scroll')); assert.ok(!calls.includes('focus-and-scroll'));
});
test('reopening an existing conversation still navigates to it',()=>{
  const {c,ST,calls}=setup();c.stOpen('right',{win:'source'});
  assert.equal(ST.nodes.length,3);assert.ok(calls.includes('scroll'));assert.ok(!calls.includes('freeze'));
});
test('activity updates do not reorder inserted windows',()=>{
  const nodes=[{id:'source',ord:0},{id:'new',ord:1},{id:'right',ord:2}];
  const c=vm.createContext({ST:{nodes},stWins:()=>nodes,stGroupOf:()=>({id:'PGA'}),recentItems:()=>nodes.map((n,i)=>({item:n.id,last:String(i)}))});
  vm.runInContext(src.slice(src.indexOf('function stGroupGather()'),src.indexOf('function stWsLook(')),c);
  assert.equal(c.stGroupGather(),false); assert.deepEqual(nodes.map(n=>n.ord),[0,1,2]);
});
