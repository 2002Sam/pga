import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
const src=fs.readFileSync(new URL('../src/pga/web/app-live.js',import.meta.url),'utf8');
const code=src.slice(src.indexOf('function liveSnap()'),src.indexOf('// Keep DOM nodes'));
test('multiple frames share one socket and receive fresh deltas without HTTP',async()=>{
 let sockets=0,requests=0;
 const host={location:{protocol:'http:',host:'localhost'},WebSocket:class{constructor(){sockets++}close(){this.onclose()}}};
 const make=()=>{const c=vm.createContext({window:{top:host},api:async()=>{requests++;return []}});host.document={};vm.runInContext(code,c);return c};
 const a=make(),b=make();await Promise.all([a.liveSnap(),b.liveSnap()]);
 assert.equal(sockets,1);assert.equal(requests,1);
 host.__pgaLive.socket.onmessage({data:JSON.stringify([{id:'r',text:'new'}])});
 assert.equal((await b.liveSnap())[0].text,'new');assert.equal(requests,1);
 host.__pgaLive.socket.onclose();assert.equal(host.__pgaLive.received,0);assert.ok(host.__pgaLive.retryAt>Date.now());
});
test('slow fallback request is not duplicated after cache expiry',async()=>{
 let resolve,calls=0,now=10000;const host={};host.top=host;
 const c=vm.createContext({window:host,Date:{now:()=>now},api:()=>{calls++;return new Promise(r=>resolve=r)}});vm.runInContext(code,c);
 const first=c.liveSnap();now+=5000;const second=c.liveSnap();assert.equal(calls,1);assert.equal(first,second);resolve([]);await first;
});
test('malformed websocket message leaves last valid progress intact',async()=>{
 const host={location:{protocol:'https:',host:'local'},WebSocket:class{}};host.top=host;
 const c=vm.createContext({window:host,api:async()=>[]});vm.runInContext(code,c);await c.liveSnap();
 host.__pgaLive.socket.onmessage({data:'[{"text":"kept"}]'});
 host.__pgaLive.socket.onmessage({data:'broken'});assert.equal((await c.liveSnap())[0].text,'kept');
});
