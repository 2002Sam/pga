import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
let getResolve, calls = 0, fail = false;
const fields = {'#accFolder': {value: '/project'}, '#accMcp': {checked: false}, '#accDef': {checked: false}};
const ctx = vm.createContext({S: {uid: 'u', view: 'chats'}, Map, CSS: {escape: x => x},
  setInterval() {}, toast() {}, renderChat() {}, L: a => a,
  $: key => fields[key],
  document: {addEventListener() {}, querySelectorAll: () => [], querySelector: sel => sel.includes('accLvl') ? {value: 'full'} : null},
  api: async (url, opts) => {
    calls++;
    if (opts?.method === 'PUT') return {access: opts.body.access, folder: opts.body.folder, mcp: false};
    if (fail) throw Error('offline');
    return new Promise(resolve => { getResolve = resolve; });
  }});
vm.runInContext(fs.readFileSync('src/pga/web/app-access.js', 'utf8'), ctx);
const pending = ctx.loadAcc('chat:a');
await ctx.saveAcc('chat:a');
getResolve({current: {access: 'read', folder: ''}, mcp_servers: []});
await pending;
assert.equal(ctx.S.acc['chat:a'].access, 'full', 'a delayed GET cannot undo a saved permission');
const refreshed = ctx.loadAcc('chat:a', true);
getResolve({current: {access: 'auto', folder: '/new'}, mcp_servers: []});
await refreshed;
assert.equal(ctx.S.acc['chat:a'].access, 'auto', 'opening settings refreshes stale cached permissions');
fail = true;
await assert.rejects(ctx.loadAcc('chat:b'));
fail = false;
const retried = ctx.loadAcc('chat:b');
getResolve({current: {access: 'auto', folder: ''}, mcp_servers: []});
await retried;
assert.equal(ctx.S.acc['chat:b'].access, 'auto', 'failed loads can be retried');
console.log('Permission UI: stale GET, refresh and retry passed');
