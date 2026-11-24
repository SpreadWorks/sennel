import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file = 'src/renamed-conditional-copy.mjs';
function check(source) { return new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check(); }
for (const selected of ["choice?{file:'first.json'}:{file:'second.json'}", "choice?{file:'first.json'}:{}"]) {
  test('every closed copy alternative retains a portable member: ' + selected, () => {
    const report = check(`import fs from 'node:fs'; const selected=${selected}; const copy={file:'fallback.json',...selected}; fs.readFileSync(copy.file);`);
    assert.equal(report.ok, true, report.diagnostics.join('\n')); assert.equal(report.complete, true);
  });
}
test('an absent selected member retains the earlier native path', () => {
  const report = check(`import fs from 'node:fs'; const selected=choice?{file:'ordinary.json'}:{}; const copy={file:'/proc/self/stat',...selected}; fs.readFileSync(copy.file);`);
  assert.equal(report.ok, false); assert.ok(report.diagnostics.some(entry => entry.rule === 'OS01'), report.diagnostics.join('\n'));
});
test('a rightmost explicit field overrides every closed copied member', () => {
  const report = check(`import fs from 'node:fs'; const selected=choice?{file:'/proc/self/stat'}:{}; const copy={...selected,file:'ordinary.json'}; fs.readFileSync(copy.file);`);
  assert.equal(report.ok, true, report.diagnostics.join('\n')); assert.equal(report.complete, true);
});
for (const selected of ["choice?opaque():{}", "choice?{get file(){return 'ordinary.json';}}:{}"]) {
  test('a finite known branch cannot complete an unresolved copy: ' + selected, () => {
    const report = check(`const selected=${selected}; const copy={...selected};`);
    assert.equal(report.ok, false); assert.equal(report.complete, false);
  });
}
test('opaque exposure of one branch invalidates the closed copy proof', () => {
  const report = check(`const input={}; opaque(input); const selected=choice?input:{}; const copy={...selected};`);
  assert.equal(report.ok, false); assert.equal(report.complete, false);
});
test('copied capability alternatives retain their opaque consumer refusal', () => {
  const report = check(`import fs from 'node:fs'; const selected=choice?{read:fs.readFileSync}:{}; opaque({...selected});`);
  assert.equal(report.ok, false); assert.equal(report.complete, false);
});
