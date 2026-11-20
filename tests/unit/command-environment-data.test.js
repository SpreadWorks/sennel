import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandInvocationError, immutableCommandEnvironment } from '../../src/lib/command-invocation.js';

const invalidEnvironment = error => error instanceof CommandInvocationError && error.code === 'COMMAND_INVOCATION_INVALID';

test('environment capture preserves ordinary data inputs and null inheritance', () => {
  class Environment { constructor() { this.PATH = 'tools'; this.EMPTY = ''; } }
  const expected = { PATH: 'tools', EMPTY: '' };
  const inputs = [
    { ...expected },
    JSON.parse('{"PATH":"tools","EMPTY":""}'),
    Object.assign(Object.create(null), expected),
    new Environment(),
    Object.freeze({ ...expected }),
  ];
  assert.equal(immutableCommandEnvironment(null), null);
  for (const input of inputs) {
    const result = immutableCommandEnvironment(input);
    assert.notEqual(result, input);
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(Object.isFrozen(result), true);
    assert.deepEqual(result, expected);
    for (const name of ['PATH', 'EMPTY']) assert.deepEqual(Object.getOwnPropertyDescriptor(result, name),
      { value: expected[name], writable: false, enumerable: true, configurable: false });
  }
});

test('environment snapshot retains own __proto__ and shallow symbol data without source aliasing', () => {
  const symbol = Symbol('metadata');
  const metadata = { mutable: true };
  const input = { PATH: 'before', [symbol]: metadata };
  Object.defineProperty(input, '__proto__', { value: 'literal', enumerable: true, configurable: true });
  const result = immutableCommandEnvironment(input);
  input.PATH = 'after'; input[symbol] = {};
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal(result.__proto__, 'literal');
  assert.equal(result.PATH, 'before');
  assert.equal(result[symbol], metadata);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(metadata), false, 'environment capture remains shallow');
  metadata.mutable = false;
  assert.equal(result[symbol].mutable, false);
});

test('environment capture ignores inherited and nonenumerable accessors without invoking them', () => {
  let reads = 0;
  const inherited = { get INHERITED() { reads++; return 'ignored'; } };
  const input = Object.create(inherited);
  input.PATH = 'tools';
  Object.defineProperty(input, 'HIDDEN', { get() { reads++; return 'ignored'; } });
  Object.defineProperty(input, Symbol('hidden'), { get() { reads++; return 'ignored'; } });
  assert.deepEqual(immutableCommandEnvironment(input), { PATH: 'tools' });
  assert.equal(reads, 0);
});

test('environment rejects a changing enumerable getter before its first value acquisition', () => {
  let reads = 0;
  const input = { get TOKEN() { return ++reads === 1 ? 'valid' : 'bad\0value'; } };
  assert.throws(() => immutableCommandEnvironment(input), invalidEnvironment);
  assert.equal(reads, 0, 'even the initially valid getter must not execute');
});

test('environment rejects an effectful enumerable getter without running the effect', () => {
  let effects = 0;
  const input = { get TOKEN() { effects++; return 'valid'; } };
  assert.throws(() => immutableCommandEnvironment(input), invalidEnvironment);
  assert.equal(effects, 0);
});

test('environment rejects setter-only enumerable properties without invoking a setter', () => {
  let writes = 0;
  const input = { set TOKEN(value) { writes++; } };
  assert.throws(() => immutableCommandEnvironment(input), invalidEnvironment);
  assert.equal(writes, 0);
});

test('environment rejects enumerable symbol accessors without acquiring their values', () => {
  let reads = 0;
  const input = { PATH: 'tools', get [Symbol('metadata')]() { reads++; return {}; } };
  assert.throws(() => immutableCommandEnvironment(input), invalidEnvironment);
  assert.equal(reads, 0);
});

test('environment rejects Proxy inputs before any target interrogation', () => {
  const calls = [];
  const input = new Proxy({ TOKEN: 'valid' }, {
    ownKeys(target) { calls.push('ownKeys'); return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, name) { calls.push('descriptor'); return Reflect.getOwnPropertyDescriptor(target, name); },
    get(target, name, receiver) { calls.push('get'); return Reflect.get(target, name, receiver); },
    getPrototypeOf(target) { calls.push('prototype'); return Reflect.getPrototypeOf(target); },
  });
  assert.throws(() => immutableCommandEnvironment(input), invalidEnvironment);
  assert.deepEqual(calls, []);
});

test('environment rejects revoked Proxy inputs with the environment boundary error', () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  assert.throws(() => immutableCommandEnvironment(proxy), invalidEnvironment);
});

test('environment retains name and primitive-string validation without coercion', () => {
  let conversions = 0;
  const nonString = { toString() { conversions++; return 'valid'; }, valueOf() { conversions++; return 1; } };
  for (const input of [
    { TOKEN: 'bad\0value' }, { TOKEN: nonString }, { TOKEN: 1 }, { TOKEN: undefined },
    { '': 'value' }, { 'BAD=KEY': 'value' }, { ['BAD\0KEY']: 'value' },
  ]) assert.throws(() => immutableCommandEnvironment(input), invalidEnvironment);
  assert.equal(conversions, 0);
});
