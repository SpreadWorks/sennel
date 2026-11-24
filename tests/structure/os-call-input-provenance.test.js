import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
import { SourceFixtureCase } from '../support/structure/source-fixture-variants.js';

const groups = JSON.parse(fs.readFileSync(new URL('../fixtures/os-call-input-provenance.json', import.meta.url), 'utf8'));
for (const fixture of SourceFixtureCase.read(groups)) test(`call input provenance: ${fixture.name}`, () => {
  const source = fixture.input.render();
  const report = new OsIndependenceChecker(new MemorySourceRepository([[fixture.file, source]]), { files: [fixture.file] }).check();
  assert.deepEqual(report.diagnostics.filter(diagnostic => diagnostic.rule === 'OS00'), [], report.diagnostics.join('\n'));
  assert.equal(report.complete, fixture.complete, report.diagnostics.join('\n'));
  if (fixture.positive) {
    assert.equal(report.ok, true, report.diagnostics.join('\n'));
    assert.deepEqual(report.diagnostics, []);
  } else {
    assert.equal(report.ok, false);
    assert.ok(report.diagnostics.some(diagnostic => fixture.expected.matches(diagnostic)),
      `required diagnostic at the protected consumer: ${fixture.name}\n${report.diagnostics.join('\n')}`);
  }
});
