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
