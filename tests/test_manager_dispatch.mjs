import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-pmdoc.js',import.meta.url),'utf8');
for (const effort of ['', 'low', 'medium', 'high', 'xhigh']) test('effort '+effort+': manager always creates a new linked conversation and runs the chosen agent there',async()=>{
 const calls=[],opened=[];const host={ST:{nodes:[{key:'chat:pm-a',id:'manager'}]},stOpen:(key,at)=>{opened.push({key,at});return {key,id:'new'}}};
 const c={S:{uid:'u',chat:'chat:pm-a',chatTurns:{},dispatchLive:{}},PM:{name:'Test'},window:{},chatSend(){},document:{querySelector:()=>null,querySelectorAll:()=>[],addEventListener(){}},setInterval(){},setTimeout,clearTimeout,L:a=>a,loadChat:async()=>{},boardRefresh(){},dispatchWindowRefresh(){},pmHost:()=>host,toast(){},
 api:async(url,options)=>{calls.push({url,body:options.body});if(url.endsWith('manager-plan'))return {tasks:[{title:'测试',text:'测试',agent:'deepseek'}]};if(url.endsWith('/note'))return {run:'r'};if(url.endsWith('/conversation-projects'))return {key:'chat:new'};if(url.endsWith('/branch'))return {key:'chat:new'};return {ok:true};}};
 c.window=c;vm.createContext(c);vm.runInContext(src,c);const slider={value:'0',setAttribute(){}}, output={};
 c.pdEffortSet({querySelector:s=>s==='output'?output:slider},['','low','medium','high','xhigh'].indexOf(effort));
 await c.pdSend('测试');
 assert.equal(calls.find(x=>x.url.endsWith('/ask')).body.conversation,'chat:new');
 assert.equal(calls.find(x=>x.url.endsWith('/ask')).body.agent,'deepseek');
 assert.equal(calls.find(x=>x.url.endsWith('/dispatch')).body.entry.tasks[0].key,'chat:new');
 assert.equal(opened[0].at.win,'manager');
 assert.equal(c.pdEffortTake(),'');
 const assigned=calls.findIndex(x=>x.url.endsWith('/conversation-projects') && x.body.key==='chat:new');
 assert.ok(assigned > calls.findIndex(x=>x.url.endsWith('/title')));
 assert.ok(assigned < calls.findIndex(x=>x.url.endsWith('/ask')));
 assert.equal(calls.find(x=>x.url.endsWith('/ask')).body.scope,'Test');
 if(effort) assert.match(calls.find(x=>x.url.endsWith('/dispatch')).body.entry.tasks[0].why,/请求思考强度/);
 assert.equal(calls.find(x=>x.url.endsWith('/ask')).body.effort,effort || undefined);
 assert.equal(calls.find(x=>x.url.endsWith('/dispatch')).body.entry.effort,effort);
});
