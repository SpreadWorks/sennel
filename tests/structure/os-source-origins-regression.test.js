import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const entry = "src/changed-name.cjs";
function check(source, extra = []) {
  const repository = new MemorySourceRepository([[entry, source], ...extra]);
  return new OsIndependenceChecker(repository, { files: [...repository.files.keys()], entrypoints: [entry] }).check();
}
const portable = `
const fs = require('node:fs');
const path = require('node:path');
fs.readFileSync('snapshot.json');
fs.openSync('.', fs.constants.O_RDONLY);
console.log(process.platform);
const metadata = fs.statSync('snapshot.json');
console.log(metadata.size, metadata.isFile());
const stored = path.posix.join('logical', 'folder');
const data = { O_DIRECTORY: 1 };
console.log(data.O_DIRECTORY, 'fs.constants.O_DIRECTORY');
`;
function assertPortable(source = portable) {
  const report = check(source);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.equal(report.complete, true);
}

for (const [name, source, rule, extra = [], location = entry] of [
  ["inline literal require launch", `require('node:child_process').spawn('cmd.exe', []);`, "OS02"],
  ["inline literal require filesystem", `require('node:fs').readFileSync('/proc/self/stat');`, "OS01"],
  ["inline require through CommonJS reexport", `require('./renamed-bridge').readFileSync('/proc/self/stat');`, "OS01", [["src/renamed-bridge.js", `module.exports = require('node:fs');`]]],
  ["direct required callable export", `require('./renamed-loader.cjs')('/proc/self/stat');`, "OS01", [["src/renamed-loader.cjs", `const fs = require('node:fs'); function load(file) { return fs.readFileSync(file); } module.exports = load;`]], "src/renamed-loader.cjs"],
  ["forwarded required callable export", `require('./renamed-forwarder.cjs')('/proc/self/stat');`, "OS01", [
    ["src/renamed-forwarder.cjs", `module.exports = require('./renamed-loader.cjs');`],
    ["src/renamed-loader.cjs", `const fs = require('node:fs'); function load(file) { return fs.readFileSync(file); } module.exports = load;`],
  ], "src/renamed-loader.cjs"],
  ["full required member projection", `const flag = require('node:fs').constants.O_DIRECTORY; require('node:fs').openSync('.', flag);`, "OS03"],
  ["bitwise flag operands", `const fs = require('node:fs'); fs.openSync('.', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);`, "OS03"],
  ["nested reversed helper flag operands", `const fs = require('node:fs'); function flags() { return (fs.constants.O_DIRECTORY | fs.constants.O_RDONLY) & fs.constants.O_DIRECTORY; } fs.openSync('.', flags());`, "OS03"],
  ["destructured helper parameter", `const fs = require('node:fs'); function load({readFileSync}) { return readFileSync('/proc/self/stat'); } load(fs);`, "OS01"],
  ["renamed helper member return", `const fs = require('node:fs'); function obtain({readFileSync: renamed}) { return renamed; } obtain(fs)('/proc/self/stat');`, "OS01"],
  ["constructor member projection", `const fs = require('node:fs'); class Bridge { constructor({readFileSync: read}) { this.reader = read; } } const bridge = new Bridge(fs); bridge.reader('/proc/self/stat');`, "OS01"],
  ["nested helper member projection", `const fs = require('node:fs'); function obtain({constants: {O_DIRECTORY: renamed}}) { return renamed; } fs.openSync('.', obtain(fs));`, "OS03"],
]) test(`${name} retains source provenance, reports its violation, and recovers`, () => {
  assertPortable();
  const report = check(source, extra);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  const diagnostic = report.diagnostics.find((item) => item.rule === rule && item.classification === "violation" && item.file === location);
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.ok(diagnostic.line >= 1 && diagnostic.column >= 1);
  assert.ok(diagnostic.trace.includes(entry));
  for (const [file] of extra) assert.ok(diagnostic.trace.includes(file));
  assertPortable();
});

