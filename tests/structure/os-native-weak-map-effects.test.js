import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/renamed-weak-map.mjs';
function inspect(source){const report=new OsIndependenceChecker(new MemorySourceRepository([[file,"import fs from 'node:fs';"+source]]),{files:[file]}).check();assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));return report;}
for(const source of [
 'new WeakMap().has(fs.readFileSync);',
 'new WeakMap().delete(fs.readFileSync);',
 'opaque(new WeakMap().get(fs.readFileSync));',
 'new WeakMap(null).has(fs);',
 'new WeakMap(undefined).has(fs);',
 'const Native=WeakMap;new Native().has(fs);',
 'new globalThis.WeakMap().has(fs);',
 'const map=new WeakMap();const key={};map.set(key,"ordinary");opaque(map.get(key));',
 'const map=new WeakMap();const key={};const alias=key;map.set(key,"ordinary");opaque(map.get(alias));',
 'const map=new WeakMap();map.set(fs.readFileSync,"ordinary");opaque(map.get(fs.readFileSync));',
 'const map=new WeakMap();map.set({},fs.readFileSync);map.has(fs.readFileSync);',
 'const map=new WeakMap();map.set({},fs.readFileSync);opaque(map.get({}));',
 'const map=new WeakMap();map.set({},fs.readFileSync);opaque(map.get(1));',
 'const map=new WeakMap();map.extra="ordinary";map.has(fs.readFileSync);',
 'const first=new WeakMap();const second=new WeakMap();second.get=foreign;first.has(fs.readFileSync);',
 'const map=new WeakMap();Object.freeze(map);const key={};map.set(key,"ordinary");opaque(map.get(key));',
 'Object.preventExtensions(new WeakMap()).set({},true).has(fs.readFileSync);',
 'const map=new WeakMap();map.set(map.get,true);map.has(map.get);',
])test(`native weak map preserves ordinary normal results without exposing private keys: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);});
for(const source of [
 'WeakMap();',
 'new WeakMap()();',
 'new WeakMap([]);',
 'new WeakMap(iterable);',
 'new WeakMap().set(1,fs.readFileSync);',
 'new WeakMap().set("key",true);',
 'const get=new WeakMap().get;get(fs.readFileSync);',
 'new WeakMap().get.call({},fs.readFileSync);',
 'new WeakMap().get.apply({},[fs.readFileSync]);',
 'new (new WeakMap().get)({});',
 'WeakMap.prototype.get(fs.readFileSync);',
 'const map=new WeakMap();map.get=foreign;opaque(map.get({}));',
 'const map=new WeakMap();const alias=map;alias.get=foreign;opaque(map.get({}));',
 'WeakMap.prototype.get=foreign;new WeakMap().get(fs.readFileSync);',
 'WeakMap=foreign;new WeakMap().has(fs.readFileSync);',
 'globalThis.WeakMap=foreign;new WeakMap().has(fs.readFileSync);',
 'opaque(WeakMap.prototype);new WeakMap().has(fs.readFileSync);',
 'const map=new WeakMap();opaque(map);map.has(fs.readFileSync);',
 'const first=new WeakMap();const second=new WeakMap();opaque(second);first.has(fs.readFileSync);',
 'const map=new WeakMap();const key={};map.set(key,fs.readFileSync);opaque(map.get(key));',
 'const map=new WeakMap();const key={};map.set(key,fs.readFileSync);opaque(map.get(unknown));',
 'const map=new WeakMap();const key={};map.set(key,()=>fs.readFileSync);opaque(map.get(key));',
 'const map=new WeakMap();const key={};map.set(key,fs.readFileSync);map.get(key)("/proc/self/stat");',
 'const map=new WeakMap();const key={};map.set(key,fs.readFileSync);if(flag)map.delete(key);opaque(map.get(key));',
 'const map=new WeakMap();map.set({},fs.readFileSync);opaque(map);',
 'const map=new WeakMap();map.set(fs.readFileSync,"ordinary");opaque(map);',
 'const map=new WeakMap();map.has(fs.readFileSync("/proc/self/stat"));',
 'const map=new WeakMap();map.set({},fs.readFileSync("/proc/self/stat"));',
 'const map=new WeakMap();map[method](fs.readFileSync);',
 'new Proxy(new WeakMap(),{}).has(fs.readFileSync);',
 'class WeakMap{get(){return fs.readFileSync;}}opaque(new WeakMap().get({}));',
])test(`native weak map retains brand, mutation and retrieved capability obligations: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));});

test('a changed native key property cannot prove disjointness from a stored key',()=>{
 const source='const map=new WeakMap();map.set(fs.readFileSync,()=>fs.readFileSync);fs.writeFileSync=fs.readFileSync;opaque(map.get(fs.writeFileSync));';
 const report=inspect(source);
 const column="import fs from 'node:fs';".length+source.indexOf('opaque(')+1;
 assert.ok(report.diagnostics.some(entry=>entry.rule==='OS02'&&entry.column===column),report.diagnostics.join('\n'));
});

for (const source of [
 'const map=new WeakMap();map.set(map.get,fs.readFileSync);opaque(map.get(WeakMap.prototype.get));',
 'const map=new WeakMap();map.set(map.has,fs.readFileSync);opaque(map.get(WeakMap.prototype.has));',
 'const map=new WeakMap();map.set(map.get,fs.readFileSync);opaque(map.get(new WeakMap().get));',
]) test(`prototype and branded method projections retain identical native key origin: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));
});
test('distinct unchanged native weak methods remain distinct keys',()=>{
 const report=inspect('const map=new WeakMap();map.set(map.has,fs.readFileSync);opaque(map.get(WeakMap.prototype.get));');
 assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
