import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { SourceRepository, MemorySourceRepository, SourceRepositoryError } from "../support/structure/source-repository.js";
import { OsAuditScope } from "../support/structure/os-audit-scope.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-source-repository-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "src", "directory"), { recursive: true });
  const files = new Map([
    ["src/main.js", "import './module.mjs';"],
    ["src/module.mjs", "import './common.cjs';"],
    ["src/common.cjs", "require('./main.js');"],
    ["src/helper.js", "export const value = 1;"],
    ["src/directory/index.js", "module.exports = 1;"],
    ["src/readme.md", "resource"],
  ]);
  for (const [name, source] of files) fs.writeFileSync(path.join(root, name), source);
  return { root, files };
}

function failure(code) { return (error) => error instanceof SourceRepositoryError && error.code === code; }

function auditFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-source-audit-scope-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ["src", "scripts", "tests/support", "tests/runner", "tests/unit"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  const files = new Map([
    ["package.json", JSON.stringify({ name: "fixture", bin: "src/main.js", scripts: { test: "node tests/run.js" }, files: ["src/"] })],
    ["src/main.js", "export {};"], ["scripts/audit.js", "export {};"],
    ["tests/run.js", "export {};"], ["tests/support/helper.js", "export {};"],
    ["tests/runner/selection.js", "export {};"], ["tests/unit/CLAUDE.md", "metadata"],
  ]);
  for (const [name, content] of files) {
    const destination = path.join(root, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, content);
  }
  return { root, files };
}

test("filesystem and memory enumerate every implementation format and retain resources in inventory", (t) => {
  const { root, files } = fixture(t);
  for (const repository of [new SourceRepository(root), new MemorySourceRepository(files)]) {
    assert.deepEqual(repository.inventory("src"), [...files.keys()].sort());
    assert.deepEqual(repository.list("src", { strict: true }), [...files.keys()].filter((file) => !file.endsWith(".md")).sort());
    assert.equal(repository.resolve("src/main.js", "./module.mjs"), "src/module.mjs");
    assert.equal(repository.resolve("src/module.mjs", "./common.cjs"), "src/common.cjs");
    assert.equal(repository.resolve("src/common.cjs", "./helper", { kind: "require" }), "src/helper.js");
    assert.equal(repository.resolve("src/common.cjs", "./directory", { kind: "require" }), "src/directory/index.js");
    assert.throws(() => repository.resolve("src/main.js", "./helper"), failure("UNSUPPORTED_SOURCE"));
    assert.throws(() => repository.resolve("src/main.js", "./missing.js"), failure("MISSING_SOURCE"));
    assert.deepEqual(repository.list("missing"), []);
    assert.throws(() => repository.inventory("missing"), failure("MISSING_SOURCE"));
    assert.throws(() => repository.inventory("../outside"), failure("ROOT_ESCAPE"));
    assert.throws(() => repository.read("../outside.js"), failure("ROOT_ESCAPE"));
    assert.throws(() => repository.resolve("src/main.js", "../../outside.js"), failure("ROOT_ESCAPE"));
  }
});

test("unsupported implementation entries are rejected by strict discovery with recovery after removal", (t) => {
  const { root, files } = fixture(t);
  const source = path.join(root, "src", "unsupported.ts");
  fs.writeFileSync(source, "export const value: number = 1;");
  files.set("src/unsupported.ts", "export const value: number = 1;");
  for (const repository of [new SourceRepository(root), new MemorySourceRepository(files)]) {
    assert.throws(() => repository.list("src", { strict: true }), failure("UNSUPPORTED_SOURCE"));
    assert.ok(repository.inventory("src").includes("src/unsupported.ts"));
  }
  fs.unlinkSync(source); files.delete("src/unsupported.ts");
  assert.equal(new SourceRepository(root).list("src", { strict: true }).length, 5);
  assert.equal(new MemorySourceRepository(files).list("src", { strict: true }).length, 5);
});

