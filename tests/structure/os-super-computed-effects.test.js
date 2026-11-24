import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';
const forms=[
 value=>`class A{get read(){return ${value};}}class B extends A{method(key){return super[key];}}`,
 value=>`class A{static get read(){return ${value};}}class B extends A{static method(key){return super[key];}}`,
 value=>`class A{read(){return ${value};}}class B extends A{method(key){return super[key]();}}`,
];
function inspect(source){
 const file='src/computed-super.mjs';
 return new OsIndependenceChecker(new MemorySourceRepository([[file,`import fs from 'node:fs';${source}`]]),{files:[file]}).check();
}
for(const[index,form]of forms.entries()){
 const target=index===1?'B':'new B()';
 test(`computed parent selection retains uninspected native origin: ${index}`,()=>{
  const report=inspect(`${form('fs.readFileSync')}opaque(${target}.method(input));`);
  assert.equal(report.ok,false,report.diagnostics.join('\n'));
  assert.ok(report.diagnostics.some(entry=>entry.classification==='incomplete'),report.diagnostics.join('\n'));
  assert.ok(!report.diagnostics.some(entry=>entry.rule==='OS00'),report.diagnostics.join('\n'));
 });
 test(`literal parent selection preserves its real ordinary result: ${index}`,()=>{
  const report=inspect(`${form("'ordinary.json'")}fs.readFileSync(${target}.method('read'));`);
  assert.equal(report.ok,true,report.diagnostics.join('\n'));
  assert.equal(report.complete,true);
 });
}
