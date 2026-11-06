import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const more=fs.readFileSync('src/pga/web/app-more.js','utf8');
const chats=fs.readFileSync('src/pga/web/app-chats.js','utf8');
function harness(api) {
 const sent=[],errors=[];
 const S={uid:'u',chat:'chat:a',chatAgent:'codex',agents:[{name:'claude'},{name:'codex'}],chatTurns:{'chat:a':[{run:'r',agent:'claude'}]}};
 const c=vm.createContext({S,api,composerBusy:()=>false,renderChat(){},loadChat:async()=>{},splitSend:async text=>sent.push(text),toast:s=>errors.push(s),L:s=>s});
 vm.runInContext(more.slice(more.indexOf('async function startSplit('),more.indexOf('function splitHtml(')),c);
 vm.runInContext(chats.slice(chats.indexOf('async function secondOpinion('),chats.indexOf('function secondPairHtml(')),c);
 return {c,S,sent,errors};
}
test('second opinion directly starts a split and generates in the same window without DOM dialogs',async()=>{
 const calls=[];const h=harness(async(url,opts)=>{calls.push({url,body:opts.body});return {question:'question',lanes:[]};});
 await h.c.secondOpinion('r','chat:a');
 assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)),{key:'chat:a',agents:['codex','claude'],run:'r'});
 assert.deepEqual(h.sent,['question']);assert.equal(h.S.chat,'chat:a');assert.equal(h.S.splitStarting,false);
});
test('repeated clicks during setup and after split creation do not create duplicate tasks',async()=>{
 let done,n=0;const h=harness(()=>{n++;return new Promise(r=>done=r);});
 const pending=h.c.secondOpinion('r','chat:a');await h.c.secondOpinion('r','chat:a');assert.equal(n,1);
 done({question:'q',lanes:[]});await pending;await h.c.secondOpinion('r','chat:a');assert.equal(n,1);
});
test('failure reports error and allows retry without losing the conversation',async()=>{
 const h=harness(async()=>{throw Error('unavailable');});await h.c.secondOpinion('r','chat:a');
 assert.deepEqual(h.errors,['unavailable']);assert.equal(h.S.splitStarting,false);assert.equal(h.S.chat,'chat:a');assert.equal(h.S.chatSplits,undefined);
});
test('switching windows during creation never sends into the newly selected conversation',async()=>{
 let done;const h=harness(()=>new Promise(r=>done=r));const pending=h.c.secondOpinion('r','chat:a');h.S.chat='chat:b';done({question:'q',lanes:[]});await pending;
 assert.deepEqual(h.sent,[]);assert.ok(h.S.chatSplits['chat:a']);assert.equal(h.S.chat,'chat:b');
});
test('requires two different agents',async()=>{
 const h=harness(async()=>{throw Error('must not call');});h.S.agents=[{name:'codex'},{name:'codex'}];await h.c.secondOpinion('r','chat:a');assert.equal(h.errors.length,1);assert.equal(h.S.splitStarting,undefined);
});
