/* Theme-aware menus retain the underlying selects and their change handlers. */
function styleComposerSelects(root) {
  for(const select of root.querySelectorAll('select:not(#chatAgent)')) {
    if(select.dataset.styled)continue;select.dataset.styled='1';select.hidden=true;
    const b=document.createElement('button');b.type='button';b.className='pga-select-trigger';
    b.setAttribute('aria-haspopup','listbox');b.setAttribute('aria-expanded','false');
    const update=()=>{b.textContent=select.selectedOptions[0]?.textContent||select.title||'选择';b.title=select.title;b.setAttribute('aria-label',select.title||b.textContent);b.disabled=select.disabled;};
    update();select.after(b);select.addEventListener('change',update);
    b.addEventListener('click',()=>openComposerMenu(select,b));
    b.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();openComposerMenu(select,b);}});
  }
}
let closeComposerMenu=()=>{};
function openComposerMenu(select,trigger) {
  closeComposerMenu();
  const menu=document.createElement('div');menu.className='pga-select-menu';menu.setAttribute('role','listbox');menu.setAttribute('aria-label',select.title||'选项');
  const close=(focus=false)=>{menu.remove();trigger.setAttribute('aria-expanded','false');document.removeEventListener('pointerdown',outside,true);window.removeEventListener('resize',resize);document.removeEventListener('scroll',scroll,true);if(focus&&trigger.isConnected)trigger.focus();};
  const outside=e=>{if(!menu.contains(e.target)&&!trigger.contains(e.target))close();};
  const resize=()=>close(),scroll=e=>{if(!menu.contains(e.target))close();};
  closeComposerMenu=close;
  for(const o of select.options){if(o.hidden)continue;const item=document.createElement('button');item.type='button';item.setAttribute('role','option');item.setAttribute('aria-selected',String(o.selected));item.disabled=o.disabled;
    const label=document.createElement('span');label.textContent=o.textContent;item.append(label);
    const tick=document.createElement('span');tick.textContent=o.selected?'✓':'';tick.setAttribute('aria-hidden','true');item.append(tick);
    item.onclick=()=>{select.value=o.value;close(true);select.dispatchEvent(new Event('change',{bubbles:true}));};menu.append(item);
  }
  document.body.append(menu);trigger.setAttribute('aria-expanded','true');
  const r=trigger.getBoundingClientRect();menu.style.maxHeight=Math.max(80,Math.max(r.top,innerHeight-r.bottom)-12)+'px';
  const m=menu.getBoundingClientRect();menu.style.left=Math.max(6,Math.min(innerWidth-m.width-6,r.left))+'px';menu.style.top=Math.max(6,r.top>=m.height+6?r.top-m.height-5:Math.min(innerHeight-m.height-6,r.bottom+5))+'px';
  const items=[...menu.querySelectorAll('button:not(:disabled)')];(items.find(x=>x.getAttribute('aria-selected')==='true')||items[0])?.focus();
  menu.onkeydown=e=>{const i=items.indexOf(document.activeElement);if(e.key==='Escape'){e.preventDefault();close(true);}else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();items[e.key==='Home'?0:e.key==='End'?items.length-1:(i+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}else if(e.key==='Tab')close();};
  document.addEventListener('pointerdown',outside,true);window.addEventListener('resize',resize);document.addEventListener('scroll',scroll,true);
}
