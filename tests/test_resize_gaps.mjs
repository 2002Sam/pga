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
test('left edge translates preceding pages at fixed widths and keeps its right edge fixed',()=>{
 const h=harness(),r={d:'w',off0:7,across:h.ctx.stEdgeHold('b','w')};
 for(const dx of [-50,-120,-200,30,0]) {
  h.ctx.stResizeIntoGap(r,dx,1200);
  const left=(h.a.pre||0)-r.scrollTarget;
  assert.equal(left,7+dx);
  assert.equal(left+h.a.bw+20+h.b.pre+h.b.bw,947);
  assert.equal(h.b.bw,400-dx);assert.equal(h.b.pre,120);
  assert.equal(h.a.bw,400);assert.equal(h.c.bw,400);
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
 assert.equal(h.a.kw,425);assert.equal(h.a.branchGap,undefined);assert.equal(r.scrollTarget,25);
 const right={d:'e',off0:0,across:h.ctx.stEdgeHold('b','e')};
 h.ctx.stResizeIntoGap(right,25,1200);
 assert.equal(h.c.pre,15);assert.equal(h.c.bw,400);
});
test('manual resize leaves enlarged mode at the displayed width, without changing neighbours',()=>{
 const h=harness();Object.assign(h.b,{big:true,fullscreen:true,bigWidth:900});h.a.big=true;
 const r={d:'w',off0:0,across:h.ctx.stEdgeHold('b','w')};
 h.ctx.stResizeIntoGap(r,0,1200);
 assert.equal(h.b.big,true,'pressing an edge alone does not change sizing mode');
 h.ctx.stResizeIntoGap(r,60,1200);
 assert.equal(h.b.bw,340);assert.equal(h.b.big,undefined);assert.equal(h.b.fullscreen,undefined);assert.equal(h.b.bigWidth,undefined);
 assert.equal(h.a.big,true,'unrelated enlarged page is preserved');
});
test('resizing a shared branch column clears the enlarged override on every member',()=>{
 const h=harness(true),other={id:'other',big:true,bigWidth:700};h.ST.units[1].wins.push(other);h.b.big=true;
 const r={d:'e',off0:0,across:h.ctx.stEdgeHold('b','e')};
 h.ctx.stResizeIntoGap(r,50,1200);
 assert.equal(h.a.kw,450);assert.equal(h.b.big,undefined);assert.equal(other.big,undefined);assert.equal(other.bigWidth,undefined);
});
