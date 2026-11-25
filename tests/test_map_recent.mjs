import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
const wins=Array.from({length:5},(_,i)=>({id:i,key:String(i),type:'win',group:'a',completedAt:i*100})).concat({id:5,key:'5',type:'win',group:'b'});
const ctx={ST:{nodes:wins},stWins:()=>wins,stGroupOf:w=>({id:w.group})};vm.createContext(ctx);
vm.runInContext(src.slice(src.indexOf('const ST_KEEP ='),src.indexOf('// Use the full page as the reference')),ctx);
test('no default fold: every open conversation keeps its place on the map, in stage order',()=>{
 const r=ctx.stMapSelection(wins,new Map());assert.deepEqual(Array.from(r.selected,w=>w.id),[0,1,2,3,4,5]);assert.deepEqual(wins.map(w=>w.id),[0,1,2,3,4,5]);assert.equal(r.counts.get('a'),5);assert.equal(r.folded.has('a'),false);
 const recent=new Map([['0',{last:'2026-11-05T00:00:00Z'}]]);
 assert.deepEqual(Array.from(ctx.stMapSelection(wins,recent).selected,w=>w.id),[0,1,2,3,4,5]);
});
test('map hit resolves compact slots to original windows, not the stage coordinates',()=>{
 const m={dataset:{k:'1'},scrollLeft:0,getBoundingClientRect:()=>({left:100})};const inner={getBoundingClientRect:()=>({top:0,height:20})};
 const c={ST:{mapWins:[wins[4]],mapPos:new Map([[4,{x:0,w:100}]]),pos:new Map([[4,{x:4000,w:600}]])},$:s=>s==='#stmap'?m:inner,stMapBand:()=>({top:0,height:1})};vm.createContext(c);vm.runInContext(src.slice(src.indexOf('function stMapHit('),src.indexOf('function stMapHideTip(')),c);assert.equal(c.stMapHit(150,10).w.id,4);assert.equal(c.stMapHit(250,10),null);
});
test('a fully folded category has no map slots',()=>{
 const nodes=[{id:'manager',type:'win',managerProject:'A',small:true,group:'A'},
  ...Array.from({length:8},(_,i)=>({id:'a'+i,type:'win',small:true,group:'A'})),
  {id:'b',type:'win',group:'B'}];
 const c=vm.createContext({ST:{nodes},stWins:()=>nodes,stGroupOf:w=>({id:w.group,name:w.group}),stFoldCat(){}});
 vm.runInContext(src.slice(src.indexOf('const ST_KEEP ='),src.indexOf('// Use the full page as the reference')),c);
 const result=c.stMapSelection(nodes,new Map());
 assert.equal(result.selected.length,1);
 assert.equal(result.selected[0].id,'b');
 assert.equal(result.collapsed.has('A'),true);assert.equal(result.collapsed.has('B'),false);
 assert.ok(nodes.every(w=>!w._mapCategory),'map projection never changes real windows');
 nodes[1].small=false;
 assert.equal(c.stMapSelection(nodes,new Map()).collapsed.has('A'),false);
});
test('collapsed category can reopen after refresh without an in-memory fold list',()=>{
 const nodes=[{id:'a',group:'A',small:true},{id:'b',group:'A',small:true},{id:'c',group:'B',small:true}];
 let opened;
 const c=vm.createContext({ST:{nodes},stWins:()=>nodes,stGroupOf:w=>({id:w.group}),stFoldCat:id=>opened=id});
 vm.runInContext(src.slice(src.indexOf('function stMapOpenCategory('),src.indexOf('// Use the full page as the reference')),c);
 c.stMapOpenCategory('A');assert.equal(opened,'A');
 assert.deepEqual(Array.from(c.ST.foldCatIds.A),['a','b']);assert.equal(c.ST.foldCatIds.B,undefined);
 c.ST.foldCatIds.A=['b'];c.stMapOpenCategory('A');assert.deepEqual(Array.from(c.ST.foldCatIds.A),['b']);
});
test('categories rank by latest exchange including hidden chats, not by opening time', () => {
 const nodes=[{id:'a1',key:'a1',type:'win',openedAt:9999999999999},
 {id:'b1',key:'b1',type:'win'},{id:'a2',key:'a2',type:'win',completedAt:1000},
 {id:'c1',key:'c1',type:'win',small:true}];
 const c=vm.createContext({ST:{nodes},stWins:()=>nodes,stGroupOf:w=>({id:w.key[0]})});
 vm.runInContext(src.slice(src.indexOf('const ST_KEEP ='),src.indexOf('// Use the full page as the reference')),c);
 const recent=new Map([['b-closed',{last:'2026-11-08T01:00:00Z'}],['c1',{last:'2026-11-07T01:00:00Z'}]]);
 const result=c.stMapSelection(nodes,recent);
 assert.deepEqual(Array.from(result.selected,w=>w.id),['b1','a1','a2']);
 assert.deepEqual(nodes.map(w=>w.id),['a1','b1','a2','c1'],'stage order unchanged');
 nodes[0].runAt=Date.parse('2026-11-09T00:00:00Z');
 assert.deepEqual(Array.from(c.stMapSelection(nodes,recent).selected,w=>w.id),['a1','a2','b1']);
});

