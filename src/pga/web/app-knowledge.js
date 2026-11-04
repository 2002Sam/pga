/* Conversation knowledge capture and its live Markdown document page. */
const KN = { items: new Map(), timers: new Map(), pending: new Set() };
const knowledgeKey = () => S.chat || S.imp?.key || S.lineTarget || ('*new:' + (typeof stageNodeOf === 'function' ? stageNodeOf()?.n.id || '' : ''));
function knowledgeEnabled() {
  try { return localStorage.getItem(`pga_knowledge:${S.uid}:${knowledgeKey()}`) === '1'; } catch { return S.knowledgeFor === knowledgeKey(); }
}
function knowledgeSet(on, key = knowledgeKey()) {
  S.knowledgeFor = on ? key : null;
  try { localStorage.setItem(`pga_knowledge:${S.uid}:${key}`, on ? '1' : '0'); } catch {}
  try { const h = stageNodeOf(); if(h?.n) { h.n.captureKnowledge = on; h.P?.stSave?.(); } } catch {}
  knowledgeSyncButtons();
}
function knowledgeToggle() { knowledgeSet(!knowledgeEnabled()); rerenderComposer(); }
function knowledgeSyncButtons() {
  try {
    const host = knowledgeHost();
    for (const n of host.ST?.nodes || []) {
      const frame = n.el?.querySelector('iframe');
      if(frame?.contentWindow !== window) continue;
      n.captureKnowledge = knowledgeEnabled();
      const b=n.el.querySelector('[data-stw="knowledge"]');
      if(b){b.classList.toggle('on',n.captureKnowledge);b.setAttribute('aria-pressed',String(n.captureKnowledge));}
      host.stSave();
    }
  } catch {}
}
function knowledgeTool() {
  const on = knowledgeEnabled();
  return `<button class="ghost knowledge-toggle ${on ? 'on' : ''}" data-knowledge-toggle aria-pressed="${on}" title="${L('开启后，每次发送都会保存知识汇总，并打开实时文档；再次点击关闭', 'Save a live knowledge document with each message; click again to turn off')}">${on ? L('知识汇总 ✓', 'Knowledge ✓') : L('知识汇总', 'Capture knowledge')}</button><button class="ghost" data-knowledge-list title="${L('查看已保存的知识汇总', 'Saved knowledge notes')}">${L('已存', 'Saved')}</button>`;
}
function knowledgeHost() { try { if (window.top !== window && typeof window.top.knowledgeShow === 'function') return window.top; } catch {} return window; }
async function knowledgePrepare(key, text, agent) {
  const version = await api('/v1/version');
  if (!version.knowledge_capture) throw new Error(L('知识汇总功能正在等待后台重载，输入已保留，请稍后再试', 'Waiting for the knowledge feature to reload. Your draft is kept.'));
  const item = await api(`/v1/users/${S.uid}/knowledge-notes`, { body: { conversation: key, title: text.slice(0, 100), agent } });
  const origin = typeof stageNodeOf === 'function' ? stageNodeOf() : null;
  if (origin?.n && !origin.n.key) { origin.n.key = key; origin.P.stSave(); }
  knowledgeHost().knowledgeShow(item, key);
  return item;
}
function knowledgeAgent(selected, turns) {
  if (selected && selected !== 'auto') return selected;
  const last = [...turns].reverse().find(t => t.role !== 'user' && t.agent && S.agents.some(a => a.name === t.agent));
  return last?.agent || selected || 'auto';
}
function knowledgeTitle(n) { return '📚 ' + (KN.items.get(n.knowledge)?.title || L('知识汇总', 'Knowledge note')); }
function knowledgeWinHtml(n) {
  return `<div class="stwin stknowledgewin">${['e','w','n','s','ne','nw','se','sw'].map(d => `<i class="rz rz-${d}" data-rz="${d}"></i>`).join('')}
    <div class="stwh" data-stfocus="${n.id}"><b class="stwt">📚 <span class="knowledge-title">${L('知识汇总', 'Knowledge note')}</span></b><span class="grow"></span><button class="stb" data-stw="min">–</button><button class="stb" data-stw="max">▢</button><button class="stb" data-stw="close" title="${L('关闭窗口，文件仍保留', 'Close; the file stays saved')}">×</button></div>
    <div class="knowledge-body"></div></div>`;
}
function knowledgeShow(item, source) {
  KN.items.set(item.id, item);
  if (S.view === 'stage') {
    let n = ST.nodes.find(x => x.knowledge === item.id);
    if (!n) {
      const parent = ST.nodes.find(x => x.key === source && !x.knowledge);
      n = { id: 'knowledge-' + item.id, type: 'win', knowledge: item.id, knowledgeSource: source,
        ord: parent ? (parent.ord || 0) + .5 : stWins().length, bw: 460, ...(parent?.ws ? {ws:parent.ws} : {}) };
      ST.nodes.push(n); stWins().forEach((x,i) => { x.ord=i; });
    }
    n.knowledgeOpened = Date.now(); delete n.pre;
    n.mini = false; ST.focus=n.id; stRender(); stSave(); stShow(n.id);
    if (n.el) knowledgeMount(n,n.el);
  } else {
    let panel = document.getElementById('knowledge-floating');
    if (!panel) { panel=document.createElement('section'); panel.id='knowledge-floating'; document.body.append(panel); }
    panel.hidden=false; panel.dataset.knowledge=item.id;
    panel.innerHTML=`<header><b>📚 ${L('知识汇总', 'Knowledge note')}</b><button data-knowledge-hide>×</button></header><div class="knowledge-body"></div>`;
    panel.querySelector('[data-knowledge-hide]').onclick=()=>{panel.hidden=true;};
    knowledgeDraw(panel,item);
  }
  knowledgeWatch(item.id);
}
function knowledgeDraw(el, item) {
  const label = {queued:L('等待发送…','Waiting to send…'),generating:L('当前 agent 正在回答并整理…','The current agent is answering and organizing…'),ready:L('已保存并加入知识库','Saved and indexed'),saved:L('文件已保存，索引待处理','File saved; indexing pending'),failed:L('未完成整理','Not completed')}[item.status] || item.status;
  const title=el.querySelector('.knowledge-title'); if(title)title.textContent=item.title;
  const content = (item.text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
  const body=el.querySelector('.knowledge-body'); if(!body)return;
  const top=body.scrollTop, follow=body.scrollTop + body.clientHeight >= body.scrollHeight - 60;
  const signature=JSON.stringify([item.status,item.text,item.error,item.path]); if(body.dataset.signature===signature)return; body.dataset.signature=signature;
  body.innerHTML=`<div class="knowledge-status ${item.status}">${['queued','generating'].includes(item.status)?'<i class="spin"></i> ':''}${esc(label)}</div>
    <div class="knowledge-location">${esc([item.project,item.topic].filter(Boolean).join(' › '))}</div>
    ${item.error?`<div class="knowledge-error">${esc(item.error)}</div>`:''}
    ${content?`<div class="md">${md(content)}</div>`:`<div class="knowledge-empty">${L('汇总会保留结论、数据与证据、适用范围、未确认事项及来源。生成过程中会持续更新。','The summary will keep conclusions, evidence, scope, uncertainties, and sources.')}</div>`}
    <footer><button class="ghost" data-knowledge-source="${esc(item.conversation)}">${L('↗ 来源对话','↗ Source conversation')}</button><div class="knowledge-path">${esc(item.path || '')}</div>${content?`<button class="ghost" data-knowledge-open="${item.id}">${L('打开 Markdown 文件','Open Markdown file')}</button>`:''}</footer>`;
  body.scrollTop=follow ? body.scrollHeight : top;
}
async function knowledgeRefresh(id) {
  if(KN.pending.has(id))return;
  KN.pending.add(id);
  try {
    const item=await api(`/v1/users/${S.uid}/knowledge-notes/${id}`); KN.items.set(id,item);
    document.querySelectorAll(`[data-knowledge="${id}"]`).forEach(el=>knowledgeDraw(el,item));
    if (!['queued','generating'].includes(item.status)) { clearInterval(KN.timers.get(id));KN.timers.delete(id); }
    return item;
  } catch(err) { console.warn('knowledge refresh',err.message); }
  finally { KN.pending.delete(id); }
}
function knowledgeWatch(id) {
  if(KN.timers.has(id))return;
  knowledgeRefresh(id);
  if(['ready','saved','failed'].includes(KN.items.get(id)?.status))return;
  KN.timers.set(id,setInterval(()=>{
    if(!document.querySelector(`[data-knowledge="${id}"]`)){clearInterval(KN.timers.get(id));KN.timers.delete(id);return;}
    knowledgeRefresh(id);
  },1500));
}
function knowledgeMount(n,el) { el.dataset.knowledge=n.knowledge;const item=KN.items.get(n.knowledge);if(item)knowledgeDraw(el,item);knowledgeWatch(n.knowledge); }
async function knowledgeList() {
  const host=knowledgeHost(); if(host!==window)return host.knowledgeList();
  try { const r=await api(`/v1/users/${S.uid}/knowledge-notes`);for(const item of r.notes)KN.items.set(item.id,item);
    modal(`<h3>${L('已保存的知识汇总','Knowledge notes')}</h3>${r.notes.map(item=>`<button class="knowledge-row" data-knowledge-show="${item.id}"><b>${esc(item.title)}</b><span>${esc([item.project,item.topic,item.status==='ready'?L('已保存','Saved'):item.status].filter(Boolean).join(' · '))}</span></button>`).join('')||L('还没有知识汇总','No knowledge notes yet')}`);
  }catch(err){toast(err.message);}
}
document.addEventListener('click',async e=>{
  const t=e.target.closest('[data-knowledge-toggle],[data-knowledge-list],[data-knowledge-open],[data-knowledge-show],[data-knowledge-source]');if(!t)return;
  e.preventDefault();
  if(t.hasAttribute('data-knowledge-toggle')) {knowledgeToggle();return;}
  if(t.dataset.knowledgeSource) {const host=knowledgeHost();host.stOpen(t.dataset.knowledgeSource);return;}
  if(t.hasAttribute('data-knowledge-list')) {knowledgeList();return;}
  if(t.dataset.knowledgeShow) {const item=KN.items.get(t.dataset.knowledgeShow);document.querySelector('.modal')?.remove();if(item)knowledgeShow(item,item.conversation);return;}
  const item=KN.items.get(t.dataset.knowledgeOpen);if(item)openPgaFile(item.path,item.conversation);
});
