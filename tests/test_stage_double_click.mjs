import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
test('repeated frame load hooks bind double click once and Escape restores',()=>{
 const handlers=new Map(), n={id:'n'}, doc={addEventListener(k,f){handlers.set(k,[...(handlers.get(k)||[]),f]);},createElement:()=>({}),head:{appendChild(){}}};
 const cw={document:doc,getSelection:()=>({removeAllRanges(){}})};
 const c=vm.createContext({ST_DBL_SKIP:'input',stFocus(){},stMax(n,on){n.big=on;}});
 vm.runInContext(src.slice(src.indexOf('function stHold('),src.indexOf('function stDragSoon(')),c);
 c.stHold({contentWindow:cw},n);c.stHold({contentWindow:cw},n);
 assert.equal(handlers.get('dblclick').length,1);
 const event={target:{closest:()=>null}};
 handlers.get('dblclick')[0](event);assert.equal(n.big,true);
 handlers.get('dblclick')[0](event);assert.equal(n.big,false);
 n.big=true;handlers.get('keydown')[0]({key:'Escape'});assert.equal(n.big,false);
});
test('enlarge uses rendered width and restores saved geometry',()=>{
 const n={id:'n',bw:660}, ST={nodes:[n],pos:new Map([['n',{w:1003}]])};
 const c=vm.createContext({ST,ST_WW:660,stWins:()=>[n],stArena:()=>({w:1600}),stRender(){},stSave(){},stMap(){},stShow(){}});
 vm.runInContext(src.slice(src.indexOf('function stMax('),src.indexOf('async function stRepairBranchKeys')),c);
 c.stMax(n,true);assert.equal(n.bigWidth,1360);assert.equal(n.bw,660);
 c.stMax(n,false);assert.equal(n.big,undefined);assert.equal(n.bigWidth,undefined);assert.equal(n.bw,660);
});
