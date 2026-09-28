import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceModule, SourceReadError } from "../support/structure/source-reader.js";

test("source reader distinguishes imports from comments, strings, regexes, and template text", () => {
  const module = new SourceModule("example.js", [
    "// import './comment.js'",
    "const quoted = \"import './string.js'\";",
    "const regexp = /import\\('regex'\\)/;",
    "const template = `import './raw.js' ${'safe'}`;",
    "import { Service as Alias } from './service.js';",
    "export { Value } from './value.js';",
    "if (ok) /import\\('control'\\)/.test(quoted);",
  ].join("\n"));
  assert.deepEqual(module.references.map((reference) => reference.specifier), ["./service.js", "./value.js"]);
  assert.equal(module.references[0].bindings.get("Alias"), "Service");
  assert.deepEqual([module.references[0].token.line, module.references[0].token.column], [5, 1]);
});

test("source reader finds dynamic imports in template interpolations and ignores import methods", () => {
  const module = new SourceModule("example.js", "const x = `${import('./unsafe.js')}`; const object = { import() { return 1; } };");
  assert.equal(module.dynamic.length, 1);
  assert.equal(module.references[0].specifier, "./unsafe.js");
});

test("source reader fails on unterminated lexical forms", () => {
  assert.throws(() => new SourceModule("example.js", "const x = 'missing;"), SourceReadError);
  assert.throws(() => new SourceModule("example.js", "const x = /missing;"), SourceReadError);
  assert.throws(() => new SourceModule("example.js", "const x = `missing ${1;"), SourceReadError);
});

test("source reader keeps nested dependencies out of the enclosing class", () => {
  const module = new SourceModule("example.js", "export class StepA { method() { class Nested { static dependencies = [Wrong]; } } static dependencies = [Right]; }");
  assert.deepEqual(module.classes.find((entry) => entry.name === "StepA").dependencies, ["Right"]);
});

test("source reader accepts an anonymous class expression with simple heritage", () => {
  const module = new SourceModule("example.js", "const Result = { chosen: class extends BaseResult { constructor() { super(); } } };\n");
  assert.equal(module.classes[0].name, null);
  assert.equal(module.classes[0].parent, "BaseResult");
});

test("lexical bindings shadow prohibited globals only within their own scope", () => {
  const module = new SourceModule("example.js", [
    "import { process as imported } from './values.js';",
    "export function Value(process) { return process(1); }",
    "const arrow = (fetch) => fetch(2);",
    "{ const globalThis = 3; void globalThis; }",
    "const named = function process() { return process(3); };",
    "process.cwd();",
    "fetch('/api');",
    "const namedClass = class process { method() { return process; } }; process.cwd();",
  ].join("\n"));
  assert.deepEqual(module.globals.map((token) => [token.value, token.line]), [["process", 6], ["fetch", 7], ["process", 8]]);
});

test("binding collection excludes initializer references", () => {
  const module = new SourceModule("example.js", "const value = process.pid, { local = fetch('/api') } = {}; process.cwd(); fetch('/api');\n");
  assert.deepEqual(module.globals.map((token) => token.value), ["process", "fetch", "process", "fetch"]);
  const computed = new SourceModule("example.js", "function value({ [process.pid]: local }) { return local; }\n");
  assert.deepEqual(computed.globals.map((token) => token.value), ["process"]);
});

test("scope analysis rejects var declarations instead of treating them as block bindings", () => {
  for (const source of [
    "if (true) { var Error = Base; } class Hidden extends Error {}",
    "function value() { if (true) { var process = local; } return process; }",
    "const value = () => { var { Error } = source; return Error; };",
    "for (var [Error] of source) {}",
  ]) {
    assert.throws(() => new SourceModule("example.js", source),
      (error) => error instanceof SourceReadError && error.message.includes("unsupported var declaration"));
  }
});

test("var rejection leaves block bindings and lexical reference indexing intact", () => {
  const module = new SourceModule("example.js", "{ let process = local; const fetch = local; } process.cwd(); fetch('/api'); const value = object.var[key]; const other = { var: 1 };\n");
  assert.deepEqual(module.globals.map((token) => token.value), ["process", "fetch"]);
  const indexed = new SourceModule("example.js", "var steps = import('./steps.js');", { lexicalOnly: true });
  assert.deepEqual(indexed.references.map((reference) => reference.specifier), ["./steps.js"]);
});

test("regex after a control block does not create a false global reference", () => {
  const module = new SourceModule("example.js", "if (true) {} /process/.test('text'); export const Value = 1;\n");
  assert.deepEqual(module.globals, []);
  assert.deepEqual(module.references, []);
  const indexed = new SourceModule("example.js", "if (true) {} /import\\('hidden'\\)/.test('text');", { lexicalOnly: true });
  assert.deepEqual(indexed.references, []);
});

test("division after an object or expression still exposes real globals", () => {
  const module = new SourceModule("example.js", "const value = {} / process.pid;\n");
  assert.deepEqual(module.globals.map((token) => token.value), ["process"]);
});
