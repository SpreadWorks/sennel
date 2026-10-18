import test from "node:test";
import assert from "node:assert/strict";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsAuditScope, AuditEntrypoint } from "../support/structure/os-audit-scope.js";

function repository(extra = [], manifest = {}) {
  return new MemorySourceRepository([
    ["package.json", JSON.stringify({ name: "fixture", bin: { fixture: "src/main.js" }, scripts: { test: "node tests/run.js", audit: "node scripts/audit.js" }, files: ["src/"], ...manifest })],
    ["src/main.js", "export const main = 1;"], ["scripts/audit.js", "export const audit = 1;"],
    ["tests/run.js", "export const runner = 1;"], ["tests/temporary-root.js", "export const root = 1;"],
    ["tests/support/helper.js", "export const helper = 1;"], ["tests/runner/selection.js", "export const selection = 1;"],
    ...extra,
  ]);
}

test("whole-source scope includes unreachable formats, manifest entrypoints, distribution and execution infrastructure", () => {
  const scope = new OsAuditScope(repository([
    ["src/unreachable/module.mjs", "export default 1;"], ["src/unreachable/other.cjs", "module.exports = 1;"],
    ["tools/additional.cjs", "module.exports = 1;"], ["shipping/extra.mjs", "export default 1;"],
    ["src/skills/fixture/SKILL.md", "Run `node src/main.js`."],
    ["tests/unit/negative.test.js", "const badSource = 'process.platform';"],
  ], { bin: { fixture: "src/main.js", extra: "tools/additional.cjs" }, files: ["src/", "shipping/", "!src/presets/*/tests/"] })).discover();
  assert.deepEqual(scope.diagnostics, []);
  assert.deepEqual(scope.files, ["scripts/audit.js", "shipping/extra.mjs", "src/main.js", "src/unreachable/module.mjs", "src/unreachable/other.cjs", "tests/run.js", "tests/runner/selection.js", "tests/support/helper.js", "tests/temporary-root.js", "tools/additional.cjs"]);
  assert.deepEqual(scope.resources, ["src/skills/fixture/SKILL.md"]);
  assert.ok(scope.entrypoints.every((entry) => entry instanceof AuditEntrypoint));
  assert.equal(scope.entrypoints.find((entry) => entry.name === "extra").file, "tools/additional.cjs");
  assert.equal(scope.coverage.distribution.find((entry) => entry.excluded).directory, "src/presets");
});

test("test-root helpers stay in scope while suite contents remain outside it", () => {
  const scope = new OsAuditScope(repository([
    ["tests/CLAUDE.md", "runner instructions"],
    ["tests/unit/fixture.js", "process.platform"],
    ["tests/unit/CLAUDE.md", "suite instructions"],
  ])).discover();

  assert.ok(scope.files.includes("tests/run.js"));
  assert.ok(scope.files.includes("tests/temporary-root.js"));
  assert.ok(scope.resources.includes("tests/CLAUDE.md"));
  assert.equal(scope.files.some((file) => file.startsWith("tests/unit/")), false);
  assert.equal(scope.resources.some((file) => file.startsWith("tests/unit/")), false);
  assert.deepEqual(scope.diagnostics, []);
});

test("unknown implementation formats at the tests root remain classified", () => {
  const scope = new OsAuditScope(repository([["tests/extra.ts", "export const value: number = 1;"]])).discover();

  assert.ok(scope.diagnostics.some((entry) => entry.file === "tests/extra.ts" && entry.message.includes("unsupported implementation format")));
});

test("manifest executable declarations and unhandled implementation forms fail incomplete", () => {
  for (const [manifest, extra, expected] of [
    [{ scripts: { unsafe: "bash scripts/audit.js" } }, [], "unsupported executable"],
    [{ bin: { outside: "../outside.js" } }, [], "escapes repository"],
    [{ bin: { missing: "src/missing.js" } }, [], "regular source file"],
    [{ files: ["*.js"] }, [], "auditable directory"],
    [{}, [["src/hidden.ts", "export const value = 1;"]], "unsupported implementation"],
  ]) {
    const scope = new OsAuditScope(repository(extra, manifest)).discover();
    assert.ok(scope.diagnostics.some((entry) => entry.message.includes(expected)), expected);
    assert.ok(scope.diagnostics.every((entry) => entry.rule === "OS00" && entry.classification === "incomplete"));
  }
});

test("discovery failures and empty scope cannot disappear into successful source coverage", () => {
  const source = repository();
  const failing = { read: (file) => source.read(file), inventory: (directory) => {
    if (directory === "src") throw new Error("unreadable source directory");
    return source.inventory(directory);
  } };
  const scope = new OsAuditScope(failing).discover();
  assert.ok(scope.diagnostics.some((entry) => entry.file === "src" && entry.message.includes("unreadable")));
  assert.ok(scope.diagnostics.some((entry) => entry.file === "src" && entry.message.includes("empty")));
  const empty = new OsAuditScope(new MemorySourceRepository([])).discover();
  assert.ok(empty.diagnostics.some((entry) => entry.message === "audit has no implementation files"));
  assert.ok(empty.diagnostics.some((entry) => entry.file === "package.json"));
});
