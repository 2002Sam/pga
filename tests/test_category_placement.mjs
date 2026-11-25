import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
test('saved overview ranks cannot split a category, including newly opened windows',()=>{
 const nodes=[{id:'a',key:'a',ord:0,overviewOrder:0,g:'PGA'},{id:'b',key:'b',ord:1,overviewOrder:1,g:'Paper'},{id:'c',key:'c',ord:2,overviewOrder:2,g:'PGA'}];
 const c=vm.createContext({ST:{nodes},stWins:()=>nodes.slice().sort((a,b)=>a.ord-b.ord),stGroupOf:n=>({id:n.g}),recentItems:()=>[]});
 vm.runInContext(src.slice(src.indexOf('function stGroupGather()'),src.indexOf('function stWsLook(')),c);
 vm.runInContext(src.slice(src.indexOf('const ST_KEEP ='),src.indexOf('// Use the full page as the reference')),c);
 c.stGroupGather(); assert.deepEqual(nodes.slice().sort((a,b)=>a.ord-b.ord).map(n=>n.id),['a','c','b']);
 nodes.push({id:'new',key:'new',ord:3,g:'PGA'});c.stGroupGather();
 assert.deepEqual(nodes.slice().sort((a,b)=>a.ord-b.ord).map(n=>n.g),['PGA','PGA','PGA','Paper']);
 for(const n of nodes)if(n.overviewOrder!=null)assert.equal(n.overviewOrder,n.ord);
 assert.equal(c.stGroupGather(),false);
});

test('managers stay first on restore, reopen and insertion without reordering other chats',()=>{
 const nodes=[{id:'a',ord:0,g:'PGA'},{id:'b',ord:1,g:'Paper'},{id:'pm',ord:2,g:'PGA',managerProject:'PGA',small:true,overviewOrder:2},{id:'c',ord:3,g:'PGA'},{id:'paper-pm',ord:4,g:'Paper',managerProject:'Paper',overviewOrder:4}];
 const sorted=()=>nodes.slice().sort((a,b)=>a.ord-b.ord);
 const c=vm.createContext({ST:{nodes},stWins:sorted,stGroupOf:n=>({id:n.g}),recentItems:()=>[]});
 vm.runInContext(src.slice(src.indexOf('function stGroupGather()'),src.indexOf('function stWsLook(')),c);
 vm.runInContext(src.slice(src.indexOf('const ST_KEEP ='),src.indexOf('// Use the full page as the reference')),c);
 c.stGroupGather();assert.deepEqual(sorted().map(n=>n.id),['pm','a','c','paper-pm','b']);
 nodes.push({id:'new',ord:-1,g:'PGA'});c.stGroupGather();
 assert.deepEqual(sorted().map(n=>n.id),['pm','new','a','c','paper-pm','b']);
 const pm=nodes.find(n=>n.id==='pm');pm.ord=99;pm.small=false;c.stGroupGather();
 assert.equal(sorted()[0].id,'pm');assert.equal(pm.overviewOrder,pm.ord);
 assert.equal(c.stGroupGather(),false);
});

function gatherContext(nodes, recent, mode = 'cat') {
 const c=vm.createContext({ST:{nodes},stWins:()=>nodes.slice().sort((a,b)=>a.ord-b.ord),stGroupOf:n=>({id:n.g}),recentItems:()=>recent,stRender(){},stSave(){},stMapHideTip(){}});
 vm.runInContext(src.slice(src.indexOf('function stGroupGather()'),src.indexOf('function stWsLook(')),c);
 vm.runInContext(src.slice(src.indexOf('const ST_KEEP ='),src.indexOf('// Use the full page as the reference')),c);
 c.ST.mapMode=mode;c.stRender=()=>c.stGroupGather();
 return c;
}

