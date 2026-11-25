import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const more=fs.readFileSync('src/pga/web/app-more.js','utf8');
const chats=fs.readFileSync('src/pga/web/app-chats.js','utf8');
const PICKS=[{agent:'codex',model:'',effort:''},{agent:'claude',model:'opus',effort:'high'}];
function harness(api,{presets=[],stored=null}={}) {
 const sent=[],errors=[],picked=[],kept={...(stored?{pga_split_right:JSON.stringify(stored)}:{})};
 const S={uid:'u',chat:'chat:a',chatAgent:'codex',agents:[{name:'claude'},{name:'codex'}],chatTurns:{'chat:a':[{run:'r',agent:'claude'}]}};
 const c=vm.createContext({S,api,composerBusy:()=>false,renderChat(){},loadChat:async()=>{},splitSend:async text=>sent.push(text),toast:s=>errors.push(s),L:s=>s,
  agentLabel:s=>s,EFF_ZH:{high:'高'},mrPresets:()=>presets,store:{get:k=>kept[k],set:(k,v)=>kept[k]=v}});
 vm.runInContext(more.slice(more.indexOf('const SPLIT_RIGHT'),more.indexOf('function splitHtml(')),c);
 vm.runInContext(chats.slice(chats.indexOf('async function secondOpinion('),chats.indexOf('function secondPairHtml(')),c);
 c.pickSplit=(...a)=>picked.push(a);
 return {c,S,sent,errors,picked};
}
test('second opinion first lets you choose who answers on each side, without starting anything',async()=>{
 const calls=[];const h=harness(async(url,opts)=>{calls.push(url);return {};});
 await h.c.secondOpinion('r','chat:a','button');
 assert.deepEqual(calls,[]);assert.deepEqual(JSON.parse(JSON.stringify(h.picked)),[['r','chat:a','button']]);
});
test('the chosen sides start the split, models included, and generate in the same window',async()=>{
 const calls=[];const h=harness(async(url,opts)=>{calls.push({url,body:opts.body});return {question:'question',lanes:[]};});
 await h.c.startSplit('r','chat:a',PICKS);
 assert.match(calls[0].url,/compare-start$/);
 assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)),{key:'chat:a',agents:['codex','claude'],options:[{model:'',effort:''},{model:'opus',effort:'high'}],run:'r'});
 assert.deepEqual(h.sent,['question']);assert.equal(h.S.chat,'chat:a');assert.equal(h.S.splitStarting,false);
});
test('repeated clicks during setup and after split creation do not create duplicate tasks',async()=>{
 let done,n=0;const h=harness(()=>{n++;return new Promise(r=>done=r);});
 const pending=h.c.startSplit('r','chat:a',PICKS);await h.c.startSplit('r','chat:a',PICKS);assert.equal(n,1);
 done({question:'q',lanes:[]});await pending;await h.c.secondOpinion('r','chat:a');assert.equal(n,1);assert.equal(h.picked.length,0);
});
test('failure reports error and allows retry without losing the conversation',async()=>{
 const h=harness(async()=>{throw Error('unavailable');});await h.c.startSplit('r','chat:a',PICKS);
 assert.deepEqual(h.errors,['unavailable']);assert.equal(h.S.splitStarting,false);assert.equal(h.S.chat,'chat:a');assert.equal(h.S.chatSplits,undefined);
});
test('switching windows during creation never sends into the newly selected conversation',async()=>{
 let done;const h=harness(()=>new Promise(r=>done=r));const pending=h.c.startSplit('r','chat:a',PICKS);h.S.chat='chat:b';done({question:'q',lanes:[]});await pending;
 assert.deepEqual(h.sent,[]);assert.ok(h.S.chatSplits['chat:a']);assert.equal(h.S.chat,'chat:b');
});
test('the chooser starts with this window on the left and the right side you chose last time',()=>{
 const presets=[{label:'Opus · 高',agent:'claude',model:'opus',effort:'high'},{label:'Codex · 中',agent:'codex',model:'gpt',effort:'medium'},{label:'Sonnet',agent:'claude',model:'sonnet',effort:''}];
 let h=harness(null,{presets});h.S.agents.push({name:'gemini'});
 let d=JSON.parse(JSON.stringify(h.c.splitDefaults('r','chat:a')));
 assert.deepEqual(d.choices.map(c=>c.label),['codex（当前）','Opus · 高','Codex · 中','Sonnet','gemini']);   // the window's own pick is not a preset
 assert.equal(d.choices[d.li].agent,'codex');assert.equal(d.choices[d.ri].agent,'claude');
 h=harness(null,{presets,stored:{agent:'claude',model:'sonnet',effort:''}});h.c.mrCurrent=()=>({agent:'claude',model:'opus',effort:'high'});
 d=h.c.splitDefaults(null,'chat:a');assert.equal(d.choices[d.li].label,'Opus · 高');assert.equal(d.choices[d.ri].label,'Sonnet');   // the same agent, another model
 h=harness(null);h.S.agents=[{name:'codex'}];assert.equal(h.c.splitDefaults(null,'chat:a'),null);
});

test('composer split button directly opens the chooser and reflects an active split', async () => {
 const h = harness(async () => { throw Error('must choose agents first'); });
 h.c.$ = () => 'composer-button';
 vm.runInContext(chats.slice(chats.indexOf('function branchCountTool('), chats.indexOf('function stageBranch(')), h.c);
 assert.match(h.c.branchCountTool(), /<button type="button" id="branchCount"/);
 assert.doesNotMatch(h.c.branchCountTool(), /disabled|<select/);
 await h.c.branchCopies();
 assert.deepEqual(JSON.parse(JSON.stringify(h.picked)), [[null, 'chat:a', 'composer-button']]);
 h.S.chatSplits = {'chat:a': {lanes: []}};
 assert.match(h.c.branchCountTool(), /disabled/);
 assert.match(h.c.branchCountTool(), /已开启分屏/);
});
