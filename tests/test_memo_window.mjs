import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const src=fs.readFileSync('src/pga/web/app-memo-tabs.js','utf8');
test('memo opens as a separate stage window next to source and reuses it',()=>{
 const a={id:'a',key:'chat:a',type:'win',ord:0,bw:600},b={id:'b',key:'chat:b',type:'win',ord:1,bw:700};const ST={nodes:[a,b]};
 const c=vm.createContext({ST,S:{view:'stage'},toast(){},stFreezeWidths(){},stWins:()=>ST.nodes.slice().sort((a,b)=>a.ord-b.ord),stRender(){},stSave(){},stShow(){},Date});
 vm.runInContext(src.slice(src.indexOf('function memoWindowOpen('),src.indexOf('window.memoWindowOpen=')),c);
 c.memoWindowOpen('chat:a');const memo=ST.nodes.find(n=>n.memoSource==='chat:a');assert.ok(memo);assert.equal(memo.ord,1);assert.equal(b.ord,2);assert.equal(a.bw,600);assert.equal(b.bw,700);
 c.memoWindowOpen('chat:a');assert.equal(ST.nodes.length,3);
 c.memoWindowOpen('chat:b');assert.equal(ST.nodes.length,4);assert.equal(ST.nodes.find(n=>n.memoSource==='chat:b').ord,b.ord+1);
});
