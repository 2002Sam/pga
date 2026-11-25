import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('src/pga/web/app-stage-dock.js','utf8');
const c=vm.createContext({});vm.runInContext(source.slice(0,source.indexOf('function stDockStart')),c);
test('Dock reorder moves only selected item and leaves source list untouched',()=>{
 const a={id:'a'},b={id:'b'},d={id:'c'},xs=[a,b,d];
 assert.deepEqual(Array.from(c.stDockOrder(xs,b,2)),[a,d,b]);assert.deepEqual(xs,[a,b,d]);
 assert.deepEqual(Array.from(c.stDockOrder(xs,b,0)),[b,a,d]);
});
test('Dock slots clamp to first and last without losing or duplicating windows',()=>{
 const xs=[{id:1},{id:2},{id:3}];
 assert.deepEqual(Array.from(c.stDockOrder(xs,xs[1],-10)),[xs[1],xs[0],xs[2]]);
 assert.deepEqual(Array.from(c.stDockOrder(xs,xs[1],99)),[xs[0],xs[2],xs[1]]);
});

function overviewHarness(){
 const events={},windowEvents={},saved=[],renders=[];
 const element=()=>{const classes=new Set();return {style:{},dataset:{},offsetWidth:1200,inert:false,attrs:{},children:[],classList:{add:(...s)=>s.forEach(x=>classes.add(x)),remove:(...s)=>s.forEach(x=>classes.delete(x)),contains:s=>classes.has(s)},append(x){this.children.push(x);},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},getBoundingClientRect:()=>({left:20,top:10,width:600,height:500}),remove(){this.removed=true;},focus(){this.focused=true;}};};
 const stage=element(),body=element(),held=element(),hidden=element(),inert=element(),layer=element(),hint=element();
 held.querySelector=()=>body;inert.inert=true;held.classList.add('held','st-dock-held');hidden.classList.add('st-dock-muted');
 const nodes=[{id:'a',ord:0,big:true},{id:'b',ord:1},{id:'c',ord:2}],bars=nodes.slice(1).map(n=>({n,bar:element()}));
 const d={n:nodes[0],el:held,moved:false,dock:{layer,hint,bars,peers:nodes,slot:0,initial:0,scroll:60,width:1600,gap:260,gapIndex:0,styles:'original',hidden:[hidden,inert]}};
 const arena={scrollLeft:60};
 const context={ST:{nodes,drag:d,raf:0},window:{addEventListener:(name,fn)=>windowEvents[name]=fn},document:{createElement:element,addEventListener:(name,fn)=>events[name]=fn},L:a=>a,stGroupOf:n=>({id:n.group||'PGA'}),stTitle:key=>key||'对话',$:id=>id==='#vStage'?stage:arena,stSave:()=>saved.push(1),stRender:()=>renders.push(1),stMapNavigate:id=>context.ST.focus=id,matchMedia:()=>({matches:true}),cancelAnimationFrame(){}};
 vm.runInNewContext(source,context);return {context,d,stage,body,held,hidden,inert,layer,arena,saved,renders,events,windowEvents};
}
test('middle release keeps an independent overview, stops dragging and fits a maximized preview',()=>{
 const h=overviewHarness(),{context:c,d}=h;c.stDockRelease(d);
 assert.equal(c.ST.drag,null);assert.equal(c.ST.overview,d);assert.equal(d.dock.latched,true);
 assert.equal(h.layer.removed,undefined);assert.equal(h.layer.focused,true);assert(h.stage.classList.contains('overview'));
 assert(h.body.inert&&h.hidden.inert);assert.equal(h.saved.length,1);
 const scale=Number(h.held.style.transform.match(/[\d.]+/)[0]);assert(scale*h.held.offsetWidth<=d.dock.gap);
 const style={...h.held.style};c.stDockMove(d,5000,2000);assert.deepEqual(h.held.style,style);
 c.stDockRelease(d);assert.equal(h.saved.length,1,'release is idempotent');
 h.windowEvents.blur();assert.equal(c.ST.overview,d,'switching apps does not dismiss a released overview');
});
test('a completed reorder commits once; closing restores live pages and previous inert state',()=>{
 const h=overviewHarness(),{context:c,d}=h;d.moved=true;d.dock.slot=2;c.stDockRelease(d);
 assert.deepEqual(c.ST.nodes.map(n=>n.ord),[2,0,1]);c.stDockCancel();
 assert.equal(c.ST.overview,null);assert.equal(c.ST.drag,null);assert(h.layer.removed);
 assert.equal(h.hidden.inert,false);assert.equal(h.body.inert,false);assert.equal(h.inert.inert,true);
 assert(!h.held.classList.contains('held'));assert(!h.stage.classList.contains('overview'));assert.equal(h.held.attrs.style,'original');
 assert.equal(h.arena.scrollLeft,60);assert.equal(h.renders.length,1);assert.equal(c.ST.nodes[0].big,true);
 assert.deepEqual(c.ST.nodes.map(n=>n.ord),[2,0,1]);
});
test('thumbnail selection restores the stage before navigating, while Escape cancels an uncommitted drag',()=>{
 const h=overviewHarness(),{context:c,d}=h;c.stDockRelease(d);c.stDockPick('c');
 assert.equal(c.ST.overview,null);assert.equal(c.ST.focus,'c');assert(h.layer.removed);
 const k=overviewHarness();k.d.moved=true;k.d.dock.slot=2;
 k.events.keydown({key:'Escape',preventDefault(){},stopImmediatePropagation(){}});
 assert.equal(k.context.ST.drag,null);assert.deepEqual(k.context.ST.nodes.map(n=>n.ord),[0,1,2]);
});

