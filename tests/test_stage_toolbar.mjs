import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync('src/pga/web/app-stage.js', 'utf8');
const memoSrc = fs.readFileSync('src/pga/web/app-memo.js', 'utf8');

function moreHarness() {
  const attrs = {}, trigger = { focused: false, box: { left: 200, right: 240, top: 10, bottom: 36 }, getBoundingClientRect() { return this.box; }, setAttribute(k, v) { attrs[k] = v; }, focus() { this.focused = true; } };
  const panel = { style: {}, box: { width: 218, height: 310 }, scrollHeight: 310, getBoundingClientRect() { return this.box; } };
  const details = { open: true, querySelector(selector) { return selector === 'summary' ? trigger : null; } };
  const context = { innerWidth: 500, innerHeight: 600, $: (id) => id === '#stmore' ? details : id === '#stmoremenu' ? panel : null };
  const start = src.indexOf('function stMorePlace('), end = src.indexOf('function stBar(', start);
  assert(start >= 0 && end > start, 'more menu helpers exist');
  vm.runInNewContext(src.slice(start, end), context);
  return { context, details, trigger, panel, attrs };
}

test('native details menu closes with Escape and returns focus to its trigger', () => {
  const h = moreHarness();
  assert.equal(h.context.stMoreClose(true), true);
  assert.equal(h.details.open, false);
  assert.equal(h.attrs['aria-expanded'], 'false');
  assert.equal(h.trigger.focused, true);
  assert.equal(h.context.stMoreClose(true), false, 'closing an already closed menu is harmless');
});

test('more menu placement uses the rendered width and stays in the viewport', () => {
  const h = moreHarness();
  h.context.stMorePlace();
  assert.equal(h.panel.style.left, '22px');
  assert.equal(h.panel.style.top, '42px');
  h.context.innerWidth = 200;
  h.context.innerHeight = 100;
  h.trigger.box = { left: 170, right: 195, top: 70, bottom: 90 };
  h.context.stMorePlace();
  assert.equal(h.panel.style.left, '8px');
  assert.equal(h.panel.style.top, '8px');
});

test('toolbar leaves tidy rules in settings and keeps the other tools in their existing menu', () => {
  const bar = { innerHTML: '' };
  const context = { $: (id) => id === '#stbar' ? bar : null, L: (zh) => zh, memoBtns: () => '<button data-memo="new">＋ 新备忘</button><button data-memo="list">📝</button><button data-nettest>🌐</button>' };
  const start = src.indexOf('function stBar('), end = src.indexOf('/* ------------------------------------------------ pointer */', start);
  assert(start >= 0 && end > start, 'stage toolbar exists');
  vm.runInNewContext(src.slice(start, end), context);
  context.stBar();
  const html = bar.innerHTML;
  for (const id of ['data-st="new"', 'id="stmore"', 'id="stmoremenu"']) assert.ok(html.includes(id), id);
  for (const action of ['data-st="refresh"', 'data-memo="new"', 'data-memo="list"', 'data-nettest', 'data-pjpicker', 'data-stsync']) assert.ok(html.includes(action), action);
  assert.doesNotMatch(html, /id="stpmopen"/, 'toolbar no longer includes the redundant manager button');
  assert.doesNotMatch(html, /data-sttidy/);
  assert.match(src, /id="sttoolsbody"><fieldset class="sttidyrules"/);
  assert.match(html, /id="stmoremenu"[\s\S]*data-stsync[\s\S]*data-pjpicker/);
  assert.match(src, /if \(allMemos\) allMemos\.textContent = `📝 \$\{L\("所有备忘", "All memos"\)\}`/);
  assert.match(src, /if \(netTest\) \{ netTest\.textContent = `🌐 \$\{L\("网络测试", "Network test"\)\}`/);
});

test('outside click, iframe click and Escape close the menu; memo list snapshots its anchor first', () => {
  const hold = src.slice(src.indexOf('function stHold('), src.indexOf('function stPageClickBind('));
  assert.match(src, /if \(!inMore\) stMoreClose\(\)/, 'parent-document outside click closes it');
  assert.match(hold, /typeof stMoreClose === "function" && stMoreClose\(true\)/, 'iframe events can dismiss it without adding a second click handler');
  assert.match(src, /if \(stMoreClose\(true\)\) \{ e\.preventDefault\(\); e\.stopImmediatePropagation\(\); return; \}/, 'Escape closes it and stops other stage Escape actions');
  assert.match(memoSrc, /const rect0 = btn\.getBoundingClientRect\(\), trigger = document\.querySelector\("#stmore summary"\)/);
  assert.match(memoSrc, /window\.stMoreClose\?\.\(true\)/, 'all-memos action closes after preserving its anchor');
});
