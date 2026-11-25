import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../src/pga/web/app-browser.js', import.meta.url), 'utf8');

function harness(native = true) {
  const messages = [], opened = [], reads = [], toasts = [], frames = [], observed = new Set();
  let uuid = 0, modal = false;
  const document = { hidden: false, activeElement: null, listeners: {}, addEventListener(k, f) { this.listeners[k] = f; }, querySelector: () => modal ? {} : null };
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.hidden = false; this.value = ''; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    focus() { document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = null; this.onblur?.(); }
    select() { this.selected = true; }
    getBoundingClientRect() { return { x: 600, y: 90, width: 590, height: 610 }; }
    querySelector(selector) { return this.parts?.[selector]; }
  }
  document.createElement = tag => new Element(tag); document.body = new Element('body');
  const panel = new Element('section'); panel.parts = Object.fromEntries(['.fileframes', '.fp-sl', '.fp-sr'].map(k => [k, new Element('div')]));
  const FILE_PANEL = { entries: new Map(), active: null, host: panel };
  const window = { PGA_NATIVE: { browser: native }, webkit: { messageHandlers: { pga: { postMessage: m => messages.push(m) } } },
    addEventListener() {}, open: (...a) => opened.push(a) }; window.top = window;
  const ctx = { window, document, FILE_PANEL, S: { uid: 'user' }, URL, crypto: { randomUUID: () => String(++uuid) }, innerWidth: 1200,
    L: a => a, esc: a => a, toast: v => toasts.push(v), fpIcon: () => '',
    ResizeObserver: class { observe(el) { observed.add(el); } unobserve(el) { observed.delete(el); } }, MutationObserver: class { observe() {} },
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; },
    filePanel: () => panel, fpActive: () => FILE_PANEL.entries.get(FILE_PANEL.active),
    fpTab: () => { const tab = new Element('div'); tab.parts = { '.fp-name': new Element('span') }; return tab; },
    selectFile: id => { FILE_PANEL.active = id; ctx.fpBrowserSync(); },
    openPgaUrl: (...a) => reads.push(a), fpClose: id => { ctx.fpBrowserDispose(FILE_PANEL.entries.get(id)); FILE_PANEL.entries.delete(id); }, fpCycle: () => {} };
  vm.createContext(ctx); vm.runInContext(source, ctx);
  return { ctx, document, panel, messages, reads, opened, toasts, observed, modal: value => { modal = value; }, flush: () => { const work = frames.splice(0); work.forEach(fn => fn()); } };
}

