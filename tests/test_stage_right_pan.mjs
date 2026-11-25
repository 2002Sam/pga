import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
function harness(frame=null){
 const events=new Map(),winEvents=new Map(),classes=new Set(),frames=new Map();let sequence=0,selection='',focused=true;
 const root={classList:{add:(...xs)=>xs.forEach(x=>classes.add(x)),remove:(...xs)=>xs.forEach(x=>classes.delete(x))},setPointerCapture(){},releasePointerCapture(){}};
 const view={addEventListener:(k,f)=>winEvents.set(k,[...(winEvents.get(k)||[]),f]),getSelection:()=>({toString:()=>selection}),MouseEvent:class{constructor(type,init){this.type=type;Object.assign(this,init);}}};
 const doc={defaultView:view,documentElement:root,hasFocus:()=>focused,addEventListener(k,f){events.set(k,[...(events.get(k)||[]),f]);},querySelector:()=>null};
 const arena={scrollLeft:100,clientWidth:500,scrollWidth:1500},ST={nodes:[{id:'chat',type:'win',el:{hidden:false}}]};let saved=0,menus=0,replays=0;
 const ctx={ST,S:{view:'stage'},document:doc,window:{},Q:{get:()=>false},performance:{now:()=>100},clearTimeout(){},stEdgeWheel:{},stWins:()=>ST.nodes,stMiddleGrab:()=>{ST.drag={dock:{}};return true;},stDragSoon(){},stDragFlush(){},stDrop:()=>{ST.drag=null;ST.overview={};},stDockCancel:()=>{ST.overview=null;ST.drag=null;},stShiftStop(){},stPmUser(){},stMapView(){},stMap(){},stScheduleFrameLoads(){},stMenu(){menus++;},stSave(){saved++;},stScrollTo:x=>arena.scrollLeft=x,$:s=>s==='#starena'?arena:root,requestAnimationFrame:f=>{frames.set(++sequence,f);return sequence;},cancelAnimationFrame:id=>frames.delete(id)};
 vm.runInNewContext(src.slice(src.indexOf('function stPanStart('),src.indexOf('const ST_KEEP =')),ctx);
 ctx.stRightPanBind(doc,frame);ctx.stMiddlePanBind(doc,frame);
 const downBindings=events.get('pointerdown').length;
 ctx.stRightPanBind(doc,frame);ctx.stMiddlePanBind(doc,frame);
 assert.equal(events.get('pointerdown').length,downBindings);
 const target={isConnected:true,closest:()=>null,dispatchEvent(){replays++;return true;}};
 const emit=(type,extra={})=>{const e={target,pointerId:1,button:2,buttons:2,screenX:100,screenY:100,clientX:100,clientY:100,preventDefault(){this.defaultPrevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};for(const f of events.get(type)||[]){f(e);if(e.stopped)break;}return e;};
 const flush=()=>{for(const [id,f]of [...frames]){frames.delete(id);f();}};
 return {ctx,ST,arena,emit,flush,root,classes,winEvents,events,select:s=>selection=s,blur:()=>{focused=false;for(const f of winEvents.get('blur')||[])f();},counts:()=>({saved,menus,replays})};
}
test('right drag waits for horizontal threshold, accelerates and flushes final motion',()=>{
 const h=harness();
 h.emit('pointerdown');h.emit('pointermove',{screenX:96});assert(!h.ST.pan);
 h.emit('pointermove',{screenX:80});h.flush();assert.equal(h.arena.scrollLeft,132);
 h.emit('pointerup',{screenX:60,buttons:0});assert.equal(h.arena.scrollLeft,164);
 assert(!h.ST.pan&&!h.ST.rightPan&&!h.ST.overview);assert.equal(h.classes.size,0);assert.equal(h.counts().saved,1);
});
const middle=(h,type,extra={})=>h.emit(type,{button:1,buttons:4,...extra});
test('right pan clamps both edges without growing an empty canvas',()=>{
 const h=harness();h.emit('pointerdown');h.emit('pointermove',{screenX:-2000});h.flush();assert.equal(h.arena.scrollLeft,1000);h.emit('pointermove',{screenX:2000});h.flush();assert.equal(h.arena.scrollLeft,0);
});
test('middle press starts sorting; release latches the overview instead of panning',()=>{
 const h=harness();middle(h,'pointerdown');assert(h.ST.drag?.dock&&!h.ST.pan);
 middle(h,'pointermove',{screenX:300});assert.equal(h.arena.scrollLeft,100);
 middle(h,'pointerup',{buttons:0});assert(h.ST.overview&&!h.ST.drag&&!h.ST.middlePan);
 middle(h,'pointerdown');assert(!h.ST.overview);middle(h,'pointerup',{buttons:0});assert(!h.ST.overview);
});
test('a stationary right click can replay local actions but never opens the add-node menu',()=>{
 for(const drag of [false,true]){const h=harness();h.emit('pointerdown');assert(h.emit('contextmenu').defaultPrevented);assert.equal(h.counts().menus,0);
 if(drag)h.emit('pointermove',{screenX:50});h.emit('pointerup',{screenX:drag?50:100,buttons:0});assert.equal(h.counts().menus,0);assert.equal(h.counts().replays,drag?0:1);assert(h.emit('contextmenu').defaultPrevented);}
});
test('long holds suppress menus dispatched on either side of release and the next quick click still works',()=>{
 for(const beforeRelease of [false,true]){
  const h=harness();let now=100;h.ctx.performance.now=()=>now;
  const target={isConnected:true,closest:s=>s==='[data-railfork]'?{}:null,dispatchEvent:()=>assert.fail('holding a turn must not create a branch')};
  h.emit('pointerdown',{target});
  if(beforeRelease)assert(h.emit('contextmenu',{target}).defaultPrevented);
  now+=500;h.emit('pointerup',{target,buttons:0});
  assert(h.emit('contextmenu',{target}).defaultPrevented);
  assert(!h.emit('contextmenu',{target,button:0}).defaultPrevented,'keyboard context menu stays available');
  h.emit('pointerdown');h.emit('contextmenu');now+=40;h.emit('pointerup',{buttons:0});
  assert.equal(h.counts().replays,1);
 }
});
test('controls, selected text and active gestures retain right-click behavior',()=>{
 for(const mode of ['input','selection','overview','resize']){const h=harness();if(mode==='selection')h.select('copy me');if(mode==='overview')h.ST.overview={};if(mode==='resize')h.ST.rz={};
 const extra=mode==='input'?{target:{closest:s=>s.includes('input')?{}:null}}:{};assert(!h.emit('pointerdown',extra).stopped);assert.equal(!!h.ST.rightPan,['input','selection'].includes(mode));}
 const h=harness();assert(!middle(h,'pointerdown',{target:{closest:()=>({})}}).stopped);assert(!h.ST.middlePan);
});
test('Escape, cancellation, lost capture, missing button and window blur clean up middle drag',()=>{
 for(const mode of ['escape','cancel','capture','buttons','blur','pagehide']){const h=harness();middle(h,'pointerdown');middle(h,'pointermove',{screenX:80});
 if(mode==='escape')h.emit('keydown',{key:'Escape'});if(mode==='cancel')h.emit('pointercancel');if(mode==='capture')h.emit('lostpointercapture',{target:h.root});if(mode==='buttons')h.emit('pointermove',{buttons:0});if(mode==='blur')h.blur();if(mode==='pagehide')for(const f of h.winEvents.get('pagehide')||[])f();
 assert(!h.ST.pan&&!h.ST.middlePan&&!h.ST.overview,mode);assert.equal(h.classes.size,0,mode);assert.equal(h.counts().saved,0,mode);assert(!h.ST.drag,mode);}
});
test('an old iframe losing focus cannot cancel a gesture started in another document',()=>{
 for(const button of [1,2]){const h=harness();h.emit('pointerdown',{button,buttons:button===1?4:2});const state=button===1?h.ST.middlePan:h.ST.rightPan;state.doc={};h.blur();assert.equal(button===1?h.ST.middlePan:h.ST.rightPan,state);}
});
test('a right-wheel gesture ignores mouse jitter and does not replay its deferred menu',()=>{
 const h=harness();h.emit('pointerdown');h.emit('contextmenu');h.ST.rightPan.wheeled=true;
 assert(h.emit('pointermove',{screenX:70}).defaultPrevented);assert(!h.ST.pan);
 h.emit('pointerup',{screenX:70,buttons:0});assert(!h.ST.rightPan);assert.equal(h.counts().menus,0);
 assert(h.emit('contextmenu').defaultPrevented);
});
test('Monaco right-wheel is available during a stationary press and ordinary right-click replays its menu',()=>{
 for(const wheel of [false,true]){
  const h=harness();let menus=0;
  const target={isConnected:true,closest:s=>s==='.monaco-editor'?{}:null,dispatchEvent(){menus++;return false;}};
  h.emit('pointerdown',{target});assert(h.ST.rightPan);
  assert(!h.ST.pan);
  h.emit('contextmenu',{target});if(wheel)h.ST.rightPan.wheeled=true;
  h.emit('pointerup',{target,buttons:0});assert.equal(menus,wheel?0:1);
  assert.equal(h.counts().menus,0,'editor owns the menu instead of the canvas');
 }
});
test('Monaco menu callback takes priority over replaying a synthetic contextmenu',()=>{
 const h=harness();let actions=0;
 h.ctx.document.defaultView.fpStageContextMenu=()=>{actions++;return true;};
 const target={isConnected:true,closest:s=>s==='.monaco-editor'?{}:null,dispatchEvent:()=>assert.fail('menu action owns this click')};
 h.emit('pointerdown',{target});h.emit('contextmenu',{target});h.emit('pointerup',{target,buttons:0});
 assert.equal(actions,1);assert.equal(h.counts().menus,0);
});
test('nested file middle press picks its owner instead of the focused chat and accounts for inner offsets',()=>{
 const el={dataset:{nid:'file'},getBoundingClientRect:()=>({left:50})};
 const frame={closest:s=>s==='.stnode'?el:s==='.stfilewin'?{}:null,getBoundingClientRect:()=>({left:80})};
 const h=harness(frame),node={id:'file',type:'win',el};h.ST.nodes.push(node);h.ST.focus='chat';let picked;
 h.ctx.stMiddleGrab=(n,x,y,gx)=>{picked={n,gx};h.ST.drag={dock:{}};return true;};
 const target={closest:s=>s.split(', ').includes('.monaco-editor')?{}:null};
 middle(h,'pointerdown',{target,clientX:100});
 assert.equal(picked.n,node);assert.equal(picked.gx,130);assert.equal(h.ST.middlePan.node,node);
 middle(h,'pointerup',{buttons:0});assert(h.ST.overview);
});
test('plain right drag pans from file editors, controls and selected text',()=>{
 for(const kind of ['.monaco-editor','textarea','input','a','selection']){
  const h=harness(),target={closest:s=>s.split(', ').includes(kind)?{}:null};
  if(kind==='selection')h.select('selected text');
  h.emit('pointerdown',{target});h.emit('pointermove',{target,screenX:70});h.flush();
  assert.equal(h.arena.scrollLeft,148,kind);
  h.emit('pointerup',{target,screenX:70,buttons:0});assert(!h.ST.pan&&!h.ST.rightPan);
 }
});
test('a stationary Ctrl+right click still opens the file editor menu',()=>{
 const h=harness({closest:s=>s==='.stfilewin'?{}:null});let actions=0;
 h.ctx.document.defaultView.fpStageContextMenu=()=>{actions++;return true;};
 const target={isConnected:true,closest:s=>s==='.monaco-editor'?{}:null};
 h.emit('pointerdown',{target,ctrlKey:true});h.emit('contextmenu',{target});h.emit('pointerup',{target,buttons:0});
 assert.equal(actions,1);assert.equal(h.counts().menus,0);
});
test('manager right clicks never replay menus, including editable areas and release-time menus',()=>{
 const h=harness({closest:s=>s==='.st-manager-page'?{}:null});
 const target={isConnected:true,closest:s=>s.includes('input')?{}:null,dispatchEvent:()=>assert.fail('manager menu replay')};
 h.emit('pointerdown',{target});assert(h.ST.rightPan.dragOnly);
 assert(h.emit('contextmenu',{target}).defaultPrevented);
 h.emit('pointerup',{target,buttons:0});assert(h.emit('contextmenu',{target}).defaultPrevented);
 h.emit('pointerdown',{target});h.emit('pointermove',{target,screenX:75});h.flush();
 assert.equal(h.arena.scrollLeft,140);h.emit('pointerup',{target,screenX:75,buttons:0});
 assert.equal(h.counts().replays,0);
});
