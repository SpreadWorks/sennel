import fs from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';

const file = 'src/string-global.mjs';
for (const [name, source, column] of [
  ['globalThis', "globalThis.String=foreign; console.log(String(input).replace('a','b'));", 40],
  ['global', "global.String=foreign; console.log(String(input).replace('a','b'));", 36],
]) test('global replacement withdraws String conversion at consumer: ' + name, () => {
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
  assert.deepEqual(report.diagnostics.filter(entry => entry.rule === 'OS00'), []);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(entry => entry.file === file && entry.rule === 'OS02' && entry.line === 1
    && entry.column === column && entry.message === 'mutated native member has no original call contract'));
});
for (const root of ['globalThis', 'global']) test('RegExp constructor replacement does not replace a literal intrinsic: ' + root, () => {
  const source = root + ".RegExp=foreign;\nconsole.log('ordinary'.replace(/a/g,'b'));";
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
  assert.equal(report.ok, false);
  assert.deepEqual(report.diagnostics.filter(entry => entry.rule === 'OS00' || entry.line === 2), []);
  assert.ok(report.diagnostics.some(entry => entry.line === 1 && entry.rule === 'OS02'));
});

const permission = JSON.parse(fs.readFileSync(new URL('../fixtures/os-native-permission-effects.json', import.meta.url), 'utf8'))[0];
for (const root of ['globalThis', 'global']) for (const name of ['fs', 'process', 'Number', 'Object', 'TypeError']) {
  test('permission native provenance after global write: ' + root + '.' + name, () => {
    const source = root + '.' + name + '=foreign;\n' + permission.seed;
    const report = new OsIndependenceChecker(new MemorySourceRepository([[permission.sourceFile, source]]), { files: [permission.sourceFile] }).check();
    assert.equal(report.ok, false);
    assert.deepEqual(report.diagnostics.filter(entry => entry.rule === 'OS00'), []);
    assert.ok(report.diagnostics.some(entry => entry.line === 1 && entry.rule === 'OS02'));
    if (name === 'fs') assert.deepEqual(report.diagnostics.filter(entry => entry.line !== 1), []);
    else assert.ok(report.diagnostics.some(entry => entry.file === permission.sourceFile && entry.line === 11
      && entry.column === 54 && entry.rule === 'OS03' && entry.classification === 'violation'));
  });
}
