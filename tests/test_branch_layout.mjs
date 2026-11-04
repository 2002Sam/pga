import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/pga/web/app-stage.js', import.meta.url), 'utf8');
const start = source.indexOf('    if (u.kind === "stack") {                     // branches:');
const block = source.slice(start, source.indexOf('    const zones =', start));
function layout(count, selected, height) {
  const wins = Array.from({length:count}, (_,i)=>({id:`child-${i}`}));
  const positions = new Map();
  const context = vm.createContext({
    u:{kind:'stack',wins,par:{sel:`child-${selected}`},x:200,w:600}, A:{h:height}, ST:{focus:`child-${selected}`},pos:positions,esc:x=>x,
    el:()=>({classList:{toggle(){},add(){},remove(){},contains(){return false;}},querySelector(){return null;}}),
    place(){}, stMiniLook(){},stShortLook(){},stKidKeep(){},stKidLook(){},stWsLook(){},stSmallLook(){},L:zh=>zh
  });
  vm.runInContext(source.slice(source.indexOf("function stBranchHeights("),source.indexOf("function stResizeBranchPair(")),context);
  vm.runInContext(`let barHtml=""; for(let once=0;once<1;once++){${block}}`,context);
  return Array.from(positions.values(), p=>({...p}));
}
for(const [count,height] of [[2,900],[3,650],[6,500]]) {
  test(`${count} siblings retain identical positions and sizes across every focus change`,()=>{
    const initial = layout(count,0,height);
    for(let selected=1;selected<count;selected++) assert.deepEqual(layout(count,selected,height),initial);
    assert.ok(initial.every(p=>p.h>0 && p.h===initial[0].h));
  });
}
test('canvas wheel no longer selects a sibling or intercepts vertical scrolling',()=>{
  const start = source.indexOf('  arena.addEventListener("wheel",');
  const end = source.indexOf('  arena.addEventListener("contextmenu",',start);
  let handler;
  const context = vm.createContext({arena:{addEventListener:(_,fn)=>{handler=fn;}},stEdgeWheel:(dx,dy)=>Math.abs(dx)>Math.abs(dy)});
  vm.runInContext(source.slice(start,end),context);
  let prevented=false;
  handler({deltaX:0,deltaY:120,preventDefault(){prevented=true;}});
  assert.equal(prevented,false);
  assert.ok(!source.includes('stBranchWheel'));
});

test('divider changes only its two neighbors and preserves total height and focus independence',()=>{
  const context=vm.createContext({});
  vm.runInContext(source.slice(source.indexOf('function stBranchHeights('),source.indexOf('function stDetachBranch(')),context);
  const wins=[{branchWeight:200},{branchWeight:200},{branchWeight:200}];
  context.stResizeBranchPair({top:wins[0],bottom:wins[1],topHeight:200,bottomHeight:200},70);
  assert.deepEqual(Array.from(context.stBranchHeights(wins,600)),[270,130,200]);
  context.stResizeBranchPair({top:wins[0],bottom:wins[1],topHeight:270,bottomHeight:130},9999);
  assert.deepEqual(Array.from(context.stBranchHeights(wins,600)),[310,90,200]);
  const restored=JSON.parse(JSON.stringify(wins));
  assert.deepEqual(Array.from(context.stBranchHeights(restored,600)),[310,90,200]);
});

test('title drag detaches a branch without changing its identity, descendants or iframe',()=>{
  const frame={};
  const parent={id:'p',key:'chat:parent',kids:['a','b'],sel:'a',ord:0};
  const child={id:'a',key:'chat:a',branchKey:'chat:a',par:'p',kids:['grandchild'],el:frame,branchWeight:200};
  const sibling={id:'b',key:'chat:b',par:'p'};
  const context=vm.createContext({ST:{nodes:[parent,child,sibling],pos:new Map([['a',{w:420}]])},ST_WW:660,
    stFreezeWidths(){},stKids:n=>n.kids.map(id=>[child,sibling].find(k=>k.id===id)),stWins:()=>[parent,child,sibling],stRender(){},stSave(){}});
  vm.runInContext(source.slice(source.indexOf('function stDetachBranch('),source.indexOf('// A tucked branch')),context);
  context.stDetachBranch(child);
  assert.equal(child.par,undefined); assert.equal(child.key,'chat:a'); assert.equal(child.branchKey,'chat:a');
  assert.equal(child.branchParent,'p'); assert.equal(child.branchFrom,'chat:parent');
  assert.equal(child.el,frame); assert.equal(child.from,'chat:parent'); assert.equal(child.bw,420);
  assert.deepEqual(child.kids,['grandchild']); assert.deepEqual(parent.kids,['b']); assert.equal(parent.sel,'b');
  assert.equal(sibling.par,'p');
});
