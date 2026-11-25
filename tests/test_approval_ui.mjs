import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function setup(mode) {
  const listeners = {}, timers = new Map(), status = {textContent: ''};
  const buttons = ['deny', 'allow', 'full'].map(toolApproval => ({disabled: false, dataset: {toolApproval, id: 'approval'}}));
  let removed = false;
  const box = {querySelectorAll: () => buttons, querySelector: () => status, remove: () => { removed = true; }};
  buttons.forEach(b => b.closest = () => box);
  const calls = [];
  const context = vm.createContext({
    S: {uid: 'user'}, L: zh => zh, console, AbortController,
    SHARED_GET: /never/, pgaTop: {__pgaShared: {clear() {}}}, toast() {},
    document: {addEventListener: (name, fn) => { listeners[name] = fn; }, querySelectorAll: () => []},
    setInterval() {}, setTimeout: (fn, delay) => { timers.set(delay, fn); return delay; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      calls.push({url, options});
      if (mode === 'timeout') return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
      return {ok: mode !== 'error', text: async () => JSON.stringify(mode === 'error' ? {detail: 'save failed'} : {key: 'chat:test', access: {access: 'full'}})};
    },
  });
  const core = fs.readFileSync(new URL('../src/pga/web/app-core.js', import.meta.url), 'utf8');
  vm.runInContext(core.slice(core.indexOf('async function api('), core.indexOf('function localFileLink(')), context);
  vm.runInContext(fs.readFileSync(new URL('../src/pga/web/app-access.js', import.meta.url), 'utf8'), context);
  const click = () => listeners.click({target: {closest: selector => selector === '[data-tool-approval]' ? buttons[2] : null}});
  return {context, buttons, status, timers, calls, click, removed: () => removed};
}

test('full approval saves the cache, closes modal and prevents duplicate clicks', async () => {
  const ui = setup('success');
  const pending = ui.click();
  assert.ok(ui.buttons.every(b => b.disabled));
  await ui.click();
  await pending;
  assert.equal(ui.calls.length, 1);
  assert.equal(JSON.parse(ui.calls[0].options.body).decision, 'full');
  assert.equal(ui.context.S.acc['chat:test'].access, 'full');
  assert.ok(ui.removed());
  assert.equal(ui.timers.size, 0);
});

test('failed save re-enables approval buttons without changing access', async () => {
  const ui = setup('error');
  await ui.click();
  assert.equal(ui.status.textContent, 'save failed');
  assert.ok(ui.buttons.every(b => !b.disabled));
  assert.equal(ui.context.S.acc['chat:test'], undefined);
  assert.equal(ui.removed(), false);
  assert.equal(ui.timers.size, 0);
});

test('hung request aborts after 15 seconds and restores usable controls', async () => {
  const ui = setup('timeout');
  const pending = ui.click();
  assert.ok(ui.buttons.every(b => b.disabled));
  ui.timers.get(15000)();
  await pending;
  assert.equal(ui.calls[0].options.signal.aborted, true);
  assert.match(ui.status.textContent, /超时.*尚未确认/);
  assert.ok(ui.buttons.every(b => !b.disabled));
  assert.equal(ui.context.S.acc['chat:test'], undefined);
  assert.equal(ui.removed(), false);
  assert.equal(ui.timers.size, 0);
});
