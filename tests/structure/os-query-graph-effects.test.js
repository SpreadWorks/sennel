import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';

const file = 'src/renamed-query-effects.mjs';
function check(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
}
for (const member of [
  'write(){input.read=fs.readFileSync;}',
  'write:()=>{input.read=fs.readFileSync;}',
  'get write(){input.read=fs.readFileSync;return 0;}',
]) {
  test('an earlier object edge does not hide a later inline effect: ' + member, () => {
    const report = check(`import fs from 'node:fs';
const input={};
opaque({input,${member},again:input});`);
    assert.equal(report.ok, false, report.diagnostics.join('\n'));
    assert.ok(report.diagnostics.some(entry => entry.line === 3 && entry.column === 1
      && /escapes to an uninspected consumer/.test(entry.message)), report.diagnostics.join('\n'));
  });
}
test('shared native interpretations retain the later pseudo-path alternative', () => {
  const report = check(`import fs from 'node:fs'; import path from 'node:path';
const api=choice?path.win32:path.posix;
const input=other?api.normalize('snapshot.json'):api.normalize('/proc/self/stat');
fs.readFileSync(input);`);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
  assert.ok(report.diagnostics.some(entry => entry.line === 4 && ['OS01','OS04'].includes(entry.rule)), report.diagnostics.join('\n'));
});
