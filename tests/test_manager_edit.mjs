import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src=fs.readFileSync(new URL('../src/pga/web/app-pmdoc.js',import.meta.url),'utf8');
function setup(){
 const handlers={},timers=new Map(),calls=[];let seq=0;
 const c={S:{},chatSend(){},document:{querySelector:()=>({}),addEventListener:(type,fn)=>(handlers[type] ||= []).push(fn)},L:x=>x,setInterval(){},setTimeout:fn=>{timers.set(++seq,fn);return seq;},clearTimeout:id=>timers.delete(id)};
 c.window=c;vm.createContext(c);vm.runInContext(src,c);
 c.pdBeside=(...args)=>calls.push(['go',...args]);c.pdEditBranch=(...args)=>calls.push(['edit',...args]);
 const para={dataset:{pdgo:'chat:a',pdrun:'r2',pdfind:'same'},querySelector:()=>null};
 const target={closest:sel=>sel==='[data-pdgo]'||sel==='.pdpara[data-pdgo]'?para:null};
 return {c,calls,emit:(type,detail)=>handlers[type].at(-1)({target,detail,preventDefault(){}}),flush:()=>{for(const f of timers.values())f();timers.clear();}};
}
test('single click opens the same exact input target; double click cancels navigation and edits once',()=>{
 let h=setup();h.emit('click',1);assert.equal(h.calls.length,0);h.flush();assert.deepEqual(h.calls,[['go','chat:a','r2','same']]);
 h=setup();h.emit('click',1);h.emit('click',2);h.emit('dblclick',2);h.flush();assert.deepEqual(h.calls,[['edit','chat:a','r2','same']]);
});
test('edit branches before the exact run, supports first input and refuses missing input',()=>{
 const {c}=setup();const turns=[{role:'user',run:'r1',text:'same first'},{role:'agent',run:'r1',text:'reply'},{role:'user',run:'r2',text:'same second'},{role:'agent',run:'r2',text:'later reply'}];
 assert.deepEqual(JSON.parse(JSON.stringify(c.pdEditPoint(turns,'r2','same'))),{upto:'r1',text:'same second'});
 assert.equal(c.pdEditPoint(turns,'','same first').upto,'0');
 assert.equal(c.pdEditPoint(turns,'missing','no match'),null);
});
test('branch edit preloads a fresh composer without changing or sending the source',async()=>{
 const {c}=setup();const calls=[],input={value:'',dispatchEvent(){},focus(){calls.push('focus');},setSelectionRange(){}};
 const w={S:{chat:'child',chatTurns:{child:[]}},document:{querySelector:()=>input},Event:class{}};
 const source={el:{querySelector:()=>({contentWindow:{S:{chat:'parent',chatTurns:{parent:[{role:'user',run:'r1',text:'original'}]}}}})}};
 const host={stBranchAt:async(n,key,upto)=>{calls.push([n===source,key,upto]);return {key:'child',el:{querySelector:()=>({contentWindow:w})}};}};
 c.pmHost=()=>host;c.pdBeside=()=>source;c.toast=x=>{throw Error(x);};
 // Restore the actual implementation overwritten by the click harness.
 vm.runInContext(src.slice(src.indexOf('async function pdEditBranch('),src.indexOf('let pdClickTimer;')),c);
 await c.pdEditBranch('parent','r1','original');
 assert.deepEqual(calls,[[true,'parent','0'],'focus']);assert.equal(input.value,'original');assert.equal(w.S.chatDraft,'original');
});
