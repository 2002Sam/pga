/* A source is an ordinary child chat. The original stays mounted while messages update. */
let READING = null;
const READING_OPEN = new Map();
const READING_PARENT_DRAFTS = new Map();
async function readingOpen(source, web = true, origin = fpCaptureOrigin(), uid = S.uid) {
  try { if (window.top !== window && window.top.readingOpen) return window.top.readingOpen(source, web, origin, uid); } catch {}
  const parent = origin?.key;
  if (!parent) { toast('请先打开一个对话，再从对话里打开资料'); return; }
  const token = [uid, parent, source].join('\n');
  if (READING_OPEN.has(token)) return READING_OPEN.get(token);
  const work = (async () => {
    try {
      const info = await api(`/v1/users/${uid}/reading/open`, { body: { source, web, parent } });
      S.readings ||= {}; S.readings[info.key] = info;
      if (!(S.allChats || []).some(c => c.key === info.key)) (S.allChats ||= []).unshift({key: info.key, title: info.title, reading: true, turns: 0, last_at: new Date().toISOString()});
      if (typeof stOpen === 'function' && S.view === 'stage') {
        const sourceNode = ST.nodes.find(n => n.type === 'win' && n.key === parent);
        const n = stOpen(info.key, { win: sourceNode?.id, branchFrom: parent });
        if (n) {
          n.from = parent; n.readingKey = info.key; n.readingSource = info.source; n.branchKey = info.key; n.title = info.title;
          n.el?.classList.add('streading');
          (ST.stageOpen ||= new Set()).add(n.id); stSave(); stShow(n.id);
        }
      } else {
        if (S.chat && !S.readings?.[S.chat]) READING_PARENT_DRAFTS.set(S.chat, document.querySelector('#chatText')?.value || S.chatDraft || '');
        S.chat = info.key; S.imp = null; S.lineView = null; S.treeItem = null;
        history.replaceState(null,'',qs()); await loadChat(info.key);
      }
      return info;
    } catch (err) { toast(err.message + '；资料未打开，可重试'); }
    finally { READING_OPEN.delete(token); }
  })();
  READING_OPEN.set(token, work); return work;
}
window.readingOpen = readingOpen;
function readingPDFViewKey(uid, key) { return JSON.stringify(['pga:pdf-parallel',uid,key]); }
function readingRememberPDFView(uid, key, enabled) {
  try {
    const storageKey=readingPDFViewKey(uid,key);
    if(enabled)localStorage.setItem(storageKey,'1');
    else localStorage.removeItem(storageKey);
  } catch {}
}
// File-panel requests can arrive before the reader iframe has loaded.
async function readingOpenPDFTranslation(source, origin, uid) {
  const info=await readingOpen(source,false,origin,uid);
  if(!info)return;
  readingRememberPDFView(uid,info.key,true);
  const node=S.view==='stage'?ST.nodes.find(n=>n.key===info.key):null;
  const win=node?.el?.querySelector('iframe')?.contentWindow || window;
  if(!win.readingActivatePDFTranslation?.(info.key))
    (window.readingPendingPDFTranslations ||= new Set()).add(info.key);
}
function readingActivatePDFTranslation(key) {
  const r=READING;
  if(!r || r.dead || r.info.key!==key || r.slides || !(r.pdfCanvases || r.pdfFlow))return false;
  if(!r.translationOn)readingPDFParallelToggle(r);
  return true;
}


function readingAnnotationKey(info){return `pga:reading-annotations:${info.uid||S.uid}:${info.source||info.key}`;}
function readingAnnotationLoad(info){try{const a=JSON.parse(localStorage.getItem(readingAnnotationKey(info))||'[]');return Array.isArray(a)?a.slice(-500):[];}catch{return[];}}
function readingAnnotationSave(r){try{localStorage.setItem(readingAnnotationKey(r.info),JSON.stringify(r.annotations.slice(-500)));return true;}catch{return false;}}
function readingAnnotationAdd(r,id,kind){
  if(!r.annotationMode){r.status.textContent='先开启标注笔，再选择高亮或划线';return;}
  const block=r.blocks.find(b=>b.id===id);if(!block){r.status.textContent='请在译文或 PDF 原文中选中一个段落';return;}
  const previous=r.annotations;
  const page=block.page||r.page||0;
  r.annotations=r.annotations.filter(a=>!(a.page===page&&a.id===id));r.annotations.push({page,id,kind,text:block.text.slice(0,1200)});
  if(!readingAnnotationSave(r)){r.annotations=previous;r.status.textContent='本地存储不足，标注未保存';return;}
  readingAnnotationApply(r);r.status.textContent=`已保存「${kind==='highlight'?'高亮':'划线'}」标注（仅此浏览器）`;
}
function readingAnnotationClear(r){
  const previous=r.annotations;
  r.annotations=r.annotations.filter(a=>a.page!==(r.page||0));
  if(!readingAnnotationSave(r)){r.annotations=previous;r.status.textContent='本地存储不可用，标注未清除';return;}
  readingAnnotationApply(r);r.status.textContent='本页本地标注已清除';
}
function readingAnnotationApply(r){
  for(const b of r.blocks)for(const node of [b.row,b.sourceNode,b.output])node?.classList.remove('reading-mark-highlight','reading-mark-underline');
  if(r.pdfParagraphs)for(const span of r.original.querySelectorAll('.textLayer .reading-mark-highlight,.textLayer .reading-mark-underline'))span.classList.remove('reading-mark-highlight','reading-mark-underline');
  r.pdfPage?.querySelectorAll('.reading-pdf-annotation').forEach(n=>n.remove());
  for(const mark of r.annotations||[]){const b=r.blocks.find(x=>(x.page||r.page||0)===mark.page&&(x.id===mark.id||x.legacyId===mark.id)&&(!mark.text||x.text.slice(0,1200)===mark.text));if(!b)continue;
    for(const node of [b.row,b.sourceNode,b.output])node?.classList.add(mark.kind==='underline'?'reading-mark-underline':'reading-mark-highlight');
    if(r.pdfParagraphs){
      for(const span of r.original.querySelectorAll('.textLayer [data-reading-block="'+b.id+'"]'))span.classList.add(mark.kind==='underline'?'reading-mark-underline':'reading-mark-highlight');
    }
    if(!r.pdfParagraphs&&r.pdf&&b.bounds&&r.pdfPage&&(!b.page||b.page===r.page)){const overlay=readerElement('div',`reading-pdf-annotation ${mark.kind==='underline'?'is-underline':'is-highlight'}`);for(const [key,value]of Object.entries({left:b.bounds.x,top:b.bounds.y,width:b.bounds.width,height:b.bounds.height}))overlay.style[key]=value*r.pdfScale+'px';r.pdfPage.append(overlay);}
  }
  if(r.pdf&&r.pdfOriginalMode===false)readingSlideAnnotations(r);
}
function readingZoomLoad(info){try{const n=Number(localStorage.getItem(`pga:reading-zoom:${info.uid||S.uid}:${info.source||info.key}`));return Number.isFinite(n)&&n>=.6&&n<=2.5?n:1;}catch{return 1;}}
function readingPDFWheelZoom(r, e) {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.grid.clientHeight : 1;
  const pixels = e.deltaY * unit;
  if (!Number.isFinite(pixels) || !pixels) return;
  // Keep fractional motion from precision trackpads. Limit coarse wheel events to three points.
  const delta = -Math.max(-120, Math.min(120, pixels)) / 4000;
  const target = Math.max(.6, Math.min(2.5, (r.wheelZoomTarget ?? r.zoom) + delta));
  if (Math.round(target * 100) !== Math.round(r.zoom * 100)) readingZoomSet(r, target);
  r.wheelZoomTarget = target;
}
function readingSchedulePDFZoom(r){if(r.zoomTimer!=null)return;r.zoomTimer=setTimeout(()=>{r.zoomTimer=null;if(!r.dead&&r.pdf&&r.page)readingPDFPage(r,r.page,true,true);},100);}
function readingZoomSet(r,value){r.wheelZoomTarget=null;r.zoom=Math.max(.6,Math.min(2.5,Math.round(value*100)/100));try{localStorage.setItem(`pga:reading-zoom:${r.info.uid||S.uid}:${r.info.source||r.info.key}`,String(r.zoom));}catch{}if(r.zoomLabel)r.zoomLabel.textContent=`${Math.round(r.zoom*100)}%`;if(r.pdfZoom){let option=[...r.pdfZoom.options].find(o=>Number(o.value)===r.zoom);if(!option){option=readerElement('option','',`自定义 ${Math.round(r.zoom*100)}%`);option.value=String(r.zoom);r.pdfZoom.append(option);}r.pdfZoom.value=String(r.zoom);}if(r.pdf&&r.page)readingSchedulePDFZoom(r);else if(!r.native){r.original.style.zoom=String(r.zoom);r.rows.style.zoom=String(r.zoom);}else{r.rows.style.zoom=String(r.zoom);r.status.textContent='已缩放译文；桌面原网页层保持原尺寸';}}

