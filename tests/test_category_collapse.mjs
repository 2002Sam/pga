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
test('visiting categories does not automatically create manager windows',async()=>{
  const nodes=Array.from({length:12},(_,i)=>({...win('a'+i,'A',false),key:'chat:'+i}));
  const c=setup(nodes);
  Object.assign(c,{AS_UID:null,$:()=>({dataset:{ready:'1'}}),localStorage:{getItem:()=>null},
    pmRequest:async()=>assert.fail('must open managers only on request'),stId:()=> 'manager',L:s=>s,stRender(){},stSave(){}});
  vm.runInContext(source.slice(source.indexOf('function stLimitPages('),source.indexOf('function stRender()')),c);
  c.stEnsureManagers(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.ST.nodes.length,12);
  assert.equal(c.stLimitPages(),false);
  c.stEnsureManagers(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(c.ST.nodes.length,12);
});

function restoreContext(nodes) {
  const c = setup(nodes);
  Object.assign(c, {document:{querySelector:()=>null}, stKidKeep(){}, stSave(){}, stMap(){},
    stRender(){ c.stLimitPages(); c.stLayout(); }});
  vm.runInContext(source.slice(source.indexOf('function stLimitPages('),source.indexOf('function stRender()')),c);
  vm.runInContext(source.slice(source.indexOf('function stFoldSet('),source.indexOf('function stMini(n, on)')),c);
  vm.runInContext(source.slice(source.indexOf('function stMapOpenCategory('),source.indexOf('// Use the full page as the reference')),c);
  return c;
}
test('opening a category after global fold restores its previous windows and widths only',()=>{
  const a={...win('a','A',false),bw:650}, old=win('old','A'), b=win('b','B',false);
  const c=restoreContext([a,old,b]);
  c.stFoldAll();
  assert.ok(c.ST.nodes.every(w=>w.small));
  c.stMapOpenCategory('pj:A');
  assert.equal(!!a.small,false); assert.equal(a.bw,650);
  assert.equal(old.small,true); assert.equal(b.small,true);
  assert.ok(c.stLayout().units.some(u=>u.kind==='win'&&u.win===a&&!u.hide&&u.w===650));
  c.stMapOpenCategory('pj:B'); assert.equal(!!b.small,false);
  assert.equal(c.ST.foldAllIds,undefined);
  a.small=true; old.small=false;
  c.stFoldCat('pj:A'); c.stMapOpenCategory('pj:A');
  assert.equal(a.small,true); assert.equal(!!old.small,false);
});
test('category fold and reopen keeps an already folded conversation folded',()=>{
  const a=win('a','A',false), old=win('old','A');
  const c=restoreContext([a,old]);
  c.stFoldCat('pj:A'); c.stMapOpenCategory('pj:A');
  assert.equal(!!a.small,false); assert.equal(old.small,true);
});
test('category marker restores full windows even without a saved fold list',()=>{
  const c=restoreContext([win('a','A'),win('b','A')]);
  c.stMapOpenCategory('pj:A');
  assert.ok(c.ST.nodes.every(w=>!w.small));
  assert.ok(c.stLayout().units.filter(u=>u.kind==='win'&&!u.hide).every(u=>u.w>=300));
});
for (const byCategory of [false,true]) test(`batch folding retains more than ten windows for ${byCategory?'category':'global'} restore`,()=>{
  const nodes=Array.from({length:15},(_,i)=>({...win('a'+i,byCategory?'A':'G'+i,false),bw:500+i}));
  const c=restoreContext(nodes);
  if(byCategory)c.stFoldCat('pj:A'); else c.stFoldAll();
  assert.equal(c.ST.nodes.length,15);
  for(const group of new Set(nodes.map(w=>w.group)))c.stMapOpenCategory('pj:'+group);
  assert.equal(c.ST.nodes.length,15);
  assert.ok(c.ST.nodes.every((w,i)=>!w.small&&w.bw===500+i));
});

test('time layout preserves global order instead of stacking branches or merging folded categories',()=>{
 const child={...win('child','A',false),par:'a',bw:450};
 const b={...win('b','B',false),bw:450};
 const a={...win('a','A'),kids:['child'],kidsCollapsed:true};
 const a2=win('a2','A'),c=setup([child,b,a,a2]);c.ST.mapMode='time';
 const units=c.stLayout().units.filter(u=>!u.hide);
 assert.deepEqual(Array.from(units,u=>u.win?.id),['child','b','a','a2']);
 assert.equal(units[2].w,6);assert.equal(units[3].w,6);
 assert(units[0].x<units[1].x&&units[1].x<units[2].x);
 assert.equal(child.par,'a');assert.deepEqual(a.kids,['child']);assert.equal(a.kidsCollapsed,true);
 c.ST.mapMode='cat';assert(!c.stLayout().units.some(u=>u.win===child));
});
