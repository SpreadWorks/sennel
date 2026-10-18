import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/renamed-entry.mjs";
const helper = "src/renamed-reader.mjs";
const imports = "import fs from 'node:fs';\nimport path from 'node:path';\n";
function check(source, extra = []) {
  const repository = new MemorySourceRepository([[entry, source], ...extra]);
  return new OsIndependenceChecker(repository, { files: [...repository.files.keys()], entrypoints: [entry] }).check();
}
function assertPortable(source) {
  const report = check(source);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.equal(report.complete, true);
  assert.deepEqual(report.diagnostics, []);
}

const recovery = imports + "fs.readFileSync(path.join('ordinary', 'snapshot.json'));";
const portable = `${imports}
import os from 'node:os';
const stored = path.posix.join('logical', 'folder');
fs.readFileSync(path.join('relative', '/proc/self/stat'));
fs.readFileSync(path.resolve('ordinary', 'snapshot.json'));
export function read(root) { return fs.readFileSync(path.join(root, 'snapshot.json')); }
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-'));
const descriptor = fs.openSync(path.join(workspace, 'snapshot.json'), 'w');
fs.fsyncSync(descriptor);
fs.writeFileSync(os.devNull, '');
`;

for (const [name, source] of [
  ["ordinary diagnostic templates", "const host = `${process.platform}`; console.log(host);"],
  ["nested and sibling diagnostic interpolations", "import os from 'node:os'; const host = `runtime: ${process.platform}; nested: ${`${os.platform()}`}`; console.log(host);"],
  ["absolute resolve resets discard the earlier OS path", `${imports}fs.readFileSync(path.resolve('/proc', '/ordinary', 'snapshot.json'));`],
  ["POSIX storage paths formatted through the native boundary", `${imports}fs.readFileSync(path.resolve('ordinary', path.posix.join('logical', 'snapshot.json'))); export function read(root, file) { return fs.readFileSync(path.resolve(root, path.posix.normalize(file))); }`],
  ["logical values, relative paths and owned I/O", portable],
]) test(`${name} remain portable`, () => assertPortable(source));

for (const [name, expression] of [
  ["relative then absolute resolve", `path.resolve('relative', '/proc/self/stat')`],
  ["join normalization", `path.join('/ordinary', '..', 'proc', 'self/stat')`],
  ["normalize", `path.normalize('/ordinary/../proc/self/stat')`],
  ["dirname", `path.dirname('/proc/self/stat')`],
  ["nested native composition", `path.join(path.resolve('relative', '/proc'), 'self/stat')`],
  ["Windows absolute resolve", String.raw`path.resolve('ordinary', 'C:\\Windows\\system.ini')`],
]) test(`${name} rejects a concrete OS path at native I/O and recovers`, () => {
  assertPortable(recovery);
  const report = check(`${imports}fs.readFileSync(${expression});`);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  const diagnostic = report.diagnostics.find((item) => item.rule === "OS01" && item.classification === "violation");
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.equal(diagnostic.file, entry);
  assert.equal(diagnostic.line, 3);
  assert.equal(diagnostic.column, 1);
  assert.deepEqual(diagnostic.trace, [entry]);
  assertPortable(recovery);
});

for (const [name, expression] of [
  ["dynamic join", `path.join('/proc', pid, 'stat')`],
  ["dynamic resolve", `path.resolve('/sys', pid, 'state')`],
  ["dynamic normalize", `path.normalize('/proc/' + pid + '/stat')`],
  ["composed template", "`${path.join('/proc', pid, 'stat')}`"],
  ["concatenated native result", `path.resolve('ordinary', '/proc') + '/' + pid`],
]) test(`${name} refuses unresolved OS-path provenance through an exported helper and recovers`, () => {
  assertPortable(recovery);
  const report = check(`import { read } from './renamed-reader.mjs'; read(runtimePid);`, [
    [helper, `${imports}export function read(pid) { return fs.readFileSync(${expression}); }`],
  ]);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.equal(report.complete, false, report.diagnostics.join("\n"));
  const diagnostic = report.diagnostics.find((item) => item.rule === "OS01" && item.classification === "incomplete" && item.trace.includes(entry));
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.equal(diagnostic.file, helper);
  assert.equal(diagnostic.line, 3);
  assert.ok(diagnostic.column > 1);
  assert.ok(diagnostic.trace.includes(helper));
  assert.equal(report.coverage.byRule.OS01.complete, false);
  assertPortable(recovery);
});

for (const [name, value] of [
  ["template", "`${process.platform}`"],
  ["nested template", "`runtime:${`${process.platform}`}`"],
  ["concatenation", `'runtime:' + process.platform`],
  ["native composition", `path.join('runtime', process.platform)`],
  ["logical to native composition", `path.resolve('runtime', path.posix.join(process.platform, 'profile'))`],
]) test(`${name} retains OS identity when its result selects behavior`, () => {
  assertPortable(recovery);
  const report = check(`${imports}const host = ${value};\nif (host === 'win32') select();`);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  const diagnostic = report.diagnostics.find((item) => item.rule === "OS01" && item.classification === "violation" && item.line === 4);
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.equal(diagnostic.file, entry);
  assert.ok(diagnostic.trace.includes(entry));
  assertPortable(recovery);
});