// Reading identity is independent of its source chat. Repair old snapshots in which
// branchKey was the parent, using authoritative source metadata, never title alone.
function readingRepairNode(n) {
  const records=[...Object.values(S.readings||{}),...(S.allChats||[]).map(c=>c.reading_info)].filter(Boolean);
  let info=records.find(d=>d.key===(n.readingKey||n.key));
  if(!info&&!n.readingKey&&n.branchKey&&(n.branchKey===n.from||n.branchKey===n.branchFrom)){
    const matches=d=>{let initial;try{initial=new URL(d.source).hostname;}catch{initial=String(d.source||'').split('/').pop();}return d.title===n.title||d.source===n.readingSource||(n.title&&initial===n.title);};
    const candidates=[...new Map(records.filter(d=>d.parent===(n.branchFrom||n.from)&&matches(d)).map(d=>[d.key,d])).values()];
    if(candidates.length===1)info=candidates[0];
  }
  if(info){n.readingKey=info.key;n.readingSource=info.source;n.from=info.parent;n.title=info.title||n.title;}
  if(n.readingKey){n.key=n.branchKey=n.readingKey;n.el?.classList.add('streading');}
}

function readingPDFChrome(r, enabled) {
  if (!!r.compactPDF === enabled) return;
  r.compactPDF=enabled;
  r.root.classList.toggle('reading-full-pdf',enabled);
  const frame=window.frameElement;
  frame?.classList.toggle('reading-full-pdf',enabled);
  if(enabled){
    r.tools.prepend(r.translationBar);
    r.controls.ontoggle=()=>frame?.classList.toggle('reading-options-open',r.controls.open);
    r.controls.ontoggle();
  }else{
    if(frame)window.top.stPDFReaderZoom?.(frame,1,false);
    r.controls.ontoggle=null;
    frame?.classList.remove('reading-options-open');
    r.readerBody.before(r.translationBar);
  }
}

