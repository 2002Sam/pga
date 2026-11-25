import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/pga/web/app-stage.js', import.meta.url), 'utf8');
function context(ST) {
 const c=vm.createContext({ST,stWins:()=>ST.nodes.filter(n=>n.type==='win'),stGroupOf:w=>({id:w.group||'A'})});
 vm.runInContext(source.slice(source.indexOf('function stLimitPages('),source.indexOf('function stRender()')),c);
 return c;
}
test('evicts least recently used pages, retaining current page and auxiliary views',()=>{
 const ST={focus:'0',nodes:Array.from({length:102},(_,i)=>({id:String(i),type:'win',lastUsedAt:i}))};
 ST.nodes.push({id:'memo',type:'win',memo:'note'});
 ST.nodes[1].lastUsedAt=100;
 const c=context(ST); assert.equal(c.stLimitPages(),true);
 assert.equal(ST.nodes.length,100);
 assert.ok(ST.nodes.some(n=>n.id==='0'));assert.ok(ST.nodes.some(n=>n.id==='1'));
 assert.ok(ST.nodes.some(n=>n.id==='memo'));
 for(const id of ['2','3','4']) assert.ok(!ST.nodes.some(n=>n.id===id));
 assert.equal(c.stLimitPages(),false);
});
test('evicting a parent preserves and detaches its surviving branch',()=>{
 const ST={focus:'child',nodes:[{id:'parent',type:'win',kids:['child']},{id:'child',type:'win',par:'parent',small:true,branchDocked:true}]};
 context(ST).stLimitPages(1);
 assert.equal(ST.nodes.length,1);assert.equal(ST.nodes[0].id,'child');assert.equal(ST.nodes[0].par,undefined);assert.equal(ST.nodes[0].small,true);
});
test('opening a fifth category folds nothing by default',()=>{
 const nodes=Array.from({length:6},(_,i)=>({id:String(i),type:'win',group:'G'+i,lastUsedAt:i+1}));
 const ST={nodes,focus:'5'}, c=context(ST);
 assert.equal(c.stLimitPages(),false);
 assert.ok(nodes.every(n=>!n.small));
});
test('no more than ten folded categories remain, including their manager windows',()=>{
 const nodes=Array.from({length:13},(_,i)=>[
  {id:'m'+i,type:'win',group:'G'+i,managerProject:'G'+i,small:true,lastUsedAt:i},
  {id:'w'+i,type:'win',group:'G'+i,small:true,lastUsedAt:i}]).flat();
 const ST={nodes}, c=context(ST);c.stLimitPages();
 assert.equal(new Set(ST.nodes.map(w=>w.group)).size,10);
 assert.ok(ST.nodes.every(w=>!['G0','G1','G2'].includes(w.group)));
 assert.equal(c.stLimitPages(),false);
});
test('folded conversations are capped at ten, including automatically folded views',()=>{
 const nodes=Array.from({length:16},(_,i)=>({id:String(i),type:'win',small:i<8,lastUsedAt:i}));
 const ST={nodes,focus:'15'}, c=context(ST);
 c.stFoldPick=()=>({folded:new Set(['8','9','10','11','12','13'])});
 c.stLimitPages();
 assert.equal(ST.nodes.length,12);assert.deepEqual(ST.nodes.slice(0,2).map(w=>w.id),['4','5']);
 assert.equal(c.stLimitPages(),false);
});
test('hard cap includes managers and processed timestamps affect eviction order',()=>{
 const nodes=Array.from({length:104},(_,i)=>({id:String(i),type:'win',lastUsedAt:i,managerProject:i%2?'A':undefined}));
 nodes[0].completedAt=1000;
 const ST={nodes,focus:'103'}, c=context(ST);c.stLimitPages();
 assert.equal(ST.nodes.length,99);assert.ok(ST.nodes.some(w=>w.id==='0'));
 assert.ok(ST.nodes.some(w=>w.id==='103'));assert.equal(c.stLimitPages(),false);
});
test('evicted long drafts survive reopening and the saved draft is consumed once',()=>{
 const ST={nodes:[]}, c=context(ST), cache=new Map();
 c.S={uid:'user'};c.PG={pending:new Map()};
 c.localStorage={setItem:(k,v)=>cache.set(k,v),getItem:k=>cache.get(k),removeItem:k=>cache.delete(k)};
 const draft='草稿'.repeat(5000);
 const n={id:'old',key:'chat:test',el:{querySelector:()=>({contentDocument:{querySelector:()=>({value:draft})}})}};
 c.pgProg=()=>({draft:'truncated',msg:4});c.stRememberPage(n);
 const reopened={id:'new',key:n.key};c.stRecallPage(reopened);
 assert.equal(reopened.prog.draft,draft);assert.equal(c.PG.pending.get('new').msg,4);
 const again={id:'another',key:n.key};c.stRecallPage(again);assert.equal(again.prog,undefined);
});
test('category tidy keeps the newest chats first and includes the exact age boundary',()=>{
 const now=Date.now(), day=86400000;
 for (const custom of [false,true]) {
  const rules=custom?{keep:1,days:1}:null;
  const nodes=[0,1,3,4,5].map((age,i)=>({key:'chat:'+i,id:String(i),group:'A',at:now-age*day,ord:i}));
  nodes.push({key:'chat:pm-a',group:'A'}, {key:'chat:b',group:'B'}, {file:true,key:'file:x',group:'A'});
  const closed=[];
  const c=vm.createContext({Date:{now:()=>now},ST_KEEP:5,localStorage:{getItem:()=>JSON.stringify(rules)},
   ST:{},ST_PADX:10,stWins:()=>nodes,stArena:()=>({w:1240}),stGroupOf:w=>({id:w.group}),
   recentItems:()=>[],stMapTime:w=>w.at,stRememberPage:()=>true,stClose:w=>closed.push(w.id),
   stKidKeep(){},stRender(){},stSave(){},stContexts(){},stListItems(){},window:{},toast(){},L:z=>z});
  vm.runInContext(source.slice(source.indexOf('function stTidyRules('),source.indexOf("document.addEventListener('click'",source.indexOf('function stTidyCategory('))),c);
  c.stTidyCategory('A');
  assert.deepEqual(closed,custom?['2','3','4']:['3','4']);
  assert.equal(nodes[0].small,false);assert.equal(nodes[1].small,custom);
  if (!custom) assert.equal(nodes[2].small,true);
  assert(nodes.slice(5).every(w=>w.small===undefined));
  nodes.forEach(w=>{if(w.at) w.at-=10*day;});
  closed.length=0;c.stTidyCategory('A');
  assert.deepEqual(closed,[]);
  assert(nodes.filter(w=>w.group==='A').every(w=>w.small));
  assert.equal(nodes.find(w=>w.group==='B').small,undefined);
  const restore=Array.from(c.ST.foldCatIds.A);
  c.stTidyCategory('A');
  assert.deepEqual(Array.from(c.ST.foldCatIds.A),restore);
  assert(nodes.filter(w=>w.group==='A').every(w=>w.small));
 }
});
test('fold picks nothing by default, managers included',()=>{
 const nodes=Array.from({length:5},(_,i)=>({id:String(i),key:String(i),type:'win',completedAt:i+1}));
 nodes.push({id:'m',key:'m',type:'win',managerProject:'A'});
 const c=vm.createContext({ST:{},stWins:()=>nodes,stGroupOf:()=>({id:'A'}),recentItems:()=>[]});
 vm.runInContext(source.slice(source.indexOf('const ST_KEEP ='),source.indexOf('function stMapSelection')),c);
 assert.equal(c.stFoldPick().folded.size,0);
 assert.equal(c.stFoldPick().total.get('A'),6);
});
