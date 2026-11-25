// Run with: node --test tests/test_composer_live.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const flush = () => new Promise(resolve => setImmediate(resolve));
function harness() {
  const handlers = [], timers = new Map(), calls = [], notices = [];
  const box = { id: 'chatText', value: '补充说明', dataset: {}, closest: () => box, focus() {} };
  let timerId = 0;
  const c = vm.createContext({
    S: { sending: false, chat: 'chat:one', chatTurns: {}, chatRefs: [], view: 'chats' },
    navigator: { platform: 'MacIntel' },
    Q: new URLSearchParams(),
    MutationObserver: class { observe() {} },
    document: { addEventListener: (type, fn, capture) => handlers.push({ type, fn, capture }),
      querySelector: () => null, getElementById: () => null },
    window: { addEventListener() {}, history: { replaceState() {} } },
    localStorage: { getItem: () => null, setItem() {} },
    $: selector => selector === '#chatText' ? box : null,
    L: zh => zh, toast: x => notices.push(x), closeCtx() {}, renderChat() {},
    qs: () => '', loadChats: async () => {}, loadTimeline() {},
    setInterval: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; },
    clearInterval: id => timers.delete(id), setTimeout, clearTimeout, requestAnimationFrame: fn => fn(),
    api: (url, options) => { calls.push({ url, options }); return Promise.resolve([]); },
  });
  for (const file of ['app-live.js', 'app-compose.js', 'app-dispatch.js', 'app-events.js']) {
    vm.runInContext(readFileSync(new URL(`../src/pga/web/${file}`, import.meta.url), 'utf8'), c, { filename: file });
  }
  // Rendering and history fetching are separate from keyboard/request lifecycle behavior.
  c.renderChat = () => {};
  c.loadChat = async () => {};
  function key(key, extra = {}) {
    const e = { key, target: box, preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; }, ...extra };
    const keys = handlers.filter(h => h.type === 'keydown').sort((a, b) => Number(!!b.capture) - Number(!!a.capture));
    for (const h of keys) { h.fn(e); if (e.stopped) break; }
    return e;
  }
  return { c, box, calls, notices, timers, key };
}

test('Enter during a run queues draft and attachments without disturbing its live display', async () => {
  const h = harness();
  const current = { run: { id: 'original', text: 'previous tool output' } };
  h.c.S.sending = true; h.c.S.live = current;
  h.c.S.att.push({ name: 'draft.txt', type: 'text/plain' });
  h.box.value = '1. 补充第一点\n2. 补充第二点'; // dispatch wrapper must not bypass the guard
  h.key('Enter');
  await flush();
  assert.equal(h.calls.length, 0);
  assert.equal(h.c.S.live, current);
  assert.equal(h.c.S.sending, true);
  assert.equal(h.box.value, '');
  assert.equal(h.c.followups('chat:one')[0].text, '1. 补充第一点\n2. 补充第二点');
  assert.equal(h.c.followups('chat:one')[0].at.length, 1);
  assert.equal(h.c.S.att.length, 0);
  assert.equal(h.c.S.dispatchPlan, null);
  assert.equal(h.notices.length, 0);
});

test('IME confirmation and ordinary Escape do not submit or stop; explicit shortcut stops', async () => {
  const h = harness();
  h.c.S.live = { run: { id: 'running' } };
  assert.equal(h.key('Enter', { isComposing: true }).prevented, undefined);
  assert.equal(h.key('Enter', { keyCode: 229 }).prevented, undefined);
  h.key('Escape', { isComposing: true });
  h.key('Escape');
  h.key('Enter', { shiftKey: true });
  await flush();
  assert.equal(h.calls.length, 0);
  h.key('Escape', { metaKey: true });
  await flush();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/v1/agents/live/running/stop');
});

