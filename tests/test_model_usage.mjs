import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('src/pga/web/app-live.js', 'utf8');
const fn = source.slice(source.indexOf('function modelUsageTable('), source.indexOf('async function showUsage('));
const ctx = vm.createContext({L: (zh) => zh, esc: x => String(x).replaceAll('<', '&lt;').replaceAll('>', '&gt;'), agentLabel: x => x, kfmt: x => String(x)});
vm.runInContext(fn, ctx);
test('model table separates models, adds background, and escapes names', () => {
  const side = n => ({calls:1,input:n,cached:2,output:3});
  const html = ctx.modelUsageTable({models:[{model:'<gpt>',agent:'codex',yours:side(10),background:side(20)}, {model:'sonnet',agent:'claude',yours:side(4),background:side(5)}]});
  assert.ok(html.includes('&lt;gpt&gt;'));
  assert.ok(html.includes('sonnet'));
  assert.ok(html.includes('>30</td>'));
});
test('missing data is explicit, never displayed as zero usage', () => {
  assert.match(ctx.modelUsageTable(null), /读取失败/);
  assert.match(ctx.modelUsageTable({}), /重启/);
  assert.match(ctx.modelUsageTable({models:[]}), /还没有/);
});

const inline = source.slice(source.indexOf('function modelUsageCache('), source.indexOf('let usageDays = 7;'));
function inlineContext() {
  const window = {location:{origin:'http://pga'}};
  window.parent = window;
  const open = new Set(), listeners = {};
  let activeElement = null;
  const closeButton = {focus(){this.focused=true;activeElement=this;}, closest(sel){return sel==='[data-inline-usage-close]'?closeButton:sel==='.composer-usage-wrap'?wrap:null;}};
  const panel = {hidden:true, innerHTML:'', dataset:{}, querySelector:sel=>sel==='[data-inline-usage-close]'?closeButton:null,
    contains:el=>el===closeButton};
  const button = {dataset:{agent:'codex',model:'gpt-a'}, textContent:'ICON', attrs:{}, title:'',
    setAttribute(k,v){this.attrs[k]=v;}, focus(){this.focused=true;activeElement=this;}, closest(sel){return sel==='.composer-usage-wrap'?wrap:sel==='[data-inline-usage]'?button:null;}};
  const wrap = {classList:{add(x){open.add(wrap);},remove(x){open.delete(wrap);},contains(){return open.has(wrap);}},
    querySelector(sel){return sel==='[data-inline-usage]'?button:sel==='[data-inline-usage-panel]'?panel:null;},
    contains(el){return el===button||el===panel||el===closeButton;}};
  button.closest = sel => sel==='.composer-usage-wrap'?wrap:sel==='[data-inline-usage]'?button:null;
  let calls = 0;
  const models = ['gpt-a','gpt-b'].map(model => ({agent:'codex',model,yours:{input:100,output:20,cached:10},background:{input:5,output:2,cached:1}}));
  const document = {hidden:false, get activeElement(){return activeElement;}, querySelector:sel=>sel==='[data-inline-usage]'?button:sel==='.composer-usage-wrap.is-open'?(open.size?wrap:null):null,
    querySelectorAll:sel=>sel==='[data-inline-usage]'?[button]:sel==='.composer-usage-wrap.is-open'?[...open]:[],
    addEventListener:(n,fn)=>listeners[n]=fn};
  const c = vm.createContext({window, S:{uid:'u',chatAgent:'codex',chatModel:{chat:'gpt-a'}}, document,
    L:zh=>zh, esc:String, agentLabel:x=>x, kfmt:String, Date, setTimeout:()=>{}, setInterval:()=>{}, when:()=> 'tomorrow', showUsage:()=>{},
    api:async url => {calls++;return url.includes('/route') ? {ranking:[{agent:'codex',quota:{source:'provider',detail:'周额度剩余 82%',remaining:.82,resets_at:'2027-01-01'}}]} : {models};}});
  vm.runInContext(inline,c);
  return {c,button,panel,wrap,closeButton,open,listeners,calls:()=>calls};
}
test('usage control is a compact icon button and never replaces its icon with text', async () => {
  const {c,button} = inlineContext();
  const markup = c.inlineModelUsage('chat');
  assert.match(markup, /<button[^>]+data-inline-usage/);
  assert.match(markup, /composer-usage-icon/);
  assert.match(markup, /composer-usage-popover/);
  assert.doesNotMatch(markup, /model-usage-inline[^>]*>[^<]{30,}/);
  await c.refreshInlineUsage();
  assert.equal(button.textContent, 'ICON');
  assert.match(button.title, /gpt-a/);
});
test('panel shows exact-model token totals and clearly labelled shared quota/reset details', async () => {
  const {c,button,panel,closeButton} = inlineContext();
  const markup = c.inlineModelUsage('chat');
  assert.match(markup, /data-agent="codex" data-model="gpt-a"/);
  await c.refreshInlineUsage();
  c.inlineUsageClick({target:{closest:sel=>sel==='[data-inline-usage]'?button:null}});
  assert.equal(panel.hidden, false);
  assert.equal(closeButton.focused,true);
  assert.match(panel.innerHTML, /输入（含缓存） 105/);
  assert.match(panel.innerHTML, /缓存读取 11/);
  assert.match(panel.innerHTML, /输出 22/);
  assert.match(panel.innerHTML, /账户共享额度/);
  assert.match(panel.innerHTML, /可能由多个模型共用/);
  assert.match(panel.innerHTML, /周额度剩余 82%/);
  assert.match(panel.innerHTML, /重置于 tomorrow/);
  assert.doesNotMatch(panel.innerHTML, /gpt-b/);
  c.modelUsageCache().version++;
  c.paintInlineUsage();
  assert.equal(closeButton.focused,true, 'refresh must preserve focus in the open panel');
});
test('unknown model does not borrow an aggregate and close/Escape restore focus', async () => {
  const {c,button,panel,wrap,open,listeners} = inlineContext();
  button.dataset.model='';
  await c.refreshInlineUsage();
  c.inlineUsageClick({target:{closest:sel=>sel==='[data-inline-usage]'?button:null}});
  assert.match(panel.innerHTML, /尚未确定具体模型，因此不显示汇总 token/);
  assert.doesNotMatch(panel.innerHTML, /输入（含缓存） 105/);
  const close = {closest:sel=>sel==='[data-inline-usage-close]'?close:sel==='.composer-usage-wrap'?wrap:null};
  c.inlineUsageClick({target:close});
  assert.equal(panel.hidden,true);
  assert.equal(button.attrs['aria-expanded'],'false');
  assert.equal(button.focused,true);
  c.inlineUsageClick({target:{closest:sel=>sel==='[data-inline-usage]'?button:null}});
  let prevented=false, stopped=false;
  listeners.keydown({key:'Escape',preventDefault(){prevented=true;},stopPropagation(){stopped=true;}});
  assert.ok(prevented);
  assert.ok(stopped);
  assert.equal(panel.hidden,true);
  assert.equal(open.size,0);
  c.inlineUsageClick({target:{closest:sel=>sel==='[data-inline-usage]'?button:null}});
  c.inlineUsageFocusin({target:{outside:true}});
  assert.equal(panel.hidden,true);
});
test('concurrent refreshes share requests and missing exact model is not zero usage', async () => {
  const {c,calls,button} = inlineContext();
  await Promise.all([c.refreshInlineUsage(),c.refreshInlineUsage()]);
  await c.refreshInlineUsage();
  assert.equal(calls(),2);
  button.dataset.model='unrecorded';
  assert.match(c.inlineUsagePanel(c.modelUsageCache(),'codex','unrecorded'), /该模型最近 7 天暂无记录/);
});
test('quota read errors are explicit and preserve prior provider detail', () => {
  const {c} = inlineContext(), cache=c.modelUsageCache();
  cache.data={models:[]}; cache.quotaError=true;
  cache.ranking=[{agent:'codex',quota:{detail:'上次读取失败：429'}}];
  const html=c.inlineUsageContent(cache,'codex','gpt-a');
  assert.match(html,/额度暂时无法读取/);
  assert.match(html,/上次读取失败：429/);
});

