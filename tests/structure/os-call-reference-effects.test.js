import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/call-reference.mjs';
function inspect(source){const report=new OsIndependenceChecker(new MemorySourceRepository([[file,"import fs from 'node:fs';"+source]]),{files:[file]}).check();assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));return report;}
const objects='const a={file:"ordinary",read(){fs.readFileSync(this.file);}},b={file:"other",read(){fs.readFileSync(this.file);}};const selected=flag?a:b;';
for(const source of [
 objects+'selected.read();',
 objects+'(selected.read)();',
 objects+'((selected.read))();',
 objects+'const holder={file:"normal",f:selected.read};holder.f();',
 objects+'const holder={file:"normal",get f(){return selected.read;}};holder.f();',
 objects+'const h1={file:"normal",f:selected.read},h2={file:"other",f:selected.read};(other?h1:h2).f();',

 'const set=new WeakSet();(set.has)({});',
 'const a=new WeakSet(),b=new WeakSet();const selected=flag?a:b;(selected.has)({});',
 'const a={read(){return "ordinary";}},b={read(){return "other";}};const selected=flag?a:b;const f=selected.read;opaque(f());',
 'const object={file:"ordinary",get read(){return ()=>fs.readFileSync(this.file);}};const holder={file:"/proc/self/stat",f:object.read};holder.f();',
 'function check(){return this===undefined;}check();',
 'const f=()=>"ordinary";opaque((0,f)());',
])test(`call references preserve only the actual receiver: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);});
for(const source of [
 objects+'const holder={file:"/proc/self/stat",f:selected.read};holder.f();',
 objects+'const holder={file:"/proc/self/stat",get f(){return selected.read;}};holder.f();',
 objects+'const h1={file:"/proc/self/stat",f:selected.read},h2={file:"other",f:selected.read};(other?h1:h2).f();',
 objects+'const h1={file:"/proc/self/stat",get f(){return selected.read;}},h2={file:"other",get f(){return selected.read;}};(other?h1:h2).f();',
 'const a=new WeakSet(),b=new WeakSet();const selected=flag?a:b;const h1={get f(){return selected.has;}},h2={get f(){return selected.has;}};(other?h1:h2).f({});',

 objects+'const f=selected.read;f();',
 objects+'(flag?a.read:b.read)();',
 objects+'(0,selected.read)();',
 objects+'(fs.readFileSync("/proc/self/stat"),selected.read)();',
 'const set=new WeakSet();const f=set.has;f({});',
 'const a=new WeakSet(),b=new WeakSet();const selected=flag?a:b;const f=selected.has;f({});',
 'const a=new WeakSet(),b=new WeakSet();(flag?a.has:b.has)({});',
 'const a=new WeakSet(),b=new WeakSet();const selected=flag?a:b;const holder={f:selected.has};holder.f({});',
 'const a=new WeakSet(),b=new WeakSet();const selected=flag?a:b;const holder={get f(){return selected.has;}};holder.f({});',
 'const object={file:"/proc/self/stat",read(){fs.readFileSync(this.file);}};(object.read)();',
 'const object={file:"/proc/self/stat",read(){fs.readFileSync(this.file);}};((object.read))();',
])test(`GetValue does not retain a selected receiver or native brand: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));});
