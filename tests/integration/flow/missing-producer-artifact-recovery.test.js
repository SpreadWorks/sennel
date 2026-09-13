import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it, afterEach } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { emptySpecStub } from "../../../src/lib/spec-json.js";
import {
  CurrentAttempt,
  CurrentFlowSpecRecord,
  FlowActivity,
} from "../../../src/flow/lib/current-flow-state.js";
import { CanonicalFlowCreateRequest } from "../../../src/flow/lib/canonical-flow-manager-store.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunRecoverMissingProducerArtifactCommand from "../../../src/flow/lib/run-recover-missing-producer-artifact.js";
import RunSettleFailureCommand from "../../../src/flow/lib/run-settle-failure.js";
import { attachCanonicalCommandResultArtifact } from "../../../src/flow/lib/canonical-command-result.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { canonicalFixtureProducerResult } from "../../support/infrastructure/flow-setup.js";

const roots = [];
const execFileAsync = promisify(execFile);
const FLOW_MANAGER_MODULE = new URL("../../../src/lib/flow-manager.js", import.meta.url).href;

function root() {
  const value = createTmpDir("missing-producer-artifact-");
  roots.push(value);
  return value;
}

function request(specId = "001-missing-producer-artifact") {
  return new CanonicalFlowCreateRequest({
    specId,
    runId: "missing-producer-artifact-run",
    request: "Keep the request exactly as supplied.",
    execution: { mode: "direct" },
    policy: { autoApprove: false, nonblocking: null },
    flowId: "missing-producer-artifact-flow",
    flowVersionId: "missing-producer-artifact-flow-v1",
    specRecord: new CurrentFlowSpecRecord({ ...emptySpecStub(), tasks: [] }, { specId }),
  });
}

function leaves(nodes, values = []) {
  for (const node of nodes) {
    if (!node.children || node.children.length === 0) values.push(node);
    else leaves(node.children, values);
  }
  return values;
}

function advanceTo(manager, specId, nodeId) {
  const ordered = leaves(manager.load(specId).steps);
  const index = ordered.findIndex((node) => node.id === nodeId);
  for (const node of ordered.slice(0, index)) {
    manager.updateStepStatus({ stepId: node.id, requestedStatus: "in_progress" }, { specId });
    const canonicalCommandResult = canonicalFixtureProducerResult(manager.load(specId), node.id, { flowManager: manager });
    manager.updateStepStatus(
      { stepId: node.id, requestedStatus: "done" },
      { specId, ...(canonicalCommandResult === null ? {} : { canonicalCommandResult }) },
    );
  }
  manager.updateStepStatus({ stepId: nodeId, requestedStatus: "in_progress" }, { specId });
}

function toolingFailure(manager, specId) {
  manager.failCurrentAttempt({
    specId,
    failure: {
      category: "tooling",
      code: "REVIEW_EXECUTION_FAILED",
      message: "review provider failed before producing a result",
      retryable: true,
      retryKind: "tooling",
    },
    result: {
      outcome: "failed",
      summary: "review provider failed before producing a result",
      confirmedAt: "2026-08-20T00:00:00.000Z",
      artifactRefs: [],
    },
  });
}

function claimHistoricalSpecTriage(manager, specId) {
  const recorded = manager.canonicalState(specId);
  const triage = recorded.findNode("spec-triage");
  const attempt = new CurrentAttempt({
    id: "historical-triage-attempt",
    nodeId: "spec-triage",
    sequence: triage.attemptSequence + 1,
    startedAt: "2026-08-20T00:00:01.000Z",
    consumption: { semantic: 0, tooling: 0 },
    failure: null,
    blocker: null,
    incomplete: [],
    operationClaims: [{
      operation: "resolve-command-context",
      resources: recorded.definition.contractForNode(triage).resourceContract.required,
    }],
  });
  manager._store.runtime.startAttempt({
    specId,
    activityId: "historical-triage-claimed",
    nodeId: "spec-triage",
    attempt: attempt.toJSON(),
  });
  return attempt;
}

function commandContext(repository, manager, specId) {
  return {
    root: repository,
    mainRoot: repository,
    executionRoot: repository,
    specId,
    flowState: manager.load(specId),
    flowManager: manager,
    config: {},
  };
}

