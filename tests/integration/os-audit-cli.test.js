import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { auditOsIndependence, auditOsIndependenceAt } from "../support/structure/os-audit.js";
import { SourceRepository, MemorySourceRepository } from "../support/structure/source-repository.js";
import { portableInvocationSource } from "../support/builders/os-audit-sources.js";

const script = fileURLToPath(new URL("../../scripts/check-os-independence.js", import.meta.url));

class AuditFixture {
  constructor(t) {
    this.root = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-os-audit-cli-"));
    t.after(() => fs.rmSync(this.root, { recursive: true, force: true }));
    for (const [file, contents] of AuditFixture.seed()) this.write(file, contents);
  }
  static seed() {
    return [
      ["package.json", JSON.stringify({ name: "example", type: "module", bin: { example: "src/entry.js" },
        files: ["src/"], scripts: { test: "node tests/run.js" } })],
      ["src/entry.js", "throw new Error('The audit must never execute source');"],
      ["scripts/build.js", "export const build = 1;"],
      ["tests/run.js", "export const runner = 1;"],
      ["tests/runner/selector.js", "export const selector = 1;"],
      ["tests/support/fixture.js", "export const fixture = 1;"],
    ];
  }
  write(file, contents) {
    const absolute = path.join(this.root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, contents);
  }
  run(args = []) {
    const execution = spawnSync(process.execPath, [script, ...args], { cwd: this.root, encoding: "utf8", timeout: 30000 });
    assert.equal(execution.error, undefined);
    assert.equal(execution.signal, null);
    const report = JSON.parse(execution.stdout);
    assert.equal(execution.status, report.exitCode, execution.stderr);
    return report;
  }
}

const platformRead = `import fs from 'node:fs';
export function read() {
  if (process.platform === 'win32') return fs.readFileSync('snapshot.json');
  if (process.platform === 'darwin') return fs.readFileSync('snapshot.json');
  return fs.readFileSync('/proc/self/stat');
}`;
const extractedPlatformRead = `import fs from 'node:fs';
export function read() {
  if (process.platform === 'linux') return readLinux();
  return fs.readFileSync('snapshot.json');
}
function readLinux() { return fs.readFileSync('/proc/self/stat'); }`;
for (const [name, valid, invalid, rule, classification] of [
  ["platform coverage", platformRead, platformRead.replace("return fs.readFileSync('snapshot.json');", "return;"), "OS01", "violation"],
  ["typed Node execution", portableInvocationSource, portableInvocationSource.replace("['worker.js']", "['-e', 'process.kill(-123)']"), "OS04", "incomplete"],
  ["inline Node preload", portableInvocationSource.replace("['worker.js']", "['--import', './preload.js', 'worker.js']"), portableInvocationSource.replace("['worker.js']", "['--import', 'data:text/javascript;base64,Y29uc29sZS5sb2coMSk=', 'worker.js']"), "OS04", "incomplete"],
  ["private platform helper", extractedPlatformRead, `${extractedPlatformRead}\nreadLinux();`, "OS01", "violation"],
  ["tagged path provenance", "import fs from 'node:fs'; fs.readFileSync(String.raw`ordinary/snapshot.json`);", "import fs from 'node:fs'; fs.readFileSync(String.raw`/proc/self/stat`);", "OS01", "violation"],
]) test(`${name} reaches CLI exit status, located evidence and exact recovery`, (t) => {
  const fixture = new AuditFixture(t);
  const file = "src/audited-boundary.mjs";
  fixture.write(file, valid);
  const clean = fixture.run();
  assert.equal(clean.exitCode, 0, JSON.stringify(clean.diagnostics));
  assert.equal(clean.ok, true);

  fixture.write(file, invalid);
  const rejected = fixture.run();
  assert.equal(rejected.exitCode, classification === "incomplete" ? 2 : 1, JSON.stringify(rejected.diagnostics));
  assert.equal(rejected.ok, false);
  const diagnostic = rejected.diagnostics.find((entry) => entry.rule === rule && entry.file === file && entry.classification === classification);
  assert.ok(diagnostic, JSON.stringify(rejected.diagnostics));
  assert.ok(diagnostic.line > 0 && diagnostic.column > 0);
  assert.ok(diagnostic.trace.includes(file));
  assert.notEqual(rejected.source.digest, clean.source.digest);

  fixture.write(file, valid);
  const recovered = fixture.run();
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.diagnostics));
  assert.equal(recovered.source.digest, clean.source.digest);
});