test('normal send starts once; a second Enter queues the next message', async () => {
  const h = harness();
  let finish;
  h.c.api = (url, options) => {
    h.calls.push({ url, options });
    return url.endsWith('/ask') ? new Promise(resolve => { finish = resolve; }) : Promise.resolve([]);
  };
  h.key('Enter');
  await flush();
  assert.equal(h.c.S.sending, true);
  const watch = h.c.S.live;
  h.box.value = '下一条草稿';
  h.key('Enter');
  await flush();
  assert.equal(h.calls.filter(x => x.url.endsWith('/ask')).length, 1);
  assert.equal(h.c.S.live, watch);
  assert.equal(h.box.value, '');
  assert.equal(h.c.followups('chat:one')[0].text, '下一条草稿');
  finish({ text: 'stopped', stopped: true });
  await flush();
  assert.equal(h.c.S.sending, false);
  assert.equal(h.box.value, '');
  assert.equal(h.c.followups('chat:one')[0].text, '下一条草稿');
});

test('late polls cannot replace another run or rewind newer progress', async () => {
  const h = harness(), pending = [];
  // Exercise response ordering independently of the shared 500 ms request cache.
  vm.runInContext("liveSnap = () => api('/v1/agents/live')", h.c);
  h.c.api = () => new Promise(resolve => pending.push(resolve));
  h.c.startLive('old');
  h.c.startLive('new');
  const current = h.c.S.live;
  const row = text => ({ id: 'new', tags: { conversation: 'u:new' }, started: Date.now() / 1000, text });
  pending[1]([row('new progress')]);
  await flush();
  pending[0]([{ ...row('old progress'), id: 'old', tags: { conversation: 'u:old' } }]);
  await flush();
  assert.equal(current.run.text, 'new progress');
  const poll = [...h.timers.values()].find(x => x.ms === 100).fn;
  poll(); poll();
  pending[3]([row('latest progress')]);
  await flush();
  pending[2]([row('stale progress')]);
  await flush();
  assert.equal(current.run.text, 'latest progress');
  poll();
  pending[4]([row('original keeps working'), { ...row(''), id: 'queued-follow-up', phase: 'queued' }]);
  await flush();
  assert.equal(current.run.id, 'new');
  assert.equal(current.run.text, 'original keeps working');
  poll(); h.c.stopLive();
  pending[5]([row('after stop')]);
  await flush();
  assert.equal(h.c.S.live, null);
});

test('queued messages run in order with fresh history, captured options and an untouched new draft', async () => {
  const h = harness(), pending = [], asks = []; let history = [];
  h.c.liveSnap = async () => [];
  h.c.S.chatModel = {'chat:one':'selected-model'};
  h.c.api = async (url, options) => {
    if (url.endsWith('/ask')) { asks.push(options.body); return new Promise(resolve=>pending.push(resolve)); }
    if (url.includes('/chats/')) return {turns:history};
    return [];
  };
  h.key('Enter'); await flush();
  h.box.value='follow one'; h.c.S.att.push({name:'notes.txt',type:'text/plain',data:'data:text/plain;base64,YQ=='});
  h.key('Enter'); h.box.value='follow two'; h.key('Enter');
  h.box.value='still editing';
  history=[{role:'agent',agent:'claude-2',text:'first complete answer'}];
  pending[0]({ok:true,text:'first complete answer'}); await flush();
  assert.equal(asks.length,2); assert.equal(asks[1].agent,'claude-2');
  assert.equal(asks[1].model,'selected-model'); assert.equal(asks[1].files[0].name,'notes.txt');
  assert.equal(asks[1].history.at(-1).text,'first complete answer');
  assert.equal(h.box.value,'still editing');
  history.push({role:'agent',agent:'claude-2',text:'follow one answer'});
  pending[1]({ok:true}); await flush();
  assert.equal(asks.length,3); assert.equal(asks[2].text,'follow two');
  assert.equal(asks[2].history.at(-1).text,'follow one answer');
  pending[2]({ok:true}); await flush();
  assert.equal(h.c.followups('chat:one').length,0);
  assert.equal(h.c.S.sending,false); assert.equal(h.box.value,'still editing');
});

test('uncertain request failure pauses the queue without replaying or losing messages', async()=>{
  const h=harness();h.c.S.sending=true;h.box.value='one';h.c.queueFollowup();h.box.value='two';h.c.queueFollowup();
  h.c.S.sending=false;let asked=0;
  h.c.startLive=()=>{};h.c.stopLive=()=>{};
  h.c.api=async(url)=>{if(url.endsWith('/ask')){asked++;throw Error('network disconnected');}return {turns:[]};};
  await h.c.drainFollowups('chat:one');
  assert.equal(asked,1);assert.equal(h.c.followups('chat:one').length,2);
  assert.ok(h.c.followups('chat:one').every(x=>x.paused));
  await h.c.drainFollowups('chat:one');assert.equal(asked,1);
});