test('inline quota displays remaining and countdown without requiring token statistics', () => {
 const {c}=inlineContext(),now=Date.parse('2026-11-16T00:00:00Z');
 const cache={ranking:[{agent:'codex',quota:{source:'codex_live',remaining:.82,resets_at:'2026-11-16T02:15:00Z'}}]};
 assert.equal(c.inlineQuotaText(cache,'codex',now),'剩余 82% · 2小时 15分后重置');
 assert.match(c.inlineQuotaText(cache,'claude',now),/读取中/);
 assert.match(c.inlineQuotaText(cache,'auto',now),/待选择/);
 cache.ranking[0].quota.resets_at='2026-11-15T00:00:00Z';
 assert.match(c.inlineQuotaText(cache,'codex',now),/重置时间已到 · 待更新/);
});
test('estimates, login errors, balances and missing quota never masquerade as provider percentages',()=>{
 const {c}=inlineContext();
 const text=q=>c.inlineQuotaText({at:1,ranking:[{agent:'a',quota:q}]},'a');
 assert.match(text({source:'observed',remaining:.8}),/账户额度未知（本地估算）/);
 assert.doesNotMatch(text({source:'observed',remaining:.8}),/80%/);
 assert.match(text({source:'login',remaining:0}),/需要登录/);
 assert.match(text({source:'deepseek_balance',remaining:1,detail:'余额 CNY 25.00'}),/余额 CNY 25.00/);
 assert.doesNotMatch(text({source:'deepseek_balance',remaining:1}),/100%/);
 assert.match(text({remaining:null}),/额度未知 · 重置时间未知/);
 assert.match(text({source:'codex_sessions',remaining:.5}),/记录：剩余 50%/);
 assert.match(c.inlineQuotaText({quotaError:true},'a'),/读取失败/);
});
test('quota summary is rendered directly in the composer control',()=>{
 const {c}=inlineContext(); c.modelUsageCache().ranking=[{agent:'codex',quota:{remaining:.72}}];
 assert.match(c.inlineModelUsage('chat'),/data-inline-quota-summary>剩余 72%/);
});
