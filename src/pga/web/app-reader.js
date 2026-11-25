/* Shared reader controls for offline and direct cloud translation. */
const READER_CACHE = new Map(); // session-only, bounded; keys include user, URL, language and exact source
function readerElement(tag, cls, text) {
  const el = document.createElement(tag); if (cls) el.className = cls;
  if (text != null) el.textContent = text; return el;
}
function readerButton(text, action, cls = '') {
  const b = readerElement('button', cls, text); b.type = 'button'; b.onclick = action; return b;
}
function readerServiceSelect(uid, onChange) {
  const select = readerElement('select');
  select.setAttribute('aria-label', L('翻译服务', 'Translation service'));
  select.title = L('本地中英互译，首次使用下载模型。云翻译需自备密钥。已保存的译文会直接复用。',
    'Local English–Chinese models download on first use. Cloud services require your own key. Saved translations are reused.');
  const services = [['Local', L('本地离线 · 中英', 'Offline · EN/ZH')], ['Bing', L('微软 Azure', 'Microsoft Azure')],
    ['Google', 'Google Cloud'], ['Youdao', L('有道智云', 'Youdao Cloud')]];
  for (const [id, label] of services) {
    const option = readerElement('option', '', label);
    option.value = id; select.append(option);
  }
  const key = 'pga:reader-builtin-service:' + uid;
  try { select.value = localStorage.getItem(key) || 'Local'; } catch {}
  if (!select.value) select.value = 'Local';
  select.onchange = () => {
    try { localStorage.setItem(key, select.value); } catch {}
    onChange();
  };
  return select;
}
// On a fresh installation the first local batch also downloads the selected language pair.
function readerTranslationTimeout(service) { return service === 'Local' ? 600000 : 90000; }
function readerRequestTranslation(uid, service, target, blocks, signal) {
  return api(`/v1/users/${uid}/web/translate`, {signal, body: {engine: 'builtin', service, target, blocks}});
}
function readerVisible(en) {
  return FILE_PANEL.active === en.id && !FILE_PANEL.host?.hidden && !document.hidden && en.body.isConnected;
}
function readerCacheKey(en, text) { return JSON.stringify([en.uid, en.web, 'zh-CN', text]); }
function readerRemember(key, text) {
  READER_CACHE.delete(key); READER_CACHE.set(key, text);
  while (READER_CACHE.size > 800) READER_CACHE.delete(READER_CACHE.keys().next().value);
}
function readerText(node) {
  const copy = node.cloneNode(true);
  copy.querySelectorAll('pre, code, math').forEach(n => {
    if (n.parentElement?.closest('pre, code, math')) return;
    const formula = n.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
    n.replaceWith(document.createTextNode(n.tagName.toLowerCase() === 'math' ? `\\(${formula || n.textContent}\\)` : '`' + n.textContent + '`'));
  });
  return copy.textContent.trim();
}
function readerBlocks(article) {
  // Leaf paragraph containers: do not translate a list/blockquote/table a second time.
  const selector = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,td,th,dt,dd';
  const blocks = [];
  for (const node of [...article.querySelectorAll(selector)]) {
    if (node.closest('pre,code,math,.website') || node.querySelector(selector)) continue;
    const text = readerText(node);
    if (!/[A-Za-z]{2}/.test(text)) continue;
    const id = 'p' + blocks.length, pair = readerElement('div', 'rr-pair');
    // Keep list items and cells valid: their original inline children go into a span.
    if (node.matches('li,td,th,dt,dd')) {
      const original = readerElement('div', 'rr-source');
      while (node.firstChild) original.append(node.firstChild);
      node.append(pair); pair.append(original);
    } else { node.before(pair); pair.append(node); node.classList.add('rr-source'); }
    pair.dataset.block = id;
    const translated = readerElement('div', 'rr-translation'); translated.lang = 'zh-CN';
    pair.append(translated);
    blocks.push({ id, text, pair, translated, status: text.length > 3000 ? 'long' : 'idle' });
  }
  return blocks;
}
function readerPaintBlock(r, block) {
  block.pair.dataset.status = block.status;
  block.translated.replaceChildren();
  if (block.status === 'done') { block.translated.textContent = block.translation; return; }
  if (block.status === 'error') {
    block.translated.append(readerElement('span', '', block.error || L('翻译失败', 'Translation failed')),
      readerButton(L('重试本段', 'Retry paragraph'), () => { block.status = 'idle'; r.paused = false; readerPaintBlock(r, block); readerPump(r); }));
  } else {
    block.translated.textContent = block.status === 'pending' ? L('正在翻译…', 'Translating…') : block.status === 'long'
      ? L('本段过长，保留原文；可划词翻译或提问。', 'Long paragraph kept intact; select a passage to translate or ask.')
      : L('待翻译 · 滚动到这里时加载', 'Translation loads as you read');
  }
}
function readerProgress(r) {
  const done = r.blocks.filter(b => b.status === 'done').length;
  const failed = r.blocks.filter(b => b.status === 'error').length;
  r.progress.textContent = r.mode === 'original' ? L('原文 · 选中文本可问 AI', 'Original · select text to ask AI') :
    `${done}/${r.blocks.length} ${L('段已译', 'translated')}${failed ? ` · ${failed} ${L('段失败', 'failed')}` : ''}${r.paused ? L(' · 已暂停', ' · paused') : ''}`;
  r.pause.textContent = r.paused ? L('继续翻译', 'Resume') : L('暂停翻译', 'Pause');
  r.pause.hidden = r.mode === 'original' || !r.blocks.some(b => b.status === 'idle' || b.status === 'pending');
  r.retry.hidden = !failed || r.mode === 'original';
}
async function readerPump(r) {
  if (r.disposed || r.busy || r.paused || r.mode === 'original' || !readerVisible(r.en)) return;
  const box = r.scroll.getBoundingClientRect();
  let size = 0;
  const batch = r.blocks.filter(b => {
    const rect = b.pair.getBoundingClientRect();
    if (b.status !== 'idle' || rect.bottom < box.top - 200 || rect.top > box.bottom + 500 || size + b.text.length > 6000) return false;
    size += b.text.length; return true;
  }).slice(0, 6);
  if (!batch.length) { readerProgress(r); return; }
  const ctrl = new AbortController(); r.busy = ctrl;
  batch.forEach(b => { b.status = 'pending'; readerPaintBlock(r, b); }); readerProgress(r);
  const timeout = setTimeout(() => ctrl.abort(), readerTranslationTimeout(r.service.value));
  try {
    const data = await readerRequestTranslation(r.en.uid, r.service.value, 'zh-CN',
      batch.map(b => ({ id: b.id, text: b.text })), ctrl.signal);
    if (r.disposed || r.busy !== ctrl || ctrl.signal.aborted) return;
    for (const b of batch) {
      const matches = data?.blocks?.filter(item => item.id === b.id) || [];
      const result = matches.length === 1 && matches[0];
      if (result && typeof result.text === 'string' && result.text.trim() && !result.error) {
        b.translation = result.text; b.status = 'done'; readerRemember(readerCacheKey(r.en, b.text), result.text);
      } else { b.status = 'error'; b.error = result?.error || L('本段未返回译文', 'No translation returned'); }
      readerPaintBlock(r, b);
    }
  } catch (err) {
    if (r.disposed || r.busy !== ctrl) return;
    for (const b of batch) { b.status = 'error'; b.error = ctrl.signal.aborted ? L('翻译超时，请重试', 'Translation timed out') : err.message; readerPaintBlock(r, b); }
    r.paused = true; // a provider/configuration failure must not spend requests down the entire page
  } finally {
    clearTimeout(timeout);
    if (r.busy === ctrl) { r.busy = null; readerProgress(r); if (!r.disposed) readerPump(r); }
  }
}
function readerStop(r) {
  const pending = r.busy; r.busy = null; pending?.abort();
  r.blocks.filter(b => b.status === 'pending').forEach(b => { b.status = 'idle'; readerPaintBlock(r, b); });
  readerProgress(r);
}
function fpReaderVisibility() {
  for (const en of FILE_PANEL.entries.values()) {
    const r = en.reader; if (!r) continue;
    r.selectionMenu.hidden = true;
    if (readerVisible(en)) readerPump(r); else readerStop(r);
  }
}
function fpReaderDispose(en) {
  en.readController?.abort();
  const r = en.reader;
  if (r) { r.disposed = true; readerStop(r); r.askController?.abort();
    r.events.abort(); r.observer?.disconnect(); r.selectionMenu.remove(); }
  en._docToolsObserver?.disconnect(); en._docToolsObserver = null;
  en._docToolsDead = true;
  clearTimeout(en._docToolsInitTimer); en._docToolsInitTimer = null;
  for (const b of en._docBindings || []) {
    b.doc.removeEventListener('wheel', b.wheel, true);
    b.doc.removeEventListener('mouseup', b.selection, true);
    b.doc.removeEventListener('keyup', b.selection, true);
    b.doc.removeEventListener('keyup', b.esc, true);
  }
  en._docBindings = [];
  en._docBindingByFrame?.clear(); en._docBindingByFrame = null;
  en._docMarkedNodes = [];
  en._docFrameLoad && en.body.removeEventListener('load', en._docFrameLoad, true);
}
document.addEventListener('visibilitychange', fpReaderVisibility);

