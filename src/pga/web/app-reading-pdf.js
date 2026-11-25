/* PDF.js renders the original page; its separate text layer supplies selection/evidence. */
const READING_PDF_BASE = '/ui/vendor/pdfjs/6.5.438/';
let READING_PDF_LIBRARY;
async function readingPDF(r, url) {
  const lib = await (READING_PDF_LIBRARY ||= import(READING_PDF_BASE + 'legacy/build/pdf.mjs').catch(err => { READING_PDF_LIBRARY=null; throw err; }));
  if (r.dead) return;
  lib.GlobalWorkerOptions.workerSrc = READING_PDF_BASE + 'legacy/build/pdf.worker.mjs';
  readingPDFContinuousDispose(r);readingSlidesDispose(r);
  r.slides=r.content?.kind==='slides'||/\.(pptx?|odp)(?:$|[?#])/i.test(r.info.source||'');
  r.pdfFlowVersion=(r.pdfFlowVersion||0)+1;r.pdfFlowObserver?.disconnect();
  r.pdfRender?.cancel(); r.pdfText?.cancel(); await r.pdfTask?.destroy();
  if (r.dead) return;
  window.top.readingNativeRemove?.(r.nativeId); r.native=false;r.inline=true;r.grid.classList.add('reading-inline');r.sync.hidden=true;
  r.pdfFlowObserver?.disconnect();r.pdfOriginalMode=!r.slides;r.pdfPage=null;r.pdfPixels=null;r.layout=null;
  r.pdfLib=lib; r.original.replaceChildren(); r.original.classList.add('reading-pdf');
  const task=r.pdfTask=lib.getDocument({url,cMapUrl:READING_PDF_BASE+'cmaps/',cMapPacked:true,
    standardFontDataUrl:READING_PDF_BASE+'standard_fonts/',wasmUrl:READING_PDF_BASE+'wasm/',isEvalSupported:false,fontExtraProperties:!r.slides});
  task.onPassword=()=>{r.status.textContent='此 PDF 需要密码，请使用「打开原件」';task.destroy();};
  r.pdf=await task.promise;
  r.chatButton.hidden=false;
  if (r.dead) return;
  readingPDFChrome(r,!r.slides);
  r.pdfTools?.remove();
  const bar=r.pdfTools=readerElement('div','reading-pdf-tools');
  r.prev=readerButton('‹',()=>readingPDFPage(r,r.page-1)); r.prev.title='上一页'; r.prev.setAttribute('aria-label','上一页');
  r.next=readerButton('›',()=>readingPDFPage(r,r.page+1)); r.next.title='下一页'; r.next.setAttribute('aria-label','下一页');
  r.pageInput=readerElement('input'); r.pageInput.type='number'; r.pageInput.min='1'; r.pageInput.max=String(r.pdf.numPages); r.pageInput.setAttribute('aria-label','PDF 页码');
  r.pageInput.onchange=()=>readingPDFPage(r,Number(r.pageInput.value));
  r.pageInput.onkeydown=e=>{if(e.key==='Enter'){e.stopPropagation();readingPDFPage(r,Number(r.pageInput.value));}};
  const zoom=readerElement('select'); zoom.setAttribute('aria-label','PDF 缩放');
  for(const [value,label] of [['1','适合宽度'],['1.5','150%'],['2','200%']]) {const option=readerElement('option','',label);option.value=value;zoom.append(option);}
  if(![1,1.5,2].includes(r.zoom||1)){const option=readerElement('option','',`自定义 ${Math.round(r.zoom*100)}%`);option.value=String(r.zoom);zoom.append(option);}
  r.pdfZoom=zoom;zoom.value=String(r.zoom||1);zoom.onchange=()=>readingZoomSet(r,Number(zoom.value));
  bar.append(r.prev,r.pageInput,readerElement('span','',`/ ${r.pdf.numPages}`),r.next,zoom); r.translationBar.append(bar);
  if (r.slides) {r.pdfParagraphs=false;r.pdfOnPage=false;readingPDFCreateFlow(r);}
  else {
    const view=r.pdfViewSelect=readerElement('select');
    view.setAttribute('aria-label','翻译视图');
    for(const [value,label] of [['sections','分组对照'],['pages','原版对照'],['onpage','原页点段翻译']]){
      const option=readerElement('option','',label);option.value=value;view.append(option);
    }
    const modeKey=readingPDFViewKey(S.uid,r.info.key)+':layout-v2';
    try{
      let saved=localStorage.getItem(modeKey);
      if(saved==='paragraphs')saved='sections';
      if([...view.options].some(option=>option.value===saved))view.value=saved;
    }catch{}
    view.onchange=()=>{
      try{localStorage.setItem(modeKey,view.value);}catch{}
      if(r.translationOn)readingPDFChangeView(r);
    };
    bar.append(view);
    r.translationOn=!!window.top.readingPendingPDFTranslations?.delete(r.info.key);
    try { r.translationOn ||= localStorage.getItem(readingPDFViewKey(S.uid,r.info.key))==='1'; } catch {}
    r.webFrame=false;
    if(!localStorage.getItem('pga_reading_target')) {
      r.target='zh-CN';r.tools.querySelector('[aria-label="翻译语言"]').value=r.target;
    }
    readingPDFParallelLayout(r);
  }
  r.original.onscroll=()=>{
    if(r.dead)return;
    if(!r.pdfOriginalMode){readingPDFTrack(r);readingPDFVisible(r);readingTranslate(r);return;}
    if (r.translationOn && !r.inline) readingPDFSyncScroll(r,r.original,r.rows);
    readingPDFContinuousTrack(r);
  };
  r.resize?.disconnect(); let width=r.original.clientWidth;
  r.resize=new ResizeObserver(()=>{const next=r.original.clientWidth;if(next>0 && next!==width){width=next;clearTimeout(r.resizeTimer);r.resizeTimer=setTimeout(()=>{if(!r.dead)readingPDFPage(r,r.page,true);},180);}});
  r.resize.observe(r.original);
  await readingPDFPage(r,Math.min(r.pdf.numPages,r.state.page||1),true);
  if(!r.slides && window.top.readingPendingPDFTranslations?.delete(r.info.key))readingActivatePDFTranslation(r.info.key);
}
function readingPDFContinuousDispose(r){
  readingPDFCloseNote(r);
  r.pdfCanvasVersion=(r.pdfCanvasVersion||0)+1;r.pdfCanvasObserver?.disconnect();
  for(const item of r.pdfCanvases?.values()||[]){item.render?.cancel();item.layer?.cancel();item.proseResize?.disconnect();item.backRender?.cancel();item.translated?.replaceChildren();}
  if(r.pdfParagraphs){
    for(const page of r.pdfTextPages?.values()||[])for(const b of page.blocks||[])b.sectionSlot?.remove();
  }
  r.pdfCanvases=null;
}
function readingPDFCenterAnchor(r) {
  const pane=r.original, middle=pane.scrollTop+pane.clientHeight/2;
  let lo=1,hi=r.pdfCanvases.size;
  while(lo<hi){
    const mid=Math.ceil((lo+hi)/2);
    if(r.pdfCanvases.get(mid).el.offsetTop<=middle)lo=mid;
    else hi=mid-1;
  }
  const el=r.pdfCanvases.get(lo).el;
  return {number:lo,ratio:(middle-el.offsetTop)/Math.max(1,el.offsetHeight)};
}
async function readingPDFPage(r,number,restore=false,centerWindow=false){
  if(r.dead||!r.pdf||!Number.isInteger(number)||number<1||number>r.pdf.numPages)return;
  const zoom=r.zoom||1, frame=window.frameElement;
  const windowZoom=r.pdfOriginalMode ? Math.max(1,zoom) : 1;
  const extra=frame ? (window.top.stPDFReaderZoom?.(frame,windowZoom,centerWindow && r.pdfOriginalMode) ?? 0) : 0;
  if(!r.pdfOriginalMode)return readingPDFTextPage(r,number,restore);
  const pane=r.original, width=pane.clientWidth;
  // The extra window width reveals more paper at the requested magnification.
  const paperWidth=Math.max(1,width-extra/(r.translationOn&&!r.inline?2:1))*zoom;
  const signature=[width,paperWidth,zoom,!!r.translationOn].join(':');
  // The ResizeObserver can arrive after the split view already resized itself.
  // A redundant restore would overwrite a scroll performed in the meantime.
  if(restore && r.page===number && r.pdfCanvases && r.pdfCanvasSize===signature)return readingPDFCanvas(r,number);
  const ratio=restore?r.state.ratio||0:0;
  const rebuild=!r.pdfCanvases||r.pdfCanvasSize!==signature;
  const anchor=rebuild && restore && r.pdfCanvases ? readingPDFCenterAnchor(r) : null;
  if(rebuild){
    readingPDFContinuousDispose(r);r.pdfCanvasSize=signature;
    const version=r.pdfCanvasVersion,first=await r.pdf.getPage(number);
    if(r.dead||version!==r.pdfCanvasVersion)return;
    const unit=first.getViewport({scale:1}),scale=paperWidth/unit.width;
    r.pdfPaperWidth=paperWidth;
    r.pdfCanvases=new Map();r.original.replaceChildren();r.rows.replaceChildren();r.layout=null;r.pdfPixels=null;
    for(let n=1;n<=r.pdf.numPages;n++){
      const el=readerElement('div','reading-pdf-page');el.dataset.pdfPage=n;el.setAttribute('aria-label',`PDF 第 ${n} 页`);
      el.style.width=unit.width*scale+'px';el.style.height=unit.height*scale+'px';el.style.marginBottom='16px';
      r.original.append(el);
      const item={el,number:n,version};
      if (r.translationOn && !r.inline) {
        const translated=item.translated=readerElement('div','reading-pdf-page');
        translated.dataset.translatedPage=n;translated.setAttribute('aria-label',`译文第 ${n} 页`);
        translated.style.cssText=el.style.cssText;r.rows.append(translated);
      }
      r.pdfCanvases.set(n,item);
    }
    r.pdfCanvasObserver=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting)readingPDFCanvas(r,Number(entry.target.dataset.pdfPage));},{root:r.original,rootMargin:'500px'});
    for(const item of r.pdfCanvases.values())r.pdfCanvasObserver.observe(item.el);
  }
  const item=r.pdfCanvases.get(number);if(!item)return;
  r.page=number;r.state.page=number;
  const anchored=anchor && r.pdfCanvases.get(anchor.number);
  pane.scrollTop=anchored ? anchored.el.offsetTop+anchor.ratio*anchored.el.offsetHeight-pane.clientHeight/2 : item.el.offsetTop+ratio*item.el.clientHeight;
  if(rebuild)pane.scrollLeft=(pane.scrollWidth-pane.clientWidth)/2;
  if(r.translationOn && !r.inline)readingPDFSyncScroll(r,r.original,r.rows,true);
  await readingPDFCanvas(r,number);readingPDFContinuousTrack(r);
}
async function readingPDFCanvas(r,number){
  const item=r.pdfCanvases?.get(number);if(!item||item.ready)return;if(item.pending)return item.pending;
  const valid=()=>!r.dead&&item.version===r.pdfCanvasVersion;
  item.pending=(async()=>{
    try{
      const page=await r.pdf.getPage(number);if(!valid())return;
      const unit=page.getViewport({scale:1}),scale=r.pdfPaperWidth/unit.width,viewport=page.getViewport({scale});
      item.scale=scale;
      for(const surface of [item.el,item.translated].filter(Boolean)){
        surface.style.width=viewport.width+'px';surface.style.height=viewport.height+'px';
      }
      item.el.style.setProperty('--total-scale-factor',scale);item.el.style.setProperty('--scale-factor',scale);
      const density=Math.min(devicePixelRatio||1,2,Math.sqrt(8_000_000/(viewport.width*viewport.height)));
      const canvas=readerElement('canvas');canvas.width=Math.ceil(viewport.width*density);canvas.height=Math.ceil(viewport.height*density);
      canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';canvas.setAttribute('aria-label',`PDF 原件第 ${number} 页`);
      const text=readerElement('div','textLayer');item.el.replaceChildren(canvas,text);
      item.render=page.render({canvasContext:canvas.getContext('2d'),viewport,recordImages:r.pdfParagraphs,transform:density===1?null:[density,0,0,density,0,0]});
      await item.render.promise;if(!valid())return;
      let content;
      try {
        content=await page.getTextContent({includeMarkedContent:!r.slides});if(!valid())return;
        item.layer=new r.pdfLib.TextLayer({textContentSource:content,container:text,viewport});
        await item.layer.render();if(!valid())return;
        await readingPDFTextLoad(r,number,{page,content});if(!valid())return;
        for(const block of r.pdfTextPages.get(number)?.blocks||[]){
          for(const index of block.indices){
            const span=item.layer.textDivs[index];
            if(span)span.dataset.readingBlock=block.id;
          }
          if(r.pdfOnPage&&!block.sourceOnly){
            const first=item.layer.textDivs[block.indices[0]];
            if(first){first.tabIndex=0;first.setAttribute('role','button');first.title='查看本段译文';}
          }
        }
        if(r.pdfOnPage){
          text.onclick=e=>{
            if(!r.annotationMode && !window.getSelection()?.toString())readingPDFOpenNote(r,item,e.target);
          };
          text.onkeydown=e=>{
            if(e.key==='Enter'||e.key===' '){e.preventDefault();readingPDFOpenNote(r,item,e.target);}
          };
        }
      }catch(err){
        if(!valid())return;
        r.pdfTextPages.get(number).error=err.message||'文字层读取失败';
        content=null;
      }
      if(r.pdfParagraphs && content){
        readingPDFInsertParagraphs(r,item,page,canvas,text,viewport,content);
        readingPDFPaintCopy(r,number);
      }
      if (item.translated) {
        try {await readingPDFPrepareCopy(r,item,page,viewport,canvas,density,content);}
        catch(err){
          if(!valid()||err.name==='RenderingCancelledException')return;
          const retry=readerButton('译页加载失败，点击重试',()=>{item.ready=false;readingPDFCanvas(r,number);});
          retry.className='reading-pdf-page-note';retry.title=err.message;item.translated.append(retry);
        }
        if (!valid()) return;
      }
      item.ready=true;readingAnnotationApply(r);readingPDFContinuousTrack(r);
    }catch(err){if(valid()&&err.name!=='RenderingCancelledException'){item.el.replaceChildren(readerButton('本页加载失败，点击重试',()=>readingPDFCanvas(r,number)));}}
    finally{item.pending=null;}
  })();return item.pending;
}
function readingPDFCloseNote(r){
  r.pdfNote?.remove();
  r.pdfNote=null;
}
function readingPDFOpenNote(r,item,span){
  const block=r.pdfTextPages.get(item.number)?.blocks?.find(b=>b.id===span.dataset.readingBlock);
  if(!block||block.sourceOnly)return;
  readingPDFCloseNote(r);
  const note=r.pdfNote=readerElement('aside','reading-pdf-note');
  note.dataset.readingBlock=block.id;
  note.setAttribute('aria-label','本段译文');
  const close=()=>{
    readingPDFCloseNote(r);
    item.layer.textDivs[block.indices[0]]?.focus({preventScroll:true});
  };
  const button=readerButton('×',close);
  button.setAttribute('aria-label','收起本段译文');
  note.append(button,block.row);
  note.onkeydown=e=>{if(e.key==='Escape'){e.stopPropagation();close();}};
  const page=item.el.getBoundingClientRect(),pane=r.original.getBoundingClientRect();
  const left=Math.max(page.left,pane.left),right=Math.min(page.right,pane.right);
  const top=Math.max(page.top,pane.top),bottom=Math.min(page.bottom,pane.bottom);
  const width=Math.max(1,Math.min(460,right-left-12));
  const line=span.getBoundingClientRect();
  const end=page.top+(block.bounds.y+block.bounds.height)*item.scale;
  const below=end+6<bottom-90;
  const y=below?Math.max(top+4,end+6):Math.min(bottom-4,Math.max(top+90,line.top-6));
  note.style.width=width+'px';
  note.style.left=(Math.max(left+6,Math.min(page.left+block.bounds.x*item.scale,right-width-6))-page.left)+'px';
  note.style.top=(y-page.top)+'px';
  note.style.maxHeight=Math.max(48,Math.min(320,below?bottom-y-4:y-top-4))+'px';
  if(!below)note.style.transform='translateY(-100%)';
  item.el.append(note);
  button.focus({preventScroll:true});
  readingTranslate(r);
}
function readingPDFContinuousTrack(r){
  if(!r.pdfCanvases||r.dead)return;
  const top=r.original.getBoundingClientRect().top;
  const item=[...r.pdfCanvases.values()].find(i=>i.el.getBoundingClientRect().bottom>top+30);if(!item)return;
  r.page=item.number;r.state.page=r.page;r.pageInput.value=r.page;r.prev.disabled=r.page===1;r.next.disabled=r.page===r.pdf.numPages;
  r.pdfPage=item.el;r.pdfScale=item.scale||1;
  r.state.ratio=Math.max(0,Math.min(1,(top-item.el.getBoundingClientRect().top)/Math.max(1,item.el.clientHeight)));
  r.status.textContent=`第 ${r.page} / ${r.pdf.numPages} 页`;readingScheduleSave(r);readingTranslate(r);
  // Retain placeholders while releasing distant canvas/text-layer memory.
  for(const other of r.pdfCanvases.values()){
    if(!other.ready||Math.abs(other.number-r.page)<=3)continue;
    if(r.pdfParagraphs){
      other.el.style.height=other.el.getBoundingClientRect().height+'px';
      for(const b of r.pdfTextPages.get(other.number)?.blocks||[])b.sectionSlot?.remove();
    }
    other.layer?.cancel();other.proseResize?.disconnect();other.proseResize=null;other.prose=null;
    other.el.replaceChildren();other.translated?.replaceChildren();other.clean=null;other.copy=null;
    other.geometry=null;other.backRender=null;other.ready=false;other.render=null;other.layer=null;
  }
}
function readingPDFBlocks(items,viewport,lib,starts) {
  const blocks=[];let current=null,index=-1,last=null,fonts;
  for(const item of items) {
    if(typeof item.str!=='string')continue;
    index++; if(!item.str.trim())continue;
    const t=lib.Util.transform(viewport.transform,item.transform),height=Math.max(1,Math.hypot(t[2],t[3]));
    const box={x:t[4],y:t[5]-height,width:Math.abs(item.width),height};
    const gap=last?Math.abs(box.y-last.y):0;
    const limit=starts?(gap>height*.55?2600:2950):1800;
    // Returning from a short citation at the right margin to the next line
    // of the same column is common in papers.
    const columnJump=starts && current ? box.x-current.bounds.x>viewport.width*.4 || (last && box.y<last.y-height*1.9)
      : last && Math.abs(box.x-last.x)>viewport.width*.4;
    const newBlock=!current||starts?.has(index)||current.text.length+item.str.length>limit||gap>height*1.9||
      (last&&gap<height*.6&&(box.x-last.x-last.width>height*2||box.x+box.width<last.x-height))||
      (columnJump&&gap>height*.6);
    if(newBlock){current={id:'p'+blocks.length,text:'',indices:[],bounds:{...box},style:{}};blocks.push(current);fonts=new Map();}
    // Superscript references and mathematical symbols often start a paragraph.
    // Use the dominant text run for the translated paragraph's type and size.
    const fontKey=item.fontName+'@'+height.toFixed(1);
    const run=fonts.get(fontKey)||{size:height,font:item.fontName,sample:index,count:0};
    run.count+=item.str.trim().length;fonts.set(fontKey,run);
    if(run.count>=(current.style.count||0))current.style=run;
    current.text+=(current.text?' ':'')+item.str; current.indices.push(index);
    const bounds=current.bounds;
    const right=Math.max(bounds.x+bounds.width,box.x+box.width),bottom=Math.max(bounds.y+bounds.height,box.y+box.height);
    bounds.x=Math.min(bounds.x,box.x);bounds.y=Math.min(bounds.y,box.y);bounds.width=right-bounds.x;bounds.height=bottom-bounds.y;
    last=box;
  }
  return blocks;
}
function readingPDFLocate(r,block) {
  if(!r.pdfOriginalMode)return readingSlideLocate(r,block);
  if(block.page&&block.page!==r.page){readingPDFPage(r,block.page).then(()=>readingPDFLocate(r,block));return;}
  if(r.pdfParagraphs){
    r.original.querySelector('.textLayer [data-reading-block="'+block.id+'"]')?.scrollIntoView({block:'center'});
    return;
  }
  if(!block.bounds||!r.pdfPage)return;
  r.original.scrollTop=Math.max(0,r.pdfPage.offsetTop+block.bounds.y*r.pdfScale-30);
  r.pdfPage.querySelectorAll('.reading-pdf-highlight').forEach(n=>n.remove());
  const highlight=readerElement('div','reading-pdf-highlight');
  for(const [key,value] of Object.entries({left:block.bounds.x,top:block.bounds.y,width:block.bounds.width,height:block.bounds.height}))highlight.style[key]=value*r.pdfScale+'px';
  r.pdfPage.append(highlight);setTimeout(()=>highlight.remove(),2400);
}

