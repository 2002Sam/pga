import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-reading.js',import.meta.url),'utf8');
function setup(){
 const cache=new Map(),timers=new Map(),renders=[];let serial=0;
 const el=()=>{const classes=new Set();return{style:{},classList:{add:x=>classes.add(x),remove:(...xs)=>xs.forEach(x=>classes.delete(x)),contains:x=>classes.has(x)}};};
 const c=vm.createContext({S:{uid:'u'},localStorage:{getItem:k=>cache.get(k),setItem:(k,v)=>cache.set(k,v)},
  readerElement:()=>el(),readingPDFPage:(r,page,restore)=>renders.push({page,restore,zoom:r.zoom}),
  setTimeout:fn=>{timers.set(++serial,fn);return serial;},clearTimeout:id=>timers.delete(id)});
 vm.runInContext(src.slice(src.indexOf('function readingAnnotationKey('),src.indexOf('// Reading identity')),c);
 const r={info:{source:'/test.pdf'},page:1,annotations:[],annotationMode:true,blocks:[{id:'p0',text:'Important paragraph',row:el(),bounds:{x:10,y:20,width:80,height:30}}],status:{},zoom:1,zoomLabel:{},original:el(),rows:el()};
 return{c,r,cache,timers,renders};
}
test('highlights and underlines persist per user/document and are isolated by PDF page',()=>{
 const{c,r}=setup();c.readingAnnotationAdd(r,'p0','highlight');
 assert(r.blocks[0].row.classList.contains('reading-mark-highlight'));
 r.page=2;c.readingAnnotationAdd(r,'p0','underline');
 const saved=c.readingAnnotationLoad(r.info);assert.equal(saved.length,2);
 assert(r.blocks[0].row.classList.contains('reading-mark-underline'));
 assert.equal(c.readingAnnotationLoad({source:'/another.pdf'}).length,0);
 assert.equal(c.readingAnnotationLoad({source:'/test.pdf',uid:'other'}).length,0);
 r.page=1;c.readingAnnotationClear(r);assert.equal(c.readingAnnotationLoad(r.info).length,1);
 assert.equal(c.readingAnnotationLoad(r.info)[0].page,2);
});
test('annotations do not attach to a changed paragraph just because its block id was reused',()=>{
 const{c,r}=setup();c.readingAnnotationAdd(r,'p0','highlight');r.blocks[0].text='Different paragraph';
 c.readingAnnotationApply(r);assert(!r.blocks[0].row.classList.contains('reading-mark-highlight'));
});
test('save and clear failures keep the previously saved marks and report the failure',()=>{
 const{c,r}=setup();c.readingAnnotationAdd(r,'p0','highlight');const previous=r.annotations;
 c.localStorage.setItem=()=>{throw Error('quota');};c.readingAnnotationAdd(r,'p0','underline');
 assert.equal(r.annotations,previous);assert.match(r.status.textContent,/未保存/);
 c.readingAnnotationClear(r);assert.equal(r.annotations,previous);assert.match(r.status.textContent,/未清除/);
});
test('PDF wheel bursts coalesce into one render at the latest bounded zoom and update the displayed option',()=>{
 const{c,r,timers,renders}=setup();r.pdf={};r.pdfZoom={options:[],append(o){this.options.push(o);}};
 for(const value of [1.1,1.2,1.3])c.readingZoomSet(r,value);
 assert.equal(timers.size,1);assert.equal(r.pdfZoom.value,'1.3');assert.equal(r.zoomLabel.textContent,'130%');
 const jobs=[...timers.values()];timers.clear();jobs.forEach(fn=>fn());assert.deepEqual(renders,[{page:1,restore:true,zoom:1.3}]);
 c.readingZoomSet(r,50);assert.equal(r.zoom,2.5);assert.equal(c.readingZoomLoad(r.info),2.5);
 c.readingZoomSet(r,.01);assert.equal(r.zoom,.6);
 r.dead=true;[...timers.values()].forEach(fn=>fn());assert.equal(renders.length,1,'closed reader must not restart rendering');
});
test('PDF overlay coordinates scale with the page after rerender',()=>{
 const{c,r}=setup();let overlays=[];r.pdf={};r.pdfScale=2;
 r.pdfPage={querySelectorAll:()=>overlays.map(x=>({remove(){overlays=overlays.filter(y=>y!==x);}})),append:x=>overlays.push(x)};
 c.readingAnnotationAdd(r,'p0','highlight');assert.equal(overlays.length,1);assert.equal(overlays[0].style.left,'20px');
 r.pdfScale=3;c.readingAnnotationApply(r);assert.equal(overlays.length,1);assert.equal(overlays[0].style.width,'240px');
});
test('inline web articles mark the visible source and translation, not only the hidden row',()=>{
 const{c,r}=setup();const source=new Set(),output=new Set();
 const node=set=>({classList:{add:x=>set.add(x),remove:(...xs)=>xs.forEach(x=>set.delete(x))}});
 r.blocks[0].sourceNode=node(source);r.blocks[0].output=node(output);
 c.readingAnnotationAdd(r,'p0','highlight');assert(source.has('reading-mark-highlight'));assert(output.has('reading-mark-highlight'));
 c.readingAnnotationClear(r);assert.equal(source.size,0);assert.equal(output.size,0);
});
test('PDF wheel zoom accumulates fine motion and caps a coarse event at three points',()=>{
 const {c,r}=setup();r.pdf={};r.grid={clientHeight:800};
 const wheel=(deltaY,deltaMode=0)=>c.readingPDFWheelZoom(r,{deltaY,deltaMode});
 for(let i=0;i<40;i++)wheel(-1);
 assert.equal(r.zoom,1.01);
 wheel(1,2);assert.equal(r.zoom,.98);
 wheel(-10,1);assert.equal(r.zoom,1.01);
 c.readingZoomSet(r,1.5);wheel(120);assert.equal(r.zoom,1.47);
});
