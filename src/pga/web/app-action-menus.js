/* Compact conversation/window tools; keep existing action handlers and selectors. */
(() => {
  function close(except, focus = false) {
    document.querySelectorAll('.chat-action-menu[open]').forEach(menu => {
      if (menu === except) return;
      menu.open = false;
      if (focus) menu.querySelector('summary')?.focus();
    });
  }
  document.addEventListener('toggle', e => {
    const menu = e.target;
    if (!menu.matches?.('.chat-action-menu') || !menu.open) return;
    close(menu);
    const panel = menu.querySelector('.chat-action-panel'), r = menu.querySelector('summary').getBoundingClientRect();
    panel.style.maxHeight = Math.max(80, innerHeight - r.bottom - 16) + 'px';
  }, true);
  document.addEventListener('pointerdown', e => close(e.target.closest('.chat-action-menu')), true);
  document.addEventListener('click', e => {
    const button = e.target.closest('.chat-action-panel button');
    // Defer closing until handlers have measured the clicked button for anchored dialogs.
    if (button) setTimeout(() => close(null), 0);
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.querySelector('.chat-action-menu[open]')) {
      close(null, true); e.preventDefault(); e.stopImmediatePropagation();
    }
  }, true);
  window.addEventListener('blur', () => close(null));
})();
