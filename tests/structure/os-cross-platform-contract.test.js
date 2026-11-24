import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";
import { classifyExecutable, UnclassifiedExecutable } from "../support/structure/os-command-policy.js";

const file = "src/platform-boundary.js";
function check(body) {
  return new OsIndependenceChecker(new MemorySourceRepository([[file, `import fs from 'node:fs';\n${body}`]]), { files: [file] }).check();
}
const complete = `export function read() {
  if (process.platform === 'win32') return fs.readFileSync('snapshot.json');
  if (process.platform === 'darwin') return fs.readFileSync('snapshot.json');
  return fs.readFileSync('/proc/self/stat');
}`;

for (const [name, source] of [
  ["if and early return", complete],
  ["class method", complete.replace("export function read()", "export class Reader { read()") + "}"],
  ["arrow boundary", complete.replace("export function read()", "export const read = () =>") + ";"],
  ["conditional return", `export function read() { return process.platform === 'linux' ? fs.readFileSync('/proc/self/stat') : fs.readFileSync('snapshot.json'); }`],
  ["aliased identity", `const { platform: host } = process; ${complete.replaceAll('process.platform', 'host')}`],
  ["os platform alias", `import {platform as host} from 'node:os'; ${complete.replaceAll('process.platform', 'host()')}`],
  ["switch and unsupported-OS default", `export function read() { switch (process.platform) {
    case 'win32': return fs.readFileSync('snapshot.json');
    case 'darwin': return fs.readFileSync('snapshot.json');
    case 'linux': return fs.readFileSync('/proc/self/stat');
    default: throw new Error('unsupported OS');
  } }`],
  ["compound POSIX condition", `export function read() { if (process.platform === 'linux' || process.platform === 'darwin') return fs.readFileSync('/dev/null'); else return fs.readFileSync('snapshot.json'); }`],
  ["Windows-only optimization flag", `export function open(file) { if (process.platform === 'win32') return fs.openSync(file, fs.constants.O_RDONLY | fs.constants.UV_FS_O_FILEMAP); else return fs.openSync(file, fs.constants.O_RDONLY); }`],
  ["documented ignored optimization", `export function open(file) { return fs.openSync(file, fs.constants.O_RDONLY | fs.constants.UV_FS_O_FILEMAP); }`],
  ["identity predicates as data", `export const windows = process.platform === 'win32'; console.log(windows);`],
  ["documented process existence API", `process.kill(process.pid, 0);`],
  ["OS-specific logical formatters", `import path from 'node:path'; export function read() { if (process.platform === 'win32') return fs.readFileSync(path.win32.join('logical', 'snapshot.json')); return fs.readFileSync(path.posix.join('logical', 'snapshot.json')); }`],
]) test(`shared boundary accepts ${name} without claiming runtime equivalence`, () => {
  const report = check(source);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

for (const [name, source, classification] of [
  ["missing Windows and macOS", `export function read() { if (process.platform === 'linux') return fs.readFileSync('/proc/self/stat'); }`, "violation"],
  ["Windows rejection", complete.replace("return fs.readFileSync('snapshot.json');", "throw new Error('unsupported');"), "violation"],
  ["Windows no-op", complete.replace("return fs.readFileSync('snapshot.json');", "return;"), "violation"],
  // A literal false with no I/O is a known no-op here, not an opaque result.
  ["false fallback", complete.replace("return fs.readFileSync('snapshot.json');", "return false;"), "violation"],
  ["all platforms rejected", `export function read() { if (process.platform === 'linux') throw new Error(); else throw new Error(); }`, "violation"],
  ["constant rejection before dispatch", `export function read() { if (true) throw new Error(); ${complete.split('{').slice(1).join('{')}`, "violation"],
  ["delegated rejection before unreachable I/O", `function unavailable() { throw new Error(); return fs.readFileSync('snapshot.json'); } export function read() { if (process.platform === 'win32') return unavailable(); return fs.readFileSync('snapshot.json'); }`, "incomplete"],
  ["silently dropped no-follow guarantee", `export function open(file) { if (process.platform === 'linux') return fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); else return fs.openSync(file, fs.constants.O_RDONLY); }`, "incomplete"],
  ["existence check replacing termination", `export function stop() { if (process.platform === 'win32') return process.kill(process.pid, 0); return process.kill(process.pid, 'SIGKILL'); }`, "incomplete"],
  ["read replacing exclusive creation", `export function create(file) { if (process.platform === 'win32') return fs.openSync(file, 'r'); return fs.openSync(file, 'wx'); }`, "incomplete"],
  ["unknown OS predicate", `export function read(expected) { if (process.platform === expected) return fs.readFileSync('snapshot.json'); return fs.readFileSync('snapshot.json'); }`, "incomplete"],
  ["unsupported identity transform", `export function read() { if (process.platform.startsWith('win')) return fs.readFileSync('snapshot.json'); }`, "incomplete"],
  ["unmodeled path selector", `export function read() { return fs.readFileSync(process.platform === 'linux' ? '/proc/self/stat' : 'snapshot.json'); }`, "incomplete"],
  ["shared boundary bypass", `if (process.platform === 'win32') fs.readFileSync('snapshot.json'); else fs.readFileSync('snapshot.json');`, "violation"],
  ["pseudo path on wrong platform", complete.replace("if (process.platform === 'win32') return fs.readFileSync('snapshot.json');", "if (process.platform === 'win32') return fs.readFileSync('/proc/self/stat');"), "violation"],
]) test(`${name} cannot establish all-platform support and recovers`, () => {
  const report = check(source);
  assert.equal(report.ok, false);
  const diagnostic = report.diagnostics.find((entry) => entry.rule === "OS01" && entry.classification === classification);
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.equal(diagnostic.file, file);
  assert.ok(diagnostic.line >= 2);
  assert.deepEqual(diagnostic.trace, [file]);
  assert.equal(check(complete).ok, true);
});

test("executable identity uses platform availability, never the extension alone", () => {
  assert.equal(classifyExecutable('custom.exe') instanceof UnclassifiedExecutable, true);
  assert.equal(classifyExecutable('custom.cmd') instanceof UnclassifiedExecutable, true);
  assert.equal(classifyExecutable('node.exe').identity, 'node');
  assert.deepEqual(classifyExecutable('node.exe').platforms, ['win32']);
  assert.deepEqual(classifyExecutable('node').platforms, ['linux', 'darwin', 'win32']);
});

test("literal words and punctuation remain path data during platform indexing", () => {
  for (const path of ["new", "function", "(", ";"]) {
    const report = check(`fs.readFileSync(${JSON.stringify(path)});`);
    assert.equal(report.ok, true, report.diagnostics.join("\n"));
  }
});

test("an exhausted platform-path inspection retains independently provable violations", () => {
  const work = Array.from({length: 3100}, () => "console.log('diagnostic');").join("\n");
  const source = `export function read() { if (process.platform === 'win32') { ${work} return fs.readFileSync('snapshot.json'); } return fs.readFileSync('snapshot.json'); }\nprocess.kill(-123);`;
  const report = check(source);
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS00" && entry.classification === "incomplete" && /work budget/.test(entry.message)));
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS01" && entry.classification === "violation" && entry.line === 3102), report.diagnostics.join("\n"));
});
