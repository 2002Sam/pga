import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const src = fs.readFileSync(new URL('../src/pga/web/app-more.js', import.meta.url),'utf8');
function render(defaultEffort, selected='model', chosen='') {
  const c={S:{chatAgent:'cx',chatModel:{key:selected},chatEffort:{key:chosen},agentOpts:{cx:{default_model:'model',default_effort:defaultEffort,models:[{id:'model',label:'Model Label',default_effort:'high',efforts:[{id:'low',label:'低'},{id:'high',label:'高'}]}]}}},L:x=>x,esc:String,agentLabel:x=>x==='cx'?'Agent Label':x,CI:{model:'<svg class="model-icon"></svg>'},inlineModelUsage:()=>'',EFF_ZH:{}};
  vm.createContext(c);vm.runInContext(src.slice(src.indexOf('function effortSel('),src.indexOf('const EFF_ZH')),c);
  return c.effortSel('key');
}
test('model default is selected when global default is absent',()=>assert.match(render(null),/value="high" selected/));
test('unsupported configured default does not silently select first effort',()=>assert.match(render('ultra'),/value="" disabled hidden selected/));
test('explicit effort wins',()=>assert.match(render('high','model','low'),/value="low" selected/));
test('unknown model does not borrow another model efforts',()=>assert(!render(null,'unknown').includes('id="chatEffort"')));
test('model control exposes the agent label and model name accessibly with its icon',()=>{
  const html=render(null);
  assert.match(html,/aria-label="选择模型：Agent Label · Model Label"/);
  assert.match(html,/<svg class="model-icon"><\/svg><span class="composer-model-name">Model Label<\/span>/);
});
