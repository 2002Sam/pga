import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-chats.js',import.meta.url),'utf8');
test('new-tab continuation updates the source immediately without switching or duplicating markers',async()=>{
 let maps=0,trees=0,opened='';
 const ctx=vm.createContext({S:{chat:'chat:parent',uid:'test'},window:{open:()=>({location:{replace:url=>opened=url}})},stageBranch:()=>false,URL,location:{href:'http://localhost/?c=chat:parent'},api:async()=>({key:'chat:child',upto:'last',title:'Child'}),convMap:()=>maps++,branchTree:()=>trees++});
 vm.runInContext(src.slice(src.indexOf('function chatBranchCreated('),src.indexOf('// Keep actions visible')),ctx);
 await ctx.chatBranch('last');assert.equal(ctx.S.chat,'chat:parent');assert.equal(ctx.S.chatKids['chat:parent'][0].upto,'last');assert.equal(maps,1);assert.equal(trees,1);assert(opened.includes('chat%3Achild'));
 ctx.chatBranchCreated('chat:parent',{key:'chat:child'},'last');assert.equal(ctx.S.chatKids['chat:parent'].length,1);
});
