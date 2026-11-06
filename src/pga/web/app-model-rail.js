/* Model presets affect the next submission in the focused conversation. */
const MR_KEY = 'pga_model_presets_v1';
const MR_DEFAULTS = [
  ['DeepSeek','deepseek','deepseek-chat',''],
  ['ChatGPT Astra · 中','chatgpt','gpt-6-astra','medium'],
  ['ChatGPT Astra · 高','chatgpt','gpt-6-astra','high'],
  ['Codex · 中','codex','gpt-6-astra','medium'],
  ['Codex · 高','codex','gpt-6-astra','high'],
  ['Sonnet · 中','claude','sonnet','medium'],
  ['Opus · 中','claude','opus','medium'],
  ['Opus · 高','claude','opus','high'],
  ['Opus · Extra','claude','opus','xhigh'],
].map(([label,agent,model,effort])=>({label,agent,model,effort}));
function mrPresets() {
  try { const p=JSON.parse(localStorage.getItem(MR_KEY)); if(Array.isArray(p)&&p.length&&p.every(x=>x&&typeof x.label==='string'&&typeof x.agent==='string'&&typeof x.model==='string'&&typeof x.effort==='string')) return p.slice(0,30); } catch {}
  return MR_DEFAULTS.map(x=>({...x}));
}
function mrKey() { return S.lineView ? S.lineTarget || '' : S.chat || S.imp?.key || ''; }
window.mrCurrent = () => {
  const key=mrKey(), agent=S.chatAgent || 'auto', o=S.agentOpts?.[agent];
  const model=S.chatModel?.[key] || o?.default_model || '';
  return {agent,model,effort:S.chatEffort?.[key] || o?.default_effort || o?.models?.find(m=>m.id===model)?.default_effort || ''};
};
let mrApplyVersion=0;
window.mrApply = async p => {
  const key=mrKey(), version=++mrApplyVersion;
  if(!S.agents.some(a=>a.name===p.agent)) throw Error('这个 agent 当前不可用，请在快捷档位设置中修改');
  const o=S.agentOpts?.[p.agent] || await api(`/v1/agents/${encodeURIComponent(p.agent)}/options`);
  if(version!==mrApplyVersion || key!==mrKey()) return false;
  const model=o.models?.find(m=>m.id===p.model);
  if(!model || (p.effort && !model.efforts?.some(e=>e.id===p.effort))) throw Error('这个模型或强度当前不可用，请编辑快捷档位');
  // A single-model selection explicitly leaves the saved multi-answer mode.
  if ((S.multi?.length || 0) > 1 || (S.chatMulti?.[key]?.length || 0) > 1) {
    if (key) await api(`/v1/users/${S.uid}/chat-multi`, { method: 'PUT', body: { key, agents: [] } });
    S.chatMulti = {...(S.chatMulti || {}), [key]: []};
    if(version!==mrApplyVersion || key!==mrKey()) return false;
    S.multi = [];
  }
  S.agentOpts[p.agent]=o; S.chatAgent=p.agent;
  S.chatModel={...(S.chatModel||{}),[key]:p.model};
  S.chatEffort={...(S.chatEffort||{}),[key]:p.effort};
  if (typeof chatChoiceSave === 'function') chatChoiceSave(key);
  rerenderComposer(); return true;
};
function mrTarget() {
  // Each embedded conversation owns its controls; the stage has no global rail.
  return S.view==='chats' ? window : null;
}
/* vendor logos (simple-icons, CC0): each preset shows the maker's mark, then how hard it thinks */
const MR_LOGO = {"openai": "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z", "claude": "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z", "deepseek": "M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45"};
const mrVendor = (p) => p.agent === 'deepseek' ? 'deepseek' : (p.agent === 'chatgpt' || p.agent === 'codex') ? 'openai' : (/^claude/.test(p.agent) || /sonnet|opus|haiku|fable/i.test(p.model)) ? 'claude' : '';
const MR_EFFORT = { medium: 'mid', xhigh: 'extra' };
/* the same maker, told apart by a small tag on the logo: ChatGPT (the app) has none, Codex (the command-line agent) has >_ ,
   Claude Code (the claude agents; claude-2 is its second account) has </> ; a model that is no agent of its own has none */
