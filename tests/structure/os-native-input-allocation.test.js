import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

// An earlier opaque-native refusal does not replace inspection of a later consumer.
const cases = [
  [
    "import fs from 'node:fs';opaque(fs);function make(input){return new WeakMap();}const map=make(fs);const key={};map.set(key,fs.readFileSync);opaque(map.get(key));",
    "OS02",
    141
  ],
  [
    "import fs from 'node:fs';opaque(process.env);function make(input){return {file:'ordinary'};}const holder=make(process.env);holder.file='/proc/self/stat';fs.readFileSync(holder.file);",
    "OS01",
    154
  ],
  [
    "import fs from 'node:fs';opaque(process.env);function make(input){return new WeakMap();}const map=make(process.env);const key={};map.set(key,fs.readFileSync);opaque(map.get(key));",
    "OS02",
    159
  ],
  [
    "import fs from 'node:fs';opaque(process.env);class Factory{make(input){return new WeakMap();}}const factory=new Factory();const map=factory.make(process.env);const key={};map.set(key,fs.readFileSync);opaque(map.get(key));",
    "OS02",
    201
  ],
  [
    "import fs from 'node:fs';opaque(process.env);function make(input){return new WeakMap();}const first=make(process.env);const second=make(process.env);const key={};first.set(key,fs.readFileSync);opaque(second.get(key));",
    null,
    0
  ],
  [
    "import fs from 'node:fs';opaque(process.env);function make(input){return new WeakMap();}const map=make(process.env);const key={};map.set(key,'ordinary');opaque(map.get(key));",
    null,
    0
  ],
  [
    "import fs from 'node:fs';opaque(process.env);function make(input){return new WeakMap();}const map=make(process.env);const key={};map.set(key,fs.readFileSync);process.env.X='changed';opaque(map.get(key));",
    "OS02",
    183
  ],
  [
    "import fs from 'node:fs';opaque(process.env);function make(input){return new WeakMap();}const map=make(process.env);const key={};map.set(key,fs.readFileSync);Math.abs=foreign;opaque(map.get(key));",
    "OS02",
    176
  ],
  [
    "import fs from 'node:fs';function make(input){return new WeakMap();}const map=make(process.env);const key={};map.set(key,fs.readFileSync);process.env.X='changed';opaque(map.get(key));",
    "OS02",
    163
  ],
  [
    "import fs from 'node:fs';function make(input){return new WeakMap();}const map=make(process.env);const key={};map.set(key,fs.readFileSync);opaque(process.env);opaque(map.get(key));",
    "OS02",
    159
  ]
];
for (const [source, rule, column] of cases) {
  test(`native-origin allocation survives reinspection and mutation: ${source}`, () => {
    const file = "src/native-call-input.mjs";
    const report = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] }).check();
    assert.deepEqual(report.diagnostics.filter(entry => entry.rule === "OS00"), [], report.diagnostics.join("\n"));
    assert.equal(report.ok, false, "the original mutation/opaque rejection remains mandatory");
    if (rule !== null) assert.equal(report.diagnostics.some(entry => entry.file === file && entry.rule === rule
      && entry.line === 1 && entry.column === column && entry.classification === "incomplete"), true,
      `expected ${rule} at actual consumer 1:${column}\n${report.diagnostics.join("\n")}`);
    else assert.deepEqual(report.diagnostics.map(entry => [entry.rule, entry.line, entry.column]), [["OS01", 1, 26]],
      "a different allocation or ordinary payload must not acquire the sensitive write");
  });
}

function inputContexts() {
  const file = "src/native-input-identity.mjs";
  const source = "import fs from 'node:fs';import other from 'node:os';function make(input){return {};}const quoted=fs['a.b'];const nested=fs.a.b;const foreign=other['a.b'];make(quoted);";
  const checker = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), {files: [file]});
  const module = checker.graph.module(file, {lexicalOnly: true});
  const origins = checker.rules.origins;
  const environment = new Map();
  const callable = origins.value(module, module.declaration("make").tokens, environment);
  const token = module.tokens.filter(token => token.value === "make").at(-1);
  // Exercise the existing member API directly: the expression reader currently
  // refuses dotted computed names before this input-domain boundary is reached.
  const value = name => {
    const native = origins.identifier(module, module.tokens.find(token => token.value === (name === "foreign" ? "other" : "fs")), environment);
    if (name === "nested") return origins.member(origins.member(native, "a", token, module, environment), "b", token, module, environment);
    return origins.member(native, "a.b", token, module, environment);
  };
  const context = input => origins.callInvocations.environment(callable, [input], null, token, environment, origins);
  return {origins, value, context};
}
test("native input member components remain distinct even when their display identities coincide", () => {
  const {value, context} = inputContexts();
  const quoted = value("quoted"), nested = value("nested");
  assert.equal(quoted.identity, nested.identity, "the fixture exposes the display-string collision");
  assert.notEqual(context(quoted), context(nested));
  assert.notEqual(context(quoted), context(value("foreign")), "different native roots remain distinct");
});
test("native input reinspection keeps its allocation context across native mutation", () => {
  const {origins, value, context} = inputContexts();
  const before = context(value("quoted"));
  origins.nativeMutations.add(value("quoted"));
  assert.equal(context(value("quoted")), before);
  assert.equal(origins.nativeMutations.affects(value("quoted")), true, "context identity never restores native validity");
});
