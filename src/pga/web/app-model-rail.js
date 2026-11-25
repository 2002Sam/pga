/* Recent models and the complete picker affect only the originating conversation. */
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
const MR_RECENT_KEY = 'pga_recent_models_v1:';
const MR_RECENT_LIMIT = 10;
const mrTestKey = p => JSON.stringify([p.agent, p.model, p.effort || '']);
const mrIdentity = p => JSON.stringify([p.agent, p.model]);
const mrValid = p => p && typeof p.agent === 'string' && p.agent && p.agent !== 'auto' && typeof p.model === 'string';
function mrUniqueModels(rows) {
  const seen = new Set(), models = [];
  for (const p of rows) {
    if (!mrValid(p)) continue;
    const id = mrIdentity(p);
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({agent:p.agent, model:p.model});
  }
  return models;
}
function mrRemember(p) {
  if (!mrValid(p)) return;
  let rows = [];
  try { rows = JSON.parse(localStorage.getItem(MR_RECENT_KEY + S.uid)) || []; } catch {}
  rows = mrUniqueModels([p, ...(Array.isArray(rows) ? rows : [])]).slice(0,MR_RECENT_LIMIT);
  try { localStorage.setItem(MR_RECENT_KEY + S.uid, JSON.stringify(rows)); } catch {}
  if (mrRail?.isConnected) mrDraw();
}
window.mrRemember = mrRemember;
function mrRecent() {
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(MR_RECENT_KEY + S.uid)) || []; } catch {}
  const available = new Set(S.agents.filter(a => a.available !== false).map(a => a.name));
  const usable = p => available.has(p.agent) && (!S.agentOpts?.[p.agent] || mrOption(S.agentOpts[p.agent], p));
  const recent = Array.isArray(saved) ? mrUniqueModels(saved).filter(usable) : [];
  return (recent.length ? recent : mrUniqueModels(mrPresets()).filter(usable)).slice(0,MR_RECENT_LIMIT);
}
function mrModels(o) {
  return o?.models?.length ? o.models : o ? [{id:o.default_model || '',label:o.default_model || '默认模型',efforts:[]}] : [];
}
function mrOption(o,p) { return mrModels(o).find(m=>m.id===p.model&&(!p.effort||m.efforts?.some(e=>e.id===p.effort))); }
function mrCatalog(opts, agents = S.agents) {
  return agents.filter(a=>a.available!==false).flatMap(a => mrModels(opts[a.name]).map(m => ({
    agent:a.name, model:m.id, label:m.label || m.id, efforts:m.efforts || [],
    effort:(m.efforts || []).some(e => e.id === opts[a.name].default_effort) ? opts[a.name].default_effort : m.default_effort || ''
  })));
}
window.mrConversationKey = () => mrKey();
function mrKey() { return S.lineView ? S.lineTarget || '' : S.chat || S.imp?.key || ''; }
window.mrCurrent = () => {
  const key=mrKey(), agent=S.chatAgent || 'auto', o=S.agentOpts?.[agent];
  const model=S.chatModel?.[key] || o?.default_model || '';
  return {agent,model,effort:S.chatEffort?.[key] || o?.default_effort || o?.models?.find(m=>m.id===model)?.default_effort || ''};
};
let mrApplyVersion=0;
window.mrApply = async (p, expectedKey = mrKey(), freshOptions = null) => {
  const key=mrKey(), version=++mrApplyVersion;
  if (key !== expectedKey) return false;
  if(!S.agents.some(a=>a.name===p.agent&&a.available!==false)) throw Error('这个 Agent 当前不可用，请重新选择');
  const o=freshOptions || S.agentOpts?.[p.agent] || await api(`/v1/agents/${encodeURIComponent(p.agent)}/options`);
  if(version!==mrApplyVersion || key!==mrKey()) return false;
  const model=mrOption(o,p);
  if(!model || (p.effort && !model.efforts?.some(e=>e.id===p.effort))) throw Error('这个模型或强度当前不可用，请重新选择');
  // A single-model selection explicitly leaves the saved multi-answer mode.
  if ((S.multi?.length || 0) > 1 || (S.chatMulti?.[key]?.length || 0) > 1) {
    if (key) await api(`/v1/users/${S.uid}/chat-multi`, { method: 'PUT', body: { key, agents: [] } });
    S.chatMulti = {...(S.chatMulti || {}), [key]: []};
    if(version!==mrApplyVersion || key!==mrKey()) return false;
    S.multi = [];
  }
  S.agentOpts[p.agent]=o; S.chatAgent=p.agent;
  S.chatModel={...(S.chatModel||{}),[key]:p.model};
  const previousEffort = S.chatEffort?.[key];
  const effort = p.effort ?? (model.efforts?.some(e => e.id === previousEffort) ? previousEffort : '');
  S.chatEffort={...(S.chatEffort||{}),[key]:effort};
  if (typeof chatChoiceSave === 'function') chatChoiceSave(key);
  mrRemember(p); rerenderComposer(); return true;
};
function mrTarget() {
  // Each embedded conversation owns its controls; the stage has no global rail.
  return S.view==='chats' ? window : null;
}
/* Vendor logos (simple-icons, CC0) distinguish model providers. */
const MR_LOGO = {"openai": "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z", "claude": "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z", "deepseek": "M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45", "gemini": "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"};
const mrVendor = (p) => p.agent === 'deepseek' ? 'deepseek' : (p.agent === 'chatgpt' || p.agent === 'codex') ? 'openai' : (/^claude/.test(p.agent) || /sonnet|opus|haiku|fable/i.test(p.model)) ? 'claude' : (/^gemini/.test(p.agent) || /^gemini/i.test(p.model)) ? 'gemini' : '';
/* the same maker, told apart by a small tag on the logo: ChatGPT (the app) has none, Codex (the command-line agent) has >_ ,
   Claude Code (the claude agents; claude-2 is its second account) has </> ; Gemini CLI has >_ ; a model that is no agent of its own has none */
