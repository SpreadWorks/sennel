import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SourceDeclaration, SourceModule, readTokens} from '../support/structure/source-reader.js';
import {MemorySourceRepository} from '../support/structure/source-repository.js';
import {OsIndependenceChecker} from '../support/structure/os-independence-checker.js';

function expressionFixture() {
  const file = 'src/token-owner.mjs';
  const checker = new OsIndependenceChecker(new MemorySourceRepository([[file,
    'export function read(input) { return input; }']]), {files: [file]});
  const module = checker.graph.module(file, {lexicalOnly: true});
  const declaration = module.declaration('read');
  const callable = checker.rules.origins.value(module, declaration.tokens, new Map());
  return {module, declaration: callable.declaration, expression: callable.captures.expression};
}

test('completed module syntax has an immutable token order and preserves lexer metadata', () => {
  const source = 'export function read(input) { return `value:${input}`; }';
  const module = new SourceModule('src/reader.mjs', source);
  assert.deepEqual(module.tokens, readTokens(source, module.file));
  assert.equal(Object.isFrozen(module.tokens), true);
  assert.throws(() => module.tokens.reverse(), TypeError);
  assert.equal(Object.isFrozen(module.tokens[0]), false, 'token metadata has its existing lifetime');
  assert.equal(module.declaration('read').token, module.tokens[1]);
});

test('declarations isolate mutable caller arrays without freezing or copying their token objects', () => {
  const tokens = readTokens('function read(input) { return input; }');
  const original = [...tokens];
  const declaration = new SourceDeclaration('read', tokens);
  assert.equal(Object.isFrozen(tokens), false);
  tokens.reverse();
  assert.deepEqual(declaration.tokens, original);
  assert.equal(Object.isFrozen(declaration.tokens), true);
  assert.ok(declaration.tokens.every((token, index) => token === original[index]));
});

test('declarations and captured expressions share an already immutable exact token sequence', () => {
  const {module, declaration, expression} = expressionFixture();
  assert.equal(expression.tokens, declaration.tokens);
  const again = new expression.constructor(module, declaration.tokens);
  assert.equal(again.tokens, declaration.tokens);
  assert.equal(new SourceDeclaration('read', declaration.tokens).tokens, declaration.tokens);
});

test('expression ownership isolates mutable input and never equates different interior tokens', () => {
  const {module, declaration, expression} = expressionFixture();
  const tokens = [...declaration.tokens];
  const saved = [...tokens];
  const owned = new expression.constructor(module, tokens);
  assert.equal(Object.isFrozen(tokens), false);
  tokens[3] = readTokens('different')[0];
  assert.deepEqual(owned.tokens, saved);
  assert.equal(owned.hasExpression(module, tokens), false);
  const frozen = Object.freeze(tokens);
  const different = new expression.constructor(module, frozen);
  assert.equal(different.tokens, frozen);
  assert.equal(different.hasExpression(module, saved), false);
  assert.equal(different.hasExpression(new SourceModule('src/other.mjs', ''), frozen), false);
});

for (const frozen of [false, true]) test('invalid token elements remain rejected in '+(frozen ? 'frozen' : 'mutable')+' input', () => {
  const {module, expression} = expressionFixture();
  for (const elements of [[null], [{}], Array(1)]) {
    const tokens = frozen ? Object.freeze(elements) : elements;
    assert.throws(() => new SourceDeclaration('read', tokens), TypeError);
    assert.throws(() => new expression.constructor(module, tokens), TypeError);
  }
});