test("audit CLI inspects unreachable source, reports status, and recovers after removal", (t) => {
  const fixture = new AuditFixture(t);
  const clean = fixture.run();
  assert.equal(clean.ok, true, JSON.stringify(clean.diagnostics));
  assert.equal(clean.complete, true);
  assert.equal(clean.exitCode, 0);
  assert.match(clean.source.digest, /^[a-f0-9]{64}$/);

  fixture.write("src/unreachable.mjs", "if (process.platform === 'win32') throw new Error('platform branch');\n");
  const violation = fixture.run();
  assert.equal(violation.ok, false);
  assert.notEqual(violation.exitCode, 0);
  const diagnostic = violation.diagnostics.find((entry) => entry.rule === "OS01" && entry.file === "src/unreachable.mjs");
  assert.ok(diagnostic, JSON.stringify(violation.diagnostics));
  assert.equal(diagnostic.classification, "violation");
  assert.equal(diagnostic.line, 1);
  assert.ok(diagnostic.column > 0);
  assert.ok(diagnostic.trace.includes("src/unreachable.mjs"));
  assert.notEqual(violation.source.digest, clean.source.digest);

  fs.rmSync(path.join(fixture.root, "src/unreachable.mjs"));
  const recovered = fixture.run();
  assert.equal(recovered.ok, true, JSON.stringify(recovered.diagnostics));
  assert.equal(recovered.source.digest, clean.source.digest);

  fixture.write("src/broken.cjs", "const text = 'unterminated\n");
  const incomplete = fixture.run();
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.complete, false);
  assert.notEqual(incomplete.exitCode, 0);
  assert.ok(incomplete.diagnostics.some((entry) => entry.file === "src/broken.cjs" && entry.classification === "incomplete"));
});

test("audit CLI rejects arguments instead of allowing a narrowed successful scope", (t) => {
  const fixture = new AuditFixture(t);
  const report = fixture.run(["--scope", "src/entry.js"]);
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.notEqual(report.exitCode, 0);
  assert.equal(report.diagnostics[0].rule, "OS00");
});

test("literal require violations reach the CLI exit status and recover with the source evidence", (t) => {
  const fixture = new AuditFixture(t);
  const clean = fixture.run();
  assert.equal(clean.exitCode, 0);

  const file = "src/unreachable.cjs";
  fixture.write(file, 'require("node:child_process").spawn("cmd.exe", []);');
  const rejected = fixture.run();
  assert.equal(rejected.exitCode, 1, JSON.stringify(rejected.diagnostics));
  assert.equal(rejected.complete, true);
  assert.equal(rejected.ok, false);
  const diagnostic = rejected.diagnostics.find((entry) => entry.rule === "OS02" && entry.file === file);
  assert.equal(diagnostic?.classification, "violation");
  assert.ok(diagnostic.trace.includes(file));
  assert.notEqual(rejected.source.digest, clean.source.digest);
  assert.ok(rejected.source.files.some((entry) => entry.file === file));

  fs.rmSync(path.join(fixture.root, file));
  const recovered = fixture.run();
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.diagnostics));
  assert.equal(recovered.source.digest, clean.source.digest);
});

test("uninspected public compound instructions reach the CLI as incomplete and recover", (t) => {
  const fixture = new AuditFixture(t);
  const file = "src/skills/example/SKILL.md";
  const simple = "```sh\nnode --version\n```\n";
  fixture.write(file, simple);
  const clean = fixture.run();
  assert.equal(clean.exitCode, 0, JSON.stringify(clean.diagnostics));

  fixture.write(file, "```sh\nnode --version && chmod 700 private-dir\n```\n");
  const rejected = fixture.run();
  assert.equal(rejected.exitCode, 2, JSON.stringify(rejected.diagnostics));
  assert.equal(rejected.complete, false);
  assert.equal(rejected.ok, false);
  const diagnostic = rejected.diagnostics.find((entry) => entry.rule === "OS02" && entry.file === file);
  assert.equal(diagnostic?.classification, "incomplete");
  assert.ok(diagnostic.trace.includes(file));
  assert.ok(rejected.coverage.instructions.resources.includes(file));
  assert.notEqual(rejected.source.digest, clean.source.digest);

  fixture.write(file, simple);
  const recovered = fixture.run();
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.diagnostics));
  assert.equal(recovered.source.digest, clean.source.digest);
});

