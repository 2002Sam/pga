import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function harness() {
  const heading = {textContent:'最初的问题'}, draft = {value:'输入中的草稿', selectionStart:3};
  const timers = new Map(); let id = 0, redraws = 0, timeline = 0;
  const S = {uid:'user',view:'chats',chat:'chat:one',allChats:[{key:'chat:one',title:'最初的问题'}],
    chatTurns:{'chat:one':[{text:'保留回答'}]}, scrollChat:false};
  const c = vm.createContext({S, EMBED:true, L:x=>x, document:{}, window:{addEventListener(){}},
    $:s=>s==='#chead h1'?heading:null,
    setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:i=>timers.delete(i),
    api:async()=>[{key:'chat:one',title:'整体主题与当前进展',title_pending:true}],
    loadTimeline:async()=>{timeline++;},renderChat:()=>{redraws++;}, renderChatList:()=>{},
    draft});
  vm.runInContext(readFileSync(new URL('../src/pga/web/app-rail.js',import.meta.url),'utf8'),c);
  c.renderRail=()=>{};
  return {c,heading,draft,timers,redraws:()=>redraws,timeline:()=>timeline};
}

test('title arrives without repainting transcript, moving scroll, or disturbing draft',async()=>{
  const h=harness(), turns=h.c.S.chatTurns;
  await h.c.loadChats();
  assert.equal(h.heading.textContent,'整体主题与当前进展');
  assert.equal(h.draft.value,'输入中的草稿');assert.equal(h.draft.selectionStart,3);
  assert.equal(h.c.S.chatTurns,turns);assert.equal(h.c.S.scrollChat,false);
  assert.equal(h.redraws(),0);assert.equal(h.timeline(),1);assert.equal(h.timers.size,1);
  h.c.api=async()=>[{key:'chat:one',title:'整体主题与当前进展',title_pending:false}];
  await [...h.timers.values()][0]();
  assert.equal(h.timers.size,0);assert.equal(h.timeline(),1);
});

test('background titles do not replace imported or line-view headings',async()=>{
  const h=harness();h.c.S.lineView='line';await h.c.loadChats();
  assert.equal(h.heading.textContent,'最初的问题');
});
