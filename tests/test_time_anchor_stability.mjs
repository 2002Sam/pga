import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
test('open manager retains its source conversation when stage focus changes',()=>{
 const nodes=[{id:'a',key:'chat:a'},{id:'b',key:'chat:b'}];
 const arena={scrollLeft:100,clientWidth:1000};
 const c=vm.createContext({MP:{open:true,source:'chat:a'},ST:{focus:'b',pos:new Map([['a',{x:200,w:400}],['b',{x:600,w:400}]])},$:()=>arena,stWins:()=>nodes});
 vm.runInContext(src.slice(src.indexOf('function stAnchor()'),src.indexOf('function stKeepAnchor(')),c);
 assert.equal(c.stAnchor().id,'a');assert.equal(c.stAnchor().dx,100);
 c.MP.open=false;assert.equal(c.stAnchor().id,'b');
});
test('promotion in time order does not schedule navigation, including reduced motion',()=>{
 for(const reduce of [false,true]) {
 let timers=0,navigation=0;
 const arena={scrollLeft:200,getBoundingClientRect:()=>({left:0,right:1000,width:1000})};
 const el={style:{left:'0px',top:'0px',width:'400px',height:'500px'},dataset:{nid:'a'},getBoundingClientRect:()=>({left:100,right:500,top:0})};
 const c=vm.createContext({ST:{nodes:[],sortAlignTimer:123},window:{matchMedia:()=>({matches:reduce})},$:()=>arena,clearTimeout(){},setTimeout(){timers++},stNavigationStart(){navigation++},performance:{now:()=>0}});
 vm.runInContext(src.slice(src.indexOf('function stReorderEnd('),src.indexOf('function stRender()')),c);
 c.stReorderEnd([{e:el,rect:{left:100,right:500,top:0},layout:'900px|0px|400px|500px',scroll:200,transition:''}],{id:'a',dx:100});
 assert.equal(timers,0);assert.equal(navigation,0);assert.equal(c.ST.sortAlignTimer,null);
 }
});
