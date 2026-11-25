import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/pga/web/app-stage.js', import.meta.url), 'utf8');
function harness(reduce = false) {
  let clock = 0, id = 0;
  const frames = new Map();
  const arena = {scrollLeft:100, clientWidth:1000, scrollWidth:20000, isConnected:true,
    scrollTo({left}) { this.scrollLeft = left; }, focus() {}};
  const marks = [500, 1800, 3200].map((x, i) => ({digit:String(i+1), page:'page', id:String(i+1), key:'chat:'+i, x:x+300}));
  const ST = {nodes:marks.map(m => ({type:'win',id:m.id,key:m.key})), pos:new Map(marks.map(m => [m.digit, {x:m.x-300,w:600}])),
    positionMarks:Object.fromEntries(marks.map(m => [m.digit,m])), markHistory:[], markIndex:-1};
  const c = vm.createContext({ST, PG:{cur:'page', pending:new Map()}, S:{view:'stage'}, stFrame:{},
    $:s=>s==='#starena' ? arena : null, window:{matchMedia:()=>({matches:reduce})},
    performance:{now:()=>clock}, requestAnimationFrame:f=>{frames.set(++id,f);return id;},
    cancelAnimationFrame:i=>frames.delete(i), clearTimeout(){}, stScheduleFrameLoads(){},
    stShiftStop(){c.stNavigationStop();}, stReorderStop(){}, stEdgeWheel:{}, stGrow(){},
    stFocus(n){ ST.focus=n; arena.scrollLeft=7000; }, stMap(){}, L:(a,b)=>b});
  vm.runInContext(source.slice(source.indexOf('function stMarkChat('), source.indexOf('function stReorderStop(')), c);
  vm.runInContext(source.slice(source.indexOf('function stShow('), source.indexOf('// Top-bar clicks glide')), c);
  const tick = (ms=16) => {clock+=ms; const jobs=[...frames.values()];frames.clear();jobs.forEach(f=>f(clock));};
  const finish = () => {for(let i=0;frames.size && i<40;i++)tick(); assert.equal(frames.size,0);};
  return {c, ST, arena, marks, frames, tick, finish};
}
test('marks ease from the visible offset despite focus navigation and finish at the current conversation',async()=>{
  const h=harness();await h.c.stReturnToMark(h.marks[2]);
  assert.equal(h.arena.scrollLeft,100);assert.equal(h.ST.navigation.mark,h.marks[2]);
  h.tick(80);assert(h.arena.scrollLeft>100 && h.arena.scrollLeft<2800);
  h.finish();assert.equal(h.arena.scrollLeft,2800);assert.equal(h.ST.navigation,null);
});
test('rapid mark changes continue from the current position and obsolete animation callbacks are inert',async()=>{
  const h=harness();await h.c.stReturnToMark(h.marks[2]);h.tick(180);
  const at=h.arena.scrollLeft, stale=[...h.frames.values()][0];
  await h.c.stReturnToMark(h.marks[0]);assert.equal(h.arena.scrollLeft,at);
  stale(1000);assert.equal(h.arena.scrollLeft,at);h.finish();assert.equal(h.arena.scrollLeft,500);
  assert.deepEqual(Array.from(h.ST.markHistory),[h.marks[2],h.marks[0]]);
});
test('arrows advance from the pending mark while travelling across other marks',async()=>{
  const h=harness(), target={closest:()=>null};await h.c.stReturnToMark(h.marks[1]);h.tick(20);
  assert.equal(h.c.stAdjacentMark(1,null,target),h.marks[2]);
  assert.equal(h.c.stAdjacentMark(-1,null,target),h.marks[0]);
});
test('manual scrolling cancels mark motion without restoring the old destination',async()=>{
  const h=harness();await h.c.stReturnToMark(h.marks[2]);h.tick(50);
  h.arena.scrollLeft=777;h.tick();assert.equal(h.ST.navigation,null);assert.equal(h.arena.scrollLeft,777);
});
test('reduced motion jumps directly, keeps the current reading position and creates no animation',async()=>{
  const h=harness(true);await h.c.stReturnToMark(h.marks[1]);
  assert.equal(h.arena.scrollLeft,1400);assert.equal(h.frames.size,0);
  assert.equal(h.c.PG.pending.size,0);
});
test('a mark at the current offset does not animate even if focus temporarily navigates elsewhere',async()=>{
  const h=harness();h.arena.scrollLeft=100;await h.c.stReturnToMark(h.marks[0]);
  assert.equal(h.arena.scrollLeft,100);assert.equal(h.frames.size,0);
});

test('a number pressed once while a marked document reopens reaches its destination',async()=>{
  const {c,ST,marks}=harness(true);
  const file=ST.nodes.shift();
  marks[0].resource={file:{path:'notes.txt'}};
  let finishOpen;
  c.stOpenFile=()=>new Promise(resolve=>{finishOpen=()=>{ST.nodes.push(file);resolve(file);};});
  const opening=c.stReturnToMark(marks[0]);
  await c.stReturnToMark(marks[2]);
  finishOpen();
  await opening;
  assert.equal(ST.focus,marks[2].id);
  assert.equal(ST.markHistory[ST.markIndex],marks[2]);
});
