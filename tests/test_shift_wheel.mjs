import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/pga/web/app-stage.js', import.meta.url), 'utf8');
function setup() {
  const arena = {scrollLeft:100, scrollWidth:1800, clientWidth:600, isConnected:true, scrollTo({left}) { this.scrollLeft = left; },
    getBoundingClientRect:()=>({top:0, bottom:800})};
  let now = 0, nextFrame = 0;
  const frames = new Map(), events = new Map();
  const win = {matchMedia:()=>({matches:false}), addEventListener:(name,handler)=>events.set(name,handler)};
  win.parent = win;
  const ctx = vm.createContext({$:()=>arena, S:{view:'stage'}, ST:{}, window:win, performance:{now:()=>now},
    document:{hidden:false, addEventListener:(name,handler)=>events.set(name,handler)}, stScheduleScroll(){},
    requestAnimationFrame:handler=>{frames.set(++nextFrame,handler);return nextFrame;}, cancelAnimationFrame:id=>frames.delete(id)});
  const step = (ms = 16.7) => { const pending = [...frames.values()]; frames.clear(); now += ms; pending.forEach(handler=>handler(now)); };
  const drain = (ms) => { let count=0;while(frames.size && count++<200)step(ms);assert(count<200); };
  vm.runInContext(source.slice(source.indexOf('function stEdgeWheel('),source.indexOf('window.stBoundaryWheel =')),ctx);
  const event=(over={})=>ctx.stShiftWheel({shiftKey:true,deltaX:0,deltaY:60,deltaMode:0,...over});
  return {arena,ctx,frames,events,step,drain,event,wait:ms=>{now+=ms;},wheel:over=>{const result=event(over);drain();return result;}};
}
// A lone notch moves at least a tenth of the screen: here 80px (the floor) on a 600px stage.
test('Shift-wheel pans both directions and accepts already translated horizontal deltas',()=>{
  const h=setup(); assert.equal(h.wheel(),true); assert.equal(h.arena.scrollLeft,180);
  h.wheel({deltaY:-40}); assert.equal(h.arena.scrollLeft,100);
  h.wheel({deltaX:50,deltaY:0}); assert.equal(h.arena.scrollLeft,180);
  h.wheel({deltaX:50,deltaY:50}); assert.equal(h.arena.scrollLeft,260);
  h.wheel({deltaY:200}); assert.equal(h.arena.scrollLeft,460,'a notch longer than the floor keeps its own length');
});
test('line/page wheel units and stage boundaries are respected without wrapping',()=>{
  const h=setup(); h.wheel({deltaY:5,deltaMode:1}); assert.equal(h.arena.scrollLeft,260);
  h.wheel({deltaY:1,deltaMode:2}); assert.equal(h.arena.scrollLeft,860);
  h.wheel({deltaY:10000}); assert.equal(h.arena.scrollLeft,1200);
  h.wheel({deltaY:-10000}); assert.equal(h.arena.scrollLeft,0);
});
test('ordinary scrolling, zoom gestures and active drags remain untouched',()=>{
  const h=setup();
  for(const flags of [{shiftKey:false},{ctrlKey:true},{metaKey:true}]) assert.equal(h.wheel(flags),false);
  h.ctx.ST.drag={}; assert.equal(h.wheel(),false); assert.equal(h.arena.scrollLeft,100);
});
test('native document gestures reuse stage gliding without consuming scroll or zoom outside the stage',()=>{
  const h=setup(), send=data=>h.ctx.window.stNativeWheel({deltaX:0,deltaY:60,deltaMode:0,...data});
  assert.equal(send({rightButton:true}),true);h.drain();assert.equal(h.arena.scrollLeft,180);
  assert.equal(send({shiftKey:true,deltaY:-60}),true);h.drain();assert.equal(h.arena.scrollLeft,100);
  for(const data of [{},{shiftKey:true,ctrlKey:true},{rightButton:true,metaKey:true},{shiftKey:true,deltaY:NaN}])assert.equal(send(data),false);
  h.ctx.S.view='chats';assert.equal(send({shiftKey:true}),false);assert.equal(h.arena.scrollLeft,100);
});

