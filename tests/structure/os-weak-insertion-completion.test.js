import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/weak-insertion-completion.mjs';
function inspect(source){const report=new OsIndependenceChecker(new MemorySourceRepository([[file,"import fs from 'node:fs';"+source]]),{files:[file]}).check();assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));return report;}
for (const source of [
 'new WeakSet().add(input);',
 'new WeakMap().set(input,"ordinary");',
 'export function store(value){return new WeakSet().add(value);}',
 'export function store(value){return new WeakMap().set(value,"ordinary");}',
 'const map=new WeakMap();map.set(input,"ordinary");opaque(map.get({}));',
 'const map=new WeakMap();map.set(input,"ordinary");opaque(map.get(other));',
])test(`noncoercive native insertion retains possible normal completion: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);});
for (const source of [
 'const map=new WeakMap();map.set(input,fs.readFileSync);opaque(map.get({}));',
 'const map=new WeakMap();map.set(input,fs.readFileSync);opaque(map.get(other));',
 'const map=new WeakMap();map.set(input,fs.readFileSync);opaque(map);',
 'const set=new WeakSet();set.add(input);set.add(fs.readFileSync);opaque(set);',
 'export function store(value){const map=new WeakMap();map.set(value,fs.readFileSync);opaque(map.get({}));}',
 'new WeakSet().add(1);',
 'new WeakSet().add("key");',
 'new WeakSet().add(null);',
 'new WeakMap().set(false,fs.readFileSync);',
 'new WeakMap().set(undefined,fs.readFileSync);',
 'new WeakMap().set(Symbol(),fs.readFileSync);',
 'new WeakMap().set(fs.readFileSync("/proc/self/stat"),false);',
 'const map=new WeakMap();opaque(map);map.set(input,"ordinary");',
 'WeakMap.prototype.set=foreign;new WeakMap().set(input,"ordinary");',
 'new WeakMap(iterable).set(input,"ordinary");',
 'unknown.set(input,fs.readFileSync);',
 'const read=flag?fs.readFileSync:foreign;new WeakMap().set(read,"ordinary");',
])test(`possible insertion does not prove invalid input, unknown receiver or capability consumer: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));});
