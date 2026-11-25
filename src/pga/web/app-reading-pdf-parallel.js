// Only pages near the viewport need canvases. The other pages need text only.
function readingPDFParallelLayout(r) {
  readingPDFContinuousDispose(r);
  r.pdfFlowObserver?.disconnect();
  r.pdfParagraphs=r.translationOn && r.pdfViewSelect.value==='sections';
  r.pdfOnPage=r.translationOn && r.pdfViewSelect.value==='onpage';
  const parallel=r.translationOn && r.pdfViewSelect.value==='pages';
  r.pdfOriginalMode=true;
  r.inline=!parallel;
  r.grid.classList.toggle('reading-pdf-onpage',r.pdfOnPage);
  r.grid.classList.toggle('reading-pdf-parallel',parallel);
  r.grid.classList.toggle('reading-inline',!parallel);
  r.pdfFlowVersion++;
  r.pdfFlow=null;r.blocks=[];r.pdfTextQueue=Promise.resolve();
  r.pdfTextPages=new Map();
  for(let n=1;n<=r.pdf.numPages;n++)r.pdfTextPages.set(n,{ready:false});
  r.pdfBackground=null;
  r.pdfSectionIndex=null;
  r.pdfSectionOutline=null;
  if(r.pdfParagraphs){
    r.pdfSectionOutline=r.pdf.getOutline().then(outline=>{
      const titles=new Set();
      function collect(entries){
        for(const entry of entries||[]){
          titles.add(entry.title.trim().replace(/\s+/g,' ').toLowerCase());
          collect(entry.items);
        }
      }
      collect(outline);
      return titles;
    }).catch(()=>null);
    readingPDFNextText(r);
  }
  r.root.classList.toggle('translation-enabled', r.translationOn);
  r.translateButton.setAttribute('aria-expanded', String(r.translationOn));
  r.original.setAttribute('aria-label', 'PDF 原文');
  r.tools.querySelector('.reading-format').textContent=r.pdfOnPage?'点击原文段落查看译文':parallel?'PDF · 原页与译页':r.pdfParagraphs?'PDF · 分组对照':'PDF · 原页';
  if (!r.pdfProgress) {
    r.pdfProgress=readerElement('span','reading-pdf-progress');
    r.pdfProgress.setAttribute('role','status');
    r.pdfRetry=readerButton('重试失败部分',()=>{
      if(r.pdfParagraphs && [...r.pdfTextPages.values()].some(p=>p.error))readingPDFResetSections(r);
      for(const [number,item] of r.pdfTextPages) {
        if(!item.error)continue;
        item.error='';
        const view=r.pdfCanvases?.get(number);
        if(view?.ready){view.ready=false;readingPDFCanvas(r,number);}
      }
      readingRetry(r);
    });
    r.translateButton.after(r.pdfProgress,r.pdfRetry);
  }
  r.pdfViewSelect.hidden=!r.translationOn;
  r.pdfProgress.hidden=!r.translationOn;
  r.pdfRetry.hidden=true;
  readingProgress(r);
}
async function readingPDFParallelToggle(r) {
  r.translationOn=!r.translationOn;
  readingRememberPDFView(S.uid,r.info.key,r.translationOn);
  window.top.readingPendingPDFTranslations?.delete(r.info.key);
  return readingPDFChangeView(r);
}
async function readingPDFChangeView(r) {
  const page=r.page||1, wasOriginal=r.pdfOriginalMode;
  r.generation++;r.translateController?.abort();r.translateController=null;
  for (const b of r.blocks) delete b.output.dataset.pending;
  readingPDFParallelLayout(r);
  await readingPDFPage(r,page,wasOriginal && r.pdfOriginalMode);
  readingTranslate(r);
}
function readingPDFSyncScroll(r,source,target,force=false) {
  // A delayed scroll event from our previous mirror can arrive after the user
  // has already scrolled the other pane. Only forward an actual new position.
  const mirrors=r.pdfMirrors ||= new WeakMap();
  const {scrollTop,scrollLeft:left}=source, previous=mirrors.get(source);
  mirrors.delete(source);
  if(!force && previous && Math.abs(previous.top-scrollTop)<1 && Math.abs(previous.left-left)<1)return;
  r.pdfScrollSource=source;
  const top=readingPDFMappedTop(r,source,target);
  if(Math.abs(target.scrollTop-top)<1 && Math.abs(target.scrollLeft-left)<1)return;
  target.scrollTo(left,top);
  mirrors.set(target,{top:target.scrollTop,left:target.scrollLeft});
}
// Prose translations can span more screenfuls than the original page.
function readingPDFMappedTop(r,source,target) {
  const pages=r.pdfCanvases;
  if(!pages?.size)return source.scrollTop;
  const fromOriginal=source===r.original;
  const sourceKey=fromOriginal?'el':'translated', targetKey=fromOriginal?'translated':'el';
  const top=source.scrollTop, sourceEnd=source.scrollHeight-source.clientHeight;
  const targetEnd=target.scrollHeight-target.clientHeight;
  if(top<=0 || sourceEnd<=0)return 0;
  if(top>=sourceEnd-1)return targetEnd;
  let lo=1,hi=pages.size;
  while(lo<hi){
    const mid=Math.ceil((lo+hi)/2);
    if(pages.get(mid)[sourceKey].offsetTop<=top)lo=mid;
    else hi=mid-1;
  }
  const here=pages.get(lo),next=pages.get(lo+1);
  const start=here[sourceKey].offsetTop, dest=here[targetKey].offsetTop;
  const end=Math.min(next?.[sourceKey].offsetTop??sourceEnd,sourceEnd);
  const destEnd=Math.min(next?.[targetKey].offsetTop??targetEnd,targetEnd);
  return dest+(top-start)*(destEnd-dest)/Math.max(1,end-start);
}
function readingPDFMatch(r,target) {
  if(!r.translationOn||!r.pdfOriginalMode)return;
  const id=target?.closest('[data-reading-block]')?.dataset.readingBlock;
  for(const node of r.grid.querySelectorAll('.pdf-corresponding'))node.classList.remove('pdf-corresponding');
  if(!/^p\d+$/.test(id))return;
  for(const node of r.grid.querySelectorAll('[data-reading-block="'+id+'"]'))node.classList.add('pdf-corresponding');
}
function readingPDFNextText(r) {
  if (r.pdfBackground) return;
  const next=[...r.pdfTextPages].find(([,item])=>!item.ready&&!item.error);
  if (!next) return;
  const job=readingPDFTextLoad(r,next[0]);
  r.pdfBackground=job;
  job.finally(()=>{
    if(r.pdfBackground!==job)return;
    r.pdfBackground=null;
    if(!r.dead && r.translationOn){
      if(r.pdfParagraphs)readingPDFNextText(r);
      readingTranslate(r);
    }
  });
}
function readingPDFProgress(r) {
  const pages=[...r.pdfTextPages.values()];
  const completed=pages.filter(p=>p.ready && p.blocks?.every(b=>b.done)).length;
  const unreadable=pages.filter(p=>p.error).length;
  const failed=r.blocks.filter(b=>b.failed).length;
  const empty=pages.filter(p=>p.ready&&!p.blocks?.length).length;
  const language=r.target==='en'?'英文':'中文';
  const progress=`${language}译文 · ${completed}/${pages.length} 页`;
  const notes=[failed && `${failed} 段翻译失败`,unreadable && `${unreadable} 页读取失败`,empty && `${empty} 页无文字层，保留原页`].filter(Boolean);
  r.pdfProgress.textContent=[progress,...notes].join(' · ');
  r.pdfProgress.title=r.pdfProgress.textContent;
  r.pdfRetry.hidden=!(failed||unreadable);
}
function readingPDFResetLanguage(r) {
  r.generation++;r.translateController?.abort();r.translateController=null;
  for(const b of r.blocks){
    if(b.sourceOnly)continue;
    b.done=false;b.failed=false;b.retry?.remove();b.retry=null;b.error='';
    b.output.textContent=(b.sourceNode||r.pdfOnPage||r.pdfParagraphs)?'':b.text;b.output.lang=r.target;delete b.output.dataset.pending;
  }
  for(const item of r.pdfCanvases?.values()||[])if(item.copy||item.prose||r.pdfParagraphs)readingPDFPaintCopy(r,item.number);
  readingProgress(r);readingTranslate(r);
}
// Compare the original glyph with the same background without text. The
// highest-contrast pixel approximates the ink even on coloured paper.
function readingPDFInk(original, clean, rect, density) {
  const x=Math.max(0,Math.floor(rect.x*density)), y=Math.max(0,Math.floor(rect.y*density));
  const w=Math.min(128,original.width-x,Math.ceil(rect.w*density)), h=Math.min(80,original.height-y,Math.ceil(rect.h*density));
  if(w<1||h<1)return '';
  const src=original.getContext('2d').getImageData(x,y,w,h).data;
  const bg=clean.getContext('2d').getImageData(x,y,w,h).data;
  let best=0,ink='';
  for(let i=0;i<src.length;i+=4){
    const diff=Math.abs(src[i]-bg[i])+Math.abs(src[i+1]-bg[i+1])+Math.abs(src[i+2]-bg[i+2]);
    if(diff>best){best=diff;ink='rgb('+src[i]+' '+src[i+1]+' '+src[i+2]+')';}
  }
  return ink;
}
// A prose page can grow with its translation. Keep the facsimile for pages
// containing artwork, side-by-side columns, or positioned labels.
function readingPDFProsePage(blocks, viewport) {
  const body=blocks.filter(b=>b.bounds.height>b.style.size*3);
  if(!body.length)return false;
  const column=body[0].bounds.x;
  let bottom=-Infinity;
  return blocks.every(b=>{
    const box=b.bounds, em=b.style.size;
    const aligned=Math.abs(box.x-column)<em*2;
    const centered=Math.abs(box.x+box.width/2-viewport.width/2)<em;
    const linear=box.y>=bottom-em*.4;
    bottom=box.y+box.height;
    return linear && (aligned || centered);
  }) && body.every(b=>b.bounds.width>viewport.width*.48);
}
function readingPDFProseLayout(r,item,blocks,viewport) {
  const article=readerElement('div','reading-pdf-prose');
  const bodySize=blocks.find(b=>b.bounds.height>b.style.size*3).style.size;
  for(const b of blocks){
    const row=b.row;
    row.removeAttribute('style');row.classList.remove('pdf-shaped');
    if(b.output.firstElementChild)b.output.textContent=b.output.textContent;
    b.retry?.removeAttribute('style');
    const narrow=b.bounds.width<viewport.width*.48;
    const centered=narrow && Math.abs(b.bounds.x+b.bounds.width/2-viewport.width/2)<b.style.size;
    row.classList.toggle('pdf-prose-centered',centered);
    row.style.fontSize=(b.style.size*item.scale)+'px';
    if(b.style.size>bodySize*1.12)row.style.fontWeight='650';
    article.append(row);
  }
  item.prose=article;item.translated.replaceChildren(article);
  const pageHeight=viewport.height*item.scale;
  function matchHeight(){
    const height=Math.max(pageHeight,article.offsetHeight)+'px';
    if(item.translated.style.height===height)return;
    item.translated.style.height=height;
    const source=r.pdfScrollSource===r.rows?r.rows:r.original;
    readingPDFSyncScroll(r,source,source===r.rows?r.original:r.rows,true);
  }
  matchHeight();
  item.proseResize=new ResizeObserver(matchHeight);item.proseResize.observe(article);
}
async function readingPDFPrepareCopy(r,item,page,viewport,original,density,content) {
  const blocks=r.pdfTextPages.get(item.number)?.blocks||[];
  const unit=page.getViewport({scale:1});
  if(content && !r.pdfTextPages.get(item.number)?.tables?.length && !blocks.every(b=>b.sourceOnly) && readingPDFProsePage(blocks,unit)){
    const list=await page.getOperatorList();
    if(r.dead||item.version!==r.pdfCanvasVersion)return;
    const textOps=r.pdfTextOnlyOps ||= new Set([
      'dependency','save','restore','transform','beginText','endText','setFont',
      'setCharSpacing','setWordSpacing','setHScale','setLeading','setTextRise',
      'moveText','setLeadingMoveText','setTextMatrix','nextLine','showText',
      'showSpacedText','nextLineShowText','nextLineSetSpacingShowText',
      'setFillRGBColor','setStrokeRGBColor','setFillGray','setStrokeGray',
      'beginMarkedContent','beginMarkedContentProps','endMarkedContent',
    ].map(name=>r.pdfLib.OPS[name]));
    const horizontal=!unit.rotation && content.items.every(run=>
      !run.str?.trim() || (run.transform[0]>0 && Math.abs(run.transform[1])<.001));
    if(horizontal && list.fnArray.every(op=>textOps.has(op))){
      readingPDFProseLayout(r,item,blocks,unit);
      readingPDFPaintCopy(r,item.number);
      return;
    }
  }
  const copy=readerElement('canvas');
  copy.width=original.width;copy.height=original.height;copy.style.cssText=original.style.cssText;
  copy.setAttribute('aria-label',`PDF 译文第 ${item.number} 页`);
  copy.getContext('2d').drawImage(original,0,0);
  item.translated.replaceChildren(copy);
  if(!blocks.length||!content){
    const note=readerElement('span','reading-pdf-page-note',r.pdfTextPages.get(item.number)?.error?'本页文字读取失败':'本页无文字层，保留原页');
    item.translated.append(note);
    return;
  }
  if(blocks.every(b=>b.sourceOnly))return;
  const clean=readerElement('canvas');
  clean.width=original.width;clean.height=original.height;
  const ops=r.pdfLib.OPS;
  const glyphs=new Set([ops.showText,ops.showSpacedText,ops.nextLineShowText,ops.nextLineSetSpacingShowText]);
  // Repaint just the glyph areas from this graphics-only rendering. Coloured
  // backgrounds, figure artwork and table rules need no guessed white mask.
  const render=item.backRender=page.render({canvasContext:clean.getContext('2d'),viewport,
    transform:density===1?null:[density,0,0,density,0,0],
    operationsFilter:(index,list)=>!glyphs.has(list.fnArray[index])});
  await render.promise;
  if(r.dead||item.version!==r.pdfCanvasVersion)return;
  item.clean=clean;item.copy=copy;
  const pageRect=item.el.getBoundingClientRect();
  const textItems=content.items.filter(entry=>typeof entry.str==='string');
  item.geometry=new Map();
  for(const b of blocks){
    const rects=[];
    const spans=[];
    for(const index of b.indices){
      const span=item.layer.textDivs[index],source=textItems[index];
      if(!span||!source)continue;
      const measured=span.getBoundingClientRect();
      if(!measured.width||!measured.height)continue;
      const rect={x:measured.left-pageRect.left,y:measured.top-pageRect.top,w:measured.width,h:measured.height};
      const transform=r.pdfLib.Util.transform(viewport.transform,source.transform);
      // The browser's substitute font can have a different advance from
      // the embedded PDF font. Use PDF coordinates for horizontal runs.
      if(transform[0]>0 && Math.abs(transform[1])<.001 && source.width>0){
        rect.x=transform[4];rect.w=source.width*viewport.scale;
        const font=content.styles[source.fontName];
        if(font && Number.isFinite(font.ascent) && Number.isFinite(font.descent)){
          const height=Math.hypot(transform[2],transform[3]);
          rect.inkTop=transform[5]-height*font.ascent;
          rect.inkBottom=transform[5]-height*font.descent;
        }
      }
      rects.push(rect);spans.push(span);
    }
    if(!rects.length)continue;
    const left=Math.min(...rects.map(p=>p.x)),top=Math.min(...rects.map(p=>p.y));
    const right=Math.max(...rects.map(p=>p.x+p.w)),bottom=Math.max(...rects.map(p=>p.y+p.h));
    const first=item.layer.textDivs[b.style.sample]||spans[0];
    const font=page.commonObjs.has(b.style.font)?page.commonObjs.get(b.style.font):null;
    const inkRect=first.getBoundingClientRect();
    const box={x:left,y:top,width:right-left,height:bottom-top};
    const angle=Math.round(parseFloat(first.style.getPropertyValue('--rotate'))||0);
    if(Math.abs(angle)===90){
      box.x=angle>0?right:left;box.y=angle>0?top:bottom;
      box.width=bottom-top;box.height=right-left;
    }
    const centered=angle===0 && Math.abs((left+right)/2-pageRect.width/2)<b.style.size*item.scale*.45;
    const lines=rects.filter((rect,i)=>i===0 || Math.abs(rect.y-rects[i-1].y)>b.style.size*item.scale*.65);
    const leading=lines.length>1?(lines[lines.length-1].y-lines[0].y)/(lines.length-1)/(b.style.size*item.scale):1;
    const areas=angle===0?readingPDFTextAreas(rects,box,b.style.size*item.scale):[];
    const fontName=font?.name||'';
    const serif=font?.isSerifFont||/Times|NimbusRom|CMR\d|CMBX\d/i.test(fontName);
    item.geometry.set(b.id,{rects,box,areas,angle,centered,leading:Math.max(1,Math.min(1.6,leading)),
      color:readingPDFInk(original,clean,{x:inkRect.left-pageRect.left,y:inkRect.top-pageRect.top,w:inkRect.width,h:inkRect.height},density),family:serif?'"Songti SC","Noto Serif CJK SC",serif':font?.fallbackName||first.style.fontFamily||'serif',
      bold:font?.bold||font?.black||/Bold|NimbusRom[^+]*-Medi|CMBX\d/i.test(fontName),italic:font?.italic||/Italic|Oblique/i.test(fontName)});
  }
  readingPDFPaintCopy(r,item.number);
}
// Turn the measured lines into rectangles that can hold translated text.
// A paragraph can be narrow beside a figure and full-width beneath it.
function readingPDFTextAreas(rects,box,em) {
  const lines=[];
  for(const rect of [...rects].sort((a,b)=>a.y-b.y||a.x-b.x)){
    const mid=rect.y+rect.h/2;
    let line=lines[lines.length-1];
    if(!line || mid-line.mid>em*.55){line={mid,runs:[]};lines.push(line);}
    line.runs.push(rect);
  }
  const areas=[];
  for(const line of lines){
    const runs=[];
    for(const rect of line.runs.sort((a,b)=>a.x-b.x)){
      const last=runs[runs.length-1];
      if(last && rect.x-last.right<=em*1.5){
        last.right=Math.max(last.right,rect.x+rect.w);
        last.top=Math.min(last.top,rect.y);last.bottom=Math.max(last.bottom,rect.y+rect.h);
      }else runs.push({left:rect.x,right:rect.x+rect.w,top:rect.y,bottom:rect.y+rect.h});
    }
    for(const run of runs){
      const prev=areas[areas.length-1];
      if(prev && run.top>=prev.bottom-em*.4 && run.top-prev.bottom<em &&
          Math.abs(run.left-prev.left)<em && Math.abs(run.right-prev.right)<em &&
          Math.min(prev.right,run.right)>Math.max(prev.left,run.left)){
        // Only use space shared by all the lines in this band.
        prev.left=Math.max(prev.left,run.left);prev.right=Math.min(prev.right,run.right);
        prev.bottom=Math.max(prev.bottom,run.bottom);
      }else areas.push(run);
    }
  }
  if(areas.length<2)return [];
  return areas.map(area=>({x:area.left-box.x,y:area.top-box.y,width:area.right-area.left,height:area.bottom-area.top}));
}

