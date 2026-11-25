import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const more = fs.readFileSync('src/pga/web/app-more.js', 'utf8');
const live = fs.readFileSync('src/pga/web/app-live.js', 'utf8');
const flush = () => new Promise(r => setImmediate(r));
function harness(names = ['codex', 'claude']) {
  const calls = [], waiting = [], renders = [], timers = [];
  const S = {chat:'chat:test', multi:names, chatMulti:{'chat:test':names}, chatTurns:{}, sentHist:[], sideBy:{}};
  const box = {value:'question'};
  const c = vm.createContext({S, LIVE:null, TICK:null, Date, Math, L:x=>x, esc:String, md:String, agentLabel:x=>x,
    composerBusy:()=>false, $:()=>box, takeAtts:()=>({images:[],files:[]}), history:{replaceState(){}}, qs:()=>'',
    renderChat:()=>renders.push(c.multiWorkHtml()), loadChats:async()=>{}, loadChat:async()=>{}, loadTimeline(){}, drainFollowups:async()=>{}, toast(){},
    workCard:()=>'<div>single</div>', splitWorkCard:key=>`<div data-progress="${key}"></div>`,
    setInterval:f=>(timers.push(f),timers.length), clearInterval(){}, document:{getElementById:()=>null}, liveSnap:async()=>c.runs || [],
    api:async(url, opts)=>{calls.push({url, body:opts?.body}); if(url.includes('/access?')) return {current:{}};
      if(url.endsWith('/agents/ask')) return new Promise(resolve=>waiting.push(resolve)); return {};}
  });
  vm.runInContext(live.slice(live.indexOf('function runEffortLabel('),live.indexOf('function workCard(')),c);
  vm.runInContext(live.slice(live.indexOf('function livePaintFrame('),live.indexOf('function composerBusy(')),c);
  vm.runInContext(live.slice(live.indexOf('function startLive('),live.indexOf('const TOOLKIND')),c);
  vm.runInContext(live.slice(live.indexOf('function splitWorkId('),live.indexOf('function splitWorkCard(')),c);
  vm.runInContext(more.slice(more.indexOf('async function multiSend('),more.indexOf('/* answers from different agents')),c);
  return {c,S,calls,waiting,renders,timers};
}
test('multi answering has equal columns before either request finishes; each finishes independently', async()=>{
  const h=harness(), done=h.c.multiSend(); await flush();
  assert.equal(h.waiting.length,2);
  assert.match(h.renders.at(-1),/--multi-columns:2/);
  assert.equal((h.renders.at(-1).match(/data-progress=/g)||[]).length,2);
  h.waiting[1]({run_id:'right',agent:'worker B',effort:'high',text:'right answer'}); await flush();
  assert.equal(h.S.sending,true);
  assert.match(h.renders.at(-1),/worker B.*推理强度：high.*right answer/);
  assert.equal((h.renders.at(-1).match(/data-progress=/g)||[]).length,1);
  h.waiting[0]({run_id:'left',text:'left answer'}); await done;
  assert.equal(h.S.multiWork,null); assert.equal(h.S.sending,false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.find(x=>x.url.endsWith('/fold')).body)),{root:'left',runs:['right'],key:'chat:test'});
});
test('same-agent requests track separate runs even if live response order changes',async()=>{
  const h=harness(['codex','codex']), done=h.c.multiSend(); await flush();
  const keys=h.S.multiWork.lanes.map(x=>x.key); assert.notEqual(keys[0],keys[1]);
  h.c.runs=keys.map((key,i)=>({id:`run-${i}`,started:Date.now()/1000,tags:{conversation:'u:'+key},text:`output-${i}`}));
  await h.timers[0](); h.c.runs.reverse(); await h.timers[0]();
  assert.equal(h.S.live.lanes[keys[0]].run.text,'output-0');
  assert.equal(h.S.live.lanes[keys[1]].run.text,'output-1');
  h.waiting.forEach((resolve,i)=>resolve({text:`done-${i}`})); await done;
});
test('failed lane displays its error while the other continues',async()=>{
  const h=harness(), done=h.c.multiSend(); await flush();
  h.waiting[0]({error:'provider unavailable'}); await flush();
  assert.match(h.renders.at(-1),/role="alert">provider unavailable/);
  assert.equal((h.renders.at(-1).match(/data-progress=/g)||[]).length,1);
  h.waiting[1]({text:'success'}); await done;
});

test('saved parallel texts retain separate effort levels even for the same agent', () => {
  const {c} = harness();
  vm.runInContext(more.slice(more.indexOf('function sideBySide('),more.indexOf('async function convene(')),c);
  const versions = ['low','high'].map((effort,i) => ({
    agent:'codex', run:String(i), text:'answer '+i, how:{effort}
  }));
  const columns = c.sideBySide({run:'0',version:'0',versions}).split('<div class="sbc ').slice(1);
  assert.match(columns[0],/codex #1.*推理强度：low[\s\S]*answer 0/);
  assert.match(columns[1],/codex #2.*推理强度：high[\s\S]*answer 1/);
});
