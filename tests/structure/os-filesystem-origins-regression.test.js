import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-io-entry.mjs";
const helper = "src/renamed-io-helper.mjs";
const imports = "import fs from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath, pathToFileURL } from 'node:url';\n";
function check(source, extra = []) {
  const repository = new MemorySourceRepository([[entry, source], ...extra]);
  return new OsIndependenceChecker(repository, { files: [...repository.files.keys()], entrypoints: [entry] }).check();
}
function assertPortable(body) {
  const report = check(imports + body);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.equal(report.complete, true);
  assert.deepEqual(report.diagnostics, []);
}
function assertDiagnostic(report, rule, classification, file = entry, line = 4) {
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  const diagnostic = report.diagnostics.find((item) => item.rule === rule && item.classification === classification && item.file === file && item.line === line);
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.ok(diagnostic.column >= 1);
  assert.ok(diagnostic.trace.includes(entry));
  assert.equal(report.complete, classification === "violation", report.diagnostics.join("\n"));
  return diagnostic;
}
const recovery = "fs.copyFileSync('ordinary', 'output'); fs.writeFileSync('ordinary', '/proc/self/stat');";

for (const [name, body, line = 4] of [
  ["read stream", "fs.createReadStream('/proc/self/stat');"],
  ["renamed write stream import", "import { createWriteStream as output } from 'node:fs';\noutput('/dev/example');", 5],
  ["copyFile destination", "fs.copyFileSync('ordinary', '/proc/self/stat');"],
  ["recursive copy destination", "fs.cpSync('ordinary', '/sys/output');"],
  ["rename destination", "fs.rename('ordinary', '/proc/output', () => {});"],
  ["link destination", "fs.linkSync('ordinary', '/sys/output');"],
  ["symlink destination", "fs.symlinkSync('ordinary', '/proc/output', 'file');"],
  ["promise copy destination", "import { copyFile as copy } from 'node:fs/promises';\nawait copy('ordinary', '/proc/output');", 5],
  ["native realpath entry", "fs.realpathSync.native('/proc/self/stat');"],
  ["glob pattern array", "fs.globSync(['ordinary/*', '/proc/*']);"],
]) test(`${name} inspects the API's actual path operand and recovers`, () => {
  assertPortable(recovery);
  const report = check(imports + body);
  assertDiagnostic(report, "OS01", "violation", entry, line);
  assertPortable(recovery);
});

test("destination provenance crosses renamed imports and helper parameters", () => {
  assertPortable(recovery);
  const report = check(`import { save } from './renamed-io-helper.mjs'; save('/proc/output');`, [
    [helper, "import { renameSync as move } from 'node:fs';\nexport function save(destination) { move('ordinary', destination); }"],
  ]);
  const diagnostic = assertDiagnostic(report, "OS01", "violation", helper, 2);
  assert.deepEqual(diagnostic.trace, [entry, helper]);
  assertPortable(recovery);
});

for (const [name, body] of [
  ["write data", "fs.writeFileSync('ordinary', '/proc/self/stat'); fs.appendFileSync('ordinary', '/sys/state');"],
  ["descriptor data", "const fd = fs.openSync('ordinary', 'w'); fs.writeSync(fd, '/proc/self/stat'); fs.closeSync(fd);"],
  ["options and callback data", "fs.cp('ordinary', 'output', { filter(source) { return source !== '/proc/self/stat'; } }, () => console.log('/sys/state'));"],
  ["stream descriptor overrides path", "const fd = fs.openSync('ordinary', 'r'); const stream = fs.createReadStream('/proc/self/stat', { fd }); stream.close();"],
  ["pathname diagnostic transforms", "console.log(new URL('file:///ordinary').pathname.trim().slice(0));"],
  ["pathname transformed write data", "fs.writeFileSync('ordinary', new URL('file:///ordinary').pathname.trim());"],
  ["ordinary stat projections", "const metadata = fs.statSync('ordinary'); console.log(metadata.size, metadata.isFile());"],
  ["composed glob pattern", "fs.globSync(path.join('relative', '/proc/*'));"],
]) test(`${name} is not mistaken for a filesystem path`, () => assertPortable(body));

test("unresolved stream fd cannot prove a sensitive path is ignored", () => {
  assertPortable(recovery);
  const report = check(imports + "fs.createReadStream('/proc/self/stat', { fd: runtimeFd });");
  assertDiagnostic(report, "OS01", "incomplete");
  assertPortable(recovery);
});

test("stream options spread can replace a known descriptor and re-enable the path", () => {
  assertPortable("const fd = fs.openSync('ordinary', 'r'); fs.createReadStream('/proc/self/stat', { fd });");
  assertDiagnostic(check(imports + "fs.createReadStream('/proc/self/stat', { fd: 0, ...runtimeOptions });"), "OS01", "incomplete");
  assertPortable(recovery);
});

for (const expression of [
  "new URL('file:///ordinary').pathname.trim()",
  "new URL('file:///ordinary').pathname.trim().slice(0)",
]) test(`direct pathname transform retains its origin at I/O: ${expression}`, () => {
  assertPortable("console.log(new URL('file:///ordinary').pathname.trim());");
  const report = check(imports + `fs.readFileSync(${expression});`);
  assertDiagnostic(report, "OS04", "incomplete");
  assertPortable(recovery);
});

