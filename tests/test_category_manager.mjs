import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../src/pga/web/app-manager.js', import.meta.url), 'utf8');
const conv = (key, title, last, extra = {}) => ({ key, title, last, first: last, turns: 2, summary: '', topic: null, asked: [], kind: 'chat', agent: '', ...extra });
function setup(data, wins = []) {
  const box = { innerHTML: '', scrollTop: 0 }, sent = [];
  const ctx = { S: { uid: 'u' }, ST: { nodes: wins.map(w=>({type:"win",...w})) }, stWins: () => wins, stBusy: () => false,
    api: async (url, opts) => { sent.push(opts.body); return data; }, esc: (s) => String(s ?? ''), L: (zh) => zh, ago: () => '刚刚', hueOf: () => 10,
    document: { querySelector: (q) => q === '#pmtree' ? box : null, querySelectorAll: () => [], addEventListener() {} }, addEventListener() {}, CSS: { escape: (s) => s } };
  ctx.window = ctx; vm.runInNewContext(src, ctx);
  return { ctx, box, sent, run: (code) => vm.runInContext(code, ctx) };
}
const DATA = { project: 'PGA', manager: 'chat:pm-x', topics: [{ id: 't1', title: '界面', summary: '' }], outside: [{ key: 'chat:o', title: '外部', project: '论文思考' }],
  conversations: [conv('chat:a', '根', '2026-11-03', { topic: 't1' }), conv('chat:b', '分支', '2026-11-02'), conv('chat:c', '孙', '2026-11-01'), conv('chat:d', '引用者', '2026-10-30')],
  edges: [{ from: 'chat:a', to: 'chat:b', kind: 'branch' }, { from: 'chat:b', to: 'chat:c', kind: 'derived' }, { from: 'chat:c', to: 'chat:a', kind: 'branch' },
    { from: 'chat:a', to: 'chat:d', kind: 'ref' }, { from: 'chat:d', to: 'chat:o', kind: 'ref' }] };

test('lineage ignores a loop, keeps references apart, and sends the stage wires', async () => {
  const wins = [{ id: 'w1', key: 'chat:a' }, { id: 'w2', key: 'chat:d', links: [{ from: 'w1', pin: 0 }] }];
  const t = setup(DATA, wins); t.run('PM.name = "PGA"'); await t.run('pmLoad()');
  assert.deepEqual(JSON.parse(JSON.stringify(t.sent[0])), { project: 'PGA', shown: ['chat:a', 'chat:d'], refs: [['chat:a', 'chat:d']] });
  const m = t.run('PM.m');
  assert.equal(m.parent.get('chat:b'), 'chat:a'); assert.equal(m.parent.get('chat:c'), 'chat:b'); assert.equal(m.parent.has('chat:a'), false);
  assert.deepEqual([...m.refIn.get('chat:d')], ['chat:a']); assert.equal(m.parent.has('chat:d'), false);
});

