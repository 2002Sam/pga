import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync('src/pga/web/app-stage.js','utf8');
function harness(stack=false) {
 const a={id:'a'},b={id:'b',pre:120},c={id:'c',pre:40};
 const units=[{kind:'win',win:a,x:0,w:400,open:true}, stack ? {kind:'stack',par:a,wins:[b],x:554,w:400,open:true} : {kind:'win',win:b,x:540,w:400,open:true}, {kind:'win',win:c,x:1000,w:400,open:true}];
 const ST={units};const ctx=vm.createContext({ST,ST_FORKGAP:34});
 vm.runInContext(src.slice(src.indexOf('function stEdgeHold('),src.indexOf('function stGroups(')),ctx);
 return {ctx,ST,a,b,c};
}
test('right edge consumes gap before moving neighbour, and reversing drag restores it',()=>{
 const h=harness(),r={d:'e',off0:0,across:h.ctx.stEdgeHold('a','e')};
 for (const delta of [50,120,150,20,0,-30]) {
  h.ctx.stResizeIntoGap(r,delta,1200);
  const rightStart=h.a.bw+20+h.b.pre;
  assert.equal(rightStart,540+Math.max(0,delta-120));
  assert.equal(h.b.bw,400);assert.equal(h.c.bw,400);
 }
});
test('left edge consumes preceding gap while its right edge stays fixed',()=>{
 const h=harness(),r={d:'w',off0:7,across:h.ctx.stEdgeHold('b','w')};
 for(const dx of [-50,-120,-200,30,0]) {
  h.ctx.stResizeIntoGap(r,dx,1200);
  assert.equal(h.a.bw+20+h.b.pre+h.b.bw,940);
  assert.ok(h.b.pre>=0);assert.equal(h.a.bw,400);assert.equal(h.ST.shift,7);
 }
});
test('parent expands into branch gutter before shifting the entire stack',()=>{
 const h=harness(true),r={d:'e',off0:0,across:h.ctx.stEdgeHold('a','e')};
 h.ctx.stResizeIntoGap(r,20,1200);
 assert.equal(h.a.bw,420);assert.equal(h.a.branchGap,14);
 assert.equal(h.a.bw+h.a.branchGap,434);assert.equal(h.a.kw,400);
 h.ctx.stResizeIntoGap(r,50,1200);
 assert.equal(h.a.branchGap,0);assert.equal(h.a.bw,450);
});
test('branch stack left edge uses its own gutter and right edge uses next root gap',()=>{
 const h=harness(true),r={d:'w',off0:0,across:h.ctx.stEdgeHold('b','w')};
 h.ctx.stResizeIntoGap(r,-25,1200);
 assert.equal(h.a.kw,425);assert.equal(h.a.branchGap,9);
 const right={d:'e',off0:0,across:h.ctx.stEdgeHold('b','e')};
 h.ctx.stResizeIntoGap(right,25,1200);
 assert.equal(h.c.pre,15);assert.equal(h.c.bw,400);
});
