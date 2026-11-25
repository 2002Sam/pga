/* Only the trusted top-level PGA document talks to the native bridge. */
const READING_NATIVE = { entries:new Map(), frame:0, signature:'' };
window.readingNativeAdd = function(r,owner) {
  READING_NATIVE.entries.set(r.nativeId,{r,owner}); READING_NATIVE.signature=''; readingNativeSync();
};
window.readingNativeRemove = function(id) {
  if(!id||!READING_NATIVE.entries.delete(id))return;
  fpBrowserPost('close',{id});READING_NATIVE.signature='';readingNativeSync();
};
window.readingNativeCommand = (id,op,data={}) => fpBrowserPost(op,{id,...data});
// Resolve a native browser id to its actual canvas page, never the last focus.
window.readingNativeStageTarget = function(id) {
  const entry=READING_NATIVE.entries.get(id);if(!entry||entry.r.dead||!entry.r.original.isConnected)return null;
  let anchor=entry.r.original,owner=entry.owner;
  try {
    while(owner!==window){anchor=owner.frameElement;if(!anchor?.isConnected)return null;owner=owner.parent;}
    const el=anchor.closest('.stnode');
    const n=window.ST?.nodes.find(n=>n.el===el);
    return n&&!n.small&&!n.mini&&!n.managerParked&&!el.hidden?el:null;
  } catch {return null;}
};
function readingNativeIntersect(a,b) {
  const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y);
  return{x,y,width:Math.max(0,Math.min(a.x+a.width,b.x+b.width)-x),height:Math.max(0,Math.min(a.y+a.height,b.y+b.height)-y)};
}
// Native web views are siblings of the host WKWebView; CSS z-index cannot put
// a pinned conversation/document above them. Send only the unobscured area.
function readingNativeOcclusion(clip,anchor,doc) {
  let parts=[clip];
  for(const cover of doc.querySelectorAll('.st-screen-pinned, #pgaFilePanel, #managerPanel, #stlist, #stmoremenu')){
    if(cover.contains(anchor)||anchor.contains(cover))continue;
    const box=cover.getBoundingClientRect(),overlap=readingNativeIntersect(clip,box);
    if(!overlap.width||!overlap.height)continue;
    // Respect DOM stacking: a legacy file panel can itself be above a pin.
    const front=doc.elementsFromPoint(overlap.x+overlap.width/2,overlap.y+overlap.height/2)
      .find(el=>cover.contains(el)||anchor.contains(el));
    if(!front||!cover.contains(front))continue;
    parts=parts.flatMap(p=>{
      const cut=readingNativeIntersect(p,box);if(!cut.width||!cut.height)return[p];
      return[{x:p.x,y:p.y,width:cut.x-p.x,height:p.height},
        {x:cut.x+cut.width,y:p.y,width:p.x+p.width-cut.x-cut.width,height:p.height},
        {x:cut.x,y:p.y,width:cut.width,height:cut.y-p.y},
        {x:cut.x,y:cut.y+cut.height,width:cut.width,height:p.y+p.height-cut.y-cut.height}]
        .filter(r=>r.width>0&&r.height>0);
    });
  }
  // Pins occupy contiguous strips at the left. Other overlays temporarily leave
  // the largest visible rectangle; the full viewport stays unchanged for layout.
  return parts.sort((a,b)=>b.width*b.height-a.width*a.height)[0]||{...clip,width:0,height:0};
}
function readingNativeRect(entry) {
  const {r,owner}=entry;
  if(r.dead||!r.original.isConnected||owner.document.hidden||owner.document.querySelector('.modal,dialog[open],.reading-ask-popup,.reading-controls[open]'))return null;
  const b=r.original.getBoundingClientRect();
  if(b.width<1||b.height<1)return null;
  let rect={x:b.x,y:b.y,width:b.width,height:b.height},clip={...rect},w=owner,anchor=r.original;
  while(true){
    if(w.document.hidden||w.document.querySelector('#vStage.overview:not([hidden]), #vStage .st-dock-layer'))return null;
    for(let p=anchor;p;p=p.parentElement){
      const style=w.getComputedStyle(p);
      if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0)return null;
      if([style.overflowX,style.overflowY].some(v=>['hidden','clip','auto','scroll'].includes(v)))
        clip=readingNativeIntersect(clip,p.getBoundingClientRect());
    }
    clip=readingNativeIntersect(clip,{x:0,y:0,width:w.innerWidth,height:w.innerHeight});
    clip=readingNativeOcclusion(clip,anchor,w.document);
    if(clip.width<24||clip.height<24)return null;
    if(w===window)break;
    const f=w.frameElement;if(!f||!f.isConnected)return null;
    const box=f.getBoundingClientRect(),sx=box.width/w.innerWidth,sy=box.height/w.innerHeight;
    const convert=a=>({x:box.x+a.x*sx,y:box.y+a.y*sy,width:a.width*sx,height:a.height*sy});
    rect=convert(rect);clip=convert(clip);anchor=f;w=w.parent;
  }
  const round=a=>Object.fromEntries(Object.entries(a).map(([k,v])=>[k,Math.round(v*2)/2]));
  const x=Math.ceil(clip.x*2)/2,y=Math.ceil(clip.y*2)/2;
  clip={x,y,width:Math.floor((clip.x+clip.width)*2)/2-x,height:Math.floor((clip.y+clip.height)*2)/2-y};
  return{id:r.nativeId,url:r.info.source,reading:true,stageWheel:S.view==='stage',
    stagePointer:S.view==='stage'&&!!window.readingNativeStageTarget(r.nativeId),
    markDigits:Object.keys(window.ST?.positionMarks || {}).filter(d => /^[1-9]$/.test(d)).join(''),
    theme:r.theme,viewportWidth:innerWidth,rect:round(rect),clip};
}
function readingNativeSync() {
  if(window.top!==window||!window.PGA_NATIVE?.readingBrowser||READING_NATIVE.frame)return;
  READING_NATIVE.frame=requestAnimationFrame(()=>{
    READING_NATIVE.frame=0;
    const legacy=typeof fpActive==='function'&&fpActive()?.browser&&!FILE_PANEL.host?.hidden;
    const blocked=document.hidden||document.querySelector('.modal,dialog[open]');
    const items=[];
    for(const [id,entry]of READING_NATIVE.entries){
      if(entry.owner.closed||entry.r.dead||!entry.r.original.isConnected){READING_NATIVE.entries.delete(id);fpBrowserPost('close',{id});continue;}
      if(!blocked&&!legacy){const rect=readingNativeRect(entry);if(rect)items.push(rect);}
    }
    if(!legacy){const signature=JSON.stringify(items);if(signature!==READING_NATIVE.signature){READING_NATIVE.signature=signature;fpBrowserPost('layout',{items});}}
    else READING_NATIVE.signature='';
    if(READING_NATIVE.entries.size)readingNativeSync();
  });
}
window.readingNativeState = function(state) {
  const entry=READING_NATIVE.entries.get(state.id);if(!entry)return false;
  const {r,owner}=entry;
  if (state.event === 'markDigit') {
    const mark = /^[1-9]$/.test(state.digit) && ST.positionMarks[state.digit];
    if (mark && S.view === 'stage' && window.readingNativeStageTarget(state.id)) stReturnToMark(mark);
    return true;
  }
  if (state.event === 'pageSelected' || state.event === 'leavePage') {
    const node = window.readingNativeStageTarget(state.id);
    if (node && S.view === 'stage') {
      const id = node.dataset.nid;
      if (id !== ST.focus) { stFocus(id); stShow(id, true); }
      if (state.event === 'leavePage') $('#starena')?.focus({preventScroll:true});
    }
    return true;
  }
  if (state.event === 'pageSize') {
    const el = window.readingNativeStageTarget(state.id);
    const node = el && ST.nodes.find(n => n.el === el);
    if (node && S.view === 'stage' && (state.clicks === 2 || state.clicks === 3)) {
      stClickSize(node, {detail:state.clicks});
    }
    return true;
  }
  if (r.webBack && typeof state.back === 'boolean') {
    r.webBack.disabled = !state.back;
  }
  if (r.webForward && typeof state.forward === 'boolean') r.webForward.disabled = !state.forward;
  if(state.open){
    let url;try{url=new URL(state.open);}catch{return true;}
    if(!/^https?:$/.test(url.protocol)||url.username||url.password)return true;
    if (readingPDFSource(url.href)) {
      // readingOpen coalesces pending opens for this exact source and parent.
      readingOpen(url.href,true,{key:r.info.key},r.info.uid||owner.S?.uid||S.uid);
    } else {
      readingNativeCommand(state.id,'navigate',{url:url.href});
    }
    return true;
  }
  if(state.event==='document'){
    if(!Array.isArray(state.blocks))return true;
    if(!r.inline&&state.layout&&Number.isFinite(state.layout.width)&&Number.isFinite(state.layout.height))r.layout=state.layout;
    r.visibleIds=Array.isArray(state.visibleIds)?state.visibleIds:state.blocks.slice(0,6).map(b=>b.id);
    const blocks=state.blocks.filter(b=>typeof b.id==='string'&&typeof b.text==='string').slice(0,500);
    const signature=JSON.stringify(blocks.map(b=>[b.id,b.text]));
    if(signature!==r.nativeContent){r.nativeContent=signature;owner.readingBlocks(r,blocks);}
    else {owner.readingPushTranslations(r);owner.readingTranslate(r);}
    if(Number.isFinite(state.top))r.rows.scrollTop=state.top*(r.layoutScale||1);
    if(state.title){r.info.title=String(state.title).slice(0,500);r.state.title=r.info.title;owner.document.querySelector('#chead h1').textContent=r.info.title;owner.readingScheduleSave(r);}
    r.status.textContent='原网页逐段翻译 · 译文显示在段落下方，选字可问 AI';
    if(!r.restoredNative){r.restoredNative=true;if(r.state.ratio)readingNativeCommand(r.nativeId,'readScroll',{ratio:r.state.ratio});else if(r.state.anchor)readingNativeCommand(r.nativeId,'locate',{anchor:r.state.anchor});}
  }else if(state.event==='selection'){
    const text=String(state.text||'').slice(0,8000);if(text){const rect=r.original.getBoundingClientRect();owner.readingAskPopup(r,{text,id:String(state.anchor||'')},{left:rect.left,bottom:rect.top+Number(state.bottom||60)});}
  }else if(state.event==='scroll'){
    if(Array.isArray(state.visibleIds))r.visibleIds=state.visibleIds;
    if(r.inline)owner.readingTranslate(r);
    r.state.ratio=Math.max(0,Math.min(1,Number(state.ratio)||0));r.state.anchor=String(state.anchor||'').slice(0,80);owner.readingScheduleSave(r);
    if(!r.inline&&!r.syncOff&&r.syncingUntil<Date.now()){
      if(r.layout&&Number.isFinite(state.top)){r.syncingUntil=Date.now()+180;r.rows.scrollTop=state.top*(r.layoutScale||1);return true;}
      const b=r.blocks.find(b=>b.id===r.state.anchor);if(b){r.syncingUntil=Date.now()+400;r.rows.scrollTop+=b.row.getBoundingClientRect().top-r.rows.getBoundingClientRect().top-8;r.rows.querySelectorAll('.reading-active').forEach(n=>n.classList.remove('reading-active'));b.row.classList.add('reading-active');}
    }
  }else if(state.error){r.status.textContent=state.error+' · 点击「重新载入」重试';}
  else if(state.loading){r.status.textContent='正在载入原始网页…';}
  return true;
};
