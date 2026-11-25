import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../src/pga/web/app-pmdoc.js', import.meta.url), 'utf8');
function setup() {
  const requests = [], intervals = [];
  const c = {S:{uid:'u',chat:'chat:pm-a'},PM:{name:'A'},chatSend(){},
    document:{hidden:false,querySelector:()=>({}),addEventListener(){}},frameElement:null,L:x=>x,
    setInterval(fn,ms){intervals.push({fn,ms});}, console,
    api:url=>new Promise(resolve=>requests.push({url,resolve}))};
  c.window=c; vm.createContext(c);vm.runInContext(src,c);c.pdRender=()=>{};
  return {c,requests,intervals,read:()=>vm.runInContext('PD.activity',c)};
}
function documentModel() {
  const t = setup(), question = '然后现在改成shift+ctrl进行管理员快速发送';
  t.c.S.chatTurns = {'chat:pm-a':[{role:'user',run:'note',text:question,at:'2026-11-12T01:00:00Z'}]};
  // Persisted dispatch entries have the target key and title, but no task text/run.
  t.c.S.chatDispatch = {'chat:pm-a':[{id:'dispatch',run:'note',tasks:[{key:'chat:task',title:'管理员快速发送改为Shift+Ctrl',agent:'claude'}]}]};
  t.c.pdTitle = k => k;
  const activity = (id='task-run', key='chat:task', text=question, at='2026-11-12T01:00:01Z') => ({id,key,text,at,status:'RUNNING',answer:''});
  const model = rows => {t.c.activityRows=rows;vm.runInContext('PD.activity = activityRows',t.c);return t.c.pdModel();};
  return {...t,question,activity,model};
}
test('a dispatched input is rendered once, with its exact task target and live status',()=>{
  const {model,activity,question} = documentModel();
  let rows=model([activity()]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].text,question);
  assert.equal(rows[0].notes[0].title,'管理员快速发送改为Shift+Ctrl');
  assert.equal(rows[0].notes[0].key,'chat:task');
  assert.equal(rows[0].notes[0].run,'task-run');
  assert.equal(rows[0].notes[0].find,question);
  assert.equal(rows[0].notes[0].st,'running');
  for (const [status,state] of [['SUCCEEDED','done'],['FAILED','error']]) {
    rows=model([{...activity(),status,answer:'处理结果'}]);
    assert.equal(rows.length,1);
    assert.equal(rows[0].notes[0].st,state);
    assert.equal(rows[0].notes[0].body,'处理结果');
  }
});
test('later inputs, identical resends, steering and other conversations remain visible',()=>{
  const {model,activity,question} = documentModel();
  const rows=model([activity(),activity('task-run:steer:s1','chat:task','追加要求'),
    activity('followup','chat:task',question,'2026-11-12T01:01:00Z'),activity('direct','chat:other',question)]);
  assert.deepEqual(Array.from(rows,r=>r.id),['note','activity:task-run:steer:s1','activity:direct','activity:followup']);
  assert.equal(rows[0].notes[0].run,'task-run');
});
test('split tasks keep their own paragraphs and answers without duplicating raw activity',()=>{
  const {c,model,activity} = documentModel();
  c.S.chatDispatch['chat:pm-a'][0].tasks.push({key:'chat:second',title:'第二项',agent:'codex'});
  const first=activity('task-run','chat:task','第一项\n\n原始需求（仅作为背景与约束，只执行上面分配的任务）：\n完整需求');
  const second=activity('second-run','chat:second','第二项\n\n原始需求：\n完整需求');
  const rows=model([second,first]);
  assert.equal(rows.length,2);
  assert.deepEqual(Array.from(rows,r=>r.notes[0].run),['task-run','second-run']);
  assert.equal(rows[0].notes[0].find,first.text);
});
test('activity is only folded when its dispatch paragraph is actually shown',()=>{
  const {c,model,activity} = documentModel();
  assert.equal(model([]).length,1);
  const turns=c.S.chatTurns['chat:pm-a'];c.S.chatTurns['chat:pm-a']=[];
  assert.equal(model([activity()])[0].id,'activity:task-run');
  c.S.chatTurns['chat:pm-a']=turns;
  assert.equal(model([activity()]).length,1);
  c.S.chatDispatch['chat:pm-a']=[];
  assert.equal(model([activity()]).length,2);
});
test('the first task input is matched by time, never a steering message or later reply',()=>{
  const {model,activity} = documentModel();
  const rows=model([activity('later','chat:task','后续输入','2026-11-12T01:05:00Z'),
    activity('task-run:steer:s1','chat:task','补充'),activity()]);
  assert.equal(rows.length,3);
  assert.equal(rows[0].notes[0].run,'task-run');
  assert.ok(rows.some(r=>r.id==='activity:task-run:steer:s1'));
  assert.ok(rows.some(r=>r.id==='activity:later'));
});
test('category changes fetch immediately despite older request; late data cannot leak',async()=>{
  const t=setup(); const old=t.c.pdRefreshActivity();
  await t.c.pdRefreshActivity(); assert.equal(t.requests.length,1);
  t.c.PM.name='B';t.c.S.chat='chat:pm-b';const fresh=t.c.pdRefreshActivity();
  assert.equal(t.requests.length,2);
  t.requests[1].resolve([{id:'b',text:'B'}]);await fresh;
  t.requests[0].resolve([{id:'a',text:'A'}]);await old;
  assert.equal(t.read()[0].id,'b');
  const retry=t.c.pdRefreshActivity();t.requests[2].resolve([{id:'b',text:'B'}]);await retry;
  assert.equal(t.read().length,1);
  assert.ok(t.intervals.some(x=>x.fn===t.c.pdRefreshActivity && x.ms===1000));
});
test('a hidden manager document stops polling and refreshes when shown again',async()=>{
  const t=setup();let parent={hidden:true,parentElement:null};t.c.frameElement={hidden:false,parentElement:parent};
  await t.c.pdRefreshActivity();assert.equal(t.requests.length,0);
  parent.hidden=false;const visible=t.c.pdRefreshActivity();assert.equal(t.requests.length,1);
  t.requests[0].resolve([{id:'visible'}]);await visible;assert.equal(t.read()[0].id,'visible');
  t.c.document.hidden=true;await t.c.pdRefreshActivity();assert.equal(t.requests.length,1);
});
test('a hidden manager document skips the 150 ms composer scan',()=>{
  const t=setup();let calls=0;t.c.document.querySelector=()=>{calls++;return {};};
  t.c.frameElement={hidden:true,parentElement:null};t.c.pdRefreshDrafts();
  assert.equal(calls,1,'only the visibility check runs; no manager DOM scan follows');
});
test('malformed response is ignored and another user cannot receive a pending response',async()=>{
  const t=setup();let p=t.c.pdRefreshActivity();t.requests[0].resolve({error:'bad'});await p;
  assert.equal(t.read().length,0);
  p=t.c.pdRefreshActivity();t.c.S.uid='another';t.requests[1].resolve([{id:'private'}]);await p;
  assert.equal(t.read().length,0);
});

