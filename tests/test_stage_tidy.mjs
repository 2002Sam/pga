import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const stage=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
const tidy=fs.readFileSync(new URL('../src/pga/web/app-stage-tidy.js',import.meta.url),'utf8');
const win=(id,g='A',at=0,rest={})=>({id,key:'chat:'+id,type:'win',g,lastUsedAt:at,ord:0,...rest});
function harness(nodes, recent=[]) {
  const ST={nodes,mapMode:'cat',shift:800,sortLead:400,spaceRight:1e6,focus:nodes[0]?.id,stageOpen:new Set(),mapExpanded:new Set(),catOpen:new Set()};
  const saved=[], scrolls=[];
  const c={ST,window:{},localStorage:{setItem:(...args)=>saved.push(args)},recentItems:()=>recent,
    stWins:()=>ST.nodes.filter(n=>n.type==='win'&&!n.managerParked).sort((a,b)=>a.ord-b.ord),
    stGroupOf:n=>n?{id:'pj:'+n.g,name:n.g}:null,stArena:()=>({w:1400,h:900}),
    stKids:n=>(n.kids||[]).map(id=>ST.nodes.find(w=>w.id===id)).filter(w=>w&&!w.branchDocked),
    stDock:()=>false,stGroupHidden:()=>false,stKnowledgeUnits(){},stReorderStop(){},stKidKeep(){},stSave(){},stShow:id=>scrolls.push(id),
    stFoldPick:()=>({folded:new Set()}),ST_PADX:12,ST_CW:190,ST_MINW:300,ST_WW:660,ST_LINE:6,ST_CATW:22,ST_GAP:18,ST_FORKGAP:4,ST_FIT:560,ST_TAB:150};
  c.stRootOf=n=>{for(let i=0;n?.par&&i<50;i++)n=ST.nodes.find(w=>w.id===n.par);return n;};
  c.stBranchUnits=(par,kids)=>kids.map(w=>({kind:'stack',par,wins:[w],nodes:[w],w:600,open:true}));
  vm.createContext(c);vm.runInContext(tidy,c);
  vm.runInContext(stage.slice(stage.indexOf('function stGroupGather()'),stage.indexOf('function stWsLook(')),c);
  vm.runInContext(stage.slice(stage.indexOf('function stLayout()'),stage.indexOf('/* ------------------------------------------------ drawing */')),c);
  c.stRender=()=>{c.stGroupGather();c.layout=c.stLayout();};
  return {c,saved,scrolls};
}
test('tidy keeps at most 15 pages in the five most recently used categories, retaining every node',()=>{
  const nodes=Array.from({length:42},(_,i)=>win(String(i),'G'+i%7,1000-i,{ord:i,small:i%2===0,pre:200,mini:i===3}));
  const {c}=harness(nodes);const result=c.stTidyStage();
  assert.equal(result.open,15);assert.equal(result.categories,5);assert.equal(result.folded,27);assert.equal(c.ST.nodes.length,42);
  const open=nodes.filter(n=>!n.small);assert(open.every(n=>Number(n.g.slice(1))<5));
  assert.deepEqual(open.map(n=>n.id),nodes.filter(n=>Number(n.g.slice(1))<5).slice(0,15).map(n=>n.id));
  assert(nodes.every(n=>n.bw===688&&n.tidyCompact&&!n.mini&&!n.pre));
});
test('small stages keep their pages and ties preserve their existing order',()=>{
  const nodes=[win('z','A',100,{ord:0}),win('a','A',100,{ord:1})],{c}=harness(nodes);
  assert.equal(c.stTidyStage().open,2);assert.deepEqual(c.stWins().map(w=>w.id),['z','a']);
});
test('a busy category keeps its latest four pages and leaves room for other categories within the total limit',()=>{
  const nodes=['A','B','C','D','E','F'].flatMap((g,gi)=>Array.from({length:8},(_,i)=>win(g+i,g,1000-gi*100-i)));
  const {c}=harness(nodes),result=c.stTidyStage();
  assert.equal(result.open,15);assert.equal(c.ST.nodes.length,48);
  assert.deepEqual(nodes.filter(n=>!n.small).map(n=>n.id),['A0','A1','A2','A3','B0','B1','B2','B3','C0','C1','C2','C3','D0','D1','D2']);
  assert(nodes.filter(n=>n.g==='F').every(n=>n.small));
});
test('usage ranking considers visits, opening, running, completion and recent exchanges',()=>{
  const nodes=[win('visited','A',600),win('opened','B',0,{openedAt:500}),win('running','C',0,{runAt:400}),win('completed','D',0,{completedAt:300}),win('exchanged','E'),win('old','F',50)];
  const {c}=harness(nodes,[{item:'chat:exchanged',last:new Date(200).toISOString()}]);
  c.stTidyStage();assert.equal(nodes[5].small,true);assert(nodes.slice(0,5).every(n=>!n.small));
});
test('parent, detached child and grandchild form a family without altering provenance',()=>{
  const parent=win('parent','A',30), child=win('child','A',80,{branchParent:'parent',branchFrom:parent.key}), grand=win('grand','A',100,{par:'child',branchKey:'chat:grand',branchFrom:child.key});
  const unrelated=win('other','A',90),{c}=harness([unrelated,grand,parent,child]);
  c.stTidyStage();assert.deepEqual(c.stWins().map(w=>w.id),['parent','child','grand','other']);
  assert.equal(grand.par,'child');assert.equal(grand.branchFrom,child.key);assert.equal(child.branchParent,'parent');
  const visible=c.layout.units.filter(u=>!u.hide&&u.kind==='win');
  assert.deepEqual(Array.from(visible,u=>u.win.id),['parent','child','grand','other']);
  const gap=visible[1].x-visible[0].x-visible[0].w;
  assert(gap>=0&&gap<=8);
});
test('a recent child counts as one page and can remain open beside an older folded parent',()=>{
  const parent=win('parent','A',1), child=win('child','A',100,{par:'parent'});
  const nodes=[parent,child,...Array.from({length:14},(_,i)=>win('other'+i,'A',90-i))],{c}=harness(nodes);
  c.stTidyStage();assert.equal(parent.small,true);assert.equal(child.small,false);
  assert.equal(c.layout.units.filter(u=>!u.hide&&u.kind==='win'&&!u.win.small).length,4);
  assert.deepEqual(nodes.filter(n=>!n.small).map(n=>n.id),['child','other0','other1','other2']);
  assert(c.layout.units.some(u=>!u.hide&&u.kind==='win'&&u.win===child));
});
test('folded pages and whole categories move after all open pages with compact gutters',()=>{
  const nodes=Array.from({length:40},(_,i)=>win(String(i),'G'+i%8,1000-i,{ord:i,pre:500,branchGap:80})),{c}=harness(nodes);
  c.stTidyStage();const units=c.layout.units.filter(u=>!u.hide);
  const firstFold=units.findIndex(u=>u.kind==='cat'||u.kind==='lines'||u.line);
  assert(firstFold>0);assert(units.slice(firstFold).every(u=>u.kind==='cat'||u.kind==='lines'||u.line));
  for(let i=1;i<units.length;i++) { const gap=units[i].x-units[i-1].x-units[i-1].w;assert(gap>=0&&gap<=8); }
  const tail=units.slice(firstFold).map(u=>Math.max(...(u.wins||[u.win]).map(w=>w.lastUsedAt)));
  assert.deepEqual(tail,tail.slice().sort((a,b)=>b-a));
  assert.equal(c.ST.shift,0);assert.equal(c.ST.sortLead,0);assert.equal(c.ST.spaceRight,0);
});
test('broken layout links are repaired without destroying fork origins or looping on cycles',()=>{
  const a=win('a','A',10,{par:'b',kids:['missing','b','b'],branchFrom:'chat:origin'}),b=win('b','A',20,{par:'a'}),orphan=win('o','A',30,{par:'missing',branchFrom:'chat:original'});
  const {c}=harness([a,b,orphan]);c.stTidyStage();
  assert(!(a.par==='b'&&b.par==='a'));assert.equal(orphan.par,undefined);assert.equal(a.branchFrom,'chat:origin');assert.equal(orphan.branchFrom,'chat:original');
  for(const n of c.ST.nodes)assert.deepEqual(n.kids||[],c.ST.nodes.filter(k=>k.par===n.id).map(k=>k.id));
});
test('layout is idempotent and survives serialized page restoration',()=>{
  const nodes=Array.from({length:22},(_,i)=>win(String(i),'G'+i%6,100-i,{ord:22-i})),{c}=harness(nodes);
  c.ST.mapMode='time';c.stTidyStage();const saved=JSON.stringify(nodes);c.stTidyStage();assert.equal(JSON.stringify(nodes),saved);
  const restored=harness(JSON.parse(saved)).c;restored.stRender();
  assert.equal(restored.stWins().filter(w=>!w.small).length,15);
  assert.deepEqual(Array.from(restored.layout.units.filter(u=>!u.hide),u=>u.kind),Array.from(c.layout.units.filter(u=>!u.hide),u=>u.kind));
});
test('more than ten tidied folded pages are not retired by the old cleanup policy',()=>{
  const nodes=Array.from({length:130},(_,i)=>win(String(i),'G'+i%12,200-i)),{c}=harness(nodes);
  c.stTidyStage();
  vm.runInContext(stage.slice(stage.indexOf('function stLimitPages('),stage.indexOf('function stRememberPage(')),c);
  assert.equal(c.stLimitPages(),false);assert.equal(c.ST.nodes.length,130);
});
test('explicit branch-layer folding still hides tidied descendants',()=>{
  const parent=win('p','A',100),child=win('c','A',90,{par:'p'}),grand=win('g','A',80,{par:'c'}),{c}=harness([parent,child,grand]);
  c.stTidyStage();parent.kidsCollapsed=true;c.stRender();
  assert(!c.layout.units.some(u=>!u.hide&&u.kind==='win'&&u.win!==parent));
  parent.kidsCollapsed=false;c.stRender();assert.equal(c.layout.units.filter(u=>!u.hide&&u.kind==='win').length,3);
});
test('pinned pages count toward the limits; an old pin folds in the row and keeps its pin record',()=>{
  const pinned=win('pin','old',1,{screenPin:{width:450,prev:'other'}}),nodes=[pinned,...Array.from({length:20},(_,i)=>win(String(i),'G'+i%5,100-i))],{c}=harness(nodes);
  c.stTidyStage();assert.equal(pinned.small,true);assert.equal(pinned.screenPin.width,450);
  assert(c.layout.units.some(u=>!u.hide&&u.kind==='cat'&&u.wins.includes(pinned)));
  pinned.small=false;c.stRender();assert(!c.layout.units.some(u=>!u.hide&&(u.win===pinned||u.wins?.includes(pinned))));
});
