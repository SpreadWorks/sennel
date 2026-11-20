import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const file='src/integrity-observation.mjs';
function inspect(source){
 const report=new OsIndependenceChecker(new MemorySourceRepository([[file,"import fs from 'node:fs';"+source]]),{files:[file]}).check();
 assert.deepEqual(report.diagnostics.filter(entry=>entry.rule==='OS00'),[],report.diagnostics.join('\n'));return report;
}
for(const method of ['isFrozen','isSealed','isExtensible','preventExtensions']){
 for(const source of [
  `const set=new WeakSet();Object.${method}(set);set.has(fs.readFileSync);`,
  `const input={get read(){return fs.readFileSync;}};Object.${method}(input);`,
 ])test(`ordinary allocation integrity does not execute getters or alter native entries: ${source}`,()=>{
  const report=inspect(source);assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
 });
 for(const source of [
  `Object.${method}=foreign;const set=new WeakSet();Object.${method}(set);set.has(fs.readFileSync);`,
  `const input={get read(){return fs.readFileSync;}};Object.${method}(new Proxy(input,{}));`,
 ])test(`integrity observation keeps changed intrinsic and opaque receiver obligations: ${source}`,()=>{
  const report=inspect(source);assert.equal(report.ok,false,report.diagnostics.join('\n'));
 });
}
test('preventExtensions returns the original weak collection and leaves internal entries writable',()=>{
 const report=inspect('Object.preventExtensions(new WeakSet()).add({}).has(fs.readFileSync);');
 assert.equal(report.ok,true,report.diagnostics.join('\n'));assert.equal(report.complete,true);
});
test('a returned ordinary object retains its getter capability at an opaque consumer',()=>{
 const report=inspect('opaque(Object.preventExtensions({get read(){return fs.readFileSync;}}));');
 assert.equal(report.ok,false,report.diagnostics.join('\n'));
});
