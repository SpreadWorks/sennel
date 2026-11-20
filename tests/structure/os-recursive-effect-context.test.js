import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
const file = 'src/renamed-recursive-effects.mjs';
function check(source) { return new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check(); }
for (const source of [
  'function visit(value){return value.items.map(item=>visit(item));} opaque(visit);',
  'function walk(n){return items.map(()=>walk(n));} opaque(walk);',
  'function visit(value, seen=new Set()){return value.items.map(item=>visit(item,seen));} opaque(visit);',
]) {
  test('recursive effects close over the same immutable lexical context: ' + source, () => {
    const report = check(source);
    assert.equal(report.ok, true, report.diagnostics.join('\n'));
    assert.equal(report.complete, true);
  });
}
for (const declaration of [
  'function make(file){return ()=>fs.readFileSync(file);}',
  'function make(file){const retained=file;return ()=>fs.readFileSync(retained);}',
  "function make(file){if(choice)file='/proc/self/stat';return ()=>fs.readFileSync(file);}",
]) {
  test('context sharing never merges distinct or indirect captured origins: ' + declaration, () => {
    const report = check(`import fs from 'node:fs';\n${declaration}\nopaque(make('ordinary.json'));\nopaque(make('/proc/self/stat'));`);
    assert.equal(report.ok, false, report.diagnostics.join('\n'));
    assert.ok(report.diagnostics.some(entry => entry.line === 4 && /uninspected consumer/.test(entry.message)), report.diagnostics.join('\n'));
  });
}
test('a recursive callback retains its reachable native effect', () => {
  const report = check(`import fs from 'node:fs'; function visit(value){return value.items.map(item=>{fs.readFileSync('/proc/self/stat');return visit(item);});} opaque(visit);`);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
  assert.ok(report.diagnostics.some(entry => entry.rule === 'OS01'), report.diagnostics.join('\n'));
});
test('constructor result refinement retains opaque argument provenance', () => {
  const report = check(`import fs from 'node:fs'; const value=new Foreign('/proc/self/stat'); fs.readFileSync(value.file);`);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
  assert.ok(report.diagnostics.some(entry => entry.rule === 'OS01'), report.diagnostics.join('\n'));
});
for (const expression of [
  '`${items.map(key=>visit(value[key])).join(",")}`',
  'items.map(key=>visit(value[key]))',
]) test('equivalent ordinary unknown captures close recursive effects: ' + expression, () => {
  const report=check(`function visit(value){return ${expression};} opaque(visit);`);
  assert.equal(report.ok,true,report.diagnostics.join('\n'));
  assert.equal(report.complete,true);
});
for (const origin of ["fs.readFileSync", "{read:fs.readFileSync}", "choice ? fs.readFileSync : ordinary"]) {
  test('unknown context identity cannot erase a later captured capability: ' + origin, () => {
    const report=check(`import fs from 'node:fs'; function make(value){return ()=>opaque(value);} opaque(make(ordinary)); opaque(make(${origin}));`);
    assert.equal(report.ok,false,report.diagnostics.join('\n'));
    assert.ok(!report.diagnostics.some(entry=>entry.rule==='OS00'),report.diagnostics.join('\n'));
  });
}
