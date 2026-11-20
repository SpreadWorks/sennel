import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemorySourceRepository } from '../support/structure/source-repository.js';
import { OsIndependenceChecker } from '../support/structure/os-independence-checker.js';

/** Interpret source through the checker; never run the inspected JavaScript. */
class SourceCallEvaluationFixture {
  constructor() {
    this.file = 'src/source-evaluation.mjs';
    this.source = "import fs from 'node:fs';const pattern=/a/;const match=pattern.exec('ordinary','extra');pattern.exec=foreign;const alternate=foreign;const otherPattern=/b/;const key={};function wrap(input){return new WeakMap();}wrap(match);";
    this.checker = new OsIndependenceChecker(new MemorySourceRepository([[this.file, this.source]]), { files: [this.file] });
    this.checker.check();
    this.origins = this.checker.rules.origins;
    this.module = this.checker.graph.module(this.file, { lexicalOnly: true });
    this.environment = new Map();
    this.calls = [];
    const fixture = this, invoke = this.origins.invoke;
    this.origins.invoke = function(...args) {
      const result = Reflect.apply(invoke, this, args);
      fixture.calls.push(new SourceCallObservation(args, result));
      return result;
    };
  }
  tokens(expression) {
    const start = this.source.indexOf(expression);
    assert.ok(start >= 0);
    return this.module.tokens.filter(token => token.offset >= start && token.offset < start + expression.length);
  }
  read() { return this.origins.expression(this.module, this.tokens("pattern.exec('ordinary','extra')"), this.environment); }
  named(name) { return this.origins.identifier(this.module, this.module.tokens.find(token => token.value === name), this.environment); }
  reinterpret(context, callee, receiver, inputs) {
    return this.origins.invoke(callee, inputs, context.source.callee.tokens.at(-1), this.module,
      this.environment, false, receiver, context.source);
  }
  inputContext(value, caller = this.environment, token = this.module.tokens.at(-4)) {
    const callable = this.origins.value(this.module, this.module.declaration('wrap').tokens, this.environment);
    return this.origins.callInvocations.environment(callable, [value], null, token, caller, this.origins);
  }
  wrap(value) {
    const callable = this.origins.value(this.module, this.module.declaration('wrap').tokens, this.environment);
    return this.origins.invoke(callable, [value], this.module.tokens.at(-4), this.module, this.environment);
  }
  member(receiver, name) { return this.origins.member(receiver, name, this.module.tokens.at(-4), this.module, this.environment); }
  callMember(receiver, name, args) {
    return this.origins.invoke(this.member(receiver, name), args, this.module.tokens.at(-4), this.module,
      this.environment, false, receiver);
  }
}
class SourceCallObservation {
  constructor(args, result) { this.args = args; this.result = result; Object.freeze(this); }
}

