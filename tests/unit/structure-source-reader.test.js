import assert from "node:assert/strict";
import { test } from "node:test";
import { SourceModule, SourceReadError, SourceOriginUsage, SourceToken, readMemberAccess, readTokens } from "../support/structure/source-reader.js";
import * as sourceReader from "../support/structure/source-reader.js";

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

test("explicit origin binding acceptance retains private-field and chained alias provenance", () => {
  const declaration = new SourceModule("writer.js", `class Writer {
    #capability;
    constructor(capability) { this.#capability = capability; }
    settle() { const first = this.#capability; const alias = first; return alias; }
  }`).declaration("Writer");
  const automatic = new SourceOriginUsage(declaration, ["#capability"]);
  const explicit = new SourceOriginUsage(declaration, ["#capability"], { acceptBindings: false });
  assert.deepEqual(explicit.origins, new Set(["#capability", "capability", "first", "alias"]));
  assert.deepEqual(explicit.origins, automatic.origins);
  assert.deepEqual(automatic.unresolved().map((token) => token.value), ["alias"]);
  assert.deepEqual(explicit.unresolved().map((token) => token.value), [
    "#capability", "capability", "#capability", "capability", "first", "#capability", "alias", "first", "alias",
  ]);
  const returnedAlias = declaration.tokens[declaration.tokens.findIndex((token) => token.value === "return") + 1];
  explicit.accept([returnedAlias]);
  assert.deepEqual(explicit.unresolved().map((token) => token.value), [
    "#capability", "capability", "#capability", "capability", "first", "#capability", "alias", "first",
  ]);
});

test("explicit origin binding acceptance leaves destructured parameter bindings unchecked", () => {
  const declaration = new SourceModule("consumer.js", "function consume({ capability }) { return capability; }")
    .declaration("consume");
  const automatic = new SourceOriginUsage(declaration, ["capability"]);
  const explicit = new SourceOriginUsage(declaration, ["capability"], { acceptBindings: false });
  assert.deepEqual(automatic.unresolved().map((token) => token.value), ["capability"]);
  assert.deepEqual(explicit.unresolved().map((token) => token.value), ["capability", "capability"]);
});

test("explicit origin binding acceptance is forwarded by the module reader", () => {
  const module = new SourceModule("consumer.js", `function consume(selection) { return selection; }
    const alias = consume; alias = replacement;`);
  const automatic = module.originUsage(["consume"]);
  const explicit = module.originUsage(["consume"], { acceptBindings: false });
  assert.deepEqual(explicit.origins, new Set(["consume", "alias"]));
  assert.deepEqual(automatic.unresolved().map((token) => token.value), ["consume", "alias"]);
  assert.deepEqual(explicit.unresolved().map((token) => token.value), ["consume", "alias", "consume", "alias"]);
  explicit.accept(module.declaration("consume").tokens);
  assert.deepEqual(explicit.unresolved().map((token) => token.value), ["alias", "consume", "alias"]);
});

test("module binding origin accounting distinguishes lexical identity while preserving default behavior", () => {
  const module = new SourceModule("capability.js", [
    "const capability = {};",
    "const metadata = { capability: 'label' };",
    "function independent(capability) { return capability; }",
    "function capture() { return capability; }",
    "const alias = capability;",
    "function independentAlias(alias) { return alias; }",
    "external(alias);",
  ].join("\n"));
  const references = (usage) => usage.unresolved().map((token) => [token.value, token.line]);
  const scoped = module.originUsage(["capability"], { acceptBindings: false, moduleBindings: true });
  assert.deepEqual(scoped.origins, new Set(["capability", "alias"]));
  assert.deepEqual(references(scoped), [["capability", 1], ["capability", 4], ["alias", 5], ["capability", 5], ["alias", 7]]);
  assert.deepEqual(references(module.originUsage(["capability"], { acceptBindings: false })), [
    ["capability", 1], ["capability", 2], ["capability", 3], ["capability", 3], ["capability", 4],
    ["alias", 5], ["capability", 5], ["alias", 6], ["alias", 6], ["alias", 7],
  ]);
  assert.deepEqual(references(module.originUsage(["capability"])), [
    ["capability", 1], ["capability", 2], ["capability", 3], ["capability", 4], ["alias", 6], ["alias", 6], ["alias", 7],
  ]);
});

