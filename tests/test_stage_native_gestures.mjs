import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('src/pga/web/app-stage-native.js','utf8');
function setup(){
 const events=[],handlers={},docHandlers={},ST={nodes:[]};
 const dispatchEvent=e=>{
  events.push(e);
  const key=e.button===2?'rightPan':'middlePan';
  if(e.type==='pointerdown')ST[key]={id:e.pointerId};
  if(e.type==='pointerup'||e.type==='pointercancel')ST[key]=null;
 };
 const target={isConnected:true,dispatchEvent},node={id:'web',el:target};ST.nodes=[node];
 const ctx={ST,S:{view:'stage',uid:'demo'},PointerEvent:class{constructor(type,init){this.type=type;Object.assign(this,init);}},
  document:{documentElement:{dispatchEvent},addEventListener:(key,fn)=>docHandlers[key]=fn},
  addEventListener:(key,fn)=>handlers[key]=fn,readingNativeStageTarget:id=>id==='reader:web'?target:null};
 ctx.window=ctx;vm.runInNewContext(source,ctx);
 const send=(phase,extra={})=>ctx.stNativePointer({id:'reader:web',sequence:1,gesture:'right',phase,clientX:500,clientY:200,ctrlKey:false,...extra});
 return{ctx,ST,target,node,events,handlers,docHandlers,send};
}
test('native gesture targets its registered page and carries host coordinates to the shared handlers',()=>{
 const h=setup();h.ST.focus='another';assert.equal(h.send('down'),true);
 const down=h.events[0];assert.equal(down.type,'pointerdown');assert.equal(down.button,2);assert.equal(down.buttons,2);
 assert.equal(down.clientX,500);assert.equal(down.screenX,500);assert.equal(down.screenY,200);
 h.send('move',{clientX:450});h.send('up',{clientX:440});
 assert.deepEqual(h.events.map(e=>e.type),['pointerdown','pointermove','pointerup']);assert.equal(h.events[2].buttons,0);
 assert.equal(h.ST.rightPan,null);
});
test('invalid/unregistered starts never enter canvas handlers',()=>{
 for(const extra of [{id:'foreign'},{clientX:NaN},{sequence:-1},{gesture:'left'},{metaKey:true}]){
  const h=setup();assert.equal(h.send('down',extra),false);assert.equal(h.events.length,0);
 }
 const h=setup();h.ctx.S.view='chats';assert.equal(h.send('down'),false);assert.equal(h.events.length,0);
});
test('stale native moves and releases cannot terminate a newer gesture',()=>{
 const h=setup();h.send('down');h.send('down',{sequence:2,gesture:'middle',ctrlKey:false});
 assert.equal(h.events[1].type,'pointercancel');assert(h.ST.middlePan);
 const count=h.events.length;
 for(const phase of ['move','up','cancel'])assert.equal(h.send(phase),false);
 assert.equal(h.events.length,count);assert(h.ST.middlePan);
 assert.equal(h.send('up',{sequence:2,gesture:'middle',ctrlKey:false}),true);assert.equal(h.ST.middlePan,null);
});
test('closing the owning page, switching accounts/views or losing focus cancels safely',()=>{
 for(const change of ['close','detach','account','view','blur','hide']){
  const h=setup();h.send('down');
  if(change==='close')h.ST.nodes=[];
  if(change==='detach')h.target.isConnected=false;
  if(change==='account')h.ctx.S.uid='other';
  if(change==='view')h.ctx.S.view='chats';
  if(change==='blur')h.handlers.blur();
  else if(change==='hide'){h.ctx.document.hidden=true;h.docHandlers.visibilitychange();}
  else assert.equal(h.send('move'),false);
  assert.equal(h.events.at(-1).type,'pointercancel',change);assert.equal(h.ST.rightPan,null,change);
  assert.equal(h.send('up'),false);
 }
});
