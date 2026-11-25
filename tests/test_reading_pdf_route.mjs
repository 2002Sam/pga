import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('src/pga/web/app-reading.js','utf8');
const code=source.slice(source.indexOf('function readingPDFSource('),source.indexOf('function readingWeb('));
function setup({apiFails=false,directFails=false,kind='document'}={}) {
  const calls=[];
  const c=vm.createContext({URL,S:{uid:'test'},window:{top:{PGA_NATIVE:{readingBrowser:true}}},
    document:{querySelector:()=>({})},readingScheduleSave(){},readingFileActionsSync(){},
    api:async()=>{calls.push('api');if(apiFails)throw Error('超过 8 MB');return {kind,url_view:'/cached.pdf'};},
    readingPDF:async(r,url)=>{calls.push(url);if(directFails&&url.startsWith('https:'))throw Error('CORS');},
    readingWeb:()=>calls.push('native'),
  });vm.runInContext(code,c);
  const r={info:{source:'https://arxiv.org/pdf/2610.23913v1',web:true,key:'paper'},controller:new AbortController(),state:{},status:{},progress:{}};
  return {c,r,calls};
}
test('recognizes extensionless PDF endpoints without treating abstract pages as PDFs',()=>{
  const {c}=setup();
  for(const url of ['https://arxiv.org/pdf/2610.23913v1','https://openreview.net/pdf?id=123','https://example.com/file.pdf?download=1'])assert.equal(c.readingPDFSource(url),true);
  for(const url of ['https://arxiv.org/abs/2610.23913','https://arxiv.org.evil.example/pdf/123','https://example.com/pdf/help'])assert.equal(c.readingPDFSource(url),false);
});
test('direct PDF extraction bypasses the article fetch size cap',async()=>{
  const {c,r,calls}=setup({apiFails:true});await c.readingLoad(r);
  assert.deepEqual(calls,[r.info.source]);assert.equal(r.loading,false);
});
test('servers without CORS fall back to the backend PDF preview',async()=>{
  const {c,r,calls}=setup({directFails:true});await c.readingLoad(r);
  assert.deepEqual(calls,[r.info.source,'api','/cached.pdf']);
});
test('PDF fetch failure is visible and never opens the textless native viewer',async()=>{
  const {c,r,calls}=setup({directFails:true,apiFails:true});await c.readingLoad(r);
  assert.equal(calls.includes('native'),false);assert.match(r.progress.textContent,/PDF 文字读取失败.*8 MB/);assert.equal(r.loading,false);
});
test('normal webpage failures retain native browser fallback',async()=>{
  const {c,r,calls}=setup({apiFails:true});r.info.source='https://arxiv.org/abs/2610.23913';await c.readingLoad(r);
  assert.deepEqual(calls,['api','native']);
});