function readingLeave(key) {
  const r = READING;
  if (!r || r.info.key === key) return;
  readingPDFChrome(r,false);
  readingSave(r, true); r.dead = true; clearTimeout(r.saveTimer); clearTimeout(r.scrollTimer);clearTimeout(r.zoomTimer);
  r.controller.abort(); r.translateController?.abort(); readingSlidesDispose(r);r.pdfTask?.destroy(); r.pdfRender?.cancel();
  r.observer?.disconnect(); r.resize?.disconnect(); r.pdfFlowObserver?.disconnect();readingPDFContinuousDispose(r); r.popup?.remove(); r.selectionMenu?.remove();
  r.themeObserver?.disconnect();r.layoutResize?.disconnect();document.documentElement.classList.remove('reading-page','reading-chat-open');
  window.top.document.removeEventListener('scroll',r.viewportChanged,true);
  window.removeEventListener('resize',r.viewportChanged);
  window.top.readingNativeRemove?.(r.nativeId); READING = null;
  if(r.composerHome?.isConnected)r.composerHome.replaceWith(document.querySelector('#ccomp'));
  document.querySelector('#cdlg')?.classList.remove('reading-dialog');
  document.querySelector('#ccomp')?.classList.remove('reading-composer');
  document.querySelector('#ccomp')?.replaceChildren();
  S.chatDraft = READING_PARENT_DRAFTS.get(key) || '';
}
function readingRender(info) {
  let r = READING;
  if (r?.info.key === info.key && !r.dead && r.root.isConnected) { readingHistory(r); return; }
  if (r) readingLeave(null);
  r = READING = { info, state: {...info.state}, dead: false, blocks: [], generation: 0, cache: new Map(), syncingUntil: 0,
    target: localStorage.getItem('pga_reading_target') === 'zh-CN' ? 'zh-CN' : 'en', controller: new AbortController(), nativeId: 'reading:' + crypto.randomUUID(), zoom: readingZoomLoad(info), annotations: readingAnnotationLoad(info), annotationMode:false };
  const head = document.querySelector('#chead');
  document.documentElement.classList.add('reading-page');
  try {const host=window.top.ST?.nodes.find(n=>n.el?.querySelector('iframe')?.contentWindow===window);if(host){host.readingKey=host.branchKey=host.key=info.key;host.readingSource=info.source;host.el.classList.add('streading');window.top.stSave?.();}} catch {}
  head.innerHTML = `<span class="kind">资料会话</span><h1>${esc(info.title || '阅读资料')}</h1>` + headActs();
  const dialog = document.querySelector('#cdlg'); dialog.classList.add('reading-dialog');
  const root = r.root = readerElement('section', 'reading-workspace');
  const tools = r.tools = readerElement('div', 'reading-tools');
  r.controls=readerElement('details','reading-controls');
  const toggle=readerElement('summary','','⋯');toggle.setAttribute('aria-label','阅读选项');
  r.controls.append(toggle,tools);
  tools.append(readerButton('问答',()=>readingChatSet(r,!document.documentElement.classList.contains('reading-chat-open'))));
  tools.append(readerButton('← 来源对话', () => pjGo(info.parent)), readerElement('span', 'reading-format', '段落下方显示译文'));
  tools.append(readerButton('打开原件 ↗', () => {
    if (info.web) window.open(info.source, '_blank', 'noopener');
    else if (r.documentURL) window.open(r.documentURL, '_blank', 'noopener');
  }), readerButton('重新载入', () => readingLoad(r)));
  r.downloadButton=readerButton('下载原文件',()=>readingFileAction(r,'download'));
  r.revealButton=readerButton('在文件夹中显示',()=>readingFileAction(r,'reveal'));
  tools.append(r.downloadButton,r.revealButton);readingFileActionsSync(r);
  r.markToggle=readerButton('✎ 标注笔：关',()=>{r.annotationMode=!r.annotationMode;r.markToggle.textContent=r.annotationMode?'✎ 标注笔：开':'✎ 标注笔：关';r.markToggle.setAttribute('aria-pressed',String(r.annotationMode));});
  r.markToggle.title='先开启标注笔，再选中段落并选择高亮或划线；Esc 退出';
  r.zoomLabel=readerButton(`${Math.round(r.zoom*100)}%`,()=>readingZoomSet(r,1));r.zoomLabel.title='缩放重置为100%';
  tools.append(r.markToggle,readerButton('−',()=>readingZoomSet(r,r.zoom*.9)),r.zoomLabel,readerButton('+',()=>readingZoomSet(r,r.zoom*1.1)));
  tools.append(readerButton('清除本页标注',()=>readingAnnotationClear(r)));
  const language = readerElement('select'); language.setAttribute('aria-label','翻译语言');
  for (const [value,label] of [['en','英文'],['zh-CN','中文']]) { const o=readerElement('option','',label);o.value=value;language.append(o); }
  language.value=r.target; language.onchange=()=>{
    r.target=language.value;localStorage.setItem('pga_reading_target',r.target);r.cache.clear();
    if(r.pdf&&!r.slides){readingPDFResetLanguage(r);return;}
    if(r.native)window.top.readingNativeCommand?.(r.nativeId,'readClearTranslations');
    readingBlocks(r,r.blocks.map(b=>({id:b.id,text:b.text,bounds:b.bounds,style:b.style,indices:b.indices,tag:b.tag,sourceNode:b.sourceNode,page:b.page,legacyId:b.legacyId})));
  };
  const grid = r.grid = readerElement('div', 'reading-grid');
  r.original = readerElement('section', 'reading-original'); r.original.setAttribute('aria-label', '原始网页或 PDF');
  r.translations = readerElement('section', 'reading-translations'); r.translations.setAttribute('aria-label', '中文译文');
  r.translateButton = readerButton('翻译', () => readingToggleTranslation(r));
  r.sync = readerButton('联动：开', () => { r.syncOff = !r.syncOff; r.sync.textContent = r.syncOff ? '联动：关' : '联动：开'; });
  r.rows = readerElement('div', 'reading-rows');
  const translationBar = r.translationBar = readerElement('div','reading-translation-bar');
  r.progress = readerElement('span','reading-progress','等待载入正文…'); r.progress.setAttribute('role','status');
  if (info.web && !readingPDFSource(info.source)) {
    function historyButton(icon, label, direction) {
      const button = readerButton(icon, () => {
        if (r.native) window.top.readingNativeCommand(r.nativeId, direction);
        else {
          try { r.original.querySelector('.reading-web-frame')?.contentWindow.navigation?.[direction](); }
          catch { /* The iframe may have navigated cross-origin since the last update. */ }
        }
      });
      button.title = label;
      button.setAttribute('aria-label', label);
      button.disabled = true;
      return button;
    }
    r.webBack = historyButton('←', '返回上一网页', 'back');
    r.webForward = historyButton('→', '前进到下一网页', 'forward');
    const reload = readerButton('↻', () => {
      if (r.native) window.top.readingNativeCommand(r.nativeId, 'reload');
      else {
        const frame = r.original.querySelector('.reading-web-frame');
        try { if (frame?.contentWindow) { frame.contentWindow.location.reload(); return; } }
        catch { /* Cross-origin frames only expose their originally assigned URL. */ }
        readingLoad(r);
      }
    });
    reload.title = '刷新网页';
    reload.setAttribute('aria-label', reload.title);
    translationBar.append(r.webBack, r.webForward, reload);
  }
  r.service = readerServiceSelect(S.uid, () => { if (r.translationOn) readingRetry(r); });
  translationBar.append(r.translateButton);tools.append(language,r.service,r.progress); tools.append(r.sync);r.translations.append(r.rows); grid.append(r.original, r.translations);
  r.status = readerElement('div', 'reading-status'); r.status.setAttribute('role', 'status');
  r.history = readerElement('details', 'reading-history'); r.history.open = false;
  r.historyLabel = readerElement('summary', '', '本资料的问答'); r.log = readerElement('div', 'reading-log');
  r.history.append(r.historyLabel, r.log); tools.append(r.status);r.readerBody=readerElement('div','reading-body');r.readerBody.append(grid);root.append(r.controls, translationBar, r.readerBody, r.history);
  r.grid.addEventListener('pointerup', e => readingPDFMatch(r,e.target));
  r.grid.addEventListener('focusin', e => readingPDFMatch(r,e.target));
  r.grid.addEventListener('keyup', e => {if(e.key==='Shift')readingPDFMatch(r,window.getSelection()?.anchorNode?.parentElement);});
  r.grid.addEventListener('wheel',e=>{if(!e.ctrlKey||e.metaKey||e.shiftKey)return;e.preventDefault();e.stopPropagation();if(r.pdf)readingPDFWheelZoom(r,e);else readingZoomSet(r,r.zoom*(e.deltaY<0?1.1:.9));},{capture:true,passive:false});
  r.controls.addEventListener('keydown',e=>{if(e.key==='Escape'){r.controls.open=false;toggle.focus();}});
  r.root.addEventListener('keydown',e=>{if(e.key==='Escape'&&(r.annotationMode||r.selectionMenu?.isConnected)){e.stopPropagation();r.annotationMode=false;r.markToggle.textContent='✎ 标注笔：关';r.markToggle.setAttribute('aria-pressed','false');r.selectionMenu?.remove();}});
  root.addEventListener('pointerdown',e=>{
    if(r.pdfNote && !r.pdfNote.contains(e.target))readingPDFCloseNote(r);
    if(!r.controls.contains(e.target))r.controls.open=false;
    if(!r.selectionMenu?.contains(e.target))r.selectionMenu?.remove();
  });
  document.addEventListener('selectionchange',()=>{
    if(getSelection()?.isCollapsed)r.selectionMenu?.remove();
  },{signal:r.controller.signal});
  document.querySelector('#cdlgIn').replaceChildren(root);
  const composer = document.querySelector('#ccomp'); composer.classList.add('reading-composer');
  composer.innerHTML = `<div class="reading-reference" hidden></div><div class="cbar"><textarea id="chatText" maxlength="2000" aria-label="向 AI 提问" placeholder="问这份资料… 选中原文或译文可就地提问"></textarea><button id="chatSend" class="primary">发送</button></div>`;
  r.chatButton=readerButton('对话',()=>readingChatSet(r,!document.documentElement.classList.contains('reading-chat-open')),'reading-chat-button');
  r.chatButton.title='与这份 PDF 对话';r.chatButton.setAttribute('aria-label','打开 PDF 对话');r.chatButton.setAttribute('aria-expanded','false');
  r.chatButton.hidden=!readingPDFSource(info.source);translationBar.append(r.chatButton);
  r.input = document.querySelector('#chatText'); r.input.value = r.state.draft || '';
  r.input.addEventListener('input', () => { r.state.draft = r.input.value; readingScheduleSave(r); });
  r.quote = composer.querySelector('.reading-reference');
  r.selection = r.state.selection || null; readingQuote(r);
  r.original.addEventListener('mouseup', e => readingSelection(r, e));
  r.rows.addEventListener('mouseup', e => readingSelection(r, e));
  r.original.addEventListener('keyup', e => { if (e.key === 'Shift') readingSelection(r, e); });
  r.rows.addEventListener('keyup', e => { if (e.key === 'Shift') readingSelection(r, e); });
  r.rows.addEventListener('scroll', () => {
    if(r.pdf&&!r.slides){
      if(r.translationOn&&r.pdfOriginalMode&&!r.inline)readingPDFSyncScroll(r,r.rows,r.original);
      return;
    }
    clearTimeout(r.scrollTimer); r.scrollTimer = setTimeout(() => {
      if (r.translationOn) readingTranslate(r);
      if (r.syncingUntil > Date.now() || r.syncOff) return;
      if(r.layout){readingScrollSource(r);return;}
      const box = r.rows.getBoundingClientRect();
      const block = r.blocks.find(b => b.row.getBoundingClientRect().bottom > box.top + 10);
      if (block) readingLocate(r, block.id, false);
    }, 100);
  }, {passive: true});
  readingHistory(r); readingLoad(r);
  try{if(localStorage.getItem('pga_reading_chat:'+S.uid+':'+r.info.key)==='open')readingChatSet(r,true);}catch{}
  r.viewportChanged=()=>{if(r.pdfFlow&&!r.pdfOriginalMode)readingPDFVisible(r);if(r.translationOn)readingTranslate(r);};
  window.top.document.addEventListener('scroll',r.viewportChanged,true);window.addEventListener('resize',r.viewportChanged);
  r.observer=new IntersectionObserver(entries=>{if(entries[0]?.isIntersecting)r.viewportChanged();});r.observer.observe(r.root);
  r.themeObserver=new MutationObserver(()=>readingTheme(r));r.themeObserver.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme','data-skin','data-palette','style']});readingTheme(r);
  r.layoutResize=new ResizeObserver(()=>{if(r.layout)readingAlign(r);});r.layoutResize.observe(r.rows);
}
function readingHistory(r) {
  const turns = S.chatTurns[r.info.key] || [];
  const signature = JSON.stringify(turns);
  if (signature === r.historySignature) return;
  r.historySignature = signature; r.log.replaceChildren();
  for (const turn of turns) {
    const item = readerElement('div', 'reading-turn');
    const ref = turn.reader_reference;
    if (ref && (ref.selection || ref.page || ref.anchor)) {
      const cite = readerButton((ref.page ? `第 ${ref.page} 页` : '原文引用') + ' ↗', async () => {
        if (ref.page && r.pdf && ref.page !== r.page) await readingPDFPage(r, ref.page);
        readingLocate(r, ref.anchor, true);
      });
      cite.className = 'reading-citation'; item.append(cite);
      if (ref.selection) item.append(readerElement('blockquote', '', ref.selection));
    }
    const message = readerElement('div');
    message.innerHTML = PGATree.chat([{agent: turn.role === 'user' ? 'you' : 'AI', kind: turn.role === 'user' ? 'question' : 'answer',
      text: turn.reader_question || turn.text || '', at: turn.at, data:{}}], {md, name: x => x.agent});
    item.append(message); r.log.append(item);
  }
  if(!turns.length)r.log.append(readerElement('p','reading-chat-empty','可以问这份文件，也可以提出其他问题。选中文本后提问，会附上对应引用。'));
  r.historyLabel.textContent = `本资料的问答 · ${turns.filter(t => t.role === 'user').length}`;
}
// PDF endpoints often have no .pdf suffix (arXiv and OpenReview).
function readingFileActionsSync(r) {
  const kind=r.content?.kind,source=r.info.source||'';
  const file=!r.info.web||['file','document','slides','sheet','text','image','external'].includes(kind)||readingPDFSource(source)||/\.(docx?|rtf|odt|pptx?|odp|xlsx?|xlsm|ods|csv|tsv)(?:$|[?#])/i.test(source);
  if(r.downloadButton)r.downloadButton.hidden=!file;
  if(r.revealButton)r.revealButton.hidden=!file;
}
async function readingFileAction(r,action) {
  if(r.dead||r.fileActionPending)return;
  r.fileActionPending=true;r.downloadButton.disabled=r.revealButton.disabled=true;
  r.status.textContent=action==='download'?'正在准备原文件下载…':'正在定位原文件…';
  try {
    const info=await api(`/v1/users/${S.uid}/reading/${encodeURIComponent(r.info.key)}/file-actions`,{signal:r.controller.signal});
    if(r.dead)return;
    const ok=action==='download'?await window.top.fpDownload(info,S.uid,r.info.key):await window.top.fpReveal(info,S.uid,r.info.key);
    if(ok)r.status.textContent=action==='download'?'已请求下载原文件':r.info.web?'已在文件夹中显示下载的原文件':'已在文件夹中显示原文件';
    else r.status.textContent='文件操作未完成，请查看提示后重试';
  }catch(err){if(!r.dead)r.status.textContent='文件操作失败：'+err.message;}
  finally{r.fileActionPending=false;r.downloadButton.disabled=r.revealButton.disabled=false;}
}
function readingPDFSource(source) {
  if (/\.pdf(?:$|[?#])/i.test(source)) return true;
  try {
    const url=new URL(source);
    return /^https?:$/.test(url.protocol)&&/(^|\.)(arxiv\.org|openreview\.net)$/i.test(url.hostname)&&/^\/pdf(?:\/|$)/i.test(url.pathname);
  } catch { return false; }
}
async function readingLoad(r) {
  if (r.loading || r.dead) return;
  r.loading = true; r.status.textContent = '正在载入原件…';r.progress.textContent=r.status.textContent;
  let pdfSource=readingPDFSource(r.info.source), directError=null;
  try {
    // CORS-enabled PDF servers can feed PDF.js directly, avoiding the article fetch size cap.
    if(r.info.web && pdfSource) {
      try {r.documentURL=r.info.source;await readingPDF(r,r.documentURL);return;}
      catch(err){if(r.dead)return;directError=err;}
    }
    let info = await api(`/v1/users/${S.uid}/reading/${encodeURIComponent(r.info.key)}/content`, {signal:r.controller.signal});
    if (r.dead) return;
    if (info.kind === 'file' && info.file) info = info.file;
    r.content = info;
    readingFileActionsSync(r);
    if (info.title) {
      r.info.title = info.title; r.state.title = info.title;
      document.querySelector('#chead h1').textContent = info.title; readingScheduleSave(r);
    }
    if (info.kind === 'document' || info.kind === 'slides' || pdfSource) {
      pdfSource=true;
      r.documentURL = info.url || info.url_view;
      if (/\.(docx?|odt|rtf)(?:$|[?#])/i.test(info.path || r.info.source)) {
        const response=await fetch(info.url,{signal:r.controller.signal});
        if(!response.ok)throw Error('文档文字预览载入失败，请重新载入');
        readingWeb(r,{html:await response.text(),local:true});
        r.status.textContent='译文显示在每个原段落下方；原始版式可打开原件查看';return;
      }
      const url = info.pdf_url || info.url_view || info.url;
      if (!url) throw Error('此文档暂时没有 PDF 版式预览，请安装 LibreOffice 后重试');
      r.documentURL = url; await readingPDF(r, url); return;
    }
    if (info.kind === 'sheet' && info.url) {
      const response=await fetch(info.url,{signal:r.controller.signal});
      if(!response.ok)throw Error('表格预览载入失败，请重新载入');
      readingWeb(r,{html:await response.text(),local:true});return;
    }
    if (info.kind === 'text') {
      const html=info.markdown ? md(info.text||'') : String(info.text||'').split(/\n\s*\n/).map(t=>'<p>'+esc(t)+'</p>').join('');
      readingWeb(r,{html,local:true});return;
    }
    if (info.kind !== 'web') throw Error('这份资料暂不支持双语阅读，请使用原件预览');
    readingWeb(r, info);
  } catch (err) {
    if (r.dead) return;
    // The desktop can still read authenticated/dynamic sites when public extraction fails.
    if (r.info.web && !pdfSource && window.top.PGA_NATIVE?.readingBrowser) readingWeb(r, {html:'', frameable:false});
    else {
      const message=pdfSource?'PDF 文字读取失败：'+err.message+'；请重新载入，或下载后在 PGA 打开本地 PDF':err.message;
      r.status.textContent=message;if(r.progress){r.progress.textContent=message;r.progress.title=directError?.message||message;}
    }
  } finally { r.loading = false; }
}
function readingWeb(r, info) {
  readingPDFChrome(r,false);
  readingSlidesDispose(r);r.slides=false;r.pdfParagraphs=false;
  if(r.pdfProgress){
    r.pdfProgress.remove();r.pdfRetry.remove();r.pdfProgress=r.pdfRetry=null;
    r.translationOn=false;r.translateButton.removeAttribute('aria-expanded');r.root.classList.remove('translation-enabled');
  }
  r.pdfFlowObserver?.disconnect();readingPDFContinuousDispose(r);r.resize?.disconnect();r.pdfTools?.remove();r.grid.classList.remove('reading-pdf-parallel');r.pdf=null;r.pdfPage=null;r.pdfPixels=null;r.pdfFlow=null;
  r.original.classList.remove('reading-pdf');
  r.original.replaceChildren(); r.inline=true; r.layout=null;
  r.grid.classList.add('reading-inline'); r.sync.hidden=true;
  if (!info.local && window.top.PGA_NATIVE?.readingBrowser && window.top.readingNativeAdd) {
    const wasNative=r.native; r.native=true; r.visibleIds=[];
    r.original.append(readerElement('p','reading-source-hint','正在载入原始网页…'));
    window.top.readingNativeAdd(r,window);
    if(wasNative)window.top.readingNativeCommand?.(r.nativeId,'reload');
    r.status.textContent='原网页逐段翻译 · 译文显示在每段下方';
  } else if(!info.local) {
    window.top.readingNativeRemove?.(r.nativeId);r.native=false;r.webFrame=true;
    const frame=readerElement('iframe','reading-web-frame');frame.src=r.info.source;frame.title=r.info.title||'原网页';
    frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-forms allow-popups');frame.referrerPolicy='no-referrer';
    if (r.webBack) r.webBack.disabled = r.webForward.disabled = true;
    frame.addEventListener('load', () => {
      if (!r.webBack || !frame.isConnected) return;
      try {
        frame.contentDocument?.addEventListener('click', e => {
          if (e.button !== 0 || (e.detail !== 2 && e.detail !== 3) || e.target.closest(ST_DBL_SKIP) || frame.contentWindow.getSelection()?.toString()) return;
          const host = window.top;
          const node = host.ST?.nodes.find(n => n.el?.querySelector('iframe')?.contentWindow === window);
          if (host.S?.view === 'stage' && node) host.stClickSize(node, e);
        }, true);
        const nav = frame.contentWindow.navigation;
        const sync = () => { if (frame.isConnected) {
          r.webBack.disabled = !nav?.canGoBack;
          r.webForward.disabled = !nav?.canGoForward;
        } };
        nav?.addEventListener('currententrychange', sync);
        sync();
      } catch { r.webBack.disabled = r.webForward.disabled = true; }
    });
    if(info.frameable!==false)r.original.append(frame);
    else r.original.append(readerElement('p','reading-source-hint','原站不允许内嵌，请使用 PGA 桌面端或打开原件。'));
    r.translateButton.disabled=true;r.translateButton.title='原网页翻译需要 PGA 桌面端';
  } else {
    window.top.readingNativeRemove?.(r.nativeId);r.native=false;
    const article=readerElement('article','reading-inline-article');
    article.innerHTML=DOMPurify.sanitize(info.html||'',{USE_PROFILES:{html:true,mathMl:true}});
    // Use an inert, sanitized article when browser same-origin restrictions prevent injection.
    article.querySelectorAll('a[href]').forEach(a=>{try{a.href=new URL(a.getAttribute('href'),r.info.source).href;}catch{a.removeAttribute('href');}});
    r.original.append(article);
    const nodes=[...article.querySelectorAll('h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,td,th')].filter(n=>!n.querySelector('p,li,pre,td,th')&&!n.closest('pre,code,script,style'));
    const blocks=[];
    for(const node of nodes){const text=readerText(node).trim();for(let start=0;start<text.length&&blocks.length<500;start+=2800)blocks.push({id:'p'+blocks.length,text:text.slice(start,start+2800),sourceNode:node});}
    readingBlocks(r,blocks);
    r.original.onscroll=()=>{r.state.ratio=r.original.scrollTop/Math.max(1,r.original.scrollHeight-r.original.clientHeight);readingScheduleSave(r);readingTranslate(r);};
    r.original.scrollTop=(r.state.ratio||0)*Math.max(0,r.original.scrollHeight-r.original.clientHeight);
    r.status.textContent='正文逐段翻译；原站排版与交互请使用新版 PGA 桌面端。';
  }
}
function readingCacheKey(r,text){return r.target+'\n'+text;}
function readingPushTranslations(r){
  if(!r.native||!r.inline||!r.translationOn)return;
  const blocks=r.blocks.filter(b=>b.done).map(b=>({id:b.id,source:b.text,text:b.output.textContent}));
  // Bound native bridge payloads, just like model requests.
  for(let i=0;i<blocks.length;i+=6)window.top.readingNativeCommand?.(r.nativeId,'readTranslations',{target:r.target,blocks:blocks.slice(i,i+6)});
}
function readingBlocks(r, blocks, append=false) {
  if(!append){r.translateController?.abort(); r.translateController = null; r.generation++;}
  if(!r.pdf&&!r.native){r.original.style.zoom=String(r.zoom||1);r.rows.style.zoom=String(r.zoom||1);}
  const added = blocks.filter(b => b.text?.trim()).slice(0,r.pdf?blocks.length:500).map((b,i) => ({...b, id:/^p\d+$/.test(b.id) ? b.id : 'p'+i, text:b.text.slice(0,3000)}));
  if(append)r.blocks.push(...added);else r.blocks=added;
  if(!append)r.rows.replaceChildren();
  if(!append&&r.inline&&!r.native)r.original.querySelectorAll('.reading-inline-output,.reading-translation-retry').forEach(n=>n.remove());
  for (const block of added) {
    block.row = readerElement('article', 'reading-block'); block.row.dataset.readingBlock = block.id;
    block.row.tabIndex = 0;
    block.row.setAttribute('aria-label','译文；选择文字可问 AI，按 Enter 引用本段');
    block.row.onkeydown=e=>{if(e.key==='Enter'&&e.target===block.row){e.preventDefault();readingAskPopup(r,{text:block.output.textContent,id:block.id,page:block.page||r.page},block.row.getBoundingClientRect());}};
    if (r.pdf && !r.slides) {
      const cached=block.sourceOnly?block.text:r.cache.get(readingCacheKey(r,block.text));
      block.done=cached!==undefined;
      block.output=readerElement('div','reading-translation',cached ?? ((block.sourceNode||r.pdfOnPage||r.pdfParagraphs)?'':block.text));
      block.output.lang=r.target;
      if(block.sourceNode){
        block.sourceNode.dataset.readingBlock=block.id;
        block.output.dataset.readingBlock=block.id;
        block.output.classList.add('reading-inline-output');
        block.sourceNode.after(block.output);
      }else block.row.append(block.output);
      continue;
    }
    const original = readerElement('details', 'reading-source-text'); original.append(readerElement('summary','','原文'), readerElement('div','',block.text));
    block.output = readerElement('div','reading-translation',r.cache.get(readingCacheKey(r,block.text)) || (r.inline ? '' : block.text));
    block.done = r.cache.has(readingCacheKey(r,block.text));
    const actions = readerElement('div','reading-block-actions');
    block.locate=readerButton('定位原文', () => readingLocate(r,block.id,true));
    actions.append(block.locate, readerButton('问 AI', () => readingAskPopup(r,{text:block.text,id:block.id,page:block.page||r.page},block.row.getBoundingClientRect())));
    block.row.append(original, block.output, actions); r.rows.append(block.row);
    if(r.inline&&block.sourceNode){
      const node=block.sourceNode;node.dataset.readingBlock=block.id;
      block.output.classList.add('reading-inline-output');block.output.dataset.readingBlock=block.id;block.output.lang=r.target;
      const previous=r.blocks[r.blocks.indexOf(block)-1];
      if(previous?.sourceNode===node)previous.output.after(block.output);
      else if(node.matches('li,td,th'))node.append(block.output);else node.after(block.output);
    }
  }
  if (!r.blocks.length && !(r.pdf&&!r.slides)) r.rows.append(readerElement('p','reading-empty',r.pdf ? '本页未检测到可选文字，可能是扫描页；原页仍可阅读。' : '暂未提取到正文。可在原网页载入后重试。'));
  readingAnnotationApply(r);readingProgress(r);readingPushTranslations(r);if(r.layout&&!r.inline)readingAlign(r); requestAnimationFrame(() => {
    const saved=r.blocks.find(b=>b.id===r.state.anchor);
    if(!append&&saved&&!r.layout&&!r.inline)r.rows.scrollTop+=saved.row.getBoundingClientRect().top-r.rows.getBoundingClientRect().top-8;
    readingTranslate(r);
  });
  return added;
}
function readingProgress(r) {
  const eligible=r.blocks.filter(b=>!b.sourceOnly);
  const done=eligible.filter(b=>b.done).length,failed=eligible.filter(b=>b.failed).length;
  const pending=r.blocks.some(b=>b.output.dataset.pending);
  const unchanged=eligible.filter(b=>b.done&&b.output.textContent.trim()===b.text.trim()).length;
  const label=r.target==='en'?'英文':'中文';
  r.translations.setAttribute('aria-label',label+'译文');
  r.progress.textContent=r.blocks.length && !eligible.length ? '本页仅保留原文' : eligible.length ? `${pending?'正在翻译为':'译为'}${label} · ${done}/${eligible.length} 段${unchanged?` · ${unchanged} 段与原文相同，可切换语言`:''}${failed?` · ${failed} 段失败：${r.blocks.find(b=>b.failed).error}`:''}` : (r.pdf?'本页无可提取文字，暂不支持扫描件 OCR':'未提取到可翻译正文');
  r.progress.title=r.progress.textContent;
  if(r.pdf&&!r.slides && r.translationOn) readingPDFProgress(r);
  r.translateButton.textContent=r.translationOn?'关闭翻译':r.pdf&&!r.slides?'全文翻译':'翻译';
  r.translateButton.disabled=!!r.webFrame;
}
function readingToggleTranslation(r){
  if(r.webFrame){r.status.textContent='网页内翻译需要 PGA 桌面端；原网页保持原样展示。';return;}
  if(r.pdf&&!r.slides)return readingPDFParallelToggle(r);
  r.translationOn=!r.translationOn;r.generation++;r.translateController?.abort();r.translateController=null;
  r.root.classList.toggle('translation-enabled',r.translationOn);
  if(r.slides){r.inline=!r.translationOn;r.grid.classList.toggle('reading-inline',!r.translationOn);}
  if(r.native&&!r.translationOn)window.top.readingNativeCommand?.(r.nativeId,'readClearTranslations');
  for(const b of r.blocks)delete b.output.dataset.pending;
  readingProgress(r);if(r.translationOn){readingPushTranslations(r);readingRetry(r);}
}
function readingRetry(r, block) {
  for(const b of block?[block]:r.blocks.filter(b=>b.failed)) {
    b.failed=false;b.error='';b.retry?.remove();b.retry=null;
  }
  r.translationOn=true;readingTranslate(r);
}
function readingTranslationError(r,b,message) {
  b.failed=true;b.error=String(message||'翻译失败');delete b.output.dataset.pending;b.row.title=b.error;
  if(!r.native) {
    b.retry?.remove();b.retry=readerButton('翻译失败 · 点击重试',()=>readingRetry(r,b));
    b.retry.className='reading-translation-retry';b.retry.title=b.error;
    b.output.after(b.retry);
  }
}
async function readingTranslate(r) {
  const fullPDF=r.pdf&&!r.slides;
  if (r.dead || r.translateController || !r.translationOn || (!fullPDF && !readingInViewport(r))) return;
  const bounds = (r.inline ? r.original : r.rows).getBoundingClientRect();
  if (!fullPDF && (bounds.height < 1 || document.hidden)) return;
  let chars=0;
  const candidates=fullPDF ? [...(r.pdfTextPages.get(r.page)?.blocks||[]), ...r.blocks.filter(b=>b.page!==r.page)] : r.blocks;
  if(r.pdfNote?.isConnected){
    const index=candidates.findIndex(b=>b.id===r.pdfNote.dataset.readingBlock);
    if(index>0)candidates.unshift(candidates.splice(index,1)[0]);
  }
  const batch = candidates.filter(b => {
    if(r.inline&&r.native)return !b.done&&!b.failed&&(r.visibleIds||[]).includes(b.id);
    if(fullPDF)return !b.sourceOnly&&!b.done&&!b.failed;
    const pos=(r.inline ? b.sourceNode || b.row : b.row).getBoundingClientRect();
    return !b.done && !b.failed && pos.bottom >= bounds.top - 160 && pos.top < bounds.bottom + 260;
  }).filter(b => { if (chars + b.text.length > 6000) return false; chars+=b.text.length; return true; }).slice(0,6);
  if (!batch.length) {
    if(fullPDF)readingPDFNextText(r);
    readingProgress(r);return;
  }
  const ctrl=r.translateController=new AbortController(), gen=r.generation;
  const timeout=setTimeout(() => ctrl.abort(),readerTranslationTimeout(r.service.value));
  batch.forEach(b => {b.output.dataset.pending='true';b.row.title='正在翻译';});readingProgress(r);
  try {
    const result=await readerRequestTranslation(S.uid,r.service.value,r.target,batch.map(b => ({id:b.id,text:b.text})),ctrl.signal);
    if (r.dead || gen !== r.generation) return;
    for (const b of batch) {
      const translated=result.blocks?.find(t => t.id===b.id);
      if (translated?.text && !translated.error) {
        b.output.textContent=translated.text; b.done=true; r.cache.set(readingCacheKey(r,b.text),translated.text);
        delete b.output.dataset.pending;b.error='';b.row.title='';b.retry?.remove();b.retry=null;if(r.layout&&!r.inline)readingFit(b);
        if (r.cache.size>1000) r.cache.delete(r.cache.keys().next().value);
      } else readingTranslationError(r,b,translated?.error || '本段未返回译文');
    }
    readingPushTranslations(r);
  } catch(err) {
    if (!r.dead && gen===r.generation) batch.forEach(b => readingTranslationError(r,b,ctrl.signal.aborted?'翻译超时':err.message));
  } finally {
    clearTimeout(timeout);
    if (r.translateController===ctrl) {
      r.translateController=null;
      if(!r.dead && fullPDF)for(const number of new Set(batch.map(b=>b.page)))readingPDFPaintCopy(r,number);
      if (!r.dead) readingTranslate(r);
    }
  }
}
function readingInViewport(r) {
  if(document.hidden||!r.root.isConnected)return false;
  let box=(r.inline?r.original:r.rows).getBoundingClientRect(),owner=window;
  while(true){
    if(box.width<1||box.height<1||box.right<=0||box.bottom<=0||box.left>=owner.innerWidth||box.top>=owner.innerHeight)return false;
    if(owner===window.top)return true;
    const frame=owner.frameElement;if(!frame||!frame.isConnected)return false;
    const outer=frame.getBoundingClientRect(),sx=outer.width/owner.innerWidth,sy=outer.height/owner.innerHeight;
    const left=outer.left+box.left*sx,top=outer.top+box.top*sy,width=box.width*sx,height=box.height*sy;
    box={left,top,width,height,right:left+width,bottom:top+height};owner=owner.parent;
  }
}
function readingLocate(r,id,alignTranslation) {
  if (!id) return;
  r.state.anchor=id; readingScheduleSave(r); r.syncingUntil=Date.now()+500;
  r.rows.querySelectorAll('.reading-active').forEach(n => n.classList.remove('reading-active'));
  const block=r.blocks.find(b => b.id===id); if (!block) return;
  block.row.classList.add('reading-active');
  if (alignTranslation && !(r.pdf&&!r.slides)) r.rows.scrollTop += block.row.getBoundingClientRect().top - r.rows.getBoundingClientRect().top - 8;
  if (r.native) window.top.readingNativeCommand?.(r.nativeId,'locate',{anchor:id});
  else if (r.pdf) readingPDFLocate(r,block);
  else block.sourceNode?.scrollIntoView({block:'center'});
}
function readingSelection(r,event) {
  if (r.dead || event.target.closest('button,input,textarea')) return;
  const selection=getSelection(), text=selection?.toString().trim();
  if (!text || !selection.rangeCount || text.length>8000) return;
  const node=selection.anchorNode?.parentElement;
  if (!node || (!r.original.contains(node) && !r.rows.contains(node))) return;
  const id=node.closest('[data-reading-block]')?.dataset.readingBlock || r.state.anchor || '';
  const rect=selection.getRangeAt(0).getBoundingClientRect();
  r.selectionMenu?.remove();
  const menu=r.selectionMenu=readerElement('div','reading-selection-menu');
  const page=r.blocks.find(b=>b.id===id)?.page||r.page;
  menu.append(readerButton('问 AI', () => { menu.remove(); readingAskPopup(r,{text,id,page},rect); }),
    readerButton('高亮',()=>{readingAnnotationAdd(r,id,'highlight');menu.remove();}),
    readerButton('划线',()=>{readingAnnotationAdd(r,id,'underline');menu.remove();}));
  menu.setAttribute('role','group');menu.setAttribute('aria-label','选文操作');
  menu.onmousedown=e=>e.preventDefault();
  if(r.pdf&&!r.slides)r.grid.append(menu);
  else{
    menu.style.left=Math.max(8,Math.min(innerWidth-260,rect.left))+'px';
    menu.style.top=Math.max(8,Math.min(innerHeight-44,rect.bottom+5))+'px';
    document.body.append(menu);
  }
}
function readingAskPopup(r,selection,rect) {
  r.popup?.remove(); r.selection=selection; r.state.selection=selection; readingScheduleSave(r);
  const box=r.popup=readerElement('section','reading-ask-popup'); box.setAttribute('role','dialog'); box.setAttribute('aria-label','引用文字提问');
  const heading=readerElement('div','reading-popup-head','问 AI');
  heading.append(readerButton('×',()=>{box.remove();r.popup=null;}));
  const quote=readerElement('blockquote','',selection.text);
  const input=readerElement('textarea'); input.maxLength=2000; input.placeholder='针对这段文字提问…'; input.setAttribute('aria-label','针对选文的问题');
  input.value=r.input.value;
  input.oninput=()=>{r.input.value=input.value;r.state.draft=input.value;readingScheduleSave(r);};
  const actions=readerElement('div','reading-popup-actions');
  actions.append(readerButton('解释这段',()=>{input.value='请结合上下文解释这段内容。';input.oninput();}),readerButton('发送',()=>readingSend(r,input,selection)));
  input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();readingSend(r,input,selection);}};
  box.onkeydown=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();box.remove();r.popup=null;r.input.focus();}};
  box.append(heading,quote,input,actions); document.body.append(box);
  const width=Math.min(360,innerWidth-24); box.style.width=width+'px';
  const x=rect?.left || 12;
  box.style.left=Math.max(12,Math.min(innerWidth-width-12,x))+'px';
  box.style.top=Math.max(12,Math.min(innerHeight-box.offsetHeight-12,rect?.bottom || 120))+'px';
  readingQuote(r);
  input.focus();
}
function readingQuote(r) {
  r.quote.hidden=!r.selection;
  if(r.selection)r.quote.replaceChildren(readerElement('span','',r.selection.text.slice(0,250)),readerButton('取消引用',()=>{r.selection=null;r.state.selection=null;r.quote.hidden=true;readingScheduleSave(r);}));
}
function readingChatSet(r,shown=true){
  if(r.dead)return;
  try{localStorage.setItem('pga_reading_chat:'+S.uid+':'+r.info.key,shown?'open':'closed');}catch{}
  if((r.pdf||readingPDFSource(r.info.source))&&!r.chatPanel){
    const panel=r.chatPanel=readerElement('aside','reading-chat-panel');panel.setAttribute('aria-label','PDF 对话');panel.id='readingChatPanel';
    const header=readerElement('div','reading-chat-header');
    const title=readerElement('strong','','文件对话');
    const close=readerButton('×',()=>{readingChatSet(r,false);(r.compactPDF?r.controls.querySelector('summary'):r.chatButton).focus();});close.setAttribute('aria-label','收起 PDF 对话');
    header.append(title,close);
    const source=readerElement('div','reading-chat-source',r.info.title||'当前 PDF');source.title=r.info.source;
    r.chatStatus=readerElement('div','reading-chat-status');r.chatStatus.setAttribute('role','status');
    const composer=document.querySelector('#ccomp');r.composerHome=document.createComment('reading composer home');composer.before(r.composerHome);
    r.input.placeholder='问这份 PDF，或聊其他问题…';
    r.chatButton.setAttribute('aria-controls',panel.id);
    panel.append(header,source,r.history,r.chatStatus,composer);r.readerBody.append(panel);
    panel.addEventListener('keydown',e=>{if(e.key==='Escape'&&!r.popup){e.preventDefault();e.stopPropagation();readingChatSet(r,false);(r.compactPDF?r.controls.querySelector('summary'):r.chatButton).focus();}});
  }
  document.documentElement.classList.toggle('reading-chat-open',shown);r.root.classList.toggle('reading-with-chat',shown&&!!r.chatPanel);
  if(r.chatPanel)r.chatPanel.hidden=!shown;
  r.history.open=shown;r.controls.open=false;r.chatButton.setAttribute('aria-expanded',String(shown));
  if(shown){r.input.focus({preventScroll:true});if(r.pdf)readingDocumentIndex(r).catch(()=>{});}
}
function readingChatStatus(r,text){r.status.textContent=text;if(r.chatStatus)r.chatStatus.textContent=text;}
// Extract text independently of visible canvases, so questions can refer to later pages.
function readingDocumentIndex(r){
  if(!r.pdf)return Promise.resolve(null);
  const pdf=r.pdf;if(r.chatIndexPDF===pdf&&r.chatIndex)return r.chatIndex;
  r.chatIndexPDF=pdf;
  r.chatIndex=(async()=>{
    const pages=[];let size=0,failed=0;
    for(let page=1;page<=Math.min(pdf.numPages,200)&&size<2000000;page++){
      if(r.dead||r.pdf!==pdf)throw Error('文件已关闭');
      try{
        const p=await pdf.getPage(page),content=await p.getTextContent();
        const text=content.items.map(i=>i.str||'').join(' ').slice(0,40000);size+=text.length;pages.push({page,text});
      }catch(err){if(r.dead)throw err;failed++;}
    }
    return {pages,total:pdf.numPages,failed};
  })();return r.chatIndex;
}
async function readingQuestionContext(r,question,selection){
  if(!r.pdf){const idx=Math.max(0,r.blocks.findIndex(b=>b.id===(selection?.id||r.state.anchor)));return r.blocks.slice(Math.max(0,idx-4),idx+12).map(b=>b.text).join('\n\n').slice(0,24000);}
  const index=await readingDocumentIndex(r);if(!index?.pages.some(p=>p.text.trim()))return '';
  const words=question.toLowerCase().match(/[a-z]{3,}|[\p{Script=Han}]{2,}/gu)||[];
  const tokens=[...new Set(words.flatMap(word=>/\p{Script=Han}/u.test(word)?[...word].slice(0,-1).map((_,i)=>word.slice(i,i+2)):[word]))].slice(0,80);
  const requestedPages=[...question.matchAll(/(?:第\s*(\d+)\s*页|page\s*(\d+))/gi)].map(m=>Number(m[1]||m[2]));
  const chunks=[];
  for(const p of index.pages)for(let offset=0;offset<p.text.length;offset+=1800){
    const text=p.text.slice(offset,offset+1800),lower=text.toLowerCase();
    const score=tokens.reduce((n,t)=>n+(lower.includes(t)?3:0),0)+(requestedPages.includes(p.page)?8:0)+(p.page===(selection?.page||r.page)?2:0)+(p.page===1?1:0);
    chunks.push({page:p.page,offset,text,score});
  }
  const excerpt=chunks.sort((a,b)=>b.score-a.score||a.page-b.page||a.offset-b.offset).slice(0,12).sort((a,b)=>a.page-b.page||a.offset-b.offset);
  return (`PDF 共 ${index.total} 页，已提取 ${index.pages.length} 页文字${index.failed?'，部分页面提取失败':''}。以下是有限的相关摘录，并非完整全文；不得假称已读全部内容。\n\n`+excerpt.map(c=>`[第 ${c.page} 页]\n${c.text}`).join('\n\n')).slice(0,24000);
}
async function readingSend(r=READING,input=r?.input,selection=r?.selection) {
  if (!r || r.dead || r.askPending) return;
  const question=input?.value.trim(); if (!question) {input?.focus();return;}
  const anchor=selection?.id || '';
  r.askPending=true;input.disabled=true;r.input.disabled=true;
  const sendButton=document.querySelector('#chatSend');if(sendButton)sendButton.disabled=true;
  readingChatStatus(r,r.pdf?'正在准备文件内容…':'AI 正在回答…');
  try {
    let context='';
    try{context=await readingQuestionContext(r,question,selection);}catch(err){if(r.dead)return;}
    if(r.dead)return;
    const body={question,selection:selection?.text||'',context,page:selection?.page||null,anchor};
    const signature=JSON.stringify(body);
    if(r.retrySignature!==signature){r.retryId=crypto.randomUUID();r.retrySignature=signature;}
    readingChatStatus(r,'AI 正在回答…');
    await api(`/v1/users/${S.uid}/reading/${encodeURIComponent(r.info.key)}/ask`,{body:{...body,request_id:r.retryId}});
    if (r.dead) return;
    input.value='';r.state.draft='';r.input.value='';r.selection=null;r.state.selection=null;r.quote.hidden=true;r.popup?.remove();r.popup=null;
    r.retrySignature=null;readingScheduleSave(r);
    await loadChat(r.info.key);if(r.dead)return;
    readingChatSet(r,true);r.log.scrollTop=r.log.scrollHeight;readingChatStatus(r,'回答已保存，可继续追问');
  } catch(err) {if(!r.dead){readingChatStatus(r,err.message+'；问题已保留，可重试');toast(r.status.textContent);}}
  finally {r.askPending=false;input.disabled=false;r.input.disabled=false;if(sendButton)sendButton.disabled=false;}
}
function readingScheduleSave(r) {
  clearTimeout(r.saveTimer); r.saveTimer=setTimeout(()=>readingSave(r),500);
}
function readingSave(r,keepalive=false) {
  if (!r || r.dead) return;
  const state={...r.state};
  const signature=JSON.stringify(state);
  if (signature===r.savedSignature) return;
  r.saveRevision=Math.max(Date.now()*1000,(r.saveRevision||0)+1);
  const body=JSON.stringify({...state,revision:r.saveRevision});
  const send=()=>fetch(`/v1/users/${S.uid}/reading/${encodeURIComponent(r.info.key)}/state`,{method:'PATCH',headers:{'Content-Type':'application/json'},body,keepalive}).then(res=>{if(!res.ok)throw Error('保存阅读位置失败');r.savedSignature=signature;});
  // Keep saves ordered; an older scroll request cannot overwrite a newer draft.
  r.saveWork=(keepalive ? send() : (r.saveWork||Promise.resolve()).catch(()=>{}).then(send)).catch(()=>{if(!r.dead)r.status.textContent='阅读位置暂未保存，恢复连接后会重试';});
}
addEventListener('online',()=>{if(READING)readingSave(READING);});
addEventListener('pagehide',()=>{if(READING){
  const r=READING;readingPDFChrome(r,false);readingSave(r,true);r.dead=true;clearTimeout(r.zoomTimer);r.controller.abort();r.translateController?.abort();readingSlidesDispose(r);
  r.observer?.disconnect();r.pdfFlowObserver?.disconnect();readingPDFContinuousDispose(r);r.resize?.disconnect();window.top.document.removeEventListener('scroll',r.viewportChanged,true);
  window.top.readingNativeRemove?.(r.nativeId);
}});
addEventListener('pageshow',e=>{if(e.persisted&&S.readings?.[S.chat])loadChat(S.chat);});
