import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const file = "src/default-environment.mjs";
function fixture(source = "import fs from 'node:fs';function make(input='ordinary'){fs.readFileSync('ordinary');return input;}") {
  const checker = new OsIndependenceChecker(new MemorySourceRepository([[file, source]]), { files: [file] });
  const module = checker.graph.module(file, { lexicalOnly: true });
  const origins = checker.rules.origins, caller = new Map();
  const callable = origins.value(module, module.declaration("make").tokens, caller);
  const args = callable.effects.parameters.values;
  const local = origins.callInvocations.environment(callable, args, null, callable.declaration.token, caller, origins);
  return { checker, module, origins, callable, args, local,
    invoke: () => origins.invoke(callable, args, callable.declaration.token, module, caller) };
}

test("equivalent defaults retain environment revision while current wrappers, origins and actual effects refresh", () => {
  const f = fixture();
  let reads = 0;
  const original = f.origins.onCall;
  f.origins.onCall = function(callee, ...rest) {
    if (callee.builtin === "fs" && callee.member === "readFileSync") reads++;
    return original.call(this, callee, ...rest);
  };
  let previous = null, revision = null, effects = null;
  const marker = f.callable.effects.parameters.values[0];
  for (let repeat = 0; repeat < 8; repeat++) {
    f.local.rememberOrigin("probe", "ordinary", marker);
    const before = reads, result = f.invoke();
    assert.equal(result.constructor.name, "SourceDefaultValue");
    assert.notEqual(result, previous, "the new wrapper must replace the preceding interpretation");
    assert.equal([...f.local.values()].includes(result), true, "the current formal binding retains the new wrapper");
    assert.equal(f.local.readOrigin("probe", "ordinary"), null, "local origin observations are cleared even for equivalent values");
    assert.ok(reads > before, "actual source I/O is interpreted on every call");
    effects ??= reads - before;
    assert.equal(reads - before, effects);
    revision ??= f.local.revision;
    assert.equal(f.local.revision, revision, "equivalent default input must not invalidate an unchanged environment");
    previous = result;
  }
  assert.deepEqual(f.checker.report.diagnostics, []);
});

for (const variation of ["supplied trace", "fallback trace", "fallback value", "defined", "formal identity", "heap identity", "opaque identity"]) {
  test(`different default dependency invalidates the environment: ${variation}`, () => {
    const f = fixture("function make(input='ordinary',other){return input;}function object(){return {};}function opaque(){return foreign();}");
    const value = f.invoke(), Default = value.constructor;
    const [supplied, fallback] = value.origin.values;
    let next;
    if (variation === "supplied trace") {
      const unknown = f.origins.identifier(f.module, f.module.tokens.find(token => token.value === "foreign"), new Map());
      f.local.set("probe", new Default(unknown, fallback));
      next = new Default(new unknown.constructor(unknown.reason, unknown.isSensitive, ["different source"]), fallback);
    }
    if (variation === "fallback trace") next = new Default(supplied, new fallback.constructor(fallback.value, ["different source"]));
    if (variation === "fallback value") next = new Default(supplied, new fallback.constructor("different", fallback.trace));
    if (variation === "defined") next = new Default(supplied, new fallback.constructor(undefined, fallback.trace));
    if (variation === "formal identity") next = new Default(f.args[1], fallback);
    if (variation === "heap identity" || variation === "opaque identity") {
      const name = variation === "heap identity" ? "object" : "opaque";
      const callable = f.origins.value(f.module, f.module.declaration(name).tokens, new Map());
      const left = f.origins.invoke(callable, [], callable.declaration.token, f.module, new Map());
      const right = f.origins.invoke(callable, [], callable.declaration.token, f.module, new Map());
      f.local.set("probe", new Default(left, fallback));
      next = new Default(right, fallback);
    } else if (variation !== "supplied trace") f.local.set("probe", value);
    const revision = f.local.revision;
    f.local.rememberOrigin("probe", "ordinary", value);
    f.local.set("probe", next);
    assert.equal(f.local.revision, revision + 1);
    assert.equal(f.local.get("probe"), next);
    assert.equal(f.local.readOrigin("probe", "ordinary"), null);
  });
}

for (const mutation of ["heap", "native"]) {
  test(`stable default environment still invalidates effects after ${mutation} changes`, () => {
    const source = "import fs from 'node:fs';const holder={file:'ordinary'};function make(input='ordinary'){return ()=>fs.readFileSync(holder.file);}function mutate(){holder.file='/proc/self/stat';}";
    const f = fixture(source), child = f.invoke();
    f.origins.invoke(child, [], child.declaration.token, f.module, f.local);
    assert.deepEqual(f.checker.report.diagnostics, [], "the unchanged source uses an ordinary path");
    child.effects.resolve();
    assert.equal(child.effects.current, true);
    const revision = f.local.revision;
    if (mutation === "heap") {
      const callable = f.origins.value(f.module, f.module.declaration("mutate").tokens, f.callable.environment);
      f.origins.invoke(callable, [], callable.declaration.token, f.module, f.callable.environment);
    } else {
      const token = f.module.tokens.find(token => token.value === "fs");
      const fs = f.origins.identifier(f.module, token, f.callable.environment);
      f.origins.nativeMutations.add(f.origins.member(fs, "readFileSync", token, f.module, f.callable.environment));
    }
    assert.equal(f.local.revision, revision, "the dependency changes independently of the formal environment");
    assert.equal(child.effects.current, false, "existing heap/native invalidation must withdraw the old effect summary");
    child.effects.resolve();
    assert.equal(child.effects.current, true);
    f.origins.invoke(child, [], child.declaration.token, f.module, f.local);
    const column = source.indexOf("fs.readFileSync") + 1;
    assert.equal(f.checker.report.diagnostics.some(entry => entry.file === file && entry.line === 1 && entry.column === column
      && entry.rule === (mutation === "heap" ? "OS01" : "OS02") && entry.classification === "incomplete"), true,
      f.checker.report.diagnostics.map(String).join("\n"));
  });
}
