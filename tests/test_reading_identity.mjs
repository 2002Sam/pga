import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/pga/web/app-reading.js',import.meta.url),'utf8');
const repair=source.slice(source.indexOf('function readingRepairNode('),source.indexOf('function readingLeave('));
const document={key:'chat:paper',parent:'chat:parent',source:'https://paper.example/project',title:'Paper title'};
function fix(node,records=[document]){
  const context=vm.createContext({URL,S:{allChats:records.map(reading_info=>({reading_info}))}});
  vm.runInContext(repair,context);context.readingRepairNode(node);return node;
}
test('source key survives a stale parent branchKey and can restore without loaded metadata',()=>{
  const n=fix({key:'chat:parent',branchKey:'chat:parent',readingKey:'chat:paper'},[]);
  assert.equal(n.key,'chat:paper');assert.equal(n.branchKey,'chat:paper');
});
test('authoritative source metadata repairs the first version of a reading window',()=>{
  const n=fix({key:'chat:paper',branchKey:'chat:parent',from:'chat:parent'});
  assert.equal(n.key,'chat:paper');assert.equal(n.branchKey,n.key);assert.equal(n.readingSource,document.source);
});
test('an already corrupted key recovers by parent plus source title',()=>{
  const n=fix({key:'chat:parent',branchKey:'chat:parent',from:'chat:parent',title:'Paper title'});
  assert.equal(n.key,'chat:paper');
});
test('initial hostname titles recover after the page title changes',()=>{
  const n=fix({key:'chat:parent',branchKey:'chat:parent',from:'chat:parent',title:'paper.example'});
  assert.equal(n.key,'chat:paper');
});
test('ambiguous old hostnames and unrelated regular branches are never guessed',()=>{
  const records=[document,{...document,key:'chat:second',source:'https://paper.example/second'}];
  assert.equal(fix({key:'chat:parent',branchKey:'chat:parent',from:'chat:parent',title:'paper.example'},records).key,'chat:parent');
  assert.equal(fix({key:'chat:branch',branchKey:'chat:branch',from:'chat:parent',title:'Paper title'}).key,'chat:branch');
});
