import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/pga/web/app-pmdoc.js', import.meta.url), 'utf8');
function setup() {
  const clicks = [], opens = [], notices = [], timers = [];
  const button = {dataset:{pdcontinue:'chat:mt-task'}, setAttribute(){}};
  const input = {value:'尚未发送的草稿', getClientRects:()=>[{}], focus(){this.focused = true;},
    setSelectionRange(a,b){this.selection = [a,b];}, scrollIntoView(){this.scrolled = true;}};
  const history = {scrollTop:17, scrollHeight:1500};
  const child = {S:{uid:'u', view:'chats', chat:'chat:mt-task', chatTurns:{'chat:mt-task':[]}},
    document:{querySelector:s=>s === '#chatText' ? input : s === '#cdlg' ? history : null}};
  const node = {type:'win', key:'chat:mt-task', el:{querySelector:()=>({contentWindow:child})}};
  const host = {ST:{nodes:[node]}};
  const c = {S:{uid:'u',view:'chats',chat:'chat:pm-demo',chatTurns:{'chat:pm-demo':[]}}, chatSend(){},
    document:{querySelector:()=>({}),querySelectorAll:()=>[button],addEventListener:(type,fn)=>{if(type === 'click') clicks.push(fn);}},
    L:x=>x, esc:s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;'), md:String,
    setInterval(){}, setTimeout:fn=>{timers.push(fn);return timers.length;}, clearTimeout(){}, toast:m=>notices.push(m)};
  c.window = c; vm.createContext(c); vm.runInContext(source, c);
  c.pmHost = () => host; c.pdBeside = key => {opens.push(key);return node;};
  return {c,child,input,history,node,host,button,opens,notices,timers,click:clicks.at(-1)};
}

test('task status offers only a quick conversation link', () => {
  const {c} = setup(); c.PM={m:{names:new Map([['chat:mt-task','任务对话'],['chat:a"b','任务对话']])}};
  for (const st of ['done','error','running']) {
    const html = c.pdNoteHtml({id:'task',key:'chat:mt-task',st,body:'原始回复'});
    assert.match(html, /data-pdgo="chat:mt-task"/);
    assert.match(html, /任务对话/);
    assert.doesNotMatch(html, /继续对话|原始回复|data-pdcontinue|打开独立对话/);
  }
  assert.doesNotMatch(c.pdNoteHtml({id:'pending',st:'running'}), /data-pdcontinue/);
  assert.match(c.pdNoteHtml({id:'task',key:'chat:a"b',st:'done'}), /data-pdgo="chat:a&quot;b"/);
  assert.equal(c.pdAnswerNote({text:'旧的管理员回复'},'old').key,'chat:pm-demo');
});

test('continue focuses the original task at the latest reply and preserves its draft', async () => {
  const h = setup();
  await h.c.pdContinue('chat:mt-task');
  assert.deepEqual(h.opens,['chat:mt-task']);
  assert.equal(h.input.focused,true);
  assert.equal(h.input.value,'尚未发送的草稿');
  assert.deepEqual(h.input.selection,[h.input.value.length,h.input.value.length]);
  assert.equal(h.history.scrollTop,h.history.scrollHeight);
  assert.equal(h.button.disabled,false);
  assert.equal(h.host.ST.nodes.length,1);
  assert.deepEqual(h.notices,[]);
});

test('slow history keeps the button busy; repeat clicks do not open duplicate windows', async () => {
  const h = setup();h.child.S.chatLoads = {'chat:mt-task':{}};
  const pending = h.c.pdContinue('chat:mt-task');
  assert.equal(h.button.disabled,true);
  assert.match(h.button.textContent,/正在打开/);
  assert.equal(h.input.focused,undefined);
  await h.c.pdContinue('chat:mt-task');
  assert.equal(h.opens.length,1);
  delete h.child.S.chatLoads['chat:mt-task'];h.timers.shift()();await pending;
  assert.equal(h.input.focused,true);
  assert.equal(h.button.disabled,false);
});

test('failed history reports the problem and permits retry', async () => {
  const h = setup();h.child.S.chatLoadErrors = {'chat:mt-task':'读取失败'};
  await h.c.pdContinue('chat:mt-task');
  assert.deepEqual(h.notices,['读取失败']);
  assert.equal(h.input.focused,undefined);
  assert.equal(h.button.disabled,false);
  delete h.child.S.chatLoadErrors['chat:mt-task'];
  await h.c.pdContinue('chat:mt-task');assert.equal(h.input.focused,true);
});

test('closing the task or switching account during loading does not steal focus', async () => {
  for (const change of ['closed','account']) {
    const h = setup();h.child.S.chatTurns = {};
    const pending = h.c.pdContinue('chat:mt-task');
    if (change === 'closed') h.host.ST.nodes = [];
    else h.c.S.uid = 'someone-else';
    h.timers.shift()();await pending;
    assert.equal(h.input.focused,undefined);assert.deepEqual(h.notices,[]);
  }
});

test('a later continuation takes priority over an older slow-loading page', async () => {
  const h = setup();h.child.S.chatTurns = {};
  const pending = h.c.pdContinue('chat:mt-task');
  const editor = {...h.input};
  h.c.document.querySelector = s => s === '#pdDraft' ? editor : null;
  await h.c.pdContinue('chat:pm-demo');
  h.child.S.chatTurns['chat:mt-task'] = [];h.timers.shift()();await pending;
  assert.equal(editor.focused,true);assert.equal(h.input.focused,undefined);
});

test('standalone manager panel focuses the host conversation; direct manager answers focus its own editor', async () => {
  let h = setup();h.c.pmHost = () => h.child;h.c.pdBeside = () => undefined;
  await h.c.pdContinue('chat:mt-task');assert.equal(h.input.focused,true);
  h = setup();h.c.document.querySelector = s => s === '#pdDraft' ? h.input : null;
  await h.c.pdContinue('chat:pm-demo');
  assert.equal(h.input.focused,true);assert.equal(h.input.scrolled,true);assert.deepEqual(h.opens,[]);
});

test('continue button handles mouse or keyboard clicks without the old input jump/branch', () => {
  const h = setup(), calls=[];
  h.c.pdContinue = key => calls.push(key);
  h.click({target:{closest:s=>s === '[data-pdcontinue]' ? h.button : null},detail:0,
    preventDefault(){calls.push('prevent');},stopPropagation(){calls.push('stop');}});
  assert.deepEqual(calls,['prevent','stop','chat:mt-task']);
  assert.deepEqual(h.opens,[]);
});

test('native focus handoff is limited to the requested account, conversation and recent click', async () => {
  for (const kind of ['matching','other-user','other-chat','expired']) {
    const h = setup();h.c.PGA_NATIVE = {float:true};h.c.S = h.child.S;
    h.c.document.querySelector = h.child.document.querySelector;
    let stored = JSON.stringify({uid:kind === 'other-user' ? 'another' : 'u',
      key:kind === 'other-chat' ? 'chat:unrelated' : 'chat:mt-task',at:Date.now() - (kind === 'expired' ? 60000 : 0)});
    h.c.localStorage = {getItem:()=>stored,removeItem:()=>{stored=null;}};
    h.c.pdTakeNativeContinue();await Promise.resolve();await Promise.resolve();
    assert.equal(!!h.input.focused,kind === 'matching');
    if (kind === 'matching') assert.equal(stored,null);
    assert.deepEqual(h.notices,[]);
  }
});
