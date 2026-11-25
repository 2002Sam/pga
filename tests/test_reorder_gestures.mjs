import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync('src/pga/web/app-stage.js','utf8');
function setup(){
 let cancelled=0,reads=0;
 const el={_sortAnimation:{cancel(){cancelled++;}}};
 const ST={nodes:[{el}],mapMode:'time'};
 const c=vm.createContext({ST,clearTimeout});
 vm.runInContext(src.slice(src.indexOf('function stReorderStop('),src.indexOf('function stRender(')),c);
 return {ST,c,el,box:{querySelectorAll(){reads++;}},counts:()=>({cancelled,reads})};
}
test('panning, dragging and resizing never start sorting animations or capture anchors',()=>{
 for(const key of ['pan','drag','rz','branchResize','overview']){
 const h=setup();h.ST[key]={};assert.equal(h.c.stReorderStart(h.box),null);assert.equal(h.counts().reads,0);
 }
});
test('taking manual control cancels and clears active sort animations',()=>{
 const h=setup();h.c.stReorderStop();assert.equal(h.el._sortAnimation,null);assert.equal(h.counts().cancelled,1);
 h.c.stReorderStop();assert.equal(h.counts().cancelled,1);
});
