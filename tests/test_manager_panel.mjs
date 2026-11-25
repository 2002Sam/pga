import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-manager-panel.js',import.meta.url),'utf8');
function setup() {
  const frames=[], label={}, status={append(){}}, classes=new Set();
  const panel={hidden:true,querySelector:s=>s==='[data-mp-name]'?label:s==='.mp-status'?status:{append:f=>frames.push(f)}};
  const view={classList:{toggle:(c,on)=>on?classes.add(c):classes.delete(c)}};
  const c=vm.createContext({S:{uid:'u',chat:'chat:a',view:'chats'},Q:new URLSearchParams(),URLSearchParams,
    L:s=>s,renderChat(){},pjCanonical:k=>k.replace(/^imp:/,'c:'),pjName:x=>x?.project||'日常对话',recentItems:()=>[],
    document:{getElementById:id=>id==='managerPanel'?panel:id==='vChats'?view:null,querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){},
      createElement:()=>({addEventListener(){},contentWindow:{},remove(){this.removed=true;}})}});
  c.window=c;vm.runInContext(src,c);
  const calls=[];c.api=async(url,opts)=>{calls.push({url,opts});return url.endsWith('/project-map')?{project:'PGA',manager:'chat:pm-pga'}:{of:{'chat:a':'PGA'}};};
  return {c,frames,label,status,panel,classes,calls};
}
test('opening reuses one manager frame and render updates never resubmit or reload it',async()=>{
  const t=setup();await t.c.pmPanelToggle();const f=t.frames[0];
  f.contentWindow.draft='keep';assert.equal(t.panel.hidden,false);assert.equal(t.frames.length,1);
  assert.equal(new URL(f.src,'http://localhost').searchParams.get('pmpanel'),'1');
  t.c.renderChat();assert.equal(t.calls.length,2);
  await t.c.pmPanelToggle();assert.equal(t.panel.hidden,true);
  await t.c.pmPanelToggle();assert.equal(t.frames.length,1);assert.equal(f.contentWindow.draft,'keep');
  assert.equal(t.label.textContent,'PGA · 管理员');
});
test('close invalidates a late project response before a frame is mounted',async()=>{
  const t=setup();let complete;t.c.api=()=>new Promise(resolve=>complete=resolve);
  const loading=t.c.pmPanelToggle();t.c.pmPanelClose();complete({of:{'chat:a':'PGA'}});await loading;
  assert.equal(t.frames.length,0);assert.equal(t.panel.hidden,true);
});
test('category changes cannot be overwritten by an older lookup',async()=>{
  const t=setup(),pending=[];t.c.api=()=>new Promise(resolve=>pending.push(resolve));
  const a=t.c.pmPanelToggle();t.c.S.chat='chat:b';const b=t.c.pmPanelLoad();
  pending[1]({of:{'chat:b':'Research'}});await new Promise(setImmediate);
  pending[2]({project:'Research',manager:'chat:pm-research'});await b;
  pending[0]({of:{'chat:a':'PGA'}});await a;
  assert.equal(t.frames.length,1);assert.equal(t.label.textContent,'Research · 管理员');
});
test('account switches discard the former account’s cached manager before loading',async()=>{
  const t=setup();await t.c.pmPanelToggle();const old=t.frames[0];
  t.c.S.uid='other';let complete;t.c.api=()=>new Promise(resolve=>complete=resolve);
  const loading=t.c.pmPanelLoad();assert.equal(old.removed,true);
  t.c.pmPanelClose();complete({of:{}});await loading;
});
test('import aliases use the assigned category, with an explicit daily category fallback',()=>{
  const {c}=setup();assert.equal(c.pmPanelProject({of:{'c:123':'Paper'}},'imp:123'),'Paper');
  assert.equal(c.pmPanelProject({of:{}},'chat:new'),'日常对话');
});
test('a manager cannot recursively open its own sidebar, and tools expose expanded state',async()=>{
  const {c,calls}=setup();assert.match(c.pmPanelTool(),/aria-expanded="false"/);
  await c.pmPanelToggle();assert.match(c.pmPanelTool(),/aria-expanded="true"/);
  c.S.chat='chat:pm-pga';c.renderChat();assert.equal(c.pmPanelTool(),'');
  const count=calls.length;await c.pmPanelToggle();assert.equal(calls.length,count);
});

