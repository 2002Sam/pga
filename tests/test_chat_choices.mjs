import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const core = fs.readFileSync('src/pga/web/app-core.js', 'utf8');
const code = core.slice(core.indexOf('const conversationDefaultAgent'), core.indexOf('window.S = S;'));
function setup(values = new Map()) {
  const S = {uid:'user',chat:'a',chatAgent:'auto',chatModel:{},chatEffort:{}};
  const c = vm.createContext({S,store:{get:k=>values.get(k),set:(k,v)=>values.set(k,v)}});
  vm.runInContext(code,c);
  return {S,c,values,run:s=>vm.runInContext(s,c)};
}
test('explicit choices survive refresh without changing another window defaults',()=>{
  const a=setup();a.S.chatAgent='codex';a.S.chatModel.a='model';a.S.chatEffort.a='high';a.run('chatChoiceSave()');
  const b=setup(a.values);b.S.chat='b';b.run('chatChoiceRestore()');assert.equal(b.S.chatAgent,'auto');
  const reopened=setup(a.values);reopened.run('chatChoiceRestore()');assert.equal(reopened.S.chatAgent,'codex');assert.equal(reopened.S.chatEffort.a,'high');
  assert.equal(a.values.has('pga_chat_agent'),false);
});
test('switching conversations restores their own agent model and effort',()=>{
 const h=setup();h.S.chatAgent='codex';h.S.chatModel.a='m1';h.S.chatEffort.a='high';h.run('chatChoiceSave();chatChoiceRestore()');
 h.S.chat='b';h.run('chatChoiceRestore()');assert.equal(h.S.chatAgent,'auto');
 h.S.chatAgent='claude';h.S.chatModel.b='m2';h.S.chatEffort.b='medium';h.run('chatChoiceSave()');
 h.S.chat='a';h.run('chatChoiceRestore()');assert.equal(h.S.chatAgent,'codex');assert.equal(h.S.chatModel.a,'m1');assert.equal(h.S.chatEffort.a,'high');
});
test('explicit choices win over stale branch options; unedited branches inherit options',()=>{
 const h=setup();h.S.chatAgent='claude';h.S.chatEffort.a='high';h.run('chatChoiceSave()');
 h.S.chatLoadedChoices={a:{agent:'codex',model:'old',effort:'low'},b:{agent:'codex',model:'branch',effort:'medium'}};
 h.run('chatChoiceRestore()');assert.equal(h.S.chatAgent,'claude');assert.equal(h.S.chatEffort.a,'high');
 h.S.chat='b';h.run('chatChoiceRestore()');assert.equal(h.S.chatModel.b,'branch');
});
test('saved choices are scoped by user and malformed storage is ignored',()=>{
 const h=setup();h.S.chatAgent='codex';h.run('chatChoiceSave()');h.S.uid='other';h.S.chatChoiceActive=null;h.S.chatChoices={};h.run('chatChoiceRestore()');assert.equal(h.S.chatAgent,'auto');
 h.values.set('pga_chat_choice:other:a','{');assert.equal(h.run('chatChoiceRead("a")'),null);
});
