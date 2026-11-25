import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const core=fs.readFileSync(new URL('../src/pga/web/app-core.js',import.meta.url),'utf8');
function setup(){
 const pending=[],timers=new Map();let seq=0;
 const c={window:{},location:{origin:'http://local'},Map,Date,AbortController,
   setTimeout:(fn,ms)=>{assert.equal(ms,15000);timers.set(++seq,fn);return seq;},clearTimeout:id=>timers.delete(id),
   fetch:(path,{signal})=>new Promise((resolve,reject)=>{pending.push({path,signal,resolve,reject});signal.addEventListener('abort',()=>reject(Error('aborted')));})};
 c.window.top=c.window;vm.runInNewContext(core.slice(core.indexOf('const SHARED_GET'),core.indexOf('async function api(')),c);
 return {cache:c.window.__pgaShared,pending,timers};
}
test('a hung shared request times out and stops blocking all conversations',async()=>{
 const {cache,pending,timers}=setup(),path='/v1/users/demo/console';
 const a=cache.get(path),b=cache.get(path);assert.equal(a,b);const rejected=assert.rejects(a,/aborted/);
 [...timers.values()][0]();await rejected;assert.equal(pending[0].signal.aborted,true);assert.equal(timers.size,0);
 const retry=cache.get(path);assert.equal(pending.length,2);
 pending[1].resolve({ok:true,text:async()=>'{"agents":[]}'});assert.deepEqual(JSON.parse(JSON.stringify(await retry)),{agents:[]});
 assert.equal(timers.size,0);
});
test('an invalidated old request cannot delete the fresh shared cache on failure',async()=>{
 const {cache,pending}=setup(),path='/v1/users/demo/console';
 const old=cache.get(path);const rejected=assert.rejects(old,/old failure/);cache.clear();
 const fresh=cache.get(path);pending[0].reject(Error('old failure'));await rejected;
 assert.equal(cache.get(path),fresh);assert.equal(pending.length,2);
 pending[1].resolve({ok:true,text:async()=>'{"agents":[]}'});await fresh;
});
