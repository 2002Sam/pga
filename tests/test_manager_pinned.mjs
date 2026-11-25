import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root = new URL('../src/pga/web/', import.meta.url);
const pm = fs.readFileSync(new URL('app-stage-pm.js', root), 'utf8');
const stage = fs.readFileSync(new URL('app-stage.js', root), 'utf8');
const manager = (id, project, extra = {}) => ({id, type:'win', key:'chat:pm-'+id, managerProject:project, group:project, ...extra});
function setup(nodes = [manager('ma','A',{small:true}), {id:'a',type:'win',key:'chat:a',group:'A',bw:560}, manager('mb','B',{small:true})]) {
  const arena={clientWidth:1600,scrollWidth:4000,scrollLeft:0};
  const button={classList:{toggle(){}},setAttribute(){}};
  const c=vm.createContext({ST:{nodes,focus:'a'}, L:s=>s, performance:{now:()=>1000}, localStorage:{getItem:()=>null},
    stWins:()=>nodes, stGroupOf:w=>w.group?{id:'pj:'+w.group,name:w.group}:null, stHalfWidth:()=>779,
    $:q=>q==='#starena'?arena:q==='#stpmopen'?button:null, window:{mgOpen:name=>name}});
  vm.runInContext(pm,c);return {c,nodes,arena,button};
}
test('migration reuses manager pages and opens only the previous category manager',()=>{
  const {c,nodes}=setup();const draft={text:'keep this draft'};nodes[0].el={draft};
  c.stPmInit({v:5});
  assert.equal(nodes[0].small,false);assert.equal(nodes[2].small,true);
  assert.equal(nodes[0].bw,480);assert.equal(nodes[0].el.draft,draft);assert.equal(c.ST.pmCat,'pj:A');
  nodes[0].small=true;c.stPmInit({v:5,pmPages:1});assert.equal(nodes[0].small,true,'a newer saved fold must be respected');
});
test('migration preserves a collapsed old manager pane',()=>{
  const {c,nodes}=setup();c.localStorage.getItem=()=>JSON.stringify({shut:true});c.stPmInit({v:5});
  assert.ok(nodes.filter(n=>n.managerProject).every(n=>n.small));
});
test('manager belongs to the canvas and folding frees its width for conversations',()=>{
  const {c,nodes}=setup([manager('ma','A',{bw:480}),{id:'a',type:'win',key:'chat:a',group:'A',bw:560}]);
  Object.assign(c,{stArena:()=>({w:1600,h:900}),stKids:()=>[],stDock:()=>false,stGroupHidden:()=>false,
    stRootOf:n=>n,stKnowledgeUnits(){},stFoldPick:()=>({folded:new Set()}),ST_CW:190,ST_MINW:300,ST_WW:660,
    ST_LINE:6,ST_CATW:22,ST_GAP:18,ST_PADX:12,ST_FORKGAP:18,ST_FIT:560,ST_TAB:150});
  c.ST.shift=0;
  vm.runInContext(stage.slice(stage.indexOf('function stLayout()'),stage.indexOf('/* ------------------------------------------------ drawing */')),c);
  let result=c.stLayout();assert.equal(result.units.find(u=>u.kind==='win'&&u.win===nodes[0]).w,480);
  const before=result.units.find(u=>u.kind==='win'&&u.win===nodes[1]).x;
  nodes[0].small=true;result=c.stLayout();
  const after=result.units.find(u=>u.kind==='win'&&u.win===nodes[1]).x;
  assert.equal(before-after,480-6);assert.equal(result.units.find(u=>u.kind==='lines').wins[0],nodes[0]);
  nodes[0].small=false;result=c.stLayout();assert.equal(result.units.find(u=>u.kind==='win'&&u.win===nodes[0]).w,480);
});
test('manager entry follows focus without mounting or showing another manager',()=>{
  const {c,nodes,button}=setup();c.stPmRendered();assert.equal(c.ST.pmCat,'pj:A');
  c.stPmFollow(nodes[2]);assert.equal(c.ST.pmCat,'pj:B');assert.match(button.title,/B/);
  assert.equal(nodes[0].small,true);assert.equal(nodes[2].small,true);
  let opened;c.window.mgOpen=name=>(opened=name);button.onclick();assert.equal(opened,'B');
});
test('scroll changes only the manager entry; programmatic navigation does not change it',()=>{
  const {c,nodes,arena}=setup();c.ST.units=[{kind:'win',win:nodes[1],x:0,w:1000,open:true},{kind:'win',win:nodes[2],x:2000,w:1000,open:true}];
  c.ST.pmCat='pj:A';arena.scrollLeft=2400;c.ST.pmUserAt=-5000;c.stPmScrolled();assert.equal(c.ST.pmCat,'pj:A');
  c.stPmUser();c.stPmScrolled();assert.equal(c.ST.pmCat,'pj:B');assert.equal(nodes[2].small,true);
});
test('closed managers remain reachable from their project and empty stages hide the entry',()=>{
  const {c,nodes,button}=setup();nodes.splice(0,1);nodes.splice(1,1);c.stPmRendered();
  assert.equal(button.hidden,false);assert.equal(c.stPmGo(),'A');
  nodes.length=0;c.ST.units=[];c.ST.focus=null;c.stPmRendered();assert.equal(button.hidden,true);
});
test('restoring a saved page selects the manager for the restored viewport',()=>{
  const {c,nodes,arena,button}=setup();
  c.ST.pmCat='pj:A';c.ST.focus='a';
  c.ST.units=[{kind:'win',win:nodes[1],x:0,w:1000,open:true},{kind:'win',win:nodes[2],x:2000,w:1000,open:true}];
  const source=fs.readFileSync(new URL('app-pages.js',root),'utf8');
  Object.assign(c,{PG:{pending:new Map()},document:{querySelector:()=>null},
    _stSavePG(){},stRender(){},stContexts(){},stListItems(){},stMap(){},pgKick(){},stPadOut(){},
    requestAnimationFrame:fn=>fn()});
  vm.runInContext(source.slice(source.indexOf('function pgApply('),source.indexOf('function pgKick(')),c);
  c.pgApply({nodes,view:{sl:2400,focus:'a'}});
  assert.equal(arena.scrollLeft,2400);assert.equal(c.ST.pmCat,'pj:B');assert.match(button.title,/B/);
  assert.equal(nodes[2].small,true,'restoring context must not unfold its manager');
});
test('folding a manager preserves its document scroll, frame and unsent content',()=>{
  const {c,nodes}=setup();const n=nodes[0];delete n.small;
  const doc={scrollTop:412};const frame={contentDocument:{querySelector:q=>q==='#pmdoc'?doc:null},draft:'unsent'};
  n.el={querySelector:()=>frame};c.ST.focus=n.id;
  Object.assign(c,{requestAnimationFrame:fn=>fn(),document:{querySelector:()=>null},stRender(){doc.scrollTop=0;},stSave(){},stMap(){}});
  const frames=[];c.requestAnimationFrame=fn=>frames.push(fn);
  vm.runInContext(stage.slice(stage.indexOf('const ST_KSCROLL ='),stage.indexOf('function stCompletionTime(')),c);
  vm.runInContext(stage.slice(stage.indexOf('function stMini(n,'),stage.indexOf('function stClose(')),c);
  c.stMini(n,true);assert.equal(n.small,true);assert.equal(c.ST.focus,n.id);assert.equal(frame.draft,'unsent');
  c.stMini(n,false);while(frames.length)frames.shift()();
  assert.equal(doc.scrollTop,412);assert.equal(n.el.querySelector(),frame);assert.equal(n.bw,undefined);
});

test('the manager links to each answer in the shared feed and shows its status', () => {
  const c = { chatSend() {}, document: { addEventListener() {} }, window: {}, setInterval() {}, S: { chat: 'manager' }, L: (a) => a, esc: (s) => String(s ?? ''), agentLabel: (x) => x, md: (t) => '<p>' + t + '</p>' };
  vm.createContext(c); vm.runInContext(fs.readFileSync(new URL('app-pmdoc.js', root), 'utf8'), c);
  for (const run of ['first-answer', 'second-answer']) {
    const note = c.pdNoteHtml({ id: run, key: 'chat:summary-example-qa', run, st: 'done',
      conversationTitle: '知识问答和回应', body: '这是回复' });
    assert.match(note, /已完成/);
    assert.match(note, /data-pdgo="chat:summary-example-qa"/);
    assert.ok(note.includes(`data-pdrun="${run}"`));
    assert.doesNotMatch(note, /这是回复/);
  }
  const css = fs.readFileSync(new URL('app.css', root), 'utf8'), last = css.lastIndexOf('#pmdoc .pdnote {');
  assert.match(css.slice(last, css.indexOf('}', last)), /border:0 !important;.*background:none; box-shadow:none/);
});