test("transformed pathname reaches the caller through an imported helper", () => {
  const report = check(`import { transformed } from './renamed-io-helper.mjs';\nimport fs from 'node:fs';\nfs.readFileSync(transformed());`, [
    [helper, "export function transformed() { return new URL('file:///ordinary').pathname.trim(); }"],
  ]);
  const diagnostic = assertDiagnostic(report, "OS04", "incomplete", entry, 3);
  assert.ok(diagnostic.trace.includes(helper));
  assertPortable(recovery);
});

test("uninspected consumer refuses a transformed pathname without rejecting diagnostic use", () => {
  assertPortable("console.log(new URL('file:///ordinary').pathname.trim());");
  assertDiagnostic(check(imports + "consume(new URL('file:///ordinary').pathname.trim());"), "OS04", "incomplete");
  assertPortable(recovery);
});

for (const [name, expression] of [
  ["direct file URL", "new URL('file:///proc/self/stat')"],
  ["file URL string conversion", "fileURLToPath('file:///proc/self/stat')"],
  ["file URL object conversion", "fileURLToPath(new URL('file:///proc/self/stat'))"],
  ["native path to file URL", "pathToFileURL('/proc/self/stat')"],
  ["native URL path normalization exposes pseudo root", "pathToFileURL('/ordinary/../proc/self/stat')"],
  ["URL and native roundtrip", "fileURLToPath(pathToFileURL('/proc/self/stat'))"],
  ["relative URL with literal base", "new URL('self/stat', 'file:///proc/')"],
  ["relative URL with URL base", "fileURLToPath(new URL('self/stat', new URL('file:///proc/')))"],
  ["percent-decoded pathname", "fileURLToPath('file:///%70roc/self/stat')"],
  ["Windows drive URL", "fileURLToPath('file:///C:/Windows/system.ini')"],
  ["converted URL in native composition", "path.join(fileURLToPath('file:///proc'), 'self/stat')"],
]) test(`${name} retains its concrete OS destination at native I/O`, () => {
  assertPortable(recovery);
  assertDiagnostic(check(imports + `fs.readFileSync(${expression});`), "OS01", "violation");
  assertPortable(recovery);
});

for (const [name, expression] of [
  ["URL template suffix", "fileURLToPath(`file:///proc/${runtimePid}/stat`)"],
  ["relative URL with sensitive base", "new URL(runtimeName, 'file:///proc/')"],
  ["native composition roundtrip", "fileURLToPath(pathToFileURL(path.join('/proc', runtimePid, 'stat')))"],
  ["unsupported URL serialization", "fileURLToPath(new URL('file:///proc/self/stat').toString())"],
  ["remote file URL authority", "fileURLToPath('file://remote/ordinary')"],
  ["encoded separator", "fileURLToPath('file:///ordinary%2Fchild')"],
]) test(`${name} refuses unresolved native destination provenance`, () => {
  assertPortable(recovery);
  assertDiagnostic(check(imports + `fs.readFileSync(${expression});`), "OS01", "incomplete");
  assertPortable(recovery);
});

test("file URL conversion input survives an imported helper and reports the I/O location", () => {
  const report = check(`import { read } from './renamed-io-helper.mjs'; read(new URL('file:///proc/self/stat'));`, [
    [helper, "import fs from 'node:fs';\nimport { fileURLToPath } from 'node:url';\nexport function read(url) { return fs.readFileSync(fileURLToPath(url)); }"],
  ]);
  const diagnostic = assertDiagnostic(report, "OS01", "violation", helper, 3);
  assert.deepEqual(diagnostic.trace, [entry, helper]);
  assertPortable(recovery);
});

test("imported and namespace URL constructors share global URL destination analysis", () => {
  for (const [declaration, constructor] of [
    ["import { URL as Location } from 'node:url';", "Location"],
    ["import * as addresses from 'node:url';", "addresses.URL"],
  ]) {
    assertPortable(`${declaration}\nfs.readFileSync(new ${constructor}('file:///ordinary'));`);
    assertDiagnostic(check(`${imports}${declaration}\nfs.readFileSync(new ${constructor}('file:///proc/self/stat'));`), "OS01", "violation", entry, 5);
    assertPortable(recovery);
  }
});

for (const expression of [
  "new URL('file:///ordinary')",
  "fileURLToPath('file:///ordinary')",
  "fileURLToPath(new URL('file:///ordinary'))",
  "fileURLToPath(pathToFileURL('ordinary'))",
  "fileURLToPath(pathToFileURL(path.posix.join('ordinary', 'snapshot.json')))",
  "pathToFileURL('/proc/../ordinary')",
  "new URL('snapshot.json', new URL('file:///ordinary/'))",
  "fileURLToPath('file:///ordinary?data=/proc/self/stat#hint=/sys/state')",
  "fileURLToPath('file:///ordinary%20snapshot')",
  "fileURLToPath(runtimeURL)",
  "new URL(runtimeName, 'file:///ordinary/')",
]) test(`ordinary URL/native destination remains portable: ${expression}`, () => assertPortable(`fs.readFileSync(${expression});`));
