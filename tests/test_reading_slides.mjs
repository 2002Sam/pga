import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('src/pga/web/app-reading-slides.js','utf8');
function setup(getPage){
  const node=()=>({children:[],style:{setProperty(){}},classList:{add(){},remove(){}},
    append(...kids){this.children.push(...kids);},replaceChildren(...kids){this.children=kids;},
    querySelectorAll(){return [];},setAttribute(){},getContext(){return {};}});
  const item={art:{...node(),clientWidth:600},ready:true};
  const r={slides:true,zoom:1,pdfFlowVersion:1,pdf:{getPage},pdfTextPages:new Map([[1,item]]),
    pdfFlow:{clientWidth:600},blocks:[],annotations:[],slideRenderQueue:Promise.resolve(),
    pdfLib:{TextLayer:class{constructor(){this.textDivs=[];}render(){return Promise.resolve();}cancel(){}}}};
  const c=vm.createContext({readerElement:node,readerButton:node,devicePixelRatio:1,setTimeout,readingBox(){}});
  vm.runInContext(source,c);return{c,r,item};
}
const page={getViewport:({scale})=>({width:600*scale,height:400*scale}),getTextContent:async()=>({items:[]}),render:()=>({promise:Promise.resolve(),cancel(){}})};
test('a rendered slide reuses its artwork until size changes and preserves aspect ratio',async()=>{
  let calls=0;const{c,r,item}=setup(async()=>{calls++;return page;});
  await c.readingSlideRender(r,1);assert.equal(item.canvas.width,600);assert.equal(item.canvas.height,400);
  const canvas=item.canvas;await c.readingSlideRender(r,1);assert.equal(item.canvas,canvas);assert.equal(calls,1);
  item.art.clientWidth=900;await c.readingSlideRender(r,1);
  assert.equal(item.canvas.width,900);assert.equal(item.canvas.height,600);assert.equal(canvas.width,0);
});
test('closing or replacing the document discards an outstanding slide request',async()=>{
  for(const close of [r=>r.dead=true,r=>r.pdfFlowVersion++]){
    let release;const{c,r,item}=setup(()=>new Promise(resolve=>release=()=>resolve(page)));
    const job=c.readingSlideRender(r,1);await new Promise(resolve=>setImmediate(resolve));close(r);release();await job;
    assert.equal(item.canvas,undefined);assert.equal(item.paintJob,null);
  }
});
test('trimming distant slides releases canvas memory and allows them to render again',async()=>{
  const{c,r,item}=setup(async()=>page);await c.readingSlideRender(r,1);
  r.original={getBoundingClientRect:()=>({top:0,bottom:700,height:700})};item.art.getBoundingClientRect=()=>({top:3000,bottom:3400});
  const canvas=item.canvas;c.readingSlidesTrim(r);assert.equal(canvas.width,0);assert.equal(canvas.height,0);assert.equal(item.canvas,null);
  await c.readingSlideRender(r,1);assert.equal(item.canvas.width,600);
});
test('presentation canvas is not recoloured by the surrounding reading theme',()=>{
  const layout=fs.readFileSync('src/pga/web/app-reading-layout.js','utf8');
  const calls=[],pixels={data:new Uint8ClampedArray([14,24,40,255]),width:1,height:1};
  const canvas={getContext:()=>({putImageData:(...args)=>calls.push(args)})};
  const c=vm.createContext({});vm.runInContext(layout.slice(layout.indexOf('function readingPDFTheme(')),c);
  c.readingPDFTheme({slides:true,pdfPage:{querySelector:()=>canvas},pdfPixels:pixels,theme:{dark:false,background:'#fff',foreground:'#000'}});
  assert.equal(calls.length,1);assert.equal(calls[0][0],pixels);assert.deepEqual([...pixels.data],[14,24,40,255]);
});
