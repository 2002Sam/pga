import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const core = fs.readFileSync(new URL('../src/pga/web/app-core.js', import.meta.url), 'utf8');
const images = fs.readFileSync(new URL('../src/pga/web/app-images.js', import.meta.url), 'utf8');
const live = fs.readFileSync(new URL('../src/pga/web/app-live.js', import.meta.url), 'utf8');
function processRenderer() {
  const ctx = vm.createContext({esc, L: x => x, S: {uid: 'test-user'}, md: x => esc(x),
    TOOLKIND: () => 'other', TOOLICON: {other: '•'}});
  vm.runInContext(live.slice(live.indexOf('const dur ='), live.indexOf('/* under an answer:')), ctx);
  return ctx;
}
test('generated images are outside collapsed work details even without a Markdown image in the answer', () => {
  const ctx = processRenderer();
  const h = {steps: [{t: 'tool', tool: 'exec', title: 'const result = await tools.image_gen__imagegen({prompt: "logo"});', images: ['24.1']}]};
  const html = ctx.howBlock(h, {session: 'test-session', kind: 'codex'});
  assert.ok(html.indexOf('class="generated-pictures"') > html.lastIndexOf('</details>'));
  assert.match(html, /class="pga-output-image"/);
  assert.match(html, /ref=24.1&amp;kind=codex/);
  assert.match(html, /data-zoom=/);
});
test('generated gallery uses the source of each step, deduplicates and leaves reference screenshots in the log', () => {
  const ctx = processRenderer();
  const pic = {tool: 'imagegen', src: 'codex:source-session', images: ['10.1', '10.1']};
  const html = ctx.generatedPictures([pic, {tool: 'computer', images: ['20.1']}, {...pic, error: true, images: ['30.1']}], {session: 'wrong'});
  assert.equal((html.match(/<img /g) || []).length, 1);
  assert.match(html, /source-session/); assert.doesNotMatch(html, /wrong|20.1|30.1/);
  assert.match(ctx.generatedPictures([{tool: 'image_gen', images: ['0']}], {live: 'running'}), /\/live\/running\/image\/0/);
});
const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
function setup(api = async () => ({kind: 'image', url: '/v1/file-preview/test'})) {
  let renderer;
  const ctx = vm.createContext({esc, L: x => x, S: {uid: 'user', chat: 'current'}, api,
    marked: {use: x => {renderer = x.renderer;}},
    MutationObserver: class {observe() {}}, document: {body: {nodeType: 1, matches: () => false, querySelectorAll: () => []}, addEventListener() {}}});
  vm.runInContext(core.slice(core.indexOf('function localFileLink('), core.indexOf('const md =')), ctx);
  vm.runInContext(images, ctx);
  ctx.fileLinkExtensions();
  return {ctx, renderer};
}
function img(path, key = 'source') {
  return {dataset: {localImage: path}, isConnected: true,
    closest: () => ({dataset: {fileKey: key}}), addEventListener() {}};
}
test('local Markdown images and ordinary image links become inline pictures', () => {
  const {renderer} = setup();
  for (const path of ['cute-cat.png', '/Users/me/猫.png', 'file:///tmp/cat.svg', 'sandbox:/mnt/data/cat.png']) {
    assert.match(renderer.image(path, '', 'cat'), /data-local-image=/);
    const html = renderer.link(path, '', '下载猫图');
    assert.match(html, /<img /); assert.match(html, /data-local-file=/); assert.match(html, /下载猫图/);
  }
  assert.equal(renderer.link('https://example.org/page', '', 'page'), false);
  assert.doesNotMatch(renderer.link('report.pdf', '', 'report'), /<img/);
  assert.doesNotMatch(renderer.link('cat.png', '', '<img src="https://example.org/cat.png">'), /pga-image-link/);
});
test('remote and base64 pictures display; unsafe schemes and attributes cannot execute', () => {
  const {renderer} = setup();
  assert.match(renderer.image('https://example.org/cat.png', '', 'cat'), /src="https:/);
  assert.match(renderer.image('data:image/png;base64,AA==', '', 'cat'), /src="data:image/);
  assert.equal(renderer.image('javascript:alert(1)', '', 'bad'), 'bad');
  assert.match(renderer.image('/tmp/a.png', '', '" onerror="evil'), /&quot; onerror=&quot;/);
});
test('same conversation shares requests; different source conversations resolve separately', async () => {
  const calls = [];
  const {ctx} = setup(async (url, options) => {calls.push(options.body); return {kind: 'image', url: '/preview/' + options.body.key};});
  const a = img('cat.png'), b = img('cat.png'), c = img('cat.png', 'another');
  await Promise.all([ctx.loadOutputImage(a), ctx.loadOutputImage(b), ctx.loadOutputImage(c)]);
  assert.equal(calls.length, 2); assert.equal(calls[0].key, 'source');
  assert.equal(a.src, '/preview/source'); assert.equal(b.src, a.src); assert.equal(c.src, '/preview/another');
});
test('missing images keep an actionable fallback and can load on the next render', async () => {
  let count = 0;
  const {ctx} = setup(async () => {if (++count === 1) throw new Error('missing'); return {kind: 'image', url: '/preview/ok'};});
  const a = img('cat.png'); await ctx.loadOutputImage(a);
  assert.match(a.alt, /点击查看/); assert.equal(a.title, 'missing');
  const b = img('cat.png'); await ctx.loadOutputImage(b); assert.equal(b.src, '/preview/ok');
});
test('late requests do not mutate removed messages; non-image results are not embedded', async () => {
  const {ctx} = setup(); const a = img('cat.png'); a.isConnected = false;
  await ctx.loadOutputImage(a); assert.equal(a.src, undefined);
  const other = setup(async () => ({kind: 'text', text: 'not an image'}));
  const b = img('cat.png'); await other.ctx.loadOutputImage(b);
  assert.equal(b.src, undefined); assert.match(b.alt, /点击查看/);
});