function directAttempt(state, nodeId) {
  const node = state.findNode(nodeId);
  return new CurrentAttempt({
    id: `historical-${nodeId}-attempt-${node.attemptSequence + 1}`,
    nodeId,
    sequence: node.attemptSequence + 1,
    startedAt: "2026-08-20T00:00:00.000Z",
    consumption: { semantic: 0, tooling: 0 },
    failure: null,
    blocker: null,
    incomplete: [],
    operationClaims: [{
      operation: "resolve-command-context",
      resources: state.definition.contractForNode(node).resourceContract.required,
    }],
  });
}

function rawAttemptActivity({ state, id, nodeId, operation, activityAttempt, transitionAttempt = null, result = null }) {
  const node = state.findNode(nodeId);
  const type = {
    start_attempt: "attempt_started",
    record_failure: "failure_recorded",
    recover_missing_producer_artifact: "recovery",
  }[operation];
  return new FlowActivity({
    id,
    nodeId: node.id,
    nodeKey: node.key,
    attemptId: activityAttempt.id,
    sequence: activityAttempt.sequence,
    confirmationOrder: state.confirmationOrder + 1,
    type,
    transition: {
      operation,
      nodeId: node.id,
      task: null,
      attempt: transitionAttempt?.toJSON() ?? null,
      status: null,
      policy: null,
      outbox: null,
      approval: null,
      nonblocking: null,
      finalizeSteps: null,
    },
    result,
    timing: null,
    failure: null,
    provider: null,
    model: null,
    effort: null,
    usage: null,
    references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
    metric: null,
    note: null,
    reviewPublication: null,
  });
}

function directArtifactlessAdvanceTo(manager, specId, nodeId) {
  const ordered = leaves(manager.load(specId).steps);
  const index = ordered.findIndex((node) => node.id === nodeId);
  assert.ok(index >= 0, `missing canonical fixture node: ${nodeId}`);
  for (const node of ordered.slice(0, index + 1)) {
    const state = manager.canonicalState(specId);
    const attempt = directAttempt(state, node.id);
    manager._store.runtime.startAttempt({
      specId,
      activityId: `historical-${node.id}-started-${attempt.sequence}`,
      nodeId: node.id,
      attempt: attempt.toJSON(),
    });
    if (node.id === nodeId) return;
    manager._store.runtime.confirmAttempt({
      specId,
      activityId: `historical-${node.id}-confirmed-${attempt.sequence}`,
      result: {
        outcome: "passed",
        summary: "Historical artifactless completion used only to model pre-admission persisted state.",
        confirmedAt: "2026-08-20T00:00:01.000Z",
        artifactRefs: [],
      },
    });
  }
}

function unchangedPersistentSnapshot(manager, specId) {
  return {
    state: manager.canonicalState(specId).toJSON(),
    catalog: manager.artifactCatalog(specId).toJSON(),
    activities: structuredClone(manager.activityLedger(specId)),
  };
}

afterEach(() => {
  while (roots.length > 0) removeTmpDir(roots.pop());
});

