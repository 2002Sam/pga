import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
function setup(){
 const timers=new Map(),clock={now:1e6};let next=0;
 const rect={left:0,right:1000,top:0,bottom:700};
 const c={L:s=>s,document:{hidden:false},performance:{now:()=>clock.now},ST:{nodes:[],focus:'first'},S:{view:'stage',allChats:[]},AS_UID:null,Q:new URLSearchParams(),URLSearchParams,window:{PG:{pending:new Map()},pgLocalSave(){}},stWins:()=>c.ST.nodes,stBusy:()=>false,stSave(){},pgProg:n=>n.prog||{msg:2,draft:''},$:()=>({getBoundingClientRect:()=>rect}),setTimeout:f=>{timers.set(++next,f);return next;},clearTimeout:id=>timers.delete(id)};
 vm.runInNewContext(source.slice(source.indexOf('function stScheduleFrameLoads('),source.indexOf('const ST_DBL_SKIP')),c);
 const frame=left=>({isConnected:true,attrs:{},events:new Set(),contentDocument:{URL:'about:blank',querySelector:()=>null},contentWindow:{getSelection:()=>({isCollapsed:true})},getBoundingClientRect:()=>({left,right:left+600,top:40,bottom:700,width:600,height:660}),setAttribute(k,v){this.attrs[k]=v;},hasAttribute(k){return k in this.attrs;},removeAttribute(k){delete this.attrs[k];},get src(){return this.attrs.src;},set src(v){this.attrs.src=v;},addEventListener(k,f){this.events.add(f);},removeEventListener(k,f){this.events.delete(f);}});
 const add=(id,left,loading=false)=>{
   const f=frame(left),label={},button={},box=loading?{dataset:{},hidden:true,querySelector:s=>s==='button'?button:label}:null;
   const n={id,type:'win',key:'chat:'+id,el:{isConnected:true,querySelector:s=>s==='iframe'?f:s==='.stloading'?box:null}};
   c.ST.nodes.push(n);c.stFrame(n,n.el);return {f,n,box,label,button};
 };
 const flush=()=>{const jobs=[...timers.values()];timers.clear();jobs.forEach(f=>f());};
 return {c,timers,rect,add,flush,clock};
}
test('restored offscreen conversations do not load until they are visible and scrolling settles',()=>{
 const {c,timers,rect,add,flush}=setup();const first=add('first',0),near=add('near',620),far=add('far',5000);
 assert(first.f.src);assert.equal(near.f.src,undefined);assert.equal(far.f.src,undefined);
 for(let i=0;i<30;i++)c.stScheduleFrameLoads();assert.equal(timers.size,1);
 flush();assert(near.f.src);assert.equal(far.f.src,undefined);assert.equal(c.stFrame.pending.size,1);
 rect.left=4800;rect.right=5800;c.stScheduleFrameLoads();flush();assert(far.f.src);assert.equal(c.stFrame.pending.size,0);
});
test('gliding and panning defer visible frame loads, including an already queued callback',()=>{
 const {c,timers,add,flush}=setup();const {f}=add('near',620),stale=[...timers.values()][0];
 c.ST.navigation={};c.stScheduleFrameLoads();assert.equal(timers.size,0);stale();assert.equal(f.src,undefined);
 c.ST.navigation=null;c.ST.pan={};c.stScheduleFrameLoads();assert.equal(timers.size,0);
 c.ST.pan=null;c.stScheduleFrameLoads();flush();assert(f.src);
});
test('wheel animation remains a load barrier even if a delayed frame made the movement clock old',()=>{
 const {c,add,timers,flush,clock}=setup();const {f}=add('near',620),stale=[...timers.values()][0];
 c.stShiftMotion={};c.ST.movedAt=clock.now-1000;c.stScheduleFrameLoads();
 assert.equal(timers.size,0);stale();assert.equal(f.src,undefined);
 c.stShiftMotion=null;c.stScheduleFrameLoads();flush();assert(f.src);
});
test('a page in view waits until the wheel glide has been still for a moment',()=>{
 const {c,timers,add,flush,clock}=setup();const {f}=add('near',620);
 c.ST.movedAt=clock.now;clock.now+=120;flush();assert.equal(f.src,undefined,'mid-glide: not yet');assert.equal(timers.size,1);
 clock.now+=200;flush();assert(f.src,'still since 320 ms: loads');
});
test('removed frames are discarded and replacing a deferred chat uses its latest URL',()=>{
 const {c,add,flush}=setup();const dead=add('dead',3000),changed=add('changed',620);
 dead.f.isConnected=false;changed.n.key='chat:new-key';c.stFrame(changed.n,changed.n.el);
 assert.equal(changed.f.events.size,1);flush();
 assert.match(changed.f.src,/chat%3Anew-key/);assert.equal(dead.f.src,undefined);assert.equal(c.stFrame.pending.size,0);
});
test('loaded frames can navigate immediately and load handlers use current restored state',()=>{
 const {c,add}=setup();const {n,f}=add('first',0),seen=[];
 n.key='chat:replacement';c.stFrame(n,n.el);assert.match(f.src,/replacement/);assert.equal(f.events.size,1);
 const restored={...n,side:false};c.ST.nodes=[restored];
 c.stHold=()=>{};c.stSide=x=>seen.push(x);c.stShortLook=()=>{};f.contentDocument={URL:'http://local/?embed=1'};f.contentWindow={};
 [...f.events][0]();assert.equal(seen[0],restored);
});
test('revisiting the same frame is idempotent, while an explicit retry reloads it',()=>{
 const {c,add}=setup();const {n,f}=add('first',0,true),pending=f._pgaLoading,handler=f._pgaStageLoad;
 c.stFrame(n,n.el);assert.equal(f._pgaLoading,pending);assert.equal(f._pgaStageLoad,handler);
 c.stFrame(n,n.el,true);assert.notEqual(f._pgaLoading,pending);assert.equal(f.events.size,1);
});
test('a second visible application waits for the first history to be ready',()=>{
 const {c,add,flush}=setup();const first=add('first',0,true),next=add('next',620,true);
 flush();assert.equal(next.f.src,undefined);
 first.f.contentDocument={URL:'http://local/?embed=1'};
 first.f.contentWindow.S={booted:true,chat:first.n.key,chatTurns:{[first.n.key]:[]}};
 c.stFrameWatch(first.f);flush();assert(next.f.src);
});
test('an offscreen slow load cannot block a newly visible page and concurrency stays bounded',()=>{
 const {c,add,flush,rect}=setup();const first=add('first',0,true),next=add('next',5000,true),third=add('third',10000,true);
 rect.left=4800;rect.right=5800;flush();assert(first.f._pgaLoading);assert(next.f.src,'foreground starts beside the old offscreen load');
 rect.left=9800;rect.right=10800;flush();assert.equal(third.f.src,undefined,'at most two documents boot even across rapid jumps');
 first.f.contentDocument={URL:'http://local/?embed=1'};
 first.f.contentWindow.S={booted:true,chat:first.n.key,chatTurns:{[first.n.key]:[]}};
 c.stFrameWatch(first.f);flush();assert(third.f.src,'new target resumes as soon as capacity is free');
});
test('a nearby cold page prewarms only after quiet time, never while a gesture is active',()=>{
 const {c,add,flush,clock}=setup();add('first',0);const near=add('nearby',1300),far=add('faraway',5000);
 c.ST.movedAt=clock.now-300;flush();assert.equal(near.f.src,undefined);
 c.ST.frameMoving=true;clock.now+=600;flush();assert.equal(near.f.src,undefined);
 c.ST.frameMoving=false;c.stScheduleFrameLoads();flush();assert(near.f.src);assert.equal(far.f.src,undefined);
});
test('a lone focused frame can run the scheduler without a pending queue',()=>{
 const {c,add,flush}=setup();const {f}=add('first',0);
 assert.equal(c.stFrame.pending,undefined);c.stScheduleFrameLoads();flush();assert(f.src);
});
test('distant idle frames checkpoint and suspend; active requests and selected text stay mounted',()=>{
 const {c,add,flush,rect}=setup();const focused=add('first',0),far=add('far',5000),busy=add('busy',6000),selected=add('selected',7000);
 busy.n.id='busy';selected.n.id='selected';selected.f.contentWindow.getSelection=()=>({isCollapsed:false});
 c.stBusy=n=>n.id==='busy';
 far.f.src='/conversation';busy.f.src='/busy';selected.f.src='/selected';
 flush();assert.equal(far.f.src,undefined);assert.equal(far.n._stageSuspended,true);assert.equal(far.n.prog.draft,'');
 assert.equal(busy.f.src,'/busy');assert.equal(selected.f.src,'/selected');assert(focused.f.src);
 rect.left=4800;rect.right=5800;c.stScheduleFrameLoads();flush();assert(far.f.src,'visible frame resumes');assert.equal(far.n._stageSuspended,undefined);
});
test('a 100-window canvas keeps only the viewport session resident after the quiet period',()=>{
 const {c,add,flush}=setup(),all=[];
 for(let i=0;i<100;i++){const x=add(i?'session-'+i:'first',i?5000+i*650:0);all.push(x);if(i)x.f.src='/loaded/'+i;}
 c.stScheduleFrameLoads();flush();
 const resident=all.filter(x=>x.f.hasAttribute('src'));
 assert.equal(resident.length,1,'the focused viewport session stays resident');
 assert.equal(all.filter(x=>x.n._stageSuspended).length,99);
});
test('queued work, attachments, long drafts, manager documents and focused editors remain mounted',()=>{
 const {c,add,flush}=setup();const keep=[];
 for(const [id,left] of [['first',0],['queued',5000],['attached',6000],['long',7000],['manager',8000],['editor',9000]]) keep.push(add(id,left));
 for(const x of keep.slice(1))x.f.src='/loaded/'+x.n.id;
 keep[1].f.contentWindow.S={uid:'u',followups:{'chat:queued':[{}]}};
 keep[2].f.contentWindow.S={att:[{name:'draft.pdf'}]};
 keep[3].f.contentDocument={querySelector:()=>({value:'x'.repeat(4001)})};
 keep[4].n.managerProject='project';
 keep[5].f.contentDocument={activeElement:{tagName:'TEXTAREA'}};
 c.stScheduleFrameLoads();flush();
 assert(keep.slice(1).every(x=>x.f.hasAttribute('src')));
 assert(keep.slice(1).every(x=>!x.n._stageSuspended));
});
test('nonempty live drafts stay resident and saved offscreen drafts boot after restore',()=>{
 const {c,add,flush}=setup();const saved=add('saved',5000),live=add('live',7000),restoring=add('restoring',9000);
 saved.n.prog={msg:1,draft:'restore this draft'};c.window.PG.pending.set(saved.n.id,saved.n.prog);
 live.f.src='/loaded/live';live.f.contentDocument={querySelector:()=>({value:'unsent now'})};
 restoring.f.src='/loaded/restoring';c.window.PG.pending.set(restoring.n.id,{draft:'pending restore'});
 c.stScheduleFrameLoads();flush();
 assert(saved.f.src,'offscreen frame carrying a saved draft boots');
 assert.equal(saved.n._stageSuspended,undefined);
 assert.equal(live.f.src,'/loaded/live','a nonempty live composer is not suspended');
 assert.equal(live.n._stageSuspended,undefined);
 assert(restoring.f.hasAttribute('src'),'a draft awaiting page restore is not suspended');
});
test('recently seen pages stay warm, capped at twelve offscreen documents and expire',()=>{
 const {c,add,flush,clock}=setup();add('first',0);const pages=[];
 for(let i=0;i<16;i++) {const x=add('warm-'+i,5000+i*700);x.f.src='/loaded/'+i;x.f._pgaSeenAt=clock.now-i*100;pages.push(x);}
 flush();assert.equal(pages.filter(x=>x.f.hasAttribute('src')).length,12);
 assert(pages.slice(0,12).every(x=>x.f.hasAttribute('src')),'most recently seen twelve remain');
 clock.now+=301000;flush();assert.equal(pages.filter(x=>x.f.hasAttribute('src')).length,0);
});
test('reading a page for several minutes still keeps it warm when leaving it',()=>{
 const {c,add,flush,clock,rect}=setup();const x=add('first',0);c.stScheduleFrameLoads();flush();
 clock.now+=300000;rect.left=5000;rect.right=6000;c.ST.focus='elsewhere';
 c.stScheduleFrameLoads();flush();assert(x.f.src);assert.equal(x.f._pgaSeenAt,clock.now);
 rect.left=0;rect.right=1000;c.stScheduleFrameLoads();flush();assert(x.f.src);assert(!x.n._stageSuspended);
});
test('a suspended focus waits for navigation to settle before its document restarts',()=>{
 const {c,add,flush}=setup();const {n,f}=add('first',0);
 f.removeAttribute('src');n._stageSuspended=true;c.ST.navigation={};
 c.stFrame(n,n.el);assert.equal(f.src,undefined);
 c.ST.navigation=null;c.stScheduleFrameLoads();flush();assert(f.src);assert(!n._stageSuspended);
});
test('visible pages load ahead of saved offscreen drafts, one document per batch',()=>{
 const {c,add,flush}=setup();const draft=add('draft',5000);draft.n.prog={draft:'saved'};
 const left=add('left',0),middle=add('middle',300),right=add('right',900);
 flush();assert(middle.f.src);assert(!left.f.src);assert(!right.f.src);assert(!draft.f.src);
 flush();assert(left.f.src);assert(!right.f.src);
 flush();assert(right.f.src);assert(!draft.f.src);
 flush();assert(draft.f.src);
});
test('loading stays visible until the requested conversation has data, including valid empty history',()=>{
 const {c,add}=setup();const {n,f,box,label}=add('first',0,true);
 assert.equal(box.hidden,false);assert.match(label.textContent,/打开页面/);
 f.contentDocument={URL:'http://local/?embed=1'};f.contentWindow.S={booted:true,chat:n.key,chatTurns:{}};
 c.stFrameWatch(f);assert.equal(box.hidden,false,'HTML loaded, history still missing');
 f.contentWindow.S.chatTurns[n.key]=[];c.stFrameWatch(f);
 assert.equal(box.hidden,true);assert.equal(f.attrs['aria-busy'],'false');assert.equal(f._pgaLoading,null);
});
test('slow/error states offer retry and a late successful response clears the placeholder',()=>{
 const {c,add,clock}=setup();const {n,f,box,button}=add('first',0,true);
 clock.now+=8100;c.stFrameWatch(f);assert.equal(box.dataset.state,'slow');assert.equal(button.hidden,false);
 f.contentDocument={URL:'http://local/?embed=1'};
 f.contentWindow.S={booted:true,chat:n.key,chatTurns:{},chatLoadErrors:{[n.key]:'offline'}};
 c.stFrameWatch(f);assert.equal(box.dataset.state,'error');assert.equal(button.hidden,false);
 delete f.contentWindow.S.chatLoadErrors[n.key];f.contentWindow.S.chatTurns[n.key]=[];
 c.stFrameWatch(f);assert.equal(box.hidden,true);assert.equal(button.hidden,true);
});
test('previous documents and other conversations cannot clear a new load; removed frames stop watching',()=>{
 const {c,add,timers}=setup();const {n,f,box}=add('first',0,true);
 f.contentDocument={URL:'http://local/?embed=1'};f.contentWindow.S={booted:true,chat:n.key,chatTurns:{[n.key]:[]}};
 c.stFrame(n,n.el,true);c.stFrameWatch(f);assert.equal(box.hidden,false,'old document is still showing');
 f.contentDocument={URL:'http://local/?embed=1'};f.contentWindow.S.chat='chat:other';c.stFrameWatch(f);assert.equal(box.hidden,false);
 f.isConnected=false;c.stFrameWatch(f);assert.equal(timers.size,0);
});
test('imported, tree and new conversations also finish their loading UI',()=>{
 for(const kind of ['imported','tree','new']) {
   const {c,add}=setup();const {n,f,box}=add('first',0,true);n.key=kind==='new'?null:'item:'+kind;
   f.contentDocument={URL:'http://local/?embed=1',querySelector:()=>({})};f.contentWindow.S={booted:true};
   if(kind==='imported')Object.assign(f.contentWindow.S,{imp:{key:n.key,cid:'i1'},impData:{id:'i1',turns:[]}});
   if(kind==='tree')f.contentWindow.S.treeItem={item:n.key};
   c.stFrameWatch(f);assert.equal(box.hidden,true,kind);
 }
});
test('unchanged environment visibility does not rerender a loaded transcript',()=>{
 let side=false,draws=0;
 const f={contentDocument:{documentElement:{classList:{contains:()=>side,toggle:(_,v)=>side=v}}},contentWindow:{S:{booted:true},renderChat:()=>draws++}};
 const c={document:{querySelector:()=>f}};
 vm.runInNewContext(source.slice(source.indexOf('function stSide(n)'),source.indexOf('/* ------------------------------------------------ moving:',source.indexOf('function stSide(n)'))),c);
 c.stSide({id:'a',side:false});assert.equal(draws,0);
 c.stSide({id:'a',side:true});assert.equal(draws,1);
 c.stSide({id:'a',side:true});assert.equal(draws,1);
 f.contentWindow.S.booted=false;c.stSide({id:'a',side:false});assert.equal(side,false);assert.equal(draws,1);
});

