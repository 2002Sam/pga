import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const hand=fs.readFileSync(new URL('../src/pga/web/app-hand.js',import.meta.url),'utf8');
const live=fs.readFileSync(new URL('../src/pga/web/app-live.js',import.meta.url),'utf8');
function setup() {
  const timers=new Map();let timerId=0;
  const calls=[], draws=[], errors=[], intervals=[], refresh={forest:0,chats:0,timeline:0};
  let sharedDone, historyDone;
  const shared=new Promise(r=>sharedDone=r), history=new Promise(r=>historyDone=r);
  const c={AbortController,L:s=>s,setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),S:{uid:'demo',view:'chats',chat:'chat:first',chatTurns:{}},EMBED:false,Q:{get:()=>null},encodeURIComponent,
    api:path=>{calls.push(path);return path.includes('/chats/')?history:shared;},
    setMini(){},applySplits(){},loadForest:()=>{refresh.forest++;return shared;},loadChats:()=>{refresh.chats++;return shared;},loadTimeline(){refresh.timeline++;},
    requestAnimationFrame:f=>f(),setInterval:f=>(intervals.push(f),intervals.length),window:{},document:{hidden:false},
    renderChat:()=>draws.push(c.S.chat),toast:e=>errors.push(e)};
  c.show=()=>{draws.push(c.S.chat);c.loaded=c.loadChat(c.S.chat);};
  vm.runInNewContext(live.slice(live.indexOf('function stageFrameVisible()'),live.indexOf('async function chatSend(')),c);
  vm.runInNewContext(hand.slice(hand.indexOf('function pgCopyMetaRows('),hand.lastIndexOf('\nboot();')),c);
  return {c,calls,draws,errors,sharedDone,historyDone,intervals,refresh,timers};
}
test('initial history starts before shared boot data completes and is consumed exactly once',async()=>{
  const h=setup(),boot=h.c.boot();
  assert.match(h.calls[0],/chats\/chat%3Afirst$/);assert.equal(h.c.S.booted,undefined);
  h.historyDone({turns:[],options:{agent:'codex'}});h.sharedDone({});await boot;await h.c.loaded;
  assert.equal(h.calls.filter(x=>x.includes('/chats/')).length,1);
  assert.equal(h.c.S.chatTurns['chat:first'].length,0);assert.equal(h.c.S.chatBoot,undefined);
  assert.equal(h.c.S.chatAgent,'codex');assert.deepEqual(h.errors,[]);
});
test('a rejected initial history is reported and a normal retry fetches fresh data',async()=>{
  const {c,errors}=setup();let requests=0;
  c.S.chatBoot={key:c.S.chat,result:Promise.resolve({error:new Error('offline')})};
  c.api=async()=>{requests++;return {turns:[]};};
  await c.loadChat(c.S.chat);assert.equal(requests,0);assert.equal(c.S.chatLoadErrors[c.S.chat],'offline');
  await c.loadChat(c.S.chat);assert.equal(requests,1);assert.equal(c.S.chatLoadErrors[c.S.chat],undefined);
  assert.equal(c.S.chatTurns[c.S.chat].length,0);assert.deepEqual(errors,['offline']);
});
test('a different conversation never consumes the original prefetched history',async()=>{
  const {c}=setup();c.S.chatBoot={key:'chat:old',result:Promise.resolve({data:{turns:[{text:'old'}]}})};
  c.api=async()=>({turns:[{text:'new'}]});await c.loadChat(c.S.chat);
  assert.equal(c.S.chatTurns[c.S.chat][0].text,'new');
});
test('split histories finish before rendering and lane failures retain a retryable error',async()=>{
  const {c,draws}=setup();let release;
  c.api=async path=>path.endsWith('chat%3Afirst')?{turns:[],split:{lanes:[{key:'chat:lane'}]}}:new Promise(r=>release=r);
  const loading=c.loadChat(c.S.chat);await new Promise(setImmediate);
  assert.equal(draws.length,0);release({turns:[{text:'lane'}]});await loading;
  assert.equal(c.S.chatTurns['chat:lane'][0].text,'lane');assert.equal(draws.length,1);
  c.api=async path=>{if(path.endsWith('chat%3Afirst'))return {turns:[],split:{lanes:[{key:'chat:lane'}]}};throw Error('lane offline');};
  await c.loadChat(c.S.chat);assert.equal(c.S.chatLoadErrors[c.S.chat],'lane offline');
});


