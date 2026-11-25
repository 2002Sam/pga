import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../src/pga/web/app-recycle.js', import.meta.url), 'utf8');
function setup(archived) {
  const calls = [], closed = [], toastEl = {appendChild(){}, style:{}, classList:{remove(){}}};
  const wins = [{id:'w1',key:'chat:a'},{id:'w2',key:'chat:b',done:1},{id:'w3',key:'chat:c'}];
  const c = {S:{uid:'u'}, ST:{focus:'w3', nodes:wins}, document:{hidden:false}, L:x=>x, console,
    $:sel => sel === '#vStage' ? {dataset:{ready:'1'}} : toastEl, stWins:()=>wins, stClose:n=>closed.push(n.key),
    toast(){}, setTimeout:()=>0, clearTimeout(){}, setInterval(){},
    api:async (url, opts) => { calls.push({url, body:opts?.body}); return url.endsWith('/recycle') ? {archived:archived.map(key=>({key}))} : {}; }};
  c.window = c; vm.createContext(c); vm.runInContext(src, c);
  return {c, calls, closed};
}
test('the stage reports what you saw, and closes the pages the rules archived except the one in front of you', async () => {
  const {c, calls, closed} = setup(['chat:a', 'chat:c']);
  c.stSaw('chat:a');
  await c.rcSweep();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), {url:'/v1/users/u/chats/seen', body:{keys:['chat:a']}});
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1].body)), {unread:['chat:b'], visible:['chat:c']});
  assert.deepEqual([...closed], ['chat:a']);
});
test('a conversation frame (not the stage) does nothing', async () => {
  const {c, calls} = setup(['chat:a']);
  c.$ = () => null;
  c.stSaw('chat:a'); await c.rcSweep();
  assert.equal(calls.length, 0);
});
