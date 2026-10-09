import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import RunFinalRegressionCommand from "../../../src/flow/lib/run-final-regression.js";
import RunClaimNextActionCommand from "../../../src/flow/lib/run-claim-next-action.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import {
  validateFinalRegressionEvidence,
  validateFinalRegressionResult,
} from "../../../src/flow/lib/test-artifacts.js";
import {
  CompletionValidator,
  contractFromFinalRegressionArtifact,
} from "../../../src/flow/lib/flow-judgment-contract.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import {
  attachCanonicalCommandResultArtifact,
  attachedCanonicalCommandResultArtifact,
} from "../../../src/flow/lib/canonical-command-result.js";
import { CanonicalTestArtifactStore } from "../../../src/flow/lib/canonical-test-artifacts.js";
import {
  captureFinalRegressionChangedSnapshotDigest,
  resolveCanonicalFinalRegressionTransition,
} from "../../../src/flow/lib/final-regression-transition-facts.js";
import { applyFinalRegressionTransition } from "../../../src/flow/lib/final-regression-transition-application.js";
import { createTmpDir, removeTmpDir, writeFile } from "../../support/builders/tmp-dir.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { FlowAtStepFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import {
  childProcessRecord,
  shellPrintChildProcessRecord,
} from "../../support/infrastructure/child-process-record.js";

const SPEC_ID = "001-record-proceed";
const FIXTURE_PATH = "final-regression-fixture.sh";

async function setupProject(root, scriptBody) {
  writeFile(root, FIXTURE_PATH, scriptBody);
  initGitRepo(root);
  commitAll(root, "initial");
  const flowManager = makeFlowManager(root);
  const fixture = await new FlowAtStepFixture({
    flowManager,
    specId: SPEC_ID,
    runId: "run-final-regression-recorded",
    request: "Exercise explicit final-regression acceptance.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: "main" },
    specRecord: {
      goal: "Exercise explicit final-regression acceptance.",
      requirements: [{ id: "R-1", desc: "A failed regression can be explicitly accepted with evidence." }],
    },
    targetStep: "final-regression",
  }).createWithProducers();
  commitAll(root, "record canonical final-regression frontier");
  return {
    root,
    mainRoot: root,
    executionRoot: root,
    specId: SPEC_ID,
    config: { test: { command: `sh ${FIXTURE_PATH}`, timeout: 5 } },
    flowManager,
    flowState: fixture.state(),
  };
}

function latestArtifact(ctx) {
  const history = JSON.parse(ctx.flowManager.readArtifact({
    specId: SPEC_ID,
    logicalKey: "final.regression",
    consumerNodeId: "report",
  }).bytes.toString("utf8"));
  return validateFinalRegressionResult(history.attempts.at(-1).artifact.payload);
}

async function executeAndApply(ctx) {
  const result = await new RunFinalRegressionCommand().execute(ctx);
  await FLOW_COMMANDS.run["final-regression"].post(ctx, result);
  ctx.flowState = ctx.flowManager.loadReadOnly(SPEC_ID);
  return result;
}