test('manager frame reuses complete same-user parent metadata without sharing arrays and still fetches its history',async()=>{
  const h=setup();
  const parent={S:{uid:'demo',booted:true,forest:{trees:[{id:'tree'}],knowledge:[{id:'fact'}]},
    chats:[{key:'chat:visible'}],allChats:[{key:'chat:visible',archived:false}],agents:[{name:'codex'}],
    acctOf:{codex:'user@example.com'},liveRuns:[{id:'run',running:true}]}};
  h.c.window={top:parent};h.c.EMBED=true;h.c.Q={get:key=>key==='manager'?'PGA':null};h.c.S.chat='chat:pm-manager';
  const boot=h.c.boot();
  assert.equal(h.calls.length,1);assert.match(h.calls[0],/chats\/chat%3Apm-manager$/);
  h.historyDone({turns:[]});await boot;await h.c.loaded;
  assert.deepEqual(h.refresh,{forest:0,chats:0,timeline:0});
  assert.equal(h.c.S.forest.trees[0].id,'tree');assert.equal(h.c.S.chats[0].key,'chat:visible');
  assert.notEqual(h.c.S.forest,parent.S.forest);assert.notEqual(h.c.S.forest.trees,parent.S.forest.trees);
  assert.notEqual(h.c.S.forest.trees[0],parent.S.forest.trees[0]);assert.notEqual(h.c.S.chats,parent.S.chats);
  assert.notEqual(h.c.S.allChats,parent.S.allChats);assert.notEqual(h.c.S.agents,parent.S.agents);assert.notEqual(h.c.S.acctOf,parent.S.acctOf);
  h.c.S.forest.trees.push({id:'child-only'});h.c.S.chats[0].key='child-only';h.c.S.agents.push({name:'child-only'});h.c.S.acctOf.codex='changed';
  assert.equal(parent.S.forest.trees.length,1);assert.equal(parent.S.chats[0].key,'chat:visible');
  assert.equal(parent.S.agents.length,1);assert.equal(parent.S.acctOf.codex,'user@example.com');
});

test('manager metadata fast path falls back when parent data is missing or belongs to another user',async()=>{
  for(const [label,parentState] of [
    ['incomplete',{uid:'demo',booted:true,forest:{trees:[]},chats:[],allChats:[],agents:[],acctOf:{}}],
    ['other user',{uid:'other',booted:true,forest:{trees:[]},chats:[],allChats:[],agents:[],acctOf:{},liveRuns:[]}],
  ]){
    const h=setup();h.c.window={top:{S:parentState}};h.c.EMBED=true;
    h.c.Q={get:key=>key==='manager'?'PGA':null};h.c.S.chat='chat:pm-manager';
    const boot=h.c.boot();h.historyDone({turns:[]});h.sharedDone({agents:[]});await boot;await h.c.loaded;
    assert.equal(h.refresh.forest,1,`${label}: normal forest load remains enabled`);
    assert.equal(h.refresh.chats,1,`${label}: normal chats load remains enabled`);
    assert(h.calls.some(x=>x.endsWith('/console')),`${label}: console metadata falls back to network`);
    assert(h.calls.some(x=>x.endsWith('/agents')),`${label}: agent accounts fall back to network`);
    assert(h.calls.some(x=>x.includes('/chats/')),`${label}: history remains a separate request`);
  }
});

test('stage idle gate defers first screen; loadChat returns immediately and coalesces pending paints',async()=>{
  const {c,draws,sharedDone,historyDone}=setup();let releaseIdle;
  const idle=new Promise(resolve=>{releaseIdle=resolve;});c.EMBED=true;
  c.window={};c.pgStageIdleForPaint=()=>idle;
  const boot=c.boot();historyDone({turns:[]});sharedDone({});
  for(let i=0;i<5;i++)await Promise.resolve();
  assert.equal(draws.length,0);
  releaseIdle();await boot;await c.loaded;for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(draws.join(','),'chat:first,chat:first');

  let releaseChat, idleCalls=0; const idleAgain=new Promise(resolve=>{releaseChat=resolve;});
  c.pgStageIdleForPaint=()=>{idleCalls++;return idleAgain;};c.S.stageMotion=true;
  const first=c.loadChat('chat:first'); await first; // background queue progress must not wait for paint
  assert.equal(draws.length,2);
  c.S.chat='chat:second'; c.S.chatBoot=null;
  c.api=async()=>({turns:[{text:'latest'}]});
  const latest=c.loadChat('chat:second'); await latest;
  assert.equal(draws.length,2); assert.equal(idleCalls,1,'repeated load updates the pending render instead of registering another idle waiter');
  c.S.stageMotion=false;releaseChat();
  for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(draws.join(','),'chat:first,chat:first,chat:second');
  assert.equal(c.S.chatTurns['chat:second'][0].text,'latest');
});

