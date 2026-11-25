import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
function nav(x,sl=0,last=null){
 const moves=[],a={clientWidth:1000,scrollLeft:sl,scrollWidth:20000,scrollTo:v=>moves.push(v)};
 const ctx={ST:{nodes:[{id:'target'}],pos:new Map([['target',{x,w:800}]]),showAt:last},ST_PADX:0,$:()=>a,stGrow(){},performance:{now:()=>1000},window:{matchMedia:()=>({matches:false})}};
 vm.runInNewContext(source.slice(source.indexOf('function stShow('),source.indexOf('function stFocus(')),ctx);ctx.stShow('target');return moves;
}
test('first to last skips long smooth animation',()=>assert.equal(nav(15000)[0].behavior,'instant'));
test('last to first skips long smooth animation',()=>assert.equal(nav(0,15000)[0].behavior,'instant'));
test('nearby navigation remains smooth; rapid repeat is instant',()=>{assert.equal(nav(500)[0].behavior,'smooth');assert.equal(nav(500,0,950)[0].behavior,'instant');});
test('fully visible conversation does not move',()=>assert.equal(nav(50).length,0));
test('scroll keeps the minimap current but defers frame lifecycle and wire redraw until quiet',()=>{
 const frames=[],timers=new Map();let map=0,wire=0,loads=0,id=0;
 let resumed=0;const active={},parked={};
 const nodes=[{type:'win',el:{querySelector:()=>({contentWindow:{S:active,pgaStageActivated:()=>resumed++}})}},
  {type:'win',managerParked:true,el:{hidden:true,querySelector:()=>({contentWindow:{S:parked}})}}];
 const ctx={ST:{nodes},S:{view:'stage'},performance:{now:()=>1000},window:{},stFrame:{},stWins:()=>[],
  $:()=>({classList:{toggle(){}}}),stScheduleFrameLoads(){loads++;},
  setTimeout:f=>{timers.set(++id,f);return id;},clearTimeout:n=>timers.delete(n),
  requestAnimationFrame:f=>{frames.push(f);return frames.length;},stMapView:()=>map++,stOver:()=>wire++,document:{addEventListener(){}}};
 const start=source.indexOf('function stFrameMotion(');vm.runInNewContext(source.slice(start,source.indexOf('window.addEventListener("resize"',start)),ctx);
 for(let i=0;i<100;i++)ctx.stScheduleScroll();assert.equal(frames.length,1);assert.equal(timers.size,1);
 frames[0]();assert.equal(map,1);assert.equal(wire,0);assert.equal(loads,0);assert.equal(ctx.ST.frameMoving,true);
 assert.equal(ctx.S.stageMotion,true);assert.equal(active.stageMotion,true);assert.equal(parked.stageMotion,true);assert.equal(parked.stageDormant,true);
 [...timers.values()][0]();assert.equal(ctx.ST.frameMoving,false);assert.equal(wire,1);assert.equal(loads,1);
 assert.equal(ctx.S.stageMotion,false);assert.equal(active.stageMotion,false);assert.equal(parked.stageDormant,true);assert.equal(resumed,1);
});
function animationHarness() {
 const moves=[],cancelled=[],frames=new Map();let clock=1000,next=100;
 const a={clientWidth:1000,scrollLeft:3000,scrollWidth:20000,isConnected:true,scrollTo(v){moves.push(v);this.scrollLeft=v.left;}};
 const ctx={ST:{nodes:[{id:'last'},{id:'first'}],pos:new Map([['last',{x:15000,w:800}],['first',{x:0,w:800}]])},S:{view:'stage'},ST_PADX:0,$:()=>a,stGrow(){assert.fail('navigation must not grow the stage');},performance:{now:()=>clock},window:{matchMedia:()=>({matches:false})},stFocus(){},stFrame(){},stScheduleFrameLoads(){},clearTimeout(){},stShiftStop(){ctx.stNavigationStop();},stEdgeWheel:{motion:{frame:7}},requestAnimationFrame:f=>{frames.set(++next,f);return next;},cancelAnimationFrame:id=>{cancelled.push(id);frames.delete(id);}};
 vm.runInNewContext(source.slice(source.indexOf('function stShow('),source.indexOf('function stFocus(')),ctx);
 const tick=(ms=16)=>{clock+=ms;const jobs=[...frames.values()];frames.clear();jobs.forEach(f=>f(clock));};
 const finish=()=>{for(let i=0;frames.size&&i<40;i++)tick();assert.equal(frames.size,0);};
 return {ctx,a,moves,cancelled,frames,tick,finish};
}
test('parent tick restores the starting offset then glides to the parent within 420 ms',()=>{
 const {ctx,a,moves,tick}=animationHarness();a.scrollLeft=8000;
 ctx.stOpen=()=>{a.scrollLeft=0;return {id:'first'};};
 ctx.stReturnParent('parent-key');assert.equal(moves[0].left,8000);
 tick(100);assert(a.scrollLeft>0&&a.scrollLeft<8000);
 tick(320);assert.equal(a.scrollLeft,0);assert.equal(ctx.ST.navigation,null);
});
test('rapid top-bar clicks start at the current offset and stale callbacks cannot undo them',()=>{
 const {ctx,a,moves,cancelled,frames,tick,finish}=animationHarness();
 ctx.stFocus=()=>{a.scrollLeft=15000;};ctx.stMapNavigate('last');
 assert.equal(moves[0].left,3000);assert(cancelled.includes(7));assert.equal(ctx.stEdgeWheel.motion,null);
 tick(100);assert(a.scrollLeft>3000&&a.scrollLeft<14800);
 const from=a.scrollLeft,stale=[...frames.values()][0];ctx.stMapNavigate('first');
 assert.equal(a.scrollLeft,from);stale(2000);assert.equal(a.scrollLeft,from);
 tick();assert(a.scrollLeft<from);finish();assert.equal(a.scrollLeft,0);
 // Already at the target: stop without starting another animation.
 ctx.stFocus=()=>{};ctx.stMapNavigate('first');assert.equal(frames.size,0);
 ctx.window.matchMedia=()=>({matches:true});ctx.stMapNavigate('last');
 assert.equal(a.scrollLeft,14800);assert.equal(frames.size,0);assert.equal(moves.at(-1).behavior,'instant');
});
test('manual movement or leaving the stage cancels a glide without snapping back',()=>{
 const {ctx,a,frames,tick}=animationHarness();ctx.stMapNavigate('last');tick(50);
 a.scrollLeft=1234;tick();assert.equal(a.scrollLeft,1234);assert.equal(frames.size,0);
 ctx.stMapNavigate('last');tick();ctx.S.view='chats';const at=a.scrollLeft;tick();
 assert.equal(a.scrollLeft,at);assert.equal(frames.size,0);
});
test('page navigation moves only the hidden portion and leaves visible targets stationary',()=>{
 const {ctx,a,finish}=animationHarness();a.scrollWidth=5000;a.scrollLeft=0;
 const p={x:2000,w:600};ctx.ST.nodes=[{id:'target'}];ctx.ST.pos=new Map([['target',p]]);
 const jump=expected=>{ctx.stShow('target',true);finish();assert.equal(a.scrollLeft,expected);};
 jump(1600);
 a.scrollLeft=1900;jump(1900); // Already wholly visible: no recentering.
 a.scrollLeft=2100;jump(2000); // Reveal only the clipped left edge.
 p.x=0;jump(0);p.x=4400;jump(4000);p.x=2000;p.w=900;jump(2000);p.w=1200;jump(2000);
});
