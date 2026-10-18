import assert from "node:assert/strict";
import { test } from "node:test";
import { portableInvocationSource as typedBoundarySource } from "../support/builders/os-audit-sources.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";
import { SourceGraph, sourceBuiltin } from "../support/structure/source-graph.js";

function check(source, extra = [], file = "src/renamed-entry.mjs") {
  const repository = new MemorySourceRepository([[file, source], ...extra]);
  return new OsIndependenceChecker(repository, { files: [...repository.files.keys()], entrypoints: [file] }).check();
}

const positive = `
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const sample = 'fs.readFileSync("/proc/1/stat"); process.kill(-123);';
// if (process.platform === 'win32') spawn('cmd.exe');
console.log(process.platform, os.platform(), os.type());
const stored = path.posix.join('logical', 'folder');
const gitMode = '100755';
fs.writeFileSync(os.devNull, '');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-'));
fs.readFileSync(path.join(workspace, 'snapshot.json'));
`;

test("OS checker accepts diagnostic identities, logical paths/modes, devNull and owned readonly roots", () => {
  const report = check(positive);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.equal(report.complete, true);
  assert.equal(report.coverage.inspected, 1);
  assert.deepEqual(report.coverage.rules, ["OS01", "OS02", "OS03", "OS04"]);
  assert.equal(report.coverage.byRule.OS01.complete, true);
});

const injections = [
  ["OS01", `if (process.platform === 'win32') execute();`],
  ["OS01", `const { platform: host } = process; if (host === 'darwin') execute();`],
  ["OS01", `import os from 'node:os'; const { platform: host } = os; if (host() === 'linux') execute();`],
  ["OS01", `import { platform as host } from 'node:os'; if (host() === 'linux') execute();`],
  ["OS01", `switch (process.platform) { case 'linux': execute(); break; default: other(); }`],
  ["OS01", `import fs from 'node:fs'; let io; io = fs; io.readFileSync('/proc/self/stat');`],
  ["OS01", `import fs from 'node:fs'; fs.readFileSync('/pro' + 'c/1/stat');`],
  ["OS01", "import fs from 'node:fs'; const pid = 17; fs.readFileSync(`/proc/${pid}/stat`);"],
  ["OS01", "import fs from 'node:fs'; fs.readFileSync(`/proc/${condition ? 1 : 2}/stat`);"],
  ["OS01", "import fs from 'node:fs'; fs.readFileSync(`/proc/${pid + 1}/stat`);"],
  ["OS01", "import fs from 'node:fs'; fs.readFileSync(`/sys/${device}/state`);"],
  ["OS01", `import fs from 'node:fs'; function load(file) { return fs.readFileSync(file); } load('/proc/self/stat');`],
  ["OS01", `import fs from 'node:fs'; const helper = () => fs.readFileSync; helper()('/proc/self/stat');`],
  ["OS01", `import fs from 'node:fs'; const bridge = { get reader() { return fs.readFileSync; } }; bridge.reader('/proc/self/stat');`],
  ["OS01", `import fs from 'node:fs'; class Bridge { get reader() { return fs.readFileSync; } } const bridge = new Bridge(); bridge.reader('/proc/self/stat');`],
  ["OS02", `import { spawn as start } from 'node:child_process'; start('node', ['worker.js']);`],
  ["OS02", `import * as child from 'node:child_process'; const { spawn: start } = child; start('node', [], { shell: true });`],
  ["OS02", `import { spawnSync } from 'node:child_process'; spawnSync('powershell.exe', []);`],
  ["OS02", `import { execFileSync } from 'node:child_process'; execFileSync('helper.cmd', []);`],
  ["OS03", `import fs from 'node:fs'; if (fs.statSync(root).uid === owner) authorize();`],
  ["OS03", `import fs from 'node:fs'; const metadata = fs.statSync(root); if ((metadata.mode & 0o777) === 0o700) authorize();`],
  ["OS03", `import fs from 'node:fs'; if (fs.statfsSync(root).type === 0x01021994) authorize();`],
  ["OS03", `import os from 'node:os'; if (os.userInfo().uid === 0) authorize();`],
  ["OS03", `import fs from 'node:fs'; fs.openSync(root, fs.constants.O_DIRECTORY);`],
  ["OS03", `import fs from 'node:fs'; const handle = fs.openSync(root, 'r'); fs.fsyncSync(handle);`],
  ["OS03", `import fs from 'node:fs/promises'; const handle = await fs.open(root, 'r'); await handle.sync();`],
  ["OS04", `import fs from 'node:fs'; const file = new URL('file:///tmp/snapshot').pathname; fs.readFileSync(file);`],
  ["OS04", `import fs from 'node:fs'; import { pathToFileURL } from 'node:url'; fs.readFileSync(pathToFileURL('relative/file').pathname);`],
  ["OS04", `import fs from 'node:fs'; import { parse } from 'node:url'; fs.readFileSync(parse('file:///tmp/snapshot').pathname);`],
  ["OS04", `import { execSync } from 'node:child_process'; execSync(parts.join(' '));`],
  ["OS03", `import { spawn } from 'node:child_process'; spawn(process.execPath, ['--version'], { uid: 1 });`],
];