const pointer=(x,y=100)=>({clientX:x,clientY:y,pointerId:1,preventDefault(){},stopImmediatePropagation(){}});
test('left drag in a latched overview reorders a thumbnail and keeps the overview open',()=>{
 const h=overviewHarness(),c=h.context,d=h.d;c.stDockRelease(d);
 const [a,b,z]=c.ST.nodes, centers=d.dock.centers;
 c.stDockReorderStart(d,b,pointer(centers.get(b)));
 c.stDockReorderMove(d,pointer(centers.get(z)+60));
 assert.deepEqual(c.ST.nodes.map(n=>n.ord),[0,1,2],'only visual positions change before release');
 c.stDockReorderEnd(d);
 assert.deepEqual(c.ST.nodes.map(n=>n.ord),[0,2,1]);assert.equal(c.ST.overview,d);
 assert.equal(h.renders.length,0);assert.equal(h.saved.length,2);assert.equal(h.layer.removed,undefined);
 let picked=false;c.stDockPick=()=>{picked=true;};
 h.events.click({target:{closest:()=>({dataset:{dockPick:'b'}})},preventDefault(){},stopImmediatePropagation(){}});
 assert.equal(picked,false,'the drag release must not navigate');
 assert.equal(d.dock.ignoreClick,false);
});
test('small pointer movement keeps click navigation and does not save a reorder',()=>{
 const h=overviewHarness(),c=h.context,d=h.d;c.stDockRelease(d);
 c.stDockReorderStart(d,c.ST.nodes[1],pointer(500));c.stDockReorderMove(d,pointer(503,102));c.stDockReorderEnd(d);
 assert.deepEqual(c.ST.nodes.map(n=>n.ord),[0,1,2]);assert.equal(h.saved.length,1);assert.equal(d.dock.ignoreClick,false);
 c.stDockPick('b');assert.equal(c.ST.focus,'b');assert.equal(c.ST.overview,null);
});
test('the enlarged preview is draggable too and repeated drags use the committed order',()=>{
 const h=overviewHarness(),c=h.context,d=h.d;c.stDockRelease(d);
 c.stDockReorderStart(d,d.n,pointer(d.dock.centers.get(d.n)));
 c.stDockReorderMove(d,pointer(1580));c.stDockReorderEnd(d);
 assert.deepEqual(c.ST.nodes.map(n=>n.ord),[2,0,1]);
 c.stDockReorderStart(d,d.n,pointer(d.dock.centers.get(d.n)));
 c.stDockReorderMove(d,pointer(12));c.stDockReorderEnd(d);
 assert.deepEqual(c.ST.nodes.map(n=>n.ord),[0,1,2]);
});
test('cancel or focus loss discards only the current drag, not an earlier reorder',()=>{
 const h=overviewHarness(),c=h.context,d=h.d;c.stDockRelease(d);
 const move=()=>{c.stDockReorderStart(d,d.n,pointer(d.dock.centers.get(d.n)));c.stDockReorderMove(d,pointer(1580));};
 move();h.events.pointercancel(pointer(1580));
 assert.deepEqual(c.ST.nodes.map(n=>n.ord),[0,1,2]);assert.equal(c.ST.overview,d);
 move();c.stDockReorderEnd(d);const saved=c.ST.nodes.map(n=>n.ord);
 c.stDockReorderStart(d,d.n,pointer(d.dock.centers.get(d.n)));c.stDockReorderMove(d,pointer(12));
 h.windowEvents.blur();assert.deepEqual(c.ST.nodes.map(n=>n.ord),saved);assert.equal(d.dock.reorder,null);
 c.stDockCancel();assert.deepEqual(c.ST.nodes.map(n=>n.ord),saved);
});
test('dragging branches reorders their siblings without detaching them or changing categories',()=>{
 const h=overviewHarness(),c=h.context,d=h.d,[a,b,z]=c.ST.nodes;
 b.par=z.par='parent';c.ST.nodes.push({id:'parent',kids:['b','c']},{id:'other',group:'other',ord:9});
 c.stDockRelease(d);c.stDockReorderStart(d,b,pointer(d.dock.centers.get(b)));c.stDockReorderMove(d,pointer(1580));c.stDockReorderEnd(d);
 assert.deepEqual(c.ST.nodes[3].kids,['c','b']);assert.equal(b.par,'parent');assert.equal(z.par,'parent');
 assert.equal(c.ST.nodes[4].ord,9);
});

