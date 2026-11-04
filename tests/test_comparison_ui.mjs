import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-more.js',import.meta.url),'utf8');
function harness(target='both',fail=false){
 const calls=[], box={value:'next question'}, key='chat:p';
 const S={chat:key,chatSplits:{[key]:{lanes:[{key:'second:left',agent:'a'},{key:'second:right',agent:'b'}]}},chatTurns:{},splitTargets:{[key]:target}};
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
test('continuation opens an independent stage tab with exact cutoff',async()=>{
 const source=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');let body,opened;
 const ctx=vm.createContext({window:{},S:{uid:'u'},api:async(u,o)=>{body=o.body;return{key:'chat:new'}},stOpen:(...a)=>{opened=a;return {}},stSave(){},stWires(){},toast(){}});
 vm.runInContext(source.slice(source.indexOf('async function stFork('),source.indexOf('// Opening an existing')),ctx);
 await ctx.window.stBranchAt({id:'parent'},'chat:p','reply-5');
 assert.deepEqual({...body},{from:'chat:p',upto:'reply-5'});assert.equal(opened[0],'chat:new');assert.equal(opened[1].win,'parent');
});
