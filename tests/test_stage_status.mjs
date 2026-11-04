import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
test('backend live state survives missing iframe state, isolates users, and chooses latest run',()=>{
 const ctx={ST:{},S:{uid:'u'},setInterval(){}};ctx.window=ctx;vm.createContext(ctx);
 vm.runInContext(src.slice(src.indexOf('const stBusy ='),src.indexOf('function stSeen('))+'\nthis.busy=stBusy;',ctx);
 ctx.stApplyLive([{tags:{conversation:'u:chat:a'},started:10,running:true},{tags:{conversation:'foreign:chat:b'},started:30,running:true}]);
 assert(ctx.busy({key:'chat:a'}));assert(!ctx.busy({key:'chat:b'}));
 ctx.stApplyLive([{tags:{conversation:'u:chat:a'},started:20,running:false},{tags:{conversation:'u:chat:a'},started:10,running:true}]);assert(!ctx.busy({key:'chat:a'}));
});
test('unread numbers are newest first and renumber after reading',()=>{
 const nodes=[{id:'a',key:'chat:a',done:100},{id:'b',key:'chat:b',done:300},{id:'c',key:'chat:c',done:200},{id:'d',key:'chat:d',run:true,runAt:400}];
 const ctx={stWins:()=>nodes};vm.createContext(ctx);vm.runInContext(src.slice(src.indexOf('function stStat()'),src.indexOf('const stDraft =')),ctx);
 let s=ctx.stStat();assert.equal(s.get('b').num,1);assert.equal(s.get('c').num,2);assert.equal(s.get('a').num,3);assert(s.get('d').run);
 delete nodes[1].done;s=ctx.stStat();assert.equal(s.get('c').num,1);assert.equal(s.get('a').num,2);
});
