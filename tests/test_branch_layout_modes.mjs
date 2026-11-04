import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
test('layout toggle includes promoted and docked children without capturing other parents',()=>{
 const parent={id:'p',key:'chat:p',kidsCollapsed:true};
 const kids=[{id:'a',type:'win',par:'p',branchDocked:true},{id:'b',type:'win',branchParent:'p',branchFrom:'chat:p'}];
 const other={id:'c',type:'win',par:'other',branchFrom:'chat:p'};
 const ctx=vm.createContext({ST:{nodes:[parent,...kids,other]},stRender(){},stSave(){},stShow(){},ST_WW:660});
 vm.runInContext(src.slice(src.indexOf('function stRelatedChildren('),src.indexOf('function stToggleLayer(')),ctx);
 ctx.stToggleBranchLayout(parent);
 assert.equal(parent.branchLayout,'column');assert.equal(parent.kidsCollapsed,false);
 assert.equal(ctx.stBranchUnits(parent,kids).length,1);
 assert(kids.every(k=>k.par==='p'&&!k.branchDocked));assert.equal(other.par,'other');
 ctx.stToggleBranchLayout(parent);assert.equal(parent.branchLayout,'row');assert.equal(ctx.stBranchUnits(parent,kids).length,2);
});
