// Each stage conversation owns its search state, even when several windows are open.
(() => {
  const stageWindow = window.frameElement?.closest('.stwin');
  const menu = stageWindow?.querySelector('.st-window-menu');
  if (!menu || Q.has('manager') || Q.get('c')?.startsWith('chat:pm-')) return;

  const outer = stageWindow.ownerDocument;
  const box = outer.createElement('div');
  box.className = 'st-chat-find';
  const label = L('搜索当前对话', 'Find in conversation');
  const hint = L('Enter 下一处，Shift+Enter 上一处', 'Enter for next, Shift+Enter for previous');
  box.innerHTML = `<input type="search" aria-label="${label}" placeholder="${label}" title="${label} (⌘F / Ctrl+F) · ${hint}"><output aria-live="polite"></output>`;
  menu.before(box);
  document.documentElement.classList.add('stage-chat-header');
  const input = box.querySelector('input'), count = box.querySelector('output');
  const body = document.getElementById('cdlgIn');
  let ranges = [], index = 0, timer;
  const highlights = window.CSS?.highlights;
  const observer = new MutationObserver(() => {
    if (!timer) timer = setTimeout(() => search(false), 100);
  });

  function show(scroll) {
    const range = ranges[index];
    count.textContent = input.value.trim() ? (range ? `${index + 1}/${ranges.length}` : '0/0') : '';
    if (highlights) {
      highlights.delete('chat-find-current');
      if (range) highlights.set('chat-find-current', new Highlight(range));
    }
    if (!range || !scroll) return;
    const el = range.startContainer.parentElement;
    for (let d = el.closest('details'); d; d = d.parentElement.closest('details')) d.open = true;
    if (!highlights) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range); }
    // Keep the canvas and adjacent windows still while revealing the matched line.
    for (let p = el; p && body.parentElement.contains(p); p = p.parentElement) {
      if (p.scrollHeight <= p.clientHeight || !/auto|scroll/.test(getComputedStyle(p).overflowY)) continue;
      const hit = range.getBoundingClientRect(), rect = p.getBoundingClientRect();
      if (hit.top < rect.top || hit.bottom > rect.bottom) p.scrollTop += hit.top - rect.top - p.clientHeight / 2;
    }
  }

  function search(scroll) {
    clearTimeout(timer);
    timer = null;
    observer.disconnect();
    const query = input.value.trim();
    if (!highlights && ranges.includes(getSelection()?.rangeCount ? getSelection().getRangeAt(0) : null)) getSelection().removeAllRanges();
    ranges = [];
    if (query) {
      const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
      for (const message of body.querySelectorAll('.ct, .mynote .md, .question-supplement .md, .mine-q, .wtext')) {
        const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
        let text = '';
        const parts = [];
        for (let node; (node = walker.nextNode());) {
          if (!node.length) continue;
          text += node.data;
          parts.push({node, end:text.length});
        }
        let part = 0;
        for (const match of text.matchAll(pattern)) {
          const start = match.index, end = start + match[0].length;
          while (parts[part].end <= start) part++;
          const first = parts[part], range = document.createRange();
          range.setStart(first.node, start - first.end + first.node.length);
          while (parts[part].end < end) part++;
          const last = parts[part];
          range.setEnd(last.node, end - last.end + last.node.length);
          ranges.push(range);
        }
      }
      observer.observe(body, {subtree:true, childList:true, characterData:true});
    }
    if (highlights) {
      highlights.delete('chat-find');
      const marks = new Highlight();
      for (const range of ranges) marks.add(range);
      if (ranges.length) highlights.set('chat-find', marks);
    }
    index = Math.max(0, Math.min(index, ranges.length - 1));
    show(scroll);
  }

  input.onfocus = () => outer.defaultView.stFocus(stageWindow.closest('.stnode').dataset.nid);
  input.oninput = () => { index = 0; search(true); };
  input.onkeydown = e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { input.value = ''; search(false); }
    else if (e.key === 'Enter') {
      if (ranges.length) index = (index + (e.shiftKey ? -1 : 1) + ranges.length) % ranges.length;
      show(true);
    } else return;
    e.preventDefault(); e.stopPropagation();
  };

  // Forward actions to the embedded document so they use this conversation's state.
  const actions = outer.createElement('div');
  menu.querySelector('.chat-action-panel').append(actions);
  const fillMenu = () => {
    actions.replaceChildren();
    if (!menu.open) return;
    const panel = document.querySelector('#chead .chat-action-panel');
    for (const item of panel?.children || []) {
      if (item.tagName !== 'BUTTON') { actions.append(item.cloneNode(true)); continue; }
      const button = outer.createElement('button');
      button.type = 'button'; button.textContent = item.textContent; button.title = item.title;
      button.disabled = item.disabled; button.className = item.className;
      button.onclick = () => {
        const current = [...(document.querySelector('#chead .chat-action-panel')?.children || [])]
          .find(el => el.tagName === 'BUTTON' && Object.keys(item.dataset).every(k => el.dataset[k] === item.dataset[k]));
        current?.click();
      };
      actions.append(button);
    }
  };
  menu.addEventListener('toggle', fillMenu);
  window.addEventListener('pagehide', e => {
    if (e.persisted) return;
    clearTimeout(timer); observer.disconnect();
    menu.removeEventListener('toggle', fillMenu); actions.remove(); box.remove();
  });
})();
