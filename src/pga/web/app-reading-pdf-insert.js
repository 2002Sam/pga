// The text layer has no paragraph tags. A larger baseline gap relative to the
// surrounding lines often marks a paragraph, even when both share the same left margin.
function readingPDFParagraphBlocks(blocks,items,viewport,lib) {
  const lines=[],breaks=new Set();
  let index=-1;
  for(const run of items){
    if(typeof run.str!=='string')continue;
    index++;
    if(!run.str.trim())continue;
    const t=lib.Util.transform(viewport.transform,run.transform);
    if(t[0]<=0||Math.abs(t[1])>.001)continue;
    const em=Math.hypot(t[2],t[3]),prev=lines.at(-1);
    if(!prev||Math.abs(t[5]-prev.y)>Math.max(prev.em,em)*.55){
      lines.push({index,y:t[5],em,text:run.str});
    }else if(em>prev.em){
      prev.y=t[5];prev.em=em;
    }
  }
  const spacing=[];
  for(let i=1;i<lines.length;i++){
    const ratio=(lines[i].y-lines[i-1].y)/lines[i].em;
    if(ratio>.7&&ratio<2)spacing.push(ratio);
  }
  spacing.sort((a,b)=>a-b);
  const leading=spacing[Math.floor(spacing.length/2)]||1.2;
  for(let i=1;i<lines.length;i++){
    const line=lines[i],prev=lines[i-1];
    if((line.y-prev.y)>Math.max(1.45,leading*1.3)*Math.max(line.em,prev.em) ||
       /^[•●▪]/u.test(line.text.trimStart()))breaks.add(line.index);
  }
  const ids=new Map(blocks.map(b=>[b.indices[0],b.id]));
  let next=blocks.length;
  const result=readingPDFBlocks(items,viewport,lib,breaks);
  for(const b of result)b.id=ids.get(b.indices[0])||'p'+next++;
  return result;
}

