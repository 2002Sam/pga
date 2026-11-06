import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function harness() {
  const box={value:'请总结实验结论'}, calls=[], storage=new Map(); let taken=0;
  const c=vm.createContext({S:{uid:'u',chat:'chat:a',chatTurns:{},chatRefs:[],sentHist:[],agents:[]},
    window:{history:{replaceState(){}}},document:{addEventListener(){},querySelectorAll:()=>[]},
    localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
    $:s=>s==='#chatText'?box:null,L:x=>x,esc:String,md:String,toast(){},qs:()=>'',
    takeAtts:()=>{taken++;return {images:[],files:[]};},renderChat(){},rerenderComposer(){},
    // App background polling must not keep this isolated test process alive.
    loadChats:async()=>{},loadChat:async()=>{},loadTimeline(){},
    setInterval:(fn,ms)=>{const t=setInterval(fn,ms);t.unref();return t;},clearInterval,setTimeout,clearTimeout,
    api:async(url,opt)=>{calls.push([url,opt]);if(url==='/v1/version')return {knowledge_capture:true};if(url.endsWith('/knowledge-notes'))return {id:'note1',conversation:'chat:a'};return {};}});
  for(const file of ['app-live.js','app-knowledge.js'])vm.runInContext(readFileSync(new URL('../src/pga/web/'+file,import.meta.url),'utf8'),c);
  c.startLive=()=>{};c.stopLive=()=>{};c.loadChat=async()=>{};
  c.knowledgeHost=()=>({knowledgeShow:(item,key)=>calls.push(['opened',item.id,key]),knowledgeRefresh:id=>calls.push(['refresh',id])});
  return {c,box,calls,taken:()=>taken};
}

test('selected capture opens its document before asking, sends its id, and stays selected',async()=>{
  const h=harness();h.c.knowledgeSet(true);await h.c.chatSend();
  const open=h.calls.findIndex(x=>x[0]==='opened'),ask=h.calls.findIndex(x=>x[0].endsWith('/agents/ask'));
  assert.ok(open>=0 && open<ask);assert.equal(h.calls[ask][1].body.knowledge_id,'note1');
  assert.equal(h.calls[ask][1].body.text,'请总结实验结论');assert.equal(h.c.knowledgeEnabled(),true);
  assert.equal(h.taken(),1);assert.ok(h.calls.some(x=>x[0]==='refresh'));
  h.c.S.chat='chat:b';assert.equal(h.c.knowledgeEnabled(),false);
});

test('preparation failure keeps the draft and attachments, and never sends the question',async()=>{
  const h=harness();h.c.knowledgeSet(true);h.c.api=async()=>{throw Error('offline');};await h.c.chatSend();
  assert.equal(h.box.value,'请总结实验结论');assert.equal(h.taken(),0);assert.equal(h.c.S.knowledgePreparing,false);
});

test('ordinary messages do not create knowledge files',async()=>{
  const h=harness();await h.c.chatSend();assert.equal(h.calls.length,1);
  assert.ok(h.calls[0][0].endsWith('/agents/ask'));assert.equal(h.calls[0][1].body.knowledge_id,undefined);
});
