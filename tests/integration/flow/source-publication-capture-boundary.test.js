import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { container } from "../../../src/lib/container.js";
import { StepResult } from "../../../src/flow/engine/step-result.js";
import { settleTaskStepResult } from "../../../src/flow/definition.js";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { ImplPhasePublicationObserver } from "../../support/infrastructure/impl-phase-publication-observer.js";
import { SourcePublicationCaptureFile } from "../../support/infrastructure/source-publication-capture.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
function resign(document) {
  const { digest, ...content } = document;
  document.digest = hash(JSON.stringify(content));
}

test("original child Source save capture rejects changed provenance, bytes and binding without touching canonical evidence", async (t) => {
  const observer = new ImplPhasePublicationObserver(t);
  const scenario = new TaskReviewScenario(t);
  container.reset();
  container.register("root", scenario.root);
  t.after(() => container.reset());
  const captureRoot = createTmpDir("source-publication-wire-boundary-");
  let originalBytes = null;
  const filePath = path.join(captureRoot, "original-save.json");
  t.after(() => {
    if (originalBytes !== null) fs.writeFileSync(filePath, originalBytes);
    removeTmpDir(captureRoot);
  });
  const nonce = randomUUID();
  const reviewed = await scenario.publishReview([{
    findingKey: "missing-behavior", title: "The required branch is missing",
    failureMode: "missing_acceptance_requirement", file: "README.md", requirementId: "R-1",
    issue: "A required branch is missing.", suggestion: "Implement the required branch.",
    disposition: "must-fix", rationale: "The mapped Requirement requires the branch.",
  }]);
  assert.notEqual(reviewed.ok, false, JSON.stringify(reviewed));
  assert.equal((await scenario.filter([])).ok, true);
  const work = scenario.stageHandoff("repair");
  fs.appendFileSync(scenario.sourcePath, "the actual repaired branch\n");
  const dispositions = work.request.inputs.find((entry) => entry.name === "task-triage.json").document.dispositions;
  scenario.sealHandoff(work, {
    version: 1, stepId: "task-repair", completionStatus: "done", issues: [], overview: null, triage: null,
    repair: { version: 1, findings: dispositions.filter((entry) => entry.disposition === "apply")
      .map(({ findingKey }) => ({ findingKey, paths: ["README.md"] })),
    summary: "Implemented the exact mapped Requirement branch.", recurrenceResolutions: [] }, noChangeReason: null,
  });
  const child = `
    import { FlowManager } from ${JSON.stringify(new URL("../../../src/lib/flow-manager.js", import.meta.url).href)};
    import { WorkerArtifactHandoffCoordinator } from ${JSON.stringify(new URL("../../../src/flow/lib/worker-artifact-handoff.js", import.meta.url).href)};
    import { ImplPhasePublicationObserver } from ${JSON.stringify(new URL("../../support/infrastructure/impl-phase-publication-observer.js", import.meta.url).href)};
    import { mock } from 'node:test';
    new ImplPhasePublicationObserver({ mock, after() {} }, { sourceCapture: {
      filePath: process.env.CAPTURE_FILE, nonce: process.env.CAPTURE_NONCE } });
    const root = process.env.CAPTURE_ROOT;
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    const result = new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: {
      root, mainRoot: root, executionRoot: root, specId: process.env.CAPTURE_SPEC, flowManager: manager } });
    if (result?.completed !== true) throw new Error('actual Source repair did not complete');
  `;
  const produced = spawnSync(process.execPath, ["--input-type=module", "--eval", child], {
    encoding: "utf8", env: { ...process.env, CAPTURE_FILE: filePath, CAPTURE_NONCE: nonce,
      CAPTURE_ROOT: scenario.root, CAPTURE_SPEC: scenario.specId },
  });
  assert.equal(produced.status, 0, produced.stderr);
  scenario.reload();
  const beforeAudit = scenario.snapshot();
  const source = fs.readFileSync(scenario.sourcePath, "utf8");
  originalBytes = fs.readFileSync(filePath);
  const original = JSON.parse(originalBytes);
  const capture = new SourcePublicationCaptureFile({ filePath, nonce });
  const options = { processId: produced.pid, executionRoot: scenario.root };
  const restored = capture.read(options);
  assert.deepEqual(restored.input.stepResult.toJSON(), original.input.stepResult);
  assert.deepEqual(StepResult.fromStored(restored.input.binding.stepId, original.input.stepResult).toJSON(),
    restored.input.stepResult.toJSON());
  assert.deepEqual(settleTaskStepResult(restored.input.binding.stepId, restored.input.stepResult).toJSON(),
    original.input.settlement);
  for (const field of ["effect", "mutationManifest", "sourceMutationBaseline", "sourceHandoffSettlement",
    "taskStageBinding", "result", "sourceTaskReviewStage"]) {
    assert.deepEqual(restored.input[field].toJSON(), original.input[field]);
  }
  for (const [index, write] of original.input.sourceTaskReviewStage.artifactWrites.entries()) {
    const bytes = Buffer.from(original.input.candidateBytes[index], "base64");
    assert.equal(bytes.length, write.byteLength);
    assert.equal(hash(bytes), write.digest);
  }
  const mutations = [
    ["nonce", (value) => { value.nonce = "foreign-parent"; resign(value); }],
    ["PID", (value) => { value.processId += 1; resign(value); }],
    ["digest", (value) => { value.digest = "0".repeat(64); }],
    ["candidate bytes", (value) => { value.input.candidateBytes[0] = Buffer.from("different bytes").toString("base64"); resign(value); }],
    ["binding", (value) => { value.input.binding.attempt.id = "foreign-source-attempt"; resign(value); }],
  ];
  for (const [label, change] of mutations) {
    const changed = structuredClone(original);
    change(changed);
    fs.writeFileSync(filePath, JSON.stringify(changed));
    assert.throws(() => observer.importSourceCapture({ filePath, nonce, ...options }), { code: "ERR_ASSERTION" }, label);
    assert.equal(scenario.snapshot(), beforeAudit, label);
    assert.equal(fs.readFileSync(scenario.sourcePath, "utf8"), source, label);
  }
  fs.writeFileSync(filePath, originalBytes);
  assert.throws(() => observer.importSourceCapture({ filePath, nonce,
    processId: produced.pid, executionRoot: captureRoot }), { code: "ERR_ASSERTION" });
  assert.equal(scenario.snapshot(), beforeAudit);
  assert.equal(fs.readFileSync(scenario.sourcePath, "utf8"), source);

  assert.equal(observer.importSourceCapture({ filePath, nonce, ...options }), original.digest);
  const activity = scenario.manager.activityLedger(scenario.specId).findLast((entry) => (
    entry.nodeId === "T-1-repair" && entry.result?.stepResult?.kind === restored.input.stepResult.kind
  ));
  assert.ok(activity);
  const authenticated = observer.authenticate(scenario.manager, activity,
    restored.input.stepResult, restored.input.settlement);
  assert.equal(authenticated.receipt.id, activity.result.draftSettlementReceipt.id);
  assert.deepEqual(authenticated.afterState.toJSON(), scenario.state().toJSON());
  assert.equal(scenario.snapshot(), beforeAudit);
  assert.equal(fs.readFileSync(scenario.sourcePath, "utf8"), source);
});
