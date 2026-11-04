import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../src/pga/web/app-project.js',import.meta.url),'utf8');
function harness() {
  const calls=[], opened=[];
  const catalog={names:['PGA','论文思考','日常对话'],of:{'c:imported':'PGA'},drafts:{}};
  const root={PJ:{},S:{uid:'u',view:'stage'},ST:{nodes:[]},recentItems:()=>[{item:'c:imported',title:'导入的对话',project:'旧分类'}],
    api:async(url,opts)=>{if(!opts) return structuredClone(catalog);calls.push(opts.body);const key=opts.body.key || 'chat:new';catalog.of[key]=opts.body.project;if(opts.body.create)catalog.drafts[key]={at:'2026-10-31'};return {key,project:opts.body.project};},
    stOpen:key=>opened.push(key),stRender(){},stListItems(){},stSave(){},renderRecent(){},loadTimeline:async()=>{},
    L:x=>x,toast(){},document:{addEventListener(){},querySelector(){return null;}},localStorage:{setItem(){}},setTimeout(){}};
  root.window=root; root.parent=root;
  const ctx=vm.createContext(root);
  vm.runInContext(source.slice(source.indexOf('// Categories are persisted')),ctx);
  return {ctx,calls,opened};
}
test('creating within a category persists assignment before opening and resists double clicks',async()=>{
  const h=harness(); await Promise.all([h.ctx.pjCreate('论文思考'),h.ctx.pjCreate('论文思考')]);
  assert.equal(h.calls.length,1); assert.deepEqual(h.opened,['chat:new']);
  const draft=h.ctx.recentItems().find(x=>x.item==='chat:new');
  assert.equal(draft.project,'论文思考'); assert.equal(draft.kind,'chat');
  assert.equal(h.ctx.PJ.fold['论文思考'],false);
});
test('moving an imported chat immediately changes its displayed category',async()=>{
  const h=harness(); await h.ctx.pjAssign('c:imported','论文思考');
  assert.equal(h.ctx.recentItems()[0].project,'论文思考');
  assert.equal(h.ctx.recentItems()[0].title,'导入的对话');
});