test('storage failure retains draft and attachments; restored queues are paused and scoped', ()=>{
  const h=harness();h.c.S.sending=true;
  h.c.localStorage.setItem=()=>{throw Error('quota');};
  h.c.S.att.push({name:'big.txt',type:'text/plain'});h.key('Enter');
  assert.equal(h.box.value,'补充说明');assert.equal(h.c.S.att.length,1);assert.equal(h.c.followups('chat:one').length,0);
  delete h.c.S.followups;
  h.c.localStorage.getItem=k=>k.endsWith('chat:one') ? JSON.stringify([{id:'saved',text:'recover',at:[]}]):null;
  assert.equal(h.c.followups('chat:one')[0].paused,true);
  assert.equal(h.c.followups('chat:two').length,0);
});

test('unchanged live content preserves the card across clock ticks; changed content and replaced DOM refresh',async()=>{
 const h=harness();let renders=0,replacements=0,box;
 const makeBox=()=>({querySelector:()=>null,querySelectorAll:()=>[],set outerHTML(v){replacements++;box=makeBox();}});
 h.c.document.createElement=()=>({content:{firstElementChild:{}}});h.c.patchLiveNode=()=>{replacements++;};
 box=makeBox();h.c.document.getElementById=id=>id==='workCard'?box:null;h.c.document.querySelectorAll=()=>[];
 h.c.workCard=()=>{renders++;return '<div class="work">'+renders+'</div>';};
 let run={id:'r',started:Date.now()/1000,running:true,text:'same',tags:{conversation:'u:chat:one'}};
 h.c.liveSnap=async()=>[{...run}];h.c.startLive('chat:one');await flush();
 const poll=[...h.timers.values()].find(t=>t.ms===100).fn;
 for(let i=0;i<20;i++)await poll();assert.equal(renders,1);assert.equal(replacements,1);
 run={...run,text:'new output'};await poll();assert.equal(replacements,2);
 box=makeBox();await poll();assert.equal(replacements,3);
});

test('queued split follow-up still reaches both independent lanes',async()=>{
  const h=harness(),asks=[];
  h.c.S.uid='u';h.c.S.sending=true;h.box.value='queued for both';h.c.queueFollowup();h.c.S.sending=false;
  h.c.api=async(url,options)=>{
    if(url.endsWith('/ask')) { asks.push(options.body);return {ok:true}; }
    if(url.includes('/chats/')) return {turns:[],context:[],split:{lanes:[{key:'second:left',agent:'a'},{key:'second:right',agent:'b'}]}};
    return [];
  };
  await h.c.drainFollowups('chat:one');
  assert.deepEqual(asks.map(x=>x.conversation),['second:left','second:right']);
  assert.deepEqual(asks.map(x=>x.agent),['a','b']);
  assert.ok(asks.every(x=>x.history===undefined));assert.equal(h.c.followups('chat:one').length,0);
});

test('running composer explains queue timing in its placeholder, without a line that pushes it up', () => {
  const {c}=harness();
  let next;const host={dataset:{},querySelector:()=>next,set innerHTML(html){next={placeholder:'写点什么…'};}};
  c.$=s=>s==='#ccomp'?host:null;
  c.paintComposer('idle');
  assert.equal(next.placeholder,'写点什么…');
  c.S.sending=true;
  assert.equal(c.followupHtml(),'');
  c.paintComposer('running');
  assert.match(next.placeholder,/发送时插入当前任务/);
  c.S.sending=false;c.S.regenBusy=true;
  assert.equal(c.followupHtml(),'');
  c.paintComposer('regenerating');
  assert.match(next.placeholder,/不支持时排队/);
});

