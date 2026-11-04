import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-more.js',import.meta.url),'utf8');
const fn=src.slice(src.indexOf('function railPairColor('),src.indexOf('function railParentInfo('));
test('siblings get distinct persistent colors regardless of shared project and reordered windows',()=>{
 const saved=new Map(), localStorage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)};
 const create=()=>{const c=vm.createContext({localStorage,window:{parent:{stProjectColor:()=> 'blue'}}});vm.runInContext(fn,c);return c;};
 const c=create(),keys=['chat:a','chat:b','chat:c','chat:d','chat:e','chat:f'];
 const colors=keys.map(k=>c.railPairColor(k));assert.equal(new Set(colors).size,6);
 const d=create();for(let i=5;i>=0;i--)assert.equal(d.railPairColor(keys[i]),colors[i]);
});
