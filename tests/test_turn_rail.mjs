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
test('markers retain precise fork points and give each branch its own clickable tick',()=>{
 const h=harness(); h.context.convMap();
 assert.equal(h.box.hidden,false);
 assert.match(h.box.innerHTML,/data-point="r1"[^>]*data-kids="child"/);
 assert.match(h.box.innerHTML,/data-point="r2"[^>]*data-kids="newchild"/);
 for(const key of ['child','newchild']) assert.equal((h.box.innerHTML.match(new RegExp(`data-mchat="${key}"`,'g'))||[]).length,1);
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
test('branch ticks and tree rows share their own colour and open state without colouring the question tick',()=>{
 const element=key=>{const classes=new Set();return {dataset:{mchat:key},classList:{add:c=>classes.add(c),remove:c=>classes.delete(c),contains:c=>classes.has(c),toggle:(c,on)=>on?classes.add(c):classes.delete(c)},style:{props:{},setProperty(k,v){this.props[k]=v},removeProperty(k){delete this.props[k]}}};};
 const mark=element(''),open=element('open-kid'),closed=element('closed-kid');mark.classList.add('paired');
 const row={dataset:{kids:'open-kid,closed-kid'},querySelector:()=>mark,querySelectorAll:()=>[open,closed]};
 const tb=element('open-kid');
 const host={ST:{nodes:[{type:'win',key:'open-kid'},{type:'win',key:'closed-kid',branchDocked:true}]}};
 const ctx=vm.createContext({S:{chat:'me'},window:{parent:host},$:s=>s==='#cbr'?{querySelector:()=>null,querySelectorAll:()=>[tb]}:{querySelectorAll:()=>[row]}});
 vm.runInContext(src.slice(src.indexOf('function relOpen('),src.indexOf('let relSig')),ctx);
 vm.runInContext(src.slice(src.indexOf('function railPairColor('),src.indexOf('function railParentInfo(')),ctx);
 ctx.relPaint();
 assert.ok(!mark.classList.contains('paired'));assert.ok(open.classList.contains('open'));assert.ok(!closed.classList.contains('open'));
 assert.equal(open.style.props['--pair-color'],ctx.railPairColor('open-kid'));assert.equal(tb.style.props['--pair-color'],open.style.props['--pair-color']);assert.ok(tb.classList.contains('open'));
 host.ST.nodes[0].mini=true;ctx.relPaint();
 assert.ok(!open.classList.contains('open'));assert.ok(!tb.classList.contains('open'));
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
