/* Visible help for the bottom toolbars, including dynamically rendered controls. */
(() => {
  const scope = '.cbar, #stbar, .pdtools, .pdcompose, #chead, .stwh';
  let owner = null, tip = null, oldTitle = null, oldDescription = null;
  const descriptions = [
    ['[data-st="new"]', '新建一个对话窗口，开始新的任务', 'Open a new conversation window for a new task'],
    ['[data-browser-new]', '在台面内打开网页浏览窗口', 'Open a web browser on the stage'],
    ['[data-pjpicker]', '选择项目分类，或创建新的分类', 'Choose a project category or create one'],
    ['#stpmopen', '打开当前分类的管理员，提交需求并查看任务进度', 'Open this category’s manager to assign tasks and review progress'],
    ['#stmore > summary', '展开更多工具：备忘、网页、导入、整理和刷新', 'Show more tools: memos, browser, import, tidy and reload'],
    ['[data-act="mic"]', '语音输入：点击开始或停止录音，将语音转成文字', 'Voice input: click to start or stop recording and transcribe speech'],
    ['#chrefAdd', '选择已有知识，作为本次对话的参考资料', 'Select saved knowledge to use as context'],
    ['#chatSend, #lineSend, #impSend', '发送当前输入；任务进行中时加入待发送队列', 'Send this message; queue it if a task is running']
  ];
  function hide() {
    if (owner) {
      if (oldTitle !== null && !owner.hasAttribute('title')) owner.setAttribute('title', oldTitle);
      if (oldDescription === null) owner.removeAttribute('aria-describedby');
      else owner.setAttribute('aria-describedby', oldDescription);
    }
    tip?.remove(); tip = owner = null;
  }
  function show(el) {
    if (el === owner) return;
    hide();
    if (!el?.closest(scope)) return;
    const match = descriptions.find(([selector]) => el.matches(selector));
    const text = match ? L(match[1], match[2]) : el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent.trim();
    if (!text) return;
    owner = el; oldTitle = el.getAttribute('title'); oldDescription = el.getAttribute('aria-describedby');
    el.removeAttribute('title'); // avoid a second native tooltip
    tip = document.createElement('div'); tip.id = 'pga-toolbar-tip'; tip.className = 'pga-toolbar-tip';
    tip.setAttribute('role', 'tooltip'); tip.textContent = text;
    document.body.append(tip);
    el.setAttribute('aria-describedby', [oldDescription, tip.id].filter(Boolean).join(' '));
    const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(innerWidth - t.width - 8, r.left + (r.width - t.width) / 2)) + 'px';
    tip.style.top = Math.max(8, Math.min(innerHeight - t.height - 8, r.top >= t.height + 16 ? r.top - t.height - 8 : r.bottom + 8)) + 'px';
  }
  const control = target => target?.closest?.('button, summary, select, [role="button"]');
  document.addEventListener('pointerover', e => { if (!e.buttons && e.pointerType !== 'touch') show(control(e.target)); });
  document.addEventListener('pointerout', e => { if (owner && !owner.contains(e.relatedTarget)) hide(); });
  document.addEventListener('focusin', e => show(control(e.target)));
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', hide, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  // A live response can replace the composer while the pointer remains still.
  new MutationObserver(() => { if (owner && !owner.isConnected) hide(); }).observe(document.body, {childList:true, subtree:true});
})();
