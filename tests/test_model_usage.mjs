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

const inline = source.slice(source.indexOf('function modelUsageCache('), source.indexOf('setInterval(refreshInlineUsage, 15000);'));
function inlineContext() {
  const window = {location:{origin:'http://pga'}};
  window.parent = window;
  const element = {dataset:{agent:'codex',model:'gpt-a'},textContent:''};
  let calls = 0;
  const models = ['gpt-a','gpt-b'].map(model => ({agent:'codex',model,yours:{input:100,output:20},background:{input:5,output:2}}));
  const c = vm.createContext({window, S:{uid:'u',chatAgent:'codex',chatModel:{chat:'gpt-a'}},
    document:{hidden:false,querySelector:()=>element,querySelectorAll:()=>[element]},
    L:zh=>zh, esc:String, agentLabel:x=>x, kfmt:String, Date, setTimeout:()=>{},
    api:async url => {calls++;return url.includes('/route') ? {ranking:[{agent:'codex',quota:{source:'codex_live',detail:'每周已用 10%'}}]} : {models};}});
  vm.runInContext(inline,c);
  return {c,element,calls:()=>calls};
}
test('usage is rendered inline and changes with selected model without opening modal', async () => {
  const {c,element} = inlineContext();
  assert.match(c.inlineModelUsage('chat'), /data-inline-usage/);
  await c.refreshInlineUsage();
  assert.match(element.textContent, /gpt-a · 7天 ↓105 ↑22/);
  assert.match(element.textContent, /每周已用 10%/);
  assert.ok(!element.textContent.includes('gpt-b'));
  element.dataset.model='gpt-b';
  c.paintInlineUsage();
  assert.match(element.textContent, /gpt-b/);
  assert.ok(!element.textContent.includes('gpt-a'));
});
test('concurrent refreshes share requests and missing model is not zero usage', async () => {
  const {c,calls,element} = inlineContext();
  await Promise.all([c.refreshInlineUsage(),c.refreshInlineUsage()]);
  await c.refreshInlineUsage();
  assert.equal(calls(),2);
  element.dataset.model='unrecorded';
  c.paintInlineUsage();
  assert.match(element.textContent, /暂无记录/);
  assert.ok(!element.textContent.includes('↓0'));
});
