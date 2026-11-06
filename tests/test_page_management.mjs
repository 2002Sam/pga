import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/pga/web/app-stage.js', import.meta.url), 'utf8');
function context(ST) {
 const c=vm.createContext({ST,stWins:()=>ST.nodes.filter(n=>n.type==='win')});
 vm.runInContext(source.slice(source.indexOf('function stLimitPages('),source.indexOf('function stRender()')),c);
 return c;
}
test('evicts least recently used pages, retaining current page and auxiliary views',()=>{
 const ST={focus:'0',nodes:Array.from({length:15},(_,i)=>({id:String(i),type:'win',lastUsedAt:i}))};
 ST.nodes.push({id:'memo',type:'win',memo:'note'});
 ST.nodes[1].lastUsedAt=100;
 const c=context(ST); assert.equal(c.stLimitPages(),true);
 assert.equal(ST.nodes.length,13);
 assert.ok(ST.nodes.some(n=>n.id==='0'));assert.ok(ST.nodes.some(n=>n.id==='1'));
 assert.ok(ST.nodes.some(n=>n.id==='memo'));
 for(const id of ['2','3','4']) assert.ok(!ST.nodes.some(n=>n.id===id));
 assert.equal(c.stLimitPages(),false);
});
test('evicting a parent preserves and detaches its surviving branch',()=>{
 const ST={focus:'child',nodes:[{id:'parent',type:'win',kids:['child']},{id:'child',type:'win',par:'parent',small:true,branchDocked:true}]};
 context(ST).stLimitPages(1);
 assert.equal(ST.nodes.length,1);assert.equal(ST.nodes[0].id,'child');assert.equal(ST.nodes[0].par,undefined);assert.equal(ST.nodes[0].small,undefined);
});
test('tidy resets expanded categories and recovers after layout errors without network requests',()=>{
 const ST={mapExpanded:new Set(['a']),stageOpen:new Set(['b']),projectLimits:{a:Infinity}};
 let listed=false;
 const c=vm.createContext({ST,stTidyLayout(){throw new Error('layout');},stListItems(){listed=true;},toast(){},L:z=>z});
 vm.runInContext(source.slice(source.indexOf('function stTidy(b)'),source.indexOf('function stDropToggle')),c);
 const button={classList:{add(){},remove(){}},disabled:false};c.stTidy(button);
 assert.equal(ST.tidying,false);assert.equal(button.disabled,false);assert.equal(ST.mapExpanded.size,0);assert.equal(ST.stageOpen.size,0);assert.equal(Object.keys(ST.projectLimits).length,0);
 c.stTidyLayout=()=>{};c.stTidy(button);assert.equal(listed,true);
});

test('tidy restores collapsed pages and makes managers half of normal width',()=>{
 const nodes=[{id:'m',managerProject:'A',small:true,big:true},{id:'a',small:true},{id:'b'}];
 const c=vm.createContext({ST:{nodes},stArena:()=>({w:1240}),ST_PADX:10,ST_GAP:20,stWins:()=>nodes,
 stWs:()=>false,stWsGather(){},stRender(){},stSave(){},$:()=>null});
 vm.runInContext(source.slice(source.indexOf('function stTidyLayout()'),source.indexOf('function stTidy(b)')),c);
 c.stTidyLayout();assert.equal(nodes[0].bw,300);assert.equal(nodes[1].bw,600);
 assert.ok(nodes.every(n=>!n.small&&!n.big&&!n.mini));
});
test('fold picks the latest two per category and excludes managers',()=>{
 const nodes=Array.from({length:5},(_,i)=>({id:String(i),key:String(i),type:'win',completedAt:i+1}));
 nodes.push({id:'m',type:'win',managerProject:'A'});
 const c=vm.createContext({ST:{},stWins:()=>nodes,stGroupOf:()=>({id:'A'}),recentItems:()=>[]});
 vm.runInContext(source.slice(source.indexOf('const ST_KEEP ='),source.indexOf('function stMapSelection')),c);
 assert.deepEqual([...c.stFoldPick().folded],['2','1','0']);
 const recent=new Map([['0',{last:'2026-11-06'}]]);
 assert.deepEqual([...c.stFoldPick(recent).folded],['3','2','1']);
});
