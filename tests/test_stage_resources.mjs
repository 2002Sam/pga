import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const stage=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
const resources=fs.readFileSync(new URL('../src/pga/web/app-stage-resources.js',import.meta.url),'utf8');
function setup(count=30) {
  const timers=[], cache=new Map(), calls={render:0,save:0,toast:0};
  const nodes=Array.from({length:count},(_,i)=>({id:String(i),key:'chat:'+i,type:'win',tidyLinear:true,lastUsedAt:i+1,
    prog:{msg:i,off:20,draft:''},el:{querySelector:()=>null}}));
  const ST={nodes,focus:'29',pos:new Map(),liveByKey:new Map(),liveCheckedAt:1000000};
  const arena={scrollLeft:0,clientWidth:1000};
  const c=vm.createContext({ST,S:{view:'stage',uid:'u'},window:{PG:{pending:new Map()}},PG:{pending:new Map()},
    Date:{now:()=>1000000},performance:{now:()=>1000000},document:{hidden:false},
    $:s=>s==='#starena'?arena:s==='#vStage'?{dataset:{ready:'1'}}:null,
    localStorage:{getItem:k=>cache.get(k),setItem:(k,v)=>cache.set(k,v)},
    stWins:()=>ST.nodes,stBusy:n=>!!n.busy,stAnchor:()=>({id:ST.focus,dx:40}),
    stRender:()=>calls.render++,stSave:()=>calls.save++,stContexts(){},stFrame:{pending:new Map()},
    toast:()=>calls.toast++,L:zh=>zh,setTimeout:(fn,ms)=>timers.push({fn,ms}),setInterval:(fn,ms)=>timers.push({fn,ms}),clearTimeout(){}});
  vm.runInContext(stage.slice(stage.indexOf('function stRememberPage('),stage.indexOf('/* every category')),c);
  vm.runInContext(stage.slice(stage.indexOf('function stClose('),stage.indexOf('function stMax(')),c);
  vm.runInContext(resources,c);
  return {c,ST,nodes,calls,cache,timers,arena};
}
test('periodic cleanup closes oldest idle views across categories, including tidy views, in one render',()=>{
  const {c,ST,cache,calls,timers}=setup();
  assert.deepEqual(timers.map(x=>x.ms),[15000,30000]);
  assert.equal(c.stAutoCloseIdlePages(),10);assert.equal(ST.nodes.length,20);
  assert.equal(ST.nodes[0].id,'10');assert.equal(calls.render,1);assert.equal(calls.toast,1);
  assert.equal(JSON.parse(cache.get('pga:retired:u:chat:0')).off,20);
  assert.equal(ST.sortAnchor.id,'29');assert.equal(c.stAutoCloseIdlePages(),0);
});
test('current, pinned, running, unread, draft, attachment and queued pages survive automatic cleanup',()=>{
  const {c,ST,nodes}=setup();
  nodes[0].screenPin=true;nodes[1].busy=true;nodes[2].done=1;nodes[3].prog.draft='unsent';
  for(const [i,state] of [[4,{att:[{}]}],[5,{followups:{'chat:5':[{}]}}],[6,{remoteRun:'run'}]])
    nodes[i].el={querySelector:()=>({contentWindow:{S:state},contentDocument:{querySelector:()=>null}})};
  ST.liveByKey.set('chat:7',{finished:false});ST.pos.set('8',{x:100,w:500});
  assert.equal(c.stAutoCloseIdlePages(),10);
  for(const id of ['0','1','2','3','4','5','6','7','8','29'])assert(ST.nodes.some(n=>n.id===id),id);
});
test('an idle parent may close while the protected child retains fork provenance',()=>{
  const {c,ST,nodes}=setup();nodes[29].par='0';nodes[0].kids=['29'];
  c.stAutoCloseIdlePages();const child=ST.nodes.find(n=>n.id==='29');
  assert.equal(child.par,undefined);assert.equal(child.from,'chat:0');assert.equal(child.branchFrom,'chat:0');
});
test('storage failure or unavailable live status retains every page',()=>{
  const {c,ST}=setup();c.localStorage.setItem=()=>{throw Error('quota');};
  assert.equal(c.stAutoCloseIdlePages(),0);assert.equal(ST.nodes.length,30);
  c.localStorage.setItem=()=>{};ST.liveCheckedAt=1;
  assert.equal(c.stAutoCloseIdlePages(),0);assert.equal(ST.nodes.length,30);
});
test('newly used pages and ongoing gestures defer collection without losing the scheduled sweep',()=>{
  const {c,ST,nodes,timers}=setup();for(const n of nodes)n.lastUsedAt=990000;
  assert.equal(c.stAutoCloseIdlePages(),0);
  for(const n of nodes)n.lastUsedAt=1;
  for(const key of ['frameMoving','navigation','drag','pan','overview','rz','branchResize']) {
    ST[key]=true;assert.equal(c.stAutoCloseIdlePages(),0);ST[key]=null;
  }
  timers[1].fn();assert.equal(ST.nodes.length,20);
});
test('recently visible frames and saved pending drafts remain even if node timestamps are old',()=>{
  const {c,ST,nodes}=setup();nodes[0].el={querySelector:()=>({_pgaSeenAt:990000})};
  c.window.PG.pending.set('1',{draft:'restoring'});
  c.localStorage.setItem('pga:followups:u:chat:2','[{}]');
  c.stAutoCloseIdlePages();for(const id of ['0','1','2'])assert(ST.nodes.some(n=>n.id===id));
});
test('a suspended page retains its saved reading position when no document is mounted',()=>{
  const {c,cache}=setup();c.pgProg=()=>null;
  c.stAutoCloseIdlePages();assert.equal(JSON.parse(cache.get('pga:retired:u:chat:3')).msg,3);
  const restored={id:'restored',key:'chat:3'};c.stRecallPage(restored);
  assert.equal(restored.prog.off,20);assert.equal(c.PG.pending.get('restored').msg,3);
});
