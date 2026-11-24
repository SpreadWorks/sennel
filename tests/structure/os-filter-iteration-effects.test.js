import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file = 'src/filtered-native-iterator.mjs';
function inspect(source) {
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, "import fs from 'node:fs';" + source]]), { files: [file] }).check();
  assert.deepEqual(report.diagnostics.filter(entry => entry.rule === 'OS00'), [], report.diagnostics.join('\n'));
  return report;
}
for (const source of [
  'for(const item of [{enabled:true}].filter(entry=>entry.enabled===true)){console.log(item);}',
  'for(const item of ["ordinary"].filter(entry=>true)){fs.readFileSync(item);}',
  'for(const item of ["ordinary"].filter(entry=>false)){console.log(item);}',
  'for(const item of ["ordinary"].filter(entry=>0)){console.log(item);}',
  'for(const item of ["ordinary"].filter(entry=>"yes")){fs.readFileSync(item);}',
  'for(const item of ["ordinary"].filter(entry=>({}))){fs.readFileSync(item);}',
  'for(const item of [{enabled:false},{enabled:true}].filter(entry=>entry.enabled===true)){console.log(item);}',
  'for(const item of ["ordinary","other"].filter((entry,index)=>index===1)){fs.readFileSync(item);}',
]) test(`known filter predicates preserve the native finite iterator: ${source}`, () => {
  const report = inspect(source);
  assert.equal(report.ok, true, report.diagnostics.join('\n'));
  assert.equal(report.complete, true);
});
for (const source of [
  'for(const item of ["/proc/self/stat"].filter(entry=>true)){fs.readFileSync(item);}',
  'for(const item of ["ordinary"].filter(entry=>{fs.readFileSync("/proc/self/stat");return false;})){console.log(item);}',
  'for(const item of ["ordinary"].filter(entry=>flag)){console.log(item);}',
  'for(const item of ["ordinary"].filter(entry=>foreign())){console.log(item);}',
  'const values=["ordinary"];for(const item of values.filter(entry=>{values[0]="/proc/self/stat";return true;})){fs.readFileSync(item);}',
  'Array.prototype.filter=foreign;for(const item of ["ordinary"].filter(entry=>true)){console.log(item);}',
  'const values=["ordinary"];opaque(values);for(const item of values.filter(entry=>true)){console.log(item);}',
  'for(const item of ["ordinary"].filter(entry=>{opaque(fs.readFileSync);return false;})){console.log(item);}',
  'for(const item of [{get enabled(){fs.readFileSync("/proc/self/stat");return true;}}].filter(entry=>entry.enabled)){console.log(item);}',
]) test(`filter cannot erase unresolved predicates, callback effects, or mutation: ${source}`, () => {
  const report = inspect(source);
  assert.equal(report.ok, false, 'expected an actual refusal');
  assert.ok(report.diagnostics.some(entry => ['OS01', 'OS02'].includes(entry.rule)), report.diagnostics.join('\n'));
});
