import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';

const file = 'src/renamed-super-context.mjs';
function inspect(source) {
  const report = new OsIndependenceChecker(new MemorySourceRepository([
    [file, `import fs from 'node:fs'; ${source}`],
  ]), { files: [file] }).check();
  assert.ok(!report.diagnostics.some(entry => entry.rule === 'OS00'), report.diagnostics.join('\n'));
  return report;
}

for (const source of [
  "class A{static paths=['ordinary.json'];}const alias=A.paths;alias[0]='/proc/self/stat';A.paths.map(path=>fs.readFileSync(path));",
  "class A{static paths=['ordinary.json'];}opaque(A.paths);A.paths.map(path=>fs.readFileSync(path));",
  "class A{static read=()=>1;static read=()=>fs.readFileSync('/proc/self/stat');}A.read();",
  "class A{read(){return 1;}}class B extends A{read(){return super.read();}}opaque(B);new B().read();",
  "class A{read(){return fs.readFileSync(this.file);}}class B extends A{read(){return super['read']();}}class C extends B{constructor(){super();this.file='/proc/self/stat';}}new C().read();",
  "class A{read(){return fs.readFileSync(this.file);}}class B extends A{read(){return super.read();}}const read=new B().read;const target={file:'/proc/self/stat',read};target.read();",
  "class A{static read(){return fs.readFileSync(this.file);}}class B extends A{static read(){return super.read();}}B.file='/proc/self/stat';B.read();",
  "class A{static read(){return 1;}}class B extends A{static read(){return super.read();}}A.read=fs.readFileSync;B.read('/proc/self/stat');",
  "class A{static value='ordinary.json';}class B extends A{static read(){return fs.readFileSync(super.value);}}A.value='/proc/self/stat';B.read();",
  "class A{static file='ordinary.json';static file='/proc/self/stat';}fs.readFileSync(A.file);",
  "class A{static file='ordinary.json';static snapshot=this.file;static file='/proc/self/stat';}fs.readFileSync(A.file);",
  "class A{static read(){return 1;}}class B extends A{static read(){return super.read();}}opaque(A);B.read();",
  "class A{read(){return 1;}}class B extends A{read(){return super.read();}}Object.setPrototypeOf(B.prototype,foreign);new B().read();",
  "class A{static read(){return 1;}}class B extends A{static read(){return super.read();}}Object.setPrototypeOf(B,foreign);B.read();",
  "class A{read(){return 1;}}class Unsafe{read(){return fs.readFileSync('/proc/self/stat');}}let Parent=A;class B extends Parent{read(){return super.read();}}Parent=Unsafe;new B().read();",
  "class A{static set file(value){fs.readFileSync(value);}}class B extends A{}B.file='/proc/self/stat';",
]) test(`home identity and mutable parent state remain observable: ${source}`, () => {
  const report = inspect(source);
  assert.equal(report.ok, false, report.diagnostics.join('\n'));
});

for (const source of [
  "class A{read(){return fs.readFileSync(this.file);}}class B extends A{read(){return super['read']();}}class C extends B{constructor(){super();this.file='ordinary.json';}}new C().read();",
  "class A{static file='ordinary.json';static snapshot=this.file;static file='/proc/self/stat';}fs.readFileSync(A.snapshot);",
  "class A{static later='ordinary.json';}class B extends A{static first=this.later;static later='/proc/self/stat';}fs.readFileSync(B.first);",
  "class A{static file='ordinary.json';static snapshot=this.file;}class B extends A{static file='/proc/self/stat';}fs.readFileSync(B.snapshot);",
]) test(`static initialization reads the reached fields of its actual home: ${source}`, () => {
  const report = inspect(source);
  assert.equal(report.ok, true, report.diagnostics.join('\n'));
  assert.equal(report.complete, true);
});