function readerSetMode(r, mode) {
  // Retain the first visible source block while changing row heights.
  const top = r.scroll.getBoundingClientRect().top;
  const anchor = r.blocks.find(b => b.pair.getBoundingClientRect().bottom > top);
  const offset = anchor?.pair.getBoundingClientRect().top;
  r.mode = mode; r.root.dataset.readerMode = mode;
  r.modes.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.readerMode === mode)));
  try { localStorage.setItem('pga_reader_mode', mode); } catch {}
  if (anchor) r.scroll.scrollTop += anchor.pair.getBoundingClientRect().top - offset;
  if (mode === 'original') readerStop(r); else readerPump(r);
  readerProgress(r);
}
function fpReaderMount(en, info) {
  const root = readerElement('section', 'rr-reader'); root.setAttribute('aria-label', L('双语网页阅读器', 'Bilingual web reader'));
  const bar = readerElement('div', 'rr-toolbar'), modes = readerElement('div', 'rr-modes');
  modes.setAttribute('role', 'group'); modes.setAttribute('aria-label', L('阅读模式', 'Reading mode'));
  const scroll = readerElement('div', 'rr-scroll'); scroll.tabIndex = 0;
  const article = readerElement('article', 'webread rr-article');
  // Never fall back to inserting untrusted HTML, even if the sanitizer fails to load.
  const purifier = window.DOMPurify || (typeof DOMPurify !== 'undefined' && DOMPurify);
  if (purifier) article.innerHTML = purifier.sanitize(info.html || '', { USE_PROFILES: { html: true, mathMl: true },
    FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'button', 'iframe', 'audio', 'video'], FORBID_ATTR: ['style', 'id', 'name', 'class'], ALLOW_DATA_ATTR: false });
  else article.textContent = L('阅读组件未能加载，请刷新页面重试。', 'Reader could not load. Refresh to retry.');
  const card = readerElement('div', 'webcard');
  card.append(readerElement('div', 'website', [info.site || info.host, info.byline, info.published?.slice(0, 10)].filter(Boolean).join(' · ')),
    readerElement('h1', '', info.title || info.host));
  if (info.description) card.append(readerElement('p', 'webdesc', info.description));
  article.prepend(card);
  article.querySelectorAll('img').forEach(img => { img.referrerPolicy = 'no-referrer'; img.loading = 'lazy'; img.addEventListener('error', () => img.remove()); });
  article.querySelectorAll('a').forEach(a => { a.rel = 'noopener noreferrer'; });
  const progress = readerElement('span', 'rr-progress'); progress.setAttribute('role', 'status');
  const r = en.reader = { en, root, scroll, article, modes, progress, blocks: readerBlocks(article), mode: 'bilingual', paused: false,
    events: new AbortController(), history: [], selectionPick: null, askSelection: null, askSeq: 0, drafts: new Map() };
  for (const [mode, label] of [['original', L('原文', 'Original')], ['bilingual', L('段落对照', 'Bilingual')],
    ['columns', L('左右对照', 'Columns')], ['translation', L('仅中文', 'Chinese')]]) {
    const b = readerButton(label, () => readerSetMode(r, mode)); b.dataset.readerMode = mode; modes.append(b);
  }
  r.pause = readerButton(L('暂停翻译', 'Pause'), () => { r.paused = !r.paused; if (r.paused) readerStop(r); else readerPump(r); readerProgress(r); });
  r.pause.title = L('暂停后续段落的翻译', 'Pause translation of subsequent paragraphs');
  r.retry = readerButton(L('重试失败段落', 'Retry failed'), () => {
    r.blocks.filter(b => b.status === 'error').forEach(b => { b.status = 'idle'; readerPaintBlock(r, b); }); r.paused = false; readerPump(r);
  });
  const original = readerButton(L('原网页 ↗', 'Website ↗'), () => {
    if (typeof fpBrowserAvailable === 'function' && fpBrowserAvailable()) openPgaBrowser(en.web, en.uid);
    else window.open(en.web, '_blank', 'noopener');
  });
  const ask = readerButton(L('问 AI', 'Ask AI'), () => readerOpenAsk(r, null));
  r.service = readerServiceSelect(en.uid, () => {
    if (r.mode !== 'original' && r.blocks.some(b => b.status === 'error')) r.retry.click();
  });
  bar.append(modes, r.service, ask, original);
  const status = readerElement('div', 'rr-status'); status.append(progress, r.pause, r.retry);
  if (info.thin) {
    const hint = readerElement('p', 'rr-notice', L('正文较少；登录或动态内容可能未能提取，可打开原网页。', 'Little text extracted. Login or dynamic content may require the original page.'));
    scroll.append(hint);
  }
  scroll.append(article); root.append(bar, status, scroll); en.body.append(root);
  for (const b of r.blocks) {
    const cached = READER_CACHE.get(readerCacheKey(en, b.text));
    if (cached) { b.translation = cached; b.status = 'done'; }
    readerPaintBlock(r, b);
  }
  readerSelection(r);
  r.observer = new IntersectionObserver(() => readerPump(r), { root: scroll, rootMargin: '200px 0px 500px' });
  r.blocks.forEach(b => r.observer.observe(b.pair));
  scroll.addEventListener('scroll', () => { r.selectionMenu.hidden = true; readerPump(r); }, { passive: true, signal: r.events.signal });
  let mode; try { mode = localStorage.getItem('pga_reader_mode'); } catch {}
  readerSetMode(r, ['original', 'bilingual', 'columns', 'translation'].includes(mode) ? mode : 'bilingual');
}

