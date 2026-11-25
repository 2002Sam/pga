import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
function harness(){
 const a={id:'a',bw:600},b={id:'b',bw:500},nodes=[a,b];
 const c=vm.createContext({ST_MINW:300,ST:{nodes},ST_PADX:12,stWins:()=>nodes,stArena:()=>({w:1200}),
 stRender(){},stSave(){},stMap(){},stShow(){},setTimeout,clearTimeout,Date});
 vm.runInContext(source.slice(source.indexOf('function stMax('),source.indexOf('async function stRepairBranchKeys')),c);
 return {a,b,c,nodes};
}
test('maximize fills canvas without removing neighbours; restore and double click retain geometry',()=>{
 const {a,b,c,nodes}=harness();
 c.stMax(a,true); assert.equal(a.bigWidth,1176); assert.equal(a.fullscreen,true);
 assert.equal(nodes.length,2); assert.equal(b.bw,500);
 c.stMax(a,true,.7); assert.equal(a.bigWidth,840); assert.equal(a.fullscreen,false);
 c.stMax(a,false); assert.equal(a.big,undefined); assert.equal(a.bw,600);
});
test('maximized width follows resized canvas, including restored saved windows',()=>{
 const {a,c}=harness();c.stMax(a,true);
 const units=[{kind:'win',win:a,w:500}];
 Object.assign(c,{units,room:976,A:{w:1000}});
 const start=source.indexOf('  // Exact requested width');
 vm.runInContext(source.slice(start,source.indexOf('  const flex =',start)),c);
 assert.equal(units[0].w,976);
});
test('maximized branch retains parent and siblings and restores vertical grouping',()=>{
 const c=vm.createContext({ST_MINW:300,ST_WW:660});
 vm.runInContext(source.slice(source.indexOf('function stBranchUnits('),source.indexOf('function stToggleLayer(')),c);
 const par={branchLayout:'column'},kids=[{id:'a',fullscreen:true},{id:'b'}];
 assert.equal(c.stBranchUnits(par,kids).length,2);
 assert.equal(par.branchLayout,'column');
 delete kids[0].fullscreen;assert.equal(c.stBranchUnits(par,kids).length,1);
});
