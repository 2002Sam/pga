import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('src/pga/web/app-stage.js','utf8');
function harness(branch=false) {
 const nodes=[{id:'a',key:'chat:a',type:'win',ord:0,bw:450},{id:'b',key:'chat:b',type:'win',ord:1,bw:500,pre:80},{id:'c',key:'chat:c',type:'win',ord:2,bw:420}];
 if(branch) {nodes[0].kids=['b'];nodes[0].sel='b';nodes[0].kw=500;nodes[1].par='a';nodes[1].branchKey='chat:b';}
 else {nodes[1].branchFrom='chat:a';nodes[1].branchParent='a';nodes[1].branchKey='chat:b';}
 for(const n of nodes)n.el={dataset:{nid:n.id},style:{},classList:{add(){},remove(){},toggle(){}},querySelector:()=>null,
  get offsetWidth(){return parseFloat(this.style.width);},offsetHeight:600};
 const svg={},ST={nodes,shift:0},arena={scrollLeft:0,clientWidth:1800,scrollWidth:5000};
 let ctx;
 const render=()=>{const {units}=ctx.stLayout();ST.units=units;ST.pos=new Map();
  for(const u of units) {if(u.hide)continue;const wins=u.kind==='win'?[u.win]:u.kind==='stack'?u.wins:[];
   for(const [i,n]of wins.entries()){const p={x:u.x,y:8+i*300,w:u.w,h:600/wins.length,...(u.kind==='stack'?{kid:true}:{})};ST.pos.set(n.id,p);Object.assign(n.el.style,{left:p.x+'px',top:p.y+'px',width:p.w+'px'});}
  }
 };
 ctx=vm.createContext({ST,ST_GAP:18,ST_CW:190,ST_PADX:12,ST_MINW:320,ST_WW:660,ST_FORKGAP:34,ST_TAB:150,ST_FIT:320,
  stArena:()=>({w:1800,h:700}),stSL:()=>0,stDock:()=>false,stKnowledgeUnits(){},stGroupOf:n=>({id:n.group || "one"}),stMap(){},stOver(){},stSave(){},stRender:render,
  stWins:()=>ST.nodes.filter(n=>n.type==='win').sort((a,b)=>a.ord-b.ord),stKids:n=>(n.kids||[]).map(id=>ST.nodes.find(n=>n.id===id)).filter(n=>!n.branchDocked),
  document:{querySelector:s=>ST.nodes.find(n=>s.includes(`"${n.id}"`))?.el,querySelectorAll:()=>[]},
  $:id=>id==='#stwires'?svg:id==='#starena'?arena:{classList:{add(){},toggle(){}}},requestAnimationFrame:()=>1,L:s=>s});
 for(const [start,end]of [['function stLayout()','/* ------------------------------------------------ drawing */'],['function stFreezeWidths()','function stEdgeHold('],['function stGroups(','function stDrop('],['function stBranchLine(','function stFrame('],['function stDetachBranch(','// A tucked branch']])vm.runInContext(source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start))),ctx);
 vm.runInContext(source.slice(source.indexOf('function stGroupHidden('),source.indexOf("document.addEventListener('click', e =>",source.indexOf('function stGroupHidden('))),ctx);
 render();return {ctx,ST,nodes,svg,render};
}
test('dragging through and back past neighbours keeps all widths, including on drop',()=>{
 for(const index of [0,1,2]){
  const h=harness(),n=h.nodes[index],original=h.nodes.map(n=>n.el.offsetWidth);
  h.ctx.stGrab(n,0,0);
  for(const dx of [80,200,550,-180,-600,0]){
   h.ctx.stDragTo(dx,0);
   assert.deepEqual(h.nodes.map(n=>n.el.offsetWidth),original);
   assert.match(h.svg.innerHTML,/stwire fork/);
  }
  h.ctx.stDragTo(180,0);h.ctx.stSettle(h.ST.drag);h.ST.drag=null;h.render();
  assert.deepEqual(h.nodes.map(n=>n.el.offsetWidth),original);
  h.ctx.stWires();assert.match(h.svg.innerHTML,/stwire fork/);
 }
});
test('detaching, moving, dropping and restoring a branch keeps its wire and every width',()=>{
 const h=harness(true),child=h.nodes[1],original=h.nodes.map(n=>n.el.offsetWidth);
 h.ctx.stDetachBranch(child);
 assert.deepEqual(h.nodes.map(n=>n.el.offsetWidth),original);
 assert.equal(child.branchParent,'a');
 h.ctx.stGrab(child,0,0);h.ctx.stDragTo(-500,0);
 assert.match(h.svg.innerHTML,/stwire fork/);
 assert.deepEqual(h.nodes.map(n=>n.el.offsetWidth),original);
 h.ctx.stSettle(h.ST.drag);h.ST.drag=null;h.render();h.ctx.stWires();
 assert.deepEqual(h.nodes.map(n=>n.el.offsetWidth),original);
 assert.match(h.svg.innerHTML,/stwire fork/);
 const saved=JSON.parse(JSON.stringify(h.ST.nodes.map(({el,...n})=>n)));
 for(const n of saved)n.el=h.nodes.find(o=>o.id===n.id).el;
 h.ST.nodes=saved;h.render();h.ctx.stWires();assert.match(h.svg.innerHTML,/stwire fork/);
 assert.deepEqual(h.nodes.map(n=>n.el.offsetWidth),original);
});
test('legacy detached snapshots with only source key still draw a connection',()=>{
 const h=harness();delete h.nodes[1].branchParent;h.ctx.stWires();assert.match(h.svg.innerHTML,/stwire fork/);
});
test('manual links stay visible after moving target to the left or overlapping source',()=>{
 const h=harness();delete h.nodes[1].branchParent;delete h.nodes[1].branchFrom;delete h.nodes[1].branchKey;
 h.nodes[1].links=[{from:'a',pin:0}];h.ctx.stPinY=p=>p.y+50;
 for(const x of [-600,10,1000]){h.ST.pos.get('b').x=x;h.ctx.stWires();assert.match(h.svg.innerHTML,/stwire link/);assert.ok(!h.svg.innerHTML.includes('NaN'));}
});
test('expanded pages use stage geometry and restore their original width',()=>{
 const h=harness(),n=h.nodes[1];n.big=true;h.render();
 assert.equal(h.ST.pos.get(n.id).w,1260);
 assert.equal(h.ST.pos.get('c').w,420);
 assert.ok(h.ST.pos.get('c').x >= h.ST.pos.get(n.id).x+1260);
 h.ctx.stWires();assert.match(h.svg.innerHTML,/stwire fork/);
 delete n.big;h.render();assert.equal(h.ST.pos.get(n.id).w,500);
 const css=fs.readFileSync('src/pga/web/app.css','utf8');
 assert.doesNotMatch(css, /\.stnode\.conversation-expanded\s*\{[^}]*position:\s*fixed/);
});
test('dragging a title upward does not silently enable enlargement',()=>{
 const h=harness();h.ctx.stGrab(h.nodes[1],0,0);h.ctx.stDragTo(60,-100);
 assert.ok(!h.ST.drag.up);assert.ok(!h.nodes[1].big);
});

test('category collapse and solo hide whole groups without losing windows or widths',()=>{
 const h=harness(true);h.nodes[0].group=h.nodes[1].group='one';h.nodes[2].group='two';
 const refs=h.nodes.map(n=>n.el), widths=h.nodes.map(n=>n.bw);
 h.ctx.stGroupToggle('one');
 assert.ok(!h.ST.pos.has('a'));assert.ok(!h.ST.pos.has('b'));assert.ok(h.ST.pos.has('c'));
 h.ctx.stGroupToggle('one',true);
 assert.ok(h.ST.pos.has('a'));assert.ok(h.ST.pos.has('b'));assert.ok(!h.ST.pos.has('c'));
 h.ctx.stGroupToggle('one',true);
 assert.equal(h.ST.pos.size,3);assert.deepEqual(h.nodes.map(n=>n.el),refs);assert.deepEqual(h.nodes.map(n=>n.bw),widths);
});
