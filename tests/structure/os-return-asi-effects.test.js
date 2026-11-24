import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';

const file = 'src/return-asi-probe.mjs';
function inspect(source) {
  const report = new OsIndependenceChecker(new MemorySourceRepository([
    [file, `import fs from 'node:fs'; ${source}`],
  ]), { files: [file] }).check();
  assert.ok(!report.diagnostics.some(entry => entry.rule === 'OS00'), report.diagnostics.join('\n'));
  return report;
}

for (const source of [
  'function read(){return fs.readFileSync}opaque(read());',
  'function read(flag){if(flag){return fs.readFileSync}return null;}opaque(read(input));',
  'function read(){return function(){return fs.readFileSync}}opaque(read()());',
  "function read(){return '/proc/self/stat'}fs.readFileSync(read());",
]) test(`implicit return terminators retain the actual sensitive result: ${source}`, () => {
  const report = inspect(source);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
});

for (const source of [
  'function read(){return\nfs.readFileSync;}opaque(read());',
  'function read(){return;}opaque(read());',
  "function read(){return 'ordinary.json'}fs.readFileSync(read());",
]) test(`return line breaks and ordinary results retain their JavaScript meaning: ${source}`, () => {
  const report = inspect(source);
  assert.equal(report.ok, true, report.diagnostics.join('\n'));
  assert.equal(report.complete, true);
});
