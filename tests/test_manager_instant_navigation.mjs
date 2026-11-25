import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const pm=fs.readFileSync('src/pga/web/app-stage-pm.js','utf8');
const stage=fs.readFileSync('src/pga/web/app-stage.js','utf8');
function readyHarness(){
 const calls=[],state={stageDormant:true,stageMotion:true},frame={contentWindow:{S:state,pgaStageActivated(){calls.push('activate')}}};
 const manager={id:'m',managerProject:'PGA',el:{querySelector:()=>frame}},arena={scrollLeft:321};
 const c=vm.createContext({ST:{focus:'m',movedAt:123,scrollEndTimer:17},$:()=>arena,clearTimeout:t=>calls.push(['clear',t]),
  stFrameMotion:m=>calls.push(['motion',m]),stFrameStart:(f,url)=>calls.push(['load',f,url]),stScheduleFrameLoads:d=>calls.push(['schedule',d])});
 c.stFrame=()=>calls.push('restore');c.stFrame.pending=new Map();c.window=c;
 vm.runInContext(pm.slice(pm.indexOf('window.stPmReady =')),c);
 return {c,calls,state,frame,manager,arena};
}
test('selected manager starts ahead of pending background frames without reloading a cached document',()=>{
 const h=readyHarness();h.c.stFrame.pending.set(h.frame,'/?c=chat%3Apm-test');
 h.c.stPmReady(h.manager);
 assert.equal(h.c.ST.movedAt,-Infinity);assert.equal(h.c.ST.managerScrollLeft,321);
 assert.equal(h.state.stageDormant,false);assert.equal(h.state.stageMotion,false);
 assert.equal(h.c.stFrame.pending.size,0);assert.equal(h.calls.filter(c=>c[0]==='load').length,1);
 h.c.stPmReady(h.manager);assert.equal(h.calls.filter(c=>c[0]==='load').length,1);
});
test('a superseded or parked manager never takes foreground priority',()=>{
 const h=readyHarness();h.c.ST.focus='other';h.c.stPmReady(h.manager);assert.deepEqual(h.calls,[]);
 h.c.ST.focus='m';h.manager.managerParked=true;h.c.stPmReady(h.manager);assert.deepEqual(h.calls,[]);
});
test('only the scroll caused by the instant jump skips the gesture quiet period',()=>{
 const calls=[],arena={scrollLeft:500},c=vm.createContext({ST:{managerScrollLeft:500},S:{view:'stage'},$:()=>arena,
  performance:{now:()=>1000},stFrame:{timer:1},clearTimeout(){},setTimeout:()=>12,requestAnimationFrame:f=>(calls.push('raf'),1),
  stScrollSettled(){},stFrameMotion:()=>calls.push('motion'),stScheduleFrameLoads:()=>calls.push('loads')});
 vm.runInContext(stage.slice(stage.indexOf('let stScrollFrame ='),stage.indexOf('document.addEventListener("scroll", stScheduleScroll')),c);
 c.stScheduleScroll({target:{id:'starena'}});assert.deepEqual(calls,['loads','raf']);assert.equal(c.ST.managerScrollLeft,undefined);
 arena.scrollLeft=600;c.stScheduleScroll({target:{id:'starena'}});assert.ok(calls.includes('motion'));assert.equal(c.ST.movedAt,1000);
});
