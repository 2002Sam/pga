import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function setup(){
 const window={};window.top=window;const data=new Map();
 const ctx=vm.createContext({window,S:{uid:'u'},Date,setInterval(){},localStorage:{getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)}});
 vm.runInContext(fs.readFileSync('src/pga/web/app-pet.js','utf8'),ctx);return ctx;
}
const run=(id,key,extra={})=>({id,tags:{conversation:'u:'+key},started:Date.now()/1000,finished:Date.now()/1000+1,ok:true,...extra});
test('completion tracker delivers all conversations, deduplicates snapshots, and filters other accounts',()=>{
 const ctx=setup();ctx.rows=[...Array.from({length:8},(_,i)=>run('r'+i,'chat:'+i)),run('foreign','x',{tags:{conversation:'other:x'}})];
 assert.equal(vm.runInContext('petCompleted(rows).length',ctx),8);
 assert.equal(vm.runInContext('petCompleted(rows).length',ctx),0);
 ctx.rows=[run('new','chat:0')];assert.equal(vm.runInContext('petCompleted(rows).length',ctx),1);
});
test('a conversation waits for all runs and ignores completions from before page load',()=>{
 const ctx=setup();ctx.rows=[run('a','chat:a'),run('b','chat:a',{finished:null}),run('old','chat:old',{finished:1})];
 assert.equal(vm.runInContext('petCompleted(rows).length',ctx),0);
 ctx.rows[1].finished=Date.now()/1000+2;ctx.rows[1].ok=false;
 assert.equal(vm.runInContext('petCompleted(rows)[0].run.ok',ctx),false);
});
test('inbox retains every unread conversation while bounding read history',()=>{
 const ctx=setup();vm.runInContext("petItems=Array.from({length:180},(_,i)=>({key:'chat:'+i,read:i>=80}));petTrim()",ctx);
 assert.equal(vm.runInContext('petItems.length',ctx),130);assert.equal(vm.runInContext('petItems.filter(x=>!x.read).length',ctx),80);
});
test('desktop capability suppresses web notifications',()=>{
 const ctx=setup();ctx.window.PGA_NATIVE={petNotifications:true};
 vm.runInContext("petShow({key:'chat:a',title:'done'})",ctx);
 assert.equal(vm.runInContext('petItems.length',ctx),0);
});