for (const [rule, source] of injections) test(`single ${rule} injection has a source diagnostic and recovers: ${source}`, () => {
  assert.equal(check(positive).ok, true);
  const report = check(source);
  const diagnostic = report.diagnostics.find((entry) => entry.rule === rule && entry.classification === "violation");
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.equal(report.ok, false);
  assert.equal(diagnostic.file, "src/renamed-entry.mjs");
  assert.ok(diagnostic.line >= 1 && diagnostic.column >= 1);
  assert.ok(diagnostic.trace.includes("src/renamed-entry.mjs"));
  assert.equal(check(positive).ok, true);
});

for (const [name, source, rule] of [
  // An unknown PID sign/path root cannot prove Windows incompatibility or
  // compatibility. The old name-based bans overstated these as violations.
  ["unresolved process group", `process.kill(-group, 'SIGKILL');`, "OS01"],
  ["unresolved logical path root", `import fs from 'node:fs'; import path from 'node:path'; fs.readFileSync(path.win32.resolve(root));`, "OS04"],
  // AGENTS.md permits platform predicates. An unknown dispatch condition is
  // incomplete inspection rather than a violation merely for using the OS.
  ["unresolved OS predicate", `function select(expected) { if (process.platform === expected) return 1; return 0; }`, "OS01"],
  ["computed filesystem", `import fs from 'node:fs'; fs[operation](file);`, "OS01"],
  ["computed literal member", `import fs from 'node:fs'; fs['readFileSync'](file);`, "OS01"],
  ["computed launch", `import * as child from 'node:child_process'; child[method](command);`, "OS02"],
  ["computed load", `const capability = await import(name);`, "OS02"],
  ["dynamic require", `const capability = require(name);`, "OS02"],
  ["escaped filesystem", `import fs from 'node:fs'; consume(fs.readFileSync);`, "OS01"],
  ["escaped property", `import fs from 'node:fs'; consume({ reader: fs.readFileSync });`, "OS02"],
  ["reflective launch", `import * as child from 'node:child_process'; Reflect.get(child, name)(command);`, "OS02"],
  ["unknown fsync number", `import fs from 'node:fs'; fs.fsyncSync(42);`, "OS03"],
  ["unknown fsync parameter", `import fs from 'node:fs'; export function flush(fd) { fs.fsyncSync(fd); }`, "OS03"],
  ["ambiguous binding writes", `import fs from 'node:fs'; let io = {}; if (condition) io = fs; io.readFileSync(file);`, "OS02"],
  ["global member escape", `import fs from 'node:fs'; globalThis.reader = fs.readFileSync;`, "OS01"],
  ["spread capability escape", `import fs from 'node:fs'; const copy = { ...fs }; copy.readFileSync(file);`, "OS01"],
  ["function indirection", `import fs from 'node:fs'; fs.readFileSync.apply(null, ['/proc/self/stat']);`, "OS01"],
  ["multiple helper returns", `import fs from 'node:fs'; function choose(flag) { if (flag) return fs; return {}; } const io = choose(condition); io.readFileSync('/proc/self/stat');`, "OS02"],
  ["conditional helper return", `import fs from 'node:fs'; function choose(flag) { return flag ? fs : {}; } const io = choose(condition); io.readFileSync('/proc/self/stat');`, "OS02"],
  ["created dynamic require", `import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); load(name);`, "OS02"],
  ["vm source execution", `import vm from 'node:vm'; vm.runInNewContext(source);`, "OS02"],
  ["computed global capability", `globalThis['process']['kill'](-pid);`, "OS02"],
  ["unsupported builtin transform", `import fs from 'node:fs'; const io = Object.assign({}, fs); io.readFileSync('/proc/self/stat');`, "OS01"],
]) test(`${name} makes the relevant rule incomplete`, () => {
  const report = check(source);
  assert.equal(report.ok, false, report.diagnostics.join("\n"));
  assert.equal(report.complete, false, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some((entry) => entry.rule === rule && entry.classification === "incomplete"), report.diagnostics.join("\n"));
  assert.equal(report.coverage.byRule[rule].complete, false);
});