// Keep the translation and paragraph identity intact. Flow successive word
// ranges through the available areas; the final area can scroll for long text.
const readingPDFWords=typeof Intl.Segmenter==='function'?new Intl.Segmenter(undefined,{granularity:'word'}):null;
function readingPDFFlowText(block,geom,text) {
  if(geom.flowText===text && block.output.firstElementChild){
    block.row.style.fontSize=geom.flowSize;
    return;
  }
  const output=block.output;
  const pieces=geom.areas.map(area=>{
    const piece=readerElement('span','reading-pdf-piece');
    readingBox(piece,area,1);return piece;
  });
  output.replaceChildren(...pieces);
  const ends=[0];
  // Keep trailing punctuation with the preceding word when moving to a new band.
  const canStart=value=>!(/^[\s.,!?;:%，。！？、；：）】》」』…]/u.test(value));
  if(readingPDFWords){
    for(const word of readingPDFWords.segment(text))if(word.index && canStart(word.segment))ends.push(word.index);
  }else{
    for(const token of text.matchAll(/[A-Za-z0-9]+|\s+|./gsu))if(token.index && canStart(token[0]))ends.push(token.index);
  }
  ends.push(text.length);
  const fits=piece=>piece.scrollHeight<=piece.clientHeight+1 && piece.scrollWidth<=piece.clientWidth+1;
  function distribute(size){
    block.row.style.fontSize=size+'px';
    let start=0;
    for(let n=0;n<pieces.length;n++){
      const piece=pieces[n];
      piece.textContent=text.slice(ends[start]);
      if(n===pieces.length-1)return fits(piece);
      if(fits(piece)){start=ends.length-1;continue;}
      let lo=start,hi=ends.length-1;
      while(hi-lo>1){
        const mid=Math.floor((hi+lo)/2);
        piece.textContent=text.slice(ends[start],ends[mid]);
        if(fits(piece))lo=mid;else hi=mid;
      }
      piece.textContent=text.slice(ends[start],ends[lo]);start=lo;
    }
  }
  const size=block.fontSize;
  for(const factor of [1,.9,.8,.72])if(distribute(size*factor))break;
  geom.flowText=text;geom.flowSize=block.row.style.fontSize;
}
function readingPDFPaintCopy(r,number) {
  const item=r.pdfCanvases?.get(number);
  if(!item||!r.translationOn)return;
  if(r.pdfParagraphs){
    for(const b of r.pdfTextPages.get(number)?.blocks||[])b.row.hidden=b.done && b.output.textContent.trim()===b.text.trim();
    return;
  }
  if(item.prose){
    for(const b of r.pdfTextPages.get(number).blocks){
      b.row.classList.toggle('pdf-replaced',b.done && b.output.textContent!==b.text);
      b.row.title=b.failed?b.error:'';
    }
    return;
  }
  if(!item.copy||!item.clean)return;
  const surface=item.translated,canvas=item.copy,ctx=canvas.getContext('2d');
  const original=item.el.querySelector('canvas');
  if(!original)return;
  ctx.drawImage(original,0,0);
  const factor=canvas.width/parseFloat(canvas.style.width);
  for(const b of r.pdfTextPages.get(number)?.blocks||[]){
    const geom=item.geometry.get(b.id);
    if(!geom)continue;
    const row=b.row,out=b.output,changed=b.done && out.textContent.trim()!==b.text.trim();
    row.classList.toggle('pdf-replaced',changed);
    row.classList.toggle('pdf-failed',!!b.failed);
    if(changed){
      for(const rect of geom.rects){
        const inkTop=Math.min(rect.y,rect.inkTop??rect.y);
        const inkBottom=Math.max(rect.y+rect.h,rect.inkBottom??(rect.y+rect.h));
        const x=Math.max(0,Math.floor(rect.x*factor)-1),y=Math.max(0,Math.floor(inkTop*factor)-1);
        const w=Math.min(canvas.width-x,Math.ceil(rect.w*factor)+3),h=Math.min(canvas.height-y,Math.ceil((inkBottom-inkTop)*factor)+3);
        if(w>0&&h>0)ctx.drawImage(item.clean,x,y,w,h,x,y,w,h);
      }
    }
    readingBox(row,geom.box,1);
    row.style.color=changed?geom.color:'';
    row.style.fontFamily=geom.family;
    row.style.textAlign=geom.centered && !geom.areas.length?'center':'start';
    row.style.lineHeight=geom.leading;
    row.style.transform=Math.abs(geom.angle)===90?'rotate('+geom.angle+'deg)':'';
    row.style.transformOrigin='top left';
    row.style.fontWeight=geom.bold?'700':'400';row.style.fontStyle=geom.italic?'italic':'normal';
    b.fontSize=b.style.size*item.scale;row.style.fontSize=b.fontSize+'px';
    row.title=b.failed?b.error:out.textContent;
    if(row.parentElement!==surface)surface.append(row);
    row.classList.toggle('pdf-shaped',!!geom.areas.length);
    if(geom.areas.length){
      readingPDFFlowText(b,geom,out.textContent);
      if(b.retry)readingBox(b.retry,geom.areas[0],1);
    }else{
      // A rerender at another scale may turn a shaped paragraph into one box.
      if(out.firstElementChild)out.textContent=out.textContent;
      b.retry?.removeAttribute('style');
      if(changed)readingFit(b);
    }
  }
}
