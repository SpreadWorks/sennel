import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const file = 'src/renamed-callable-effects.mjs';
function check(source) { return new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check(); }
function incomplete(source, line) {
  const report = check(source);
  assert.equal(report.ok, false);
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some(entry => entry.file === file && entry.line === line && entry.classification === 'incomplete'), report.diagnostics.join('\n'));
}
function portable(source) {
  const report = check(source);
  assert.equal(report.ok, true, report.diagnostics.join('\n'));
  assert.equal(report.complete, true);
}

test('an opaque consumer cannot acquire a returned native reader from a callable', () => {
  incomplete(`import fs from 'node:fs';
function acquire() { return fs.readFileSync; }
opaque(acquire);`, 3);
});
test('a data-only callable remains portable at an opaque consumer', () => {
  portable(`function stringify(input) { return input.trim(); }
opaque(stringify);`);
});
test('an opaque callback cannot hide its supplied native filesystem input', () => {
  incomplete(`import fs from 'node:fs';
function read(file) { return fs.readFileSync(file); }
opaque(read);`, 3);
});
test('a fixed portable native read can be inspected without a caller input', () => {
  portable(`import fs from 'node:fs';
function read() { return fs.readFileSync('snapshot.json'); }
opaque(read);`);
});
test('a callback transformation retains its supplied input until native I/O', () => {
  incomplete(`import fs from 'node:fs';
function read(file) { return fs.readFileSync(file.trim()); }
opaque(read);`, 3);
});
test('a nested returned callable keeps its native reader exposure', () => {
  incomplete(`import fs from 'node:fs';
function factory() { return () => fs.readFileSync; }
opaque(factory);`, 3);
});
test('an opaque consumer cannot obtain a mutable global intrinsic through a callable', () => {
  incomplete(`function acquire() { return Object; }
opaque(acquire);`, 2);
});
test('a callable global shadow remains ordinary data', () => {
  portable(`const Object = {value:'local'};
function acquire() { return Object; }
opaque(acquire);`);
});
for (const expression of ['Reader', 'new Reader()']) test('class module-native effects reach an opaque consumer: '+expression, () => {
  incomplete(`import fs from 'node:fs';
class Reader { read() { return fs.readFileSync; } }
opaque(${expression});`, 3);
});
test('a source object getter exposes its module-native capability', () => {
  incomplete(`import fs from 'node:fs';
const holder={get reader(){return fs.readFileSync;}};
opaque(holder);`, 3);
});
test('a source class getter exposes its module-native capability', () => {
  incomplete(`import fs from 'node:fs';
class Reader { get reader() { return fs.readFileSync; } }
opaque(new Reader());`, 3);
});
test('a static method exposes its module-native capability', () => {
  incomplete(`import fs from 'node:fs';
class Reader { static reader() { return fs.readFileSync; } }
opaque(Reader);`, 3);
});
test('a pure object getter remains inspectable', () => {
  portable(`const holder={get value(){return 'snapshot.json';}};
opaque(holder);`);
});
test('a pure source class remains inspectable', () => {
  portable(`class Value { constructor(value){this.value=value;} read(){return this.value;} }
opaque(new Value('snapshot.json'));`);
});

for (const expression of ['first', 'second']) test('mutually recursive native effects cannot borrow an unfinished safe summary: '+expression, () => {
  incomplete(`import fs from 'node:fs';
function first(flag) { return flag ? second(false) : fs.readFileSync; }
function second(flag) { return first(flag); }
opaque(${expression});`, 4);
});
test('separate closure invocations do not share a data-only effect result', () => {
  incomplete(`import fs from 'node:fs';
function wrap(value) { return () => value; }
opaque(wrap('snapshot.json'));
opaque(wrap(fs.readFileSync));`, 4);
});
test('a later lexical binding retains native effects after an earlier callback observation', () => {
  incomplete(`import fs from 'node:fs';
function make() { function read(){return value;} opaque(read); const value=fs.readFileSync; return read; }
opaque(make());`, 3);
});
test('an early recursive observation retains its dependency after the native summary completes', () => {
  incomplete(`import fs from 'node:fs';
function first(file){opaque(second);return fs.readFileSync(file);}
function second(){opaque(first);}
Object.freeze(first);
opaque(second);`, 5);
});
for (const definition of [
  'class Reader { #read=fs.readFileSync; getReader(){return this.#read;} }',
  'class Reader { read=fs.readFileSync; }',
  'class Reader { static read=fs.readFileSync; }',
  'class Reader { #read=()=>fs.readFileSync; getReader(){return this.#read;} }',
]) test('class field initializer capabilities remain observable: '+definition, () => {
  incomplete(`import fs from 'node:fs';
${definition}
opaque(${definition.includes('static') ? 'Reader' : 'new Reader()'});`, 3);
});
test('a getter summary observes subsequent writes to its module heap dependency', () => {
  incomplete(`const store={file:'snapshot.json'};
const bridge={get file(){return store.file;}};
opaque(bridge);
store.file='/proc/self/stat';
opaque(bridge);`, 5);
});
