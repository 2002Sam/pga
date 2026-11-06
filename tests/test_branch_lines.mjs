import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const stage=fs.readFileSync(new URL('../src/pga/web/app-stage.js',import.meta.url),'utf8');
const ctx=vm.createContext({});vm.runInContext(stage.slice(stage.indexOf('function stBranchLine('),stage.indexOf('function stWires()')),ctx);
test('bottom elbows stay attached while windows approach, touch or overlap',()=>{
 const a={x:0,y:20,w:400,h:600};
 for(const x of [600,410,400,390]) {
  const l=ctx.stBranchLine(a,{x,y:20,w:400,h:600});
  assert.equal(l.path,`M 200 620 V 632 H ${x+200} V 620`);
 }
});
test('stacked children route below the full row through the side gutter',()=>{
 const a={x:0,y:20,w:400,h:600};
 for(const y of [20,220,420]) {
  const b={x:430,y,w:300,h:190,kid:true},l=ctx.stBranchLine(a,b,644);
  assert.equal(l.path,`M 200 620 V 644 H 424 V ${y+194} H 438 V ${y+190}`);
 }
 const l=ctx.stBranchLine(a,{x:430,y:700,w:300,h:100});
 assert.equal(l.path,'M 200 620 V 812 H 580 V 800');
});
test('selection lengthens only the immediately adjacent ticks and clears old state',()=>{
 const src=fs.readFileSync(new URL('../src/pga/web/app-more.js',import.meta.url),'utf8');
 const marks=Array.from({length:5},()=>{const classes=new Set();return {classes,classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name)}}});
 const c=vm.createContext({$:()=>({querySelectorAll:()=>marks})});vm.runInContext(src.slice(src.indexOf('function railSelect('),src.indexOf('function syncMap()')),c);
 c.railSelect(marks[2]);assert(marks[2].classes.has('on'));assert(marks[1].classes.has('near'));assert(marks[3].classes.has('near'));assert(!marks[0].classes.has('near'));
 c.railSelect(marks[0]);assert(marks[1].classes.has('near'));assert(!marks[3].classes.has('near'));assert(!marks[2].classes.has('on'));
});

test('a branch moved to the left keeps bottom endpoints',()=>{
 const l=ctx.stBranchLine({x:500,y:0,w:300,h:500},{x:100,y:0,w:300,h:500},200);
 assert.equal(l.path,'M 650 500 V 512 H 250 V 500');
});

test('every visible sibling gets a wire; a tucked sibling loses only its own wire', () => {
 const parent={id:'p',type:'win',kids:['a','b'],sel:'b'},a={id:'a',type:'win',par:'p'},b={id:'b',type:'win',par:'p'};
 const ST={nodes:[parent,a,b],pos:new Map([['p',{x:0,y:0,w:400,h:600}],['a',{x:434,y:0,w:400,h:295,kid:true}],['b',{x:434,y:305,w:400,h:295,kid:true}]])};
 const svg={};const c=vm.createContext({ST,$:()=>svg,stWins:()=>ST.nodes,stOver(){},requestAnimationFrame:()=>1});
 vm.runInContext(stage.slice(stage.indexOf('function stBranchLine('),stage.indexOf('function stFrame(')),c);
 c.stWires();assert.equal((svg.innerHTML.match(/class="stwire fork/g)||[]).length,2);
 ST.pos.delete('a');c.stWires();assert.equal((svg.innerHTML.match(/class="stwire fork/g)||[]).length,1);
 assert.match(svg.innerHTML,/ H 428/);
});