test("composed pseudo-filesystem paths cannot produce a successful CLI report and recover after removal", (t) => {
  const fixture = new AuditFixture(t);
  const clean = fixture.run();
  assert.equal(clean.exitCode, 0);
  fixture.write("src/composed-path.mjs", 'import fs from "node:fs"; import path from "node:path"; fs.readFileSync(path.resolve("relative", "/proc/self/stat"));');
  const rejected = fixture.run();
  assert.notEqual(rejected.exitCode, 0, JSON.stringify(rejected.diagnostics));
  assert.equal(rejected.ok, false);
  const diagnostic = rejected.diagnostics.find((entry) => entry.rule === "OS01" && entry.file === "src/composed-path.mjs");
  assert.ok(diagnostic, JSON.stringify(rejected.diagnostics));
  assert.ok(diagnostic.trace.includes("src/composed-path.mjs"));
  assert.equal(rejected.exitCode, rejected.complete ? 1 : 2);
  assert.notEqual(rejected.source.digest, clean.source.digest);
  assert.ok(rejected.source.files.some((entry) => entry.file === "src/composed-path.mjs"));

  fs.rmSync(path.join(fixture.root, "src/composed-path.mjs"));
  const recovered = fixture.run();
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.diagnostics));
  assert.equal(recovered.source.digest, clean.source.digest);
});

test("diagnostic OS templates reach the CLI as complete without granting OS branches a successful report", (t) => {
  const fixture = new AuditFixture(t);
  const file = "src/entry.js";
  const diagnosticOnly = 'const host = `${process.platform}`; console.log(host);';
  fixture.write(file, diagnosticOnly);
  const clean = fixture.run();
  assert.equal(clean.exitCode, 0, JSON.stringify(clean.diagnostics));
  assert.equal(clean.complete, true);
  assert.deepEqual(clean.diagnostics, []);

  fixture.write(file, 'const host = `${process.platform}`; if (host === "win32") console.log("selected");');
  const rejected = fixture.run();
  assert.notEqual(rejected.exitCode, 0, JSON.stringify(rejected.diagnostics));
  assert.equal(rejected.ok, false);
  assert.ok(rejected.diagnostics.some((entry) => ["OS01", "OS02"].includes(entry.rule) && entry.file === file));
  assert.notEqual(rejected.source.digest, clean.source.digest);

  fixture.write(file, diagnosticOnly);
  const recovered = fixture.run();
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.diagnostics));
  assert.equal(recovered.source.digest, clean.source.digest);
});

for (const [name, source] of [
  ["filesystem destinations", 'import fs from "node:fs"; fs.copyFileSync("ordinary", "/proc/self/stat");'],
  ["converted file URLs", 'import fs from "node:fs"; import { fileURLToPath } from "node:url"; fs.readFileSync(fileURLToPath("file:///proc/self/stat"));'],
]) test(`${name} reach CLI rejection and recover with identical source evidence`, (t) => {
  const fixture = new AuditFixture(t);
  const clean = fixture.run();
  assert.equal(clean.exitCode, 0, JSON.stringify(clean.diagnostics));

  const file = "src/extra-io.mjs";
  fixture.write(file, source);
  const rejected = fixture.run();
  assert.notEqual(rejected.exitCode, 0, JSON.stringify(rejected.diagnostics));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.exitCode, rejected.complete ? 1 : 2);
  const diagnostic = rejected.diagnostics.find((entry) => entry.rule === "OS01" && entry.file === file);
  assert.ok(diagnostic, JSON.stringify(rejected.diagnostics));
  assert.ok(diagnostic.trace.includes(file));
  assert.ok(rejected.source.files.some((entry) => entry.file === file));
  assert.notEqual(rejected.source.digest, clean.source.digest);

  fs.rmSync(path.join(fixture.root, file));
  const recovered = fixture.run();
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.diagnostics));
  assert.equal(recovered.source.digest, clean.source.digest);
});