test("declared route reader distinguishes complete function shapes and declaration prefixes", () => {
  for (const [prefix, tokens, exported, defaultExport, matches] of [
    ["", [], false, false, true],
    ["export", ["export"], true, false, true],
    ["export default", ["export", "default"], true, true, true],
    ["async", ["async"], false, false, false],
    ["export async", ["export", "async"], true, false, false],
  ]) {
    const declaration = new SourceModule("route.js", `${prefix} function route(input) { return input; }`).declaration("route");
    assert.deepEqual(declaration.prefix.map((token) => token.value), tokens);
    assert.equal(declaration.exported, exported);
    assert.equal(declaration.defaultExport, defaultExport);
    assert.equal(declaration.matchesFunction("input", "return input;"), matches);
    assert.equal(declaration.matchesBody("return input;"), true);
  }
  for (const parameters of ["input = external()", "input, extra"]) {
    const declaration = new SourceModule("route.js", `function route(${parameters}) { return input; }`).declaration("route");
    assert.equal(declaration.matchesFunction("input", "return input;"), false);
    assert.equal(declaration.matchesBody("return input;"), true);
  }
  assert.equal(new SourceModule("route.js", "function* route(input) { return input; }").declaration("route"), null);
});

test("declared route reader keeps local export tokens distinct from aliases and reexports", () => {
  const module = new SourceModule("exports.js", [
    "const first = 1; const second = 2;",
    "export { first, second as renamed };",
    "export { Remote as Forwarded } from './remote.js';",
  ].join("\n"));
  for (const entry of module.exports) assert.equal(entry.token instanceof SourceToken, true);
  assert.deepEqual(module.exports.map((entry) => [entry.name, entry.local, entry.token.value,
    entry.token.line, entry.token.column, entry.reference?.specifier ?? null]), [
    ["first", "first", "first", 2, 10, null],
    ["renamed", "second", "second", 2, 17, null],
    ["Forwarded", "Remote", "Remote", 3, 10, "./remote.js"],
  ]);
  const usage = module.originUsage(["Remote"], { acceptBindings: false, moduleBindings: true });
  assert.deepEqual(usage.unresolved(), []);
});

test("reaudit reader identifies binding assignments and updates without treating RHS reads as writes", () => {
  const module = new SourceModule("writes.js", [
    "let observed = 1; let replacement = 2;",
    "observed = -replacement;",
    "observed += +replacement;",
    "observed **= replacement;",
    "observed ??= replacement;",
    "++observed; observed--;",
    "const read = observed === replacement;",
  ].join("\n"));
  const writes = module.bindingWrites(["observed", "replacement"]);
  assert.equal(writes.every((write) => write instanceof sourceReader.SourceBindingWrite), true);
  assert.deepEqual(writes.map((write) => [write.binding.name, write.token.line, write.token.column]), [
    ["observed", 2, 1], ["observed", 3, 1], ["observed", 4, 1], ["observed", 5, 1],
    ["observed", 6, 3], ["observed", 6, 13],
  ]);
  assert.deepEqual(module.bindingWrites(["replacement", "missing"]), []);
});

test("reaudit reader resolves pattern and loop writes by lexical identity and preserves its cached index", () => {
  const module = new SourceModule("patterns.js", [
    "let observed; let rest; let object = {};",
    "({ nested: { value: observed = fallback }, ...rest } = source);",
    "[observed, ...rest] = source;",
    "for (observed of source) {}",
    "for ({ value: observed } of source) {}",
    "for (rest in source) {}",
    "object.observed = 1; object[observed] = 2; observed.value = 3;",
    "function independent(observed) { observed = 4; ++observed; }",
    "{ let rest; rest = 5; }",
    "for (let observed of source) { observed = 6; }",
  ].join("\n"));
  const writes = module.bindingWrites(["observed", "rest", "object"]);
  assert.deepEqual(writes.map((write) => [write.binding.name, write.token.line, write.token.column]), [
    ["observed", 2, 21], ["rest", 2, 47], ["observed", 3, 2], ["rest", 3, 15],
    ["observed", 4, 6], ["observed", 5, 15], ["rest", 6, 6],
  ]);
  const firstBinding = writes[0].binding;
  module.originUsage(["observed"], { acceptBindings: false, moduleBindings: true });
  assert.equal(module.bindingWrites(["observed"])[0], writes[0]);
  assert.equal(module.bindingWrites(["observed"]).every((write) => write.binding === firstBinding), true);
  assert.deepEqual(module.globals, []);
});

test("reaudit reader exposes inline public bindings without changing lexical-only reference parsing", () => {
  const module = new SourceModule("exports.js", [
    "export function lookup(input) { return input; }",
    "export const selection = 1;",
    "export class Value {}",
  ].join("\n"));
  assert.deepEqual(module.exports.map((entry) => [entry.name, entry.local, entry.token.value,
    entry.token.line, entry.token.column, entry.reference]), [
    ["lookup", "lookup", "lookup", 1, 17, null],
    ["selection", "selection", "selection", 2, 14, null],
    ["Value", "Value", "Value", 3, 14, null],
  ]);
  const indexed = new SourceModule("outside.js", "var outside = 1; export const value = outside; export * from './values.js';", { lexicalOnly: true });
  assert.deepEqual(indexed.references.map((reference) => reference.specifier), ["./values.js"]);
});