test('sending empties the composer before the redraw, so it shrinks back at once', async () => {
  const h=harness();h.c.S.uid='u';h.c.S.sentHist=[];h.c.S.chatCtx={};h.c.takeAtts=()=>({images:[],files:[]});
  h.box.value='第一行\n第二行\n第三行';
  let seen;h.c.renderChat=()=>{seen??=h.box.value;};
  h.c.api=()=>new Promise(()=>{});
  h.c.chatSend();await flush();
  assert.equal(seen,'');
  assert.equal(h.c.S.chatTurns['chat:one'].at(-1).text,'第一行\n第二行\n第三行');
});

test('composer redraw preserves a focused draft and selection, and waits for IME commit', async () => {
  const {c}=harness();let current, redraws=0, committed;
  const makeBox=()=>({value:'draft being edited',selectionStart:2,selectionEnd:7,selectionDirection:'backward',scrollTop:18,isConnected:true,
    focus(){c.document.activeElement=this;},setSelectionRange(a,b,d){this.selectionStart=a;this.selectionEnd=b;this.selectionDirection=d;},
    addEventListener(type,fn){assert.equal(type,'compositionend');committed=fn;}});
  current=makeBox();c.document.activeElement=current;
  const host={dataset:{composerKey:'chat:one'},querySelector:()=>current,set innerHTML(html){redraws++;current.isConnected=false;current=makeBox();current.value='';}};
  c.$=s=>s==='#ccomp'?host:current;
  c.paintComposer('updated markup');
  assert.equal(current.value,'draft being edited');
  assert.deepEqual([current.selectionStart,current.selectionEnd,current.selectionDirection,current.scrollTop],[2,7,'backward',18]);
  assert.equal(c.document.activeElement,current);
  current._pgaComposing=true;const composing=current;
  c.renderChat=()=>c.paintComposer('after commit');
  c.paintComposer('during IME');c.paintComposer('another update');
  assert.equal(redraws,1);assert.equal(current,composing);
  current.value='完整的中文';current._pgaComposing=false;committed();
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(redraws,2);assert.equal(current.value,'完整的中文');
  assert.equal(c.document.activeElement,current);
});

test('insert queued text targets the exact running conversation and never creates another ask', async () => {
  const h=harness();h.c.S.uid='u';h.c.S.sending=true;h.c.queueFollowup();
  const item=h.c.followups()[0];
  h.c.S.chatTurns['chat:one']=[{role:'user',text:'原提问',at:'2026-11-16T00:00:00Z'}];
  h.box.value='new unsent draft';
  const calls=[];
  h.c.api=async(url,options)=>{
    calls.push({url,options});
    if(url==='/v1/agents/live')return [{id:'unrelated',running:true,can_steer:true,tags:{conversation:'other:chat:one'}},{id:'active',running:true,can_steer:true,tags:{conversation:'u:chat:one'}}];
    assert.equal(url,'/v1/users/u/agents/live/active/steer');
    assert.equal(options.body.message_id,item.id);
    return {status:'accepted'};
  };
  await h.c.steerFollowup('chat:one',item.id);
  assert.equal(h.c.followups().length,0);
  assert.equal(h.box.value,'new unsent draft');
  assert.equal(h.c.S.chatTurns['chat:one'][0].text,'原提问\n\n[运行中补充]\n补充说明');
  assert.equal(h.c.followupHtml(),'');
  assert.equal(calls.length,2);
  assert.equal(h.c.S.sending,true);
});

test('uncertain delivery stays paused and checks the same receipt instead of a newer run', async () => {
  const h=harness();h.c.S.uid='u';h.c.S.sending=true;h.c.queueFollowup();
  const item=h.c.followups()[0];let posts=0,reads=0;
  h.c.api=async(url)=>{
    if(url==='/v1/agents/live'){reads++;return [{id:'active',running:true,can_steer:true,tags:{conversation:'u:chat:one'}}];}
    assert.equal(url,'/v1/users/u/agents/live/active/steer');
    posts++;if(posts===1)throw Error('connection lost');
    return {status:'accepted'};
  };
  await h.c.steerFollowup('chat:one',item.id);
  assert.equal(item.paused,true);assert.equal(item.steerState,'uncertain');
  h.c.S.sending=false;
  await h.c.drainFollowups('chat:one');assert.equal(posts,1);
  await h.c.steerFollowup('chat:one',item.id);
  assert.equal(reads,1);assert.equal(posts,2);assert.equal(h.c.followups().length,0);
});

