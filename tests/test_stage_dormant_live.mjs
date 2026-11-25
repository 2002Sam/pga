import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync('src/pga/web/app-live.js','utf8');
const frameCode=source.slice(source.indexOf('function livePaintFrame('),source.indexOf('function composerBusy('));
const startCode=source.slice(source.indexOf('function startLive('),source.indexOf('function stopLive('));
const turn=(revision,finished)=>({id:'run-1',revision,started:Date.now()/1000,finished:finished?Date.now()/1000:null,
  running:!finished,ok:finished?true:null,text:`answer ${revision}`,steps:[],tags:{conversation:'u:chat:test'}});
async function flush(){for(let i=0;i<8;i++)await Promise.resolve();}
function setup(){
 const rows=[turn(1)],timers=[],frames=[],painted=[];
 const box={id:'workCard',querySelector:()=>null,querySelectorAll:()=>[]};
 const document={hidden:false,addEventListener(){},getElementById:id=>id==='workCard'?box:null};
 const S={uid:'u',chat:'chat:test',stageDormant:true,chatTurns:{'chat:test':[{role:'user',text:'question'}]}};
 const c=vm.createContext({S,document,window:{},Date,URLSearchParams,encodeURIComponent,
   liveSnap:async()=>rows,followupKey:()=>S.chat,steeringQuestion:()=>null,attachSteering:()=>false,
   liveContentVersion:r=>`${r.id}:${r.revision}`,paintLiveCard:(state,_id,node)=>{painted.push(state.run.revision);state.box=node;return true;},
   requestAnimationFrame:fn=>(frames.push(fn),frames.length),setInterval:fn=>(timers.push(fn),timers.length),clearInterval(){},
   liveSecs:()=> '1.0',renderChat(){throw Error('unexpected chat render while not steering');}});
 c.stopLive=()=>{c.S.live=null;};
 vm.runInContext(frameCode,c);vm.runInContext(startCode,c);
 return {c,S,rows,timers,frames,painted};
}

test('live records and watcher advance while dormant/moving; next idle tick paints only the latest revision',async()=>{
 const h=setup();h.c.startLive('chat:test');await flush();
 assert.equal(h.S.live.run.revision,1);assert.deepEqual(h.painted,[]);assert.equal(h.frames.length,0);

 h.S.stageDormant=false;h.S.stageMotion=true;h.rows[0]=turn(2);await h.timers[0]();await flush();
 assert.equal(h.S.live.run.revision,2);assert.deepEqual(h.painted,[]);assert.equal(h.frames.length,0);

 h.S.stageMotion=false;h.rows[0]=turn(3);const resumed=h.timers[0]();await flush();
 assert.deepEqual(h.painted,[]);assert.equal(h.frames.length,1);
 h.frames.shift()();await resumed;
 assert.deepEqual(h.painted,[3]);assert.equal(h.S.live.run.revision,3);
 h.c.stopLive();
});

test('hiding the browser tab skips live paints and restoring it paints the latest answer',async()=>{
 const h=setup();h.S.stageDormant=false;h.c.document.hidden=true;
 h.c.startLive('chat:test');await flush();
 assert.equal(h.S.live.run.revision,1);assert.equal(h.frames.length,0);assert.equal(h.painted.length,0);
 h.rows[0]=turn(2);h.c.document.hidden=false;
 const poll=h.timers[0]();await flush();h.frames.shift()();await poll;
 assert.deepEqual(h.painted,[2]);
});
