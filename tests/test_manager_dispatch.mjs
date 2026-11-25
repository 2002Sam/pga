import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-pmdoc.js',import.meta.url),'utf8');
const efforts = ['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
for (const project of ['Test', '']) for (const effort of efforts) for (const separate of [false,true]) test(`project ${project} effort ${effort}: separate=${separate}`,async()=>{
 const calls=[],opened=[];const host={ST:{nodes:[{key:'chat:pm-a',id:'manager'}]},stOpen:(key,at)=>{opened.push({key,at});return {key,id:'new'}}};
 const c={S:{uid:'u',chat:'chat:pm-a',chatTurns:{},dispatchLive:{}},PM:{name:project},window:{},chatSend(){},document:{querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}},setInterval(){},setTimeout,clearTimeout,L:a=>a,loadChat:async()=>{},boardRefresh(){},pmHost:()=>host,toast(){},notice(){},
 api:async(url,options)=>{calls.push({url,body:options?.body});return {ok:true,entry:{tasks:[{key:'chat:new',agent:'deepseek'}]}};}};
 c.window=c;vm.createContext(c);vm.runInContext(src,c);const slider={value:'0',setAttribute(){}}, output={};
 const position = Math.max(0, efforts.indexOf(effort) - 0.23);
 c.pdEffortSet({querySelector:s=>s==='output'?output:slider},position);
 assert.equal(Number(slider.value),position);
 if(separate) c.pdConversationSet(true);
 await c.pdSend('测试');
 assert.equal(calls.length,1,'server owns execution, no duplicate browser requests');
 assert.ok(calls[0].url.endsWith('/manager-submit'));
 assert.equal(calls[0].body.conversation,'chat:pm-a');
 assert.equal(calls[0].body.create_conversations,undefined);
 assert.equal(calls[0].body.effort,effort || undefined);
 assert.equal(opened.length,0);
 assert.equal(c.pdEffortTake(),'');
});

test('manager shows failure cause, replacement and durable retry result', () => {
 const c={S:{},PM:{},window:{},chatSend(){},document:{addEventListener(){}},setInterval(){},L:a=>a,agentLabel:a=>a};
 c.window=c; vm.createContext(c); vm.runInContext(src,c);
 const activity={status:'SUCCEEDED',agent:'codex',dispatch_reports:[{agent:'claude',error:'401 unauthorized',to:'codex'}],start_check:{message:'已开始执行'}};
 const note=c.pdTaskNote({id:'d'},{key:'chat:test',agent:'claude',title:'task'},0,new Map(),new Map(),activity);
 assert.match(note.report,/401 unauthorized/);
 assert.match(note.report,/已切换 codex/);
 assert.match(note.report,/替换后已完成/);
 assert.match(note.report,/10 秒回查/);
 assert.equal(note.agent,'codex');
});


test('a committed assignment is visible while history is still loading', async () => {
 const key='chat:pm-test', entry={id:'d',run:'run',at:'2026-01-01',tasks:[
   {task_id:'t',key:'chat:worker',agent:'codex',text:'修改按钮',title:'修改按钮'}]};
 let releaseHistory, visible;
 const c={S:{uid:'u',chat:key,chatTurns:{},dispatchLive:{}},PM:{},window:{},chatSend(){},
   document:{querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}},setInterval(){},L:a=>a,
   loadChat:()=>new Promise(resolve=>{releaseHistory=resolve}),boardRefresh(){},api:async()=>({entry})};
 c.window=c;vm.createContext(c);vm.runInContext(src,c);
 c.pdRender=()=>{visible=c.pdModel().some(row=>row.notes.some(n=>n.agent==='codex'))};
 const sent=c.pdSend('修改按钮');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(visible,true);
 releaseHistory();await sent;
 assert.equal(c.S.chatTurns[key].length,1);
});
