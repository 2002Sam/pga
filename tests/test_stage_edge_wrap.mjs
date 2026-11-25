import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
function setup(left){
 let now=1000, frames=[];const a={scrollLeft:left,scrollWidth:11000,clientWidth:1000,scrollTo(v){assert.equal(v.behavior,'instant');this.scrollLeft=v.left;}};
 const c={ST:{},S:{view:'stage'},$:()=>a,performance:{now:()=>now},stShiftStop(){},stScheduleScroll(){},requestAnimationFrame:f=>{frames.push(f);return frames.length;}};vm.createContext(c);vm.runInContext(src.slice(src.indexOf('function stEdgeWheel('),src.indexOf('window.stEdgeWheel =')),c);
 return {a,c,wheel:(x,y=0)=>{const r=c.stEdgeWheel(x,y);frames.splice(0).forEach(f=>f());return r},raw:(x,y=0)=>c.stEdgeWheel(x,y),flush:()=>frames.splice(0).forEach(f=>f()),idle:()=>now+=400};
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
test('dragging stops at the first page on the left, no blank grows there; past the right end it still extends',()=>{
 let renders=0;
 const arena={scrollLeft:5,clientWidth:1000},c={ST:{pan:{sl:5,x:100}},$:()=>arena,stMapView(){},stRender(){renders++;},stGrow(){}};
 vm.runInNewContext(src.slice(src.indexOf('function stScrollTo('),src.indexOf('function stPanStart('))+src.slice(src.indexOf('function stPanApply('),src.indexOf('function stPanEnd(')),c);
 c.stPanApply(150);assert.equal(arena.scrollLeft,0);assert.equal(c.ST.spaceLeft,undefined);
 c.stPanApply(4000);assert.equal(arena.scrollLeft,0,'however far you pull');assert.equal(renders,0,'nothing is re-laid out to make room');
 c.stPanApply(90);assert.equal(arena.scrollLeft,15,'and it comes straight back when you reverse');
 c.ST.pan={sl:9995,x:100};c.stPanApply(50);assert.equal(arena.scrollLeft,10045);assert.equal(c.ST.spaceRight,11045);
 c.stPanApply(60);assert.equal(arena.scrollLeft,10035);assert.equal(c.ST.spaceRight,11045);
});

test('trackpad burst accumulates fractional deltas into one frame and yields to navigation',()=>{
 const h=setup(100);for(let i=0;i<100;i++)h.raw(.25);
 assert.equal(h.a.scrollLeft,100);h.flush();assert.equal(h.a.scrollLeft,125);
 h.raw(20);h.a.scrollLeft=700;h.flush();assert.equal(h.a.scrollLeft,700);
 h.raw(-.5);h.flush();assert.equal(h.a.scrollLeft,699.5);
});
test('small trackpad deltas carry across paints when the browser rounds scrollLeft',()=>{
 const h=setup(100);h.a.scrollTo=({left})=>{h.a.scrollLeft=Math.round(left)};
 for(let i=0;i<8;i++)h.wheel(.25);
 assert.equal(h.a.scrollLeft,102);h.a.scrollLeft=101;h.wheel(-1);assert.equal(h.a.scrollLeft,100);
});
test('dragging within the existing canvas never rewrites its layer widths',()=>{
 let grows=0;const arena={scrollLeft:0,clientWidth:500,scrollWidth:2000};
 const c={ST:{},$:()=>arena,stGrow(){grows++}};
 vm.runInNewContext(src.slice(src.indexOf('function stScrollTo('),src.indexOf('function stPanStart(')),c);
 for(let x=0;x<=1500;x+=5)c.stScrollTo(x);
 assert.equal(grows,0);assert.equal(arena.scrollLeft,1500);
 c.stScrollTo(1510);assert.equal(grows,1);assert.equal(c.ST.spaceRight,2010);
});
test('blank once pulled out on the left is gone: not laid out, not saved, and a saved page scrolls to the same pages',()=>{
 const stage=src.slice(src.indexOf('function stLayout()'),src.indexOf('/* ------------------------------------------------ drawing */'));
 assert.doesNotMatch(stage,/spaceLeft/);assert.doesNotMatch(src,/spaceLeft:/);
 const pages=fs.readFileSync(new URL('../src/pga/web/app-pages.js',import.meta.url),'utf8');
 assert.doesNotMatch(pages,/ST\.spaceLeft/);
 assert.match(pages,/Math\.max\(0, \(v\.sl \|\| 0\) - \(v\.spaceLeft \|\| 0\)\)/);
});
