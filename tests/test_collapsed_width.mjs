import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
test('collapsed windows release blank width and restore saved width without moving the preceding window',()=>{
 const first={id:'first',type:'win',bw:660}, folded={id:'folded',type:'win',bw:1400,small:true,big:true};
 const ST={nodes:[first,folded],shift:0};
 const c=vm.createContext({ST,stArena:()=>({w:1800,h:900}),stWins:()=>ST.nodes,stKids:()=>[],stDock:()=>false,stGroupHidden:()=>false,stGroupOf:()=>null,stRootOf:n=>n,stKnowledgeUnits(){},stFoldPick:()=>({folded:new Set()}),ST_CW:190,ST_MINW:300,ST_WW:660,ST_LINE:6,ST_GAP:18,ST_PADX:12,ST_FORKGAP:18,ST_FIT:560,ST_TAB:150});
 vm.runInContext(source.slice(source.indexOf('function stLayout()'),source.indexOf('/* ------------------------------------------------ drawing */')),c);
 const before=c.stLayout().units.filter(u=>u.kind==='win'||u.kind==='lines');
 assert.equal(before[1].w,6);assert.equal(before[1].x,before[0].x+660+18);assert.ok(ST.span<900);assert.equal(folded.bw,1400);
 delete folded.small;delete folded.big;
 const after=c.stLayout().units.filter(u=>u.kind==='win');assert.equal(after[1].w,1400);assert.equal(after[0].x,before[0].x);
});