test('unsent drafts mirror typing, edits and clear without sending; category and account isolation',()=>{
  const t=setup(), texts={a:{value:'正在输入'},b:{value:'另一个分类'},c:{value:'另一个用户'}};
  const node=(id,group,uid='u')=>({id,key:'chat:'+id,type:'win',group,
    el:{querySelector:()=>({contentWindow:{S:{uid,chat:'chat:'+id}},contentDocument:{querySelector:()=>texts[id]}})}});
  const host={ST:{nodes:[node('a','A'),node('b','B'),node('c','A','other')]},stGroupOf:n=>({id:'pj:'+n.group})};
  t.c.pmHost=()=>host;t.c.pdTitle=k=>k;
  assert.equal(t.c.pdDraftRows().length,1);
  assert.equal(t.c.pdDraftRows()[0].text,'正在输入');
  texts.a.value='改过的草稿\n第二行';assert.equal(t.c.pdDraftRows()[0].text,texts.a.value);
  texts.a.value='';assert.equal(t.c.pdDraftRows().length,0);
  t.c.PM.name='B';assert.equal(t.c.pdDraftRows()[0].text,'另一个分类');
  host.ST.nodes=[];assert.equal(t.c.pdDraftRows().length,0);
  assert.equal(t.requests.length,0);
  assert.ok(t.intervals.some(x=>x.fn===t.c.pdRefreshDrafts && x.ms===150));
});
test('manager renders only a quick target link, never answers, process or continue controls',()=>{
  const {c,model,activity}=documentModel();c.esc=String;
  const rows=model([{...activity(),status:'SUCCEEDED',answer:'完整最终答复',progress:[{text:'执行细节'}],archived:{why:'需求已完成'}}]);
  const html=c.pdNoteHtml(rows[0].notes[0]);
  assert.match(html,/data-pdgo="chat:task"/);assert.match(html,/data-pdrun="task-run"/);
  assert.doesNotMatch(html,/已归档|pdarch/);
  assert.doesNotMatch(html,/完整最终答复|执行细节|pdcontinue|pdprocess|pdanswer|pdrestore/);
});
test('two tasks sharing one conversation retain their own status and target run',()=>{
  const {c,model,activity}=documentModel();
  c.S.chatTurns['chat:pm-a'].push({role:'user',run:'note2',text:'第二次需求',at:'2026-11-12T01:02:00Z'});
  const first=c.S.chatDispatch['chat:pm-a'][0];first.tasks[0].task_id='task1';
  c.S.chatDispatch['chat:pm-a'].push({id:'dispatch2',run:'note2',tasks:[{key:'chat:task',task_id:'task2',title:'第二次需求'}]});
  let rows=model([{...activity(),manager_task_id:'task1',status:'SUCCEEDED'},
    {...activity('run2','chat:task','第二次需求','2026-11-12T01:02:01Z'),manager_task_id:'task2'}]);
  assert.equal(rows.length,2);
  assert.equal(rows[0].notes[0].st,'done');assert.equal(rows[0].notes[0].run,'task-run');
  assert.equal(rows[1].notes[0].st,'running');assert.equal(rows[1].notes[0].run,'run2');
  rows=model([{...activity(),manager_task_id:'task1',status:'SUCCEEDED'}]);
  assert.equal(rows[1].notes[0].st,'running');assert.equal(rows[1].notes[0].run,'');
});

