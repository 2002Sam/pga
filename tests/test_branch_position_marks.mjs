import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-more.js',import.meta.url),'utf8');
test('stripe tracks actual stage positions, shared edge colors and closed windows',()=>{
 const c=vm.createContext({railPairColor:k=>'color:'+k});
 vm.runInContext(src.slice(src.indexOf('function branchPositionMarks('),src.indexOf('function relPositions(')),c);
 const nodes=[{id:'p',key:'parent',type:'win'},{id:'a',key:'a',type:'win'},{id:'b',key:'b',type:'win',branchDocked:true}];
 const pos=new Map([['p',{x:0,w:100}],['a',{x:100,w:100}],['b',{x:200,w:100}]]);
 let marks=c.branchPositionMarks(new Set(['parent','a','b']),nodes,pos,{parent:'parent',key:'a'});
 assert.equal(marks.length,2);assert.equal(marks[1].left,50);assert.equal(marks[1].width,50);assert.equal(marks[0].color,marks[1].color);
 pos.set('a',{x:0,w:100});pos.set('p',{x:100,w:100});
 marks=c.branchPositionMarks(new Set(['a']),nodes,pos,{});assert.equal(marks[0].left,0);
});
