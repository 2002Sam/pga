import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const webDir = new URL('../src/pga/web/', import.meta.url);

class FakeElement {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase(); this.id = id; this.children = []; this.parentElement = null;
    this.dataset = {}; this.attrs = {}; this.handlers = {}; this.hidden = false; this.disabled = false;
    this.title = ''; this.innerHTML = ''; this.textContent = '';
    const names = new Set();
    this.classList = { add: (...xs) => xs.forEach(x => names.add(x)), contains: x => names.has(x),
      toggle: (x, force) => { const on = force === undefined ? !names.has(x) : !!force; on ? names.add(x) : names.delete(x); return on; },
      toString: () => [...names].join(' ') };
    Object.defineProperty(this, 'className', { get: () => this.classList.toString(), set: value => { names.clear(); String(value).split(/\s+/).filter(Boolean).forEach(x => names.add(x)); } });
  }
  get isConnected() { return !!this.parentElement; }
  append(...nodes) { for (const node of nodes) { if (!node) continue; node.remove?.(); node.parentElement = this; this.children.push(node); } }
  appendChild(node) { this.append(node); return node; }
  remove() { if (!this.parentElement) return; const p = this.parentElement; p.children = p.children.filter(x => x !== this); this.parentElement = null; }
  replaceWith(...nodes) { const p = this.parentElement; if (!p) return; const i = p.children.indexOf(this); this.remove(); for (const n of nodes) { n.remove?.(); n.parentElement = p; p.children.splice(i++, 0, n); } }
  after(node) { const p = this.parentElement; if (!p) return; node.remove?.(); const i = p.children.indexOf(this); node.parentElement = p; p.children.splice(i + 1, 0, node); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  matches(selector) { return selector.split(',').some(raw => { const s = raw.trim();
    const not = s.match(/^([\w-]+):not\(#([\w-]+)\)$/); if (not) return this.tagName === not[1].toUpperCase() && this.id !== not[2];
    if (s === 'select') return this.tagName === 'SELECT';
    const id = s.match(/^#([\w-]+)$/); if (id) return this.id === id[1];
    const attr = s.match(/^\[([^\]=]+)(?:="([^"]*)")?\]$/); if (attr) {
      const value = this.attrs[attr[1]] ?? this.dataset[attr[1].replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
      return value !== undefined && (attr[2] === undefined || String(value) === attr[2]);
    }
    if (s === 'textarea') return this.tagName === 'TEXTAREA';
    const cls = s.match(/^\.([\w-]+)$/); return !!cls && this.classList.contains(cls[1]);
  }); }
  querySelectorAll(selector) { const out = []; const visit = node => { for (const child of node.children) { if (child.matches(selector)) out.push(child); visit(child); } }; visit(this); return out; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function loadComposer() {
  const chats = fs.readFileSync(new URL('app-chats.js', webDir), 'utf8');
  const compose = fs.readFileSync(new URL('app-compose.js', webDir), 'utf8');
  const selectMenu = fs.readFileSync(new URL('app-select-menu.js', webDir), 'utf8');
  const fn = chats.slice(chats.indexOf('function compactComposer()'), chats.indexOf('\n}', chats.indexOf('function compactComposer()')) + 2);
  const ci = compose.slice(compose.indexOf('const CI = {'), compose.indexOf('\n};', compose.indexOf('const CI = {')) + 3);
  const style = selectMenu.slice(selectMenu.indexOf('function styleComposerSelects'), selectMenu.indexOf('\nlet closeComposerMenu'));
  const bar = new FakeElement('div'); bar.className = 'cbar';
  const host = new FakeElement('div'); host.id = 'ccomp'; host.append(bar);
  const textarea = new FakeElement('textarea', 'chatText'); textarea.value = 'keep this draft'; textarea.selectionStart = 5; textarea.selectionEnd = 9;
  const send = new FakeElement('button', 'chatSend'); send.innerHTML = 'Send';
  const model = new FakeElement('button'); model.setAttribute('data-model-picker', ''); model.innerHTML = 'model';
  const usage = new FakeElement('span'); usage.setAttribute('data-inline-usage', '');
  const usageWrap = new FakeElement('span'); usageWrap.className = 'composer-usage-wrap'; usageWrap.append(usage);
  const effort = new FakeElement('select', 'chatEffort'); effort.title = 'Effort'; effort.selectedOptions = [{ textContent: 'High' }];
  const agent = new FakeElement('select', 'chatAgent');
  const attach = new FakeElement('button'); attach.setAttribute('data-act', 'attach'); attach.innerHTML = 'attach';
  const mic = new FakeElement('button'); mic.setAttribute('data-act', 'mic'); mic.innerHTML = 'mic';
  const web = new FakeElement('button'); web.setAttribute('data-act', 'web'); web.classList.add('on2'); web.innerHTML = 'web';
  const multi = new FakeElement('button'); multi.setAttribute('data-act', 'multi'); multi.setAttribute('data-count', '3'); multi.innerHTML = 'multi';
  const knowledge = new FakeElement('button'); knowledge.setAttribute('data-knowledge-toggle', ''); knowledge.setAttribute('aria-pressed', 'true'); knowledge.classList.add('on');
  const polish = new FakeElement('button', 'polishBtn'); polish.disabled = true; polish.setAttribute('data-polish', 'yes');
  for (const node of [textarea, attach, mic, web, multi, model, usageWrap, effort, agent, knowledge, polish, send]) bar.append(node);
  let styleCalls = 0;
  const c = vm.createContext({
    document: { querySelector: selector => selector === '#ccomp .cbar' ? bar : null,
      createElement: tag => new FakeElement(tag) },
    S: { chat: 'chat:a', chatSplits: { 'chat:a': true } },
    CI: {}, ICO: () => '<svg></svg>', L: x => x, styleComposerSelects: root => { styleCalls++; style(root); },
  });
  vm.runInContext(ci, c); vm.runInContext(style, c); vm.runInContext(fn, c);
  return { c, bar, host, textarea, send, model, usage, usageWrap, effort, agent, attach, mic, web, multi, knowledge, polish, get styleCalls() { return styleCalls; } };
}

test('compactComposer groups existing controls while preserving textarea, send and handlers', () => {
  const h = loadComposer(); let clicks = 0; h.model.addEventListener('click', () => clicks++);
  h.c.compactComposer();
  assert.equal(h.bar.querySelector('textarea'), h.textarea);
  assert.equal(h.bar.querySelector('#chatSend'), h.send);
  assert.equal(h.textarea.value, 'keep this draft');
  h.model.handlers.click[0](); assert.equal(clicks, 1);
  assert.ok(h.bar.querySelector('.composer-input-tools').children.includes(h.attach));
  const pair = h.bar.querySelector('.composer-model-pair');
  assert.ok(pair.children.includes(h.model)); assert.ok(pair.children.includes(h.usageWrap)); assert.ok(pair.children.includes(h.effort));
  assert.equal(h.bar.querySelectorAll('[data-model-picker]').length, 1);
  assert.equal(h.bar.querySelectorAll('.composer-model-name').length, 0);
  assert.equal(h.bar.querySelector('.composer-assist-tools').children.includes(h.multi), true);
});

test('compactComposer is idempotent and keeps active, disabled and data state while iconizing', () => {
  const h = loadComposer(); h.c.compactComposer();
  const groups = h.bar.querySelectorAll('.composer-tool-group');
  const children = groups.map(g => [...g.children]);
  h.c.compactComposer();
  assert.equal(h.bar.querySelectorAll('.composer-tool-group').length, 3);
  assert.deepEqual(h.bar.querySelectorAll('.composer-tool-group').map(g => [...g.children]), children);
  assert.equal(h.web.classList.contains('on2'), true);
  assert.equal(h.knowledge.getAttribute('aria-pressed'), 'true');
  assert.equal(h.knowledge.classList.contains('on'), true);
  assert.equal(h.polish.disabled, true); assert.equal(h.polish.getAttribute('data-polish'), 'yes');
  assert.ok(h.knowledge.innerHTML.includes('<svg'));
});

test('composer controls keep text labels for accessibility and effort uses its custom select trigger', () => {
  const h = loadComposer(); h.c.compactComposer();
  assert.equal(h.bar.querySelectorAll('[data-composer-select]').length, 1);
  assert.equal(h.effort.hidden, true);
  const effortTrigger = h.bar.querySelector('[data-composer-select]');
  assert.equal(effortTrigger.dataset.composerSelect, 'chatEffort');
  assert.match(effortTrigger.getAttribute('aria-label'), /Effort/);
  assert.ok(effortTrigger.innerHTML.includes('<svg'));
});
