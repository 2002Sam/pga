import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-more.js',import.meta.url),'utf8');
test('one marker represents a question and answer, with branching after the round',()=>{
  const box={classList:{add(){},remove(){}},innerHTML:''};
  const ctx=vm.createContext({$:()=>box,hideRailTip(){},S:{view:'chats',chat:'chat:p',chatTurns:{'chat:p':[
    {role:'user',run:'r1',text:'问题一'},{role:'agent',run:'r1',text:'回答一'},
    {role:'user',run:'r2',text:'问题二'},{role:'agent',run:'r2',text:'回答二'}]}},
    convMapKids:()=>[],L:x=>x,esc:x=>String(x),syncMap(){},requestAnimationFrame(){},convMapWires(){}});
  vm.runInContext(src.slice(src.indexOf('function convMap()'),src.indexOf("document.addEventListener('contextmenu'",src.indexOf('function convMap()'))),ctx);
  ctx.convMap();
  assert.match(box.innerHTML,/data-mgo="t-r1"[^>]*data-railfork="r1"/);
  assert.match(box.innerHTML,/data-mgo="t-r2"[^>]*data-railfork="r2"/);
  assert.equal((box.innerHTML.match(/data-mgo=/g)||[]).length,2);
  assert.match(box.innerHTML,/data-preview-title="问题一" data-preview="回答一"/);

});
test('opening inherited history scrolls its own container to the last message',()=>{
  const chats=fs.readFileSync(new URL('../src/pga/web/app-chats.js',import.meta.url),'utf8');
  let toggle;
  const ctx=vm.createContext({document:{addEventListener:(name,fn)=>{toggle=fn;}},requestAnimationFrame:fn=>fn()});
  const start=chats.indexOf("document.addEventListener('toggle'");
  vm.runInContext(chats.slice(start,chats.indexOf('function stageNodeOf()',start)),ctx);
  const body={scrollTop:0,scrollHeight:3200};
  toggle({target:{matches:()=>true,open:true,querySelector:()=>body}});
  assert.equal(body.scrollTop,3200);
  body.scrollTop=30; toggle({target:{matches:()=>true,open:false,querySelector:()=>body}});
  assert.equal(body.scrollTop,30);
});
