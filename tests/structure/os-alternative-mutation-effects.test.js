import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/alternative-mutation.mjs';
function inspect(source){const report=new OsIndependenceChecker(new MemorySourceRepository([[file,"import fs from 'node:fs';"+source]]),{files:[file]}).check();assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));return report;}
for(const source of [
 'const map=new WeakMap();const key={};map.set(key,{file:"ordinary"});map.get(key).file="/proc/self/stat";fs.readFileSync(map.get(key).file);',
 'const first={file:"ordinary"};const second={file:"ordinary"};(flag?first:second).file="/proc/self/stat";fs.readFileSync(first.file);',
 'const first={set file(value){fs.readFileSync(value);}};const second={};(flag?first:second).file="/proc/self/stat";',
 'const map=new WeakMap();const key={};map.set(key,{set file(value){fs.readFileSync(value);}});map.get(key).file="/proc/self/stat";',
 'const map=new WeakMap();const key={};map.set(key,{});map.get(key).read=fs.readFileSync;opaque(map.get(key));',
])test(`alternative mutation visits every possible concrete target: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01'||entry.rule==='OS02'),report.diagnostics.join('\n'));});
for(const source of [
 'const map=new WeakMap();const key={};map.set(key,{file:"ordinary"});map.get(key).file="another";fs.readFileSync(map.get(key).file);',
 'const first={file:"ordinary"};const second={file:"ordinary"};(flag?first:second).file="another";fs.readFileSync(first.file);',
])test(`alternative mutation preserves ordinary targets: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);});