test('the graph lays every conversation, topic and outside one out around the manager', async () => {
  const t = setup(DATA); t.run('PM.name = "PGA"'); await t.run('pmLoad()'); t.run('PM.mode="graph"; pmLayout()');
  const N = t.run('PM.N'), E = t.run('PM.E');
  assert.equal(N.length, 1 + 1 + 4 + 1); assert.equal(N[0].id, 'hub'); assert.equal(N[0].x, 0); assert.equal(N[0].y, 0);
  assert.ok(N.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
  assert.deepEqual([...E.filter((e) => e.kind === 'ref').map((e) => e.a.id + '>' + e.b.id)], ['chat:a>chat:d', 'chat:d>chat:o']);
  const before = N.map((n) => [n.x, n.y]); t.run('PM.mode="graph"; pmLayout()');
  assert.ok(t.run('PM.N').every((n, i) => Math.hypot(n.x - before[i][0], n.y - before[i][1]) < 60));   // reopening keeps the picture
});

test('opening a category uses one stable normal stage window and deduplicates simultaneous clicks', async () => {
  const t = setup(DATA), opened = [];
  t.ctx.S.view = 'stage';
  t.ctx.toast = message => { throw new Error(message); };
  t.ctx.stOpen = (key, options) => {
    opened.push({key, options});
    let n = t.ctx.ST.nodes.find(n => n.key === key);
    if (!n) { n = {id:'manager',type:'win',key}; t.ctx.ST.nodes.push(n); }
    Object.assign(n, options); return n;
  };
  await Promise.all([t.ctx.mgOpen('PGA'), t.ctx.mgOpen('PGA')]);
  assert.equal(t.sent.length, 1); assert.equal(opened.length, 1);
  assert.equal(opened[0].key, DATA.manager); assert.equal(opened[0].options.managerProject, 'PGA');
  await t.ctx.mgOpen('PGA');
  assert.equal(t.sent.length, 1); assert.equal(t.ctx.ST.nodes.length, 1);
});

test('a manager frame gets references and running state from the enclosing stage', async () => {
  const t = setup(DATA);
  const wins = [{type:'win',id:'root',key:'chat:a'}, {type:'win',id:'kid',key:'chat:d',links:[{from:'root'}]}];
  t.ctx.parent = {mgOpen(){},ST:{nodes:wins},stWins:()=>wins,stBusy:n=>n.key==='chat:d'};
  t.run('PM.name="PGA"'); await t.run('pmLoad()');
  assert.deepEqual(JSON.parse(JSON.stringify(t.sent[0].refs)), [['chat:a','chat:d']]);
  assert.deepEqual([...t.run('pmLive()')], ['chat:d']);
});

test('project identity survives URL reload and restored stage nodes without leaking to other chats', () => {
  const t = setup(DATA, [{type:'win',key:'chat:pm-paper',managerProject:'论文思考'}]);
  t.ctx.Q = new URLSearchParams({c:'chat:pm-x',manager:'PGA'});
  assert.equal(t.ctx.pmProjectFor('chat:pm-x'), 'PGA');
  assert.equal(t.ctx.pmProjectFor('chat:pm-paper'), '论文思考');
  assert.equal(t.ctx.pmProjectFor('chat:a'), null);
  assert.equal(t.ctx.pmProjectFor('chat:pm-other'), null);
});

test('late project-map responses cannot replace another manager or a newer refresh', async () => {
  const t=setup(DATA), pending=[];
  t.ctx.api=()=>new Promise(resolve=>pending.push(resolve));
  t.run('PM.name="old"'); const old=t.run('pmLoad()');
  t.run('PM.name="PGA"'); const current=t.run('pmLoad()');
  pending[1](DATA); assert.equal(await current,true);
  pending[0]({...DATA,project:'old'});assert.equal(await old,false);
  assert.equal(t.run('PM.data.project'),'PGA');
});

test('fit keeps nodes and labels above the controls in a narrow embedded graph', async () => {
  const t=setup(DATA); t.run('PM.name="PGA"');await t.run('pmLoad()'); t.run('PM.mode="graph"; pmLayout()');
  t.ctx.document.querySelector = q => q === '#pmvp-graph' ? {clientWidth:360,clientHeight:170,hidden:false} : null;
  t.run('pmFit()'); const {k,x,y,N} = t.run('PM');
  for (const n of N) {
    assert(x + (n.x-n.r-52)*k >= 0);assert(x + (n.x+n.r+52)*k <= 360);
    assert(y + (n.y-n.r-12)*k >= -0.01);assert(y + (n.y+n.r+28)*k <= 170-48+0.01);
  }
});

test('search pages render distinct sources and ignore stale responses', async () => {
  const t=setup(DATA), pending=[], box={innerHTML:'',textContent:''}, input={value:''};
  t.ctx.document.querySelector=q=>q==='#pmhits'?box:q==='#pmquery'?input:null;
  t.ctx.api=url=>new Promise(resolve=>pending.push({url,resolve}));
  t.run('PM.name="PGA"');
  const old=t.run('pmSearch("old")'), fresh=t.run('pmSearch("缓存",2)');
  assert.match(pending[1].url,/page=2/);
  pending[1].resolve({sources:[{key:'chat:a',title:'缓存',text:'命中原文',at:'2026-11-04'}],page:2,pages:3,total:17});
  await fresh;
  assert.match(box.innerHTML,/命中原文/); assert.match(box.innerHTML,/data-pmopenpage/);
  assert.match(box.innerHTML,/17 项/);
  pending[0].resolve({sources:[],page:1,pages:1,total:0}); await old;
  assert.match(box.innerHTML,/命中原文/);
});

test('manager no longer exposes its conversation tree', () => {
  assert.doesNotMatch(src,/data-cvopen|function pmTree/);
});
