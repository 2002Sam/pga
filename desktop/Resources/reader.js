/* Runs only in WKContentWorld("PGA reading"), with no privileged app bridge. */
(() => {
  let enabled=false,blocks=[],nodes=new Map(),serial=0,ids=new WeakMap(),timer,scrollTimer,button,selection,layoutSignature;
  let translationTarget=null; const translations=new Map();
  const send=data=>webkit.messageHandlers.reader.postMessage(data);
  let markDigits = '';
  addEventListener('keydown', e => {
    if (!e.isTrusted || e.defaultPrevented || e.isComposing || e.keyCode === 229 ||
        e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || !/^[1-9]$/.test(e.key) || !markDigits.includes(e.key)) return;
    const target = e.composedPath()[0];
    if (target.isContentEditable || target.closest?.('input:not([readonly]), textarea:not([readonly]), select, [role="textbox"]:not([aria-readonly="true"]), [role="dialog"], dialog')) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!e.repeat) send({event:'markDigit', digit:e.key});
  }, true);
  addEventListener('click', e => {
    if (!e.isTrusted || e.button !== 0) return;
    if (e.detail === 1) { send({event:'pageSelected'}); return; }
    if (e.detail !== 2 && e.detail !== 3) return;
    if (e.target.closest?.('a,button,input,textarea,select,summary,label,[contenteditable],[role="button"],[role="link"],video,audio,pre,code,p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,[data-pga-reader-tool],[data-pga-translation]') || getSelection()?.toString()) return;
    send({event:'pageSize', clicks:e.detail});
  }, true);
  const excluded='nav,header,footer,aside,script,style,noscript,form,button,[role="button"],input,textarea,select,[contenteditable="true"],[role="navigation"],sup,sub,[data-pga-reader-tool],[data-pga-translation],[translate="no"],.notranslate,[role="tab"],[role="tablist"],[role="menu"],[role="toolbar"],label,pre,code,math';
  function isTranslationContent(node){
    if(node.closest(excluded))return false;
    // arXiv abstract pages contain large service panels inside the main content.
    // Their labels and submission metadata are not part of the paper.
    if(/(^|\.)arxiv\.org$/i.test(location.hostname)&&/^\/abs\//.test(location.pathname))
      return !!node.closest('h1.title,blockquote.abstract');
    if(node.querySelector('button,input,select,[role="tab"],[role="switch"]'))return false;
    const text=node.textContent.trim();
    if(/^(?:https?:\/\/\S+|(?:doi:)?10\.\d{4,9}\/\S+|arXiv:\S+|[\d\s.,%+−–:/()[\]-]+)$/iu.test(text))return false;
    return true;
  }
  function extract(){
    if(!enabled)return;
    const root=document.querySelector('article,main,[role="main"]')||document.body;if(!root)return;
    const semantic=[...root.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,td')].filter(n=>!n.querySelector('p,li,pre,td')&&!n.closest(excluded));
    const sourceText=node=>{const clone=node.cloneNode(true);clone.querySelectorAll('[data-pga-translation],[data-pga-reader-tool]').forEach(n=>n.remove());return clone.textContent||'';};
    const candidates=semantic.map(node=>({node,text:sourceText(node)}));
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let leaf;
    const grouped=new Set();
    while((leaf=walker.nextNode())&&candidates.length<2000){
      let node=leaf.parentElement;
      if(!leaf.textContent.trim()||!node||node.closest(excluded)||semantic.some(n=>n.contains(node)))continue;
      // Translate whole prose blocks, never individual author links or punctuation.
      while(node!==root&&['inline','inline-block','contents'].includes(getComputedStyle(node).display))node=node.parentElement;
      if(!node||grouped.has(node)||node.closest(excluded)||semantic.some(n=>node.contains(n)))continue;
      grouped.add(node);
      if(node.querySelector('sup,sub')||!['block','flow-root'].includes(getComputedStyle(node).display))continue;
      const text=sourceText(node).trim();
      if(text.length<40||!/[.!?。！？]/u.test(text))continue;
      candidates.push({node,text});
    }
    const out=[];nodes=new Map();let chars=0;
    const bounds=rect=>({x:rect.left+scrollX,y:rect.top+scrollY,width:rect.width,height:rect.height});
    for(const entry of candidates){
      const {node}=entry;if(!node.getClientRects().length||!isTranslationContent(node))continue;
      const computed=getComputedStyle(node);if(computed.visibility==='hidden'||computed.display==='none')continue;
      const text=entry.text.trim();if(!/\p{L}/u.test(text))continue;
      let rect=node.getBoundingClientRect();if(entry.key){const range=document.createRange();range.selectNodeContents(entry.key);rect=range.getBoundingClientRect();}
      if(!rect.width||!rect.height)continue;
      let keys=ids.get(entry.key||node);if(!keys){keys=[];ids.set(entry.key||node,keys);}
      const chunks=Math.ceil(text.length/2800);
      for(let start=0,i=0;start<text.length;start+=2800,i++){
        const id=keys[i]||(keys[i]='p'+serial++),part=text.slice(start,start+2800),box=bounds(rect);
        box.y+=box.height*i/chunks;box.height/=chunks;
        out.push({id,text:part,bounds:box,tag:node.tagName,style:{size:parseFloat(computed.fontSize),weight:computed.fontWeight,align:computed.textAlign,family:computed.fontFamily,color:computed.color,line:(parseFloat(computed.lineHeight)||parseFloat(computed.fontSize)*1.3)/parseFloat(computed.fontSize)}});nodes.set(id,node);chars+=part.length;
        if(out.length>=500||chars>=200000)break;
      }
      if(out.length>=500||chars>=200000)break;
    }
    for(const [id,entry] of translations){if(!entry.node.isConnected||!out.some(b=>b.id===id&&b.text===entry.source)){entry.el.remove();translations.delete(id);}}
    out.sort((a,b)=>a.bounds.y-b.bounds.y||a.bounds.x-b.bounds.x);
    const media=[...root.querySelectorAll('img,video')].slice(0,100).filter(n=>n.getClientRects().length).map(n=>({...bounds(n.getBoundingClientRect()),src:n.currentSrc&&n.tagName==='IMG'?n.currentSrc:n.tagName==='VIDEO'?n.poster:n.src,alt:n.alt||''})).filter(m=>m.width>4&&m.height>4&&/^https?:/.test(m.src||''));
    const layout={width:innerWidth,height:Math.max(document.documentElement.scrollHeight,innerHeight),media};
    const signature=JSON.stringify([out,layout]);
    if(signature!==layoutSignature){blocks=out;layoutSignature=signature;send({event:'document',title:document.title.slice(0,500),blocks,layout,top:scrollY,visibleIds:visibleIds()});}
  }

  function visibleIds(){return blocks.filter(b=>{const n=nodes.get(b.id),r=n?.getBoundingClientRect();return r&&r.bottom>=-160&&r.top<innerHeight+260;}).map(b=>b.id);}
  function clearTranslations(){for(const entry of translations.values())entry.el.remove();translations.clear();translationTarget=null;}
  function putTranslations(data){
    if(!enabled||!['en','zh-CN'].includes(data?.target)||!Array.isArray(data.blocks))return;
    if(translationTarget!==data.target){clearTranslations();translationTarget=data.target;}
    for(const item of data.blocks.slice(0,6)){
      const source=blocks.find(b=>b.id===item.id),node=nodes.get(item.id);
      if(!node?.isConnected||!source||source.text!==item.source||typeof item.text!=='string'||item.text.length>16000)continue;
      let entry=translations.get(item.id);
      const normalize=text=>text.normalize('NFKC').replace(/\s+/g,' ').trim();
      if(!item.text.trim()||normalize(item.text)===normalize(item.source)){
        entry?.el.remove();translations.delete(item.id);continue;
      }
      if(!entry){
        const el=document.createElement('div');el.dataset.pgaTranslation=item.id;el.lang=data.target;
        const style=getComputedStyle(node);
        el.style.cssText='display:block!important;position:static!important;float:none!important;clear:both;max-width:100%;box-sizing:border-box;margin:6px 0 12px!important;white-space:pre-wrap!important;overflow-wrap:anywhere!important;opacity:.85;background:transparent!important;';
        el.style.fontFamily=style.fontFamily;el.style.fontSize=style.fontSize;el.style.fontWeight=style.fontWeight;el.style.lineHeight=style.lineHeight;el.style.color='inherit';
        entry={el,node,source:item.source};translations.set(item.id,entry);
        const preceding=blocks.slice(0,blocks.indexOf(source)).reverse().find(b=>nodes.get(b.id)===node&&translations.has(b.id));
        if(preceding)translations.get(preceding.id).el.after(el);
        else if(node.matches('li,td,th'))node.append(el);else node.after(el);
      }
      if(entry.el.textContent!==item.text)entry.el.textContent=item.text;
    }
    clearTimeout(timer);timer=setTimeout(extract,120);
  }
  function nearest(){return blocks.find(b=>{const rect=nodes.get(b.id)?.getBoundingClientRect();return rect&&rect.bottom>35;})?.id||blocks.at(-1)?.id||'';}
  function scroll(){if(!enabled)return;clearTimeout(scrollTimer);scrollTimer=setTimeout(()=>send({event:'scroll',anchor:nearest(),visibleIds:visibleIds(),top:scrollY,ratio:Math.max(0,Math.min(1,scrollY/Math.max(1,document.documentElement.scrollHeight-innerHeight)))}),130);}
  function pick(event){
    if(!enabled||!event.isTrusted||(event.target.closest?.(excluded)&&!event.target.closest?.('[data-pga-translation]')))return;
    const s=getSelection(),text=s?.toString().trim();button?.remove();button=null;
    if(!text||text.length>8000||!s.rangeCount)return;
    const node=s.anchorNode?.parentElement;if(!node||(node.closest(excluded)&&!node.closest('[data-pga-translation]')))return;
    const anchor=node.closest('[data-pga-translation]')?.dataset.pgaTranslation||blocks.find(b=>nodes.get(b.id)?.contains(node))?.id||nearest();
    const rect=s.getRangeAt(0).getBoundingClientRect();selection={text,anchor,bottom:rect.bottom};
    button=document.createElement('button');button.type='button';button.textContent='问 AI';button.setAttribute('data-pga-reader-tool','');
    button.style.cssText=`position:fixed!important;z-index:2147483647!important;left:${Math.max(4,Math.min(innerWidth-80,rect.right-65))}px!important;top:${Math.max(4,Math.min(innerHeight-40,rect.bottom+5))}px!important;padding:7px 12px!important;background:#242a2f!important;color:white!important;border:1px solid #eee!important;border-radius:8px!important;font:13px system-ui!important;cursor:pointer!important;box-shadow:0 4px 15px #0003!important;`;
    button.addEventListener('mousedown',e=>e.preventDefault());
    button.addEventListener('click',e=>{if(!e.isTrusted)return;e.preventDefault();e.stopPropagation();send({event:'selection',...selection});button?.remove();button=null;});
    document.body.append(button);
  }
  window.__pgaReading={
    marks(digits){markDigits=digits;},
    translations:putTranslations,clearTranslations,
    start(){enabled=true;layoutSignature='';extract();},
    theme(theme){document.getElementById('pga-reading-theme')?.remove();},
    offset(top){window.scrollTo({top:Math.max(0,top),behavior:'instant'});},
    locate(id){const node=nodes.get(id);if(node){node.scrollIntoView({block:'start',behavior:'instant'});node.animate?.([{outline:'3px solid #e7b649',backgroundColor:'#ffd75a44'},{outline:'3px solid transparent',backgroundColor:'transparent'}],{duration:1800});}},
    scroll(ratio){window.scrollTo({top:Math.max(0,Math.min(1,ratio))*Math.max(0,document.documentElement.scrollHeight-innerHeight),behavior:'instant'});}
  };
  addEventListener('resize',()=>{clearTimeout(timer);timer=setTimeout(extract,120);});
  addEventListener('load',()=>{clearTimeout(timer);timer=setTimeout(extract,100);},true);
  new ResizeObserver(()=>{clearTimeout(timer);timer=setTimeout(extract,120);}).observe(document.documentElement);
  addEventListener('mouseup',pick);addEventListener('keyup',e=>{if(e.key==='Shift')pick(e);});
  addEventListener('scroll',scroll,{passive:true});
  addEventListener('mousedown',e=>{if(button&&!button.contains(e.target)){button.remove();button=null;}},true);
  new MutationObserver(records=>{
    if(!enabled||records.every(record=>record.target.parentElement?.closest('[data-pga-translation],[data-pga-reader-tool]')||record.target.closest?.('[data-pga-translation],[data-pga-reader-tool]')||record.type==='childList'&&[...record.addedNodes,...record.removedNodes].every(n=>n.nodeType===1&&(n.hasAttribute?.('data-pga-reader-tool')||n.hasAttribute?.('data-pga-translation')))))return;
    clearTimeout(timer);timer=setTimeout(extract,700);
  }).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
})();
