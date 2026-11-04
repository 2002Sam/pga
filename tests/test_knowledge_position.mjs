import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const src=readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
const ctx=vm.createContext({});
vm.runInContext(src.slice(src.indexOf('function stKnowledgeUnits('),src.indexOf('function stLayout()')),ctx);
const win=key=>({kind:'win',win:{key}});
const doc=(source,opened=0)=>({kind:'win',win:{knowledge:'note-'+opened,knowledgeSource:source,knowledgeOpened:opened}});
test('date/group order cannot separate source and document; latest opens closest',()=>{
  const a=win('a'), b=win('b'), c=win('c'), old=doc('a',1), fresh=doc('a',2), col={kind:'col',win:fresh.win};
  const units=[old,b,a,c,col,fresh];ctx.stKnowledgeUnits(units);
  assert.deepEqual(units,[b,a,col,fresh,old,c]);
  ctx.stKnowledgeUnits(units);assert.deepEqual(units,[b,a,col,fresh,old,c]);
});
test('branch document stays beside its own branch column, before deeper branches',()=>{
  const root=win('root'), branch={kind:'stack',wins:[{key:'child'}]}, deeper={kind:'stack',wins:[{key:'deep'}]}, note=doc('child'), other=win('other');
  const units=[note,root,branch,deeper,other];ctx.stKnowledgeUnits(units);
  assert.deepEqual(units,[root,branch,note,deeper,other]);
});
test('closed source leaves its saved document accessible',()=>{
  const note=doc('closed'), a=win('a'), units=[note,a];ctx.stKnowledgeUnits(units);assert.deepEqual(units,[note,a]);
});