// Count mixed-language source text in English-word equivalents. Citations and
// line-wrapped words need not contribute extra stops while reading a paper.
function readingPDFReadLength(text) {
  const prose=text.replace(/\[[\d,\s–-]+\]/g,'').replace(/(\p{L})-\s+(?=\p{Ll})/gu,'$1');
  const han=/\p{Script=Han}/gu;
  const chars=prose.match(han)?.length||0;
  const words=prose.replace(han,' ').match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu)?.length||0;
  return words+chars*.6;
}
function readingPDFCanPause(before,after) {
  // Extraction also produces fragments at equations, column wraps and lists.
  // Let the group grow until the prose reaches a complete thought.
  return /[.!?。！？][”’"'）)\]]*$/.test(before.trimEnd()) &&
    !/^(?:[\p{Ll},，=+−]|min\b|max\b|where\b)/u.test(after.trimStart()) &&
    !/^(?:min|max)\s|^\p{L}\s*=/u.test(before);
}
function readingPDFGroupCut(blocks,total,final) {
  if(total<=220||(!final&&total<=300))return 0;
  let sum=0,cut=0,best=Infinity;
  for(let i=1;i<blocks.length;i++){
    const prev=blocks[i-1],next=blocks[i];
    sum+=prev.readLength;
    if(!prev.sectionSlot || !readingPDFCanPause(prev.text,next.text))continue;
    const tail=total-sum;
    if(tail<40 || (total<=300 && Math.min(sum,tail)<100))continue;
    const newTopic=/^(?:[A-Z][\p{L}–-]*\s+){1,6}[\p{L}–-]+\.\s+\p{Lu}/u.test(next.text);
    const sizePenalty=Math.max(0,120-sum)*3+Math.max(0,sum-300)*3;
    const tailPenalty=Math.max(0,100-tail);
    const score=Math.abs(sum-185)+sizePenalty+tailPenalty-(newTopic?85:0);
    if(score<best){cut=i;best=score;}
  }
  return cut;
}

// Reserve slots at safe paragraph endings. Only the selected group endings
// contain translations. The original rows retain their selection and retry IDs.
function readingPDFSectionParts(blocks) {
  const parts=[];
  let part;
  for(const b of blocks){
    if(!part||b.sectionHeading){
      part={heading:b.sectionHeading?b.text:'',blocks:[]};
      parts.push(part);
    }
    if(!b.sourceOnly)part.blocks.push(b);
  }
  for(const part of parts){
    for(let i=0;i<part.blocks.length;i++){
      const block=part.blocks[i],next=part.blocks[i+1];
      block.readLength=readingPDFReadLength(block.text);
      if(!next||readingPDFCanPause(block.text,next.text))block.sectionSlot=readerElement('section');
    }
  }
  return parts;
}
function readingPDFIndexSections(r) {
  const index=r.pdfSectionIndex ||= {page:1,title:'',blocks:[],length:0};
  function show(count){
    const group=index.blocks.splice(0,count),slot=group.at(-1).sectionSlot;
    slot.className='reading-pdf-insert';
    slot.setAttribute('aria-label',index.title ? index.title+' · 译文' : '本页译文');
    for(const block of group){slot.append(block.row);index.length-=block.readLength;}
  }
  function flush(final){
    let cut;
    while((cut=readingPDFGroupCut(index.blocks,index.length,final)))show(cut);
    if(final&&index.blocks.length){show(index.blocks.length);index.length=0;}
  }
  while(index.page<=r.pdf.numPages){
    const page=r.pdfTextPages.get(index.page);
    if(!page.ready&&!page.error)break;
    if(page.error){
      flush(true);index.title='';
    }else{
      for(const part of page.sectionParts){
        if(part.heading){flush(true);index.title=part.heading;}
        for(const block of part.blocks){index.blocks.push(block);index.length+=block.readLength;}
        flush(false);
      }
      // A document with no recognized heading still has a readable page unit.
      if(!index.title||index.page===r.pdf.numPages)flush(true);
    }
    index.page++;
  }
}
function readingPDFResetSections(r) {
  for(const page of r.pdfTextPages.values()){
    for(const b of page.blocks||[]){
      if(b.sectionSlot){b.sectionSlot.replaceChildren();b.sectionSlot.className='';}
    }
  }
  r.pdfSectionIndex=null;
}

// Work in backing pixels so every part of the original canvas is copied exactly once.
// Separate columns can grow independently. Keep raster illustrations in one piece.
function readingPDFInsertParagraphs(r,item,page,canvas,textLayer,viewport,content) {
  const blocks=r.pdfTextPages.get(item.number)?.blocks;
  if(!blocks?.some(b=>!b.sourceOnly))return;
  const width=canvas.width,height=canvas.height;
  const sx=viewport.width/width,sy=viewport.height/height;
  const origin=item.el.getBoundingClientRect();
  const runBoxes=new Map(),entries=[];
  const sources=content.items.filter(run=>typeof run.str==='string');
  for(const b of blocks){
    const runs=[];
    for(const i of b.indices){
      const span=item.layer.textDivs[i];
      if(!span)continue;
      const rect=span.getBoundingClientRect();
      if(!rect.width||!rect.height)continue;
      const run={span,left:(rect.left-origin.left)/sx,right:(rect.right-origin.left)/sx,
        top:(rect.top-origin.top)/sy,bottom:(rect.bottom-origin.top)/sy};
      const source=sources[i],matrix=r.pdfLib.Util.transform(viewport.transform,source.transform);
      // PDF.js may use a wider substitute font for the invisible selection layer.
      // Locate a column gutter using the advance of the embedded PDF font.
      if(matrix[0]>0 && Math.abs(matrix[1])<.001 && source.width>0){
        run.left=matrix[4]/sx;
        run.right=run.left+source.width*viewport.scale/sx;
      }
      runs.push(run);runBoxes.set(span,run);
    }
    // Track changes in line width so text beside a figure and the continuation
    // beneath it can move independently. Only the final band receives the translation.
    const lines=[];
    for(const run of runs){
      const mid=(run.top+run.bottom)/2,last=lines.at(-1);
      if(last && Math.abs(mid-last.mid)<(run.bottom-run.top)*.45){
        last.left=Math.min(last.left,run.left);last.right=Math.max(last.right,run.right);
        last.top=Math.min(last.top,run.top);last.bottom=Math.max(last.bottom,run.bottom);
      }else lines.push({...run,mid});
    }
    let band;
    for(const line of lines){
      if(band && Math.abs(line.left-band.left)<width*.045 && Math.abs(line.right-band.right)<width*.12){
        band.left=Math.min(band.left,line.left);band.right=Math.max(band.right,line.right);
        band.top=Math.min(band.top,line.top);band.bottom=Math.max(band.bottom,line.bottom);
      }else{
        band={left:line.left,right:line.right,top:line.top,bottom:line.bottom};entries.push(band);
      }
    }
    if(band&&b.sectionSlot){
      band.block=b;
      band.textLeft=Math.min(...runs.map(p=>p.left));
      band.textRight=Math.max(...runs.map(p=>p.right));
    }
  }
  if(!entries.length)return;
  for(const table of r.pdfTextPages.get(item.number).tables||[]){
    entries.push({figure:true,left:table.left*item.scale/sx,right:table.right*item.scale/sx,
      top:table.top*item.scale/sy,bottom:table.bottom*item.scale/sy});
  }
  const coords=page.imageCoordinates||[];
  for(let i=0;i<coords.length;i+=6){
    const [x,y,vx,vy,hx,hy]=coords.subarray(i,i+6);
    entries.push({figure:true,left:Math.min(x,vx,hx,vx+hx-x)*width,right:Math.max(x,vx,hx,vx+hx-x)*width,
      top:Math.min(y,vy,hy,vy+hy-y)*height,bottom:Math.max(y,vy,hy,vy+hy-y)*height});
  }
  const pixels=canvas.getContext('2d').getImageData(0,0,width,height).data;
  function clearLine(area,pos,vertical){
    const from=vertical?area.top:area.left,to=vertical?area.bottom:area.right;
    let i=4*(vertical?from*width+pos:pos*width+from);
    const stride=vertical?4*width:4;
    const red=pixels[i],green=pixels[i+1],blue=pixels[i+2];
    for(let n=from+1;n<to;n++){
      i+=stride;
      if(Math.abs(pixels[i]-red)>8||Math.abs(pixels[i+1]-green)>8||Math.abs(pixels[i+2]-blue)>8)return false;
    }
    return true;
  }

  function strip(parent,area){
    const w=area.right-area.left,h=area.bottom-area.top;
    if(w<=0||h<=0)return;
    const band=readerElement('div','reading-pdf-strip');
    const crop=readerElement('canvas');
    crop.width=w;crop.height=h;crop.style.width=w*sx+'px';crop.style.height=h*sy+'px';
    crop.getContext('2d').drawImage(canvas,area.left,area.top,w,h,0,0,w,h);
    band.append(crop);
    const layer=textLayer.cloneNode(false);
    layer.style.width=viewport.width+'px';layer.style.height=viewport.height+'px';
    layer.style.left=-area.left*sx+'px';layer.style.top=-area.top*sy+'px';
    for(const [span,run] of runBoxes){
      const x=(run.left+run.right)/2,y=(run.top+run.bottom)/2;
      if(x>=area.left&&x<area.right&&y>=area.top&&y<area.bottom){
        layer.append(span);runBoxes.delete(span);
      }
    }
    if(layer.childElementCount)band.append(layer);
    parent.append(band);
  }
  function translation(parent,area,e){
    const b=e.block;
    const available=(area.right-area.left)*sx;
    const left=Math.max(0,Math.min((e.textLeft-area.left)*sx,available*.83));
    const measure=Math.max((e.textRight-e.textLeft)*sx,Math.min(available*.75,260*item.scale));
    const slot=b.sectionSlot;
    slot.style.marginLeft=left+'px';
    slot.style.width=Math.max(1,Math.min(available-left,measure))+'px';
    slot.style.fontSize=Math.max(12,b.style.size*item.scale)+'px';
    parent.append(slot);
  }

  // Prefer gutters between whole paragraphs and figures. If a paragraph wraps
  // around a figure, its caption can still receive a translation at the next clear line.
  function layout(parent,area,objects){
    if(!objects.some(e=>e.block)){strip(parent,area);return;}
    for(const vertical of [true,false]){
      const start=vertical?'left':'top',end=vertical?'right':'bottom';
      // The last line can be much shorter than the paragraph it ends. The
      // translation needs the whole column, even if a footer fits beside that line.
      const min=e=>vertical&&e.block?e.textLeft:e[start];
      const max=e=>vertical&&e.block?e.textRight:e[end];
      const sorted=[...objects].sort((a,b)=>min(a)-min(b));
      let edge=-Infinity;
      const gaps=[];
      for(let i=0;i<sorted.length;i++){
        const next=min(sorted[i]);
        if(i && next-edge>(vertical?2*item.scale/sx:1)){
          gaps.push({i,low:Math.max(area[start]+1,Math.ceil(edge)),high:Math.min(area[end]-1,Math.floor(next))});
        }
        edge=Math.max(edge,max(sorted[i]));
      }
      gaps.sort((a,b)=>Math.abs(a.i-sorted.length/2)-Math.abs(b.i-sorted.length/2));
      for(const gap of gaps){
        let cut=vertical?Math.round((gap.low+gap.high)/2):gap.low;
        while(cut<=gap.high&&!clearLine(area,cut,vertical))cut++;
        if(cut>gap.high||cut<=area[start]||cut>=area[end])continue;
        let first=parent,second=parent;
        if(vertical){
          const columns=readerElement('div','reading-pdf-columns');
          columns.style.gridTemplateColumns=(cut-area.left)*sx+'px minmax(0,1fr)';
          first=readerElement('div');second=readerElement('div');
          columns.append(first,second);parent.append(columns);
        }
        layout(first,{...area,[end]:cut},sorted.slice(0,gap.i));
        layout(second,{...area,[start]:cut},sorted.slice(gap.i));
        return;
      }
    }
    let top=area.top;
    const figures=objects.filter(e=>e.figure);
    for(const e of objects.filter(e=>e.block).sort((a,b)=>a.bottom-b.bottom||a.left-b.left)){
      let cut=Math.max(top,Math.min(area.bottom,Math.ceil(e.bottom)));
      while(cut<area.bottom){
        const figure=figures.find(f=>f.top<cut&&f.bottom>cut);
        if(figure){cut=Math.min(area.bottom,Math.ceil(figure.bottom));continue;}
        if(clearLine(area,cut,false))break;
        cut++;
      }
      strip(parent,{...area,top,bottom:cut});
      translation(parent,area,e);
      top=cut;
    }
    strip(parent,{...area,top});
  }
  const paper=readerElement('div','reading-pdf-interleaved');
  layout(paper,{left:0,right:width,top:0,bottom:height},entries);
  item.el.replaceChildren(paper);
  item.el.style.height='auto';
}
