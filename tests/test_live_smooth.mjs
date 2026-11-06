import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync('src/pga/web/app-live.js','utf8');
function setup(extra={}) {
 const c=vm.createContext({document:{hidden:false},...extra});
 vm.runInContext(src.slice(src.indexOf('function liveFormatCache('),src.indexOf('function composerBusy(')),c);
 return c;
}
test('unchanged formatted content is reused while changed text updates and old entries are pruned',()=>{
 const c=setup(),state={};let calls=0;
 let cache=c.liveFormatCache(state);assert.equal(cache('words','a',()=>{calls++;return 'A';}),'A');cache('step:0','tool',()=> 'tool');
 for(let i=0;i<100;i++){cache=c.liveFormatCache(state);assert.equal(cache('words','a',()=>{calls++;return 'wrong';}),'A');}
 assert.equal(calls,1);assert.equal(state.formatted.size,1);
 cache=c.liveFormatCache(state);assert.equal(cache('words','b',()=>{calls++;return 'B';}),'B');assert.equal(calls,2);
});
test('independent lanes never share formatted output',()=>{
 const c=setup(),a={},b={};c.liveFormatCache(a)('words','a',()=> 'left');
 assert.equal(c.liveFormatCache(b)('words','a',()=> 'right'),'right');assert.equal(c.liveFormatCache(a)('words','a',()=> 'wrong'),'left');
});
test('burst updates share one frame and subsequent updates schedule a fresh frame',async()=>{
 const frames=[];const c=setup({requestAnimationFrame:fn=>frames.push(fn)}),watch={};
 const first=c.livePaintFrame(watch),second=c.livePaintFrame(watch);assert.equal(first,second);assert.equal(frames.length,1);
 frames.shift()();await first;assert.equal(watch.frame,null);
 const next=c.livePaintFrame(watch);assert.equal(frames.length,1);frames.shift()();await next;
});
test('background windows do not wait forever for an animation frame',async()=>{
 const c=setup({document:{hidden:true},requestAnimationFrame:()=>assert.fail('hidden frame scheduled')});await c.livePaintFrame({});
});
