import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-more.js',import.meta.url),'utf8');
function harness() {
 const box={classList:{add(){},remove(){}},innerHTML:'',hidden:true};
 const S={view:'chats',chat:'source',chatTurns:{source:[{role:'user',run:'r1',text:'<question>'},{role:'agent',run:'r1',text:'answer'},{role:'user',run:'r2',text:'next'},{role:'agent',run:'r2',text:'next answer'}]},chatKids:{source:[{key:'child',upto:'r1',title:'child title'}]}};
 const host={ST:{nodes:[{key:'child',branchFrom:'source',branchPoint:'r1',tag:'A'},{key:'newchild',branchFrom:'source',branchPoint:'r2',tag:'B'}]}};
 const context=vm.createContext({S,window:{parent:host},$:()=>box,document:{querySelectorAll:()=>[]},L:z=>z,agentLabel:x=>x,hideRailTip(){},syncMap(){},requestAnimationFrame(){},convMapWires(){},esc:x=>String(x).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;')});
 vm.runInContext(src.slice(src.indexOf('function railPairColor('),src.indexOf('function railParentInfo(')),context);
 vm.runInContext(src.slice(src.indexOf('function convMapKids('),src.indexOf('// The stage uses')),context);
 vm.runInContext(src.slice(src.indexOf('function convMap()'),src.indexOf("document.addEventListener('contextmenu'",src.indexOf('function convMap()'))),context);
 return {context,S,box};
}
test('markers retain precise fork points and name their branches, with no bar of their own',()=>{
 const h=harness(); h.context.convMap();
 assert.equal(h.box.hidden,false);
 assert.match(h.box.innerHTML,/data-point="r1"[^>]*data-kids="child"/);
 assert.match(h.box.innerHTML,/data-point="r2"[^>]*data-kids="newchild"/);
 assert.doesNotMatch(h.box.innerHTML,/railbranch|data-mchat=/);
 assert.match(h.box.innerHTML,/data-preview-title="&lt;question>" data-preview="answer"/);
 assert.doesNotMatch(h.box.innerHTML,/class="railbranches"/);
 assert.match(h.box.innerHTML,/data-kidtitles="child title"/);
});
test('branches before the first question receive a start marker',()=>{
 const h=harness(); h.S.chatKids.source.push({key:'empty',upto:'0'}); h.context.convMap();
 assert.match(h.box.innerHTML,/data-point="0"[^>]*data-kids="empty"/);
});
test('switching to an empty conversation clears old markers',()=>{
 const h=harness(); h.context.convMap();h.S.chat='empty';h.context.convMap();
 assert.equal(h.box.hidden,true);assert.equal(h.box.innerHTML,'');
});

test('every sibling is named once on the row it grew from, including inherited origins',()=>{
 const h=harness();h.S.chatKids.source.push({key:'sibling',upto:'r1',title:'second branch'},{key:'inherited',upto:'old-run',title:'from history'});h.context.convMap();
 const named=[...h.box.innerHTML.matchAll(/data-kids="([^"]*)"/g)].flatMap(m=>m[1].split(','));
 for(const key of ['child','newchild','sibling','inherited']) assert.equal(named.filter(k=>k===key).length,1);
});
test('an open branch lends its colour to the turn it grew from and to its row in the tree; a closed one does not',()=>{
 const mark={classList:new Set(),style:{props:{},setProperty(k,v){this.props[k]=v},removeProperty(k){delete this.props[k]}}};
 mark.classList.toggle=(c,on)=>on?mark.classList.add(c):mark.classList.delete(c);
 const row={dataset:{kids:'open-kid,closed-kid'},querySelector:()=>mark};
 const tb={dataset:{mchat:'open-kid'},classList:new Set(),style:mark.style};tb.classList.toggle=(c,on)=>on?tb.classList.add(c):tb.classList.delete(c);tb.classList.contains=c=>tb.classList.has(c);
 const host={ST:{nodes:[{type:'win',key:'open-kid'},{type:'win',key:'closed-kid',branchDocked:true}]}};
 const ctx=vm.createContext({S:{chat:'me'},window:{parent:host},$:s=>s==='#cbr'?{querySelectorAll:()=>[tb]}:{querySelectorAll:()=>[row]}});
 vm.runInContext(src.slice(src.indexOf('function relOpen('),src.indexOf('let relSig')),ctx);
 vm.runInContext(src.slice(src.indexOf('function railPairColor('),src.indexOf('function railParentInfo(')),ctx);
 ctx.relPaint();
 assert.ok(mark.classList.has('paired'));assert.equal(mark.style.props['--pair-color'],ctx.railPairColor('open-kid'));assert.ok(tb.classList.has('open'));
 host.ST.nodes[0].mini=true;ctx.relPaint();
 assert.ok(!mark.classList.has('paired'));assert.ok(!tb.classList.has('open'));
});
test('each child wire joins its own tick, even at a shared or inherited fork',()=>{
 const tick=(key,y)=>({dataset:{mchat:key},getBoundingClientRect:()=>({right:98,top:y,height:8})});
 const box={hidden:false,querySelectorAll:s=>s==='[data-mchat]'?[tick('a',40),tick('b',48)]:[],getBoundingClientRect:()=>({top:20,bottom:100,right:100})};
 const ctx={window:{},$:()=>box};vm.createContext(ctx);
 vm.runInContext(src.slice(src.indexOf('window.convMapAnchor ='),src.indexOf('function convMapWires()')),ctx);
 assert.equal(ctx.window.convMapAnchor('same','a').y,44);
 assert.equal(ctx.window.convMapAnchor('same','b').y,52);
 assert.equal(ctx.window.convMapAnchor(null,'a').x,98);
 assert.equal(ctx.window.convMapAnchor('missing','none'),null);
});
