import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
function nav(x,sl=0,last=null){
 const moves=[],a={clientWidth:1000,scrollLeft:sl,scrollWidth:20000,scrollTo:v=>moves.push(v)};
 const ctx={ST:{nodes:[{id:'target'}],pos:new Map([['target',{x,w:800}]]),showAt:last},ST_PADX:0,$:()=>a,stGrow(){},performance:{now:()=>1000},window:{matchMedia:()=>({matches:false})}};
 vm.runInNewContext(source.slice(source.indexOf('function stShow('),source.indexOf('function stFocus(')),ctx);ctx.stShow('target');return moves;
}
test('first to last skips long smooth animation',()=>assert.equal(nav(15000)[0].behavior,'instant'));
test('last to first skips long smooth animation',()=>assert.equal(nav(0,15000)[0].behavior,'instant'));
test('nearby navigation remains smooth; rapid repeat is instant',()=>{assert.equal(nav(500)[0].behavior,'smooth');assert.equal(nav(500,0,950)[0].behavior,'instant');});
test('fully visible conversation does not move',()=>assert.equal(nav(50).length,0));
test('many scroll events schedule one map and wire redraw per frame',()=>{
 let frames=[],map=0,wire=0;const ctx={S:{view:'stage'},requestAnimationFrame:f=>{frames.push(f);return frames.length;},stMapView:()=>map++,stOver:()=>wire++,document:{addEventListener(){}}};
 const start=source.indexOf('let stScrollFrame =');vm.runInNewContext(source.slice(start,source.indexOf('window.addEventListener("resize"',start)),ctx);
 for(let i=0;i<100;i++)ctx.stScheduleScroll();assert.equal(frames.length,1);frames[0]();assert.equal(map,1);assert.equal(wire,1);ctx.stScheduleScroll();assert.equal(frames.length,2);
});
