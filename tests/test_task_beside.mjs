import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root=new URL('../src/pga/web/',import.meta.url);
const stage=fs.readFileSync(new URL('app-stage.js',root),'utf8');
function setup(nodes){
 const calls=[];
 const c={ST:{nodes},window:{},stWins:()=>nodes.slice().sort((a,b)=>a.ord-b.ord),stFocus:(id)=>calls.push(id),stSave(){},stContexts(){},
 stOpen(key){let n=nodes.find(n=>n.key===key);if(!n){n={id:key,key,type:'win',ord:nodes.length};nodes.push(n)}return n;}};
 vm.createContext(c);vm.runInContext(stage.slice(stage.indexOf('function stBringBeside('),stage.indexOf('function stOpen(key,')),c);return {c,calls};
}
test('an existing task moves beside the manager without losing its state or duplicating',()=>{
 const manager={id:'m',key:'manager',type:'win',ord:0},other={id:'o',key:'other',type:'win',ord:1},task={id:'t',key:'task',type:'win',ord:2,small:true,mini:true,draft:'unsent',running:true};
 const {c}=setup([manager,other,task]);c.stBringBeside('task','manager');
 assert.deepEqual(c.stWins().map(n=>n.id),['m','t','o']);assert.equal(task.draft,'unsent');assert.equal(task.running,true);assert.equal(task.small,undefined);assert.equal(task.mini,false);
 c.stBringBeside('task','manager');assert.equal(c.ST.nodes.length,3);
});
test('closed task opens beside source and a child can move independently while keeping lineage',()=>{
 const manager={id:'m',key:'manager',type:'win',ord:0},other={id:'o',key:'other',type:'win',ord:1};const {c}=setup([manager,other]);
 const task=c.stBringBeside('task','manager');assert.deepEqual(c.stWins().map(n=>n.key),['manager','task','other']);
 task.par='o';other.sel=task.id;task.branchDocked=true;
 c.stBringBeside('task','manager');assert.equal(task.par,undefined);assert.equal(task.from,'other');assert.equal(other.sel,undefined);
 c.stBringBeside('manager','manager');assert.equal(c.ST.nodes.length,3);
});
test('result comments expose an escaped direct link and keep the result preview',()=>{
 const c={chatSend(){},document:{addEventListener(){}},window:{},setInterval(){},S:{chat:'manager'},L:a=>a,esc:s=>String(s??'').replaceAll('&','&amp;').replaceAll('"','&quot;'),agentLabel:x=>x};vm.createContext(c);
 vm.runInContext(fs.readFileSync(new URL('app-pmdoc.js',root),'utf8'),c);
 const html=c.pdNoteHtml({id:'a',key:'chat:task',who:'worker',st:'done',body:'result',title:'Task'});
 assert.match(html,/href="\?v=chats&c=chat%3Atask" data-pdgo="chat:task"/);assert.match(html,/查看处理对话/);assert.doesNotMatch(html,/>result</);
});
