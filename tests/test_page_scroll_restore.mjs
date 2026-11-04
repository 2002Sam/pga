import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/pga/web/app-pages.js',import.meta.url),'utf8');
function setup(){
 let now=0,count=0;const timers=[],events={};
 const box={clientHeight:200,scrollHeight:2000,scrollTop:0,getBoundingClientRect:()=>({top:0})};
 const doc={querySelector:s=>s==='#cdlg'?box:null,querySelectorAll:()=>Array.from({length:count},(_,i)=>({getBoundingClientRect:()=>({top:i*100-box.scrollTop})})),addEventListener:(e,f)=>events[e]=f};
 const old={id:'a'},current={id:'a'},p={msg:7,msgs:10,off:25,end:false};
 const ctx={window:{},ST:{nodes:[current]},PG:{pending:new Map([['a',p]])},pgWatchScroll(){},Date:{now:()=>now},setTimeout:f=>timers.push(f),Event:class{}};
 vm.runInNewContext(source.slice(source.indexOf('window.pgRestore ='),source.indexOf('/* ------------------------------------------------ add, switch')),ctx);
 ctx.window.pgRestore(old,{contentDocument:doc,contentWindow:{S:{},eval(){}}});
 return {ctx,box,current,old,p,events,setCount:n=>count=n,step(t){now=t;const work=timers.splice(0);work.forEach(f=>f());}};
}
test('restoration protects the current node, not the stale iframe closure',()=>{
 const x=setup();assert.equal(x.current._pgRestoring,true);assert.equal(x.old._pgRestoring,undefined);assert.equal(x.current.prog,x.p);
});
test('slow loading retains saved position until full history arrives',()=>{
 const x=setup();x.setCount(2);x.step(7000);assert.equal(x.box.scrollTop,0);assert.equal(x.current._pgRestoring,true);
 x.setCount(10);x.step(10000);assert.equal(x.box.scrollTop,725);assert.equal(x.current._pgRestoring,true);
 x.step(16500);assert.equal(x.current._pgRestoring,undefined);
});
test('user scrolling cancels delayed restoration',()=>{
 const x=setup();x.events.wheel();x.setCount(10);x.box.scrollTop=300;x.step(1000);assert.equal(x.box.scrollTop,300);assert.equal(x.current._pgRestoring,undefined);
});
test('missing local checkpoint restores the server snapshot including arena offset',()=>{
 const init=source.slice(source.indexOf('async function pgInit()'));
 assert.match(init,/if \(saved\) pgApply\(saved\);\s*else \{[\s\S]*?pgApply\(\(await api\(pgUrl\(PG.cur\)\)\)\.snap\)/);
});