test('addresses are normalized and privileged schemes or embedded passwords are rejected', () => {
  const { ctx } = harness();
  assert.equal(ctx.fpBrowserURL(' example.com/docs '), 'https://example.com/docs');
  assert.equal(ctx.fpBrowserURL('http://localhost:8010/test'), 'http://localhost:8010/test');
  assert.equal(ctx.fpBrowserURL('localhost:8080'), 'https://localhost:8080/');
  for (const url of ['', 'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hello', 'pga://app/', 'https://me:secret@example.com/', 'not a url']) assert.equal(ctx.fpBrowserURL(url), null, url);
});
test('native viewport enables stage wheel forwarding only while the canvas is active',()=>{
  const h=harness();h.ctx.S.view='stage';h.ctx.openPgaBrowser('https://example.com/');h.flush();
  assert.equal(h.messages.at(-1).stageWheel,true);
  h.ctx.S.view='chats';h.ctx.fpBrowserSync();h.flush();assert.equal(h.messages.at(-1).stageWheel,false);
});
test('new page waits for an address; navigating creates a native slot and duplicate URLs select the same tab', () => {
  const h = harness(), en = h.ctx.openPgaBrowser(); h.flush();
  assert.equal(h.document.activeElement, en.address);
  assert.equal(h.messages.some(m => m.op === 'show'), false);
  assert.equal(h.ctx.fpBrowserNavigate(en, 'example.com'), true); h.flush();
  const message = h.messages.findLast(m => m.op === 'show');
  assert.equal(message.url, 'https://example.com/'); assert.equal(message.rect.width, 590);
  assert.equal(h.ctx.openPgaBrowser('https://example.com/'), en);
  assert.equal(h.ctx.FILE_PANEL.entries.size, 1);
  h.ctx.fpBrowserSync(); h.flush();
  assert.equal(h.messages.filter(m => m.op === 'show').length, 1, 'unchanged geometry does not generate repeated native updates');
});
test('navigation callbacks keep the actual URL and title, without overwriting an address being edited', () => {
  const h = harness(), en = h.ctx.openPgaBrowser('https://example.com'); h.flush();
  en.address.focus(); en.address.value = 'new.example.com'; en.address.oninput();
  h.ctx.window.pgaBrowserState({ id: en.id, url: 'https://example.com/final', title: '<script>site title</script>', back: true, forward: false, loading: false });
  assert.equal(en.web, 'https://example.com/final'); assert.equal(en.address.value, 'new.example.com');
  en.address.blur(); assert.equal(en.address.value, 'https://example.com/final');
  assert.equal(en.tab.querySelector('.fp-name').textContent, '<script>site title</script>'); assert.equal(en.back.disabled, false);
  en.back.onclick(); assert.equal(h.messages.at(-1).op, 'back');
  en.reload.onclick(); assert.equal(h.messages.at(-1).op, 'reload');
  h.ctx.window.pgaBrowserState({ id: en.id, loading: true }); en.reload.onclick(); assert.equal(h.messages.at(-1).op, 'stop');
  h.ctx.window.pgaBrowserState({ id: en.id, error: 'Connection failed', loading: false }); assert.equal(en.hint.textContent, 'Connection failed');
});
test('hiding the panel and opening an app dialog hide the native page, then restore it', () => {
  const h = harness(); h.ctx.openPgaBrowser('https://example.com'); h.flush();
  h.panel.hidden = true; h.ctx.fpBrowserSync(); h.flush(); assert.equal(h.messages.at(-1).op, 'hide');
  h.panel.hidden = false; h.ctx.fpBrowserSync(); h.flush(); assert.equal(h.messages.at(-1).op, 'show');
  h.modal(true); h.ctx.fpBrowserSync(); h.flush(); assert.equal(h.messages.at(-1).op, 'hide');
  h.modal(false); h.ctx.fpBrowserSync(); h.flush(); assert.equal(h.messages.at(-1).op, 'show');
});
test('submitted addresses stop editing so page links and redirects update the address bar', () => {
  const h = harness(), en = h.ctx.openPgaBrowser();
  en.address.focus(); en.address.value = 'example.com'; en.address.oninput();
  assert.equal(en.editingAddress, true);
  h.ctx.fpBrowserNavigate(en, en.address.value); h.flush();
  assert.equal(en.editingAddress, false);
  h.ctx.window.pgaBrowserState({ id: en.id, url: 'https://example.com/redirected', loading: false });
  assert.equal(en.address.value, 'https://example.com/redirected');
  h.ctx.window.pgaBrowserState({ id: en.id, action: 'address' });
  assert.equal(h.document.activeElement, en.address); assert.equal(en.address.selected, true);
  h.ctx.window.pgaBrowserState({ id: en.id, action: 'close' });
  assert.equal(h.ctx.FILE_PANEL.entries.size, 0);
});
test('closing a page releases the native tab and observer; late updates cannot reopen it', () => {
  const h = harness(), en = h.ctx.openPgaBrowser('https://example.com'); h.flush();
  assert.equal(h.observed.size, 1); h.ctx.fpClose(en.id);
  assert.equal(h.messages.at(-1).op, 'close'); assert.equal(h.observed.size, 0);
  h.ctx.window.pgaBrowserState({ id: en.id, open: 'https://other.example.com/' });
  assert.equal(h.ctx.FILE_PANEL.entries.size, 0);
});
test('browser-only builds preserve the existing reader without sending native messages', () => {
  const h = harness(false);
  h.ctx.openPgaBrowser('example.com'); assert.deepEqual(h.reads, [['https://example.com/', 'user']]);
  assert.equal(h.messages.length, 0); assert.equal(h.ctx.FILE_PANEL.entries.size, 0);
});
test('new-window links become another PGA tab; malformed navigation never goes to the native bridge', () => {
  const h = harness(), en = h.ctx.openPgaBrowser('https://example.com'); h.flush();
  h.ctx.window.pgaBrowserState({ id: en.id, open: 'https://example.com/next' }); h.flush();
  assert.equal(h.ctx.FILE_PANEL.entries.size, 2); assert.equal(h.opened.length, 0);
  const count = h.messages.length; assert.equal(h.ctx.fpBrowserNavigate(en, 'file:///tmp/private'), false); h.flush();
  assert.equal(h.messages.length, count);
});