test('retrying a history error reuses the live document, draft and attachments',()=>{
 const {c,add}=setup();const {n,f}=add('first',0,true),doc={URL:'http://local/?embed=1'},calls=[];
 f.contentDocument=doc;f.contentWindow.S={booted:true,chat:n.key,chatTurns:{},att:[{name:'keep.png'}]};
 f.contentWindow.draft='unsent draft';f.contentWindow.loadChat=(...args)=>calls.push(args);
 const url=f.src;c.stFrameRetry(n);
 assert.equal(f.src,url);assert.equal(f.contentDocument,doc);assert.equal(f.contentWindow.draft,'unsent draft');
 assert.equal(f.contentWindow.S.att[0].name,'keep.png');assert.equal(calls[0][0],n.key);assert.equal(calls[0][1].force,true);
});
test('cached readable history remains visible when a refresh fails',()=>{
 const {c,add}=setup();const {n,f,box}=add('first',0,true);
 f.contentDocument={URL:'http://local/?embed=1'};
 f.contentWindow.S={booted:true,chat:n.key,chatTurns:{[n.key]:[{text:'cached'}]},chatLoadErrors:{[n.key]:'offline'}};
 c.stFrameWatch(f);assert.equal(box.hidden,true);
});
test('data awaiting a deferred paint does not prematurely dismiss the loading UI',()=>{
 const {c,add}=setup();const {n,f,box}=add('first',0,true);
 f.contentDocument={URL:'http://local/?embed=1'};
 f.contentWindow.S={booted:true,chat:n.key,chatTurns:{[n.key]:[]},stageChatRenderPending:{}};
 c.stFrameWatch(f);assert.equal(box.hidden,false);assert.equal(box.dataset.phase,'paint');
 f.contentWindow.S.stageChatRenderPending=null;c.stFrameWatch(f);assert.equal(box.hidden,true);
});