test("directory links and traversal cycles are rejected through the same strict entry boundary", (t) => {
  const { root } = fixture(t);
  const link = path.join(root, "src", "loop");
  fs.symlinkSync(path.join(root, "src"), link, "junction");
  const repository = new SourceRepository(root);
  assert.throws(() => repository.inventory("src"), failure("SYMLINK_SOURCE"));
  assert.throws(() => repository.read("src/loop/main.js"), failure("SYMLINK_SOURCE"));
  assert.throws(() => repository.resolve("src/main.js", "./loop/main.js"), failure("SYMLINK_SOURCE"));
  fs.unlinkSync(link);
  assert.equal(repository.list("src", { strict: true }).length, 5);
});

test("portable filesystem failure injection preserves unreadable, special-entry, and cycle errors", (t) => {
  const { root } = fixture(t);
  const denied = new Error("fixture read denied"); denied.code = "EACCES";
  const unreadable = new SourceRepository(root, { filesystem: { ...fs, readFileSync() { throw denied; } } });
  assert.throws(() => unreadable.read("src/main.js"), (error) => failure("UNREADABLE_SOURCE")(error) && error.cause === denied);
  const unreadableDirectory = new SourceRepository(root, { filesystem: { ...fs, readdirSync() { throw denied; } } });
  assert.throws(() => unreadableDirectory.inventory("src"), failure("UNREADABLE_SOURCE"));
  const special = new SourceRepository(root, { filesystem: { ...fs, lstatSync(file) {
    return file === path.join(root, "src", "main.js")
      ? { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false }
      : fs.lstatSync(file);
  } } });
  assert.throws(() => special.inventory("src"), failure("SPECIAL_SOURCE"));
  const cycle = new SourceRepository(root, { filesystem: { ...fs, realpathSync(file) {
    return file === path.join(root, "src", "directory") ? path.join(root, "src") : fs.realpathSync(file);
  } } });
  assert.throws(() => cycle.inventory("src"), failure("SOURCE_CYCLE"));
  assert.equal(new SourceRepository(root).read("src/main.js"), "import './module.mjs';");
});

