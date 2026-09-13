import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import RunFinalRegressionCommand from "../../../src/flow/lib/run-final-regression.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunClaimNextActionCommand from "../../../src/flow/lib/run-claim-next-action.js";
import { CanonicalTestArtifactStore } from "../../../src/flow/lib/canonical-test-artifacts.js";
import {
  captureFinalRegressionChangedSnapshotDigest,
  resolveCanonicalFinalRegressionTransition,
} from "../../../src/flow/lib/final-regression-transition-facts.js";
import { validateFinalRegressionResult } from "../../../src/flow/lib/test-artifacts.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { FlowDispatchAction } from "../../../src/flow/lib/run-dispatch.js";
import { createTmpDir, removeTmpDir, writeFile } from "../../support/builders/tmp-dir.js";
import { FlowAtStepFixture, makeFlowManager } from "../../support/infrastructure/flow-setup.js";
import { initGitRepo, commitAll } from "../../support/infrastructure/git-repo.js";
import { shellPrintChildProcessRecord } from "../../support/infrastructure/child-process-record.js";

const SPEC_ID = "001-test";
const FIXTURE_PATH = "final-regression-fixture.sh";
const PASSING_FIXTURE_BODY = "printf '%s\\n' 'initial pass'\n";

function failingFixtureBody(message) {
  return `printf '%s\\n' ${JSON.stringify(message)} >&2\nexit 1\n`;
}

function setupProject(tmp, scriptBody, { targetStep = "final-regression" } = {}) {
  writeFile(tmp, FIXTURE_PATH, scriptBody);
  initGitRepo(tmp);
  commitAll(tmp, "initial");
  const flowManager = makeFlowManager(tmp);
  const fixture = new FlowAtStepFixture({
    flowManager,
    specId: SPEC_ID,
    runId: "run-final-regression",
    request: "Run the final project regression.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: "main" },
    specRecord: {
      goal: "Run the final project regression.",
      requirements: [{ id: "R-1", desc: "The full project regression is recorded." }],
    },
    targetStep,
  }).create();
  commitAll(tmp, "record canonical final-regression frontier");
  return {
    root: tmp,
    mainRoot: tmp,
    executionRoot: tmp,
    specId: SPEC_ID,
    config: { test: { command: `sh ${FIXTURE_PATH}`, timeout: 5 } },
    flowManager,
    flowState: fixture.state(),
  };
}

function writeChangedFileReferencingFailureFixture(tmp, message) {
  writeFile(tmp, FIXTURE_PATH, [
    `printf '%s\\n' ${JSON.stringify(`${FIXTURE_PATH}: ${message}`)} >&2`,
    shellPrintChildProcessRecord({
      stderr: `ERR_ASSERTION\n${FIXTURE_PATH}: ${message}\n`,
    }),
    "exit 1",
    "",
  ].join("\n"));
}

function readFinalRegressionArtifact(ctx) {
  const history = JSON.parse(ctx.flowManager.readArtifact({
    specId: SPEC_ID,
    logicalKey: "final.regression",
    consumerNodeId: "report",
  }).bytes.toString("utf8"));
  return validateFinalRegressionResult(history.attempts.at(-1).artifact.payload);
}

function assertFinalRegressionCommandFailure(result, { failureKind }) {
  assert.equal(result.result, "fail");
  assert.equal(result.artifacts.failureKind, failureKind);
  assert.equal(Object.hasOwn(result.artifacts, "retryable"), false);
  assert.equal(Object.hasOwn(result.artifacts, "nextAction"), false);
}

function assertFinalRegressionArtifactFailure(artifact, { failureKind }) {
  assert.equal(artifact.result, "fail");
  assert.equal(artifact.failureKind, failureKind);
  assert.equal(Object.hasOwn(artifact, "retryable"), false);
  assert.equal(Object.hasOwn(artifact, "nextAction"), false);
}

function assertFinalRegressionFailure(ctx, result, expected) {
  assertFinalRegressionCommandFailure(result, expected);
  const artifact = readFinalRegressionArtifact(ctx);
  assertFinalRegressionArtifactFailure(artifact, expected);
  return artifact;
}

async function executeFinalRegression(ctx) {
  const result = await new RunFinalRegressionCommand().execute(ctx);
  await FLOW_COMMANDS.run["final-regression"].post(ctx, result);
  ctx.flowState = ctx.flowManager.loadReadOnly(SPEC_ID);
  return result;
}