function readerSelectionSnapshot(r) {
  const sel = window.getSelection(); if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0), element = n => n.nodeType === 1 ? n : n.parentElement;
  const start = element(range.startContainer), end = element(range.endContainer);
  if (!r.article.contains(start) || !r.article.contains(end) || start.closest('.rr-ask') || end.closest('.rr-ask')) return null;
  const text = sel.toString().trim(); if (!text) return null;
  const pair = start.closest('.rr-pair');
  return { text: text.slice(0, 8000), truncated: text.length > 8000, block: r.blocks.find(b => b.pair === pair),
    anchor: pair || start.closest('p,pre,table,blockquote,h1,h2,h3,figure') || r.article.firstElementChild,
    rect: range.getBoundingClientRect() };
}
function readerSelection(r) {
  const menu = r.selectionMenu = readerElement('div', 'rr-selection'); menu.hidden = true;
  menu.setAttribute('role', 'toolbar'); menu.setAttribute('aria-label', L('选文操作', 'Selected text actions'));
  const open = question => { const selected = r.selectionPick; menu.hidden = true; readerOpenAsk(r, selected, question); };
  menu.append(readerButton(L('问 AI', 'Ask AI'), () => open('')), readerButton(L('解释', 'Explain'), () => open(L('请解释这段话，说明关键术语。', 'Explain this passage and its key terms.'))),
    readerButton(L('翻译选文', 'Translate'), () => { menu.hidden = true; readerTranslateSelection(r, r.selectionPick); }));
  menu.addEventListener('pointerdown', e => e.preventDefault()); // preserve the range before a button is clicked
  FILE_PANEL.host.append(menu);
  const capture = () => {
    if (!readerVisible(r.en)) return;
    const selected = readerSelectionSnapshot(r);
    if (!selected) { menu.hidden = true; return; }
    r.selectionPick = selected; menu.hidden = false;
    const rect = selected.rect, bounds = FILE_PANEL.host.getBoundingClientRect(), m = menu.getBoundingClientRect();
    menu.style.left = Math.max(bounds.left + 8, Math.min(innerWidth - m.width - 8, rect.left)) + 'px';
    menu.style.top = Math.max(bounds.top + 8, Math.min(innerHeight - m.height - 8, rect.top > m.height + bounds.top + 8 ? rect.top - m.height - 6 : rect.bottom + 6)) + 'px';
  };
  r.article.addEventListener('pointerup', () => requestAnimationFrame(capture), { signal: r.events.signal });
  r.article.addEventListener('keyup', e => { if (e.key.startsWith('Arrow') || e.key === 'Shift') capture(); }, { signal: r.events.signal });
  document.addEventListener('selectionchange', () => { if (window.getSelection()?.isCollapsed) menu.hidden = true; }, { signal: r.events.signal });
  rootKeydown();
  function rootKeydown() {
    r.root.addEventListener('keydown', e => {
      if (e.altKey && e.key === 'Enter') { const selected = readerSelectionSnapshot(r); if (selected) { e.preventDefault(); readerOpenAsk(r, selected); } }
      if (e.key === 'Escape') { e.stopPropagation(); menu.hidden = true; readerCloseAsk(r); }
    }, { signal: r.events.signal });
  }
  window.addEventListener('resize', () => { menu.hidden = true; }, { signal: r.events.signal });
}
function readerContext(r, selected) {
  const focus = selected?.block;
  if (focus) {
    const i = r.blocks.indexOf(focus);
    return r.blocks.slice(Math.max(0, i - 2), i + 3).map(b => `[${b.id}] ${b.text}`).join('\n\n').slice(0, 24000);
  }
  if (selected?.anchor) {
    // Code, formulas and untranslated Chinese passages still need their local neighbours.
    const nodes = [selected.anchor.previousElementSibling, selected.anchor, selected.anchor.nextElementSibling];
    return nodes.filter(Boolean).map(node => {
      const copy = node.cloneNode(true); copy.querySelectorAll('.rr-translation,.rr-ask,button').forEach(n => n.remove());
      return copy.matches('.rr-ask') ? '' : copy.textContent.trim();
    }).join('\n\n').slice(0, 24000);
  }
  const copy = r.article.cloneNode(true); copy.querySelectorAll('.rr-translation,.rr-ask').forEach(n => n.remove());
  return copy.textContent.trim().slice(0, 24000);
}
function readerCloseAsk(r) {
  if (r.askKey && r.askInput) { r.drafts.set(r.askKey, r.askInput.value); while (r.drafts.size > 8) r.drafts.delete(r.drafts.keys().next().value); }
  r.askSeq++; r.askController?.abort(); r.askController = null;
  if (r.askCard) r.askCard.hidden = true;
  r.askSelection?.anchor?.classList.remove('rr-focus');
}
function readerPlaceCard(r, card, selected) {
  // Keep cards outside lists, tables and the article title.
  let anchor = selected?.anchor || r.article.firstElementChild;
  while (anchor?.parentElement && anchor.parentElement !== r.article) anchor = anchor.parentElement;
  if (anchor && anchor !== r.article) anchor.after(card); else r.article.prepend(card);
  selected?.anchor?.classList.add('rr-focus');
  card.scrollIntoView({ block: 'nearest' });
}
async function readerTranslateSelection(r, selected) {
  if (!selected?.text.trim()) return;
  readerCloseAsk(r);
  r.askInput = null; r.askSelection = selected; r.askCard?.remove();
  const card = r.askCard = readerElement('aside', 'rr-ask');
  card.setAttribute('aria-label', L('选文译文', 'Selection translation'));
  const header = readerElement('div', 'rr-ask-head');
  header.append(readerElement('b', '', L('选文译文', 'Selection translation')),
    readerButton(L('关闭', 'Close'), () => { readerCloseAsk(r); r.scroll.focus({ preventScroll: true }); }));
  const output = readerElement('div', 'rr-answer', L('正在翻译…', 'Translating…'));
  output.setAttribute('role', 'status'); output.tabIndex = -1;
  if (selected.truncated) card.append(readerElement('small', 'rr-evidence', L('仅翻译选文的前 8000 字符', 'Showing the first 8000 characters')));
  card.append(header, output); readerPlaceCard(r, card, selected);
  output.focus({ preventScroll: true });
  const controller = r.askController = new AbortController();
  const service = r.service.value;
  const timeout = setTimeout(() => controller.abort(), readerTranslationTimeout(service));
  const text = selected.text;
  const target = (text.match(/\p{Script=Han}/gu) || []).length * 2 > (text.match(/[a-z]/gi) || []).length ? 'en' : 'zh-CN';
  const chunks = [];
  const characters = Array.from(text);
  while (characters.length) {
    let end = Math.min(characters.length, 3000);
    if (end < characters.length) {
      const boundary = characters.slice(0, end).findLastIndex(ch => /[\s。！？]/u.test(ch));
      if (boundary >= 0) end = boundary + 1;
    }
    const chunk = characters.splice(0, end).join('').trim();
    if (chunk) chunks.push(chunk);
  }
  const translated = [];
  try {
    for (let i = 0; i < chunks.length; i += 2) {
      const blocks = chunks.slice(i, i + 2).map((text, j) => ({ id: 'p' + (i + j), text }));
      const result = await readerRequestTranslation(r.en.uid, service, target, blocks, controller.signal);
      if (r.askController !== controller || r.disposed) return;
      for (const block of blocks) {
        const item = result.blocks?.find(b => b.id === block.id);
        if (!item?.text || item.error) throw Error(item?.error || L('未收到译文', 'No translation returned'));
        translated.push(item.text);
      }
    }
    output.textContent = translated.join('\n');
  } catch (err) {
    if (r.askController !== controller || r.disposed) return;
    output.textContent = controller.signal.aborted ? L('翻译超时', 'Translation timed out') : err.message;
    card.append(readerButton(L('重试翻译', 'Retry translation'), () => readerTranslateSelection(r, selected)));
  } finally {
    clearTimeout(timeout);
    if (r.askController === controller) r.askController = null;
  }
}
function readerOpenAsk(r, selected, question = '') {
  readerCloseAsk(r); r.selectionMenu.hidden = true;
  const key = selected ? `${selected.block?.id || ''}:${selected.text}` : '__article__';
  const same = r.askKey === key; r.askKey = key; r.askSelection = selected;
  if (!same) r.history = [];
  r.askCard?.remove();
  const card = r.askCard = readerElement('aside', 'rr-ask'); card.setAttribute('aria-label', L('就地询问 AI', 'Ask AI in place'));
  const header = readerElement('div', 'rr-ask-head');
  header.append(readerElement('b', '', selected ? L('关于这段文字', 'About this passage') : L('关于这篇文章', 'About this article')),
    readerButton(L('关闭', 'Close'), () => { readerCloseAsk(r); r.scroll.focus({ preventScroll: true }); }));
  const quote = readerElement('blockquote', 'rr-quote', selected?.text || r.en.name);
  const evidence = readerElement('div', 'rr-evidence', L('仅使用选文与有限正文上下文 · 发送给 PGA 已配置的模型', 'Uses the selection and limited article context · sent to the configured PGA model'));
  if (selected?.truncated) evidence.textContent += L(' · 选文已截取前 8000 字符', ' · selection limited to 8000 characters');
  const source = readerButton(L('定位原文 ↑', 'Back to source ↑'), () => {
    const target = selected?.anchor || r.article.firstElementChild; target?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    target?.classList.add('rr-focus');
  });
  const log = r.askLog = readerElement('div', 'rr-answers'); log.setAttribute('aria-live', 'polite');
  for (const turn of r.history) readerAnswer(r, turn.role, turn.content);
  const form = readerElement('form', 'rr-question');
  const input = r.askInput = readerElement('textarea'); input.rows = 2; input.maxLength = 2000;
  input.placeholder = L('针对选文提问… Enter 发送，Shift+Enter 换行', 'Ask about the passage… Enter to send');
  input.setAttribute('aria-label', L('向 AI 提问', 'Question for AI')); input.value = question || r.drafts.get(key) || '';
  const send = r.askSend = readerElement('button', '', L('发送', 'Send')); send.type = 'submit';
  const cancel = r.askCancel = readerButton(L('停止等待', 'Stop waiting'), () => {
    r.askSeq++; r.askController?.abort(); r.askController = null; send.disabled = false; cancel.hidden = true;
    r.askStatus.textContent = L('已停止等待；模型可能仍在完成当前请求。', 'Stopped waiting; the model may still finish the request.');
  }); cancel.hidden = true;
  const status = r.askStatus = readerElement('div', 'rr-ask-status'); status.setAttribute('role', 'status');
  form.append(input, send, cancel); form.onsubmit = e => { e.preventDefault(); readerAsk(r); };
  input.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); readerAsk(r); } };
  card.append(header, quote, evidence, source, log, form, status);
  readerPlaceCard(r, card, selected); input.focus({ preventScroll: true });
}
function readerAnswer(r, role, content) {
  const answer = readerElement('div', role === 'user' ? 'rr-question-text' : 'rr-answer md');
  if (role === 'user') answer.textContent = content;
  else answer.innerHTML = md(content); // shared Markdown renderer sanitizes model output
  r.askLog.append(answer);
}
async function readerAsk(r) {
  const question = r.askInput.value.trim(); if (!question || r.askController || r.disposed) return;
  const selected = r.askSelection, context = readerContext(r, selected);
  if (!selected?.text && !context) { r.askStatus.textContent = L('没有可用正文，请打开原网页。', 'No article text available.'); return; }
  const ctrl = new AbortController(), seq = ++r.askSeq; r.askController = ctrl;
  r.askSend.disabled = true; r.askCancel.hidden = false; r.askStatus.textContent = L('AI 正在回答…', 'AI is answering…');
  const timeout = setTimeout(() => ctrl.abort(), 90000);
  const history = r.history.slice(-6).map(t => ({ ...t, content: t.content.slice(0, 2000) }));
  try {
    const result = await api(`/v1/users/${r.en.uid}/web/ask`, { signal: ctrl.signal, body: {
      url: r.en.web, title: r.en.name.slice(0, 500), selection: selected?.text || '', context, question, history
    } });
    if (r.disposed || r.askSeq !== seq || ctrl.signal.aborted) return;
    if (!result?.answer?.trim()) throw Error(L('AI 没有返回回答，请重试', 'No answer returned. Try again.'));
    readerAnswer(r, 'user', question); readerAnswer(r, 'assistant', result.answer);
    r.history.push({ role: 'user', content: question }, { role: 'assistant', content: result.answer }); r.history = r.history.slice(-8);
    r.askInput.value = ''; r.askStatus.textContent = L('可继续追问', 'You can ask a follow-up');
    r.askLog.scrollTop = r.askLog.scrollHeight;
  } catch (err) {
    if (!r.disposed && r.askSeq === seq) r.askStatus.textContent = ctrl.signal.aborted ? L('回答超时，问题已保留，可重新发送。', 'Timed out. Your question is kept; send again.') : err.message;
  } finally {
    clearTimeout(timeout);
    if (r.askSeq === seq) { r.askController = null; r.askSend.disabled = false; r.askCancel.hidden = true; }
  }
}

