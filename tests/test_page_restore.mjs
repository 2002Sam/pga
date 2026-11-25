import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/pga/web/app-pages.js', import.meta.url), 'utf8');
const start = source.indexOf('window.pgCancelRestore = function (n)');
const end = source.indexOf('\n\n/* ------------------------------------------------ add, switch', start);
const restoreSource = source.slice(start, end);

function harness(progress) {
  let now = 0, next = 0;
  const timers = new Map();
  const clock = class extends Date { static now() { return now; } };
  const c = vm.createContext({
    Date: clock,
    setTimeout(fn, delay) { const id = ++next; timers.set(id, { at: now + delay, fn }); return id; },
    clearTimeout(id) { timers.delete(id); },
    Event: class { constructor(type, options) { this.type = type; this.options = options; } },
    PG: { pending: new Map(), restoreTimers: new Map() },
    ST: { nodes: [] },
    pgWatchScroll() {},
  });
  c.window = c;
  vm.runInContext(restoreSource, c);
  function advance(ms) {
    const target = now + ms;
    while (true) {
      const due = [...timers].filter(([, x]) => x.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at; timers.delete(due[0]); due[1].fn();
    }
    now = target;
  }
  const box = { clientHeight: 100, scrollHeight: 500, scrollTop: 0 };
  let messages = [];
  let draft = null;
  const doc = {
    querySelector(sel) { return sel === '#cdlg' ? box : sel === '#chatText' ? draft : null; },
    querySelectorAll() { return messages; },
    addEventListener() {},
  };
  const frame = { isConnected: true, contentDocument: doc, contentWindow: { S: {}, eval() {} },
    hasAttribute(name) { return name === 'src' && this.src; }, src: true };
  const n = { id: 'n1', key: 'chat:test', el: { querySelector: () => frame } };
  c.ST.nodes = [n]; c.PG.pending.set(n.id, progress);
  c.window.pgRestore(n, frame);
  return { c, n, frame, doc, box, timers, advance, setMessages(xs) { messages = xs; }, setDraft(x) { draft = x; } };
}

test('restore and draft retries stop when the iframe document is disposed', () => {
  const h = harness({ msgs: 4, msg: 2, end: true, draft: 'saved draft' });
  h.advance(5000); assert.ok(h.timers.size > 0);
  h.frame.src = false; h.frame.contentDocument = { querySelector() { return null; } };
  h.c.window.pgCancelRestore(h.n);
  h.advance(60000);
  assert.equal(h.timers.size, 0);
  assert.equal(h.c.PG.restoreTimers.size, 0);
  assert.equal(h.n._pgRestoring, undefined);
});

test('empty history restore and draft wait have a finite deadline', () => {
  const h = harness({ msgs: 4, msg: 2, end: true, draft: 'saved draft' });
  h.advance(30001);
  assert.equal(h.timers.size, 0);
  assert.equal(h.c.PG.restoreTimers.size, 0);
  assert.equal(h.n._pgRestoring, undefined);
});

test('normal restore waits for history, restores scroll and draft, then releases callbacks', () => {
  const h = harness({ msgs: 2, msg: 0, end: true, draft: 'saved draft' });
  h.advance(500);
  h.setMessages([{ getBoundingClientRect: () => ({ top: 0, bottom: 20 }) }, { getBoundingClientRect: () => ({ top: 20, bottom: 40 }) }]);
  h.setDraft({ value: '', dispatchEvent() {} });
  h.advance(6500);
  assert.equal(h.box.scrollTop, h.box.scrollHeight);
  assert.equal(h.doc.querySelector('#chatText').value, 'saved draft');
  assert.equal(h.timers.size, 0);
  assert.equal(h.c.PG.restoreTimers.size, 0);
});