test("application argv stays data at the CLI while Node eval authority remains incomplete", (t) => {
  const fixture = new AuditFixture(t);
  fixture.write("scripts/worker.js", "export const worker = 1;");
  const file = "src/skills/example/invocation.json";
  const invocation = JSON.stringify({ executable: "node", args: ["scripts/worker.js", "-e", "ordinary-data"], shell: false });
  fixture.write(file, invocation);
  const clean = fixture.run();
  assert.equal(clean.exitCode, 0, JSON.stringify(clean.diagnostics));
  assert.equal(clean.complete, true);
  assert.ok(clean.coverage.instructions.resources.includes(file));

  fixture.write(file, JSON.stringify({ executable: "node", args: ["-e", "doTask()"], shell: false }));
  const rejected = fixture.run();
  assert.equal(rejected.exitCode, 2, JSON.stringify(rejected.diagnostics));
  assert.equal(rejected.complete, false);
  assert.ok(rejected.diagnostics.some((entry) => entry.rule === "OS04" && entry.file === file && entry.classification === "incomplete"));
  assert.notEqual(rejected.source.digest, clean.source.digest);

  fixture.write(file, invocation);
  const recovered = fixture.run();
  assert.equal(recovered.exitCode, 0, JSON.stringify(recovered.diagnostics));
  assert.equal(recovered.source.digest, clean.source.digest);
});

test("read refusal is an incomplete audit with coverage and preserved source evidence", (t) => {
  const fixture = new AuditFixture(t);
  class RefusingRepository extends SourceRepository {
    read(file) {
      if (file === "src/entry.js") throw Object.assign(new Error("read refused"), { code: "EACCES" });
      return super.read(file);
    }
  }
  const report = auditOsIndependence(new RefusingRepository(fixture.root));
  assert.equal(report.complete, false);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some((entry) => entry.file === "src/entry.js" && entry.classification === "incomplete"));
  assert.ok(report.source.files.some((entry) => entry.file === "package.json"));
  assert.equal(report.source.files.some((entry) => entry.file === "src/entry.js"), false);
  assert.ok(report.toJSON().coverage.implementation);
});

test("fingerprints and diagnostics refer to the same observed input during source changes", () => {
  class ChangingRepository extends MemorySourceRepository {
    read(file) {
      const source = super.read(file);
      if (file === "src/entry.js") this.files.set(file, "if (process.platform === 'win32') throw new Error();");
      return source;
    }
  }
  const original = new MemorySourceRepository(AuditFixture.seed());
  const changed = new ChangingRepository(AuditFixture.seed());
  const before = auditOsIndependence(original);
  const during = auditOsIndependence(changed);
  assert.equal(during.ok, true, JSON.stringify(during.diagnostics));
  assert.equal(during.source.digest, before.source.digest);
  const after = auditOsIndependence(changed);
  assert.equal(after.ok, false);
  assert.notEqual(after.source.digest, before.source.digest);
  assert.ok(after.diagnostics.some((entry) => entry.rule === "OS01"));
});

test("evidence includes owned transitive dependencies outside the initial directory scope", (t) => {
  const fixture = new AuditFixture(t);
  fixture.write("src/entry.js", "import { value } from '../outside.js'; export const observed = value;");
  fixture.write("outside.js", "export const value = 1;");
  const before = auditOsIndependenceAt(fixture.root);
  assert.equal(before.ok, true, JSON.stringify(before.diagnostics));
  assert.ok(before.source.files.some((entry) => entry.file === "outside.js"));
  fixture.write("outside.js", "export const value = 2;");
  const after = auditOsIndependenceAt(fixture.root);
  assert.equal(after.ok, true, JSON.stringify(after.diagnostics));
  assert.notEqual(after.source.digest, before.source.digest);
  assert.notEqual(after.source.files.find((entry) => entry.file === "outside.js").sha256,
    before.source.files.find((entry) => entry.file === "outside.js").sha256);
});
