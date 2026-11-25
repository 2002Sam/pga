import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-more.js',import.meta.url),'utf8');
function harness(){
 const els={},calls=[];
 const parentFrame={getBoundingClientRect:()=>({top:100}),contentWindow:{convMapAnchor:()=>({y:180}),S:{chat:'parent'}},contentDocument:{getElementById:id=>id==='a-cut'?{scrollIntoView:o=>calls.push(['scroll',id])}:null}};
 const host={ST:{nodes:[{key:'parent',type:'win',el:{querySelector:()=>parentFrame}}]},stOpen:key=>{calls.push(['open',key]);return {el:{querySelector:()=>parentFrame}}}};
 const S={view:'chats',chat:'child',chatCtx:{child:{branch:{from:'parent',upto:'cut'},parent_title:'Mother'}}};
 const doc={getElementById:id=>els[id],querySelector:()=>({getBoundingClientRect:()=>({top:0,bottom:700,right:640})}),createElement:()=>({dataset:{},style:{setProperty(k,v){this[k]=v}},setAttribute(){},remove(){delete els.railReturn}}),body:{append:b=>{els[b.id]=b}}};
 const window={parent:host,frameElement:{getBoundingClientRect:()=>({top:100})},addEventListener(){}};
 const context=vm.createContext({S,document:doc,window,innerHeight:700,L:x=>x});
 const chats = fs.readFileSync(new URL('../src/pga/web/app-chats.js', import.meta.url), 'utf8');
 vm.runInContext(chats.slice(chats.indexOf('function executionFeedOf('), chats.indexOf('async function openSourceChat(')), context);
 vm.runInContext(src.slice(src.indexOf('// One deterministic color')),context);
 return {context,S,els,calls};
}
test('child return tick aligns with the parent tick and shares its stable color',()=>{
 const h=harness();h.context.updateParentRail();const b=h.els.railReturn;
 assert.equal(b.dataset.mparent,'parent');assert.equal(b.dataset.parentPoint,'cut');
 assert.equal(b.style.top,'172px');assert.equal(b.style['--pair-color'],h.context.railPairColor('child'));
 assert.notEqual(h.context.railPairColor('child'),h.context.railPairColor('sibling'));
 h.context.updateParentRail();assert.equal(h.els.railReturn,b);
});
test('return tick opens the mother and locates the precise fork answer',async()=>{
 const h=harness();await h.context.returnToParent('parent','cut');
 assert.deepEqual(h.calls,[['open','parent'],['scroll','a-cut']]);
});
test('return tick clears when switching away, including empty conversations',()=>{
 const h=harness();h.context.updateParentRail();h.S.chat='unrelated';h.context.updateParentRail();assert.equal(h.els.railReturn,undefined);
});
test('an off-screen parent marker is clamped to visible child bounds',()=>{
 const h=harness();assert.equal(h.context.parentRailPosition(50,100,48,600),48);assert.equal(h.context.parentRailPosition(900,100,48,600),600);
});

test('a worker links back to its execution feed without a saved fork', () => {
 const h=harness();
 h.S.chat='chat:mt-'+'a'.repeat(20)+'-execute-'+'b'.repeat(32);
 h.S.chatTurns={[h.S.chat]:[{role:'user',run:'original'}]};
 h.context.updateParentRail();
 assert.equal(h.els.railReturn.dataset.mparent,'chat:summary-'+'a'.repeat(20)+'-execute');
 assert.equal(h.els.railReturn.dataset.parentPoint,'original');
});
