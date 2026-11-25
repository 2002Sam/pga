import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const stageSource = fs.readFileSync('src/pga/web/app-stage.js', 'utf8');
const css = fs.readFileSync('src/pga/web/app.css', 'utf8');

function toggleHarness() {
  const lp = {}, events = [], timers = [], cleared = [];
  const query = { focused: false, focus() { this.focused = true; } };
  const button = { attrs: {}, focused: false, setAttribute(k, v) { this.attrs[k] = v; }, focus() { this.focused = true; } };
  const context = {
    document: { querySelectorAll: () => [] },
    ST: { listOpen: false }, S: { view: 'stage' },
    stPanel: () => lp,
    stPanelSave: () => events.push(['save', lp.open]),
    stSideList: () => events.push(['panel', context.ST.listOpen]),
    $: (selector) => selector === '#stlq' ? query : selector === '#stlbar' ? button : null,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => cleared.push(id),
  };
  const start = stageSource.indexOf('function stDropToggle(');
  const end = stageSource.indexOf('function stMyHeight(', start);
  assert(start >= 0 && end > start, 'settings toggle function exists');
  vm.runInNewContext(stageSource.slice(start, end), context);
  return { context, lp, events, timers, cleared, query, button };
}

test('settings toggle updates only its panel, persists state, and focuses history search', () => {
  const h = toggleHarness();
  h.context.stDropToggle(true);
  assert.equal(h.context.ST.listOpen, true);
  assert.equal(h.lp.open, true);
  assert.equal(h.button.attrs['aria-expanded'], 'true');
  assert.deepEqual(h.events.map((event) => event[0]), ['save', 'panel']);
  h.timers[0]();
  assert.equal(h.query.focused, true);

  h.context.stDropToggle(false, true);
  assert.equal(h.context.ST.listOpen, false);
  assert.equal(h.lp.open, false);
  assert.equal(h.button.attrs['aria-expanded'], 'false');
  assert.equal(h.button.focused, true, 'Escape and the close button return focus to the gear');
});

test('closing and reopening cancels stale search focus callbacks', () => {
  const h = toggleHarness();
  h.context.stDropToggle(true);
  h.context.stDropToggle(false);
  h.context.stDropToggle(true);
  const activeTimer = h.context.ST.listFocusTimer;
  assert.ok(h.cleared.includes(1), 'closing cancels the pending focus timer');
  h.timers[0]();
  assert.equal(h.context.ST.listFocusTimer, activeTimer, 'a stale callback cannot clear the new timer handle');
  assert.equal(h.query.focused, false, 'a stale callback cannot steal focus');
  h.timers[1]();
  assert.equal(h.query.focused, true);
});

function mapHarness({ desktop, width, actionsWidth, rightToolLeft }) {
  const map = { style: {} }, actions = { style: {}, getBoundingClientRect: () => ({ width: actionsWidth }) };
  const stage = {
    getBoundingClientRect: () => ({ left: 0, width, right: width }),
    querySelector: (selector) => selector === '.stmapacts' ? actions : selector === '#stbar' ? { getBoundingClientRect: () => ({ left: rightToolLeft }) } : null,
  };
  const context = {
    ST: {}, ST_WW: 1000, ST_MAPGAP: 8, window: { innerWidth: width },
    document: { documentElement: { classList: { contains: (name) => name === 'deskapp' && desktop } } },
  };
  const start = stageSource.indexOf('function stMapLayout(');
  const end = stageSource.indexOf('const ST_MAPFOLD', start);
  vm.runInNewContext(stageSource.slice(start, end), context);
  context.stMapLayout(map, stage, [{ sw: 1000 }]);
  return { map, actions };
}

test('page action group reserves space after the gear on web and desktop layouts', () => {
  const web = mapHarness({ desktop: false, width: 500, actionsWidth: 100, rightToolLeft: 460 });
  const desk = mapHarness({ desktop: true, width: 650, actionsWidth: 120, rightToolLeft: 610 });
  assert.equal(web.actions.style.left, '50px');
  assert.equal(desk.actions.style.left, '164px');
  assert.ok(parseFloat(web.actions.style.left) >= 14 + 28 + 8);
  assert.ok(parseFloat(desk.actions.style.left) >= 128 + 28 + 8);
});

test('navigation moves to a second row when tools would leave too little room', () => {
  const narrow = mapHarness({ desktop: true, width: 650, actionsWidth: 80, rightToolLeft: 430 });
  assert.equal(narrow.map.style.top, '42px');
  assert.ok(parseFloat(narrow.map.style.width) > 0);
  assert.ok(parseFloat(narrow.map.style.left) + parseFloat(narrow.map.style.width) <= 610);
  const wide = mapHarness({ desktop: true, width: 1440, actionsWidth: 80, rightToolLeft: 1200 });
  assert.equal(wide.map.style.top, '6px');
  assert.ok(parseFloat(wide.map.style.left) >= 128 + 36 + 80 + 80);
  assert.ok(parseFloat(wide.map.style.left) + parseFloat(wide.map.style.width) <= 1160);
});

test('history overlay retains iframe dismissal and readable dark theme styles', () => {
  const sideList = stageSource.slice(stageSource.indexOf('function stSideList()'), stageSource.indexOf('async function stSync('));
  const hold = stageSource.slice(stageSource.indexOf('function stHold('), stageSource.indexOf('// Delay single-click navigation'));
  assert.match(sideList, /历史与设置/);
  assert.match(sideList, /settings\.open = stPanel\(\)\.toolsOpen \?\? true/);
  assert.match(hold, /e\.key === "Escape" && ST\.listOpen\) \{ stDropToggle\(false, true\); e\.preventDefault\(\); e\.stopImmediatePropagation\(\); return; \}/);
  assert.match(hold, /doc\.addEventListener\("click", \(e\) => \{\s*if \(ST\.listOpen && !e\.defaultPrevented\) stDropToggle\(false\)/);
  assert.match(stageSource, /settingsButton\.textContent = "⚙"/);
  assert.match(stageSource, /function stDropToggle\(open, restoreFocus = false\)/);
  assert.match(stageSource, /if \(ST\.listOpen\) \{ stDropToggle\(false, true\); e\.preventDefault\(\); e\.stopImmediatePropagation\(\); return; \}/);
  assert.match(css, /#vStage #stlist #stlq \{ background:var\(--panel\); color:var\(--text\);/);
  assert.match(css, /#vStage #stlist #stlq::placeholder \{ color:var\(--muted\);/);
  assert.match(css, /#vStage #stlist\.stlist\.side\s*\{[^}]*position:absolute; left:8px; top:36px;[^}]*padding:10px 8px/s);
});