// Slides retain their original artwork and a vertical bilingual reading flow.
function readingPDFCreateFlow(r) {
  r.translateController?.abort();r.translateController=null;r.generation++;
  r.blocks=[];r.rows.replaceChildren();r.pdfTextPages=new Map();r.pdfTextQueue=Promise.resolve();
  r.pdfFlow=readerElement('div','reading-pdf-flow');r.pdfFlow.style.zoom=String(r.zoom||1);
  r.pdfFlow.classList.add(r.slides?'reading-slides-flow':'reading-bilingual-flow');r.slideRenderQueue=Promise.resolve();
  r.pdfFlowVersion=(r.pdfFlowVersion||0)+1;r.pdfFlowReady=false;
  const fragment=document.createDocumentFragment();
  for(let number=1;number<=r.pdf.numPages;number++){
    const section=readerElement('section','reading-document-page');section.dataset.page=String(number);
    const header=readerElement('div','reading-document-page-head');
    header.append(readerElement('span','',r.slides?`幻灯片 ${number}`:`第 ${number} 页`));
    const body=readerElement('div','reading-document-paragraphs');
    body.append(readerElement('p','reading-document-pending','正文将在滚动到此处时载入…'));
    const art=r.slides?readerElement('div','reading-slide-art'):null;
    section.append(header);
    if(art){
      art.dataset.page=String(number);art.setAttribute('aria-label',`原始幻灯片 ${number}`);
      art.append(readerElement('p','reading-slide-pending','正在载入原页…'));section.append(art);
    }
    section.append(body);
    fragment.append(section);
    r.pdfTextPages.set(number,{section,body,art,ready:false,pending:null});
  }
  r.pdfFlow.append(fragment);r.original.replaceChildren(r.pdfFlow);
  r.pdfFlowObserver=new IntersectionObserver(entries=>{
    if(r.dead||r.pdfOriginalMode||!r.pdfFlowReady||!readingInViewport(r))return;
    for(const entry of entries)if(entry.isIntersecting){const number=Number(entry.target.dataset.page);readingPDFTextLoad(r,number).then(()=>{readingSlideRender(r,number);});}
  },{root:r.original,rootMargin:'320px 0px'});
}
function readingPDFTextLoad(r,number,loaded) {
  const item=r.pdfTextPages?.get(number);if(!item||r.dead)return Promise.resolve();
  if(item.ready)return Promise.resolve(item);
  if(item.pending)return item.pending;
  const version=r.pdfFlowVersion,pdf=r.pdf;
  const valid=()=>!r.dead&&version===r.pdfFlowVersion&&pdf===r.pdf;
  item.pending=r.pdfTextQueue.catch(()=>{}).then(async()=>{
    if(!valid())return;
    item.body?.replaceChildren(readerElement('p','reading-document-pending','正在读取正文…'));
    try {
      const page=loaded?.page||await pdf.getPage(number),content=loaded?.content||await page.getTextContent({includeMarkedContent:!r.slides});
      if(!valid())return;
      const unit=page.getViewport({scale:1});
      item.unit=unit;
      if(item.art)item.art.style.aspectRatio=String(unit.width/unit.height);
      let blocks=readingPDFBlocks(content.items,unit,r.pdfLib);
      if(r.pdfParagraphs)blocks=readingPDFParagraphBlocks(blocks,content.items,unit,r.pdfLib);
      if(!r.slides && r.translationOn){
        const policy=await readingPDFContentPolicy(page,content,unit,r.pdfLib,blocks,number,await r.pdfSectionOutline);
        if(!valid())return;
        blocks=policy.blocks;item.tables=policy.tables;
      }
      item.body?.replaceChildren();
      for(const block of blocks){
        block.legacyId=block.id;block.id='p'+(number*100000+Number(block.id.slice(1)));block.page=number;
        if (!item.body) continue;
        const pair=readerElement('div','reading-document-paragraph');
        block.sourceNode=readerElement('p','reading-document-source',block.text);
        pair.append(block.sourceNode);item.body.append(pair);
        if(r.slides){
          const locate=readerButton(r.slides?'定位到幻灯片':'定位到原段落',()=>readingLocate(r,block.id,true));locate.className='reading-slide-locate';pair.append(locate);
        }
      }
      if(!blocks.length && item.body){
        const empty=readerElement('div','reading-document-empty',r.slides?'本页以图片或图形为主，原始幻灯片已保留；没有可提取的文字。':'本页没有可提取的文字，图片与图表可在原始版式中查看；扫描文字暂不支持翻译。');
        item.body.append(empty);
      }
      item.ready=true;item.error='';item.section?.classList.add('is-loaded');
      item.blocks=readingBlocks(r,blocks,true);
      if(r.pdfParagraphs){
        item.sectionParts=readingPDFSectionParts(item.blocks);
        readingPDFIndexSections(r);
      }
      if(r.slides)r.blocks.sort((a,b)=>a.page-b.page||Number(a.id.slice(1))-Number(b.id.slice(1)));
      return item;
    }catch(err){
      if(!valid())return;
      item.error=err.message || '文字读取失败';
      if(r.pdfParagraphs)readingPDFIndexSections(r);
      if (!item.body) return;
      const failure=readerElement('div','reading-document-empty',`第 ${number} 页正文读取失败：${err.message}`);
      failure.append(readerButton('重试本页',()=>readingPDFTextLoad(r,number)));item.body.replaceChildren(failure);
    }finally{item.pending=null;}
  });
  r.pdfTextQueue=item.pending;return item.pending;
}
async function readingPDFTextPage(r,number,restore=false) {
  const same=r.pdfFlowReady&&r.page===number;
  r.pdfFlow.style.zoom=String(r.zoom||1);
  r.page=number;r.pageInput.value=number;r.prev.disabled=number===1;r.next.disabled=number===r.pdf.numPages;
  if(!r.original.contains(r.pdfFlow))r.original.replaceChildren(r.pdfFlow);
  r.pdfPage=null;r.pdfPixels=null;r.pdfBackdrop=null;r.layout=null;
  r.state.page=number;if(r.slides)r.translationOn=true;
  const version=r.pdfFlowVersion;await readingPDFTextLoad(r,number);
  if(r.dead||r.pdfOriginalMode||version!==r.pdfFlowVersion)return;
  const item=r.pdfTextPages.get(number);
  if(!same||!restore){
    // Old reading sessions may point into the former plain-text transcript.
    // Presentations must reopen at the intact slide, not skip past its artwork.
    const saved=!r.slides&&restore&&r.blocks.find(b=>b.page===number&&(b.id===r.state.anchor||b.legacyId===r.state.anchor));
    (saved?.sourceNode||item.section).scrollIntoView({block:'start'});
  }
  if(!r.pdfFlowReady){r.pdfFlowReady=true;for(const item of r.pdfTextPages.values())r.pdfFlowObserver.observe(item.section);}
  await readingSlideRender(r,number);
  r.status.textContent=r.slides?'保留幻灯片版式与配色；同页下方逐段对照，点击可定位原文':'译文显示在每段原文下方';
  readingScheduleSave(r);readingPDFVisible(r);readingTranslate(r);
}
function readingPDFTrack(r) {
  const top=r.original.getBoundingClientRect().top+20;
  const item=[...r.pdfTextPages.values()].find(item=>item.section.getBoundingClientRect().bottom>top);
  if(!item)return;
  const number=Number(item.section.dataset.page);r.page=number;r.state.page=number;r.pageInput.value=number;
  r.prev.disabled=number===1;r.next.disabled=number===r.pdf.numPages;
  const block=r.blocks.find(b=>b.page===number&&b.sourceNode.getBoundingClientRect().bottom>top);
  if(block)r.state.anchor=block.id;
  r.state.ratio=r.original.scrollTop/Math.max(1,r.original.scrollHeight-r.original.clientHeight);readingScheduleSave(r);
}
function readingPDFVisible(r) {
  if(r.dead||r.pdfOriginalMode||!r.pdfFlowReady||!readingInViewport(r))return;
  const bounds=r.original.getBoundingClientRect();let count=0;
  for(const [number,item]of r.pdfTextPages){
    const box=item.section.getBoundingClientRect();
    if(box.bottom>=bounds.top-160&&box.top<=bounds.bottom+320){
      if(!item.ready&&!item.pending)readingPDFTextLoad(r,number).then(()=>{readingSlideRender(r,number);});
      else if(item.ready)readingSlideRender(r,number);
      if(++count>=3)break;
    }
  }
  readingSlidesTrim(r);
}
