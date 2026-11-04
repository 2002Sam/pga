import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const s=fs.readFileSync('src/pga/web/app-stage.js','utf8');
const c=vm.createContext({hueOf:()=>210});
vm.runInContext(s.slice(s.indexOf('function stGroupPalette('),s.indexOf('function stGroupColors(')),c);
const hue=x=>Number(x.match(/hsl\((\d+)/)[1]);
const diff=(a,b)=>Math.min(Math.abs(a-b),360-Math.abs(a-b));
test('daily and research use warm and cool colors even with identical name hashes',()=>{
 const g=['日常对话','论文思考'].map(name=>({id:name,name}));
 const p=c.stGroupPalette(g,g);assert.equal(hue(p.get(g[0].id)),30);assert.equal(hue(p.get(g[1].id)),210);
});
test('adjacent groups remain distinct after reordering and hiding middle groups',()=>{
 for(let shift=0;shift<12;shift++){
 const all=Array.from({length:12},(_,i)=>({id:String((i+shift)%12),name:String(i)}));
 const visible=all.filter((_,i)=>i%3!==1), p=c.stGroupPalette(all,visible);
 for(const row of [all,visible])for(let i=1;i<row.length;i++)assert.ok(diff(hue(p.get(row[i-1].id)),hue(p.get(row[i].id)))>=80);
 assert.equal(JSON.stringify([...p]),JSON.stringify([...c.stGroupPalette(all,visible)]));
 }
});
