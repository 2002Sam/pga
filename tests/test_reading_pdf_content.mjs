import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code=fs.readFileSync('src/pga/web/app-reading-pdf-content.js','utf8');
const pdf=fs.readFileSync('src/pga/web/app-reading-pdf.js','utf8');
const ctx=vm.createContext({});
vm.runInContext(pdf.slice(pdf.indexOf('function readingPDFBlocks('),pdf.indexOf('function readingPDFLocate('))+code,ctx);
const viewport={width:600,height:800,transform:[1,0,0,1,0,0]};
const lib={Util:{transform:(_,t)=>t},OPS:{}};
const page={getOperatorList:async()=>({fnArray:[]}),getStructTree:async()=>null};
const run=(str,x,y,width,em=10)=>({str,transform:[1,0,0,em,x,y],width,fontName:'paper'});
async function classify(items,number=2,source=page){
  const blocks=ctx.readingPDFBlocks(items,viewport,lib);
  return ctx.readingPDFContentPolicy(source,{items},viewport,lib,blocks,number);
}
test('borderless text table stays in the original language while neighboring body prose is translated',async()=>{
  const cells=['Method','Result','Control group','Successful','New method','Unchanged'];
  const items=cells.map((s,i)=>run(s,i%2?320:80,160+Math.floor(i/2)*14,65));
  items.push(run('This short sentence matters.',80,240,140));
  const {blocks,tables}=await classify(items);
  assert.equal(tables.length,1);
  assert.deepEqual(Array.from(blocks.filter(b=>!b.sourceOnly),b=>b.text),['This short sentence matters.']);
});
test('two adjacent columns of ordinary prose remain translatable',async()=>{
  const items=[];
  for(const x of [50,315])for(let i=0;i<5;i++)items.push(run('A regular line of prose spanning the full column.',x,180+i*12,220));
  const {blocks,tables}=await classify(items);
  assert.equal(tables.length,0);assert.ok(blocks.every(b=>!b.sourceOnly));
});
test('tagged cells are excluded even within a mixed extraction block',async()=>{
  const items=[run('The following sentence is body text.',55,150,225),
    {type:'beginMarkedContentProps',id:'cell'},run('Unusually long descriptive text inside a single table cell.',55,163,225),{type:'endMarkedContent'}];
  const {blocks,tables}=await classify(items,2,{...page,getStructTree:async()=>({role:'Table',children:[{role:'TD',children:[{id:'cell'}]}]})});
  assert.equal(tables.length,1);
  assert.equal(blocks.length,2);assert.equal(blocks[0].sourceOnly,false);assert.equal(blocks[1].sourceOnly,true);
});
test('title, authors, short caption and footer stay original while abstract and long explanatory caption remain eligible',async()=>{
  const items=[run('A Paper About Robot Control',90,100,420,22),run('Author One, Author Two',160,145,220),
    run('Abstract: This paper explains how the robot collects observations and learns to manipulate objects.',70,220,460),
    run('Figure 1: Robot setup.',140,480,115),run('Figure 2: '+('This explanation describes the observations and their interpretation. ').repeat(3),70,550,450),run('1',300,750,5)];
  const {blocks}=await classify(items,1);
  assert.deepEqual(Array.from(blocks,b=>b.sourceOnly),[true,true,false,true,false,true]);
  const cover=await classify(items.slice(0,2),1);
  assert.ok(cover.blocks.every(b=>b.sourceOnly));
});
test('section boundaries distinguish numbered headings from run-in leads and small diagram labels',async()=>{
  const items=[run('3.3 Interactive Scene Initialization',50,95,285),
    run('Hand Pose Initialization. The reconstructed poses are refined across the sequence.',50,130,440),
    run('1 Object Pose Estimation',340,320,95,7),run('第十二章 实验方法',50,460,160)];
  const {blocks}=await classify(items);
  assert.deepEqual(Array.from(blocks,b=>b.sectionHeading),[true,false,false,true]);
});
test('section assembly waits for preceding pages and joins continuations at the last body block',()=>{
  const script=fs.readFileSync('src/pga/web/app-reading-pdf-insert.js','utf8');
  const context=vm.createContext({readerElement:()=>({rows:[],setAttribute(){},append(row){this.rows.push(row);}})});
  vm.runInContext(script,context);
  const body=text=>({text,row:text}),head=text=>({text,sectionHeading:true,sourceOnly:true});
  const first=body('starts here'),last=body('ends here'),next=body('next section');
  const makePage=blocks=>({ready:true,sectionParts:context.readingPDFSectionParts(blocks)});
  const pages=new Map([[1,{ready:false}],[2,makePage([last,head('3.4'),next])]]);
  const r={pdf:{numPages:2},pdfTextPages:pages};
  context.readingPDFIndexSections(r);
  assert.deepEqual(last.sectionSlot.rows,[]);
  pages.set(1,makePage([head('3.3'),first,{sourceOnly:true,text:'Table 1'}]));
  context.readingPDFIndexSections(r);
  assert.deepEqual(first.sectionSlot.rows,[]);
  assert.deepEqual(last.sectionSlot.rows,['starts here','ends here']);
  assert.deepEqual(next.sectionSlot.rows,['next section']);
});

test('reading groups count Han and Latin text, retain short sections and keep explanations with equations',()=>{
  const script=fs.readFileSync('src/pga/web/app-reading-pdf-insert.js','utf8');
  const context=vm.createContext({readerElement:()=>({rows:[],setAttribute(){},append(row){this.rows.push(row);}})});
  vm.runInContext(script,context);
  function group(texts){
    const blocks=texts.map((text,row)=>({text,row}));
    const page={ready:true,sectionParts:context.readingPDFSectionParts(blocks)};
    context.readingPDFIndexSections({pdf:{numPages:1},pdfTextPages:new Map([[1,page]])});
    return blocks.flatMap(b=>b.sectionSlot?.rows.length?[b.sectionSlot.rows]:[]);
  }
  const paragraph=n=>'Observations '+('provide '.repeat(n-2))+'evidence.';
  assert.deepEqual(group([paragraph(50),paragraph(60),paragraph(70)]),[[0,1,2]]);
  assert.deepEqual(group([paragraph(100),paragraph(95),'Joint Pose Refinement. '+paragraph(125)]),[[0,1],[2]]);
  assert.deepEqual(group(['中'.repeat(215)+'。','译'.repeat(135)+'。','文'.repeat(200)+'。']),[[0,1],[2]]);
  assert.equal(context.readingPDFReadLength('物体 pose refinement [2, 3]'),3.2);
  assert.equal(context.readingPDFCanPause('The loss is defined as:', 'L = R + D.'),false);
  assert.equal(context.readingPDFCanPause('L = R + D.', 'where D is the distance.'),false);
  assert.deepEqual(group([paragraph(360),paragraph(12)]),[[0,1]]);
});
