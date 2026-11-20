import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';

const file = 'src/renamed-spread.mjs';
function check(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
}
for (const expose of ['opaque(input)', 'const alias=input; opaque(alias)', 'opaque({input})']) {
  test('object copying cannot invoke uninspected getters after exposure: ' + expose, () => {
    const report = check(`const input={file:'snapshot.json'}; ${expose}; const copy={...input};`);
    assert.equal(report.ok, false, report.diagnostics.join('\n'));
    assert.equal(report.complete, false);
    assert.ok(report.diagnostics.some(entry => /spread/.test(entry.message)), report.diagnostics.join('\n'));
  });
}
test('a later copy invalidates a previously inspected callable effect', () => {
  const report = check(`const input={file:'snapshot.json'}; function copy(){return {...input};} opaque(copy); opaque(input); opaque(copy);`);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
  assert.equal(report.complete, false);
});
test('inspected plain data can still be copied after a named data write', () => {
  const report = check(`const input={file:'snapshot.json'}; input.file='other.json'; const copy={...input}; opaque(copy);`);
  assert.equal(report.ok, true, report.diagnostics.join('\n'));
  assert.equal(report.complete, true);
});
for (const copy of ['({...input});', 'const wrapper={nested:{...input}};', 'consume({...input});', 'const result=[{...input}];']) {
  test('eager copy effects do not depend on a later binding consumer: ' + copy, () => {
    const report = check(`const input={}; opaque(input); ${copy}`);
    assert.equal(report.ok, false, report.diagnostics.join('\n'));
    assert.equal(report.complete, false);
  });
}
