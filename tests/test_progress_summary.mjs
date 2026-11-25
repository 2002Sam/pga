import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync('src/pga/web/app-live.js', 'utf8');
function setup() {
  const c = vm.createContext({S:{}, L:zh=>zh, esc:String, md:String, document:{getElementById:()=>null,addEventListener(){}},
    window:{}, setInterval(){}, liveSecs:()=> '1.0'});
  vm.runInContext(source, c);
  return c;
}
test('native, namespaced and wrapped tool calls get plain activity labels', () => {
  const c=setup();
  for (const tool of ['Edit','Write','apply_patch','functions.apply_patch','mcp__files__write_file'])
    assert.equal(c.workStatus({},[{t:'tool',tool}],'',true),'正在写代码');
  for (const tool of ['Bash','exec_command','functions.exec_command','terminal','write_stdin'])
    assert.equal(c.workStatus({},[{t:'tool',tool}],'',true),'正在运行命令');
  assert.equal(c.workStatus({},[{t:'tool',tool:'exec',title:'await tools.apply_patch("*** Begin Patch");'}],'',true),'正在写代码');
  assert.equal(c.workStatus({},[{tool:'Bash',target:'secret command'}],'',false),'正在运行命令');
});
test('pending tools take precedence over earlier prose, but completed tools are not shown as running', () => {
  const c=setup(), r={text:'I will check this.'};
  assert.equal(c.workStatus(r,[{t:'tool',tool:'Bash'}],r.text,true),'正在运行命令');
  assert.equal(c.workStatus(r,[{t:'tool',tool:'Bash',secs:2}],r.text,true),'正在写回答');
  assert.equal(c.workStatus({},[{t:'tool',tool:'Edit',secs:0}],'',true),'正在继续处理 · 刚完成代码修改');
});
test('queue, compaction, stop and failure override the activity', () => {
  const c=setup(), steps=[{t:'tool',tool:'Bash'}];
  for(const [r,label] of [[{phase:'queued'},'正在排队'],[{compaction:{status:'running'}},'正在整理上下文'],
    [{stopping:true},'正在停止…'],[{finished:12,ok:false},'运行失败'],[{finished:12,stopping:true},'已停止']])
    assert.equal(c.workStatus(r,steps,'',true),label);
});
test('technical output and environment are behind the default disclosure, with errors still indicated', () => {
  const c=setup();
  const html=c.workCard({run:{id:'r',text:'当前进展\n```js\nintermediate code\n```',started:1,running:true,env:{cwd:'/tmp/project',model:'model'},
    steps:[{t:'tool',tool:'Bash',id:'cmd',title:'sensitive command',output:'large output',secs:2,error:true}]}});
  const summary=html.match(/<summary class="wh">([\s\S]*?)<\/summary>/)[1];
  assert.match(summary,/1 步出错/); assert.doesNotMatch(summary,/sensitive|large output|intermediate|project|model/);
  assert.match(html,/<details class="work-progress"[^>]*>\s*<summary/);
  assert.doesNotMatch(html,/<details class="work-progress"[^>]*\bopen\b/);
  assert.match(html,/<div class="work-detail"><\/div>/);
  assert.doesNotMatch(html,/sensitive command|large output|intermediate code/);
});

test('details materialize only on demand, preserving the latest output without formatting closed content', () => {
  const c=setup(), rendered=[]; c.md=text=>{rendered.push(text);return text;};
  const state={run:{id:'lazy',started:1,text:'progress prose',steps:[{t:'tool',id:'one',tool:'Bash',title:'pwd',output:'old output'}]}};
  c.workCard(state);
  assert.deepEqual(rendered,[]);
  state.folds.set('progress:lazy',true);
  let html=c.workCard(state);
  assert.match(html,/progress prose/);assert.doesNotMatch(html,/old output|<pre>/);
  state.run.steps[0].output='latest output';
  state.folds.set('tool:lazy:one',true);
  html=c.workCard(state);
  assert.match(html,/latest output/);assert.match(html,/pwd/);
  state.folds.set('progress:lazy',false);
  assert.doesNotMatch(c.workCard(state),/latest output/);
  assert.match(c.workCard(state),/progress prose/);
  state.folds.set('progress:lazy',true);
  assert.match(c.workCard(state),/latest output/);
  state.run={id:'next',started:2,steps:[{t:'tool',id:'two',tool:'Bash',output:'next run'}]};
  assert.doesNotMatch(c.workCard(state),/latest output|next run|\bopen\b/);
});

