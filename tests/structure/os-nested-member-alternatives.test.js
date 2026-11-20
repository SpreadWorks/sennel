import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/nested-member-alternatives.mjs';
function inspect(source){const report=new OsIndependenceChecker(new MemorySourceRepository([[file,"import fs from 'node:fs';"+source]]),{files:[file]}).check();assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));return report;}
for(const source of [
 'const a=new WeakSet(),b=new WeakSet(),c=new WeakSet();(first?a:second?b:c).has({});',
 'const a=new WeakSet(),b=new WeakSet(),c=new WeakSet();const selected=first?(second?a:b):c;selected.add({});selected.delete({});',
 'const a=new WeakMap(),b=new WeakMap(),c=new WeakMap();(first?a:second?b:c).get({});',
 'const key={};const a=new WeakMap(),b=new WeakMap(),c=new WeakMap();a.set(key,"ordinary");b.set(key,"other");c.set(key,"third");opaque((first?a:second?b:c).get(key));',
 'const a={file:"ordinary",read(){fs.readFileSync(this.file);}},b={file:"other",read(){fs.readFileSync(this.file);}},c={file:"third",read(){fs.readFileSync(this.file);}};(first?a:second?b:c).read();',
])test(`nested member alternatives keep each proven callable receiver: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);});
for(const source of [
 'const a=new WeakSet(),b=new WeakSet();(first?a:second?b:foreign()).has({});',
 'const a=new WeakSet(),b=new WeakSet(),c=new WeakSet();b.has=foreign;(first?a:second?b:c).has({});',
 'const a=new WeakSet(),b=new WeakSet(),c=new WeakSet();opaque(c);(first?a:second?b:c).has({});',
 'const a=new WeakSet(),b=new WeakSet(),c=new WeakSet();WeakSet.prototype.has=foreign;(first?a:second?b:c).has({});',
 'const key={};const a=new WeakMap(),b=new WeakMap(),c=new WeakMap();c.set(key,fs.readFileSync);opaque((first?a:second?b:c).get(key));',
 'const a={file:"ordinary",read(){fs.readFileSync(this.file);}},b={file:"other",read(){fs.readFileSync(this.file);}},c={file:"/proc/self/stat",read(){fs.readFileSync(this.file);}};(first?a:second?b:c).read();',
 'const a=new WeakMap(),b=new WeakMap(),c=new WeakMap();(first?a:second?b:c).get(fs.readFileSync("/proc/self/stat"));',
 'const a={read(){return "ordinary";}},b={read(){return "other";}},c={read:foreign};(first?a:second?b:c).read(fs.readFileSync);',
])test(`nested alternatives preserve unresolved leaves, actual effects and native mutation: ${source}`,()=>{const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));});
