import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
function harness(){
 const handlers=new Map(),timers=new Map(),n={id:'n',key:'chat:n',bw:660},ST={nodes:[n]};let seq=0;
 const doc={addEventListener(k,f){handlers.set(k,[...(handlers.get(k)||[]),f]);},createElement:()=>({}),head:{appendChild(){}}};
 const cw={document:doc,getSelection:()=>({removeAllRanges(){},toString:()=>''})};
 const c=vm.createContext({ST,ST_PADX:12,ST_DBL_SKIP:'input',stWins:()=>ST.nodes,stArena:()=>({w:1600}),stRender(){},stSave(){},stMap(){},stShow(){},stFocus(){},stRightPanBind(){},stMiddlePanBind(){},
 setTimeout(fn){timers.set(++seq,fn);return seq;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(src.slice(src.indexOf('function stMax('),src.indexOf('async function stRepairBranchKeys')),c);
 vm.runInContext(src.slice(src.indexOf('function stHold('),src.indexOf('function stDragSoon(')),c);
 const dispatch=(type,extra={})=>{for(const fn of handlers.get(type)||[])fn({detail:2,target:{closest:()=>null},...extra});};
 const flush=()=>{const fns=[...timers.values()];timers.clear();for(const fn of fns)fn();};
 return {c,n,ST,cw,handlers,dispatch,flush,timers};
}
test('reused frame binds once and double click/Escape operate on the restored node',()=>{
 const h=harness();h.c.stHold({contentWindow:h.cw},h.n);h.c.stHold({contentWindow:h.cw},h.n);
 const restored={...h.n};h.ST.nodes=[restored];h.c.stHold({contentWindow:h.cw},restored);
 assert.equal(h.handlers.get('click').length,2);assert.equal(h.handlers.get('keydown').length,2);
 h.dispatch('click');h.flush();assert.equal(restored.bigWidth,800);assert.equal(h.n.big,undefined);
 h.dispatch('keydown',{key:'Escape'});assert.equal(restored.big,undefined);assert.equal(restored.bw,660);
});
test('maximize and double-click sizes restore the original saved geometry',()=>{
 const {c,n}=harness();c.stMax(n,true);assert.equal(n.bigWidth,1576);assert.equal(n.fullscreen,true);
 c.stMax(n,true,.5);assert.equal(n.bigWidth,800);assert.equal(n.fullscreen,false);
 c.stMax(n,false);assert.equal(n.big,undefined);assert.equal(n.bigWidth,undefined);assert.equal(n.bw,660);
});
test('pending double click follows a same-chat snapshot but ignores a removed or replaced conversation',()=>{
 const h=harness();h.c.stClickSize(h.n,{detail:2});const restored={...h.n};h.ST.nodes=[restored];h.flush();assert.equal(restored.bigWidth,800);
 h.c.stMax(restored,false);h.c.stClickSize(restored,{detail:2});h.ST.nodes=[{...restored,key:'chat:other'}];h.flush();assert.equal(h.ST.nodes[0].big,undefined);
 h.c.stClickSize(h.ST.nodes[0],{detail:2});h.ST.nodes=[];h.flush();assert.equal(h.timers.size,0);
});
test('Escape cancels pending enlargement; triple click replaces the double-click timer',()=>{
 const h=harness();h.c.stHold({contentWindow:h.cw},h.n);h.dispatch('click');h.dispatch('keydown',{key:'Escape'});h.flush();assert.equal(h.n.big,undefined);
 h.dispatch('click');h.dispatch('click',{detail:3});assert.equal(h.n.bigWidth,1440);h.flush();assert.equal(h.n.bigWidth,1440);
});
test('double click inside an input does not resize the window',()=>{
 const h=harness();h.c.stHold({contentWindow:h.cw},h.n);h.dispatch('click',{target:{closest:()=>({})}});h.flush();assert.equal(h.n.big,undefined);
});
