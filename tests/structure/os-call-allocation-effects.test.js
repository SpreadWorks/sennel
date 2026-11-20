import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/call-allocation.mjs';
function inspect(source){const report=new OsIndependenceChecker(new MemorySourceRepository([[file,"import fs from 'node:fs';"+source]]),{files:[file]}).check();assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));return report;}
for(const source of [
 'function make(){return new WeakMap();}const map=make();const key={};map.set(key,fs.readFileSync);opaque(map.get(key));',
 'function make(C){return new C();}const set=make(WeakSet);const map=make(WeakMap);const key={};set.add(key);map.set(key,fs.readFileSync);opaque(map.get(key));',
 'function make(){return {file:"ordinary"};}const input=make();input.file="/proc/self/stat";fs.readFileSync(input.file);',
 'function make(input){return {input};}const input={};const holder=make(input);holder.file="/proc/self/stat";fs.readFileSync(holder.file);',
 'function outer(read){return function make(){return {read};};}const safe=outer(()=>0);const unsafe=outer(fs.readFileSync);opaque(safe());opaque(unsafe());',
 'function make(read){return {read};}const safe=make(()=>0);const unsafe=make(fs.readFileSync);opaque(safe);opaque(unsafe);',
 'function make(input){return {read:input.read};}const input={read:null};opaque(make(input));input.read=fs.readFileSync;opaque(make(input));',
 'function make(input){return {read:input.read};}const input={read:null};opaque(make(input));opaque(input);opaque(make(input));',
 'function read(input){fs.readFileSync(input.file);}function run(input){read(input);}const input={file:"ordinary"};run(input);input.file="/proc/self/stat";run(input);',
 'function make(C){return new C();}const map=make(WeakMap);WeakMap.prototype.get=foreign;opaque(map.get({}));',
 'function make(){return new WeakMap();}function outer(){return make();}const map=outer();const key={};map.set(key,fs.readFileSync);opaque(map.get(key));',
 'const first={make(){return {read:this.read};},read:null};const second={make:first.make,read:fs.readFileSync};opaque(first.make());opaque(second.make());',
])test(`call allocation keeps writes and distinct captured inputs: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));});
for(const source of [
 'function make(){return new WeakMap();}const map=make();const key={};map.set(key,"ordinary");opaque(map.get(key));',
 'function make(){return new WeakMap();}const first=make();const second=make();const key={};first.set(key,fs.readFileSync);opaque(second.get(key));',
 'function make(C){return new C();}const set=make(WeakSet);const map=make(WeakMap);const key={};set.add(key);map.set(key,"ordinary");opaque(map.get(key));',
 'function make(){return {file:"ordinary"};}const input=make();input.file="another";fs.readFileSync(input.file);',
 'function make(){return new WeakMap();}function outer(){return make();}const first=outer();const second=outer();const key={};first.set(key,fs.readFileSync);opaque(second.get(key));',
])test(`call allocation preserves ordinary results and separate sites: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);});