for (const [name, parameter, argument] of [
  ["computed property", `{[name]: reader}`, "fs"],
  ["rest property", `{...reader}`, "fs"],
  ["default member", `{readFileSync: reader = fs.readFileSync}`, "{}"],
]) test(`${name} binding refuses unknown sensitive projection and recovers`, () => {
  assertPortable();
  const report = check(`const fs = require('node:fs'); function load(${parameter}) { return reader('/proc/self/stat'); } load(${argument});`);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.equal(report.complete, false, report.diagnostics.join("\n"));
  const diagnostic = report.diagnostics.find((item) => item.classification === "incomplete" && item.file === entry && /binding pattern/.test(item.message));
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.ok(diagnostic.line >= 1 && diagnostic.column >= 1);
  assert.ok(diagnostic.trace.includes(entry));
  assertPortable();
});

test("unsupported operator preserves a capability until its consumer refuses it", () => {
  assertPortable();
  const report = check(`const fs = require('node:fs'); const reader = false || fs.readFileSync; reader('/proc/self/stat');`);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.equal(report.complete, false, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some((item) => item.file === entry && item.classification === "incomplete"));
  assertPortable();
});

test("shadowed require and destructured ordinary members do not acquire builtin provenance", () => {
  assertPortable(`
function require(name) { return { readFileSync(value) { return value; } }; }
require('node:fs').readFileSync('/proc/self/stat');
function load({readFileSync: reader}) { return reader('/proc/self/stat'); }
load({readFileSync(value) { return value; }});
`);
});

test("cyclic required callable defaults stop with an incomplete origin", () => {
  assertPortable();
  const report = check(`require('./first.cjs')('/proc/self/stat');`, [
    ["src/first.cjs", `module.exports = require('./second.cjs');`],
    ["src/second.cjs", `module.exports = require('./first.cjs');`],
  ]);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.equal(report.complete, false, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some((item) => item.classification === "incomplete" && /origin cycle/.test(item.message)), report.diagnostics.join("\n"));
  assertPortable();
});

test("aliased required callable defaults detect origin cycles and recover", () => {
  const source = `require('./first.cjs')('snapshot.json');`;
  const first = ["src/first.cjs", `const next = require('./second.cjs'); module.exports = next;`];
  const portableSecond = ["src/second.cjs", `const fs = require('node:fs'); function load(file) { return fs.readFileSync(file); } module.exports = load;`];
  const assertForwarding = () => {
    const report = check(source, [first, portableSecond]);
    assert.equal(report.ok, true, report.diagnostics.join("\n"));
    assert.equal(report.complete, true);
  };
  assertForwarding();
  const report = check(source, [first, ["src/second.cjs", `const next = require('./first.cjs'); module.exports = next;`]]);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.equal(report.complete, false, report.diagnostics.join("\n"));
  const diagnostic = report.diagnostics.find((item) => item.classification === "incomplete" && /origin cycle/.test(item.message));
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.equal(diagnostic.rule, "OS02");
  assert.equal(diagnostic.file, entry);
  assert.ok(diagnostic.trace.includes("src/first.cjs"));
  assert.ok(diagnostic.trace.includes("src/second.cjs"));
  assert.equal(report.diagnostics.some((item) => item.rule === "OS00"), false, report.diagnostics.join("\n"));
  assertForwarding();
});

test("filtered for-of declarations finish indexing and preserve later launch diagnostics", () => {
  const loop = `const values = [{enabled: true}]; for (const item of values.filter(entry => entry.enabled === true)) { console.log(item); }`;
  assertPortable(loop);
  const report = check(`${loop}\nrequire('node:child_process').spawn('cmd.exe', []);`);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  const diagnostic = report.diagnostics.find((item) => item.rule === "OS02" && item.classification === "violation" && item.file === entry);
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.equal(diagnostic.line, 2);
  assert.ok(diagnostic.column >= 1);
  assert.ok(diagnostic.trace.includes(entry));
  assertPortable(loop);
});
