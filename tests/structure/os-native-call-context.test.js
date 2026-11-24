import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';

class NativeCallContextFixture {
  constructor(source, expression) {
    this.file = 'src/native-call-context.mjs';
    this.checker = new OsIndependenceChecker(new MemorySourceRepository([[this.file, source], ['src/change.mjs', 'globalThis.String=foreign;RegExp.prototype.exec=foreign;']]), { files: [this.file] });
    this.checker.check();
    this.origins = this.checker.rules.origins;
    this.module = this.checker.graph.module(this.file, { lexicalOnly: true });
    const start = source.indexOf(expression), end = start + expression.length;
    this.tokens = this.module.tokens.filter(token => token.offset >= start && token.offset < end);
    this.environment = new Map();
    this.calls = [];
    const invoke = this.origins.invoke, fixture = this;
    this.origins.invoke = function(callee, args, ...rest) {
      fixture.calls.push({ callee, args });
      return invoke.call(this, callee, args, ...rest);
    };
  }
  read() { return this.origins.expression(this.module, this.tokens, this.environment); }
  mutate() { this.origins.scan(this.checker.graph.module('src/change.mjs', { lexicalOnly: true })); }
}

test('explicit String call retains exact source, native identity, environment and original inputs without changing its result type', () => {
  const fixture = new NativeCallContextFixture('const text=String(choice);', 'String(choice)');
  for (let index = 0; index < 2; index++) {
    const before = fixture.calls.length, result = fixture.read(), context = result.callContext;
    assert.ok(context, 'native call metadata is retained');
    assert.equal(result.constructor.name, 'SourceStringValue');
    assert.equal(context.constructor.name, 'SourceStringCallContext');
    assert.equal(context.source.expression.module, fixture.module);
    assert.deepEqual(context.source.expression.tokens, fixture.tokens);
    assert.equal(context.source.constructed, false);
    assert.equal(context.callee.builtin, 'String');
    assert.deepEqual(context.callee.members, []);
    assert.equal(context.environment, fixture.environment);
    assert.equal(context.home, null);
    assert.equal(context.receiver, null);
    assert.equal(context.inputs[0], result.origin);
    assert.deepEqual(context.outputs, []);
    assert.deepEqual(context.trace, result.trace);
    assert.ok(fixture.calls.length > before, 'native invocation effects run on each interpretation');
  }
});

test('exec retains nullable ordered output identities and actual receiver without granting the alternative an allocation', () => {
  const fixture = new NativeCallContextFixture("const pattern=/a/;const match=pattern.exec('ordinary');", "pattern.exec('ordinary')");
  let state = null;
  for (let index = 0; index < 2; index++) {
    const before = fixture.calls.length, result = fixture.read(), context = result.callContext;
    assert.ok(context, 'nullable native call metadata is retained');
    assert.equal(result.constructor.name, 'SourceAlternativeValues');
    assert.equal(result.allocationState, null);
    assert.equal(context.constructor.name, 'SourceRegexExecContext');
    assert.deepEqual(context.source.expression.tokens, fixture.tokens);
    assert.equal(context.callee.builtin, 'RegExp');
    assert.deepEqual(context.callee.members, ['prototype', 'exec']);
    assert.equal(context.receiver.constructor.name, 'RegexLiteralValue');
    assert.equal(context.environment, fixture.environment);
    assert.equal(context.inputs[0].value, 'ordinary');
    assert.equal(context.outputs[0], result.values[0]);
    assert.equal(context.outputs[1], result.values[1]);
    assert.equal(result.values[1].value, null);
    assert.ok(result.values[0].allocationState);
    if (state !== null) assert.equal(result.values[0].allocationState, state);
    state = result.values[0].allocationState;
    assert.ok(fixture.calls.length > before);
  }
});

test('native replacement withdraws producer metadata without certifying the changed result', () => {
  for (const [source, expression] of [['const text=String(choice);', 'String(choice)'], ["const pattern=/a/;const match=pattern.exec('ordinary');", "pattern.exec('ordinary')"]]) {
    const fixture = new NativeCallContextFixture(source, expression);
    assert.ok(fixture.read().callContext);
    fixture.mutate();
    assert.equal(fixture.read().callContext, undefined);
    assert.ok(fixture.checker.report.diagnostics.some(entry => entry.file === fixture.file && entry.rule === 'OS02' && entry.classification === 'incomplete'));
  }
});

test('literal String output retains the existing exact scalar representation', () => {
  const fixture = new NativeCallContextFixture("const text=String('ordinary');", "String('ordinary')"), result = fixture.read();
  assert.equal(result.value, 'ordinary');
  assert.equal(result.callContext, undefined);
});

for (const expression of ['String(choice)', 'globalThis.String(choice)']) test(`cached intrinsic syntax retains the complete producer boundary: ${expression}`, () => {
  const fixture = new NativeCallContextFixture(`const text=${expression};`, expression);
  for (let index = 0; index < 2; index++) {
    const before = fixture.calls.length;
    const result = fixture.origins.intrinsicExpressions.value(fixture.module, fixture.tokens, fixture.environment, fixture.origins);
    const context = result.callContext;
    assert.ok(context, 'the intrinsic syntax path forwards native provenance');
    assert.equal(context.constructed, false);
    assert.equal(context.source.constructed, false);
    assert.deepEqual(context.source.expression.tokens, fixture.tokens);
    assert.deepEqual(context.source.callee.tokens, fixture.tokens.slice(0, expression.startsWith('globalThis') ? 3 : 1));
    assert.equal(context.inputs[0], result.origin);
    assert.equal(context.environment, fixture.environment);
    if (expression.startsWith('globalThis')) assert.equal(context.receiver.builtin, 'globalThis');
    else assert.equal(context.receiver, null);
    assert.ok(fixture.calls.length > before);
  }
});

test('cached intrinsic syntax preserves the real I/O effect in each helper invocation', () => {
  const fixture = new NativeCallContextFixture("import fs from 'node:fs';function extra(){return fs.readFileSync('/proc/self/stat');}function convert(input){return String(input,extra());}const text=convert(choice);", 'convert(choice)');
  const observed = call => call.callee.builtin === 'fs' && call.callee.member === 'readFileSync';
  for (let index = 0; index < 2; index++) {
    const before = fixture.calls.filter(observed).length;
    const result = fixture.read();
    assert.ok(result.callContext);
    assert.equal(result.callContext.inputs.length, 2);
    assert.notEqual(result.callContext.inputs[1], undefined);
    assert.ok(fixture.calls.filter(observed).length > before, 'actual extra-argument I/O is reinterpreted');
  }
  assert.ok(fixture.checker.report.diagnostics.some(entry => entry.file === fixture.file && entry.rule === 'OS01'
    && entry.line === 1 && entry.column === 50 && entry.classification === 'violation'));
});
