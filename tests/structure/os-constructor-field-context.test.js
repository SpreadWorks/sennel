import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';

const file = 'src/field-context-probe.mjs';
function inspect(source) {
  const report = new OsIndependenceChecker(new MemorySourceRepository([
    [file, `import fs from 'node:fs'; ${source}`],
  ]), { files: [file] }).check();
  assert.ok(!report.diagnostics.some(entry => entry.rule === 'OS00'), report.diagnostics.join('\n'));
  return report;
}

for (const source of [
  "class Input{paths=['ordinary.json'];}const input=new Input();input.paths.map(file=>fs.readFileSync(file));",
  "class Input{paths=['ordinary.json'];}const input=new Input();input.paths;input.paths.map(file=>fs.readFileSync(file));",
  "const file='ordinary.json';class Input{paths=[file];constructor(file){}}new Input('/proc/self/stat').paths.map(value=>fs.readFileSync(value));",
  "class Parent{constructor(file){this.file=file;}}class Input extends Parent{paths=[this.file];}new Input('ordinary.json').paths.map(file=>fs.readFileSync(file));",
  "const file='ordinary.json';class Parent{paths=[file];}function make(file){return class Input extends Parent{}}new (make('/proc/self/stat'))().paths.map(value=>fs.readFileSync(value));",
]) test(`field allocation retains its home scope and actual receiver: ${source}`, () => {
  const report = inspect(source);
  assert.equal(report.ok, true, report.diagnostics.join('\n'));
  assert.equal(report.complete, true);
});

for (const source of [
  "class Input{paths=['/proc/self/stat'];}const input=new Input();input.paths.map(file=>fs.readFileSync(file));",
  "class Input{paths=['ordinary.json'];}const input=new Input();const alias=input.paths;alias[0]='/proc/self/stat';input.paths.map(file=>fs.readFileSync(file));",
  "class Input{paths=['ordinary.json'];}const input=new Input();opaque(input.paths);input.paths.map(file=>fs.readFileSync(file));",
  "class Parent{constructor(file){this.file=file;}}class Input extends Parent{paths=[this.file];}new Input('/proc/self/stat').paths.map(file=>fs.readFileSync(file));",
  "function make(file){return class Input{paths=[file];};}const First=make('ordinary.json');const Second=make('/proc/self/stat');new First().paths.map(value=>fs.readFileSync(value));new Second().paths.map(value=>fs.readFileSync(value));",
  "class Input{paths=['ordinary.json'];}Array.prototype.map=foreign;new Input().paths.map(file=>fs.readFileSync(file));",
]) test(`field context reuse preserves later effects and distinct captures: ${source}`, () => {
  const report = inspect(source);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
});
