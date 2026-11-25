import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const live = fs.readFileSync(new URL('../src/pga/web/app-live.js', import.meta.url), 'utf8');
const chats = fs.readFileSync(new URL('../src/pga/web/app-chats.js', import.meta.url), 'utf8');

test('opening a merged conversation requests only its own history', async () => {
  const keys = [], members = [{key:'chat:nested',title:'Nested'}, {key:'c:import',title:'Imported'}];
  const ctx = vm.createContext({S:{uid:'u',chatTurns:{}}, AbortController, chatHistoryRequest:key => {
    keys.push(key);
    return {result:Promise.resolve({turns:[],merges:{from:members}})};
  }});
  vm.runInContext(live.slice(live.indexOf('async function loadChat(key,'), live.indexOf('function questionReplayKey')), ctx);
  await ctx.loadChat('chat:merged');
  assert.deepEqual(keys, ['chat:merged']);
  assert.deepEqual(ctx.S.chatSources['chat:merged'], members);
  ctx.esc = String;
  vm.runInContext(chats.slice(chats.indexOf('function consolidatedSourcesHtml('), chats.indexOf('function chatTurnsHtml(')), ctx);
  const html = ctx.consolidatedSourcesHtml('chat:merged');
  for (const member of members) assert.ok(html.includes(`data-source-chat="${member.key}"`));
});