test('unsupported connections retain queued messages and repeated clicks send once', async () => {
  const h=harness();h.c.S.uid='u';h.c.S.sending=true;h.c.queueFollowup();
  const item=h.c.followups()[0];
  h.c.api=async()=>[{id:'claude',running:true,tags:{conversation:'u:chat:one'}}];
  await h.c.steerFollowup('chat:one',item.id);
  assert.equal(h.c.followups().length,1);assert.equal(item.paused,false);assert.equal(item.steerRun,undefined);
  let release,posts=0;
  h.c.api=async(url)=>url==='/v1/agents/live'?[{id:'active',running:true,can_steer:true,tags:{conversation:'u:chat:one'}}]:(posts++,new Promise(r=>release=r));
  const first=h.c.steerFollowup('chat:one',item.id);await flush();
  await h.c.steerFollowup('chat:one',item.id);assert.equal(posts,1);
  release({status:'rejected',error:'turn ended'});await first;
  assert.equal(h.c.followups().length,1);assert.equal(item.paused,false);assert.equal(item.steerRun,undefined);
});

test('refresh recovers pending insertion as an uncertain receipt, never a disabled sending button', () => {
  const h=harness();h.c.localStorage.getItem=()=>JSON.stringify([{id:'queued',text:'x',paused:true,steerState:'sending',steerRun:'run-a'}]);
  const item=h.c.followups()[0];
  assert.equal(item.paused,true);assert.equal(item.steerState,'uncertain');assert.equal(item.steerRun,'run-a');
});

test('a late rejected insertion cannot restart the queue after the current task was stopped', async () => {
  const h=harness();h.c.S.uid='u';h.c.S.sending=true;h.c.queueFollowup();
  const item=h.c.followups()[0];let release;
  h.c.api=async url=>url==='/v1/agents/live'?[{id:'active',running:true,can_steer:true,tags:{conversation:'u:chat:one'}}]:new Promise(r=>release=r);
  const inserting=h.c.steerFollowup('chat:one',item.id);await flush();
  h.c.S.sending=false;await h.c.drainFollowups('chat:one',false);
  release({status:'rejected',error:'stopped'});await inserting;
  assert.equal(h.c.followups()[0],item);assert.equal(item.paused,true);assert.equal(h.c.S.sending,false);
});

 test('send during a running task inserts text directly without an extra click', async()=>{
 const h=harness();h.c.S.uid='u';h.c.S.sending=true;
 const calls=[];h.c.api=async(url,options)=>{calls.push(url);if(url==='/v1/agents/live')return [{id:'active',running:true,can_steer:true,tags:{conversation:'u:chat:one'}}];assert.equal(options.body.text,'补充说明');return {status:'accepted'};};
 await h.c.chatSend();assert.equal(h.c.followups().length,0);assert.equal(h.box.value,'');
 assert.deepEqual(calls,['/v1/agents/live','/v1/users/u/agents/live/active/steer']);
 });

test('stop on an expired run releases a lost ask response and pauses follow-ups', async () => {
  const h = harness(); h.c.S.uid = 'u';
  h.c.liveSnap = async () => [];
  h.c.api = async url => url.endsWith('/ask') ? new Promise(() => {}) : url.endsWith('/stop') ? {running:false} : [];
  const sending = h.c.chatSend(); await flush();
  h.c.S.live.run = {id:'expired', tags:{conversation:'u:chat:one'}, finished:Date.now()/1000};
  h.box.value='keep this follow-up'; h.c.queueFollowup();
  await h.c.requestLiveStop('expired'); await sending;
  assert.equal(h.c.S.sending,false);
  assert.equal(h.c.S.live,null);
  assert.equal(h.c.followups()[0].paused,true);
});

test('recovery will not release a new running attempt or a different watcher', async () => {
  const h=harness(); let released=0;
  const watch={key:'chat:one',run:{id:'old',tags:{conversation:'u:chat:one'}},release:()=>released++};
  h.c.S.live=watch;
  h.c.api=async()=>[{id:'new-attempt',tags:{conversation:'u:chat:one'}}];
  await h.c.recoverLive(watch); assert.equal(released,0);
  h.c.S.live={key:'chat:two'}; h.c.api=async()=>[];
  await h.c.recoverLive(watch); assert.equal(released,0);
});

