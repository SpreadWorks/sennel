import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceModule, SourceDeclaration, readTokens } from "../support/structure/source-reader.js";

function values(source, direct = false) {
  const declaration = direct ? new SourceDeclaration("selected", readTokens(source))
    : new SourceModule("src/renamed-return-scope.mjs", source).declaration("selected");
  return declaration.returns().map(entry => entry.tokens.map(token => token.value));
}

test("an enclosing function does not own a nested function return", () => {
  assert.deepEqual(values("function selected(input) { function nested() { return 'nested'; } return input; }"), [["input"]]);
});

test("a direct declaration does not own a nested arrow block return", () => {
  assert.deepEqual(values("function selected(input) { const nested = () => { return 'nested'; }; return input; }", true), [["input"]]);
});

test("an enclosing function does not own a local object getter return", () => {
  assert.deepEqual(values("function selected(input) { const object = { get file() { return input; } }; return object; }"), [["object"]]);
});

test("an enclosing function does not own a nested class method return", () => {
  assert.deepEqual(values("function selected(input) { class Nested { read() { return 'nested'; } } return input; }"), [["input"]]);
});

test("ordinary branch and catch returns remain owned by their function", () => {
  assert.deepEqual(values("function selected(input) { if (input) { return 'left'; } try { throw 0; } catch (error) { return 'caught'; } return 'last'; }"), [["left"], ["caught"], ["last"]]);
});

test("returning an object keeps the complete outer expression", () => {
  assert.deepEqual(values("function selected(input) { return { get file() { return input; } }; }"),
    [["{", "get", "file", "(", ")", "{", "return", "input", ";", "}", "}"]]);
});

test("a callable parameter default cannot supply a body return", () => {
  assert.deepEqual(values("function selected(input = () => { return 'default'; }) { return input; }"), [["input"]]);
});

test("automatic semicolon insertion at the body end retains the returned expression", () => {
  assert.deepEqual(values("function selected(input) { return input }"), [["input"]]);
});

test("automatic semicolon insertion before a branch closing brace retains both returns", () => {
  assert.deepEqual(values("function selected(input) { if (input) { return 'left' } return 'right' }"), [["left"], ["right"]]);
});

test("a line terminator after return produces an empty return expression", () => {
  assert.deepEqual(values("function selected(input) { return\ninput; }"), [[]]);
});

for (const direct of [false, true]) test('body ownership retains exact lexical token owners across nested declarations: '+(direct ? 'direct' : 'module'), () => {
  const source = `function selected(input = () => { return 'default'; }) {
    const nested = () => { return 'arrow'; };
    class Nested { get value() { return 'class'; } }
    const object = { read() { return 'object'; } };
    if (input) return 'branch';
    return 'outer';
  }`;
  const declaration = direct ? new SourceDeclaration('selected', readTokens(source))
    : new SourceModule('src/body-ownership.mjs', source).declaration('selected');
  for (const [name, expected] of [['default', false], ['arrow', false], ['class', false], ['object', false], ['branch', true], ['outer', true]]) {
    const token = declaration.tokens.find(token => token.kind === 'string' && token.value === name);
    assert.equal(declaration.ownsBodyToken(token), expected, name);
  }
  assert.deepEqual(declaration.returns().map(entry => entry.tokens.map(token => token.value)), [['branch'], ['outer']]);
  const foreign = readTokens(source).find(token => token.kind === 'string' && token.value === 'outer');
  assert.equal(declaration.ownsBodyToken(foreign), false, 'matching text and coordinates never replace token identity');
});

test('return ownership does not replace the module binding identities or imported references', () => {
  const module = new SourceModule('src/body-bindings.mjs', "import fs from 'node:fs';export function selected(input) { const nested = () => input; return fs.readFileSync(input); }");
  const declaration = module.declaration('selected');
  const tokens = declaration.tokens.filter(token => token.value === 'input' || token.value === 'fs');
  const bindings = tokens.map(token => module.bindingAt(token));
  const imported = module.moduleBinding('fs');
  assert.ok(imported);
  assert.ok(bindings.every(Boolean));
  assert.equal(declaration.returns().length, 1);
  for (const [index, token] of tokens.entries()) assert.equal(module.bindingAt(token), bindings[index]);
  assert.equal(module.moduleBinding('fs'), imported);
  assert.equal(declaration.ownsBodyToken(tokens.at(-1)), true);
});