test('manager view and embedding parameters survive a URL update and reload',()=>{
  const core=fs.readFileSync(new URL('../src/pga/web/app-core.js',import.meta.url),'utf8');
  const fn=core.slice(core.indexOf('const qs = () =>'),core.indexOf('document.querySelectorAll("[data-l]")'));
  const c=vm.createContext({S:{view:'chats',chat:'chat:pm-a'},window:{pmProjectFor:k=>k.startsWith('chat:pm-')?'PGA':null},
    Q:new URLSearchParams('embed=1&pmpanel=1&pmfull=graph&pmfrom=chat:a'),AS_UID:'u',URLSearchParams,location:{pathname:'/'}});
  vm.runInContext(fn,c);let q=new URLSearchParams(vm.runInContext('qs()',c));
  for(const k of ['embed','pmpanel'])assert.equal(q.get(k),'1');
  assert.equal(q.get('pmfull'),'graph');assert.equal(q.get('pmfrom'),'chat:a');
  c.S.chat='chat:a';q=new URLSearchParams(vm.runInContext('qs()',c));assert.equal(q.has('pmpanel'),false);assert.equal(q.get('embed'),'1');
});

test('a standalone sidebar submits through the manager API without opening hidden stage windows',async()=>{
  const doc=fs.readFileSync(new URL('../src/pga/web/app-pmdoc.js',import.meta.url),'utf8'),calls=[];
  const host={S:{view:'chats'},ST:{nodes:[]},stOpen:()=>assert.fail('must keep the standalone conversation in place')};
  const c=vm.createContext({S:{uid:'u',chat:'chat:pm-a'},PM:{name:'PGA'},window:{},Q:new URLSearchParams('pmpanel=1'),
    chatSend(){},document:{querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}},setInterval(){},L:s=>s,
    loadChat:async()=>{},boardRefresh(){},pmHost:()=>host,pmSourceKey:()=> 'chat:origin',
    api:async(url,opts)=>{calls.push({url,body:opts.body});return {entry:{tasks:[{key:'chat:new'}]}};}});
  c.window=c;vm.runInContext(doc,c);await c.pdSend('需要处理的任务',{images:[],files:[]});
  assert.equal(calls.length,1);assert.match(calls[0].url,/manager-submit$/);
  assert.equal(calls[0].body.conversation,'chat:pm-a');assert.equal(calls[0].body.text,'需要处理的任务');
});

test('embedded entry delegates to the outer surface without creating an internal panel',async()=>{
  const {c,calls,panel}=setup(); const sources=[];
  c.parent={pmPanelToggle:async key=>sources.push(key)};
  await c.pmPanelToggle();
  assert.deepEqual(sources,['chat:a']);assert.equal(calls.length,0);assert.equal(panel.hidden,true);
});
test('a host without a canvas keeps its panel fallback and switches the requested source',async()=>{
  const {c,frames,panel}=setup();c.S.view='stage';
  await c.pmPanelToggle('chat:a');assert.equal(panel.hidden,false);
  await c.pmPanelToggle('chat:b');assert.equal(panel.hidden,false);assert.equal(frames.length,1);
  await c.pmPanelToggle('chat:b');assert.equal(panel.hidden,true);
});

