import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/pga/web/app-stage.js', import.meta.url), 'utf8');
function setup(nodes) {
  const ST = {nodes, shift:0};
  const c = vm.createContext({ST, stArena:()=>({w:1800,h:900}), stWins:()=>ST.nodes.filter(n=>n.type==='win'),
    stKids:()=>[], stDock:()=>false, stGroupHidden:()=>false,
    stGroupOf:w=>({id:'pj:'+w.group,name:w.group}), stRootOf:n=>n, stKnowledgeUnits(){},
    stFoldPick:()=>({folded:new Set()}), ST_CW:190, ST_MINW:300, ST_WW:660,
    ST_LINE:6, ST_CATW:22, ST_GAP:18, ST_PADX:12, ST_FORKGAP:18, ST_FIT:560, ST_TAB:150});
  vm.runInContext(source.slice(source.indexOf('function stLayout()'),source.indexOf('/* ------------------------------------------------ drawing */')),c);
  return c;
}
const win = (id,group,small=true)=>({id,group,type:'win',small});
test('adjacent fully collapsed categories each become their own marker',()=>{
  const c=setup([win('a','A'),win('ma','A'),win('b','B'),win('mb','B')]);
  c.ST.nodes[1].managerProject='A'; c.ST.nodes[3].managerProject='B';
  const cats=c.stLayout().units.filter(u=>u.kind==='cat'&&!u.hide);
  assert.deepEqual(Array.from(cats,u=>u.g.id),['pj:A','pj:B']);
  assert.ok(cats.every(u=>u.wins.length===2));
});
test('category peek survives rendering but resets after opening and refolding a page',()=>{
  const c=setup([win('a','A'),win('ma','A')]);
  c.ST.catOpen=new Set(['pj:A']);
  assert.equal(c.stLayout().units.some(u=>u.kind==='cat'),false);
  c.ST.nodes[0].small=false; c.stLayout();
  assert.equal(c.ST.catOpen.has('pj:A'),false);
  c.ST.nodes[0].small=true;
  assert.equal(c.stLayout().units.filter(u=>u.kind==='cat').length,1);
});
test('open page keeps only its own category expanded',()=>{
  const c=setup([win('a','A',false),win('ma','A'),win('b','B')]);
  const cats=c.stLayout().units.filter(u=>u.kind==='cat');
  assert.deepEqual(Array.from(cats,u=>u.g.id),['pj:B']);
});
test('automatic managers are folded, unique, and do not evict ordinary conversations',async()=>{
  const nodes=Array.from({length:12},(_,i)=>({...win('a'+i,'A',false),key:'chat:'+i}));
  const c=setup(nodes);
  Object.assign(c,{AS_UID:null,$:()=>({dataset:{ready:'1'}}),localStorage:{getItem:()=>null},
    pmRequest:async()=>({project:'A',manager:'chat:pm-A'}),stId:()=> 'manager',L:s=>s,stRender(){},stSave(){}});
  vm.runInContext(source.slice(source.indexOf('function stLimitPages('),source.indexOf('function stRender()')),c);
  c.stEnsureManagers(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.ST.nodes.length,13);
  assert.equal(c.ST.nodes.at(-1).small,true);
  assert.equal(c.stLimitPages(),false);
  c.stEnsureManagers(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.ST.nodes.length,13);
});