test('a failed history refresh cannot leave the composer permanently busy', async () => {
  const h=harness(); h.c.liveSnap=async()=>[];
  h.c.api=async()=>({ok:false,error:'account disabled'});
  h.c.loadChats=async()=>{throw Error('network down');};
  await h.c.chatSend();
  assert.equal(h.c.S.sending,false); assert.equal(h.c.S.live,null);
});

test('finished run from polling recovers a lost response without another click', async () => {
  const h=harness(); h.c.liveSnap=async()=>[];
  h.c.api=async url=>url.endsWith('/ask')?new Promise(()=>{}):[];
  const sending=h.c.chatSend(); await flush();
  h.c.S.live.run={id:'done',finished:Date.now()/1000,ok:false};
  h.c.S.live.endedAt=Date.now()-6000;
  const poll=[...h.timers.values()].find(t=>t.ms===100).fn;
  await poll(); await sending;
  assert.equal(h.c.S.sending,false); assert.equal(h.c.S.live,null);
});

test('finished error card labels failure instead of writing', () => {
  const h=harness(); h.c.esc=s=>s; h.c.md=s=>s; h.c.generatedPictures=()=>'';
  const html=h.c.workCard({run:{id:'denied',text:'API Error: account disabled',started:1,finished:8,ok:false}});
  assert.match(html,/运行失败/); assert.match(html,/同步对话/);
  assert.doesNotMatch(html,/正在写回答/);
});

test('a recently finished previous turn cannot cancel a new request still preparing context', async () => {
  const h=harness(); let released=0;
  const watch={key:'chat:one',t0:Date.now(),run:{id:'previous',started:(Date.now()-2000)/1000,finished:Date.now()/1000},release:()=>released++};
  h.c.S.live=watch; h.c.api=async()=>[];
  await h.c.recoverLive(watch); assert.equal(released,0);
});


test('accepted supplements accumulate by ID and snapshots do not duplicate reloaded history', () => {
  const h=harness(), q={role:'user',text:'original'};
  assert.equal(h.c.attachSteering(q,[{id:'1',text:'same'}]),true);
  assert.equal(h.c.attachSteering(q,[{id:'2',text:'same'}]),true);
  const inputs=[{id:'1',text:'same'},{id:'2',text:'same'},{id:'3',text:'last'}];
  assert.equal(h.c.attachSteering(q,inputs,true),true);
  assert.equal(h.c.attachSteering(q,inputs,true),false);
  const loaded={role:'user',text:q.text};
  assert.equal(h.c.attachSteering(loaded,inputs,true),false);
  assert.equal(loaded.text.split('[运行中补充]').length,4);
});

test('supplements render below their own question and before its answer, including saved history', () => {
  const h=harness();
  const src=readFileSync(new URL('../src/pga/web/app-chats.js',import.meta.url),'utf8');
  const start=src.indexOf('function chatTurnsHtml('), end=src.indexOf('\n}',start)+2;
  Object.assign(h.c,{esc:String,md:x=>`<p>${x}</p>`,PGATree:{chat:xs=>`<article>${xs[0].text}</article>`},userActs:()=>'<nav>actions</nav>',agentLabel:x=>x,procBlock:()=>'<aside>work</aside>',replyMeta:()=>'',replyActs:()=>''});
  vm.runInContext(src.slice(start,end),h.c);
  const html=h.c.chatTurnsHtml([{role:'user',text:'question\n\n[运行中补充]\nextra one\n\n[运行中补充]\nextra two',run:'r'},{role:'agent',text:'answer',agent:'test',run:'r'},{role:'user',text:'next question'}]);
  assert.ok(html.indexOf('question</article>') < html.indexOf('extra one'));
  assert.ok(html.indexOf('extra one') < html.indexOf('extra two'));
  assert.ok(html.indexOf('extra two') < html.indexOf('<aside>work'));
  assert.ok(html.indexOf('extra two') < html.indexOf('next question'));
  assert.equal((html.match(/question-supplement"/g)||[]).length,2);
});
