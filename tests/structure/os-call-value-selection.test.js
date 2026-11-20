import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/call-value-selection.mjs';
function inspect(source){const report=new OsIndependenceChecker(new MemorySourceRepository([[file,"import fs from 'node:fs';"+source]]),{files:[file]}).check();assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));return report;}
for(const source of [
 'const f=()=>"ordinary";opaque((true&&f)());',
 'const f=()=>"ordinary";opaque((false||f)());',
 'const f=()=>"ordinary";opaque((null??f)());',
 'const f=()=>"ordinary",other=()=>"other";opaque((f||other)());',
 'const original={file:"ordinary",read(){fs.readFileSync(this.file);}};const holder={file:"other",f:true&&original.read};holder.f();',
])test(`known logical call selection retains normal functions: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);});
for(const source of [
 'const original={file:"ordinary",read(){fs.readFileSync(this.file);}};(true&&original.read)();',
 'const original={file:"ordinary",read(){fs.readFileSync(this.file);}};(false||original.read)();',
 'const original={file:"ordinary",read(){fs.readFileSync(this.file);}};(null??original.read)();',
 'const original={file:"ordinary",read(){fs.readFileSync(this.file);}};const holder={file:"/proc/self/stat",f:true&&original.read};holder.f();',
 'const set=new WeakSet();(true&&set.has)({});',
 'const f=()=>"ordinary";(false&&f)();',
 'const f=()=>"ordinary";(true||f)();',
 'const f=()=>"ordinary";(0??f)();',
 'const f=()=>"ordinary";(flag&&f)();',
 'const f=()=>"ordinary";(1+2)();',
 '({}) ();',
 '([]) ();',
 'const f=()=>fs.readFileSync("/proc/self/stat");(true&&f)();',
 'const f=()=>"ordinary";(true&&f)(fs.readFileSync("/proc/self/stat"));',
])test(`logical GetValue and noncallable data cannot acquire a receiver or call proof: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));});
