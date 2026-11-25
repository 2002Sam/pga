/* Render translated text in the measured boxes of the source, retaining figures and whitespace. */
function readingTheme(r){
  if(r.dead)return;
  const style=getComputedStyle(r.original),dark=document.documentElement.dataset.theme!=='light';
  r.theme={dark,background:style.backgroundColor,foreground:getComputedStyle(r.root).color};
  if(r.native)window.top.readingNativeCommand?.(r.nativeId,'readTheme',{theme:r.theme});
  if(r.pdfPixels)readingPDFTheme(r);
}
function readingAlign(r){
  if(!r.layout||r.dead||r.inline||r.pdfOriginalMode)return;
  const width=Math.max(1,Number(r.layout.width)||r.rows.clientWidth),height=Math.max(1,Math.min(1000000,Number(r.layout.height)||1));
  const scale=r.pdf ? r.pdfScale : r.rows.clientWidth/width;r.layoutScale=scale;
  let surface=r.rows.querySelector('.reading-layout');
  if(!surface){surface=readerElement('div','reading-layout');r.rows.prepend(surface);}
  r.rows.classList.add('reading-positioned');r.rows.classList.toggle('reading-pdf-rows',!!r.pdf);surface.style.width=width*scale+'px';surface.style.height=height*scale+'px';
  surface.querySelectorAll('.reading-media').forEach(n=>n.remove());
  for(const media of (r.layout.media||[]).slice(0,100)){
    if(!/^https?:\/\/|^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(media.src||''))continue;
    const img=readerElement('img','reading-media');img.src=media.src;img.alt=String(media.alt||'');img.referrerPolicy='no-referrer';img.loading='lazy';surface.append(img);readingBox(img,media,scale);
  }
  if(r.pdfBackdrop){surface.prepend(r.pdfBackdrop);r.pdfBackdrop.style.width=width*scale+'px';r.pdfBackdrop.style.height=height*scale+'px';}
  for(const block of r.blocks){
    const box=block.bounds;if(!box||![box.x,box.y,box.width,box.height].every(Number.isFinite))continue;
    surface.append(block.row);readingBox(block.row,box,scale);
    const style=block.style||{};
    block.row.style.textAlign=['center','right','justify','left','start','end'].includes(style.align)?style.align:'left';
    block.row.style.fontWeight=String(style.weight||'400');
    block.fontSize=Math.max(8,Math.min(160,Number(style.size)||14))*scale;
    block.row.style.fontFamily=style.family||'inherit';
    block.row.style.color=style.color||'inherit';
    block.row.style.lineHeight=String(Math.max(1,Math.min(2.5,Number(style.line)||1.4)));
    block.row.style.fontSize=block.fontSize+'px';block.row.classList.toggle('reading-heading',/^H[1-6]$/.test(block.tag||''));
    readingFit(block);
  }
}
function readingBox(el,box,scale){
  for(const [prop,value]of Object.entries({left:box.x,top:box.y,width:box.width,height:box.height}))el.style[prop]=Math.max(prop==='width'||prop==='height'?1:0,Math.min(1000000,Number(value)||0))*scale+'px';
}
function readingFit(block){
  const el=block.output,row=block.row;if(!row.closest('.reading-layout, [data-translated-page]'))return;
  let upper=block.fontSize||14,lower=row.closest('[data-translated-page]')?upper*.72:Math.min(9,upper);row.style.fontSize=upper+'px';
  const fits=()=>el.scrollHeight<=row.clientHeight+2&&el.scrollWidth<=row.clientWidth+2;
  if(fits())return;
  // Bound layout work for large headings; long translations remain selectable and scrollable.
  for(let i=0;i<8&&upper-lower>.4;i++){const size=(upper+lower)/2;row.style.fontSize=size+'px';if(fits())lower=size;else upper=size;}
  row.style.fontSize=lower+'px';
}
function readingScrollSource(r){
  r.syncingUntil=Date.now()+250;
  const top=r.rows.scrollTop/(r.layoutScale||1);
  if(r.native)window.top.readingNativeCommand?.(r.nativeId,'readOffset',{top});
  else if(r.pdf){r.original.scrollTop=r.rows.scrollTop;r.original.scrollLeft=r.rows.scrollLeft;}
}
function readingPDFTheme(r){
  const canvas=r.pdfPage?.querySelector('canvas');if(!canvas||!r.pdfPixels)return;
  const ctx=canvas.getContext('2d'),original=r.pdfPixels;
  if(r.slides||r.pdfOriginalMode){ctx.putImageData(original,0,0);return;}
  if(!r.theme){ctx.putImageData(original,0,0);}else{
    const rgb=color=>{const c=document.createElement('canvas').getContext('2d');c.fillStyle=color;c.fillRect(0,0,1,1);return c.getImageData(0,0,1,1).data;};
    const bg=rgb(r.theme.background),fg=rgb(r.theme.foreground),copy=new ImageData(new Uint8ClampedArray(original.data),original.width,original.height),data=copy.data;
    for(let i=0;i<data.length;i+=4){if(Math.max(data[i],data[i+1],data[i+2])-Math.min(data[i],data[i+1],data[i+2])>20)continue;const paper=(data[i]+data[i+1]+data[i+2])/765;for(let ch=0;ch<3;ch++)data[i+ch]=fg[ch]*(1-paper)+bg[ch]*paper;}
    ctx.putImageData(copy,0,0);
  }
  if(r.pdfBackdrop){
    r.pdfBackdrop.width=canvas.width;r.pdfBackdrop.height=canvas.height;
    const copy=r.pdfBackdrop.getContext('2d');copy.drawImage(canvas,0,0);copy.fillStyle=r.theme?.background||'#fff';
    const sx=canvas.width/r.layout.width,sy=canvas.height/r.layout.height;
    for(const block of r.blocks){const b=block.bounds;if(!b)continue;const descent=(block.style?.size||12)*.3;
      copy.fillRect(b.x*sx-2,b.y*sy-2,b.width*sx+4,(b.height+descent)*sy+4);
    }
  }
}
