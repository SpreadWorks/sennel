import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';

const file='src/renamed-lexical-capture.mjs';
function check(source) { return new OsIndependenceChecker(new MemorySourceRepository([[file,source]]),{files:[file]}).check(); }

test('a module class cannot capture a factory caller local capability', () => {
  const report=check(`import fs from 'node:fs';
class Plain { value() { return 'snapshot.json'; } }
function make(unused) { return new Plain(); }
opaque(make(fs));`);
  assert.equal(report.ok,true,report.diagnostics.join('\n'));
  assert.equal(report.complete,true);
});
test('a module function cannot lend a factory caller local capability to its returned class', () => {
  const report=check(`import fs from 'node:fs';
function create() { return class Plain { value() { return 'snapshot.json'; } }; }
function make(unused) { return create(); }
opaque(make(fs));`);
  assert.equal(report.ok,true,report.diagnostics.join('\n'));
  assert.equal(report.complete,true);
});
test('actual module class constructor arguments still reach native consumers', () => {
  const report=check(`import fs from 'node:fs';
class Reader { constructor(file) { this.file=file; } read() { fs.readFileSync(this.file); } }
function make(input) { return new Reader(input); }
make('/proc/self/stat').read();`);
  assert.equal(report.ok,false);
  assert.ok(report.diagnostics.some(entry=>entry.rule==='OS01' && entry.file===file && entry.line===2 && entry.classification==='violation'),report.diagnostics.join('\n'));
});
test('a genuinely nested class retains its lexical captured capability', () => {
  const report=check(`import fs from 'node:fs';
function make(input) { return class Reader { read() { return input; } }; }
opaque(make(fs));`);
  assert.equal(report.ok,false);
  assert.equal(report.complete,false);
  assert.ok(report.diagnostics.some(entry=>entry.rule==='OS02' && entry.file===file && entry.line===3 && entry.classification==='incomplete'),report.diagnostics.join('\n'));
});
test('a nested class captures only lexical bindings actually referenced by its source', () => {
  const report=check(`import fs from 'node:fs';
function make(unused) { return class Plain { value() { return 'snapshot.json'; } }; }
opaque(make(fs));`);
  assert.equal(report.ok,true,report.diagnostics.join('\n'));
  assert.equal(report.complete,true);
});
test('a class method parameter shadow does not capture the outer binding', () => {
  const report=check(`import fs from 'node:fs';
function make(input) { return class Plain { value(input) { return input; } }; }
opaque(make(fs));`);
  assert.equal(report.ok,true,report.diagnostics.join('\n'));
  assert.equal(report.complete,true);
});
