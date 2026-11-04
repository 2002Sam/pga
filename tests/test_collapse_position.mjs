import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
for (const par of [undefined,'parent']) test(`collapse preserves geometry, selection and viewport for ${par ? 'branch' : 'root'}`,()=>{
  const n={id:'a',par,bw:650,pre:95,branchWeight:220}, frame={}; n.el=frame;
  const ST={shift:120,focus:'a',nodes:[n]}, calls=[];
  const c=vm.createContext({ST,stKidKeep:(node,on)=>calls.push(on),stRender(){},stSave(){},stMap(){}});
  vm.runInContext(source.slice(source.indexOf('function stMini(n, on)'),source.indexOf('function stClose(n)')),c);
  const before={...n};
  c.stMini(n,true);
  assert.equal(n.small,true);assert.deepEqual({...n,small:undefined},{...before,small:undefined});
  assert.equal(ST.shift,120);assert.equal(ST.focus,'a');assert.equal(n.el,frame);
  c.stMini(n,false);assert.deepEqual(n,before);assert.deepEqual(calls,[true,false]);
});
