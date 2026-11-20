import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/uninspected-result.mjs';const prefix="import fs from 'node:fs';";
function inspect(source){const report=new OsIndependenceChecker(new MemorySourceRepository([[file,prefix+source]]),{files:[file]}).check();assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));return report;}
for(const source of [
 'const input={file:"ordinary"};const result=foreign(input);input.file="/proc/self/stat";opaque(result);',
 'const result=foreign({file:"/proc/self/stat"});opaque(result);',
 'const result=foreign(fs.readFileSync);opaque(result);',
 'const result=foreign(()=>fs.readFileSync);opaque(result);',
 'const result=foreign({get read(){return fs.readFileSync;}});opaque(result);',
])test(`uninspected result preserves input origin until its later consumer: ${source}`,()=>{
 const report=inspect(source),column=prefix.length+source.indexOf('opaque(')+1;
 assert.ok(report.diagnostics.some(entry=>entry.rule==='OS02'&&entry.column===column&&entry.classification==='incomplete'),report.diagnostics.join('\n'));
});
for(const source of [
 'const result=foreign("ordinary");opaque(result);',
 'const result=foreign({file:"ordinary"});opaque(result);',
])test(`uninspected ordinary result does not acquire a native capability: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
for(const source of ['new WeakSet().add(foreign());','new WeakMap().set(Symbol(),false);'])test(`uninspected result does not prove a normal weak insertion: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));
});
for(const source of [
 'foreign("/proc/self/stat");',
 'class Value{constructor(value){this.value=value;}read(){return this.value;}}opaque(new Value("ordinary"));',
 'function sample(process,fs){if(process.platform==="win32")fs.readFileSync("/proc/1/stat");}sample({},{});',
])test(`discarded possible result origins do not invent an actual OS consumer: ${source}`,()=>{
 const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
for(const consumer of ['opaque(result);','fs.readFileSync(result);'])test(`a later consumer inspects the retained unknown result path: ${consumer}`,()=>{
 const report=inspect(`const result=foreign("/proc/self/stat");${consumer}`);
 const column=prefix.length+`const result=foreign("/proc/self/stat");`.length+1;
 assert.ok(report.diagnostics.some(entry=>entry.column===column&&['OS01','OS02'].includes(entry.rule)),report.diagnostics.join('\n'));
});
