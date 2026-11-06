import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/pga/web/app-memo.js', import.meta.url), 'utf8');
function setup() {
  const events = {}, storage = new Map(), notices = [];
  const document = {documentElement: {classList: {contains: () => true}}, activeElement: null,
    addEventListener: (name, fn) => (events[name] ||= []).push(fn), querySelector: () => null};
  const window = {addEventListener(){}, parent: {stTitle: () => '源对话', toast: x => notices.push(x)}, crypto: {randomUUID: () => 'test-clip'}};
  const S = {uid: 'u', chat: 'source', chatTurns: {source: [{role:'user',text:'第一问'},{role:'agent',text:'第一答'}]}};
  const c = vm.createContext({document, window, S, localStorage: {getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
    getSelection:()=>({toString:()=>''}), L:x=>x, toast:x=>notices.push(x), Event:class {}, api:async()=>({id:'a'.repeat(32),title:'源对话',mode:'full'})});
  vm.runInContext(source, c);
  return {c, events, S, document, notices};
}
function clipboard() { const data = new Map();return {files:[],getData:k=>data.get(k)||'',setData:(k,v)=>data.set(k,v)}; }
function box() {return {id:'chatText',value:'我的问题',selectionStart:4,selectionEnd:4,isConnected:true,
  setRangeText(t,a,b){this.value=this.value.slice(0,a)+t+this.value.slice(b)},dispatchEvent(){}};}
test('copy captures visible snapshot, text-only fallback survives original changes, paste stays in draft',async()=>{
  const {c,events,S}=setup(), dt=clipboard();
  events.copy[0]({clipboardData:dt,preventDefault(){}});
  S.chatTurns.source[1].text='未来的内容';
  const parsed=c.memoRefs({getData:k=>k==='text/plain'?dt.getData(k):''});
  assert.equal(parsed[0].turns[1].text,'第一答');
  S.chat='destination';const target=box();let sent;
  c.api=async(url,opts)=>{sent=opts.body;return {id:'a'.repeat(32),title:'源对话',mode:'knowledge'}};
  await events.paste[0]({target,clipboardData:dt,preventDefault(){}});
  assert.equal(sent.turns[1].text,'第一答');assert.match(target.value,/知识库 \+ 最近 3 轮/);assert.match(target.value,/我的问题/);
});
test('normal text selection and editable copy are not intercepted',()=>{
  const {c,events,document}=setup();let prevented=false;
  c.getSelection=()=>({toString:()=> 'selected'});
  events.copy[0]({clipboardData:clipboard(),preventDefault(){prevented=true}});assert.equal(prevented,false);
  c.getSelection=()=>({toString:()=> ''});document.activeElement={tagName:'TEXTAREA'};
  events.copy[0]({clipboardData:clipboard(),preventDefault(){prevented=true}});assert.equal(prevented,false);
});
test('navigation during upload never inserts into another chat',async()=>{
  const {c,events,S}=setup(),dt=clipboard();events.copy[0]({clipboardData:dt,preventDefault(){}});
  const target=box();c.api=async()=>{S.chat='other';return {id:'a'.repeat(32),title:'source',mode:'full'}};
  await events.paste[0]({target,clipboardData:dt,preventDefault(){}});assert.equal(target.value,'我的问题');
});
test('ordinary text paste is untouched and malformed URL does not throw',async()=>{
  const {c,events}=setup(),dt=clipboard();dt.setData('text/plain','plain words');let prevented=false;
  await events.paste[0]({target:box(),clipboardData:dt,preventDefault(){prevented=true}});assert.equal(prevented,false);
  dt.setData('text/plain','pga://conv/%BAD');assert.equal(c.memoRefs(dt).length,0);
});
