import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
function setup(){
 const handlers={},timers=new Map(),calls=[],n={id:'page'};let seq=0,selected='';
 const ctx={ST:{nodes:[n],focus:n.id},$:()=>null,setTimeout:f=>{timers.set(++seq,f);return seq;},clearTimeout:id=>timers.delete(id),stFocus(id){ctx.ST.focus=id;},stShiftStop(){},stEdgeWheel:{},stShow:(...args)=>calls.push(args)};
 vm.runInNewContext(src.slice(src.indexOf('function stPageClickBind('),src.indexOf('function stDragSoon(')),ctx);
 ctx.stPageClickBind({addEventListener:(k,f)=>handlers[k]=f},()=>n,()=>({toString:()=>selected}));
 const emit=(type,extra={})=>handlers[type]({detail:1,button:0,screenX:100,screenY:100,target:{closest:()=>null},...extra});
 const flush=()=>{for(const f of timers.values())f();timers.clear();};
 return {ctx,emit,flush,calls,select:s=>selected=s};
}
test('single click reveals the page without imposing a center position',()=>{
 const h=setup();h.emit('pointerdown');h.emit('click');assert.equal(h.calls.length,0);h.flush();assert.deepEqual(h.calls,[['page',true]]);
});
test('double click, drag, selection and controls never trigger page navigation',()=>{
 for(const kind of ['double','drag','selection','control','wheel','cancel','key']){
  const h=setup();h.emit('pointerdown');
  if(kind==='drag')h.emit('pointermove',{screenX:120});
  if(kind==='selection')h.select('selected text');
  h.emit('click',kind==='control'?{target:{closest:()=>({})}}:{});
  if(kind==='double'){h.emit('pointerdown');h.emit('click',{detail:2});}
  if(kind==='wheel')h.emit('wheel');
  if(kind==='cancel')h.emit('pointercancel');
  if(kind==='key')h.emit('keydown');
  h.flush();assert.equal(h.calls.length,0,kind);
 }
});
test('selection made or page removed while waiting cancels navigation',()=>{
 const h=setup();h.emit('click');h.select('word');h.flush();assert.equal(h.calls.length,0);
 h.select('');h.emit('click');h.ctx.ST.nodes=[];h.flush();assert.equal(h.calls.length,0);
});

test('one click on another page selects and reveals it before the double-click timer',()=>{
 const h=setup();h.ctx.ST.focus='other';h.emit('pointerdown');h.emit('click');
 assert.equal(h.ctx.ST.focus,'page');assert.deepEqual(h.calls,[['page',true]]);h.flush();assert.equal(h.calls.length,1);
});
