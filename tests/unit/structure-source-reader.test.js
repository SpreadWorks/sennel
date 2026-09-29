import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceModule, SourceReadError, SourceOriginUsage, readMemberAccess, readTokens } from "../support/structure/source-reader.js";

test("route initializers must be unconditional declarations in the enclosing function", () => {
  const direct = new SourceModule("route.js", "function route(input = {}) { const registration = lookup(input.stepId); return registration; }");
  assert.equal(direct.declaration("route").topLevelInitializer("registration")
    .matches("lookup( input.stepId )"), true);
  const guarded = new SourceModule("route.js", "function route(input) { if (input.allowed) { const registration = lookup(input.stepId); return registration; } }");
  assert.equal(guarded.declaration("route").topLevelInitializer("registration"), null);
});

test("closed route matching distinguishes identifiers from equal literal text", () => {
  const module = new SourceModule("route.js", "function route(target) { const registration = target.scope; return registration; }");
  const declaration = module.declaration("route");
  const initializer = declaration.topLevelInitializer("registration");
  assert.equal(initializer.matches("target.scope"), true);
  assert.equal(initializer.matches('"target".scope'), false);
  assert.equal(declaration.matchesBody("const registration = target.scope; return registration;"), true);
  assert.equal(declaration.matchesBody('const registration = "target".scope; return registration;'), false);
});

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

test("route prose placeholders accept only string literals and preserve surrounding contracts", () => {
  const pattern = 'new Directive({ actionId: "CLAIM", instruction: $STRING_LITERAL })';
  for (const [expression, expected] of [
    ['new Directive({ actionId: "CLAIM", instruction: "Updated wording" })', true],
    ['new Directive({ actionId: "OTHER", instruction: "Updated wording" })', false],
    ['new Directive({ actionId: "CLAIM", instruction: bypass() })', false],
    ['new Directive({ actionId: "CLAIM", instruction: message })', false],
  ]) {
    const declaration = new SourceModule("route.js", `function route() { const result = ${expression}; }`).declaration("route");
    assert.equal(declaration.topLevelInitializer("result").matches(pattern), expected);
    assert.equal(declaration.containsBodySequence(`const result = ${pattern};`), expected);
  }
});

test("member extraction normalizes access and call syntax without granting permission", () => {
  for (const source of [
    'manager.save({})', 'manager?.save({})', 'manager.save?.({})',
    'manager?.save?.({})', 'return ((manager))?.save({})',
    'return (this.manager).save({})', 'return (this?.manager)?.save({})',
  ]) {
    const tokens = readTokens(source);
    const access = readMemberAccess(tokens, tokens.findIndex((token) => token.value === "manager"));
    assert.equal(access.name, "save", source);
    assert.equal(access.isCallTo(new Set(["save"])), true, source);
    assert.equal(access.isCallTo(new Set(["other"])), false, source);
  }
  for (const source of ['manager["save"]({})', 'manager?.[key]({})', 'manager()',
    'manager.save', 'manager?.save.call(null)', 'manager.save = other']) {
    const tokens = readTokens(source);
    const access = readMemberAccess(tokens, 0);
    assert.notEqual(access, null, source);
    assert.equal(access.isCallTo(new Set(["save"])), false, source);
  }
  for (const source of ['helper(manager).receipt', 'const alias = manager;', 'manager;']) {
    const tokens = readTokens(source);
    assert.equal(readMemberAccess(tokens, tokens.findIndex((token) => token.value === "manager")), null, source);
  }
});

test("origin accounting leaves escapes unclassified after tracking private and local bindings", () => {
  const declaration = new SourceModule("writer.js", `class Writer {
    #manager;
    constructor(manager) { this.#manager = manager; }
    settle() { const alias = this.#manager; return alias; }
  }`).declaration("Writer");
  const usage = new SourceOriginUsage(declaration, ["#manager"]);
  assert.deepEqual(usage.unresolved().map((token) => token.value), ["alias"]);
});

test("origin accounting never treats destructuring, captures, or defaults as checked transfers", () => {
  for (const body of [
    'const { operation } = manager;',
    'const box = { manager };',
    'const alias = (manager);',
    'let alias; alias = manager;',
  ]) {
    const declaration = new SourceModule("writer.js", `function settle(manager) { ${body} }`).declaration("settle");
    assert.equal(new SourceOriginUsage(declaration, ["manager"]).unresolved().length, 1, body);
  }
  const declaration = new SourceModule("writer.js", 'function settle(value = manager) {}').declaration("settle");
  assert.deepEqual(new SourceOriginUsage(declaration, ["manager"]).unresolved().map((token) => token.value), ["manager"]);
});
