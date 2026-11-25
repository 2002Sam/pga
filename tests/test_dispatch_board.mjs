import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../src/pga/web/app-dispatch.js',import.meta.url),'utf8');
const board=source.slice(source.indexOf('S.taskTurns = {};'),source.indexOf('function boards()'));
const timerStart=source.indexOf('setInterval(() => { const key = S.chat, visible');
const timer=source.slice(timerStart,source.indexOf('\n\ndocument.addEventListener("click"',timerStart));
function setup(api){
 const intervals=[],c={S:{uid:'u',chat:'parent',view:'chats',chatDispatch:{},dispatchLive:{},taskTurns:{}},renderChat(){},api,setInterval:(fn,ms)=>intervals.push({fn,ms})};
 vm.createContext(c);vm.runInContext(board+'\n'+timer,c);return {c,intervals};
}
const work = () => ({key:'task',turns:[{role:'user',text:'prompt'},{role:'agent',text:'old'},{role:'user',text:'followup'},{role:'agent',text:'latest'}]});

test('periodic board polling fetches only the one pending task in a large completed board',async()=>{
 const requests=[],t=setup(url=>new Promise(resolve=>requests.push({url,resolve}))),tasks=[];
 for(let i=0;i<30;i++){
  const key='done-'+i;tasks.push({key});t.c.S.taskTurns[key]=work().turns;t.c.S.dispatchLive[key]='done';
 }
 tasks.push({key:'pending'},{key:'pending'});t.c.S.dispatchLive.pending='running';t.c.S.chatDispatch.parent=[{tasks}];
 assert.equal(t.intervals[0].ms,6000);t.intervals[0].fn();
 await Promise.resolve();await Promise.resolve();assert.equal(requests.length,1);
 assert.match(requests[0].url,/pending/);
 const overlap=t.c.boardRefresh('parent',{runningOnly:true});
 assert.equal(requests.length,1,'a second refresh joins the per-task request already in flight');
 requests[0].resolve({turns:work().turns});await overlap;await Promise.resolve();
 assert.equal(t.c.S.taskTurns.pending.length,1);
 assert.equal(t.c.S.taskTurns.pending[0].text,'latest');
});

test('explicit board refresh still reloads all tasks with at most four requests in flight',async()=>{
 let active=0,peak=0,count=0;const tasks=Array.from({length:31},(_,i)=>({key:'task-'+i}));
 const t=setup(async()=>{active++;count++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,0));active--;return {turns:work().turns};});
 t.c.S.chatDispatch.parent=[{tasks}];await t.c.boardRefresh('parent');
 assert.equal(count,31);assert.ok(peak<=4,`peak concurrency ${peak}`);
 assert.ok(tasks.every(x=>t.c.S.taskTurns[x.key].length===1));
 assert.equal(t.c.S.taskTurns['task-0'][0].text,'latest');
});

test('completion can force just its branch; hidden manager timers do not poll boards',async()=>{
 const requests=[],t=setup(url=>new Promise(resolve=>requests.push({url,resolve}))),tasks=[{key:'done'},{key:'other'}];
 t.c.S.chatDispatch.parent=[{tasks}];t.c.S.dispatchLive.done='done';t.c.S.taskTurns.done=[{role:'agent',text:'old'}];
 const one=t.c.boardRefresh('parent',{keys:['done']});await Promise.resolve();assert.equal(requests.length,1);
 requests[0].resolve({turns:work().turns});await one;
 t.c.S.chat='chat:pm-project';t.c.S.dispatchLive.other='running';t.c.pdVisible=()=>false;
 t.intervals[0].fn();await Promise.resolve();assert.equal(requests.length,1,'hidden manager periodic refresh is skipped');
});

test('completion refresh fetches again after an older poll response settles',async()=>{
 const requests=[],t=setup(url=>new Promise(resolve=>requests.push({url,resolve}))),tasks=[{key:'task'}];
 t.c.S.chatDispatch.parent=[{tasks}];t.c.S.dispatchLive.task='running';
 const poll=t.c.boardRefresh('parent',{runningOnly:true});await Promise.resolve();
 assert.equal(requests.length,1);
 t.c.S.dispatchLive.task='done';
 const completion=t.c.boardRefresh('parent',{keys:['task']});
 requests[0].resolve({turns:[{role:'agent',text:'old'}]});
 for(let i=0;i<8&&requests.length<2;i++) await new Promise(resolve=>setImmediate(resolve));
 assert.equal(requests.length,2,'completion must start a post-poll fetch');
 requests[1].resolve({turns:[{role:'agent',text:'fresh final'}]});
 await Promise.all([poll,completion]);
 assert.equal(t.c.S.taskTurns.task[0].text,'fresh final');
});