const MR_TAG = { codex: '>_', claude: '</>', gemini: '>_' };
const mrKind = (p) => /^claude/.test(p.agent) ? 'Claude Code' + (/-(\d+)$/.test(p.agent) ? ' ' + p.agent.match(/-(\d+)$/)[1] : '') : /^gemini/.test(p.agent) ? 'Gemini CLI' + (/-(\d+)$/.test(p.agent) ? ' ' + p.agent.match(/-(\d+)$/)[1] : '') : p.agent === 'codex' ? 'Codex' : p.agent === 'chatgpt' ? 'ChatGPT' : p.agent === 'deepseek' ? 'DeepSeek' : p.agent;
function mrModelName(p) {                         // the model itself, short: "6-Astra", "Opus", "Sonnet", "chat", "2.5-Pro"
  const label = S.agentOpts?.[p.agent]?.models?.find((m) => m.id === p.model)?.label || '';
  let t = (label || p.model || '').replace(/[（(].*$/, '').replace(/^claude[\s-]+/i, '').replace(/^gemini[\s-]+/i, '').replace(/^gpt-?/i, '').replace(/^deepseek-?/i, '').trim();
  if (!t) t = p.model || '默认';
  return t.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('-');
}
function mrBadge(p) {
  const v = mrVendor(p), d = MR_LOGO[v], tag = MR_TAG[p.agent] || (/^claude/.test(p.agent) ? MR_TAG.claude : /^gemini/.test(p.agent) ? MR_TAG.gemini : '');
  const mark = d ? `<span class="mr-mark"><svg class="mr-logo" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>${tag ? `<small>${esc(tag)}</small>` : ''}</span>` : `<b>${esc(p.agent.slice(0, 2).toUpperCase())}</b>`;
  return `<span class="mr-badge">${mark}<span class="mr-name">${esc(mrModelName(p))}</span></span>`;
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
let mrDisplayed = [], mrSizeObserver;
function mrFit() {
  const track = mrRail?.querySelector('.mr-track');
  if (!track) return;
  const end = track.getBoundingClientRect().right;
  const buttons = [...track.children];
  const firstOverflow = buttons.findIndex(b => b.getBoundingClientRect().right > end);
  buttons.forEach((b,i) => b.classList.toggle('mr-overflow', firstOverflow >= 0 && i >= firstOverflow));
}
let mrRail, mrSignature='', mrPending=-1, mrVersion=0;
function mrIndex(presets,target) {
  const c=target?.mrCurrent?.();
  return c ? presets.findIndex(p=>mrIdentity(p)===mrIdentity(c)) : -1;
}
async function mrChoose(index) {
  const p=mrDisplayed[index], target=mrTarget();
  if(!p||!target?.mrApply) return;
  const version=++mrVersion; mrPending=index; mrDraw();
  try { await target.mrApply(p); } catch(e) { toast(e.message); }
  finally { if(version===mrVersion) {mrPending=-1;mrDraw();} }
}
// Keep the slider mounted while the recent-model buttons and composer refresh.
function mrSyncEffort() {
  const control = mrRail.querySelector('.mr-effort');
  const select = document.querySelector('#chatEffort');
  control.hidden = !select || S.multi?.length > 1 || !!S.chatSplits?.[S.chat];
  if (control.hidden) { delete control.dataset.scope; return; }

  const current = window.mrCurrent(), key = mrKey();
  const options = new Map(Array.from(select.options, o => [o.value, o.textContent]));
  const levels = PD_EFFORTS.filter(([id]) => options.has(id)).map(([id, zh, en]) => [id, L(zh, en)]);
  for (const [id, label] of options) {
    if (!levels.some(([known]) => known === id)) levels.push([id, label]);
  }
  const scope = JSON.stringify([S.uid, key, current.agent, current.model, levels]);
  const chosen = S.chatEffort?.[key] || '';
  let input = control.querySelector('input');
  if (control.dataset.scope !== scope) {
    const fresh = input.cloneNode(false);
    input.replaceWith(fresh); // an old drag must not commit against the new model
    input = fresh;
  }
  function preview() {
    const [, label] = levels[Math.round(input.value)];
    input.setAttribute('aria-valuetext', label);
    control.querySelector('output').textContent = label;
  }
  if (control.dataset.scope !== scope || control.dataset.chosen !== chosen) {
    input.max = levels.length - 1;
    input.value = Math.max(0, levels.findIndex(([id]) => id === chosen));
    control.dataset.scope = scope;
    control.dataset.chosen = chosen;
    preview();
  }
  input.oninput = preview;
  input.onchange = () => {
    if (control.hidden || !input.isConnected || mrKey() !== key || select !== document.querySelector('#chatEffort')) return;
    const [effort] = levels[Math.round(input.value)];
    // An automatic choice sends the configured default, just like a fresh composer.
    select.value = effort || select.dataset.defaultEffort || '';
    select.dispatchEvent(new Event('change')); // refresh the existing menu's caption
    S.chatEffort[key] = effort;
    chatChoiceSave(key);
    control.dataset.chosen = effort;
    if (effort) mrRemember({...current, effort});
    else mrDraw();
  };
  input.onkeydown = e => {
    const delta = {ArrowLeft:-1, ArrowDown:-1, ArrowRight:1, ArrowUp:1}[e.key];
    if (!delta) return;
    e.preventDefault();
    input.value = Math.max(0, Math.min(levels.length - 1, Math.round(input.value) + delta));
    preview();
    input.onchange();
  };
}
function mrDraw() {
  const target=mrTarget();
  if(!target && !mrRail) return;
  if(!mrRail) {
    mrRail=document.createElement('aside');mrRail.id='modelRail';mrRail.className='mr-above';mrRail.setAttribute('aria-label','最近使用的模型，最多十个');
    mrRail.innerHTML = `<label class="mr-effort" hidden title="${L('思考强度', 'Reasoning effort')}"><input type="range" min="0" step="any" aria-label="${L('思考强度', 'Reasoning effort')}"><output></output></label><div class="mr-track" role="group" aria-label="最近使用的模型"></div>`;
    document.body.appendChild(mrRail);
    mrRail.addEventListener('click', e => { const b=e.target.closest('[data-mr]'); if(b) mrChoose(Number(b.dataset.mr)); });
    mrSizeObserver = new ResizeObserver(mrFit);
  }
  mrRail.hidden=!target?.mrApply;
  if(!mrRail.hidden) mrPlace();
  if(mrRail.hidden)return;
  mrSyncEffort();
  const ps=mrRecent(), index=mrPending>=0?mrPending:mrIndex(ps,target), sig=JSON.stringify([ps,index]);
  if(sig===mrSignature)return;mrSignature=sig;
  mrDisplayed=ps;
  mrSizeObserver.disconnect();
  const track=mrRail.querySelector('.mr-track');
  track.innerHTML=ps.map((p,i)=>{
    const label=esc(mrKind(p) + ' · ' + mrModelName(p));
    return `<button data-mr="${i}" class="${i===index?'on':''}" aria-pressed="${i===index}" aria-label="${label}" title="${label}">${mrBadge(p)}</button>`;
  }).join('');
  mrSizeObserver.observe(track);
  for (const button of track.children) mrSizeObserver.observe(button);
  mrFit();
}
function mrPickerTarget() {
  if (mrTarget()) return window;
  return typeof ST !== 'undefined' ? ST.nodes.find(n => n.id === ST.focus)?.el?.querySelector('iframe')?.contentWindow : null;
}
// One probe per picker; selection is saved before testing and never rolled back by a failed probe.
function mrSelectionSession({target, key, options, current, onChange, isActive = () => true}) {
  let version=0, active=null, disposed=false;
  const session={selected:current, last:null, results:new Map(), select, dispose};
  const alive=token=>!disposed&&isActive()&&token===version;
  function cancel() {
    if(!active)return;
    session.results.set(active.id,{state:'cancelled',error:'测试已取消'});
    clearTimeout(active.timer); active.controller?.abort(); active=null;
  }
  function dispose(){disposed=true;version++;cancel();}
  async function select(row) {
    if(disposed||!isActive())return false;
    const p={...row,effort:row.effort||''}, id=mrTestKey(p);
    if(active?.id===id)return false;
    const token=++version;cancel();active={id};session.last=p;
    session.results.set(id,{state:'switching'});onChange();
    try {
      const applied=await target.mrApply({...p,label:`${mrKind(p)} · ${p.label}`},key,options()[p.agent]);
      if(!alive(token))return false;
      if(!applied)throw Error('对话已切换，请在目标对话中重新选择模型');
      session.selected=p;
      session.results.set(id,{state:'testing'});onChange();
      const controller=new AbortController();let timedOut=false;
      active={id,controller,timer:setTimeout(()=>{timedOut=true;controller.abort();},30000)};
      try {
        const result=await api('/v1/agents/test',{body:{agent:p.agent,model:p.model,effort:p.effort,timeout_s:25},signal:controller.signal});
        if(!alive(token))return false;
        const reply=String(result.reply||'').trim();
        session.results.set(id,result.ok&&reply
          ? {state:'passed',reply:reply.slice(0,200),duration_s:result.duration_s,...(result.model&&result.model!==p.model?{model:String(result.model).slice(0,200)}:{})}
          : {state:'failed',error:String(result.error||result.detail||'模型没有返回文字回答').slice(0,500)});
      } catch(err) {
        if(!alive(token))return false;
        session.results.set(id,{state:'failed',error:timedOut?'测试超时，暂时未收到回答':String(err.message||'测试失败').slice(0,500)});
      }
      return true;
    } catch(err) {
      if(alive(token))session.results.set(id,{state:'failed',switchFailed:true,error:String(err.message||'切换失败').slice(0,500)});
      return false;
    } finally {
      if(token===version){clearTimeout(active?.timer);active=null;if(!disposed&&isActive())onChange();}
    }
  }
  return session;
}
async function mrSettings(target = mrPickerTarget()) {
  try { if (window.top !== window && window.top.mrSettings) return window.top.mrSettings(target); } catch {}
  if (!target?.mrApply) { toast('请先打开要切换模型的对话'); return; }
  const key=target.mrConversationKey(), current=target.mrCurrent(), focus=document.activeElement;
  const box=modal(`<div class="mp-head"><div><h2>选择模型</h2><p class="muted">点击即切换，并自动测试一次简短回答</p></div><button data-mp-close aria-label="关闭模型选择">×</button></div><input class="mp-search" type="search" placeholder="搜索模型或 Agent" aria-label="搜索模型或 Agent"><div class="mp-filters"></div><div class="mp-status" role="status">正在加载可用模型…</div><div class="mp-list"></div><div class="mp-footer"></div><div class="mp-result" role="status" aria-live="polite"></div>`);
  box.classList.add('model-picker'); box.setAttribute('role','dialog'); box.setAttribute('aria-modal','true'); box.setAttribute('aria-label','选择模型');
  let rows=[], opts={}, chosen=null, filter='', loadVersion=0;
  const loads=new Set(), q=s=>box.querySelector(s);
  const session=mrSelectionSession({target,key,options:()=>opts,current,onChange:draw,isActive:()=>box.isConnected});
  const cleanup=()=>{session.dispose();loads.forEach(c=>c.abort());loads.clear();observer.disconnect();};
  const close=()=>{cleanup();box.remove();const back=focus?.isConnected?focus:target.document?.querySelector('[data-model-picker]');back?.focus({preventScroll:true});};
  // Other dialogs can replace this one through the shared modal helper.
  const observer=new MutationObserver(()=>{if(!box.isConnected)cleanup();});
  observer.observe(document.body,{childList:true});
  q('[data-mp-close]').onclick=close;
  box.addEventListener('keydown', e => {
    if(e.key==='Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if(e.key==='Tab') { const xs=[...box.querySelectorAll('button:not(:disabled),input,select')].filter(x=>x.getClientRects().length); const first=xs[0],last=xs.at(-1); if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();} }
  });
  function draw() {
    if(!box.isConnected)return;
    chosen=rows.find(p=>session.selected&&mrIdentity(p)===mrIdentity(session.selected))||null;
    if(chosen)chosen.effort=session.selected.effort||'';
    const focused=document.activeElement, index=focused?.dataset?.modelIndex, effortFocus=focused?.matches('.mp-actions select');
    const list=q('.mp-list'), scroll=list.scrollTop;
    const term=q('.mp-search').value.trim().toLowerCase();
    const visible=rows.filter(p=>(!filter||p.agent===filter)&&`${p.label} ${p.model} ${mrKind(p)}`.toLowerCase().includes(term));
    const labels={switching:'切换中…',testing:'测试中…',passed:'可回答',failed:'未通过',cancelled:'已取消'};
    list.innerHTML=visible.length ? visible.map(p=>{
      const selected=chosen&&mrIdentity(p)===mrIdentity(chosen), result=session.results.get(mrTestKey(p));
      return `<button class="mp-model ${selected?'on':''}" data-model-index="${rows.indexOf(p)}" aria-pressed="${!!selected}"><span><strong>${esc(p.label)}</strong><small>${esc(mrKind(p))}</small>${result?`<small class="mp-test ${result.state}" title="${esc(result.error||result.reply||'')}">${labels[result.state]}</small>`:''}</span><span class="mp-check">${selected?'✓':''}</span></button>`;
    }).join('') : '<p class="muted">没有匹配的模型</p>';
    q('.mp-footer').innerHTML=chosen ? `<div class="mp-selection"><strong>${esc(chosen.label)}</strong><span>当前模型 · ${esc(mrKind(chosen))}</span></div><div class="mp-actions">${chosen.efforts.length?`<label>思考强度 <select aria-label="思考强度"><option value="" ${!chosen.effort?'selected':''}>默认</option>${chosen.efforts.map(e=>`<option value="${esc(e.id)}" ${e.id===chosen.effort?'selected':''}>${esc(e.label||e.id)}</option>`).join('')}</select></label>`:''}</div>` : '<span class="muted">点击一个模型即可切换</span>';
    const result=session.last&&session.results.get(mrTestKey(session.last)), panel=q('.mp-result');
    panel.className=`mp-result ${result?.state||''}`;
    panel.innerHTML=result ? `<strong>${result.switchFailed?'未能切换模型':result.state==='passed'?'可以正常回答':result.state==='failed'?'本次测试未通过':labels[result.state]}</strong>${result.state==='passed'?`<span class="mp-duration">${Number.isFinite(result.duration_s)?`${Number(result.duration_s.toFixed(1))} 秒`:''}</span><p>回答：${esc(result.reply)}</p>${result.model?`<p class="muted">返回模型：${esc(result.model)}</p>`:''}`:result.state==='testing'?'<p>已切换。正在请求一句简短回答…</p>':result.error?`<p>${esc(result.error)}</p>`:''}${['passed','failed','cancelled'].includes(result.state)&&!result.switchFailed?'<button data-mp-test>重新测试</button>':''}` : '<p>选择后会在这里显示实际回答和测试结果。</p>';
    if(index!==undefined)q(`[data-model-index="${index}"]`)?.focus({preventScroll:true});
    else if(effortFocus)q('.mp-actions select')?.focus({preventScroll:true});
    list.scrollTop=scroll;
  }
  async function load() {
    const version=++loadVersion;
    q('.mp-status').textContent='正在加载可用模型…';
    const agents=(target.S?.agents || S.agents).filter(a=>a.available!==false), failed=[], loaded={};
    await Promise.all(agents.map(async a=>{
      const controller=new AbortController(), timer=setTimeout(()=>controller.abort(),12000);
      loads.add(controller);
      try{loaded[a.name]=await api(`/v1/agents/${encodeURIComponent(a.name)}/options`,{signal:controller.signal});}catch{failed.push(a.name);}finally{clearTimeout(timer);loads.delete(controller);}
    }));
    if(!box.isConnected||version!==loadVersion) return;
    opts=loaded;
    rows=mrCatalog(opts,agents);
    q('.mp-status').innerHTML=failed.length ? `${esc(failed.join('、'))} 暂时加载失败 <button data-mp-retry>重试</button>` : `${rows.length} 个可用选项`;
    q('.mp-filters').innerHTML=[['','全部'],...agents.map(a=>[a.name,mrKind({agent:a.name})])].map(([id,name])=>`<button data-mp-agent="${esc(id)}" aria-pressed="${id===filter}" class="${id===filter?'on':''}">${esc(name)}</button>`).join('');
    draw();
  }
  q('.mp-search').addEventListener('input',draw);
  q('.mp-footer').addEventListener('change',e=>{if(chosen&&e.target.matches('select'))session.select({...chosen,effort:e.target.value});});
  box.addEventListener('click',async e=>{
    if(e.target===box){close();return;}
    const a=e.target.closest('[data-mp-agent]'), row=e.target.closest('[data-model-index]');
    if(a){filter=a.dataset.mpAgent;q('.mp-filters').querySelectorAll('button').forEach(b=>{b.classList.toggle('on',b===a);b.setAttribute('aria-pressed',b===a);});draw();}
    if(row){const p=rows[Number(row.dataset.modelIndex)];if(p)session.select(p);}
    if(e.target.closest('[data-mp-retry]'))load();
    if(e.target.closest('[data-mp-test]')&&chosen)session.select(chosen);
  });
  q('.mp-search').focus({preventScroll:true}); await load();
}
window.mrSettings=mrSettings;
// Draw after composer changes; recency propagates across windows without polling.
if(typeof renderChat==='function'){const mrRender=renderChat;renderChat=function(...a){const r=mrRender.apply(this,a);try{mrDraw();}catch{}return r;};}
window.addEventListener('resize',()=>mrDraw());
window.addEventListener('storage',e=>{if(e.key===MR_KEY||e.key===MR_RECENT_KEY+S.uid){mrSignature='';mrDraw();}});
if(typeof document!=='undefined')document.addEventListener('click',e=>{if(e.target.closest('[data-model-picker]'))mrSettings();});
