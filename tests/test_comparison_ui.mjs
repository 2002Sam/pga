import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-more.js',import.meta.url),'utf8');
function harness(target='both',fail=false){
 const calls=[], box={value:'next question'}, key='chat:p';
 const S={agents:[],chat:key,chatSplits:{[key]:{lanes:[{key:'second:left',agent:'a'},{key:'second:right',agent:'b'}]}},chatTurns:{},splitTargets:{[key]:target}};
 const ctx=vm.createContext({window:{addEventListener(){}},S,document:{addEventListener(){}},$(){return box},composerBusy:()=>false,takeAtts:()=>({images:[],files:[]}),startLive(){},stopLive(){},renderChat(){},loadChat:async()=>{},drainFollowups:async()=>{},L:x=>x,esc:x=>String(x),agentLabel:x=>x,chatTurnsHtml:(xs,key)=>key,
 api:async(url,opts)=>{calls.push([url,opts]);if(opts?.body){if(fail&&opts.body.agent==='a')throw Error('left failed');return {ok:true}}return {turns:[{role:'agent',text:'answer'}]}}});
 vm.runInContext(src.slice(src.indexOf('/* Branch is a persistent')),ctx);return {ctx,S,calls,box};
}
test('one input goes to two stable lane identities with distinct agents',async()=>{
 const h=harness();await h.ctx.splitSend();
 const bodies=h.calls.filter(x=>x[1]?.body).map(x=>x[1].body);
 assert.deepEqual(bodies.map(b=>b.conversation),['second:left','second:right']);
 assert.deepEqual(bodies.map(b=>b.agent),['a','b']);
 assert.ok(bodies.every(b=>b.text==='next question'&&!('history'in b))); // server controls history
 assert.equal(h.S.sending,false);assert.equal(h.box.value,'');
});
test('failure on one side does not discard the other answer',async()=>{
 const h=harness('both',true);await h.ctx.splitSend();
 assert.equal(h.S.splitErrors['second:left'],'left failed');
 assert.equal(h.S.chatTurns['second:right'][0].text,'answer');assert.equal(h.S.sending,false);
});
test('user can continue only one side',async()=>{
 const h=harness('second:right');await h.ctx.splitSend();
 assert.deepEqual(h.calls.filter(x=>x[1]?.body).map(x=>x[1].body.agent),['b']);
});
test('comparison renders exactly two panes within the parent',()=>{
 const h=harness();const html=h.ctx.splitHtml([]);
 assert.equal((html.match(/class="split-lane"/g)||[]).length,2);
 assert.ok(html.includes('data-split-target'));assert.ok(html.includes('second:left'));assert.ok(html.includes('second:right'));
});
test('stage Branch delegates to its existing frame and opens no window',async()=>{
 const source=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');let starts=0;
 const ctx=vm.createContext({window:{},toast(){}});
 vm.runInContext(source.slice(source.indexOf('async function stFork('),source.indexOf('// Opening an existing')),ctx);
 await ctx.stFork({el:{querySelector:()=>({contentWindow:{startSplit:async()=>{starts++}}})}});
 assert.equal(starts,1);
});
test('continuation stands a page beside its source at once, then turns it to the branch without reloading it',async()=>{
 const source=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');let body,opened,turned,resolve;
 const child={id:'kid'};
 const ctx=vm.createContext({window:{},S:{uid:'u'},ST:{nodes:[child]},store:{set(){}},api:(u,o)=>{body=o.body;return new Promise(r=>resolve=r);},stOpen:(...a)=>{opened=a;return child},stSave(){},stWires(){},toast(){},stRender(){}});
 vm.runInContext(source.slice(source.indexOf('async function stFork('),source.indexOf('// Opening an existing')),ctx);
 ctx.stTurnTo=(n,k)=>{turned=[n.id,k];};
 const done=ctx.window.stBranchAt({id:'parent'},'chat:p','reply-5');
 assert.equal(opened[0],null,'the page stands before the server has made the branch');assert.deepEqual({...opened[1]},{win:'parent',pending:true,branchFrom:'chat:p'});
 assert.ok(ctx.ST.stageOpen.has('parent')&&ctx.ST.stageOpen.has('kid'),'neither the source nor the new page folds to make room');
 assert.equal(turned,undefined);
 resolve({key:'chat:new',upto:'reply-5',title:'T'});await done;
 assert.deepEqual({...body},{from:'chat:p',upto:'reply-5'});assert.deepEqual(turned,['kid','chat:new']);
 assert.equal(child.key,'chat:new');assert.equal(child.branchKey,'chat:new');assert.equal(child.from,'chat:p');
});
test('a failed continuation takes its page away again',async()=>{
 const source=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');let msg;
 const child={id:'kid'},parent={id:'parent'};
 const ctx=vm.createContext({window:{},S:{uid:'u'},ST:{nodes:[parent,child],focus:'kid'},store:{set(){}},api:async()=>{throw new Error('nope');},stOpen:()=>child,stSave(){},stWires(){},toast:m=>msg=m,stRender(){}});
 vm.runInContext(source.slice(source.indexOf('async function stFork('),source.indexOf('// Opening an existing')),ctx);
 await ctx.window.stBranchAt(parent,'chat:p','reply-5');
 assert.deepEqual(ctx.ST.nodes.map(n=>n.id),['parent']);assert.equal(ctx.ST.focus,'parent');assert.equal(msg,'nope');
});
test('the waiting page turns to the branch in place: before it has started, its own start loads it; after, it loads now',async()=>{
 const source=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
 const timers=[];let framed=0;
 const ctx=vm.createContext({window:{},S:{},ST:{nodes:[]},setTimeout:f=>timers.push(f),stTitle:k=>'title of '+k,stFrame:()=>framed++,URLSearchParams});
 vm.runInContext(source.slice(source.indexOf('async function stFork('),source.indexOf('// Opening an existing')),ctx);
 const page=(booted)=>{const classes=new Set(['stpending']),title={textContent:''},cw={S:undefined,location:{search:'?view=chats&embed=1'},history:{replaceState:(a,b,u)=>cw.url=u},loadChat:async k=>{cw.loaded=k;cw.S.chatTurns[k]=[];},renderChat:()=>cw.rendered=true};
  const f={contentWindow:cw},el={isConnected:true,classList:{remove:c=>classes.delete(c),has:c=>classes.has(c)},querySelector:s=>s==='iframe'?f:title};
  return {n:{id:'k',key:'chat:b',el},cw,classes,title,boot:()=>{cw.S={chatTurns:{},booted:false};}};};
 // still starting: nothing to set yet, then its S appears before it has shown anything
 const a=page();ctx.stTurnTo(a.n,'chat:b');assert.equal(a.title.textContent,'title of chat:b');
 assert.equal(timers.length,1);a.boot();timers.shift()();
 assert.equal(a.cw.S.chat,'chat:b');assert.equal(a.cw.S.scrollChat,true);assert.match(a.cw.url,/c=chat%3Ab/);assert.equal(a.cw.loaded,undefined,'its own start loads it');
 assert.ok(a.classes.has('stpending'));a.cw.S.booted=true;a.cw.S.chatTurns['chat:b']=[];timers.shift()();
 assert.equal(a.classes.has('stpending'),false,'shown once its conversation is there');assert.equal(framed,0,'never reloaded');
 // already started: loaded at once
 const b=page();b.boot();b.cw.S.booted=true;ctx.stTurnTo(b.n,'chat:b');await new Promise(r=>setImmediate(r));
 assert.equal(b.cw.loaded,'chat:b');assert.equal(b.cw.rendered,true);assert.equal(b.classes.has('stpending'),false);assert.equal(framed,0);
});
