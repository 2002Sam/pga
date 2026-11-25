import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/pga/web/app-stage.js', import.meta.url),'utf8');
function setup(nodes) {
  const ST={nodes,focus:'A12'}, remembered=[];
  const c=vm.createContext({ST,stWins:()=>ST.nodes,stGroupOf:w=>({id:w.group}),stRememberPage:w=>remembered.push(w.id)});
  vm.runInContext(source.slice(source.indexOf('function stLimitPages('),source.indexOf('function stRememberPage(')),c);
  return {c,ST,remembered};
}
const wins=group=>Array.from({length:13},(_,i)=>({id:group+i,key:'chat:'+group+i,group,type:'win',openedAt:i,tidyLinear:true,screenPin:i===0}));
test('each category retains ten views, with five expanded, including previously tidied and pinned views',()=>{
 const {c,ST,remembered}=setup([...wins('A'),...wins('B'),{id:'pm',group:'A',managerProject:'A'}]);
 assert.equal(c.stLimitPages(),true);
 for(const group of ['A','B']) {
 const pages=ST.nodes.filter(w=>w.group===group&&!w.managerProject);
 assert.equal(pages.length,10);assert.equal(pages.filter(w=>!w.small).length,5);
 }
 assert.equal(remembered.length,6);assert(ST.nodes.some(w=>w.id==='pm'));
 assert.equal(c.stLimitPages(),false);
});
test('focused older conversation stays available and branch links are repaired on eviction',()=>{
 const nodes=wins('A');nodes[12].par='A0';nodes[0].kids=['A12'];
 const {c,ST}=setup(nodes);c.stLimitPages();
 const child=ST.nodes.find(w=>w.id==='A12');assert.equal(child.par,undefined);assert.equal(child.branchFrom,'chat:A0');
 ST.focus='A3';ST.nodes.find(w=>w.id==='A3').small=false;c.stLimitPages();
 assert.equal(ST.nodes.filter(w=>!w.small).length,5);assert(!ST.nodes.find(w=>w.id==='A3').small);
});