function resolveFinalRegressionDecision(ctx) {
  const state = ctx.flowManager.canonicalState(SPEC_ID);
  const store = new CanonicalTestArtifactStore({ flowManager: ctx.flowManager, state });
  return resolveCanonicalFinalRegressionTransition({
    flowManager: ctx.flowManager,
    specId: SPEC_ID,
    changedFileSnapshotDigest: () => captureFinalRegressionChangedSnapshotDigest({
      root: ctx.executionRoot,
      relativeSpecFile: store.location.relativeSpecFile,
    }),
  });
}

describe("flow run final-regression", () => {
  let tmp;
  afterEach(() => tmp && removeTmpDir(tmp));

  it("writes a pass artifact and leaves route selection to Definition", async () => {
    tmp = createTmpDir("final-regression-pass-");
    const ctx = setupProject(tmp, "printf '%s\\n' 'TAP version 13' '1..1' 'ok 1 - final pass'\n");

    const result = await executeFinalRegression(ctx);

    assert.equal(result.result, "pass");
    assert.equal(Object.hasOwn(result, "next"), false);
    const artifact = readFinalRegressionArtifact(ctx);
    assert.equal(artifact.result, "pass");
    assert.equal(artifact.failureKind, null);
    assert.equal(Object.hasOwn(artifact, "nextAction"), false);
    assert.equal(artifact.completed, true);
    assert.equal(artifact.rawOutputPath, "specs/001-test/001/steps/final-regression/attempt-001.log");
    assert.ok(fs.existsSync(path.join(tmp, artifact.rawOutputPath)));
  });

  it("does not fingerprint canonical Version evidence as a project change", async () => {
    tmp = createTmpDir("final-regression-version-evidence-");
    const ctx = setupProject(tmp, "printf '%s\\n' 'TAP version 13' '1..1' 'ok 1 - final pass'\n");
    ctx.flowManager.appendIssueLog({
      specId: SPEC_ID,
      entry: {
        step: "final-regression",
        reason: "Canonical evidence changed without a project source change.",
      },
      idempotencyKey: "final-regression-version-evidence",
    });
    ctx.flowState = ctx.flowManager.loadReadOnly(SPEC_ID);

    const result = await executeFinalRegression(ctx);

    assert.equal(result.result, "pass");
    const artifact = readFinalRegressionArtifact(ctx);
    assert.deepEqual(artifact.changedFiles, []);
  });

  it("uses the authority root final regression timeout over a stale context config", async () => {
    tmp = createTmpDir("final-regression-authority-timeout-");
    const ctx = setupProject(tmp, "sleep 2\nprintf '%s\\n' 'TAP version 13' '1..1' 'ok 1 - final pass'\n");
    writeFile(tmp, ".sennel/config.json", JSON.stringify({
      lang: "en",
      type: "node-cli",
      docs: { languages: ["en"], defaultLanguage: "en" },
      test: {
        command: `sh ${FIXTURE_PATH}`,
        timeout: 1,
        finalRegressionTimeout: 5,
      },
    }, null, 2));

    const result = await executeFinalRegression(ctx);

    assert.equal(result.result, "pass");
  });

  it("rejects execution before the definition-owned final-regression Attempt", async () => {
    tmp = createTmpDir("final-regression-before-frontier-");
    const ctx = setupProject(tmp, "printf '%s\\n' 'final pass'\n", { targetStep: "retro" });

    await assert.rejects(
      () => new RunFinalRegressionCommand().execute(ctx),
      /requires its active Attempt/,
    );
    assert.equal(ctx.flowManager.loadReadOnly(SPEC_ID).currentNodeId, "retro");
    assert.equal(ctx.flowManager.readArtifact({
      specId: SPEC_ID,
      logicalKey: "final.regression",
      consumerNodeId: "report",
      optional: true,
    }), null);
  });

  it("leaves a failed observation un-routed until the registry applies the Definition plan", async () => {
    tmp = createTmpDir("final-regression-producer-boundary-");
    const ctx = setupProject(tmp, PASSING_FIXTURE_BODY);
    writeChangedFileReferencingFailureFixture(tmp, "producer only");

    const result = await new RunFinalRegressionCommand().execute(ctx);

    assert.equal(result.result, "fail");
    assert.equal(ctx.flowManager.canonicalState(SPEC_ID).attempt.failure, null);
    assert.equal(ctx.flowManager.readArtifact({
      specId: SPEC_ID,
      logicalKey: "final.regression",
      consumerNodeId: "report",
      optional: true,
    }), null);

    await FLOW_COMMANDS.run["final-regression"].post(ctx, result);
    assert.equal(ctx.flowManager.canonicalState(SPEC_ID).attempt.failure.code, "FINAL_REGRESSION_FAILED");
  });

  it("classifies current-change failure and lets the Definition plan record the failed Attempt", async () => {
    tmp = createTmpDir("final-regression-fail-");
    const ctx = setupProject(tmp, PASSING_FIXTURE_BODY);
    writeChangedFileReferencingFailureFixture(tmp, "boom");

    const result = await executeFinalRegression(ctx);

    assertFinalRegressionFailure(ctx, result, {
      failureKind: "caused_by_current_change",
    });
    const failed = ctx.flowManager.canonicalState(SPEC_ID).attempt.failure;
    assert.equal(failed.code, "FINAL_REGRESSION_FAILED");
    assert.equal(failed.retryable, true);
    assert.equal(failed.retryKind, "semantic");

    assert.equal(ctx.flowManager.canonicalState(SPEC_ID).attempt.failure.code, "FINAL_REGRESSION_FAILED");
    assert.equal(
      ctx.flowManager.canonicalState(SPEC_ID).nextAction().operation,
      "resolve-step-definition",
      "CurrentFlowState exposes a route-neutral cursor while the Step Definition owns canonical final-regression routing",
    );
    const restart = ctx.flowManager.restartFlow(SPEC_ID);
    assert.equal(restart.nextAction.operation, "resolve-step-definition");
    const beforeRejectedClaim = ctx.flowManager.canonicalState(SPEC_ID);
    const beforeRejectedActivities = ctx.flowManager.activityLedger(SPEC_ID).length;
    const beforeRejectedCatalog = ctx.flowManager.readCanonicalTransitionSnapshot(SPEC_ID).catalog.length;
    assert.throws(
      () => ctx.flowManager.beginNextAction(SPEC_ID),
      /requires its canonical Definition-selected Action/,
    );
    const afterRejectedClaim = ctx.flowManager.canonicalState(SPEC_ID);
    assert.equal(afterRejectedClaim.attempt.id, beforeRejectedClaim.attempt.id);
    assert.equal(ctx.flowManager.activityLedger(SPEC_ID).length, beforeRejectedActivities);
    assert.equal(ctx.flowManager.readCanonicalTransitionSnapshot(SPEC_ID).catalog.length, beforeRejectedCatalog);
    ctx.flowState = ctx.flowManager.loadReadOnly(SPEC_ID);
    const next = await new GetNextActionCommand().execute(ctx);
    assert.equal(next.directive.kind, "execute_command");
    assert.equal(next.directive.actionPrompt, undefined);
    assert.equal(next.directive.actionId, "FINAL_REGRESSION_REPAIR");
    assert.match(next.directive.nextAction, /flow run claim-next-action/);
    const decision = resolveFinalRegressionDecision(ctx);
    assert.deepEqual(next.definitionTransition.action, decision.plan.action.toJSON());
    const projected = ctx.flowManager.canonicalState(SPEC_ID).attempt;
    assert.equal(projected.sequence, 1);
    assert.equal(projected.failure.code, "FINAL_REGRESSION_FAILED");

    const claim = await new RunClaimNextActionCommand().execute(ctx);
    assert.equal(claim.ok, true, JSON.stringify(claim));
    ctx.flowState = ctx.flowManager.loadReadOnly(SPEC_ID);
    writeFile(tmp, FIXTURE_PATH, "printf '%s\\n' 'TAP version 13' '1..1' 'ok 1 - repaired final pass'\n");
    await new RunFinalRegressionCommand().execute(ctx);
    const replacement = ctx.flowManager.canonicalState(SPEC_ID).attempt;
    assert.equal(replacement.sequence, 2);
    assert.equal(replacement.failure, null);
  });

  it("blocks get-next repair when the changed-file snapshot became stale", async () => {
    tmp = createTmpDir("final-regression-stale-get-next-");
    const ctx = setupProject(tmp, PASSING_FIXTURE_BODY);
    writeChangedFileReferencingFailureFixture(tmp, "first failure snapshot");

    const result = await executeFinalRegression(ctx);
    writeChangedFileReferencingFailureFixture(tmp, "changed after failure");

    ctx.flowState = ctx.flowManager.loadReadOnly(SPEC_ID);
    const next = await new GetNextActionCommand().execute(ctx);
    assert.equal(next.directive.kind, "blocked");
    assert.equal(next.directive.code, "FINAL_REGRESSION_BLOCKED");
    assert.equal(next.directive.actionPrompt, undefined);
    assert.equal(new FlowDispatchAction(next).isTerminal, true);
    assert.equal(new FlowDispatchAction(next).awaitsUserDecision, false);
    assert.equal(ctx.flowManager.canonicalState(SPEC_ID).attempt.sequence, 1);
    assert.equal(ctx.flowManager.canonicalState(SPEC_ID).attempt.failure.code, "FINAL_REGRESSION_FAILED");
  });

  it("classifies failure with no project change as unattributed_existing_failure", async () => {
    tmp = createTmpDir("final-regression-unattributed-existing-");
    const ctx = setupProject(tmp, [
      "printf '%s\\n' 'existing failure' >&2",
      shellPrintChildProcessRecord({
        stderr: "ERR_ASSERTION\ntests/unit/existing.test.js: existing failure\n",
      }),
      "exit 1",
      "",
    ].join("\n"));

    const result = await executeFinalRegression(ctx);

    assertFinalRegressionFailure(ctx, result, {
      failureKind: "unattributed_existing_failure",
    });
    ctx.flowState = ctx.flowManager.loadReadOnly(SPEC_ID);
    const next = await new GetNextActionCommand().execute(ctx);
    assert.equal(next.directive.kind, "await_user_decision");
    assert.deepEqual(
      next.directive.actionPrompt.choices.map((choice) => choice.actionId),
      ["ACCEPT_FINAL_REGRESSION_FAILURE", "KEEP_BLOCKED"],
    );
    const decision = resolveFinalRegressionDecision(ctx);
    assert.deepEqual(next.definitionTransition.action, decision.plan.action.toJSON());
    assert.deepEqual(next.definitionTransition.userAction, decision.plan.userActions[0].toJSON());
    assert.deepEqual(
      next.definitionTransition.userAction.identity.transition,
      next.definitionTransition.action.identity,
    );
    assert.equal(ctx.flowManager.canonicalState(SPEC_ID).attempt.sequence, 1);
  });

  it("prioritizes a TAP assertion failure over an earlier successful not-found warning", async () => {
    tmp = createTmpDir("final-regression-assertion-after-warning-");
    const ctx = setupProject(tmp, [
      "printf '%s\\n' '# [text] WARN: analysis.json not found. Proceeding with empty analysis context.'",
      "printf '%s\\n' '# Subtest: flow state path ownership stays in the shared writer'",
      "printf '%s\\n' 'not ok 274 - flow state path ownership stays in the shared writer'",
      "printf '%s\\n' '  ---'",
      "printf '%s\\n' \"  failureType: 'testCodeFailure'\"",
      "printf '%s\\n' \"  error: 'direct flow.json sinks detected'\"",
      "printf '%s\\n' \"  code: 'ERR_ASSERTION'\"",
      "printf '%s\\n' '  ...'",
      shellPrintChildProcessRecord({
        stderr: "ERR_ASSERTION\ntests/unit/flow-state-path.test.js: direct flow.json sinks detected\n",
      }),
      "exit 1",
      "",
    ].join("\n"));

    const result = await executeFinalRegression(ctx);

    const artifact = assertFinalRegressionFailure(ctx, result, {
      failureKind: "unattributed_existing_failure",
    });
    assert.equal(artifact.failureCategory, "existing_failure");
    assert.equal(artifact.failureNature, "assertion");
    assert.match(artifact.failureSummary, /not ok 274.*flow state path ownership/);
    assert.match(artifact.failureSummary, /direct flow\.json sinks detected/);
    assert.doesNotMatch(artifact.failureSummary, /analysis\.json not found/);
  });

  it("attributes all real TAP failures while summarizing the first failure block", async () => {
    tmp = createTmpDir("final-regression-multiple-tap-failures-");
    const ctx = setupProject(tmp, PASSING_FIXTURE_BODY);
    writeFile(tmp, FIXTURE_PATH, [
      "printf '%s\\n' '# not ok 900 - diagnostic comment only'",
      "printf '%s\\n' '# Subtest: existing assertion'",
      "printf '%s\\n' 'not ok 1 - existing assertion'",
      "printf '%s\\n' '  ---'",
      "printf '%s\\n' \"  error: 'tests/unit/existing.test.js failed'\"",
      "printf '%s\\n' \"  code: 'ERR_ASSERTION'\"",
      "printf '%s\\n' '  ...'",
      "printf '%s\\n' '# Subtest: current assertion'",
      "printf '%s\\n' 'not ok 2 - current assertion'",
      "printf '%s\\n' '  ---'",
      `printf '%s\\n' "  error: '${FIXTURE_PATH} failed'"`,
      "printf '%s\\n' \"  code: 'ERR_ASSERTION'\"",
      "printf '%s\\n' '  ...'",
      shellPrintChildProcessRecord({
        stderr: [
          "ERR_ASSERTION",
          "tests/unit/existing.test.js failed",
          `${FIXTURE_PATH} failed`,
          "",
        ].join("\n"),
      }),
      "exit 1",
      "",
    ].join("\n"));

    const result = await executeFinalRegression(ctx);

    const artifact = assertFinalRegressionFailure(ctx, result, {
      failureKind: "caused_by_current_change",
    });
    assert.equal(artifact.failureCategory, "caused_by_current_change");
    assert.equal(artifact.failureNature, "assertion");
    assert.equal(artifact.currentDiffRelationship, "current-diff");
    assert.equal(artifact.recordAndProceed.eligible, false);
    assert.match(artifact.failureSummary, /not ok 1 - existing assertion/);
    assert.doesNotMatch(artifact.failureSummary, /diagnostic comment only/);
    assert.doesNotMatch(artifact.failureSummary, /not ok 2 - current assertion/);
  });

  it("fails closed on silent non-zero test runner exits without typed child evidence", async () => {
    tmp = createTmpDir("final-regression-silent-fail-");
    const ctx = setupProject(tmp, "exit 1\n");

    const result = await executeFinalRegression(ctx);

    assertFinalRegressionFailure(ctx, result, {
      failureKind: "unattributed_unknown_failure",
    });
  });

  it("fails closed as unknown when a non-zero runner reports zero totals without typed child evidence", async () => {
    tmp = createTmpDir("final-regression-zero-detail-fail-");
    const ctx = setupProject(tmp, [
      "printf '%s\\n' 'unit: 0'",
      "printf '%s\\n' 'integration: 0'",
      "printf '%s\\n' 'acceptance: 0'",
      "exit 1",
      "",
    ].join("\n"));

    const result = await executeFinalRegression(ctx);

    const artifact = assertFinalRegressionFailure(ctx, result, {
      failureKind: "unattributed_unknown_failure",
    });
    assert.equal(artifact.failureCategory, "unknown");
    assert.equal(artifact.failureNature, "execution");
    assert.equal(artifact.recordAndProceed.eligible, false);
    assert.equal(Object.hasOwn(artifact, "nextRecommendedAction"), false);
  });

  it("classifies child-process EPERM output distinctly", async () => {
    tmp = createTmpDir("final-regression-eperm-");
    const error = new Error("spawn EPERM");
    error.code = "EPERM";
    const ctx = setupProject(tmp, [
      shellPrintChildProcessRecord({ status: null, error }),
      "exit 1",
      "",
    ].join("\n"));

    const result = await executeFinalRegression(ctx);

    assertFinalRegressionFailure(ctx, result, {
      failureKind: "child_process_eperm",
    });

    ctx.flowState = ctx.flowManager.loadReadOnly(SPEC_ID);
    const next = await new GetNextActionCommand().execute(ctx);
    assert.deepEqual(
      {
        kind: next.directive.kind,
        terminal: next.directive.terminal,
        requiresUserAction: next.directive.requiresUserAction,
      },
      { kind: "await_user_decision", terminal: false, requiresUserAction: true },
    );
    assert.deepEqual(
      next.directive.actionPrompt.choices.map((choice) => ({
        actionId: choice.actionId,
        stateTransition: choice.stateTransition,
        hasNextAction: choice.nextAction !== null,
      })),
      [
        { actionId: "KEEP_STRICT_FLOW", stateTransition: "retain-strict-flow-block", hasNextAction: false },
        { actionId: "ENABLE_NONBLOCKING", stateTransition: null, hasNextAction: true },
      ],
    );
    const dispatched = new FlowDispatchAction(next);
    assert.equal(dispatched.isTerminal, false);
    assert.equal(dispatched.awaitsUserDecision, true);
    assert.equal(next.definitionTransition.action.identity.operation, "external-blocked");
    assert.equal(ctx.flowManager.canonicalState(SPEC_ID).attempt.sequence, 1);
  });

  it("stops on the second final-regression failure and omits previous failure state", async () => {
    tmp = createTmpDir("final-regression-second-fail-");
    const ctx = setupProject(tmp, PASSING_FIXTURE_BODY);
    writeChangedFileReferencingFailureFixture(tmp, "still failing");

    await executeFinalRegression(ctx);
    ctx.flowState = ctx.flowManager.loadReadOnly(SPEC_ID);
    await new GetNextActionCommand().execute(ctx);
    const claim = await new RunClaimNextActionCommand().execute(ctx);
    assert.equal(claim.ok, true, JSON.stringify(claim));
    ctx.flowState = ctx.flowManager.loadReadOnly(SPEC_ID);
    const second = await executeFinalRegression(ctx);

    const artifact = assertFinalRegressionFailure(ctx, second, {
      failureKind: "caused_by_current_change",
    });
    assert.ok(!Object.hasOwn(artifact, "previousFailureKind"), "previousFailureKind must not appear in the artifact");
    assert.match(artifact.rawOutputPath, /steps\/final-regression\/attempt-002\.log$/);
  });

  it("keeps per-attempt final-regression logs", async () => {
    tmp = createTmpDir("final-regression-attempt-logs-");
    const ctx = setupProject(tmp, PASSING_FIXTURE_BODY);
    writeChangedFileReferencingFailureFixture(tmp, "first attempt fails");

    await executeFinalRegression(ctx);
    ctx.flowState = ctx.flowManager.loadReadOnly(SPEC_ID);
    await new GetNextActionCommand().execute(ctx);
    const claim = await new RunClaimNextActionCommand().execute(ctx);
    assert.equal(claim.ok, true, JSON.stringify(claim));
    ctx.flowState = ctx.flowManager.loadReadOnly(SPEC_ID);
    writeFile(tmp, FIXTURE_PATH, "printf '%s\\n' 'TAP version 13' '1..1' 'ok 1 - repaired final pass'\n");
    await executeFinalRegression(ctx);

    const artifact = readFinalRegressionArtifact(ctx);
    assert.match(artifact.rawOutputPath, /steps\/final-regression\/attempt-002\.log$/);
    const firstLog = artifact.rawOutputPath.replace("attempt-002.log", "attempt-001.log");
    assert.ok(fs.existsSync(path.join(tmp, firstLog)));
    assert.ok(fs.existsSync(path.join(tmp, artifact.rawOutputPath)));
  });

  it("runs the project command only in the explicit execution authority root", async () => {
    tmp = createTmpDir("final-regression-execution-root-");
    const fixtureBody = failingFixtureBody("PROJECT_TEST_RAN");
    const ctx = setupProject(tmp, fixtureBody);
    const executionRoot = path.join(tmp, "execution-authority");
    fs.mkdirSync(executionRoot, { recursive: true });
    writeFile(executionRoot, FIXTURE_PATH, "printf '%s\\n' 'TAP version 13' '1..1' 'ok 1 - authority pass'\n");
    initGitRepo(executionRoot);
    commitAll(executionRoot, "execution authority");
    ctx.executionRoot = executionRoot;

    const result = await executeFinalRegression(ctx);

    assert.equal(result.result, "pass");
    const artifact = readFinalRegressionArtifact(ctx);
    const raw = fs.readFileSync(path.join(tmp, artifact.rawOutputPath), "utf8");
    assert.doesNotMatch(raw, /PROJECT_TEST_RAN/);
    assert.match(raw, /authority pass/);
  });
});
