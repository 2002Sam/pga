/* A tiny shared completion inbox. Embedded conversations never create their own pet or poller. */
const PET_KEY = 'pga_pet_inbox_v1:';
let petItems = [], petBox = null, petExpanded = false, petTimer = null, petLoadedFor = null, petPage = 0, petReaction = '';
const petHandled = new Set(), petSince = Date.now()/1000;
function petNative() { try { return !!window.top.PGA_NATIVE?.petNotifications; } catch { return false; } }
function petLoad() {
  if(petLoadedFor === S.uid) return;
  petLoadedFor = S.uid;
  try { const rows=JSON.parse(localStorage.getItem(PET_KEY+S.uid)); petItems=Array.isArray(rows)?rows.filter(x=>x&&typeof x.key==='string'&&typeof x.title==='string'):[]; } catch { petItems=[]; }
}
function petTrim() {
  let read=0; petItems=petItems.filter(x=>!x.read || ++read<=50);
  try { localStorage.setItem(PET_KEY+S.uid,JSON.stringify(petItems)); } catch {}
}
async function stOpenCompleted(key, project) {
  if (S.view !== 'stage') show('stage');
  const current = pmBeginManagerOpen();
  const existing = () => ST.nodes.find(n => n.type === 'win' && n.key === key);
  let node;
  if (existing() || key.startsWith('chat:pm-')) {
    node = stOpen(key, key.startsWith('chat:pm-') && project ? {managerProject:project} : undefined);
  } else {
    if (!project) {
      const canonical = pjCanonical(key);
      const catalog = PJ.catalog?.of?.[canonical] ? PJ.catalog : await pjCatalog();
      if (!current() || S.view !== 'stage') return false;
      project = catalog.of?.[canonical] || pjName(pjRecentByKey(key));
    }
    const {manager} = await pmResolveManager(project);
    if (!current() || S.view !== 'stage') return false;
    if (existing()) node = stOpen(key);
    else {
      const anchor = ST.nodes.find(n => n.type === 'win' && n.key === manager);
      if (!anchor?.managerProject || anchor.managerParked || anchor.small || anchor.mini)
        stOpen(manager, {managerProject:project});
      node = stBringBeside(key, manager);
    }
  }
  if (!node) return false;
  window.stSaw?.(key);
  return ST.focus === node.id;
}
async function petOpen(key) {
  const item = petItems.find(x => x.key === key);
  if (!item) return;
  try {
    if (!await stOpenCompleted(key, item.project)) return;
    item.read = true;
    petTrim(); petDraw();
  } catch (err) { toast(err.message); }
}
function petShow(o) {
  if(petNative())return;
  try { if(window.top!==window)return window.top.petShow?.(o); } catch { return; }
  petLoad();
  const old=petItems.find(x=>x.key===o.key);
  if(old && Date.now()-old.at<15000 && (old.prio||0)>(o.prio||0))return;
  // Store only a compact record, never the caller's iframe, DOM nodes or callbacks.
  const item={key:o.key,project:o.project || old?.project,title:String(o.title||'对话').slice(0,160),text:String(o.text||'').slice(0,260),kind:o.kind||'done',read:false,at:Date.now(),prio:o.prio||0};
  petItems=petItems.filter(x=>x.key!==item.key);petItems.unshift(item);petExpanded=true;petPage=0;petReaction=item.kind==='done'?'done':'attention';petTrim();petDraw();petArm();
}
window.petShow=petShow;
function petArm(){clearTimeout(petTimer);if(petExpanded)petTimer=setTimeout(()=>{petExpanded=false;petDraw();},18000);}
function petDraw(){
  if(!petItems.length)return;
  if(!petBox){
    petBox=document.createElement('aside');petBox.id='pgaPet';petBox.setAttribute('aria-label','PGA 完成会话');document.body.appendChild(petBox);
    petBox.addEventListener('click',e=>{
      const pager=e.target.closest('[data-pet-page]');if(pager){petPage+=Number(pager.dataset.petPage);petDraw();return;}
      const row=e.target.closest('[data-pet-key]');if(row)return petOpen(row.dataset.petKey);
      if(e.target.closest('[data-pet-toggle]')){petExpanded=!petExpanded;petReaction='tap';petDraw();petArm();}
      if(e.target.closest('[data-pet-close]')){petExpanded=false;petDraw();clearTimeout(petTimer);}
    });
    petBox.addEventListener('pointerenter',()=>clearTimeout(petTimer));petBox.addEventListener('pointerleave',petArm);
    petBox.addEventListener('keydown',e=>{if(e.key==='Escape'){petExpanded=false;petDraw();petBox.querySelector('[data-pet-toggle]').focus();}});
  }
  const unread=petItems.filter(x=>!x.read).length, pages=Math.ceil(petItems.length/20); petPage=Math.max(0,Math.min(petPage,pages-1));
  petBox.innerHTML=`${petExpanded?`<section class="pet-bubble"><header><b>${unread?`有 ${unread} 个会话等你来看`:'这些会话处理好了'}</b><button data-pet-close aria-label="收起完成列表">×</button></header><div class="pet-list">${petItems.slice(petPage*20,petPage*20+20).map(x=>`<button data-pet-key="${esc(x.key)}" class="${x.read?'read':''}"><strong>${x.read?'':'● '}${x.kind==='done'?'✓':'!'} ${esc(x.title)}</strong><span>${esc(x.text)}</span></button>`).join('')}</div>${pages>1?`<nav class="pet-pages"><button data-pet-page="-1" ${petPage?'':'disabled'} aria-label="上一页会话">‹</button><span>${petPage+1} / ${pages}</span><button data-pet-page="1" ${petPage<pages-1?'':'disabled'} aria-label="下一页会话">›</button></nav>`:''}</section>`:''}<button class="pet-cat ${petReaction?'pet-'+petReaction:''}" data-pet-toggle aria-expanded="${petExpanded}" aria-label="PGA 魔女猫，${unread} 个未读会话，查看完成列表"><span>${unread?`${unread} 条新消息`:'会话已完成 ✓'}</span><span class="pet-rider"><img src="/icons/witch-cat-broom.webp" width="130" height="87" alt=""></span></button>`;
  petReaction='';
}
function petCompleted(rows) {
  const groups=new Map(), prefix=S.uid+':', present=new Set(rows.map(r=>r.id));
  for(const id of petHandled)if(!present.has(id))petHandled.delete(id);
  for(const r of rows){const tag=String(r.tags?.conversation||'');if(!tag.startsWith(prefix))continue;const key=tag.slice(prefix.length);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(r);}
  const out=[];
  for(const [key,rs] of groups){
    if(rs.some(r=>!r.finished))continue;
    const fresh=rs.filter(r=>!petHandled.has(r.id));fresh.forEach(r=>petHandled.add(r.id));
    const last=fresh.sort((a,b)=>b.finished-a.finished)[0];if(!last||last.finished<petSince)continue;
    out.push({key,run:last});
  }
  return out;
}
let petPolling=false;
async function petPoll(){
  if(window.top!==window||petNative()||!S.uid||petPolling||typeof liveSnap!=='function')return;
  petLoad();if(!petBox&&petItems.length)petDraw();
  petPolling=true;
  try {for(const {key,run} of petCompleted(await liveSnap())){
    const title=typeof stTitle==='function'?stTitle(key):S.chats?.find(c=>c.key===key)?.title||'对话';
    petShow({key,title,kind:run.ok===false?'warn':'done',text:run.ok===false?(run.error||'运行未完成，点击查看'):String(run.text||'做完了，点一下查看').slice(-260)});
  }}catch{}finally{petPolling=false;}
}
if(window.top===window&&!petNative())setInterval(petPoll,2500);
