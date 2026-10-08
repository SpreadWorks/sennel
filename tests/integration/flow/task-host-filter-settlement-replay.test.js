import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { container } from "../../../src/lib/container.js";
import { taskStepRegistration, recoverHostFilterExecution } from "../../../src/flow/engine/composition/task.js";
import { StepAdmissionRefusal } from "../../../src/flow/lib/step-admission-refusal.js";
import { TaskHostFilterService } from "../../../src/flow/services/task-host-filter-service.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";

function protectedEvidence(scenario, location) {
  const files = [];
  function visit(directory, relative = "") {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const child = path.join(relative, name);
      if (fs.statSync(file).isDirectory()) visit(file, child);
      else files.push([child, createHash("sha256").update(fs.readFileSync(file)).digest("hex")]);
    }
  }
  visit(location.directory);
  return { source: fs.readFileSync(scenario.sourcePath).toString("base64"), files };
}

test("Host filter checkpoint replay reauthenticates its captured episode before direct and recovery returns", async (t) => {
  const scenario = new TaskReviewScenario(t);
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  assert.notEqual((await scenario.publishReview([{
    findingKey: "required-behavior", title: "Required behavior is missing",
    failureMode: "spec_behavior_contradiction", file: "README.md", requirementId: "R-1",
    issue: "The implementation omits required behavior.", suggestion: "Implement the required behavior.",
    disposition: "must-fix", rationale: "The mapped requirement requires this behavior.",
  }])).ok, false);
  const registration = taskStepRegistration("task-triage");
  const input = () => ({ flowManager: scenario.manager, specId: scenario.specId,
    stepId: registration.stepId, registration });
  const initial = registration.executionContract.select(input());
  assert.equal(initial.receipt, null);
  const published = registration.executionContract.execute(initial, input());
  const originalManager = scenario.manager;
  scenario.reload();
  assert.notEqual(scenario.manager, originalManager);
  const saved = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: registration.stepId });
  assert.equal(saved.result.kind, "task-triage-filter-required");
  assert.equal(saved.receipt.id, published.receipt.id);
  const selected = registration.executionContract.select(input());
  assert.notEqual(selected.receipt, null);
  const location = scenario.manager.specLocation(scenario.specId);
  const capture = () => protectedEvidence(scenario, location);

  const processCalls = [];
  const mocks = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"].map((name) => {
    const original = childProcess[name];
    return t.mock.method(childProcess, name, function (...args) {
      processCalls.push({ name, command: args[0] });
      return original.apply(this, args);
    });
  });
  syncBuiltinESMExports();
  t.after(() => { for (const mocked of mocks) mocked.mock.restore(); syncBuiltinESMExports(); });
  const originalPersist = TaskHostFilterService.prototype.persistStepResult;
  let saves = 0;
  t.mock.method(TaskHostFilterService.prototype, "persistStepResult", function (...args) {
    saves += 1;
    return originalPersist.apply(this, args);
  });
  const consume = (selection) => [
    () => registration.executionContract.execute(selection, input()),
    () => recoverHostFilterExecution({ ...input(), selection }),
  ];
  const unchanged = capture();
  for (const run of consume(selected)) assert.deepEqual(run().toJSON(), saved.receipt.toJSON());
  assert.deepEqual(capture(), unchanged);
  assert.equal(saves, 0, "exact replay must not execute a saving Step again");

  function assertRefused(selection, label) {
    const before = capture();
    const priorSaves = saves;
    const outcomes = consume(selection).map((run) => {
      try { return run(); } catch (error) { return error; }
    });
    assert.equal(outcomes.filter((value) => value instanceof StepAdmissionRefusal).length, 2,
      `${label}: both direct execution and recovery must refuse the captured receipt`);
    assert.equal(saves, priorSaves, `${label}: refusal must not persist a Result`);
    assert.deepEqual(capture(), before, `${label}: refusal must preserve all canonical evidence`);
  }

  const review = scenario.manager.artifactCatalog(scenario.specId).artifacts.find((entry) => entry.logicalKey === "task.review");
  assert.ok(review, "the real Review must have a cataloged publication");
  const reviewPath = scenario.manager.specLocation(scenario.specId).resolve(review.relativePath);
  for (const [label, file] of [["changed current source", scenario.sourcePath], ["changed Review bytes", reviewPath]]) {
    const captured = registration.executionContract.select(input());
    const bytes = fs.readFileSync(file);
    let altered = false;
    const restore = () => { if (altered) { fs.writeFileSync(file, bytes); altered = false; } };
    t.after(restore);
    try {
      altered = true;
      fs.writeFileSync(file, Buffer.concat([bytes, Buffer.from("\nchanged after selection\n")]));
      assertRefused(captured, label);
    } finally { restore(); }
    assert.deepEqual(capture(), unchanged);
  }
  // Source authentication legitimately runs read-only Git probes; no provider,
  // worker, or other external execution may be started by these replay paths.
  assert.ok(processCalls.every(({ command }) => command === "git"), JSON.stringify(processCalls));
  for (const mocked of mocks) mocked.mock.restore();
  syncBuiltinESMExports();

  const captured = registration.executionContract.select(input());
  const oldAttempt = scenario.state().attempt.id;
  const oldCatalog = scenario.manager.artifactCatalog(scenario.specId).hash;
  assert.equal((await scenario.filter([])).ok, true);
  scenario.reload();
  assert.equal(scenario.state().current.at(-1), "T-1-repair");
  assert.notEqual(scenario.state().attempt.id, oldAttempt);
  assert.notEqual(scenario.manager.artifactCatalog(scenario.specId).hash, oldCatalog);
  assertRefused(captured, "canonically advanced Task stage, Attempt and catalog");
});
