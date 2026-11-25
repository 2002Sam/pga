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
test('incremental snapshots replace changed runs, remove expired runs, and reconnect from a full snapshot',async()=>{
 const sockets=[];let now=10000;
 const host={location:{protocol:'http:',host:'local'},WebSocket:class{constructor(url){this.url=url;sockets.push(this);}}};host.top=host;
 const c=vm.createContext({window:host,Date:{now:()=>now},api:async()=>[]});vm.runInContext(code,c);await c.liveSnap();
 const emit=(socket,data)=>socket.onmessage({data:JSON.stringify(data)}),first=sockets[0];
 assert.match(first.url,/delta=1/);
 emit(first,[{id:'a',started:1,revision:1,text:'first'},{id:'b',started:2,revision:1,text:'second'}]);
 const b=(await c.liveSnap())[1];
 emit(first,{type:'live_delta',runs:[{id:'a',started:1,revision:2,text:'updated'}],removed:[]});
 assert.equal((await c.liveSnap())[0].text,'updated');assert.equal((await c.liveSnap())[1],b);
 emit(first,{type:'live_delta',runs:[],removed:['a']});assert.equal((await c.liveSnap()).length,1);
 first.onclose();now+=6000;await c.liveSnap();const second=sockets[1];
 emit(second,{type:'live_delta',runs:[],removed:['b']});assert.equal(host.__pgaLive.received,0);
 emit(second,[{id:'new',started:3}]);emit(first,[{id:'stale'}]);
 assert.equal((await c.liveSnap())[0].id,'new');
});
test('reloadable chat frames delegate the shared request to the durable top window',async()=>{
 let resolve,topCalls=0,frameCalls=0;
 const top={document:{}};top.top=top;
 const root=vm.createContext({window:top,api:()=>{topCalls++;return new Promise(r=>resolve=r)}});
 vm.runInContext(code,root);top.liveSnap=root.liveSnap;
 const frame=vm.createContext({window:{top},api:()=>{frameCalls++;throw Error('frame request would be lost on reload')}});
 vm.runInContext(code,frame);
 const first=frame.liveSnap();assert.equal(topCalls,1);assert.equal(frameCalls,0);
 const replacement=vm.createContext({window:{top},api:()=>{throw Error('must use stage')}});vm.runInContext(code,replacement);
 const second=replacement.liveSnap();assert.equal(first,second);resolve([{id:'preserved'}]);
 assert.equal((await second)[0].id,'preserved');assert.equal(top.__pgaLive.pending,false);
});
