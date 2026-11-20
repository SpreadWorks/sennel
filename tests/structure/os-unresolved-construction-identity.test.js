import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';

const file = 'src/unresolved-construction-probe.mjs';
function inspect(source) {
  const report = new OsIndependenceChecker(new MemorySourceRepository([
    [file, `import fs from 'node:fs';\n${source}`],
  ]), { files: [file] }).check();
  assert.ok(!report.diagnostics.some(entry => entry.rule === 'OS00'), report.diagnostics.join('\n'));
  return report;
}

for (const source of [
  "class Holder{value=new foreign('ordinary');}const holder=new Holder();\nopaque(holder.value);",
  "class Holder{value=new foreign();}const holder=new Holder();holder.value;\nopaque(holder.value);",
]) test(`repeated unresolved construction retains only its original ordinary inputs: ${source}`, () => {
  const report = inspect(source);
  assert.equal(report.ok, true, report.diagnostics.join('\n'));
  assert.equal(report.complete, true);
});

for (const source of [
  "class Holder{value=new foreign(fs.readFileSync);}const holder=new Holder();\nopaque(holder.value);",
  "function create(input){class Holder{value=new foreign(input);}return new Holder();}const first=create('ordinary');const second=create('/proc/self/stat');\nopaque(second.value);",
  "function create(input){class Holder{value=new foreign(input);}return new Holder();}const first=create('/proc/self/stat');const second=create('ordinary');\nopaque(first.value);",
  "let input='ordinary';class Holder{value=new foreign(input);}const holder=new Holder();input='/proc/self/stat';const next=new Holder();\nopaque(next.value);",
  "const first=new foreign('ordinary');const second=new foreign(fs.readFileSync);class Holder{value=second;}const holder=new Holder();\nopaque(holder.value);",
  "const input={read(){return 'ordinary';}};class Holder{value=new foreign(input);}const holder=new Holder();input.read=fs.readFileSync;\nopaque(holder.value);",
  "class Holder{value=new foreign('ordinary');}const holder=new Holder();const alias=holder;opaque(alias);\nopaque(holder.value);",
  "class Holder{value=new foreign(Object);}const holder=new Holder();Object.freeze=foreign;\nopaque(holder.value);",
]) test(`construction identity keeps changed inputs and effects visible at the final consumer: ${source}`, () => {
  const report = inspect(source);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
  const line = source.split('\n').length + 1;
  assert.ok(report.diagnostics.some(entry => entry.file === file && entry.line === line), report.diagnostics.join('\n'));
});

test('an unresolved construction retains later object paths at its opaque consumer', () => {
  const report = inspect("const input={file:'ordinary'};class Holder{value=new foreign(input);}const holder=new Holder();input.file='/proc/self/stat';\nopaque(holder.value);");
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some(entry => entry.file === file && entry.line === 3 && entry.column === 1
    && entry.rule === 'OS02' && entry.classification === 'incomplete'), report.diagnostics.join('\n'));
});
