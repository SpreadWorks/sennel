import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file = 'src/guarded-super-probe.mjs';
function inspect(source) {
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
  assert.ok(!report.diagnostics.some(entry => entry.rule === 'OS00'), report.diagnostics.join('\n'));
  return report;
}
for (const source of [
  'class Parent{}class Reader extends Parent{constructor(flag){if(flag)super();this.value=1;}}new Reader(false);',
  'class Parent{}class Reader extends Parent{constructor(flag){if(flag)super();this.value=1;}}new Reader(input);',
  "class Parent{}class Reader extends Parent{constructor(){if(process.platform!=='win32')super();this.value=1;}}new Reader();",
  'class Parent{}class Reader extends Parent{constructor(flag){const start=()=>{if(flag)super();};start();this.value=1;}}new Reader(false);',
  'class Parent{}class Reader extends Parent{constructor(){const later=()=>super();this.value=1;}}new Reader();',
  'class Parent{}class Reader extends Parent{constructor(flag){flag&&super();this.value=1;}}new Reader(false);',
  'class Parent{}class Reader extends Parent{constructor(flag){flag?super():null;this.value=1;}}new Reader(false);',
  'class Parent{}class Reader extends Parent{constructor(flag){const start=()=>flag&&super();start();this.value=1;}}new Reader(false);',
  'class Parent{}class Reader extends Parent{constructor(flag){while(flag){super();}this.value=1;}}new Reader(false);',
  'class Parent{}class Reader extends Parent{constructor(value){value?.read(super());this.value=1;}}new Reader(null);',
  'class Parent{}class Reader extends Parent{constructor(value){value?.[super()];this.value=1;}}new Reader(null);',
  "import fs from 'node:fs';class Parent{}class Reader extends Parent{constructor(){if(fs.existsSync('/proc/self/stat'))super();this.value=1;}}new Reader();",
]) test(`a possible super call cannot establish normal construction: ${source}`, () => {
  const report = inspect(source);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
});
for (const source of [
  'class Parent{}class Reader extends Parent{constructor(flag){if(flag)super();this.value=1;}}new Reader(true);',
  'class Parent{}class Reader extends Parent{constructor(flag){if(flag){super();}else{super();}this.value=1;}}new Reader(false);',
  'class Parent{}class Reader extends Parent{constructor(flag){if(flag){super();}else{super();}this.value=1;}}new Reader(true);',
  'class Parent{}class Reader extends Parent{constructor(flag){if(flag)super();return {};}}new Reader(false);',
  'class Parent{}class Reader extends Parent{constructor(flag){const start=()=>{if(flag)super();};start();this.value=1;}}new Reader(true);',
  'class Parent{}class Reader extends Parent{constructor(){const start=()=>super();start();this.value=1;}}new Reader();',
  'class Parent{}class Reader extends Parent{constructor(){const later=()=>super();return {};}}new Reader();',
]) test(`selected normal constructor paths retain their real this initialization: ${source}`, () => {
  const report = inspect(source);
  assert.equal(report.ok, true, report.diagnostics.join('\n'));
  assert.equal(report.complete, true);
});
