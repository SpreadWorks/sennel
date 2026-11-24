import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';

const file = 'src/renamed-array-effects.mjs';
function check(source) {
  const report = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
  assert.ok(!report.diagnostics.some(entry => entry.rule === 'OS00'), report.diagnostics.join('\n'));
  return report;
}
for (const expression of [
  "['one','two'].map(String)",
  "['one','two'].filter(value=>value).map(String)",
  "['one','two'].map(value=>String(value))",
]) test('closed array callbacks retain native identity: ' + expression, () => {
  const report = check(`const values=${expression}; opaque(values); String('later');`);
  assert.equal(report.ok, true, report.diagnostics.join('\n'));
  assert.equal(report.complete, true);
});
for (const source of [
  "['/proc/self/stat'].map(fs.readFileSync);",
  "value ?? [fs].map(reader=>reader.readFileSync('/proc/self/stat'));",
  "value ? [fs].map(reader=>reader.readFileSync('/proc/self/stat')) : [];",
  "['/proc/self/stat'].some(value=>fs.readFileSync(value));",
  "['/proc/self/stat'].every(value=>fs.readFileSync(value));",
  "['/proc/self/stat'].map(value=>fs.readFileSync(value));",
  "['/proc/self/stat'].filter(value=>value).map(value=>fs.readFileSync(value));",
  "const values=['/proc/self/stat'].map(String); fs.readFileSync(values[0]);",
  "const values=['/proc/self/stat'].filter(value=>value).map(String); fs.readFileSync(values[0]);",
  "const values=[0].map(()=>fs.readFileSync); opaque(values);",
  "const values=[{toString(){return '/proc/self/stat';}}].map(String); fs.readFileSync(values[0]);",
  "const values=[{get toString(){return ()=>'/proc/self/stat';}}].map(String); fs.readFileSync(values[0]);",
  "const values=[{toString(){return fs.readFileSync;}}].map(String); opaque(values);",
]) test('array callback provenance reaches its consumer: ' + source, () => {
  const report = check(`import fs from 'node:fs'; ${source}`);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
});
for (const mutation of [
  'values.map=foreign;',
  "values[0]='/proc/self/stat';",
  'opaque(values);',
  'const alias=values; alias.map=foreign;',
  'Array.prototype.map=foreign;',
  'const prototype=Array.prototype; prototype.map=foreign;',
  'globalThis.Array=foreign;',
  'Array=foreign;',
  "Reflect.set(values,'map',foreign);",
  "Object.defineProperty(values,'0',{get(){return '/proc/self/stat';}});",
  'values.constructor=foreign;',
  'Object.setPrototypeOf(values,foreign);',
  'opaque(Array.prototype);',
  'String=foreign;',
  'const prototype=Array.prototype; Object.defineProperty(prototype,Symbol.species,{get(){return foreign;}});',
  'Array.prototype[Symbol.iterator]=foreign;',
  "Object.defineProperty(Array.prototype,'constructor',{get(){return foreign;}});",
]) test('array mutation cannot retain a native callback proof: ' + mutation, () => {
  const report = check(`import fs from 'node:fs'; const values=['record']; ${mutation} values.map(value=>fs.readFileSync(value));`);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
});
test('mutation from an earlier callback invalidates later element reads', () => {
  const report = check(`import fs from 'node:fs'; const values=['record','record']; values.map((value,index,array)=>{array[1]='/proc/self/stat';fs.readFileSync(value);});`);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
});
test('one array allocation does not mutate another allocation', () => {
  const report = check(`const first=['one']; first.map=foreign; const selected=['two']; opaque(selected.map(String));`);
  assert.equal(report.ok, true, report.diagnostics.join('\n'));
});
test('an unresolved array receiver does not acquire native callback semantics', () => {
  const report = check(`import fs from 'node:fs'; supplied.map(fs.readFileSync);`);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
});

test('map output and input have distinct allocation identities', () => {
  const report = check(`const input=['one']; const output=input.map(String); output.map=foreign; opaque(input.map(String));`);
  assert.equal(report.ok, true, report.diagnostics.join('\n'));
});
test('primitive conversion cannot erase a custom object path result', () => {
  const report = check(`import fs from 'node:fs'; const value={toString(){return '/proc/self/stat';}}; fs.readFileSync(String(value));`);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
});
for (const callback of [
  "value=>{Array.prototype.map=foreign;return value;}",
  "value=>{opaque(Array.prototype);return value;}",
  "value=>{if(fs.statSync('record').uid===0)return value;return value;}",
  "value=>{const input={toString(){return '/proc/self/stat';}};fs.readFileSync(String(input));return value;}",
]) test('callback contexts retain mutation and authority policy: ' + callback, () => {
  const report=check(`import fs from 'node:fs'; const values=['record'].map(${callback}); opaque(values);`);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
});
test('returning an inline callback does not grant its future inputs primitive authority', () => {
  const report=check(`import fs from 'node:fs'; const values=['record'].map(function callback(value){return value ? callback : fs.readFileSync(String(value));}); opaque(values);`);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
});
test('an aliased callback remains inspectable outside the array invocation', () => {
  const report=check(`import fs from 'node:fs'; function callback(value){return fs.readFileSync(String(value));} const values=['record'].map(callback); opaque(callback);`);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
});
test('known filtered argv does not bypass the required typed process boundary', () => {
  const report=check(`import {spawn} from 'node:child_process'; const args=['--version'].filter(value=>value); const child=spawn(process.execPath,args,{shell:false}); try {} finally { child.kill(); }`);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
  assert.equal(report.complete, true);
  assert.ok(report.diagnostics.some(entry => entry.rule === 'OS02' && entry.classification === 'violation'
    && entry.line === 1 && entry.column === 102 && /shared typed invocation boundary/.test(entry.message)), report.diagnostics.join('\n'));
});
test('an unknown filter predicate cannot prove native argv positions', () => {
  const report=check(`import {spawn} from 'node:child_process'; const args=['--version'].filter(value=>flag); const child=spawn(process.execPath,args,{shell:false}); try {} finally { child.kill(); }`);
  assert.equal(report.ok, false);
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some(entry => entry.rule === 'OS04' && entry.classification === 'incomplete'
    && entry.line === 1 && entry.column === 101 && /Node option boundary/.test(entry.message)), report.diagnostics.join('\n'));
});
test('borrowed array methods require an actual receiver', () => {
  const report=check(`const values=['record']; const map=values.map; opaque(map(String));`);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
});
test('primitive String identity passed through a lexical alias stays native', () => {
  const report=check(`const convert=String; const values=['record'].map(convert); opaque(values);`);
  assert.equal(report.ok, true, report.diagnostics.join('\n'));
});