test('stage live metadata refresh pauses while hidden or moving and resumes when idle',async()=>{
  const h=setup(),boot=h.c.boot();h.historyDone({turns:[]});h.sharedDone({});await boot;
  const before={...h.refresh};
  for(const flag of ['stageDormant','stageMotion']){
    h.c.S[flag]=true;await h.intervals[0]();
    assert.deepEqual(h.refresh,before,`${flag} suspends periodic metadata reads`);
    h.c.S[flag]=false;
  }
  h.c.document.hidden=true;await h.intervals[0]();assert.deepEqual(h.refresh,before);
  h.c.document.hidden=false;await h.intervals[0]();
  assert.equal(h.refresh.forest,before.forest+1);
  assert.equal(h.refresh.chats,before.chats+1);
  assert.equal(h.refresh.timeline,before.timeline+1);
});

test('conversation paints while shared navigation metadata remains stalled',async()=>{
  const h=setup(),boot=h.c.boot();h.historyDone({turns:[{text:'ready without metadata'}]});
  await boot;await h.c.loaded;
  assert.equal(h.c.S.booted,true);assert.equal(h.c.S.chatTurns['chat:first'][0].text,'ready without metadata');
  assert.ok(h.draws.length>0);
  h.sharedDone({});await new Promise(setImmediate);
});
test('ordinary conversation frames reuse same-account metadata just like managers',async()=>{
  const h=setup(),parent={S:{uid:'demo',booted:true,forest:{trees:[]},chats:[],allChats:[],agents:[{name:'codex'}],acctOf:{},liveRuns:[]}};
  h.c.window={top:parent};h.c.EMBED=true;
  const boot=h.c.boot();h.historyDone({turns:[]});await boot;await h.c.loaded;
  assert.deepEqual(h.refresh,{forest:0,chats:0,timeline:0});
  assert.equal(h.calls.length,1);assert.notEqual(h.c.S.agents,parent.S.agents);
});
test('stalled history is aborted with a retryable timeout and a retry succeeds',async()=>{
  const {c,timers,errors}=setup();let signal;
  c.api=(_url,options)=>new Promise((_resolve,reject)=>{signal=options.signal;signal.addEventListener('abort',()=>reject(Error('aborted')));});
  const read=c.loadChat(c.S.chat);
  const timeout=[...timers.values()].find(t=>t.ms===15000);assert.ok(timeout);timeout.fn();await read;
  assert.equal(signal.aborted,true);assert.match(errors[0],/超时/);assert.equal(timers.size,0);
  c.api=async()=>({turns:[{text:'retried'}]});await c.loadChat(c.S.chat,{force:true});
  assert.equal(c.S.chatTurns[c.S.chat][0].text,'retried');assert.equal(c.S.chatLoadErrors[c.S.chat],undefined);
});
test('repeated reads deduplicate; explicit retry cancels the old read and ignores its late result',async()=>{
  const {c,errors}=setup(),pending=[];
  c.api=(_url,opts)=>new Promise(resolve=>pending.push({resolve,signal:opts.signal}));
  const old=c.loadChat(c.S.chat),same=c.loadChat(c.S.chat);assert.equal(pending.length,1);
  const fresh=c.loadChat(c.S.chat,{force:true});assert.equal(pending.length,2);assert.equal(pending[0].signal.aborted,true);
  pending[1].resolve({turns:[{text:'latest'}],options:{agent:'codex'}});await fresh;
  pending[0].resolve({turns:[{text:'old'}],options:{agent:'wrong'}});await Promise.all([old,same]);
  assert.equal(c.S.chatTurns[c.S.chat][0].text,'latest');assert.equal(c.S.chatAgent,'codex');assert.deepEqual(errors,[]);
});
test('malformed history becomes an explicit failure instead of an endless loading placeholder',async()=>{
  const {c}=setup();c.api=async()=>({ok:true});await c.loadChat(c.S.chat);
  assert.match(c.S.chatLoadErrors[c.S.chat],/格式异常/);assert.equal(c.S.chatTurns[c.S.chat],undefined);
});
