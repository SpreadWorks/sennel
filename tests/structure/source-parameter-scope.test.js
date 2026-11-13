import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceModule, SourceInputBinding } from "../support/structure/source-reader.js";

function sameInput(source, name = "input") {
  const module = new SourceModule("src/renamed-parameter-scope.mjs", source);
  const tokens = module.tokens.filter(token => token.kind === "identifier" && token.value === name);
  assert.ok(tokens.length >= 2);
  const binding = module.bindingAt(tokens[0]);
  assert.ok(binding instanceof SourceInputBinding);
  assert.ok(tokens.every(token => module.bindingAt(token) === binding));
}

test("ordinary parameter defaults reference the same formal input", () => {
  sameInput("function selected(input, file = input) { return input; }");
});

test("destructured parameter defaults reference an earlier input", () => {
  sameInput("function selected(input, { file = input } = {}) { return input; }");
});

test("arrow parameter defaults reference the same input as the expression body", () => {
  sameInput("const selected = (input, file = input) => input;");
});

test("method parameter defaults reference the same input as the method body", () => {
  sameInput("class Reader { read(input, { file = input } = {}) { return input; } }");
});

test("catch destructuring defaults reference the caught input binding", () => {
  sameInput("try {} catch ({ input, file = input }) { consume(input); }");
});

test("body declarations cannot shadow a global in parameter defaults", () => {
  const module = new SourceModule("src/renamed-parameter-scope.mjs",
    "function selected(value = process.platform) { const process = {}; return process; }");
  const tokens = module.tokens.filter(token => token.value === "process");
  assert.equal(module.bindingAt(tokens[0]), null);
  assert.equal(module.isUnbound("process", tokens[0]), true);
  assert.notEqual(module.bindingAt(tokens[1]), null);
  assert.equal(module.bindingAt(tokens[1]), module.bindingAt(tokens[2]));
  assert.equal(module.isUnbound("process", tokens[2]), false);
});
