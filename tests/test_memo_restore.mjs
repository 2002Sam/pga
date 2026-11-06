import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const stage=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
const memo=fs.readFileSync(new URL('../src/pga/web/app-memo.js',import.meta.url),'utf8');
test('one click restores memos and conversations without a summary step',()=>{
 const calls=[];const ctx=vm.createContext({document:{querySelector:()=>null},stMini:(n,on)=>{assert.equal(on,false);delete n.small;},stFocus:(id)=>calls.push(id),stSummaryOpen:()=>calls.push('summary')});
 vm.runInContext(stage.slice(stage.indexOf('function stOpenCollapsed('),stage.indexOf('function stBindSummaryHover(')),ctx);
 for(const memoId of ['saved-note','tabs:chat:1']){const el={draft:'unsaved text'};const n={id:memoId,memo:memoId,small:true,mini:true,el};ctx.stOpenCollapsed(n,{});assert.equal(n.small,undefined);assert.equal(n.mini,false);assert.equal(n.el,el);}
 ctx.stOpenCollapsed({id:'chat'},{});assert.deepEqual(calls,['saved-note','tabs:chat:1','chat']);
});
test('reopening a memo from the list clears collapsed state and reuses the node',()=>{
 const n={id:'memo-1',memo:'1',small:true,mini:true};const ST={nodes:[n]};const ctx=vm.createContext({ST,S:{view:'stage'},stRender(){},stSave(){},stShow(){}});
 vm.runInContext(memo.slice(memo.indexOf('function memoShow('),memo.indexOf('async function memoMount(')),ctx);ctx.memoShow('1',false);
 assert.equal(ST.nodes.length,1);assert.equal(n.small,undefined);assert.equal(n.mini,false);assert.equal(ST.focus,n.id);assert.ok(ST.stageOpen.has(n.id));
});
test('folded memos leave the top bar and return when restored',()=>{
 const ctx=vm.createContext({stFoldPick:()=>({folded:new Set(['source']),total:new Map(),count:new Map()}),stRootOf:()=>({id:'source'})});
 vm.runInContext(stage.slice(stage.indexOf('function stMapSelection('),stage.indexOf('// Use the full page as the reference')),ctx);
 const note={id:'note',memo:'tabs:source',small:true};
 const selected=()=>[...ctx.stMapSelection([note,{id:'chat'}],new Map()).selected];
 assert.deepEqual(selected(),[]);
 delete note.small;assert.deepEqual(selected(),[note]);
 note.mini=true;assert.deepEqual(selected(),[]);
 note.mini=false;assert.deepEqual(selected(),[note]);
});
test('expanded memo has a visible title in top bar, without a conversation key',()=>{
 const start=stage.indexOf('    if (w.memo) {',stage.indexOf('function stMap()'));
 const snippet=stage.slice(start,stage.indexOf('    if (lab && fits)',start));
 const ctx=vm.createContext({w:{memo:'note'},memoNodeTitle:()=> '📝 备忘',p:{x:0,w:100},k:1,esc:s=>s});
 vm.runInContext('let lab="";'+snippet+'globalThis.result=lab;',ctx);
 assert.match(ctx.result,/mlabel/);assert.match(ctx.result,/📝 备忘/);
});
