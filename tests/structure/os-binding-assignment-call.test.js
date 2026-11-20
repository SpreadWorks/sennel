import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/binding-assignment-call.mjs';
function inspect(source){const report=new OsIndependenceChecker(new MemorySourceRepository([[file,"import fs from 'node:fs';"+source]]),{files:[file]}).check();assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));return report;}
for(const source of [
 'let saved;(saved=()=>"ordinary")();',
 'let saved;const f=(saved=()=>"ordinary");opaque(f());',
 'let saved;(saved=flag?()=>"ordinary":()=>"other")();',
 'let a,b;(a=b=()=>"ordinary")();a();b();',
 'let saved=fs.readFileSync;(saved=()=>"ordinary")();',
 'let saved;(saved=fs.readFileSync)("ordinary");',
 'let saved;const original={read(){fs.readFileSync(this.file);}};const holder={file:"ordinary",f:(saved=original.read)};holder.f();',
])test(`simple assignment returns its RHS value without reading the previous binding: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);});
for(const source of [
 'let saved;(saved=1)();',
 'let saved;(saved=fs.readFileSync)("/proc/self/stat");',
 'let saved;const a=new WeakSet(),b=new WeakSet();const selected=flag?a:b;(saved=selected.has)({});',
 'let saved;const a={read(){return this.file;}},b={read(){return this.file;}};(saved=(flag?a:b).read)();',
 'let saved;const original={file:"ordinary",read(){fs.readFileSync(this.file);}};(saved=original.read)();',
 'let saved;const original={read(){fs.readFileSync(this.file);}};const holder={file:"/proc/self/stat",f:(saved=original.read)};holder.f();',
 'let saved;(saved=()=>"ordinary")(fs.readFileSync("/proc/self/stat"));',
 'let a,b;(a=b=fs.readFileSync)("/proc/self/stat");',
 'Object=foreign;let saved;(saved=Object.freeze)({read:fs.readFileSync});',
 'let saved;const a=new WeakSet(),b=new WeakSet();const selected=flag?a:b;const holder={};(holder.f=selected.has)({});',
])test(`assignment GetValue retains native effects but loses the old property receiver: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));});
