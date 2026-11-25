import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/pga/web/app-manager.js', import.meta.url), 'utf8');
function between(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.notEqual(a, -1, `missing source marker: ${start}`);
  assert.notEqual(b, -1, `missing source marker: ${end}`);
  return source.slice(a, b);
}
function setup(mode = '') {
  const calls = { layout:0, graph:0, info:0, all:0, api:0, queries:[] };
  const hits = { innerHTML:'', textContent:'' }, stats = { textContent:'' };
  const PM = {name:'PGA', data:{conversations:[{key:'chat:a',title:'A',last:'2026-01-01',turns:2,summary:''}],edges:[],topics:[],outside:[]},
    m:{by:new Map(),parent:new Map(),kind:new Map(),kids:new Map(),refIn:new Map(),refOut:new Map(),names:new Map(),topics:new Map()},
    mode:'graph', searchQuery:'', graphReady:false, pos:new Map(), N:[], E:[]};
  const document = {documentElement:{dataset:{pmfull:mode}}, querySelector(sel){
    calls.queries.push(sel); if(sel==='#pmstats')return stats; if(sel==='#pmhits')return hits; if(sel==='#pmquery')return {value:''}; if(sel==='#pmview')return {}; return null;
  }};
  const context = vm.createContext({PM, document, window:{pdRender(){}}, S:{uid:'u'}, L:s=>s,
    esc:s=>String(s), ago:s=>s, hueOf:()=>30, api:async()=>{calls.api++;return {total:0,page:1,pages:1,sources:[],coverage:''};},
    pmLoad:async()=>true, pmLayout(){calls.layout++;}, pmGraph(){calls.graph++;}, pmFit(){}, pmTransform(){}, pmLight(){},
    pmActivate(){}, pmGraphShow(){calls.graph++;}, pmInfo(){calls.info++;}, pmAll(){calls.all++;},
    pmWins:()=>{calls.wins=(calls.wins||0)+1; return [{key:'chat:a'}];}, pmLive:()=>new Set(), pmQ:()=>null, calls,
  });
  const snippets = [
    between('const pmFullMode =', 'async function pmRequest'),
    between('function pmBoth(', 'const pmColor'),
    between('function pmLayout()', 'function pmEdgePath'),
    between('function pmGraph()', 'function pmTransform'),
    between('function pmInfo()', 'function pmSelect'),
    between('async function pmSearch(', '/* ------------------------------------------------ open the same regular conversation'),
    between('async function pmRefresh(', 'function pmAll()'),
    between('function pmAll()', 'function pmRemove()'),
    between('function pmGraphShow(', 'async function pmRefresh'),
    between('function pmGraphPoll(', '/* ------------------------------------------------ ways in, and links out'),
  ];
  vm.runInContext(snippets.join('\n'), context);
  return {context,calls,hits,stats};
}

test('normal manager document keeps the document and metadata while skipping hidden graph and search work', async()=>{
  const h=setup('');
  await h.context.pmRefresh(true);
  assert.equal(h.context.PM.data.conversations.length,1);
  assert.equal(h.calls.layout,0); assert.equal(h.calls.graph,0); assert.equal(h.calls.info,0); assert.equal(h.calls.all,0);
  assert.equal(h.hits.innerHTML,'');
  assert.equal(h.context.PM.graphReady, false);
});

test('explicit graph view lays out and paints the graph after metadata loads', async()=>{
  const h=setup('graph');
  await h.context.pmRefresh(true);
  assert.equal(h.context.PM.N.length, 2);
  assert.equal(h.context.PM.graphReady, true);
});

test('explicit search view renders the related-conversation list and runs searches', async()=>{
  const h=setup('search');
  await h.context.pmRefresh(true);
  assert.match(h.hits.innerHTML,/chat:a|>A</);
  // The real renderer and search function are active only in explicit search mode.
  h.context.pmAll();
  assert.match(h.hits.innerHTML,/chat:a|>A</);
  await h.context.pmSearch('query');
  assert.equal(h.calls.api,1);
  assert.match(h.hits.innerHTML,/找到 0 项/);
});

test('graph poll does no hidden sampling and watches only the explicit graph view',()=>{
  const h=setup(''); const state={stage:'',live:'',ready:false};
  h.context.pmGraphPoll(false,state);
  assert.equal(h.calls.layout,0); assert.equal(h.calls.graph,0); assert.equal(h.calls.wins||0,0);
  h.context.pmBoth=()=>{h.calls.graph++;};
  h.context.document.documentElement.dataset.pmfull='graph';
  h.context.pmGraphPoll(false,state); // seed baseline without duplicate initial render
  h.context.pmGraphPoll(false,state);
  assert.equal(h.calls.graph,0);
  h.context.pmWins=()=>[{key:'chat:b'}];
  h.context.pmGraphPoll(false,state);
  assert.equal(h.calls.graph,1);
});