test("namespace reexports and renamed aliases retain the dependency route", () => {
  const report = check(`import * as bridge from './other-name.mjs'; bridge.obtain()('/proc/self/stat');`, [
    ["src/other-name.mjs", `export { obtain } from './leaf.mjs';`],
    ["src/leaf.mjs", `import { readFileSync as read } from 'node:fs'; export function obtain() { return read; }`],
  ]);
  const diagnostic = report.diagnostics.find((entry) => entry.rule === "OS01" && entry.file.endsWith("renamed-entry.mjs"));
  assert.ok(diagnostic, report.diagnostics.join("\n"));
  assert.ok(diagnostic.trace.includes("src/other-name.mjs"));
  assert.ok(diagnostic.trace.includes("src/leaf.mjs"));
});

test("literal CommonJS require/destructuring and exports use the shared dependency graph", () => {
  const report = check(`const { reader } = require('./bridge'); reader('/proc/self/stat');`, [
    ["src/bridge.js", `const { readFileSync: read } = require('node:fs'); exports.reader = read;`],
  ], "src/entry.cjs");
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS01" && entry.file === "src/entry.cjs"), report.diagnostics.join("\n"));
});

test("literal dynamic imports retain inspectable capability origins", () => {
  const report = check(`const filesystem = await import('node:fs'); filesystem.readFileSync('/proc/self/stat');`);
  assert.equal(report.complete, true, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS01"));
});

test("unreachable modules are checked without evaluating source", () => {
  const report = check(`throw new Error('must never run');`, [["src/not-imported.cjs", `process.kill(-23);`]]);
  assert.ok(report.diagnostics.some((entry) => entry.file === "src/not-imported.cjs" && entry.rule === "OS01"));
  assert.deepEqual([...report.visited].sort(), ["src/not-imported.cjs", "src/renamed-entry.mjs"]);
});

test("ordinary finite import cycles finish and unresolved origin cycles fail closed", () => {
  const safe = check(`import './cycle.mjs'; export const first = 1;`, [["src/cycle.mjs", `import './renamed-entry.mjs'; export const second = 2;`]]);
  assert.equal(safe.ok, true, safe.diagnostics.join("\n"));
  assert.equal(safe.visited.size, 2);
  const unresolved = check(`import { reader } from './cycle.mjs'; reader(file); export { reader };`, [["src/cycle.mjs", `export { reader } from './renamed-entry.mjs';`]]);
  assert.equal(unresolved.complete, false);
  assert.ok(unresolved.diagnostics.some((entry) => /origin cycle/.test(entry.message)));
});

test("lexical shadowing does not invent builtin origins", () => {
  const report = check(`import fs from 'node:fs'; function sample(process, fs) { if (process.platform === 'win32') fs.readFileSync('/proc/1/stat'); } sample({}, {});`);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});

test("retained ChildProcess handles and owned portable test launch cleanup are accepted", () => {
  const source = `import { spawn } from 'node:child_process'; const owned = spawn(process.execPath, ['--version']); try { await run(owned); } finally { owned.kill('SIGKILL'); }`;
  assert.equal(check(source, [], "tests/support/owned-fixture.js").ok, true);
  const unowned = check(source.replace(`owned.kill('SIGKILL');`, `console.log(owned.pid);`), [], "tests/support/owned-fixture.js");
  assert.ok(unowned.diagnostics.some((entry) => entry.rule === "OS02"));
  const renamed = check(source, [], "tests/support/entirely-renamed-fixture.js");
  assert.equal(renamed.ok, true, renamed.diagnostics.join("\n"));
});

test("read failures, unresolved dependencies, malformed source and empty scopes are incomplete", () => {
  for (const report of [check(`import './missing.js';`), check(`const text = 'unterminated;`), new OsIndependenceChecker(new MemorySourceRepository([]), { files: [] }).check()]) {
    assert.equal(report.ok, false);
    assert.equal(report.complete, false);
    assert.ok(report.diagnostics.some((entry) => entry.rule === "OS00" && entry.classification === "incomplete"));
    assert.ok(Object.values(report.coverage.byRule).every((entry) => entry.complete === false));
  }
  const report = new OsIndependenceChecker(new MemorySourceRepository([]), { files: ["src/missing.js"] }).check();
  assert.equal(report.coverage.inspected, 0);
  assert.equal(report.complete, false);
});



test("a closed typed invocation boundary validates and preserves executable and argv", () => {
  const report = check(typedBoundarySource);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});

test("typed launch accepts node.exe inside a complete shared OS selector", () => {
  const source = typedBoundarySource.replace("launch(new PortableInvocation(process.execPath, ['worker.js']));", `
export function execute() {
  if (process.platform === 'win32') return launch(new PortableInvocation('node.exe', ['worker.js']));
  return launch(new PortableInvocation('node', ['worker.js']));
}
execute();`);
  const report = check(source);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});

for (const argv of [
  "['-e', 'process.kill(-123)']",
  "['--eval=console.log(1)']",
  "['-p', '1 + 1']",
  "['--require', './preload.js', '-e', 'console.log(1)']",
]) test(`typed Node launch refuses uninspected inline code: ${argv}`, () => {
  const source = typedBoundarySource.replace("['worker.js']", argv);
  const report = check(source);
  assert.equal(report.ok, false);
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS04" && entry.classification === "incomplete"), report.diagnostics.join("\n"));
  assert.equal(report.diagnostics.some((entry) => entry.rule === "OS01"), false, "inline code is not classified by forbidden-word matching");
  assert.equal(check(typedBoundarySource).ok, true);
});

for (const argv of [
  "['worker.js', '-e', 'process.kill(-123)']",
  "['--', 'worker.js', '-e', 'process.kill(-123)']",
  "['--require', './preload.js', 'worker.js', '--eval=process.kill(-123)']",
  "['worker.js', applicationArgument, '-e']",
  "['--', applicationArgument, '-e']",
]) test(`typed Node launch preserves application argv as data: ${argv}`, () => {
  const report = check(typedBoundarySource.replace("['worker.js']", argv));
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  assert.deepEqual(report.diagnostics, []);
});

test("typed Node launch refuses an unknown prefix before its script boundary", () => {
  const report = check(typedBoundarySource.replace("['worker.js']", "[unknownPrefix, 'worker.js']"));
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS04" && entry.classification === "incomplete"), report.diagnostics.join("\n"));
});

test("typed strings cannot confer execution authority on an unresolved owned executable", () => {
  const source = typedBoundarySource.replace("process.execPath", "requiredExecutable").replace("['worker.js']", "['-e', 'process.kill(-123)']");
  const report = check(source);
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS02" && entry.classification === "incomplete" && /executable identity/.test(entry.message)), report.diagnostics.join("\n"));
});

for (const [name, source] of [
  ["spoofed type guard", typedBoundarySource.replace(`if (!Array.isArray(args) || args.some((argument) => typeof argument !== 'string')) throw new TypeError('argv');`, ``)],
  ["unrelated argv", typedBoundarySource.replace(`return start(invocation.executable, invocation.args, { shell: false });`, `return start(invocation.executable, ['other.js'], { shell: false });`)],
  ["discarded guard", typedBoundarySource.replace(`if (!(invocation instanceof PortableInvocation)) throw new TypeError('typed input required');`, `if (false) { if (!(invocation instanceof PortableInvocation)) throw new TypeError('typed input required'); }`)],
  ["shadowed constructor builtin", typedBoundarySource.replace(`class PortableInvocation`, `const Array = {isArray: () => true}; class PortableInvocation`)],
]) test(`${name} cannot confer typed launch authority`, () => {
  const report = check(source);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS02" && entry.classification === "incomplete"), report.diagnostics.join("\n"));
});

test("the typed boundary rejects unconditional platform requirements, not executable spelling", () => {
  for (const executable of ["ps", "ls", "mktemp", "cp", "mv", "rm", "/usr/bin/node"]) {
    const report = check(typedBoundarySource.replace(`process.execPath, ['worker.js']`, `'${executable}', []`));
    assert.ok(report.diagnostics.some((entry) => entry.rule === "OS02" && entry.classification === "violation" && /without an implementation/.test(entry.message)), report.diagnostics.join("\n"));
  }
  // A suffix is not evidence of portability or its absence. Unknown identities
  // remain incomplete instead of inheriting the retired blanket suffix ban.
  for (const executable of ["helper.cmd", "custom.exe"]) {
    const report = check(typedBoundarySource.replace(`process.execPath, ['worker.js']`, `'${executable}', []`));
    assert.equal(report.complete, false);
    assert.ok(report.diagnostics.some((entry) => entry.rule === "OS02" && entry.classification === "incomplete"));
    assert.equal(report.diagnostics.some((entry) => entry.classification === "violation"), false);
  }
  const unclassified = check(typedBoundarySource.replace(`process.execPath, ['worker.js']`, `'apt-get', []`));
  assert.equal(unclassified.complete, false);
  assert.ok(unclassified.diagnostics.some((entry) => entry.rule === "OS02" && /unclassified/.test(entry.message)));
  const portable = check(typedBoundarySource.replace(`process.execPath, ['worker.js']`, `'git', ['status']`));
  assert.equal(portable.ok, true, portable.diagnostics.join("\n"));
});

test("builtin resolution respects prefix-only Node builtin modules", () => {
  assert.equal(sourceBuiltin("node:test"), "test");
  assert.equal(sourceBuiltin("test"), null);
  const report = check(`import { test } from 'node:test'; test('static only', () => {});`);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
  const graph = new SourceGraph(new MemorySourceRepository([]));
  assert.equal(graph.resolve("src/main.js", { specifier: "node:test", kind: "import" }).builtin, "test");
  const validation = check(`import { isBuiltin } from 'node:module'; import vm from 'node:vm'; console.log(isBuiltin(name), vm.isContext(value));`);
  assert.equal(validation.ok, true, validation.diagnostics.join("\n"));
});

for (const cleanup of [`if (false) owned.kill();`, `function neverCalled() { owned.kill(); }`, `try { await run(owned); } finally { owned.kill('-UNSUPPORTED'); }`]) test(`unproven fixture cleanup fails closed: ${cleanup}`, () => {
  const report = check(`import { spawn } from 'node:child_process'; const owned = spawn(process.execPath, ['--version']); ${cleanup}`, [], "tests/support/fixture.js");
  assert.equal(report.complete, false, report.diagnostics.join("\n"));
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS02" && entry.classification === "incomplete"));
});

test("owned fixture cleanup does not exempt runtime inline code or unknown worker scripts", () => {
  for (const argv of [`['-e', 'setInterval(() => {}, 1000)']`, `['worker.js']`]) {
    const report = check(`import { spawn } from 'node:child_process'; const owned = spawn(process.execPath, ${argv}); try { await run(owned); } finally { owned.kill('SIGKILL'); }`, [], "tests/support/fixture.js");
    assert.equal(report.complete, false, report.diagnostics.join("\n"));
    assert.ok(report.diagnostics.some((entry) => entry.rule === "OS02"));
  }
});

test("coverage distinguishes declared roots from transitive implementation files", () => {
  const repository = new MemorySourceRepository([["src/main.js", `import './leaf.js';`], ["src/leaf.js", `export const value = 1;`]]);
  const report = new OsIndependenceChecker(repository, { files: ["src/main.js"] }).check();
  assert.equal(report.ok, true);
  assert.equal(report.coverage.declared, 1);
  assert.equal(report.coverage.discovered, 2);
  assert.equal(report.coverage.inspected, 2);
});

test("finite source analysis work is reported incomplete and does not skip other roots", () => {
  const report = check(Array.from({ length: 3100 }, (_, index) => `console.log(${index});`).join("\n"), [["src/independent.js", `process.kill(-1);`]]);
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some((entry) => entry.rule === "OS00" && /work budget/.test(entry.message)));
  assert.ok(report.diagnostics.some((entry) => entry.file === "src/independent.js" && entry.rule === "OS01"));
});

