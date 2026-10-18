import test from "node:test";
import assert from "node:assert/strict";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { inspectInstructions } from "../support/structure/os-instruction-checker.js";

function inspect(file, text) {
  const repository = new MemorySourceRepository([[file, text]]);
  return inspectInstructions({ repository, files: [], resources: [file] });
}

const file = "src/skills/example/SKILL.md";

test("Node application data resembling JavaScript is not classified by its words", () => {
  for (const body of ["process.kill(-123)", "fs.readFileSync('/proc/self/stat')"]) {
    const report = inspect("src/presets/example/preset.json", JSON.stringify({
      executable: "node", args: ["scripts/worker.js", "-e", body], shell: false,
    }));
    assert.deepEqual(report.diagnostics, []);
  }
});

test("Node application argv after a script remains inert in structured and public commands", () => {
  const publicCommand = inspect(file, "Run \`node scripts/worker.js -e ordinary-data\`.");
  assert.deepEqual(publicCommand.diagnostics, []);

  const structured = inspect("src/presets/example/preset.json",
    '{"executable":"node","args":["scripts/worker.js","-e","ordinary-data"],"shell":false}');
  assert.deepEqual(structured.diagnostics, []);

  const commandString = inspect("src/skills/example/commands.json",
    '{"command":"node scripts/worker.js -e ordinary-data"}');
  assert.deepEqual(commandString.diagnostics, []);
});

test("Node eval and print options before the script remain incomplete", () => {
  for (const command of [
    "node -e doTask()",
    "node --eval doTask()",
    "node --eval=doTask()",
    "node -p doTask()",
    "node --print doTask()",
  ]) {
    const report = inspect(file, "Run \`" + command + "\`.");
    assert.equal(report.complete, false, command);
    assert.ok(report.diagnostics.some((entry) => entry.rule === "OS04" && entry.classification === "incomplete"), command);
  }

  const structured = inspect("src/presets/example/preset.json",
    '{"executable":"node","args":["-e","doTask()"],"shell":false}');
  assert.equal(structured.complete, false);
  assert.deepEqual(structured.diagnostics.map((entry) => [entry.rule, entry.classification]), [["OS04", "incomplete"]]);
  const shell = inspect("src/presets/example/preset.json", JSON.stringify({
    executable: "node", args: ["-e", "doTask()"], shell: true,
  }));
  // Native JSON already rejects shell:true at OS02; inline inspection remains
  // incomplete independently of that authority-contract violation.
  assert.deepEqual(shell.diagnostics.map((entry) => [entry.rule, entry.classification]), [["OS02", "violation"], ["OS04", "incomplete"]]);
});

test("Node loader operands do not become script boundaries before a later eval option", () => {
  for (const option of ["-r", "--require", "--import"]) {
    const report = inspect(file, "Run \`node " + option + " scripts/worker.js -e doTask()\`.");
    assert.equal(report.complete, false, option);
    assert.deepEqual(report.diagnostics.map((entry) => [entry.rule, entry.classification]), [["OS04", "incomplete"]], option);
  }

  const script = inspect(file, "Run \`node --require scripts/preload.js scripts/worker.js -e ordinary-data\`.");
  assert.deepEqual(script.diagnostics, []);
});

test("Node option parsing stops at the explicit end marker and rejects unknown prefix options", () => {
  const publicCommand = inspect(file, "Run \`node -- -e doTask()\`.");
  assert.deepEqual(publicCommand.diagnostics, []);

  const structured = inspect("src/presets/example/preset.json",
    '{"executable":"node","args":["--","-e","doTask()"],"shell":false}');
  assert.deepEqual(structured.diagnostics, []);

  const unknown = inspect(file, "Run \`node --unknown-option -e doTask()\`.");
  assert.equal(unknown.complete, false);
  assert.deepEqual(unknown.diagnostics.map((entry) => [entry.rule, entry.classification]), [["OS04", "incomplete"]]);

  for (const command of ["node -eSOURCE scripts/worker.js", "node -pSOURCE scripts/worker.js"]) {
    assert.deepEqual(inspect(file, "Run \`" + command + "\`.").diagnostics, [], command);
  }
});