for (const [name, value] of [
  ["template", "`${pathname}`"],
  ["nested template", "`${`file:${pathname}`}`"],
  ["concatenation", `pathname + '/snapshot'`],
  ["native composition", `path.join(pathname, 'snapshot')`],
  ["template through native composition", "path.normalize(`${pathname}/snapshot`)"],
  ["logical through native composition", `path.resolve('ordinary', path.posix.join(pathname, 'snapshot'))`],
]) test(`${name} retains file URL pathname provenance at native I/O`, () => {
  assertPortable(recovery);
  const report = check(`${imports}const pathname = new URL('file:///ordinary').pathname;\nfs.readFileSync(${value});`);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  const diagnostic = report.diagnostics.find((item) => item.rule === "OS04" && item.classification === "violation" && item.line === 4 && item.column === 1);
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.equal(diagnostic.file, entry);
  assert.ok(diagnostic.trace.includes(entry));
  assertPortable(recovery);
});

test("calls in sibling and nested interpolations remain inspected at their own source locations", () => {
  assertPortable(recovery);
  const report = check(`${imports}const message = \`host=\${process.platform}; body=\${\`\${fs.readFileSync('/proc/self/stat')}\`}\`; console.log(message);`);
  const diagnostic = report.diagnostics.find((item) => item.rule === "OS01" && item.classification === "violation");
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.equal(diagnostic.file, entry);
  assert.equal(diagnostic.line, 3);
  assert.ok(diagnostic.column > 1);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assertPortable(recovery);
});

test("repeated helper diagnostics retain one actual caller route without joining unrelated callers", () => {
  const first = "src/first-caller.mjs";
  const second = "src/second-caller.mjs";
  const report = check(`import { read as first } from './first-caller.mjs'; import { read as second } from './second-caller.mjs'; first(pid); second(pid);`, [
    [first, `export { read } from './renamed-reader.mjs';`],
    [second, `export { read } from './renamed-reader.mjs';`],
    [helper, `${imports}export function read(pid) { return fs.readFileSync(path.join('/proc', pid, 'stat')); }`],
  ]);
  const diagnostics = report.diagnostics.filter((item) => item.rule === "OS01" && item.classification === "incomplete" && item.file === helper);
  assert.equal(diagnostics.length, 1, report.diagnostics.join("\n"));
  assert.deepEqual(diagnostics[0].trace, [entry, first, helper]);
  assert.equal(diagnostics[0].trace.includes(second), false);
  assert.equal(report.complete, false);
  assertPortable(recovery);
});

for (const [name, expression, rule] of [
  ["native path", `path.resolve('/proc/self/stat').slice(0)`, "OS01"],
  ["file URL template", "`${new URL('file:///ordinary').pathname}`.trim()", "OS04"],
]) test(`unsupported ${name} string transform refuses the retained origin and recovers`, () => {
  assertPortable(`${imports}fs.readFileSync(path.join('ordinary', 'snapshot.json').slice(0));`);
  const report = check(`${imports}fs.readFileSync(${expression});`);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.equal(report.complete, false);
  const diagnostic = report.diagnostics.find((item) => item.rule === rule && item.classification === "incomplete" && item.line === 3);
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.equal(diagnostic.file, entry);
  assert.ok(diagnostic.column >= 1);
  assert.ok(diagnostic.trace.includes(entry));
  assert.equal(report.coverage.byRule[rule].complete, false);
  assertPortable(recovery);
});

for (const [name, expression, rule] of [
  ["direct logical POSIX I/O", `path.posix.join('logical', 'snapshot.json')`, "OS04"],
  ["Windows logical syntax across a native formatter", `path.resolve('ordinary', path.win32.join('logical', 'snapshot.json'))`, "OS04"],
  ["concrete pseudo path across logical and native formatters", `path.resolve('ordinary', path.posix.join('/proc', 'self', 'stat'))`, "OS01"],
]) test(`${name} still rejects its boundary violation`, () => {
  assertPortable(recovery);
  const report = check(`${imports}fs.readFileSync(${expression});`);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  const diagnostic = report.diagnostics.find((item) => item.rule === rule && item.classification === "violation");
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.equal(diagnostic.file, entry);
  assert.equal(diagnostic.line, 3);
  assert.equal(diagnostic.column, 1);
  assert.deepEqual(diagnostic.trace, [entry]);
  assertPortable(recovery);
});

test("unknown pseudo-path suffix remains incomplete across logical and native formatters", () => {
  assertPortable(recovery);
  const report = check(`import { read } from './renamed-reader.mjs'; read(root, pid);`, [
    [helper, `${imports}export function read(root, pid) { return fs.readFileSync(path.resolve(root, path.posix.join('/proc', pid, 'stat'))); }`],
  ]);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.equal(report.complete, false);
  const diagnostic = report.diagnostics.find((item) => item.rule === "OS01" && item.classification === "incomplete" && item.file === helper);
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.equal(diagnostic.line, 3);
  assert.ok(diagnostic.column > 1);
  assert.deepEqual(diagnostic.trace, [entry, helper]);
  assert.equal(report.coverage.byRule.OS01.complete, false);
  assertPortable(recovery);
});
