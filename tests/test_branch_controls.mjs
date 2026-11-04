import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/pga/web/app-stage.js', import.meta.url), 'utf8');
function harness() {
  const calls = [], attached = [];
  const frame = { S: { chat: 'chat:source', chatAgent: 'claude-2' }, document: { querySelector: s => ({value: {'#chatAgent':'claude-2','#chatModel':'opus','#chatEffort':'high'}[s]}) } };
  const n = {id:'parent', key:'chat:source', el:{querySelector:()=>({contentWindow:frame})}};
  const context = vm.createContext({ window: {}, S:{uid:'user'}, L:zh=>zh, toast(){}, stTitle:()=> '原标题', stId:()=>`id${calls.length}`,
    api:async (url,opts)=>{ calls.push(opts.body); return {key:`chat:new-${calls.length}`}; },
    stAttach:(parent,made)=>attached.push(...made), branchBackendReady:async()=>true });
  vm.runInContext(source.slice(source.indexOf('function branchOptions('),source.indexOf('window.stBranchAt')),context);
  const start=source.indexOf('async function stGrowBranches(');
  vm.runInContext(source.slice(start,source.indexOf('/* ------------------------------------------------ the notepad',start)),context);
  return {context,n,calls,attached};
}
test('Branch delegates to the existing conversation frame',async()=>{
  const h=harness();let calls=0;h.n.el.querySelector=()=>({contentWindow:{startSplit:async()=>{calls++}}});
  await h.context.stFork(h.n);assert.equal(calls,1);assert.equal(h.calls.length,0);assert.equal(h.attached.length,0);
});

test('reloading a branch uses its own identity even when snapshot key is stale', () => {
  const frame = { addEventListener() {} };
  const context = vm.createContext({URLSearchParams, S:{}, AS_UID:null, Q:new URLSearchParams()});
  vm.runInContext(source.slice(source.indexOf('function stFrame('), source.indexOf('function stHold(')), context);
  const n = {key:'chat:source', branchKey:'chat:fork'};
  context.stFrame(n, {querySelector:()=>frame});
  assert.equal(new URLSearchParams(frame.src.slice(2)).get('c'), 'chat:fork');
  assert.equal(n.key, 'chat:fork');
});

test('context reset in a stage page also opens an independent branch window', async () => {
  const chats = fs.readFileSync(new URL('../src/pga/web/app-chats.js', import.meta.url), 'utf8');
  const calls = [];
  const context = vm.createContext({S:{chat:'chat:source'}, stageBranch:(...args)=>{calls.push(args);return true;}});
  vm.runInContext(chats.slice(chats.indexOf('async function chatBranch(')), context);
  await context.chatBranch('reply-1', 'chat:source', false);
  assert.deepEqual(calls, [['chat:source','reply-1']]);
});

test('legacy duplicate window recovers its saved branch ID by title', async () => {
  const parent = {id:'parent',type:'win',key:'chat:source'};
  const child = {id:'child',type:'win',key:'chat:source',par:'parent',title:'分支 A',el:{}};
  const frames = [];
  const context = vm.createContext({ST:{nodes:[parent,child]}, S:{chats:[{key:'chat:fork',title:'分支 A'}]},
    stWins:()=>[parent,child],stFrame:n=>frames.push(n.key),stSave(){}});
  vm.runInContext(source.slice(source.indexOf('async function stRepairBranchKeys('),source.indexOf('setInterval(() => {                               // a new conversation')),context);
  await context.stRepairBranchKeys();
  assert.equal(parent.key, 'chat:source');
  assert.equal(child.key, 'chat:fork');
  assert.equal(child.branchKey, 'chat:fork');
  assert.deepEqual(frames, ['chat:fork']);
});

