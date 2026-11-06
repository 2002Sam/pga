import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/pga/web/app-stage.js', import.meta.url), 'utf8');
function setup() {
  const arena = {scrollLeft:100, scrollWidth:1800, clientWidth:600, isConnected:true, scrollTo({left}) { this.scrollLeft = left; }};
  let now = 0, nextFrame = 0;
  const frames = new Map(), events = new Map();
  const win = {matchMedia:()=>({matches:false}), addEventListener:(name,handler)=>events.set(name,handler)};
  win.parent = win;
  const ctx = vm.createContext({$:()=>arena, S:{view:'stage'}, ST:{}, window:win,
    document:{hidden:false, addEventListener:(name,handler)=>events.set(name,handler)}, stScheduleScroll(){},
    requestAnimationFrame:handler=>{frames.set(++nextFrame,handler);return nextFrame;}, cancelAnimationFrame:id=>frames.delete(id)});
  const step = () => { const pending = [...frames.values()]; frames.clear(); now += 16.7; pending.forEach(handler=>handler(now)); };
  const drain = () => { let count=0;while(frames.size && count++<100)step();assert(count<100); };
  vm.runInContext(source.slice(source.indexOf('function stEdgeWheel('),source.indexOf('// Top and bottom strips')),ctx);
  const event=(over={})=>ctx.stShiftWheel({shiftKey:true,deltaX:0,deltaY:60,deltaMode:0,...over});
  return {arena,ctx,frames,events,step,drain,event,wheel:over=>{const result=event(over);drain();return result;}};
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
 assert.equal(h.frames.size,1);assert.equal(h.arena.scrollLeft,100);
 h.step();const forward=h.arena.scrollLeft;assert(forward>100&&forward<900);
 h.event({deltaY:-60});h.step();assert(h.arena.scrollLeft<forward);h.drain();
 assert(Math.abs(h.arena.scrollLeft-(forward-60))<0.001);
});
test('fine wheel input is direct and external navigation cancels smoothing',()=>{
 const h=setup();h.event({deltaY:3});h.step();assert.equal(h.arena.scrollLeft,103);
 h.event();h.step();h.arena.scrollLeft=700;h.drain();assert.equal(h.arena.scrollLeft,700);
 h.event();h.ctx.ST.pan={};h.drain();assert.equal(h.arena.scrollLeft,700);
});

test('integer scroll positions settle without an endless one-pixel animation',()=>{
 const h=setup();let left=100;
 Object.defineProperty(h.arena,'scrollLeft',{get:()=>left,set:v=>{left=Math.round(v);}});
 h.event({deltaY:60});h.drain();assert.equal(left,160);assert.equal(h.frames.size,0);
});
test('decelerating wheel keeps its smoothing instead of flushing the pending distance',()=>{
 const h=setup();h.event({deltaY:120});h.step();
 h.event({deltaY:5});h.step();assert(h.arena.scrollLeft<225);
 h.drain();assert.equal(h.arena.scrollLeft,225);
});

test('a new Shift-wheel event after navigation uses the new position',()=>{
  const h=setup();h.event({deltaY:120});h.step();
  h.arena.scrollLeft=700;h.event({deltaY:60});h.drain();
  assert.equal(h.arena.scrollLeft,760);
});

test('switching between Shift and ordinary horizontal scrolling keeps only the current gesture',()=>{
  const h=setup();h.event({deltaY:120});h.step();const left=h.arena.scrollLeft;
  h.ctx.stEdgeWheel(-40,0);h.drain();assert.equal(h.arena.scrollLeft,left-40);
  h.ctx.stEdgeWheel(80,0);h.event({deltaY:-30});h.drain();
  assert.equal(h.arena.scrollLeft,left-70);
});

test('releasing Shift or losing focus stops its remaining animation',()=>{
  for (const event of [{type:'keyup',key:'Shift'},{type:'blur'},{type:'pointerdown'}]) {
    const h=setup();h.event({deltaY:120});h.step();const left=h.arena.scrollLeft;
    h.events.get(event.type)(event);h.drain();
    assert.equal(h.arena.scrollLeft,left);assert.equal(h.frames.size,0);
  }
});

test('Shift release in a conversation iframe stops the parent stage',()=>{
  const parent=setup(),child=setup();child.ctx.window.parent=parent.ctx.window;
  parent.event({deltaY:120});parent.step();const left=parent.arena.scrollLeft;
  child.events.get('keyup')({type:'keyup',key:'Shift'});parent.drain();
  assert.equal(parent.arena.scrollLeft,left);assert.equal(parent.frames.size,0);
});

test('vertical scrolling and branch resizing interrupt pending Shift motion',()=>{
  const h=setup();h.event({deltaY:120});h.step();const left=h.arena.scrollLeft;
  assert.equal(h.event({shiftKey:false}),false);h.drain();assert.equal(h.arena.scrollLeft,left);
  h.event();h.ctx.ST.branchResize={};h.drain();assert.equal(h.arena.scrollLeft,left);
  assert.equal(h.event(),false);
});
test('map viewport follows fractional page movement',()=>{
 const arena={scrollLeft:0,clientWidth:500}, map={dataset:{k:'1'},scrollLeft:0}, marker={style:{}};
 const ctx=vm.createContext({$:s=>({'#starena':arena,'#stmap':map,'#stmv':marker}[s]),ST:{mapWins:[{id:'a'},{id:'b'}],pos:new Map([['a',{x:0,w:1000}],['b',{x:1000,w:1000}]]),mapPos:new Map([['a',{x:0,w:100}],['b',{x:100,w:100}]])}});
 vm.runInContext(source.slice(source.indexOf('function stMapView()'),source.indexOf('function stMapGo(')),ctx);
 ctx.stMapView();assert.equal(marker.style.width,'50px');
 arena.scrollLeft=100;ctx.stMapView();assert.equal(marker.style.left,'10px');
 arena.scrollLeft=800;ctx.stMapView();assert.equal(marker.style.left,'80px');assert.equal(marker.style.width,'50px');
});
