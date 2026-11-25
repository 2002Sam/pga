import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const manager=fs.readFileSync(new URL('../src/pga/web/app-manager.js',import.meta.url),'utf8');
const panel=fs.readFileSync(new URL('../src/pga/web/app-manager-panel.js',import.meta.url),'utf8');
const stage=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
function lookup(){
 const calls=[],resolvers=[];
 const c=vm.createContext({S:{uid:'u'},ST:{nodes:[]},Date,Promise,L:s=>s,
  api:(url,opts)=>{calls.push({url,opts});return new Promise((resolve,reject)=>resolvers.push({resolve,reject}));}});
 c.window=c;vm.runInContext(manager.slice(manager.indexOf('const pmManagerLookups ='),manager.indexOf('const pmOpening =')),c);
 return {c,calls,resolvers};
}
test('hover and repeated clicks share a lightweight manager lookup',async()=>{
 const h=lookup();const first=h.c.pmResolveManager('PGA'),second=h.c.pmResolveManager('PGA');
 assert.equal(first,second);assert.equal(h.calls.length,1);assert.equal(h.calls[0].opts.body.manager_only,true);
 h.resolvers[0].resolve({project:'PGA',manager:'chat:pm-pga'});await first;
 assert.equal(await h.c.pmResolveManager('PGA'),await first);assert.equal(h.calls.length,1);
});
test('manager identity cache is account scoped and a mounted renamed manager wins',async()=>{
 const h=lookup(),a=h.c.pmResolveManager('PGA');h.c.S.uid='other';const b=h.c.pmResolveManager('PGA');
 assert.equal(h.calls.length,2);assert.match(h.calls[1].url,/users\/other\//);
 h.resolvers[0].resolve({project:'PGA',manager:'chat:pm-old'});h.resolvers[1].resolve({project:'PGA',manager:'chat:pm-new'});
 await a;await b;assert.equal((await h.c.pmResolveManager('PGA')).manager,'chat:pm-new');
 h.c.ST.nodes=[{type:'win',managerProject:'Renamed',key:'chat:pm-original'}];
 assert.equal((await h.c.pmResolveManager('Renamed')).manager,'chat:pm-original');assert.equal(h.calls.length,2);
});
test('failed or invalid identity lookups can be retried',async()=>{
 const h=lookup();const bad=h.c.pmResolveManager('PGA');h.resolvers[0].resolve({manager:'chat:ordinary'});await assert.rejects(bad);
 const retry=h.c.pmResolveManager('PGA');assert.equal(h.calls.length,2);h.resolvers[1].resolve({project:'PGA',manager:'chat:pm-pga'});await retry;
});
test('toolbar chooses a visible conversation in its own category instead of offscreen focus',()=>{
 const nodes=[{id:'off',type:'win',group:'PGA'},{id:'visible',type:'win',group:'PGA'},{id:'other',type:'win',group:'Research'},{id:'manager',type:'win',group:'PGA',managerProject:'PGA'}];
 const c=vm.createContext({ST:{nodes,focus:'off',pos:new Map([['off',{x:0,w:400}],['visible',{x:1200,w:400}],['other',{x:1600,w:400}]])},document:{getElementById:()=>({scrollLeft:1000,clientWidth:1000})},stGroupOf:n=>({id:'pj:'+n.group})});
 vm.runInContext(panel.slice(panel.indexOf('function pmPanelStageSource('),panel.indexOf('window.pmPanelStageSource')),c);
 assert.equal(c.pmPanelStageSource('PGA').id,'visible');assert.equal(c.pmPanelStageSource('Research').id,'other');
 nodes[3].managerBeside='visible';c.ST.focus='manager';assert.equal(c.pmPanelStageSource('PGA').id,'visible');
});
test('repeated clicks on an already placed manager avoid layout, animation and iframe replacement',()=>{
 const frame={},m={id:'manager',type:'win',key:'chat:pm-a',managerProject:'PGA',managerBeside:'source',bw:400,el:frame},source={id:'source',type:'win',key:'chat:a'};
 let focus=0,loads=0;const c=vm.createContext({ST:{nodes:[m,source],pos:new Map([['manager',{x:12,w:400}],['source',{x:418,w:500}]])},$:()=>({scrollLeft:0,clientWidth:1200,scrollTo(){}}),
 stNavigationStop(){},stShiftStop(){},stEdgeWheel:{},stFocus:id=>{assert.equal(id,'manager');focus++;},stScheduleFrameLoads:()=>loads++,stLayout:()=>assert.fail('same slot must not relayout')});
 vm.runInContext(stage.slice(stage.indexOf('function stOpen(key, at)'),stage.indexOf('// Pages moved over by one')),c);
 assert.equal(c.stOpen(m.key,{win:'source',managerProject:'PGA',managerBeside:'source'}),m);
 assert.equal(m.el,frame);assert.equal(m.bw,400);assert.equal(focus,1);assert.equal(loads,1);
});
test('moving a category manager updates the toolbar category before rendering',()=>{
 const m={id:'manager',type:'win',key:'chat:pm-resume',managerProject:'简历投递',bw:400},source={id:'source',type:'win',key:'chat:resume'};
 let renders=0;const c=vm.createContext({ST:{nodes:[m,source],pmCat:'pj:PGA',focus:'old',pos:new Map()},performance,L:s=>s,
  $:()=>null,document:{querySelector:()=>null},stNavigationStop(){},stShiftStop(){},stEdgeWheel:{},stShiftMotion:null,
  stLayout:()=>({units:[]}),stFreezeWidths(){},stPmOffSet(){},stPmActivate(){},stWins:()=>[m,source],
  stGroupOf:()=>({id:'pj:简历投递'}),stRects:()=>new Map(),stSlide(){},stSave(){},stContexts(){},stScheduleFrameLoads(){},
  stPmIsManager:n=>!!n.managerProject,stPmName:id=>id?.startsWith('pj:')?id.slice(3):null,stPmButton(){},
  stRender(){renders++;assert.equal(c.ST.focus,'manager');assert.equal(c.ST.pmCat,'pj:简历投递');}});
 c.window=c;
 const pm=fs.readFileSync(new URL('../src/pga/web/app-stage-pm.js',import.meta.url),'utf8');
 vm.runInContext(pm.slice(pm.indexOf('function stPmFollow('),pm.indexOf('function stPmCats(')),c);
 vm.runInContext(stage.slice(stage.indexOf('function stOpen(key, at)'),stage.indexOf('// Pages moved over by one')),c);
 c.stOpen(m.key,{win:'source',managerProject:'简历投递',managerBeside:'source'});
 assert.equal(renders,1);assert.equal(c.ST.pmUserAt,0);
});