test('revisioned runs skip full content scans and legacy runs still detect changed output', () => {
  const c=setup();
  assert.equal(c.liveContentVersion({id:'r',revision:2,get steps(){throw Error('full scan');}}),'r:2');
  const run={id:'old',steps:[{output:'a'}]},before=c.liveContentVersion(run);
  run.steps[0].output='b';assert.notEqual(c.liveContentVersion(run),before);
});
test('ordinary text streams outside details, and saved legacy work stays collapsed', () => {
  const c=setup(),html=c.workCard({run:{id:'plain',text:'Hello',started:1}});
  assert.match(html,/<\/details>[\s\S]*class="wtext md">Hello/);
  assert.doesNotMatch(c.procBlock({how:{actions:[{tool:'Bash',target:'pwd'}]}}),/<details[^>]*\bopen\b/);
});

test('continuation includes a short progress note or current task without tool arguments', () => {
  const c=setup(), steps=[{t:'note',text:'正在检查布局并验证修改'}, {t:'tool',tool:'Bash',title:'secret command',secs:2}];
  assert.equal(c.workStatus({},steps,'',true),'正在继续处理 · 正在检查布局并验证修改');
  assert.equal(c.workStatus({todos:[{status:'in_progress',content:'验证刷新后的状态'}]},steps,'',true),'正在继续处理 · 验证刷新后的状态');
  assert.equal(c.workStatus({},[{t:'think',text:'private reasoning'},{t:'tool',tool:'Read',secs:1}],'',true),'正在继续处理 · 已读取文件，正在分析');
});

test('adjacent mixed tools share one disclosure while failed calls remain reachable', () => {
  const c = setup();
  const steps = ['Bash','WebSearch','Bash','WebSearch','Bash'].map((tool,i) =>
    ({t:'tool', id:String(i), tool, secs:0, error:i === 4}));
  const state = {run:{id:'grouped',steps,text:'正在整理结果'}};
  c.workCard(state);
  state.folds.set('progress:grouped',true);
  const html = c.workCard(state);
  assert.match(html,/3 次命令 · 2 次网页检索/);
  assert.equal((html.match(/class="work-group"/g)||[]).length,1);
  assert.equal((html.match(/class="hstep tool-progress"/g)||[]).length,0);
  state.folds.set('group:grouped:0',true);
  assert.equal((c.workCard(state).match(/class="hstep tool-progress"/g)||[]).length,5);
});

test('collapsed progress and saved answers show the effort of their own run', () => {
  const c = setup();
  const card = c.workCard({run:{id:'effort', effort:'medium', env:{reasoning_effort:'high'}}});
  assert.match(card.split('</summary>')[0], /推理强度：high/);
  assert.match(c.replyMeta({how:{effort:'high'}}), /推理强度：high/);
  assert.match(c.replyMeta({}), /推理强度：未知/);
});

test('saved tool chunks end at prose and preserve call order', () => {
  const c = setup();
  const steps = ['Bash','Edit','note','Read','Bash'].map(tool =>
    tool === 'note' ? {t:'note',text:'中间说明'} : {t:'tool',tool});
  const html = c.howBlock({steps}, {});
  assert.equal((html.match(/class="work-group"/g) || []).length, 2);
  assert.match(html, /Bash[\s\S]*Edit[\s\S]*<\/details>[\s\S]*中间说明[\s\S]*class="work-group"[\s\S]*Read[\s\S]*Bash/);
});

test('compact tool trail keeps a pending edit visible and hides command input', () => {
  const c = setup(), run = {id:'trail', steps:[
    {t:'tool',tool:'Edit',title:'/project/src/app.js'},
    {t:'tool',tool:'Read',title:'/project/README.md',secs:1},
    {t:'tool',tool:'Bash',title:'pytest secret',secs:0,error:true},
    {t:'tool',tool:'Bash',title:'sensitive command',secs:0}
  ]};
  const state = {run}, html = c.workCard(state);
  const trail = html.match(/<ul class="work-actions"[\s\S]*?<\/ul>/)[0];
  assert.equal((trail.match(/<li /g)||[]).length,3);
  assert.match(trail,/app.js[\s\S]*进行中/);
  assert.match(trail,/运行测试[\s\S]*失败/);
  assert.doesNotMatch(trail,/secret|sensitive|\/project|README/);
  state.folds.set('progress:trail', true);
  assert.doesNotMatch(c.workCard(state),/class="work-actions"/);
  assert.doesNotMatch(c.workActionTrail(run.steps, {finished:1}),/进行中/);
});