const MR_TAG = { codex: '>_', claude: '</>' };
const mrKind = (p) => /^claude/.test(p.agent) ? 'Claude Code' + (/-(\d+)$/.test(p.agent) ? ' ' + p.agent.match(/-(\d+)$/)[1] : '') : p.agent === 'codex' ? 'Codex' : p.agent === 'chatgpt' ? 'ChatGPT' : p.agent === 'deepseek' ? 'DeepSeek' : p.agent;
function mrModelName(p) {                         // the model itself, short: "6-Astra", "Opus", "Sonnet", "chat"
  const label = S.agentOpts?.[p.agent]?.models?.find((m) => m.id === p.model)?.label || '';
  let t = (label || p.model || '').replace(/[（(].*$/, '').replace(/^claude[\s-]+/i, '').replace(/^gpt-?/i, '').replace(/^deepseek-?/i, '').trim();
  if (!t) t = p.model || '';
  return t.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
}
function mrBadge(p) {
  const v = mrVendor(p), d = MR_LOGO[v], tag = MR_TAG[p.agent] || (/^claude/.test(p.agent) ? MR_TAG.claude : '');
  const mark = d ? `<span class="mr-mark"><svg class="mr-logo" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>${tag ? `<small>${esc(tag)}</small>` : ''}</span>` : `<b>${esc(p.agent.slice(0, 2).toUpperCase())}</b>`;
  return `<span class="mr-badge" title="${esc(mrKind(p))}">${mark}<span class="mr-name">${esc(mrModelName(p))}</span><em>${esc(MR_EFFORT[p.effort] || p.effort || '')}</em></span>`;
}
function mrPosition(rect, width, height) {
  return { left: Math.max(4, Math.min(width-22, rect.left+4)),
    top: Math.max(8, Math.min(height-40, rect.top+rect.height/2)),
    height: Math.max(36, height-40) };
}
function mrPlace() {
  const bar=document.querySelector('#chatText')?.closest('.cbar');
  if(!mrRail || !bar || !bar.getClientRects().length) { if(mrRail)mrRail.hidden=true; return false; }
  if(mrRail.parentElement!==bar.parentElement || mrRail.nextElementSibling!==bar) bar.before(mrRail);
  mrRail.classList.remove('mr-inline');
  mrRail.removeAttribute('style');
  return true;
}
let mrRail, mrSignature='', mrWheelAt=0, mrPending=-1, mrVersion=0;
function mrIndex(presets,target) {
  const c=target?.mrCurrent?.();
  return c ? presets.findIndex(p=>p.agent===c.agent&&p.model===c.model&&p.effort===c.effort) : -1;
}
async function mrChoose(index) {
  const presets=mrPresets(), p=presets[index], target=mrTarget();
  if(!p||!target?.mrApply) return;
  const version=++mrVersion; mrPending=index; mrDraw();
  try { await target.mrApply(p); } catch(e) { toast(e.message); }
  finally { if(version===mrVersion) {mrPending=-1;mrDraw();} }
}
function mrDraw() {
  const target=mrTarget();
  if(!target && !mrRail) return;
  if(!mrRail) {
    mrRail=document.createElement('aside');mrRail.id='modelRail';mrRail.className='mr-above';mrRail.setAttribute('aria-label','模型快捷档位');
    document.body.appendChild(mrRail);
    // Only on purpose: a click on a preset, or dragging the chosen one and letting go. Hovering or scrolling never switches.
    let dragged=false;
    mrRail.addEventListener('click',e=>{if(dragged){dragged=false;return;}const b=e.target.closest('[data-mr]');if(b) mrChoose(Number(b.dataset.mr));if(e.target.closest('[data-mr-settings]')) (window.parent!==window && window.parent.mrSettings ? window.parent.mrSettings() : mrSettings());});
    mrRail.addEventListener('wheel',e=>{                  // a row too long for its space scrolls sideways; the choice stays
      const track=mrRail.querySelector('.mr-track');if(!track||track.scrollWidth<=track.clientWidth||!e.deltaY)return;
      e.preventDefault();track.scrollLeft+=e.deltaY;
    },{passive:false});
    const showLabel=e=>{const b=e.target.closest('[data-mr]');if(!b)return;const label=mrRail.querySelector('.mr-current');if(label){label.textContent=mrPresets()[Number(b.dataset.mr)]?.label||'';label.style.top=(b.getBoundingClientRect().top-mrRail.getBoundingClientRect().top+b.offsetHeight/2-10)+'px';}};
    mrRail.addEventListener('pointerover',showLabel);mrRail.addEventListener('focusin',showLabel);
    let drag=null;                                       // holding the chosen preset: it follows the pointer, and is applied on release
    const nearest=e=>{const points=[...mrRail.querySelectorAll('[data-mr]')];let best=-1,dist=Infinity;points.forEach((b,i)=>{const r=b.getBoundingClientRect(),d=Math.abs(e.clientX-r.left-r.width/2);if(d<dist){dist=d;best=i;}});return best;};
    const preview=i=>{mrRail.querySelectorAll('[data-mr]').forEach((b,j)=>b.classList.toggle('mr-over',j===i&&!b.classList.contains('on')));const b=mrRail.querySelector(`[data-mr="${i}"]`);if(b)showLabel({target:b});};
    mrRail.addEventListener('pointerdown',e=>{const b=e.target.closest('[data-mr].on');if(e.button!==0||!b)return;e.preventDefault();drag={x:e.clientX,at:Number(b.dataset.mr),over:Number(b.dataset.mr)};mrRail.setPointerCapture(e.pointerId);mrRail.classList.add('mr-dragging');});
    mrRail.addEventListener('pointermove',e=>{if(!drag)return;if(Math.abs(e.clientX-drag.x)<4&&drag.over===drag.at)return;drag.over=nearest(e);preview(drag.over);});
    const drop=apply=>{if(!drag)return;const d=drag;drag=null;mrRail.classList.remove('mr-dragging');preview(-1);if(d.over!==d.at){dragged=true;if(apply)mrChoose(d.over);}};
    mrRail.addEventListener('pointerup',()=>drop(true));mrRail.addEventListener('pointercancel',()=>drop(false));
  }
  mrRail.hidden=!target?.mrApply;
  if(!mrRail.hidden) mrPlace();
  if(mrRail.hidden)return;
  const ps=mrPresets(), index=mrPending>=0?mrPending:mrIndex(ps,target), sig=JSON.stringify([ps,index]);
  if(sig===mrSignature)return;mrSignature=sig;
  mrRail.innerHTML=`<span class="mr-current">${esc(ps[index]?.label || "选择模型")}</span><div class="mr-track" role="group" aria-label="点击某一档切换模型，或按住当前档拖到别的档后松开">${ps.map((p,i)=>`<button data-mr="${i}" class="${i===index?'on':''}" aria-pressed="${i===index}" aria-label="${esc(p.label)}" title="${esc(p.label)}"><i></i>${mrBadge(p)}</button>`).join('')}</div><button data-mr-settings title="设置快捷档位" aria-label="设置快捷档位">⚙ 设置</button>`;
  const track=mrRail.querySelector('.mr-track'), on=track?.querySelector('button.on');   // a narrow row: the chosen one stays in sight
  if(track&&on&&track.scrollWidth>track.clientWidth) track.scrollLeft=Math.max(0,on.offsetLeft-track.clientWidth/2+on.offsetWidth/2);
}
async function mrSettings() {
  const names=S.agents.map(a=>a.name), opts={};
  await Promise.all(names.map(async name=>{try{opts[name]=await api(`/v1/agents/${encodeURIComponent(name)}/options`);}catch{}}));
  let rows=mrPresets();
  modal('<h2>模型快捷档位设置</h2><p class="muted">从左到右排列；可修改名称、agent、模型和强度。切换作用于当前对话的下一次提交。</p><div id="mrRows"></div><div class="row"><button id="mrAdd">＋ 添加</button><button id="mrReset">恢复默认</button><span class="grow"></span><button id="mrSave">保存</button></div>');
  const options=(xs,value)=>xs.map(x=>`<option value="${esc(x.id)}" ${x.id===value?'selected':''}>${esc(x.label||x.id)}</option>`).join('');
  function draw(){document.querySelector('#mrRows').innerHTML=rows.map((p,i)=>{
    const ms=opts[p.agent]?.models||[],eff=ms.find(m=>m.id===p.model)?.efforts||[];
    return `<div class="mr-row" data-row="${i}"><input data-field="label" aria-label="档位名称" value="${esc(p.label)}"><select data-field="agent" aria-label="Agent">${options([...new Set([...names,p.agent])].map(id=>({id})),p.agent)}</select><select data-field="model" aria-label="模型">${options(ms.some(m=>m.id===p.model)?ms:[{id:p.model,label:p.model+'（不可用）'},...ms],p.model)}</select><select data-field="effort" aria-label="强度">${options([{id:'',label:'默认'},...eff],p.effort)}</select><button data-move="-1" title="上移">↑</button><button data-move="1" title="下移">↓</button><button data-remove title="删除档位">×</button></div>`;
  }).join('');}
  draw();
  document.querySelector('#mrRows').addEventListener('change',e=>{const r=e.target.closest('[data-row]');if(!r)return;const p=rows[Number(r.dataset.row)],field=e.target.dataset.field;p[field]=e.target.value;if(field==='agent'){p.model=opts[p.agent]?.default_model||opts[p.agent]?.models?.[0]?.id||'';p.effort='';}if(field==='model')p.effort='';if(field!=='label')draw();});
  document.querySelector('#mrRows').addEventListener('click',e=>{const r=e.target.closest('[data-row]');if(!r)return;const i=Number(r.dataset.row);if(e.target.hasAttribute('data-remove'))rows.splice(i,1);else if(e.target.hasAttribute('data-move')){const j=i+Number(e.target.dataset.move);if(j>=0&&j<rows.length)[rows[i],rows[j]]=[rows[j],rows[i]];}else return;draw();});
  document.querySelector('#mrAdd').onclick=()=>{if(rows.length>=30)return;rows.push({...MR_DEFAULTS[0]});draw();};
  document.querySelector('#mrReset').onclick=()=>{rows=MR_DEFAULTS.map(x=>({...x}));draw();};
  document.querySelector('#mrSave').onclick=()=>{
    if(!rows.length||rows.some(p=>!p.label.trim()||!opts[p.agent]?.models?.some(m=>m.id===p.model&&(!p.effort||m.efforts?.some(e=>e.id===p.effort)))))return toast('请至少保留一档，并选择有效的模型和强度');
    localStorage.setItem(MR_KEY,JSON.stringify(rows));document.querySelector('.modal')?.remove();mrSignature='';mrDraw();toast('快捷档位已保存');
  };
}
window.mrSettings=mrSettings;
setInterval(mrDraw,500);
if(typeof renderChat==='function'){const mrRender=renderChat;renderChat=function(...a){const r=mrRender.apply(this,a);try{mrDraw();}catch{}return r;};}   // the composer was redrawn: the presets go straight back into its row
window.addEventListener('resize',()=>mrDraw());
window.addEventListener('storage',e=>{if(e.key===MR_KEY){mrSignature='';mrDraw();}});
