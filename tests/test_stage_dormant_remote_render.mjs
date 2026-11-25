import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync('src/pga/web/app-live.js','utf8');
const helpers=source.slice(source.indexOf('function stageFrameVisible()'),source.indexOf('async function chatSend('));
const poll=source.slice(source.indexOf('setInterval(async () => {\n  if (S.stageChatRenderPending'),source.indexOf('\n}, 1500);',source.indexOf('setInterval(async () => {\n  if (S.stageChatRenderPending')))+'\n}, 1500);';
test('remote run polling continues while moving and defers only the render until activation',async()=>{
  const events=[]; const S={uid:'u',view:'chats',chat:'chat:x',chatTurns:{},stageDormant:true};
  const run={id:'r1',started:Date.now()/1000,finished:null,tags:{conversation:'u:chat:x'}};
  const c=vm.createContext({S,window:{},document:{hidden:false},Date,URLSearchParams,encodeURIComponent,
    liveSnap:async()=>[run],pgStageIdleForPaint:async()=>{},startLive:()=>events.push('watch-started'),
    renderChat:()=>events.push('paint'),setInterval(fn){c.poll=fn;},clearInterval(){},
    paintInlineUsage(){},console});
  vm.runInContext(helpers,c);vm.runInContext(poll,c);
  await c.poll(); await Promise.resolve();
  assert.equal(S.remoteRun,'chat:x'); assert.equal(S.sending,true);
  assert.deepEqual(events,['watch-started']);
  S.stageDormant=false; c.window.pgaStageActivated();
  for(let i=0;i<4;i++)await Promise.resolve();
  assert.deepEqual(events,['watch-started','paint']);
});
