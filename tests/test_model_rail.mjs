import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync('src/pga/web/app-model-rail.js','utf8');
function setup(){
 const options={models:[{id:'gpt-6-astra',efforts:[{id:'medium'},{id:'high'}]}],default_model:'gpt-6-astra',default_effort:'medium'};
 const S={chat:'chat:a',chatAgent:'codex',agentOpts:{codex:options},agents:[{name:'codex'},{name:'chatgpt'}],chatModel:{},chatEffort:{},view:'chats'};
 const window={parent:{},addEventListener(){}},values=new Map();let renders=0;
 const ctx=vm.createContext({S,window,localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)},store:{set(){}},api:async()=>options,rerenderComposer:()=>renders++,setInterval(){},console});
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


test('recent choices keep ten distinct models in use order regardless of effort',()=>{
 const h=setup();h.S.uid='u';h.S.agents=[{name:'a'}];
 const remember=(model,effort)=>h.window.mrRemember({agent:'a',model,effort});
 const rows=()=>JSON.parse(vm.runInContext('JSON.stringify(mrRecent().map(p=>p.model))',h.ctx));
 for(let i=0;i<11;i++)remember('m'+i,'medium');
 remember('m4','high');remember('m4','medium');
 assert.deepEqual(rows().slice(0,3),['m4','m10','m9']);
 assert.equal(rows().length,10);assert.deepEqual(rows().at(-1),'m1');
});
test('recent models ignore unavailable entries and corrupted storage, scoped by account',()=>{
 const h=setup();h.S.uid='u';h.values.set('pga_recent_models_v1:u','{}');
 assert.ok(vm.runInContext('mrRecent().length<=10',h.ctx));
 h.values.set('pga_recent_models_v1:u',JSON.stringify([{...p,agent:'missing'},p]));
 assert.equal(vm.runInContext('mrRecent()[0].agent',h.ctx),'codex');
 h.S.uid='other';assert.equal(vm.runInContext('mrRecent()[0].agent',h.ctx),'chatgpt');
});
test('picker catalog includes every backend model including a single-model agent',()=>{
 const h=setup();h.ctx.opts={codex:{models:[{id:'new',label:'New',efforts:[{id:'ultra'}],default_effort:'ultra'},{id:'other'}]},chatgpt:{models:[{id:'only'}]}};
 const rows=JSON.parse(vm.runInContext('JSON.stringify(mrCatalog(opts))',h.ctx));
 assert.deepEqual(rows.map(p=>p.model),['new','other','only']);assert.equal(rows[0].effort,'ultra');
});
test('a picker opened for another conversation cannot change the new conversation',async()=>{
 const h=setup();assert.equal(await h.window.mrApply(p,'chat:old'),false);assert.equal(h.renders,0);
 assert.equal(h.values.size,0);
});
test('fresh picker options validate newly discovered models and record only successful selections',async()=>{
 const h=setup();const fresh={models:[{id:'new',efforts:[{id:'high'}]}]};
 assert.equal(await h.window.mrApply({...p,model:'new'},'chat:a',fresh),true);
 assert.equal(h.S.chatModel['chat:a'],'new');
 assert.equal(vm.runInContext('mrRecent()[0].model',h.ctx),'new');
 await assert.rejects(h.window.mrApply({...p,model:'invalid'}));
 assert.equal(vm.runInContext('mrRecent()[0].model',h.ctx),'new');
});

test('agents with implicit defaults remain selectable and unavailable agents are excluded',async()=>{
 const h=setup();h.S.agents=[{name:'hermes'},{name:'gemini',available:false}];h.ctx.opts={hermes:{models:[],default_model:null},gemini:{models:[{id:'x'}]}};
 assert.equal(vm.runInContext('mrCatalog(opts).length',h.ctx),1);
 assert.equal(await h.window.mrApply({agent:'hermes',model:'',effort:''},'chat:a',h.ctx.opts.hermes),true);
 assert.equal(h.S.chatAgent,'hermes');assert.equal(vm.runInContext('mrRecent()[0].agent',h.ctx),'hermes');
 await assert.rejects(h.window.mrApply({agent:'gemini',model:'x',effort:''}));
});

test('Hermes native default accepts and remembers a per-conversation reasoning choice',async()=>{
 const h=setup();h.S.agents=[{name:'hermes'}];
 const opts={models:[{id:'',label:'Hermes 默认模型',efforts:[{id:'high'},{id:'none'}]}],default_model:null};
 assert.equal(await h.window.mrApply({agent:'hermes',model:'',effort:'high'},'chat:a',opts),true);
 assert.equal(h.S.chatModel['chat:a'],'');assert.equal(h.S.chatEffort['chat:a'],'high');
 await h.window.mrApply({agent:'hermes',model:'',effort:'none'},'chat:a',opts);
 assert.equal(h.S.chatEffort['chat:a'],'none');
});
