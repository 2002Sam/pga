import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('src/pga/web/app-reading-pdf.js','utf8');
const load=source.slice(source.indexOf('function readingPDFTextLoad('),source.indexOf('async function readingPDFTextPage('));
const blocks=source.slice(source.indexOf('function readingPDFBlocks('),source.indexOf('function readingPDFLocate('));
function setup(getPage){
  const node=(tag,cls,text)=>({tag,cls,text,children:[],classList:{add(){}},append(...kids){this.children.push(...kids);},replaceChildren(...kids){this.children=kids;}});
  const c=vm.createContext({readerElement:node,readerButton:(text,click)=>({text,click}),
    readingBlocks:(r,items)=>r.blocks.push(...items)});
  vm.runInContext(blocks+load,c);
  const r={pdfFlowVersion:1,pdfTextQueue:Promise.resolve(),blocks:[],pdf:{getPage},
    pdfLib:{Util:{transform:(_,v)=>v}},pdfTextPages:new Map([1,2].map(n=>[n,{section:node(),body:node(),ready:false,pending:null}]))};
  return {c,r};
}
const page=text=>({getTextContent:async()=>({items:[{str:text,width:80,transform:[1,0,0,14,20,30]}]}),getViewport:()=>({width:600,transform:[]})});
test('continuous pages retain distinct paragraph identities and append without discarding earlier translations',async()=>{
  const {c,r}=setup(async n=>page('Paragraph on page '+n));
  await c.readingPDFTextLoad(r,1);r.blocks[0].done=true;
  await c.readingPDFTextLoad(r,2);
  assert.equal(r.blocks.length,2);assert.equal(r.blocks[0].done,true);
  assert.equal(r.blocks[0].id,'p100000');assert.equal(r.blocks[1].id,'p200000');
  assert.equal(r.blocks[0].legacyId,'p0');assert.equal(r.blocks[1].page,2);
  assert.equal(r.blocks[1].sourceNode.text,'Paragraph on page 2');
});
test('duplicate requests share pending extraction and different pages are serialized',async()=>{
  let release;const calls=[];
  const {c,r}=setup(n=>{calls.push(n);return n===1?new Promise(resolve=>release=()=>resolve(page('First'))):Promise.resolve(page('Second'));});
  const a=c.readingPDFTextLoad(r,1),duplicate=c.readingPDFTextLoad(r,1),b=c.readingPDFTextLoad(r,2);
  assert.equal(a,duplicate);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,[1]);
  release();await Promise.all([a,b]);assert.deepEqual(calls,[1,2]);
  await c.readingPDFTextLoad(r,1);assert.deepEqual(calls,[1,2]);
});
test('a closed or replaced PDF cannot append late text or start translation',async()=>{
  for(const close of [r=>r.dead=true,r=>r.pdfFlowVersion++,r=>r.pdf={}]){
    let release;const {c,r}=setup(()=>new Promise(resolve=>release=()=>resolve(page('Late text'))));
    const pending=c.readingPDFTextLoad(r,1);await new Promise(resolve=>setImmediate(resolve));close(r);release();await pending;
    assert.equal(r.blocks.length,0);assert.equal(r.pdfTextPages.get(1).ready,false);
  }
});
test('failed text extraction remains retryable and does not prevent another page from loading',async()=>{
  let fail=true;const {c,r}=setup(async n=>{if(n===1&&fail)throw Error('Unreadable text stream');return page('Recovered');});
  await c.readingPDFTextLoad(r,1);
  const item=r.pdfTextPages.get(1);assert.match(item.body.children[0].text,/Unreadable/);assert.equal(item.pending,null);
  await c.readingPDFTextLoad(r,2);assert.equal(r.blocks.length,1);
  fail=false;await c.readingPDFTextLoad(r,1);assert.equal(item.ready,true);assert.equal(r.blocks.length,2);
});