describe("missing producer artifact recovery", () => {
  it("does not let a retained prior spec-review result settle a later artifactless Attempt", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-prior-review-artifact"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "spec-review");
    manager.publishCurrentAttemptResult({
      specId: created.specId,
      commandResult: attachCanonicalCommandResultArtifact({ result: "first review" }, {
        logicalKey: "spec.review",
        payload: { verdict: "REJECTED", proposalCount: 1 },
      }),
    });
    toolingFailure(manager, created.specId);
    manager.retryCurrentAttempt({ specId: created.specId });
    toolingFailure(manager, created.specId);

    assert.throws(
      () => manager.settleCurrentFailure({ specId: created.specId }),
      (error) => error?.code === "CANONICAL_PRODUCER_ARTIFACT_NOT_READY",
    );
    assert.equal(manager.canonicalState(created.specId).attempt.sequence, 2);
    assert.equal(manager.canonicalState(created.specId).current.at(-1), "spec-review");
  });

  it("keeps an exhausted tooling failure on spec-review instead of claiming spec-triage", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "spec-review");
    assert.throws(
      () => manager.updateStepStatus({ stepId: "spec-review", requestedStatus: "done" }, { specId: created.specId }),
      (error) => error?.code === "CANONICAL_PRODUCER_ARTIFACT_NOT_READY",
    );
    assert.equal(manager.canonicalState(created.specId).current.at(-1), "spec-review");
    assert.equal(manager.canonicalState(created.specId).attempt.failure, null);
    toolingFailure(manager, created.specId);
    manager.retryCurrentAttempt({ specId: created.specId });
    toolingFailure(manager, created.specId);

    assert.throws(
      () => manager.settleCurrentFailure({ specId: created.specId }),
      (error) => error?.code === "CANONICAL_PRODUCER_ARTIFACT_NOT_READY",
    );
    const state = manager.canonicalState(created.specId);
    assert.equal(state.current.at(-1), "spec-review");
    assert.equal(state.attempt.failure.code, "REVIEW_EXECUTION_FAILED");
    assert.equal(state.findNode("spec-triage").status, "pending");
    const next = await new GetNextActionCommand().execute(commandContext(repository, manager, created.specId));
    assert.equal(next.directive.kind, "blocked");
    assert.equal(next.directive.code, "CANONICAL_PRODUCER_ARTIFACT_NOT_READY");
    assert.doesNotMatch(next.directive.resumeInstruction, /settle-failure/);
    const settlement = new RunSettleFailureCommand().execute(commandContext(repository, manager, created.specId));
    assert.equal(settlement.ok, false);
    assert.equal(settlement.errors[0].code, "CANONICAL_PRODUCER_ARTIFACT_NOT_READY");
  });

  it("refuses raw lifecycle Activities and artifact mutation options before they can bypass producer readiness", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-raw-activity-admission"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "spec-review");
    toolingFailure(manager, created.specId);
    manager.retryCurrentAttempt({ specId: created.specId });
    toolingFailure(manager, created.specId);

    const failed = manager.canonicalState(created.specId);
    const rawRecord = rawAttemptActivity({
      state: failed,
      id: "raw-record-failure",
      nodeId: "spec-review",
      operation: "record_failure",
      activityAttempt: failed.attempt,
      result: manager.activityLedger(created.specId).at(-1).result,
    });
    const beforeRecord = unchangedPersistentSnapshot(manager, created.specId);
    assert.throws(
      () => manager.applyActivity(rawRecord, { specId: created.specId }),
      (error) => error?.code === "CANONICAL_RAW_ACTIVITY_MUTATION_FORBIDDEN",
    );
    assert.deepEqual(unchangedPersistentSnapshot(manager, created.specId), beforeRecord);

    const existing = manager.activityLedger(created.specId).at(-1);
    const beforeArtifactOptions = unchangedPersistentSnapshot(manager, created.specId);
    assert.throws(
      () => manager.applyActivity(existing, { specId: created.specId, artifactWrites: [] }),
      (error) => error?.code === "CANONICAL_RAW_ACTIVITY_MUTATION_FORBIDDEN",
    );
    assert.deepEqual(unchangedPersistentSnapshot(manager, created.specId), beforeArtifactOptions);

    const beforeDivergentReplay = unchangedPersistentSnapshot(manager, created.specId);
    assert.throws(
      () => manager.applyActivity({ ...existing, provider: "untrusted-raw-replay" }, { specId: created.specId }),
      (error) => error?.code === "CANONICAL_RAW_ACTIVITY_MUTATION_FORBIDDEN",
    );
    assert.deepEqual(unchangedPersistentSnapshot(manager, created.specId), beforeDivergentReplay);

    // Model only the historical persisted state that the former raw public
    // API could create.  The public boundary must reject the same consumer
    // claim before Runtime transition handling can bypass its admission.
    manager._store.runtime.recordFailure({
      specId: created.specId,
      activityId: "historical-raw-boundary-recorded",
      result: existing.result,
    });
    const recorded = manager.canonicalState(created.specId);
    const rawStart = rawAttemptActivity({
      state: recorded,
      id: "raw-spec-triage-start",
      nodeId: "spec-triage",
      operation: "start_attempt",
      activityAttempt: directAttempt(recorded, "spec-triage"),
      transitionAttempt: directAttempt(recorded, "spec-triage"),
    });
    const beforeStart = unchangedPersistentSnapshot(manager, created.specId);
    assert.throws(
      () => manager.applyActivity(rawStart, { specId: created.specId }),
      (error) => error?.code === "CANONICAL_RAW_ACTIVITY_MUTATION_FORBIDDEN",
    );
    assert.deepEqual(unchangedPersistentSnapshot(manager, created.specId), beforeStart);

    const producer = new CurrentAttempt({
      ...directAttempt(recorded, "spec-review").toJSON(),
      id: "raw-producer-recovery",
      sequence: recorded.findNode("spec-review").attemptSequence,
      failure: {
        category: "tooling",
        code: "REVIEW_EXECUTION_FAILED",
        message: "historical producer failure",
        retryable: true,
        retryKind: "tooling",
      },
    });
    const rawRecovery = rawAttemptActivity({
      state: recorded,
      id: "raw-missing-producer-recovery",
      nodeId: "spec-review",
      operation: "recover_missing_producer_artifact",
      activityAttempt: producer,
      transitionAttempt: producer,
    });
    const beforeRecovery = unchangedPersistentSnapshot(manager, created.specId);
    assert.throws(
      () => manager.applyActivity(rawRecovery, { specId: created.specId }),
      (error) => error?.code === "CANONICAL_RAW_ACTIVITY_MUTATION_FORBIDDEN",
    );
    assert.deepEqual(unchangedPersistentSnapshot(manager, created.specId), beforeRecovery);
  });

  it("recovers a historical consumer claim with one append-only producer restoration Activity", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-recover-missing-producer-artifact"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "spec-review");
    toolingFailure(manager, created.specId);
    manager.retryCurrentAttempt({ specId: created.specId });
    toolingFailure(manager, created.specId);

    // This low-level operation models the pre-fix persisted state only; the
    // production manager now refuses this transition without readiness.
    const failureResult = manager.activityLedger(created.specId).at(-1).result;
    manager._store.runtime.recordFailure({
      specId: created.specId,
      activityId: "historical-failure-recorded",
      result: failureResult,
    });
    assert.throws(
      () => manager.updateStepStatus({ stepId: "spec-triage", requestedStatus: "in_progress" }, { specId: created.specId }),
      (error) => error?.code === "CANONICAL_PRODUCER_ARTIFACT_NOT_READY",
    );
    claimHistoricalSpecTriage(manager, created.specId);
    const before = manager.activityLedger(created.specId).length;

    const next = await new GetNextActionCommand().execute(commandContext(repository, manager, created.specId));
    assert.equal(next.directive.kind, "execute_command");
    assert.equal(next.directive.actionId, "RECOVER_MISSING_PRODUCER_ARTIFACT");
    assert.match(next.directive.nextAction, /sennel flow run recover-missing-producer-artifact/);
    const commandRecovered = new RunRecoverMissingProducerArtifactCommand()
      .execute(commandContext(repository, manager, created.specId));
    assert.equal(commandRecovered.ok, true);
    const recovered = manager.canonicalState(created.specId);
    assert.equal(recovered.current.at(-1), "spec-review");
    assert.equal(recovered.attempt.failure.code, "REVIEW_EXECUTION_FAILED");
    assert.equal(recovered.findNode("spec-triage").status, "invalidated");
    assert.equal(manager.activityLedger(created.specId).length, before + 1);
    assert.equal(manager.activityLedger(created.specId).at(-1).transition.operation, "recover_missing_producer_artifact");
    assert.throws(
      () => manager.recoverMissingProducerArtifact({ specId: created.specId }),
      /cannot reconstruct the recorded producer Attempt/,
      "the append-only recovery is idempotent: a stale repeat never adds a second Activity",
    );
    assert.equal(manager.activityLedger(created.specId).length, before + 1);

    // Crash/resume reconstructs exclusively from the immutable journal.  A
    // fresh manager must accept the recovery Activity rather than relying on
    // the in-memory state returned by the transition.
    const reloaded = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const resumed = reloaded.canonicalState(created.specId);
    assert.equal(resumed.current.at(-1), "spec-review");
    assert.equal(resumed.attempt.id, recovered.attempt.id);
    assert.equal(resumed.attempt.failure.code, "REVIEW_EXECUTION_FAILED");
  });

  it("recovers a record-to-claim crash without inventing a consumer Attempt", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-recover-record-claim-crash"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "spec-review");
    toolingFailure(manager, created.specId);
    manager.retryCurrentAttempt({ specId: created.specId });
    toolingFailure(manager, created.specId);

    const failureResult = manager.activityLedger(created.specId).at(-1).result;
    manager._store.runtime.recordFailure({
      specId: created.specId,
      activityId: "historical-failure-recorded-before-claim",
      result: failureResult,
    });
    const recorded = manager.canonicalState(created.specId);
    assert.equal(recorded.current, null);
    assert.equal(recorded.attempt, null);
    const before = manager.activityLedger(created.specId).length;

    const next = await new GetNextActionCommand().execute(commandContext(repository, manager, created.specId));
    assert.equal(next.directive.kind, "execute_command");
    assert.equal(next.directive.actionId, "RECOVER_MISSING_PRODUCER_ARTIFACT");
    const recovered = new RunRecoverMissingProducerArtifactCommand()
      .execute(commandContext(repository, manager, created.specId));
    assert.equal(recovered.ok, true);
    const restored = manager.canonicalState(created.specId);
    assert.equal(restored.current.at(-1), "spec-review");
    assert.equal(restored.attempt.failure.code, "REVIEW_EXECUTION_FAILED");
    assert.equal(restored.findNode("spec-triage").status, "pending");
    const recovery = manager.activityLedger(created.specId).at(-1);
    assert.equal(manager.activityLedger(created.specId).length, before + 1);
    assert.equal(recovery.transition.operation, "recover_missing_producer_artifact");
    assert.equal(recovery.attemptId, restored.attempt.id, "gap recovery binds its producer Attempt identity");
    assert.throws(
      () => manager.recoverMissingProducerArtifact({ specId: created.specId }),
      /cannot reconstruct the recorded producer Attempt/,
    );
    assert.equal(manager.activityLedger(created.specId).length, before + 1);

    const reloaded = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    assert.equal(reloaded.canonicalState(created.specId).attempt.id, restored.attempt.id);
  });

  it("recovers a historical consumer claim even after that consumer has failed", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-recover-failed-consumer"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "spec-review");
    toolingFailure(manager, created.specId);
    manager.retryCurrentAttempt({ specId: created.specId });
    toolingFailure(manager, created.specId);

    const failureResult = manager.activityLedger(created.specId).at(-1).result;
    manager._store.runtime.recordFailure({
      specId: created.specId,
      activityId: "historical-failure-recorded",
      result: failureResult,
    });
    claimHistoricalSpecTriage(manager, created.specId);
    toolingFailure(manager, created.specId);
    const claimed = manager.canonicalState(created.specId).attempt;
    assert.equal(claimed.nodeId, "spec-triage");
    assert.equal(claimed.failure.code, "REVIEW_EXECUTION_FAILED");

    const next = await new GetNextActionCommand().execute(commandContext(repository, manager, created.specId));
    assert.equal(next.directive.actionId, "RECOVER_MISSING_PRODUCER_ARTIFACT");
    const recovered = manager.recoverMissingProducerArtifact({ specId: created.specId });
    assert.equal(recovered.current.at(-1), "spec-review");
    assert.equal(recovered.attempt.failure.code, "REVIEW_EXECUTION_FAILED");
    assert.equal(recovered.findNode("spec-triage").status, "invalidated");
    const recovery = manager.activityLedger(created.specId).at(-1);
    assert.equal(recovery.transition.operation, "recover_missing_producer_artifact");
    assert.equal(recovery.attemptId, claimed.id, "the failed consumer identity is preserved in the recovery Activity");
  });

  it("allows only one competing process to append record-to-claim recovery", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-recover-concurrent-gap"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "spec-review");
    toolingFailure(manager, created.specId);
    manager.retryCurrentAttempt({ specId: created.specId });
    toolingFailure(manager, created.specId);
    manager._store.runtime.recordFailure({
      specId: created.specId,
      activityId: "historical-failure-recorded-concurrent",
      result: manager.activityLedger(created.specId).at(-1).result,
    });
    const script = [
      `import { FlowManager } from ${JSON.stringify(FLOW_MANAGER_MODULE)};`,
      `const manager=new FlowManager({root:${JSON.stringify(repository)},mainRoot:${JSON.stringify(repository)},inWorktree:false});`,
      `try { manager.recoverMissingProducerArtifact({specId:${JSON.stringify(created.specId)}}); process.stdout.write('recovered'); }`,
      "catch (error) { process.stderr.write(error.code || error.message); process.exitCode=1; }",
    ].join("");
    const attempts = await Promise.allSettled([
      execFileAsync(process.execPath, ["--input-type=module", "-e", script]),
      execFileAsync(process.execPath, ["--input-type=module", "-e", script]),
    ]);
    assert.equal(attempts.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((entry) => entry.status === "rejected").length, 1);
    const activities = manager.activityLedger(created.specId);
    assert.equal(activities.filter((activity) => activity.transition.operation === "recover_missing_producer_artifact").length, 1);
    const restored = manager.canonicalState(created.specId);
    assert.equal(restored.current.at(-1), "spec-review");
    assert.equal(restored.attempt.failure.code, "REVIEW_EXECUTION_FAILED");
  });

  it("keeps the spec-gate repair-to-spec transition atomic when draft.gate is absent", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-repair-plan-gate-missing-draft-gate"));
    manager.addActiveFlow(created.specId, "direct");
    // Model a persisted pre-admission lineage: the internal runtime can read
    // it, but the public Store must never allow its replacement consumer.
    directArtifactlessAdvanceTo(manager, created.specId, "spec-gate");
    manager.failCurrentAttempt({
      specId: created.specId,
      failure: {
        category: "semantic",
        code: "GATE_REJECTED",
        message: "The specification gate rejected the artifactless historical lineage.",
        retryable: true,
        retryKind: "semantic",
      },
      result: {
        outcome: "failed",
        summary: "The specification gate rejected the artifactless historical lineage.",
        confirmedAt: "2026-08-20T00:00:02.000Z",
        artifactRefs: [],
      },
    });
    const source = {
      issueLogId: "spec-gate-blocking-evidence",
      step: "spec-gate",
      phase: "spec",
      reason: "The specification gate found a blocking observation.",
      observations: [{
        kind: "violation",
        failureMode: "gate-failure",
        requirementRef: "R-1",
        where: { file: "spec.json" },
        observed: "The specification requires a correction.",
        severity: "blocking",
        refs: ["R-1"],
      }],
      timestamp: "2026-08-20T00:00:00.000Z",
    };
    const before = unchangedPersistentSnapshot(manager, created.specId);

    assert.throws(
      () => manager.repairPlanGate({
        specId: created.specId,
        record: {
          version: 1,
          runId: created.runId,
          specId: created.specId,
          issue: null,
          phase: "spec",
          targetStepId: "spec",
          sourceIssueLogId: source.issueLogId,
          sourceEntryDigest: "a".repeat(64),
          observations: source.observations,
          requestedAt: "2026-08-20T00:00:01.000Z",
        },
        issueLog: { entries: [source] },
      }),
      /plan gate repair version must be 2/,
    );
    assert.deepEqual(unchangedPersistentSnapshot(manager, created.specId), before);
  });

  it("keeps acceptance repair-to-impl-triage atomic when impl.review is absent", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-repair-acceptance-missing-impl-review"));
    manager.addActiveFlow(created.specId, "direct");
    // This is likewise a historical invalid lineage. The acceptance result
    // publication below must not make the replacement consumer claimable.
    directArtifactlessAdvanceTo(manager, created.specId, "acceptance-review");
    const commandResult = attachCanonicalCommandResultArtifact({
      result: "acceptance review requires an implementation repair",
      verdict: "repair_required",
    }, {
      logicalKey: "acceptance.review",
      payload: { verdict: "repair_required" },
    });
    const before = unchangedPersistentSnapshot(manager, created.specId);

    assert.throws(
      () => manager.repairAcceptanceReview({ specId: created.specId, commandResult }),
      (error) => error?.code === "CANONICAL_PRODUCER_ARTIFACT_NOT_READY"
        && error?.producerNodeId === "impl-review"
        && error?.consumerNodeId === "impl-triage",
    );
    assert.deepEqual(unchangedPersistentSnapshot(manager, created.specId), before);
  });
});