test("audit shallowly classifies test-root entries without inspecting suite contents", (t) => {
  const { root } = auditFixture(t);
  const metadata = path.join(root, "tests", "unit", "CLAUDE.md");
  const linkStat = { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
  const filesystem = { ...fs, lstatSync(file) { return file === metadata ? linkStat : fs.lstatSync(file); } };
  const repository = new SourceRepository(root, { filesystem });
  const shallowErrors = [];
  assert.deepEqual(repository.inventory("tests", { maxDepth: 1, onError: (error) => shallowErrors.push(error) }), ["tests/run.js"]);
  assert.deepEqual(shallowErrors, []);
  assert.throws(() => repository.inventory("tests"), failure("SYMLINK_SOURCE"));
  const scope = new OsAuditScope(repository).discover();

  assert.deepEqual(scope.diagnostics, []);
  assert.ok(scope.files.includes("tests/run.js"));
  assert.equal(scope.files.some((file) => file.startsWith("tests/unit/")), false);
  assert.equal(scope.resources.some((file) => file.startsWith("tests/unit/")), false);
});

test("audit still rejects an immediate test-root directory link that could hide code", (t) => {
  const { root } = auditFixture(t);
  const suite = path.join(root, "tests", "unit");
  const linkStat = { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
  const filesystem = { ...fs, lstatSync(file) { return file === suite ? linkStat : fs.lstatSync(file); } };
  const scope = new OsAuditScope(new SourceRepository(root, { filesystem })).discover();

  assert.ok(scope.diagnostics.some((entry) => entry.file === "tests/unit" && entry.classification === "incomplete"));
});

test("audit still rejects a test-root runner file link", (t) => {
  const { root } = auditFixture(t);
  const runner = path.join(root, "tests", "run.js");
  const linkStat = { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
  const filesystem = { ...fs, lstatSync(file) { return file === runner ? linkStat : fs.lstatSync(file); } };
  const scope = new OsAuditScope(new SourceRepository(root, { filesystem })).discover();

  assert.ok(scope.diagnostics.some((entry) => entry.file === "tests/run.js" && entry.classification === "incomplete"));
});

test("empty roots stay visible and CommonJS resolution never invents mjs or resource loading", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-source-empty-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const repository of [new SourceRepository(root), new MemorySourceRepository([])]) {
    assert.deepEqual(repository.inventory(), []);
    assert.deepEqual(repository.list(".", { strict: true }), []);
  }
  const sources = new Map([["src/helper.mjs", "export const value = 1;"], ["src/data.json", "{}"]]);
  fs.mkdirSync(path.join(root, "src"));
  for (const [file, content] of sources) fs.writeFileSync(path.join(root, file), content);
  for (const repository of [new SourceRepository(root), new MemorySourceRepository(sources)]) {
    assert.throws(() => repository.resolve("src/main.cjs", "./helper", { kind: "require" }), failure("MISSING_SOURCE"));
    assert.throws(() => repository.resolve("src/main.cjs", "./data", { kind: "require" }), failure("UNSUPPORTED_SOURCE"));
  }
});

test("strict discovery reports each failed entry while retaining readable sibling sources", (t) => {
  const { root, files } = fixture(t);
  fs.symlinkSync(path.join(root, "src"), path.join(root, "src", "loop"), "junction");
  const filesystem = { ...fs, lstatSync(file) {
    return file === path.join(root, "src", "main.js")
      ? { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => false }
      : fs.lstatSync(file);
  } };
  const repository = new SourceRepository(root, { filesystem });
  const errors = [];
  assert.deepEqual(repository.inventory("src", { onError: (error) => errors.push(error) }),
    [...files.keys()].filter((file) => file !== "src/main.js").sort());
  assert.deepEqual(errors.map((error) => [error.code, error.file]).sort(),
    [["SPECIAL_SOURCE", "src/main.js"], ["SYMLINK_SOURCE", "src/loop"]].sort());
  assert.throws(() => repository.inventory("src"), SourceRepositoryError);
  const rootErrors = [];
  assert.deepEqual(repository.inventory("../outside", { onError: (error) => rootErrors.push(error) }), []);
  assert.deepEqual(rootErrors.map((error) => error.code), ["ROOT_ESCAPE"]);
  const memoryErrors = [];
  const memory = new MemorySourceRepository([["src/valid.js", "export {};"], ["../invalid.js", ""]]);
  assert.deepEqual(memory.inventory("src", { onError: (error) => memoryErrors.push(error) }), ["src/valid.js"]);
  assert.deepEqual(memoryErrors.map((error) => error.code), ["ROOT_ESCAPE"]);
});

test("the default JavaScript index ignores proven asset-file links and rejects directory or source links", (t) => {
  const { root } = fixture(t);
  const linked = new Set([path.join(root, "src", "readme.md")]);
  const linkStat = { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
  const filesystem = { ...fs, lstatSync(file) { return linked.has(file) ? linkStat : fs.lstatSync(file); } };
  const repository = new SourceRepository(root, { filesystem });
  assert.equal(repository.list("src").length, 5);
  assert.throws(() => repository.inventory("src"), failure("SYMLINK_SOURCE"));
  const errors = [];
  assert.equal(repository.inventory("src", { onError: (error) => errors.push(error) }).length, 5);
  assert.deepEqual(errors.map((error) => [error.code, error.file]), [["SYMLINK_SOURCE", "src/readme.md"]]);
  linked.add(path.join(root, "src", "directory"));
  assert.throws(() => repository.list("src"), failure("SYMLINK_SOURCE"));
  linked.delete(path.join(root, "src", "directory"));
  linked.add(path.join(root, "src", "main.js"));
  assert.throws(() => repository.list("src"), failure("SYMLINK_SOURCE"));
});
