import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file='src/string-new.mjs';
const cases=[
  [
    "literal replace",
    "const text='a';new text.replace('a','b');",
    16
  ],
  [
    "retained replace",
    "const text=String(input);new text.replace('a','b');",
    26
  ],
  [
    "literal replaceAll",
    "const text='a';new text.replaceAll('a','b');",
    16
  ],
  [
    "parenthesized",
    "new ('a'.replace)('a','b');",
    1
  ],
  [
    "holder method",
    "const holder={f:'a'.replace};new holder.f('a','b');",
    30
  ]
];
for (const [name, source, column] of cases) test('native replacement cannot construct: ' + name, () => {
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
  assert.equal(report.ok, false);
  assert.equal(report.complete, false);
  assert.deepEqual(report.diagnostics.filter(entry => entry.rule === 'OS00'), []);
  assert.ok(report.diagnostics.some(entry => entry.file === file && entry.rule === 'OS02' && entry.line === 1
    && entry.column === column && entry.message === 'native string replacement method is not a constructor'), JSON.stringify(report.diagnostics));
});
for (const source of ["const text='a';text.replace('a','b');", "const text=String(input);text.replace('a','b');", "const text='a';text.replaceAll('a','b');"]) test('ordinary replacement call: ' + source, () => {
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
  assert.equal(report.complete, true);
  assert.deepEqual(report.diagnostics, []);
});
test('invalid constructor still evaluates every actual argument', () => {
  const source = "import fs from 'node:fs';const text='a';new text.replace('a','b',fs.readFileSync('/proc/self/stat'));";
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
  assert.equal(report.ok, false);
  assert.deepEqual(report.diagnostics.filter(entry => entry.rule === 'OS00'), []);
  assert.ok(report.diagnostics.some(entry => entry.rule === 'OS01' && entry.line === 1 && entry.column === 66 && entry.classification === 'violation'), JSON.stringify(report.diagnostics));
});
