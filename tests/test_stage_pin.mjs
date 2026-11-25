import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('src/pga/web/app-stage-pin.js', 'utf8');
function harness() {
  const nodes = ['a','b','c'].map((id, ord) => ({id, ord, el: {classList:{remove(){}},getBoundingClientRect:()=>({width:500})}}));
  let renders=0;
  const c={ST:{},window:{addEventListener(){}},$:()=>({}),stWins:()=>nodes.slice().sort((a,b)=>a.ord-b.ord),stRender:()=>renders++,stShow(){},stSave(){},stReorderStop(){}};
  vm.runInNewContext(source,c); return {c,nodes,renders:()=>renders};
}
test('pin captures original neighbours and left position; unpin restores after intervening reorder',()=>{
  const {c,nodes,renders}=harness(); const [a,b,z]=nodes;
  c.stPinToggle(b); assert.equal(b.screenPin.x,0);assert.equal(b.screenPin.prev,'a');assert.equal(b.screenPin.next,'c');assert.equal(renders(),1);
  b.ord=0;a.ord=1;z.ord=2;c.stPinToggle(b);
  assert.deepEqual(c.stWins().map(n=>n.id),['a','b','c']);assert.equal(b.screenPin,undefined);assert.equal(c.ST.pinRestoring,false);
});
test('unpin falls back to surviving previous neighbour when next page was closed',()=>{
 const {c,nodes}=harness();const b=nodes[1];c.stPinToggle(b);nodes.pop();c.stPinToggle(b);assert.deepEqual(c.stWins().map(n=>n.id),['a','b']);
});