test('ordinary call evaluation keeps its actual opaque callee and original edges without a native or normal result', () => {
  const fixture = new SourceCallEvaluationFixture();
  let previous = null, previousInputContext = null;
  for (let index = 0; index < 2; index++) {
    const before = fixture.calls.length;
    const result = fixture.read(), context = result.callContext;
    const observation = fixture.calls.findLast(call => call.result === result);
    assert.ok(fixture.calls.length > before, 'each interpretation still invokes the original effect path');
    assert.equal(result.constructor.name, 'SourceUninspectedCallResult');
    assert.equal(result.reason, 'uninspected call result');
    assert.equal(result.allocationState, null);
    assert.ok(context);
    assert.equal(context.constructor.name, 'SourceUninspectedCallContext');
    assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(context)).constructor.name, 'SourceCallEvaluationContext');
    assert.equal(context.callee, observation.args[0]);
    assert.equal(context.callee.constructor.name, 'UnknownValue');
    assert.equal(context.receiver, observation.args[6]);
    assert.equal(context.receiver.constructor.name, 'RegexLiteralValue');
    assert.deepEqual(context.source.expression.tokens, fixture.tokens("pattern.exec('ordinary','extra')"));
    assert.equal(context.source.expression.module, fixture.module);
    assert.equal(context.source.constructed, false);
    assert.equal(context.constructed, false);
    assert.equal(context.environment, fixture.environment);
    assert.equal(context.home, null);
    assert.deepEqual(context.inputs, observation.args[1]);
    assert.deepEqual(result.inputs, [context.callee, ...context.inputs]);
    assert.equal(context.inputs[0].value, 'ordinary');
    assert.equal(context.inputs[1].value, 'extra');
    assert.deepEqual(context.outputs, []);
    assert.deepEqual(context.trace, result.trace);
    assert.ok(Object.isFrozen(context));
    const inputContext = fixture.inputContext(result);
    if (previous !== null) {
      assert.notEqual(previous, result, 'fresh result values are not semantically interned');
      assert.equal(previous.callContext.callee, context.callee, 'only the actual same opaque callee may share an interpretation');
      assert.equal(previousInputContext, inputContext);
    }
    assert.notEqual(inputContext, fixture.inputContext(result, new Map(fixture.environment)), 'caller identity is retained');
    assert.notEqual(inputContext, fixture.inputContext(result, fixture.environment, fixture.module.tokens.at(-3)), 'call site identity is retained');
    previous = result;
    previousInputContext = inputContext;
  }
});

test('input interpretation distinguishes actual opaque callee references, receiver and ordered arguments at the same source boundary', () => {
  const fixture = new SourceCallEvaluationFixture();
  const original = fixture.read(), context = original.callContext;
  const alternate = fixture.named('alternate'), receiver = fixture.named('otherPattern');
  assert.equal(alternate.constructor.name, 'UnknownValue');
  assert.equal(alternate.reason, context.callee.reason);
  assert.equal(alternate.sensitive, context.callee.sensitive);
  assert.notEqual(alternate, context.callee, 'an equal unknown description is not actual callee identity');
  const same = fixture.reinterpret(context, context.callee, context.receiver, context.inputs);
  const otherCallee = fixture.reinterpret(context, alternate, context.receiver, context.inputs);
  const otherReceiver = fixture.reinterpret(context, context.callee, receiver, context.inputs);
  const reverseArguments = fixture.reinterpret(context, context.callee, context.receiver, [...context.inputs].reverse());
  const extraArgument = fixture.reinterpret(context, context.callee, context.receiver, [...context.inputs, alternate]);
  const inputContext = fixture.inputContext(original);
  assert.equal(fixture.inputContext(same), inputContext);
  for (const result of [otherCallee, otherReceiver, reverseArguments, extraArgument]) {
    assert.equal(result.constructor.name, 'SourceUninspectedCallResult');
    assert.equal(result.callContext.constructor.name, 'SourceUninspectedCallContext');
    assert.equal(result.callContext.source, context.source);
    assert.equal(result.callContext.environment, context.environment);
    assert.notEqual(fixture.inputContext(result), inputContext);
    assert.deepEqual(result.inputs, [result.callContext.callee, ...result.callContext.inputs]);
    assert.equal(result.allocationState, null);
  }
  assert.equal(otherCallee.callContext.callee, alternate);
  assert.equal(otherReceiver.callContext.receiver, receiver);
  assert.deepEqual(reverseArguments.callContext.inputs, [...context.inputs].reverse());

  // Use the existing helper interpretation and native WeakMap model to observe
  // the retained allocation, rather than only comparing trie environments.
  const map = fixture.wrap(original), sameMap = fixture.wrap(same), otherMap = fixture.wrap(otherCallee);
  const key = fixture.named('key'), payload = fixture.member(fixture.named('fs'), 'readFileSync');
  assert.equal(payload.sensitive, true);
  fixture.callMember(map, 'set', [key, payload]);
  assert.equal(fixture.callMember(sameMap, 'get', [key]).sensitive, true, 'the same evaluation retains the later write');
  assert.equal(fixture.callMember(otherMap, 'get', [key]).sensitive, false, 'a different actual opaque callee never inherits that write');
});
