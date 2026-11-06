import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const project=fs.readFileSync(new URL('../src/pga/web/app-project.js',import.meta.url),'utf8');
const stage=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
function setup(){
 const handlers={},timers=new Map(),opened=[],jumps=[];let sequence=0,hidden=0;
 const ctx={PJ:{},document:{addEventListener:(name,fn)=>handlers[name]=fn},clearTimeout:id=>timers.delete(id),setTimeout:fn=>{timers.set(++sequence,fn);return sequence;},pjShared:p=>opened.push(p),stMapHideTip:()=>hidden++,stProjectJump:(...args)=>jumps.push(args)};ctx.window=ctx;
 vm.runInNewContext(project.slice(project.indexOf('// Keep map navigation'),project.indexOf('// A project has one shared page')),ctx);
 const event=(selector,detail=1)=>({target:{closest:s=>s.includes(selector)?{dataset:{pjmap:'PGA'}}:null},detail,clientX:100,clientY:20,preventDefault(){},stopImmediatePropagation(){}});
 return {ctx,handlers,opened,jumps,event,flush:()=>{for(const fn of timers.values())fn();timers.clear();},hidden:()=>hidden};
}
test('single click navigates without opening shared context',()=>{
 const h=setup();h.handlers.click(h.event('[data-pjmap]'));h.flush();assert.deepEqual(h.jumps,[['PGA',100,20]]);assert.deepEqual(h.opened,[]);
});
test('double click starts inline category rename and cancels pending navigation',()=>{
 const h=setup(),renamed=[];h.ctx.pjRenameInline=b=>renamed.push(b.dataset.pjmap);h.handlers.click(h.event('[data-pjmap]'));h.handlers.click(h.event('[data-pjmap]',2));h.handlers.dblclick(h.event('[data-pjmap]',2));h.flush();assert.deepEqual(renamed,['PGA']);assert.deepEqual(h.opened,[]);assert.deepEqual(h.jumps,[]);
});
test('hovering plus hides the stale thumbnail without navigating',()=>{
 const h=setup();h.handlers.pointerover(h.event('[data-pjnew]'));h.flush();assert.equal(h.hidden(),1);assert.deepEqual(h.jumps,[]);
});
test('project navigation chooses the hit conversation and never an adjacent project',()=>{
 const one={id:'one'},two={id:'two'},foreign={id:'foreign'},calls=[],tip={hidden:false};
 const ctx={ST:{mapHover:'one'},$:()=>tip,stMapHit:()=>({w:two}),stWins:()=>[one,two],stGroupOf:w=>({id:w===foreign?'pj:Other':'pj:PGA'}),stFocus:id=>calls.push(id),stShow:()=>{}};
 vm.runInNewContext(stage.slice(stage.indexOf('function stMapHideTip('),stage.indexOf('function stMapTip(')),ctx);
 ctx.stProjectJump('PGA',100,20);assert.deepEqual(calls,['two']);assert.equal(tip.hidden,true);assert.equal(ctx.ST.mapHover,null);
 ctx.stMapHit=()=>({w:foreign});ctx.stProjectJump('PGA',100,20);assert.deepEqual(calls,['two','one']);
});
test('a newer click elsewhere cancels the delayed project jump',()=>{
 const h=setup();h.handlers.click(h.event('[data-pjmap]'));h.handlers.pointerdown(h.event('[data-conversation]'));h.flush();assert.deepEqual(h.jumps,[]);
});