test('requested effort is labelled as requested when the adapter did not report the actual value',()=>{
  const {c}=documentModel();c.esc=String;c.agentLabel=a=>a;
  assert.match(c.pdExecution({agent:'codex',requested_effort:'high'}),/codex · 推理强度：请求值 · 高/);
});

test('assigned inputs show their text and destination together, with distinct stable route colors', () => {
  const {c,model,question} = documentModel();
  c.PM.data = {defaults:{execute:{key:'chat:task',title:'执行'},qa:{key:'chat:qa',title:'知识问答和回应'}}};
  c.document.getElementById = () => ({});
  vm.runInContext(fs.readFileSync(new URL('../src/pga/web/tree.js', import.meta.url),'utf8'), c);
  c.esc = c.PGATree.esc;
  c.hueOf = key => { assert.equal(key, 'chat:custom'); return 42; };
  const html = c.pdRowHtml(model([])[0]);
  assert.match(html,/pdbar-text/);
  assert.ok(html.includes(question));
  assert.match(html,/var\(--blue\)/);
  assert.match(html,/data-pdgo="chat:task"/);
  assert.match(html,/执行 ↗/);
  assert.doesNotMatch(html,/class="pdnotes"|cmsg/);
  const tasks = c.S.chatDispatch['chat:pm-a'][0].tasks;
  tasks.push({key:'chat:qa',text:'解释 <button> 的作用'}, {key:'chat:custom',text:'自定义任务'});
  const [, qa, custom] = Array.from(model([]), c.pdRowHtml);
  assert.match(qa,/var\(--green\)/);
  assert.match(qa,/解释 &lt;button&gt; 的作用/);
  assert.match(qa,/知识问答和回应 ↗/);
  assert.ok(qa.includes(question), 'split tasks keep the complete request');
  assert.match(custom,/hsl\(42 /);
  assert.doesNotMatch(c.pdRowHtml({text:'待分配',notes:[]}),/pdbar/);
});

test('inputs synced from another conversation use its route bar and retain the jump target', () => {
  const {c, model, activity} = documentModel();
  c.PM.data = {defaults:{qa:{key:'chat:other', title:'知识问答和回应'}}};
  c.esc = String;
  const row = model([activity('direct','chat:other','另一条提问')]).find(r => r.id === 'activity:direct');
  const html = c.pdRowHtml(row);
  assert.match(html,/class="pdpara pdbar"/);
  assert.match(html,/var\(--green\)/);
  assert.match(html,/知识问答和回应 ↗/);
  assert.match(html,/data-pdgo="chat:other" data-pdrun="direct" data-pdfind="另一条提问"/);
});

test('manager task rows keep a destination link while output belongs to the worker feed', () => {
  const {c,model,activity} = documentModel();
  c.PM.data = {defaults:{execute:{key:'chat:task',title:'执行'}}};
  c.esc = String;
  const html = c.pdRowHtml(model([{...activity(),status:'SUCCEEDED',answer:'执行结果'}])[0]);
  assert.match(html,/执行 ↗/);
  assert.doesNotMatch(html,/执行结果|pdanswer/);
});

test('row whitespace and status share the exact destination of their task link', () => {
  const {c} = documentModel(); c.esc = String;
  const note = {key:'chat:task',run:'second-run',find:'重复的问题',st:'done'};
  for (const conversationTitle of ['', '执行']) {
    const html = c.pdRowHtml({id:'row',text:'重复的问题',notes:[{...note,conversationTitle,conversationKind:'execute'}]});
    const destination = 'data-pdgo="chat:task" data-pdrun="second-run" data-pdfind="重复的问题"';
    assert.ok(html.slice(0,html.indexOf('>')).includes(destination), 'outer row owns the same precise input');
    assert.ok(html.match(/<div class="pdnote pdroute[^>]*>/)[0].includes(destination), 'status owns its task target');
    assert.ok(html.match(/<a class="pdresultlink"[^>]*>/)[0].includes(destination));
  }
});
