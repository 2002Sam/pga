import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
test('saved overview ranks cannot split a category, including newly opened windows',()=>{
 const nodes=[{id:'a',key:'a',ord:0,overviewOrder:0,g:'PGA'},{id:'b',key:'b',ord:1,overviewOrder:1,g:'Paper'},{id:'c',key:'c',ord:2,overviewOrder:2,g:'PGA'}];
 const c=vm.createContext({ST:{nodes},stWins:()=>nodes.slice().sort((a,b)=>a.ord-b.ord),stGroupOf:n=>({id:n.g}),recentItems:()=>[]});
 vm.runInContext(src.slice(src.indexOf('function stGroupGather()'),src.indexOf('function stWsLook(')),c);
 c.stGroupGather(); assert.deepEqual(nodes.slice().sort((a,b)=>a.ord-b.ord).map(n=>n.id),['a','c','b']);
 nodes.push({id:'new',key:'new',ord:3,g:'PGA'});c.stGroupGather();
 assert.deepEqual(nodes.slice().sort((a,b)=>a.ord-b.ord).map(n=>n.g),['PGA','PGA','PGA','Paper']);
 for(const n of nodes)if(n.overviewOrder!=null)assert.equal(n.overviewOrder,n.ord);
 assert.equal(c.stGroupGather(),false);
});

test('managers stay first on restore, reopen and insertion without reordering other chats',()=>{
 const nodes=[{id:'a',ord:0,g:'PGA'},{id:'b',ord:1,g:'Paper'},{id:'pm',ord:2,g:'PGA',managerProject:'PGA',small:true,overviewOrder:2},{id:'c',ord:3,g:'PGA'},{id:'paper-pm',ord:4,g:'Paper',managerProject:'Paper',overviewOrder:4}];
 const sorted=()=>nodes.slice().sort((a,b)=>a.ord-b.ord);
 const c=vm.createContext({ST:{nodes},stWins:sorted,stGroupOf:n=>({id:n.g})});
 vm.runInContext(src.slice(src.indexOf('function stGroupGather()'),src.indexOf('function stWsLook(')),c);
 c.stGroupGather();assert.deepEqual(sorted().map(n=>n.id),['pm','a','c','paper-pm','b']);
 nodes.push({id:'new',ord:-1,g:'PGA'});c.stGroupGather();
 assert.deepEqual(sorted().map(n=>n.id),['pm','new','a','c','paper-pm','b']);
 const pm=nodes.find(n=>n.id==='pm');pm.ord=99;pm.small=false;c.stGroupGather();
 assert.equal(sorted()[0].id,'pm');assert.equal(pm.overviewOrder,pm.ord);
 assert.equal(c.stGroupGather(),false);
});