for (const expression of [
  "['ignored'].map(function(){return fs.readFileSync(this[0]);},['/proc/self/stat'])",
  "new Array('/proc/self/stat').map(value=>fs.readFileSync(value))",
  "Array('/proc/self/stat').map(value=>fs.readFileSync(value))",
  "fs.readFileSync(new Array('/proc/self/stat')[0])",
  "fs.readFileSync(Array.of('/proc/self/stat')[0])",
  "const values=Array(fs.readFileSync);opaque(values)",
]) test('array receiver and constructor provenance survives existing consumers: ' + expression, () => {
  const report=check(`import fs from 'node:fs'; ${expression};`);
  assert.equal(report.ok,false,report.diagnostics.join('\n'));
});
for (const expression of ["Array('one','two').map(String)", "new Array('one').map(String)", "Array().map(String)"]) {
  test('native Array construction preserves actual dense elements: ' + expression, () => {
    const report=check(`opaque(${expression});`);
    assert.equal(report.ok,true,report.diagnostics.join('\n'));
  });
}
test('array-valued thisArg remains distinct from the mapped allocation',()=>{
  const report=check(`import fs from 'node:fs'; const context=['/proc/self/stat']; const values=['record']; values.map(function(){return fs.readFileSync(this[0]);},context);`);
  assert.equal(report.ok,false,report.diagnostics.join('\n'));
});

for (const source of [
  "const files=['/proc/self/stat'].filter(value=>value);fs.globSync(files);",
  "const files=[];files.push('/proc/self/stat');fs.globSync(files);",
  "const files=['record'];files[0]='/proc/self/stat';fs.globSync(files);",
  "const files=[];opaque(files);fs.globSync(files);",
  "function load(file){const files=[];files[0]=file;fs.globSync(files);}opaque(load);",
  "fs.readFileSync(['/proc/self/stat'].join(','));",
  "fs.readFileSync(['/pro','c/self/stat'].join(''));",
  "fs.readFileSync([{toString(){return '/proc/self/stat';}}].join(','));",
  "fs.readFileSync(['/proc/self/stat'].join(',').trim());",
  "const values=['record'];Object.defineProperty(values.constructor.prototype,'map',{value:foreign});values.map(value=>fs.readFileSync(value));",
]) test('array graph consumers preserve path and mutation obligations: ' + source, () => {
  const report=check(`import fs from 'node:fs'; ${source}`);
  assert.equal(report.ok,false,report.diagnostics.join('\n'));
});
for (const source of [
  "fs.globSync(['record.json'].filter(value=>value));",
  "fs.readFileSync(['/pro','other','c/self/stat'].filter(value=>value).join(''));",
  "fs.readFileSync(['record','.json'].join(''));",
  "fs.readFileSync(['record',null,'.json'].join(''));",
  "const values=[];fs.globSync(values);",
]) test('closed ordinary array path consumers remain usable: ' + source, () => {
  const report=check(`import fs from 'node:fs'; ${source}`);
  assert.equal(report.ok,true,report.diagnostics.join('\n'));
});

// The same truthy-filter source above joins to /prootherc/self/stat. These
// separate controls retain actual pseudo-path, unresolved predicate and callback IO obligations.
for (const [source, classification, column] of [
  ["fs.readFileSync(['/pro','other','c/self/stat'].filter(value=>value!=='other').join(''));", 'violation', 27],
  ["fs.readFileSync(['/pro','other','c/self/stat'].filter(value=>flag).join(''));", 'incomplete', 27],
  ["fs.readFileSync(['/pro','other','c/self/stat'].filter(value=>{fs.readFileSync('/proc/self/stat');return value;}).join(''));", 'violation', 89],
]) test('filter join retains the actual filesystem obligation: ' + source, () => {
  const report=check(`import fs from 'node:fs'; ${source}`);
  assert.equal(report.ok, false);
  assert.equal(report.complete, classification === 'violation');
  assert.ok(report.diagnostics.some(entry => entry.rule === 'OS01' && entry.classification === classification
    && entry.file === file && entry.line === 1 && entry.column === column), report.diagnostics.join('\n'));
});
