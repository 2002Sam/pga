import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
const wins=Array.from({length:5},(_,i)=>({id:i,key:String(i),type:'win',group:'a',completedAt:i*100})).concat({id:5,key:'5',type:'win',group:'b'});
const ctx={ST:{nodes:wins},stWins:()=>wins,stGroupOf:w=>({id:w.group})};vm.createContext(ctx);
vm.runInContext(src.slice(src.indexOf('const ST_KEEP ='),src.indexOf('// Use the full page as the reference')),ctx);
test('each category keeps its two most recent conversations in their original stage order',()=>{
 const r=ctx.stMapSelection(wins,new Map());assert.deepEqual(Array.from(r.selected,w=>w.id),[3,4,5]);assert.deepEqual(wins.map(w=>w.id),[0,1,2,3,4,5]);assert.equal(r.counts.get('a'),5);assert.equal(r.folded.get('a'),3);
});
test('expanded category includes all windows and recent history participates in ranking',()=>{
 const recent=new Map([['0',{last:'2026-11-05T00:00:00Z'}]]);
 assert.deepEqual(Array.from(ctx.stMapSelection(wins,recent).selected,w=>w.id),[0,4,5]);
 ctx.ST.mapExpanded=new Set(['a']);
 const r=ctx.stMapSelection(wins,recent);assert.deepEqual(Array.from(r.selected,w=>w.id),[0,1,2,3,4,5]);assert.equal(r.folded.has('a'),false);
 ctx.ST.mapExpanded.clear();
});
test('map hit resolves compact slots to original windows, not the stage coordinates',()=>{
 const m={dataset:{k:'1'},scrollLeft:0,getBoundingClientRect:()=>({left:100})};const inner={getBoundingClientRect:()=>({top:0,height:20})};
 const c={ST:{mapWins:[wins[4]],mapPos:new Map([[4,{x:0,w:100}]]),pos:new Map([[4,{x:4000,w:600}]])},$:s=>s==='#stmap'?m:inner,stMapBand:()=>({top:0,height:1})};vm.createContext(c);vm.runInContext(src.slice(src.indexOf('function stMapHit('),src.indexOf('function stMapHideTip(')),c);assert.equal(c.stMapHit(150,10).w.id,4);assert.equal(c.stMapHit(250,10),null);
});
