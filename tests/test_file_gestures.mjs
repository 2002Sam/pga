import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../src/pga/web/app-stage-files.js', import.meta.url), 'utf8');
function harness() {
  const right = [], middle = [], shifts = [], edges = [], boundaries = [];
  const host = {}, c = vm.createContext({window:host,
    stRightPanBind:(doc, frame) => right.push({doc, frame}),
    stMiddlePanBind:(doc, frame) => middle.push({doc, frame}),
    stShiftWheel:e => { shifts.push(e); return !!e.shiftKey; },
    stBoundaryWheel:(e,y) => { boundaries.push(y); return false; },
    stEdgeWheel:(x,y) => { edges.push([x,y]); return Math.abs(x)>Math.abs(y); }});
  vm.runInContext(src.slice(src.indexOf('function stFileGestureFrame('),src.indexOf('function stFileDirty(')),c);
  const doc = (url='http://pga/preview') => ({URL:url, listeners:{}, frames:[],
    defaultView:{getComputedStyle:el=>({overflowX:el.overflowX||'visible'})},
    addEventListener(type,fn,opts){(this.listeners[type]||=[]).push({fn,opts});},
    querySelectorAll(){return this.frames;}});
  const frame = (document=doc(), owner=host, top=100, left=20) => ({contentDocument:document,
    ownerDocument:{defaultView:owner}, listeners:{}, getBoundingClientRect:()=>({top,left}),
    addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}});
  const wheel = (document, values={}) => {
    const e={deltaX:0,deltaY:80,clientY:50,target:{nodeType:1,closest:()=>null},
      preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...values};
    for(const {fn} of document.listeners.wheel||[])fn(e);
    return e;
  };
  return {c,host,doc,frame,wheel,right,middle,shifts,edges,boundaries};
}
test('file gestures bind current and nested documents once and survive preview reloads',()=>{
  const h=harness(), outer=h.frame(), inner=h.frame(h.doc(),{frameElement:outer},30,5);
  outer.contentDocument.frames=[inner];
  h.c.stFileGestureFrame(outer);h.c.stFileGestureFrame(outer);
  assert.equal(h.right.length,2);
  assert.equal(h.middle.length,2);
  assert.equal(outer.listeners.load.length,1);assert.equal(inner.listeners.load.length,1);
  assert.equal(inner.contentDocument.listeners.wheel.length,1);
  assert.equal(inner.contentDocument.listeners.wheel[0].opts.passive,false);
  assert.deepEqual({...h.right[1].frame.getBoundingClientRect()},{top:130,left:25});
  assert.equal(h.wheel(inner.contentDocument,{shiftKey:true}).prevented,true);
  const replacement=h.doc();inner.contentDocument=replacement;inner.listeners.load[0]();
  assert.equal(h.right.length,3);assert.equal(h.wheel(replacement,{shiftKey:true}).stopped,true);
  assert.equal(h.middle.length,3);
});
test('nested gestures retain the outer file page identity and accumulated coordinates',()=>{
  const h=harness(),outer=h.frame(),node={id:'file'},win={};
  outer.closest=selector=>selector==='.stnode'?node:selector==='.stfilewin'?win:null;
  const inner=h.frame(h.doc(),{frameElement:outer},30,5);
  outer.contentDocument.frames=[inner];h.c.stFileGestureFrame(outer);
  const context=h.middle[1].frame;
  assert.equal(context.closest('.stnode'),node);assert.equal(context.closest('.stfilewin'),win);
  assert.deepEqual({...context.getBoundingClientRect()},{left:25,top:130});
  assert.equal(h.right[1].frame,context);
});
test('late preview frames are bound through captured load events',()=>{
  const h=harness(), outer=h.frame();h.c.stFileGestureFrame(outer);
  const inner=h.frame();inner.tagName='IFRAME';
  outer.contentDocument.listeners.load[0].fn({target:inner});
  assert.equal(h.wheel(inner.contentDocument,{shiftKey:true}).prevented,true);
});
test('ordinary vertical scrolling, local horizontal scrollers and zoom keep their own events',()=>{
  const h=harness(), f=h.frame();h.c.stFileGestureFrame(f);const d=f.contentDocument;
  assert.equal(h.wheel(d).prevented,undefined);
  for(const flag of ['ctrlKey','metaKey'])assert.equal(h.wheel(d,{shiftKey:true,[flag]:true}).prevented,undefined);
  const scroll={nodeType:1,closest:()=>null,scrollWidth:900,clientWidth:200,overflowX:'auto'};
  assert.equal(h.wheel(d,{target:scroll,deltaX:80,deltaY:0}).prevented,undefined);
  assert.equal(h.wheel(d,{target:scroll,shiftKey:true}).prevented,true,'explicit stage gesture takes priority over local horizontal scrolling');
  assert.equal(h.wheel(d,{deltaX:80,deltaY:0}).prevented,true);
});
test('opaque frames remain isolated and accessible replacements can later bind',()=>{
  const h=harness(), f=h.frame(null);h.c.stFileGestureFrame(f);assert.equal(h.right.length,0);
  f.contentDocument=h.doc();f.listeners.load[0]();assert.equal(h.right.length,1);
  const blocked=h.frame();Object.defineProperty(blocked,'contentDocument',{get(){throw Error('SecurityError');}});
  assert.doesNotThrow(()=>h.c.stFileGestureFrame(blocked));
});
test('deferred editor menu uses the public action and preserves an existing selected range',()=>{
  const editorSource=fs.readFileSync(new URL('../src/pga/web/app-editor.js',import.meta.url),'utf8');
  let selected=true, inside=true, moves=0, actions=0;
  const editor={getDomNode:()=>({contains:()=>inside}),getTargetAtClientPoint:()=>({position:{lineNumber:4,column:3}}),
    getSelection:()=>({containsPosition:()=>selected}),setPosition:()=>moves++,focus(){},
    trigger:(_,action)=>{assert.equal(action,'editor.action.showContextMenu');actions++;}};
  const c=vm.createContext({window:{},fpActive:()=>({editor})});
  vm.runInContext(editorSource.slice(editorSource.indexOf('window.fpStageContextMenu ='),editorSource.indexOf('async function fpSave(')),c);
  assert.equal(c.window.fpStageContextMenu({},20,30),true);assert.equal(moves,0);assert.equal(actions,1);
  selected=false;c.window.fpStageContextMenu({},20,30);assert.equal(moves,1);assert.equal(actions,2);
  inside=false;assert.equal(c.window.fpStageContextMenu({},20,30),false);assert.equal(actions,2);
});