function failedRecordedArtifact(overrides = {}) {
  const rawOutputPath = "specs/001/001/steps/final-regression/attempt-002.log";
  return {
    version: "1",
    completed: true,
    result: "fail",
    failureKind: "unattributed_existing_failure",
    failureCategory: "existing_failure",
    failureNature: "assertion",
    command: "npm test --",
    commandSource: "package.json",
    rawOutputPath,
    rawOutputLines: { start_line: 1, end_line: 4 },
    process: { started: true, exitCode: 1, signal: null, timedOut: false, spawnError: null },
    childProcesses: [{
      ...childProcessRecord({
        stderr: "ERR_ASSERTION\ntests/unit/existing.test.js: existing failure\n",
      }).toArtifactJSON(),
      rawOutputPath,
    }],
    changedFiles: [],
    changedFileFingerprints: [],
    changedFileSnapshotDigest: "d".repeat(64),
    commandIdentity: {
      command: "npm test --",
      commandSource: "package.json",
      argv: ["npm", "test", "--"],
      env: {},
      source: "config",
      metadata: {},
      resolvedScriptDigest: null,
      resolvedConfigDigest: null,
    },
    recordAndProceed: {
      eligible: true,
      validated: true,
      evidence: "existing failure remained after an attempted repair",
      failureClassification: "existing_failure",
      operatorJustification: "failure is outside the current change",
      remainingRisk: "full regression remains red for an existing failure",
      executionBinding: {},
    },
    selectedAction: "explicit-record-and-proceed",
    remainingRisk: "full regression remains red for an existing failure",
    fixAttempts: 1,
    failureSummary: "existing failure",
    currentDiffRelationship: "non-current-diff",
    executionBinding: {
      command: "npm test --",
      rawOutputPath,
      rawOutputSha256: "a".repeat(64),
      parsedResult: "fail",
      headSha: "b".repeat(40),
      treeSha: "c".repeat(40),
      worktreeSha256: "d".repeat(64),
      testCount: 1,
      truncated: false,
      stdout: {
        originalByteLength: 0,
        capturedByteLength: 0,
        truncated: false,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
      stderr: {
        originalByteLength: 60,
        capturedByteLength: 60,
        truncated: false,
        sha256: "e".repeat(64),
      },
    },
    ...overrides,
  };
}

describe("canonical final-regression record-and-proceed", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  test("records eligible existing failures in the immutable first Attempt", async () => {
    tmp = createTmpDir("unit-final-regression-record-proceed-existing-");
    const ctx = await setupProject(tmp, [
      "printf '%s\\n' 'existing failure' >&2",
      shellPrintChildProcessRecord({
        stderr: "ERR_ASSERTION\ntests/unit/existing.test.js: existing failure\n",
      }),
      "exit 1",
      "",
    ].join("\n"));

    const result = await executeAndApply(ctx);
    const artifact = latestArtifact(ctx);

    assert.equal(result.result, "fail");
    assert.equal(artifact.failureCategory, "existing_failure");
    assert.equal(artifact.recordAndProceed.eligible, true);
    assert.equal(Object.hasOwn(artifact, "nextRecommendedAction"), false);
    fs.rmSync(path.join(tmp, artifact.rawOutputPath), { force: true });
    assert.deepEqual(validateFinalRegressionEvidence({ root: tmp, artifact }), {
      ok: true,
      rawEvidence: "absent",
    });
  });

  test("accepts a current-diff failure only after Definition exhausts repair and selects its user Action", async () => {
    tmp = createTmpDir("unit-final-regression-record-proceed-current-");
    const ctx = await setupProject(tmp, "printf '%s\\n' 'initial pass'\n");
    writeFile(tmp, FIXTURE_PATH, [
      "printf '%s\\n' 'current failure' >&2",
      shellPrintChildProcessRecord({
        stderr: `ERR_ASSERTION\n${FIXTURE_PATH}: unrelated flow test failure\n`,
      }),
      "exit 1",
      "",
    ].join("\n"));

    await executeAndApply(ctx);
    const failed = latestArtifact(ctx);
    assert.equal(failed.failureKind, "caused_by_current_change");
    assert.equal(failed.recordAndProceed.eligible, false);

    await assert.rejects(() => new RunFinalRegressionCommand().execute({
      ...ctx,
      flowState: ctx.flowManager.loadReadOnly(SPEC_ID),
      recordAndProceed: true,
      recordCategory: "out_of_scope",
      recordEvidence: "User approved recording this unrelated regression failure.",
      remainingRisk: "The full regression remains red for the recorded unrelated failure.",
    }), /Definition selected repair/);
    assert.equal(ctx.flowManager.canonicalState(SPEC_ID).attempt.sequence, 1);

    const repair = await new RunClaimNextActionCommand().execute({
      ...ctx,
      flowState: ctx.flowManager.loadReadOnly(SPEC_ID),
    });
    assert.equal(repair.ok, true, JSON.stringify(repair));
    ctx.flowState = ctx.flowManager.loadReadOnly(SPEC_ID);
    await executeAndApply(ctx);
    assert.equal(ctx.flowManager.canonicalState(SPEC_ID).attempt.sequence, 2);
    const prompted = await new GetNextActionCommand().execute({
      ...ctx,
      flowState: ctx.flowManager.loadReadOnly(SPEC_ID),
    });
    assert.equal(prompted.directive.kind, "await_user_decision");
    assert.equal(prompted.directive.actionPrompt.choices[0].actionId, "ACCEPT_FINAL_REGRESSION_FAILURE");

    const recorded = await new RunFinalRegressionCommand().execute({
      ...ctx,
      flowState: ctx.flowManager.loadReadOnly(SPEC_ID),
      recordAndProceed: true,
      recordCategory: "out_of_scope",
      recordEvidence: "User approved recording this unrelated regression failure.",
      remainingRisk: "The full regression remains red for the recorded unrelated failure.",
    });
    const attached = attachedCanonicalCommandResultArtifact(recorded);
    const state = ctx.flowManager.canonicalState(SPEC_ID);
    const store = new CanonicalTestArtifactStore({ flowManager: ctx.flowManager, state });
    const decision = resolveCanonicalFinalRegressionTransition({
      flowManager: ctx.flowManager,
      specId: SPEC_ID,
      changedFileSnapshotDigest: () => captureFinalRegressionChangedSnapshotDigest({
        root: tmp,
        relativeSpecFile: store.location.relativeSpecFile,
      }),
      candidateArtifact: attached.payload,
    });
    const tamperedArtifact = structuredClone(attached.payload);
    tamperedArtifact.recordAndProceed.evidence = "tampered after Definition selection";
    const tamperedResult = attachCanonicalCommandResultArtifact({ ...recorded }, {
      logicalKey: "final.regression",
      payload: tamperedArtifact,
    });
    assert.throws(() => applyFinalRegressionTransition({
      flowManager: ctx.flowManager,
      specId: SPEC_ID,
      commandResult: tamperedResult,
      decision,
    }), /does not match the sealed Definition decision/);
    assert.equal(ctx.flowManager.canonicalState(SPEC_ID).attempt.sequence, 2);

    await FLOW_COMMANDS.run["final-regression"].post(ctx, recorded);
    const artifact = latestArtifact(ctx);
    const history = JSON.parse(ctx.flowManager.readArtifact({
      specId: SPEC_ID,
      logicalKey: "final.regression",
      consumerNodeId: "report",
    }).bytes.toString("utf8"));

    assert.equal(recorded.failedRecorded, true);
    assert.equal(artifact.completed, true);
    assert.equal(artifact.failureCategory, "out_of_scope");
    assert.equal(artifact.recordAndProceed.validated, true);
    assert.deepEqual(history.attempts.map((entry) => entry.attempt), [1, 2, 3]);
    assert.equal(ctx.flowManager.canonicalState(SPEC_ID).findNode("final-regression").status, "done");
    assert.ok(ctx.flowManager.activityLedger(SPEC_ID).some((activity) => (
      activity.transition.operation === "accept_final_regression_failure"
    )));
  });

  test("rejects record-and-proceed when facts change after its guarded user-decision projection", async () => {
    tmp = createTmpDir("unit-final-regression-record-proceed-stale-");
    const ctx = await setupProject(tmp, "printf '%s\\n' 'initial pass'\n");
    writeFile(tmp, FIXTURE_PATH, [
      "printf '%s\\n' 'current failure' >&2",
      shellPrintChildProcessRecord({
        stderr: `ERR_ASSERTION\\n${FIXTURE_PATH}: current failure\\n`,
      }),
      "exit 1",
      "",
    ].join("\n"));

    await executeAndApply(ctx);
    const repair = await new RunClaimNextActionCommand().execute({
      ...ctx,
      flowState: ctx.flowManager.loadReadOnly(SPEC_ID),
    });
    assert.equal(repair.ok, true, JSON.stringify(repair));
    await executeAndApply(ctx);
    const prompt = await new GetNextActionCommand().execute({
      ...ctx,
      flowState: ctx.flowManager.loadReadOnly(SPEC_ID),
    });
    assert.equal(prompt.directive.kind, "await_user_decision");
    assert.equal(prompt.directive.actionPrompt.choices[0].actionId, "ACCEPT_FINAL_REGRESSION_FAILURE");

    const before = ctx.flowManager.canonicalState(SPEC_ID);
    const beforeActivities = ctx.flowManager.activityLedger(SPEC_ID).length;
    const beforeCatalog = ctx.flowManager.readCanonicalTransitionSnapshot(SPEC_ID).catalog.length;
    writeFile(tmp, "changed-after-user-decision.txt", "canonical facts changed after the prompt\n");

    await assert.rejects(() => new RunFinalRegressionCommand().execute({
      ...ctx,
      flowState: ctx.flowManager.loadReadOnly(SPEC_ID),
      recordAndProceed: true,
      recordCategory: "out_of_scope",
      recordEvidence: "User approved recording this existing regression failure.",
      remainingRisk: "The full regression remains red for the recorded existing failure.",
    }), /Definition selected blocked/);

    const after = ctx.flowManager.canonicalState(SPEC_ID);
    assert.equal(after.attempt.id, before.attempt.id);
    assert.equal(after.attempt.sequence, before.attempt.sequence);
    assert.equal(ctx.flowManager.activityLedger(SPEC_ID).length, beforeActivities);
    assert.equal(ctx.flowManager.readCanonicalTransitionSnapshot(SPEC_ID).catalog.length, beforeCatalog);
  });

  test("schema accepts only fully validated failed-recorded artifacts", () => {
    assert.equal(validateFinalRegressionResult(failedRecordedArtifact()).result, "fail");
    assert.throws(() => validateFinalRegressionResult(failedRecordedArtifact({
      recordAndProceed: { eligible: true, validated: false, evidence: "" },
    })), /record-and-proceed evidence/i);
    const validator = new CompletionValidator();
    const contract = contractFromFinalRegressionArtifact(failedRecordedArtifact(), {
      artifactPath: "specs/001/001/steps/final-regression/result.json",
    });
    assert.equal(validator.validate({ contract, requestedStatus: "done" }).kind, "normal");
  });

  test("prompt documents the explicit failed-regression decision", () => {
    const prompt = fs.readFileSync("src/flow/prompts/impl/final-regression.md", "utf8");
    assert.match(prompt, /follow only its guarded directive/i);
    assert.match(prompt, /--record-and-proceed.*exact guarded user-decision command/i);
    assert.doesNotMatch(prompt, /nextRecommendedAction/);
  });
});
