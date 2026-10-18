import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceModule, SourceDeclaration, readTokens, readParameters, readInvocations, readCommaSeparated, SourceReadError, SourceTemplateToken, sourceContainsSequence } from "../support/structure/source-reader.js";

test("template chunks preserve cooked text, interpolation tokens, and exact nested locations", () => {
  const source = 'const path = `a\\n${prefix + `b${name}`}c`;';
  const module = new SourceModule("template.mjs", source);
  const template = module.templates[0];
  assert.ok(template instanceof SourceTemplateToken);
  assert.deepEqual(template.chunks.map((chunk) => [chunk.value, chunk.raw]), [["a\n", "a\\n"], ["c", "c"]]);
  assert.equal(source[template.offset], "`");
  assert.equal(source[template.endToken.offset], "`");
  assert.deepEqual(template.interpolations[0].tokens.map((token) => token.value),
    ["prefix", "+", "<template>", "name", "<template-end>"]);
  for (const nested of module.templates) {
    for (const chunk of nested.chunks) assert.equal(source.slice(chunk.offset, chunk.offset + chunk.raw.length), chunk.raw);
    for (const expression of nested.interpolations) {
      assert.equal(source.slice(expression.token.offset, expression.token.offset + 2), "${");
      assert.equal(source[expression.endToken.offset], "}");
      assert.equal(expression.token.column, expression.token.offset + 1);
    }
  }
  assert.equal(module.templates[1].chunks[0].value, "b");
});

test("literal CommonJS loads and exports share references without evaluating module text", () => {
  const module = new SourceModule("module.cjs", [
    "const filesystem = require('node:fs');",
    "const { readFile: read } = require('node:fs/promises');",
    "const main = require('./helper.mjs').main;",
    "exports.load = read; module.exports.main = main;",
    "const literal = \"require('./ignored.js')\";",
    "function local(require) { return require('./shadow.js'); }",
  ].join("\n"));
  assert.deepEqual(module.references.map((reference) => [reference.kind, reference.specifier, [...reference.bindings]]), [
    ["require", "node:fs", [["filesystem", "*"]]],
    ["require", "node:fs/promises", [["read", "readFile"]]],
    ["require", "./helper.mjs", [["main", "main"]]],
  ]);
  assert.deepEqual(module.exports.map((entry) => [entry.name, entry.local]), [["load", "read"], ["main", "main"]]);
  const references = module.bindingReferences("read");
  assert.equal(references.length, 1);
  assert.equal(module.bindingAt(references[0]), module.moduleBinding("read"));
});

test("CommonJS object and forwarding exports preserve the referenced origin", () => {
  const object = new SourceModule("object.cjs", "const original = 1; module.exports = { original, renamed: original };");
  assert.deepEqual(object.exports.map((entry) => [entry.name, entry.local]), [["original", "original"], ["renamed", "original"]]);
  const forward = new SourceModule("forward.cjs", "module.exports = require('./source.cjs');");
  assert.deepEqual(forward.exports.map((entry) => [entry.name, entry.local, entry.reference.specifier]),
    [["default", "*", "./source.cjs"], ["*", "*", "./source.cjs"]]);
});

test("computed require and unsupported CommonJS export shapes remain incomplete", () => {
  const module = new SourceModule("dynamic.cjs", "require(name);");
  assert.deepEqual(module.dynamic.map((token) => [token.value, token.line, token.column]), [["require", 1, 1]]);
  assert.throws(() => new SourceModule("export.cjs", "module.exports = factory();"), SourceReadError);
});


test("shared source sequence matching distinguishes instructions from inert text", () => {
  const module = new SourceModule("loader.js", 'const text = "consume(snapshot)"; const snapshot = read(); consume(snapshot);');
  assert.equal(sourceContainsSequence(module.tokens, "consume(snapshot)"), true);
  const inert = new SourceModule("fixture.js", 'const text = "consume(snapshot)";');
  assert.equal(sourceContainsSequence(inert.tokens, "consume(snapshot)"), false);
});


test("shared callable grammar reads parenthesized and single-parameter arrow helper bodies", () => {
  for (const source of ["value => { return value.platform; }", "(value) => { return value.platform; }", "async value => { return value.platform; }"]) {
    const declaration = new SourceDeclaration("helper", readTokens(source));
    assert.deepEqual(readParameters(declaration.tokens).map((part) => part.map((token) => token.value)), [["value"]]);
    assert.deepEqual(declaration.returns().map((entry) => entry.tokens.map((token) => token.value)), [["value", ".", "platform"]]);
  }
  const enclosing = new SourceDeclaration("enclosing", readTokens("function enclosing(input) { const helper = nested => nested; return input; }"));
  assert.deepEqual(readParameters(enclosing.tokens).map((part) => part.map((token) => token.value)), [["input"]]);
  assert.deepEqual(enclosing.returns().map((entry) => entry.tokens.map((token) => token.value)), [["input"]]);
});


test("shared call grammar keeps comma interpolations inside one template argument", () => {
  const module = new SourceModule("arguments.js", 'consume(`${first, second}`, `outer ${`inner ${third, fourth}`}`, last);');
  const call = readInvocations(module).find((entry) => entry.name === "consume");
  assert.equal(call.arguments.length, 3);
  assert.equal(call.arguments[0][0], module.templates[0]);
  assert.equal(call.arguments[0].at(-1), module.templates[0].endToken);
  assert.equal(call.arguments[1][0], module.templates[1]);
  assert.equal(call.arguments[1].at(-1), module.templates[1].endToken);
  assert.deepEqual(call.arguments[2].map((token) => token.value), ["last"]);
  assert.deepEqual(module.templates[0].interpolations[0].tokens.map((token) => token.value), ["first", ",", "second"]);
});

test("truncated retained template spans fail rather than looping or splitting an interpolation", () => {
  const tokens = readTokens('`prefix ${first, second} suffix`, last');
  const close = tokens.indexOf(tokens[0].endToken);
  assert.throws(() => readCommaSeparated(tokens.slice(0, close), 0, close), SourceReadError);
  assert.throws(() => readCommaSeparated(tokens, 0, close), SourceReadError);
});
