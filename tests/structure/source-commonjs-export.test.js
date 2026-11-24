import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceCommonJsExport, SourceExport, SourceInitializer, SourceModule, SourceReadError, readTokens } from "../support/structure/source-reader.js";

test("named CommonJS assignments expose exact target, operator, value and export identities", () => {
  const module = new SourceModule("named.cjs", "const first = 1; const second = 2;\nexports.first = first;\nmodule.exports.second = (second);");
  assert.equal(module.commonJsExports.length, 2);
  const [first, second] = module.commonJsExports;
  assert.ok(first instanceof SourceCommonJsExport);
  assert.equal(first.file, "named.cjs");
  assert.ok(first.target instanceof SourceInitializer);
  assert.ok(first.value instanceof SourceInitializer);
  assert.equal(first.target.matches("exports.first"), true);
  assert.equal(second.target.matches("module.exports.second"), true);
  assert.equal(first.value.matches("first"), true);
  assert.equal(second.value.matches("(second)"), true);
  assert.deepEqual([first.target.token.value, second.target.token.value], ["exports", "module"]);
  assert.deepEqual([first.token.value, first.token.line, first.token.column], ["=", 2, 15]);
  assert.deepEqual(first.exports, [module.exports[0]]);
  assert.deepEqual(second.exports, [module.exports[1]]);
  assert.equal(first.exports[0].token, first.target.token);
  for (const assignment of module.commonJsExports) {
    assert.equal(module.tokens[assignment.target.index + assignment.target.tokens.length], assignment.token);
    assert.equal(module.tokens[assignment.value.index - 1], assignment.token);
    for (const span of [assignment.target, assignment.value]) {
      assert.deepEqual(module.tokens.slice(span.index, span.index + span.tokens.length), span.tokens);
    }
  }
});

test("default object export assignments retain the root even when export entries use property tokens", () => {
  const module = new SourceModule("object.cjs", "const original = 1; module.exports = ({ original, renamed: original });");
  const [assignment] = module.commonJsExports;
  assert.equal(assignment.target.matches("module.exports"), true);
  assert.equal(assignment.value.matches("({ original, renamed: original })"), true);
  assert.deepEqual(assignment.exports, module.exports);
  assert.deepEqual(assignment.exports.map(entry => [entry.name, entry.local, entry.token.value]),
    [["original", "original", "original"], ["renamed", "original", "renamed"]]);
  assert.equal(assignment.target.token.value, "module");
  assert.equal(assignment.exports.every(entry => entry instanceof SourceExport && entry.token !== assignment.target.token), true);
});

test("forwarding and empty object exports remain recognized assignments", () => {
  const forward = new SourceModule("forward.cjs", "module.exports = require('./other.cjs');");
  const [assignment] = forward.commonJsExports;
  assert.equal(assignment.value.matches("require('./other.cjs')"), true);
  assert.deepEqual(assignment.exports, forward.exports);
  assert.deepEqual(assignment.exports.map(entry => [entry.name, entry.local]), [["default", "*"], ["*", "*"]]);
  assert.equal(assignment.exports.every(entry => entry.reference === forward.references[0]), true);
  const empty = new SourceModule("empty.cjs", "module.exports = {};");
  assert.equal(empty.commonJsExports.length, 1);
  assert.deepEqual(empty.commonJsExports[0].exports, []);
  assert.equal(empty.commonJsExports[0].value.matches("{}"), true);
});

test("shadowed module and exports receivers are excluded by the existing lexical reader", () => {
  const module = new SourceModule("shadow.cjs", [
    "const local = 1;",
    "function first(module) { module.exports = local; }",
    "function second(exports) { exports.named = local; }",
    "function hoisted() { module.exports = local; const module = other; }",
    "exports.real = local;",
  ].join("\n"));
  assert.equal(module.commonJsExports.length, 1);
  assert.deepEqual(module.exports.map(entry => [entry.name, entry.local]), [["real", "local"]]);
  assert.equal(module.commonJsExports[0].target.matches("exports.real"), true);
  assert.equal(module.commonJsExports[0].target.token.line, 5);
  const local = new SourceModule("local.cjs", "const module = {}; const exports = {}; module.exports = value; exports.named = value;");
  assert.deepEqual(local.commonJsExports, []);
});

test("ES module exports do not enter the CommonJS assignment index", () => {
  const module = new SourceModule("esm.mjs", "export const value = 1; export { value as renamed };");
  assert.deepEqual(module.commonJsExports, []);
  assert.deepEqual(module.exports.map(entry => [entry.name, entry.local]), [["value", "value"], ["renamed", "value"]]);
});

test("unsupported CommonJS values keep the existing incomplete-read failure", () => {
  assert.throws(() => new SourceModule("unknown.cjs", "module.exports = factory();"), SourceReadError);
});

test("CommonJS assignment constructor rejects unrelated tokens, spans and export entries", () => {
  const module = new SourceModule("named.cjs", "const local = 1; exports.named = local;");
  const [assignment] = module.commonJsExports;
  assert.throws(() => new SourceCommonJsExport(module, assignment.target, readTokens("=")[0], assignment.value, assignment.exports), TypeError);
  assert.throws(() => new SourceCommonJsExport(module, assignment.value, assignment.token, assignment.value, assignment.exports), TypeError);
  assert.throws(() => new SourceCommonJsExport(module, assignment.target, assignment.token, assignment.value,
    [new SourceExport("named", "local", null, assignment.target.token)]), TypeError);
});
