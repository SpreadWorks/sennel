import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";

const file = "src/platform-reader.js";
const helper = `function readLinux() { return fs.readFileSync('/proc/self/stat'); }`;
const reader = `export function read() {
  if (process.platform === 'linux') return readLinux();
  return fs.readFileSync('snapshot.json');
}`;
const platformHelper = `function platformRead() {
  if (process.platform === 'linux') return fs.readFileSync('/proc/self/stat');
  return fs.readFileSync('snapshot.json');
}`;
const caller = `export function read() {
  if (process.platform === 'linux') return platformRead();
  return platformRead();
}`;

function check(body, extra = []) {
  const repository = new MemorySourceRepository([[file, `import fs from 'node:fs';\n${body}`], ...extra]);
  return new OsIndependenceChecker(repository, { files: [...repository.files.keys()] }).check();
}
function successful(report) { assert.equal(report.ok, true, report.diagnostics.join("\n")); }
function diagnostic(report, classification) {
  assert.equal(report.ok, false);
  const entry = report.diagnostics.find((entry) => entry.rule === "OS01" && entry.classification === classification);
  assert.ok(entry, report.diagnostics.join("\n"));
  assert.equal(entry.file, file);
  assert.ok(entry.line >= 2 && entry.column >= 1);
  assert.ok(entry.trace.includes(file));
}

test("extracting a Linux implementation into a private helper preserves the inline judgment", () => {
  successful(check(reader.replace("readLinux()", "fs.readFileSync('/proc/self/stat')")));
  successful(check(`${helper}\n${reader}`));
});

test("private helper caller context follows existing lexical aliases and transitive calls", () => {
  successful(check(`${helper}\nconst alias = readLinux;
function delegated() { return alias(); }
${reader.replace("readLinux()", "delegated()")}`));
});

test("expression and block arrow helpers preserve both selected and incompatible callers", () => {
  for (const declaration of [
    `const readLinux = () => fs.readFileSync('/proc/self/stat');`,
    `const readLinux = () => { return fs.readFileSync('/proc/self/stat'); };`,
  ]) {
    successful(check(`${declaration}\n${reader}`));
    diagnostic(check(`${declaration}\n${reader}\nreadLinux();`), "violation");
  }
});

test("a class field initializer is still inspected without a statement-body route", () => {
  diagnostic(check(`export class Reader { snapshot = fs.readFileSync('/proc/self/stat'); }`), "violation");
});

test("a private helper need only implement the platforms reachable from its callers", () => {
  successful(check(`${helper.replace("return fs.readFileSync", "if (process.platform === 'linux') return fs.readFileSync")}\n${reader}`));
});

for (const [name, body] of [
  ["a Windows caller", `${helper}\n${reader.replace("=== 'linux'", "=== 'win32'")}`],
  ["an unconditional caller", `${helper}\n${reader}\nreadLinux();`],
  ["a second public caller", `${helper}\n${reader}\nexport function bypass() { return readLinux(); }`],
  ["a directly exported helper", `export ${helper}\n${reader}`],
  ["a bad caller alongside an unresolved caller", `${helper}\n${reader}\nreadLinux(); consume(readLinux);`],
  ["a shared boundary bypass", `${helper}\nif (process.platform === 'linux') readLinux(); else fs.readFileSync('snapshot.json');`],
]) test(`private extraction does not hide ${name}`, () => {
  diagnostic(check(body), "violation");
  successful(check(`${helper}\n${reader}`));
});

for (const [name, body] of [
  ["an escaped callable", `${helper}\n${reader}\nconsume(readLinux);`],
  ["an unresolved member caller", `${helper}\n${reader}\nreadLinux.call(null);`],
  ["no resolved caller", helper],
]) test(`${name} stays incomplete rather than granting a helper exemption`, () => {
  diagnostic(check(body), "incomplete");
});

test("resolved dependency calls preserve private helper context regardless of scope order", () => {
  const library = "src/library.js";
  const source = `import fs from 'node:fs'; ${helper}\n${reader}`;
  for (const files of [[file, library], [library, file]]) {
    const repository = new MemorySourceRepository([[file, `import { read } from './library.js'; export function readPublic() { return read(); }`], [library, source]]);
    successful(new OsIndependenceChecker(repository, { files }).check());
  }
});

test("platform helpers declared before and after their caller have the same successful judgment", () => {
  const before = check(`${platformHelper}\n${caller}`);
  const after = check(`${caller}\n${platformHelper}`);
  successful(before);
  successful(after);
  assert.deepEqual(after.diagnostics, before.diagnostics);
});

test("a selected helper path has the same effects as its inline implementation", () => {
  successful(check(`${reader.replace("readLinux()", "fs.readFileSync('/proc/self/stat')")}`));
  successful(check(`${reader.replace("readLinux()", "platformRead()") }\n${platformHelper}`));
});

test("the helper's own OS selection cannot erase an incompatible caller", () => {
  for (const definitions of [
    `${platformHelper.replace("=== 'linux'", "=== 'win32'")}\n${caller}`,
    `${caller}\n${platformHelper.replace("=== 'linux'", "=== 'win32'")}`,
  ]) diagnostic(check(definitions), "violation");
});

test("unresolved helper conditions retain the same classification in either declaration order", () => {
  const unknown = platformHelper.replace("=== 'linux'", "=== expected");
  for (const source of [`${unknown}\n${caller}`, `${caller}\n${unknown}`]) {
    const report = check(source);
    diagnostic(report, "incomplete");
    assert.equal(report.complete, false);
    assert.equal(report.diagnostics.some((entry) => entry.classification === "violation"), false);
  }
});

test("recursive and mutually recursive platform helpers finish with incomplete inspection", () => {
  for (const definitions of [
    `function first() { if (process.platform === 'linux') return first(); return fs.readFileSync('snapshot.json'); }\nexport function read() { return first(); }`,
    `function first() { if (process.platform === 'linux') return second(); return fs.readFileSync('snapshot.json'); }\nfunction second() { return first(); }\nexport function read() { return first(); }`,
  ]) {
    const report = check(definitions);
    diagnostic(report, "incomplete");
    assert.equal(report.complete, false);
    assert.equal(report.diagnostics.some((entry) => entry.rule === "OS00" && /budget/.test(entry.message)), false, "cycles must terminate without exhausting the work budget");
  }
});

test("dependency cycles stay incomplete in either scope order without evaluating either module", () => {
  const other = "src/other.js";
  const repository = new MemorySourceRepository([
    [file, `import fs from 'node:fs'; import { second } from './other.js';
export function first() { if (process.platform === 'linux') return second(); return fs.readFileSync('snapshot.json'); }`],
    [other, `import { first } from './platform-reader.js'; export function second() { return first(); }`],
  ]);
  for (const files of [[file, other], [other, file]]) {
    const report = new OsIndependenceChecker(repository, { files }).check();
    diagnostic(report, "incomplete");
    assert.equal(report.complete, false);
    assert.equal(report.diagnostics.some((entry) => entry.rule === "OS00"), false, report.diagnostics.join("\n"));
  }
});
