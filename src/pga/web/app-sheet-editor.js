/* Local XLSX editing: a compact toolbar and native inputs inside cells. */
// Excel quotes fields containing tabs, newlines or double quotes.
export function clipboardRows(text) {
  const rows = [], row = [];
  let field = '', quoted = false;
  text = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && (quoted || !field)) {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (ch === '\t' || ch === '\n')) {
      row.push(field);
      field = '';
      if (ch === '\n') rows.push(row.splice(0));
    } else field += ch;
  }
  if (field || row.length || !text.endsWith('\n')) rows.push([...row, field]);
  return rows;
}

export async function mountSheetEditor(en,host,{api,toast,fpStatus,fpBanner}) {
  const style=document.createElement('style');
  style.textContent=`
  #pgaFilePanel:has(.fileview:not([hidden]) .filemode:not([hidden]) .pga-sheet) > .fp-crumbs,
  #pgaFilePanel:has(.fileview:not([hidden]) .filemode:not([hidden]) .pga-sheet) > .fp-status,
  #pgaFilePanel .fileview:has(.filemode:not([hidden]) .pga-sheet) > .fp-doc-tools,
  #pgaFilePanel .fileview:has(.filemode:not([hidden]) .pga-sheet) > .filemodes{display:none!important}
  #pgaFilePanel .pga-sheet{display:flex;flex-direction:column;position:relative;height:100%;min-height:100px;color:var(--text,#222);font:13px system-ui;background:var(--bg,#fff);padding:0!important}
  #pgaFilePanel .pga-sheet .sheet-tools{display:flex;align-items:center;gap:6px;flex-wrap:nowrap;height:36px;min-height:36px;box-sizing:border-box;padding:4px 8px;border-bottom:1px solid #8884;overflow-x:auto;overflow-y:hidden;flex-shrink:0}
  #pgaFilePanel .pga-sheet button,#pgaFilePanel .pga-sheet select,#pgaFilePanel .pga-sheet input{font:12px system-ui!important;line-height:18px!important;color:inherit;background:var(--bg,#fff);border:1px solid #8885;border-radius:4px!important;padding:2px 6px!important;height:26px!important;min-height:0!important;box-shadow:none!important;flex-shrink:0;box-sizing:border-box}
  #pgaFilePanel .pga-sheet button{cursor:pointer}#pgaFilePanel .pga-sheet button:disabled{opacity:.4;cursor:default}
  #pgaFilePanel .pga-sheet .sheet-tools select{max-width:160px}#pgaFilePanel .pga-sheet .sheet-search{width:160px;min-width:70px;flex:0 1 160px}
  #pgaFilePanel .pga-sheet .sheet-count{margin-left:auto;font-size:11px;white-space:nowrap;opacity:.7}
  #pgaFilePanel .pga-sheet .sheet-address{font:11px monospace;min-width:28px;text-align:center;opacity:.7}
  #pgaFilePanel .pga-sheet .sheet-scroll{flex:1;overflow:auto;min-height:0;position:relative}
  #pgaFilePanel .pga-sheet table{border-collapse:separate;border-spacing:0;font:13px system-ui;table-layout:fixed;margin:0}
  #pgaFilePanel .pga-sheet th,#pgaFilePanel .pga-sheet td{border-right:1px solid #8883;border-bottom:1px solid #8883;padding:7px;min-width:140px;max-width:240px;white-space:pre-wrap;overflow-wrap:anywhere;vertical-align:top;box-sizing:border-box}
  #pgaFilePanel .pga-sheet td{position:relative;cursor:text;height:34px}#pgaFilePanel .pga-sheet td>div{max-height:76px;overflow:hidden;line-height:19px}
  #pgaFilePanel .pga-sheet td.selected{outline:2px solid #3185db;outline-offset:-2px;background:#3185db12}#pgaFilePanel .pga-sheet td.changed{background:#ffc53124}
  #pgaFilePanel .pga-sheet td.formula{color:var(--dim,#888);cursor:default}
  #pgaFilePanel .pga-sheet th{position:sticky;top:0;background:var(--bg,#eee);z-index:2;text-align:center}
  #pgaFilePanel .pga-sheet th:first-child{left:0;min-width:44px;width:44px;z-index:3}#pgaFilePanel .pga-sheet tbody th{top:auto!important;left:0;z-index:1}
  #pgaFilePanel .pga-sheet textarea.sheet-cell-input,#pgaFilePanel .pga-sheet select.sheet-cell-input{position:absolute;inset:0;width:100%;height:100%!important;min-height:32px!important;margin:0!important;padding:7px!important;border:2px solid #3185db!important;border-radius:0!important;resize:none;box-shadow:none!important;background:var(--bg,#fff);color:var(--text,#222);font:13px/19px system-ui!important;box-sizing:border-box;outline:none;z-index:4}
  #pgaFilePanel .pga-sheet td:has(.sheet-cell-input){min-height:34px}#pgaFilePanel .pga-sheet td:has(.sheet-cell-input)>div{visibility:hidden}
  #pgaFilePanel .pga-sheet .sheet-error{color:#cf4438;background:var(--bg,#fff);font-size:12px;padding:5px 8px;border-bottom:1px solid #8883;flex-shrink:0}#pgaFilePanel .pga-sheet .sheet-error:empty{display:none}
  #pgaFilePanel .pga-sheet .sheet-menu{position:absolute;right:8px;top:35px;z-index:12;min-width:160px;padding:6px;border:1px solid #8885;border-radius:6px;background:var(--bg,#fff);box-shadow:0 5px 20px #0002;display:flex;flex-direction:column;gap:4px}
  #pgaFilePanel .pga-sheet [hidden]{display:none!important}#pgaFilePanel .pga-sheet .sheet-menu button{text-align:left}#pgaFilePanel .pga-sheet a{font-size:12px;white-space:nowrap;color:#3185db}
  `;host.append(style);
  const box=document.createElement('section');box.className='pga-sheet';box.setAttribute('aria-label','Excel编辑器');host.append(box);
  box.innerHTML=`<div class="sheet-tools" role="toolbar" aria-label="表格工具"><select aria-label="工作表"></select><input class="sheet-search" aria-label="搜索表格" placeholder="搜索公司、岗位"><span class="sheet-address">—</span><button data-undo disabled title="撤销上一次单元格修改">撤销</button><button data-save disabled title="保存到Excel（⌘S / Ctrl+S）">保存</button><a data-link hidden target="_blank" rel="noopener noreferrer">打开链接 ↗</a><span class="sheet-count"></span><button data-help title="点击单元格直接输入；Enter 换行到下一格，Tab 向右，Alt+Enter 输入换行，Esc 取消本格编辑。公式只读，在 Excel/WPS 中重新计算。" aria-label="编辑帮助">?</button><button data-more aria-label="更多表格操作" aria-expanded="false">⋯</button></div><div class="sheet-menu" hidden><button data-action="preview">预览原表</button><button data-action="reload">重新载入</button><button data-action="external">用系统应用编辑</button><button data-action="copy">复制文件路径</button><button data-action="back">返回会话</button></div><div role="status" class="sheet-error"></div><div class="sheet-scroll"></div>`;
  const tabs=box.querySelector('select'),search=box.querySelector('input'),undo=box.querySelector('[data-undo]'),saveButton=box.querySelector('[data-save]'),err=box.querySelector('.sheet-error'),grid=box.querySelector('.sheet-scroll'),link=box.querySelector('[data-link]'),menu=box.querySelector('.sheet-menu'),more=box.querySelector('[data-more]');
  let data,current=0,selected=null,editor=null,changes=new Map(),history=[],loading=false;
  const letter=n=>{let s='';for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
  const key=(sheet,cell)=>JSON.stringify([sheet,cell]);
  const sheet=()=>data?.sheets[current];
  const value=ref=>changes.get(key(sheet().name,ref))||sheet().cells[ref]||{value:'',type:'text'};
  const locate=ref=>{const m=/^([A-Z]+)(\d+)$/.exec(ref);return [+m[2],[...m[1]].reduce((a,c)=>a*26+c.charCodeAt(0)-64,0)];};
  const contains=(ref,range)=>{const [a,b=a]=range.replaceAll('$','').split(':'),[r,c]=locate(ref),[r1,c1]=locate(a),[r2,c2]=locate(b);return r>=r1&&r<=r2&&c>=c1&&c<=c2;};
  const cell=ref=>grid.querySelector(`[data-cell="${ref}"]`);
  const text=v=>v.formula!==undefined?'[公式] '+String(v.value||v.formula):String(v.value??'');
  function dirty(){
    const draft=editor&&editor.el.value!==String(value(editor.ref).value??'');
    en.dirty=changes.size>0||!!draft;en.tab.classList.toggle('dirty',en.dirty);
    undo.disabled=(!history.length&&!draft)||en.saving;saveButton.disabled=!en.dirty||en.saving;
    saveButton.textContent=en.saving?'保存中…':'保存';
    box.querySelector('.sheet-count').textContent=en.saving?'正在保存':en.dirty?'● 未保存':'已保存';fpStatus(en);
  }
  function paint(ref){const td=cell(ref);if(!td)return;td.querySelector('div').textContent=text(value(ref));td.classList.toggle('changed',changes.has(key(sheet().name,ref)));}
  function endEditor(){if(editor){const el=editor.el;editor=null;el.remove();}dirty();}
  function commit(){
    if(!editor)return true;
    if(editor.composing)return false;
    const ref=editor.ref;
    try { apply([prepare(ref, editor.el.value)]); }
    catch(e){err.textContent=e.message;dirty();return false;}
    endEditor();paint(ref);err.textContent='';dirty();return true;
  }
  function prepare(ref,val){
    const old=value(ref);let type=sheet().cells[ref]?.type||old.type||'text';
    if(val===String(old.value??''))return null;
    if(type==='number'&&val!==''){
      if(!val.trim()||!Number.isFinite(Number(val))){throw Error('请输入有效数字');}val=Number(val);
    }else if(type==='boolean'){
      if(!['true','false'].includes(val.toLowerCase())){throw Error('请输入 true 或 false');}val=val.toLowerCase()==='true';
    }else if(type==='date'&&!/^\d{4}-\d{2}-\d{2}$/.test(val)){throw Error('日期请输入 YYYY-MM-DD');}
    if(val===''&&type!=='date')type='text';
    const k=key(sheet().name,ref),original=sheet().cells[ref]||{value:'',type:'text'};
    return {k, ref, next:val===original.value&&type===original.type?null:{sheet:sheet().name,cell:ref,value:val,type}};
  }
  function apply(edits){
    const batch=edits.filter(Boolean);
    if(!batch.length)return;
    history.push(batch.map(({k})=>({k,before:changes.get(k)})));
    for(const {k,next} of batch){if(next)changes.set(k,next);else changes.delete(k);}
  }
  grid.addEventListener('paste',e=>{
    const anchor=e.target.closest('td[data-cell]');
    const raw=e.clipboardData?.getData('text/plain');
    if(!anchor||!raw||editor?.composing||loading||en.saving)return;
    const table=e.clipboardData.getData('text/html').match(/<table[\s>]/i);
    if(!table&&!raw.includes('\t')&&e.target.tagName==='TEXTAREA'&&!/[\r\n]/.test(raw))return;
    e.preventDefault();
    const [r,c]=locate(anchor.dataset.cell),s=sheet(),edits=[];
    try {
      clipboardRows(raw).forEach((row,i)=>row.forEach((val,j)=>{
        const ref=letter(c+j-1)+(r+i);
        if(!cell(ref)||s.protected||s.hidden||value(ref).formula!==undefined||
           s.merges.some(a=>contains(ref,a)&&a.replaceAll('$','').split(':')[0]!==ref))
          throw Error(ref+' 超出可编辑区域');
        const list=s.choices.find(d=>d.ranges.some(a=>contains(ref,a)));
        if(list&&val&&val!==String(value(ref).value)&&!list.values.includes(val))throw Error(ref+' 请选择有效选项');
        try { edits.push(prepare(ref,val)); } catch(error){throw Error(ref+' '+error.message);}
      }));
    } catch(error){err.textContent=error.message;return;}
    endEditor();apply(edits);render();cell(anchor.dataset.cell)?.focus();err.textContent='';
  });
  function select(ref){
    selected=ref;box.querySelector('.sheet-address').textContent=ref;
    grid.querySelectorAll('.selected').forEach(n=>n.classList.remove('selected'));cell(ref)?.classList.add('selected');
    let url=String(value(ref).value??'');const formula=sheet().cells[ref]?.formula;
    const m=formula&&/^HYPERLINK\(\s*([A-Z]+\d+|"[^"]+")/i.exec(formula);
    if(m)url=m[1].startsWith('"')?m[1].slice(1,-1):String(value(m[1]).value??'');
    link.hidden=!/^https?:\/\//i.test(url);if(!link.hidden)link.href=url;
  }
  function start(ref){
    if(en.saving||loading||editor?.ref===ref)return;
    if(!commit()){editor?.el.focus();return;}
    const td=cell(ref);if(!td)return;
    select(ref);const s=sheet(),v=value(ref);err.textContent='';
    const merged=s.merges.some(a=>contains(ref,a)&&a.replaceAll('$','').split(':')[0]!==ref);
    if(s.protected||s.hidden||merged||v.formula!==undefined){
      td.focus({preventScroll:true});
      td.title=merged?'请编辑合并区域的左上角':v.formula!==undefined?'公式只读，原公式会保留':'工作表只读';
      return;
    }
    const list=s.choices.find(d=>d.ranges.some(a=>contains(ref,a)));
    const input=document.createElement(list?'select':'textarea');input.className='sheet-cell-input';input.setAttribute('aria-label',list?'状态选项':`${ref} 单元格内容`);
    if(list){for(const x of new Set(['',...list.values,String(v.value??'')]))input.add(new Option(x||'（空白）',x));}
    else{input.spellcheck=false;input.wrap='soft';}
    input.value=String(v.value??'');editor={el:input,ref,composing:false};td.append(input);
    input.addEventListener('click',e=>e.stopPropagation());
    input.addEventListener('input',dirty);
    input.addEventListener('compositionstart',()=>{if(editor?.el===input)editor.composing=true;});
    input.addEventListener('compositionend',()=>{if(editor?.el===input)editor.composing=false;dirty();});
    input.addEventListener('blur',()=>{if(editor?.el===input&&!editor.composing)commit();});
    if(list)input.addEventListener('change',()=>{if(commit())td.focus({preventScroll:true});});
    input.addEventListener('keydown',e=>{
      if(e.isComposing||editor?.composing||e.keyCode===229)return;
      if(e.key==='Escape'){e.preventDefault();e.stopPropagation();endEditor();paint(ref);err.textContent='';td.focus({preventScroll:true});}
      else if(e.key==='Enter'&&e.altKey&&!list){e.preventDefault();input.setRangeText('\n',input.selectionStart,input.selectionEnd,'end');dirty();}
      else if(e.key==='Enter'||e.key==='Tab'){
        e.preventDefault();e.stopPropagation();if(!commit())return;
        const [r,c]=locate(ref);let next;
        if(e.key==='Enter')next=letter(c-1)+(r+(e.shiftKey?-1:1));
        else{const cells=[...grid.querySelectorAll('td[data-cell]')];next=cells[cells.indexOf(td)+(e.shiftKey?-1:1)]?.dataset.cell;}
        if(next&&cell(next)){cell(next).scrollIntoView({block:'nearest',inline:'nearest'});start(next);}else td.focus({preventScroll:true});
      }
    });
    input.focus({preventScroll:true});if(!list)input.setSelectionRange(input.value.length,input.value.length);dirty();
  }
  function render(){
    const s=sheet();if(!s)return;
    const table=document.createElement('table'),head=table.createTHead().insertRow();head.append(document.createElement('th'));
    for(let c=0;c<s.cols;c++){const th=document.createElement('th');th.textContent=letter(c);head.append(th);}
    const body=table.createTBody(),q=search.value.trim().toLowerCase();let shown=0;
    for(let r=1;r<=s.rows;r++){
      const vals=Array.from({length:s.cols},(_,c)=>value(letter(c)+r));
      if(q&&!vals.some(v=>String(v.value??'').toLowerCase().includes(q)))continue;if(shown++>=300)break;
      const tr=body.insertRow(),th=document.createElement('th');th.textContent=r;tr.append(th);
      vals.forEach((v,c)=>{
        const td=tr.insertCell(),ref=letter(c)+r,content=document.createElement('div');td.dataset.cell=ref;td.tabIndex=0;
        content.textContent=text(v);td.append(content);td.title=`${ref} · ${v.formula!==undefined?'公式只读':'点击直接输入'}`;
        td.classList.toggle('formula',v.formula!==undefined);td.classList.toggle('changed',changes.has(key(s.name,ref)));
        td.onclick=()=>start(ref);td.addEventListener('keydown',e=>{if(e.target!==td)return;if(e.key==='Enter'||e.key==='F2'){e.preventDefault();start(ref);}});
      });
    }
    grid.replaceChildren(table);if(selected)select(selected);dirty();
    if(shown>300||s.truncated)err.textContent='最多显示300个匹配行，可通过搜索定位。';
  }
  tabs.onchange=()=>{if(!commit()){tabs.value=current;return;}current=+tabs.value;selected=null;link.hidden=true;box.querySelector('.sheet-address').textContent='—';err.textContent='';render();grid.scrollTop=0;};
  search.oninput=()=>{if(commit()){render();grid.scrollTop=0;}};
  undo.onclick=()=>{
    if(editor&&editor.el.value!==String(value(editor.ref).value??'')){const ref=editor.ref;endEditor();paint(ref);err.textContent='';return;}
    if(!commit())return;const h=history.pop();if(!h)return;for(const {k,before} of h){if(before)changes.set(k,before);else changes.delete(k);}render();
  };
  const closeMenu=()=>{menu.hidden=true;more.setAttribute('aria-expanded','false');};
  more.onclick=()=>{menu.hidden=!menu.hidden;more.setAttribute('aria-expanded',String(!menu.hidden));};
  box.addEventListener('click',e=>{if(!menu.contains(e.target)&&e.target!==more)closeMenu();});
  box.querySelector('[data-help]').onclick=e=>toast(e.currentTarget.title);
  menu.onclick=async e=>{
    const action=e.target.dataset.action;if(!action)return;closeMenu();
    if(action==='reload'){
      if(en.dirty&&!confirm('放弃未保存的修改并重新载入？'))return;await reload(true);return;
    }
    if(!commit())return;
    if(action==='preview')en.body.querySelector('.filemodes [data-m="table"]')?.click();
    else en.body.closest('#pgaFilePanel')?.querySelector({'external':'[data-file-system]','copy':'[data-file-copy]','back':'[data-file-origin]'}[action])?.click();
  };
  async function reload(discard=false){
    if(loading||en.saving||(!discard&&en.dirty))return;
    loading=true;box.inert=true;err.textContent='正在读取表格…';
    try{
      const d=await api(`/v1/users/${en.uid}/files/sheet`,{body:{path:en.path,key:en.key}});
      endEditor();data=d;en.info.mtime=d.mtime;current=Math.min(current,d.sheets.length-1);changes.clear();history=[];tabs.replaceChildren();
      d.sheets.forEach((s,i)=>tabs.add(new Option(s.name+(s.hidden?'（隐藏）':''),i)));tabs.value=current;selected=null;link.hidden=true;box.querySelector('.sheet-address').textContent='—';
      en.conflict=null;fpBanner(en);en.onReload?.();render();err.textContent='';
    }catch(e){err.textContent=e.message;}finally{loading=false;box.inert=false;}
  }
  async function save(){
    if(en.saving||loading||!commit()||!changes.size)return;
    en.saving=true;box.inert=true;dirty();err.textContent='';
    try{
      const sent=[...changes.values()],result=await api(`/v1/users/${en.uid}/files/sheet/save`,{body:{path:en.path,key:en.key,version:data.version,changes:sent}});
      for(const x of sent)data.sheets.find(s=>s.name===x.sheet).cells[x.cell]={value:x.value,type:x.type};
      data.version=result.version;en.info.mtime=result.mtime;en.info.size=result.size;changes.clear();history=[];en.conflict=null;fpBanner(en);en.onSave?.();toast('已保存到Excel，原版本已自动备份');render();
    }catch(e){err.textContent=/409|别处/.test(e.message)?'文件已被其他窗口修改。草稿已保留，请复制需要保留的内容，再从「⋯」重新载入。':e.message;}
    finally{en.saving=false;box.inert=false;dirty();}
  }
  en.sheetEditor={save,reload};saveButton.onclick=save;await reload();
}
