import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync('src/pga/web/app-model-rail.js','utf8');
function setup(){
 const options={models:[{id:'gpt-6-astra',efforts:[{id:'medium'},{id:'high'}]}],default_model:'gpt-6-astra',default_effort:'medium'};
 const S={chat:'chat:a',chatAgent:'codex',agentOpts:{codex:options},agents:[{name:'codex'},{name:'chatgpt'}],chatModel:{},chatEffort:{},view:'chats'};
 const window={parent:{},addEventListener(){}},values=new Map();let renders=0;
 const ctx=vm.createContext({S,window,localStorage:{getItem:k=>values.get(k)},store:{set(){}},api:async()=>options,rerenderComposer:()=>renders++,setInterval(){},console});
 vm.runInContext(src,ctx);return {ctx,S,window,values,get renders(){return renders;}};
}
const p={label:'Codex high',agent:'codex',model:'gpt-6-astra',effort:'high'};
test('presets include all nine requested choices and safely recover invalid storage',()=>{
 const h=setup();assert.equal(vm.runInContext('mrPresets().length',h.ctx),9);
 h.values.set('pga_model_presets_v1','invalid');assert.equal(vm.runInContext('mrPresets().length',h.ctx),9);
 h.values.set('pga_model_presets_v1',JSON.stringify([p]));assert.equal(vm.runInContext('mrPresets()[0].effort',h.ctx),'high');
});
test('selection changes the active conversation and preserves other conversation settings',async()=>{
 const h=setup();h.S.chatEffort['chat:b']='medium';await h.window.mrApply(p);
 assert.equal(h.S.chatEffort['chat:a'],'high');assert.equal(h.S.chatEffort['chat:b'],'medium');assert.equal(h.renders,1);
});
test('unsupported effort and missing agents do not change settings',async()=>{
 const h=setup();await assert.rejects(h.window.mrApply({...p,effort:'invalid'}));await assert.rejects(h.window.mrApply({...p,agent:'missing'}));assert.equal(h.renders,0);
});
test('delayed options cannot apply to another conversation',async()=>{
 const h=setup();let finish;h.ctx.api=()=>new Promise(r=>finish=r);
 const pending=h.window.mrApply({...p,agent:'chatgpt'});h.S.chat='chat:b';finish(h.S.agentOpts.codex);assert.equal(await pending,false);assert.equal(h.renders,0);
});
test('last choice wins when earlier requests finish late',async()=>{
 const h=setup();let finish;h.ctx.api=()=>new Promise(r=>finish=r);
 const pending=h.window.mrApply({...p,agent:'chatgpt'});await h.window.mrApply(p);finish(h.S.agentOpts.codex);assert.equal(await pending,false);assert.equal(h.S.chatAgent,'codex');
});

test('each conversation targets itself, regardless of the stage selection',()=>{
 const a=setup(),b=setup();
 assert.equal(vm.runInContext('mrTarget()',a.ctx),a.window);
 assert.equal(vm.runInContext('mrTarget()',b.ctx),b.window);
 a.S.view='stage';assert.equal(vm.runInContext('mrTarget()',a.ctx),null);
});
test('rail anchors to the conversation left edge in narrow viewports',()=>{
 const h=setup();
 const p=vm.runInContext('mrPosition({left:0,top:180,height:80},520,400)',h.ctx);
 assert.equal(p.left,4);assert.equal(p.top,220);
 const small=vm.runInContext('mrPosition({left:20,top:0,height:200},240,180)',h.ctx);
 assert.equal(small.left,24);assert.ok(small.height<=180);
});

test('wide and short frames both anchor to the conversation left',()=>{
 const h=setup();
 assert.equal(vm.runInContext('mrPosition({left:680,top:80,height:80},720,500).left',h.ctx),684);
 assert.equal(vm.runInContext('mrPosition({left:680,top:80,height:80},720,250).left',h.ctx),684);
});

test('single preset clears saved multi-answer mode before selection',async()=>{
 const h=setup(),calls=[];h.S.uid='u';h.S.multi=['codex','chatgpt'];h.S.chatMulti={'chat:a':['codex','chatgpt'],'chat:b':['claude','codex']};
 h.ctx.api=async(url,options)=>{calls.push({url,options});return {agents:[]};};
 await h.window.mrApply(p);
 assert.equal(calls.length,1);assert.equal(calls[0].url,'/v1/users/u/chat-multi');
 assert.equal(calls[0].options.body.key,'chat:a');assert.equal(calls[0].options.body.agents.length,0);
 assert.equal(h.S.multi.length,0);assert.equal(h.S.chatMulti['chat:a'].length,0);assert.equal(h.S.chatMulti['chat:b'].length,2);
});
test('failed persistence does not falsely display single mode',async()=>{
 const h=setup();h.S.multi=['codex','chatgpt'];h.ctx.api=async()=>{throw Error('offline');};
 await assert.rejects(h.window.mrApply(p),/offline/);assert.equal(h.S.multi.length,2);assert.equal(h.renders,0);
});
test('clearing multi on one chat does not clear a newly selected chat',async()=>{
 const h=setup();h.S.multi=['codex','chatgpt'];let finish;h.ctx.api=()=>new Promise(r=>finish=r);
 const pending=h.window.mrApply(p);h.S.chat='chat:b';h.S.multi=['claude','deepseek'];finish({agents:[]});
 assert.equal(await pending,false);assert.deepEqual(h.S.multi,['claude','deepseek']);assert.equal(h.renders,0);
});

test('new chat does not inherit previous multi-answer or dispatch state',async()=>{
 const handlers=[];const S={chat:'old',multi:['codex','chatgpt'],dispatchPlan:{text:'old'}};
 const c=vm.createContext({S,DR:{},window:{addEventListener(){}},document:{addEventListener:(type,fn)=>{if(type==='click')handlers.push(fn);}},closeCtx(){},renderTimeline(){},renderChatList(){},renderChat(){},history:{replaceState(){}},qs:()=>'', $:()=>null});
 vm.runInContext(fs.readFileSync('src/pga/web/app-events.js','utf8'),c);
 const button={id:'newChat',dataset:{},hasAttribute:()=>false};
 await handlers[0]({target:{closest:s=>s.includes('#newChat')?button:null}});
 assert.equal(S.chat,null);assert.equal(S.multi.length,0);assert.equal(S.dispatchPlan,null);
});
