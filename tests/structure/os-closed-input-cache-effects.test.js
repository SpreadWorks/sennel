import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';
import { matching } from '../support/structure/source-reader.js';

const file = 'src/cache-alias.mjs';
const changed = 'src/change.mjs';
const source = "import fs from 'node:fs';function extra(){return 0;} 'a a'.replace('a',(_match,index)=>{const selected=index;return fs.readFileSync(selected===0?'ordinary':'/proc/self/stat');},extra());";

class ClosedCallbackQueryFixture {
  constructor() {
    this.checker = new OsIndependenceChecker(new MemorySourceRepository([[file, source], [changed, 'String.prototype.replace=foreign;']]), { files: [file] });
    assert.equal(this.checker.check().ok, true);
    this.origins = this.checker.rules.origins;
    this.module = this.checker.graph.module(file, { lexicalOnly: true });
    const tokens = this.module.tokens;
    const call = tokens.findIndex(token => token.offset === source.indexOf('fs.readFileSync'));
    const end = matching(tokens, call + 3, '(', ')');
    this.path = tokens.slice(call + 4, end);
    this.alias = this.path.slice(0, 1);
    this.consumer = tokens.slice(call, end + 1);
    this.environment = new Map();
    this.consumerEnvironment = new Map();
    this.effects = 0;
    this.consumers = [];
    const extraToken = tokens.find(token => token.value === 'function');
    const invoke = this.origins.invoke, fixture = this;
    this.origins.invoke = function(callee, ...args) {
      if (callee.declaration?.token === extraToken) fixture.effects++;
      return invoke.call(this, callee, ...args);
    };
    const onCall = this.origins.onCall;
    this.origins.onCall = function(callee, args, ...rest) {
      if (callee.builtin === 'fs' && callee.member === 'readFileSync') fixture.consumers.push(args[0]);
      return onCall.call(this, callee, args, ...rest);
    };
  }
  read(tokens, environment = this.environment) {
    const before = this.effects;
    const value = this.origins.value(this.module, tokens, environment);
    assert.equal(this.effects - before, 1, 'each dependent evaluation runs the actual extra argument');
    assert.equal(this.origins.activeCallInputs.size, 0);
    return value;
  }
  readConsumer() {
    const before = this.consumers.length;
    this.read(this.consumer, this.consumerEnvironment);
    assert.equal(this.consumers.length - before, 1, 'the downstream native consumer must be observed');
    return this.consumers.at(-1);
  }
  mutate() { this.origins.scan(this.checker.graph.module(changed, { lexicalOnly: true })); }
}

test('closed input aliases and derived paths re-evaluate their transitive input effects', () => {
  const fixture = new ClosedCallbackQueryFixture();
  for (let count = 0; count < 2; count++) {
    assert.equal(fixture.read(fixture.alias).value, 0);
    assert.equal(fixture.read(fixture.path).value, 'ordinary');
    assert.equal(fixture.readConsumer().value, 'ordinary');
  }
});

test('same-environment aliases and downstream I/O withdraw closed input proof after native mutation', () => {
  const fixture = new ClosedCallbackQueryFixture();
  fixture.read(fixture.alias);
  fixture.read(fixture.path);
  fixture.readConsumer();
  fixture.mutate();
  const binding = fixture.module.bindingAt(fixture.module.tokens.find(token => token.value === 'index'));
  assert.equal(fixture.origins.closedCallInput(fixture.module, binding, fixture.origins.closedCallInputs.callback(fixture.module, binding)), null);
  assert.equal(fixture.read(fixture.alias).value, undefined);
  assert.equal(fixture.read(fixture.path).sensitive, true);
  assert.equal(fixture.readConsumer().sensitive, true);
  assert.equal(fixture.read(fixture.path, new Map()).sensitive, true);
  assert.ok(fixture.checker.report.diagnostics.some(entry => entry.file === file && entry.rule === 'OS01'
    && entry.line === 1 && entry.column === 117 && entry.classification === 'incomplete'));
  assert.deepEqual(fixture.checker.report.diagnostics.filter(entry => entry.rule === 'OS00'), []);
});

test('unrelated literal evaluations retain the existing constant cache', () => {
  const fixture = new ClosedCallbackQueryFixture();
  const token = fixture.module.tokens.find(token => token.kind === 'number' && token.value === '0');
  const read = fixture.origins.constantValues.read;
  let hits = 0;
  fixture.origins.constantValues.read = function(...args) {
    const value = read.apply(this, args);
    if (args[1] === fixture.module && args[2].endsWith(`:${token.offset}:${token.offset}`) && value !== null) hits++;
    return value;
  };
  const environment = new Map(), revision = fixture.origins.closedCallInputs.queryRevision;
  assert.equal(fixture.origins.value(fixture.module, [token], environment).value, 0);
  assert.equal(fixture.origins.value(fixture.module, [token], environment).value, 0);
  assert.ok(hits > 0, 'the unrelated constant cache remains active');
  assert.equal(fixture.origins.closedCallInputs.queryRevision, revision);
});
