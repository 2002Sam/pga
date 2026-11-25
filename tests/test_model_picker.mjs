import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('src/pga/web/app-model-rail.js', 'utf8');
const models = [
  { agent: 'codex', model: 'gpt-6-astra', label: 'Astra', effort: 'medium' },
  { agent: 'claude', model: 'sonnet', label: 'Sonnet', effort: 'high' },
];

function setup({ apply, api, timers = false, isActive } = {}) {
  const S = { agents: [{ name: 'codex' }, { name: 'claude' }] };
  const window = { parent: {}, addEventListener() {} };
  const handlers = new Map();
  let nextTimer = 1;
  const pendingTimers = new Map();
  const clock = timers ? {
    setTimeout(fn, ms) { const id = nextTimer++; pendingTimers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { pendingTimers.delete(id); },
  } : { setTimeout, clearTimeout };
  const ctx = vm.createContext({
    S, window,
    document: { addEventListener(type, fn) { handlers.set(type, fn); } },
    localStorage: { getItem() { return null; }, setItem() {} },
    store: { set() {} },
    api: api || (async () => ({ ok: true, reply: '你好，我可以协助你整理和分析信息。', duration_s: 0.2 })),
    toast() {}, rerenderComposer() {}, setInterval() {}, console,
    AbortController, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  vm.runInContext(source, ctx);
  const calls = [];
  const target = {
    mrApply: apply || (async (p, key, opts) => { calls.push({ type: 'apply', p, key, opts }); return true; }),
  };
  const changes = [];
  const options = () => ({ codex: { models: [{ id: 'gpt-6-astra' }] }, claude: { models: [{ id: 'sonnet' }] } });
  const session = vm.runInContext('mrSelectionSession', ctx)({
    target, key: 'chat:one', options, current: { ...models[0] },
    onChange: () => changes.push(sessionState(session)), isActive: isActive || (() => true),
  });
  return { ctx, session, target, calls, changes, pendingTimers };
}

function sessionState(session) {
  return { selected: session.selected, results: [...session.results.entries()] };
}
const keyOf = p => JSON.stringify([p.agent, p.model, p.effort || '']);
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

test('selection applies first, probes the exact agent/model/effort, and shows the real short reply', async () => {
  const order = [], requests = [];
  const h = setup({
    apply: async (p, key, opts) => { order.push('apply'); assert.equal(key, 'chat:one'); assert.equal(opts.models[0].id, 'sonnet'); return true; },
    api: async (url, init) => { order.push('probe'); requests.push({ url, init }); return { ok: true, reply: '这里是模型实际生成的回答。', duration_s: 0.5 }; },
  });
  assert.equal(await h.session.select(models[1]), true);
  assert.deepEqual(order, ['apply', 'probe']);
  assert.equal(requests[0].url, '/v1/agents/test');
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].init.body)), {
    agent: 'claude', model: 'sonnet', effort: 'high', timeout_s: 25,
  });
  assert.equal(h.session.selected.model, 'sonnet');
  assert.deepEqual(JSON.parse(JSON.stringify(h.session.results.get(keyOf(models[1])))), {
    state: 'passed', reply: '这里是模型实际生成的回答。', duration_s: 0.5,
  });
});

test('a rejected or stale model switch does not start a probe or replace the selected model', async () => {
  let probes = 0;
  const h = setup({
    apply: async () => false,
    api: async () => { probes++; return { ok: true, reply: 'should not run' }; },
  });
  assert.equal(await h.session.select(models[1]), false);
  assert.equal(probes, 0);
  assert.equal(h.session.selected.model, 'gpt-6-astra');
  assert.equal(h.session.results.get(keyOf(models[1])).state, 'failed');
});

test('a failed real-model probe keeps the successfully selected model and exposes the failure', async () => {
  const h = setup({ api: async () => ({ ok: false, error: 'provider unavailable' }) });
  assert.equal(await h.session.select(models[1]), true);
  assert.equal(h.session.selected.model, 'sonnet');
  assert.equal(h.session.results.get(keyOf(models[1])).state, 'failed');
  assert.match(h.session.results.get(keyOf(models[1])).error, /provider unavailable/);
});

test('an ok response with an empty or whitespace-only reply is treated as failed', async () => {
  const h = setup({ api: async () => ({ ok: true, reply: '  \n\t  ' }) });
  assert.equal(await h.session.select(models[1]), true);
  const result = h.session.results.get(keyOf(models[1]));
  assert.equal(result.state, 'failed');
  assert.match(result.error, /没有返回文字回答/);
  assert.equal(h.session.selected.model, 'sonnet');
});

