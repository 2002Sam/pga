import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const read = name => fs.readFileSync(`src/pga/web/${name}`, 'utf8');
const extract = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('manager document and draft polling avoid DOM scans while dormant/moving and render again when idle', () => {
  const src = read('app-pmdoc.js');
  const render = extract(src, 'window.pdRender = function () {', '\n};') + '\n};';
  const drafts = extract(src, 'function pdRefreshDrafts() {', '\n}\nfunction pdDraftSource') + '\n}';
  const S = {stageDormant:true, chat:'chat:test'}; const PD = {open:new Set()}; let reads=0;
  const c = vm.createContext({S, PD, PM:{name:'test'}, window:{}, document:{querySelector(){reads++;return null;}},
    pdVisible:()=>true, setInterval(){}, console});
  vm.runInContext(render, c); vm.runInContext(drafts, c);
  c.window.pdRender(); c.pdRefreshDrafts();
  assert.equal(reads, 0, 'busy stage must return before reading or changing UI DOM');
  assert.equal(PD.renderPending, true);
  S.stageDormant=false; S.stageMotion=true; c.window.pdRender(); c.pdRefreshDrafts();
  assert.equal(reads, 0);
  S.stageMotion=false; c.window.pdRender(); c.pdRefreshDrafts();
  assert.equal(reads, 3, 'idle pass resumes the manager render and draft scan');
  assert.equal(PD.renderPending, false);
});

test('stage activation coalesces manager paints, waits for placement, and retries after motion', async () => {
  const src = read('app-live.js');
  const hook = extract(src, 'window.pgaStageActivated = function () {', '\n};') + '\n};';
  const waiter = extract(src, 'function stageTryPendingManagerPaint() {', '\n}\nfunction stageQueueChatRender') + '\n}';
  const S = {stageDormant:false, stageMotion:false};
  const frame={hidden:true}, window={count:0, frameElement:frame};
  let release, idleCalls=0;
  const c=vm.createContext({S, window, stageTryPendingChatRender(){}, stageTryPendingUsagePaint(){},
    stageFrameVisible(){return !frame.hidden;}, pgStageIdleForPaint(){idleCalls++;return new Promise(resolve=>{release=resolve;});}});
  vm.runInContext(`const PD = {renderPending:true}; window.pdRender=()=>{window.count++;PD.renderPending=false;};`,c);
  vm.runInContext(waiter,c); vm.runInContext(hook,c);
  c.window.pgaStageActivated(); c.window.pgaStageActivated();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(idleCalls,1,'repeated activation shares one idle waiter');
  assert.equal(window.count,0,'hidden manager must not render');
  frame.hidden=false; S.stageMotion=true; release();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(window.count,0,'motion that resumes while waiting cancels the paint');
  S.stageMotion=false; c.window.pgaStageActivated(); await Promise.resolve(); await Promise.resolve();
  assert.equal(idleCalls,2,'a later activation can retry after the first waiter settles');
  release(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(window.count,1,'visible idle manager paints the latest pending document');
  c.window.pgaStageActivated(); await Promise.resolve();
  assert.equal(idleCalls,2,'cleared pending state does not start another waiter');
});

test('branch rail maintenance pauses during stage movement and resumes after settling', () => {
  const src = read('app-more.js');
  const block = extract(src, "let relSig = '';", '\n// One deterministic color') + '\n';
  const timers=[]; let paints=0, positions=0;
  const S={stageDormant:true};
  const c=vm.createContext({S, setInterval(fn){timers.push(fn);}, document:{querySelectorAll(){return[];}},
    relOpen:()=>false, relPaint(){paints++;}, relPositions(){positions++;}, $:()=>null,
    stageBranchUiPending:false, convMap(){}, branchTree(){}, requestAnimationFrame(){}, updateParentRail(){}});
  vm.runInContext(block,c);
  assert.equal(timers.length,1);
  timers[0](); assert.equal(paints+positions,0);
  S.stageDormant=false; S.stageMotion=true; timers[0](); assert.equal(paints+positions,0);
  S.stageMotion=false; timers[0](); assert.equal(positions,1,'position strip refresh resumes when idle');
});

test('project grouping timer does not traverse stage data while busy and resumes when idle', () => {
  const src=read('app-project.js');
  const line=src.slice(src.indexOf('setInterval(() => { if (!S.stageDormant && !S.stageMotion) PJ.fill(); }'), src.indexOf('\n',src.indexOf('setInterval(() => { if (!S.stageDormant && !S.stageMotion) PJ.fill(); }')));
  const timers=[]; let fills=0; const c=vm.createContext({S:{stageDormant:true},PJ:{fill(){fills++;}},setInterval(fn){timers.push(fn);}});
  vm.runInContext(line,c); timers[0](); assert.equal(fills,0);
  c.S.stageDormant=false;c.S.stageMotion=true;timers[0]();assert.equal(fills,0);
  c.S.stageMotion=false;timers[0]();assert.equal(fills,1);
});

test('category and title lookups reuse one index until the timeline, chats or category catalog changes', () => {
  const src = read('app-project.js');
  let builds = 0;
  const S = {tl: {}, chats: []}, PJ = {catalog: {}};
  const c = vm.createContext({S, PJ, recentItems() {}, pjRecentItems() {
    return [{item: 'a', title: 'revision ' + ++builds}];
  }});
  vm.runInContext(extract(src, 'let pjRecentMemo =', 'function pjRecentItems()'), c);
  for (let i = 0; i < 100; i++) assert.equal(c.pjRecentByKey('a').title, 'revision 1');
  c.recentItems().pop();
  assert.equal(c.recentItems().length, 1);
  for (const update of [() => { S.tl = {}; }, () => { S.chats = []; }, () => { PJ.catalog = {}; }]) {
    const before = builds;
    update();
    assert.equal(c.pjRecentByKey('a').title, 'revision ' + (before + 1));
  }
});
