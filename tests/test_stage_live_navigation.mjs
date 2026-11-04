import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
const start=source.indexOf('setInterval(() => {\n  let changed = false, sent = false;');
const code=source.slice(start,source.indexOf('/* ------------------------------------------------ the page */',start));
function harness(){
 const running={id:'running',run:true},other={id:'reading',run:false};let poll;
 const ctx={ST:{focus:'reading',draftSig:'\u0001'},S:{view:'stage'},document:{activeElement:{tagName:'IFRAME',closest:()=>({dataset:{nid:'running'}})}},stFocus:id=>{ctx.ST.focus=id;},stWins:()=>[running,other],stSeen:()=>false,stBusy:n=>n===running&&running.run,stDraft:()=>'',stSave(){},stRender(){},stMap(){},stListItems(){},stKidLook(){},stInputs(){},setTimeout(){},setInterval:fn=>{poll=fn;}};
 vm.runInNewContext(code,ctx);return {ctx,running,poll:()=>poll()};
}
test('live polling cannot restore stale iframe focus after map navigation',()=>{
 const h=harness();for(let i=0;i<5;i++)h.poll();assert.equal(h.ctx.ST.focus,'reading');assert.equal(h.running.run,true);
});
test('completion marks the background conversation unread without stealing navigation',()=>{
 const h=harness();h.ctx.stBusy=()=>false;h.poll();assert.equal(h.ctx.ST.focus,'reading');assert.equal(h.running.run,false);assert(h.running.done);
});
test('panning remains independent of the active iframe during output',()=>{
 const h=harness();h.ctx.ST.pan={x:100,sl:400};h.ctx.ST.focus='reading';h.poll();assert.equal(h.ctx.ST.focus,'reading');assert.deepEqual(h.ctx.ST.pan,{x:100,sl:400});
});