test('a reorder keeps the page you are on where it was on the screen',()=>{
 const arena={scrollLeft:1200,clientWidth:1000,scrollWidth:5000,scrollTo(o){this.scrollLeft=o.left;}};
 const nodes=[{id:'x',type:'win'},{id:'y',type:'win'},{id:'z',type:'win'}];
 const c=vm.createContext({ST:{nodes,focus:'y',pos:new Map([['x',{x:0,w:600}],['y',{x:1300,w:600}],['z',{x:2000,w:600}]])},$:()=>arena,stWins:()=>nodes,stGrow(){}});
 vm.runInContext(src.slice(src.indexOf('function stAnchor()'),src.indexOf('function stRender()')),c);
 const anchor=c.stAnchor();assert.deepEqual({...anchor},{id:'y',dx:100});
 c.ST.pos=new Map([['y',{x:20,w:600}],['x',{x:640,w:600}],['z',{x:2000,w:600}]]);
 c.stKeepAnchor(anchor);assert.equal(arena.scrollLeft,0,'y moved to the front: the stage follows it, clamped at the start');
 arena.scrollLeft=1200;c.ST.focus='gone';c.ST.pos=new Map([['x',{x:0,w:600}],['y',{x:1300,w:600}],['z',{x:2000,w:600}]]);
 const mid=c.stAnchor();assert.equal(mid.id,'y','no focus on screen: the page in the middle');
 c.ST.pos=new Map([['y',{x:2600,w:600}]]);c.stKeepAnchor(mid);assert.equal(arena.scrollLeft,2500);
});
test('category order stays manual; time mode follows each exchange including folded pages',()=>{
 const nodes=[{id:'a1',key:'a1',type:'win',ord:0,g:'A'},{id:'b1',key:'b1',type:'win',ord:1,g:'B'},{id:'a2',key:'a2',type:'win',ord:2,g:'A'},{id:'b2',key:'b2',type:'win',ord:3,g:'B'},{id:'s',key:'s',type:'win',ord:4,g:'A',small:true}];
 const recent=[{item:'a1',last:'2026-11-08T01:00:00Z'},{item:'b1',last:'2026-11-08T05:00:00Z'},{item:'a2',last:'2026-11-08T02:00:00Z'},{item:'b2',last:'2026-11-08T00:30:00Z'},{item:'s',last:'2026-11-08T04:00:00Z'}];
 const c=gatherContext(nodes,recent);c.stAnchor=()=>null;c.stKeepAnchor=()=>{};
 const order=()=>nodes.slice().sort((a,b)=>a.ord-b.ord).map(n=>n.id);
 c.stGroupGather();assert.deepEqual(order(),['a1','a2','s','b1','b2'],'each category together, where it first stands');
 nodes.find(n=>n.id==='b2').runAt=Date.parse('2026-11-08T06:00:00Z');
 assert.equal(c.stGroupGather(),false,'a message in B moves nothing');assert.deepEqual(order(),['a1','a2','s','b1','b2']);
 c.stMapModeSet('time');
 assert.deepEqual(order(),['b2','b1','s','a2','a1'],'by time: every page uses its own time, including folded pages');
 nodes.find(n=>n.id==='a1').runAt=Date.parse('2026-11-08T07:00:00Z');
 assert.equal(c.stGroupGather(),true);assert.deepEqual(order(),['a1','b2','b1','s','a2'],'a newer exchange moves that conversation ahead of other categories');
 c.stMapModeSet('cat');
 assert.deepEqual(order(),['a1','a2','s','b1','b2'],'back by category: the order you had');
 assert.ok(nodes.every(n=>n.catOrd==null));
});
test('by time a branch not talked in yet is sorted just after what it grew from, not first for being new',()=>{
 const nodes=[{id:'x',key:'x',type:'win',ord:0,g:'B'},{id:'src',key:'src',type:'win',ord:1,g:'A'},{id:'kid',key:'kid',type:'win',ord:2,g:'A',branchFrom:'src',openedAt:Date.parse('2026-11-10T00:00:00Z')}];
 const c=gatherContext(nodes,[{item:'x',last:'2026-11-08T03:00:00Z'},{item:'src',last:'2026-11-08T02:00:00Z'}]);c.stAnchor=()=>null;c.stKeepAnchor=()=>{};
 c.stMapModeSet('time');assert.deepEqual(nodes.slice().sort((a,b)=>a.ord-b.ord).map(n=>n.id),['x','src','kid']);
});
test('a new branch (made with order 0) does not pull its category to the front',()=>{
 const nodes=[{id:'a',key:'a',type:'win',ord:0,g:'A'},{id:'b',key:'b',type:'win',ord:1,g:'B'},{id:'kid',key:'kid',type:'win',ord:0,g:'B',par:'b'}];
 const c=gatherContext(nodes,[]);c.stGroupGather();
 assert.deepEqual(nodes.filter(n=>!n.par).sort((x,y)=>x.ord-y.ord).map(n=>n.id),['a','b']);
});

for(const mode of ['cat','time'])test(`explicit manager stays next to its source in ${mode} order`,()=>{
 const nodes=[{id:'pm',key:'pm',type:'win',ord:0,g:'A',managerProject:'A',managerBeside:'a'},
   {id:'b',key:'b',type:'win',ord:1,g:'A'}, {id:'a',key:'a',type:'win',ord:2,g:'A'}];
 const c=gatherContext(nodes,[{item:'b',last:'2026-11-16'},{item:'a',last:'2026-11-12'},{item:'pm',last:'2026-11-17'}],mode);
 c.stGroupGather();assert.deepEqual(nodes.slice().sort((a,b)=>a.ord-b.ord).map(n=>n.id),['b','pm','a']);
 assert.equal(c.stGroupGather(),false);
 nodes[0].managerBeside='b';c.stGroupGather();
 assert.deepEqual(nodes.slice().sort((a,b)=>a.ord-b.ord).map(n=>n.id),['pm','b','a']);
 nodes[1].g='B';c.stGroupGather();assert.equal(nodes[0].managerBeside,undefined);
});