test('stage entry opens a sibling manager for the clicked source, not the focused chat',async()=>{
  const {c,frames,calls}=setup(),opened=[];
  c.S.view='stage';c.ST={focus:'b',nodes:[{id:'a',type:'win',key:'chat:a'},{id:'b',type:'win',key:'chat:b'}]};
  c.stOpen=(key,at)=>{opened.push({key,...at});return {};};c.toast=message=>assert.fail(message);
  await c.pmPanelToggle('chat:a');
  assert.equal(frames.length,0);
  assert.deepEqual(opened,[{key:'chat:pm-pga',win:'a',managerProject:'PGA',managerBeside:'a'}]);
  assert.equal(calls.length,2);
  const child=setup().c;child.parent=c;
  assert.match(child.pmPanelTool(),/左侧/);assert.doesNotMatch(child.pmPanelTool(),/aria-controls/);
});
test('stage button opens, folds and reopens the same manager beside its source',async()=>{
  const {c,frames,calls}=setup(),opened=[];
  c.S.view='stage';c.ST={nodes:[{id:'a',type:'win',key:'chat:a'},{id:'pm',type:'win',key:'chat:pm-pga',managerProject:'PGA',small:true}]};
  const manager=c.ST.nodes[1], folded=[];
  c.stOpen=(key,at)=>{manager.managerBeside=at.win;manager.small=false;opened.push(key);return manager;};
  c.stMini=(node,on)=>{assert.equal(node,manager);node.small=on;folded.push(on);};
  c.stFocus=id=>assert.equal(id,'a');c.toast=message=>assert.fail(message);
  await c.pmPanelToggle('chat:a');await c.pmPanelToggle('chat:a');
  assert.equal(manager.small,true);
  await c.pmPanelToggle('chat:a');
  assert.deepEqual(folded,[true]);assert.equal(opened.length,2);assert.equal(manager.small,false);assert.equal(frames.length,0);
  assert.ok(calls.every(call=>call.url.endsWith('/conversation-projects')));
});
test('pressing the same edge button during lookup cancels the pending open',async()=>{
  const {c}=setup();let resolve;
  c.S.view='stage';c.ST={nodes:[{id:'a',type:'win',key:'chat:a'}]};
  c.stOpen=()=>assert.fail('cancelled manager reopened');
  c.api=()=>new Promise(r=>resolve=r);
  const opening=c.pmPanelToggle('a');
  await c.pmPanelToggle('a');
  resolve({of:{'chat:a':'PGA'}});await opening;
});
test('late stage lookup cannot open a manager after its source closes or the view changes',async()=>{
  for(const change of ['close','view','account']) {
    const {c,frames}=setup();let resolve;
    c.S.view='stage';c.ST={nodes:[{id:'a',type:'win',key:'chat:a'}]};
    c.stOpen=()=>assert.fail('stale request opened a page');c.api=()=>new Promise(r=>resolve=r);
    const opening=c.pmPanelToggle('chat:a');
    if(change==='close')c.ST.nodes=[];
    if(change==='view')c.S.view='chats';
    if(change==='account')c.S.uid='another';
    resolve({of:{'chat:a':'PGA'}});await opening;assert.equal(frames.length,0);
  }
});
test('a later source click supersedes an older pending lookup',async()=>{
  const {c}=setup(),pending=[],opened=[];
  c.S.view='stage';c.ST={nodes:[{id:'a',type:'win',key:'chat:a'},{id:'b',type:'win',key:'chat:b'}]};
  c.api=()=>new Promise(r=>pending.push(r));c.stOpen=(key,at)=>{opened.push(at.win);return {};};
  const a=c.pmPanelToggle('chat:a'), b=c.pmPanelToggle('chat:b');
  pending[1]({of:{'chat:b':'Paper'}});await new Promise(setImmediate);
  pending[2]({project:'Paper',manager:'chat:pm-paper'});await b;
  pending[0]({of:{'chat:a':'PGA'}});await a;
  assert.deepEqual(opened,['b']);
});

test('blank canvas windows move the existing manager immediately by window id, without an API call',async()=>{
  const {c}=setup(),opened=[];
  c.S.view='stage';c.ST={nodes:[{id:'blank',type:'win',key:null},{id:'pm',type:'win',key:'chat:pm-pga',managerProject:'PGA'}]};
  c.stGroupOf=()=>({id:'pj:PGA'});c.api=()=>assert.fail('cached manager movement must not wait on the server');
  c.stOpen=(key,at)=>{opened.push({key,...at});return {};};c.toast=message=>assert.fail(message);
  const opening=c.pmPanelStageOpen('blank');
  assert.deepEqual(opened,[{key:'chat:pm-pga',win:'blank',managerProject:'PGA',managerBeside:'blank'}]);
  await opening;
});
test('embedded source lookup uses its canvas window id when the conversation key is not ready',async()=>{
  const {c}=setup(),sources=[];
  c.S.chat=null;c.frameElement={_pgaNodeId:'blank'};
  c.parent={S:{view:'stage'},ST:{nodes:[]},stOpen(){},pmPanelToggle(){},pmPanelStageOpen:source=>sources.push(source)};
  await c.pmPanelToggle();assert.deepEqual(sources,['blank']);
});
