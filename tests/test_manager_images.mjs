import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-pmdoc.js',import.meta.url),'utf8');
function ctx(calls){
 const host={ST:{nodes:[{key:'chat:pm-a',id:'manager'}]},stOpen:(key)=>({key,id:key})};let n=0;
 const c={S:{uid:'u',chat:'chat:pm-a',chatTurns:{},dispatchLive:{},att:[]},PM:{name:'Test'},window:{},chatSend(){},document:{querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}},setInterval(){},setTimeout,clearTimeout,L:a=>a,loadChat:async()=>{},boardRefresh(){},dispatchWindowRefresh(){},pmHost:()=>host,toast(){},notice(){},rerenderComposer(){},
  api:async(url,options)=>{calls.push({url,body:options?.body});if(url.includes('/access?'))return {current:{access:'auto',folder:'',mcp:false}};if(url.endsWith('manager-plan'))return {tasks:[{title:'一',text:'一',agent:'claude'},{title:'二',text:'二',agent:'codex'}]};if(url.endsWith('/note'))return {run:'r'};if(url.endsWith('/conversation-projects'))return {key:'chat:new'+(++n)};return {ok:true,entry:{tasks:[{key:"chat:new",agent:"claude"}]}};}};
 c.window=c;vm.createContext(c);vm.runInContext(src,c);return c;
}
const img={name:'a.png',data:'data:image/png;base64,AA=='};
test('manager document: attached images are submitted to the server dispatcher',async()=>{
 const calls=[],c=ctx(calls);
 await c.pdSend('看图',{images:[img],files:[]});
 const submit=calls.find(x=>x.url.endsWith('/manager-submit'));
 assert.ok(submit);
 assert.deepEqual(JSON.parse(JSON.stringify(submit.body.images)),[img]);
 assert.equal(submit.body.create_conversations,undefined);
});
test('manager composer: attachments are sent instead of refused',async()=>{
 const calls=[],c=ctx(calls);
 c.takeAtts=()=>({images:[img],files:[]});
 c.document.querySelector=s=>s==='#chatText'?{value:'看图',closest:()=>null}:null;
 await c.chatSend();
 assert.equal(calls.find(x=>x.url.endsWith('/manager-submit')).body.images.length,1);
});

test('failed assignment retries in place with its original payload, once per click cycle', async () => {
 const c = ctx([]), bodies = [];
 let finish;
 c.api = async (_, {body}) => {
   bodies.push(body);
   if (bodies.length < 3) throw Error('Internal Server Error');
   return new Promise(resolve => { finish = resolve; });
 };
 vm.runInContext('pdEffortChoices.set(pdKey(), 8)', c);
 await c.pdSend('看图', {images:[img], files:[]});
 const pending = vm.runInContext('PD.pending', c);
 const id = pending[0].id;
 assert.equal(pending[0].error, 'Internal Server Error');
 await c.pdRetry(id);
 assert.equal(pending.length, 1);
 assert.ok(pending[0].error);
 const retry = c.pdRetry(id);
 c.pdRetry(id);
 assert.equal(bodies.length, 3);
 assert.equal(pending[0].error, undefined);
 assert.deepEqual(bodies[2], bodies[0]);
 assert.equal(bodies[2].effort, 'ultra');
 c.loadChat = async () => { throw Error('refresh failed'); };
 finish({entry:{tasks:[]}});
 await retry;
 c.pdRetry(id);
 assert.equal(vm.runInContext('PD.pending.length', c), 0);
 assert.equal(bodies.length, 3);
});
