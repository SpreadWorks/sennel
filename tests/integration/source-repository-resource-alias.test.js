import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SourceRepository } from "../support/structure/source-repository.js";
import { auditOsIndependence } from "../support/structure/os-audit.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";

// Model only native alias metadata. Real directory containment and file reads
// still go through SourceRepository and fs, without requiring Windows link privilege.
class ResourceAliasFixture {
  constructor(t) {
    this.root = createTmpDir("source-resource-alias-");
    t.after(() => removeTmpDir(this.root));
    this.aliases = new Map();
    this.reads = [];
    for (const file of ["src/main.js", "scripts/check.js", "tests/support/helper.js", "tests/runner/main.js"]) this.write(file, "export {};\n");
    this.write("package.json", JSON.stringify({ name: "fixture", bin: { fixture: "src/main.js" },
      scripts: { check: "node scripts/check.js" }, files: ["src/"] }));
    this.write("src/AGENTS.md", "Portable project instructions.\n");
    this.link("src/CLAUDE.md", "src/AGENTS.md");
    this.filesystem = { ...fs,
      lstatSync: file => this.aliases.has(file)
        ? { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false }
        : fs.lstatSync(file),
      realpathSync: file => {
        if (!this.aliases.has(file)) return fs.realpathSync(file);
        const target = this.aliases.get(file);
        if (target instanceof Error) throw target;
        return fs.realpathSync(target);
      },
      readFileSync: (file, ...args) => { this.reads.push(file); return fs.readFileSync(file, ...args); },
    };
  }
  write(file, bytes) {
    const absolute = path.join(this.root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, bytes);
  }
  link(file, target) {
    this.write(file, "alias placeholder");
    this.aliases.set(path.join(this.root, file), path.resolve(this.root, target));
  }
  repository() { return new SourceRepository(this.root, { filesystem: this.filesystem }); }
}

test("owned Markdown resource aliases remain inventoried and readable under their logical names", t => {
  const fixture = new ResourceAliasFixture(t);
  const repository = fixture.repository();
  assert.deepEqual(repository.inventory("src", { allowResourceAliases: true }), ["src/AGENTS.md", "src/CLAUDE.md", "src/main.js"]);
  assert.equal(repository.read("src/CLAUDE.md"), "Portable project instructions.\n");
  assert.equal(fixture.reads.at(-1), path.join(fixture.root, "src/AGENTS.md"));
});

test("whole-source auditing fingerprints owned Markdown resource aliases rather than excluding them", t => {
  const fixture = new ResourceAliasFixture(t);
  const report = auditOsIndependence(fixture.repository());
  assert.equal(report.complete, true, JSON.stringify(report.diagnostics));
  assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
  assert.ok(report.scope.resources.includes("src/CLAUDE.md"));
  const expected = crypto.createHash("sha256").update("Portable project instructions.\n").digest("hex");
  assert.equal(report.source.files.find(file => file.file === "src/CLAUDE.md").sha256, expected);
  assert.equal(report.source.files.find(file => file.file === "src/AGENTS.md").sha256, expected);
});

test("resource alias admission leaves ordinary discovery and executable source aliases strict", t => {
  const fixture = new ResourceAliasFixture(t);
  assert.throws(() => fixture.repository().inventory("src"), { code: "SYMLINK_SOURCE" });
  fixture.link("src/alias.js", "src/main.js");
  assert.throws(() => fixture.repository().inventory("src/alias.js", { allowResourceAliases: true }), { code: "SYMLINK_SOURCE" });
  fixture.link("src/code.md", "src/main.js");
  assert.throws(() => fixture.repository().inventory("src/code.md", { allowResourceAliases: true }), { code: "SYMLINK_SOURCE" });
});

test("resource aliases cannot expose an outside regular file or a directory", t => {
  const fixture = new ResourceAliasFixture(t);
  const outside = createTmpDir("source-resource-outside-");
  t.after(() => removeTmpDir(outside));
  fs.writeFileSync(path.join(outside, "secret.md"), "foreign bytes");
  fixture.link("src/outside.md", path.join(outside, "secret.md"));
  assert.throws(() => fixture.repository().inventory("src/outside.md", { allowResourceAliases: true }), { code: "ROOT_ESCAPE" });
  fixture.link("src/directory.md", "src");
  assert.throws(() => fixture.repository().inventory("src/directory.md", { allowResourceAliases: true }), { code: "SYMLINK_SOURCE" });
  assert.deepEqual(fixture.reads, []);
});

test("unreadable or cyclic resource aliases retain a discovery failure", t => {
  for (const code of ["EACCES", "ELOOP"]) {
    const fixture = new ResourceAliasFixture(t);
    fixture.aliases.set(path.join(fixture.root, "src/CLAUDE.md"), Object.assign(new Error("unavailable alias"), { code }));
    assert.throws(() => fixture.repository().inventory("src", { allowResourceAliases: true }), { code: "UNREADABLE_SOURCE" });
    assert.deepEqual(fixture.reads, []);
  }
});

test("resource aliases are revalidated before reading after an outside retarget", t => {
  const fixture = new ResourceAliasFixture(t);
  const outside = createTmpDir("source-resource-retarget-");
  t.after(() => removeTmpDir(outside));
  fs.writeFileSync(path.join(outside, "secret.md"), "foreign bytes");
  const repository = fixture.repository();
  repository.inventory("src", { allowResourceAliases: true });
  fixture.aliases.set(path.join(fixture.root, "src/CLAUDE.md"), path.join(outside, "secret.md"));
  assert.throws(() => repository.read("src/CLAUDE.md"), { code: "ROOT_ESCAPE" });
  assert.deepEqual(fixture.reads, []);
});
