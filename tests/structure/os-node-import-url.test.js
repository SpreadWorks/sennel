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

for (const argv of [
  [`--import=${plain}`, "worker.js"],
  ["--import", plain, "worker.js"],
  [`--import=${encoded}`, "worker.js"],
  ["--import", encoded, "worker.js"],
]) test(`inline preload has no inspected module boundary: ${JSON.stringify(argv)}`, () => {
  for (const [check, file] of [[typed, sourceFile], [instruction, instructionFile]]) {
    const report = check(argv);
    assert.equal(report.complete, false);
    assert.deepEqual(report.diagnostics.map((entry) => [entry.rule, entry.classification, entry.file]), [["OS04", "incomplete", file]]);
  }
});

test("public command text uses the same inline-import boundary without inspecting its body", () => {
  const file = "src/skills/example/SKILL.md";
  const text = "Run `node --import='data:text/javascript,process.kill(-123)' worker.js`.";
  const report = inspectInstructions({ repository: new MemorySourceRepository([[file, text]]), files: [], resources: [file] });
  assert.equal(report.complete, false);
  assert.deepEqual(report.diagnostics.map((entry) => [entry.rule, entry.classification]), [["OS04", "incomplete"]]);
});

for (const argv of [
  ["--import", "./preload.js", "worker.js"],
  ["--import=./preload.js", "worker.js"],
  ["--require", "./preload.cjs", "worker.js"],
  ["--import", "file:///preload.js", "worker.js"],
  ["worker.js", `--import=${plain}`],
  ["--", `--import=${encoded}`],
  [plain, "--import", encoded],
]) test(`preload files and application data stay allowed: ${JSON.stringify(argv)}`, () => {
  assert.equal(typed(argv).ok, true);
  assert.deepEqual(instruction(argv).diagnostics, []);
});
