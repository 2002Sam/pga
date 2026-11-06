import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync('src/pga/web/app-stage-dock.js','utf8');
const c=vm.createContext({});vm.runInContext(source.slice(0,source.indexOf('function stDockStart')),c);
test('Dock reorder moves only selected item and leaves source list untouched',()=>{
 const a={id:'a'},b={id:'b'},d={id:'c'},xs=[a,b,d];
 assert.deepEqual(Array.from(c.stDockOrder(xs,b,2)),[a,d,b]);assert.deepEqual(xs,[a,b,d]);
 assert.deepEqual(Array.from(c.stDockOrder(xs,b,0)),[b,a,d]);
});
test('Dock slots clamp to first and last without losing or duplicating windows',()=>{
 const xs=[{id:1},{id:2},{id:3}];
 assert.deepEqual(Array.from(c.stDockOrder(xs,xs[1],-10)),[xs[1],xs[0],xs[2]]);
 assert.deepEqual(Array.from(c.stDockOrder(xs,xs[1],99)),[xs[0],xs[2],xs[1]]);
});
