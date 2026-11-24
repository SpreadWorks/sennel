import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const file = "src/renamed-parent-projection.mjs";
function inspect(source) {
  return new OsIndependenceChecker(new MemorySourceRepository([
    [file, `import fs from 'node:fs';\n${source}`],
  ]), { files: [file], entrypoints: [file] }).check();
}

// The parent lookup belongs to the method's lexical home object; its receiver
// remains the actual instance/class, including through inheritance and arrows.
// These are source fixtures only. No fixture code is evaluated.
const forms = [
  ["instance parent method", path => `
class Origin {
  constructor(file) { this.file = file; }
  read() { return fs.readFileSync(this.file); }
}
class Projection extends Origin { read() { return super.read(); } }
new Projection(${JSON.stringify(path)}).read();`],
  ["inherited method keeps its home class", path => `
class Origin {
  constructor(file) { this.file = file; }
  read() { return fs.readFileSync(this.file); }
}
class Projection extends Origin { read() { return super.read(); } }
class Leaf extends Projection {}
new Leaf(${JSON.stringify(path)}).read();`],
  ["parent getter uses the actual instance", path => `
class Origin {
  constructor(file) { this.file = file; }
  get path() { return this.file; }
}
class Projection extends Origin { get path() { return super.path; } }
fs.readFileSync(new Projection(${JSON.stringify(path)}).path);`],
  ["arrow keeps its enclosing super binding", path => `
class Origin {
  constructor(file) { this.file = file; }
  read() { return fs.readFileSync(this.file); }
}
class Projection extends Origin {
  read() { const later = () => super.read(); return later(); }
}
new Projection(${JSON.stringify(path)}).read();`],
  ["field initializer uses its lexical parent and initialized receiver", path => `
class Origin {
  constructor(file) { this.file = file; }
  read() { return fs.readFileSync(this.file); }
}
class Projection extends Origin { result = super.read(); }
new Projection(${JSON.stringify(path)});`],
  ["static parent method uses the actual class", path => `
class Origin { static read() { return fs.readFileSync(this.file); } }
class Projection extends Origin { static read() { return super.read(); } }
class Leaf extends Projection { static file = ${JSON.stringify(path)}; }
Leaf.read();`],
  ["static parent getter uses the actual class", path => `
class Origin { static get path() { return this.file; } }
class Projection extends Origin { static get path() { return super.path; } }
class Leaf extends Projection { static file = ${JSON.stringify(path)}; }
fs.readFileSync(Leaf.path);`],
  ["static field initializer keeps its lexical parent", path => `
class Origin { static read() { return fs.readFileSync(this.file); } }
class Projection extends Origin {
  static file = ${JSON.stringify(path)};
  static result = super.read();
}`],
];

for (const [name, source] of forms) {
  test(`${name}: ordinary path completes`, () => {
    const report = inspect(source("ordinary.json"));
    assert.equal(report.complete, true, report.diagnostics.join("\n"));
    assert.equal(report.ok, true, report.diagnostics.join("\n"));
    assert.deepEqual(report.diagnostics, []);
  });
  test(`${name}: platform-specific path reaches its real filesystem sink`, () => {
    const report = inspect(source("/proc/self/stat"));
    assert.equal(report.ok, false, report.diagnostics.join("\n"));
    assert.ok(report.diagnostics.some(entry => entry.file === file && entry.rule === "OS01"
      && entry.classification === "violation"), report.diagnostics.join("\n"));
    assert.ok(!report.diagnostics.some(entry => entry.rule === "OS00"), report.diagnostics.join("\n"));
  });
}

for (const source of [
  "class Origin { read() { return 1; } } class Projection extends Origin { constructor() { super.read(); super(); } } new Projection();",
  "class Origin { get value() { return 1; } } class Projection extends Origin { constructor() { const value = super.value; super(); } } new Projection();",
  "class Origin { read() { return 1; } } class Projection extends Origin { constructor() { const later = () => super.read(); later(); super(); } } new Projection();",
]) test(`parent property before receiver initialization refuses normal completion: ${source}`, () => {
  const report = inspect(source);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some(entry => entry.file === file
    && entry.classification === "incomplete"), report.diagnostics.join("\n"));
});

test("an unknown parent cannot supply a resolved parent method proof", () => {
  const report = inspect("class Projection extends foreign { read() { return super.read(); } } new Projection().read();");
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some(entry => entry.file === file
    && entry.classification === "incomplete"), report.diagnostics.join("\n"));
});
