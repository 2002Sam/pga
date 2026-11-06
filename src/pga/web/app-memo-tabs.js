/* Conversation-linked memo tabs. Closing a tab never deletes its Markdown file. */
const MT = { open:false, active:null, busy:false };
function mtState(){return mmStore.get(`pga:memo-tabs:${S.uid}`,{tabs:[],links:{}});}
function mtStore(s){localStorage.setItem(`pga:memo-tabs:${S.uid}`,JSON.stringify(s));}
function mtHost(){try{return window.top.memoWindowOpen?window.top:window;}catch{return window;}}
function mtShell(){
 let panel=document.getElementById('memoTabsPanel');if(panel)return panel;
 panel=document.createElement('aside');panel.id='memoTabsPanel';panel.innerHTML='<header><div class="mt-tabs" role="tablist"></div><button data-mt-new title="新备忘">＋</button><button data-mt-history title="重新打开备忘">▾</button><button data-mt-hide title="收起备忘">×</button></header><div class="mt-pages"></div>';
 (Q.get("memoWorkspace") ? document.body : (document.getElementById("vChats") || document.body)).append(panel);return panel;
}
function mtDraw(){
 const s=mtState(),p=mtShell();p.hidden=!MT.open;
 document.getElementById("vChats")?.classList.toggle("memo-side-open",MT.open);
 p.querySelector('.mt-tabs').innerHTML=s.tabs.map(id=>`<div class="mt-tab ${id===MT.active?'on':''}"><button role="tab" aria-selected="${id===MT.active}" data-mt-tab="${esc(id)}">${esc(MM.titles[id]||'新备忘')}</button><button data-mt-close="${esc(id)}" title="关闭标签，内容保留">×</button></div>`).join('');
 p.querySelectorAll('[data-mt-page]').forEach(el=>el.hidden=el.dataset.mtPage!==MT.active);
}
async function mtSelect(id){
 const panel=mtShell();let w=MM.wins.find(w=>w.id===id && w.tabbed);
 if(!w){
  const r=await api(`/v1/users/${S.uid}/memos/${id}`);
  const el=document.createElement('section');el.dataset.mtPage=id;el.className='mt-page';el.innerHTML='<div class="mt-status"><span class="memot"></span><span class="memost"></span></div><div class="memob"></div>';panel.querySelector('.mt-pages').append(el);
  w={id,rev:r.rev,blocks:mmParse(r.text),el,dirty:false,tabbed:true};MM.wins.push(w);memoBody(w);memoHead(w);
  el.addEventListener('input',()=>{clearTimeout(MT.titleTimer);MT.titleTimer=setTimeout(mtDraw,800);});
  el.addEventListener('click',e=>{const dot=e.target.closest('[data-mdot]');if(dot)memoDotMenu(w,Number(dot.dataset.mdot),dot);const ref=e.target.closest('[data-mref]');if(ref)memoOpenRef(w.blocks[Number(ref.dataset.mref)]);});
 }
 MT.active=id;mtDraw();w.el.querySelectorAll('textarea').forEach(memoFit);
}
async function pmemoOpen(key, fresh=false){
 if(MT.busy)return;MT.busy=true;
 try{
  if(!key)throw Error('请先打开一段对话');MT.chat=key;
  const s=mtState();let id=!fresh?s.links[key]:null;
  if(!id){const r=await api(`/v1/users/${S.uid}/memos`,{method:'POST',body:{}});id=r.id;s.links[key]=id;}
  if(!s.tabs.includes(id))s.tabs.push(id);mtStore(s);MT.open=true;await mtSelect(id);
 }catch(e){toast(e.message);}finally{MT.busy=false;}
}
window.pmemoOpen=pmemoOpen;
async function mtFollow(key){if(MT.open&&key&&mtState().links[key])await pmemoOpen(key);}
window.pmemoFollow=mtFollow;
document.addEventListener('click',async e=>{
 const open=e.target.closest('[data-chat-memo]');if(open){e.preventDefault();const key=open.dataset.chatMemo||S.chat;mtHost().memoWindowOpen(key);return;}
 if(!e.target.closest('#memoTabsPanel'))return;
 try{
  const tab=e.target.closest('[data-mt-tab]'),close=e.target.closest('[data-mt-close]');
  if(tab){await mtSelect(tab.dataset.mtTab);return;}
  if(close){const id=close.dataset.mtClose,w=MM.wins.find(w=>w.id===id&&w.tabbed);if(w){await memoSave(w);if(w.dirty)throw Error('保存未成功，标签暂不关闭');}const s=mtState();s.tabs=s.tabs.filter(x=>x!==id);mtStore(s);if(MT.active===id)MT.active=s.tabs.at(-1)||null;mtDraw();if(MT.active)await mtSelect(MT.active);return;}
  if(e.target.closest('[data-mt-new]'))await pmemoOpen(MT.chat,true);
  if(e.target.closest('[data-mt-hide]')){for(const w of MM.wins.filter(w=>w.tabbed))await memoSave(w);MT.open=false;mtDraw();}
  if(e.target.closest('[data-mt-history]')){
   const r=await api(`/v1/users/${S.uid}/memos`);const select=document.createElement('select');select.innerHTML='<option value="">重新打开…</option>'+r.memos.map(m=>`<option value="${esc(m.id)}">${esc(m.title||'新备忘')}</option>`).join('');
   select.onchange=async()=>{if(!select.value)return;const s=mtState();if(!s.tabs.includes(select.value))s.tabs.push(select.value);if(MT.chat)s.links[MT.chat]=select.value;mtStore(s);await mtSelect(select.value);select.remove();};mtShell().querySelector('header').append(select);select.focus();
  }
 }catch(err){toast(err.message);}
});
if(typeof loadChat==='function'){const original=loadChat;loadChat=async function(key,...args){const r=await original(key,...args);mtHost().pmemoFollow?.(key);return r;};}

function memoWindowOpen(key){
 if(!key){toast('请先打开一段对话');return;}
 if(S.view!=='stage')show('stage');
 const source=ST.nodes.find(n=>n.key===key&&n.type==='win');
 let n=ST.nodes.find(n=>n.memoSource===key);
 stFreezeWidths();
 if(!n){n={id:'memo-tabs-'+Date.now().toString(36),type:'win',memo:'tabs:'+key,memoSource:key,bw:480,ord:0};ST.nodes.push(n);}
 const order=stWins().filter(w=>w!==n),i=source?order.indexOf(source)+1:order.length;
 order.splice(i,0,n);order.forEach((w,j)=>w.ord=j);
 n.mini=false;delete n.small;(ST.stageOpen ||=new Set()).add(n.id);ST.focus=n.id;
 stRender();stSave();stShow(n.id);
}
window.memoWindowOpen=memoWindowOpen;
if(Q.get('memoWorkspace')){
 document.documentElement.classList.add('memo-workspace');
 const key=Q.get('memoWorkspace');
 const ready=setInterval(()=>{if(!S.uid)return;clearInterval(ready);pmemoOpen(key);},100);
}
