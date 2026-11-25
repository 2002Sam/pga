import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-more.js',import.meta.url),'utf8');
test('one marker represents a question and answer, with branching after the round',()=>{
  const box={classList:{add(){},remove(){}},innerHTML:''};
  const ctx=vm.createContext({BRANCH_SHOWN:40,$:()=>box,hideRailTip(){},S:{view:'chats',chat:'chat:p',chatTurns:{'chat:p':[
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
test('what a branch grew from shows as the conversation itself, not in a box; a line marks where the branch starts',()=>{
  const chats=fs.readFileSync(new URL('../src/pga/web/app-chats.js',import.meta.url),'utf8');
  const ctx=vm.createContext({BRANCH_SHOWN:40,S:{allChats:[{key:'chat:p',title:'论文汇总'}],chatCtx:{}},L:(zh)=>zh,esc:String,chatTurnsHtml:(turns)=>turns.map(t=>`<${t.role}:${t.text}>`).join('')});
  vm.runInContext(chats.slice(chats.indexOf('const BRANCH_SHOWN'),chats.indexOf('function stageNodeOf()')),ctx);
  ctx.S.chatCtx['chat:b']={branch:{from:'chat:p',upto:'r2'},context:[{role:'user',text:'q1'},{role:'assistant',text:'a1',agent:'claude'},{role:'user',text:'q2'},{role:'assistant',text:'a2'}]};
  const html=ctx.branchCtx('chat:b');
  assert.doesNotMatch(html,/<details/);
  assert.match(html,/<user:q1><agent:a1><user:q2><agent:a2><div class="bctxsep"><span>以上 2 轮来自「论文汇总」 · 从这里接着聊<\/span>/);
  ctx.S.chatCtx['chat:b'].context=Array.from({length:50},(_,i)=>({role:i%2?'assistant':'user',text:'t'+i}));
  const long=ctx.branchCtx('chat:b');
  assert.match(long,/更早的 5 轮在「论文汇总」里/);assert.match(long,/<user:t10>/);assert.doesNotMatch(long,/<user:t8>/);
  assert.equal(ctx.branchCtx('chat:plain'),'');
});
test('a branch not talked in yet opens at its fork point once, then stays where you read',()=>{
  const chats=fs.readFileSync(new URL('../src/pga/web/app-chats.js',import.meta.url),'utf8');
  assert.match(chats,/const forkView = !!S\.chatCtx\?\.\[S\.chat\]\?\.branch && !turns\.length && !\(S\.forkSeen \|\|= \{\}\)\[S\.chat\];/);
  assert.match(chats,/if \(S\.scrollChat \|\| forkView \|\| \(S\.sending && following\)\)/);
});

test('inherited replies expose snapshot branch points under the current parent without mutable ancestor actions',()=>{
  const chats=fs.readFileSync(new URL('../src/pga/web/app-chats.js',import.meta.url),'utf8');
  const S={chat:'chat:child',chatCtx:{'chat:child':{branch:{from:'chat:root'},context:Array.from({length:50},(_,i)=>({role:i%2?'assistant':'user',text:'turn '+i,run:'original-'+Math.floor(i/2)}))}}};
  const ctx=vm.createContext({S,replyMeta:()=>"",L:x=>x,esc:String,agentLabel:x=>x,md:x=>x,PGATree:{chat:ts=>ts.map(t=>`<p>${t.text}</p>`).join('')}});
  const compose=fs.readFileSync(new URL('../src/pga/web/app-compose.js',import.meta.url),'utf8');
  vm.runInContext(compose.slice(compose.indexOf('function questionBranchButton('), compose.indexOf('function userActs(')),ctx);
  vm.runInContext(chats.slice(chats.indexOf('function chatTurnsHtml('),chats.indexOf('function secondHtml(')),ctx);
  vm.runInContext(chats.slice(chats.indexOf('const BRANCH_SHOWN'),chats.indexOf('function stageNodeOf()')),ctx);
  const html=ctx.branchCtx('chat:child');
  assert.equal((html.match(/data-cbranch=/g)||[]).length,40);
  assert.match(html,/data-cbranch="question:context:11" data-ckey="chat:child"/);
  assert.match(html,/data-cbranch="context:12" data-ckey="chat:child"/);
  assert.match(html,/data-cbranch="context:50" data-ckey="chat:child"/);
  assert.doesNotMatch(html,/data-act="(?:regen|edit|rate)"|data-second=/);
});
