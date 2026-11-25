import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-reading.js',import.meta.url),'utf8');
function setup(texts){
 const c=vm.createContext({});vm.runInContext(src.slice(src.indexOf('function readingDocumentIndex('),src.indexOf('async function readingSend(')),c);
 let reads=0;const r={page:1,pdf:{numPages:texts.length,async getPage(n){reads++;return{getTextContent:async()=>({items:[{str:texts[n-1]}]})};}}};return {c,r,reads:()=>reads};
}
test('file context indexes later pages independently of visible canvas and caches extraction',async()=>{
 const {c,r,reads}=setup(Array.from({length:30},(_,i)=>i===24?'Unicorn evidence shows a large effect.':'Common introductory text.'));
 const text=await c.readingQuestionContext(r,'What is the unicorn evidence?',null);
 assert.match(text,/第 25 页/);assert.match(text,/Unicorn evidence/);assert.equal(reads(),30);
 await c.readingQuestionContext(r,'Follow-up',null);assert.equal(reads(),30);
});
test('explicit page and Chinese terms select relevant text within the prompt limit',async()=>{
 const {c,r}=setup(Array.from({length:50},(_,i)=>i===39?'方差下降的原因是样本数量增加。':'Introductory English text. '.repeat(100)));
 const text=await c.readingQuestionContext(r,'第40页方差下降为什么？',null);
 assert.match(text,/第 40 页/);assert.match(text,/方差下降/);assert.ok(text.length<=24000);
});
test('blank scanned text permits a general question without fabricated evidence',async()=>{
 const {c,r}=setup(['','   ']);assert.equal(await c.readingQuestionContext(r,'What is probability?',null),'');
});
test('large documents use bounded extraction and state partial coverage',async()=>{
 const {c,r,reads}=setup(Array.from({length:210},()=> 'Short text.'));
 const text=await c.readingQuestionContext(r,'Explain',null);
 assert.equal(reads(),200);assert.match(text,/共 210 页，已提取 200 页/);assert.match(text,/并非完整全文/);
});