test('cross-category middle drop carries manager, branches, folded and pinned siblings as one block',()=>{
 const h=overviewHarness(),c=h.context;
 const nodes=[{id:'ma',group:'A',managerProject:'A'},{id:'a',group:'A',kids:['ak']},{id:'ak',group:'A',par:'a'},
  {id:'af',group:'A',small:true,screenPin:{x:30,y:10}},{id:'b',group:'B'},{id:'b2',group:'B'},{id:'c',group:'C'}];
 nodes.forEach((n,i)=>n.ord=i);c.ST.nodes=nodes;
 const plan=c.stDockPlan(nodes,nodes[1],5);
 assert.deepEqual(Array.from(plan.order,n=>n.id),['b','b2','ma','a','ak','af','c']);
 assert.deepEqual(nodes.map(n=>n.ord),[0,1,2,3,4,5,6],'preview does not persist before drop');
 c.stDockCommit({n:nodes[1],moved:true,dock:{plan}});
 assert.deepEqual(nodes.slice().sort((a,b)=>a.ord-b.ord).map(n=>n.id),['b','b2','ma','a','ak','af','c']);
 assert.deepEqual(nodes.map(n=>n.group),['A','A','A','A','B','B','C']);
 assert.equal(nodes[2].par,'a');assert.deepEqual(nodes[1].kids,['ak']);assert.deepEqual(nodes[3].screenPin,{x:30,y:10});
 const back=c.stDockPlan(Array.from(plan.order),nodes[2],0);
 assert.deepEqual(Array.from(back.order,n=>n.id),['ma','a','ak','af','b','b2','c'],'a branch carries the whole category back');
});
test('cross-category preview never splits the target category and works for a lone source page',()=>{
 const h=overviewHarness(),c=h.context;
 const nodes=['a','b','b2','b3','c'].map((id,ord)=>({id,ord,group:id[0]}));c.ST.nodes=nodes;
 for(const slot of [0,1,2,3,4]){
  const plan=c.stDockPlan(nodes,nodes[4],slot),ids=Array.from(plan.order,n=>n.id);
  const i=ids.indexOf('b');assert.deepEqual(ids.slice(i,i+3),['b','b2','b3']);assert.equal(new Set(ids).size,5);
 }
 assert.deepEqual(Array.from(c.stDockPlan(nodes,nodes[4],0).order,n=>n.id),['c','a','b','b2','b3']);
});
test('time-mode and pinned drags cannot overwrite chronological ordering',()=>{
 const h=overviewHarness(),c=h.context,nodes=c.ST.nodes;
 c.ST.mapMode='time';const plan=c.stDockPlan(nodes,nodes[0],2);
 c.stDockCommit({n:nodes[0],moved:true,dock:{plan}});assert.deepEqual(nodes.map(n=>n.ord),[0,1,2]);
 c.ST.mapMode='cat';nodes[0].screenPin={x:10};
 assert.deepEqual(Array.from(c.stDockPlan(nodes,nodes[0],2).order),nodes);
});