test('wheel bursts share a frame, reverse promptly and settle exactly',()=>{
 const h=setup();for(let i=0;i<20;i++)h.event({deltaY:40});
 assert.equal(h.frames.size,1);assert.equal(h.arena.scrollLeft,100);
 h.step();const forward=h.arena.scrollLeft;assert(forward>100&&forward<900);
 h.event({deltaY:-60});h.step();assert(h.arena.scrollLeft<forward);h.drain();
 assert(Math.abs(h.arena.scrollLeft-(forward-60))<0.001);
});
test('a burst is one stream: its distances add up without a notch step each',()=>{
 const h=setup();for(let i=0;i<20;i++)h.event({deltaY:40});h.drain();assert.equal(h.arena.scrollLeft,900);
});
test('a delayed trackpad event within a confirmed stream preserves its distance',()=>{
 const h=setup();
 h.event({deltaY:4});h.step();h.event({deltaY:4});h.step();
 h.step(65);h.event({deltaY:2});h.drain();
 assert.equal(h.arena.scrollLeft,110);
 h.wait(200);h.wheel({deltaY:4});assert.equal(h.arena.scrollLeft,190,'a separate notch still receives its minimum step');
});
test('a fine stream follows closely without a lurch, and external navigation cancels it',()=>{
 const h=setup();let most=0;
 for(let i=0;i<10;i++){h.event({deltaY:3});h.step();most=Math.max(most,h.arena.scrollLeft);}
 h.drain();assert.equal(h.arena.scrollLeft,130);assert(most<=131,'its first event was no notch');
 h.event();h.step();h.arena.scrollLeft=700;h.drain();assert.equal(h.arena.scrollLeft,700);
 h.event();h.ctx.ST.pan={};h.drain();assert.equal(h.arena.scrollLeft,700);
});
test('in a busy app a stream arrives a frame apart and, once its frames are seen, is still a stream',()=>{
 const h=setup();h.event({deltaY:200});h.drain(45);   // ~22 fps: the glide learns the frame time
 const left=h.arena.scrollLeft;h.wait(500);h.event({deltaY:5});
 for(let i=0;i<12;i++){h.step(45);h.event({deltaY:5});}                              // an event a frame
 h.drain(45);assert(Math.abs(h.arena.scrollLeft-(left+13*5))<1);
});
test('slow notches run together into one glide that eases in and out',()=>{
 const h=setup(),xs=[h.arena.scrollLeft];
 for(let i=0;i<8;i++){h.event({deltaY:4});for(let f=0;f<4;f++){h.step();xs.push(h.arena.scrollLeft);}}   // a notch every ~67 ms
 const steps=xs.slice(1).map((x,i)=>x-xs[i]);
 h.drain();assert.equal(h.arena.scrollLeft,100+8*80);
 assert(steps.every(d=>d>=0),'never steps back');
 assert(steps.slice(0,32).every(d=>d>0),'never stands still between notches');
 assert(steps[0]<steps[3],'starts gently');
 assert(Math.max(...steps)<40,'no jump');
});

test('integer scroll positions settle without an endless one-pixel animation',()=>{
 const h=setup();let left=100;
 Object.defineProperty(h.arena,'scrollLeft',{get:()=>left,set:v=>{left=Math.round(v);}});
 h.event({deltaY:60});h.drain();assert.equal(left,180);assert.equal(h.frames.size,0);
});
test('decelerating wheel keeps its smoothing instead of flushing the pending distance',()=>{
 const h=setup();h.event({deltaY:120});h.step();
 h.event({deltaY:5});h.step();assert(h.arena.scrollLeft<225);
 h.drain();assert.equal(h.arena.scrollLeft,225);
});

test('a new Shift-wheel event after navigation uses the new position',()=>{
  const h=setup();h.event({deltaY:120});h.step();
  h.arena.scrollLeft=700;h.wait(200);h.event({deltaY:60});h.drain();
  assert.equal(h.arena.scrollLeft,780);
});

test('switching between Shift and ordinary horizontal scrolling keeps only the current gesture',()=>{
  const h=setup();h.arena.scrollLeft=600;h.event({deltaY:120});h.step();const left=h.arena.scrollLeft;
  h.ctx.stEdgeWheel(-40,0);h.drain();assert.equal(h.arena.scrollLeft,left-40);
  h.ctx.stEdgeWheel(80,0);h.event({deltaY:-30});h.drain();
  assert.equal(h.arena.scrollLeft,left-120);
});