test("win32 path syntax validation and logical storage do not perform native I/O", () => {
  const report = check(`import path from 'node:path'; if (path.win32.isAbsolute(input)) throw new TypeError('rooted input'); const stored = path.win32.normalize(input); console.log(stored);`);
  assert.equal(report.ok, true, report.diagnostics.join("\n"));
});

test("helper work in an earlier caller cannot exhaust a module's independent root inspection", () => {
  const work = Array.from({ length: 3100 }, (_, index) => `console.log(${index});`).join("\n");
  const report = check(`import { work } from './helper.js'; work();`, [["src/helper.js", `export function work() { ${work} } process.kill(-2);`]]);
  assert.equal(report.complete, false);
  assert.ok(report.diagnostics.some((entry) => entry.file === "src/helper.js" && entry.rule === "OS01"));
});

test("owned fixture cleanup does not authorize OS process uid/gid options", () => {
  for (const option of ["uid", "gid"]) {
    const report = check(`import { spawn } from 'node:child_process'; const owned = spawn(process.execPath, ['--version'], { ${option}: 1 }); try { await run(owned); } finally { owned.kill('SIGKILL'); }`, [], "tests/support/fixture.js");
    assert.ok(report.diagnostics.some((entry) => entry.rule === "OS03"), report.diagnostics.join("\n"));
  }
});
