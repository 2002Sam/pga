/* Presentation artwork is never reflowed or recoloured. Translations belong to
   the same slide card, beneath it, and can locate their original text boxes. */
function readingSlideRelease(item) {
  item.paintVersion=(item.paintVersion||0)+1;
  item.render?.cancel();item.textLayer?.cancel();
  if(item.canvas){item.canvas.width=0;item.canvas.height=0;}
  item.canvas=null;item.wrapper=null;item.render=null;item.textLayer=null;item.paintSignature='';
  if(item.art){item.art.replaceChildren(readerElement('p','reading-slide-pending','滚动到此处时显示原页'));item.art.classList.remove('is-rendered');}
}
function readingSlidesDispose(r) {
  for(const item of r.pdfTextPages?.values()||[])if(item.art)readingSlideRelease(item);
}
function readingSlideRender(r,number) {
  const item=r.pdfTextPages?.get(number);
  if(r.dead||r.pdfOriginalMode||!item?.art)return Promise.resolve();
  const width=Math.max(1,item.art.clientWidth||r.pdfFlow.clientWidth-24);
  const signature=[Math.round(width),r.zoom||1,devicePixelRatio||1].join(':');
  if(item.paintSignature===signature&&item.canvas)return Promise.resolve(item);
  if(item.paintJob)return item.paintJob;
  const pdf=r.pdf,flowVersion=r.pdfFlowVersion,paintVersion=item.paintVersion||0;
  const valid=()=>!r.dead&&!r.pdfOriginalMode&&r.pdf===pdf&&r.pdfFlowVersion===flowVersion&&(item.paintVersion||0)===paintVersion;
  const job=(r.slideRenderQueue||Promise.resolve()).catch(()=>{}).then(async()=>{
    try {
      if(!valid())return;
      const page=await pdf.getPage(number);if(!valid())return;
      const unit=page.getViewport({scale:1}),scale=width/unit.width,viewport=page.getViewport({scale});
      item.unit=unit;item.scale=scale;item.art.style.aspectRatio=String(unit.width/unit.height);
      const density=Math.min((devicePixelRatio||1)*(r.zoom||1),2,Math.sqrt(4_000_000/(viewport.width*viewport.height)));
      const wrapper=readerElement('div','reading-pdf-page');wrapper.style.width=viewport.width+'px';wrapper.style.height=viewport.height+'px';
      wrapper.style.setProperty('--total-scale-factor',scale);wrapper.style.setProperty('--scale-factor',scale);
      const canvas=readerElement('canvas');canvas.width=Math.ceil(viewport.width*density);canvas.height=Math.ceil(viewport.height*density);
      canvas.style.width=viewport.width+'px';canvas.style.height=viewport.height+'px';canvas.setAttribute('aria-label',r.slides?`原始幻灯片 ${number}`:`原始 PDF 第 ${number} 页`);
      const text=readerElement('div','textLayer');wrapper.append(canvas,text);
      item.render?.cancel();item.textLayer?.cancel();
      if(item.canvas){item.canvas.width=0;item.canvas.height=0;}
      item.wrapper=wrapper;item.canvas=canvas;item.art.replaceChildren(wrapper);
      const render=item.render=page.render({canvasContext:canvas.getContext('2d'),viewport,transform:density===1?null:[density,0,0,density,0,0]});
      // Attach a rejection handler immediately, including while text extraction waits.
      const rendered=render.promise;rendered.catch(()=>{});
      const content=await page.getTextContent();if(!valid())return;
      const layer=item.textLayer=new r.pdfLib.TextLayer({textContentSource:content,container:text,viewport});
      await Promise.all([rendered,layer.render()]);if(!valid())return;
      for(const block of r.blocks.filter(b=>b.page===number))for(const index of block.indices||[])if(layer.textDivs[index])layer.textDivs[index].dataset.readingBlock=block.id;
      item.paintSignature=signature;item.art.classList.add('is-rendered');readingSlideAnnotations(r);
      return item;
    }catch(err){
      if(!valid()||err.name==='RenderingCancelledException')return;
      item.paintSignature='';
      const error=readerElement('div','reading-document-empty',`原页显示失败：${err.message}`);
      error.append(readerButton('重新显示',()=>readingSlideRender(r,number)));item.art.replaceChildren(error);
    }finally{if(item.paintJob===job)item.paintJob=null;}
  });
  item.paintJob=job;r.slideRenderQueue=job;return job;
}
function readingSlidesTrim(r) {
  const bounds=r.original.getBoundingClientRect(),margin=Math.max(bounds.height,600);
  const mounted=[...r.pdfTextPages.values()].filter(item=>item.canvas);
  for(const item of mounted){
    const box=item.art.getBoundingClientRect();
    if(box.bottom<bounds.top-margin||box.top>bounds.bottom+margin)readingSlideRelease(item);
  }
}
function readingSlideAnnotations(r) {
  if(r.pdfOriginalMode)return;
  for(const item of r.pdfTextPages?.values()||[])item.wrapper?.querySelectorAll('.reading-pdf-annotation').forEach(node=>node.remove());
  for(const mark of r.annotations||[]){
    const block=r.blocks.find(b=>b.page===mark.page&&(b.id===mark.id||b.legacyId===mark.id)&&(!mark.text||b.text.slice(0,1200)===mark.text));
    const item=block&&r.pdfTextPages.get(block.page);if(!item?.wrapper||!block.bounds)continue;
    const overlay=readerElement('div',`reading-pdf-annotation ${mark.kind==='underline'?'is-underline':'is-highlight'}`);
    readingBox(overlay,{...block.bounds},item.scale);item.wrapper.append(overlay);
  }
}
async function readingSlideLocate(r,block) {
  const item=r.pdfTextPages?.get(block.page);if(!item||r.dead)return;
  item.art.scrollIntoView({block:'center'});await readingSlideRender(r,block.page);
  if(r.dead||!item.wrapper||!block.bounds)return;
  r.page=block.page;r.state.page=block.page;r.state.anchor=block.id;r.pageInput.value=block.page;readingScheduleSave(r);
  item.wrapper.querySelectorAll('.reading-pdf-highlight').forEach(node=>node.remove());
  const highlight=readerElement('div','reading-pdf-highlight');readingBox(highlight,{...block.bounds},item.scale);item.wrapper.append(highlight);
  setTimeout(()=>highlight.remove(),2400);
}