test('letting go of Shift lets the glide settle; a press or losing focus stops it',()=>{
  const h=setup();assert(!h.events.has('keyup'));h.event({deltaY:120});h.step();h.drain();assert.equal(h.arena.scrollLeft,220);
  for (const event of [{type:'blur'},{type:'pointerdown'}]) {
    const h=setup();h.event({deltaY:120});h.step();const left=h.arena.scrollLeft;
    h.events.get(event.type)(event);h.drain();
    assert.equal(h.arena.scrollLeft,left);assert.equal(h.frames.size,0);
  }
});

test('a press in a conversation iframe stops the parent stage',()=>{
  const parent=setup(),child=setup();child.ctx.window.parent=parent.ctx.window;
  parent.ctx.window.stShiftStop=parent.ctx.stShiftStop;
  parent.event({deltaY:120});parent.step();const left=parent.arena.scrollLeft;
  child.events.get('pointerdown')({type:'pointerdown'});parent.drain();
  assert.equal(parent.arena.scrollLeft,left);assert.equal(parent.frames.size,0);
});

test('vertical scrolling and branch resizing interrupt pending Shift motion',()=>{
  const h=setup();h.event({deltaY:120});h.step();const left=h.arena.scrollLeft;
  assert.equal(h.event({shiftKey:false}),false);h.drain();assert.equal(h.arena.scrollLeft,left);
  h.event();h.ctx.ST.branchResize={};h.drain();assert.equal(h.arena.scrollLeft,left);
  assert.equal(h.event(),false);
});
test('the top and bottom strips glide the same way, and their own wheel does not stop it',()=>{
  const h=setup(),strip=(over={})=>h.ctx.stBoundaryWheel({deltaX:0,deltaY:40,deltaMode:0,clientY:10,...over});
  assert.equal(strip(),true);h.step();assert(h.arena.scrollLeft>100&&h.arena.scrollLeft<200,'glides, no jump');
  assert.equal(h.event({shiftKey:false}),false);h.drain();assert.equal(h.arena.scrollLeft,200);
  assert.equal(strip({clientY:400}),false,'the middle of the stage scrolls its pages');
});
test('reduced motion lands at once',()=>{
  const h=setup();h.ctx.window.matchMedia=()=>({matches:true});h.event({deltaY:120});h.step();
  assert.equal(h.arena.scrollLeft,220);assert.equal(h.frames.size,0);
});
function mapView(cols, W, arena) {
 const removed=[], map={dataset:{k:'1'},scrollLeft:0,querySelectorAll:()=>[{remove:()=>removed.push(1)}]}, marker={style:{}};
 const ctx=vm.createContext({$:s=>({'#starena':arena,'#stmap':map,'#stmv':marker}[s]),ST:{}});
 vm.runInContext(source.slice(source.indexOf('const ST_MAPGAP ='),source.indexOf('function stMapModeSet(')),ctx);
 vm.runInContext(source.slice(source.indexOf('function stMapView()'),source.indexOf('// Dragging along the bar')),ctx);
 ctx.ST.mapCols=ctx.stMapProject(cols,W);
 return {ctx,marker,removed,view:()=>{ctx.stMapView();return [Number(marker.style.transform.match(/translate3d\(([-\d.]+)px/)[1]),Number(marker.style.width.slice(0,-2))];}};
}
test('map viewport follows fractional page movement, the same share of a slot as of its page',()=>{
 const arena={scrollLeft:0,clientWidth:500};
 const h=mapView([{sx:0,sw:1000},{sx:1000,sw:1000}],202,arena);   // two slots of 100px, a 2px hairline between
 assert.deepEqual(h.view(),[0,50]);
 arena.scrollLeft=100;assert.deepEqual(h.view(),[10,50]);
 arena.scrollLeft=1250;assert.deepEqual(h.view(),[127,50]);
 for(let x=0;x<=1500;x+=37){arena.scrollLeft=x;const [l]=h.view();arena.scrollLeft=x+1;assert.ok(h.view()[0]>=l,'never steps back as the stage moves on');}
 assert.equal(h.removed.length,1,'legacy markers are cleaned once, not queried on every animation frame');
});
test('map viewport is one frame: folded lines and gaps between pages close up to the hairline between slots',()=>{
 // a at 0–500; folded lines and a folded category in 518–900; c at 918–1418, then d far right.
 const arena={scrollLeft:0,clientWidth:1000};
 const h=mapView([{sx:0,sw:500},{sx:918,sw:500},{sx:3000,sw:500}],304,arena);
 const [l,w]=h.view();
 assert.equal(l,0);assert.ok(Math.abs(l+w-(102+82/500*100))<0.1,'ends 82px into c, in proportion');
 assert.equal(h.removed.length,1,'no second frame is ever kept');
 arena.scrollLeft=600;const [l2]=h.view();assert.ok(l2>=100&&l2<=102,'inside the folded stretch: on the hairline');
 assert.ok(Math.abs(h.ctx.stMapSX(h.ctx.stMapX(1100))-1100)<1e-6,'stage and bar map back and forth exactly');
});
test('dragging along the bar carries the stage with it; a press without moving leaves it for the click',()=>{
 const arena={scrollLeft:1000,clientWidth:1000,scrollWidth:4000,scrollTo(o){this.scrollLeft=o.left;}};
 const map={dataset:{k:'1'},scrollLeft:0,querySelectorAll:()=>[],getBoundingClientRect:()=>({left:50})}, marker={style:{}};
 let stopped=0;
 const ctx=vm.createContext({$:s=>({'#starena':arena,'#stmap':map,'#stmv':marker}[s]),ST:{},stShiftStop:()=>stopped++,stEdgeWheel:{}});
 vm.runInContext(source.slice(source.indexOf('const ST_MAPGAP ='),source.indexOf('function stMapModeSet(')),ctx);
 vm.runInContext(source.slice(source.indexOf('function stMapView()'),source.indexOf('function stStep(')),ctx);
 ctx.ST.mapCols=ctx.stMapProject([{sx:0,sw:1000},{sx:1000,sw:1000},{sx:2000,sw:1000},{sx:3000,sw:1000}],406);   // 100px slots
 ctx.ST.mapDrag=ctx.stMapDragStart(50+152);   // inside the frame (slot 2, half way along): the stage point keeps that place
 assert.equal(ctx.ST.mapDrag.at,.5);
 ctx.stMapGo(50+155);assert.equal(arena.scrollLeft,1000,'a jiggle is still a click');assert.equal(ctx.ST.mapDrag.moved,false);
 ctx.stMapGo(50+204+50);assert.ok(Math.abs(arena.scrollLeft-2000)<1,'one slot along the bar: one page along the stage');assert.equal(ctx.ST.mapDrag.moved,true);assert.equal(stopped,1);
 ctx.stMapGo(50+406);assert.equal(arena.scrollLeft,3000,'held at the end');
});

test('held right button uses exactly the Shift-wheel motion in both directions and wheel units',()=>{
 for(const delta of [{deltaY:60},{deltaY:-100},{deltaX:90,deltaY:0},{deltaY:2,deltaMode:1},{deltaY:1,deltaMode:2}]){
  const shift=setup(),right=setup();right.ctx.ST.rightPan={menu:{}};
  assert.equal(right.wheel({shiftKey:false,...delta}),true);shift.wheel(delta);
  assert.equal(right.arena.scrollLeft,shift.arena.scrollLeft);
  assert.equal(right.ctx.ST.rightPan.wheeled,true);assert.equal(right.ctx.ST.rightPan.menu,null);
 }
});
test('right-wheel leaves zoom alone and stops owning ordinary wheel on release',()=>{
 const h=setup();h.ctx.ST.rightPan={};assert.equal(h.wheel({shiftKey:false,ctrlKey:true}),false);
 assert(!h.ctx.ST.rightPan.wheeled);h.wheel({shiftKey:false});h.ctx.ST.rightPan=null;
 const before=h.arena.scrollLeft;assert.equal(h.wheel({shiftKey:false}),false);assert.equal(h.arena.scrollLeft,before);
});
test('right-wheel cannot take ownership from an active middle drag',()=>{
 const h=setup();h.ctx.ST.rightPan={};h.ctx.ST.middlePan={moved:true};h.ctx.ST.pan={};let ended=0;
 h.ctx.stPanEnd=()=>{ended++;h.ctx.ST.pan=null;};
 const before=h.arena.scrollLeft;
 assert.equal(h.wheel({shiftKey:false}),false);assert.equal(ended,0);assert.equal(h.arena.scrollLeft,before);
});

test('right-wheel flushes an active right drag before starting wheel motion',()=>{
 const h=setup();h.ctx.ST.rightPan={moved:true};h.ctx.ST.pan={};let ended=0;
 h.ctx.stPanEnd=()=>{ended++;h.ctx.ST.pan=null;};
 assert.equal(h.wheel({shiftKey:false}),true);assert.equal(ended,1);assert.equal(h.ctx.ST.rightPan.wheeled,true);
});
