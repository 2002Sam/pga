import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = name => fs.readFileSync(new URL('../src/pga/web/'+name,import.meta.url),'utf8');
test('input bursts measure only final text once per frame and ignore removed composers',()=>{
 const source=read('app-tree.js'),frames=[],seen=[];
 const c=vm.createContext({WeakSet,requestAnimationFrame:f=>frames.push(f),autoGrow:t=>seen.push(t.value)});
 vm.runInContext(source.slice(source.indexOf('const growPending'),source.indexOf('function autoGrow(t)')),c);
 const t={value:'',isConnected:true};for(let i=0;i<100;i++){t.value+='字';c.autoGrowSoon(t);}
 assert.equal(frames.length,1);frames.shift()();assert.deepEqual(seen,['字'.repeat(100)]);
 c.autoGrowSoon(t);t.isConnected=false;frames.shift()();assert.equal(seen.length,1);
 t.isConnected=true;t.value='';c.autoGrowSoon(t);frames.shift()();assert.equal(seen.at(-1),'');
});
test('timer mutations do not scan code blocks; new headers receive exactly one run button',()=>{
 let callback,scans=0,buttons=0;
 const body={querySelectorAll:()=>{scans++;return []}};
 const c=vm.createContext({document:{body},RUNNABLE:/javascript/,L:a=>a,MutationObserver:class{constructor(f){callback=f}observe(){}}});
 const src=read('app-more.js'),start=src.indexOf('function enhanceRunHeaders(');
 vm.runInContext(src.slice(start,src.indexOf('/* ------------------------------------------------ notes */',start)),c);
 scans=0;for(let i=0;i<100;i++)callback([{addedNodes:[{nodeType:3}]}]);assert.equal(scans,0);
 const hd={nodeType:1,isConnected:true,dataset:{},firstElementChild:{textContent:'javascript'},querySelectorAll:()=>[],matches(){return !this.dataset.run},contains:()=>false,insertAdjacentHTML:()=>buttons++};
 callback([{addedNodes:[hd,hd]}]);assert.equal(buttons,1);
 callback([{addedNodes:[hd]}]);assert.equal(buttons,1);
});
test('unwired horizontal scrolling does no sidebar scans or layout measurements',()=>{
 let marks=0,queries=[];const svg={innerHTML:''};
 const c=vm.createContext({ST:{nodes:[]},S:{view:'stage'},stRailMarks:()=>marks++,$:id=>{queries.push(id);return id==='#stover'?svg:{classList:{contains:()=>false}}}});
 const src=read('app-stage.js'),start=src.indexOf('function stOver(');
 vm.runInContext(src.slice(start,src.indexOf('document.addEventListener("pointerdown"',start)),c);
 for(let i=0;i<100;i++)c.stOver(false);
 assert.equal(marks,0);assert(!queries.includes('#stli'));assert(!queries.includes('#starena'));
 c.stOver();assert.equal(marks,1);
});
test('30-window map sorts history once per draw and retains DOM when unchanged',()=>{
 let reads=0,writes=0,html='';
 const inner={clientHeight:22,querySelectorAll:()=>[],querySelector:()=>null,get innerHTML(){return html},set innerHTML(v){writes++;html=v}};
 const els={'#starena':{scrollWidth:20000,clientWidth:1000},'#vStage':{},'#stmap':{clientWidth:500,clientHeight:30,dataset:{},style:{setProperty(){}}},'#stmi':inner};
 const nodes=Array.from({length:30},(_,i)=>({id:String(i),key:'chat:'+i,type:'win'}));
 const c=vm.createContext({ST:{nodes,pos:new Map(nodes.map((w,i)=>[w.id,{x:i*600,w:580}]))},S:{view:'stage'},$:id=>els[id],L:a=>a,esc:String,stWins:()=>nodes,stStat:()=>new Map(),stGroupOf:()=>null,stDraft:()=>'',stMapBand:()=>({top:0,height:1}),stMapView(){},recentItems:()=>{reads++;return nodes.map(w=>({item:w.key,title:'Title '+w.id}))}});
 const src=read('app-stage.js');vm.runInContext(src.slice(src.indexOf('function stMap()'),src.indexOf('// Use the same vertical projection')),c);
 c.stMap();assert.equal(reads,1);assert.equal(writes,1);assert(html.includes('Title 29'));
 c.stMap();assert.equal(reads,2);assert.equal(writes,1);
 c.ST.focus='1';c.stMap();assert.equal(writes,2);
});
test('reading checkpoint finds the same anchor in 4096 messages with at most 14 measurements',()=>{
 let measures=0;const topIndex=3500,off=25;
 const ms=Array.from({length:4096},(_,i)=>({classList:{contains:()=>i%2===0},getBoundingClientRect(){measures++;return {top:i*100-topIndex*100-off,bottom:(i+1)*100-topIndex*100-off}}}));
 const box={clientHeight:600,scrollHeight:409600,scrollTop:350025,getBoundingClientRect:()=>({top:0})};
 const d={querySelector:s=>s==='#cdlg'?box:{value:'草稿'},querySelectorAll:()=>ms};
 const n={id:'a',key:'k',el:{querySelector:()=>({contentDocument:d})}};
 const c=vm.createContext({PG:{pending:new Map()},recentItems:()=>[{item:'k',title:'Test',last:123}],stTitle:()=>{throw Error('unneeded title scan')}});
 const src=read('app-pages.js');vm.runInContext(src.slice(src.indexOf('function pgProg('),src.indexOf('function pgSnap(')),c);
 const p=c.pgProg(n);assert.equal(p.msg,topIndex);assert.equal(p.off,off);assert.equal(p.turns,2048);assert.equal(p.draft,'草稿');assert(measures<=14);
});
test('checkpoint is deferred through a scroll/input burst and stale idle jobs cannot save',()=>{
 const timers=new Map(),idles=new Map(),events={};let id=0,saves=0;
 const c=vm.createContext({PG:{ready:true},pgLocalSave:()=>saves++,setTimeout:f=>{timers.set(++id,f);return id},clearTimeout:i=>timers.delete(i),window:{requestIdleCallback:f=>{idles.set(++id,f);return id},cancelIdleCallback:i=>idles.delete(i)}});
 const src=read('app-pages.js');vm.runInContext(src.slice(src.indexOf('function pgScheduleCheckpoint('),src.indexOf('pgWatchScroll(document);')),c);
 c.pgWatchScroll({addEventListener:(k,f)=>events[k]=f});
 for(let i=0;i<100;i++)events.scroll();assert.equal(timers.size,1);assert.equal(saves,0);
 [...timers.values()][0]();timers.clear();const old=[...idles.values()][0];events.input();old();assert.equal(saves,0);
 [...timers.values()][0]();[...idles.values()][0]();assert.equal(saves,1);
});
test('drag pan batches pointer events, preserves end position and cancels pending frame on release',()=>{
 let id=0,writes=0;const frames=new Map(),arena={scrollWidth:10000,clientWidth:1000,_left:500,get scrollLeft(){return this._left},set scrollLeft(v){writes++;this._left=v},scrollTo({left}){this.scrollLeft=left}};
 const c=vm.createContext({ST:{},$:s=>s==='#starena'?arena:{classList:{add(){},remove(){}}},requestAnimationFrame:f=>{frames.set(++id,f);return id},cancelAnimationFrame:i=>frames.delete(i),stMapView(){},stMap(){}});
 const src=read('app-stage.js');vm.runInContext(src.slice(src.indexOf('function stPanStart('),src.indexOf('try { if (window.webkit')),c);
 c.stPanStart(1000);for(let x=999;x>=900;x--)c.stPanMove(x);assert.equal(frames.size,1);assert.equal(writes,0);
 [...frames.values()][0]();frames.clear();assert.equal(arena.scrollLeft,600);assert.equal(writes,1);
 c.stPanMove(850);c.stPanEnd();assert.equal(arena.scrollLeft,650);assert.equal(frames.size,0);assert.equal(c.ST.pan,null);
});
test('activity clock ticks leave historical sections untouched and tool changes update live section',()=>{
 let writes=0,clock=0;const section={set outerHTML(v){writes++}};const box={querySelector:()=>section};
 const c=vm.createContext({S:{view:'chats',sending:true,live:{run:{text:'a'}}},$:()=>box,liveSecs:()=>clock,L:a=>a,esc:String,agentLabel:String,parseSteps:t=>({steps:[{tool:t}],words:''})});
 const src=read('app-activity.js');vm.runInContext(src.slice(src.indexOf('function activityLiveHtml('),src.indexOf('function renderActivity(')),c);
 c.refreshActivityLive();assert.equal(writes,1);for(clock=1;clock<100;clock++)c.refreshActivityLive();assert.equal(writes,1);
 c.S.live.run.text='b';c.refreshActivityLive();assert.equal(writes,2);
});
