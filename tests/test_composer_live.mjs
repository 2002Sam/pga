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
    clearInterval: id => timers.delete(id), setTimeout, clearTimeout,
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
  const poll = [...h.timers.values()].find(x => x.ms === 600).fn;
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
  const h=harness();h.c.S.sending=true;h.box.value='one';h.key('Enter');h.box.value='two';h.key('Enter');
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
 box=makeBox();h.c.document.getElementById=id=>id==='workCard'?box:null;h.c.document.querySelectorAll=()=>[];
 h.c.workCard=()=>{renders++;return '<div class="work">'+renders+'</div>';};
 let run={id:'r',started:Date.now()/1000,running:true,text:'same',tags:{conversation:'u:chat:one'}};
 h.c.liveSnap=async()=>[{...run}];h.c.startLive('chat:one');await flush();
 const poll=[...h.timers.values()].find(t=>t.ms===600).fn;
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