test('folded conversations and hidden branches leave no slot, then return on expansion', () => {
 const nodes=[{id:'a',type:'win',group:'A',small:true},{id:'child',type:'win',group:'A',par:'a'},
 {id:'b',type:'win',group:'A'},{id:'mini',type:'win',group:'A',mini:true}];
 const c=vm.createContext({ST:{nodes,mapExpanded:new Set(['A'])},stWins:()=>nodes,stGroupOf:w=>({id:w.group})});
 vm.runInContext(src.slice(src.indexOf('const ST_KEEP ='),src.indexOf('// Use the full page as the reference')),c);
 assert.deepEqual(Array.from(c.stMapSelection(nodes,new Map()).selected,w=>w.id),['b']);
 delete nodes[0].small;
 assert.deepEqual(Array.from(c.stMapSelection(nodes,new Map()).selected,w=>w.id),['a','child','b']);
 assert.equal(nodes.length,4,'conversations are retained');
});

test('a branch tucked into its page, or anything not standing open on the drawn stage, has no slot', () => {
 const nodes=[{id:'p',type:'win',group:'A',kids:['k']},{id:'k',type:'win',group:'A',par:'p',branchDocked:true},
 {id:'g',type:'win',group:'A',par:'k'},{id:'q',type:'win',group:'B'}];
 const c=vm.createContext({ST:{nodes},stWins:()=>nodes,stGroupOf:w=>({id:w.group})});
 vm.runInContext(src.slice(src.indexOf('const ST_KEEP ='),src.indexOf('// Use the full page as the reference')),c);
 assert.deepEqual(Array.from(c.stMapSelection(nodes,new Map()).selected,w=>w.id),['p','q'],'the tucked branch and the branch under it');
 c.ST.pos=new Map([['p',{x:0,w:600}],['q',{x:620,w:140,tab:true}]]);
 assert.deepEqual(Array.from(c.stMapSelection(nodes,new Map()).selected,w=>w.id),['p'],'once drawn, only what stands open');
});

test('by time: latest exchange first across categories, opening only places windows never talked to, folded stay off', () => {
 const at=s=>Date.parse('2026-11-08T0'+s+':00:00Z');
 const nodes=[{id:'a1',key:'a1',type:'win',group:'A'},{id:'b1',key:'b1',type:'win',group:'B'},
 {id:'a2',key:'a2',type:'win',group:'A'},{id:'n',key:'n',type:'win',group:'B',openedAt:at(2)+1800e3},
 {id:'s',key:'s',type:'win',group:'A',small:true},{id:'old',key:'old',type:'win',group:'B',openedAt:at(9)}];
 const c=vm.createContext({ST:{nodes,mapExpanded:new Set(['A','B'])},stWins:()=>nodes,stGroupOf:w=>({id:w.group})});
 vm.runInContext(src.slice(src.indexOf('const ST_KEEP ='),src.indexOf('// Use the full page as the reference')),c);
 const recent=new Map([['a1',{last:new Date(at(1)).toISOString()}],['b1',{last:new Date(at(2)).toISOString()}],
  ['a2',{last:new Date(at(3)).toISOString()}],['s',{last:new Date(at(4)).toISOString()}],['old',{last:new Date(at(0)).toISOString()}]]);
 assert.deepEqual(Array.from(c.stMapSelection(nodes,recent,'time').selected,w=>w.id),['a2','n','b1','a1','old']);
 assert.deepEqual(Array.from(c.stMapSelection(nodes,recent,'cat').selected,w=>w.id),['a1','a2','b1','n','old']);
 assert.equal(c.ST.mapMode,'cat','category is the default without a saved choice');
 assert.deepEqual(nodes.map(w=>w.id),['a1','b1','a2','n','s','old'],'stage order unchanged');
});

test('time stretches under the bar: last hour, today, yesterday, this week, earlier', () => {
 const c=vm.createContext({ST:{nodes:[]},stWins:()=>[],stGroupOf:()=>null});
 vm.runInContext(src.slice(src.indexOf('const ST_KEEP ='),src.indexOf('// Use the full page as the reference')),c);
 const now=new Date(2026,10,8,15,0).getTime(), d=(day,h)=>new Date(2026,10,day,h,0).getTime();
 assert.deepEqual([now-600e3,d(8,9),d(7,20),d(5,9),d(1,9),0].map(t=>vm.runInContext('ST_MAPAGES',c)[c.stMapAge(t,now)][1]),
  ['1 小时内','今天','昨天','近 7 天','更早','更早']);
});
