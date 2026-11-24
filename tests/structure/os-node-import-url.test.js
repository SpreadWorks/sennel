import assert from "node:assert/strict";
import { test } from "node:test";
import { portableInvocationSource } from "../support/builders/os-audit-sources.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { OsIndependenceChecker } from "../support/structure/os-independence-checker.js";
import { inspectInstructions } from "../support/structure/os-instruction-checker.js";

const sourceFile = "src/launch.js";
const instructionFile = "src/presets/example/preset.json";
const plain = "data:text/javascript,console.log(1)";
const encoded = "data:text/javascript;base64,Y29uc29sZS5sb2coMSk=";

function typed(argv) {
  const source = portableInvocationSource.replace("['worker.js']", JSON.stringify(argv));
  return new OsIndependenceChecker(new MemorySourceRepository([[sourceFile, source]]), { files: [sourceFile] }).check();
}
function instruction(argv) {
  const source = JSON.stringify({ executable: "node", args: argv, shell: false });
  return inspectInstructions({ repository: new MemorySourceRepository([[instructionFile, source]]), files: [], resources: [instructionFile] });
}

for (const prefix of [[], ["--no-warnings"]]) for (const operands of [
  [`--import=${plain}`, "worker.js"],
  ["--import", plain, "worker.js"],
  [`--import=${encoded}`, "worker.js"],
  ["--import", encoded, "worker.js"],
]) {
  const argv = [...prefix, ...operands];
  test(`inline preload has no inspected module boundary: ${JSON.stringify(argv)}`, () => {
    for (const [check, file] of [[typed, sourceFile], [instruction, instructionFile]]) {
      const report = check(argv);
      assert.equal(report.complete, false);
      assert.deepEqual(report.diagnostics.map((entry) => [entry.rule, entry.classification, entry.file]), [["OS04", "incomplete", file]]);
    }
  });
}

for (const prefix of ["", "--no-warnings "]) test(`public command text uses the same inline-import boundary: ${prefix || "no prefix"}`, () => {
  const file = "src/skills/example/SKILL.md";
  const text = `Run \`node ${prefix}--import='data:text/javascript,process.kill(-123)' worker.js\`.`;
  const report = inspectInstructions({ repository: new MemorySourceRepository([[file, text]]), files: [], resources: [file] });
  assert.equal(report.complete, false);
  assert.deepEqual(report.diagnostics.map((entry) => [entry.rule, entry.classification]), [["OS04", "incomplete"]]);
});

for (const prefix of [[], ["--no-warnings"]]) for (const operands of [
  ["worker.js"],
  ["--import", "./preload.js", "worker.js"],
  ["--import=./preload.js", "worker.js"],
  ["--require", "./preload.cjs", "worker.js"],
  ["--import", "file:///preload.js", "worker.js"],
  ["worker.js", `--import=${plain}`],
  ["worker.js", "--import", encoded],
  ["--", `--import=${encoded}`],
  ["--", "worker.js", "--import", plain],
  [plain, "--import", encoded],
]) {
  const argv = [...prefix, ...operands];
  test(`preload files and application data stay allowed: ${JSON.stringify(argv)}`, () => {
    assert.equal(typed(argv).ok, true);
    assert.deepEqual(instruction(argv).diagnostics, []);
  });
}

for (const argv of [
  ["--message", "&& chmod 700 private-dir; $(literal)"],
  ["-eSOURCE", "worker.js"],
  ["-pSOURCE", "worker.js"],
  ["--unregistered-option", "worker.js"],
  ["--unregistered-option", `--import=${plain}`, "worker.js"],
  ["--unregistered-option", "--import", encoded, "worker.js"],
]) test(`an unknown prefix cannot prove the script boundary: ${JSON.stringify(argv)}`, () => {
  for (const [check, file] of [[typed, sourceFile], [instruction, instructionFile]]) {
    const report = check(argv);
    assert.equal(report.complete, false);
    assert.deepEqual(report.diagnostics.map((entry) => [entry.rule, entry.classification, entry.file]), [["OS04", "incomplete", file]]);
  }
});
