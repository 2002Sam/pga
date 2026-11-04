import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../src/pga/web/app-chats.js', import.meta.url), 'utf8');
function harness(api) {
  const t = { role:'agent', run:'r1', agent:'claude', text:'Original answer' };
  const ctx = vm.createContext({ S:{chat:'chat:a',view:'chats',uid:'u',chatTurns:{'chat:a':[t]}}, api,
    renderChat(){}, toast(){}, esc:x=>String(x), md:x=>String(x), agentLabel:x=>x, L:x=>x });
  vm.runInContext(src.slice(src.indexOf('async function secondOpinion('),src.indexOf('/* translate one piece')),ctx);
  return {ctx,t};
}
test('second opinion stays attached to the source reply without a branch request',async()=>{
  const calls=[]; const {ctx,t}=harness(async(url,opts)=>{calls.push(opts.body);return {agent:'codex',text:'Other answer'};});
  await ctx.secondOpinion('r1','chat:a');
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{run:'r1'}]);
  assert.equal(ctx.S.chat,'chat:a'); assert.equal(t.second.text,'Other answer');
  const html=ctx.secondPairHtml(t);
  assert.equal((html.match(/<section /g)||[]).length,2);
  assert.match(html,/Original answer/); assert.match(html,/Other answer/);
});
test('pending request renders two columns and repeated clicks do not duplicate it',async()=>{
  let finish, count=0; const {ctx,t}=harness(()=>{count++;return new Promise(r=>finish=r);});
  const pending=ctx.secondOpinion('r1','chat:a');
  await ctx.secondOpinion('r1','chat:a');
  assert.equal(count,1); assert.match(ctx.secondPairHtml(t),/aria-live/);
  ctx.S.chat='chat:b'; finish({agent:'codex',text:'Done'}); await pending;
  assert.equal(ctx.S.chat,'chat:b'); assert.equal(t.second.text,'Done'); assert.equal(ctx.S.secondBusy,null);
});
test('failure leaves original answer intact and releases pending state',async()=>{
  const {ctx,t}=harness(async()=>{throw Error('unavailable');});
  await ctx.secondOpinion('r1','chat:a');
  assert.equal(t.text,'Original answer'); assert.equal(t.second,undefined); assert.equal(ctx.S.secondBusy,null);
});
test('saved second opinions use the pair renderer instead of the legacy collapsed comparison',()=>{
  const render=src.slice(src.indexOf('function chatTurnsHtml('),src.indexOf('function secondHtml('));
  assert.ok(render.includes("t.second || (t.run && S.secondBusy === t.run) ? secondPairHtml(t)"));
  assert.doesNotMatch(render,/out \+= secondHtml/);
});
