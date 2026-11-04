import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
function setup(left){
 let now=1000;const a={scrollLeft:left,scrollWidth:11000,clientWidth:1000,scrollTo(v){assert.equal(v.behavior,'instant');this.scrollLeft=v.left;}};
 const c={ST:{},S:{view:'stage'},$:()=>a,performance:{now:()=>now},stScheduleScroll(){}};vm.createContext(c);vm.runInContext(src.slice(src.indexOf('function stEdgeWheel('),src.indexOf('window.stEdgeWheel =')),c);
 return {a,c,wheel:(x,y=0)=>c.stEdgeWheel(x,y),idle:()=>now+=400};
}
test('left-edge wheel overshoot stops at zero, including inertia and a new gesture',()=>{
 const h=setup(5);h.wheel(-25);assert.equal(h.a.scrollLeft,0);h.wheel(-30000);assert.equal(h.a.scrollLeft,0);h.idle();h.wheel(-10);assert.equal(h.a.scrollLeft,0);
});
test('right-edge overshoot stops at the last window',()=>{const h=setup(9995);h.wheel(25);assert.equal(h.a.scrollLeft,10000);h.wheel(30000);assert.equal(h.a.scrollLeft,10000);});
test('reversing direction responds immediately at either edge',()=>{
 const h=setup(0);h.wheel(-10);h.wheel(30);assert.equal(h.a.scrollLeft,30);
 h.a.scrollLeft=10000;h.wheel(10);h.wheel(-30);assert.equal(h.a.scrollLeft,9970);
});
test('Safari rubber-band offsets are normalized without wrapping',()=>{
 const h=setup(-45);h.wheel(-10);assert.equal(h.a.scrollLeft,0);h.a.scrollLeft=10045;h.wheel(10);assert.equal(h.a.scrollLeft,10000);
});
test('vertical reading and resizing are left alone',()=>{const h=setup(0);assert.equal(h.wheel(-2,30),false);h.c.ST.rz={};assert.equal(h.wheel(-30),false);});
test('map wheel and arrow navigation stop at the first and last window',()=>{
 const nodes=['a','b','c'].map(id=>({id})),shown=[];
 const c={ST:{focus:'a'},stWins:()=>nodes,stFocus:id=>c.ST.focus=id,stShow:id=>shown.push(id),stMap(){},$:()=>null};
 vm.runInNewContext(src.slice(src.indexOf('function stStep('),src.indexOf('// Navigation never reorders')),c);
 c.stStep(-1);assert.equal(c.ST.focus,'a');assert.equal(shown.length,0);
 c.stStep(1);assert.equal(c.ST.focus,'b');c.stStep(10);assert.equal(c.ST.focus,'c');
 c.stStep(1);assert.equal(c.ST.focus,'c');assert.equal(shown.length,2);
});
test('dragging stops at either edge and reverses without a dead zone',()=>{
 const arena={scrollLeft:5},c={ST:{pan:{sl:5,x:100,max:10000}},$:()=>arena,stMapView(){}};
 vm.runInNewContext(src.slice(src.indexOf('function stPanApply('),src.indexOf('function stPanEnd(')),c);
 c.stPanApply(150);assert.equal(arena.scrollLeft,0);c.stPanApply(140);assert.equal(arena.scrollLeft,10);
 c.ST.pan={sl:9995,x:100,max:10000};c.stPanApply(50);assert.equal(arena.scrollLeft,10000);c.stPanApply(60);assert.equal(arena.scrollLeft,9990);
});
