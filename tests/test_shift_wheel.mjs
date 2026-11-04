import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/pga/web/app-stage.js', import.meta.url), 'utf8');
function setup() {
  const arena = {scrollLeft:100, scrollWidth:1800, clientWidth:600,isConnected:true};
  let now=0; const frames=[];
  const ctx = vm.createContext({$:()=>arena,S:{view:'stage'},ST:{},window:{matchMedia:()=>({matches:false})},requestAnimationFrame:f=>(frames.push(f),frames.length)});
  const step=()=>{const f=frames.shift();if(f)f(now+=16.7);};
  const drain=()=>{let count=0;while(frames.length && count++<100)step();assert(count<100);};
  vm.runInContext(source.slice(source.indexOf('let stShiftMotion ='),source.indexOf('window.stShiftWheel =')),ctx);
  const event=(over={})=>ctx.stShiftWheel({shiftKey:true,deltaX:0,deltaY:60,deltaMode:0,...over});
  return {arena,ctx,frames,step,drain,event,wheel:over=>{const result=event(over);drain();return result;}};
}
test('Shift-wheel pans both directions and accepts already translated horizontal deltas',()=>{
  const h=setup(); assert.equal(h.wheel(),true); assert.equal(h.arena.scrollLeft,160);
  h.wheel({deltaY:-40}); assert.equal(h.arena.scrollLeft,120);
  h.wheel({deltaX:50,deltaY:0}); assert.equal(h.arena.scrollLeft,170);
  h.wheel({deltaX:50,deltaY:50}); assert.equal(h.arena.scrollLeft,220);
});
test('line/page wheel units and stage boundaries are respected without wrapping',()=>{
  const h=setup(); h.wheel({deltaY:2,deltaMode:1}); assert.equal(h.arena.scrollLeft,164);
  h.wheel({deltaY:1,deltaMode:2}); assert.equal(h.arena.scrollLeft,764);
  h.wheel({deltaY:10000}); assert.equal(h.arena.scrollLeft,1200);
  h.wheel({deltaY:-10000}); assert.equal(h.arena.scrollLeft,0);
});
test('ordinary scrolling, zoom gestures and active drags remain untouched',()=>{
  const h=setup();
  for(const flags of [{shiftKey:false},{ctrlKey:true},{metaKey:true}]) assert.equal(h.wheel(flags),false);
  h.ctx.ST.drag={}; assert.equal(h.wheel(),false); assert.equal(h.arena.scrollLeft,100);
});

test('wheel bursts share a frame, reverse promptly and settle exactly',()=>{
 const h=setup();for(let i=0;i<20;i++)h.event({deltaY:40});
 assert.equal(h.frames.length,1);assert.equal(h.arena.scrollLeft,100);
 h.step();const forward=h.arena.scrollLeft;assert(forward>100&&forward<900);
 h.event({deltaY:-60});h.step();assert(h.arena.scrollLeft<forward);h.drain();
 assert(Math.abs(h.arena.scrollLeft-(forward-60))<0.001);
});
test('fine wheel input is direct and external navigation cancels smoothing',()=>{
 const h=setup();h.event({deltaY:3});h.step();assert.equal(h.arena.scrollLeft,103);
 h.event();h.step();h.arena.scrollLeft=700;h.drain();assert.equal(h.arena.scrollLeft,700);
 h.event();h.ctx.ST.pan={};h.drain();assert.equal(h.arena.scrollLeft,700);
});