test('the reported effective model alias is retained for display when it differs from the choice', async () => {
  const h = setup({ api: async () => ({ ok: true, reply: '4。', model: 'claude-sonnet-5-5' }) });
  assert.equal(await h.session.select(models[1]), true);
  const result = h.session.results.get(keyOf(models[1]));
  assert.equal(result.state, 'passed');
  assert.equal(result.model, 'claude-sonnet-5-5');
  assert.equal(result.reply, '4。');
});

test('the latest selection wins and aborts an older in-flight probe', async () => {
  const requests = [];
  const h = setup({ api: (url, init) => new Promise((resolve, reject) => {
    const request = { url, init, resolve, reject }; requests.push(request);
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }) });
  const first = h.session.select(models[0]);
  await tick();
  assert.equal(requests.length, 1);
  const second = h.session.select(models[1]);
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.signal.aborted, true);
  requests[1].resolve({ ok: true, reply: 'Sonnet ответил.' });
  assert.equal(await second, true);
  assert.equal(await first, false);
  assert.equal(h.session.selected.model, 'sonnet');
  assert.equal(h.session.results.get(keyOf(models[1])).state, 'passed');
  assert.equal(h.session.results.get(keyOf(models[0])).state, 'cancelled');
});

test('duplicate clicks on the model being tested do not launch duplicate probes', async () => {
  let resolveProbe, applyCount = 0, probeCount = 0;
  const h = setup({
    apply: async () => { applyCount++; return true; },
    api: () => { probeCount++; return new Promise(resolve => { resolveProbe = resolve; }); },
  });
  const first = h.session.select(models[1]);
  await tick();
  assert.equal(await h.session.select(models[1]), false);
  assert.equal(applyCount, 1);
  assert.equal(probeCount, 1);
  resolveProbe({ ok: true, reply: 'ready' });
  await first;
});

test('closing the picker aborts the probe and ignores any later completion', async () => {
  let request;
  const h = setup({ api: (url, init) => new Promise(resolve => { request = { url, init, resolve }; }) });
  // Observe changes after constructing the session.
  const original = h.session;
  const p = original.select(models[1]);
  await tick();
  assert.ok(request);
  const changesBeforeClose = h.changes.length;
  h.session.dispose();
  assert.equal(request.init.signal.aborted, true);
  request.resolve({ ok: true, reply: 'late reply' });
  assert.equal(await p, false);
  assert.notEqual(h.session.results.get(keyOf(models[1])).state, 'passed');
  assert.equal(h.changes.length, changesBeforeClose);
});

test('inactive picker sessions do not apply a model', async () => {
  let active = false, applies = 0, probes = 0;
  const h = setup({
    isActive: () => active,
    apply: async () => { applies++; return true; },
    api: async () => { probes++; return { ok: true, reply: 'ready' }; },
  });
  assert.equal(await h.session.select(models[1]), false);
  assert.equal(applies, 0);
  assert.equal(probes, 0);
});

test('probe timeout is reported distinctly and does not revert the selection', async () => {
  const h = setup({
    timers: true,
    api: (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
  });
  const pending = h.session.select(models[1]);
  await tick();
  const timeout = [...h.pendingTimers.entries()].find(([, timer]) => timer.ms === 30000);
  assert.ok(timeout, 'a 30 second timeout should be armed');
  timeout[1].fn();
  await tick();
  assert.equal(await pending, true);
  assert.equal(h.session.selected.model, 'sonnet');
  assert.equal(h.session.results.get(keyOf(models[1])).state, 'failed');
  assert.match(h.session.results.get(keyOf(models[1])).error, /测试超时/);
});

test('effort is part of the probe identity', async () => {
  const h = setup({ api: async () => ({ ok: true, reply: 'ok' }) });
  const medium = { ...models[0], effort: 'medium' };
  const high = { ...models[0], effort: 'high' };
  assert.notEqual(vm.runInContext('mrTestKey', h.ctx)(medium), vm.runInContext('mrTestKey', h.ctx)(high));
  await h.session.select(high);
  assert.equal(h.session.results.get(keyOf(high)).state, 'passed');
  assert.equal(h.session.results.has(keyOf(medium)), false);
});
