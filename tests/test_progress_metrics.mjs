import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('src/pga/web/app-live.js','utf8');
function setup(){
 const c=vm.createContext({S:{uid:'user',chat:'chat:a',chatTurns:{}},L:zh=>zh,esc:String,md:String,window:{},document:{getElementById:()=>null,addEventListener(){}},setInterval(){}});
 vm.runInContext(source,c);return c;
}
const planned=()=>({run:{id:'r',agent:'codex',started:100,todos:[{content:'implementation',status:'completed'},{content:'verification',status:'in_progress'}]}});
test('verified metrics show counts; legacy connections never invent line totals',()=>{
 const c=setup();
 assert.equal(c.workCodeSummary({code_progress:{added:123,removed:20,files:3,source:'turn_diff'}}).text,'改动 +123 −20 行 · 3 文件');
 assert.match(c.workCodeSummary({code_progress:{added:4,removed:1,files:1,partial:true}}).title,/仅统计已知部分/);
 assert.match(c.workCodeSummary({steps:[{tool:'Edit',secs:1},{tool:'Edit',secs:1,error:true}]}).text,/1 次修改 · 行数待回报/);
 assert.match(c.workCodeSummary({}).text,/待回报/);
});
test('plan estimates count down without moving the deadline and revise when the plan changes',()=>{
 const c=setup(),lv=planned();
 assert.equal(c.workEta(lv,220).text,'还需约 2–4分钟');
 const deadline=lv.eta.high;
 assert.equal(c.workEta(lv,280).text,'还需约 1–3分钟');assert.equal(lv.eta.high,deadline);
 assert.equal(c.workEta(lv,500).text,'已超出预估');
 lv.run.todos.push({content:'new requirement',status:'pending'});
 assert.match(c.workEta(lv,500).text,/还需约/);assert(lv.eta.high>deadline);
 lv.run.todos.forEach(t=>t.status='completed');assert.equal(c.workEta(lv,510).text,'正在收尾');
 lv.run.finished=520;assert.equal(c.workEta(lv,520).text,'');
});
test('queue, approvals and compaction pause estimates; new run and split lanes do not share deadlines',()=>{
 const c=setup(),lv=planned();c.workEta(lv,220);
 for(const [field,value,label] of [['phase','queued','排队中'],['approval',{id:'a'},'等待确认'],['compaction',{status:'running'},'整理上下文中']]){
  lv.run[field]=value;assert.equal(c.workEta(lv,250).text,label);delete lv.run[field];assert.equal(lv.eta,null);
 }
 const another=planned();another.run.id='other';another.run.started=200;c.workEta(lv,300);c.workEta(another,300);
 assert.notEqual(lv.eta.high,another.eta.high);
 lv.run={id:'new',agent:'codex',started:400};assert.equal(c.workEta(lv,410).text,'估算中');
});
test('history estimates use at least three successful same-agent/model turns from this conversation only',()=>{
 const c=setup(),lv={key:'chat:a',run:{id:'r',agent:'codex',started:100,env:{model:'m'}}};
 const turn=s=>({role:'agent',agent:'codex',model:'m',how:{seconds:s}});
 c.S.chatTurns['chat:b']=[turn(10),turn(20),turn(30)];assert.equal(c.workEta(lv,120).text,'估算中');
 c.S.chatTurns['chat:a']=[turn(100),turn(200),{...turn(300),error:'failed'},{...turn(20),agent:'other'},{...turn(20),model:'other'}];
 assert.equal(c.workEta(lv,120).text,'估算中');
 c.S.chatTurns['chat:a'].push(turn(300));assert.match(c.workEta(lv,120).text,/还需约/);assert.match(c.workEta(lv,120).title,/3 次历史/);
 assert.equal(c.workEta(lv,600).text,'已超出预估');
});
test('metric updates invalidate legacy render versions and stay visible while details remain folded',()=>{
 const c=setup(),r={id:'r',agent:'codex',started:Date.now()/1000,steps:[{t:'tool',tool:'Bash',title:'secret args'}]},before=c.liveContentVersion(r);
 r.code_progress={added:23,removed:5,files:2};assert.notEqual(c.liveContentVersion(r),before);
 const html=c.workCard({run:r});assert.match(html,/改动 \+23 −5 行 · 2 文件/);assert.match(html,/work-eta/);assert.match(html,/估算中/);assert.doesNotMatch(html,/secret args/);
});