/* Document-page tools: Ctrl-wheel zoom and paragraph marks stored per user/file. */
function fpDocMarkKey(en) { return `pga:document-marks:${en.uid}:${en.path || en.web || en.id}`; }
function fpDocZoomKey(en) { return `pga:document-zoom:${en.uid}:${en.path || en.web || en.id}`; }
function fpDocRoot(en, doc = document) {
  const mode = en.body.querySelector('.filemode:not([hidden])') || en.body;
  try {
    const frame = mode.querySelector('iframe');
    if (frame?.contentDocument?.body) return {doc:frame.contentDocument, root:frame.contentDocument.body};
  } catch {}
  const editor = mode.querySelector('.monaco-editor');
  if (editor) return {doc:editor.ownerDocument, root:editor};
  return {doc:mode.ownerDocument || doc, root:mode.querySelector('.filecontent, article, .webread') || mode};
}
function fpDocBlocks(root) {
  const selector='p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,td,th,dt,dd,pre';
  if (!root?.querySelectorAll) return [];
  return [...root.querySelectorAll(selector)].filter(el=>!el.closest('.fp-doc-tools')&&!el.querySelector(selector)&&el.textContent.trim());
}
function fpDocNorm(s) { return String(s||'').replace(/\s+/g,' ').trim(); }
function fpDocMarks(en) { try { const x=JSON.parse(localStorage.getItem(fpDocMarkKey(en))||'[]');return Array.isArray(x)?x.slice(-400):[]; } catch { return []; } }
function fpDocSaveMarks(en, marks) { try { localStorage.setItem(fpDocMarkKey(en),JSON.stringify(marks.slice(-400)));return true; } catch { return false; } }
function fpDocApplyMarks(en, root) {
  if (!root?.querySelectorAll) return;
  const blocks=fpDocBlocks(root);
  for(const el of en._docMarkedNodes||[]){delete el.dataset.pgaDocMark;}
  en._docMarkedNodes=[];
  const marks=fpDocMarks(en), seen=new Map();
  for(const el of blocks){const text=fpDocNorm(el.textContent),i=seen.get(text)||0;seen.set(text,i+1);const mark=marks.find(m=>m.text===text&&m.occurrence===i);if(!mark)continue;
    el.dataset.pgaDocMark=mark.kind;en._docMarkedNodes.push(el);
  }
  const doc=root.ownerDocument;if(doc&&!doc.querySelector('style[data-pga-doc-mark-style]')){const style=doc.createElement('style');style.dataset.pgaDocMarkStyle='1';style.textContent='[data-pga-doc-mark="highlight"]{background:rgba(255,216,76,.32)!important;border-radius:2px}[data-pga-doc-mark="underline"]{text-decoration:underline #d98216 2px!important;text-underline-offset:2px}';doc.head?.append(style);}
}
function fpDocInstall(en) {
  if (!en?.body || en._docToolsInstalled) return;en._docToolsInstalled=true;en._docToolsDead=false;
  const tools=readerElement('div','fp-doc-tools'),pen=readerButton('✎ 标注笔：关',()=>{pen.dataset.on=pen.dataset.on==='1'?'0':'1';pen.textContent=pen.dataset.on==='1'?'✎ 标注笔：开':'✎ 标注笔：关';tools.classList.toggle('marking',pen.dataset.on==='1');highlight.disabled=underline.disabled=pen.dataset.on!=='1'||!en._docHasSelection;if(pen.dataset.on!=='1')status.textContent='标注笔已关闭';}),highlight=readerButton('高亮',()=>apply('highlight')),underline=readerButton('划线',()=>apply('underline')),clear=readerButton('清除全部标注',()=>{fpDocSaveMarks(en,[]);const {root}=fpDocRoot(en);fpDocApplyMarks(en,root);tools.querySelector('.fp-doc-status').textContent='本地标注已清除';}),minus=readerButton('−',()=>zoomBy(.9)),plus=readerButton('+',()=>zoomBy(1.1)),reset=readerButton('100%',()=>setZoom(1)),status=readerElement('span','fp-doc-status','选中段落后使用标注笔');highlight.disabled=underline.disabled=true;
  tools.append(pen,highlight,underline,clear,readerElement('span','fp-doc-sep','缩放'),minus,reset,plus,status);tools.addEventListener('mousedown',e=>e.preventDefault());en.body.prepend(tools);
  function getZoom(){const n=Number(localStorage.getItem(fpDocZoomKey(en)));return Number.isFinite(n)&&n>0?n:1;}
  function setZoom(value){const zoom=Math.max(.65,Math.min(2.5,Math.round(value*100)/100));try{localStorage.setItem(fpDocZoomKey(en),String(zoom));}catch{}const {root}=fpDocRoot(en);if(root?.style&&root.style.zoom!==String(zoom))root.style.zoom=String(zoom);const label=`${Math.round(zoom*100)}%`;if(reset.textContent!==label)reset.textContent=label;}
  function zoomBy(factor){setZoom(getZoom()*factor);}
  function apply(kind){if(pen.dataset.on!=='1'){tools.querySelector('.fp-doc-status').textContent='先打开标注笔，再选择要标记的段落';return;}const doc=en._docSelection||document,sel=doc.getSelection?.();if(!sel||sel.isCollapsed||!sel.rangeCount){tools.querySelector('.fp-doc-status').textContent='请先选中段落中的文字';return;}const range=sel.getRangeAt(0),blocks=fpDocBlocks(fpDocRoot(en,doc).root).filter(el=>{try{return range.intersectsNode(el);}catch{return false;}});if(!blocks.length){tools.querySelector('.fp-doc-status').textContent='当前视图暂不支持段落标注';return;}const root=fpDocRoot(en,doc).root,all=fpDocBlocks(root),marks=fpDocMarks(en);for(const el of blocks){const text=fpDocNorm(el.textContent),occurrence=all.slice(0,all.indexOf(el)).filter(x=>fpDocNorm(x.textContent)===text).length;const old=marks.findIndex(m=>m.text===text&&m.occurrence===occurrence);if(old>=0)marks.splice(old,1);marks.push({text,occurrence,kind});}if(!fpDocSaveMarks(en,marks)){tools.querySelector('.fp-doc-status').textContent='本地存储空间不足，标注未保存';return;}fpDocApplyMarks(en,root);tools.querySelector('.fp-doc-status').textContent=`已保存 ${blocks.length} 段${kind==='highlight'?'高亮':'划线'}（仅此浏览器）`;}
  function wheel(e){if(!e.ctrlKey||e.metaKey||e.shiftKey||FILE_PANEL.active!==en.id||e.target.closest?.('.fp-img,.monaco-editor'))return;e.preventDefault();e.stopPropagation();zoomBy(e.deltaY<0?1.1:.9);}
  function updateCapabilities(){const {root}=fpDocRoot(en);const supported=fpDocBlocks(root).length>0;highlight.disabled=underline.disabled=true;if(!supported)status.textContent='此预览没有可标注的文字；图片/原生 PDF 请使用阅读器';}
  function unbind(b){b.doc.removeEventListener('wheel',b.wheel,true);b.doc.removeEventListener('mouseup',b.selection,true);b.doc.removeEventListener('keyup',b.selection,true);b.doc.removeEventListener('keyup',b.esc,true);en._docBindings=en._docBindings.filter(x=>x!==b);for(const [key,value]of en._docBindingByFrame||[])if(value===b)en._docBindingByFrame.delete(key);}
  function bind(doc,frame=null){if(!doc)return;en._docBindings ||= [];en._docBindingByFrame ||= new Map();const ownerFrame=frame||(doc!==document?doc.defaultView?.frameElement:null),key=ownerFrame||document,prior=en._docBindingByFrame.get(key);if(prior?.doc===doc)return;if(prior)unbind(prior);const selection=e=>{if(FILE_PANEL.active!==en.id||tools.contains(e.target))return;en._docSelection=doc;en._docHasSelection=!!doc.getSelection?.()?.toString().trim();const supported=fpDocBlocks(fpDocRoot(en).root).length>0;highlight.disabled=underline.disabled=!en._docHasSelection||pen.dataset.on!=='1'||!supported;if(en._docHasSelection&&status.textContent!==(supported?'选文已就绪：高亮或划线':'当前编辑视图不支持段落标注'))status.textContent=supported?'选文已就绪：高亮或划线':'当前编辑视图不支持段落标注';};const esc=e=>{if(e.key==='Escape'&&pen.dataset.on==='1')pen.click();};doc.addEventListener('wheel',wheel,{capture:true,passive:false});doc.addEventListener('mouseup',selection,{capture:true});doc.addEventListener('keyup',selection,{capture:true});doc.addEventListener('keyup',esc,{capture:true});const binding={doc,wheel,selection,esc};en._docBindings.push(binding);en._docBindingByFrame.set(key,binding);}
  bind(document);en._docFrameLoad=e=>{if(e.target.tagName==='IFRAME')try{bind(e.target.contentDocument,e.target);fpDocApplyMarks(en,fpDocRoot(en).root);setZoom(getZoom());updateCapabilities();}catch{}};en.body.addEventListener('load',en._docFrameLoad,true);
  const observer=new MutationObserver(records=>{if(records.every(m=>m.target.closest?.('.fp-doc-tools')||m.target===tools))return;const {doc,root}=fpDocRoot(en);bind(doc);fpDocApplyMarks(en,root);setZoom(getZoom());updateCapabilities();});observer.observe(en.body,{subtree:true,childList:true});en._docToolsObserver=observer;
  setZoom(getZoom());en._docToolsInitTimer=setTimeout(()=>{en._docToolsInitTimer=null;if(en._docToolsDead||!en.body.isConnected)return;const {doc,root}=fpDocRoot(en);bind(doc,root?.ownerDocument===document?null:root?.ownerDocument?.defaultView?.frameElement||null);fpDocApplyMarks(en,root);setZoom(getZoom());updateCapabilities();},0);
}
if(typeof openPgaFile==='function'){
  const fpOpenOriginal=openPgaFile;
  openPgaFile=async function(...args){const result=await fpOpenOriginal.apply(this,args);const active=typeof fpActive==='function'?fpActive():null;if(active)fpDocInstall(active);return result;};
  window.openPgaFile=openPgaFile;
}