function dockHarness() {
  const parent = {id:'p',type:'win',key:'chat:p',kids:['a','b'],sel:'a'};
  const a = {id:'a',type:'win',key:'chat:a',branchKey:'chat:a',par:'p',kids:['c'],sel:'c',el:{}};
  const b = {id:'b',type:'win',key:'chat:b',par:'p'};
  const c = {id:'c',type:'win',key:'chat:c',par:'a'};
  const state = {nodes:[parent,a,b,c],focus:'c'}, scroll = [];
  const context = vm.createContext({ST:state,stKidKeep:(n,fold)=>scroll.push([n.id,fold]),stRender(){},stSave(){},stShow(){},stMap(){},stListItems(){},requestAnimationFrame:f=>f(),document:{querySelectorAll:()=>[]}});
  vm.runInContext(source.slice(source.indexOf('const stKids ='),source.indexOf('async function branchBackendReady')),context);
  vm.runInContext(source.slice(source.indexOf('function stDockBranch('),source.indexOf('function stBranchDockLook(')),context);
  vm.runInContext(source.slice(source.indexOf('function stFocus('),source.indexOf('function stMiniLook(')),context);
  context.stKids = vm.runInContext('stKids',context);
  return {context,state,parent,a,b,c,scroll};
}
test('minimize hides only the chosen branch, retains its identity/frame, and focuses parent',()=>{
  const h=dockHarness(), frame=h.a.el;
  h.context.stDockBranch(h.a);
  assert.equal(h.state.focus,'p');
  assert.deepEqual(Array.from(h.context.stKids(h.parent),n=>n.id),['b']);
  assert.equal(h.parent.sel,'b');
  assert.equal(h.a.el,frame); assert.equal(h.a.key,'chat:a'); assert.equal(h.a.branchKey,'chat:a');
  assert.equal(h.state.nodes.length,4); assert.equal(h.c.par,'a');
  h.context.stDockBranch(h.b);
  assert.equal(h.context.stKids(h.parent).length,0);
  h.context.stFocus('a',true);
  assert.equal(h.a.branchDocked,undefined); assert.equal(h.b.branchDocked,true);
  assert.equal(h.parent.sel,'a'); assert.equal(h.state.focus,'a');
});
test('opening a nested branch reveals every ancestor without reopening its siblings',()=>{
  const h=dockHarness();
  h.a.branchDocked=true; h.b.branchDocked=true; h.c.branchDocked=true;
  h.parent.kidsCollapsed=true; h.a.kidsCollapsed=true;
  h.context.stFocus('c',true);
  assert.equal(h.a.branchDocked,undefined); assert.equal(h.c.branchDocked,undefined);
  assert.equal(h.b.branchDocked,true);
  assert.equal(h.parent.kidsCollapsed,undefined); assert.equal(h.a.kidsCollapsed,undefined);
  assert.equal(h.parent.sel,'a'); assert.equal(h.a.sel,'c'); assert.equal(h.state.focus,'c');
});

function toggleHarness() {
  const h = dockHarness();
  h.context.window = {};
  h.context.stId = () => 'new-child';
  h.context.stTitle = k => k;
  h.state.pos = new Map([['p',{}],['a',{kid:true}],['b',{kid:true}]]);
  h.context.stAttach = (p, made) => {h.state.nodes.push(...made); p.kids.push(...made.map(n=>n.id)); for(const n of made) h.state.pos.set(n.id,{kid:true});};
  vm.runInContext(source.slice(source.indexOf('function stToggleChatBranch('),source.indexOf('function stAttach(')),h.context);
  return h;
}
test('branch tick toggles independently while another sibling stays open', () => {
  const h = toggleHarness();
  h.context.stToggleChatBranch(h.parent,'chat:a');
  assert.equal(h.a.branchDocked,true);
  assert.deepEqual(Array.from(h.context.stKids(h.parent),n=>n.id),['b']);
  h.context.stToggleChatBranch(h.parent,'chat:a');
  assert.equal(h.a.branchDocked,undefined);
  assert.deepEqual(Array.from(h.context.stKids(h.parent),n=>n.id),['a','b']);
  h.context.stToggleChatBranch(h.parent,'chat:b');
  assert.equal(h.b.branchDocked,true);
  assert.equal(h.a.branchDocked,undefined);
});
test('history branch absent from canvas is attached to its source for stack layout and wiring', () => {
  const h = toggleHarness();
  h.context.stToggleChatBranch(h.parent,'chat:historical',{upto:'turn-2',title:'Historical'});
  const child = h.state.nodes.find(n=>n.key==='chat:historical');
  assert.equal(child.par,'p');
  assert.equal(child.branchKey,'chat:historical');
  assert.equal(child.branchPoint,'turn-2');
  assert.ok(h.parent.kids.includes(child.id));
  assert.equal(h.context.stKids(h.parent).length,3);
  h.context.stToggleChatBranch(h.parent,child.key);
  assert.equal(child.branchDocked,true);
  assert.equal(h.state.nodes.filter(n=>n.key===child.key).length,1);
});
test('legacy standalone branch is reattached without replacing its frame', () => {
  const h=toggleHarness(), frame={};
  const old={id:'old',type:'win',key:'chat:old',el:frame};h.state.nodes.push(old);
  h.context.stToggleChatBranch(h.parent,old.key,{upto:'turn-1'});
  assert.equal(old.par,'p');assert.equal(old.el,frame);
  assert.ok(h.parent.kids.includes('old'));
  assert.equal(h.state.nodes.filter(n=>n.key===old.key).length,1);
});
