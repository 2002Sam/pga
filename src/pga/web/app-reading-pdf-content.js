// Prefer the PDF's structural tags. Many papers omit them, so use the text
// baselines, aligned cells and table rules from the same PDF.js viewport.
async function readingPDFContentPolicy(page,content,viewport,lib,blocks,number,outline) {
  const headingRuns=new Set(),excluded=new Set(), runs=[],stack=[],tagged=new Map(),taggedTables=new Map();
  if(content.items.some(item=>item.type==='beginMarkedContentProps'&&item.id)){
    const tree=await page.getStructTree().catch(()=>null);
    function visit(node,skip,table,heading){
      if(!node)return;
      if(node.role==='Table')table=node;
      heading=heading||/^H[1-6]?$/.test(node.role);
      skip=skip||/^(?:Table|TH|TD|H[1-6]?|Title|Artifact)$/.test(node.role);
      if(skip&&node.id)tagged.set(node.id,{table,heading});
      for(const child of node.children||[])visit(child,skip,table,heading);
    }
    visit(tree,false);
  }
  for(const item of content.items){
    if(typeof item.str!=='string'){
      if(item.type==='endMarkedContent')stack.pop();
      else if(item.type?.startsWith('beginMarkedContent')){
        const parent=stack.at(-1);
        const tag=tagged.get(item.id)||(/^(?:Artifact|Table|TH|TD|H[1-6]?|Title)$/.test(item.tag)?{table:item.tag==='Table'?item:null,heading:/^H[1-6]?$/.test(item.tag)}:null);
        stack.push(parent?.table?parent:tag||parent);
      }
      continue;
    }
    const t=lib.Util.transform(viewport.transform,item.transform);
    const run={index:runs.length,x:t[4],y:t[5],right:t[4]+item.width,em:Math.hypot(t[2],t[3]),text:item.str};
    const tag=stack.at(-1);
    if(tag)excluded.add(run.index);
    if(tag?.heading&&!tag.table)headingRuns.add(run.index);
    if(tag?.table && run.text.trim()){
      const box=taggedTables.get(tag.table);
      if(box){
        box.left=Math.min(box.left,run.x);box.right=Math.max(box.right,run.right);
        box.top=Math.min(box.top,run.y-run.em);box.bottom=Math.max(box.bottom,run.y+1);
      }else taggedTables.set(tag.table,{left:run.x,right:run.right,top:run.y-run.em,bottom:run.y+1});
    }
    runs.push(run);
  }
  const rows=[];
  for(const run of runs.filter(r=>r.text.trim()).sort((a,b)=>a.y-b.y)){
    let row=rows.at(-1);
    if(!row||run.y-row.y>Math.min(run.em,row.em)*.4){
      rows.push(row={y:run.y,em:run.em,runs:[],cells:[]});
    }
    row.runs.push(run);
  }
  for(const row of rows){
    for(const run of row.runs.sort((a,b)=>a.x-b.x)){
      const cell=row.cells.at(-1);
      if(cell && run.x-cell.right<row.em*1.1){
        cell.right=Math.max(cell.right,run.right);cell.text+=' '+run.text;
      }else row.cells.push({x:run.x,right:run.right,text:run.text});
    }
  }
  const tables=[];
  const inBox=(run,b)=>run.y>=b.top&&run.y<=b.bottom&&
    (run.x+run.right)/2>=b.left-1&&(run.x+run.right)/2<=b.right+1;
  if(rows.some(row=>row.cells.length>=2)){
    const rules=await readingPDFTableRules(page,viewport,lib).catch(()=>[]);
    for(let i=0;i<rules.length;i++){
      const a=rules[i],b=rules.slice(i+1).find(q=>q.y>a.y+2&&Math.abs(q.x-a.x)<3&&Math.abs(q.right-a.right)<3);
      if(!b)continue;
      const box={left:a.x,right:a.right,top:a.y-1,bottom:b.y+1};
      const within=rows.filter(row=>row.y>=box.top&&row.y<=box.bottom)
        .map(row=>row.cells.filter(c=>c.x>=box.left-2&&c.right<=box.right+2)).filter(cells=>cells.length);
      if(within.length && within.filter(cells=>cells.length>=2).length>=within.length*.45)tables.push(box);
    }
    // Borderless tables have repeatedly aligned short cells on adjacent rows.
    // Two broad columns of prose, or short labels sharing just one baseline,
    // are insufficient evidence of a table.
    const aligned=(a,b,em)=>Math.min(Math.abs(a.x-b.x),Math.abs(a.right-b.right),
      Math.abs(a.x+a.right-b.x-b.right)/2)<em*.55;
    let group=[];
    function flush(){
      const compactRows=group.filter(row=>row.cells.length>=3 || row.cells.some(c=>
        c.right-c.x<viewport.width*.23 && c.text.length<30 &&
        (c.text.trim().split(/\s+/).length<=4||/\d/.test(c.text))));
      if(group.length>=3 && compactRows.length>=group.length*.7){
        const cells=group.flatMap(row=>row.cells);
        tables.push({left:Math.min(...cells.map(c=>c.x)),right:Math.max(...cells.map(c=>c.right)),
          top:group[0].y-group[0].em,bottom:group.at(-1).y+1});
      }
      group=[];
    }
    for(const row of rows){
      if(tables.some(b=>row.y>=b.top&&row.y<=b.bottom) || row.cells.length<2 ||
         row.cells.some(c=>c.text.length>64||c.right-c.x>viewport.width*.46)){
        flush();continue;
      }
      const prev=group.at(-1);
      if(prev&&(row.y-prev.y>row.em*2.1 || row.cells.filter(c=>prev.cells.some(p=>aligned(c,p,row.em))).length<2))flush();
      group.push(row);
    }
    flush();
  }
  for(const run of runs)if(tables.some(b=>inBox(run,b)))excluded.add(run.index);
  tables.push(...taggedTables.values());

  // Split a mixed extraction block at table/tag boundaries before sending it
  // to translation. Preserve the original indices for selection and citations.
  const items=content.items.filter(item=>typeof item.str==='string');
  let next=Math.max(-1,...blocks.map(b=>Number(b.id.slice(1))))+1;
  const split=[];
  for(const block of blocks){
    const groups=[];
    for(const index of block.indices){
      const skip=excluded.has(index);
      if(!groups.length||groups.at(-1).skip!==skip)groups.push({skip,indices:[]});
      groups.at(-1).indices.push(index);
    }
    if(groups.length===1){block.sourceOnly=groups[0].skip;split.push(block);continue;}
    let first=true;
    for(const group of groups){
      for(const part of readingPDFBlocks(group.indices.map(i=>items[i]),viewport,lib)){
        part.indices=part.indices.map(i=>group.indices[i]);part.style.sample=group.indices[part.style.sample];
        part.sourceOnly=group.skip;part.id=first?block.id:'p'+next++;first=false;split.push(part);
      }
    }
  }
  const body=split.filter(b=>!b.sourceOnly&&b.text.length>100);
  const bodySizes=body.map(b=>b.style.size).sort((a,b)=>a-b);
  const bodySize=bodySizes[Math.floor(bodySizes.length/2)]||10;
  const abstract=number===1 && split.find(b=>/^(?:abstract\b|摘要)/iu.test(b.text));
  const title=number===1 && split.find(b=>b.bounds.y<viewport.height*.32 && b.style.size>bodySize*1.28 &&
    !/[.!?。！？]$/.test(b.text.trim()));
  const cover=title && !abstract && !split.some(b=>b!==title && !b.sourceOnly && !/^https?:/i.test(b.text) &&
    (b.text.length>90 || (b.text.length>40 && /[.!?。！？]$/.test(b.text))));
  for(const b of split){
    const s=b.text.trim(),box=b.bounds,lines=box.height/b.style.size;
    const caption=/^(?:(?:fig(?:ure)?\.?|scheme|图)\s*[\dIVX]+|\([a-z]\)\s)/iu.test(s);
    const tableCaption=/^(?:table|tab\.|表)\s*(?:\d+|[IVX]+)(?=\s*[:.：]|$)/iu.test(s);
    const marginal=box.y<viewport.height*.08||box.y>viewport.height*.91;
    const heading=lines<2.7 && s.length<110 && !/[。！？.!?]$/.test(s) &&
      (b.style.size>bodySize*1.12 || /^(?:\d+(?:\.\d+)*|[A-Z])\s+\p{Lu}|^(?:Abstract|Introduction|Conclusion|References|Acknowledg[e]?ments|摘要|引言|结论|参考文献)$/u.test(s));
    const shortTitle=/^(?:\p{Lu}[\p{L}-]*(?:\s+|\.$)){1,5}$/u.test(s);
    const label=lines<1.6 && s.length<60 && (!/[。！？.!?]$/.test(s)||shortTitle);
    const taggedHeading=b.indices.every(i=>headingRuns.has(i));
    const chapter=/^(?:第[一二三四五六七八九十百零〇千\d]+[章节篇]|chapter\s+[\dIVX]+\b|appendix\s+[A-Z]\b)/iu.test(s) && lines<2.7 && s.length<110 && !/[。！？.!?]$/.test(s);
    const inOutline=outline?.has(s.toLowerCase()) || outline?.has(s.replace(/^(?:\d+(?:\.\d+)*\.?|[A-Z])\s+/u,'').toLowerCase());
    b.sectionHeading=taggedHeading || (!b.sourceOnly && !cover && b!==title && !caption && !tableCaption &&
      ((inOutline||heading||chapter) && b.style.size>=bodySize*.96));
    b.sourceOnly=!!(b.sectionHeading||b.sourceOnly||cover||b===title||(abstract&&box.y<abstract.bounds.y)||
      heading||label||tableCaption||(caption&&s.length<=155)||/^(?:arxiv:|https?:|keywords\s*[:：]|关键词\s*[:：])/iu.test(s)||
      /^[\d\s().–—-]+$/.test(s)||/^(?:[∗*]\s*)?corresponding author\.?$/i.test(s)||
      (marginal&&s.length<115&&lines<2&&/conference|proceedings|copyright|©|preprint|journal|会议|版权/iu.test(s)));
  }
  return {blocks:split,tables};
}

async function readingPDFTableRules(page,viewport,lib) {
  const list=await page.getOperatorList(),ops=lib.OPS,stack=[],rules=[];
  let matrix=viewport.transform;
  for(let i=0;i<list.fnArray.length;i++){
    const op=list.fnArray[i],args=list.argsArray[i];
    if(op===ops.save)stack.push(matrix);
    else if(op===ops.restore)matrix=stack.pop()||viewport.transform;
    else if(op===ops.transform)matrix=lib.Util.transform(matrix,args);
    else if(op===ops.constructPath){
      const box=args[2];
      if(!box||box.length!==4)continue;
      const [x0,y0,x1,y1]=box,[a,b,c,d,e,f]=matrix;
      const dx=Math.abs(a*(x1-x0))+Math.abs(c*(y1-y0));
      const dy=Math.abs(b*(x1-x0))+Math.abs(d*(y1-y0));
      if(dx<viewport.width*.12||dy>2)continue;
      const midX=a*(x1+x0)/2+c*(y1+y0)/2+e;
      rules.push({x:midX-dx/2,right:midX+dx/2,y:b*(x1+x0)/2+d*(y1+y0)/2+f});
    }
  }
  return rules.sort((a,b)=>a.y-b.y);
}
