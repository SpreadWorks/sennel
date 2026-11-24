import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/renamed-weak-set.mjs';
function inspect(source){
 const report=new OsIndependenceChecker(new MemorySourceRepository([[file,`import fs from 'node:fs';${source}`]]),{files:[file]}).check();
 assert.ok(!report.diagnostics.some(entry=>entry.rule==='OS00'),report.diagnostics.join('\n'));
 return report;
}
for(const source of [
 'new WeakSet().has(fs.readFileSync);',
 'const set=new WeakSet();set.add(set.has);set.has(set.has);',
 'const set=new WeakSet();Object.freeze(set);set.add({});set.delete({});set.has(fs.readFileSync);',
 'const set=new WeakSet();set.extra="ordinary";set.has(fs.readFileSync);',
 'new WeakSet().delete(fs.readFileSync);',
 'new WeakSet(null).has(fs);',
 'new WeakSet(undefined).has(fs);',
 'const Renamed=WeakSet;new Renamed().has(fs.readFileSync);',
 'new globalThis.WeakSet().has(fs.readFileSync);',
 'const set=new WeakSet();const alias=set;alias.has(fs.readFileSync);',
 'const set=new WeakSet();set.add(fs.readFileSync);set.has(fs.readFileSync);set.delete(fs.readFileSync);',
 'new WeakSet().add({path:"/proc/self/stat"}).has(fs.readFileSync);',
 'new WeakSet().has({get valueOf(){return fs.readFileSync;}});',
 'new WeakSet().has("/proc/self/stat");new WeakSet().delete(1);',
 'function read(set,key){return set.has(key);}read(new WeakSet(),fs.readFileSync);',
 'class Cache{entries=new WeakSet();has(value){return this.entries.has(value);}}new Cache().has(fs.readFileSync);',
 'const first=new WeakSet();const second=new WeakSet();second.has=foreign;first.has(fs.readFileSync);',
])test(`native membership preserves empty allocation and noncoercing boolean result: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
for(const source of [
 'WeakSet();',
 'new WeakSet()();',
 'new WeakSet().has.call({},{});',
 'new WeakSet().has.apply({},[]);',
 'new (new WeakSet().has)({});',
 'new WeakSet().add(1);',
 'new WeakSet().add("key");',
 'new WeakSet(iterable);',
 'new WeakSet({get [Symbol.iterator](){return fs.readFileSync;}});',
 'new WeakSet([]);',
 'const has=new WeakSet().has;has(fs.readFileSync);',
 'WeakSet.prototype.has(fs.readFileSync);',
 'const set=new WeakSet();const fake={has:set.has};fake.has(fs.readFileSync);',
 'const set=new WeakSet();set[method]();',
 'const set=new WeakSet();set.has=foreign;set.has(fs.readFileSync);',
 'const set=new WeakSet();const alias=set;alias.has=foreign;set.has(fs.readFileSync);',
 'WeakSet.prototype.has=foreign;new WeakSet().has(fs.readFileSync);',
 'WeakSet=foreign;new WeakSet().has(fs.readFileSync);',
 'globalThis.WeakSet=foreign;new WeakSet().has(fs.readFileSync);',
 'const Native=WeakSet;opaque(Native);new Native().has(fs.readFileSync);',
 'opaque(WeakSet.prototype);new WeakSet().has(fs.readFileSync);',
 'const set=new WeakSet();opaque(set);set.has(fs.readFileSync);',
 'const first=new WeakSet();const second=new WeakSet();opaque(second);first.has(fs.readFileSync);',
 'const set=new WeakSet();set.reader=fs.readFileSync;opaque(set);',
 'const set=new WeakSet();set.has(fs.readFileSync("/proc/self/stat"));',
 'const set=new WeakSet();set.has(fs.readFileSync);fs.readFileSync("/proc/self/stat");',
 'class WeakSet{has(){return fs.readFileSync("/proc/self/stat");}}new WeakSet().has({});',
 'class WeakSet{has(){return fs.readFileSync;}}opaque(new WeakSet().has({}));',
 'const proxy=new Proxy(new WeakSet(),{});proxy.has(fs.readFileSync);',
 'const map=new WeakMap();const key={};map.set(key,fs.readFileSync);opaque(map.get(key));',
])test(`native membership retains construction, brand and mutation obligations: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));
});

// Whole-source escape remains refused independently of the unchanged has method.
test('a native own-property assignment remains refused while membership keeps its brand',()=>{
 const source='const set=new WeakSet();set.extra=fs.readFileSync;set.has(fs.readFileSync);';
 const report=inspect(source);
 const prefix="import fs from 'node:fs';";
 const assignment=prefix.length+source.indexOf('=fs.readFileSync')+1;
 const membership=prefix.length+source.lastIndexOf('set.has')+1;
 assert.equal(report.ok,false,report.diagnostics.join('\n'));
 assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01'&&entry.classification==='incomplete'
  &&entry.column===assignment&&entry.message==='member/destructuring assignment escapes an OS-sensitive capability'),report.diagnostics.join('\n'));
 assert.deepEqual(report.diagnostics.filter(entry=>entry.column===membership),[]);
});

// A completed static audit covers possible native normal/TypeError completion;
// it does not promise that an unknown caller value is an object at runtime.
test('native insertion of unknown caller data has the common normal-or-TypeError contract',()=>{
 const report=inspect('new WeakSet().add(input);');
 assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);assert.deepEqual(report.diagnostics,[]);
});
