import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { AgentTimeout } from "../../../src/lib/agent-timeout.js";
import { GIT_REPOSITORY_LOCATION_ENVIRONMENT } from "../../../src/lib/git-repository-environment.js";
import { container } from "../../../src/lib/container.js";
import {
  FlowArtifactAttemptHistory,
  FlowArtifactAttemptRecord,
} from "../../../src/lib/flow-artifact-contract.js";
import { CanonicalFlowCreateRequest, CanonicalFlowManagerStore } from "../../../src/flow/lib/canonical-flow-manager-store.js";
import {
  ActivityReviewPublication,
  CurrentAttempt,
  CurrentFlowSpecRecord,
  CurrentFlowState,
  CurrentFlowStateStore,
} from "../../../src/flow/lib/current-flow-state.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunClaimNextActionCommand from "../../../src/flow/lib/run-claim-next-action.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import {
  FLOW_DISPATCH_INVOCATION_ENV,
  FLOW_DISPATCH_INVOCATION_ID_ENV,
} from "../../../src/flow/lib/dispatch-invocation.js";
import RunFinalRegressionCommand from "../../../src/flow/lib/run-final-regression.js";
import RunReportCommand from "../../../src/flow/lib/run-report.js";
import RunReviewCommand, {
  TaskReviewCanonicalObservationBoundary,
  taskReviewRecoveryIgnoredDirectories,
} from "../../../src/flow/lib/run-review.js";
import GetStatusCommand from "../../../src/flow/lib/get-status.js";
import FlowReviewCommand from "../../../src/flow/commands/review.js";
import {
  REVIEW_WORK_UNIT_MANIFEST_ENV,
  reconcileCompletedReviewWorkUnits,
  ReviewWorkUnit,
  ReviewWorkUnitOutput,
} from "../../../src/flow/lib/review-work-unit.js";
import { attachedCanonicalReviewWorkUnit } from "../../../src/flow/lib/canonical-review-artifacts.js";
import SetReviewEvidenceCommand from "../../../src/flow/lib/set-review-evidence.js";
import RunRecoverReviewPassCommand from "../../../src/flow/lib/run-recover-review-pass.js";
import RunUpdateOverviewCommand from "../../../src/flow/lib/run-update-overview.js";
import RunGateCommand, { appendIssueLogFromGateResult, GateIssueLogEntry } from "../../../src/flow/lib/run-gate.js";
import { computeGitState } from "../../../src/lib/git-state.js";
import { CanonicalGatePromotion, canonicalGateRevision } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { readCurrentGateTransitionFacts } from "../../../src/flow/lib/gate-transition-facts.js";
import {
  resolveGateTransition,
  resolveNonGateTransition,
  resolveTaskExecutionOverrun,
  scenarioValidityTransitionDefinition,
  testExecuteTransitionDefinition,
} from "../../../src/flow/definition.js";
import RunRepairPlanGateCommand from "../../../src/flow/lib/run-repair-plan-gate.js";
import RunSettleFailureCommand from "../../../src/flow/lib/run-settle-failure.js";
import RunSettleReviewTransitionCommand from "../../../src/flow/lib/run-settle-review-transition.js";
import RunSettleGateTransitionCommand from "../../../src/flow/lib/run-settle-gate-transition.js";
import RunRepairTestReviewCommand from "../../../src/flow/lib/run-repair-test-review.js";
import RunScenarioValidityCommand from "../../../src/flow/lib/run-scenario-validity.js";
import RunTestExecuteCommand from "../../../src/flow/lib/run-test-execute.js";
import RunTestResultReviewCommand from "../../../src/flow/lib/run-test-result-review.js";
import RunAcceptanceReviewCommand, {
  AcceptanceReviewResponseSource,
  buildAcceptancePrompt,
} from "../../../src/flow/lib/run-acceptance-review.js";
import SetAcceptanceDecisionCommand from "../../../src/flow/lib/set-acceptance-decision.js";
import {
  attachCanonicalCommandResultArtifact,
  CanonicalCommandResultPublication,
  attachCanonicalCommandResultPublications,
  attachedCanonicalCommandResultArtifact,
  attachedCanonicalCommandResultPublications,
} from "../../../src/flow/lib/canonical-command-result.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { emptySpecStub } from "../../../src/lib/spec-json.js";
import {
  WorkerArtifactHandoffCoordinator,
  WorkerArtifactHandoffRequest,
  WorkerArtifactPublicationJournal,
  WorkerArtifactMutationAuthoritySnapshot,
  WorkerArtifactSemanticInputRevision,
  SourceMutationBaseline,
  SourceMutationManifest,
  WORKER_ARTIFACT_HANDOFF_REQUEST_ENV,
  SourceWorkerEffect,
  captureSourceMutationManifestForParent,
  sealParentMaterializedSourceWorkerEffect,
  sealWorkerArtifactHandoff,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import { captureCurrentTaskSource } from "../../../src/flow/lib/task-mutation-lineage.js";
import { canonicalPlanGateRepairForTarget, inspectCanonicalPlanGateRepair } from "../../../src/flow/lib/plan-gate-repair.js";
import RunRecoverTaskExecutionOverrunCommand from "../../../src/flow/lib/run-recover-task-execution-overrun.js";
import { readTaskExecutionOverrunFacts, readTaskExecutionOverrunFactsFromView } from "../../../src/flow/lib/task-execution-overrun.js";

function emptySourceMutationManifest(manager, specId) {
  return new SourceMutationManifest({
    attempt: manager.canonicalState(specId).attempt,
    baselineDigest: "a".repeat(64),
    mutations: [],
  });
}

function repairSourceMutationManifest(manager, specId, relativePath = "src/example.js") {
  const attempt = manager.canonicalState(specId).attempt;
  return new SourceMutationManifest({
    attempt,
    baselineDigest: "a".repeat(64),
    mutations: [{
      mutationId: SourceMutationManifest.mutationId(attempt, relativePath),
      path: relativePath,
      changeKind: "content",
      beforeDigest: "b".repeat(64),
      afterDigest: "c".repeat(64),
    }],
  });
}

function confirmTaskImplementationMutation({ repository, manager, specId, requirementId = "R-1", relativePath = "README.md", content }) {
  const baseline = SourceMutationBaseline.capture({
    root: repository,
    attempt: manager.canonicalState(specId).attempt,
  });
  fs.writeFileSync(path.join(repository, relativePath), content);
  const mutationManifest = SourceMutationManifest.capture({ baseline });
  manager.confirmSourceWorkerHandoff({
    specId,
    mutationManifest,
    handoffDigest: "c".repeat(64),
    effect: new SourceWorkerEffect({
      version: 1,
      stepId: "task-impl",
      completionStatus: "done",
      files: [{ requirementId, mutationIds: mutationManifest.mutations.map((entry) => entry.mutationId) }],
      issues: [],
      overview: { modules: [], data_flow: [], decisions: [] },
      triage: null,
      repair: null,
    }),
    result: {
      outcome: "passed",
      summary: "Fixture Task implementation changed one allow-listed source file.",
      confirmedAt: "2026-09-03T00:00:00.000Z",
      artifactRefs: [],
    },
  });
  manager.updateStepStatus(
    { stepId: "T-1-review", requestedStatus: "in_progress" },
    { specId },
  );
  return mutationManifest;
}

function currentTaskSourceFingerprint(manager, specId, taskId = "T-1") {
  return captureCurrentTaskSource({
    root: manager.executionRoot(),
    flowManager: manager,
    state: manager.loadReadOnly(specId),
    taskId,
  }).fingerprint;
}

function invalidTaskContextFacade(manager) {
  return new Proxy(manager, {
    get(target, property, receiver) {
      if (property === "readArtifact") {
        return (options) => {
          const resolved = target.readArtifact(options);
          if (options.logicalKey !== "spec.record") return resolved;
          const spec = JSON.parse(resolved.bytes.toString("utf8"));
          spec.requirements = spec.requirements.map(({ task_ids: _taskIds, ...requirement }) => requirement);
          return { ...resolved, bytes: Buffer.from(`${JSON.stringify(spec)}\n`) };
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
import {
  FlowOutboxIdentity,
  FlowOutboxRecoveryClaim,
  FlowOutboxRecoveryRequiredError,
  FlowOutboxStore,
} from "../../../src/flow/lib/flow-outbox.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import {
  completeTaskStageHandoff,
  createTaskStageHandoff,
} from "../../support/builders/task-review-scenario.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { validWorkerHandoffSpec } from "../../support/infrastructure/worker-artifact.js";
import {
  canonicalDraftDocument,
  canonicalFixtureProducerResult,
  confirmCanonicalFixtureStep,
  FlowAtStepFixture,
  TaskLifecycleFixture,
} from "../../support/infrastructure/flow-setup.js";
import { validateCanonicalUpgradeEvidence } from "../../../src/flow/lib/test-artifacts.js";
import { ReviewTargetAuthority } from "../../../src/flow/lib/review-target-authority.js";
import {
  CanonicalTestArtifactStore,
  CanonicalTestSourceProvenanceError,
  CanonicalTestSourceRevision,
} from "../../../src/flow/lib/canonical-test-artifacts.js";
import {
  CanonicalTestReviewRepair,
  TestReviewRepairFinding,
  TestReviewRepairScope,
  TestReviewRepairProgress,
  WorkerVisibleTestReviewRepair,
  canonicalTestReviewRepairProgress,
} from "../../../src/flow/lib/test-review-repair.js";
import { buildRepairFingerprint } from "../../../src/flow/lib/repair-fingerprint.js";
import { decisionContextForActiveFlow } from "../../../src/flow/lib/nonblocking.js";
import { readCurrentTestChainTransitionFacts } from "../../../src/flow/lib/test-chain-transition-facts.js";
import { findStepById } from "../../../src/flow/lib/step-tree.js";
import { ReviewFindingFingerprint } from "../../../src/flow/lib/finding-disposition-policy.js";
import {
  CanonicalSpecReview,
  SpecReviewDelta,
  mergeSpecReviewDelta,
} from "../../../src/flow/lib/spec-review-artifacts.js";

const roots = [];

function root() {
  const value = createTmpDir("canonical-flow-manager-");
  roots.push(value);
  return value;
}

function initializeReviewSource(rootPath) {
  fs.writeFileSync(path.join(rootPath, "README.md"), "review checkout fixture\n");
  initGitRepo(rootPath);
  commitAll(rootPath, "review source");
}

function canonicalTaskReviewFinding(finding) {
  const fingerprint = ReviewFindingFingerprint.fromFinding({
    ...finding,
    category: finding.failureMode,
    failureMode: finding.failureMode,
    requirementId: finding.requirementId,
    ...(finding.guardrailId ? { guardrailId: finding.guardrailId } : {}),
    file: finding.file || null,
    title: finding.title,
    issue: finding.issue,
  }).value;
  return {
    ...finding,
    findingId: fingerprint,
    fingerprint,
    repeatCount: Number.isSafeInteger(finding.repeatCount) ? finding.repeatCount : 1,
  };
}

async function publishTaskReview({ repository, manager, specId, blockingFindings = [] }) {
  const review = new RunReviewCommand({
    resolveTreeSha: () => "a".repeat(40),
    resolveTargetStateDigest: () => "b".repeat(64),
    runCommand(_command, _args, options) {
      const outputDirectory = options.env.SENNEL_REVIEW_OUTPUT_DIR;
      fs.writeFileSync(path.join(outputDirectory, "impl-review.json"), `${JSON.stringify({
        version: 1,
        phase: "impl",
        generatedAt: "2026-09-08T00:00:00.000Z",
        verdict: blockingFindings.length === 0 ? "PASS" : "REJECTED",
        summary: { blocking: blockingFindings.length, nonBlocking: 0, total: blockingFindings.length },
        blockingFindings,
        nonBlockingImprovements: [],
        excluded: { missingFile: 0, outOfScope: 0 },
      })}\n`);
      ReviewWorkUnit.fromEnvironment(options.env).seal();
      return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
    },
  });
  const ctx = {
    root: repository,
    mainRoot: repository,
    executionRoot: repository,
    specId,
    flowManager: manager,
    flowState: manager.load(specId),
    config: {},
  };
  const result = await review.execute(ctx);
  if (result.ok !== false) await FLOW_COMMANDS.run.review.post(ctx, result);
  return result;
}

function writeSpecReviewDeltaOutput(options, findings = []) {
  const outputDirectory = options.env.SENNEL_REVIEW_OUTPUT_DIR;
  const reviewSource = JSON.parse(options.env.SENNEL_REVIEW_SPEC_REVIEW_SOURCE);
  const review = new CanonicalSpecReview(JSON.parse(fs.readFileSync(reviewSource.sourcePath, "utf8")));
  const delta = new SpecReviewDelta({
    version: 2,
    stage: "spec-review",
    identity: review.identity.toJSON(),
    baseReviewDigest: review.digest,
    findings,
    operations: [],
  });
  fs.writeFileSync(path.join(outputDirectory, "review.delta.json"), `${JSON.stringify(delta.toJSON(), null, 2)}\n`);
}

function reviewPublicationWrite(review, stage) {
  const delta = new SpecReviewDelta({
    version: 2,
    stage,
    identity: review.identity.toJSON(),
    baseReviewDigest: review.digest,
    findings: [],
    operations: [],
  });
  const next = mergeSpecReviewDelta({ review, delta });
  return {
    next,
    write: {
      logicalKey: "spec.review",
      parameters: { revision: review.identity.revision.toString() },
      mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(next.toJSON(), null, 2)}\n`, "utf8"),
    },
  };
}

function noOpSpecReviewCommandResult(review) {
  const publication = reviewPublicationWrite(review, "spec-review");
  return attachCanonicalCommandResultPublications({
    result: "ok",
    artifacts: { phase: "spec", verdict: "PASS" },
  }, [new CanonicalCommandResultPublication({
    logicalKey: "spec.review",
    parameters: { revision: review.identity.revision.toString() },
    mediaType: "application/json",
    payload: JSON.parse(publication.write.bytes.toString("utf8")),
  })]);
}

function currentSpecRevisionAuthority(manager, specId) {
  const location = manager.specLocation(specId);
  const current = manager.readCurrentSpecReview({ specId, consumerNodeId: "spec-review" });
  const revisions = fs.readdirSync(location.resolve("revisions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9]{3,}$/.test(entry.name))
    .map((entry) => Number(entry.name));
  const revision = current?.revision ?? Math.max(...revisions);
  const revisionText = String(revision).padStart(3, "0");
  const root = fs.readFileSync(location.specFile);
  const snapshot = fs.readFileSync(location.artifact("spec.snapshot", { revision: revisionText }));
  assert.deepEqual(root, snapshot, "root spec.json must be byte-identical to its immutable current snapshot");
  if (current !== null) {
    assert.equal(current.review.identity.specId, specId);
    assert.equal(current.review.identity.revision.value, current.revision);
    assert.equal(current.review.identity.digest, crypto.createHash("sha256").update(root).digest("hex"));
    assert.equal(current.review.identity.byteLength, root.length);
    assert.equal(current.review.digest, current.descriptor.hash);
    assert.equal(current.descriptor.size, current.bytes.length);
  }
  return Object.freeze({
    revision,
    root: Buffer.from(root),
    snapshot: Buffer.from(snapshot),
    review: current?.review ?? null,
    descriptor: current?.descriptor ?? null,
  });
}

function assertSpecRevisionAdvanced(before, after) {
  assert.equal(after.revision, before.revision + 1, "a changed root Spec publication must create exactly one new revision");
  assert.notDeepEqual(after.root, before.root, "a revision increment requires changed root Spec bytes");
}

function rootSpecPublicationBytes(location, revision) {
  const currentRevision = String(revision).padStart(3, "0");
  return Object.freeze({
    root: fs.readFileSync(location.specFile),
    snapshot: fs.readFileSync(location.artifact("spec.snapshot", { revision: currentRevision })),
    review: fs.existsSync(location.artifact("spec.review", { revision: currentRevision }))
      ? fs.readFileSync(location.artifact("spec.review", { revision: currentRevision })) : null,
    state: fs.readFileSync(location.flowStateFile),
    activities: fs.readFileSync(location.activitiesFile),
    catalog: fs.readFileSync(location.catalogFile),
  });
}

function rejectedTestReviewCommand(onOutputDirectory) {
  return new RunReviewCommand({
    resolveTreeSha: () => "a".repeat(40),
    resolveTargetStateDigest: () => "b".repeat(64),
    runCommand(_command, _args, options) {
      const outputDirectory = options.env.SENNEL_REVIEW_OUTPUT_DIR;
      onOutputDirectory(outputDirectory, options.env);
      fs.writeFileSync(path.join(outputDirectory, "test-review.json"), `${JSON.stringify({
        version: 1,
        phase: "test",
        generatedAt: "2026-08-23T00:00:00.000Z",
        verdict: "REJECTED",
        coverageArtifact: "test-coverage.json",
        sourceTestArtifactRevision: JSON.parse(options.env.SENNEL_REVIEW_TEST_ARTIFACT_REVISION),
        blockingFindings: [{
          findingId: "test-review-finding",
          fingerprint: "f".repeat(64),
          summary: "The test omits a required behavior.",
        }],
        advisoryFindings: [],
      })}\n`);
      ReviewWorkUnit.fromEnvironment(options.env).seal();
      return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
    },
  });
}

function request(specId = "001-canonical-manager", overrides = {}) {
  return new CanonicalFlowCreateRequest({
    specId,
    runId: "canonical-manager-run",
    request: "Keep the request exactly as supplied.",
    execution: { mode: "direct" },
    policy: { autoApprove: false, nonblocking: null },
    flowId: "canonical-manager-flow",
    flowVersionId: "canonical-manager-flow-v1",
    specRecord: new CurrentFlowSpecRecord({ ...emptySpecStub(), tasks: [] }, { specId }),
    ...overrides,
  });
}

function taskRequest(specId = "001-canonical-manager", taskIds = ["T-1"]) {
  return request(specId, {
    specRecord: new CurrentFlowSpecRecord({
      ...emptySpecStub(),
      requirements: [{ id: "R-tasks", desc: "Exercise canonical Task persistence.", task_ids: taskIds }],
      tasks: [],
    }, { specId }),
  });
}

function canonicalDraftBytes(goal) {
  return Buffer.from(`${JSON.stringify(canonicalDraftDocument({ goal }), null, 2)}\n`, "utf8");
}

function runtimeLog(runId, sequence) {
  return {
    runId,
    sequence,
    attempt: 1,
    command: "flow run fixture",
    startedAt: "2026-08-13T00:00:00.000Z",
    endedAt: "2026-08-13T00:00:01.000Z",
    exitCode: 0,
  };
}

function leaves(nodes, values = []) {
  for (const node of nodes) {
    if (!node.children || node.children.length === 0) values.push(node);
    else leaves(node.children, values);
  }
  return values;
}

function advanceTo(manager, specId, nodeId, { onActive = null } = {}) {
  if (onActive !== null && typeof onActive !== "function") {
    throw new TypeError("canonical Flow advance onActive must be a function or null");
  }
  const ordered = leaves(manager.load(specId).steps);
  const targetIndex = ordered.findIndex((entry) => entry.id === nodeId);
  assert.ok(targetIndex >= 0, `missing canonical Flow node: ${nodeId}`);
  for (const entry of ordered.slice(0, targetIndex)) {
    manager.updateStepStatus({ stepId: entry.id, requestedStatus: "in_progress" }, { specId });
    onActive?.(entry.id);
    confirmFixtureStep(manager, entry.id, { specId });
  }
  manager.updateStepStatus({ stepId: nodeId, requestedStatus: "in_progress" }, { specId });
}

/**
 * A setup-only normal completion has the same primary result transaction as
 * a real producer. This keeps fixture progress from manufacturing an
 * impossible artifactless completed producer.
 */
function confirmFixtureStep(manager, stepId, opts = {}) {
  if (Object.hasOwn(opts, "canonicalCommandResult")) {
    return manager.updateStepStatus({ stepId, requestedStatus: "done" }, opts);
  }
  return confirmCanonicalFixtureStep(manager, opts.specId, stepId);
}

function attemptHistoryBytes(nodeId, logicalKey, payload, attempt = 1) {
  const history = new FlowArtifactAttemptHistory(Array.from({ length: attempt }, (_, index) => (
    new FlowArtifactAttemptRecord({
      attempt: index + 1,
      payload: {
        nodeId,
        outcome: "completed",
        result: { result: "ok" },
        artifact: { logicalKey, payload },
      },
    })
  )));
  return Buffer.from(`${JSON.stringify(history.toJSON(), null, 2)}\n`, "utf8");
}

function publishAttemptArtifact(manager, specId, nodeId, logicalKey, payload) {
  const attempt = manager.canonicalState(specId).attempt.sequence;
  manager.publishArtifacts({
    specId,
    nodeId,
    artifactWrites: [{
      logicalKey,
      mediaType: "application/json",
      bytes: attemptHistoryBytes(nodeId, logicalKey, payload, attempt),
    }],
  });
}

function integrationGateFixture(suffix) {
  const repository = root();
  const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
  const specId = `001-integration-gate-${suffix}`;
  const created = manager.createFresh(request(specId));
  manager.addActiveFlow(created.specId, "direct");
  advanceTo(manager, created.specId, "impl-gate", {
    onActive(stepId) {
      if (stepId !== "impl-review") return;
      publishAttemptArtifact(manager, created.specId, "impl-review", "impl.review", {
        version: 1,
        phase: "impl",
        generatedAt: "2026-01-02T03:04:05.000Z",
        runId: manager.load(created.specId).runId,
        taskId: null,
        planRewindAt: null,
        verdict: "PASS",
        summary: { blocking: 0, nonBlocking: 0, total: 0 },
        blockingFindings: [],
        nonBlockingImprovements: [],
        repairFingerprint: "a".repeat(64),
      });
    },
  });
  return { manager, repository, specId: created.specId };
}

function canonicalIdentity(state) {
  const value = state.toJSON();
  return {
    schemaRevision: value.schemaRevision,
    flowId: value.flowId,
    flowVersionId: value.flowVersionId,
    runId: value.runId,
    specId: value.specId,
    request: value.request,
    version: value.version,
    execution: value.execution,
  };
}

function catalogDescriptorReferences(catalog) {
  return catalog.toJSON().artifacts.map((artifact) => ({
    logicalKey: artifact.logicalKey,
    kind: artifact.kind,
    relativePath: artifact.relativePath,
    mediaType: artifact.mediaType,
    authority: artifact.authority,
    memberId: artifact.memberId,
    publicationStep: artifact.publicationStep,
    retention: artifact.retention,
  }));
}

function catalogArtifactReferences(catalog) {
  return catalogDescriptorReferences(catalog).map(({ publicationStep, ...reference }) => reference);
}

/** A production-API fixture for the V1 worker-owned test collection. */
function canonicalTestTreeHandoffScenario(specId, invocationId) {
  const repository = root();
  const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
  const created = manager.createFresh(request(specId, {
    specRecord: new CurrentFlowSpecRecord({ ...validWorkerHandoffSpec(), tasks: [] }, { specId }),
  }));
  manager.addActiveFlow(created.specId, "direct");
  advanceTo(manager, created.specId, "test");
  manager.publishArtifacts({
    specId: created.specId,
    nodeId: "test",
    artifactWrites: [{
      logicalKey: "tests.source",
      parameters: { testPath: "obsolete.test.js" },
      mediaType: "text/javascript",
      bytes: Buffer.from("// spec: R1\n", "utf8"),
    }],
  });
  const coordinator = new WorkerArtifactHandoffCoordinator();
  const context = {
    root: repository,
    mainRoot: repository,
    executionRoot: repository,
    specId: created.specId,
    flowManager: manager,
  };
  const handoff = coordinator.createRequest({
    ctx: context,
    state: manager.load(created.specId),
    invocation: {
      id: invocationId,
      target: { digest: "b".repeat(64) },
      action: { digest: "a".repeat(64), nextAction: { step: "test" } },
    },
  });
  return Object.freeze({ repository, manager, created, coordinator, context, handoff });
}

function writeCanonicalTestTreePayload(handoff) {
  const replacementPath = path.join(handoff.payloadPath("spec-tests"), "current.test.js");
  fs.writeFileSync(replacementPath, [
    "// spec: R1",
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    "",
    'test("R1: replaces the cataloged test collection", () => {',
    "  assert.equal(true, true);",
    "});",
    "",
  ].join("\n"));
}

function acceptanceInputWrites(manager, specId) {
  const location = manager.specLocation(specId);
  const executionRaw = Buffer.from("canonical acceptance test execution raw\n", "utf8");
  let repairFingerprint = null;
  const currentRepairFingerprint = () => {
    if (repairFingerprint === null) {
      repairFingerprint = buildRepairFingerprint({
        root: location.repositoryRoot,
        artifactRoot: location.repositoryRoot,
        specPath: location.relativeSpecFile,
      }).hash;
    }
    return repairFingerprint;
  };
  const testSourceRevision = () => new CanonicalTestArtifactStore({
    flowManager: manager,
    state: manager.load(specId),
  }).testSourceRevision().digest;
  const executionIdentity = () => {
    const execution = manager.readArtifact({
      specId,
      logicalKey: "test.execute",
      consumerNodeId: "test-result-review",
    });
    const activity = manager.activityLedger(specId).find((entry) => entry.id === execution.descriptor.activityId);
    return {
      historyAttempt: JSON.parse(execution.bytes.toString("utf8")).attempts.at(-1).attempt,
      producerActivityId: activity.id,
      attemptId: activity.attemptId,
      sequence: activity.sequence,
    };
  };
  return new Map([
    ["test", () => manager.publishArtifacts({ specId, nodeId: "test", artifactWrites: [{
      logicalKey: "tests.source", parameters: { testPath: "acceptance.fixture.test.js" }, mediaType: "text/javascript",
      bytes: Buffer.from("import test from 'node:test';\ntest('R-1: acceptance fixture', () => {});\n", "utf8"),
    }] })],
    ["scenario-validity", () => publishAttemptArtifact(manager, specId, "scenario-validity", "scenario.validity", {
      version: "1",
      testSourceRevision: testSourceRevision(),
      command: "node --test artifacts/tests/scenario.test.js",
      process: { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null },
      result: "pass",
      raw_output_path: location.relativeArtifact("scenario.validity.raw-log"),
      summary: [],
    })],
    ["test-execute", () => {
      manager.writeRuntimeArtifact({
        specId,
        nodeId: "test-execute",
        artifact: { logicalKey: "test.execute.raw-log", mediaType: "text/plain", bytes: executionRaw },
      });
      return publishAttemptArtifact(manager, specId, "test-execute", "test.execute", {
      version: "2",
      repairFingerprint: currentRepairFingerprint(),
      testSourceRevision: testSourceRevision(),
      rawEvidenceFingerprint: crypto.createHash("sha256").update(executionRaw).digest("hex"),
      process: { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null },
      raw_output_path: location.relativeArtifact("test.execute.raw-log"),
      summary: [],
      regression: { required: false, result: "skipped", mode: "none", category: "docs-only", reason: "fixture", classified_paths: [], trigger_relevant_changed_files: [], changed_files: [] },
      });
    }],
    ["test-result-review", () => {
      return publishAttemptArtifact(manager, specId, "test-result-review", "test.result.review", {
      verdict: "pass",
      checked_items: [{ check: "project_regression_verification", result: "pass", detail: "fixture regression evidence" }],
      result_file_path: location.relativeArtifact("test.execute"),
      raw_output_path: location.relativeArtifact("test.execute.raw-log"),
      repairFingerprint: currentRepairFingerprint(),
      testSourceRevision: testSourceRevision(),
      testExecute: executionIdentity(),
      rawEvidenceFingerprint: crypto.createHash("sha256").update(executionRaw).digest("hex"),
    });
    }],
    ["impl-review", () => publishAttemptArtifact(manager, specId, "impl-review", "impl.review", {
      version: 1,
      phase: "impl",
      verdict: "PASS",
      summary: "Canonical implementation review passed.",
      blockingFindings: [],
      nonBlockingImprovements: [],
      canonicalEvidence: { phase: "impl", disposition: "PASS", findings: [] },
    })],
    ["impl-gate", () => manager.publishCurrentAttemptResult({
      specId,
      commandResult: new CanonicalGatePromotion({
        state: manager.canonicalState(specId),
        phase: "integration",
        nodeId: "impl-gate",
      }).promote({
        result: "pass",
        artifacts: { issues: [], evaluations: [], observations: [] },
      }),
    })],
    ["retro", () => manager.publishArtifacts({
      specId,
      nodeId: "retro",
      artifactWrites: [{
      logicalKey: "retro",
      mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify({
        mode: "attempt-history",
        date: "2026-08-13T00:00:00.000Z",
        summary: { not_done: 0 },
        requirements: [{ id: "R-1", status: "done" }],
      }, null, 2)}\n`, "utf8"),
    }],
    })],
  ]);
}

class FixtureAcceptanceResponseSource extends AcceptanceReviewResponseSource {
  constructor(response) {
    super();
    this.response = structuredClone(response);
    this.contexts = [];
  }

  load(context) {
    this.contexts.push(structuredClone(context));
    return structuredClone(this.response);
  }
}

function acceptanceRiskReviewResult() {
  return attachCanonicalCommandResultArtifact({
    result: "ok",
    verdict: "user_decision_required",
  }, {
    logicalKey: "acceptance.review",
    payload: {
      version: 2,
      repairFingerprint: "a".repeat(64),
      mechanicalBlockers: [],
      hardBlockers: [],
      requirementJudgments: [{
        requirementId: "R-1",
        status: "notVerifiable",
        requestRefs: ["flow.request"],
        requirementRefs: ["spec.json#R-1"],
        diffRefs: [],
        repairRefs: ["acceptance:no-repair"],
        testRefs: [],
        missingEvidence: ["A deliberate acceptance-risk decision is required."],
      }],
      deferredFindings: [],
      userDecision: null,
      verdict: "user_decision_required",
    },
  });
}

async function beginAcceptanceRiskDecision({ manager, created, repository }) {
  advanceTo(manager, created.specId, "acceptance-review");
  const ctx = {
    root: repository,
    mainRoot: repository,
    executionRoot: repository,
    specId: created.specId,
    flowManager: manager,
    flowState: manager.load(created.specId),
  };
  await FLOW_COMMANDS.run["acceptance-review"].post(ctx, acceptanceRiskReviewResult());
  assert.equal(manager.load(created.specId).currentNodeId, "acceptance-decision");
  return ctx;
}

afterEach(() => {
  container.reset();
  for (const directory of roots.splice(0)) removeTmpDir(directory);
});

describe("FlowManager canonical Version-1 runtime", () => {
  it("records context reads through the same metric path inside and outside managed handoff workers", () => {
    const previous = process.env[WORKER_ARTIFACT_HANDOFF_REQUEST_ENV];
    const recorded = [];
    const ctx = {
      flowManager: {
        load() {
          return { steps: [{ id: "implement", status: "in_progress" }] };
        },
        incrementMetric(phase, counter) {
          recorded.push({ phase, counter });
        },
      },
    };
    try {
      process.env[WORKER_ARTIFACT_HANDOFF_REQUEST_ENV] = "/tmp/managed-handoff/request.json";
      FLOW_COMMANDS.get.context.post(ctx, { total: 1, entries: [{}] });
      assert.deepEqual(recorded, [{ phase: "impl", counter: "docsRead" }]);

      delete process.env[WORKER_ARTIFACT_HANDOFF_REQUEST_ENV];
      FLOW_COMMANDS.get.context.post(ctx, { total: 1, entries: [{}] });
      assert.deepEqual(recorded, [
        { phase: "impl", counter: "docsRead" },
        { phase: "impl", counter: "docsRead" },
      ]);
    } finally {
      if (previous === undefined) delete process.env[WORKER_ARTIFACT_HANDOFF_REQUEST_ENV];
      else process.env[WORKER_ARTIFACT_HANDOFF_REQUEST_ENV] = previous;
    }
  });

  it("resolves requirement, GLOBAL, locators, and invalid repair targets to safe spec-test surfaces", () => {
    const finding = (target) => new TestReviewRepairFinding({ findingId: `scope-${target}`, fingerprint: crypto.createHash("sha256").update(target).digest("hex"), target, requiredChange: "Repair the smallest test premise." });
    const uncovered = new TestReviewRepairScope({ finding: finding("R1"), testPaths: ["z.test.js", "a.test.js"] }).toJSON();
    assert.equal(uncovered.operation, "create");
    assert.match(uncovered.targetFiles[0], /^repair-[a-f0-9]{16}\.test\.js$/);
    assert.equal(new TestReviewRepairScope({ finding: finding("GLOBAL"), testPaths: [] }).toJSON().operation, "create");
    assert.equal(new TestReviewRepairScope({ finding: finding("a.test.js:line 3"), testPaths: ["a.test.js"] }).toJSON().targetFiles[0], "a.test.js");
    assert.equal(new TestReviewRepairScope({ finding: finding("a.test.js:R1"), testPaths: ["a.test.js"] }).toJSON().targetFiles[0], "a.test.js");
    assert.throws(() => new TestReviewRepairScope({ finding: finding("../product.js"), testPaths: [] }), /repair target/);
  });
  it("starts a new progress episode when retained progress belongs to an older review artifact", () => {
    const state = { schemaRevision: 3, runId: "repair-progress-run", specId: "repair-progress-spec" };
    const revision = { version: 1, runId: state.runId, specId: state.specId, stepId: "test", digest: "a".repeat(64), byteLength: 1, finalizedAt: "2026-08-01T00:00:00.000Z" };
    const finding = (findingId, fingerprint) => ({ findingId, fingerprint, target: "one.test.js", requiredChange: "Repair one assertion." });
    const previous = new CanonicalTestReviewRepair({ state, attempt: 1, artifactDigest: "b".repeat(64), evidenceId: "c".repeat(64), sourceTestRevision: revision, blockingFindings: [finding("old", "d".repeat(64))] });
    const current = new CanonicalTestReviewRepair({ state, attempt: 2, artifactDigest: "e".repeat(64), evidenceId: "f".repeat(64), sourceTestRevision: revision, blockingFindings: [finding("current", "1".repeat(64))] });
    const retained = TestReviewRepairProgress.start(previous);
    const progress = canonicalTestReviewRepairProgress({
      flowManager: { readArtifact() { return { bytes: Buffer.from(JSON.stringify(retained.toJSON())) }; } },
      state, repair: current, consumerNodeId: "test",
    });
    assert.equal(progress.nextFinding(current).findingId, "current");
    assert.equal(progress.complete, false);
  });
  it("fails closed for malformed retained test-review repair progress before resetting an episode", () => {
    const state = { schemaRevision: 3, runId: "repair-progress-run", specId: "repair-progress-spec" };
    const revision = { version: 1, runId: state.runId, specId: state.specId, stepId: "test", digest: "a".repeat(64), byteLength: 1, finalizedAt: "2026-08-01T00:00:00.000Z" };
    const finding = { findingId: "current", fingerprint: "1".repeat(64), target: "one.test.js", requiredChange: "Repair one assertion." };
    const current = new CanonicalTestReviewRepair({ state, attempt: 2, artifactDigest: "e".repeat(64), evidenceId: "f".repeat(64), sourceTestRevision: revision, blockingFindings: [finding] });
    const validOld = TestReviewRepairProgress.start(new CanonicalTestReviewRepair({
      state, attempt: 1, artifactDigest: "b".repeat(64), evidenceId: "c".repeat(64), sourceTestRevision: revision,
      blockingFindings: [{ ...finding, findingId: "old", fingerprint: "d".repeat(64) }],
    })).toJSON();
    for (const invalid of [
      { ...validOld, sourceArtifactDigest: "not-a-digest" },
      (() => { const copy = structuredClone(validOld); delete copy.sourceArtifactDigest; return copy; })(),
      { ...validOld, sourceTestRevision: { ...validOld.sourceTestRevision, stepId: "test-review" } },
      { ...validOld, entries: [{ ...validOld.entries[0], status: "done", handoff: { handoffDigest: "2".repeat(64) } }] },
    ]) {
      assert.throws(
        () => canonicalTestReviewRepairProgress({
          flowManager: { readArtifact() { return { bytes: Buffer.from(JSON.stringify(invalid)) }; } },
          state, repair: current, consumerNodeId: "test",
        }),
        /test review repair progress/,
      );
    }
    const staleCurrentBinding = { ...TestReviewRepairProgress.start(current).toJSON(), sourceEvidenceId: "9".repeat(64) };
    assert.throws(
      () => canonicalTestReviewRepairProgress({
        flowManager: { readArtifact() { return { bytes: Buffer.from(JSON.stringify(staleCurrentBinding)) }; } },
        state, repair: current, consumerNodeId: "test",
      }),
      /different canonical evidence/,
    );
  });
  it("creates, locates, and reloads only specs/<specId>/001/flow.json", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    const location = manager.specLocation(created.specId);

    assert.equal(manager.pathFor(created.specId), location.flowStateFile);
    assert.equal(location.relativeDirectory, `specs/${created.specId}/001`);
    assert.equal(fs.existsSync(location.flowStateFile), true);
    assert.equal(fs.existsSync(path.join(repository, "specs", created.specId, "flow.json")), false);
    assert.equal(fs.existsSync(path.join(location.directory, "flow-version.json")), false);
    assert.equal(fs.existsSync(location.activitiesFile), true);
    assert.equal(fs.existsSync(location.specFile), true);
    assert.equal(fs.existsSync(location.catalogFile), true);
    assert.equal(fs.existsSync(path.join(location.directory, ".runtime")), true);
    assert.equal(manager.readCurrentSpecReview({ specId: created.specId, consumerNodeId: "spec-review" }), null);
    assert.equal(fs.existsSync(location.artifact("spec.review", { revision: "001" })), false);
    assert.ok(leaves(created.steps).every((step) => step.status === "pending"));

    manager.addActiveFlow(created.specId, "direct");
    const loaded = manager.load();
    assert.equal(loaded.request, "Keep the request exactly as supplied.");
    assert.equal(loaded.schemaRevision, 3);
    assert.equal(loaded.execution.mode, "direct");
  });

  it("reuses a per-spec Version Store but replaces its directory authority after recreation", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const specId = "001-runtime-store-recreation";
    const created = manager.createFresh(request(specId));
    const first = manager._store.runtime.store(specId);

    assert.strictEqual(manager._store.runtime.store(specId), first);
    const location = manager.specLocation(created.specId);
    const directStore = new CurrentFlowStateStore({
      directory: location.directory,
      definition: manager._store.definition,
      runtimeLockLocation: location.runtimeLock("runtime.lock.current-flow-state"),
    });
    directStore.lock.acquire();
    try {
      assert.throws(
        () => manager._store.runtime.load(specId),
        (error) => error?.code === "CURRENT_FLOW_STATE_LOCK_REENTRANT"
          && error.lockStatus === "reentrant",
      );
    } finally {
      directStore.lock.release();
    }

    fs.rmSync(location.directory, { recursive: true, force: true });
    assert.throws(() => manager._store.runtime.load(specId), /authority|root does not exist/);

    const recreated = manager.createFresh(request(specId));
    const second = manager._store.runtime.store(specId);
    assert.notStrictEqual(second, first);
    assert.equal(recreated.specId, specId);
    assert.equal(manager._store.runtime.load(specId).confirmationOrder, 1);
  });

  it("publishes system-owned upgrade evidence through the Version catalog", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-upgrade-result"));
    manager.addActiveFlow(created.specId, "direct");
    const payload = {
      version: 1,
      command: "sennel upgrade",
      dryRun: false,
      exitCode: 0,
      result: "success-no-change",
      summary: { skills: { updated: 0, unchanged: 1, removed: 0 } },
      failureReason: null,
      checkedPaths: [],
    };

    manager.publishUpgradeResult({
      specId: created.specId,
      artifact: {
        logicalKey: "upgrade.result",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(payload)}\n`, "utf8"),
      },
    });

    const resolved = manager.readArtifact({
      specId: created.specId,
      logicalKey: "upgrade.result",
      consumerNodeId: "impl-gate",
    });
    assert.equal(resolved.relativePath, "steps/upgrade-result.json");
    assert.deepEqual(JSON.parse(resolved.bytes.toString("utf8")), payload);
  });

  it("rejects malformed system-owned upgrade evidence before catalog publication", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-upgrade-result-malformed"));
    manager.addActiveFlow(created.specId, "direct");

    assert.throws(
      () => manager.publishUpgradeResult({
        specId: created.specId,
        artifact: {
          logicalKey: "upgrade.result",
          mediaType: "application/json",
          bytes: Buffer.from("{ malformed JSON", "utf8"),
        },
      }),
      /canonical upgrade result must be JSON/,
    );
    assert.equal(manager.readArtifact({
      specId: created.specId,
      logicalKey: "upgrade.result",
      consumerNodeId: "impl-gate",
      optional: true,
    }), null);
  });

  it("validates cataloged upgrade evidence by logical key", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-upgrade-catalog-validation"));
    manager.addActiveFlow(created.specId, "direct");
    const state = manager.load(created.specId);
    const requiredPaths = ["src/skills/sennel.flow/SKILL.md"];
    const missing = validateCanonicalUpgradeEvidence({
      flowManager: manager,
      state,
      consumerNodeId: "impl-gate",
      currentRequiredPaths: requiredPaths,
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, "upgrade-result.json missing");

    manager.publishUpgradeResult({
      specId: created.specId,
      artifact: {
        logicalKey: "upgrade.result",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify({
          version: 1,
          command: "sennel upgrade",
          dryRun: false,
          exitCode: 0,
          result: "success-updated",
          summary: {},
          failureReason: null,
          checkedPaths: requiredPaths,
        })}\n`, "utf8"),
      },
    });

    assert.equal(validateCanonicalUpgradeEvidence({
      flowManager: manager,
      state: manager.load(created.specId),
      consumerNodeId: "impl-gate",
      currentRequiredPaths: requiredPaths,
    }).ok, true);
  });

  it("rejects dry-run upgrade evidence even when its checked paths match", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-upgrade-dry-run-evidence"));
    manager.addActiveFlow(created.specId, "direct");
    const requiredPaths = ["src/skills/sennel.flow/SKILL.md"];
    assert.throws(
      () => manager.publishUpgradeResult({
        specId: created.specId,
        artifact: {
          logicalKey: "upgrade.result",
          mediaType: "application/json",
          bytes: Buffer.from(`${JSON.stringify({
            version: 1,
            command: "sennel upgrade --dry-run",
            dryRun: true,
            exitCode: 0,
            result: "success-updated",
            summary: {},
            failureReason: null,
            checkedPaths: requiredPaths,
          })}\n`, "utf8"),
        },
      }),
      /must record a materialized upgrade/,
    );
    assert.equal(manager.readArtifact({
      specId: created.specId,
      logicalKey: "upgrade.result",
      consumerNodeId: "impl-gate",
      optional: true,
    }), null);
  });

  it("routes normal manager step transitions and Task addition through the Activity Store", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    manager.createFresh(taskRequest());
    manager.addActiveFlow("001-canonical-manager", "direct");

    manager.updateStepStatus({ stepId: "branch", requestedStatus: "in_progress" });
    confirmFixtureStep(manager, "branch");
    manager.updateStepStatus({ stepId: "prepare-spec", requestedStatus: "in_progress" });
    confirmFixtureStep(manager, "prepare-spec");
    const beforeTaskAdmission = currentSpecRevisionAuthority(manager, "001-canonical-manager");
    manager.addTask({
      id: "T-1",
      key: "implement-task",
      title: "Implement task",
      goal: "Verify canonical Task ownership.",
      origin: "plan",
      added_round: 0,
      status: "pending",
    });

    const location = manager.specLocation("001-canonical-manager");
    const state = manager.load();
    const task = state.tasks.find((entry) => entry.id === "T-1");
    const activities = fs.readFileSync(location.activitiesFile, "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));

    assert.equal(state.steps[0].children[0].status, "done");
    assert.deepEqual(task.steps.map((step) => step.id), ["T-1-impl", "T-1-review", "T-1-triage", "T-1-repair", "T-1-gate"]);
    assert.equal(activities.at(-1).transition.operation, "add_task");
    assert.equal(activities.at(-1).nodeId, "impl");
    const taskLocation = location.taskArtifactLocation("T-1");
    assert.equal(fs.existsSync(taskLocation.implDirectory), true);
    assert.equal(fs.existsSync(taskLocation.reviewDirectory), true);
    assert.equal(fs.existsSync(taskLocation.triageDirectory), true);
    assert.equal(fs.existsSync(taskLocation.repairDirectory), true);
    assert.equal(fs.existsSync(taskLocation.gateDirectory), true);
    const persistedSpec = JSON.parse(fs.readFileSync(location.specFile, "utf8"));
    assert.equal(persistedSpec.tasks[0].id, "T-1");
    assertSpecRevisionAdvanced(beforeTaskAdmission, currentSpecRevisionAuthority(manager, "001-canonical-manager"));

    const reloaded = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    assert.deepEqual(
      reloaded.load("001-canonical-manager").tasks.find((entry) => entry.id === "T-1").steps.map((step) => step.id),
      ["T-1-impl", "T-1-review", "T-1-triage", "T-1-repair", "T-1-gate"],
    );
    assert.equal(fs.existsSync(taskLocation.implDirectory), true);
    assert.equal(fs.existsSync(taskLocation.reviewDirectory), true);
    assert.equal(fs.existsSync(taskLocation.triageDirectory), true);
    assert.equal(fs.existsSync(taskLocation.repairDirectory), true);
    assert.equal(fs.existsSync(taskLocation.gateDirectory), true);
  });

  it("routes Task runtime metadata aliases to the active materialized child", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(taskRequest());
    manager.addActiveFlow(created.specId, "direct");
    confirmFixtureStep(manager, "branch");
    confirmFixtureStep(manager, "prepare-spec");
    manager.addTask({
      id: "T-1",
      key: "runtime-metadata-task",
      title: "Runtime metadata task",
      goal: "Resolve runtime metadata through a materialized Task child.",
      origin: "plan",
      added_round: 0,
      status: "pending",
    });

    const location = manager.specLocation(created.specId);
    const taskImplIndex = leaves(manager.load(created.specId).steps)
      .findIndex((step) => step.id === "T-1-impl");
    for (const step of leaves(manager.load(created.specId).steps).slice(0, taskImplIndex)) {
      if (step.status === "pending") confirmFixtureStep(manager, step.id);
    }
    manager.updateStepStatus({ stepId: "T-1-impl", requestedStatus: "in_progress" });
    manager.setStepRuntimeLog("task-impl", runtimeLog(created.runId, 1));
    confirmFixtureStep(manager, "T-1-impl");
    manager.updateStepStatus({ stepId: "T-1-review", requestedStatus: "in_progress" });
    manager.setStepRuntimeLog("task-review", runtimeLog(created.runId, 2));

    for (const [nodeId, sequence] of [["T-1-impl", 1], ["T-1-review", 2]]) {
      const record = JSON.parse(fs.readFileSync(
        path.join(location.directory, ".runtime", "step-metadata", `${nodeId}.json`),
        "utf8",
      ));
      assert.equal(record.nodeId, nodeId);
      assert.equal(record.sequence, sequence);
    }
    assert.equal(fs.existsSync(path.join(location.directory, ".runtime", "step-metadata", "task-impl.json")), false);
    assert.equal(fs.existsSync(path.join(location.directory, ".runtime", "step-metadata", "task-review.json")), false);
    assert.equal(fs.existsSync(path.join(location.directory, ".runtime", "step-metadata", "task-gate.json")), false);
  });

  it("runs the normal spec gate through the V1 catalog and confirms its result through the Store", async () => {
    const repository = root();
    const specRecord = {
      ...emptySpecStub(),
      goal: "Persist canonical gate output.",
      requirements: [{ id: "R-1", desc: "The gate result is cataloged.", task_ids: ["T-1"] }],
      acceptance_criteria: ["R-1 gate result is retained by its producer Step."],
      tasks: [],
    };
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-canonical-spec-gate", {
      specRecord: new CurrentFlowSpecRecord(specRecord, { specId: "001-canonical-spec-gate" }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    manager.addTask({
      id: "T-1",
      key: "canonical-gate-task",
      title: "Canonical gate task",
      goal: "Exercise the canonical gate.",
      test_strategy: "Validate the V1 gate result contract.",
      origin: "plan",
      added_round: 0,
      status: "pending",
    });
    const ordered = leaves(manager.load(created.specId).steps);
    const gateIndex = ordered.findIndex((entry) => entry.id === "spec-gate");
    assert.ok(gateIndex > 0);
    for (const entry of ordered.slice(0, gateIndex)) {
      confirmFixtureStep(manager, entry.id);
    }
    manager.updateStepStatus({ stepId: "spec-gate", requestedStatus: "in_progress" });
    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      phase: "spec",
      config: {},
      skipGuardrail: true,
      flowManager: manager,
      flowState: manager.load(created.specId),
    };

    const result = await new RunGateCommand().execute(ctx);
    assert.equal(result.result, "pass", JSON.stringify(result));
    await FLOW_COMMANDS.run.gate.post(ctx, result);

    const history = JSON.parse(manager.readArtifact({
      specId: created.specId,
      logicalKey: "spec.gate",
      consumerNodeId: "approval",
    }).bytes.toString("utf8"));
    assert.deepEqual(history.attempts.map((entry) => entry.attempt), [1]);
    assert.equal(history.attempts[0].artifact.payload.result, "pass");
    assert.equal(leaves(manager.load(created.specId).steps)
      .find((entry) => entry.id === "spec-gate").status, "done");
    const location = manager.specLocation(created.specId);
    assert.equal(fs.existsSync(path.join(location.directory, "spec-gate-result.json")), false);
    assert.equal(fs.existsSync(path.join(location.directory, "flow-version.json")), false);
  });

  it("publishes a non-pass gate Attempt without a legacy result/source sibling", async () => {
    const repository = root();
    fs.writeFileSync(path.join(repository, "README.md"), "canonical gate failure\n");
    initGitRepo(repository);
    commitAll(repository, "initial");
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-canonical-spec-gate-fail", {
      specRecord: new CurrentFlowSpecRecord({
        ...emptySpecStub(),
        requirements: [{ id: "R-1", desc: "Exercise the non-pass Task gate.", task_ids: ["T-1"] }],
        tasks: [],
      }, {
        specId: "001-canonical-spec-gate-fail",
      }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    manager.addTask({
      id: "T-1",
      key: "canonical-gate-fail-task",
      title: "Canonical gate failure task",
      goal: "Exercise non-pass persistence.",
      test_strategy: "Validate the V1 failure result contract.",
      origin: "plan",
      added_round: 0,
      status: "pending",
    });
    const ordered = leaves(manager.load(created.specId).steps);
    const gateIndex = ordered.findIndex((entry) => entry.id === "spec-gate");
    for (const entry of ordered.slice(0, gateIndex)) {
      confirmFixtureStep(manager, entry.id);
    }
    manager.updateStepStatus({ stepId: "spec-gate", requestedStatus: "in_progress" });
    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      phase: "spec",
      config: {},
      skipGuardrail: true,
      flowManager: manager,
      flowState: manager.load(created.specId),
    };

    const result = await new RunGateCommand().execute(ctx);
    assert.equal(result.result, "fail");
    await FLOW_COMMANDS.run.gate.post(ctx, result);

    const history = JSON.parse(manager.readArtifact({
      specId: created.specId,
      logicalKey: "spec.gate",
      consumerNodeId: "approval",
    }).bytes.toString("utf8"));
    assert.deepEqual(history.attempts.map((entry) => entry.attempt), [1]);
    assert.equal(history.attempts[0].artifact.payload.result, "fail");
    const facts = readCurrentGateTransitionFacts({
      flowManager: manager,
      flowState: manager.load(created.specId),
      phase: "spec",
    });
    assert.ok(facts);
    assert.equal(facts.result, "fail");
    // The fixture intentionally omits an AI semantic judgment. Its
    // structural Gate failure is a local input stop and must not consume the
    // semantic retry budget.
    assert.equal(facts.failure.category, "local");
    assert.equal(facts.failure.code, "GATE_LOCAL_INPUT_INVALID");
    assert.equal(facts.lineage.sourceFingerprint.length, 64);
    assert.equal(facts.lineage.canonicalFingerprint.length, 64);
    assert.equal(facts.lineage.sourceFingerprint, facts.lineage.canonicalFingerprint);
    assert.equal(facts.lineage.sourceRevisionFingerprint, null);
    assert.equal(facts.lineage.canonicalRevisionFingerprint, null);
    assert.equal(facts.integrityFailure, null);
    const reloadedManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const reloadedFacts = readCurrentGateTransitionFacts({
      flowManager: reloadedManager,
      flowState: reloadedManager.load(created.specId),
      phase: "spec",
    });
    assert.deepEqual(reloadedFacts.toJSON(), facts.toJSON());
    assert.deepEqual(
      resolveGateTransition(reloadedFacts).toJSON(),
      resolveGateTransition(facts).toJSON(),
    );
    const beforeBypassState = manager.canonicalState(created.specId).toJSON();
    const beforeBypassActivities = manager.activityLedger(created.specId);
    await assert.rejects(
      new RunGateCommand().execute({ ...ctx, flowState: manager.load(created.specId) }),
      /canonical gate admission rejected evaluation/,
    );
    assert.deepEqual(manager.canonicalState(created.specId).toJSON(), beforeBypassState);
    assert.deepEqual(manager.activityLedger(created.specId), beforeBypassActivities);
    assert.equal(leaves(manager.load(created.specId).steps)
      .find((entry) => entry.id === "spec-gate").status, "in_progress");
    const location = manager.specLocation(created.specId);
    assert.equal(fs.existsSync(path.join(location.directory, "spec-gate-result.json")), false);
    assert.equal(fs.existsSync(path.join(location.directory, "spec-gate-source.json")), false);
  });

  it("keeps a mechanically blocked acceptance review in its V1 Attempt while cataloging its evidence", async () => {
    const repository = root();
    fs.writeFileSync(path.join(repository, "README.md"), "canonical acceptance\n");
    initGitRepo(repository);
    commitAll(repository, "initial");
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-canonical-acceptance"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "acceptance-review");
    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
      flowState: manager.load(created.specId),
    };

    const result = await new RunAcceptanceReviewCommand().execute(ctx);
    assert.equal(result.verdict, "blocked");
    assert.equal(attachedCanonicalCommandResultArtifact(result).logicalKey, "acceptance.review");
    await FLOW_COMMANDS.run["acceptance-review"].post(ctx, result);

    const history = JSON.parse(manager.readArtifact({
      specId: created.specId,
      logicalKey: "acceptance.review",
      consumerNodeId: "final-regression",
    }).bytes.toString("utf8"));
    assert.deepEqual(history.attempts.map((entry) => entry.attempt), [1]);
    assert.equal(history.attempts[0].artifact.payload.verdict, "blocked");
    assert.equal(manager.load(created.specId).currentNodeId, "acceptance-review");
    const location = manager.specLocation(created.specId);
    assert.equal(fs.existsSync(path.join(location.directory, "acceptance-review.json")), false);
    assert.equal(fs.existsSync(path.join(location.directory, "steps", "acceptance-review", "result.json")), true);
  });

  it("keeps the acceptance worker evidence contract while rewinding from cataloged V1 inputs", async () => {
    const repository = root();
    fs.writeFileSync(path.join(repository, "README.md"), "canonical acceptance base\n");
    initGitRepo(repository);
    commitAll(repository, "initial");
    fs.writeFileSync(path.join(repository, "README.md"), "canonical acceptance changed\n");
    fs.writeFileSync(path.join(repository, "untracked-source.js"), "export const acceptanceInput = true;\n");
    const specId = "001-canonical-acceptance-contract";
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request(specId, {
      execution: { mode: "direct", baseBranch: "main" },
      specRecord: new CurrentFlowSpecRecord({
        ...emptySpecStub(),
        requirements: [{ id: "R-1", desc: "Canonical input stays stable." }],
        tasks: [],
      }, { specId }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    const inputs = acceptanceInputWrites(manager, created.specId);
    advanceTo(manager, created.specId, "acceptance-review", {
      onActive: (nodeId) => inputs.get(nodeId)?.(),
    });
    const source = new FixtureAcceptanceResponseSource({
      requirementJudgments: [{
        requirementId: "R-1",
        status: "notMet",
        requestRefs: ["flow.request"],
        requirementRefs: ["spec.json#R-1"],
        diffRefs: ["diff:README.md"],
        repairRefs: ["acceptance:no-repair"],
        testRefs: ["test-execute-result.json#R-1"],
        missingEvidence: [],
      }],
      deferredFindingDispositions: [],
    });
    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
      flowState: manager.load(created.specId),
    };

    const result = await new RunAcceptanceReviewCommand({ responseSource: source }).execute(ctx);
    assert.equal(result.verdict, "repair_required");
    assert.equal(source.contexts.length, 1);
    const [context] = source.contexts;
    assert.deepEqual(Object.keys(context.evidence), [
      "originalRequest",
      "requirements",
      "diff",
      "repairEvidence",
      "upgradeEvidence",
      "testEvidence",
      "reviewEvidence",
      "taskReviewHandoffs",
      "deferredFindings",
      "deferredFindingEvidence",
    ]);
    assert.deepEqual(context.evidence.taskReviewHandoffs, []);
    assert.match(context.evidence.diff, /diff --git a\/README\.md b\/README\.md/);
    assert.match(context.evidence.diff, /diff --git a\/untracked-source\.js b\/untracked-source\.js/);
    assert.equal(
      context.evidence.testEvidence["test-result-review.json"].result_file_path,
      `specs/${specId}/test-execute-result.json`,
    );
    assert.equal(
      context.evidence.testEvidence["test-result-review.json"].raw_output_path,
      `specs/${specId}/tests/.raw/test-execution.log`,
    );
    const prompt = buildAcceptancePrompt(context);
    const promptEvidence = JSON.parse(prompt.userPrompt.slice("## Acceptance Evidence\n".length));
    assert.deepEqual(Object.keys(promptEvidence), Object.keys(context.evidence));
    const durableExecution = JSON.parse(manager.readArtifact({
      specId: created.specId,
      logicalKey: "test.execute",
      consumerNodeId: "acceptance-review",
    }).bytes.toString("utf8"));
    assert.equal(
      durableExecution.attempts[0].artifact.payload.raw_output_path,
      manager.specLocation(created.specId).relativeArtifact("test.execute.raw-log"),
    );

    await FLOW_COMMANDS.run["acceptance-review"].post(ctx, result);
    const state = manager.load(created.specId);
    assert.equal(state.currentNodeId, "impl-triage");
    const next = await new GetNextActionCommand().execute({ ...ctx, flowState: state });
    assert.notEqual(next.directive?.actionId, "SETTLE_CANONICAL_FAILURE");
    assert.equal(leaves(state.steps).find((entry) => entry.id === "acceptance-review").status, "invalidated");
    const history = JSON.parse(manager.readArtifact({
      specId: created.specId,
      logicalKey: "acceptance.review",
      consumerNodeId: "acceptance-decision",
    }).bytes.toString("utf8"));
    assert.equal(history.attempts[0].artifact.payload.verdict, "repair_required");
    const transition = manager.activityLedger(created.specId).at(-1);
    assert.equal(transition.transition.operation, "repair_acceptance_review");
    assert.equal(transition.nodeId, "acceptance-review");
    assert.equal(transition.transition.attempt.nodeId, "impl-triage");
    assert.equal(transition.references.artifacts[0].label, "acceptance.review");
    const handoff = WorkerArtifactHandoffRequest.create({
      mainRoot: repository,
      executionRoot: repository,
      state,
      flowManager: manager,
      invocation: {
        id: "acceptance-repair-triage-invocation",
        action: {
          digest: crypto.createHash("sha256").update("acceptance-repair-triage").digest("hex"),
          nextAction: { step: "impl-triage", taskId: null },
        },
      },
    });
    assert.deepEqual(handoff.inputs.map((input) => input.name), ["spec.json", "acceptance-review.json", "approved-finding-exceptions.json"]);
    assert.notEqual(handoff.inputDigest, handoff.inputRevision);
  });

  it("binds every stable acceptance repair finding through sealed triage and journal reload", async () => {
    const repository = root();
    const specId = "001-canonical-acceptance-hard-blockers";
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request(specId, {
      specRecord: new CurrentFlowSpecRecord({
        ...emptySpecStub(),
        requirements: [{ id: "R-1", desc: "Repair all acceptance findings." }],
        tasks: [],
      }, { specId }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "acceptance-review");
    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
      flowState: manager.load(created.specId),
    };
    const hardBlockers = ["DF-acceptance-a", "DF-acceptance-b"].map((findingId) => ({
      findingId,
      sourceStep: "impl-review",
      sourceArtifact: "steps/impl/review/result.json",
      sourceFindingId: findingId,
      finalDisposition: "blocking",
      evidenceRefs: [`steps/impl/review/result.json#${findingId}`],
    }));
    const review = {
      version: 2,
      repairFingerprint: "a".repeat(64),
      mechanicalBlockers: [],
      hardBlockers,
      requirementJudgments: [{
        requirementId: "R-1",
        status: "notMet",
        requestRefs: ["flow.request"],
        requirementRefs: ["spec.json#R-1"],
        diffRefs: ["diff:README.md"],
        repairRefs: ["acceptance:no-repair"],
        testRefs: ["test-execute-result.json#R-1"],
        missingEvidence: [],
      }],
      deferredFindings: hardBlockers,
      userDecision: null,
      verdict: "repair_required",
    };
    await FLOW_COMMANDS.run["acceptance-review"].post(ctx, attachCanonicalCommandResultArtifact({
      result: "ok",
      verdict: "repair_required",
    }, { logicalKey: "acceptance.review", payload: review }));

    const state = manager.load(created.specId);
    assert.equal(state.currentNodeId, "impl-triage");
    const coordinator = new WorkerArtifactHandoffCoordinator({
      now: () => new Date("2026-08-18T00:00:00.000Z"),
    });
    const handoff = coordinator.createRequest({
      ctx,
      state,
      invocation: {
        id: "acceptance-hard-blocker-triage",
        action: {
          digest: crypto.createHash("sha256").update("acceptance-hard-blocker-triage").digest("hex"),
          nextAction: { step: "impl-triage", taskId: null },
        },
      },
    });
    assert.deepEqual(handoff.inputs.map((input) => input.name), ["spec.json", "acceptance-review.json", "approved-finding-exceptions.json"]);
    assert.deepEqual(handoff.inputs[1].document.hardBlockers.map((entry) => entry.findingId), [
      "DF-acceptance-a", "DF-acceptance-b",
    ]);
    const authority = WorkerArtifactMutationAuthoritySnapshot.capture(handoff);
    const effect = new SourceWorkerEffect({
      version: 1,
      stepId: "impl-triage",
      completionStatus: "done",
      requirements: [],
      files: [],
      issues: [],
      overview: null,
      triage: {
        version: 1,
        dispositions: [
          { findingKey: "requirement:R-1", disposition: "apply", basis: "repair-required", rationale: "The failed requirement needs an implementation repair." },
          { findingKey: "hard-blocker:DF-acceptance-a", disposition: "apply", basis: "repair-required", rationale: "The first canonical blocker requires repair." },
          { findingKey: "hard-blocker:DF-acceptance-b", disposition: "apply", basis: "repair-required", rationale: "The second canonical blocker requires repair." },
        ],
      },
      repair: null,
    });
    fs.writeFileSync(handoff.payloadPath("effects.json"), `${JSON.stringify(effect.toJSON(), null, 2)}\n`);
    captureSourceMutationManifestForParent({ request: handoff });
    sealParentMaterializedSourceWorkerEffect({ request: handoff, now: () => new Date("2026-08-18T00:00:01.000Z") });
    const reconciliation = coordinator.reconcile({ ctx, request: handoff, mutationAuthority: authority });
    assert.equal(reconciliation.completed, true);

    const reloadedManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const reloaded = reloadedManager.load(created.specId);
    assert.equal(reloaded.currentNodeId, "impl-repair");
    const triage = JSON.parse(reloadedManager.readArtifact({
      specId: created.specId,
      logicalKey: "impl.triage",
      consumerNodeId: "impl-repair",
    }).bytes.toString("utf8"));
    assert.deepEqual(triage.dispositions.map((entry) => entry.findingKey), [
      "requirement:R-1",
      "hard-blocker:DF-acceptance-a",
      "hard-blocker:DF-acceptance-b",
    ]);
    const route = reloadedManager.activityLedger(created.specId).findLast((activity) => (
      activity.transition.operation === "repair_acceptance_review"
    ));
    assert.ok(route);
    assert.equal(route.references.artifacts[0].label, "acceptance.review");
    const triageRoute = reloadedManager.activityLedger(created.specId).findLast((activity) => (
      activity.transition.operation === "triage_implementation_for_repair"
    ));
    assert.ok(triageRoute);
    assert.equal(triageRoute.nodeId, "impl-triage");
    assert.equal(triageRoute.transition.attempt.nodeId, "impl-repair");
    assert.notEqual(triageRoute.attemptId, triageRoute.transition.attempt.id);
  });

  it("uses fixed dual-identity source triage routes for applying and rejecting findings", () => {
    for (const scenario of [
      {
        disposition: "apply",
        operation: "triage_implementation_for_repair",
        target: "impl-repair",
        repairStatus: "in_progress",
      },
      {
        disposition: "reject",
        operation: "triage_implementation_no_repair",
        target: "impl-gate",
        repairStatus: "skipped",
      },
    ]) {
      const repository = root();
      const specId = `001-canonical-triage-${scenario.disposition}`;
      const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
      const created = manager.createFresh(request(specId, {
        specRecord: new CurrentFlowSpecRecord({ ...validWorkerHandoffSpec(), tasks: [] }, { specId }),
      }));
      manager.addActiveFlow(created.specId, "direct");
      advanceTo(manager, created.specId, "impl-triage");
      const handoffDigest = scenario.disposition === "apply" ? "a".repeat(64) : "b".repeat(64);
      manager.confirmSourceWorkerHandoff({
        specId: created.specId,
        effect: new SourceWorkerEffect({
          version: 1,
          stepId: "impl-triage",
          completionStatus: "done",
          files: [], issues: [], overview: null, repair: null,
          triage: {
            version: 1,
            dispositions: [{
              findingKey: "finding-1",
              disposition: scenario.disposition,
              basis: scenario.disposition === "apply" ? "repair-required" : "finding-invalid",
              rationale: "The canonical triage route has a fixed target.",
            }],
          },
        }),
        mutationManifest: emptySourceMutationManifest(manager, created.specId),
        handoffDigest,
        result: {
          outcome: "passed",
          summary: "Worker handoff confirmed for impl-triage.",
          confirmedAt: "2026-08-18T00:00:00.000Z",
          artifactRefs: [
            { kind: "worker-handoff", id: handoffDigest },
            { kind: "worker-handoff-request", id: "c".repeat(64) },
          ],
        },
      });
      const reloaded = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
      const state = reloaded.load(created.specId);
      assert.equal(state.currentNodeId, scenario.target, scenario.disposition);
      assert.equal(leaves(state.steps).find((entry) => entry.id === "impl-repair").status, scenario.repairStatus);
      const activity = reloaded.activityLedger(created.specId).at(-1);
      assert.equal(activity.transition.operation, scenario.operation);
      assert.equal(activity.nodeId, "impl-triage");
      assert.equal(activity.transition.attempt.nodeId, scenario.target);
      assert.notEqual(activity.attemptId, activity.transition.attempt.id);
    }
  });

  it("binds repaired implementation findings to their triage Activity before integration readiness", () => {
    const repository = root();
    initializeReviewSource(repository);
    const specId = "001-integration-repaired-readiness";
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request(specId, {
      specRecord: new CurrentFlowSpecRecord({ ...validWorkerHandoffSpec(), tasks: [] }, { specId }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    const finding = ({ findingKey, title, file }) => {
      const rawFinding = {
        findingKey, title, failureMode: "required_behavior", file,
        requirementId: "R1", guardrailId: null, issue: "Required behavior is absent.", suggestion: "Implement it.",
        disposition: "must-fix", rationale: "The accepted requirement is mandatory.",
      };
      const fingerprint = ReviewFindingFingerprint.fromFinding({
        ...rawFinding, scope: "flow", phase: "impl-review", taskId: null, category: rawFinding.failureMode,
      }).value;
      return { ...rawFinding, findingId: fingerprint, fingerprint };
    };
    const repairedFinding = finding({ findingKey: "repair-me", title: "Repair me", file: "src/example.js" });
    const rejectedFinding = finding({ findingKey: "do-not-repair", title: "Do not repair", file: "src/other.js" });
    const review = (findings, repairFingerprint = "a".repeat(64)) => ({
      version: 1, phase: "impl", generatedAt: "2026-01-02T03:04:05.000Z", runId: manager.load(specId).runId,
      taskId: null, planRewindAt: null, verdict: findings.length === 0 ? "PASS" : "REJECTED",
      summary: { blocking: findings.length, nonBlocking: 0, total: findings.length },
      blockingFindings: findings, nonBlockingImprovements: [], repairFingerprint,
    });
    const publishReReview = (findings, repairFingerprint) => {
      const history = JSON.parse(manager.readArtifact({
        specId, logicalKey: "impl.review", consumerNodeId: "impl-triage",
      }).bytes.toString("utf8"));
      history.attempts.push({
        attempt: manager.canonicalState(specId).attempt.sequence,
        nodeId: "impl-review",
        outcome: "completed",
        result: { result: "ok" },
        artifact: { logicalKey: "impl.review", payload: review(findings, repairFingerprint) },
      });
      manager.publishArtifacts({
        specId,
        nodeId: "impl-review",
        artifactWrites: [{
          logicalKey: "impl.review",
          mediaType: "application/json",
          bytes: Buffer.from(`${JSON.stringify(history, null, 2)}\n`, "utf8"),
        }],
      });
    };
    advanceTo(manager, specId, "impl-triage", {
      onActive(stepId) {
        if (stepId === "implement") manager.updateFileMap({ specId, requirementId: "R1", paths: ["src/example.js"] });
        if (stepId === "impl-review") publishAttemptArtifact(
          manager,
          specId,
          "impl-review",
          "impl.review",
          review([repairedFinding, rejectedFinding]),
        );
      },
    });
    manager.confirmSourceWorkerHandoff({
      specId,
      effect: new SourceWorkerEffect({
        version: 1, stepId: "impl-triage", completionStatus: "done", files: [], issues: [], overview: null, repair: null,
        triage: {
          version: 1,
          dispositions: [repairedFinding, rejectedFinding].map((entry) => ({
            findingKey: entry.findingKey,
            disposition: "apply",
            basis: "repair-required",
            rationale: "The finding requires a material implementation repair.",
          })),
        },
      }),
      mutationManifest: emptySourceMutationManifest(manager, specId),
      handoffDigest: "a".repeat(64),
      result: { outcome: "passed", summary: "triage", confirmedAt: "2026-08-18T00:00:00.000Z", artifactRefs: [] },
    });
    const firstRepairManifest = repairSourceMutationManifest(manager, specId);
    manager.confirmSourceWorkerHandoff({
      specId,
      effect: new SourceWorkerEffect({
        version: 1, stepId: "impl-repair", completionStatus: "done",
        files: [{ requirementId: "R1", mutationIds: [firstRepairManifest.mutations[0].mutationId] }],
        issues: [], overview: null, triage: null,
        repair: {
          version: 1,
          appliedFindingKeys: ["repair-me", "do-not-repair"],
          findingMutations: ["repair-me", "do-not-repair"].map((findingKey) => ({
            findingKey,
            mutationIds: [firstRepairManifest.mutations[0].mutationId],
          })),
          summary: "Applied the required implementation repairs.",
        },
      }),
      mutationManifest: firstRepairManifest,
      handoffDigest: "b".repeat(64),
      result: { outcome: "passed", summary: "repair", confirmedAt: "2026-08-18T00:01:00.000Z", artifactRefs: [] },
    });
    const settleThroughImplementationReview = (findings, repairFingerprint) => {
      const cycleLeaves = leaves(manager.load(specId).steps);
      const currentIndex = cycleLeaves.findIndex((entry) => entry.id === manager.load(specId).currentNodeId);
      const implReviewIndex = cycleLeaves.findIndex((entry) => entry.id === "impl-review");
      assert.ok(currentIndex >= 0 && implReviewIndex >= currentIndex);
      for (const entry of cycleLeaves.slice(currentIndex, implReviewIndex + 1)) {
        if (manager.load(specId).currentNodeId !== entry.id) {
          manager.updateStepStatus({ stepId: entry.id, requestedStatus: "in_progress" }, { specId });
        }
        if (entry.id === "impl-review") publishReReview(findings, repairFingerprint);
        confirmFixtureStep(manager, entry.id, { specId });
      }
    };
    settleThroughImplementationReview([repairedFinding, rejectedFinding], "b".repeat(64));
    assert.equal(manager.load(specId).currentNodeId, null);
    manager.updateStepStatus({ stepId: "impl-triage", requestedStatus: "in_progress" }, { specId });
    manager.confirmSourceWorkerHandoff({
      specId,
      effect: new SourceWorkerEffect({
        version: 1, stepId: "impl-triage", completionStatus: "done", files: [], issues: [], overview: null, repair: null,
        triage: {
          version: 1,
          dispositions: [
            { findingKey: "repair-me", disposition: "apply", basis: "repair-required", rationale: "The recurring finding still requires repair." },
            { findingKey: "do-not-repair", disposition: "reject", basis: "finding-invalid", rationale: "This recurring finding is not accepted for repair." },
          ],
        },
      }),
      mutationManifest: emptySourceMutationManifest(manager, specId),
      handoffDigest: "c".repeat(64),
      result: { outcome: "passed", summary: "recurring triage", confirmedAt: "2026-08-18T00:02:00.000Z", artifactRefs: [] },
    });
    assert.equal(manager.load(specId).currentNodeId, "impl-repair");
    const handoff = new WorkerArtifactHandoffCoordinator().createRequest({
      ctx: { root: repository, executionRoot: repository, mainRoot: repository, specId, flowManager: manager },
      state: manager.load(specId),
      invocation: {
        id: "recurring-impl-repair",
        target: { digest: "d".repeat(64) },
        action: { digest: "e".repeat(64), nextAction: { step: "impl-repair" } },
      },
    });
    const recurrenceInput = handoff.inputs.find((entry) => entry.name === "impl-review-recurrence.json");
    assert.deepEqual(
      recurrenceInput.document.entries.map((entry) => entry.findingKey),
      ["repair-me"],
      "the real impl-repair handoff must omit a recurring finding rejected by current triage",
    );
    const recurringRepairManifest = repairSourceMutationManifest(manager, specId);
    manager.confirmSourceWorkerHandoff({
      specId,
      effect: new SourceWorkerEffect({
        version: 1, stepId: "impl-repair", completionStatus: "done",
        files: [{ requirementId: "R1", mutationIds: [recurringRepairManifest.mutations[0].mutationId] }],
        issues: [], overview: null, triage: null,
        repair: {
          version: 1,
          appliedFindingKeys: ["repair-me"],
          findingMutations: [{ findingKey: "repair-me", mutationIds: [recurringRepairManifest.mutations[0].mutationId] }],
          summary: "Applied a different strategy for the recurring finding.",
          recurrenceResolutions: [{
            findingKey: "repair-me",
            fingerprint: repairedFinding.fingerprint,
            priorRepairInsufficiency: "The earlier implementation did not cover the repeated behavior.",
            repairStrategy: "Move the correction to the shared behavior boundary.",
          }],
        },
      }),
      mutationManifest: recurringRepairManifest,
      handoffDigest: "f".repeat(64),
      result: { outcome: "passed", summary: "recurring repair", confirmedAt: "2026-08-18T00:03:00.000Z", artifactRefs: [] },
    });
    const status = new GetStatusCommand().execute({
      root: repository,
      executionRoot: repository,
      mainRoot: repository,
      flowManager: manager,
      flowState: manager.load(specId),
    });
    assert.equal(status.implementationReviewConvergence.finalVerdict, "REJECTED");
    assert.deepEqual(
      status.implementationReviewConvergence.recurringFindings.map((entry) => entry.findingId).sort(),
      [repairedFinding.findingId, rejectedFinding.findingId].sort(),
      "public status remains readable after the latest recurring repair",
    );

    const repairedLeaves = leaves(manager.load(specId).steps);
    const currentIndex = repairedLeaves.findIndex((entry) => entry.id === manager.load(specId).currentNodeId);
    const implGateIndex = repairedLeaves.findIndex((entry) => entry.id === "impl-gate");
    for (const entry of repairedLeaves.slice(currentIndex, implGateIndex)) {
      if (manager.load(specId).currentNodeId !== entry.id) {
        manager.updateStepStatus({ stepId: entry.id, requestedStatus: "in_progress" }, { specId });
      }
      if (entry.id === "impl-review") publishReReview([], "c".repeat(64));
      confirmFixtureStep(manager, entry.id, { specId });
    }
    manager.updateStepStatus({ stepId: "impl-gate", requestedStatus: "in_progress" }, { specId });
    const result = new CanonicalGatePromotion({ state: manager.canonicalState(specId), phase: "integration", nodeId: "impl-gate" })
      .promote({ result: "pass", artifacts: {} });
    manager.publishCurrentAttemptResult({ specId, commandResult: result });
    const facts = readCurrentGateTransitionFacts({ flowManager: manager, flowState: manager.load(specId), phase: "integration" });
    const decision = resolveGateTransition(facts);
    assert.equal(facts.reviewReadiness.status, "ready");
    assert.equal(decision.disposition.operation, "pass");
    const triage = manager.artifactCatalog(specId).artifacts.find((entry) => entry.logicalKey === "impl.triage");
    const repair = manager.artifactCatalog(specId).artifacts.find((entry) => entry.logicalKey === "impl.repair");
    const reviewArtifact = manager.artifactCatalog(specId).artifacts.find((entry) => entry.logicalKey === "impl.review");
    const ledger = manager.activityLedger(specId);
    const triageActivity = ledger.find((entry) => entry.id === triage.activityId);
    const repairActivity = ledger.find((entry) => entry.id === repair.activityId);
    const reviewActivity = ledger.find((entry) => entry.id === reviewArtifact.activityId);
    const rejectedReviewActivity = ledger.find((entry) => (
      entry.nodeId === "impl-review" && entry.confirmationOrder < triageActivity.confirmationOrder
    ));
    assert.ok(rejectedReviewActivity);
    assert.equal(rejectedReviewActivity.nodeId, "impl-review");
    assert.equal(triageActivity.nodeId, "impl-triage");
    assert.equal(repairActivity.nodeId, "impl-repair");
    assert.equal(reviewActivity.nodeId, "impl-review");
    assert.ok(rejectedReviewActivity.confirmationOrder < triageActivity.confirmationOrder);
    assert.ok(triageActivity.confirmationOrder < repairActivity.confirmationOrder);
    assert.ok(repairActivity.confirmationOrder < reviewActivity.confirmationOrder);
    const reloaded = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const restored = resolveGateTransition(readCurrentGateTransitionFacts({ flowManager: reloaded, flowState: reloaded.load(specId), phase: "integration" }));
    assert.deepEqual(restored.plan.toJSON(), decision.plan.toJSON());
    assert.equal(restored.plan.action.identity.matches(decision.plan.action.identity), true);
  });

  it("records an explicit acceptance-risk decision without overwriting review evidence", async () => {
    const repository = root();
    const specId = "001-canonical-acceptance-decision";
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request(specId, {
      specRecord: new CurrentFlowSpecRecord({
        ...emptySpecStub(),
        requirements: [{ id: "R-1", desc: "An explicit decision remains durable." }],
        tasks: [],
      }, { specId }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    await beginAcceptanceRiskDecision({ manager, created, repository });

    const result = new SetAcceptanceDecisionCommand().execute({
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      choice: "accept_risk_and_continue",
      flowManager: manager,
      flowState: manager.load(created.specId),
    });
    assert.equal(Object.hasOwn(result, "next"), false);
    const reviewHistory = JSON.parse(manager.readArtifact({
      specId: created.specId,
      logicalKey: "acceptance.review",
      consumerNodeId: "acceptance-decision",
    }).bytes.toString("utf8"));
    const decisionHistory = JSON.parse(manager.readArtifact({
      specId: created.specId,
      logicalKey: "acceptance.decision",
      consumerNodeId: "final-regression",
    }).bytes.toString("utf8"));
    const issueLog = JSON.parse(manager.readArtifact({
      specId: created.specId,
      logicalKey: "issue.log",
      consumerNodeId: "final-regression",
    }).bytes.toString("utf8"));

    assert.deepEqual(reviewHistory.attempts.map((entry) => entry.attempt), [1]);
    assert.equal(reviewHistory.attempts[0].artifact.payload.userDecision, null);
    assert.equal(decisionHistory.attempts[0].artifact.payload.choice, "accept_risk_and_continue");
    assert.equal(issueLog.entries[0].step, "acceptance-decision");
    assert.equal(manager.load(created.specId).currentNodeId, "final-regression");
  });

  it("parks the canonical Flow after an explicit acceptance-risk abort", async () => {
    const repository = root();
    const specId = "001-canonical-acceptance-abort";
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request(specId, {
      specRecord: new CurrentFlowSpecRecord({
        ...emptySpecStub(),
        requirements: [{ id: "R-1", desc: "An abort remains durable." }],
        tasks: [],
      }, { specId }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    await beginAcceptanceRiskDecision({ manager, created, repository });

    const result = new SetAcceptanceDecisionCommand().execute({
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      choice: "abort",
      flowManager: manager,
      flowState: manager.load(created.specId),
    });

    assert.equal(Object.hasOwn(result, "next"), false);
    const state = manager.load(created.specId);
    assert.equal(state.lifecycle, "parked");
    assert.equal(state.currentNodeId, null);
    assert.equal(manager.restartFlow(created.specId).resumable, true);
    const decisions = JSON.parse(manager.readArtifact({
      specId: created.specId,
      logicalKey: "acceptance.decision",
      consumerNodeId: "final-regression",
    }).bytes.toString("utf8"));
    assert.equal(decisions.attempts[0].artifact.payload.choice, "abort");
    assert.equal(manager.artifactCatalog(created.specId).artifacts
      .some((entry) => entry.logicalKey === "issue.log"), false);
  });

  it("routes a passing canonical acceptance result through its no-op decision to final regression", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-canonical-acceptance-pass"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "acceptance-review");
    const result = attachCanonicalCommandResultArtifact({
      result: "ok",
      verdict: "pass",
    }, {
      logicalKey: "acceptance.review",
      payload: {
        version: 2,
        repairFingerprint: "b".repeat(64),
        mechanicalBlockers: [],
        hardBlockers: [],
        requirementJudgments: [],
        deferredFindings: [],
        userDecision: null,
        verdict: "pass",
      },
    });
    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
      flowState: manager.load(created.specId),
    };
    await FLOW_COMMANDS.run["acceptance-review"].post(ctx, result);

    const state = manager.load(created.specId);
    const decision = leaves(state.steps).find((entry) => entry.id === "acceptance-decision");
    assert.equal(decision.status, "done");
    assert.equal(state.currentNodeId, "final-regression");
    const history = JSON.parse(manager.readArtifact({
      specId: created.specId,
      logicalKey: "acceptance.review",
      consumerNodeId: "final-regression",
    }).bytes.toString("utf8"));
    assert.equal(history.attempts[0].artifact.payload.verdict, "pass");
  });

  it("rejects an artifactless no-op from an explicit acceptance-risk decision", async () => {
    const repository = root();
    const specId = "001-canonical-noop-risk-bypass";
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request(specId, {
      specRecord: new CurrentFlowSpecRecord({
        ...emptySpecStub(),
        requirements: [{ id: "R-1", desc: "An explicit decision cannot become a no-op." }],
        tasks: [],
      }, { specId }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    await beginAcceptanceRiskDecision({ manager, created, repository });

    assert.throws(
      () => manager.completeAcceptanceDecisionNoOp({ specId: created.specId }),
      (error) => error?.code === "CANONICAL_ACCEPTANCE_DECISION_NOOP_NOT_AUTHORIZED",
    );
    assert.throws(
      () => manager.updateStepStatus({ stepId: "acceptance-decision", requestedStatus: "done" }, { specId: created.specId }),
      (error) => error?.code === "CANONICAL_PRODUCER_ARTIFACT_NOT_READY",
    );
    assert.equal(manager.load(created.specId).currentNodeId, "acceptance-decision");
  });

  it("resumes a same-schema PASS no-op recorded before the final-regression claim", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-canonical-legacy-pass-noop"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "acceptance-review");
    const result = attachCanonicalCommandResultArtifact({ result: "ok", verdict: "pass" }, {
      logicalKey: "acceptance.review",
      payload: {
        version: 2,
        repairFingerprint: "c".repeat(64),
        mechanicalBlockers: [],
        hardBlockers: [],
        requirementJudgments: [],
        deferredFindings: [],
        userDecision: null,
        verdict: "pass",
      },
    });
    manager.publishCurrentAttemptResult({ specId: created.specId, commandResult: result });
    manager.confirmCurrentAttempt({ specId: created.specId });
    manager.updateStepStatus({ stepId: "acceptance-decision", requestedStatus: "in_progress" }, { specId: created.specId });
    manager._store.runtime.confirmAttempt({
      specId: created.specId,
      activityId: "same-schema-legacy-acceptance-noop",
      result: {
        outcome: "passed",
        summary: "legacy PASS acceptance no-op",
        confirmedAt: "2026-08-20T00:00:00.000Z",
        artifactRefs: [],
      },
      references: { evaluations: [], findings: [], repairs: [], artifacts: [] },
    });
    const interrupted = manager.canonicalState(created.specId);
    assert.equal(interrupted.current, null);
    assert.equal(interrupted.findNode("acceptance-decision").status, "done");

    const reloaded = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    reloaded.updateStepStatus({ stepId: "final-regression", requestedStatus: "in_progress" }, { specId: created.specId });
    assert.equal(reloaded.load(created.specId).currentNodeId, "final-regression");
  });

  it("routes test execution and result-review artifacts through V1 history and the transient raw contract", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "test-execute", {
      onActive(nodeId) {
        if (nodeId !== "test") return;
        manager.publishArtifacts({
          specId: created.specId,
          nodeId: "test",
          artifactWrites: [{
            logicalKey: "tests.source",
            parameters: { testPath: "runtime.fixture.test.js" },
            mediaType: "text/javascript",
            bytes: Buffer.from("import test from 'node:test';\ntest('runtime fixture', () => {});\n", "utf8"),
          }],
        });
      },
    });
    manager.writeRuntimeArtifact({
      nodeId: "test-execute",
      artifact: {
        logicalKey: "test.execute.raw-log",
        mediaType: "text/plain",
        bytes: "[sennel] test execution diagnostic\\n",
      },
    });
    const repairFingerprint = buildRepairFingerprint({
      root: repository,
      artifactRoot: repository,
      specPath: manager.specLocation(created.specId).relativeSpecFile,
    });
    const testSourceRevision = new CanonicalTestArtifactStore({
      flowManager: manager,
      state: manager.load(created.specId),
    }).testSourceRevision().digest;
    const executionArtifact = {
      version: "2",
      repairFingerprint: repairFingerprint.hash,
      testSourceRevision,
      rawEvidenceFingerprint: crypto.createHash("sha256").update("[sennel] test execution diagnostic\\n").digest("hex"),
      process: { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null },
      raw_output_path: manager.specLocation(created.specId).relativeArtifact("test.execute.raw-log"),
      summary: [],
      regression: {
        required: false,
        result: "skipped",
        mode: "none",
        category: "docs-only",
        reason: "no executable project regression is required",
        classified_paths: [],
        trigger_relevant_changed_files: [],
        changed_files: [],
      },
    };
    const executionResult = attachCanonicalCommandResultArtifact({
      result: "ok",
      artifacts: { completed: true },
    }, { logicalKey: "test.execute", payload: executionArtifact });
    const executeCtx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      phase: "test-execute",
      flowManager: manager,
      flowState: manager.load(created.specId),
    };
    await FLOW_COMMANDS.run["test-execute"].post(executeCtx, executionResult);
    assert.equal(attachedCanonicalCommandResultArtifact(executionResult).logicalKey, "test.execute");
    const executionHistory = JSON.parse(manager.readArtifact({
      specId: created.specId,
      logicalKey: "test.execute",
      consumerNodeId: "test-result-review",
    }).bytes.toString("utf8"));
    assert.deepEqual(executionHistory.attempts.map((entry) => entry.attempt), [1]);
    assert.equal(executionHistory.attempts[0].artifact.payload.version, "2");

    manager.updateStepStatus({ stepId: "test-result-review", requestedStatus: "in_progress" });
    const reviewCtx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      phase: "test-result-review",
      flowManager: manager,
      flowState: manager.load(created.specId),
    };
    const reviewResult = await new RunTestResultReviewCommand().execute(reviewCtx);
    const reviewAttachment = attachedCanonicalCommandResultArtifact(reviewResult);
    assert.equal(reviewAttachment.logicalKey, "test.result.review");
    assert.equal(reviewAttachment.payload.verdict, "pass");
    assert.deepEqual(reviewResult.changed, [manager.specLocation(created.specId).relativeArtifact("test.result.review")]);
    await FLOW_COMMANDS.run["test-result-review"].post(reviewCtx, reviewResult);
    const reviewHistory = JSON.parse(manager.readArtifact({
      specId: created.specId,
      logicalKey: "test.result.review",
      consumerNodeId: "impl-review",
    }).bytes.toString("utf8"));
    assert.deepEqual(reviewHistory.attempts.map((entry) => entry.attempt), [1]);
    assert.equal(reviewHistory.attempts[0].artifact.payload.verdict, "pass");
    assert.equal(fs.existsSync(path.join(manager.specLocation(created.specId).directory, "test-result-review.md")), false);
  });

  it("projects Definition's partial test-execute block without mutating canonical state", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "test-execute", {
      onActive(nodeId) {
        if (nodeId !== "test") return;
        manager.publishArtifacts({
          specId: created.specId,
          nodeId: "test",
          artifactWrites: [{
            logicalKey: "tests.source",
            parameters: { testPath: "partial.fixture.test.js" },
            mediaType: "text/javascript",
            bytes: Buffer.from("import test from 'node:test';\ntest('partial fixture', () => {});\n", "utf8"),
          }],
        });
      },
    });
    const testSourceRevision = new CanonicalTestArtifactStore({
      flowManager: manager,
      state: manager.load(created.specId),
    }).testSourceRevision().digest;
    const partialResult = attachCanonicalCommandResultArtifact({ result: "ok", artifacts: {} }, {
      logicalKey: "test.execute",
      payload: {
        version: "2",
        repairFingerprint: "a".repeat(64),
        testSourceRevision,
        rawEvidenceFingerprint: crypto.createHash("sha256").update("").digest("hex"),
        process: { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null },
        raw_output_path: manager.specLocation(created.specId).relativeArtifact("test.execute.raw-log"),
        summary: [],
        regression: {
          required: false, result: "skipped", mode: "none", category: "docs-only",
          reason: "partial fixture", classified_paths: [], changed_files: [], trigger_relevant_changed_files: [],
        },
      },
    });
    const fresh = await new GetNextActionCommand().execute({
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
      flowState: manager.load(created.specId),
      config: {},
    });
    assert.equal(fresh.directive.kind, "execute_step");
    manager.publishCurrentAttemptResult({ specId: created.specId, commandResult: partialResult });
    const before = {
      state: manager.canonicalState(created.specId).toJSON(),
      activities: manager.activityLedger(created.specId),
      catalog: manager.artifactCatalog(created.specId).toJSON(),
    };
    const next = await new GetNextActionCommand().execute({
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
      flowState: manager.load(created.specId),
      config: {},
    });
    assert.equal(next.directive.kind, "blocked");
    assert.equal(next.directive.code, "TEST_CHAIN_EVIDENCE_BLOCKED");
    assert.equal(next.definitionTransition.operation, "blocked");
    assert.equal(next.definitionTransition.reason, "partial_completion");
    assert.deepEqual({
      state: manager.canonicalState(created.specId).toJSON(),
      activities: manager.activityLedger(created.specId),
      catalog: manager.artifactCatalog(created.specId).toJSON(),
    }, before);
  });

  it("publishes an injected spec-local spawn failure through RunTestExecuteCommand.run", async () => {
    const repository = root();
    fs.writeFileSync(path.join(repository, "README.md"), "test execute command fixture\n");
    initGitRepo(repository);
    commitAll(repository, "fixture baseline");
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-test-execute-public-boundary"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "test-execute", {
      onActive(nodeId) {
        if (nodeId !== "test") return;
        manager.publishArtifacts({ specId: created.specId, nodeId: "test", artifactWrites: [{
          logicalKey: "tests.source", parameters: { testPath: "spawn.fixture.test.js" }, mediaType: "text/javascript",
          bytes: Buffer.from("import test from 'node:test';\ntest('spawn fixture', () => {});\n", "utf8"),
        }] });
      },
    });
    const outputDirectory = path.join(repository, ".sennel", "output");
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(path.join(outputDirectory, "analysis.json"), "{}\n");
    const services = new Map([
      ["paths", { root: repository }], ["flowManager", manager], ["mainRoot", repository],
      ["config", {}], ["inWorktree", false],
    ]);
    const fakeContainer = { get(name) { return services.get(name); }, has(name) { return services.has(name); } };
    const command = new RunTestExecuteCommand({
      runSpecLocal: async () => ({
        command: "node --test", noTestsDeclared: true,
        result: { started: false, exitCode: null, signal: null, timedOut: false, spawnError: "ENOENT: node unavailable", stdout: "", stderr: "" },
      }),
    });
    const result = await command.run(fakeContainer, {});
    const attached = attachedCanonicalCommandResultArtifact(result);
    assert.equal(attached.logicalKey, "test.execute");
    assert.equal(attached.payload.process.spawnError, "ENOENT: node unavailable");
    assert.match(attached.payload.rawEvidenceFingerprint, /^[a-f0-9]{64}$/);
    await FLOW_COMMANDS.run["test-execute"].post({
      root: repository, mainRoot: repository, executionRoot: repository, specId: created.specId,
      flowManager: manager, flowState: manager.load(created.specId), config: {},
    }, result);
    const state = manager.canonicalState(created.specId);
    assert.equal(state.nextAction().operation, "blocked");
    assert.equal(state.attempt.consumption.semantic, 0);
  });

  it("blocks a raw replacement after test-execute publication without mutating canonical state", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-test-execute-raw-replacement"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "test-execute", {
      onActive(nodeId) {
        if (nodeId !== "test") return;
        manager.publishArtifacts({ specId: created.specId, nodeId: "test", artifactWrites: [{
          logicalKey: "tests.source", parameters: { testPath: "raw-replacement.fixture.test.js" }, mediaType: "text/javascript",
          bytes: Buffer.from("import test from 'node:test';\ntest('raw replacement fixture', () => {});\n", "utf8"),
        }] });
      },
    });
    const revision = new CanonicalTestArtifactStore({ flowManager: manager, state: manager.load(created.specId) }).testSourceRevision().digest;
    const initialRaw = Buffer.from("initial canonical raw\n", "utf8");
    manager.writeRuntimeArtifact({ specId: created.specId, nodeId: "test-execute", artifact: {
      logicalKey: "test.execute.raw-log", mediaType: "text/plain", bytes: initialRaw,
    } });
    manager.publishCurrentAttemptResult({ specId: created.specId, commandResult: attachCanonicalCommandResultArtifact({ result: "ok", artifacts: {} }, {
      logicalKey: "test.execute", payload: {
        version: "2",
        repairFingerprint: buildRepairFingerprint({ root: repository, artifactRoot: repository, specPath: manager.specLocation(created.specId).relativeSpecFile }).hash,
        testSourceRevision: revision,
        rawEvidenceFingerprint: crypto.createHash("sha256").update(initialRaw).digest("hex"),
        process: { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null },
        raw_output_path: manager.specLocation(created.specId).relativeArtifact("test.execute.raw-log"), summary: [],
        regression: { required: false, result: "skipped", mode: "none", category: "docs-only", reason: "fixture", classified_paths: [], changed_files: [], trigger_relevant_changed_files: [] },
      },
    }) });
    manager.writeRuntimeArtifact({ specId: created.specId, nodeId: "test-execute", artifact: {
      logicalKey: "test.execute.raw-log", mediaType: "text/plain", bytes: Buffer.from("replacement canonical raw\n", "utf8"),
    } });
    const facts = readCurrentTestChainTransitionFacts({ flowManager: manager, specId: created.specId });
    assert.equal(facts.integrityFailure, "stale_execute_raw_fingerprint");
    const decision = resolveNonGateTransition(facts, testExecuteTransitionDefinition);
    assert.equal(decision.disposition.operation, "blocked");
    assert.deepEqual(decision.plan.actions, []);
    const before = { state: manager.canonicalState(created.specId).toJSON(), activities: manager.activityLedger(created.specId), catalog: manager.artifactCatalog(created.specId).toJSON() };
    const next = await new GetNextActionCommand().execute({
      root: repository, mainRoot: repository, executionRoot: repository, specId: created.specId,
      flowManager: manager, flowState: manager.load(created.specId), config: {},
    });
    assert.equal(next.directive.code, "TEST_CHAIN_EVIDENCE_BLOCKED");
    assert.equal(next.definitionTransition.reason, "stale_execute_raw_fingerprint");
    assert.deepEqual({ state: manager.canonicalState(created.specId).toJSON(), activities: manager.activityLedger(created.specId), catalog: manager.artifactCatalog(created.specId).toJSON() }, before);
  });

  it("persists Definition-owned review retry, exhaustion, tooling block, and scenario repair routes", async () => {
    const setup = (specId, target = "test-execute", versionStoreFaultInjector = null) => {
      const repository = root();
      const manager = new FlowManager({
        root: repository,
        mainRoot: repository,
        inWorktree: false,
        versionStoreFaultInjector,
      });
      const created = manager.createFresh(request(specId));
      manager.addActiveFlow(created.specId, "direct");
      advanceTo(manager, created.specId, target, {
        onActive(nodeId) {
          if (nodeId !== "test") return;
          manager.publishArtifacts({ specId: created.specId, nodeId: "test", artifactWrites: [{
            logicalKey: "tests.source", parameters: { testPath: "definition-route.test.js" }, mediaType: "text/javascript",
            bytes: Buffer.from("import test from 'node:test';\ntest('definition route', () => {});\n", "utf8"),
          }] });
        },
      });
      const testSourceRevision = new CanonicalTestArtifactStore({ flowManager: manager, state: manager.load(created.specId) }).testSourceRevision().digest;
      const raw = Buffer.from("definition route raw evidence\n", "utf8");
      if (target === "test-execute") {
        manager.writeRuntimeArtifact({ specId: created.specId, nodeId: "test-execute", artifact: {
          logicalKey: "test.execute.raw-log", mediaType: "text/plain", bytes: raw,
        } });
      }
      const repairFingerprint = buildRepairFingerprint({ root: repository, artifactRoot: repository, specPath: manager.specLocation(created.specId).relativeSpecFile }).hash;
      return { repository, manager, created, testSourceRevision, raw, repairFingerprint };
    };
    const executionResult = ({ manager, created, testSourceRevision, repairFingerprint, raw }, process = { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null }) => attachCanonicalCommandResultArtifact({ result: "ok", artifacts: {} }, {
      logicalKey: "test.execute", payload: {
        version: "2", repairFingerprint, testSourceRevision,
        rawEvidenceFingerprint: crypto.createHash("sha256").update(raw).digest("hex"),
        process,
        raw_output_path: manager.specLocation(created.specId).relativeArtifact("test.execute.raw-log"), summary: [],
        regression: { required: false, result: "skipped", mode: "none", category: "docs-only", reason: "fixture", classified_paths: [], changed_files: [], trigger_relevant_changed_files: [] },
      },
    });
    const contextFor = ({ repository, manager, created }, phase) => ({ root: repository, mainRoot: repository, executionRoot: repository,
      specId: created.specId, phase, flowManager: manager, flowState: manager.load(created.specId), config: {} });
    const scenarioBlockResult = ({ manager, created }) => attachCanonicalCommandResultArtifact({ result: "block", artifacts: {} }, {
      logicalKey: "scenario.validity",
      payload: {
        version: "1",
        testSourceRevision: new CanonicalTestArtifactStore({
          flowManager: manager,
          state: manager.load(created.specId),
        }).testSourceRevision().digest,
        command: "node --test",
        process: { started: true, exitCode: 1, signal: null, timedOut: false, spawnError: null }, result: "block",
        raw_output_path: manager.specLocation(created.specId).relativeArtifact("scenario.validity.raw-log"),
        summary: [{ id: "R1", classification: "invalid_test", evidence: {
          test_file: "fixture.test.js", test_name: "R1: fixture", command: "node --test", raw_output_lines: { start_line: 1, end_line: 1 },
        } }],
      },
    });

    const retries = setup("001-test-chain-retry-routes");
    await FLOW_COMMANDS.run["test-execute"].post(contextFor(retries, "test-execute"), executionResult(retries));
    for (let sequence = 1; sequence <= 3; sequence += 1) {
      if (sequence === 1) {
        retries.manager.updateStepStatus({ stepId: "test-result-review", requestedStatus: "in_progress" }, { specId: retries.created.specId });
      }
      const source = retries.manager.readArtifact({ specId: retries.created.specId, logicalKey: "test.execute", consumerNodeId: "test-result-review" });
      const sourceActivity = retries.manager.activityLedger(retries.created.specId).find((entry) => entry.id === source.descriptor.activityId);
      const review = attachCanonicalCommandResultArtifact({ result: "ok", artifacts: {} }, { logicalKey: "test.result.review", payload: {
        verdict: "fail", checked_items: [
          { check: "summary_evidence", result: "fail", detail: "fixture failure" },
          { check: "project_regression_verification", result: "pass", detail: "fixture regression evidence" },
        ], invalid_reason: "fixture failure",
        result_file_path: retries.manager.specLocation(retries.created.specId).relativeArtifact("test.execute"),
        raw_output_path: retries.manager.specLocation(retries.created.specId).relativeArtifact("test.execute.raw-log"),
        repairFingerprint: retries.repairFingerprint, testSourceRevision: retries.testSourceRevision,
        testExecute: { historyAttempt: 1, producerActivityId: sourceActivity.id, attemptId: sourceActivity.attemptId, sequence: sourceActivity.sequence },
        rawEvidenceFingerprint: crypto.createHash("sha256").update(retries.raw).digest("hex"),
      } });
      await FLOW_COMMANDS.run["test-result-review"].post(contextFor(retries, "test-result-review"), review);
      const state = retries.manager.canonicalState(retries.created.specId);
      if (sequence < 3) {
        assert.equal(state.nextAction().operation, "retry");
        retries.manager.beginNextAction(retries.created.specId);
      } else {
        assert.equal(state.nextAction().operation, "blocked");
        assert.equal(state.attempt.failure.retryable, false);
        assert.equal(state.attempt.failure.code, "TEST_CHAIN_RETRY_EXHAUSTED");
      }
    }

    const tooling = setup("001-test-chain-tooling-route");
    const toolingResult = executionResult(tooling, { started: false, exitCode: null, signal: null, timedOut: false, spawnError: "ENOENT" });
    await FLOW_COMMANDS.run["test-execute"].post(contextFor(tooling, "test-execute"), toolingResult);
    const toolingState = tooling.manager.canonicalState(tooling.created.specId);
    assert.equal(toolingState.nextAction().operation, "blocked");
    assert.equal(toolingState.attempt.consumption.semantic, 0);

    const repair = setup("001-scenario-repair-route", "scenario-validity");
    repair.manager.writeRuntimeArtifact({ specId: repair.created.specId, nodeId: "scenario-validity", artifact: {
      logicalKey: "scenario.validity.raw-log", mediaType: "text/plain", bytes: Buffer.from("R1 invalid scenario\n", "utf8"),
    } });
    const scenario = scenarioBlockResult(repair);
    await FLOW_COMMANDS.run["scenario-validity"].post(contextFor(repair, "scenario-validity"), scenario);
    const repairedState = repair.manager.canonicalState(repair.created.specId);
    assert.equal(repairedState.current.at(-1), "test");
    assert.equal(repairedState.nextAction().operation, "resume");
    assert.deepEqual(repairedState.attempt.consumption.toJSON(), { semantic: 0, tooling: 0 });
    assert.equal(repair.manager.activityLedger(repair.created.specId).at(-1).transition.operation, "repair_scenario_validity");
    assert.equal(repair.manager.readArtifact({
      specId: repair.created.specId, logicalKey: "issue.log", consumerNodeId: "test",
    }) !== null, true);

    let failScenarioSettlement = true;
    const interrupted = setup("001-scenario-repair-atomicity", "scenario-validity", ({ phase, activity }) => {
      if (failScenarioSettlement && phase === "activity-appended"
        && activity.transition.operation === "repair_scenario_validity") {
        throw new Error("simulated scenario settlement interruption");
      }
    });
    interrupted.manager.writeRuntimeArtifact({ specId: interrupted.created.specId, nodeId: "scenario-validity", artifact: {
      logicalKey: "scenario.validity.raw-log", mediaType: "text/plain", bytes: Buffer.from("R1 interrupted scenario\n", "utf8"),
    } });
    const interruptedResult = scenarioBlockResult(interrupted);
    await assert.rejects(
      FLOW_COMMANDS.run["scenario-validity"].post(contextFor(interrupted, "scenario-validity"), interruptedResult),
      /simulated scenario settlement interruption/,
    );
    const afterInterruptedSettlement = interrupted.manager.canonicalState(interrupted.created.specId);
    assert.equal(afterInterruptedSettlement.current.at(-1), "scenario-validity");
    assert.equal(afterInterruptedSettlement.attempt.failure, null);
    assert.equal(interrupted.manager.readArtifact({
      specId: interrupted.created.specId, logicalKey: "issue.log", consumerNodeId: "scenario-validity", optional: true,
    }), null);
    assert.equal(interrupted.manager.activityLedger(interrupted.created.specId).some((activity) => (
      activity.transition.operation === "repair_scenario_validity"
    )), false);

    failScenarioSettlement = false;
    const interruptedFacts = readCurrentTestChainTransitionFacts({
      flowManager: interrupted.manager, specId: interrupted.created.specId,
    });
    const interruptedDecision = resolveNonGateTransition(interruptedFacts, scenarioValidityTransitionDefinition);
    interrupted.manager.applyTestChainTransitionDecision({
      specId: interrupted.created.specId,
      decision: interruptedDecision,
    });
    const settledActivityCount = interrupted.manager.activityLedger(interrupted.created.specId).length;
    interrupted.manager.applyTestChainTransitionDecision({
      specId: interrupted.created.specId,
      decision: interruptedDecision,
    });
    assert.equal(interrupted.manager.activityLedger(interrupted.created.specId).length, settledActivityCount);
    assert.equal(interrupted.manager.canonicalState(interrupted.created.specId).current.at(-1), "test");
    assert.equal(interrupted.manager.readArtifact({
      specId: interrupted.created.specId, logicalKey: "issue.log", consumerNodeId: "test",
    }) !== null, true);

    const restarted = setup("001-test-chain-restarted-attempt", "scenario-validity");
    for (let episode = 1; episode <= 4; episode += 1) {
      restarted.manager.writeRuntimeArtifact({ specId: restarted.created.specId, nodeId: "scenario-validity", artifact: {
        logicalKey: "scenario.validity.raw-log", mediaType: "text/plain",
        bytes: Buffer.from(`R1 restarted scenario episode ${episode}\n`, "utf8"),
      } });
      const result = scenarioBlockResult(restarted);
      if (episode === 4) {
        restarted.manager.publishCurrentAttemptResult({ specId: restarted.created.specId, commandResult: result });
        const restartedFacts = readCurrentTestChainTransitionFacts({
          flowManager: restarted.manager,
          specId: restarted.created.specId,
        });
        assert.ok(restartedFacts.currentAttempt.sequence > 3);
        assert.equal(restarted.manager.canonicalState(restarted.created.specId).attempt.consumption.semantic, 0);
        assert.equal(restartedFacts.retry.used, 1);
        restarted.manager.applyTestChainTransitionDecision({
          specId: restarted.created.specId,
          decision: resolveNonGateTransition(restartedFacts, scenarioValidityTransitionDefinition),
        });
        break;
      }
      await FLOW_COMMANDS.run["scenario-validity"].post(contextFor(restarted, "scenario-validity"), result);
      restarted.manager.publishArtifacts({ specId: restarted.created.specId, nodeId: "test", artifactWrites: [{
        logicalKey: "tests.source",
        parameters: { testPath: "definition-route.test.js" },
        mediaType: "text/javascript",
        bytes: Buffer.from(`import test from 'node:test';\ntest('definition route ${episode}', () => {});\n`, "utf8"),
      }] });
      confirmFixtureStep(restarted.manager, "test", { specId: restarted.created.specId });
      restarted.manager.updateStepStatus({ stepId: "scenario-validity", requestedStatus: "in_progress" }, {
        specId: restarted.created.specId,
      });
    }
    assert.equal(restarted.manager.canonicalState(restarted.created.specId).current.at(-1), "test");

    const advisory = setup("001-test-chain-nonblocking-route", "scenario-validity");
    advisory.manager.activateNonblockingPolicy({ specId: advisory.created.specId, policy: {
      enabled: true, activatedAt: "2026-08-24T00:00:00.000Z", activatedStep: "scenario-validity", reason: "fixture advisory decision",
    } });
    advisory.manager.writeRuntimeArtifact({ specId: advisory.created.specId, nodeId: "scenario-validity", artifact: {
      logicalKey: "scenario.validity.raw-log", mediaType: "text/plain", bytes: Buffer.from("R1 advisory scenario\n", "utf8"),
    } });
    await FLOW_COMMANDS.run["scenario-validity"].post(
      contextFor(advisory, "scenario-validity"),
      scenarioBlockResult(advisory),
    );
    assert.equal(advisory.manager.canonicalState(advisory.created.specId).nextAction().operation, "resume");
    assert.equal(advisory.manager.activityLedger(advisory.created.specId).at(-1).transition.operation, "record_nonblocking");
    assert.deepEqual(decisionContextForActiveFlow(advisory.repository, advisory.manager.load(advisory.created.specId), advisory.manager).allowedActions, ["retry", "continue"]);
    const advisoryDirective = await new GetNextActionCommand().execute(contextFor(advisory, "scenario-validity"));
    assert.equal(advisoryDirective.directive.code, "TEST_CHAIN_NONBLOCKING_DECISION_REQUIRED");
    assert.equal(advisoryDirective.definitionTransition.operation, "await-user-input");

    const stalePolicy = setup("001-test-chain-stale-policy", "scenario-validity");
    stalePolicy.manager.writeRuntimeArtifact({ specId: stalePolicy.created.specId, nodeId: "scenario-validity", artifact: {
      logicalKey: "scenario.validity.raw-log", mediaType: "text/plain", bytes: Buffer.from("R1 stale policy scenario\n", "utf8"),
    } });
    stalePolicy.manager.publishCurrentAttemptResult({
      specId: stalePolicy.created.specId, commandResult: scenarioBlockResult(stalePolicy),
    });
    const stalePolicyDecision = resolveNonGateTransition(readCurrentTestChainTransitionFacts({
      flowManager: stalePolicy.manager, specId: stalePolicy.created.specId,
    }), scenarioValidityTransitionDefinition);
    stalePolicy.manager.activateNonblockingPolicy({ specId: stalePolicy.created.specId, policy: {
      enabled: true, activatedAt: "2026-08-24T00:00:00.000Z", activatedStep: "scenario-validity", reason: "stale plan fixture",
    } });
    const afterPolicyActivation = {
      state: stalePolicy.manager.canonicalState(stalePolicy.created.specId).toJSON(),
      activities: stalePolicy.manager.activityLedger(stalePolicy.created.specId),
      catalog: stalePolicy.manager.artifactCatalog(stalePolicy.created.specId).toJSON(),
    };
    assert.throws(
      () => stalePolicy.manager.applyTestChainTransitionDecision({
        specId: stalePolicy.created.specId, decision: stalePolicyDecision,
      }),
      /Definition plan changed before test-chain settlement/,
    );
    assert.deepEqual({
      state: stalePolicy.manager.canonicalState(stalePolicy.created.specId).toJSON(),
      activities: stalePolicy.manager.activityLedger(stalePolicy.created.specId),
      catalog: stalePolicy.manager.artifactCatalog(stalePolicy.created.specId).toJSON(),
    }, afterPolicyActivation);

    const staleRevision = setup("001-test-chain-stale-state-revision", "scenario-validity");
    staleRevision.manager.writeRuntimeArtifact({ specId: staleRevision.created.specId, nodeId: "scenario-validity", artifact: {
      logicalKey: "scenario.validity.raw-log", mediaType: "text/plain", bytes: Buffer.from("R1 stale revision scenario\n", "utf8"),
    } });
    staleRevision.manager.publishCurrentAttemptResult({
      specId: staleRevision.created.specId, commandResult: scenarioBlockResult(staleRevision),
    });
    const staleRevisionDecision = resolveNonGateTransition(readCurrentTestChainTransitionFacts({
      flowManager: staleRevision.manager, specId: staleRevision.created.specId,
    }), scenarioValidityTransitionDefinition);
    staleRevision.manager.setAutoApprove(true, { specId: staleRevision.created.specId });
    const afterStateRevision = {
      state: staleRevision.manager.canonicalState(staleRevision.created.specId).toJSON(),
      activities: staleRevision.manager.activityLedger(staleRevision.created.specId),
      catalog: staleRevision.manager.artifactCatalog(staleRevision.created.specId).toJSON(),
    };
    assert.throws(
      () => staleRevision.manager.applyTestChainTransitionDecision({
        specId: staleRevision.created.specId, decision: staleRevisionDecision,
      }),
      /Definition plan changed before test-chain settlement/,
    );
    assert.deepEqual({
      state: staleRevision.manager.canonicalState(staleRevision.created.specId).toJSON(),
      activities: staleRevision.manager.activityLedger(staleRevision.created.specId),
      catalog: staleRevision.manager.artifactCatalog(staleRevision.created.specId).toJSON(),
    }, afterStateRevision);

    const staleRaw = setup("001-test-chain-stale-raw", "test-execute");
    staleRaw.manager.publishCurrentAttemptResult({
      specId: staleRaw.created.specId, commandResult: executionResult(staleRaw),
    });
    const staleRawDecision = resolveNonGateTransition(readCurrentTestChainTransitionFacts({
      flowManager: staleRaw.manager, specId: staleRaw.created.specId,
    }), testExecuteTransitionDefinition);
    staleRaw.manager.writeRuntimeArtifact({ specId: staleRaw.created.specId, nodeId: "test-execute", artifact: {
      logicalKey: "test.execute.raw-log", mediaType: "text/plain", bytes: Buffer.from("replacement raw evidence\n", "utf8"),
    } });
    const afterRawReplacement = {
      state: staleRaw.manager.canonicalState(staleRaw.created.specId).toJSON(),
      activities: staleRaw.manager.activityLedger(staleRaw.created.specId),
      catalog: staleRaw.manager.artifactCatalog(staleRaw.created.specId).toJSON(),
    };
    assert.throws(
      () => staleRaw.manager.applyTestChainTransitionDecision({
        specId: staleRaw.created.specId, decision: staleRawDecision,
      }),
      /Definition plan changed before test-chain settlement/,
    );
    assert.deepEqual({
      state: staleRaw.manager.canonicalState(staleRaw.created.specId).toJSON(),
      activities: staleRaw.manager.activityLedger(staleRaw.created.specId),
      catalog: staleRaw.manager.artifactCatalog(staleRaw.created.specId).toJSON(),
    }, afterRawReplacement);
    assert.throws(
      () => interrupted.manager.writeRuntimeArtifact({ specId: interrupted.created.specId, nodeId: "scenario-validity", artifact: {
        logicalKey: "scenario.validity.raw-log", mediaType: "text/plain", bytes: Buffer.from("stale producer write\n", "utf8"),
      } }),
      /producer does not own the active Attempt/,
    );

    let raceArmed = false;
    let rawRaceError = null;
    let rawRaceAttempts = 0;
    let raceManager = null;
    const raced = setup("001-test-chain-raw-write-race", "scenario-validity", ({ phase, activity }) => {
      if (!raceArmed || phase !== "activity-ready-to-append" || activity.transition.operation !== "repair_scenario_validity") return;
      rawRaceAttempts += 1;
      try {
        raceManager.writeRuntimeArtifact({ specId: raced.created.specId, nodeId: "scenario-validity", artifact: {
          logicalKey: "scenario.validity.raw-log", mediaType: "text/plain", bytes: Buffer.from("racing replacement\n", "utf8"),
        } });
      } catch (error) {
        rawRaceError = error;
      }
    });
    raceManager = raced.manager;
    const stableRaw = Buffer.from("R1 lock-race scenario\n", "utf8");
    raced.manager.writeRuntimeArtifact({ specId: raced.created.specId, nodeId: "scenario-validity", artifact: {
      logicalKey: "scenario.validity.raw-log", mediaType: "text/plain", bytes: stableRaw,
    } });
    raced.manager.publishCurrentAttemptResult({
      specId: raced.created.specId, commandResult: scenarioBlockResult(raced),
    });
    const racedDecision = resolveNonGateTransition(readCurrentTestChainTransitionFacts({
      flowManager: raced.manager, specId: raced.created.specId,
    }), scenarioValidityTransitionDefinition);
    raceArmed = true;
    raced.manager.applyTestChainTransitionDecision({ specId: raced.created.specId, decision: racedDecision });
    assert.equal(rawRaceAttempts, 1);
    assert.equal(rawRaceError?.code, "PROCESS_LOCK_REENTRANT");
    assert.equal(rawRaceError?.lockStatus, "reentrant");
    assert.deepEqual(raced.manager.readRuntimeArtifact({
      specId: raced.created.specId, logicalKey: "scenario.validity.raw-log", consumerNodeId: "scenario-validity",
    }).bytes, stableRaw);
  });

  it("confirms definition-owned no-op leaves and persists review history through the catalog", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");

    const ordered = leaves(manager.load(created.specId).steps);
    const reviewIndex = ordered.findIndex((entry) => entry.id === "spec-review");
    assert.ok(reviewIndex > 0);
    for (const entry of ordered.slice(0, reviewIndex)) {
      confirmFixtureStep(manager, entry.id);
    }
    const beforeReview = manager.readCurrentSpecReviewInput({
      specId: created.specId,
      consumerNodeId: "spec-review",
    }).review;
    manager.updateStepStatus(
      { stepId: "spec-review", requestedStatus: "done" },
      {
        canonicalCommandResult: noOpSpecReviewCommandResult(beforeReview),
      },
    );

    const resolved = manager.readCurrentSpecReview({
      specId: created.specId,
      consumerNodeId: "spec-triage",
    });

    assert.equal(resolved.review.generation, 1);
    assert.equal(resolved.review.audit.at(-1).stage, "spec-review");
    assert.equal(resolved.review.audit.at(-1).outcome, "no-op");
    assert.equal(resolved.descriptor.activityId !== null, true);
    assert.throws(
      () => manager.readCurrentSpecReview({
        specId: created.specId,
        consumerNodeId: "report",
      }),
      /consumer is not authorized/,
    );
  });

  it("records a failed producer Attempt and its result history through one V1 Store transaction", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    const ordered = leaves(manager.load(created.specId).steps);
    const finalRegressionIndex = ordered.findIndex((entry) => entry.id === "final-regression");
    assert.ok(finalRegressionIndex > 0);
    for (const entry of ordered.slice(0, finalRegressionIndex)) {
      confirmFixtureStep(manager, entry.id);
    }
    manager.updateStepStatus({ stepId: "final-regression", requestedStatus: "in_progress" });
    const commandResult = attachCanonicalCommandResultArtifact({
      result: "fail",
      artifacts: { failureKind: "infra_failure" },
    }, {
      logicalKey: "final.regression",
      payload: { result: "fail", failureKind: "infra_failure" },
    });

    manager.failCurrentAttempt({
      failure: {
        category: "environment",
        code: "FINAL_REGRESSION_FAILED",
        message: "final-regression failed (infra_failure)",
        retryable: false,
        retryKind: null,
      },
      result: {
        outcome: "failed",
        summary: "final-regression failed (infra_failure)",
        confirmedAt: "2026-08-13T00:00:00.000Z",
        artifactRefs: [],
      },
      commandResult,
    });

    const typed = manager.canonicalState(created.specId);
    assert.equal(typed.attempt.nodeId, "final-regression");
    assert.equal(typed.attempt.failure.code, "FINAL_REGRESSION_FAILED");
    const history = JSON.parse(manager.readArtifact({
      specId: created.specId,
      logicalKey: "final.regression",
      consumerNodeId: "report",
    }).bytes.toString("utf8"));
    assert.deepEqual(history.attempts.map((entry) => entry.attempt), [1]);
    assert.equal(history.attempts[0].artifact.payload.failureKind, "infra_failure");
    const activities = fs.readFileSync(manager.specLocation(created.specId).activitiesFile, "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(activities.at(-1).transition.operation, "fail_attempt");
    assert.equal(activities.at(-1).failure.code, "FINAL_REGRESSION_FAILED");
  });

  it("runs final-regression through the canonical raw/result contracts and confirms it through the registry", async () => {
    const repository = root();
    fs.writeFileSync(path.join(repository, "package.json"), JSON.stringify({
      scripts: { test: "node --test final-regression.test.js" },
    }, null, 2));
    fs.writeFileSync(path.join(repository, "final-regression.test.js"), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('canonical final regression', () => assert.equal(1, 1));",
      "",
    ].join("\n"));
    initGitRepo(repository);
    commitAll(repository, "initial");
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-canonical-final-regression", {
      execution: { mode: "direct", baseBranch: "main" },
    }));
    manager.addActiveFlow(created.specId, "direct");
    const ordered = leaves(manager.load(created.specId).steps);
    const finalRegressionIndex = ordered.findIndex((entry) => entry.id === "final-regression");
    for (const entry of ordered.slice(0, finalRegressionIndex)) {
      confirmFixtureStep(manager, entry.id);
    }
    manager.updateStepStatus({ stepId: "final-regression", requestedStatus: "in_progress" });
    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      phase: "final-regression",
      config: { test: { command: "node --test final-regression.test.js", timeout: 5 } },
      flowManager: manager,
      flowState: manager.load(created.specId),
    };

    const result = await new RunFinalRegressionCommand().execute(ctx);
    assert.equal(result.result, "pass");
    assert.equal(Object.hasOwn(result, "next"), false);
    await FLOW_COMMANDS.run["final-regression"].post(ctx, result);

    const location = manager.specLocation(created.specId);
    const history = JSON.parse(manager.readArtifact({
      specId: created.specId,
      logicalKey: "final.regression",
      consumerNodeId: "report",
    }).bytes.toString("utf8"));
    assert.equal(history.attempts[0].artifact.payload.result, "pass");
    assert.equal(history.attempts[0].artifact.payload.rawOutputPath,
      location.relativeArtifact("final.regression.raw-log", { attempt: "001" }));
    assert.equal(fs.existsSync(location.resolve("steps/final-regression/attempt-001.log")), true);
    assert.equal(leaves(manager.load(created.specId).steps)
      .find((step) => step.id === "final-regression").status, "done");
    assert.equal(fs.existsSync(path.join(location.directory, "final-regression-result.json")), false);
  });

  it("delivers a linked-Issue report through the canonical catalog and report outbox", async () => {
    const repository = root();
    fs.writeFileSync(path.join(repository, "README.md"), "canonical report\n");
    fs.writeFileSync(path.join(repository, "final-regression.test.js"), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "test('canonical report final regression', () => assert.equal(1, 1));",
      "",
    ].join("\n"));
    initGitRepo(repository);
    commitAll(repository, "initial");
    const binDirectory = path.join(repository, "bin");
    const ghLog = path.join(repository, "gh.log");
    fs.mkdirSync(binDirectory, { recursive: true });
    fs.writeFileSync(path.join(binDirectory, "gh"), [
      "#!/bin/sh",
      "if [ \"$1\" = \"issue\" ] && [ \"$2\" = \"view\" ]; then exit 0; fi",
      "printf '%s\\n' \"$@\" >> \"$SENNEL_TEST_GH_LOG\"",
      "exit 0",
      "",
    ].join("\n"));
    fs.chmodSync(path.join(binDirectory, "gh"), 0o755);
    const originalPath = process.env.PATH;
    const originalGhLog = process.env.SENNEL_TEST_GH_LOG;
    process.env.PATH = `${binDirectory}:${originalPath}`;
    process.env.SENNEL_TEST_GH_LOG = ghLog;
    try {
      const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
      const created = manager.createFresh(request("001-canonical-linked-report", {
        execution: { mode: "direct", baseBranch: "main" },
        issue: 314,
        issueSnapshot: "# Linked issue\n\nCanonical snapshot.\n",
        specRecord: new CurrentFlowSpecRecord({
          ...emptySpecStub(),
          requirements: [{
            id: "R1",
            desc: "Bind the implementation file map to the report.",
            priority: "must",
          }],
          tasks: [],
        }, { specId: "001-canonical-linked-report" }),
      }));
      manager.addActiveFlow(created.specId, "direct");
      const ordered = leaves(manager.load(created.specId).steps);
      const reportIndex = ordered.findIndex((entry) => entry.id === "report");
      assert.ok(reportIndex > 0);
      for (const entry of ordered.slice(0, reportIndex)) {
        if (entry.id === "final-regression") {
          manager.updateStepStatus({ stepId: entry.id, requestedStatus: "in_progress" });
          const finalRegressionContext = {
            root: repository,
            mainRoot: repository,
            executionRoot: repository,
            specId: created.specId,
            phase: "final-regression",
            config: { test: { command: "node --test final-regression.test.js", timeout: 5 } },
            flowManager: manager,
            flowState: manager.load(created.specId),
          };
          const finalRegressionResult = await new RunFinalRegressionCommand().execute(finalRegressionContext);
          await FLOW_COMMANDS.run["final-regression"].post(finalRegressionContext, finalRegressionResult);
          continue;
        }
        if (entry.id === "implement") {
          manager.updateStepStatus({ stepId: entry.id, requestedStatus: "in_progress" });
          manager.updateFileMap({ requirementId: "R1", paths: ["src/report.js"] });
        }
        confirmFixtureStep(manager, entry.id);
      }
      manager.updateStepStatus({ stepId: "report", requestedStatus: "in_progress" });
      const identity = new FlowOutboxIdentity({
        runId: created.runId,
        stepId: "report",
        operation: "report",
      });
      const outbox = new FlowOutboxStore(manager, { specId: created.specId });
      const entry = outbox.beginCommand(identity);
      const ctx = {
        root: repository,
        mainRoot: repository,
        executionRoot: repository,
        specId: created.specId,
        phase: "report",
        flowManager: manager,
        flowState: manager.load(created.specId),
        flowOutboxEntry: entry,
      };

      const result = await new RunReportCommand().execute(ctx);
      const publication = attachedCanonicalCommandResultPublications(result)
        .find((candidate) => candidate.logicalKey === "report");
      assert.equal(result.result, "ok");
      assert.deepEqual(result.changed, [
        "specs/001-canonical-linked-report/001/artifacts/report.json",
      ]);
      assert.equal(publication.payload.data.delivery.status, "done");
      await FLOW_COMMANDS.run.report.post(ctx, result);

      const report = JSON.parse(manager.readArtifact({
        specId: created.specId,
        logicalKey: "report",
        consumerNodeId: "report",
      }).bytes.toString("utf8"));
      assert.equal(report.data.delivery.status, "done");
      assert.equal(report.data.delivery.idempotencyKey, identity.idempotencyKey);
      assert.equal(
        report.data.binding.sourceArtifacts.some((source) => (
          source.path === "specs/001-canonical-linked-report/001/steps/impl/file-map.json"
        )),
        true,
      );
      assert.equal(outbox.status(identity).status, "done");
      assert.equal(leaves(manager.load(created.specId).steps)
        .find((step) => step.id === "report").status, "done");
      assert.equal(fs.existsSync(path.join(manager.specLocation(created.specId).directory, "report.json")), false);
      assert.match(fs.readFileSync(ghLog, "utf8"), new RegExp(`sennel:${identity.idempotencyKey}`));
    } finally {
      process.env.PATH = originalPath;
      if (originalGhLog === undefined) delete process.env.SENNEL_TEST_GH_LOG;
      else process.env.SENNEL_TEST_GH_LOG = originalGhLog;
    }
  });

  it("writes immutable review evidence under its active producer directory", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");

    const ordered = leaves(manager.load(created.specId).steps);
    const reviewIndex = ordered.findIndex((entry) => entry.id === "spec-review");
    for (const entry of ordered.slice(0, reviewIndex)) {
      confirmFixtureStep(manager, entry.id);
    }
    manager.updateStepStatus({ stepId: "spec-review", requestedStatus: "in_progress" });
    const digest = "a".repeat(64);
    const evidence = {
      logicalKey: "review.evidence",
      reviewStep: "spec-review",
      digest,
      mediaType: "application/json",
      bytes: '{"version":1,"verdict":"PASS"}\n',
    };
    const activityCount = manager.activityLedger(created.specId).length;
    manager.publishArtifacts({ nodeId: "spec-review", artifactWrites: [evidence] });

    const relativePath = `steps/spec-review/evidence/${digest}.json`;
    const descriptor = manager.artifactCatalog(created.specId).resolve(relativePath);
    assert.equal(descriptor.logicalKey, "review.evidence");
    assert.equal(fs.existsSync(path.join(manager.specLocation(created.specId).directory, relativePath)), true);
    assert.equal(manager.activityLedger(created.specId).length, activityCount + 1);
    assert.throws(
      () => manager.publishArtifacts({
        nodeId: "spec-review",
        artifactWrites: [{ ...evidence, bytes: '{"version":1,"verdict":"REJECTED"}\n' }],
      }),
      /immutable artifact publication cannot replace existing bytes/,
    );
  });

  it("registers independent advisory review evidence through the V1 catalog without a root-state mutation", () => {
    const repository = root();
    fs.writeFileSync(path.join(repository, "README.md"), "canonical review evidence\n");
    initGitRepo(repository);
    commitAll(repository, "initial");
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-canonical-set-review-evidence"));
    manager.addActiveFlow(created.specId, "direct");
    const ordered = leaves(manager.load(created.specId).steps);
    const reviewIndex = ordered.findIndex((entry) => entry.id === "spec-review");
    for (const entry of ordered.slice(0, reviewIndex)) {
      confirmFixtureStep(manager, entry.id);
    }
    manager.updateStepStatus({ stepId: "spec-review", requestedStatus: "in_progress" });
    const flowState = manager.load(created.specId);
    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
      flowState,
    };
    const evidenceFile = ".sennel/output/independent-review.json";
    fs.mkdirSync(path.join(repository, ".sennel", "output"), { recursive: true });
    const authority = ReviewTargetAuthority.fromContext(ctx);
    const fingerprint = authority.captureFingerprint();
    const targetState = authority.captureTargetStateForPhase("spec", fingerprint);
    fs.writeFileSync(path.join(repository, evidenceFile), JSON.stringify({
      version: 1,
      phase: "spec",
      taskId: null,
      treeSha: authority.resolveTreeSha(),
      targetStateDigest: targetState.digest,
      provenance: {
        provider: "independent-reviewer",
        invocationId: "canonical-set-review-evidence",
        capturedAt: "2026-08-14T00:00:00.000Z",
      },
      disposition: "ADVISORY",
      blockingFindings: [],
      advisoryFindings: [{
        findingId: "advisory-catalog-reference",
        summary: "Catalog evidence stays authoritative for advisory handoff.",
        fingerprint: "c".repeat(64),
        evidenceRefs: ["independent-review.json#advisory-catalog-reference"],
        disposition: "informational",
      }],
    }, null, 2) + "\n");

    const result = new SetReviewEvidenceCommand().execute({ ...ctx, file: evidenceFile });
    assert.equal(result.providerInvoked, false);
    assert.equal(result.phase, "spec");
    assert.equal(result.reviewAction.kind, "move_to_acceptance");
    assert.equal(result.reviewAction.handoffFindings.length, 1);
    assert.equal(result.reviewAction.handoffFindings[0].evidenceDigest, result.evidenceDigest);
    assert.match(result.artifactPath, /^steps\/spec-review\/evidence\/[a-f0-9]{64}\.json$/);
    assert.equal(result.reviewAction.handoffFindings[0].canonicalEvidenceRef, result.artifactPath);
    assert.equal(manager.artifactCatalog(created.specId).resolve(result.artifactPath).logicalKey, "review.evidence");
    const evidence = manager.readCatalogArtifact({
      specId: created.specId,
      relativePath: result.artifactPath,
      consumerNodeId: "spec-triage",
    });
    assert.equal(JSON.parse(evidence.bytes.toString("utf8")).disposition, "ADVISORY");
    assert.equal(Object.hasOwn(manager.load(created.specId), "reviewConvergence"), false);
    const activityCount = manager.activityLedger(created.specId).length;
    assert.throws(
      () => new SetReviewEvidenceCommand().execute({ ...ctx, file: evidenceFile }),
      (error) => error?.code === "REVIEW_ALREADY_COMPLETED",
    );
    assert.equal(manager.activityLedger(created.specId).length, activityCount);
  });

  it("does not send a Version-1 review through the retired PASS projection recovery writer", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-canonical-review-recovery"));
    manager.addActiveFlow(created.specId, "direct");
    const result = new RunRecoverReviewPassCommand().execute({
      root: repository,
      executionRoot: repository,
      flowState: manager.load(created.specId),
      flowManager: manager,
      phase: "spec",
      expectRunId: "canonical-manager-run",
      expectSpec: created.specId,
      expectNoIssue: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "REVIEW_PASS_RECOVERY_NOT_ELIGIBLE");
    assert.equal(Object.hasOwn(manager.load(created.specId), "reviewConvergence"), false);
  });

  it("runs the normal spec-review worker in a transient V1 work unit and confirms its result through the Store", async () => {
    const repository = root();
    initializeReviewSource(repository);
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    const ordered = leaves(manager.load(created.specId).steps);
    const reviewIndex = ordered.findIndex((entry) => entry.id === "spec-review");
    for (const entry of ordered.slice(0, reviewIndex)) {
      confirmFixtureStep(manager, entry.id);
    }
    manager.updateStepStatus({ stepId: "spec-review", requestedStatus: "in_progress" });

    let invocation = null;
    const review = new RunReviewCommand({
      resolveTreeSha: () => "a".repeat(40),
      resolveTargetStateDigest: () => "b".repeat(64),
      runCommand(command, args, options) {
        invocation = { command, args, options };
        const outputDirectory = options.env.SENNEL_REVIEW_OUTPUT_DIR;
        const specSource = JSON.parse(options.env.SENNEL_REVIEW_SPEC_SOURCE);
        assert.equal(specSource.logicalKey, "spec.record");
        assert.equal(specSource.logicalPath, "spec.json");
        assert.equal(specSource.sourcePath.startsWith(`${outputDirectory}${path.sep}`), true);
        assert.deepEqual(
          JSON.parse(fs.readFileSync(specSource.sourcePath, "utf8")),
          JSON.parse(manager.readArtifact({
            specId: created.specId,
            logicalKey: "spec.record",
            consumerNodeId: "spec-review",
          }).bytes.toString("utf8")),
        );
        const reviewSource = JSON.parse(options.env.SENNEL_REVIEW_SPEC_REVIEW_SOURCE);
        const currentReview = manager.readCurrentSpecReviewInput({
          specId: created.specId,
          consumerNodeId: "spec-review",
        });
        assert.deepEqual(Object.keys(reviewSource).sort(), [
          "byteLength", "digest", "logicalKey", "logicalPath", "sourcePath", "version",
        ]);
        assert.equal(reviewSource.version, 1);
        assert.equal(reviewSource.logicalKey, "spec.review");
        assert.equal(reviewSource.logicalPath, "review.json");
        assert.equal(reviewSource.sourcePath, path.join(outputDirectory, "inputs", "review.json"));
        assert.deepEqual(fs.readFileSync(reviewSource.sourcePath), currentReview.bytes);
        assert.equal(reviewSource.byteLength, currentReview.bytes.length);
        assert.equal(
          reviewSource.digest,
          crypto.createHash("sha256").update(fs.readFileSync(reviewSource.sourcePath)).digest("hex"),
        );
        assert.equal(options.env.SENNEL_REVIEW_FILE_MAP_SOURCE, undefined);
        assert.equal(fs.existsSync(path.join(outputDirectory, "spec-review.json")), false);
        writeSpecReviewDeltaOutput(options);
        ReviewWorkUnit.fromEnvironment(options.env).seal();
        return {
          ok: true,
          status: 0,
          stdout: "NO_PROPOSALS\n",
          stderr: "  [spec-review] verdict=PASS proposalCount=0\n",
          signal: null,
          killed: false,
        };
      },
    });
    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      phase: "spec",
      flowManager: manager,
      flowState: manager.load(created.specId),
      config: {},
    };

    const foreignRoot = root();
    initializeReviewSource(foreignRoot);
    const dynamicConfig = ["GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"];
    const inheritedGitEnvironment = Object.fromEntries(
      [...GIT_REPOSITORY_LOCATION_ENVIRONMENT, ...dynamicConfig].map((name) => [name, process.env[name]]),
    );
    const globalConfig = path.join(foreignRoot, "global.gitconfig");
    fs.writeFileSync(globalConfig, "[user]\n  name = Review Worker\n");
    Object.assign(process.env, {
      GIT_DIR: path.join(foreignRoot, ".git"),
      GIT_WORK_TREE: foreignRoot,
      GIT_INDEX_FILE: path.join(foreignRoot, ".git", "index"),
      GIT_OBJECT_DIRECTORY: path.join(foreignRoot, ".git", "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(foreignRoot, ".git", "objects"),
      GIT_COMMON_DIR: path.join(foreignRoot, ".git"),
      GIT_CEILING_DIRECTORIES: foreignRoot,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree",
      GIT_CONFIG_VALUE_0: foreignRoot,
      GIT_CONFIG_PARAMETERS: "core.worktree=foreign",
      GIT_CONFIG_GLOBAL: globalConfig,
    });
    delete process.env.GIT_CONFIG_NOSYSTEM;
    const expectedReviewGitEnvironment = Object.fromEntries(
      [...GIT_REPOSITORY_LOCATION_ENVIRONMENT, ...dynamicConfig].map((name) => [name, process.env[name]]),
    );
    let result;
    try {
      result = await review.execute(ctx);
    } finally {
      for (const [name, value] of Object.entries(inheritedGitEnvironment)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    assert.equal(invocation.command, "node");
    assert.deepEqual(invocation.args.slice(-2), ["--phase", "spec"]);
    assert.equal(invocation.options.cwd, repository);
    assert.equal(invocation.options.env.SENNEL_REVIEW_WORK_UNIT_CHECKOUT, undefined);
    assert.equal(
      invocation.options.timeout,
      AgentTimeout.fromConfig().toOuterProcessMilliseconds(),
      "the outer review worker survives the inner Agent's process-tree cleanup window",
    );
    assert.equal(invocation.options.env.SENNEL_REVIEW_OUTPUT_DIR.startsWith(
      path.join(repository, ".sennel", "review-work-units"),
    ), true);
    for (const [name, value] of Object.entries(expectedReviewGitEnvironment)) {
      assert.equal(invocation.options.env[name], value, `${name} must be inherited by the review worker`);
    }
    assert.equal(invocation.options.env.GIT_CONFIG_GLOBAL, globalConfig);
    assert.equal(invocation.options.env.GIT_CONFIG_NOSYSTEM, undefined);
    assert.equal(result.artifacts.phase, "spec");
    assert.equal(result.artifacts.evidenceDigest.length, 64);
    assert.equal(attachedCanonicalCommandResultArtifact(result), null);
    assert.equal(attachedCanonicalCommandResultPublications(result)[0].logicalKey, "spec.review");
    assert.deepEqual(attachedCanonicalCommandResultPublications(result)[0].parameters, { revision: "001" });

    await FLOW_COMMANDS.run.review.post(ctx, result);
    const transientWorkUnit = invocation.options.env.SENNEL_REVIEW_OUTPUT_DIR;
    assert.equal(fs.existsSync(transientWorkUnit), false);

    const location = manager.specLocation(created.specId);
    const canonicalReview = manager.readCurrentSpecReview({
      specId: created.specId,
      consumerNodeId: "spec-triage",
    });
    const state = manager.load(created.specId);

    assert.equal(canonicalReview.review.generation, 1);
    assert.equal(canonicalReview.review.audit.at(-1).stage, "spec-review");
    assert.equal(canonicalReview.review.audit.at(-1).relation, "revision-scoped-canonical-review");
    const publicationActivity = manager.activityLedger(created.specId)
      .find((activity) => activity.id === canonicalReview.descriptor.activityId);
    assert.ok(publicationActivity);
    assert.deepEqual(publicationActivity.reviewPublication, {
      generation: canonicalReview.review.generation,
      identity: canonicalReview.review.identity.toJSON(),
      reviewDigest: canonicalReview.review.digest,
      relation: "revision-scoped-canonical-review",
      stage: "spec-review",
      outcome: canonicalReview.review.audit.at(-1).outcome,
    });
    assert.equal(publicationActivity.id, canonicalReview.descriptor.activityId);
    assert.equal(publicationActivity.reviewPublication.reviewDigest, canonicalReview.descriptor.hash);
    assert.equal(leaves(state.steps).find((entry) => entry.id === "spec-review").status, "done");
    assert.equal(fs.existsSync(path.join(location.directory, "spec-review.json")), false);
    assert.equal(fs.existsSync(path.join(location.directory, "review-history")), false);
  });

  it("records triage and repair review receipts in their confirmation Activities", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-review-publication-receipts"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "spec-triage");

    const triageInput = manager.readCurrentSpecReview({
      specId: created.specId,
      consumerNodeId: "spec-triage",
    }).review;
    const triage = reviewPublicationWrite(triageInput, "spec-triage");
    manager.confirmCurrentAttempt({
      specId: created.specId,
      artifactWrites: [triage.write],
    });

    manager.updateStepStatus({ stepId: "spec-repair", requestedStatus: "in_progress" }, { specId: created.specId });
    const repairInput = manager.readCurrentSpecReview({
      specId: created.specId,
      consumerNodeId: "spec-repair",
    }).review;
    const repair = reviewPublicationWrite(repairInput, "spec-repair");
    manager.confirmCurrentAttempt({
      specId: created.specId,
      artifactWrites: [repair.write],
    });

    const current = manager.readCurrentSpecReview({
      specId: created.specId,
      consumerNodeId: "spec-repair",
    });
    const facts = manager.activityLedger(created.specId)
      .map((activity) => activity.reviewPublication)
      .filter((fact) => fact !== null);
    assert.deepEqual(facts.map((fact) => fact.stage), ["spec-review", "spec-triage", "spec-repair"]);
    assert.deepEqual(facts.map((fact) => fact.generation), [1, 2, 3]);
    assert.equal(facts.at(-1).reviewDigest, current.descriptor.hash);
    assert.deepEqual(facts.at(-1).identity, current.review.identity.toJSON());
    assert.equal(current.review.audit.at(-1).stage, "spec-repair");
  });

  it("rejects a review publication receipt whose generation differs from its review bytes", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-review-publication-generation-tamper"));
    const current = manager.readCurrentSpecReviewInput({ specId: created.specId, consumerNodeId: "spec-review" }).review;
    const publication = reviewPublicationWrite(current, "spec-review");
    const bytes = publication.write.bytes;
    const receipt = new ActivityReviewPublication({
      generation: publication.next.generation + 1,
      identity: publication.next.identity.toJSON(),
      reviewDigest: publication.next.digest,
      relation: "revision-scoped-canonical-review",
      stage: "spec-review",
      outcome: publication.next.audit.at(-1).outcome,
    });
    assert.throws(
      () => receipt.assertReview(publication.next, { specId: created.specId, revision: 1, bytes }),
      /publication fact does not match canonical review bytes/,
    );
  });

  it("rebases the merged spec-repair review onto exactly one changed Spec revision", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-spec-repair-revision"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "spec-repair");
    const before = currentSpecRevisionAuthority(manager, created.specId);
    const document = JSON.parse(before.root.toString("utf8"));
    document.goal = "Publish the repaired revision with its canonical review audit.";
    const repair = reviewPublicationWrite(before.review, "spec-repair");
    manager.confirmCurrentAttempt({
      specId: created.specId,
      specRecord: new CurrentFlowSpecRecord(document, { specId: created.specId }),
      artifactWrites: [repair.write],
    });
    const after = currentSpecRevisionAuthority(manager, created.specId);
    assertSpecRevisionAdvanced(before, after);
    assert.equal(after.review.audit.at(-1).stage, "spec-repair");
    assert.equal(after.review.generation, repair.next.generation);
    assert.deepEqual(after.review.findings.findings, repair.next.findings.findings);
  });

  it("publishes exactly one revision for an approval Spec update", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-approval-revision"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "approval");
    const before = currentSpecRevisionAuthority(manager, created.specId);
    manager.updateSpecApproval({
      specId: created.specId,
      approval: { confirmedAt: "2026-08-29T00:00:00.000Z", notes: "Revision test approval." },
    });
    const after = currentSpecRevisionAuthority(manager, created.specId);
    assertSpecRevisionAdvanced(before, after);
    assert.equal(JSON.parse(after.root.toString("utf8")).user_approval.approved, true);
  });

  it("rejects caller-injected revision snapshots and non-current review destinations before mutation", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-revision-write-injection"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "spec");
    const location = manager.specLocation(created.specId);
    const revisedSpec = JSON.parse(fs.readFileSync(location.specFile, "utf8"));
    revisedSpec.goal = "Create an immutable second revision.";
    manager.confirmCurrentAttempt({
      specId: created.specId,
      specRecord: new CurrentFlowSpecRecord(revisedSpec, { specId: created.specId }),
    });
    assert.equal(manager.readCurrentSpecReview({ specId: created.specId, consumerNodeId: "spec-review" }), null);
    manager.updateStepStatus({ stepId: "spec-review", requestedStatus: "in_progress" }, { specId: created.specId });
    const before = () => ({
      state: manager.load(created.specId),
      activities: manager.activityLedger(created.specId),
      catalog: manager.artifactCatalog(created.specId).toJSON(),
      revisionOneSnapshot: fs.readFileSync(location.artifact("spec.snapshot", { revision: "001" }), "utf8"),
      revisionTwoSnapshot: fs.readFileSync(location.artifact("spec.snapshot", { revision: "002" }), "utf8"),
      review: fs.existsSync(location.artifact("spec.review", { revision: "002" }))
        ? fs.readFileSync(location.artifact("spec.review", { revision: "002" }), "utf8") : null,
    });
    const baseline = before();
    const snapshot = Buffer.from(fs.readFileSync(location.artifact("spec.snapshot", { revision: "001" })));
    for (const parameters of [{ revision: "001" }, { revision: "002" }]) {
      assert.throws(
        () => manager.confirmCurrentAttempt({
          specId: created.specId,
          artifactWrites: [{ logicalKey: "spec.snapshot", parameters, mediaType: "application/json", bytes: snapshot }],
        }),
        /spec\.snapshot.*generated only/i,
      );
      assert.deepEqual(before(), baseline);
    }
    const current = manager.readCurrentSpecReviewInput({ specId: created.specId, consumerNodeId: "spec-review" }).review;
    const injected = reviewPublicationWrite(current, "spec-review").write;
    injected.parameters = { revision: "999" };
    assert.throws(
      () => manager.confirmCurrentAttempt({ specId: created.specId, artifactWrites: [injected] }),
      /verified current Spec revision/i,
    );
    assert.deepEqual(before(), baseline);
    const currentWrite = reviewPublicationWrite(current, "spec-review").write;
    assert.throws(
      () => manager.confirmCurrentAttempt({
        specId: created.specId,
        artifactWrites: [currentWrite],
        artifactBaselines: [{
          logicalKey: "spec.review",
          parameters: { revision: "002" },
          digest: "f".repeat(64),
          byteLength: currentWrite.bytes.length,
        }],
      }),
      /baseline|changed|digest/i,
    );
    assert.deepEqual(before(), baseline, "a stale review descriptor CAS must not append an Activity or mutate any revision bytes");
  });

  it("fails closed when the current review bytes or catalog descriptor are tampered", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const byteTampered = manager.createFresh(request("001-revision-review-bytes"));
    manager.addActiveFlow(byteTampered.specId, "direct");
    advanceTo(manager, byteTampered.specId, "spec-triage");
    const byteLocation = manager.specLocation(byteTampered.specId);
    const reviewFile = byteLocation.artifact("spec.review", { revision: "001" });
    fs.writeFileSync(reviewFile, `${JSON.stringify(JSON.parse(fs.readFileSync(reviewFile, "utf8")))}\n`);
    assert.throws(
      () => manager.readCurrentSpecReview({ specId: byteTampered.specId, consumerNodeId: "spec-review" }),
      /review.*(serialization|identity)|descriptor|catalog/i,
    );

    const descriptorTampered = manager.createFresh(request("001-revision-review-descriptor", {
      runId: "revision-review-descriptor-run",
      flowId: "revision-review-descriptor-flow",
      flowVersionId: "revision-review-descriptor-flow-v1",
    }));
    manager.addActiveFlow(descriptorTampered.specId, "direct");
    advanceTo(manager, descriptorTampered.specId, "spec-triage");
    const descriptorLocation = manager.specLocation(descriptorTampered.specId);
    const catalog = JSON.parse(fs.readFileSync(descriptorLocation.catalogFile, "utf8"));
    catalog.artifacts.find((entry) => entry.relativePath === "revisions/001/review.json").hash = "f".repeat(64);
    fs.writeFileSync(descriptorLocation.catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
    const reloaded = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    assert.throws(
      () => reloaded.readCurrentSpecReview({ specId: descriptorTampered.specId, consumerNodeId: "spec-review" }),
      /review.*(serialization|identity)|descriptor|catalog/i,
    );
  });

  it("rechecks catalog-first authority for a same-bytes Spec publication without creating a revision", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-same-bytes-revision-authority"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "spec");
    const location = manager.specLocation(created.specId);
    const same = new CurrentFlowSpecRecord(
      JSON.parse(fs.readFileSync(location.specFile, "utf8")),
      { specId: created.specId },
    );
    manager.confirmCurrentAttempt({ specId: created.specId, specRecord: same });
    assert.equal(manager.readCurrentSpecReview({ specId: created.specId, consumerNodeId: "spec-review" }), null);
    assert.equal(fs.readdirSync(location.resolve("revisions")).length, 1);

    const tampered = manager.createFresh(request("001-same-bytes-revision-tampered", {
      runId: "same-bytes-revision-tampered-run",
      flowId: "same-bytes-revision-tampered-flow",
      flowVersionId: "same-bytes-revision-tampered-flow-v1",
    }));
    manager.addActiveFlow(tampered.specId, "direct");
    advanceTo(manager, tampered.specId, "spec");
    const tamperedLocation = manager.specLocation(tampered.specId);
    const beforeJournal = fs.readFileSync(tamperedLocation.activitiesFile);
    const current = new CurrentFlowSpecRecord(
      JSON.parse(fs.readFileSync(tamperedLocation.specFile, "utf8")),
      { specId: tampered.specId },
    );
    fs.writeFileSync(tamperedLocation.artifact("spec.snapshot", { revision: "001" }), "{}\n");
    assert.throws(
      () => manager.confirmCurrentAttempt({ specId: tampered.specId, specRecord: current }),
      /catalog|snapshot|revision/i,
    );
    assert.deepEqual(fs.readFileSync(tamperedLocation.activitiesFile), beforeJournal);
  });

  it("rejects review evidence when the execution checkout changes during the review", async () => {
    const repository = root();
    initializeReviewSource(repository);
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-review-source-changed"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "spec-review");

    const review = new RunReviewCommand({
      runCommand(_command, _args, options) {
        const outputDirectory = options.env.SENNEL_REVIEW_OUTPUT_DIR;
        writeSpecReviewDeltaOutput(options);
        ReviewWorkUnit.fromEnvironment(options.env).seal();
        fs.writeFileSync(path.join(repository, "README.md"), "changed while review was running\n");
        return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
      },
    });
    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      phase: "spec",
      flowManager: manager,
      flowState: manager.load(created.specId),
      config: {},
    };
    const before = manager.activityLedger(created.specId).length;

    const result = await review.execute(ctx);

    assert.equal(result.ok, false);
    assert.equal(result.errors[0].code, "STALE_REVIEW_TARGET");
    assert.equal(manager.activityLedger(created.specId).length, before);
    assert.equal(
      manager.activityLedger(created.specId).some((activity) => activity.reviewPublication !== null),
      false,
      "an unconfirmed stale review must not append a publication receipt",
    );
    assert.equal(manager.canonicalState(created.specId).current.at(-1), "spec-review");
    assert.notEqual(manager.canonicalState(created.specId).attempt, null);
    assert.equal(manager.readCurrentSpecReview({ specId: created.specId, consumerNodeId: "spec-triage" }), null,
      "a stale worker cannot publish the initially absent revision review");
  });

  it("materializes draft review input from the catalog without exposing the Version root", async () => {
    const repository = root();
    const executionRoot = path.join(repository, "execution");
    fs.mkdirSync(executionRoot, { recursive: true });
    initializeReviewSource(executionRoot);
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-canonical-draft-review"));
    manager.addActiveFlow(created.specId, "direct");
    const draft = canonicalDraftBytes("Review the draft");
    advanceTo(manager, created.specId, "draft");
    manager.confirmCurrentAttempt({
      specId: created.specId,
      artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: draft }],
    });
    manager.updateStepStatus(
      { stepId: "draft-questions-review", requestedStatus: "in_progress" },
      { specId: created.specId },
    );

    let invocation = null;
    const review = new RunReviewCommand({
      resolveTreeSha: () => "a".repeat(40),
      runCommand(command, args, options) {
        invocation = { command, args, options };
        const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
        assert.equal(source.logicalPath, "draft.json");
        assert.deepEqual(fs.readFileSync(source.sourcePath), draft);
        assert.equal(source.revision.digest, crypto.createHash("sha256").update(draft).digest("hex"));
        assert.equal(path.dirname(source.sourcePath), options.env.SENNEL_REVIEW_OUTPUT_DIR);
        fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "draft-review-questions.json"), JSON.stringify({
          version: 2,
          phase: "draft-questions",
          sourceDraft: "draft.json",
          sourceDraftRevision: source.revision,
          generatedAt: "2026-08-14T00:00:00.000Z",
          verdict: "PASS",
          summary: "No finite structural defects.",
          blockingFindings: [],
          advisoryFindings: [],
          repairTargets: [],
        }, null, 2) + "\n");
        ReviewWorkUnit.fromEnvironment(options.env).seal();
        return {
          ok: true,
          status: 0,
          stdout: "Draft review PASS. QA entries are adequate.\n",
          stderr: "  [draft-questions-review] verdict=PASS proposalCount=0\n",
          signal: null,
          killed: false,
        };
      },
    });
    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot,
      specId: created.specId,
      phase: "draft",
      flowManager: manager,
      flowState: manager.load(created.specId),
      config: {},
    };

    const result = await review.execute(ctx);
    assert.equal(invocation.command, "node");
    assert.deepEqual(invocation.args.slice(-2), ["--phase", "draft"]);
    assert.equal(result.artifacts.phase, "draft-questions");
    assert.equal(attachedCanonicalCommandResultArtifact(result).logicalKey, "draft.questions.review");
    assert.equal(
      invocation.options.env.SENNEL_REVIEW_OUTPUT_DIR.startsWith(path.join(executionRoot, ".sennel", "review-work-units")),
      true,
    );
    assert.equal(path.resolve(invocation.options.cwd), executionRoot);
    const location = manager.specLocation(created.specId);
    assert.equal(fs.existsSync(path.join(location.directory, "draft.json")), false);
    assert.equal(fs.existsSync(path.join(location.directory, "draft-questions-review.json")), false);
    assert.equal(fs.existsSync(path.join(location.directory, "draft-questions-triage.json")), false);
    assert.equal(fs.existsSync(path.join(location.directory, "draft-questions-repair.json")), false);
  });

  for (const reviewPhase of ["draft-questions", "draft-coverage"]) {
    it(`runs the actual ${reviewPhase} writer in a sibling execution checkout before canonical promotion`, async () => {
      const fixtureRoot = root();
      const repository = path.join(fixtureRoot, "main");
      const executionRoot = path.join(fixtureRoot, "execution");
      fs.mkdirSync(repository, { recursive: true });
      initGitRepo(repository);
      commitAll(repository, "review writer fixture");
      execFileSync("git", ["worktree", "add", "-q", "-b", `writer-${reviewPhase}`, executionRoot], { cwd: repository });
      const manager = new FlowManager({ root: executionRoot, mainRoot: repository, inWorktree: true });
      const created = manager.createFresh(request(`001-actual-${reviewPhase}-writer`));
      assert.equal(manager.specLocation(created.specId).directory.startsWith(path.join(repository, "specs")), true);
      manager.addActiveFlow(created.specId, "direct");
      const draftDocument = {
        devType: "feature",
        goal: "Run writer boundary",
        analysis: {
          problem: "Exercise the canonical review writer boundary.",
          proposedApproach: "Publish review evidence before completing the draft.",
          validation: "Confirm the coverage completion connector promotes the exact revision.",
        },
        decisionMap: {
          knownFacts: [], decisionPoints: [], resolvedByProjectRules: [], requiresUserJudgment: [], deferredToSpec: [],
        },
        questionLedger: {
          revision: 0,
          publication: "canonical-review-writer-test",
          evidenceDigest: "c".repeat(64),
          questions: [],
        },
      };
      const draft = Buffer.from(`${JSON.stringify(draftDocument, null, 2)}\n`, "utf8");
      advanceTo(manager, created.specId, "draft");
      manager.confirmCurrentAttempt({
        specId: created.specId,
        artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: draft }],
      });
      let agentCalls = 0;
      let outputDirectory = null;
      let childCwd = null;
      const runActualDraftWriter = async (_command, _args, options) => {
          outputDirectory = options.env.SENNEL_REVIEW_OUTPUT_DIR;
          childCwd = options.cwd;
          const keys = Object.keys(options.env).filter((key) => key.startsWith("SENNEL_REVIEW_"));
          const previous = new Map(keys.map((key) => [key, process.env[key]]));
          try {
            for (const key of keys) process.env[key] = options.env[key];
            container.reset();
            container.register("root", executionRoot);
            container.register("mainRoot", repository);
            container.register("flowManager", manager);
            container.register("config", { flow: { review: {} } });
            container.register("agent", {
              resolve: () => ({ provider: "writer-fixture" }),
              call: async () => { agentCalls += 1; return "NO_PROPOSALS"; },
            });
            await new FlowReviewCommand().execute({ _rawArgs: ["--phase", "draft"] });
          } finally {
            for (const [key, value] of previous) {
              if (value === undefined) delete process.env[key];
              else process.env[key] = value;
            }
            container.reset();
          }
          return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
      };
      if (reviewPhase === "draft-coverage") {
        manager.updateStepStatus(
          { stepId: "draft-questions-review", requestedStatus: "in_progress" },
          { specId: created.specId },
        );
        const questions = new RunReviewCommand({
          resolveTreeSha: () => "a".repeat(40),
          resolveTargetStateDigest: () => "b".repeat(64),
          runCommand: runActualDraftWriter,
        });
        const questionsCtx = {
          root: repository, mainRoot: repository, executionRoot, specId: created.specId,
          phase: "draft", flowManager: manager, flowState: manager.load(created.specId), config: {},
        };
        const questionsResult = await questions.execute(questionsCtx);
        await FLOW_COMMANDS.run.review.post(questionsCtx, questionsResult);
        manager.updateStepStatus(
          { stepId: "draft-refine", requestedStatus: "in_progress" },
          { specId: created.specId },
        );
        manager.confirmCurrentAttempt({
          specId: created.specId,
          artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: draft }],
        });
        manager.updateStepStatus(
          { stepId: "draft-coverage-review", requestedStatus: "in_progress" },
          { specId: created.specId },
        );
      } else {
        manager.updateStepStatus(
          { stepId: "draft-questions-review", requestedStatus: "in_progress" },
          { specId: created.specId },
        );
      }
      const review = new RunReviewCommand({
        resolveTreeSha: () => "a".repeat(40),
        resolveTargetStateDigest: () => "b".repeat(64),
        runCommand: runActualDraftWriter,
      });
      const ctx = {
        root: repository, mainRoot: repository, executionRoot, specId: created.specId,
        phase: "draft", flowManager: manager, flowState: manager.load(created.specId), config: {},
      };
      const result = await review.execute(ctx);
      assert.equal(agentCalls, reviewPhase === "draft-coverage" ? 2 : 1);
      assert.equal(result.artifacts.phase, reviewPhase);
      assert.equal(result.artifacts.verdict, "PASS");
      assert.equal(fs.existsSync(path.join(outputDirectory, reviewPhase === "draft-questions"
        ? "draft-review-questions.json"
        : "draft-review-coverage.json")), true);
      assert.equal(outputDirectory.startsWith(path.join(executionRoot, ".sennel", "review-work-units")), true);
      assert.equal(path.resolve(childCwd), executionRoot);
      assert.equal(fs.existsSync(path.join(repository, ".sennel", "review-work-units")), false);
      await FLOW_COMMANDS.run.review.post(ctx, result);
      assert.equal(fs.existsSync(outputDirectory), false);
      assert.equal(manager.activityLedger(created.specId).some((activity) => activity.type === "result_confirmed"), true);
      const completedDraft = JSON.parse(manager.readArtifact({
        specId: created.specId,
        logicalKey: "draft",
        consumerNodeId: reviewPhase === "draft-coverage" ? "draft-gate" : "draft-refine",
      }).bytes.toString("utf8"));
      assert.deepEqual(completedDraft, draftDocument);
      if (reviewPhase === "draft-coverage") {
        const completion = manager.activityLedger(created.specId).at(-1);
        assert.equal(findStepById(manager.load(created.specId).steps, "draft-coverage-repair").status, "done");
        assert.equal(manager.canonicalState(created.specId).nextAction().nodeId, "draft-gate");
        assert.equal(completion.result.artifactRefs.at(-1).kind, "draft-completion-connector");
      }
    });
  }

  for (const verdict of ["PASS", "ADVISORY"]) {
    it(`replays a sealed draft-questions ${verdict} result without rerunning the worker`, async () => {
      const repository = root();
      const executionRoot = path.join(repository, "execution");
      fs.mkdirSync(executionRoot, { recursive: true });
      initializeReviewSource(executionRoot);
      const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
      const created = manager.createFresh(request(`001-canonical-draft-replay-${verdict.toLowerCase()}`));
      manager.addActiveFlow(created.specId, "direct");
      const draft = canonicalDraftBytes("Replay sealed draft review");
      advanceTo(manager, created.specId, "draft");
      manager.confirmCurrentAttempt({
        specId: created.specId,
        artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: draft }],
      });
      manager.updateStepStatus(
        { stepId: "draft-questions-review", requestedStatus: "in_progress" },
        { specId: created.specId },
      );

      let workerRuns = 0;
      let outputDirectory = null;
      const command = new RunReviewCommand({
        resolveTreeSha: () => "a".repeat(40),
        resolveTargetStateDigest: () => "b".repeat(64),
        runCommand(_command, _args, options) {
          workerRuns += 1;
          outputDirectory = options.env.SENNEL_REVIEW_OUTPUT_DIR;
          const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
          fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "draft-review-questions.json"), `${JSON.stringify({
            version: 2,
            phase: "draft-questions",
            sourceDraft: "draft.json",
            sourceDraftRevision: source.revision,
            generatedAt: "2026-08-14T00:00:00.000Z",
            verdict,
            summary: "Replay-safe review output.",
            blockingFindings: [],
            advisoryFindings: verdict === "ADVISORY" ? [{ id: "draft-advice", summary: "Optional cleanup." }] : [],
            repairTargets: [],
          }, null, 2)}\n`);
          ReviewWorkUnit.fromEnvironment(options.env).seal();
          return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
        },
      });
      const ctx = {
        root: repository,
        mainRoot: repository,
        executionRoot,
        specId: created.specId,
        phase: "draft",
        flowManager: manager,
        flowState: manager.load(created.specId),
        config: {},
      };

      const beforeCrash = await command.execute(ctx);
      assert.equal(Object.hasOwn(beforeCrash, "next"), false);
      assert.equal(workerRuns, 1);
      const recovered = await command.execute({ ...ctx, flowState: manager.load(created.specId) });
      assert.equal(workerRuns, 1, "a sealed work unit must not invoke the Agent again");
      assert.equal(recovered.artifacts.verdict, verdict);
      assert.equal(Object.hasOwn(recovered, "next"), false);
      await FLOW_COMMANDS.run.review.post({ ...ctx, flowState: manager.load(created.specId) }, recovered);
      assert.equal(
        findStepById(manager.load(created.specId).steps, "draft-questions-review").status,
        "done",
        "the Definition lifecycle, not the producer result, completes the review evidence",
      );
      assert.equal(fs.existsSync(outputDirectory), false, "publication confirmation cleans the sealed worker surface");
    });
  }

  it("reconciles a sealed worker surface after Store confirmation succeeds but cleanup crashes", async () => {
    const repository = root();
    const executionRoot = path.join(repository, "execution");
    fs.mkdirSync(executionRoot, { recursive: true });
    initializeReviewSource(executionRoot);
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-canonical-review-cleanup-reconcile"));
    manager.addActiveFlow(created.specId, "direct");
    const draft = canonicalDraftBytes("Reconcile cleanup");
    advanceTo(manager, created.specId, "draft");
    manager.confirmCurrentAttempt({
      specId: created.specId,
      artifactWrites: [{ logicalKey: "draft", mediaType: "application/json", bytes: draft }],
    });
    manager.updateStepStatus(
      { stepId: "draft-questions-review", requestedStatus: "in_progress" },
      { specId: created.specId },
    );
    let outputDirectory = null;
    const review = new RunReviewCommand({
      resolveTreeSha: () => "a".repeat(40),
      resolveTargetStateDigest: () => "b".repeat(64),
      runCommand(_command, _args, options) {
        outputDirectory = options.env.SENNEL_REVIEW_OUTPUT_DIR;
        const source = JSON.parse(options.env.SENNEL_REVIEW_DRAFT_SOURCE);
        fs.writeFileSync(path.join(outputDirectory, "draft-review-questions.json"), `${JSON.stringify({
          verdict: "PASS", sourceDraft: "draft.json", sourceDraftRevision: source.revision,
          blockingFindings: [], advisoryFindings: [], repairTargets: [],
        })}\n`);
        ReviewWorkUnit.fromEnvironment(options.env).seal();
        return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
      },
    });
    const ctx = {
      root: repository, mainRoot: repository, executionRoot, specId: created.specId,
      phase: "draft", flowManager: manager, flowState: manager.load(created.specId), config: {},
    };
    const result = await review.execute(ctx);
    const sealed = attachedCanonicalReviewWorkUnit(result);
    sealed.cleanup = () => { throw new Error("simulated cleanup crash"); };
    await assert.rejects(() => FLOW_COMMANDS.run.review.post(ctx, result), /simulated cleanup crash/);
    assert.equal(
      manager.activityLedger(created.specId).some((activity) => (
        activity.type === "result_confirmed" && activity.attemptId === sealed.manifestDocument.attemptId
      )),
      true,
      "Store confirmation precedes local cleanup",
    );
    assert.equal(fs.existsSync(outputDirectory), true);
    assert.equal(reconcileCompletedReviewWorkUnits({
      flowManager: manager,
      specId: created.specId,
      executionRoot,
    }), 1);
    assert.equal(fs.existsSync(outputDirectory), false);
  });

  it("materializes the shared file.map for impl review from its catalog authority", async () => {
    const repository = root();
    initializeReviewSource(repository);
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const specId = "001-canonical-file-map-review";
    const created = manager.createFresh(request(specId, {
      specRecord: new CurrentFlowSpecRecord({
        ...emptySpecStub(),
        requirements: [{ id: "R-1", desc: "Bind review to the shared file map." }],
        tasks: [],
      }, { specId }),
    }));
    manager.addActiveFlow(specId, "direct");
    advanceTo(manager, specId, "impl-review", {
      onActive(nodeId) {
        if (nodeId !== "implement") return;
        manager.updateFileMap({ specId, requirementId: "R-1", paths: ["src/mapped.js"] });
      },
    });

    let invocation = null;
    const review = new RunReviewCommand({
      resolveTreeSha: () => "a".repeat(40),
      resolveTargetStateDigest: () => "b".repeat(64),
      runCommand(command, args, options) {
        invocation = { command, args, options };
        const outputDirectory = options.env.SENNEL_REVIEW_OUTPUT_DIR;
        const specSource = JSON.parse(options.env.SENNEL_REVIEW_SPEC_SOURCE);
        const fileMapSource = JSON.parse(options.env.SENNEL_REVIEW_FILE_MAP_SOURCE);
        assert.equal(specSource.sourcePath.startsWith(`${outputDirectory}${path.sep}`), true);
        assert.equal(fileMapSource.sourcePath.startsWith(`${outputDirectory}${path.sep}`), true);
        assert.deepEqual(JSON.parse(fs.readFileSync(fileMapSource.sourcePath, "utf8")), {
          "R-1": ["src/mapped.js"],
        });
        fs.writeFileSync(path.join(outputDirectory, "impl-review.json"), `${JSON.stringify({
          verdict: "PASS",
          blockingFindings: [],
          nonBlockingImprovements: [],
        }, null, 2)}\n`);
        ReviewWorkUnit.fromEnvironment(options.env).seal();
        return {
          ok: true,
          status: 0,
          stdout: "Impl review PASS. No blocking findings or non-blocking improvements recorded.\n",
          stderr: "  [review] verdict=PASS blocking=0 nonBlocking=0\n",
          signal: null,
          killed: false,
        };
      },
    });
    const result = await review.execute({
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId,
      flowManager: manager,
      flowState: manager.load(specId),
      config: {},
    });

    assert.equal(invocation.command, "node");
    assert.equal(attachedCanonicalCommandResultArtifact(result).logicalKey, "impl.review");
    assert.equal(fs.existsSync(path.join(manager.specLocation(specId).directory, "file-map.json")), false);
  });

  it("binds rejected test-review evidence to a replacement test Attempt and handoff", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-canonical-test-review-repair", {
      specRecord: new CurrentFlowSpecRecord({ ...validWorkerHandoffSpec(), tasks: [] }, {
        specId: "001-canonical-test-review-repair",
      }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "test-review", {
      onActive(nodeId) {
        if (nodeId !== "test") return;
        manager.publishArtifacts({
          specId: created.specId,
          nodeId: "test",
          artifactWrites: [{
            logicalKey: "tests.source",
            parameters: { testPath: "requirement.test.js" },
            mediaType: "text/javascript",
            bytes: Buffer.from("// spec: R1\n", "utf8"),
          }],
        });
      },
    });
    const testArtifactStore = new CanonicalTestArtifactStore({
      flowManager: manager,
      state: manager.load(created.specId),
    });
    const sourceRevision = testArtifactStore.testSourceRevision().toJSON();
    assert.deepEqual(
      testArtifactStore.testSourceRevision().toJSON(),
      sourceRevision,
      "a cataloged test source revision is stable across repeated reads",
    );
    const evidenceDigest = "e".repeat(64);
    const finding = {
      findingId: "test-review-finding",
      fingerprint: "f".repeat(64),
      target: "requirement.test.js",
      requiredChange: "Add the missing observable assertion in this test file.",
      summary: "The test omits a required behavior.",
      disposition: "must-fix",
      rationale: "The test must cover the required behavior before acceptance.",
    };
    publishAttemptArtifact(manager, created.specId, "test-review", "test.review", {
      phase: "test",
      verdict: "REJECTED",
      blockingFindings: [finding],
      advisoryFindings: [],
      sourceTestArtifactRevision: sourceRevision,
      canonicalEvidence: {
        disposition: "REJECTED",
        // Canonical review evidence deliberately retains only identity and
        // summary.  Repair must bind it back to the rich sealed artifact.
        blockingFindings: [{
          findingId: finding.findingId,
          fingerprint: finding.fingerprint,
          severity: "blocking",
          summary: finding.summary,
          evidenceRefs: ["test-review.json#test-review-finding"],
        }],
        advisoryFindings: [],
        identity: { evidenceDigest },
      },
    });
    for (let index = 0; index < 4; index += 1) {
      manager.appendMetric({ phase: "test", counter: "reviewRetry", delta: 1 }, { specId: created.specId, taskId: null });
    }
    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
      flowState: manager.load(created.specId),
      flowCommandBoundary: true,
    };
    const next = await new GetNextActionCommand().execute(ctx);
    assert.equal(next.directive.actionId, "REPAIR_TEST_REVIEW", "four persisted retries remain below the definition maximum");

    const repaired = new RunRepairTestReviewCommand().execute({
      ...ctx,
      flowState: manager.load(created.specId),
    });
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.equal(repaired.data.nextStep, "test");
    const state = manager.load(created.specId);
    assert.equal(state.currentNodeId, "test");
    assert.equal(leaves(state.steps).find((entry) => entry.id === "scenario-validity").status, "invalidated");
    assert.equal(leaves(state.steps).find((entry) => entry.id === "test-review").status, "invalidated");
    const firstTestAction = await new GetNextActionCommand().execute({ ...ctx, flowState: state });
    const secondTestAction = await new GetNextActionCommand().execute({ ...ctx, flowState: state });
    assert.deepEqual(
      secondTestAction,
      firstTestAction,
      "repair-test-review produces a stable next action for dispatcher identity verification",
    );

    const handoff = new WorkerArtifactHandoffCoordinator().createRequest({
      ctx,
      state,
      invocation: {
        id: "canonical-test-review-repair",
        target: { digest: "b".repeat(64) },
        action: { digest: "a".repeat(64), nextAction: { step: "test" } },
      },
    });
    assert.deepEqual(handoff.inputs.map((entry) => entry.name), ["spec.json", "test-review.json"]);
    assert.equal(handoff.inputs[1].document.verdict, "REJECTED");
    assert.equal(fs.existsSync(path.join(manager.specLocation(created.specId).directory, "test-review.json")), false);
    handoff.prepare();
    assert.deepEqual(
      fs.readFileSync(path.join(handoff.payloadPath("spec-tests"), "requirement.test.js")),
      Buffer.from("// spec: R1\n", "utf8"),
      "repair payload starts as byte-identical canonical test input",
    );
    const workerContract = handoff.toWorkerJSON();
    assert.deepEqual(workerContract.inputs.map((entry) => entry.name), ["spec.json"]);
    assert.equal(workerContract.testReviewRepair.blockingFindings.length, 1);
    assert.deepEqual(workerContract.testReviewRepair.batch.scopes[0].targetFiles, ["requirement.test.js"]);
    assert.match(workerContract.testReviewRepair.batch.scopes[0].repairScope, /observable assertion/);
  });

  it("publishes one shared test-review repair batch receipt and resumes without rerunning it", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-test-review-repair-progress", {
      specRecord: new CurrentFlowSpecRecord({ ...validWorkerHandoffSpec(), tasks: [] }, {
        specId: "001-test-review-repair-progress",
      }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    const original = Buffer.from([
      "// spec: R1",
      'import test from "node:test";',
      'test("R1: preserves the original premise", () => {});',
      "",
    ].join("\n"), "utf8");
    advanceTo(manager, created.specId, "test-review", {
      onActive(nodeId) {
        if (nodeId !== "test") return;
        manager.publishArtifacts({
          specId: created.specId,
          nodeId: "test",
          artifactWrites: [{
            logicalKey: "tests.source", parameters: { testPath: "requirement.test.js" },
            mediaType: "text/javascript", bytes: original,
          }],
        });
      },
    });
    const sourceRevision = new CanonicalTestArtifactStore({ flowManager: manager, state: manager.load(created.specId) })
      .testSourceRevision().toJSON();
    const findings = [
      { findingId: "finding-one", fingerprint: "1".repeat(64), target: "requirement.test.js", requiredChange: "Add assertion one.", disposition: "must-fix", rationale: "Required." },
      { findingId: "finding-two", fingerprint: "2".repeat(64), target: "requirement.test.js", requiredChange: "Add assertion two.", disposition: "must-fix", rationale: "Required." },
    ];
    publishAttemptArtifact(manager, created.specId, "test-review", "test.review", {
      phase: "test", verdict: "REJECTED", blockingFindings: findings, advisoryFindings: [], sourceTestArtifactRevision: sourceRevision,
      canonicalEvidence: { disposition: "REJECTED", blockingFindings: findings, advisoryFindings: [], identity: { evidenceDigest: "e".repeat(64) } },
    });
    const ctx = { root: repository, mainRoot: repository, executionRoot: repository, specId: created.specId, flowManager: manager, flowState: manager.load(created.specId), flowCommandBoundary: true };
    assert.equal(new RunRepairTestReviewCommand().execute(ctx).ok, true);
    const selectedAction = await new GetNextActionCommand().execute({ ...ctx, flowState: manager.load(created.specId) });
    assert.deepEqual(selectedAction.context.testReviewRepair.blockingFindings.map((entry) => entry.findingId), ["finding-one", "finding-two"]);
    assert.equal(selectedAction.context.testReviewRepair.batch.findingIds.length, 2);
    const invocation = { id: "test-review-progress", target: { digest: "b".repeat(64) }, action: { digest: "a".repeat(64), nextAction: { step: "test" } } };
    const coordinator = new WorkerArtifactHandoffCoordinator();
    const interrupted = coordinator.createRequest({
      ctx,
      state: manager.load(created.specId),
      invocation: { ...invocation, id: "test-review-progress-crash" },
    }).prepare();
    sealWorkerArtifactHandoff({ requestPath: interrupted.requestPath, invocationId: "test-review-progress-crash" });
    assert.deepEqual(coordinator.recoverPending({ ctx }), {
      completed: true,
      replayed: true,
      cleanedHandoffs: 1,
    });
    assert.equal(manager.load(created.specId).currentNodeId, "test", "an uncommitted restored request cannot complete the full test Attempt");
    assert.equal(manager.readArtifact({
      specId: created.specId,
      logicalKey: "test.review.repair.progress",
      consumerNodeId: "test",
      optional: true,
    }), null);
    const first = coordinator.createRequest({ ctx, state: manager.load(created.specId), invocation }).prepare();
    assert.ok(first.workerVisibleTestReviewRepair instanceof WorkerVisibleTestReviewRepair);
    const firstRequestText = fs.readFileSync(first.requestPath, "utf8");
    assert.match(firstRequestText, /finding-one/);
    assert.match(firstRequestText, /finding-two/);
    const firstFile = path.join(first.payloadPath("spec-tests"), "requirement.test.js");
    assert.deepEqual(fs.readFileSync(firstFile), original);
    fs.appendFileSync(firstFile, "// repaired finding one\n");
    sealWorkerArtifactHandoff({ requestPath: first.requestPath, invocationId: invocation.id });
    const sealedFirst = JSON.parse(fs.readFileSync(first.submissionPath, "utf8"));
    const journal = new WorkerArtifactPublicationJournal({
      version: 1,
      runId: first.runId,
      specId: first.specId,
      issue: first.issue,
      stepId: first.stepId,
      actionDigest: first.actionDigest,
      dispatchInvocationId: first.dispatchInvocationId,
      requestDigest: first.requestDigest,
      handoffDigest: sealedFirst.handoffDigest,
      inputDigest: first.inputDigest,
      inputRevision: first.inputRevision,
      handoffDirectory: first.directory,
      payloadManifest: sealedFirst.payloadManifest,
      targetBaselines: first.payloads.map(({ rule, baselineDigest, baselineByteLength, baselineEntries }) => ({
        logicalName: rule.logicalName,
        kind: rule.kind,
        targetRelativePath: rule.targetRelativePath,
        digest: baselineDigest,
        byteLength: baselineByteLength,
        entries: baselineEntries,
      })),
      startedAt: "2026-08-01T00:00:00.000Z",
    });
    const restoredFirst = WorkerArtifactHandoffRequest.restore({
      mainRoot: repository,
      state: manager.load(created.specId),
      journal,
      flowManager: manager,
      canonicalLocation: manager.specLocation(created.specId),
    });
    assert.equal(restoredFirst.requestDigest, first.requestDigest, "selected request restore preserves sealed request identity");
    assert.ok(restoredFirst.workerVisibleTestReviewRepair instanceof WorkerVisibleTestReviewRepair);
    assert.deepEqual(restoredFirst.workerVisibleTestReviewRepair.toJSON(), first.workerVisibleTestReviewRepair.toJSON());
    assert.deepEqual(restoredFirst.toWorkerJSON().testReviewRepair.batch.findingIds, ["finding-one", "finding-two"]);
    const partialInterrupted = new WorkerArtifactHandoffCoordinator({
      faultInjector({ phase }) {
        if (phase === "before-worker-handoff-cleanup-rename") throw new Error("partial cleanup interruption");
      },
    });
    assert.throws(
      () => partialInterrupted.reconcile({ ctx, request: restoredFirst }),
      /partial cleanup interruption/,
    );
    const liveReplay = partialInterrupted.reconcile({ ctx, request: first });
    assert.equal(liveReplay.replayed, true, "the live selected repair request recognizes its committed checkpoint");
    assert.equal(liveReplay.handoffDigest, sealedFirst.handoffDigest);
    const committedPartial = WorkerArtifactHandoffRequest.restore({
      mainRoot: repository,
      state: manager.load(created.specId),
      journal,
      flowManager: manager,
      canonicalLocation: manager.specLocation(created.specId),
    });
    assert.equal(committedPartial.testReviewRepair, null, "a committed selected request is recognized before rebinding current progress");
    assert.deepEqual(committedPartial.workerVisibleTestReviewRepair.batch.findingIds, ["finding-one", "finding-two"]);
    assert.deepEqual(coordinator.recoverPending({ ctx }), {
      completed: true,
      replayed: true,
      cleanedHandoffs: 1,
    }, "restart recognizes the published batch receipt without rerunning it");
    const progress = JSON.parse(manager.readArtifact({ specId: created.specId, logicalKey: "test.review.repair.progress", consumerNodeId: "test" }).bytes);
    assert.equal(progress.entries.find((entry) => entry.findingId === "finding-one").status, "done");
    assert.equal(progress.entries.find((entry) => entry.findingId === "finding-two").status, "done");
    assert.equal(
      leaves(manager.load(created.specId).steps).find((entry) => entry.id === "test").status,
      "done",
      "the final finding completes the original test Attempt",
    );
  });

  it("does not mix stale test-review repair into a later scenario gate test replacement", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-repair-lineage-plan-gate", {
      specRecord: new CurrentFlowSpecRecord({ ...validWorkerHandoffSpec(), tasks: [] }, {
        specId: "001-repair-lineage-plan-gate",
      }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "test-review", {
      onActive(nodeId) {
        if (nodeId !== "test") return;
        manager.publishArtifacts({
          specId: created.specId,
          nodeId: "test",
          artifactWrites: [{
            logicalKey: "tests.source",
            parameters: { testPath: "scenario.test.js" },
            mediaType: "text/javascript",
            bytes: Buffer.from([
              'import test from "node:test";',
              'test("R1: exposes an invalid scenario premise", () => {});',
              "",
            ].join("\n"), "utf8"),
          }],
        });
      },
    });
    const testStore = new CanonicalTestArtifactStore({ flowManager: manager, state: manager.load(created.specId) });
    const revision = testStore.testSourceRevision().toJSON();
    const finding = {
      findingId: "test-review-finding",
      fingerprint: "f".repeat(64),
      summary: "The test omits a required behavior.",
    };
    publishAttemptArtifact(manager, created.specId, "test-review", "test.review", {
      phase: "test",
      verdict: "REJECTED",
      blockingFindings: [finding],
      advisoryFindings: [],
      sourceTestArtifactRevision: revision,
      canonicalEvidence: {
        disposition: "REJECTED",
        blockingFindings: [finding],
        advisoryFindings: [],
        identity: { evidenceDigest: "e".repeat(64) },
      },
    });
    const context = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
      flowState: manager.load(created.specId),
      config: {},
      flowCommandBoundary: true,
    };
    const reviewRepair = new RunRepairTestReviewCommand().execute(context);
    assert.equal(reviewRepair.ok, true, JSON.stringify(reviewRepair));
    confirmFixtureStep(manager, "test", { specId: created.specId });
    manager.updateStepStatus({ stepId: "scenario-validity", requestedStatus: "in_progress" }, { specId: created.specId });
    context.flowState = manager.load(created.specId);
    const scenario = new RunScenarioValidityCommand({
      scenarioTestExecutor: async ({ executions }) => executions.map((execution) => ({
        file: execution.file,
        requirementId: execution.requirementId,
        command: `node --test ${execution.file}`,
        process: {
          started: true,
          exitCode: 0,
          signal: null,
          timedOut: false,
          spawnError: null,
          stdout: "",
          stderr: "",
        },
      })),
    });
    const blocked = await scenario.execute(context);
    assert.equal(blocked.result, "block");
    await FLOW_COMMANDS.run["scenario-validity"].post(context, blocked);
    context.flowState = manager.load(created.specId);

    const state = manager.load(created.specId);
    const next = await new GetNextActionCommand().execute({ ...context, flowState: state });
    assert.equal(next.step, "test");
    assert.ok(next.context.planGateRepair);
    assert.equal(Object.hasOwn(next.context, "testReviewRepair"), false);
    const handoff = new WorkerArtifactHandoffCoordinator().createRequest({
      ctx: context,
      state,
      invocation: {
        id: "repair-lineage-plan-gate",
        target: { digest: "b".repeat(64) },
        action: { digest: "a".repeat(64), nextAction: { step: "test" } },
      },
    });
    assert.ok(handoff);
    assert.doesNotThrow(() => handoff.assertCurrent(state));

    manager.publishArtifacts({
      specId: created.specId,
      nodeId: "test",
      artifactWrites: [{
        logicalKey: "tests.source",
        parameters: { testPath: "scenario.test.js" },
        mediaType: "text/javascript",
        bytes: Buffer.from([
          'import test from "node:test";',
          'test("R1: covers the repaired scenario", () => {});',
          "",
        ].join("\n"), "utf8"),
      }],
    });
    confirmFixtureStep(manager, "test", { specId: created.specId });
    manager.updateStepStatus(
      { stepId: "scenario-validity", requestedStatus: "in_progress" },
      { specId: created.specId },
    );
    confirmFixtureStep(manager, "scenario-validity", { specId: created.specId });
    manager.updateStepStatus(
      { stepId: "test-review", requestedStatus: "in_progress" },
      { specId: created.specId },
    );

    const resumedReviewState = manager.load(created.specId);
    const resumedCanonicalReviewState = manager.canonicalState(created.specId);
    const resumedReview = await new GetNextActionCommand().execute({
      ...context,
      flowState: resumedReviewState,
    });
    assert.equal(resumedCanonicalReviewState.attempt.nodeId, "test-review");
    assert.ok(
      resumedCanonicalReviewState.attempt.sequence > 1,
      "the replacement test must enter a new test-review Attempt",
    );
    assert.equal(resumedReview.step, "test-review");
    assert.notEqual(resumedReview.directive.actionId, "REPAIR_TEST_REVIEW");

    const stateBeforeRejectedRepair = resumedCanonicalReviewState.toJSON();
    const rejectedHistoricalRepair = new RunRepairTestReviewCommand().execute({
      ...context,
      flowState: resumedReviewState,
    });
    assert.equal(rejectedHistoricalRepair.ok, false);
    assert.equal(rejectedHistoricalRepair.errors[0].code, "TEST_REVIEW_REPAIR_STAGE_UNSUPPORTED");
    assert.deepEqual(manager.canonicalState(created.specId).toJSON(), stateBeforeRejectedRepair);
  });

  it("preserves current test-review Attempt evidence and revision guards", async () => {
    const cases = [
      {
        label: "stale source revision",
        expectedCode: "TEST_REVIEW_REPAIR_REVISION_MISMATCH",
        alter({ payload }) {
          return {
            ...payload,
            sourceTestArtifactRevision: {
              ...payload.sourceTestArtifactRevision,
              digest: "0".repeat(64),
            },
          };
        },
      },
      {
        label: "invalid canonical evidence",
        expectedDirectiveCode: "TEST_REVIEW_REPAIR_EVIDENCE_INVALID",
        alter({ payload }) {
          return {
            ...payload,
            canonicalEvidence: {
              ...payload.canonicalEvidence,
              blockingFindings: [],
            },
          };
        },
      },
      {
        label: "exhausted stale source revision converges before repair validation",
        exhausted: true,
        alter({ payload }) {
          return {
            ...payload,
            sourceTestArtifactRevision: {
              ...payload.sourceTestArtifactRevision,
              digest: "0".repeat(64),
            },
          };
        },
      },
    ];

    for (const testCase of cases) {
      const repository = root();
      const caseId = testCase.expectedCode ?? testCase.expectedDirectiveCode ?? "exhausted-stale-revision";
      const specId = `001-current-review-guard-${caseId.toLowerCase()}`;
      const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
      const created = manager.createFresh(request(specId, {
        specRecord: new CurrentFlowSpecRecord({ ...validWorkerHandoffSpec(), tasks: [] }, { specId }),
      }));
      manager.addActiveFlow(created.specId, "direct");
      advanceTo(manager, created.specId, "test-review", {
        onActive(nodeId) {
          if (nodeId !== "test") return;
          manager.publishArtifacts({
            specId: created.specId,
            nodeId: "test",
            artifactWrites: [{
              logicalKey: "tests.source",
              parameters: { testPath: "requirement.test.js" },
              mediaType: "text/javascript",
              bytes: Buffer.from("// spec: R1\n", "utf8"),
            }],
          });
        },
      });
      const staleFlowState = manager.load(created.specId);
      const currentState = manager.canonicalState(created.specId);
      const revision = new CanonicalTestArtifactStore({
        flowManager: manager,
        state: currentState,
      }).testSourceRevision().toJSON();
      const finding = {
        findingId: "test-review-finding",
        fingerprint: "f".repeat(64),
        summary: "The test omits a required behavior.",
        disposition: "must-fix",
        rationale: "The test must cover the required behavior before acceptance.",
      };
      const payload = testCase.alter({
        payload: {
          phase: "test",
          verdict: "REJECTED",
          blockingFindings: [finding],
          advisoryFindings: [],
          sourceTestArtifactRevision: revision,
          canonicalEvidence: {
            disposition: "REJECTED",
            blockingFindings: [finding],
            advisoryFindings: [],
            identity: { evidenceDigest: "e".repeat(64) },
          },
        },
      });
      publishAttemptArtifact(manager, created.specId, "test-review", "test.review", payload);
      assert.equal(currentState.attempt.sequence, 1, `${testCase.label} fixture must own review Attempt 1`);
      if (testCase.exhausted === true) {
        for (let index = 0; index < 5; index += 1) {
          manager.appendMetric({ phase: "test", counter: "reviewRetry", delta: 1 }, { specId: created.specId, taskId: null });
        }
      }

      const context = {
        root: repository,
        mainRoot: repository,
        executionRoot: repository,
        specId: created.specId,
        flowManager: manager,
        flowState: staleFlowState,
        config: {},
        flowCommandBoundary: true,
      };
      let workerCalls = 0;
      const beforeDirectState = manager.canonicalState(created.specId).toJSON();
      const beforeDirectActivities = manager.activityLedger(created.specId).length;
      const deniedDirectReview = await new RunReviewCommand({
        runCommand: async () => {
          workerCalls += 1;
          return { ok: true, stdout: "", stderr: "" };
        },
      }).execute({ ...context, phase: "test" });
      assert.equal(deniedDirectReview.ok, false, testCase.label);
      assert.equal(deniedDirectReview.errors[0].code, "REVIEW_DEFINITION_ACTION_REQUIRED", testCase.label);
      assert.equal(workerCalls, 0, `${testCase.label} must not start a Review worker`);
      assert.deepEqual(manager.canonicalState(created.specId).toJSON(), beforeDirectState, testCase.label);
      assert.equal(manager.activityLedger(created.specId).length, beforeDirectActivities, testCase.label);
      if (testCase.exhausted === true) {
        const next = await new GetNextActionCommand().execute(context);
        assert.equal(next.directive.actionId, "SETTLE_REVIEW_DEFER");
        assert.match(next.directive.nextAction, /settle-review-transition/);
      } else if (testCase.expectedDirectiveCode) {
        const next = await new GetNextActionCommand().execute(context);
        assert.equal(next.directive.code, testCase.expectedDirectiveCode, testCase.label);
      } else {
        await assert.rejects(
          () => new GetNextActionCommand().execute(context),
          (error) => error.code === testCase.expectedCode,
          testCase.label,
        );
      }
    }
  });

  it("settles a definition-selected exhausted test-review deferral without rerunning review", async () => {
    const repository = root();
    const specId = "001-test-review-defer-settlement";
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request(specId, {
      specRecord: new CurrentFlowSpecRecord({ ...validWorkerHandoffSpec(), tasks: [] }, { specId }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "test-review", {
      onActive(nodeId) {
        if (nodeId !== "test") return;
        manager.publishArtifacts({
          specId: created.specId,
          nodeId: "test",
          artifactWrites: [{
            logicalKey: "tests.source",
            parameters: { testPath: "deferred.test.js" },
            mediaType: "text/javascript",
            bytes: Buffer.from("// spec: R1\n", "utf8"),
          }],
        });
      },
    });
    const revision = new CanonicalTestArtifactStore({
      flowManager: manager,
      state: manager.load(created.specId),
    }).testSourceRevision().toJSON();
    const finding = {
      findingId: "deferred-test-review-finding",
      fingerprint: "f".repeat(64),
      summary: "The test omits a required behavior.",
      disposition: "must-fix",
      rationale: "The test must cover the required behavior before acceptance.",
    };
    publishAttemptArtifact(manager, created.specId, "test-review", "test.review", {
      phase: "test",
      verdict: "REJECTED",
      blockingFindings: [finding],
      sourceTestArtifactRevision: revision,
      canonicalEvidence: {
        disposition: "REJECTED",
        blockingFindings: [finding],
        advisoryFindings: [],
        identity: { evidenceDigest: "e".repeat(64) },
      },
    });
    for (let index = 0; index < 5; index += 1) {
      manager.appendMetric({ phase: "test", counter: "reviewRetry", delta: 1 }, { specId: created.specId, taskId: null });
    }
    const context = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
      flowState: manager.load(created.specId),
      flowCommandBoundary: true,
    };
    const before = await new GetNextActionCommand().execute(context);
    assert.equal(before.directive.actionId, "SETTLE_REVIEW_DEFER");
    assert.match(before.directive.nextAction, /settle-review-transition/);

    const beforeSettlementActivities = manager.activityLedger(created.specId).length;
    const settled = new RunSettleReviewTransitionCommand().execute(context);
    assert.equal(settled.ok, true, JSON.stringify(settled));
    const reloaded = manager.load(created.specId);
    assert.equal(leaves(reloaded.steps).find((entry) => entry.id === "test-review").status, "done");
    const deferred = manager.readArtifact({
      specId: created.specId,
      logicalKey: "flow.findings",
      consumerNodeId: "acceptance-review",
    });
    assert.equal(JSON.parse(deferred.bytes.toString("utf8")).entries.length, 1);
    assert.equal(manager.activityLedger(created.specId).length, beforeSettlementActivities + 1);
    assert.equal(manager.activityLedger(created.specId).at(-1).transition.operation, "confirm_attempt");
    const first = await new GetNextActionCommand().execute({ ...context, flowState: reloaded });
    const second = await new GetNextActionCommand().execute({ ...context, flowState: manager.load(created.specId) });
    assert.deepEqual(second, first, "reloaded Flow projects one stable next Action after review deferral");
  });

  it("keeps an unresolved Task Review in triage and out of Acceptance deferral", async () => {
    const repository = root();
    initializeReviewSource(repository);
    const specId = "001-task-review-defer-settlement";
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    new TaskLifecycleFixture({
      flowManager: manager,
      specId,
      runId: "run-task-review-bound",
      request: "Keep Task Review findings inside the Task.",
      specRecord: {
        requirements: [{ id: "R-1", desc: "Repair the Task Review finding.", task_ids: ["T-1"] }],
        overview: { modules: [], data_flow: [], decisions: [] },
      },
      taskDocuments: [{
        id: "T-1", title: "Review transition task", goal: "Exercise Task Review exhaustion.",
        parent: null, origin: "plan", added_round: 0, status: "pending",
      }],
      taskId: "T-1",
      targetStep: "task-review",
    }).create();
    const result = await publishTaskReview({
      repository,
      manager,
      specId,
      blockingFindings: [canonicalTaskReviewFinding({
        findingKey: "task-review-unresolved-finding",
        title: "Task behavior remains incomplete",
        failureMode: "spec_behavior_contradiction",
        file: "README.md",
        requirementId: "R-1",
        issue: "The current Task behavior is incomplete.",
        suggestion: "Implement the mapped requirement.",
        disposition: "must-fix",
        rationale: "The implementation omits required behavior.",
      })],
    });
    assert.notEqual(result.ok, false, JSON.stringify(result));
    const context = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId,
      flowManager: manager,
      flowState: manager.load(specId),
      flowCommandBoundary: true,
    };

    const next = await new GetNextActionCommand().execute(context);
    assert.equal(next.taskId, "T-1");
    assert.equal(next.step, "task-triage");
    assert.equal(next.action, "write-task-triage");
    assert.equal(new RunSettleReviewTransitionCommand().execute(context).ok, false);
    assert.equal(manager.readArtifact({ specId, logicalKey: "flow.findings", consumerNodeId: "acceptance-review", optional: true }), null);
  });

  it("settles exhausted flow impl-review from current persisted evidence and resumes after partial publication", async () => {
    const repository = root();
    const specId = "001-impl-review-partial-settlement";
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request(specId, {
      specRecord: new CurrentFlowSpecRecord({ ...validWorkerHandoffSpec(), tasks: [] }, { specId }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "impl-review");
    const finding = {
      findingId: "impl-review-must-fix",
      fingerprint: "a".repeat(64),
      summary: "The implementation leaves a required behavior unresolved.",
      rationale: "The unresolved behavior is required by the accepted specification.",
      evidenceRefs: ["src/example.js:1"],
      disposition: "must-fix",
    };
    publishAttemptArtifact(manager, created.specId, "impl-review", "impl.review", {
      phase: "impl",
      verdict: "REJECTED",
      blockingFindings: [finding],
      advisoryFindings: [],
      canonicalEvidence: {
        disposition: "REJECTED",
        blockingFindings: [finding],
        advisoryFindings: [],
        identity: { evidenceDigest: "e".repeat(64) },
      },
    });
    for (let index = 0; index < 4; index += 1) {
      manager.appendMetric({ phase: "impl", counter: "reviewRetry", delta: 1 }, { specId: created.specId, taskId: null });
    }
    const context = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
      flowState: manager.load(created.specId),
      flowCommandBoundary: true,
    };
    const next = await new GetNextActionCommand().execute(context);
    assert.equal(next.step, "impl-review");
    assert.equal(next.directive.actionId, "SETTLE_REVIEW_DEFER");
    const beforeInterruptedSettlement = {
      state: manager.canonicalState(created.specId).toJSON(),
      activities: manager.activityLedger(created.specId),
      catalog: manager.artifactCatalog(created.specId).toJSON(),
    };
    const beforeInterruptedPublicationCount = beforeInterruptedSettlement.activities
      .filter((activity) => activity.type === "artifacts_published" && activity.nodeId === "impl-review").length;

    let interrupted = false;
    const interruptedManager = new Proxy(manager, {
      get(target, property) {
        if (property === "confirmCurrentAttempt") {
          return (...args) => {
            if (!interrupted) {
              interrupted = true;
              throw new Error("simulated crash before atomic review settlement");
            }
            return target.updateStepStatus(...args);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const partial = new RunSettleReviewTransitionCommand().execute({
      ...context,
      flowManager: interruptedManager,
    });
    assert.equal(partial.ok, false);
    assert.match(partial.errors[0].messages.join("\n"), /simulated crash/);
    assert.equal(manager.canonicalState(created.specId).current.at(-1), "impl-review");
    const publishedBeforeRetry = manager.activityLedger(created.specId)
      .filter((activity) => activity.type === "artifacts_published" && activity.nodeId === "impl-review").length;
    assert.deepEqual({
      state: manager.canonicalState(created.specId).toJSON(),
      activities: manager.activityLedger(created.specId),
      catalog: manager.artifactCatalog(created.specId).toJSON(),
    }, beforeInterruptedSettlement);
    assert.equal(publishedBeforeRetry, beforeInterruptedPublicationCount, "interrupted settlement must not publish flow.findings ahead of review state");

    const settled = new RunSettleReviewTransitionCommand().execute({
      ...context,
      flowManager: manager,
      flowState: manager.load(created.specId),
    });
    assert.equal(settled.ok, true, JSON.stringify(settled));
    assert.equal(manager.canonicalState(created.specId).findNode("impl-review").status, "done");
    assert.equal(manager.canonicalState(created.specId).findNode("impl-triage").status, "done");
    assert.equal(manager.canonicalState(created.specId).findNode("impl-repair").status, "done");
    const findings = manager.readArtifact({
      specId: created.specId,
      logicalKey: "flow.findings",
      consumerNodeId: "acceptance-review",
    });
    assert.deepEqual(
      JSON.parse(findings.bytes.toString("utf8")).entries.map((entry) => entry.fingerprint),
      [finding.fingerprint],
    );
    const publishedAfterRetry = manager.activityLedger(created.specId)
      .filter((activity) => activity.type === "artifacts_published" && activity.nodeId === "impl-review").length;
    assert.equal(publishedAfterRetry, publishedBeforeRetry, "settlement attaches flow.findings to its lifecycle Activity");
    const afterSettlement = await new GetNextActionCommand().execute({
      ...context,
      flowState: manager.load(created.specId),
    });
    assert.equal(afterSettlement.step, "impl-gate");
  });

  it("blocks non-deferrable exhausted test-review evidence with a stable identity", async () => {
    const repository = root();
    const specId = "001-test-review-blocked-settlement";
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request(specId, {
      specRecord: new CurrentFlowSpecRecord({ ...validWorkerHandoffSpec(), tasks: [] }, { specId }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "test-review", {
      onActive(nodeId) {
        if (nodeId !== "test") return;
        manager.publishArtifacts({
          specId: created.specId,
          nodeId: "test",
          artifactWrites: [{
            logicalKey: "tests.source",
            parameters: { testPath: "blocked.test.js" },
            mediaType: "text/javascript",
            bytes: Buffer.from("// spec: R1\n", "utf8"),
          }],
        });
      },
    });
    const revision = new CanonicalTestArtifactStore({ flowManager: manager, state: manager.load(created.specId) }).testSourceRevision().toJSON();
    const finding = {
      findingId: "mechanical-test-review-finding",
      fingerprint: "f".repeat(64),
      summary: "The review evidence is mechanically malformed.",
      failureKind: "schema_error",
    };
    publishAttemptArtifact(manager, created.specId, "test-review", "test.review", {
      phase: "test",
      verdict: "REJECTED",
      blockingFindings: [finding],
      sourceTestArtifactRevision: revision,
      canonicalEvidence: {
        disposition: "REJECTED",
        blockingFindings: [finding],
        advisoryFindings: [],
        identity: { evidenceDigest: "e".repeat(64) },
      },
    });
    for (let index = 0; index < 5; index += 1) {
      manager.appendMetric({ phase: "test", counter: "reviewRetry", delta: 1 }, { specId: created.specId, taskId: null });
    }
    const context = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
      flowState: manager.load(created.specId),
      flowCommandBoundary: true,
    };
    let workerCalls = 0;
    const beforeDirectState = manager.canonicalState(created.specId).toJSON();
    const beforeDirectActivities = manager.activityLedger(created.specId).length;
    const deniedDirectReview = await new RunReviewCommand({
      runCommand: async () => {
        workerCalls += 1;
        return { ok: true, stdout: "", stderr: "" };
      },
    }).execute({ ...context, phase: "test" });
    assert.equal(deniedDirectReview.ok, false);
    assert.equal(deniedDirectReview.errors[0].code, "REVIEW_DEFINITION_ACTION_REQUIRED");
    assert.equal(workerCalls, 0);
    assert.deepEqual(manager.canonicalState(created.specId).toJSON(), beforeDirectState);
    assert.equal(manager.activityLedger(created.specId).length, beforeDirectActivities);
    const first = await new GetNextActionCommand().execute(context);
    const second = await new GetNextActionCommand().execute({ ...context, flowState: manager.load(created.specId) });
    assert.equal(first.directive.code, "REVIEW_MAX_ATTEMPTS_EXCEEDED");
    assert.deepEqual(second, first);
  });

  it("derives every cataloged test member finalization from durable test confirmations", () => {
    const state = { schemaRevision: 3, runId: "test-source-run", specId: "001-test-source-provenance" };
    const descriptor = (testPath, activityId) => ({
      logicalKey: "tests.source",
      slot: { publicationStep: "test" },
      relativePath: `artifacts/tests/${testPath}`,
      hash: "a".repeat(64),
      size: 12,
      activityId,
    });
    const confirmation = (id, attemptId, sequence, confirmedAt, confirmationOrder) => ({
      id,
      type: "result_confirmed",
      nodeId: "test",
      attemptId,
      sequence,
      confirmationOrder,
      transition: { operation: "confirm_attempt", nodeId: "test", status: "done" },
      result: { outcome: "passed", confirmedAt },
      timing: null,
    });
    const publication = (id, attemptId, sequence, confirmationOrder) => ({
      id,
      type: "artifacts_published",
      nodeId: "test",
      attemptId,
      sequence,
      confirmationOrder,
      transition: { operation: "publish_artifacts", nodeId: "test", status: null },
      result: null,
      timing: null,
    });
    const catalog = {
      artifacts: [
        descriptor("direct.test.js", "confirm-direct"),
        descriptor("published-first.test.js", "publish-first"),
        descriptor("published-last.test.js", "publish-last"),
      ],
    };
    const activities = [
      confirmation("confirm-direct", "test-attempt-direct", 1, "2026-08-23T00:00:00.000Z", 1),
      publication("publish-first", "test-attempt-first", 2, 2),
      confirmation("confirm-first", "test-attempt-first", 2, "2026-08-23T00:01:00.000Z", 3),
      publication("publish-last", "test-attempt-last", 3, 4),
      confirmation("confirm-last", "test-attempt-last", 3, "2026-08-23T00:02:00.000Z", 5),
    ];

    const first = CanonicalTestSourceRevision.fromCatalog({ state, catalog, activities }).toJSON();
    const second = CanonicalTestSourceRevision.fromCatalog({ state, catalog, activities }).toJSON();

    assert.equal(first.finalizedAt, "2026-08-23T00:02:00.000Z");
    assert.deepEqual(second, first, "rebuilding the same canonical revision must not use read time");
  });

  it("rejects test-source revisions without complete durable provenance", () => {
    const state = { schemaRevision: 3, runId: "test-source-run", specId: "001-test-source-provenance-errors" };
    const descriptor = (activityId) => ({
      logicalKey: "tests.source",
      slot: { publicationStep: "test" },
      relativePath: "artifacts/tests/requirement.test.js",
      hash: "a".repeat(64),
      size: 12,
      activityId,
    });
    const invalidConfirmation = {
      id: "failed-confirmation",
      type: "result_confirmed",
      nodeId: "test",
      attemptId: "test-attempt",
      sequence: 1,
      confirmationOrder: 2,
      transition: { operation: "confirm_attempt", nodeId: "test", status: "done" },
      result: { outcome: "failed", confirmedAt: "2026-08-23T00:00:00.000Z" },
    };
    const assertUnavailable = ({ artifacts, activities }) => {
      assert.throws(
        () => CanonicalTestSourceRevision.fromCatalog({ state, catalog: { artifacts }, activities }),
        (error) => error instanceof CanonicalTestSourceProvenanceError
          && error.code === "CANONICAL_TEST_SOURCE_REVISION_UNAVAILABLE",
      );
    };

    assertUnavailable({ artifacts: [], activities: [] });
    assertUnavailable({ artifacts: [descriptor(null)], activities: [] });
    assertUnavailable({ artifacts: [descriptor("missing-activity")], activities: [] });
    assertUnavailable({ artifacts: [descriptor("failed-confirmation")], activities: [invalidConfirmation] });
    assertUnavailable({
      artifacts: [descriptor("invalid-confirmation")],
      activities: [{ ...invalidConfirmation, id: "invalid-confirmation", result: { outcome: "passed", confirmedAt: "not-a-timestamp" } }],
    });
    assertUnavailable({
      artifacts: [descriptor("publish-after-confirmation")],
      activities: [
        {
          id: "publish-after-confirmation",
          type: "artifacts_published",
          nodeId: "test",
          attemptId: "test-attempt",
          sequence: 1,
          confirmationOrder: 2,
          transition: { operation: "publish_artifacts", nodeId: "test", status: null },
          result: null,
        },
        { ...invalidConfirmation, id: "earlier-confirmation", confirmationOrder: 1, result: { outcome: "passed", confirmedAt: "2026-08-23T00:00:00.000Z" } },
      ],
    });
    assertUnavailable({
      artifacts: [descriptor("publish-ambiguous")],
      activities: [
        {
          id: "publish-ambiguous",
          type: "artifacts_published",
          nodeId: "test",
          attemptId: "test-attempt",
          sequence: 1,
          confirmationOrder: 1,
          transition: { operation: "publish_artifacts", nodeId: "test", status: null },
          result: null,
        },
        { ...invalidConfirmation, id: "confirmation-one", result: { outcome: "passed", confirmedAt: "2026-08-23T00:00:00.000Z" } },
        { ...invalidConfirmation, id: "confirmation-two", confirmationOrder: 3, result: { outcome: "passed", confirmedAt: "2026-08-23T00:01:00.000Z" } },
      ],
    });
  });

  it("publishes a rejected test review before repair while retaining its active Attempt", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-canonical-test-review-publication", {
      specRecord: new CurrentFlowSpecRecord({ ...validWorkerHandoffSpec(), tasks: [] }, {
        specId: "001-canonical-test-review-publication",
      }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "test-review", {
      onActive(nodeId) {
        if (nodeId !== "test") return;
        manager.publishArtifacts({
          specId: created.specId,
          nodeId: "test",
          artifactWrites: [{
            logicalKey: "tests.source",
            parameters: { testPath: "requirement.test.js" },
            mediaType: "text/javascript",
            bytes: Buffer.from("// spec: R1\n", "utf8"),
          }],
        });
      },
    });
    let outputDirectory = null;
    let testTopology = null;
    const review = rejectedTestReviewCommand((directory, environment) => {
      outputDirectory = directory;
      testTopology = JSON.parse(environment.SENNEL_REVIEW_TEST_TOPOLOGY);
    });
    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      phase: "test",
      flowManager: manager,
      flowState: manager.load(created.specId),
      flowCommandBoundary: true,
      config: {},
    };
    const result = await review.execute(ctx);
    assert.equal(attachedCanonicalCommandResultArtifact(result).logicalKey, "test.review");
    assert.deepEqual(testTopology, {
      canonicalTestRoot: path.relative(
        repository,
        path.join(manager.specLocation(created.specId).directory, "artifacts", "tests"),
      ).split(path.sep).join("/"),
      staticRelativeImportBase: "each canonical test file",
    });

    await FLOW_COMMANDS.run.review.post(ctx, result);

    const catalog = manager.artifactCatalog(created.specId);
    assert.ok(catalog.artifacts.some((artifact) => artifact.logicalKey === "test.review"));
    assert.ok(catalog.artifacts.some((artifact) => artifact.logicalKey === "review.evidence"));
    const active = manager.canonicalState(created.specId);
    assert.equal(active.current.at(-1), "test-review");
    assert.equal(active.attempt.failure, null);
    assert.equal(fs.existsSync(outputDirectory), false, "publication confirmation cleans the sealed worker surface");

    const next = await new GetNextActionCommand().execute({ ...ctx, flowState: manager.load(created.specId) });
    assert.equal(next.directive.actionId, "REPAIR_TEST_REVIEW");
    const repaired = new RunRepairTestReviewCommand().execute({ ...ctx, flowState: manager.load(created.specId) });
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.equal(manager.canonicalState(created.specId).current.at(-1), "test");
  });

  it("retains a rejected test-review work unit when its canonical publication fails", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-canonical-test-review-publication-failure", {
      specRecord: new CurrentFlowSpecRecord({ ...validWorkerHandoffSpec(), tasks: [] }, {
        specId: "001-canonical-test-review-publication-failure",
      }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "test-review", {
      onActive(nodeId) {
        if (nodeId !== "test") return;
        manager.publishArtifacts({
          specId: created.specId,
          nodeId: "test",
          artifactWrites: [{
            logicalKey: "tests.source",
            parameters: { testPath: "requirement.test.js" },
            mediaType: "text/javascript",
            bytes: Buffer.from("// spec: R1\n", "utf8"),
          }],
        });
      },
    });
    let outputDirectory = null;
    const review = rejectedTestReviewCommand((directory) => { outputDirectory = directory; });
    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      phase: "test",
      flowManager: manager,
      flowState: manager.load(created.specId),
      config: {},
    };
    const result = await review.execute(ctx);
    manager.publishCurrentAttemptResult = () => { throw new Error("simulated publication failure"); };

    await assert.rejects(
      () => FLOW_COMMANDS.run.review.post(ctx, result),
      /simulated publication failure/,
    );
    assert.equal(fs.existsSync(outputDirectory), true, "failed publication retains the sealed worker surface");
    assert.equal(manager.canonicalState(created.specId).current.at(-1), "test-review");
  });

  it("records a material impl repair and invalidates to one replacement test-execute Attempt", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-canonical-impl-repair", {
      specRecord: new CurrentFlowSpecRecord({ ...validWorkerHandoffSpec(), tasks: [] }, { specId: "001-canonical-impl-repair" }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "impl-repair", {
      onActive(stepId) {
        if (stepId === "implement") manager.updateFileMap({
          specId: created.specId,
          requirementId: "R1",
          paths: ["src/example.js"],
        });
      },
    });
    const confirmedAt = "2026-08-13T00:00:00.000Z";
    const repairManifest = repairSourceMutationManifest(manager, created.specId);
    manager.confirmSourceWorkerHandoff({
      specId: created.specId,
      effect: new SourceWorkerEffect({
        version: 1,
        stepId: "impl-repair",
        completionStatus: "done",
        files: [{ requirementId: "R1", mutationIds: [repairManifest.mutations[0].mutationId] }],
        issues: [], overview: null, triage: null,
        repair: {
          version: 1,
          appliedFindingKeys: ["finding-1"],
          findingMutations: [{ findingKey: "finding-1", mutationIds: [repairManifest.mutations[0].mutationId] }],
          summary: "Applied the reviewed implementation correction.",
        },
      }),
      mutationManifest: repairManifest,
      handoffDigest: "a".repeat(64),
      result: {
        outcome: "passed", summary: "Worker handoff confirmed for impl-repair.", confirmedAt,
        artifactRefs: [{ kind: "worker-handoff", id: "a".repeat(64) }, { kind: "worker-handoff-request", id: "b".repeat(64) }],
      },
    });
    const state = manager.load(created.specId);
    assert.equal(state.currentNodeId, "test-execute");
    assert.equal(leaves(state.steps).find((entry) => entry.id === "impl-repair").status, "invalidated");
    assert.equal(leaves(state.steps).find((entry) => entry.id === "test-execute").status, "in_progress");
    const ledger = manager.activityLedger(created.specId);
    const activity = ledger.at(-1);
    assert.equal(activity.transition.operation, "repair_implementation");
    assert.equal(activity.nodeId, "impl-repair");
    assert.notEqual(activity.attemptId, activity.transition.attempt.id, "producer and replacement Attempt identities differ");
    assert.equal(activity.transition.attempt.nodeId, "test-execute");
    const repairArtifact = manager.readArtifact({
      specId: created.specId,
      logicalKey: "impl.repair",
      consumerNodeId: "acceptance-review",
    });
    const repairRecord = JSON.parse(repairArtifact.bytes.toString("utf8"));
    assert.equal(repairArtifact.descriptor.activityId, activity.id);
    assert.deepEqual(repairRecord.sourceMutationManifest.attempt, {
      id: activity.attemptId,
      nodeId: "impl-repair",
      sequence: activity.sequence,
    });
    assert.match(repairRecord.sourceMutationManifest.digest, /^[a-f0-9]{64}$/);
    assert.equal(manager.load(created.specId).currentNodeId, "test-execute", "journal reload preserves the replacement Attempt");
  });

  it("routes the normal review post-hook through the Version Store result history", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    const ordered = leaves(manager.load(created.specId).steps);
    const reviewIndex = ordered.findIndex((entry) => entry.id === "spec-review");
    for (const entry of ordered.slice(0, reviewIndex)) {
      confirmFixtureStep(manager, entry.id);
    }
    manager.updateStepStatus({ stepId: "spec-review", requestedStatus: "in_progress" });

    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      phase: "spec",
      flowManager: manager,
      flowState: manager.load(created.specId),
    };
    const beforeReview = manager.readCurrentSpecReviewInput({
      specId: created.specId,
      consumerNodeId: "spec-review",
    }).review;
    const result = noOpSpecReviewCommandResult(beforeReview);
    result.artifacts.command = "run-review";
    await FLOW_COMMANDS.run.review.post(ctx, result);

    const state = manager.load(created.specId);
    const canonicalReview = manager.readCurrentSpecReview({
      specId: created.specId,
      consumerNodeId: "spec-triage",
    });
    const leafState = new Map(leaves(state.steps).map((entry) => [entry.id, entry.status]));
    assert.equal(canonicalReview.review.generation, 1);
    assert.equal(canonicalReview.review.audit.at(-1).stage, "spec-review");
    assert.equal(canonicalReview.review.audit.at(-1).outcome, "no-op");
    assert.equal(leafState.get("spec-review"), "done");
    assert.equal(leafState.get("spec-triage"), "pending");
    assert.equal(leafState.get("spec-repair"), "pending");
    assert.equal(state.metrics.some((entry) => entry.phase === "spec" && entry.counter === "reviewRetry"), false);
  });

  it("reloads and resumes the same Version Store after process restart in every execution mode", () => {
    for (const mode of ["direct", "branch", "worktree"]) {
      const repository = root();
      const specId = `001-canonical-restart-${mode}`;
      const execution = {
        mode,
        baseBranch: "main",
        featureBranch: mode === "direct" ? "main" : `feature/restart-${mode}`,
      };
      const executionRoot = mode === "worktree"
        ? path.join(repository, ".sennel", "worktree", specId)
        : repository;
      fs.mkdirSync(executionRoot, { recursive: true });
      const managerOptions = {
        root: executionRoot,
        mainRoot: repository,
        inWorktree: mode === "worktree",
        specId,
      };
      const manager = new FlowManager(managerOptions);
      const created = manager.createFresh(request(specId, {
        runId: `canonical-restart-${mode}-run`,
        flowId: `canonical-restart-${mode}-flow`,
        flowVersionId: `canonical-restart-${mode}-flow-v1`,
        execution,
      }));
      manager.addActiveFlow(specId, mode);
      const identity = canonicalIdentity(manager.canonicalState(specId));
      const catalog = catalogArtifactReferences(manager.artifactCatalog(specId));

      manager.parkFlow(specId);
      const restarted = new FlowManager(managerOptions);
      const parked = restarted.restartFlow(specId);
      assert.equal(parked.lifecycle, "parked", mode);
      assert.equal(parked.resumable, true, mode);
      assert.equal(parked.state.request, "Keep the request exactly as supplied.", mode);
      assert.deepEqual(canonicalIdentity(restarted.canonicalState(specId)), identity, mode);
      assert.deepEqual(catalogArtifactReferences(restarted.artifactCatalog(specId)), catalog, mode);
      assert.equal(restarted.specLocation(specId).version.toString(), "1", mode);
      assert.equal(path.basename(restarted.specLocation(specId).directory), "001", mode);

      restarted.resumeFlow(specId);
      const reloaded = new FlowManager(managerOptions);
      const resumed = reloaded.restartFlow(specId);
      assert.equal(resumed.lifecycle, "active", mode);
      assert.equal(resumed.resumable, false, mode);
      assert.equal(resumed.state.request, "Keep the request exactly as supplied.", mode);
      assert.equal(resumed.state.flowVersionId, created.flowVersionId, mode);
      assert.deepEqual(catalogArtifactReferences(reloaded.artifactCatalog(specId)), catalog, mode);
    }
  });

  it("preserves V1 identity, finalized state, Activities, and catalog references after a fresh read", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-canonical-finalized-request"));
    const originalIdentity = canonicalIdentity(manager.canonicalState(created.specId));
    const ordered = leaves(manager.load(created.specId).steps);
    const scenarioIndex = ordered.findIndex((step) => step.id === "scenario-validity");
    assert.ok(scenarioIndex >= 0);
    for (const step of ordered.slice(0, scenarioIndex)) {
      confirmFixtureStep(manager, step.id, { specId: created.specId });
    }
    manager.updateStepStatus(
      { stepId: "scenario-validity", requestedStatus: "in_progress" },
      { specId: created.specId },
    );
    const location = manager.specLocation(created.specId);
    publishAttemptArtifact(manager, created.specId, "scenario-validity", "scenario.validity", {
      version: "1",
      command: "node --test artifacts/tests/scenario.test.js",
      process: { started: true, exitCode: 0, signal: null, timedOut: false, spawnError: null },
      result: "pass",
      raw_output_path: location.relativeArtifact("scenario.validity.raw-log"),
      summary: [],
    });
    assert.equal(
      catalogArtifactReferences(manager.artifactCatalog(created.specId))
        .some((artifact) => artifact.logicalKey === "scenario.validity"),
      true,
    );
    manager.updateStepStatus(
      { stepId: "scenario-validity", requestedStatus: "done" },
      { specId: created.specId },
    );

    for (const step of leaves(manager.load(created.specId).steps)) {
      if (step.status === "pending") {
        confirmFixtureStep(manager, step.id, { specId: created.specId });
      }
    }
    const referencesBeforeFinalization = catalogArtifactReferences(manager.artifactCatalog(created.specId));
    assert.equal(referencesBeforeFinalization.some((artifact) => artifact.logicalKey === "scenario.validity"), true);

    const finalized = manager.finalizeFlow(created.specId);
    assert.equal(finalized.lifecycle.state, "finalized");
    assert.equal(finalized.request, "Keep the request exactly as supplied.");
    const finalizedState = manager.canonicalState(created.specId).toJSON();
    const finalizedActivities = manager.activityLedger(created.specId);
    const finalizedCatalog = manager.artifactCatalog(created.specId).toJSON();
    assert.deepEqual(canonicalIdentity(manager.canonicalState(created.specId)), originalIdentity);
    assert.equal(finalizedActivities.at(-1).transition.operation, "finalize_flow");
    assert.deepEqual(
      catalogArtifactReferences(manager.artifactCatalog(created.specId)),
      referencesBeforeFinalization,
    );

    const reopenedManager = new FlowManager({
      root: repository,
      mainRoot: repository,
      inWorktree: false,
      specId: created.specId,
    });
    const reopened = reopenedManager.loadReadOnly(created.specId);
    assert.equal(reopened.lifecycle, "finalized");
    assert.equal(reopened.request, "Keep the request exactly as supplied.");
    assert.deepEqual(canonicalIdentity(reopenedManager.canonicalState(created.specId)), originalIdentity);
    assert.deepEqual(reopenedManager.canonicalState(created.specId).toJSON(), finalizedState);
    assert.deepEqual(reopenedManager.activityLedger(created.specId), finalizedActivities);
    assert.deepEqual(reopenedManager.artifactCatalog(created.specId).toJSON(), finalizedCatalog);
    assert.deepEqual(
      catalogDescriptorReferences(reopenedManager.artifactCatalog(created.specId)),
      catalogDescriptorReferences(manager.artifactCatalog(created.specId)),
    );
  });

  it("keeps only unfinished outbox work in flow.json and journals terminal side effects", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    const outbox = new FlowOutboxStore(manager, { specId: created.specId });
    const identity = new FlowOutboxIdentity({
      runId: created.runId,
      stepId: "finalize-cleanup",
      operation: "finalize-cleanup",
    });

    const pending = outbox.beginCommand(identity);
    assert.equal(pending.status, "pending");
    assert.deepEqual(manager.canonicalState(created.specId).outbox.toJSON(), [{
      id: identity.idempotencyKey,
      operation: "finalize-cleanup",
    }]);

    const failed = outbox.fail(identity, new Error("cleanup interruption"));
    assert.equal(failed.status, "failed");
    assert.deepEqual(manager.canonicalState(created.specId).outbox.toJSON(), []);
    assert.throws(
      () => outbox.beginCommand(identity),
      FlowOutboxRecoveryRequiredError,
    );

    const reopened = outbox.reopenFailedExact(new FlowOutboxRecoveryClaim({
      identity,
      attempt: 1,
      failure: "cleanup interruption",
    }));
    assert.equal(reopened.status, "pending");
    const completed = outbox.complete(identity, { status: "done" });
    assert.equal(completed.status, "done");
    assert.deepEqual(manager.canonicalState(created.specId).outbox.toJSON(), []);

    const activities = fs.readFileSync(manager.specLocation(created.specId).activitiesFile, "utf8")
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(
      activities.slice(-4).map((entry) => entry.transition.operation),
      ["begin_outbox", "fail_outbox", "reopen_outbox", "complete_outbox"],
    );
    assert.equal(activities.at(-3).transition.outbox.failure, "cleanup interruption");
    assert.deepEqual(activities.at(-2).transition.outbox.exactRecoveryReceipt, {
      idempotencyKey: identity.idempotencyKey,
      attempt: 1,
      failure: "cleanup interruption",
      recoveryKey: null,
    });
    assert.equal(activities.at(-1).transition.outbox.failure, null);
  });

  it("stores explicit dispatch approval only as a typed Activity receipt", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    const receipt = {
      version: 1,
      runId: created.runId,
      actionDigest: "a".repeat(64),
      approvalToken: "b".repeat(64),
      approvedAt: "2026-08-13T00:00:00.000Z",
    };

    manager.recordDispatchApproval({ specId: created.specId, receipt });
    assert.deepEqual(manager.load(created.specId).flowDispatchApprovals, [receipt]);
    assert.throws(
      () => manager.recordDispatchApproval({
        specId: created.specId,
        receipt: { ...receipt, approvalToken: "c".repeat(64) },
      }),
      /cannot replace its exact receipt/,
    );

    const location = manager.specLocation(created.specId);
    const persisted = JSON.parse(fs.readFileSync(location.flowStateFile, "utf8"));
    const activities = fs.readFileSync(location.activitiesFile, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(Object.hasOwn(persisted, "flowDispatchApprovals"), false);
    assert.equal(activities.at(-1).type, "dispatch_approval_recorded");
    assert.deepEqual(activities.at(-1).transition.approval, receipt);
  });

  it("derives exact recovery and pre-sync failure facts from V1 outbox Activities", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    const outbox = new FlowOutboxStore(manager, { specId: created.specId });
    const identity = new FlowOutboxIdentity({
      runId: created.runId,
      stepId: "finalize-merge",
      operation: "finalize-merge",
    });
    const conflict = new Error("Pre-merge rebase detected conflicts in origin/main");
    conflict.code = "MERGE_PRE_SYNC_CONFLICT";
    conflict.data = { recovery: { baseRef: "origin/main", baseHead: "a".repeat(40) } };

    outbox.begin(identity);
    outbox.fail(identity, conflict);
    const failed = outbox.status(identity);
    assert.deepEqual(failed.latestFailure.toJSON(), {
      attempt: 1,
      failure: conflict.message,
      recordedAt: failed.updatedAt,
      code: "MERGE_PRE_SYNC_CONFLICT",
      recovery: { baseRef: "origin/main", baseHead: "a".repeat(40) },
    });

    const claim = new FlowOutboxRecoveryClaim({
      identity,
      attempt: 1,
      failure: conflict.message,
      recoveryKey: "a".repeat(40),
    });
    outbox.reopenFailedExact(claim);
    outbox.fail(identity, conflict);
    assert.throws(() => outbox.reopenFailedExact(claim), /exact recovery was already consumed/);
  });

  it("routes the normal explicit dispatch approval through the Version Store without changing worker input", async () => {
    const legacyAction = {
      taskId: null,
      step: "draft",
      action: "write-draft",
      instructions: { key: "draft", content: "Write the supplied draft." },
      context: null,
      output_schema: {},
      requires_approval: true,
      maxAttempts: 1,
      directive: {
        kind: "execute_step",
        terminal: false,
        requiresUserAction: false,
        action: "write-draft",
      },
    };

    const boundaryPromptAction = {
      ...legacyAction,
      directive: {
        ...legacyAction.directive,
        requiresUserAction: true,
        actionPrompt: {
          requiresUserAction: true,
          question: "Review or approve the specification?",
          choices: [
            {
              actionId: "APPROVE_SPECIFICATION",
              label: "Approve",
              nextAction: null,
              stateTransition: "resume-current-approval-boundary",
              impact: { retains: [], changes: ["approval authorization"], deletes: [] },
              reason: null,
            },
            {
              actionId: "REVIEW_SPECIFICATION_SUMMARY",
              label: "Review summary",
              nextAction: "sennel flow get artifact spec.record --mode summary --expect-binding 'opaque'",
              stateTransition: null,
              impact: { retains: ["current approval boundary"], changes: [], deletes: [] },
              reason: null,
            },
          ],
          recommendedActionId: "REVIEW_SPECIFICATION_SUMMARY",
          recommendationReason: "Review before approving.",
        },
      },
    };

    const captureWorkerInput = async (action) => {
      const repository = root();
      const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
      const created = manager.createFresh(request());
      manager.addActiveFlow(created.specId, "direct");
      for (const stepId of ["branch", "prepare-spec"]) {
        manager.updateStepStatus({ stepId, requestedStatus: "in_progress" });
        confirmFixtureStep(manager, stepId);
      }
      await new GetNextActionCommand().execute({
        root: repository,
        mainRoot: repository,
        executionRoot: repository,
        flowManager: manager,
        flowState: manager.load(created.specId),
        specId: created.specId,
        flowCommandBoundary: false,
      });
      await new RunClaimNextActionCommand().execute({
        root: repository,
        mainRoot: repository,
        executionRoot: repository,
        flowManager: manager,
        flowState: manager.load(created.specId),
        specId: created.specId,
      });

      const completed = {
        taskId: null,
        step: null,
        action: "completed",
        instructions: null,
        context: null,
        output_schema: null,
        requires_approval: false,
        directive: { kind: "completed", terminal: true, requiresUserAction: false },
      };
      const current = { value: structuredClone(action) };
      let workerPrompt = null;
      let workerOptions = null;
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() { return structuredClone(current.value); } },
        agent: {
          async call(prompt, options) {
            workerPrompt = prompt;
            workerOptions = options;
            manager.confirmCurrentAttempt({ specId: created.specId });
            current.value = completed;
          },
        },
        repositoryFingerprint: () => "canonical-dispatch-r0",
        leaseFactory: () => ({ acquire() {}, release() {} }),
        handoffCoordinator: {
          recoverPending() {},
          createRequest() { return null; },
        },
      });
      dispatcher.container = {};
      const context = {
        root: repository,
        mainRoot: repository,
        executionRoot: repository,
        flowManager: manager,
        flowState: manager.load(created.specId),
        specId: created.specId,
        expectRunId: created.runId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
        flowCommandBoundary: false,
      };

      const boundary = await dispatcher.execute(context);
      assert.equal(boundary.dispatch.boundary, "approval_required");
      const result = await dispatcher.execute({ ...context, approve: boundary.dispatch.approvalToken });
      assert.equal(result.dispatch.boundary, "completed");
      assert.ok(workerPrompt);
      assert.ok(workerOptions);
      const activities = fs.readFileSync(manager.specLocation(created.specId).activitiesFile, "utf8")
        .trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(activities.some((entry) => entry.type === "dispatch_approval_recorded"), true);
      assert.equal(manager.canonicalState(created.specId).findNode("draft").status, "done");
      return { prompt: workerPrompt, environment: workerOptions.executionEnvironment };
    };

    const parseWorkerPrompt = (prompt) => {
      const invocationMarker = "\n\nMachine-readable dispatch invocation contract:\n";
      const actionMarker = "\n\nGuarded next action:\n";
      const reportMarker = "\n\nYour response is only a worker report.";
      const [instructions, invocationAndAction] = prompt.split(invocationMarker);
      const [invocationJson, actionAndReport] = invocationAndAction.split(actionMarker);
      const [actionJson] = actionAndReport.split(reportMarker);
      return {
        instructions,
        invocation: JSON.parse(invocationJson),
        actionJson,
      };
    };
    const normalizeInvocation = (invocation) => {
      const { id: _id, action, authorization, ...stable } = invocation;
      return {
        ...stable,
        action: { ...action, digest: "<authorization-bound>" },
        authorization: {
          ...authorization,
          actionDigest: "<authorization-bound>",
          approvalToken: "<authorization-bound>",
          approvedAt: "<authorization-bound>",
        },
      };
    };
    const normalizeEnvironment = (environment) => ({
      ...environment,
      [FLOW_DISPATCH_INVOCATION_ID_ENV]: "<invocation-id>",
      [FLOW_DISPATCH_INVOCATION_ENV]: normalizeInvocation(
        JSON.parse(environment[FLOW_DISPATCH_INVOCATION_ENV]),
      ),
    });
    const redactAuthorizationInstruction = (instructions) => instructions.replace(
      /The CLI durably recorded explicit user approval at .+ for this exact action digest\./,
      "<explicit-authorization>",
    );

    const beforeInput = await captureWorkerInput(legacyAction);
    const before = parseWorkerPrompt(beforeInput.prompt);
    const afterInput = await captureWorkerInput(boundaryPromptAction);
    const after = parseWorkerPrompt(afterInput.prompt);

    assert.equal(before.actionJson, JSON.stringify(legacyAction, null, 2));
    assert.equal(after.actionJson, JSON.stringify(legacyAction, null, 2));
    assert.equal(redactAuthorizationInstruction(after.instructions), redactAuthorizationInstruction(before.instructions));
    assert.deepEqual(normalizeInvocation(after.invocation), normalizeInvocation(before.invocation));
    assert.deepEqual(
      normalizeEnvironment(afterInput.environment),
      normalizeEnvironment(beforeInput.environment),
    );
    assert.doesNotMatch(afterInput.prompt, /Review or approve the specification/);
    assert.doesNotMatch(afterInput.environment[FLOW_DISPATCH_INVOCATION_ENV], /actionPrompt/);
  });

  it("journals policy changes and rewinds through the same canonical state machine", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");

    manager.setAutoApprove(true);
    manager.updateStepStatus({ stepId: "branch", requestedStatus: "in_progress" });
    confirmFixtureStep(manager, "branch");
    manager.rewindTo("branch");

    const location = manager.specLocation(created.specId);
    const activities = fs.readFileSync(location.activitiesFile, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line));
    const state = manager.load(created.specId);
    const persisted = JSON.parse(fs.readFileSync(location.flowStateFile, "utf8"));

    assert.equal(state.autoApprove, true);
    assert.deepEqual(persisted.policy, { autoApprove: true, nonblocking: null });
    assert.equal(state.currentNodeId, "branch");
    assert.equal(activities.find((entry) => entry.type === "policy_updated").transition.operation, "set_policy");
    assert.equal(activities.at(-1).transition.operation, "rewind");
    assert.equal(Object.hasOwn(persisted, "autoApprove"), false);
  });

  it("keeps nonblocking policy and evidence in typed V1 policy and Activities", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    manager.beginNextAction(created.specId);
    const activeNodeId = manager.load(created.specId).currentNodeId;

    manager.activateNonblockingPolicy({
      policy: {
        enabled: true,
        activatedAt: "2026-08-14T00:00:00.000Z",
        activatedStep: "scenario-validity",
        reason: "A durable acceptance decision is required.",
      },
    });
    manager.recordNonblocking({
      nodeId: activeNodeId,
      record: {
        kind: "observation",
        sourceStep: "scenario-validity",
        sourceAttempt: 1,
        evidenceRef: "steps/scenario-validity/result.json",
        evidenceDigest: "a".repeat(64),
        resultKind: "unavailable",
        action: null,
        rationale: null,
        remainingRisk: null,
      },
    });

    const location = manager.specLocation(created.specId);
    const persisted = JSON.parse(fs.readFileSync(location.flowStateFile, "utf8"));
    const activities = manager.activityLedger(created.specId);
    assert.equal(persisted.policy.nonblocking.enabled, true);
    assert.equal(Object.hasOwn(persisted, "nonblocking"), false);
    assert.equal(Object.hasOwn(persisted, "stepAttempts"), false);
    assert.equal(activities.at(-1).type, "nonblocking_recorded");
    assert.equal(activities.at(-1).transition.nonblocking.sourceStep, "scenario-validity");
  });

  it("records metrics and notes in Activities while keeping dispatcher metadata transient", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");

    manager.incrementMetric("draft", "question");
    manager.accumulateAgentMetrics("draft", {
      provider: "provider",
      profileKey: "default",
      model: "model",
      responseChars: 12,
      durationMs: 34,
      usage: {
        input_tokens: 8,
        output_tokens: 5,
        cache_read_tokens: 3,
        cache_creation_tokens: 1,
        cost_usd: 0.01,
      },
    });
    manager.addNote("Retain this canonical observation.");
    manager.setStepRuntimeLog("branch", {
      runId: created.runId,
      sequence: 1,
      attempt: 1,
      command: "flow run branch",
      startedAt: "2026-08-13T00:00:00.000Z",
      endedAt: "2026-08-13T00:00:01.000Z",
      exitCode: 0,
    });
    manager.writeRuntimeArtifact({
      specId: created.specId,
      nodeId: "finalize-cleanup",
      artifact: {
        logicalKey: "finalize.cleanup.runtime-log",
        mediaType: "application/json",
        bytes: '{"version":1,"runtimeLog":{"runId":"canonical-manager-run"}}\n',
      },
    });

    const location = manager.specLocation(created.specId);
    const state = manager.load(created.specId);
    const persisted = JSON.parse(fs.readFileSync(location.flowStateFile, "utf8"));
    const activities = fs.readFileSync(location.activitiesFile, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(state.metrics.length, 2);
    assert.deepEqual(state.metrics[0], { phase: "draft", counter: "question", delta: 1, taskId: null, ts: state.metrics[0].ts });
    assert.equal(state.metrics[1].tokens.cacheCreation, 1);
    assert.deepEqual(state.notes, [{ text: "Retain this canonical observation.", taskId: null, ts: state.notes[0].ts }]);
    assert.equal(Object.hasOwn(persisted, "metrics"), false);
    assert.equal(Object.hasOwn(persisted, "notes"), false);
    assert.deepEqual(activities.slice(-3).map((activity) => activity.type), ["metric_recorded", "metric_recorded", "note_recorded"]);
    assert.equal(
      fs.existsSync(path.join(location.directory, ".runtime", "step-metadata", "branch.json")),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(location.directory, ".runtime", "finalize-cleanup", "runtime-log.json")),
      true,
    );
    const catalog = manager.artifactCatalog(created.specId);
    assert.equal(catalog.artifacts.some((entry) => entry.relativePath.includes("step-metadata")), false);
    assert.equal(catalog.artifacts.some((entry) => entry.relativePath.includes("runtime-log")), false);
    assert.doesNotThrow(() => catalog.verify(location));
  });

  it("resolves issue-log publication through the same bound Version catalog", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    manager.updateStepStatus({ stepId: "branch", requestedStatus: "in_progress" });
    const state = manager.load(created.specId);
    const location = manager.specLocation(created.specId);

    manager.appendIssueLog({
      specId: state.specId,
      entry: {
        step: "draft",
        reason: "Canonical issue-log publication is catalog-owned.",
      },
      idempotencyKey: "canonical-issue-log",
    });

    const catalog = manager.artifactCatalog(created.specId);
    const activities = fs.readFileSync(location.activitiesFile, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(fs.existsSync(location.issueLogFile), true);
    assert.equal(catalog.resolve("issue-log.json").logicalKey, "issue.log");
    assert.equal(activities.at(-1).transition.operation, "publish_artifacts");
    assert.equal(activities.at(-1).nodeId, "branch");
    assert.doesNotThrow(() => catalog.verify(location));
  });

  it("updates a Task overview through the V1 Store without a root spec writer or duplicate Activity", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(taskRequest("001-canonical-overview"));
    manager.addTask({
      id: "T-1",
      title: "Canonical overview update",
      goal: "Persist this Task contribution through the Version Store.",
      parent: null,
      origin: "plan",
      added_round: 0,
      status: "pending",
    }, { specId: created.specId });
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "T-1-impl");

    const command = new RunUpdateOverviewCommand();
    const context = {
      root: repository,
      flowManager: manager,
      flowState: manager.load(created.specId),
      specId: created.specId,
      json: JSON.stringify({
        modules: ["src/flow/lib/canonical-overview-update.js"],
        data_flow: ["task implementation -> canonical spec record"],
        decisions: ["Overview contributions use the Version Store."],
      }),
    };
    const beforeOverview = currentSpecRevisionAuthority(manager, created.specId);
    const first = await command.execute(context);
    assert.equal(first.ok, true, JSON.stringify(first.errors));
    assert.equal(first.data.applied, true);

    const location = manager.specLocation(created.specId);
    const spec = JSON.parse(manager.readArtifact({
      specId: created.specId,
      logicalKey: "spec.record",
      consumerNodeId: "T-1-impl",
    }).bytes.toString("utf8"));
    const activities = () => fs.readFileSync(location.activitiesFile, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(spec.overview.modules.at(-1), {
      text: "src/flow/lib/canonical-overview-update.js",
      added_by_task: "T-1",
    });
    assert.equal(activities().at(-1).transition.operation, "update_spec_record");
    assert.equal(activities().at(-1).type, "spec_record_updated");
    assert.equal(activities().at(-1).nodeId, "T-1-impl");
    const afterOverview = currentSpecRevisionAuthority(manager, created.specId);
    assertSpecRevisionAdvanced(beforeOverview, afterOverview);
    assert.equal(fs.existsSync(path.join(repository, "specs", created.specId, "spec.json")), false);
    assert.equal(fs.existsSync(path.join(location.directory, "spec.md")), false);

    const beforeRepeat = activities().length;
    const repeated = await command.execute({ ...context, flowState: manager.load(created.specId) });
    assert.equal(repeated.ok, true);
    assert.equal(repeated.data.applied, false);
    assert.equal(activities().length, beforeRepeat, "recovery must not duplicate a matching overview contribution");
    assert.equal(currentSpecRevisionAuthority(manager, created.specId).revision, afterOverview.revision);
    assert.doesNotThrow(() => manager.artifactCatalog(created.specId).verify(location));
  });

  it("advances one revision for a source-worker Task implementation Spec completion", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(taskRequest("001-source-task-implementation-revision"));
    manager.addTask({
      id: "T-1",
      title: "Source worker implementation",
      goal: "Publish the source worker's overview contribution.",
      parent: null,
      origin: "plan",
      added_round: 0,
      status: "pending",
    }, { specId: created.specId });
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "T-1-impl");
    const before = currentSpecRevisionAuthority(manager, created.specId);
    manager.confirmSourceWorkerHandoff({
      specId: created.specId,
      effect: new SourceWorkerEffect({
        version: 1,
        stepId: "task-impl",
        completionStatus: "done",
        files: [],
        issues: [],
        overview: {
          modules: ["src/flow/lib/source-worker-spec-completion.js"],
          data_flow: ["source worker handoff -> immutable Spec revision"],
          decisions: ["Task implementation publications use the Version Store."],
        },
        triage: null,
        repair: null,
      }),
      mutationManifest: emptySourceMutationManifest(manager, created.specId),
      handoffDigest: "a".repeat(64),
      result: {
        outcome: "passed",
        summary: "Source worker Task implementation completed.",
        confirmedAt: "2026-08-29T00:00:00.000Z",
        artifactRefs: [],
      },
    });
    const after = currentSpecRevisionAuthority(manager, created.specId);
    assertSpecRevisionAdvanced(before, after);
    assert.equal(JSON.parse(after.root.toString("utf8")).overview.modules.at(-1).added_by_task, "T-1");
  });

  it("advances one revision for the flow-level source worker Spec completion", () => {
    const repository = root();
    const specId = "001-source-flow-implementation-revision";
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request(specId, {
      specRecord: new CurrentFlowSpecRecord({
        ...validWorkerHandoffSpec(),
        requirements: [{ id: "R1", desc: "Publish a validated artifact.", status: "done" }],
        tasks: [],
      }, { specId }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "implement");
    const before = currentSpecRevisionAuthority(manager, created.specId);
    manager.confirmSourceWorkerHandoff({
      specId: created.specId,
      effect: new SourceWorkerEffect({
        version: 1,
        stepId: "implement",
        completionStatus: "done",
        files: [],
        issues: [],
        overview: null,
        triage: null,
        repair: null,
      }),
      mutationManifest: emptySourceMutationManifest(manager, created.specId),
      handoffDigest: "b".repeat(64),
      result: {
        outcome: "passed",
        summary: "Flow-level source worker implementation completed.",
        confirmedAt: "2026-08-29T00:00:00.000Z",
        artifactRefs: [],
      },
    });
    const after = currentSpecRevisionAuthority(manager, created.specId);
    assertSpecRevisionAdvanced(before, after);
    assert.equal(Object.hasOwn(JSON.parse(after.root.toString("utf8")).requirements[0], "status"), false);
  });

  it("rolls back root Spec, revisions, state, Activity, and catalog as one interrupted publication", () => {
    const repository = root();
    let interrupt = false;
    let catalogFile = null;
    const manager = new FlowManager({
      root: repository,
      mainRoot: repository,
      inWorktree: false,
      versionStoreFaultInjector: ({ phase, filePath }) => {
        if (interrupt && phase === "before-json-rename" && filePath === catalogFile) {
          throw new Error("injected root Spec publication interruption");
        }
      },
    });
    const created = manager.createFresh(request("001-root-spec-publication-rollback"));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "spec");
    const location = manager.specLocation(created.specId);
    catalogFile = location.catalogFile;
    const before = rootSpecPublicationBytes(location, 1);
    const changed = JSON.parse(before.root.toString("utf8"));
    changed.goal = "This changed root Spec must roll back completely after interruption.";
    interrupt = true;
    assert.throws(() => manager.confirmCurrentAttempt({
      specId: created.specId,
      specRecord: new CurrentFlowSpecRecord(changed, { specId: created.specId }),
    }), /injected root Spec publication interruption/);
    const after = rootSpecPublicationBytes(location, 1);
    assert.deepEqual(after, before);
    assert.equal(
      crypto.createHash("sha256").update(after.catalog).digest("hex"),
      crypto.createHash("sha256").update(before.catalog).digest("hex"),
      "interrupted publication must leave the catalog hash unchanged",
    );
    assert.equal(fs.existsSync(location.artifact("spec.snapshot", { revision: "002" })), false);
    assert.equal(fs.existsSync(location.artifact("spec.review", { revision: "002" })), false);
    assert.equal(currentSpecRevisionAuthority(manager, created.specId).revision, 1);
  });

  it("does not recreate the retired task-gate overview outbox after a V1 Task gate", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(taskRequest("001-canonical-task-gate"));
    manager.addTask({
      id: "T-1",
      title: "Canonical Task gate",
      goal: "Retire the post-gate Markdown refresh side effect.",
      parent: null,
      origin: "plan",
      added_round: 0,
      status: "pending",
    }, { specId: created.specId });
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "T-1-gate");
    const gateResult = new CanonicalGatePromotion({
      state: manager.canonicalState(created.specId),
      phase: "task-impl",
      nodeId: "T-1-gate",
      activeTaskId: "T-1",
    }).promote({ result: "pass", artifacts: { sourceFingerprint: currentTaskSourceFingerprint(manager, created.specId) } });
    manager.publishCurrentAttemptResult({ specId: created.specId, commandResult: gateResult });
    let gateDecision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager,
      flowState: manager.load(created.specId),
      phase: "task-impl",
    }));
    manager.recordTaskGateSettlementMetric({ specId: created.specId, decision: gateDecision });
    gateDecision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(created.specId), phase: "task-impl",
    }));
    appendIssueLogFromGateResult({
      root: repository, mainRoot: repository, executionRoot: repository,
      specId: created.specId, flowManager: manager, flowState: manager.load(created.specId),
      phase: "task-impl", gateTransitionDecision: gateDecision,
    }, gateResult);
    gateDecision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(created.specId), phase: "task-impl",
    }));
    manager.updateStepStatus({ stepId: "T-1-gate", requestedStatus: "done" }, {
      specId: created.specId,
      gateTransitionDecision: gateDecision,
    });

    const location = manager.specLocation(created.specId);
    assert.equal(fs.existsSync(path.join(location.directory, "spec.md")), false);
    assert.equal(fs.existsSync(path.join(repository, "specs", created.specId, "spec.json")), false);
  });

  it("activates a fresh worker through one journaled Attempt while preserving next-action output", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    for (const stepId of ["branch", "prepare-spec"]) {
      manager.updateStepStatus({ stepId, requestedStatus: "in_progress" });
      confirmFixtureStep(manager, stepId);
    }
    const context = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      flowManager: manager,
      flowState: manager.load(created.specId),
      specId: created.specId,
      flowCommandBoundary: false,
    };

    const first = await new GetNextActionCommand().execute(context);
    const location = manager.specLocation(created.specId);
    const projectedActivities = fs.readFileSync(location.activitiesFile, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line));

    assert.equal(first.step, "draft");
    assert.equal(first.action, "write-draft");
    assert.equal(first.directive.actionId, "CLAIM_NEXT_ACTION");
    assert.equal(manager.load(created.specId).currentNodeId, null);

    const claimed = await new RunClaimNextActionCommand().execute(context);
    assert.equal(claimed.ok, true, JSON.stringify(claimed));
    const firstActivities = fs.readFileSync(location.activitiesFile, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(firstActivities.length, projectedActivities.length + 1);
    assert.equal(firstActivities.at(-1).transition.operation, "start_attempt");
    assert.equal(firstActivities.at(-1).nodeId, "draft");

    const second = await new GetNextActionCommand().execute({ ...context, flowState: manager.load(created.specId) });
    const secondActivities = fs.readFileSync(location.activitiesFile, "utf8").trim().split("\n");
    assert.equal(second.step, first.step);
    assert.deepEqual(second.context, first.context);
    assert.equal(secondActivities.length, firstActivities.length, "resuming an active Attempt must not double-start it");
  });

  it("commits a worker result, Activity, and cataloged producer output through one V1 Store boundary", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    for (const stepId of ["branch", "prepare-spec"]) {
      manager.updateStepStatus({ stepId, requestedStatus: "in_progress" });
      confirmFixtureStep(manager, stepId);
    }
    await new GetNextActionCommand().execute({
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      flowManager: manager,
      flowState: manager.load(created.specId),
      specId: created.specId,
      flowCommandBoundary: false,
    });
    await new RunClaimNextActionCommand().execute({
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      flowManager: manager,
      flowState: manager.load(created.specId),
      specId: created.specId,
    });

    const draftBytes = canonicalDraftBytes("canonical");
    manager.confirmCurrentAttempt({
      specId: created.specId,
      artifactWrites: [{
        logicalKey: "draft",
        mediaType: "application/json",
        bytes: draftBytes,
      }],
    });

    const location = manager.specLocation(created.specId);
    const catalog = manager.artifactCatalog(created.specId);
    const draft = catalog.resolve("steps/draft/result.json");
    const activities = fs.readFileSync(location.activitiesFile, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(manager.canonicalState(created.specId).findNode("draft").status, "done");
    assert.equal(draft.logicalKey, "draft");
    assert.equal(draft.activityId, activities.at(-1).id);
    assert.equal(fs.existsSync(path.join(location.directory, "draft.json")), false);
    assert.deepEqual(fs.readFileSync(path.join(location.directory, draft.relativePath)), draftBytes);
  });

  it("journals a durable producer artifact without a second mutable state write", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    for (const stepId of ["branch", "prepare-spec"]) {
      manager.updateStepStatus({ stepId, requestedStatus: "in_progress" });
      confirmFixtureStep(manager, stepId);
    }
    await new GetNextActionCommand().execute({
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      flowManager: manager,
      flowState: manager.load(created.specId),
      specId: created.specId,
      flowCommandBoundary: false,
    });
    await new RunClaimNextActionCommand().execute({
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      flowManager: manager,
      flowState: manager.load(created.specId),
      specId: created.specId,
    });

    const draftBytes = canonicalDraftBytes("durable without completion");
    manager.publishArtifacts({
      specId: created.specId,
      nodeId: "draft",
      artifactWrites: [{
        logicalKey: "draft",
        mediaType: "application/json",
        bytes: draftBytes,
      }],
    });
    const location = manager.specLocation(created.specId);
    const activities = fs.readFileSync(location.activitiesFile, "utf8").trim().split("\n")
      .map((line) => JSON.parse(line));
    const artifact = manager.artifactCatalog(created.specId).resolve("steps/draft/result.json");

    assert.equal(manager.canonicalState(created.specId).findNode("draft").status, "in_progress");
    assert.equal(activities.at(-1).transition.operation, "publish_artifacts");
    assert.equal(activities.at(-1).attemptId, manager.canonicalState(created.specId).attempt.id);
    assert.equal(artifact.activityId, activities.at(-1).id);
    assert.deepEqual(fs.readFileSync(path.join(location.directory, artifact.relativePath)), draftBytes);
  });

  it("confirms a sealed normal worker handoff from the execution handoff directory", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    for (const stepId of ["branch", "prepare-spec"]) {
      manager.updateStepStatus({ stepId, requestedStatus: "in_progress" });
      confirmFixtureStep(manager, stepId);
    }
    await new GetNextActionCommand().execute({
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      flowManager: manager,
      flowState: manager.load(created.specId),
      specId: created.specId,
      flowCommandBoundary: false,
    });
    await new RunClaimNextActionCommand().execute({
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      flowManager: manager,
      flowState: manager.load(created.specId),
      specId: created.specId,
    });
    const coordinator = new WorkerArtifactHandoffCoordinator({
      now: () => new Date("2026-08-13T00:00:00.000Z"),
    });
    const context = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
    };
    const handoff = coordinator.createRequest({
      ctx: context,
      state: manager.load(created.specId),
      invocation: {
        id: "canonical-handoff",
        target: { digest: "b".repeat(64) },
        action: { digest: "a".repeat(64), nextAction: { step: "draft" } },
      },
    });
    // Dispatch flushes the deferred agent metric while its Attempt is still
    // active, immediately before it reconciles the sealed handoff.
    manager.accumulateAgentMetrics("draft", {
      provider: "provider",
      profileKey: "default",
      responseChars: 9,
      durationMs: 12,
      usage: { input_tokens: 3, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 },
    });
    const location = manager.specLocation(created.specId);
    assert.equal(handoff.requestPath.startsWith(path.join(repository, ".sennel", "handoffs")), true);
    assert.equal(fs.existsSync(path.join(location.directory, ".runtime", "worker-handoffs")), false);
    const draftBytes = canonicalDraftBytes("sealed canonical handoff");
    fs.writeFileSync(handoff.payloadPath("draft.json"), draftBytes);
    sealWorkerArtifactHandoff({ requestPath: handoff.requestPath, invocationId: "canonical-handoff" });

    const result = coordinator.reconcile({ ctx: context, request: handoff });
    const catalog = manager.artifactCatalog(created.specId);
    const draft = catalog.resolve("steps/draft/result.json");

    assert.equal(result.completed, true);
    assert.equal(manager.canonicalState(created.specId).findNode("draft").status, "done");
    assert.equal(manager.load(created.specId).metrics[0].kind, "agent");
    assert.deepEqual(fs.readFileSync(path.join(location.directory, draft.relativePath)), draftBytes);
    assert.equal(fs.existsSync(path.join(location.directory, "draft.json")), false);
  });

  it("replaces worker test sources through the V1 catalog without retaining obsolete artifacts", () => {
    const specId = "001-canonical-test-tree";
    const { manager, created, coordinator, context, handoff } = canonicalTestTreeHandoffScenario(
      specId,
      "canonical-test-tree",
    );
    writeCanonicalTestTreePayload(handoff);
    sealWorkerArtifactHandoff({ requestPath: handoff.requestPath, invocationId: "canonical-test-tree" });

    const result = coordinator.reconcile({ ctx: context, request: handoff });
    const location = manager.specLocation(created.specId);
    const catalog = manager.artifactCatalog(created.specId);
    const sourcePaths = catalog.artifacts
      .filter((entry) => entry.logicalKey === "tests.source")
      .map((entry) => entry.relativePath);

    assert.equal(result.completed, true);
    assert.deepEqual(sourcePaths, ["artifacts/tests/current.test.js"]);
    assert.equal(fs.existsSync(path.join(location.directory, "artifacts", "tests", "obsolete.test.js")), false);
    assert.equal(fs.existsSync(path.join(location.directory, "artifacts", "tests", "current.test.js")), true);
    assert.equal(manager.canonicalState(created.specId).findNode("test").status, "done");
  });

  it("fails a stale V1 test-tree handoff without deleting newer cataloged sources", () => {
    const { manager, created, coordinator, context, handoff } = canonicalTestTreeHandoffScenario(
      "001-canonical-test-tree-cas",
      "canonical-test-tree-cas",
    );
    manager.publishArtifacts({
      specId: created.specId,
      nodeId: "test",
      artifactWrites: [{
        logicalKey: "tests.source",
        parameters: { testPath: "newer.test.js" },
        mediaType: "text/javascript",
        bytes: Buffer.from("// spec: R1\n", "utf8"),
      }],
    });
    writeCanonicalTestTreePayload(handoff);
    sealWorkerArtifactHandoff({ requestPath: handoff.requestPath, invocationId: "canonical-test-tree-cas" });

    assert.throws(
      () => coordinator.reconcile({ ctx: context, request: handoff }),
      (error) => error?.code === "FLOW_ARTIFACT_HANDOFF_CONFLICT",
    );
    const sources = manager.artifactCatalog(created.specId).artifacts
      .filter((entry) => entry.logicalKey === "tests.source")
      .map((entry) => entry.relativePath)
      .sort();
    assert.deepEqual(sources, ["artifacts/tests/newer.test.js", "artifacts/tests/obsolete.test.js"]);
    assert.equal(manager.canonicalState(created.specId).findNode("test").status, "in_progress");
  });

  it("hands cataloged draft review payloads to V1 triage and repair without exposing attempts wrappers", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request("001-canonical-draft-triage"));
    manager.addActiveFlow(created.specId, "direct");
    const draftBytes = canonicalDraftBytes("Review the canonical draft.");
    const revision = {
      version: 1,
      runId: created.runId,
      specId: created.specId,
      sourceStepId: "draft",
      digest: crypto.createHash("sha256").update(draftBytes).digest("hex"),
      byteLength: draftBytes.length,
      finalizedAt: "2026-08-13T00:00:00.000Z",
    };
    const review = {
      version: 2,
      phase: "draft-questions",
      sourceDraft: "draft.json",
      sourceDraftRevision: revision,
      generatedAt: "2026-08-13T00:00:01.000Z",
      verdict: "ADVISORY",
      summary: "One repair target is retained.",
      blockingFindings: [],
      advisoryFindings: [],
      repairTargets: [{
        title: "Publish through the parent",
        target: "goal",
        rationale: "The parent owns durable publication.",
        evidence: "The worker handoff is catalog-backed.",
        classification: "repair_target",
      }],
    };
    advanceTo(manager, created.specId, "draft");
    manager.confirmCurrentAttempt({
      specId: created.specId,
      artifactWrites: [{
        logicalKey: "draft",
        mediaType: "application/json",
        bytes: draftBytes,
      }],
    });
    manager.updateStepStatus(
      { stepId: "draft-questions-review", requestedStatus: "in_progress" },
      { specId: created.specId },
    );
    publishAttemptArtifact(manager, created.specId, "draft-questions-review", "draft.questions.review", review);
    manager.updateStepStatus({ stepId: "draft-questions-review", requestedStatus: "done" }, { specId: created.specId });
    manager.updateStepStatus({ stepId: "draft-questions-triage", requestedStatus: "in_progress" }, { specId: created.specId });

    const coordinator = new WorkerArtifactHandoffCoordinator();
    const context = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
    };
    const handoff = coordinator.createRequest({
      ctx: context,
      state: manager.load(created.specId),
      invocation: {
        id: "canonical-draft-triage",
        target: { digest: "b".repeat(64) },
        action: { digest: "a".repeat(64), nextAction: { step: "draft-questions-triage" } },
      },
    });
    const reviewInput = handoff.inputs.find((input) => input.name === "draft-review-questions.json");
    assert.deepEqual(reviewInput.document, review);
    fs.writeFileSync(handoff.payloadPath("draft-questions-triage.json"), `${JSON.stringify({
      version: 1,
      phase: "draft-questions-triage",
      sourceReview: "draft-review-questions.json",
      summary: "Apply the repair target.",
      items: [{
        title: "Publish through the parent",
        target: "goal",
        decision: "apply",
        rationale: "The target is valid.",
        evidence: "The parent owns durable publication.",
        allowedFieldPaths: ["goal"],
        requiredFieldPaths: ["goal"],
      }],
    }, null, 2)}\n`);
    sealWorkerArtifactHandoff({ requestPath: handoff.requestPath, invocationId: "canonical-draft-triage" });

    const result = coordinator.reconcile({ ctx: context, request: handoff });
    const location = manager.specLocation(created.specId);
    const triage = manager.readArtifact({
      specId: created.specId,
      logicalKey: "draft.questions.triage",
      consumerNodeId: "draft-questions-repair",
    });
    assert.equal(result.completed, true);
    assert.equal(manager.canonicalState(created.specId).findNode("draft-questions-triage").status, "done");
    assert.equal(JSON.parse(triage.bytes.toString("utf8")).items[0].decision, "apply");
    assert.equal(fs.existsSync(path.join(location.directory, "draft-review-questions.json")), false);

    manager.updateStepStatus({ stepId: "draft-questions-repair", requestedStatus: "in_progress" }, { specId: created.specId });
    const repairHandoff = coordinator.createRequest({
      ctx: context,
      state: manager.load(created.specId),
      invocation: {
        id: "canonical-draft-repair",
        target: { digest: "d".repeat(64) },
        action: { digest: "c".repeat(64), nextAction: { step: "draft-questions-repair" } },
      },
    });
    assert.deepEqual(
      repairHandoff.inputs.find((input) => input.name === "draft-review-questions.json").document,
      review,
    );
    fs.writeFileSync(repairHandoff.payloadPath("draft-questions-repair.json"), `${JSON.stringify({
      version: 1,
      baseRevision: `sha256:${repairHandoff.inputRevision}`,
      operations: [{
        title: "Outside the triage scope",
        target: "outside",
        kind: "replace-value",
        path: "goal",
        expectedDigest: crypto.createHash("sha256").update(JSON.stringify("Review the canonical draft.")).digest("hex"),
        replacement: "This proposal must be discarded.",
        reason: "This operation is intentionally outside the triage scope.",
      }, {
        title: "Publish through the parent",
        target: "goal",
        kind: "replace-value",
        path: "goal",
        expectedDigest: crypto.createHash("sha256").update(JSON.stringify("Review the canonical draft.")).digest("hex"),
        replacement: "Repaired through the parent.",
        reason: "The parent owns durable publication.",
      }],
    }, null, 2)}\n`);
    sealWorkerArtifactHandoff({ requestPath: repairHandoff.requestPath, invocationId: "canonical-draft-repair" });

    const repaired = coordinator.reconcile({ ctx: context, request: repairHandoff });
    const draft = manager.readArtifact({
      specId: created.specId,
      logicalKey: "draft",
      consumerNodeId: "draft-refine",
    });
    const repairAudit = manager.readArtifact({
      specId: created.specId,
      logicalKey: "draft.questions.repair",
      consumerNodeId: "draft-refine",
    });
    assert.equal(repaired.completed, true);
    assert.equal(manager.canonicalState(created.specId).findNode("draft-questions-repair").status, "done");
    assert.equal(JSON.parse(draft.bytes.toString("utf8")).goal, "Repaired through the parent.");
    assert.equal(JSON.parse(repairAudit.bytes.toString("utf8")).acceptedOperations.length, 1);
    assert.equal(JSON.parse(repairAudit.bytes.toString("utf8")).discardedOperations[0].reason, "unauthorized operation");
    assert.deepEqual(JSON.parse(repairAudit.bytes.toString("utf8")).audit.envelopeErrors, []);
    assert.equal(fs.existsSync(path.join(location.directory, "draft-questions-repair.json")), false);
  });

  it("rewinds a V1 plan gate with cataloged evidence and no mutable repair marker", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "draft-gate");
    const source = {
      issueLogId: "draft-gate-blocking-evidence",
      step: "draft-gate",
      phase: "draft",
      reason: "The draft gate found a blocking retained behavior omission.",
      trigger: "gate post hook (auto)",
      observations: [{
        kind: "violation",
        failureMode: "guardrail-violation",
        requirementRef: "R-1",
        where: { file: "spec.json", locator: "requirements[0]" },
        observed: "The required behavior is absent from the draft.",
        severity: "blocking",
        refs: ["R-1"],
      }, {
        kind: "violation",
        failureMode: "process-evidence-missing",
        requirementRef: "process:gate-structure",
        where: null,
        observed: "The draft omits a required retained behavior.",
        severity: "blocking",
        refs: ["process:diff-verifiable"],
      }],
      timestamp: "2026-08-13T00:00:00.000Z",
    };
    const gateResult = attachCanonicalCommandResultArtifact({
      result: "fail",
      artifacts: {
        phase: "draft",
        nextAction: { diagnosis: { observations: source.observations } },
      },
    }, {
      logicalKey: "draft.gate",
      payload: {
        result: "fail",
        artifacts: {
          phase: "draft",
          nextAction: { diagnosis: { observations: source.observations } },
        },
      },
    });
    manager.failCurrentAttempt({
      specId: created.specId,
      failure: {
        category: "semantic",
        code: "GATE_REJECTED",
        message: "The draft gate has blocking evidence.",
        retryable: true,
        retryKind: "semantic",
      },
      commandResult: gateResult,
    });
    manager.appendIssueLog({
      specId: created.specId,
      entry: source,
      idempotencyKey: source.issueLogId,
    });
    manager.appendIssueLog({
      specId: created.specId,
      entry: {
        step: "prepare-spec",
        reason: "An unrelated lifecycle observation was recorded after the gate.",
        trigger: "test fixture",
      },
      idempotencyKey: "unrelated-lifecycle-observation",
    });
    const context = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
      flowState: manager.load(created.specId),
    };

    const repairAction = await new GetNextActionCommand().execute(context);
    assert.equal(repairAction.directive.actionId, "REPAIR_PLAN_GATE_EVIDENCE");
    assert.equal(repairAction.directive.phase, "draft");
    assert.match(repairAction.directive.nextAction, /sennel flow run repair-plan-gate/);

    const repaired = new RunRepairPlanGateCommand().execute(context);
    const typed = manager.canonicalState(created.specId);
    const projected = manager.load(created.specId);
    const activities = manager.activityLedger(created.specId);

    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.equal(repaired.data.previousStep, "draft-gate");
    assert.equal(typed.current.at(-1), "draft-refine");
    assert.equal(Object.hasOwn(typed.toJSON(), "planGateRepair"), false);
    assert.equal(Object.hasOwn(projected, "planGateRepair"), false);
    assert.equal(activities.at(-1).transition.operation, "plan_gate_repair");
    assert.equal(activities.at(-1).references.repairs[0].label, source.issueLogId);
    const workerAction = await new GetNextActionCommand().execute({
      ...context,
      flowState: manager.load(created.specId),
    });
    assert.equal(workerAction.step, "draft-refine");
    assert.deepEqual(workerAction.context.planGateRepair, {
      phase: "draft",
      targetStepId: "draft-refine",
      sourceIssueLogId: source.issueLogId,
      sourceEntryDigest: workerAction.context.planGateRepair.sourceEntryDigest,
      observations: source.observations,
    });

    confirmFixtureStep(manager, "draft-refine", { specId: created.specId });
    for (const stepId of ["draft-coverage-review", "draft-coverage-triage", "draft-coverage-repair"]) {
      const next = await new GetNextActionCommand().execute({
        ...context,
        flowState: manager.load(created.specId),
      });
      assert.equal(next.step, stepId);
      await new RunClaimNextActionCommand().execute({
        ...context,
        flowState: manager.load(created.specId),
      });
      confirmFixtureStep(manager, stepId, { specId: created.specId });
    }
    const freshGate = await new GetNextActionCommand().execute({
      ...context,
      flowState: manager.load(created.specId),
    });
    assert.equal(freshGate.step, "draft-gate");
    assert.equal(freshGate.directive.actionId, "CLAIM_NEXT_ACTION");
  });

  it("fails closed when a current gate result and issue-log observations do not match", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "draft-gate");
    const currentObservations = [{
      kind: "violation",
      failureMode: "guardrail-violation",
      requirementRef: "R-1",
      where: { file: "draft.json", locator: "requirements[0]" },
      observed: "The current gate result has this observation.",
      severity: "blocking",
      refs: ["R-1"],
    }];
    const staleObservations = [{
      ...currentObservations[0],
      observed: "A stale issue-log entry is not evidence for this result.",
    }];
    publishAttemptArtifact(manager, created.specId, "draft-gate", "draft.gate", {
      result: "fail",
      artifacts: {
        phase: "draft",
        nextAction: { diagnosis: { observations: currentObservations } },
      },
    });
    manager.failCurrentAttempt({
      specId: created.specId,
      failure: {
        category: "semantic",
        code: "GATE_REJECTED",
        message: "The current draft gate failed with different durable observations.",
        retryable: true,
        retryKind: "semantic",
      },
    });
    manager.appendIssueLog({
      specId: created.specId,
      entry: {
        step: "draft-gate",
        phase: "draft",
        reason: "A mismatched issue-log entry must not authorize repair.",
        trigger: "gate post hook (auto)",
        observations: staleObservations,
      },
      idempotencyKey: "mismatched-draft-gate-evidence",
    });
    const context = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
      flowState: manager.load(created.specId),
    };

    const next = await new GetNextActionCommand().execute(context);
    const repair = new RunRepairPlanGateCommand().execute(context);

    // Mismatched evidence cannot select repair. The current semantic Gate
    // observation remains eligible only for Definition-owned retry.
    assert.equal(next.directive.actionId, "CLAIM_GATE_RETRY");
    assert.equal(repair.ok, false);
    assert.equal(repair.errors[0].code, "PLAN_GATE_REPAIR_NOT_ADMITTED");
    assert.equal(manager.canonicalState(created.specId).current.at(-1), "draft-gate");
  });

  it("records Draft Gate recovery facts deterministically without inventing a Draft recovery route", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "draft-gate");
    manager.publishCurrentAttemptResult({
      specId: created.specId,
      commandResult: attachCanonicalCommandResultArtifact({
        result: "recovered", artifacts: { phase: "draft" },
      }, {
        logicalKey: "draft.gate",
        payload: { result: "recovered", artifacts: { phase: "draft" } },
      }),
    });
    const facts = readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(created.specId), phase: "draft",
    });
    const reloaded = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const reloadedFacts = readCurrentGateTransitionFacts({
      flowManager: reloaded, flowState: reloaded.load(created.specId), phase: "draft",
    });
    assert.equal(resolveGateTransition(facts).disposition.operation, "recovery");
    assert.deepEqual(reloadedFacts.toJSON(), facts.toJSON());
    assert.equal(manager.canonicalState(created.specId).current.at(-1), "draft-gate");
  });

  it("proves integration Gate reader bindings and Definition plans survive reload", () => {
    const integration = (suffix) => integrationGateFixture(`reader-${suffix}`);
    const promote = (manager, specId, input) => new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "integration", nodeId: "impl-gate",
    }).promote(input);

    const passing = integration("pass");
    const passResult = promote(passing.manager, passing.specId, { result: "pass", artifacts: {} });
    passing.manager.publishCurrentAttemptResult({ specId: passing.specId, commandResult: passResult });
    const passFacts = readCurrentGateTransitionFacts({
      flowManager: passing.manager, flowState: passing.manager.load(passing.specId), phase: "integration",
    });
    const passDecision = resolveGateTransition(passFacts);
    assert.equal(passDecision.disposition.operation, "pass");
    assert.equal(Object.hasOwn(passDecision.plan.phaseDefinition, "nextStepId"), false);
    assert.equal(passDecision.advance.operation, "advance");
    const reloadedManager = new FlowManager({ root: passing.repository, mainRoot: passing.repository, inWorktree: false });
    const reloadedDecision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: reloadedManager, flowState: reloadedManager.load(passing.specId), phase: "integration",
    }));
    assert.deepEqual(reloadedDecision.plan.toJSON(), passDecision.plan.toJSON());
    assert.equal(reloadedDecision.plan.action.identity.matches(passDecision.plan.action.identity), true);

    const semantic = integration("semantic");
    const semanticResult = promote(semantic.manager, semantic.specId, {
      result: "fail", artifacts: { failureKind: "ai_semantic_fail", failureCode: "INTEGRATION_REJECTED" },
    });
    semantic.manager.failCurrentAttempt({
      specId: semantic.specId,
      failure: { category: "semantic", code: "INTEGRATION_REJECTED", message: "fixture", retryable: true, retryKind: "semantic" },
      commandResult: semanticResult,
    });
    assert.equal(resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: semantic.manager, flowState: semantic.manager.load(semantic.specId), phase: "integration",
    })).disposition.operation, "retry");

    const tooling = integration("tooling");
    const toolingResult = promote(tooling.manager, tooling.specId, {
      result: "fail", artifacts: { failureKind: "provider_failure", failureCode: "INTEGRATION_PROVIDER_FAILURE" },
    });
    tooling.manager.failCurrentAttempt({
      specId: tooling.specId,
      failure: { category: "tooling", code: "INTEGRATION_PROVIDER_FAILURE", message: "fixture", retryable: false, retryKind: null },
      commandResult: toolingResult,
    });
    assert.equal(resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: tooling.manager, flowState: tooling.manager.load(tooling.specId), phase: "integration",
    })).disposition.operation, "external-blocked");

    for (const [suffix, field, value, pattern] of [
      ["stale-attempt", "gateTransitionAttemptId", "old-attempt", /Attempt binding/],
      ["stale-lineage", "gateTransitionLineage", "f".repeat(64), /lineage binding/],
    ]) {
      const stale = integration(suffix);
      const state = stale.manager.canonicalState(stale.specId);
      const artifacts = {
        phase: "integration",
        gateTransitionAttemptId: state.attempt.id,
        gateTransitionAttemptSequence: state.attempt.sequence,
        gateTransitionLineage: canonicalGateRevision(state, "impl-gate"),
        [field]: value,
      };
      const result = attachCanonicalCommandResultArtifact({ result: "pass", artifacts }, {
        logicalKey: "impl.gate", payload: { result: "pass", artifacts },
      });
      stale.manager.publishCurrentAttemptResult({ specId: stale.specId, commandResult: result });
      assert.throws(() => readCurrentGateTransitionFacts({
        flowManager: stale.manager, flowState: stale.manager.load(stale.specId), phase: "integration",
      }), pattern);
    }
  });

  it("admits only the current recovered integration Gate decision for test evidence rewind", () => {
    const fixture = integrationGateFixture("recovery-admission");
    const recovered = new CanonicalGatePromotion({
      state: fixture.manager.canonicalState(fixture.specId), phase: "integration", nodeId: "impl-gate",
    }).promote({
      result: "recovered",
      artifacts: {
        evidenceRefresh: {
          recovered: true,
          previousFingerprint: "b".repeat(64),
          currentFingerprint: "a".repeat(64),
          invalidatedArtifacts: ["test.execute", "test.result.review"],
        },
      },
    });
    fixture.manager.publishCurrentAttemptResult({ specId: fixture.specId, commandResult: recovered });
    let decision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: fixture.manager, flowState: fixture.manager.load(fixture.specId), phase: "integration",
    }));
    assert.equal(decision.disposition.operation, "recovery");

    const passing = integrationGateFixture("recovery-pass-decision");
    const passResult = new CanonicalGatePromotion({
      state: passing.manager.canonicalState(passing.specId), phase: "integration", nodeId: "impl-gate",
    }).promote({ result: "pass", artifacts: {} });
    passing.manager.publishCurrentAttemptResult({ specId: passing.specId, commandResult: passResult });
    const passDecision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: passing.manager, flowState: passing.manager.load(passing.specId), phase: "integration",
    }));
    assert.throws(
      () => fixture.manager.rewindTestEvidence({ specId: fixture.specId, decision: passDecision }),
      /recovery|decision|stale/i,
    );

    const stale = integrationGateFixture("recovery-stale-decision");
    const staleResult = new CanonicalGatePromotion({
      state: stale.manager.canonicalState(stale.specId), phase: "integration", nodeId: "impl-gate",
    }).promote({ result: "recovered", artifacts: { evidenceRefresh: { recovered: true } } });
    stale.manager.publishCurrentAttemptResult({ specId: stale.specId, commandResult: staleResult });
    const staleDecision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: stale.manager, flowState: stale.manager.load(stale.specId), phase: "integration",
    }));
    assert.throws(
      () => fixture.manager.rewindTestEvidence({ specId: fixture.specId, decision: staleDecision }),
      /current|stale|identity/i,
    );

    fixture.manager.rewindTestEvidence({ specId: fixture.specId, decision });
    const state = fixture.manager.load(fixture.specId);
    assert.equal(state.currentNodeId, "test-execute");
    assert.equal(findStepById(state.steps, "impl-gate").status, "invalidated");
  });

  it("settles exhausted integration semantic failures and preserves the acceptance route", async () => {
    const fixture = integrationGateFixture("settlement");
    const observation = {
      kind: "violation", failureMode: "required_behavior", requirementRef: "R-1",
      where: { file: "src/example.js", locator: "implementation" }, observed: "The required behavior remains absent.",
      severity: "blocking", refs: ["R-1"],
    };
    let exhausted = null;
    for (let evaluation = 1; evaluation <= 5; evaluation += 1) {
      const commandResult = new CanonicalGatePromotion({
        state: fixture.manager.canonicalState(fixture.specId), phase: "integration", nodeId: "impl-gate",
      }).promote({
        result: "fail",
        artifacts: {
          failureKind: "ai_semantic_fail",
          failureCode: "INTEGRATION_REJECTED",
          nextAction: { diagnosis: { observations: [observation] } },
        },
      });
      fixture.manager.failCurrentAttempt({
        specId: fixture.specId,
        failure: {
          category: "semantic", code: "INTEGRATION_REJECTED", message: "fixture",
          retryable: evaluation < 5, retryKind: evaluation < 5 ? "semantic" : null,
        },
        commandResult,
      });
      const decision = resolveGateTransition(readCurrentGateTransitionFacts({
        flowManager: fixture.manager, flowState: fixture.manager.load(fixture.specId), phase: "integration",
      }));
      if (evaluation < 5) {
        assert.equal(decision.disposition.operation, "retry");
        fixture.manager.retryGateTransition({ specId: fixture.specId, decision });
      } else {
        exhausted = decision;
      }
    }
    assert.equal(exhausted.disposition.operation, "defer");
    const context = {
      root: fixture.repository, mainRoot: fixture.repository, executionRoot: fixture.repository,
      specId: fixture.specId, flowManager: fixture.manager, flowState: fixture.manager.load(fixture.specId),
    };
    const settled = new RunSettleGateTransitionCommand().execute(context);
    assert.equal(settled.ok, true, JSON.stringify(settled));
    const state = fixture.manager.load(fixture.specId);
    assert.equal(findStepById(state.steps, "impl-gate").status, "done");
    assert.equal(findStepById(state.steps, "retro").status, "pending");
    assert.equal(findStepById(state.steps, "acceptance-review").status, "pending");
    const findings = fixture.manager.readArtifact({
      specId: fixture.specId, logicalKey: "flow.findings", consumerNodeId: "acceptance-review",
    });
    assert.ok(findings);
    assert.equal(fixture.manager.activityLedger(fixture.specId).at(-1).transition.operation, "defer_failed_gate");
    assert.equal(new RunSettleGateTransitionCommand().execute(context).ok, false, "settlement cannot repeat");
    assert.throws(
      () => fixture.manager.retryGateTransition({ specId: fixture.specId, decision: exhausted }),
      /current|stale|defer/i,
    );
    const retro = await new GetNextActionCommand().execute({
      ...context, flowState: fixture.manager.load(fixture.specId),
    });
    assert.equal(retro.step, "retro");
    fixture.manager.updateStepStatus({ stepId: "retro", requestedStatus: "in_progress" }, { specId: fixture.specId });
    confirmFixtureStep(fixture.manager, "retro", { specId: fixture.specId });
    const acceptance = await new GetNextActionCommand().execute({
      ...context, flowState: fixture.manager.load(fixture.specId),
    });
    assert.equal(acceptance.step, "acceptance-review");
  });

  it("settles the fifth persisted Draft Gate semantic failure, records findings, and rejects a sixth retry", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "draft-gate");
    const observation = {
      kind: "violation", failureMode: "guardrail-violation", requirementRef: "R-1",
      where: { file: "draft.json", locator: "goal" }, observed: "A bounded fixture finding.",
      severity: "blocking", refs: ["R-1"],
    };
    let fifthDecision = null;
    for (let evaluation = 1; evaluation <= 5; evaluation += 1) {
      const commandResult = attachCanonicalCommandResultArtifact({
        result: "fail",
        artifacts: {
          phase: "draft", gateTransitionFailureCategory: { category: "semantic", code: "GATE_REJECTED" },
          nextAction: { diagnosis: { observations: [observation] } },
        },
      }, {
        logicalKey: "draft.gate",
        payload: {
          result: "fail",
          artifacts: {
            phase: "draft", gateTransitionFailureCategory: { category: "semantic", code: "GATE_REJECTED" },
            nextAction: { diagnosis: { observations: [observation] } },
          },
        },
      });
      manager.failCurrentAttempt({
        specId: created.specId,
        failure: { category: "semantic", code: "GATE_REJECTED", message: "fixture", retryable: evaluation < 5, retryKind: evaluation < 5 ? "semantic" : null },
        commandResult,
      });
      const facts = readCurrentGateTransitionFacts({ flowManager: manager, flowState: manager.load(created.specId), phase: "draft" });
      const decision = resolveGateTransition(facts);
      if (evaluation < 5) {
        assert.equal(decision.disposition.operation, "retry");
        manager.retryGateTransition({ specId: created.specId, decision });
        if (evaluation === 1) {
          const stateBeforeStale = manager.canonicalState(created.specId).toJSON();
          const activitiesBeforeStale = manager.activityLedger(created.specId);
          const catalogBeforeStale = manager.artifactCatalog(created.specId).toJSON();
          assert.throws(() => manager.retryGateTransition({ specId: created.specId, decision }), /no longer current|stale/);
          assert.deepEqual(manager.canonicalState(created.specId).toJSON(), stateBeforeStale);
          assert.deepEqual(manager.activityLedger(created.specId), activitiesBeforeStale);
          assert.deepEqual(manager.artifactCatalog(created.specId).toJSON(), catalogBeforeStale);
        }
      } else {
        fifthDecision = decision;
      }
    }
    assert.equal(fifthDecision.disposition.operation, "defer");
    const next = await new GetNextActionCommand().execute({
      root: repository, mainRoot: repository, executionRoot: repository, specId: created.specId,
      flowManager: manager, flowState: manager.load(created.specId),
    });
    assert.equal(next.directive.actionId, "SETTLE_GATE_DEFER");
    const beforeActivities = manager.activityLedger(created.specId);
    manager.settleGateTransition({ specId: created.specId, decision: fifthDecision });
    const settled = manager.canonicalState(created.specId);
    assert.equal(settled.findNode("draft-gate").status, "done");
    assert.equal(leaves(manager.load(created.specId).steps).find((step) => step.id === "spec").status, "pending");
    const findings = manager.readArtifact({ specId: created.specId, logicalKey: "flow.findings", consumerNodeId: "draft-gate" });
    assert.ok(findings);
    assert.equal(manager.activityLedger(created.specId).length, beforeActivities.length + 1);
    assert.equal(manager.activityLedger(created.specId).at(-1).transition.operation, "defer_failed_gate");
  });

  it("rejects implementation and Task gate repair without a current Definition-selected receipt", async () => {
    const implementations = root();
    const implManager = new FlowManager({ root: implementations, mainRoot: implementations, inWorktree: false });
    new FlowAtStepFixture({
      flowManager: implManager,
      specId: "001-impl-gate-block",
      runId: "run-impl-gate-block",
      request: "Keep implementation gate recovery explicit.",
      targetStep: "impl-gate",
    }).create();
    const tasks = root();
    const taskManager = new FlowManager({ root: tasks, mainRoot: tasks, inWorktree: false });
    new TaskLifecycleFixture({
      flowManager: taskManager,
      specId: "001-task-gate-block",
      runId: "run-task-gate-block",
      request: "Keep Task gate recovery explicit.",
      specRecord: {
        requirements: [{ id: "R-1", desc: "Keep Task gate recovery explicit.", task_ids: ["T-1"] }],
        overview: { modules: [], data_flow: [], decisions: [] },
      },
      taskDocuments: [{
        id: "T-1",
        title: "Task gate blocker",
        goal: "Exercise Task gate failure routing.",
        parent: null,
        origin: "plan",
        added_round: 0,
        status: "pending",
      }],
      taskId: "T-1",
      targetStep: "task-gate",
    }).create();

    for (const [manager, specId, expectedStep, expectedRepairCode] of [
      [implManager, "001-impl-gate-block", "impl-gate", "PLAN_GATE_REPAIR_STAGE_UNSUPPORTED"],
      // Task Gate repair is supported only after a current catalog/lineage
      // receipt. A bare semantic failure must remain side-effect free.
      [taskManager, "001-task-gate-block", "task-gate", "PLAN_GATE_REPAIR_NOT_ADMITTED"],
    ]) {
      manager.failCurrentAttempt({
        specId,
        failure: {
          category: "semantic",
          code: "GATE_REJECTED",
          message: "The gate requires its dedicated recovery evidence.",
          retryable: true,
          retryKind: "semantic",
        },
      });
      const context = {
        root: manager === implManager ? implementations : tasks,
        mainRoot: manager === implManager ? implementations : tasks,
        executionRoot: manager === implManager ? implementations : tasks,
        specId,
        flowManager: manager,
        flowState: manager.load(specId),
      };
      const next = await new GetNextActionCommand().execute(context);
      const repair = new RunRepairPlanGateCommand().execute(context);

      assert.equal(next.step, expectedStep);
      assert.equal(next.directive.code, "CANONICAL_ATTEMPT_BLOCKED");
      assert.equal(repair.ok, false);
      assert.equal(repair.errors[0].code, expectedRepairCode);
    }
  });

  it("persists the sealed Task Gate pass lifecycle through Task completion and its exact successor", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    new TaskLifecycleFixture({
      flowManager: manager,
      specId: "001-task-gate-pass-successor",
      runId: "run-task-gate-pass-successor",
      request: "Persist the Task Gate successor.",
      taskDocuments: [
        { id: "T-1", title: "first", goal: "finish first", parent: null, origin: "plan", added_round: 0, status: "pending" },
        { id: "T-2", title: "second", goal: "begin second", parent: null, origin: "plan", added_round: 0, status: "pending" },
      ],
      taskId: "T-1",
      targetStep: "task-gate",
    }).create();
    const specId = "001-task-gate-pass-successor";
    const result = new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1",
    }).promote({ result: "pass", artifacts: { sourceFingerprint: currentTaskSourceFingerprint(manager, specId) } });
    manager.publishCurrentAttemptResult({ specId, commandResult: result });
    let decision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
    }));
    assert.equal(decision.disposition.operation, "pass");
    assert.equal(decision.facts.taskLifecycle.integrationStepId, "test-execute");
    assert.equal(decision.facts.taskLifecycle.successorStepId, "T-2-impl");
    const bypassBefore = {
      state: manager.canonicalState(specId).toJSON(), activities: manager.activityLedger(specId),
      catalog: manager.artifactCatalog(specId).toJSON(),
    };
    assert.throws(() => manager.updateStepStatus({ stepId: "T-1-gate", requestedStatus: "done" }, {
      specId,
      gateTaskLifecycle: { operation: "complete-and-advance", taskId: "T-1", successorStepId: "T-2-impl", resetStepIds: [] },
    }), /Definition-selected lifecycle/);
    assert.deepEqual(manager.canonicalState(specId).toJSON(), bypassBefore.state);
    assert.deepEqual(manager.activityLedger(specId), bypassBefore.activities);
    assert.deepEqual(manager.artifactCatalog(specId).toJSON(), bypassBefore.catalog);
    assert.throws(() => manager.confirmCurrentAttempt({
      specId,
      status: "done",
      gateTaskLifecycle: { operation: "complete-and-advance", taskId: "T-1", successorStepId: "T-2-impl", resetStepIds: [] },
    }), /Definition-selected lifecycle/);
    assert.deepEqual(manager.canonicalState(specId).toJSON(), bypassBefore.state);
    assert.deepEqual(manager.activityLedger(specId), bypassBefore.activities);
    assert.deepEqual(manager.artifactCatalog(specId).toJSON(), bypassBefore.catalog);
    assert.throws(() => manager.confirmCurrentAttempt({
      specId, status: "done", gateTransitionDecision: decision,
    }), /settlement effect/);
    manager.recordTaskGateSettlementMetric({ specId, decision });
    decision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
    }));
    appendIssueLogFromGateResult({
      root: repository, mainRoot: repository, executionRoot: repository,
      specId, flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
      gateTransitionDecision: decision,
    }, result);
    decision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
    }));
    manager.confirmCurrentAttempt({ specId, status: "done", gateTransitionDecision: decision });
    const reloaded = manager.canonicalState(specId);
    assert.equal(reloaded.findNode("T-1").status, "done");
    assert.equal(reloaded.findNode("T-1-gate").status, "done");
    assert.equal(reloaded.nextAction().nodeId, "T-2-impl");
    assert.deepEqual(manager.activityLedger(specId).at(-1).transition.gateTaskLifecycle, {
      operation: "complete-and-advance", taskId: "T-1", successorStepId: "T-2-impl", resetStepIds: [],
    });
    new TaskLifecycleFixture({
      flowManager: manager,
      specId: "001-task-gate-pass-stale-decision",
      runId: "run-task-gate-pass-stale-decision",
      request: "Reject a decision from another current Gate.",
      taskDocuments: [{ id: "T-1", title: "other", goal: "remain unchanged", parent: null, origin: "plan", added_round: 0, status: "pending" }],
      taskId: "T-1",
      targetStep: "task-gate",
    }).create();
    const staleSpecId = "001-task-gate-pass-stale-decision";
    const staleBefore = {
      state: manager.canonicalState(staleSpecId).toJSON(), activities: manager.activityLedger(staleSpecId),
      catalog: manager.artifactCatalog(staleSpecId).toJSON(),
    };
    assert.throws(() => manager.updateStepStatus({ stepId: "T-1-gate", requestedStatus: "done" }, {
      specId: staleSpecId, gateTransitionDecision: decision,
    }), /no longer current|stale/);
    assert.deepEqual(manager.canonicalState(staleSpecId).toJSON(), staleBefore.state);
    assert.deepEqual(manager.activityLedger(staleSpecId), staleBefore.activities);
    assert.deepEqual(manager.artifactCatalog(staleSpecId).toJSON(), staleBefore.catalog);
  });

  it("persists the sealed final Task Gate pass lifecycle through Flow integration", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    new TaskLifecycleFixture({
      flowManager: manager,
      specId: "001-task-gate-pass-integration",
      runId: "run-task-gate-pass-integration",
      request: "Return to integration after the final Task.",
      taskDocuments: [
        { id: "T-1", title: "only", goal: "finish only", parent: null, origin: "plan", added_round: 0, status: "pending" },
      ],
      taskId: "T-1",
      targetStep: "task-gate",
    }).create();
    const specId = "001-task-gate-pass-integration";
    const result = new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1",
    }).promote({ result: "pass", artifacts: { sourceFingerprint: currentTaskSourceFingerprint(manager, specId) } });
    manager.publishCurrentAttemptResult({ specId, commandResult: result });
    let decision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
    }));
    assert.equal(decision.disposition.operation, "pass");
    manager.recordTaskGateSettlementMetric({ specId, decision });
    decision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
    }));
    appendIssueLogFromGateResult({
      root: repository, mainRoot: repository, executionRoot: repository,
      specId, flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
      gateTransitionDecision: decision,
    }, result);
    decision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
    }));
    manager.updateStepStatus({ stepId: "T-1-gate", requestedStatus: "done" }, { specId, gateTransitionDecision: decision });
    const reloaded = manager.canonicalState(specId);
    assert.equal(reloaded.findNode("T-1").status, "done");
    assert.equal(reloaded.nextAction().nodeId, "test-execute");
  });

  it("binds Task Gate issue settlement to its attached canonical result and admits it only after the metric", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const specId = "001-task-gate-settlement-entry-bound";
    new TaskLifecycleFixture({
      flowManager: manager, specId, runId: "run-task-gate-settlement-entry-bound",
      request: "Bind Task Gate settlement to canonical producer evidence.",
      taskDocuments: [{ id: "T-1", title: "only", goal: "prove durable settlement order", parent: null, origin: "plan", added_round: 0, status: "pending" }],
      taskId: "T-1", targetStep: "task-gate",
    }).create();
    const result = new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1",
    }).promote({ result: "pass", artifacts: { sourceFingerprint: currentTaskSourceFingerprint(manager, specId) } });
    manager.publishCurrentAttemptResult({ specId, commandResult: result });
    let decision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
    }));
    const context = {
      root: repository, mainRoot: repository, executionRoot: repository,
      specId, flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
      gateTransitionDecision: decision,
    };
    const before = manager.activityLedger(specId);
    const forged = structuredClone(result);
    forged.result = "fail";
    assert.throws(() => appendIssueLogFromGateResult(context, forged), /canonical result/);
    assert.throws(() => appendIssueLogFromGateResult(context, result), /settlement effect/);
    assert.deepEqual(manager.activityLedger(specId), before, "rejected Task settlement inputs must not publish an issue entry");

    manager.recordTaskGateSettlementMetric({ specId, decision });
    decision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
    }));
    appendIssueLogFromGateResult({ ...context, flowState: manager.load(specId), gateTransitionDecision: decision }, result);
    const facts = readCurrentGateTransitionFacts({ flowManager: manager, flowState: manager.load(specId), phase: "task-impl" });
    assert.equal(facts.taskSettlementProgress.issueLogRecorded, true);
    assert.equal(manager.activityLedger(specId).at(-1).id.startsWith("task-gate-issue-log-"), true);
  });

  it("rejects direct Task Gate retry while its canonical settlement is incomplete", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const specId = "001-task-gate-retry-settlement-required";
    new TaskLifecycleFixture({
      flowManager: manager, specId, runId: "run-task-gate-retry-settlement-required",
      request: "Keep Task retries behind durable settlement.",
      taskDocuments: [{ id: "T-1", title: "only", goal: "do not lose gate effects", parent: null, origin: "plan", added_round: 0, status: "pending" }],
      taskId: "T-1", targetStep: "task-gate",
    }).create();
    const result = new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1",
    }).promote({
      result: "fail",
      artifacts: {
        failureKind: "ai_semantic_fail", failureCode: "TASK_GATE_REJECTED",
        sourceFingerprint: currentTaskSourceFingerprint(manager, specId),
      },
    });
    manager.failCurrentAttempt({
      specId,
      failure: { category: "semantic", code: "TASK_GATE_REJECTED", message: "settle before retry", retryable: true, retryKind: "semantic" },
      commandResult: result,
    });
    const decision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
    }));
    const before = { state: manager.canonicalState(specId).toJSON(), activities: manager.activityLedger(specId) };
    assert.throws(() => manager.retryGateTransition({ specId, decision }), /settlement effect/);
    assert.deepEqual(manager.canonicalState(specId).toJSON(), before.state);
    assert.deepEqual(manager.activityLedger(specId), before.activities);
  });

  it("safe-blocks matching Task issue ids recorded by an unbound or out-of-order Activity", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const specId = "001-task-gate-issue-order-evidence";
    new TaskLifecycleFixture({
      flowManager: manager, specId, runId: "run-task-gate-issue-order-evidence",
      request: "Keep issue settlement provenance ordered.",
      taskDocuments: [{ id: "T-1", title: "only", goal: "reject unbound issue evidence", parent: null, origin: "plan", added_round: 0, status: "pending" }],
      taskId: "T-1", targetStep: "task-gate",
    }).create();
    const result = new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1",
    }).promote({ result: "pass", artifacts: { sourceFingerprint: currentTaskSourceFingerprint(manager, specId) } });
    manager.publishCurrentAttemptResult({ specId, commandResult: result });
    const decision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
    }));
    const entry = new GateIssueLogEntry({
      ctx: {
        root: repository, mainRoot: repository, executionRoot: repository,
        specId, flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
        gateTransitionDecision: decision,
      },
      result,
    }).toJSON();
    entry.gateReceipt.lineage.canonicalFingerprint = "f".repeat(64);
    manager.appendIssueLog({ specId, entry, idempotencyKey: entry.issueLogId });
    assert.throws(() => readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
    }), /issue-log (Activity is unavailable|effect is out of order or not bound)/);
  });

  it("rejects a Task Gate decision when allow-listed source changes after result publication", async () => {
    const repository = root();
    initializeReviewSource(repository);
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const specId = "001-task-gate-stale-source";
    new TaskLifecycleFixture({
      flowManager: manager,
      specId,
      runId: "run-task-gate-stale-source",
      request: "reject stale Task Gate source",
      specRecord: {
        requirements: [{ id: "R-1", desc: "Reject stale Task Gate source.", task_ids: ["T-1"] }],
        overview: { modules: [], data_flow: [], decisions: [] },
      },
      taskDocuments: [{ id: "T-1", title: "Stale Gate", goal: "Bind Gate to current source.", parent: null, origin: "plan", added_round: 0, status: "pending" }],
      taskId: "T-1",
      targetStep: "task-impl",
    }).create();
    confirmTaskImplementationMutation({ repository, manager, specId, content: "implemented before Gate\n" });
    const review = await publishTaskReview({ repository, manager, specId });
    assert.notEqual(review.ok, false, JSON.stringify(review));
    assert.equal(manager.canonicalState(specId).current.at(-1), "T-1-gate");
    const result = new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1",
    }).promote({
      result: "pass",
      artifacts: { sourceFingerprint: currentTaskSourceFingerprint(manager, specId) },
    });
    manager.publishCurrentAttemptResult({ specId, commandResult: result });
    const decision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
    }));
    fs.appendFileSync(path.join(repository, "README.md"), "concurrent mutation after Gate publication\n");

    assert.throws(() => readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
    }), /source fingerprint is stale/);
    assert.throws(() => manager.updateStepStatus(
      { stepId: "T-1-gate", requestedStatus: "done" },
      { specId, gateTransitionDecision: decision },
    ), /source fingerprint is stale/);
    assert.equal(manager.canonicalState(specId).findNode("T-1-gate").status, "in_progress");
  });

  it("routes first-round exhausted Task Gate evidence through the sealed repair plan", () => {
    const repository = root();
    const manager = new FlowManager({
      root: repository,
      mainRoot: repository,
      inWorktree: false,
    });
    new TaskLifecycleFixture({
      flowManager: manager,
      specId: "001-task-gate-defer-successor",
      runId: "run-task-gate-defer-successor",
      request: "Settle the deferred Task Gate finding.",
      taskDocuments: [
        { id: "T-1", title: "first", goal: "defer first", parent: null, origin: "plan", added_round: 0, status: "pending" },
        { id: "T-2", title: "second", goal: "begin second", parent: null, origin: "plan", added_round: 0, status: "pending" },
      ],
      taskId: "T-1",
      targetStep: "task-gate",
    }).create();
    const specId = "001-task-gate-defer-successor";
    const parentGateAttemptSequence = manager.canonicalState(specId).findNode("spec-gate").attemptSequence;
    const observation = {
      kind: "violation", failureMode: "guardrail-violation", requirementRef: "R-1",
      where: { file: "src/task.js", locator: "T-1" }, observed: "A persistent Task Gate finding.",
      severity: "blocking", refs: ["R-1"],
    };
    let exhaustion = null;
    let firstFailedTaskGateRecord = null;
    for (let evaluation = 1; evaluation <= 5; evaluation += 1) {
      const commandResult = new CanonicalGatePromotion({
        state: manager.canonicalState(specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1",
      }).promote({
        result: "fail",
        artifacts: {
          failureKind: "ai_semantic_fail", failureCode: "TASK_GATE_REJECTED",
          sourceFingerprint: currentTaskSourceFingerprint(manager, specId),
          nextAction: { diagnosis: { observations: [observation] } },
        },
      });
      manager.failCurrentAttempt({
        specId,
        failure: {
          category: "semantic", code: "TASK_GATE_REJECTED", message: "persisted finding",
          retryable: evaluation < 5, retryKind: evaluation < 5 ? "semantic" : null,
        },
        commandResult,
      });
      let facts = readCurrentGateTransitionFacts({ flowManager: manager, flowState: manager.load(specId), phase: "task-impl" });
      if (evaluation === 1) {
        const firstHistory = FlowArtifactAttemptHistory.fromJSON(JSON.parse(manager.readProducerArtifact({
          specId, nodeId: "T-1-gate", logicalKey: "task.gate", parameters: { taskId: "T-1" },
        }).bytes.toString("utf8")));
        firstFailedTaskGateRecord = firstHistory.current.toJSON();
      }
      let decision = resolveGateTransition(facts);
      if (decision.plan.retryMetric !== null) {
        manager.recordTaskGateSettlementMetric({ specId, decision });
      }
      facts = readCurrentGateTransitionFacts({ flowManager: manager, flowState: manager.load(specId), phase: "task-impl" });
      decision = resolveGateTransition(facts);
      appendIssueLogFromGateResult({
        root: repository, mainRoot: repository, executionRoot: repository,
        specId, flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
        gateTransitionDecision: decision,
        gitState: { headSha: "a".repeat(40), worktreeHash: "b".repeat(64) },
      }, commandResult);
      decision = resolveGateTransition(readCurrentGateTransitionFacts({
        flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
      }));
      if (evaluation < 5) {
        assert.equal(decision.disposition.operation, "retry");
        manager.retryGateTransition({ specId, decision });
      } else {
        exhaustion = decision;
      }
    }
    assert.equal(exhaustion.disposition.operation, "repair");
    assert.equal(exhaustion.facts.taskBudget.round, 1);
    assert.equal(exhaustion.facts.taskLifecycle.integrationStepId, "test-execute");
    assert.equal(exhaustion.plan.taskLifecycle.operation, "repair-task-impl");
    assert.equal(exhaustion.plan.taskLifecycle.successorStepId, "T-1-impl");
    const taskHistory = FlowArtifactAttemptHistory.fromJSON(JSON.parse(manager.readProducerArtifact({
      specId, nodeId: "T-1-gate", logicalKey: "task.gate", parameters: { taskId: "T-1" },
    }).bytes.toString("utf8")));
    assert.deepEqual(taskHistory.attempts.map((entry) => entry.attempt.value), [1, 2, 3, 4, 5]);
    assert.equal(taskHistory.attempts.every((entry) => entry.payload.artifact.payload.result === "fail"), true);
    assert.deepEqual(taskHistory.attempts[0].toJSON(), firstFailedTaskGateRecord);
    assert.deepEqual(
      manager.activityLedger(specId)
        .filter((activity) => activity.transition.operation === "retry_gate_attempt")
        .map((activity) => activity.nodeId),
      ["T-1-gate", "T-1-gate", "T-1-gate", "T-1-gate"],
    );
    assert.equal(manager.canonicalState(specId).findNode("spec-gate").attemptSequence, parentGateAttemptSequence);
    assert.throws(() => manager.settleGateTransition({ specId, decision: exhaustion }), /defer|stale|no longer admitted/);
  });

  for (const repairedReviewStages of [false, true]) {
    it(`converges one Task across two bounded Gate rounds with ${repairedReviewStages ? "completed" : "skipped"} review stages and advances with deferred findings`, async () => {
    const repository = root();
    initializeReviewSource(repository);
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const specId = `001-task-gate-two-round-convergence-${repairedReviewStages ? "completed" : "skipped"}`;
    new TaskLifecycleFixture({
      flowManager: manager,
      specId,
      runId: "run-task-gate-two-round-convergence",
      request: "Bound Task Gate repair to two execution rounds.",
      taskDocuments: [
        { id: "T-1", title: "first", goal: "converge or defer", parent: null, origin: "plan", added_round: 0, status: "pending" },
        { id: "T-2", title: "second", goal: "continue after first", parent: null, origin: "plan", added_round: 0, status: "pending" },
      ],
      taskId: "T-1",
      targetStep: "task-impl",
    }).create();
    const observation = {
      kind: "violation", failureMode: "guardrail-violation", requirementRef: "R-T-1",
      where: { file: "README.md", locator: "T-1" }, observed: "The Task Gate finding remains unresolved.",
      severity: "blocking", refs: ["R-T-1"],
    };
    const context = () => ({
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId,
      flowManager: manager,
      flowState: manager.load(specId),
    });
    const exhaustCurrentGateRound = (round, { startAt = 1, stopAfter = 5 } = {}) => {
      let exhausted = null;
      for (let evaluation = startAt; evaluation <= stopAfter; evaluation += 1) {
        const commandResult = new CanonicalGatePromotion({
          state: manager.canonicalState(specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1",
        }).promote({
          result: "fail",
          artifacts: {
            failureKind: "ai_semantic_fail",
            failureCode: "TASK_GATE_REJECTED",
            sourceFingerprint: currentTaskSourceFingerprint(manager, specId),
            nextAction: { diagnosis: { observations: [observation] } },
          },
        });
        // Production gate:post persists the canonical result first, then
        // records the semantic failure against that same Gate Attempt.
        manager.publishCurrentAttemptResult({ specId, commandResult });
        const publishedDecision = resolveGateTransition(readCurrentGateTransitionFacts({
          flowManager: manager,
          flowState: manager.load(specId),
          phase: "task-impl",
        }));
        manager.recordGateObservationDecision({ specId, decision: publishedDecision });
        let decision = resolveGateTransition(readCurrentGateTransitionFacts({
          flowManager: manager,
          flowState: manager.load(specId),
          phase: "task-impl",
        }));
        if (decision.plan.retryMetric !== null) {
          manager.recordTaskGateSettlementMetric({ specId, decision });
        }
        decision = resolveGateTransition(readCurrentGateTransitionFacts({
          flowManager: manager,
          flowState: manager.load(specId),
          phase: "task-impl",
        }));
        // Production gate:post publishes a matching issue-log receipt after
        // every failed evaluation, including retries. That receipt must not
        // bypass the Task Gate semantic retry budget.
        appendIssueLogFromGateResult({
          ...context(),
          phase: "task-impl",
          gateTransitionDecision: decision,
          gitState: computeGitState(repository),
        }, commandResult);
        decision = resolveGateTransition(readCurrentGateTransitionFacts({
          flowManager: manager,
          flowState: manager.load(specId),
          phase: "task-impl",
        }));
        assert.equal(decision.facts.taskBudget.round, round);
        if (evaluation < 5) {
          assert.equal(decision.disposition.operation, "retry");
          if (evaluation === stopAfter) return decision;
          manager.retryGateTransition({ specId, decision });
          continue;
        }
        decision = resolveGateTransition(readCurrentGateTransitionFacts({
          flowManager: manager,
          flowState: manager.load(specId),
          phase: "task-impl",
        }));
        exhausted = decision;
      }
      return exhausted;
    };

    confirmTaskImplementationMutation({
      repository,
      manager,
      specId,
      requirementId: "R-T-1",
      content: "Task implementation round 1\n",
    });
    const firstReview = await publishTaskReview({ repository, manager, specId });
    assert.notEqual(firstReview.ok, false, JSON.stringify(firstReview));
    assert.equal(manager.canonicalState(specId).current.at(-1), "T-1-gate");

    const firstRound = exhaustCurrentGateRound(1);
    assert.equal(firstRound.disposition.operation, "repair");
    const repaired = new RunRepairPlanGateCommand().execute(context());
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.equal(manager.canonicalState(specId).current.at(-1), "T-1-impl");

    confirmTaskImplementationMutation({
      repository,
      manager,
      specId,
      requirementId: "R-T-1",
      content: "Task implementation round 2\n",
    });
    const roundTwoImplementationState = manager.canonicalState(specId);
    const interleavedFrontier = roundTwoImplementationState.toJSON();
    const firstTask = interleavedFrontier.steps
      .flatMap((branch) => branch.steps)
      .find((node) => node.id === "T-1");
    const firstTaskReview = firstTask.steps.find((node) => node.id === "T-1-review");
    firstTaskReview.status = "pending";
    firstTaskReview.attemptSequence = 0;
    assert.throws(
      () => new CurrentFlowState(interleavedFrontier, { definition: roundTwoImplementationState.definition }),
      /execution frontier/,
      "Task Gate repair must not admit an invalidated/pending/invalidated Task frontier",
    );
    const implementations = manager.taskMutationLineages({ specId, taskId: "T-1" })
      .filter((lineage) => lineage.role === "implementation");
    assert.deepEqual(implementations.map((lineage) => lineage.budget.round), [1, 2]);
    assert.deepEqual(implementations[1].budget.toJSON(), {
      round: 2,
      reviewAttemptSequenceAtStart: 1,
      gateAttemptSequenceAtStart: 5,
    });
    if (repairedReviewStages) {
      const recurringFinding = canonicalTaskReviewFinding({
        findingKey: "round-two-recurring-finding",
        title: "Round-two behavior remains incomplete",
        failureMode: "spec_behavior_contradiction",
        file: "README.md",
        requirementId: "R-T-1",
        guardrailId: null,
        issue: "The Task still lacks the round-two behavior.",
        suggestion: "Apply the exact round-two repair.",
        disposition: "must-fix",
        rationale: "R-T-1 requires the completed behavior.",
      });
      for (let ordinal = 1; ordinal <= 4; ordinal += 1) {
        const rejectedReview = await publishTaskReview({
          repository,
          manager,
          specId,
          blockingFindings: [recurringFinding],
        });
        assert.notEqual(rejectedReview.ok, false, JSON.stringify(rejectedReview));
        const triage = createTaskStageHandoff({
          root: repository, manager, specId, taskId: "T-1", role: "triage",
        });
        completeTaskStageHandoff(triage, {
          version: 1,
          stepId: "task-triage",
          completionStatus: "done",
          issues: [],
          overview: null,
          triage: {
            version: 1,
            dispositions: [{
              findingKey: recurringFinding.findingKey,
              disposition: "apply",
              basis: "repair-required",
              rationale: "The current Task source still requires this exact correction.",
            }],
          },
          repair: null,
          noChangeReason: null,
        });
        const repair = createTaskStageHandoff({
          root: repository, manager, specId, taskId: "T-1", role: "repair",
        });
        const recurrence = repair.request.inputs
          .find((input) => input.name === "task-review-recurrence.json").document;
        fs.appendFileSync(path.join(repository, "README.md"), `Task Review repair ${ordinal}\n`);
        completeTaskStageHandoff(repair, {
          version: 1,
          stepId: "task-repair",
          completionStatus: "done",
          issues: [],
          overview: null,
          triage: null,
          repair: {
            version: 1,
            findings: [{ findingKey: recurringFinding.findingKey, paths: ["README.md"] }],
            summary: "Applied the exact round-two Task Review correction.",
            recurrenceResolutions: recurrence.entries.map(({ findingKey, fingerprint }) => ({
              findingKey,
              fingerprint,
              priorRepairInsufficiency: "The prior change did not fully cover the exact recurring behavior.",
              repairStrategy: "Extend the same Task source path with the missing round-two behavior.",
            })),
          },
          noChangeReason: null,
        });
      }
    } else {
      const secondReview = await publishTaskReview({ repository, manager, specId });
      assert.notEqual(secondReview.ok, false, JSON.stringify(secondReview));
    }
    assert.equal(manager.canonicalState(specId).current.at(-1), "T-1-gate");
    assert.deepEqual(
      ["triage", "repair"].map((role) => manager.canonicalState(specId).findNode(`T-1-${role}`).status),
      [repairedReviewStages ? "done" : "skipped", repairedReviewStages ? "done" : "skipped"],
    );
    const roundTwoSource = fs.readFileSync(path.join(repository, "README.md"));

    const secondRoundFirstFailure = exhaustCurrentGateRound(2, { stopAfter: 1 });
    assert.equal(secondRoundFirstFailure.disposition.operation, "retry");
    assert.deepEqual(secondRoundFirstFailure.facts.retry.toJSON(), { used: 0, maximum: 4, remaining: 4 });

    // Reproduce the historic bug exactly: gate:post has already published a
    // receipt for the first failed second-round Gate while retry remains, then the old route opens a
    // third implementation Attempt through plan_gate_repair.  This bypasses
    // the manager admission deliberately; production admission now prevents
    // it, while recovery must still repair durable old state.
    const staleGateState = manager.canonicalState(specId);
    const staleIssueLog = JSON.parse(manager.readArtifact({
      specId, logicalKey: "issue.log", consumerNodeId: "T-1-impl",
    }).bytes.toString("utf8"));
    const staleRepairEvidence = inspectCanonicalPlanGateRepair({ flowManager: manager, state: staleGateState });
    assert.notEqual(staleRepairEvidence, null);
    const staleRepairRecord = staleRepairEvidence.createRecord(staleGateState);
    const staleImpl = staleGateState.findNode("T-1-impl");
    const staleAttempt = new CurrentAttempt({
      id: "attempt-t-1-impl-stale-round-three",
      nodeId: "T-1-impl",
      sequence: staleImpl.attemptSequence + 1,
      startedAt: "2026-09-04T00:00:00.000Z",
      consumption: { semantic: 0, tooling: 0 },
      failure: null,
      blocker: null,
      incomplete: [],
      operationClaims: [{
        operation: "resolve-command-context",
        resources: staleGateState.definition.contractForNode(staleImpl).resourceContract.required,
      }],
    });
    // CanonicalFlowRuntime is the persisted Version-store API that produced
    // the legacy state; the FlowManager facade deliberately has no bypass
    // around Definition admission.
    const legacyRuntime = new CanonicalFlowManagerStore({ root: repository, mainRoot: repository }).runtime;
    legacyRuntime.planGateRepair({
      specId,
      activityId: "task-round-overrun-plan-gate-repair",
      nodeId: "T-1-impl",
      attempt: staleAttempt,
      references: { evaluations: [], findings: [], repairs: [staleRepairRecord.activityReference()], artifacts: [] },
      artifactWrites: [{
        logicalKey: "issue.log",
        mediaType: "application/json",
        bytes: Buffer.from(`${JSON.stringify(staleRepairRecord.appendToIssueLog(staleIssueLog), null, 2)}\n`, "utf8"),
      }],
      gateTaskLifecycle: {
        operation: "repair-task-impl",
        taskId: "T-1",
        successorStepId: "T-1-impl",
        resetStepIds: ["T-1-impl", "T-1-review", "T-1-triage", "T-1-repair", "T-1-gate"],
      },
    });
    // gate:post flushes the stale implementation worker's Task-scoped agent
    // metric after the repair Activity. This exact observation must not make
    // an otherwise untouched stale frontier unrecoverable.
    manager.accumulateAgentMetrics("T-1-impl", {
      specId, taskId: "T-1", provider: "test", profileKey: "default",
      responseChars: 0, durationMs: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    });
    assert.equal(manager.canonicalState(specId).current.at(-1), "T-1-impl");
    assert.equal(manager.taskMutationLineages({ specId, taskId: "T-1" })
      .filter((lineage) => lineage.role === "implementation").length, 2);
    const beforeAttemptThreeHandoff = {
      state: manager.canonicalState(specId).toJSON(), activities: manager.activityLedger(specId),
    };
    assert.throws(() => manager.confirmSourceWorkerHandoff({
      specId,
      mutationManifest: emptySourceMutationManifest(manager, specId),
      handoffDigest: "d".repeat(64),
      effect: new SourceWorkerEffect({
        version: 1, stepId: "task-impl", completionStatus: "done", files: [], issues: [],
        overview: { modules: [], data_flow: [], decisions: [] }, triage: null, repair: null,
        noChangeReason: "The stale Attempt is not an admitted Task execution round.",
      }),
      result: {
        outcome: "passed", summary: "must not accept stale Task Attempt", confirmedAt: "2026-09-04T00:00:00.000Z", artifactRefs: [],
      },
    }), /round|budget|Task execution/);
    assert.deepEqual(manager.canonicalState(specId).toJSON(), beforeAttemptThreeHandoff.state);
    assert.deepEqual(manager.activityLedger(specId), beforeAttemptThreeHandoff.activities);
    const staleBeforeSourceEdit = {
      state: manager.canonicalState(specId).toJSON(), activities: manager.activityLedger(specId),
    };
    fs.writeFileSync(path.join(repository, "README.md"), "unconfirmed change after the round-two Gate\n");
    const sourceChangedDirective = await new GetNextActionCommand().execute(context());
    assert.notEqual(sourceChangedDirective.directive?.actionId, "RECOVER_TASK_EXECUTION_OVERRUN");
    const sourceChangedRecovery = new RunRecoverTaskExecutionOverrunCommand().execute(context());
    assert.equal(sourceChangedRecovery.ok, false);
    assert.deepEqual(manager.canonicalState(specId).toJSON(), staleBeforeSourceEdit.state);
    assert.deepEqual(manager.activityLedger(specId), staleBeforeSourceEdit.activities);
    fs.writeFileSync(path.join(repository, "README.md"), roundTwoSource);
    fs.writeFileSync(path.join(repository, "unconfirmed-attempt-three.js"), "export default true;\n");
    const untrackedSourceDirective = await new GetNextActionCommand().execute(context());
    assert.notEqual(untrackedSourceDirective.directive?.actionId, "RECOVER_TASK_EXECUTION_OVERRUN");
    const untrackedSourceRecovery = new RunRecoverTaskExecutionOverrunCommand().execute(context());
    assert.equal(untrackedSourceRecovery.ok, false);
    assert.deepEqual(manager.canonicalState(specId).toJSON(), staleBeforeSourceEdit.state);
    assert.deepEqual(manager.activityLedger(specId), staleBeforeSourceEdit.activities);
    fs.unlinkSync(path.join(repository, "unconfirmed-attempt-three.js"));
    const selectedOverrunDecision = resolveTaskExecutionOverrun(readTaskExecutionOverrunFacts({
      flowManager: manager, specId,
    }));
    assert.notEqual(selectedOverrunDecision, null);
    const malformedOverrunFacts = (changeActivities) => manager.readCanonicalTransitionView({
      specId,
      read: (view) => readTaskExecutionOverrunFactsFromView({
        root: repository,
        view: {
          state: view.state, revision: view.revision, catalog: view.catalog,
          activities: changeActivities(view.activities),
          readCatalogedArtifact: view.readCatalogedArtifact,
        },
      }),
    });
    assert.equal(malformedOverrunFacts((activities) => activities.map((activity) => (
      activity.transition.operation !== "plan_gate_repair"
        ? activity
        : { ...activity, references: { ...activity.references, repairs: [] } }
    ))), null, "a repair Activity without its sealed record reference is not recoverable");
    assert.equal(malformedOverrunFacts((activities) => activities.map((activity) => (
      activity.transition.operation !== "fail_attempt" || activity.nodeId !== "T-1-gate"
        ? activity
        : { ...activity, failure: { ...activity.failure, code: "MISMATCHED_GATE_FAILURE" } }
    ))), null, "a Gate result without its matching failure Activity is not recoverable");
    assert.equal(malformedOverrunFacts((activities) => {
      const repairOrder = activities.find((activity) => activity.transition.operation === "plan_gate_repair").confirmationOrder;
      return activities.map((activity) => (
        activity.transition.operation !== "record_metric" || activity.nodeId !== "T-1" || activity.confirmationOrder <= repairOrder
          ? activity
          : { ...activity, metric: { ...activity.metric, phase: "task-impl" } }
      ));
    }), null, "only the stale Task implementation agent metric may follow plan_gate_repair");
    const recoveryDirective = await new GetNextActionCommand().execute(context());
    assert.equal(recoveryDirective.directive.actionId, "RECOVER_TASK_EXECUTION_OVERRUN");
    const recovered = new RunRecoverTaskExecutionOverrunCommand().execute(context());
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    const restored = manager.canonicalState(specId);
    assert.equal(restored.current.at(-1), "T-1-gate");
    assert.equal(restored.attempt.failure.category, "semantic");
    for (const role of ["impl", "review", "triage", "repair"]) {
      const stepId = `T-1-${role}`;
      assert.equal(restored.findNode(stepId).status, staleGateState.findNode(stepId).status);
      assert.deepEqual(restored.findNode(stepId).result.toJSON(), staleGateState.findNode(stepId).result.toJSON());
    }
    assert.equal(restored.findNode("T-1-impl").attemptSequence, staleAttempt.sequence);
    assert.equal(restored.findNode("T-1-gate").status, "in_progress");
    assert.equal(manager.activityLedger(specId).at(-1).transition.operation, "recover_task_execution_overrun");
    assert.equal(manager.taskMutationLineages({ specId, taskId: "T-1" })
      .filter((lineage) => lineage.role === "implementation").length, 2);
    const afterRecovery = {
      state: manager.canonicalState(specId).toJSON(), activities: manager.activityLedger(specId),
    };
    assert.throws(
      () => manager.recoverTaskExecutionOverrun({ specId, decision: selectedOverrunDecision }),
      /stale|Definition-selected/,
    );
    assert.deepEqual(manager.canonicalState(specId).toJSON(), afterRecovery.state);
    assert.deepEqual(manager.activityLedger(specId), afterRecovery.activities);
    const reloaded = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    assert.equal(reloaded.canonicalState(specId).current.at(-1), "T-1-gate");
    assert.equal((await new GetNextActionCommand().execute({ ...context(), flowManager: reloaded, flowState: reloaded.load(specId) })).directive.actionId, "CLAIM_GATE_RETRY");
    const recoveredReplay = new RunRecoverTaskExecutionOverrunCommand().execute({
      ...context(), flowManager: reloaded, flowState: reloaded.load(specId),
    });
    assert.equal(recoveredReplay.ok, true, JSON.stringify(recoveredReplay));
    assert.equal(recoveredReplay.data.replayed, true);
    assert.equal(reloaded.activityLedger(specId).at(-1).transition.operation, "recover_task_execution_overrun");

    const retryAfterRecovery = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
    }));
    assert.equal(retryAfterRecovery.disposition.operation, "retry");
    manager.retryGateTransition({ specId, decision: retryAfterRecovery });
    const secondRound = exhaustCurrentGateRound(2, { startAt: 2 });
    assert.equal(secondRound.disposition.operation, "defer");
    assert.deepEqual(secondRound.facts.retry.toJSON(), { used: 4, maximum: 4, remaining: 0 });
    assert.deepEqual(secondRound.plan.taskLifecycle.toJSON(), {
      operation: "defer-and-advance",
      taskId: "T-1",
      successorStepId: "T-2-impl",
      resetStepIds: [],
    });

    const settled = new RunSettleGateTransitionCommand().execute(context());
    assert.equal(settled.ok, true, JSON.stringify(settled));
    const state = manager.canonicalState(specId);
    assert.equal(state.findNode("T-1").status, "done");
    assert.equal(state.findNode("T-2").status, "pending");
    assert.equal(state.nextAction().nodeId, "T-2-impl");
    const findings = JSON.parse(manager.readArtifact({
      specId,
      logicalKey: "flow.findings",
      consumerNodeId: "acceptance-review",
    }).bytes.toString("utf8"));
    assert.equal(findings.entries.length, 1);
    assert.equal(findings.entries[0].sourceStep, "T-1-gate");
    assert.equal(findings.entries[0].attempts, 5);
    assert.equal(findings.entries[0].round, 2);
    const next = await new GetNextActionCommand().execute(context());
    assert.equal(next.step, "task-impl");
    assert.equal(next.taskId, "T-2");
    });
  }

  it("rehydrates a classified Task Gate with unfinished settlement without starting evaluation", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    new TaskLifecycleFixture({
      flowManager: manager,
      specId: "001-task-gate-direct-admission",
      runId: "run-task-gate-direct-admission",
      request: "Keep direct Task Gate admission side-effect free.",
      taskDocuments: [
        { id: "T-1", title: "only", goal: "remain active", parent: null, origin: "plan", added_round: 0, status: "pending" },
      ],
      taskId: "T-1",
      targetStep: "task-gate",
    }).create();
    const specId = "001-task-gate-direct-admission";
    const commandResult = new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1",
    }).promote({
      result: "fail",
      artifacts: {
        failureKind: "ai_semantic_fail",
        failureCode: "TASK_GATE_REJECTED",
        sourceFingerprint: currentTaskSourceFingerprint(manager, specId),
        nextAction: { diagnosis: { observations: [{
          kind: "violation", failureMode: "guardrail-violation", requirementRef: "R-1",
          where: { file: "src/task.js", locator: "T-1" }, observed: "Definition must own the retry.",
          severity: "blocking", refs: ["R-1"],
        }] } },
      },
    });
    manager.failCurrentAttempt({
      specId,
      failure: {
        category: "semantic", code: "TASK_GATE_REJECTED", message: "Task Gate rejected the current Attempt.",
        retryable: true, retryKind: "semantic",
      },
      commandResult,
    });
    const decision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
    }));
    assert.equal(decision.disposition.operation, "retry");

    let agentCalls = 0;
    container.register("agent", {
      resolve: () => { agentCalls += 1; throw new Error("Task Gate evaluator must not start"); },
      call: async () => { agentCalls += 1; throw new Error("Task Gate worker must not start"); },
    });
    const location = manager.specLocation(specId);
    const snapshotFiles = () => fs.readdirSync(location.directory, { recursive: true })
      .filter((relative) => fs.statSync(path.join(location.directory, relative)).isFile())
      .sort()
      .map((relative) => [relative, fs.readFileSync(path.join(location.directory, relative)).toString("base64")]);
    const beforeState = manager.canonicalState(specId).toJSON();
    const beforeActivities = manager.activityLedger(specId);
    const beforeCatalog = manager.artifactCatalog(specId).toJSON();
    const beforeFiles = snapshotFiles();

    const recovered = await new RunGateCommand().execute({
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId,
      phase: "task-impl",
      config: {},
      flowManager: manager,
      flowState: manager.load(specId),
    });
    assert.equal(recovered.result, "fail");

    assert.equal(agentCalls, 0);
    assert.deepEqual(manager.canonicalState(specId).toJSON(), beforeState);
    assert.deepEqual(manager.activityLedger(specId), beforeActivities);
    assert.deepEqual(manager.artifactCatalog(specId).toJSON(), beforeCatalog);
    assert.deepEqual(snapshotFiles(), beforeFiles);
  });

  it("rejects invalid direct Task Review and Gate contexts without worker or Store side effects", async () => {
    for (const targetStep of ["task-review", "task-gate"]) {
      const repository = root();
      initializeReviewSource(repository);
      const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
      const specId = `001-invalid-task-context-${targetStep}`;
      new TaskLifecycleFixture({
        flowManager: manager,
        specId,
        runId: `run-invalid-task-context-${targetStep}`,
        request: "reject invalid Task context before execution",
        specRecord: {
          requirements: [{ id: "R-1", desc: "Require one canonical Task mapping.", task_ids: ["T-1"] }],
          overview: { modules: [], data_flow: [], decisions: [] },
        },
        taskDocuments: [{ id: "T-1", title: "Invalid context", goal: "Reject malformed mapping.", parent: null, origin: "plan", added_round: 0, status: "pending" }],
        taskId: "T-1",
        targetStep,
      }).create();
      const facade = invalidTaskContextFacade(manager);
      const before = {
        state: manager.canonicalState(specId).toJSON(),
        activities: manager.activityLedger(specId),
        catalog: manager.artifactCatalog(specId).toJSON(),
      };
      let workerCalls = 0;
      const ctx = {
        root: repository,
        mainRoot: repository,
        executionRoot: repository,
        specId,
        phase: targetStep === "task-gate" ? "task-impl" : undefined,
        config: {},
        flowManager: facade,
        flowState: manager.load(specId),
      };
      const result = targetStep === "task-review"
        ? await new RunReviewCommand({
          runCommand() { workerCalls += 1; throw new Error("invalid Task Review context must not start a worker"); },
        }).execute(ctx)
        : await new RunGateCommand().execute(ctx);
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.errors[0].code, "TASK_CONTEXT_INVALID");
      assert.equal(workerCalls, 0);
      assert.deepEqual(manager.canonicalState(specId).toJSON(), before.state);
      assert.deepEqual(manager.activityLedger(specId), before.activities);
      assert.deepEqual(manager.artifactCatalog(specId).toJSON(), before.catalog);
    }
  });

  it("keeps a tooling-failed Task Gate active without consuming semantic retry or completing its Task", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    new TaskLifecycleFixture({
      flowManager: manager,
      specId: "001-task-gate-tooling-block",
      runId: "run-task-gate-tooling-block",
      request: "Do not turn transport trouble into Task progress.",
      taskDocuments: [
        { id: "T-1", title: "only", goal: "remain active", parent: null, origin: "plan", added_round: 0, status: "pending" },
      ],
      taskId: "T-1",
      targetStep: "task-gate",
    }).create();
    const specId = "001-task-gate-tooling-block";
    const commandResult = new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1",
    }).promote({
      result: "fail",
      artifacts: {
        failureKind: "provider_failure", failureCode: "GATE_TRANSPORT_FAILURE",
        sourceFingerprint: currentTaskSourceFingerprint(manager, specId),
      },
    });
    manager.failCurrentAttempt({
      specId,
      failure: { category: "tooling", code: "GATE_TRANSPORT_FAILURE", message: "tool transport failed", retryable: false, retryKind: null },
      commandResult,
    });
    const state = manager.canonicalState(specId);
    const facts = readCurrentGateTransitionFacts({ flowManager: manager, flowState: manager.load(specId), phase: "task-impl" });
    assert.equal(resolveGateTransition(facts).disposition.operation, "external-blocked");
    assert.equal(state.attempt.consumption.semantic, 0);
    assert.equal(state.findNode("T-1-gate").status, "in_progress");
    assert.equal(state.findNode("T-1").status, "in_progress");
  });

  it("rejects malformed Task Gate result and source bindings before selecting a transition", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const fixture = (specId, runId) => new TaskLifecycleFixture({
      flowManager: manager, specId, runId, request: "Reject forged Task Gate evidence.",
      taskDocuments: [{ id: "T-1", title: "only", goal: "remain active", parent: null, origin: "plan", added_round: 0, status: "pending" }],
      taskId: "T-1", targetStep: "task-gate",
    }).create();
    fixture("001-task-gate-malformed-source", "run-task-gate-malformed-source");
    const sourceSpecId = "001-task-gate-malformed-source";
    const sourceAttempt = manager.canonicalState(sourceSpecId).attempt;
    const sourceResult = {
      result: "fail",
      artifacts: {
        phase: "task-impl", taskId: "T-1", failureKind: "ai_semantic_fail", failureCode: "TASK_GATE_REJECTED",
        sourceFingerprint: currentTaskSourceFingerprint(manager, sourceSpecId),
        gateTransitionFailureCategory: { category: "semantic", code: "TASK_GATE_REJECTED" },
        gateTransitionAttemptId: sourceAttempt.id, gateTransitionAttemptSequence: sourceAttempt.sequence,
        gateTransitionLineage: canonicalGateRevision(manager.canonicalState(sourceSpecId), "T-1-gate"),
      },
    };
    attachCanonicalCommandResultArtifact(sourceResult, { logicalKey: "task.gate", payload: sourceResult });
    attachCanonicalCommandResultPublications(sourceResult, [new CanonicalCommandResultPublication({
      logicalKey: "task.gate.source", parameters: { taskId: "T-1" },
      payload: {
        version: 1, phase: "task-impl", taskId: "T-1", result: "fail",
        failureCategory: { category: "semantic", code: "TASK_GATE_REJECTED" }, lineage: "b".repeat(64),
      },
    })]);
    manager.failCurrentAttempt({
      specId: sourceSpecId,
      failure: { category: "semantic", code: "TASK_GATE_REJECTED", message: "fixture", retryable: true, retryKind: "semantic" },
      commandResult: sourceResult,
    });
    const sourceBeforeRead = {
      state: manager.canonicalState(sourceSpecId).toJSON(), activities: manager.activityLedger(sourceSpecId),
      catalog: manager.artifactCatalog(sourceSpecId).toJSON(),
    };
    assert.throws(() => readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(sourceSpecId), phase: "task-impl",
    }), /source and canonical result lineage binding is unavailable or mismatched/);
    assert.deepEqual(manager.canonicalState(sourceSpecId).toJSON(), sourceBeforeRead.state);
    assert.deepEqual(manager.activityLedger(sourceSpecId), sourceBeforeRead.activities);
    assert.deepEqual(manager.artifactCatalog(sourceSpecId).toJSON(), sourceBeforeRead.catalog);

    const rejectPassBinding = (specId, runId, patch, pattern) => {
      fixture(specId, runId);
      const attempt = manager.canonicalState(specId).attempt;
      const forgedPass = {
        result: "pass",
        artifacts: {
          phase: "task-impl", taskId: "T-1", gateTransitionAttemptId: attempt.id,
          gateTransitionAttemptSequence: attempt.sequence,
          gateTransitionLineage: canonicalGateRevision(manager.canonicalState(specId), "T-1-gate"),
          sourceFingerprint: currentTaskSourceFingerprint(manager, specId),
          ...patch,
        },
      };
      attachCanonicalCommandResultArtifact(forgedPass, { logicalKey: "task.gate", payload: forgedPass });
      manager.publishCurrentAttemptResult({ specId, commandResult: forgedPass });
      const beforeRead = {
        state: manager.canonicalState(specId).toJSON(), activities: manager.activityLedger(specId),
        catalog: manager.artifactCatalog(specId).toJSON(),
      };
      assert.throws(() => readCurrentGateTransitionFacts({
        flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
      }), pattern);
      assert.deepEqual(manager.canonicalState(specId).toJSON(), beforeRead.state);
      assert.deepEqual(manager.activityLedger(specId), beforeRead.activities);
      assert.deepEqual(manager.artifactCatalog(specId).toJSON(), beforeRead.catalog);
    };
    rejectPassBinding("001-task-gate-wrong-task", "run-task-gate-wrong-task", { taskId: "T-2" }, /Task binding/);
    rejectPassBinding("001-task-gate-wrong-attempt", "run-task-gate-wrong-attempt", { gateTransitionAttemptId: "attempt-forged" }, /Attempt binding/);
    rejectPassBinding("001-task-gate-forged-pass", "run-task-gate-forged-pass", {
      gateTransitionLineage: "c".repeat(64),
    }, /result lineage binding is invalid/);
  });

  it("repairs a Task Gate only from its current receipt and sealed lifecycle plan", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    new TaskLifecycleFixture({
      flowManager: manager,
      specId: "001-task-gate-repair-current",
      runId: "run-task-gate-repair-current",
      request: "Repair only the current Task Gate evidence.",
      specRecord: {
        requirements: [
          { id: "R-1", desc: "Repair the current Task implementation.", task_ids: ["T-1"] },
          { id: "R-2", desc: "Keep the next Task independently mapped.", task_ids: ["T-2"] },
        ],
        overview: { modules: [], data_flow: [], decisions: [] },
      },
      taskDocuments: [
        { id: "T-1", title: "first", goal: "repair first", parent: null, origin: "plan", added_round: 0, status: "pending" },
        { id: "T-2", title: "second", goal: "do not repair", parent: null, origin: "plan", added_round: 0, status: "pending" },
      ],
      taskId: "T-1",
      targetStep: "task-gate",
    }).create();
    const specId = "001-task-gate-repair-current";
    const result = {
      result: "fail",
      artifacts: {
        phase: "task-impl", taskId: "T-1",
        failureKind: "ai_semantic_fail", failureCode: "TASK_GATE_REJECTED",
        sourceFingerprint: currentTaskSourceFingerprint(manager, specId),
        nextAction: { diagnosis: { observations: [{
          kind: "violation", failureMode: "guardrail-violation", requirementRef: "R-1",
          where: { file: "src/task.js", locator: "T-1" }, observed: "Repair the current Task implementation.",
          severity: "blocking", refs: ["R-1"],
        }] } },
      },
    };
    new CanonicalGatePromotion({
      state: manager.canonicalState(specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1",
    }).promote(result);
    manager.failCurrentAttempt({
      specId,
      failure: { category: "semantic", code: "TASK_GATE_REJECTED", message: "repair current task", retryable: true, retryKind: "semantic" },
      commandResult: result,
    });
    const currentAttempt = manager.canonicalState(specId).attempt;
    for (const [idempotencyKey, entry] of [
      ["different-task-receipt", {
        step: "T-2-gate", taskId: "T-2", phase: "task-impl", trigger: "gate post hook (auto)",
        observations: result.artifacts.nextAction.diagnosis.observations,
        gateReceipt: { attempt: { id: "old-T-2", sequence: 1 }, catalogFingerprint: "c".repeat(64), lineage: { canonicalRevisionFingerprint: "c".repeat(64) } },
      }],
      ["old-task-attempt-receipt", {
        step: "T-1-gate", taskId: "T-1", phase: "task-impl", trigger: "gate post hook (auto)",
        observations: result.artifacts.nextAction.diagnosis.observations,
        gateReceipt: { attempt: { id: "old-T-1", sequence: 1 }, catalogFingerprint: "d".repeat(64), lineage: { canonicalRevisionFingerprint: "d".repeat(64) } },
      }],
      ["current-task-wrong-lineage-receipt", {
        step: "T-1-gate", taskId: "T-1", phase: "task-impl", trigger: "gate post hook (auto)",
        observations: result.artifacts.nextAction.diagnosis.observations,
        gateReceipt: {
          attempt: { id: currentAttempt.id, sequence: currentAttempt.sequence }, catalogFingerprint: "e".repeat(64),
          lineage: { canonicalRevisionFingerprint: "f".repeat(64) },
        },
      }],
      ["current-task-wrong-catalog-receipt", {
        step: "T-1-gate", taskId: "T-1", phase: "task-impl", trigger: "gate post hook (auto)",
        observations: result.artifacts.nextAction.diagnosis.observations,
        gateReceipt: {
          attempt: { id: currentAttempt.id, sequence: currentAttempt.sequence }, catalogFingerprint: "a".repeat(64),
          lineage: { canonicalRevisionFingerprint: result.artifacts.gateTransitionLineage },
        },
      }],
    ]) manager.appendIssueLog({ specId, entry, idempotencyKey });
    const beforeReceiptRepair = {
      state: manager.canonicalState(specId).toJSON(),
      activities: manager.activityLedger(specId),
    };
    const staleReceiptFacts = readCurrentGateTransitionFacts({ flowManager: manager, flowState: manager.load(specId), phase: "task-impl" });
    assert.equal(resolveGateTransition(staleReceiptFacts).disposition.operation, "retry");
    assert.deepEqual(manager.canonicalState(specId).toJSON(), beforeReceiptRepair.state);
    assert.deepEqual(manager.activityLedger(specId), beforeReceiptRepair.activities);
    let decision = resolveGateTransition(staleReceiptFacts);
    manager.recordTaskGateSettlementMetric({ specId, decision });
    decision = resolveGateTransition(readCurrentGateTransitionFacts({
      flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
    }));
    appendIssueLogFromGateResult({
      root: repository, mainRoot: repository, executionRoot: repository,
      specId, flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
      gateTransitionDecision: decision,
      gitState: { headSha: "a".repeat(40), worktreeHash: "b".repeat(64) },
    }, result);
    let facts = readCurrentGateTransitionFacts({ flowManager: manager, flowState: manager.load(specId), phase: "task-impl" });
    decision = resolveGateTransition(facts);
    assert.equal(decision.disposition.operation, "retry");
    // A valid receipt is generated after every Task Gate evaluation. It must
    // not turn the first failure into an implementation repair; repair is
    // admitted only after the Definition-owned semantic retry budget.
    for (let retry = 1; retry <= 4; retry += 1) {
      manager.retryGateTransition({ specId, decision });
      const retryResult = new CanonicalGatePromotion({
        state: manager.canonicalState(specId), phase: "task-impl", nodeId: "T-1-gate", activeTaskId: "T-1",
      }).promote({
        result: "fail",
        artifacts: {
          phase: "task-impl", taskId: "T-1",
          failureKind: "ai_semantic_fail", failureCode: "TASK_GATE_REJECTED",
          sourceFingerprint: currentTaskSourceFingerprint(manager, specId),
          nextAction: { diagnosis: { observations: result.artifacts.nextAction.diagnosis.observations } },
        },
      });
      manager.failCurrentAttempt({
        specId,
        failure: {
          category: "semantic", code: "TASK_GATE_REJECTED", message: "repair current task",
          retryable: retry < 4, retryKind: retry < 4 ? "semantic" : null,
        },
        commandResult: retryResult,
      });
      decision = resolveGateTransition(readCurrentGateTransitionFacts({
        flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
      }));
      if (decision.plan.retryMetric !== null) {
        manager.recordTaskGateSettlementMetric({ specId, decision });
      }
      decision = resolveGateTransition(readCurrentGateTransitionFacts({
        flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
      }));
      appendIssueLogFromGateResult({
        root: repository, mainRoot: repository, executionRoot: repository,
        specId, flowManager: manager, flowState: manager.load(specId), phase: "task-impl",
        gateTransitionDecision: decision,
        gitState: { headSha: "a".repeat(40), worktreeHash: "b".repeat(64) },
      }, retryResult);
      facts = readCurrentGateTransitionFacts({ flowManager: manager, flowState: manager.load(specId), phase: "task-impl" });
      decision = resolveGateTransition(facts);
      assert.equal(decision.disposition.operation, retry < 4 ? "retry" : "repair");
    }
    const reloadedManager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const reloadedFacts = readCurrentGateTransitionFacts({
      flowManager: reloadedManager, flowState: reloadedManager.load(specId), phase: "task-impl",
    });
    assert.deepEqual(resolveGateTransition(reloadedFacts).toJSON(), decision.toJSON());
    const outcome = new RunRepairPlanGateCommand().execute({
      root: repository, mainRoot: repository, executionRoot: repository,
      specId, flowManager: manager, flowState: manager.load(specId),
    });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    const repaired = manager.canonicalState(specId);
    assert.equal(repaired.current.at(-1), "T-1-impl");
    assert.equal(repaired.findNode("T-1-impl").status, "in_progress");
    assert.equal(repaired.findNode("T-1-review").status, "invalidated");
    assert.equal(repaired.findNode("T-1-gate").status, "invalidated");
    assert.equal(repaired.findNode("T-2-impl").status, "pending");
    assert.equal(manager.activityLedger(specId).at(-1).transition.gateTaskLifecycle.operation, "repair-task-impl");

    const context = {
      root: repository, mainRoot: repository, executionRoot: repository,
      specId, flowManager: manager, flowState: manager.load(specId),
    };
    const workerAction = await new GetNextActionCommand().execute(context);
    assert.equal(workerAction.step, "task-impl");
    assert.equal(workerAction.taskId, "T-1");
    assert.equal(workerAction.context.planGateRepair.targetStepId, "T-1-impl");

    const handoff = new WorkerArtifactHandoffCoordinator().createRequest({
      ctx: context,
      state: manager.load(specId),
      invocation: {
        id: "task-gate-repair-worker",
        target: { digest: "b".repeat(64) },
        action: {
          digest: "a".repeat(64),
          nextAction: { step: "task-impl", taskId: "T-1" },
        },
      },
    });
    assert.equal(handoff.contextSnapshot.kind, "task");
    assert.deepEqual(
      handoff.contextSnapshot.context.requirements.map((requirement) => requirement.id),
      ["R-1"],
    );
    const canonicalRepair = canonicalPlanGateRepairForTarget({
      flowManager: manager,
      state: manager.load(specId),
      targetStepId: "T-1-impl",
    });
    const expectedRevision = new WorkerArtifactSemanticInputRevision({
      inputDigest: handoff.inputDigest,
      flowIdentity: repaired.identity,
      attempt: repaired.attempt,
      planGateRepair: canonicalRepair,
    });
    assert.equal(handoff.inputRevision, expectedRevision.toString());
    assert.doesNotThrow(() => handoff.assertCurrent(manager.load(specId)));
  });

  it("settles only definition-owned record and rewind failure dispositions", async () => {
    const recordRoot = root();
    const recordManager = new FlowManager({ root: recordRoot, mainRoot: recordRoot, inWorktree: false });
    new FlowAtStepFixture({
      flowManager: recordManager,
      specId: "001-record-failure",
      runId: "run-record-failure",
      request: "Record an exhausted definition failure.",
      targetStep: "impl-review",
    }).create();
    // Spec review now has a revision-scoped confirmation ledger, so this
    // generic definition-settlement fixture uses the independent impl-review
    // attempt history rather than resurrecting retired spec.review history.
    recordManager.publishCurrentAttemptResult({
      specId: "001-record-failure",
      commandResult: attachCanonicalCommandResultArtifact({ result: "rejected" }, {
        logicalKey: "impl.review",
        payload: { verdict: "REJECTED", proposalCount: 1 },
      }),
    });
    recordManager.failCurrentAttempt({
      specId: "001-record-failure",
      failure: {
        category: "semantic",
        code: "REVIEW_REJECTED",
        message: "The review cannot be retried.",
        retryable: false,
        retryKind: null,
      },
    });
    const recordContext = {
      root: recordRoot,
      mainRoot: recordRoot,
      executionRoot: recordRoot,
      specId: "001-record-failure",
      flowManager: recordManager,
      flowState: recordManager.load("001-record-failure"),
    };
    const recordDirective = await new GetNextActionCommand().execute(recordContext);
    assert.equal(recordDirective.directive.actionId, "SETTLE_CANONICAL_FAILURE");
    assert.match(recordDirective.directive.nextAction, /sennel flow run settle-failure/);
    recordManager.settleCurrentFailure({ specId: "001-record-failure" });
    assert.equal(recordManager.canonicalState("001-record-failure").current, null);
    assert.equal(recordManager.activityLedger("001-record-failure").at(-1).transition.operation, "record_failure");

    const rewindRoot = root();
    const rewindManager = new FlowManager({ root: rewindRoot, mainRoot: rewindRoot, inWorktree: false });
    new FlowAtStepFixture({
      flowManager: rewindManager,
      specId: "001-rewind-failure",
      runId: "run-rewind-failure",
      request: "Rewind an acceptance execution failure.",
      targetStep: "acceptance-review",
    }).create();
    rewindManager.failCurrentAttempt({
      specId: "001-rewind-failure",
      failure: {
        category: "agent",
        code: "ACCEPTANCE_AGENT_FAILED",
        message: "The acceptance agent failed before producing a verdict.",
        retryable: false,
        retryKind: null,
      },
    });
    const rewindContext = {
      root: rewindRoot,
      mainRoot: rewindRoot,
      executionRoot: rewindRoot,
      specId: "001-rewind-failure",
      flowManager: rewindManager,
      flowState: rewindManager.load("001-rewind-failure"),
    };
    const rewindDirective = await new GetNextActionCommand().execute(rewindContext);
    assert.equal(rewindDirective.directive.actionId, "SETTLE_CANONICAL_FAILURE");
    const settled = new RunSettleFailureCommand().execute({
      ...rewindContext,
      targetStep: "impl-gate",
      result: { outcome: "passed" },
    });
    assert.equal(settled.ok, true, JSON.stringify(settled));
    assert.equal(settled.data.operation, "rewind");
    assert.equal(rewindManager.canonicalState("001-rewind-failure").current.at(-1), "spec");
    const transition = rewindManager.activityLedger("001-rewind-failure").at(-1);
    assert.equal(transition.transition.operation, "rewind");
    assert.equal(transition.transition.attempt.nodeId, "spec");
    assert.equal(FLOW_COMMANDS.run["settle-failure"].args.options.includes("--target"), false);
    assert.equal(FLOW_COMMANDS.run["settle-failure"].args.options.includes("--result"), false);
  });

  it("records a blocked V1 scenario gate in the catalog before its guarded test rewind", async () => {
    const repository = root();
    const specId = "001-canonical-scenario-plan-gate";
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request(specId, {
      specRecord: new CurrentFlowSpecRecord({ ...validWorkerHandoffSpec(), tasks: [] }, { specId }),
    }));
    manager.addActiveFlow(created.specId, "direct");
    advanceTo(manager, created.specId, "scenario-validity", {
      onActive(nodeId) {
        if (nodeId !== "test") return;
        manager.publishArtifacts({
          specId: created.specId,
          nodeId,
          artifactWrites: [{
            logicalKey: "tests.source",
            parameters: { testPath: "scenario.test.js" },
            mediaType: "text/javascript",
            bytes: Buffer.from([
              'import test from "node:test";',
              'test("R1: exposes an invalid scenario premise", () => {});',
              "",
            ].join("\n"), "utf8"),
          }],
        });
      },
    });
    const context = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
      flowState: manager.load(created.specId),
      config: {},
    };
    const scenario = new RunScenarioValidityCommand({
      scenarioTestExecutor: async ({ executions }) => executions.map((execution) => ({
        file: execution.file,
        requirementId: execution.requirementId,
        command: `node --test ${execution.file}`,
        process: {
          started: true,
          exitCode: 0,
          signal: null,
          timedOut: false,
          spawnError: null,
          stdout: "",
          stderr: "",
        },
      })),
    });

    const blocked = await scenario.execute(context);
    assert.equal(blocked.result, "block");
    await FLOW_COMMANDS.run["scenario-validity"].post(context, blocked);
    context.flowState = manager.load(created.specId);
    const issueLog = manager.readArtifact({
      specId: created.specId,
      logicalKey: "issue.log",
      consumerNodeId: "test",
    });
    const source = JSON.parse(issueLog.bytes.toString("utf8")).entries.at(-1);
    assert.equal(source.sourceArtifact, "scenario.validity");
    assert.match(source.testRevisionDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(source.observations.map((entry) => entry.refs), [["scenario.validity#summary.0"]]);
    const activities = manager.activityLedger(created.specId);
    const resultPublication = activities.find((activity) => (
      activity.transition.operation === "publish_artifacts"
      && activity.nodeId === "scenario-validity"
    ));
    const repairActivity = activities.find((activity) => (
      activity.transition.operation === "repair_scenario_validity"
    ));
    assert.equal(resultPublication.attemptId, repairActivity.attemptId);
    assert.equal(resultPublication.sequence, repairActivity.sequence);
    const repairAction = await new GetNextActionCommand().execute(context);
    assert.equal(repairAction.step, "test");
    assert.ok(repairAction.context.planGateRepair);
    const typed = manager.canonicalState(created.specId);

    assert.equal(typed.current.at(-1), "test");
    assert.equal(Object.hasOwn(typed.toJSON(), "planGateRepair"), false);
    assert.equal(activities.at(-1).transition.operation, "repair_scenario_validity");
  });

  it("recovers a committed V1 handoff cleanup from the Flow runtime directory", async () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const created = manager.createFresh(request());
    manager.addActiveFlow(created.specId, "direct");
    for (const stepId of ["branch", "prepare-spec"]) {
      manager.updateStepStatus({ stepId, requestedStatus: "in_progress" });
      confirmFixtureStep(manager, stepId);
    }
    await new GetNextActionCommand().execute({
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      flowManager: manager,
      flowState: manager.load(created.specId),
      specId: created.specId,
      flowCommandBoundary: false,
    });
    await new RunClaimNextActionCommand().execute({
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      flowManager: manager,
      flowState: manager.load(created.specId),
      specId: created.specId,
    });
    const context = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId: created.specId,
      flowManager: manager,
    };
    const coordinator = new WorkerArtifactHandoffCoordinator({
      faultInjector: ({ phase }) => {
        if (phase === "before-worker-handoff-cleanup-rename") throw new Error("crash before cleanup");
      },
    });
    const handoff = coordinator.createRequest({
      ctx: context,
      state: manager.load(created.specId),
      invocation: {
        id: "canonical-recovery",
        target: { digest: "d".repeat(64) },
        action: { digest: "c".repeat(64), nextAction: { step: "draft" } },
      },
    });
    fs.writeFileSync(handoff.payloadPath("draft.json"), canonicalDraftBytes("recover cleanup"));
    sealWorkerArtifactHandoff({ requestPath: handoff.requestPath, invocationId: "canonical-recovery" });
    assert.throws(
      () => coordinator.reconcile({ ctx: context, request: handoff }),
      /RECOVERY_REQUIRED|cleanup requires recovery/i,
    );
    assert.equal(manager.canonicalState(created.specId).findNode("draft").status, "done");
    assert.equal(fs.existsSync(handoff.directory), true);

    const recovered = new WorkerArtifactHandoffCoordinator().recoverPending({ ctx: context });
    assert.equal(recovered.completed, true);
    assert.equal(recovered.replayed, true);
    assert.equal(fs.existsSync(handoff.directory), false);
  });

  it("persists and reloads one Task source mutation lineage", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const specId = "001-task-lineage";
    new TaskLifecycleFixture({
      flowManager: manager,
      specId,
      runId: "run-task-lineage",
      request: "record task lineage",
      taskDocuments: [{ id: "T-1", title: "Record lineage", goal: "Persist lineage.", parent: null, origin: "plan", added_round: 0, status: "pending" }],
      taskId: "T-1",
      targetStep: "task-impl",
    }).create();
    const manifest = emptySourceMutationManifest(manager, specId);
    manager.confirmSourceWorkerHandoff({
      specId,
      mutationManifest: manifest,
      handoffDigest: "c".repeat(64),
      effect: new SourceWorkerEffect({
        version: 1,
        stepId: "task-impl",
        completionStatus: "done",
        files: [],
        issues: [],
        overview: { modules: [], data_flow: [], decisions: [] },
        triage: null,
        repair: null,
        noChangeReason: "The requested implementation is already present.",
      }),
      result: { outcome: "passed", summary: "No source change.", confirmedAt: "2026-09-01T00:00:00.000Z", artifactRefs: [] },
    });
    const before = manager.taskMutationLineages({ specId, taskId: "T-1" }).map((entry) => entry.toJSON());
    assert.equal(before.length, 1);
    assert.deepEqual(before[0].budget, { round: 1, reviewAttemptSequenceAtStart: 0, gateAttemptSequenceAtStart: 0 });
    const reloaded = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    assert.deepEqual(reloaded.taskMutationLineages({ specId, taskId: "T-1" }).map((entry) => entry.toJSON()), before);
  });

  it("permits only an append-only metric settlement in Task Review canonical metadata", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const specId = "001-task-review-canonical-observation";
    const created = manager.createFresh(request(specId));
    manager.addActiveFlow(created.specId, "direct");

    const metricBoundary = TaskReviewCanonicalObservationBoundary.capture({ flowManager: manager, specId });
    manager.appendMetric({ phase: "impl", counter: "taskReview", delta: 1 }, { specId, taskId: null });
    assert.doesNotThrow(() => metricBoundary.assertMetricSettlementOnly());

    const providerMutationBoundary = TaskReviewCanonicalObservationBoundary.capture({ flowManager: manager, specId });
    manager.addNote("a Task Review provider must not mutate canonical state", { specId });
    assert.throws(
      () => providerMutationBoundary.assertMetricSettlementOnly(),
      (error) => error.code === "FLOW_SOURCE_HANDOFF_CANONICAL_MUTATION_INVALID"
        && /record_metric Activities/.test(error.message),
    );
  });

  it("rejects stale projected Task Review scope before creating a worker", async () => {
    const repository = root();
    initializeReviewSource(repository);
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const specId = "001-task-review-stale-projection";
    new TaskLifecycleFixture({
      flowManager: manager,
      specId,
      runId: "run-task-review-stale-projection",
      request: "do not execute a stale Task Review",
      taskDocuments: [{ id: "T-1", title: "Stale scope", goal: "Reject stale scope.", parent: null, origin: "plan", added_round: 0, status: "pending" }],
      taskId: "T-1",
      targetStep: "task-review",
    }).create();
    let workerCalls = 0;
    const review = new RunReviewCommand({
      runCommand() {
        workerCalls += 1;
        throw new Error("stale projected scope must not start a Task Review worker");
      },
    });
    const projected = manager.load(specId);
    await assert.rejects(
      () => review.execute({
        root: repository,
        mainRoot: repository,
        executionRoot: repository,
        specId,
        flowManager: manager,
        flowState: { ...projected, currentTaskId: "T-2" },
        config: {},
      }),
      /canonical review requires active T-2-review, found T-1-review/,
    );
    assert.equal(workerCalls, 0);
  });

  it("retains a sealed active Task Review work unit using canonical current state", () => {
    const repository = root();
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const specId = "001-task-review-sealed-active";
    new TaskLifecycleFixture({
      flowManager: manager,
      specId,
      runId: "run-task-review-sealed-active",
      request: "retain active Task Review recovery evidence",
      taskDocuments: [{ id: "T-1", title: "Recovery", goal: "Preserve active worker evidence.", parent: null, origin: "plan", added_round: 0, status: "pending" }],
      taskId: "T-1",
      targetStep: "task-review",
    }).create();
    const state = manager.canonicalState(specId);
    const worker = new ReviewWorkUnit({
      executionRoot: repository,
      runId: state.runId,
      specId,
      phase: "impl",
      taskId: "T-1",
      nodeId: "T-1-review",
      attemptId: state.attempt.id,
      target: { treeSha: "a".repeat(40), targetStateDigest: "b".repeat(64) },
      output: ReviewWorkUnitOutput.forReview({ phase: "impl", taskId: "T-1" }),
    });
    const surface = worker.finalize();
    fs.writeFileSync(surface.outputPath, '{"verdict":"PASS","blockingFindings":[],"nonBlockingImprovements":[]}\n');
    ReviewWorkUnit.fromEnvironment({ [REVIEW_WORK_UNIT_MANIFEST_ENV]: surface.manifestPath }).seal();

    assert.equal(reconcileCompletedReviewWorkUnits({ flowManager: manager, specId, executionRoot: repository }), 0);
    assert.equal(fs.existsSync(surface.directory), true);
  });

  it("publishes Task Review must-fix findings for sealed triage without repairing source", async () => {
    const repository = root();
    initializeReviewSource(repository);
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const specId = "001-task-review-rejected-lineage";
    new TaskLifecycleFixture({
      flowManager: manager,
      specId,
      runId: "run-task-review-rejected-lineage",
      request: "retain rejected Task Review evidence",
      specRecord: {
        requirements: [{ id: "R-1", desc: "Retain rejected Task Review evidence.", task_ids: ["T-1"] }],
        overview: { modules: [], data_flow: [], decisions: [] },
      },
      taskDocuments: [{ id: "T-1", title: "Rejected Review lineage", goal: "Persist rejected Review lineage.", parent: null, origin: "plan", added_round: 0, status: "pending" }],
      taskId: "T-1",
      targetStep: "task-impl",
    }).create();
    confirmTaskImplementationMutation({
      repository,
      manager,
      specId,
      content: "review checkout fixture\nimplemented Task behavior\n",
    });
    const review = new RunReviewCommand({
      resolveTreeSha: () => "a".repeat(40),
      resolveTargetStateDigest: () => "b".repeat(64),
      runCommand(_command, _args, options) {
        const outputDirectory = options.env.SENNEL_REVIEW_OUTPUT_DIR;
        fs.writeFileSync(path.join(outputDirectory, "impl-review.json"), `${JSON.stringify({
          version: 1,
          phase: "impl",
          generatedAt: "2026-09-03T00:00:00.000Z",
          verdict: "REJECTED",
          summary: { blocking: 1, nonBlocking: 0, total: 1 },
          blockingFindings: [canonicalTaskReviewFinding({
            findingKey: "missing-task-behavior",
            title: "Task behavior remains incomplete",
            failureMode: "spec_behavior_contradiction",
            file: "README.md",
            requirementId: "R-1",
            issue: "The current Task behavior is incomplete.",
            suggestion: "Implement the mapped Requirement.",
            disposition: "must-fix",
            rationale: "R-1 requires the missing behavior.",
          })],
          nonBlockingImprovements: [],
          excluded: { missingFile: 0, outOfScope: 0 },
        })}\n`);
        ReviewWorkUnit.fromEnvironment(options.env).seal();
        return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
      },
    });
    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId,
      flowManager: manager,
      flowState: manager.load(specId),
      config: {},
    };
    const result = await review.execute(ctx);
    assert.equal(result.result, "ok", JSON.stringify(result));
    assert.equal(result.artifacts.verdict, "REJECTED");
    assert.deepEqual(manager.taskMutationLineages({ specId, taskId: "T-1" }).map((lineage) => lineage.role), ["implementation"]);
    await FLOW_COMMANDS.run.review.post(ctx, result);
    assert.equal(manager.artifactCatalog(specId).artifacts.some((artifact) => artifact.logicalKey === "task.review"), true);
    assert.equal(manager.canonicalState(specId).current.at(-1), "T-1-triage");
    assert.deepEqual(manager.taskMutationLineages({ specId, taskId: "T-1" }).map((lineage) => lineage.role), ["implementation"]);
  });

  it("rejects Task source changes between Review return and registry publication", async () => {
    const repository = root();
    initializeReviewSource(repository);
    const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
    const specId = "001-task-review-stale-post";
    new TaskLifecycleFixture({
      flowManager: manager,
      specId,
      runId: "run-task-review-stale-post",
      request: "reject source changes before Review publication",
      specRecord: {
        requirements: [{ id: "R-1", desc: "Reject stale Review publication.", task_ids: ["T-1"] }],
        overview: { modules: [], data_flow: [], decisions: [] },
      },
      taskDocuments: [{ id: "T-1", title: "Review publication", goal: "Bind Review publication to current source.", parent: null, origin: "plan", added_round: 0, status: "pending" }],
      taskId: "T-1",
      targetStep: "task-impl",
    }).create();
    confirmTaskImplementationMutation({ repository, manager, specId, content: "implemented before Review publication\n" });
    const review = new RunReviewCommand({
      resolveTreeSha: () => "a".repeat(40),
      resolveTargetStateDigest: () => "b".repeat(64),
      runCommand(_command, _args, options) {
        const outputDirectory = options.env.SENNEL_REVIEW_OUTPUT_DIR;
        fs.writeFileSync(path.join(outputDirectory, "impl-review.json"), `${JSON.stringify({
          version: 1,
          phase: "impl",
          generatedAt: "2026-09-03T00:00:00.000Z",
          verdict: "PASS",
          summary: { blocking: 0, nonBlocking: 0, total: 0 },
          blockingFindings: [],
          nonBlockingImprovements: [],
          excluded: { missingFile: 0, outOfScope: 0 },
        })}\n`);
        ReviewWorkUnit.fromEnvironment(options.env).seal();
        return { ok: true, status: 0, stdout: "", stderr: "", signal: null, killed: false };
      },
    });
    const ctx = {
      root: repository,
      mainRoot: repository,
      executionRoot: repository,
      specId,
      flowManager: manager,
      flowState: manager.load(specId),
      config: {},
    };
    const result = await review.execute(ctx);
    assert.equal(result.result, "ok", JSON.stringify(result));
    fs.appendFileSync(path.join(repository, "README.md"), "external change before Review post\n");
    const before = {
      state: manager.canonicalState(specId).toJSON(),
      activities: manager.activityLedger(specId),
      catalog: manager.artifactCatalog(specId).toJSON(),
    };
    await assert.rejects(
      () => FLOW_COMMANDS.run.review.post(ctx, result),
      (error) => error.code === "STALE_REVIEW_TARGET",
    );
    assert.deepEqual(manager.canonicalState(specId).toJSON(), before.state);
    assert.deepEqual(manager.activityLedger(specId), before.activities);
    assert.deepEqual(manager.artifactCatalog(specId).toJSON(), before.catalog);
  });

  it("fails closed across prior unsealed Task Review Attempts before launching another provider", async () => {
    function setup(name) {
      const repository = root();
      initializeReviewSource(repository);
      const manager = new FlowManager({ root: repository, mainRoot: repository, inWorktree: false });
      const specId = `001-task-review-unsealed-${name}`;
      new TaskLifecycleFixture({
        flowManager: manager,
        specId,
        runId: `run-task-review-unsealed-${name}`,
        request: "Recover interrupted Task Review evidence before another provider call.",
        specRecord: {
          requirements: [{ id: "R-1", desc: "Recover Task Review evidence.", task_ids: ["T-1"] }],
          overview: { modules: [], data_flow: [], decisions: [] },
        },
        taskDocuments: [{ id: "T-1", title: "Recover review", goal: "Protect source after an interrupted review.", parent: null, origin: "plan", added_round: 0, status: "pending" }],
        taskId: "T-1",
        targetStep: "task-impl",
      }).create();
      confirmTaskImplementationMutation({ repository, manager, specId, content: "implemented Task behavior\n" });

      const previousAttempt = manager.canonicalState(specId).attempt;
      manager.failCurrentAttempt({
        specId,
        failure: {
          category: "tooling",
          code: "FIXTURE_INTERRUPTED_TASK_REVIEW",
          message: "The fixture advances to a later Task Review Attempt.",
          retryable: true,
          retryKind: "tooling",
        },
      });
      manager.retryCurrentAttempt({ specId });
      const state = manager.load(specId);
      assert.notEqual(manager.canonicalState(specId).attempt.id, previousAttempt.id);

      const stale = new ReviewWorkUnit({
        executionRoot: repository,
        runId: state.runId,
        specId,
        phase: "impl",
        taskId: "T-1",
        nodeId: "T-1-review",
        attemptId: previousAttempt.id,
        target: { treeSha: "a".repeat(40), targetStateDigest: "b".repeat(64) },
        output: ReviewWorkUnitOutput.forReview({ phase: "impl", taskId: "T-1" }),
      });
      const taskSource = captureCurrentTaskSource({
        root: repository,
        flowManager: manager,
        state,
        taskId: "T-1",
      });
      const recoveryBaseline = SourceMutationBaseline.capture({
        root: repository,
        attempt: previousAttempt,
        ignoredDirectories: taskReviewRecoveryIgnoredDirectories(repository, {
          workUnit: stale,
          flowManager: manager,
          state,
        }),
      });
      stale.writeInput({
        logicalKey: "task.source",
        logicalPath: "task-source.json",
        bytes: Buffer.from(`${JSON.stringify(taskSource.toJSON(), null, 2)}\n`, "utf8"),
        mediaType: "application/json",
      });
      stale.writeInput({
        logicalKey: "task.source-effect-baseline",
        logicalPath: "task-source-effect-baseline.json",
        bytes: Buffer.from(`${JSON.stringify(recoveryBaseline.toJSON(), null, 2)}\n`, "utf8"),
        mediaType: "application/json",
      });
      stale.finalize();
      const ctx = {
        root: repository,
        mainRoot: repository,
        executionRoot: repository,
        specId,
        flowManager: manager,
        flowState: manager.load(specId),
        config: {},
      };
      return { repository, manager, specId, stale, ctx };
    }

    for (const [name, mutate] of [
      ["task-source", ({ repository }) => fs.appendFileSync(path.join(repository, "README.md"), "interrupted Task mutation\n")],
      ["ordinary-source", ({ repository }) => fs.writeFileSync(path.join(repository, "ordinary-provider-side-effect.txt"), "unexpected source effect\n")],
    ]) {
      const fixture = setup(name);
      mutate(fixture);
      let providerCalls = 0;
      const review = new RunReviewCommand({
        resolveTreeSha: () => "a".repeat(40),
        resolveTargetStateDigest: () => "b".repeat(64),
        runCommand() {
          providerCalls += 1;
          throw new Error("the provider must not run after partial source effects");
        },
      });
      const result = await review.execute(fixture.ctx);
      assert.equal(providerCalls, 0, `${name} must block before provider execution`);
      assert.equal(result.errors[0].code, "REVIEW_TOOLING_ERROR");
      assert.deepEqual(result.data.failureCode, "TASK_REVIEW_PARTIAL_EFFECT");
      assert.equal(result.data.retryable, false);
      assert.match(result.data.workUnit, /^\.sennel\/review-work-units\//);
      assert.equal(fixture.manager.canonicalState(fixture.specId).attempt.failure.code, "TASK_REVIEW_PARTIAL_EFFECT");
      assert.equal(fs.existsSync(fixture.stale.directory), true, "partial-effect evidence must remain for definition-owned recovery");
    }

    const safe = setup("unchanged");
    let providerCalls = 0;
    const review = new RunReviewCommand({
      resolveTreeSha: () => "a".repeat(40),
      resolveTargetStateDigest: () => "b".repeat(64),
      runCommand() {
        providerCalls += 1;
        return { ok: false, status: 1, stdout: "", stderr: "fixture provider stop", signal: null, killed: false };
      },
    });
    const result = await review.execute(safe.ctx);
    assert.equal(providerCalls, 1, `unchanged prior evidence must be cleaned before the current provider runs: ${JSON.stringify(result)}`);
    assert.equal(fs.existsSync(safe.stale.directory), false);
    assert.equal(result.errors[0].code, "REVIEW_TOOLING_ERROR");
    assert.notEqual(safe.manager.canonicalState(safe.specId).attempt.failure.code, "TASK_REVIEW_PARTIAL_EFFECT");
  });
});
