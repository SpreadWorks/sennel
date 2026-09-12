import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { Container } from "../../../src/lib/container.js";
import { AgentTimeoutFailure } from "../../../src/lib/agent-failure.js";
import { AgentTimeoutError } from "../../../src/lib/agent.js";
import { AgentTimeoutDiagnostic } from "../../../src/lib/agent-timeout.js";
import { dispatch } from "../../../src/lib/dispatcher.js";
import { flowCommands } from "../../../src/lib/command-registry.js";
import { findStepById, flattenSteps } from "../../../src/flow/lib/step-tree.js";
import {
  buildInitialNestedSteps,
  buildInitialTaskSteps,
  resolveSourceHandoffTransitionPlan,
} from "../../../src/flow/definition.js";
import { SourceHandoffFailureFacts } from "../../../src/flow/lib/source-handoff-failure.js";
import { FLOW_ARTIFACT_AUTHORITY_MATRIX } from "../../../src/flow/lib/flow-artifact-authority.js";
import {
  FLOW_ARTIFACT_CONTRACTS,
  FlowArtifactAttemptHistory,
  FlowArtifactAttemptRecord,
} from "../../../src/lib/flow-artifact-contract.js";
import RunDispatchCommand, * as runDispatchModule from "../../../src/flow/lib/run-dispatch.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import RunRepairTestReviewCommand from "../../../src/flow/lib/run-repair-test-review.js";
import { canonicalTaskReviewFileMap } from "../../../src/flow/commands/review.js";
import SetStepCommand from "../../../src/flow/lib/set-step.js";
import SetMetricCommand from "../../../src/flow/lib/set-metric.js";
import { loadSpecJsonSchema } from "../../../src/lib/spec-json.js";
import { validateSchema } from "../../../src/lib/schema-validate.js";
import { adaptJsonSchemaForProvider } from "../../../src/lib/provider-schema.js";
import {
  WorkerArtifactHandoffCoordinator,
  WorkerArtifactHandoffError,
  WorkerArtifactMutationAuthoritySnapshot,
  SourceMutationManifest,
  SourceHandoffSettlement,
  SourceRepairEffect,
  SourceTriageEffect,
  SourceWorkerEffect,
  SourceWorkerEffectReport,
  assertWorkerUpgradeAllowed,
  stageWorkerUpgradeResult,
  workerArtifactHandoffPolicy,
  sealWorkerArtifactHandoff,
  materializeSourceWorkerEffect,
  sealParentMaterializedSourceWorkerEffect,
  captureSourceMutationManifestForParent,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import { sourceWorkerEffectJsonSchema } from "../../../src/flow/lib/source-worker-effect-schema.js";
import { CanonicalSourceRequirementAuthority } from "../../../src/flow/lib/canonical-file-map.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { CanonicalTestArtifactStore } from "../../../src/flow/lib/canonical-test-artifacts.js";
import {
  ApprovalTaskAdmission,
  CanonicalWorkerSpecPublication,
  CurrentFlowSpecRecord,
} from "../../../src/flow/lib/current-flow-state.js";
import { CanonicalSpecApproval } from "../../../src/flow/lib/canonical-spec-approval.js";
import { readCanonicalSpecTestBootstrapObservation } from "../../../src/flow/lib/spec-test-bootstrap-validator.js";
import { applySpecRepairOperations } from "../../../src/flow/lib/spec-repair-operations.js";
import {
  CanonicalSpecReview,
  SpecReviewDelta,
  mergeSpecReviewDelta,
  specRepairDeltaPayloadSchema,
  specTriageDeltaPayloadSchema,
} from "../../../src/flow/lib/spec-review-artifacts.js";
import {
  attachCanonicalCommandResultArtifact,
  attachCanonicalCommandResultPublications,
} from "../../../src/flow/lib/canonical-command-result.js";
import { persistAgentInvocationMetric } from "../../../src/lib/agent-invocation-metric.js";
import { ProcessLock } from "../../../src/lib/process-lock.js";
import { RealDirectoryAuthority } from "../../../src/lib/real-directory-authority.js";
import { ApprovedFindingExceptionSet } from "../../../src/flow/lib/acknowledged-rationale.js";
import { CanonicalTaskContext } from "../../../src/flow/lib/task-canonical-context.js";
import { captureCurrentTaskSource } from "../../../src/flow/lib/task-mutation-lineage.js";
import {
  CanonicalFlowFixture,
  TaskLifecycleFixture,
  canonicalDraftDocument,
} from "../../support/infrastructure/flow-setup.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import {
  validWorkerHandoffSpec as validSpec,
  validWorkerHandoffTaskSpec,
  workerArtifactJson as json,
} from "../../support/infrastructure/worker-artifact.js";

const ACTION_DIGEST = "a".repeat(64);
const SOURCE_REQUEST_LIFECYCLES = new WeakMap();
const WORKER_ARTIFACT_HANDOFF_SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../src/flow/schemas/next-action/worker-artifact-handoff.schema.json",
);
function fixture(stepId = "draft", {
  worktree = true,
  runId = "run-worker-handoff",
  specId = "500-worker-handoff",
  issue = null,
  issueSnapshot = null,
  request = "Create the target-bound worker artifact handoff.",
  autoApprove = false,
  specRecord = null,
  beforeActivate = null,
  versionStoreFaultInjector = null,
} = {}) {
  const mainRoot = createTmpDir("worker-handoff-main-");
  const executionRoot = worktree ? path.join(mainRoot, "execution") : mainRoot;
  fs.mkdirSync(executionRoot, { recursive: true });
  const flowManager = new FlowManager({
    root: executionRoot,
    mainRoot,
    inWorktree: worktree,
    specId,
    versionStoreFaultInjector,
  });
  const flow = new CanonicalFlowFixture({
    flowManager,
    specId,
    runId,
    // `flow.json.request` is required even when this fixture is exercising
    // the draft-context failure caused by an empty user request.  The V1
    // schema preserves that exact empty request; DraftInputAuthority then
    // correctly rejects it as non-authoritative worker context.
    request: request ?? "",
    issue,
    issueSnapshot,
    execution: worktree
      ? { mode: "worktree", baseBranch: "main", featureBranch: `feature/${specId}` }
      : { mode: "direct", baseBranch: "main", featureBranch: null },
    autoApprove,
    ...(specRecord === null ? {} : { specRecord }),
  }).create().registerActive();
  const ctx = { root: executionRoot, executionRoot, mainRoot, specId, flowManager };
  const invocation = {
    id: "dispatch-worker-handoff",
    target: { digest: "b".repeat(64) },
    action: {
      digest: ACTION_DIGEST,
      nextAction: { step: stepId },
    },
  };
  const coordinator = new WorkerArtifactHandoffCoordinator({
    now: () => new Date("2026-08-04T00:00:00.000Z"),
  });
  const createRequest = coordinator.createRequest.bind(coordinator);
  coordinator.createRequest = (input) => {
    const handoff = createRequest(input);
    if (handoff?.policy.kind === "source") {
      coordinator.startSourceWorker({ ctx: input.ctx, request: handoff, invocation: input.invocation });
      SOURCE_REQUEST_LIFECYCLES.set(handoff, { coordinator, ctx: input.ctx });
    }
    return handoff;
  };
  const value = { mainRoot, executionRoot, specId, flowManager, flow, ctx, invocation, coordinator };
  if (beforeActivate !== null) {
    if (typeof beforeActivate !== "function") throw new TypeError("worker handoff fixture beforeActivate must be a function");
    beforeActivate(value);
  }
  if (flow.state().currentNodeId !== stepId) flow.activate(stepId);
  return value;
}

function canonicalSpecDir(value) {
  return value.flowManager.specLocation(value.specId).directory;
}

function identityDigest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function executionHandoffRoot(value) {
  const specDigest = identityDigest(value.specId).slice(0, 24);
  return path.join(value.executionRoot, ".sennel", "handoffs", specDigest);
}

function publishDraftBeforeTarget(value, draft) {
  value.flow.activate("draft");
  value.flowManager.publishArtifacts({
    specId: value.specId,
    nodeId: "draft",
    artifactWrites: [{
      logicalKey: "draft",
      mediaType: "application/json",
      bytes: Buffer.from(json(draft), "utf8"),
    }],
  });
  value.flow.settle("draft");
}

/** Drive the production repair command from a cataloged REJECTED test review. */
function prepareCanonicalTestReviewRepair(value, { findingCount = 1 } = {}) {
  const testBytes = Buffer.from([
    "// spec: R1",
    'import test from "node:test";',
    'test("R1: keeps the premise", () => {});',
    "",
  ].join("\n"), "utf8");
  value.flowManager.publishArtifacts({
    specId: value.specId,
    nodeId: "test",
    artifactWrites: [{
      logicalKey: "tests.source",
      parameters: { testPath: "r1.test.js" },
      mediaType: "text/javascript",
      bytes: testBytes,
    }],
  });
  value.flow.settle("test").activate("scenario-validity").settle("scenario-validity").activate("test-review");
  const sourceRevision = new CanonicalTestArtifactStore({
    flowManager: value.flowManager,
    state: value.flowManager.load(value.specId),
  }).testSourceRevision().toJSON();
  const findings = Array.from({ length: findingCount }, (_, index) => ({
    findingId: `header-r${index + 1}`,
    fingerprint: String(index + 15).at(-1).repeat(64),
    target: "r1.test.js:R1",
    issue: "The header declares R1 but its test name is incomplete.",
    requiredChange: `Add missing R1 assertion ${index + 1}.`,
    title: `Header test repair ${index + 1}`,
  }));
  const evidenceFindings = findings.map((finding) => ({
    findingId: finding.findingId,
    fingerprint: finding.fingerprint,
    summary: finding.title,
    evidenceRefs: [`test-review.json#${finding.findingId}`],
  }));
  const attempt = value.flowManager.canonicalState(value.specId).attempt.sequence;
  const history = new FlowArtifactAttemptHistory([new FlowArtifactAttemptRecord({
    attempt,
    payload: {
      nodeId: "test-review",
      outcome: "completed",
      result: { result: "ok" },
      artifact: {
        logicalKey: "test.review",
        payload: {
          phase: "test",
          verdict: "REJECTED",
          blockingFindings: findings,
          advisoryFindings: [],
          sourceTestArtifactRevision: sourceRevision,
          canonicalEvidence: {
            disposition: "REJECTED",
            blockingFindings: evidenceFindings,
            advisoryFindings: [],
            identity: { evidenceDigest: "e".repeat(64) },
          },
        },
      },
    },
  })]);
  value.flowManager.publishArtifacts({
    specId: value.specId,
    nodeId: "test-review",
    artifactWrites: [{
      logicalKey: "test.review",
      mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(history.toJSON())}\n`, "utf8"),
    }],
  });
  const repair = new RunRepairTestReviewCommand().execute({
    ...value.ctx,
    flowState: value.flowManager.load(value.specId),
    flowCommandBoundary: true,
  });
  assert.equal(repair.ok, true, JSON.stringify(repair));
}

function publishSpecProposal(value, proposed) {
  const request = value.coordinator.createRequest({
    ctx: value.ctx,
    state: value.flowManager.load(),
    invocation: value.invocation,
  });
  fs.writeFileSync(request.payloadPath("spec.json"), json(proposed));
  seal(request);
  value.coordinator.reconcile({ ctx: value.ctx, request });
}

function readCatalogJson(value, logicalKey, consumerNodeId) {
  return JSON.parse(value.flowManager.readArtifact({
    specId: value.specId,
    logicalKey,
    consumerNodeId,
  }).bytes.toString("utf8"));
}

function draftDocument(goal) {
  return canonicalDraftDocument({ goal });
}

function draftWithQuestionLedger(questions) {
  return canonicalDraftDocument({
    goal: "Exercise canonical draft question promotion.",
    questions,
  });
}

function candidateDraftQuestion({ id = "q1", revision = 0 } = {}) {
  return {
    state: "CandidateQuestion",
    id,
    question: "Which public behavior should be selected?",
    category: "user-visible-behavior",
    revision,
    provenance: { producer: "worker-handoff-fixture" },
    evidenceDigest: "a".repeat(64),
  };
}

function writeScenarioRuntimeLog(value, text) {
  value.flowManager.writeRuntimeArtifact({
    specId: value.specId,
    nodeId: "scenario-validity",
    artifact: {
      logicalKey: "scenario.validity.raw-log",
      mediaType: "text/plain",
      bytes: Buffer.from(text, "utf8"),
    },
  });
}

function initializeGitRepository(value) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: value.mainRoot });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: value.mainRoot });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: value.mainRoot });
  fs.writeFileSync(path.join(value.mainRoot, "product.js"), "export const value = 1;\n");
  execFileSync("git", ["add", "."], { cwd: value.mainRoot });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: value.mainRoot });
}

function acquireRuntimeLock(location, logicalKey) {
  const runtimeLock = location.runtimeLock(logicalKey);
  fs.mkdirSync(runtimeLock.directory, { recursive: true });
  const versionAuthority = new RealDirectoryAuthority(location.directory);
  const runtimeAuthority = new RealDirectoryAuthority(runtimeLock.runtimeDirectory, {
    parentAuthority: versionAuthority,
  });
  const lockAuthority = new RealDirectoryAuthority(runtimeLock.directory, {
    parentAuthority: runtimeAuthority,
  });
  const lock = new ProcessLock({
    directoryAuthority: lockAuthority,
    fileName: runtimeLock.fileName,
    kind: "worker-authority-runtime-lock",
    authority: { logicalKey },
  });
  lock.acquire();
  return { lock, runtimeLock };
}

function seal(request) {
  if (request.policy.kind === "source") {
    if (!fs.existsSync(request.sourceMutationManifestPath)) captureSourceMutationManifestForParent({ request });
    const sealed = sealParentMaterializedSourceWorkerEffect({ request, now: () => new Date("2026-08-04T00:00:01.000Z") });
    const lifecycle = SOURCE_REQUEST_LIFECYCLES.get(request);
    if (lifecycle !== undefined) lifecycle.coordinator.finishSourceWorker({ ctx: lifecycle.ctx, request });
    return sealed;
  }
  return sealWorkerArtifactHandoff({
    requestPath: request.requestPath,
    invocationId: request.dispatchInvocationId,
    now: () => new Date("2026-08-04T00:00:01.000Z"),
  });
}

function rejectedSourcePlan(request, error, { workerStopped = true } = {}) {
  return resolveSourceHandoffTransitionPlan({
    facts: SourceHandoffFailureFacts.fromError(error, {
      request,
      ownershipProven: true,
      workerStopped,
    }),
    policy: request.policy,
  });
}

function sourceWorkerReport(stepId, additions = {}) {
  return {
    version: 1,
    stepId,
    completionStatus: "done",
    issues: [],
    overview: null,
    triage: null,
    repair: null,
    noChangeReason: null,
    ...additions,
  };
}

function captureManifest(request) {
  return captureSourceMutationManifestForParent({ request });
}

function implementationEffect(request, paths) {
  return new SourceWorkerEffect({
    version: 1,
    stepId: "implement",
    completionStatus: "done",
    files: [{
      requirementId: "R1",
      mutationIds: paths.map((entry) => SourceMutationManifest.mutationId(request.sourceMutationBaseline.attempt, entry)),
    }],
    issues: [],
    overview: null,
    triage: null,
    repair: null,
  });
}

function draftWorkerAction(stepId = "draft") {
  return {
    taskId: null,
    step: stepId,
    action: "write-draft",
    instructions: { key: `plan.${stepId}`, content: "Write the draft." },
    context: { workerArtifactHandoff: { required: true } },
    output_schema: {},
    requires_approval: false,
    maxAttempts: 1,
    directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "write-draft" },
  };
}

function specTriageWorkerAction() {
  return {
    taskId: null,
    step: "spec-triage",
    action: "write-spec",
    instructions: { key: "plan.spec-triage", content: "Classify the immutable review findings." },
    context: { workerArtifactHandoff: { required: true } },
    output_schema: loadWorkerArtifactHandoffSchema(),
    requires_approval: false,
    maxAttempts: 1,
    directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "write-spec" },
  };
}

function validSpecTriagePayload(request, findings = []) {
  const review = new CanonicalSpecReview(
    request.inputs.find((entry) => entry.name === "review.json").document,
  );
  return {
    version: 2,
    stage: "spec-triage",
    identity: review.identity.toJSON(),
    baseReviewDigest: review.digest,
    findings: structuredClone(findings),
    operations: [],
  };
}

function completedWorkerAction() {
  return {
    taskId: null,
    step: null,
    action: "completed",
    instructions: null,
    context: null,
    output_schema: null,
    requires_approval: false,
    directive: { kind: "completed", terminal: true, requiresUserAction: false },
  };
}

function loadWorkerArtifactHandoffSchema() {
  return JSON.parse(fs.readFileSync(WORKER_ARTIFACT_HANDOFF_SCHEMA_PATH, "utf8"));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function rewriteSubmission(request, mutate) {
  const document = JSON.parse(fs.readFileSync(request.submissionPath, "utf8"));
  mutate(document);
  const unsigned = { ...document };
  delete unsigned.handoffDigest;
  document.handoffDigest = crypto.createHash("sha256")
    .update(stableStringify(unsigned))
    .digest("hex");
  fs.writeFileSync(request.submissionPath, `${JSON.stringify(document, null, 2)}\n`);
}

function prepareSpecRepairFixture() {
  const value = fixture("spec-review", {
    specRecord: validSpec(),
    beforeActivate(candidate) {
      candidate.flow.addTask({
        id: "T1",
        title: "Preserve the admitted task",
        goal: "Keep the task decomposition valid.",
        acceptance: ["The task remains executable."],
        implementation_notes: "Use the canonical task contract.",
        test_strategy: "Run the focused test.",
        origin: "plan",
        added_round: 0,
        status: "pending",
      });
    },
  });
  const initial = value.flowManager.readCurrentSpecReviewInput({ specId: value.specId, consumerNodeId: "spec-review" });
  const reviewDelta = new SpecReviewDelta({ version: 2, stage: "spec-review", identity: initial.review.identity.toJSON(), baseReviewDigest: initial.review.digest, operations: [], findings: [{
    findingId: "spec-review-blocking-1", kind: "blocking", title: "Name target", target: "R1", body: "The reviewed requirement is incomplete.", issue: "Requirement R1 needs a bounded correction.", requiredChange: "Update its description.", whyBlocking: "The handoff must retain a typed permission.",
  }] });
  const reviewed = mergeSpecReviewDelta({ review: initial.review, delta: reviewDelta });
  const reviewResult = attachCanonicalCommandResultPublications({ result: "fixture spec review", artifacts: { phase: "spec" } }, [{ logicalKey: "spec.review", parameters: { revision: String(initial.revision).padStart(3, "0") }, payload: reviewed.toJSON() }]);
  value.flowManager.updateStepStatus(
    { stepId: "spec-review", requestedStatus: "done" },
    { specId: value.specId, canonicalCommandResult: reviewResult },
  );
  value.flow.activate("spec-triage");
  const triageInput = value.flowManager.readCurrentSpecReview({ specId: value.specId, consumerNodeId: "spec-triage" });
  const triageDelta = new SpecReviewDelta({ version: 2, stage: "spec-triage", identity: triageInput.review.identity.toJSON(), baseReviewDigest: triageInput.review.digest, operations: [], findings: [{ findingId: "spec-review-blocking-1", disposition: "apply", evidence: "The reviewed requirement is incomplete.", allowedTargets: [{ target: { entity: "requirement", id: "R1", field: "desc" }, operationKinds: ["replace-entity-field"] }] }] });
  const triaged = mergeSpecReviewDelta({ review: triageInput.review, delta: triageDelta });
  const triageResult = attachCanonicalCommandResultPublications({ result: "fixture spec triage", artifacts: { phase: "spec" } }, [{ logicalKey: "spec.review", parameters: { revision: String(triageInput.revision).padStart(3, "0") }, payload: triaged.toJSON() }]);
  value.flowManager.updateStepStatus(
    { stepId: "spec-triage", requestedStatus: "done" },
    { specId: value.specId, canonicalCommandResult: triageResult },
  );
  value.flow.activate("spec-repair");
  return value;
}

function prepareSpecTriageFixture() {
  const value = fixture("spec-review", { specRecord: validSpec() });
  const initial = value.flowManager.readCurrentSpecReviewInput({
    specId: value.specId,
    consumerNodeId: "spec-review",
  });
  const reviewDelta = new SpecReviewDelta({
    version: 2,
    stage: "spec-review",
    identity: initial.review.identity.toJSON(),
    baseReviewDigest: initial.review.digest,
    operations: [],
    findings: [
      {
        findingId: "F-valid",
        kind: "blocking",
        title: "Keep valid sibling",
        target: "R1",
        body: "A valid triage sibling must survive malformed siblings.",
        issue: "The requirement needs a disposition.",
        requiredChange: "Classify the finding.",
        whyBlocking: "The parent must retain the independent update.",
      },
      {
        findingId: "F-conflict",
        kind: "blocking",
        title: "Discard conflict",
        target: "R1",
        body: "Conflicting updates must remain auditable.",
        issue: "The update must have one disposition.",
        requiredChange: "Record the discard.",
        whyBlocking: "The canonical review is the audit authority.",
      },
    ],
  });
  const reviewed = mergeSpecReviewDelta({ review: initial.review, delta: reviewDelta });
  const reviewResult = attachCanonicalCommandResultPublications(
    { result: "fixture spec review", artifacts: { phase: "spec" } },
    [{
      logicalKey: "spec.review",
      parameters: { revision: String(initial.revision).padStart(3, "0") },
      payload: reviewed.toJSON(),
    }],
  );
  value.flowManager.updateStepStatus(
    { stepId: "spec-review", requestedStatus: "done" },
    { specId: value.specId, canonicalCommandResult: reviewResult },
  );
  value.flow.activate("spec-triage");
  return value;
}

function specRepairWorkerAction() {
  return {
    taskId: null,
    step: "spec-repair",
    action: "write-spec",
    instructions: { key: "plan.spec-repair", content: "Write the constrained spec repair." },
    context: { workerArtifactHandoff: { required: true } },
    output_schema: {},
    requires_approval: false,
    maxAttempts: 1,
    directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "write-spec" },
  };
}

function specRepairPayload(request, { scopeExpansion = false, valid = false } = {}) {
  const target = { entity: "requirement", id: "R1", field: "desc" };
  const rejectedReplacement = "SECRET-WORKER-REPLACEMENT";
  return {
    version: 2, stage: "spec-repair",
    identity: structuredClone(request.inputs.find((entry) => entry.name === "review.json").document.identity),
    baseReviewDigest: crypto.createHash("sha256").update(`${JSON.stringify(request.inputs.find((entry) => entry.name === "review.json").document, null, 2)}\n`).digest("hex"),
    findings: [],
    operations: scopeExpansion || valid ? [{
      findingIds: ["spec-review-blocking-1"],
      kind: "replace-entity-field",
      target,
      expectedDigest: repairDigest("Publish a validated artifact."),
      replacement: "Publish a corrected validated artifact.",
      reason: "The reviewed requirement needs its target named.",
    }] : [{
      findingIds: ["untrusted-finding"],
      kind: "replace-entity-field",
      target,
      expectedDigest: repairDigest("Publish a validated artifact."),
      replacement: rejectedReplacement,
      reason: "This operation is intentionally unauthorized.",
    }],
    scopeExpansions: scopeExpansion ? ["A new scope proposal."] : [],
  };
}

function validSpecRepairPayload(request) {
  return specRepairPayload(request, { valid: true });
}

function specRepairSnapshot(value) {
  const state = value.flowManager.load(value.specId);
  const spec = value.flowManager.readArtifact({
    specId: value.specId,
    logicalKey: "spec.record",
    consumerNodeId: "spec-repair",
  });
  return structuredClone({
    canonicalSpec: spec.bytes.toString("base64"),
    flowState: state,
    activities: value.flowManager.activityLedger(value.specId),
    catalog: value.flowManager.artifactCatalog(value.specId).toJSON(),
    stepStatus: findStepById(state.steps, "spec-repair").status,
    semanticRetry: value.flowManager.canonicalState(value.specId).retryEligibility(),
  });
}

describe("worker artifact handoff", () => {
  it("references complete large worker inputs without changing the handoff digest or input authority", () => {
    const input = `Complete worker request ${"x".repeat(133_813)} END_OF_WORKER_REQUEST`;
    const value = fixture("draft", { request: input });
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation,
      });
      const before = request.requestDigest;
      const reference = request.toPromptReference().toJSON();
      const prompt = JSON.stringify(reference);
      assert.ok(prompt.length < 20_000);
      assert.equal(prompt.includes("END_OF_WORKER_REQUEST"), false);
      assert.equal(reference.requestDigest, before);
      assert.equal(request.requestDigest, before);
      const stored = JSON.parse(fs.readFileSync(reference.requestPath, "utf8"));
      assert.ok(JSON.stringify(stored).includes(input));
      assert.deepEqual(reference.inputs, stored.inputs.map(({ name, targetRelativePath, digest, byteLength }) => ({
        name, targetRelativePath, digest, byteLength,
      })));
      assert.equal(reference.inputDigest, stored.inputDigest);
      assert.equal(reference.actionDigest, stored.actionDigest);
      assert.deepEqual(JSON.parse(fs.readFileSync(reference.actionRequestPath, "utf8")), value.invocation.action.nextAction);
      assert.throws(() => { reference.payloads[0].required = !reference.payloads[0].required; }, TypeError);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("refuses a stale guarded-action reference before handing it to a worker", () => {
    const value = fixture("draft");
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation,
      });
      const before = request.requestDigest;
      fs.writeFileSync(request.actionRequestPath, JSON.stringify({ step: "different-step" }));
      assert.throws(() => request.toPromptReference(), (error) =>
        error instanceof WorkerArtifactHandoffError && error.code === "FLOW_ARTIFACT_HANDOFF_STALE");
      assert.equal(request.requestDigest, before);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("refuses a changed request document before handing its reference to a worker", () => {
    const value = fixture("draft");
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation,
      });
      const before = request.requestDigest;
      const document = JSON.parse(fs.readFileSync(request.requestPath, "utf8"));
      document.inputDigest = "0".repeat(64);
      fs.writeFileSync(request.requestPath, JSON.stringify(document));
      assert.throws(() => request.toPromptReference(), (error) =>
        error instanceof WorkerArtifactHandoffError && error.code === "FLOW_ARTIFACT_HANDOFF_STALE");
      assert.equal(request.requestDigest, before);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("does not expose the retired spec-repair exhaustion diagnostic", () => {
    assert.equal(Object.hasOwn(runDispatchModule, "SpecRepairExhaustedDiagnostic"), false);
  });

  it("seals through the dispatcher without resolving ambient Flow authority", async () => {
    const value = fixture();
    const request = value.coordinator.createRequest({
      ctx: value.ctx,
      state: value.flowManager.load(),
      invocation: value.invocation,
    });
    fs.writeFileSync(
      request.payloadPath("draft.json"),
      json(draftDocument("sealed without ambient Flow context")),
    );
    const previousRequestPath = process.env.SENNEL_FLOW_HANDOFF_REQUEST;
    const previousInvocationId = process.env.SENNEL_FLOW_DISPATCH_INVOCATION_ID;
    const output = [];
    let contextBuilds = 0;
    let exitCode = null;
    const container = new Container();
    container.register("paths", { root: value.executionRoot, agentWorkDir: path.join(value.executionRoot, ".agent-work") });
    container.register("mainRoot", value.mainRoot);
    container.register("config", {});
    container.register("inWorktree", true);
    container.register("flowManager", {
      load() { throw new Error("seal-handoff must not load Flow state"); },
      loadReadOnly() { throw new Error("seal-handoff must not read Flow state"); },
      artifactCatalog() { throw new Error("seal-handoff must not read the artifact catalog"); },
    });
    process.env.SENNEL_FLOW_HANDOFF_REQUEST = request.requestPath;
    process.env.SENNEL_FLOW_DISPATCH_INVOCATION_ID = request.dispatchInvocationId;
    try {
      await dispatch({
        container,
        entry: flowCommands.run["seal-handoff"],
        argv: [],
        envelopeType: "run",
        envelopeKey: "seal-handoff",
        runtimeLog: true,
        stdout: (text) => output.push(text),
        setExitCode: (code) => { exitCode = code; },
        buildHookCtx: () => {
          contextBuilds += 1;
          throw new Error("seal-handoff must not build ambient Flow context");
        },
      });

      const envelope = JSON.parse(output.join(""));
      assert.equal(envelope.ok, true);
      assert.equal(exitCode, 0);
      assert.equal(contextBuilds, 0);
      assert.equal(fs.existsSync(request.submissionPath), true);
      assert.equal(envelope.data.handoffPath, request.submissionPath);
      assert.equal(fs.existsSync(path.join(value.executionRoot, ".tmp")), false);
    } finally {
      if (previousRequestPath === undefined) delete process.env.SENNEL_FLOW_HANDOFF_REQUEST;
      else process.env.SENNEL_FLOW_HANDOFF_REQUEST = previousRequestPath;
      if (previousInvocationId === undefined) delete process.env.SENNEL_FLOW_DISPATCH_INVOCATION_ID;
      else process.env.SENNEL_FLOW_DISPATCH_INVOCATION_ID = previousInvocationId;
      removeTmpDir(value.mainRoot);
    }
  });

  it("seals source-worker upgrade evidence and publishes it only with the parent confirmation", () => {
    const value = fixture("implement", { specRecord: validSpec() });
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      const effect = implementationEffect(request, ["product.js"]);
      const upgrade = {
        version: 1,
        command: "sennel upgrade",
        dryRun: false,
        exitCode: 0,
        result: "success-no-change",
        summary: { skills: { updated: 0, unchanged: 1, removed: 0 } },
        failureReason: null,
        checkedPaths: [],
      };
      fs.writeFileSync(request.payloadPath("effects.json"), json(effect.toJSON()));
      assert.equal(assertWorkerUpgradeAllowed({ requestPath: request.requestPath }).stepId, "implement");
      stageWorkerUpgradeResult({ requestPath: request.requestPath, artifact: upgrade });
      assert.equal(value.flowManager.readArtifact({
        specId: value.specId,
        logicalKey: "upgrade.result",
        consumerNodeId: "impl-gate",
        optional: true,
      }), null, "the worker may not publish canonical evidence before sealing and confirmation");
      fs.writeFileSync(path.join(value.executionRoot, "product.js"), "export const upgraded = true;\n");
      seal(request);

      value.coordinator.reconcile({ ctx: value.ctx, request, mutationAuthority: authority });

      assert.deepEqual(readCatalogJson(value, "upgrade.result", "impl-gate"), upgrade);
      assert.equal(value.flowManager.activityLedger(value.specId).at(-1).nodeId, "implement");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("confirms a source handoff after regular flow set metric docsRead commands", () => {
    const value = fixture("implement", { specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      assert.deepEqual(new SetMetricCommand().execute({
        ...value.ctx,
        phase: "impl",
        counter: "docsRead",
      }), { phase: "impl", counter: "docsRead" });
      assert.deepEqual(new SetMetricCommand().execute({
        ...value.ctx,
        phase: "impl",
        counter: "docsRead",
      }), { phase: "impl", counter: "docsRead" });
      fs.writeFileSync(request.payloadPath("effects.json"), json(implementationEffect(request, ["product.js"]).toJSON()));
      fs.writeFileSync(path.join(value.executionRoot, "product.js"), "export const value = 2;\n");
      seal(request);

      const result = value.coordinator.reconcile({ ctx: value.ctx, request, mutationAuthority: authority });

      assert.equal(result.canonicalObservationAdvance.kind, "source-worker-canonical-observation-advance");
      assert.deepEqual(
        result.canonicalObservationAdvance.addedActivityIds.filter((id) => id.startsWith("metric-recorded-")),
        value.flowManager.activityLedger(value.specId)
          .filter((activity) => activity.transition.operation === "record_metric")
          .map((activity) => activity.id),
      );
      assert.equal(findStepById(value.flowManager.load().steps, "implement").status, "done");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("manifests only mutations made after a dirty Attempt baseline", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      fs.writeFileSync(path.join(value.mainRoot, "preexisting.js"), "export const before = true;\n");
      const request = value.coordinator.createRequest({ ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation });
      fs.writeFileSync(path.join(value.mainRoot, "product.js"), "export const value = 2;\n");
      const manifest = captureManifest(request);
      assert.deepEqual(manifest.mutations.map((entry) => entry.path), ["product.js"]);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("manifests an additional edit to a pre-existing dirty source file", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const product = path.join(value.mainRoot, "product.js");
      fs.writeFileSync(product, "export const value = 0;\n");
      const request = value.coordinator.createRequest({ ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation });
      fs.writeFileSync(product, "export const value = 2;\n");
      const manifest = captureManifest(request);
      assert.deepEqual(manifest.mutations.map((entry) => entry.path), ["product.js"]);
      assert.equal(manifest.mutations[0].beforeDigest !== manifest.mutations[0].afterDigest, true);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("recovers clean tracked before state from Git index and rejects source changes after manifest generation", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const product = path.join(value.mainRoot, "product.js");
      const request = value.coordinator.createRequest({ ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation });
      fs.unlinkSync(product);
      const manifest = captureManifest(request);
      assert.equal(manifest.mutations[0].changeKind, "deleted");
      assert.match(manifest.mutations[0].beforeDigest, /^[a-f0-9]{64}$/);
      assert.equal(manifest.mutations[0].afterDigest, null);
      fs.writeFileSync(request.payloadPath("effects.json"), json(implementationEffect(request, ["product.js"]).toJSON()));
      fs.writeFileSync(product, "export const value = 3;\n");
      assert.throws(
        () => sealParentMaterializedSourceWorkerEffect({ request }),
        (error) => error instanceof WorkerArtifactHandoffError && error.code === "FLOW_SOURCE_HANDOFF_MANIFEST_STALE",
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("classifies a clean tracked content edit and chmod from normalized Git index modes", () => {
    const contentValue = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(contentValue);
      const product = path.join(contentValue.mainRoot, "product.js");
      fs.chmodSync(product, 0o664);
      const request = contentValue.coordinator.createRequest({
        ctx: contentValue.ctx, state: contentValue.flowManager.load(), invocation: contentValue.invocation,
      });
      fs.writeFileSync(product, "export const value = 2;\n");
      const manifest = captureManifest(request);
      assert.equal(manifest.mutations[0].changeKind, "content");
    } finally {
      removeTmpDir(contentValue.mainRoot);
    }

    const modeValue = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(modeValue);
      execFileSync("git", ["config", "core.fileMode", "false"], { cwd: modeValue.mainRoot });
      const product = path.join(modeValue.mainRoot, "product.js");
      fs.chmodSync(product, 0o644);
      const request = modeValue.coordinator.createRequest({
        ctx: modeValue.ctx, state: modeValue.flowManager.load(), invocation: modeValue.invocation,
      });
      fs.chmodSync(product, 0o755);
      const manifest = captureManifest(request);
      assert.equal(manifest.mutations[0].changeKind, "mode");
    } finally {
      removeTmpDir(modeValue.mainRoot);
    }
  });

  it("ignores permission changes that Git cannot represent", () => {
    for (const { committedMode, changedMode } of [
      { committedMode: 0o755, changedMode: 0o700 },
      { committedMode: 0o644, changedMode: 0o600 },
      { committedMode: 0o644, changedMode: 0o655 },
    ]) {
      const value = fixture("implement", { worktree: false, specRecord: validSpec() });
      try {
        initializeGitRepository(value);
        const product = path.join(value.mainRoot, "product.js");
        fs.chmodSync(product, committedMode);
        if (committedMode === 0o755) {
          execFileSync("git", ["add", "product.js"], { cwd: value.mainRoot });
          execFileSync("git", ["commit", "-q", "-m", "record executable authority"], { cwd: value.mainRoot });
        }
        execFileSync("git", ["config", "core.fileMode", "false"], { cwd: value.mainRoot });
        const request = value.coordinator.createRequest({
          ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation,
        });
        fs.chmodSync(product, changedMode);
        assert.deepEqual(captureManifest(request).mutations, []);
      } finally {
        removeTmpDir(value.mainRoot);
      }
    }
  });

  it("captures and restores Git-visible mode changes for executable pre-untracked files", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const script = path.join(value.mainRoot, "local-script.sh");
      fs.writeFileSync(script, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(script, 0o755);
      const request = value.coordinator.createRequest({
        ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation,
      });
      const baselineEntry = request.sourceMutationBaseline.snapshot.entries
        .find((entry) => entry.path === "local-script.sh");
      assert.equal(baselineEntry.mode, 0o755);
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);

      fs.chmodSync(script, 0o644);
      const manifest = captureManifest(request);
      assert.deepEqual(manifest.mutations.map((entry) => ({
        path: entry.path,
        changeKind: entry.changeKind,
        beforeMode: entry.beforeMode,
        afterMode: entry.afterMode,
      })), [{
        path: "local-script.sh",
        changeKind: "mode",
        beforeMode: 0o755,
        afterMode: 0o644,
      }]);

      authority.rollbackRejectedSourceMutation();

      assert.equal(fs.readFileSync(script, "utf8"), "#!/bin/sh\nexit 0\n");
      assert.equal(fs.statSync(script).mode & 0o777, 0o755);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("preserves Git-invisible permission bits while rolling back tracked content", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const product = path.join(value.mainRoot, "product.js");
      const request = value.coordinator.createRequest({
        ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);

      fs.writeFileSync(product, "export const value = 2;\n");
      fs.chmodSync(product, 0o600);
      const manifest = captureManifest(request);
      assert.equal(manifest.mutations[0].changeKind, "content");

      authority.rollbackRejectedSourceMutation();

      assert.equal(fs.readFileSync(product, "utf8"), "export const value = 1;\n");
      assert.equal(fs.statSync(product).mode & 0o777, 0o600);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("preserves 0755 to 0700 permission narrowing while rolling back tracked content", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const product = path.join(value.mainRoot, "product.js");
      fs.chmodSync(product, 0o755);
      execFileSync("git", ["add", "product.js"], { cwd: value.mainRoot });
      execFileSync("git", ["commit", "-q", "-m", "record executable product"], { cwd: value.mainRoot });
      const request = value.coordinator.createRequest({
        ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);

      fs.writeFileSync(product, "export const value = 2;\n");
      fs.chmodSync(product, 0o700);
      assert.equal(captureManifest(request).mutations[0].changeKind, "content");

      authority.rollbackRejectedSourceMutation();

      assert.equal(fs.readFileSync(product, "utf8"), "export const value = 1;\n");
      assert.equal(fs.statSync(product).mode & 0o777, 0o700);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("keeps a large clean tracked tree out of the source request authority", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const trackedRoot = path.join(value.mainRoot, "tracked-fixture");
      fs.mkdirSync(trackedRoot);
      for (let index = 0; index < 18_763; index += 1) {
        fs.writeFileSync(path.join(trackedRoot, `${String(index).padStart(5, "0")}.txt`), "x\n");
      }
      execFileSync("git", ["add", "tracked-fixture"], { cwd: value.mainRoot });
      execFileSync("git", ["commit", "-q", "-m", "large tracked fixture"], { cwd: value.mainRoot });
      fs.writeFileSync(path.join(value.mainRoot, "product.js"), "export const value = 0;\n");
      fs.writeFileSync(path.join(value.mainRoot, "untracked.txt"), "before\n");

      const request = value.coordinator.createRequest({
        ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation,
      });
      const stored = JSON.parse(fs.readFileSync(request.requestPath, "utf8"));

      assert.equal(request.sourceMutationBaseline.snapshot.entries.length, 2);
      assert.deepEqual(request.sourceMutationBaseline.snapshot.entries.map((entry) => entry.path), [
        "product.js", "untracked.txt",
      ]);
      assert.equal(Object.hasOwn(request.sourceMutationBaseline.snapshot.toJSON(), "modeEntries"), false);
      assert.equal(Object.hasOwn(stored, "sourceMutationBaseline"), false);
      assert.equal(Object.hasOwn(stored, "sourceHandoffCheckpoint"), false);
      assert.equal(stored.sourceMutationBaselineDigest, request.sourceMutationBaseline.digest);
      assert.equal(stored.sourceHandoffCheckpointDigest, request.sourceHandoffCheckpoint.digest);
      const requestBytes = fs.statSync(request.requestPath).size;
      assert.ok(Buffer.byteLength(JSON.stringify(request.sourceMutationBaseline.toJSON())) < 10_000);
      assert.ok(requestBytes < 512 * 1024);
      assert.ok(requestBytes < 8 * 1024 * 1024);
      assert.equal(value.flowManager.readSourceHandoffAuthority({
        specId: value.specId,
        identity: request.sourceHandoffIdentity,
      }).event.kind, "start-intent");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("classifies clean tracked symlink target and type changes", () => {
    const linkValue = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(linkValue);
      const link = path.join(linkValue.mainRoot, "link.js");
      fs.symlinkSync("product.js", link);
      execFileSync("git", ["add", "link.js"], { cwd: linkValue.mainRoot });
      execFileSync("git", ["commit", "-q", "-m", "tracked link"], { cwd: linkValue.mainRoot });
      const request = linkValue.coordinator.createRequest({
        ctx: linkValue.ctx, state: linkValue.flowManager.load(), invocation: linkValue.invocation,
      });
      fs.unlinkSync(link);
      fs.symlinkSync("other.js", link);
      const manifest = captureManifest(request);
      assert.equal(manifest.mutations[0].changeKind, "content");
    } finally {
      removeTmpDir(linkValue.mainRoot);
    }

    const typeValue = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(typeValue);
      const link = path.join(typeValue.mainRoot, "link.js");
      fs.symlinkSync("product.js", link);
      execFileSync("git", ["add", "link.js"], { cwd: typeValue.mainRoot });
      execFileSync("git", ["commit", "-q", "-m", "tracked link"], { cwd: typeValue.mainRoot });
      const request = typeValue.coordinator.createRequest({
        ctx: typeValue.ctx, state: typeValue.flowManager.load(), invocation: typeValue.invocation,
      });
      fs.unlinkSync(link);
      fs.writeFileSync(link, "export const replacement = true;\n");
      const manifest = captureManifest(request);
      assert.equal(manifest.mutations[0].changeKind, "type");
    } finally {
      removeTmpDir(typeValue.mainRoot);
    }
  });

  it("retains a tracked file-to-directory type change in the source mutation manifest", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const product = path.join(value.mainRoot, "product.js");
      const request = value.coordinator.createRequest({
        ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      fs.unlinkSync(product);
      fs.mkdirSync(product);
      fs.writeFileSync(path.join(product, "nested.js"), "export const nested = true;\n");
      const manifest = captureManifest(request);
      assert.deepEqual(
        manifest.mutations.map((entry) => ({ path: entry.path, changeKind: entry.changeKind })),
        [
          { path: "product.js", changeKind: "type" },
          { path: "product.js/nested.js", changeKind: "added" },
        ],
      );
      fs.writeFileSync(request.payloadPath("effects.json"), json(implementationEffect(
        request,
        manifest.paths(),
      ).toJSON()));
      seal(request);
      assert.equal(value.coordinator.reconcile({
        ctx: value.ctx,
        request,
        mutationAuthority: authority,
      }).completed, true);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("fails closed when a dirty Git directory cannot be fingerprinted at the Attempt baseline", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const product = path.join(value.mainRoot, "product.js");
      fs.unlinkSync(product);
      fs.mkdirSync(product);
      fs.writeFileSync(path.join(product, "nested.js"), "export const nested = true;\n");
      assert.throws(
        () => value.coordinator.createRequest({
          ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation,
        }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_UNAVAILABLE"
          && error.data.paths.includes("product.js"),
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("does not fall back to a filesystem scan when a valid Git root cannot read its index", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      fs.writeFileSync(path.join(value.mainRoot, ".git", "index"), "not a Git index\n");

      assert.throws(
        () => WorkerArtifactMutationAuthoritySnapshot.capture(
          value.coordinator.createRequest({
            ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation,
          }),
        ),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_UNAVAILABLE",
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("fails closed when Git status contains an invalid UTF-8 path", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const invalidPath = Buffer.concat([
        Buffer.from(`${value.mainRoot}${path.sep}invalid-`, "utf8"),
        Buffer.from([0xff]),
        Buffer.from(".txt", "utf8"),
      ]);
      fs.writeFileSync(invalidPath, "invalid path bytes\n");

      assert.throws(
        () => value.coordinator.createRequest({
          ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation,
        }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_UNAVAILABLE"
          && error.cause?.code === "GIT_STATUS_PORCELAIN_V2_INVALID",
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("recovers current index entries when dirty source changes are restored during the Attempt", () => {
    const contentValue = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(contentValue);
      const product = path.join(contentValue.mainRoot, "product.js");
      fs.writeFileSync(product, "export const value = 0;\n");
      const request = contentValue.coordinator.createRequest({
        ctx: contentValue.ctx, state: contentValue.flowManager.load(), invocation: contentValue.invocation,
      });
      fs.writeFileSync(product, "export const value = 1;\n");
      const manifest = captureManifest(request);
      assert.equal(manifest.mutations[0].changeKind, "content");
      assert.match(manifest.mutations[0].afterDigest, /^[a-f0-9]{64}$/);
    } finally {
      removeTmpDir(contentValue.mainRoot);
    }

    const deletedValue = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(deletedValue);
      const product = path.join(deletedValue.mainRoot, "product.js");
      fs.unlinkSync(product);
      const request = deletedValue.coordinator.createRequest({
        ctx: deletedValue.ctx, state: deletedValue.flowManager.load(), invocation: deletedValue.invocation,
      });
      fs.writeFileSync(product, "export const value = 1;\n");
      const manifest = captureManifest(request);
      assert.equal(manifest.mutations[0].changeKind, "added");
      assert.match(manifest.mutations[0].afterDigest, /^[a-f0-9]{64}$/);
    } finally {
      removeTmpDir(deletedValue.mainRoot);
    }
  });

  it("rejects a manifest that becomes stale after sealing and before parent reconciliation", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const product = path.join(value.mainRoot, "product.js");
      const request = value.coordinator.createRequest({ ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      fs.writeFileSync(product, "export const value = 2;\n");
      captureManifest(request);
      fs.writeFileSync(request.payloadPath("effects.json"), json(implementationEffect(request, ["product.js"]).toJSON()));
      seal(request);
      fs.writeFileSync(product, "export const value = 3;\n");
      assert.throws(
        () => value.coordinator.reconcile({ ctx: value.ctx, request, mutationAuthority: authority }),
        (error) => error instanceof WorkerArtifactHandoffError && error.code === "FLOW_SOURCE_HANDOFF_MANIFEST_STALE",
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects a mutation ID minted for another Attempt", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const product = path.join(value.mainRoot, "product.js");
      const request = value.coordinator.createRequest({ ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      fs.writeFileSync(product, "export const value = 2;\n");
      captureManifest(request);
      const otherAttemptId = SourceMutationManifest.mutationId({ id: "another-attempt", nodeId: "implement", sequence: 2 }, "product.js");
      fs.writeFileSync(request.payloadPath("effects.json"), json(new SourceWorkerEffect({
        version: 1, stepId: "implement", completionStatus: "done",
        files: [{ requirementId: "R1", mutationIds: [otherAttemptId] }], issues: [], overview: null, triage: null, repair: null,
      }).toJSON()));
      seal(request);
      assert.throws(
        () => value.coordinator.reconcile({ ctx: value.ctx, request, mutationAuthority: authority }),
        (error) => error instanceof WorkerArtifactHandoffError && error.code === "FLOW_SOURCE_HANDOFF_EFFECT_MUTATION_INVALID",
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects a non-metric canonical Activity during a source handoff", () => {
    const value = fixture("implement", { specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      fs.writeFileSync(request.payloadPath("effects.json"), json(implementationEffect(request, ["product.js"]).toJSON()));
      fs.writeFileSync(path.join(value.executionRoot, "product.js"), "export const value = 2;\n");
      seal(request);
      value.flowManager.addNote("source worker must not alter canonical observations");

      assert.throws(
        () => value.coordinator.reconcile({ ctx: value.ctx, request, mutationAuthority: authority }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.classification === "invalid"
          && error.code === "FLOW_SOURCE_HANDOFF_CANONICAL_MUTATION_INVALID",
      );
      assert.equal(findStepById(value.flowManager.load().steps, "implement").status, "in_progress");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects a direct canonical file mutation during a source handoff", () => {
    const value = fixture("implement", { specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      fs.writeFileSync(request.payloadPath("effects.json"), json(implementationEffect(request, ["product.js"]).toJSON()));
      fs.writeFileSync(path.join(value.executionRoot, "product.js"), "export const value = 2;\n");
      seal(request);
      fs.writeFileSync(path.join(canonicalSpecDir(value), "worker-direct-mutation.json"), "{}\n");

      assert.throws(
        () => value.coordinator.reconcile({ ctx: value.ctx, request, mutationAuthority: authority }),
        (error) => error instanceof WorkerArtifactHandoffError && error.classification === "invalid",
      );
      fs.unlinkSync(path.join(canonicalSpecDir(value), "worker-direct-mutation.json"));
      assert.equal(findStepById(value.flowManager.load().steps, "implement").status, "in_progress");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects a corrupted canonical Activity ledger during a source handoff", () => {
    const value = fixture("implement", { specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      fs.writeFileSync(request.payloadPath("effects.json"), json(implementationEffect(request, ["product.js"]).toJSON()));
      fs.writeFileSync(path.join(value.executionRoot, "product.js"), "export const value = 2;\n");
      seal(request);
      const activitiesPath = value.flowManager.specLocation(value.specId).activitiesFile;
      const originalActivities = fs.readFileSync(activitiesPath);
      fs.writeFileSync(
        activitiesPath,
        originalActivities.toString("utf8").replace('"confirmationOrder":2', '"confirmationOrder":99'),
      );

      assert.throws(
        () => value.coordinator.reconcile({ ctx: value.ctx, request, mutationAuthority: authority }),
        (error) => error instanceof WorkerArtifactHandoffError && error.classification === "invalid",
      );
      fs.writeFileSync(activitiesPath, originalActivities);
      assert.equal(findStepById(value.flowManager.load().steps, "implement").status, "in_progress");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("restores rejected source mutations without changing the invocation baseline", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const clean = path.join(value.mainRoot, "clean.js");
      const deleted = path.join(value.mainRoot, "deleted.js");
      const link = path.join(value.mainRoot, "link.js");
      const dirtyDeleted = path.join(value.mainRoot, "dirty-deleted.js");
      const untracked = path.join(value.mainRoot, "preexisting.txt");
      fs.writeFileSync(clean, "export const clean = 1;\n");
      fs.writeFileSync(deleted, "export const deleted = 1;\n");
      fs.writeFileSync(link, "clean.js");
      fs.unlinkSync(link);
      fs.symlinkSync("clean.js", link);
      fs.writeFileSync(dirtyDeleted, "export const removed = 1;\n");
      execFileSync("git", ["add", "clean.js", "deleted.js", "link.js", "dirty-deleted.js"], { cwd: value.mainRoot });
      execFileSync("git", ["commit", "-q", "-m", "rollback baseline"], { cwd: value.mainRoot });
      fs.writeFileSync(path.join(value.mainRoot, "product.js"), "export const value = 0;\n");
      fs.unlinkSync(link);
      fs.symlinkSync("product.js", link);
      fs.unlinkSync(dirtyDeleted);
      fs.writeFileSync(untracked, "before\n");

      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      fs.writeFileSync(clean, "export const clean = 2;\n");
      fs.unlinkSync(deleted);
      fs.unlinkSync(link);
      fs.symlinkSync("clean.js", link);
      fs.writeFileSync(path.join(value.mainRoot, "new-untracked.js"), "export const created = true;\n");
      fs.symlinkSync("clean.js", path.join(value.mainRoot, "new-link.js"));
      fs.writeFileSync(path.join(value.mainRoot, "product.js"), "export const value = 1;\n");
      fs.writeFileSync(untracked, "after\n");
      fs.writeFileSync(dirtyDeleted, "export const removed = 1;\n");

      authority.rollbackRejectedSourceMutation();

      assert.equal(fs.readFileSync(clean, "utf8"), "export const clean = 1;\n");
      assert.equal(fs.readFileSync(deleted, "utf8"), "export const deleted = 1;\n");
      assert.equal(fs.readlinkSync(link), "product.js");
      assert.equal(fs.readFileSync(path.join(value.mainRoot, "product.js"), "utf8"), "export const value = 0;\n");
      assert.equal(fs.readFileSync(untracked, "utf8"), "before\n");
      assert.equal(fs.existsSync(dirtyDeleted), false);
      assert.equal(fs.existsSync(path.join(value.mainRoot, "new-untracked.js")), false);
      assert.equal(fs.existsSync(path.join(value.mainRoot, "new-link.js")), false);
      const executionSnapshot = authority.repositories.find((entry) => entry.authorities.includes("execution"));
      assert.deepEqual(
        executionSnapshot.allChangedPaths(executionSnapshot.constructor.capture(executionSnapshot)),
        [],
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("cleans a rejected source handoff so a retry observes only its own diff", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const product = path.join(value.mainRoot, "product.js");
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      fs.writeFileSync(request.payloadPath("effects.json"), json(implementationEffect(request, ["product.js", "absent.js"]).toJSON()));
      fs.writeFileSync(product, "export const value = 2;\n");
      seal(request);
      let rejection = null;
      try {
        value.coordinator.reconcile({ ctx: value.ctx, request, mutationAuthority: authority });
      } catch (error) {
        rejection = error;
      }
      assert.ok(rejection instanceof WorkerArtifactHandoffError
        && rejection.code === "FLOW_SOURCE_HANDOFF_EFFECT_MUTATION_INVALID");
      const plan = rejectedSourcePlan(request, rejection);
      assert.equal(plan.disposition, "rollback");
      assert.ok(value.coordinator.recordSourceFailure({ ctx: value.ctx, request, plan }));

      assert.equal(value.coordinator.rollbackRejectedSourceHandoff({
        ctx: value.ctx,
        request,
        mutationAuthority: authority,
        plan,
      }), true);
      assert.equal(fs.readFileSync(product, "utf8"), "export const value = 1;\n");
      assert.equal(fs.existsSync(request.directory), false);

      const retryRequest = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: { ...value.invocation, id: "dispatch-worker-handoff-retry" },
      });
      const retryAuthority = WorkerArtifactMutationAuthoritySnapshot.capture(retryRequest);
      fs.writeFileSync(product, "export const value = 2;\n");
      const retryManifest = captureManifest(retryRequest);
      const retryEffect = implementationEffect(retryRequest, ["product.js"]);
      const firstValidation = retryAuthority.assertSourceDiff({
        policy: retryRequest.policy,
        completionStatus: "done",
        effect: retryEffect,
        manifest: retryManifest,
      });
      fs.unlinkSync(retryRequest.sourceMutationManifestPath);
      const replayManifest = captureManifest(retryRequest);
      assert.deepEqual(replayManifest.toJSON(), retryManifest.toJSON());
      assert.deepEqual(retryAuthority.assertSourceDiff({
        policy: retryRequest.policy,
        completionStatus: "done",
        effect: retryEffect,
        manifest: replayManifest,
      }), firstValidation);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("confirms a new file-map handoff against a canonical Spec that retains retired statuses", () => {
    const specRecord = validSpec();
    specRecord.requirements = specRecord.requirements.map((requirement) => ({
      ...requirement,
      status: "pending",
    }));
    const value = fixture("implement", { worktree: false, specRecord });
    try {
      initializeGitRepository(value);
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      fs.writeFileSync(request.payloadPath("effects.json"), json(implementationEffect(request, ["product.js"]).toJSON()));
      fs.writeFileSync(path.join(value.mainRoot, "product.js"), "export const value = 2;\n");
      seal(request);

      value.coordinator.reconcile({ ctx: value.ctx, request, mutationAuthority: authority });

      assert.deepEqual(readCatalogJson(value, "file.map", "impl-review"), { R1: ["product.js"] });
      assert.equal(findStepById(value.flowManager.load().steps, "implement").status, "done");
      const canonicalSpec = readCatalogJson(value, "spec.record", "impl-review");
      assert.equal(Object.hasOwn(canonicalSpec.requirements[0], "status"), false);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("does not roll back source changes after canonical confirmation succeeds", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      fs.writeFileSync(request.payloadPath("effects.json"), json(implementationEffect(request, ["product.js"]).toJSON()));
      fs.writeFileSync(path.join(value.mainRoot, "product.js"), "export const value = 2;\n");
      seal(request);
      const interrupted = new WorkerArtifactHandoffCoordinator({
        faultInjector({ phase }) {
          if (phase === "before-worker-handoff-cleanup-rename") throw new Error("simulated cleanup interruption");
        },
      });
      assert.throws(
        () => interrupted.reconcile({ ctx: value.ctx, request, mutationAuthority: authority }),
        (error) => error instanceof WorkerArtifactHandoffError && error.code === "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED",
      );
      assert.equal(interrupted.rollbackRejectedSourceHandoff({
        ctx: value.ctx,
        request,
        mutationAuthority: authority,
      }), false);
      assert.equal(fs.readFileSync(path.join(value.mainRoot, "product.js"), "utf8"), "export const value = 2;\n");
      assert.equal(fs.existsSync(request.directory), true);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("fails closed without cleaning a rejected source handoff after index mutation", () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      fs.writeFileSync(request.payloadPath("effects.json"), json(implementationEffect(request, ["product.js", "absent.js"]).toJSON()));
      fs.writeFileSync(path.join(value.mainRoot, "product.js"), "export const value = 2;\n");
      execFileSync("git", ["add", "product.js"], { cwd: value.mainRoot });
      assert.throws(
        () => seal(request),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_SOURCE_HANDOFF_FINALIZE_AUTHORITY_VIOLATION",
      );
      const plan = rejectedSourcePlan(request, new WorkerArtifactHandoffError(
        "invalid", "FLOW_SOURCE_HANDOFF_FINALIZE_AUTHORITY_VIOLATION", "source was staged before worker exit",
      ), { workerStopped: false });
      assert.equal(plan.disposition, "quarantine");
      assert.equal(value.coordinator.rollbackRejectedSourceHandoff({
        ctx: value.ctx, request, mutationAuthority: authority, plan,
      }), false);
      assert.equal(fs.existsSync(request.directory), true);
      assert.equal(fs.readFileSync(path.join(value.mainRoot, "product.js"), "utf8"), "export const value = 2;\n");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rolls back and cleans an invalid source handoff through the dispatcher", async () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const action = {
        taskId: null,
        step: "implement",
        action: "implement-source",
        instructions: { key: "plan.implement", content: "Implement the source change." },
        context: { workerArtifactHandoff: { required: true } },
        output_schema: sourceWorkerEffectJsonSchema("implement"),
        requires_approval: false,
        maxAttempts: 1,
        directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "implement-source" },
      };
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() { return structuredClone(action); } },
        agent: {
          async call(_prompt, options) {
            fs.writeFileSync(path.join(value.mainRoot, "product.js"), "export const value = 2;\n");
            return json({
              ...sourceWorkerReport("implement"),
              files: [{ requirementId: "R1", paths: ["product.js", "absent.js"] }],
            });
          },
        },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(),
        expectRunId: "run-worker-handoff",
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });
      assert.equal(result.errors[0].code, "FLOW_SOURCE_HANDOFF_RESPONSE_INVALID");
      assert.equal(fs.readFileSync(path.join(value.mainRoot, "product.js"), "utf8"), "export const value = 1;\n");
      assert.equal(fs.existsSync(executionHandoffRoot(value)), false);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("retries a source provider failure once and preserves its rollback boundary", async () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const action = {
        taskId: null,
        step: "implement",
        action: "implement-source",
        instructions: { key: "plan.implement", content: "Implement the source change." },
        context: { workerArtifactHandoff: { required: true } },
        output_schema: sourceWorkerEffectJsonSchema("implement"),
        requires_approval: false,
        maxAttempts: 1,
        directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "implement-source" },
      };
      let calls = 0;
      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run() {
            return findStepById(value.flowManager.load().steps, "implement").status === "done"
              ? completedWorkerAction()
              : structuredClone(action);
          },
        },
        agent: {
          async call(_prompt, options) {
            calls += 1;
            fs.writeFileSync(path.join(value.mainRoot, "product.js"), "export const value = 2;\n");
            if (calls === 1) {
              throw new AgentTimeoutFailure({ message: "provider timed out before structured response" });
            }
            return json(sourceWorkerReport("implement"));
          },
        },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(),
        expectRunId: value.flowManager.load().runId,
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(result.dispatch.boundary, "completed", JSON.stringify(result));
      assert.equal(calls, 2);
      assert.equal(findStepById(value.flowManager.load().steps, "implement").status, "done");
      assert.equal(fs.readFileSync(path.join(value.mainRoot, "product.js"), "utf8"), "export const value = 2;\n");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rolls back a malformed structured source response without completing the Flow", async () => {
    const value = fixture("implement", { worktree: false, specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const action = {
        taskId: null,
        step: "implement",
        action: "implement-source",
        instructions: { key: "plan.implement", content: "Implement the source change." },
        context: { workerArtifactHandoff: { required: true } },
        output_schema: sourceWorkerEffectJsonSchema("implement"),
        requires_approval: false,
        maxAttempts: 1,
        directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "implement-source" },
      };
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() { return structuredClone(action); } },
        agent: {
          async call(_prompt, options) {
            fs.writeFileSync(path.join(value.mainRoot, "product.js"), "export const value = 2;\n");
            return "{ malformed";
          },
        },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(),
        expectRunId: value.flowManager.load().runId,
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(result.errors[0].code, "FLOW_SOURCE_HANDOFF_RESPONSE_INVALID");
      assert.equal(findStepById(value.flowManager.load().steps, "implement").status, "in_progress");
      assert.equal(fs.readFileSync(path.join(value.mainRoot, "product.js"), "utf8"), "export const value = 1;\n");
      assert.equal(fs.existsSync(executionHandoffRoot(value)), false);
      assert.equal(value.flowManager.readArtifact({
        specId: value.specId,
        logicalKey: "file.map",
        consumerNodeId: "impl-gate",
        optional: true,
      }), null);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("publishes the second bootstrap-invalid test handoff for scenario-validity", async () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      const action = {
        taskId: null,
        step: "test",
        action: "write-tests",
        instructions: { key: "plan.test", content: "Write the spec tests." },
        context: { workerArtifactHandoff: { required: true } },
        output_schema: {},
        requires_approval: false,
        maxAttempts: 1,
        directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "write-tests" },
      };
      let calls = 0;
      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run() {
            return calls < 2 ? structuredClone(action) : {
              taskId: null,
              step: null,
              action: "completed",
              instructions: null,
              context: null,
              output_schema: null,
              requires_approval: false,
              directive: { kind: "completed", terminal: true, requiresUserAction: false },
            };
          },
        },
        agent: {
          async call(_prompt, options) {
            calls += 1;
            const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
            const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
            const tests = request.payloads.find((entry) => entry.logicalName === "spec-tests").payloadPath;
            fs.writeFileSync(
              path.join(tests, `future-${calls}.test.js`),
              "// spec: R1\nimport test from 'node:test';\nimport value from '../../../src/not-yet-implemented.js';\ntest('R1: future module', () => value);\n",
            );
            sealWorkerArtifactHandoff({
              requestPath,
              invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
            });
          },
        },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(),
        expectRunId: "run-worker-handoff",
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(result.dispatch?.boundary, "completed", JSON.stringify(result));
      assert.equal(calls, 2);
      const state = value.flowManager.load();
      assert.equal(findStepById(state.steps, "test").status, "done");
      assert.match(findStepById(state.steps, "test").result.summary, /deferred to scenario validity/);
      assert.equal(value.flowManager.artifactCatalog(value.specId).artifacts
        .some((entry) => entry.relativePath === "artifacts/tests/future-1.test.js"), false);
      assert.equal(value.flowManager.artifactCatalog(value.specId).artifacts
        .some((entry) => entry.relativePath === "artifacts/tests/future-2.test.js"), true);
      const observation = readCanonicalSpecTestBootstrapObservation({
        flowManager: value.flowManager,
        specId: value.specId,
        consumerNodeId: "scenario-validity",
      });
      assert.notEqual(observation, null);
      assert.equal(observation.deferred, true);
      assert.equal(observation.issues.length, 1);
      assert.deepEqual(observation.issues[0].toJSON(), {
        relativeTestFile: "future-2.test.js",
        specifier: "../../../src/not-yet-implemented.js",
        line: 3,
        expectedPath: "specs/500-worker-handoff/src/not-yet-implemented.js",
      });
      assert.equal(
        readCanonicalSpecTestBootstrapObservation({
          flowManager: value.flowManager,
          specId: value.specId,
          consumerNodeId: "test-review",
        }).issues[0].toString(),
        "future-2.test.js:3 statically imports missing pre-implementation module ../../../src/not-yet-implemented.js (specs/500-worker-handoff/src/not-yet-implemented.js)",
      );
      assert.equal(findStepById(state.steps, "test").result.artifactRefs
        .some((reference) => reference.kind === "test-bootstrap-observation"), true);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("allows an artifact-worker upgrade dry-run but rejects materialization before checkout mutation", () => {
    const value = fixture("draft");
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      assert.equal(assertWorkerUpgradeAllowed({ requestPath: request.requestPath, dryRun: true }), null);
      assert.throws(
        () => assertWorkerUpgradeAllowed({ requestPath: request.requestPath, dryRun: false }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_WORKER_UPGRADE_SOURCE_AUTHORITY_REQUIRED",
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects directly staged dry-run upgrade evidence before a source handoff can publish it", () => {
    const value = fixture("implement", { specRecord: validSpec() });
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      const effect = implementationEffect(request, ["product.js"]);
      fs.writeFileSync(request.payloadPath("effects.json"), json(effect.toJSON()));
      fs.writeFileSync(request.payloadPath("upgrade.result"), json({
        version: 1,
        command: "sennel upgrade --dry-run",
        dryRun: true,
        exitCode: 0,
        result: "success-no-change",
        summary: { skills: { updated: 0, unchanged: 1, removed: 0 } },
        failureReason: null,
        checkedPaths: [],
      }));
      fs.writeFileSync(path.join(value.executionRoot, "product.js"), "export const upgraded = true;\n");
      seal(request);

      assert.throws(
        () => value.coordinator.reconcile({ ctx: value.ctx, request, mutationAuthority: authority }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_WORKER_UPGRADE_RESULT_INVALID",
      );
      assert.equal(value.flowManager.readArtifact({
        specId: value.specId,
        logicalKey: "upgrade.result",
        consumerNodeId: "impl-gate",
        optional: true,
      }), null);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("marks malformed optional upgrade evidence as transport-retryable while keeping schema failures terminal", () => {
    const value = fixture("implement", { specRecord: validSpec() });
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const effect = implementationEffect(request, ["product.js"]);
      fs.writeFileSync(request.payloadPath("effects.json"), json(effect.toJSON()));
      fs.writeFileSync(request.payloadPath("upgrade.result"), "{ malformed upgrade result\n");
      fs.writeFileSync(path.join(value.executionRoot, "product.js"), "export const upgraded = true;\n");
      assert.throws(
        () => seal(request),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_ARTIFACT_HANDOFF_INVALID"
          && error.retryable === true,
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("quarantines an unsafe sealed artifact handoff before recovery can replay it", () => {
    const value = fixture("draft");
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(request.payloadPath("draft.json"), json(draftDocument("sealed but unsafe")));
      seal(request);
      value.coordinator.quarantine({
        request,
        error: new WorkerArtifactHandoffError(
          "invalid",
          "FLOW_ARTIFACT_HANDOFF_AUTHORITY_VIOLATION",
          "repository changed outside the handoff authority",
        ),
      });

      assert.throws(
        () => value.coordinator.recoverPending({ ctx: value.ctx }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_ARTIFACT_HANDOFF_QUARANTINED"
          && error.classification === "invalid"
          && error.recoveryPossible === false,
      );
      assert.equal(fs.existsSync(request.quarantinePath), true);
      assert.equal(value.flowManager.readArtifact({
        specId: value.specId,
        logicalKey: "draft",
        consumerNodeId: "draft-questions-review",
        optional: true,
      }), null, "recovery must not publish a quarantined canonical artifact");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("blocks recovery when quarantine persistence is obstructed", () => {
    const value = fixture("draft");
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(request.payloadPath("draft.json"), json(draftDocument("reject without a receipt")));
      seal(request);
      fs.mkdirSync(request.quarantinePath);
      assert.throws(
        () => value.coordinator.quarantine({
          request,
          error: new WorkerArtifactHandoffError(
            "invalid",
            "FLOW_ARTIFACT_HANDOFF_AUTHORITY_VIOLATION",
            "unsafe mutation rejected by the parent",
          ),
        }),
      );
      assert.throws(
        () => value.coordinator.recoverPending({ ctx: value.ctx }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_ARTIFACT_HANDOFF_QUARANTINE_INVALID"
          && error.recoveryPossible === false,
      );
      assert.equal(fs.lstatSync(request.quarantinePath).isDirectory(), true);
      assert.equal(value.flowManager.readArtifact({
        specId: value.specId,
        logicalKey: "draft",
        consumerNodeId: "draft-questions-review",
        optional: true,
      }), null);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("discards a parent-validated artifact handoff after a pre-commit interruption", () => {
    const value = fixture("draft");
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(request.payloadPath("draft.json"), json(draftDocument("accepted before crash")));
      seal(request);
      const crashing = new WorkerArtifactHandoffCoordinator({
        faultInjector({ phase }) {
          if (phase === "before-worker-handoff-publication") throw new Error("simulated pre-commit crash");
        },
      });
      assert.throws(
        () => crashing.reconcile({ ctx: value.ctx, request }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED",
      );

      const recovered = value.coordinator.recoverPending({ ctx: value.ctx });
      assert.equal(recovered.completed, true);
      assert.equal(recovered.cleanedHandoffs, 1);
      assert.equal(value.flowManager.readArtifact({
        specId: value.specId,
        logicalKey: "draft",
        consumerNodeId: "draft-questions-review",
        optional: true,
      }), null, "recovery must not publish an artifact without a committed parent confirmation");
      assert.equal(fs.existsSync(request.directory), false);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("accepts only a sealed typed source effect with task overview additions", () => {
    const effect = SourceWorkerEffect.fromDocument({
      version: 1,
      stepId: "task-impl",
      completionStatus: "done",
      files: [],
      issues: [],
      overview: { modules: [], data_flow: [], decisions: [] },
      triage: null,
      repair: null,
      noChangeReason: "No source mutation was required for this Task.",
    }, "task-impl");
    assert.deepEqual(effect.toJSON().overview, { modules: [], data_flow: [], decisions: [] });
    assert.throws(() => SourceWorkerEffect.fromDocument({
      version: 1,
      stepId: "task-impl",
      completionStatus: "done",
      files: [],
      issues: [],
      overview: null,
      triage: null,
      repair: null,
      noChangeReason: "No source mutation was required for this Task.",
    }, "task-impl"), /requires overview/);
  });

  it("uses the step-specific structured source schema before parent materialization", () => {
    const valid = {
      version: 1,
      stepId: "task-impl",
      completionStatus: "done",
      issues: [],
      overview: { modules: ["Module ownership is explicit."], data_flow: [], decisions: [] },
      triage: null,
      repair: null,
      noChangeReason: "No source mutation was required for this Task.",
    };
    assert.deepEqual(validateSchema(valid, sourceWorkerEffectJsonSchema("task-impl")), []);
    assert.doesNotThrow(() => SourceWorkerEffectReport.fromDocument(valid, "task-impl"));

    const objectOverview = structuredClone(valid);
    objectOverview.overview.modules = [{ text: "Worker must not choose canonical ownership." }];
    assert.notDeepEqual(validateSchema(objectOverview, sourceWorkerEffectJsonSchema("task-impl")), []);
    assert.throws(() => SourceWorkerEffectReport.fromDocument(objectOverview, "task-impl"), /must be a string/);

    const oversizedOverview = structuredClone(valid);
    oversizedOverview.overview.modules = Array.from({ length: 51 }, () => "Overview item");
    assert.notDeepEqual(validateSchema(oversizedOverview, sourceWorkerEffectJsonSchema("task-impl")), []);
    assert.throws(() => SourceWorkerEffectReport.fromDocument(oversizedOverview, "task-impl"), /upper bound/);
  });

  it("round-trips every source effect class through its structured response schema", () => {
    const common = { version: 1, completionStatus: "done", issues: [], noChangeReason: null };
    const documents = {
      implement: { ...common, stepId: "implement", overview: null, triage: null, repair: null },
      "impl-triage": {
        ...common, stepId: "impl-triage", overview: null, repair: null,
        triage: { version: 1, dispositions: [{ findingKey: "F1", disposition: "apply", basis: "repair-required", rationale: "The finding requires a correction." }] },
      },
      "impl-repair": {
        ...common,
        stepId: "impl-repair",
        overview: null,
        triage: null,
        repair: { version: 1, findings: [{ findingKey: "F1", paths: ["product.js"] }], summary: "Applied the reviewed correction.", recurrenceResolutions: [] },
      },
      "task-repair": {
        ...common,
        stepId: "task-repair",
        overview: null,
        triage: null,
        repair: { version: 1, findings: [{ findingKey: "F1", paths: ["product.js"] }], summary: "Applied the reviewed correction.", recurrenceResolutions: [] },
      },
      "task-impl": {
        ...common, stepId: "task-impl", overview: { modules: [], data_flow: [], decisions: [] }, triage: null, repair: null,
      },
    };
    for (const [stepId, document] of Object.entries(documents)) {
      const report = SourceWorkerEffectReport.fromDocument(document, stepId);
      assert.deepEqual(validateSchema(report.toJSON(), sourceWorkerEffectJsonSchema(stepId)), [], stepId);
    }
  });

  it("requires an explicit non-null recurrence resolution array in repair responses", () => {
    for (const stepId of ["impl-repair", "task-repair"]) {
      const document = {
        version: 1,
        stepId,
        completionStatus: "done",
        issues: [],
        overview: null,
        triage: null,
        repair: {
          version: 1,
          findings: [{ findingKey: "F1", paths: ["product.js"] }],
          summary: "Applied the reviewed correction.",
          recurrenceResolutions: [],
        },
        noChangeReason: null,
      };
      const schema = sourceWorkerEffectJsonSchema(stepId);
      const providerSchema = adaptJsonSchemaForProvider("codex", schema);
      assert.ok(schema.properties.repair.required.includes("recurrenceResolutions"), stepId);
      assert.ok(providerSchema.properties.repair.required.includes("recurrenceResolutions"), stepId);
      assert.equal(providerSchema.properties.repair.properties.recurrenceResolutions.type, "array", stepId);
      assert.deepEqual(validateSchema(document, schema), [], stepId);
      assert.deepEqual(SourceWorkerEffectReport.fromDocument(document, stepId).repair.toJSON(), document.repair, stepId);

      const nullResolutions = structuredClone(document);
      nullResolutions.repair.recurrenceResolutions = null;
      assert.notDeepEqual(validateSchema(nullResolutions, schema), [], `${stepId} rejects null`);
      assert.throws(
        () => SourceWorkerEffectReport.fromDocument(nullResolutions, stepId),
        /recurrence resolutions are invalid/,
      );
    }
  });

  it("applies the shared semantic triage contract to every canonical finding", () => {
    const findings = [
      { findingKey: "F1", disposition: "must-fix" },
      { findingKey: "F2", disposition: "informational" },
      { findingKey: "F3", disposition: "deferred" },
    ];
    const decision = (findingKey, disposition, basis) => ({
      findingKey,
      disposition,
      basis,
      rationale: "Canonical evidence supports this exact triage decision.",
    });
    const valid = new SourceTriageEffect({
      version: 1,
      dispositions: [
        decision("F1", "reject", "already-satisfied"),
        decision("F2", "reject", "not-applicable"),
        decision("F3", "reject", "not-applicable"),
      ],
    });
    assert.strictEqual(valid.assertCanonicalFindings(findings), valid);
    assert.throws(
      () => new SourceTriageEffect({ version: 1, dispositions: valid.toJSON().dispositions.slice(0, 2) })
        .assertCanonicalFindings(findings),
      /exactly once/,
    );
    assert.throws(
      () => new SourceTriageEffect({
        version: 1,
        dispositions: [
          decision("F1", "apply", "repair-required"),
          decision("F2", "apply", "repair-required"),
          decision("F3", "reject", "not-applicable"),
        ],
      }).assertCanonicalFindings(findings),
      /must be rejected as not-applicable/,
    );
    assert.throws(
      () => new SourceTriageEffect({
        version: 1,
        dispositions: [
          decision("F1", "reject", "approved-exception"),
          decision("F2", "reject", "not-applicable"),
          decision("F3", "reject", "not-applicable"),
        ],
      }).assertCanonicalFindings(findings),
      /lacks approved exception authority/,
    );
    const guardrailId = "guardrail-with-exception";
    const approvedExceptions = ApprovedFindingExceptionSet.fromCanonical({
      spec: {
        constraints: [`${guardrailId}: This intentionally accepted tradeoff is documented in canonical spec authority.`],
      },
      guardrails: [{
        id: guardrailId,
        body: "Acknowledged-exception handling: canonical spec rationale may authorize this exception.",
      }],
    });
    const approvedDecision = new SourceTriageEffect({
      version: 1,
      dispositions: [decision("F4", "reject", "approved-exception")],
    });
    assert.throws(
      () => approvedDecision.assertCanonicalFindings(
        [{ findingKey: "F4", guardrailId, disposition: "must-fix" }],
        { approvedExceptions: { allows: () => true } },
      ),
      /typed canonical authority/,
    );
    assert.strictEqual(approvedDecision.assertCanonicalFindings(
      [{ findingKey: "F4", guardrailId, disposition: "must-fix" }],
      { approvedExceptions },
    ), approvedDecision);
  });

  it("preserves a recurring implementation repair rationale and distinct strategy", () => {
    const document = {
      version: 1, stepId: "impl-repair", completionStatus: "done",
      issues: [], overview: null, triage: null, noChangeReason: null,
      repair: {
        version: 1, findings: [{ findingKey: "F1", paths: ["product.js"] }], summary: "Applied the reviewed correction with an additional boundary check.",
        recurrenceResolutions: [{
          findingKey: "F1",
          fingerprint: "a".repeat(64),
          priorRepairInsufficiency: "The earlier change covered only the direct branch and missed its caller.",
          repairStrategy: "Validate the shared boundary before both callers reach the branch.",
        }],
      },
    };
    assert.deepEqual(validateSchema(document, sourceWorkerEffectJsonSchema("impl-repair")), []);
    const repair = SourceWorkerEffectReport.fromDocument(document, "impl-repair").repair;
    assert.deepEqual(repair.toJSON(), document.repair);
    const recurrence = { entries: [{ findingKey: "F1", fingerprint: "a".repeat(64) }] };
    assert.strictEqual(repair.assertRecurrenceResolutions(recurrence), repair);
    assert.throws(
      () => repair.assertRecurrenceResolutions({ entries: [] }),
      /must exactly match canonical recurrence context/,
    );
    const ordinaryRepair = SourceWorkerEffectReport.fromDocument({
      ...document,
      repair: {
        version: 1,
        findings: [{ findingKey: "F1", paths: ["product.js"] }],
        summary: "Applied a first-occurrence implementation repair.",
        recurrenceResolutions: [],
      },
    }, "impl-repair").repair;
    assert.throws(
      () => ordinaryRepair.assertRecurrenceResolutions(recurrence),
      /must exactly match canonical recurrence context/,
    );
    const mixedTriageRepair = SourceWorkerEffectReport.fromDocument({
      ...document,
      repair: {
        ...document.repair,
        findings: [{ findingKey: "F1", paths: ["product.js"] }],
        recurrenceResolutions: [{
          ...document.repair.recurrenceResolutions[0],
          findingKey: "F2",
          fingerprint: "b".repeat(64),
        }],
      },
    }, "impl-repair").repair;
    assert.throws(
      () => mixedTriageRepair.assertRecurrenceResolutions({
        entries: [
          { findingKey: "F1", fingerprint: "a".repeat(64) },
          { findingKey: "F2", fingerprint: "b".repeat(64) },
        ],
      }),
      /must exactly match canonical recurrence context/,
      "a triage-rejected recurring finding is neither a repair obligation nor a valid resolution",
    );
  });

  it("binds finding repairs to parent-observed mutations across many-to-many path claims", () => {
    const attempt = { id: "impl-repair-attempt", nodeId: "impl-repair", sequence: 1 };
    const manifest = new SourceMutationManifest({
      attempt,
      baselineDigest: "b".repeat(64),
      mutations: ["one.js", "two.js"].map((relativePath, index) => ({
        mutationId: SourceMutationManifest.mutationId(attempt, relativePath),
        path: relativePath,
        changeKind: "content",
        beforeKind: "file",
        beforeMode: 0o644,
        beforeDigest: String(index + 1).repeat(64),
        afterKind: "file",
        afterMode: 0o644,
        afterDigest: String(index + 3).repeat(64),
      })),
    });
    const report = (findings) => SourceWorkerEffectReport.fromDocument({
      version: 1,
      stepId: "impl-repair",
      completionStatus: "done",
      issues: [],
      overview: null,
      triage: null,
      repair: { version: 1, findings, summary: "Applied every selected repair finding.", recurrenceResolutions: [] },
      noChangeReason: null,
    }, "impl-repair").bind(
      manifest,
      new CanonicalSourceRequirementAuthority(["R1"]),
    ).repair;

    const sharedMutation = report([
      { findingKey: "F1", paths: ["one.js"] },
      { findingKey: "F2", paths: ["one.js", "two.js"] },
    ]);
    assert.deepEqual(sharedMutation.appliedFindingKeys, ["F1", "F2"]);
    assert.deepEqual(sharedMutation.findingMutations.toJSON(), [
      { findingKey: "F1", mutationIds: [SourceMutationManifest.mutationId(attempt, "one.js")] },
      {
        findingKey: "F2",
        mutationIds: [
          SourceMutationManifest.mutationId(attempt, "one.js"),
          SourceMutationManifest.mutationId(attempt, "two.js"),
        ],
      },
    ]);
    assert.strictEqual(sharedMutation.assertManifest(manifest), sharedMutation);

    const oneFindingManyFiles = report([{ findingKey: "F1", paths: ["one.js", "two.js"] }]);
    assert.deepEqual(oneFindingManyFiles.appliedFindingKeys, ["F1"]);
    assert.strictEqual(oneFindingManyFiles.assertManifest(manifest), oneFindingManyFiles);

    assert.throws(
      () => report([{ findingKey: "F1", paths: ["one.js"] }]),
      (error) => error instanceof WorkerArtifactHandoffError
        && error.code === "FLOW_REPAIR_FINDING_MUTATION_COVERAGE_INVALID"
        && JSON.stringify(error.data.missing) === JSON.stringify(["two.js"]),
      "the parent rejects an observed mutation omitted from finding repair claims",
    );
  });

  it("rejects incomplete, unknown, and finding-mismatched repair mutation claims", () => {
    const attempt = { id: "impl-repair-attempt", nodeId: "impl-repair", sequence: 1 };
    const mutationId = SourceMutationManifest.mutationId(attempt, "one.js");
    const manifest = new SourceMutationManifest({
      attempt,
      baselineDigest: "b".repeat(64),
      mutations: [{
        mutationId,
        path: "one.js",
        changeKind: "content",
        beforeKind: "file",
        beforeMode: 0o644,
        beforeDigest: "1".repeat(64),
        afterKind: "file",
        afterMode: 0o644,
        afterDigest: "2".repeat(64),
      }],
    });
    const effect = new SourceRepairEffect({
      version: 1,
      appliedFindingKeys: ["F1"],
      findingMutations: [{ findingKey: "F1", mutationIds: [mutationId] }],
      summary: "Applied the selected repair finding.",
    });
    assert.throws(
      () => effect.assertAppliedFindingKeys(["F1", "F2"]),
      (error) => error.code === "FLOW_REPAIR_FINDING_COVERAGE_INVALID"
        && JSON.stringify(error.data.missingFindingKeys) === JSON.stringify(["F2"]),
    );
    assert.throws(
      () => effect.assertAppliedFindingKeys([]),
      (error) => error.code === "FLOW_REPAIR_FINDING_COVERAGE_INVALID"
        && JSON.stringify(error.data.unknownFindingKeys) === JSON.stringify(["F1"]),
    );

    const unknownMutation = new SourceRepairEffect({
      version: 1,
      appliedFindingKeys: ["F1"],
      findingMutations: [{ findingKey: "F1", mutationIds: ["f".repeat(64)] }],
      summary: "Claims a mutation outside the observed manifest.",
    });
    assert.throws(
      () => unknownMutation.assertManifest(manifest),
      (error) => error.code === "FLOW_REPAIR_FINDING_MUTATION_COVERAGE_INVALID"
        && error.data.unknownMutationIds.length === 1
        && error.data.missingMutationIds[0] === mutationId,
    );

    assert.throws(
      () => SourceWorkerEffectReport.fromDocument({
        version: 1,
        stepId: "impl-repair",
        completionStatus: "done",
        issues: [],
        overview: null,
        triage: null,
        repair: { version: 1, findings: [], summary: "No source changes were made for repair." },
        noChangeReason: null,
      }, "impl-repair"),
      /bounded non-empty array/,
      "a repair cannot complete without a finding-bound mutation claim",
    );
  });

  it("binds implementation recurrence evidence into the impl-repair handoff identity", () => {
    const contract = workerArtifactHandoffPolicy("impl-repair").inputContract;
    assert.deepEqual(contract.resolve(), [
      "spec.json",
      "impl-review.json",
      "impl-triage.json",
      "impl-review-recurrence.json",
    ]);
    assert.equal(contract.accepts(["spec.json", "impl-review.json", "impl-triage.json", "impl-review-recurrence.json"]), true);
    assert.equal(contract.accepts(["spec.json", "impl-review.json", "impl-triage.json"]), false);
  });

  it("keeps changed-file classification outside every worker response schema", () => {
    for (const stepId of ["implement", "impl-triage", "impl-repair", "task-impl", "task-triage", "task-repair"]) {
      const schema = sourceWorkerEffectJsonSchema(stepId);
      assert.equal(Object.hasOwn(schema.properties, "files"), false, stepId);
      assert.equal(schema.required.includes("files"), false, stepId);
    }
  });

  it("enforces step-static source response constraints before parent materialization", () => {
    const base = {
      version: 1,
      completionStatus: "done",
      issues: [],
      overview: null,
      triage: null,
      repair: null,
      noChangeReason: null,
    };
    for (const stepId of ["implement", "impl-triage", "impl-repair"]) {
      const document = {
        ...base,
        stepId,
        ...(stepId === "impl-triage"
          ? { triage: { version: 1, dispositions: [] } }
          : {}),
        ...(stepId === "impl-repair"
          ? {
            repair: {
              version: 1,
              findings: [{ findingKey: "F1", paths: ["product.js"] }],
              summary: "Applied the reviewed correction.",
              recurrenceResolutions: [],
            },
          }
          : {}),
      };
      const noChange = { ...document, noChangeReason: "Only task implementation may be unchanged." };
      assert.notDeepEqual(validateSchema(noChange, sourceWorkerEffectJsonSchema(stepId)), [], stepId);
      assert.throws(() => SourceWorkerEffectReport.fromDocument(noChange, stepId), /only task-impl may submit/);
    }

    const triageWithIssues = {
      ...base,
      stepId: "impl-triage",
      triage: { version: 1, dispositions: [] },
      issues: [{ classification: "quality", reason: "The triage worker must not report source quality issues.", remainingRisk: "This test proves that triage cannot persist a worker quality issue." }],
    };
    assert.notDeepEqual(validateSchema(triageWithIssues, sourceWorkerEffectJsonSchema("impl-triage")), []);
    assert.throws(() => SourceWorkerEffectReport.fromDocument(triageWithIssues, "impl-triage"), /may contain only typed triage/);

    const repairWithoutWorkerFiles = {
      ...base,
      stepId: "impl-repair",
      repair: {
        version: 1,
        findings: [{ findingKey: "F1", paths: ["product.js"] }],
        summary: "Applied the reviewed correction.",
        recurrenceResolutions: [],
      },
    };
    assert.deepEqual(validateSchema(repairWithoutWorkerFiles, sourceWorkerEffectJsonSchema("impl-repair")), []);
    assert.doesNotThrow(() => SourceWorkerEffectReport.fromDocument(repairWithoutWorkerFiles, "impl-repair"));
  });

  it("materializes and seals a source worker structured response only in the parent", () => {
    const value = fixture("implement", { specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      fs.writeFileSync(path.join(value.executionRoot, "product.js"), "export const value = 2;\n");
      materializeSourceWorkerEffect({ request, responseText: JSON.stringify(sourceWorkerReport("implement")) });
      assert.equal(fs.existsSync(request.submissionPath), false, "only parent sealing may create the submission");
      seal(request);
      value.coordinator.reconcile({ ctx: value.ctx, request, mutationAuthority: authority });

      assert.equal(findStepById(value.flowManager.load().steps, "implement").status, "done");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects retired worker-authored file classification before materialization", () => {
    const response = {
      ...sourceWorkerReport("implement"),
      files: [{ requirementId: "R1", paths: ["product.js", "inherited-fixture.js"] }],
    };
    const value = fixture("implement", { specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const request = value.coordinator.createRequest({
        ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation,
      });
      fs.writeFileSync(path.join(value.executionRoot, "product.js"), "export const value = 2;\n");
      assert.notDeepEqual(validateSchema(response, sourceWorkerEffectJsonSchema("implement")), []);
      assert.throws(
        () => materializeSourceWorkerEffect({ request, responseText: JSON.stringify(response) }),
        (error) => error.code === "FLOW_SOURCE_HANDOFF_RESPONSE_INVALID",
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("allows one observed path to remain mapped to every requirement it satisfies", () => {
    const specRecord = validSpec();
    specRecord.requirements.push({ id: "R2", desc: "Share the implementation file.", task_ids: ["T1"] });
    const value = fixture("implement", { specRecord });
    try {
      initializeGitRepository(value);
      const request = value.coordinator.createRequest({
        ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      fs.writeFileSync(path.join(value.executionRoot, "product.js"), "export const value = 2;\n");
      const effect = materializeSourceWorkerEffect({
        request,
        responseText: JSON.stringify(sourceWorkerReport("implement")),
      });
      const mutationId = SourceMutationManifest.mutationId(request.sourceMutationBaseline.attempt, "product.js");
      assert.deepEqual(effect.toJSON().files, [
        { requirementId: "R1", mutationIds: [mutationId] },
        { requirementId: "R2", mutationIds: [mutationId] },
      ]);

      seal(request);
      value.coordinator.reconcile({ ctx: value.ctx, request, mutationAuthority: authority });

      assert.deepEqual(readCatalogJson(value, "file.map", "impl-review"), {
        R1: ["product.js"],
        R2: ["product.js"],
      });
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects non-canonical Requirement or mutation bindings at the Store boundary without publishing state", () => {
    const specRecord = validSpec();
    specRecord.requirements.push({ id: "R2", desc: "Share the implementation file.", task_ids: ["T1"] });
    const value = fixture("implement", { specRecord });
    try {
      initializeGitRepository(value);
      const request = value.coordinator.createRequest({
        ctx: value.ctx, state: value.flowManager.load(), invocation: value.invocation,
      });
      fs.writeFileSync(path.join(value.executionRoot, "product.js"), "export const value = 2;\n");
      const manifest = captureManifest(request);
      value.coordinator.finishSourceWorker({ ctx: value.ctx, request });
      const authority = value.flowManager.readSourceHandoffAuthority({
        specId: value.specId,
        identity: request.sourceHandoffIdentity,
        requireUnsettled: true,
      });
      const settlement = new SourceHandoffSettlement({
        identity: request.sourceHandoffIdentity,
        checkpointDigest: request.sourceHandoffCheckpoint.digest,
        eventDigest: authority.event.digest,
        handoffDigest: "e".repeat(64),
        kind: "accepted",
      });
      const mutationId = manifest.mutations[0].mutationId;
      const stateBefore = value.flowManager.canonicalState(value.specId).toJSON();
      const sourceEffect = (files) => new SourceWorkerEffect({
        version: 1,
        stepId: "implement",
        completionStatus: "done",
        files,
        issues: [],
        overview: null,
        triage: null,
        repair: null,
        noChangeReason: null,
      });
      for (const files of [
        [{ requirementId: "R1", mutationIds: [mutationId] }],
        [
          { requirementId: "R1", mutationIds: [mutationId] },
          { requirementId: "R2", mutationIds: [mutationId] },
          { requirementId: "R3", mutationIds: [mutationId] },
        ],
        [
          { requirementId: "R1", mutationIds: [mutationId] },
          { requirementId: "R2", mutationIds: ["f".repeat(64)] },
        ],
      ]) {
        assert.throws(
          () => value.flowManager.confirmSourceWorkerHandoff({
            specId: value.specId,
            effect: sourceEffect(files),
            mutationManifest: manifest,
            handoffDigest: "e".repeat(64),
            sourceHandoffSettlement: settlement,
            result: {
              outcome: "passed",
              summary: "This malformed authority must not be published.",
              confirmedAt: "2026-09-09T00:00:00.000Z",
              artifactRefs: [],
            },
          }),
          /must bind every current-scope Requirement to every current Attempt mutation/,
        );
        assert.deepEqual(value.flowManager.canonicalState(value.specId).toJSON(), stateBefore);
        assert.equal(value.flowManager.readArtifact({
          specId: value.specId,
          logicalKey: "file.map",
          consumerNodeId: "impl-review",
          optional: true,
        }), null);
      }
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("derives durable Task file effects from each Attempt manifest across inherited dirt, shared changes, deletion, and no-change", () => {
    const root = createTmpDir("source-authority-history-");
    const specId = "source-authority-history";
    const tasks = ["T8", "T9", "T10", "T11"].map((id) => ({
      id,
      title: `${id} source authority`,
      goal: `Publish ${id} only from its observed mutations.`,
      parent: null,
      origin: "plan",
      added_round: 0,
      status: "pending",
    }));
    const specRecord = {
      ...validSpec(),
      requirements: [
        { id: "R8", desc: "Create the inherited fixture.", task_ids: ["T8"] },
        { id: "R9-A", desc: "Modify the shared source.", task_ids: ["T9"] },
        { id: "R9-B", desc: "Add the new source.", task_ids: ["T9"] },
        { id: "R10", desc: "Change the shared source and delete the prior addition.", task_ids: ["T10"] },
        { id: "R11", desc: "Confirm the existing implementation without source changes.", task_ids: ["T11"] },
      ],
    };
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
    const lifecycle = new TaskLifecycleFixture({
      flowManager: manager,
      specId,
      runId: "run-source-authority-history",
      request: "Preserve parent-owned source authority across Task Attempts.",
      execution: { mode: "direct", baseBranch: "main", featureBranch: null },
      specRecord,
      taskDocuments: tasks,
      taskId: "T8",
      targetStep: "task-impl",
    }).create();
    const flow = lifecycle.flow.flow;
    const coordinator = new WorkerArtifactHandoffCoordinator({
      now: () => new Date("2026-09-09T00:00:00.000Z"),
    });
    const context = () => ({ root, mainRoot: root, executionRoot: root, specId, flowManager: manager });
    const invocation = (taskId) => ({
      id: `dispatch-${taskId}`,
      target: { digest: "b".repeat(64) },
      action: {
        digest: crypto.createHash("sha256").update(taskId).digest("hex"),
        nextAction: { step: "task-impl", taskId },
      },
    });
    const completeTaskImplementation = (taskId, mutate, noChangeReason = null) => {
      const request = coordinator.createRequest({
        ctx: context(), state: manager.loadReadOnly(specId), invocation: invocation(taskId),
      });
      coordinator.startSourceWorker({ ctx: context(), request, invocation: invocation(taskId) });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      mutate();
      const effect = materializeSourceWorkerEffect({
        request,
        responseText: JSON.stringify({
          version: 1,
          stepId: "task-impl",
          completionStatus: "done",
          issues: [],
          overview: { modules: [], data_flow: [], decisions: [] },
          triage: null,
          repair: null,
          noChangeReason,
        }),
      });
      const manifest = SourceMutationManifest.fromStored(
        JSON.parse(fs.readFileSync(request.sourceMutationManifestPath, "utf8")),
      );
      sealParentMaterializedSourceWorkerEffect({ request });
      coordinator.finishSourceWorker({ ctx: context(), request });
      coordinator.reconcile({ ctx: context(), request, mutationAuthority: authority });
      return { effect, manifest };
    };
    const finishTask = (taskId) => {
      flow.settle(`${taskId}-review`);
      flow.settle(`${taskId}-triage`, "skipped");
      flow.settle(`${taskId}-repair`, "skipped");
      flow.settle(`${taskId}-gate`);
    };

    try {
      initializeGitRepository({ mainRoot: root });
      fs.mkdirSync(path.join(root, "tests"), { recursive: true });
      const inherited = completeTaskImplementation("T8", () => {
        fs.writeFileSync(path.join(root, "tests/inherited.test.js"), "export const inherited = true;\n");
      });
      assert.deepEqual(inherited.manifest.paths(), ["tests/inherited.test.js"]);
      finishTask("T8");
      flow.activateTask("T9", { settlePredecessors: false });

      fs.mkdirSync(path.join(root, "src"), { recursive: true });
      const taskNine = completeTaskImplementation("T9", () => {
        fs.writeFileSync(path.join(root, "product.js"), "export const value = 9;\n");
        fs.writeFileSync(path.join(root, "src/added.js"), "export const added = true;\n");
      });
      assert.deepEqual(taskNine.manifest.paths(), ["product.js", "src/added.js"]);
      assert.deepEqual(taskNine.effect.toJSON().files.map((entry) => entry.requirementId), ["R9-A", "R9-B"]);
      assert.ok(taskNine.effect.files.every((entry) => entry.mutationIds.length === 2));

      let restarted = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      assert.deepEqual(JSON.parse(restarted.readArtifact({
        specId, logicalKey: "file.map", consumerNodeId: "impl-review",
      }).bytes.toString("utf8")), {
        R8: ["tests/inherited.test.js"],
        "R9-A": ["product.js", "src/added.js"],
        "R9-B": ["product.js", "src/added.js"],
      });
      assert.deepEqual(restarted.taskMutationLineages({ specId, taskId: "T9" })[0].manifest.mutations
        .map((entry) => entry.path), ["product.js", "src/added.js"]);
      flow.activate("T9-review", { settlePredecessors: false });
      const reviewState = restarted.loadReadOnly(specId);
      const reviewSource = captureCurrentTaskSource({
        root,
        flowManager: restarted,
        state: reviewState,
        taskId: "T9",
      });
      const reviewContext = CanonicalTaskContext.capture({
        root,
        flowManager: restarted,
        state: reviewState,
        taskId: "T9",
        source: reviewSource,
      });
      assert.deepEqual(canonicalTaskReviewFileMap({
        context: reviewContext.readOnlyInput(),
        source: reviewSource.toJSON(),
      }), {
        "R9-A": ["product.js", "src/added.js"],
        "R9-B": ["product.js", "src/added.js"],
      });

      finishTask("T9");
      flow.activateTask("T10", { settlePredecessors: false });
      const taskTen = completeTaskImplementation("T10", () => {
        fs.writeFileSync(path.join(root, "product.js"), "export const value = 10;\n");
        fs.unlinkSync(path.join(root, "src/added.js"));
        fs.writeFileSync(path.join(root, "src/later.js"), "export const later = true;\n");
      });
      assert.deepEqual(taskTen.manifest.mutations.map((entry) => [entry.path, entry.changeKind]), [
        ["product.js", "content"],
        ["src/added.js", "deleted"],
        ["src/later.js", "added"],
      ]);
      finishTask("T10");
      flow.activateTask("T11", { settlePredecessors: false });
      const taskEleven = completeTaskImplementation(
        "T11",
        () => {},
        "The canonical source already satisfies this Task without another mutation.",
      );
      assert.deepEqual(taskEleven.manifest.mutations, []);
      assert.deepEqual(taskEleven.effect.files, []);

      restarted = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      const fileMap = JSON.parse(restarted.readArtifact({
        specId, logicalKey: "file.map", consumerNodeId: "impl-review",
      }).bytes.toString("utf8"));
      assert.equal(Object.hasOwn(fileMap, "R11"), false, "no-change must not create an empty file-map entry");
      assert.deepEqual(fileMap.R8, ["tests/inherited.test.js"]);
      assert.deepEqual(fileMap["R9-A"], ["product.js", "src/added.js"]);
      assert.deepEqual(fileMap["R9-B"], ["product.js", "src/added.js"]);
      assert.deepEqual(fileMap.R10, ["product.js", "src/added.js", "src/later.js"]);
      assert.equal(
        restarted.taskMutationLineages({ specId, taskId: "T9" })[0].manifest.digest,
        taskNine.manifest.digest,
      );
      assert.equal(restarted.taskMutationLineages({ specId, taskId: "T11" })[0].noChangeReason,
        "The canonical source already satisfies this Task without another mutation.");
    } finally {
      removeTmpDir(root);
    }
  });

  it("rejects duplicate requirement groups and mutation IDs in canonical source effects", () => {
    const mutationA = "a".repeat(64);
    const mutationB = "b".repeat(64);
    const base = {
      version: 1,
      stepId: "implement",
      completionStatus: "done",
      issues: [],
      overview: null,
      triage: null,
      repair: null,
      noChangeReason: null,
    };
    assert.throws(
      () => SourceWorkerEffect.fromDocument({
        ...base,
        files: [
          { requirementId: "R1", mutationIds: [mutationA] },
          { requirementId: "R1", mutationIds: [mutationB] },
        ],
      }, "implement"),
      (error) => error instanceof WorkerArtifactHandoffError
        && error.code === "FLOW_SOURCE_HANDOFF_EFFECT_REQUIREMENT_CLAIM_DUPLICATE"
        && JSON.stringify(error.data.duplicateRequirementIds) === JSON.stringify(["R1"]),
    );
    assert.throws(
      () => SourceWorkerEffect.fromDocument({
        ...base,
        files: [{ requirementId: "R1", mutationIds: [mutationA, mutationA] }],
      }, "implement"),
      (error) => error instanceof WorkerArtifactHandoffError
        && error.code === "FLOW_SOURCE_HANDOFF_EFFECT_PATH_CLAIM_DUPLICATE"
        && JSON.stringify(error.data.duplicateMutationIds) === JSON.stringify([mutationA]),
    );
  });

  it("rejects a worker-written source effect before parent materialization", () => {
    const value = fixture("implement", { specRecord: validSpec() });
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(request.payloadPath("effects.json"), "{}\n");
      assert.throws(
        () => materializeSourceWorkerEffect({ request, responseText: "{}" }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_SOURCE_HANDOFF_PARENT_AUTHORITY_VIOLATION",
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("recovers a checkpoint-bound sealed source handoff through a fresh manager", () => {
    const value = fixture("implement", { specRecord: validSpec() });
    try {
      initializeGitRepository(value);
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      assert.equal(request.version, 4);
      fs.writeFileSync(path.join(value.executionRoot, "product.js"), "export const value = 2;\n");
      fs.writeFileSync(request.payloadPath("effects.json"), json(implementationEffect(request, ["product.js"]).toJSON()));
      seal(request);
      const recoveredManager = new FlowManager({
        root: value.executionRoot,
        mainRoot: value.mainRoot,
        inWorktree: true,
        specId: value.specId,
      });
      const recovered = new WorkerArtifactHandoffCoordinator().recoverPending({
        ctx: { ...value.ctx, flowManager: recoveredManager },
      });
      assert.equal(recovered.completed, true);
      assert.equal(findStepById(recoveredManager.load(value.specId).steps, "implement").status, "done");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects the retired worker requirement completion field", () => {
    assert.throws(() => SourceWorkerEffect.fromDocument({
      version: 1,
      stepId: "implement",
      completionStatus: "done",
      requirements: [{ reference: "R1", status: "done" }],
      files: [{ requirementId: "R1", mutationIds: ["a".repeat(64)] }],
      issues: [],
      overview: null,
      triage: null,
      repair: null,
    }, "implement"), /invalid schema/);
  });

  it("rejects retired raw source paths in favor of Attempt mutation IDs", () => {
    assert.throws(() => SourceWorkerEffect.fromDocument({
      version: 1,
      stepId: "implement",
      completionStatus: "done",
      files: [{ requirementId: "R1", paths: ["product.js"] }],
      issues: [],
      overview: null,
      triage: null,
      repair: null,
    }, "implement"), /invalid schema/);
  });

  it("defines one complete authority record for all 36 Flow leaves and 5 task leaves", () => {
    const flowLeaves = flattenSteps(buildInitialNestedSteps()).map((step) => step.id);
    const taskLeaves = buildInitialTaskSteps().map((step) => step.id);
    assert.equal(flowLeaves.length, 36);
    assert.equal(taskLeaves.length, 5);
    assert.deepEqual(
      FLOW_ARTIFACT_AUTHORITY_MATRIX.map((entry) => entry.stepId).sort(),
      [...flowLeaves, ...taskLeaves].sort(),
    );
    for (const entry of FLOW_ARTIFACT_AUTHORITY_MATRIX) {
      assert.ok(["preparation", "command", "artifact", "source", "user"].includes(entry.category));
      assert.ok(entry.producer);
      assert.ok(entry.writableAuthority);
      assert.ok(entry.consumer);
      assert.ok(entry.publicationOwner);
      assert.ok(entry.completionValidator);
      assert.ok(entry.sourceBinding);
      assert.ok(entry.recoveryOwner);
    }
    assert.ok(FLOW_ARTIFACT_AUTHORITY_MATRIX.every((entry) => (
      ["preparation", "command", "artifact", "source", "user"].filter((category) => entry.category === category).length === 1
    )), "each leaf belongs to exactly one authority category");
    assert.deepEqual(
      FLOW_ARTIFACT_AUTHORITY_MATRIX
        .filter((entry) => entry.sourceHandoff)
        .map((entry) => [entry.stepId, entry.sourceMutation.mode]),
      [
        ["implement", "required"],
        ["impl-triage", "forbidden"],
        ["impl-repair", "required"],
        ["task-impl", "optional"],
        ["task-triage", "forbidden"],
        ["task-repair", "required"],
      ],
    );
    for (const entry of FLOW_ARTIFACT_AUTHORITY_MATRIX.filter((candidate) => candidate.sourceHandoff)) {
      assert.equal(workerArtifactHandoffPolicy(entry.stepId).sourceMutation, entry.sourceMutation);
    }
    assert.equal(FLOW_ARTIFACT_AUTHORITY_MATRIX.find((entry) => entry.stepId === "branch").category, "preparation");
    assert.equal(FLOW_ARTIFACT_AUTHORITY_MATRIX.find((entry) => entry.stepId === "approval").category, "user");
  });

  it("aligns every source handoff input and parent effect publication with catalog authority", () => {
    const rows = [
      { step: "implement", input: ["spec.record"], read: ["spec.record", "file.map", "issue.log"], write: ["spec.record", "file.map", "issue.log"] },
      { step: "impl-triage", input: ["spec.record", "impl.review", "acceptance.review"], read: ["spec.record"], write: ["impl.triage"] },
      { step: "impl-repair", input: ["spec.record", "impl.review", "impl.triage"], read: ["spec.record", "file.map", "issue.log"], write: ["impl.repair", "file.map", "issue.log"] },
      { step: "task-impl", input: [], read: ["spec.record", "file.map", "issue.log"], write: ["spec.record", "file.map", "issue.log"] },
    ];
    const logicalByInput = new Map([
      ["spec.json", "spec.record"], ["impl-review.json", "impl.review"],
      ["acceptance-review.json", "acceptance.review"], ["impl-triage.json", "impl.triage"],
    ]);
    for (const row of rows) {
      const policy = workerArtifactHandoffPolicy(row.step);
      assert.equal(policy?.kind, "source");
      const declaredInputs = new Set(policy.inputContract.allowedSignatures.flatMap((signature) => (
        signature === "" ? [] : signature.split("\u0000")
      )).map((input) => logicalByInput.get(input)));
      for (const logicalKey of row.input) assert.ok(declaredInputs.has(logicalKey), `${row.step} declares ${logicalKey} input`);
      for (const logicalKey of [...new Set([...row.input, ...row.read])]) {
        assert.ok(FLOW_ARTIFACT_CONTRACTS.require(logicalKey).ownership.consumers.includes(row.step), `${row.step} may read ${logicalKey}`);
      }
      for (const logicalKey of row.write) {
        assert.ok(FLOW_ARTIFACT_CONTRACTS.require(logicalKey).ownership.updaters.includes(row.step), `${row.step} parent completion may publish ${logicalKey}`);
      }
    }
  });

  it("materializes target-bound immutable draft context with explicit omissions", () => {
    const value = fixture();
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const snapshot = request.contextSnapshot;
      const entries = new Map(snapshot.entries.map((entry) => [entry.kind, entry]));

      assert.equal(snapshot.binding.runId, "run-worker-handoff");
      assert.equal(snapshot.binding.specId, value.specId);
      assert.equal(snapshot.binding.dispatchInvocationId, value.invocation.id);
      assert.equal(snapshot.binding.actionDigest, ACTION_DIGEST);
      assert.equal(snapshot.binding.targetDigest, "b".repeat(64));
      assert.equal(snapshot.inputAuthority.kind, "request");
      assert.equal(entries.get("request").document, "Create the target-bound worker artifact handoff.");
      assert.equal(entries.get("issue").reason, "no-linked-issue");
      assert.equal(entries.get("project_overview").reason, "docs-overview-unavailable");
      assert.match(snapshot.digest, /^[a-f0-9]{64}$/);
      assert.equal(request.toWorkerJSON().contextSnapshot.digest, snapshot.digest);
      assert.equal(request.inputDigest, request.toJSON().inputDigest);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("selects linked Issue content over a simultaneous Flow request", () => {
    const value = fixture("draft", {
      issue: 501,
      issueSnapshot: "Authoritative Issue body.\n",
      request: "secondary Flow request",
    });
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const entries = new Map(request.contextSnapshot.entries.map((entry) => [entry.kind, entry]));

      assert.equal(request.contextSnapshot.inputAuthority.kind, "issue");
      assert.deepEqual(entries.get("issue").document, {
        number: 501,
        body: "Authoritative Issue body.",
      });
      assert.equal(entries.get("request").document, "secondary Flow request");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects missing draft input authority before worker startup", () => {
    const value = fixture("draft", { request: null });
    try {
      assert.throws(
        () => value.coordinator.createRequest({
          ctx: value.ctx,
          state: value.flowManager.load(),
          invocation: value.invocation,
        }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_ARTIFACT_HANDOFF_CONTEXT_INVALID"
          && /linked Issue content or a Flow request/.test(error.message),
      );
      assert.equal(findStepById(value.flowManager.load().steps, "draft").status, "in_progress");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("returns typed context failure without calling the dispatcher worker", async () => {
    const value = fixture("draft", { request: null });
    try {
      let calls = 0;
      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run() {
            return {
              taskId: null,
              step: "draft",
              action: "write-draft",
              instructions: { key: "plan.draft", content: "Write the draft." },
              context: { workerArtifactHandoff: { required: true } },
              output_schema: {},
              requires_approval: false,
              maxAttempts: 1,
              directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "write-draft" },
            };
          },
        },
        agent: { async call() { calls += 1; } },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};

      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(),
        expectRunId: "run-worker-handoff",
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(result.errors[0].code, "FLOW_ARTIFACT_HANDOFF_CONTEXT_INVALID");
      assert.equal(calls, 0);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("publishes a sealed draft and completes the step only in the parent transaction", () => {
    const value = fixture();
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      assert.equal(request.directory.startsWith(executionHandoffRoot(value)), true);
      assert.equal(
        fs.existsSync(path.join(canonicalSpecDir(value), ".runtime", "worker-handoffs")),
        false,
      );
      const expectedDraft = draftDocument("sealed draft");
      fs.writeFileSync(request.payloadPath("draft.json"), json(expectedDraft));
      seal(request);

      const result = value.coordinator.reconcile({ ctx: value.ctx, request });
      const state = value.flowManager.load();
      const published = value.flowManager.readArtifact({
        specId: value.specId,
        logicalKey: "draft",
        consumerNodeId: "draft-questions-review",
      });
      const activities = value.flowManager.activityLedger(value.specId);

      assert.equal(result.completed, true);
      assert.deepEqual(
        JSON.parse(published.bytes.toString("utf8")),
        expectedDraft,
      );
      assert.equal(findStepById(state.steps, "draft").status, "done");
      assert.equal(findStepById(state.steps, "draft").result.artifactRefs[0].kind, "worker-handoff");
      assert.equal(activities.at(-1).transition.operation, "confirm_attempt");
      assert.equal(
        value.flowManager.artifactCatalog(value.specId).resolve("steps/draft/result.json").logicalKey,
        "draft",
      );
      assert.equal(fs.existsSync(request.directory), false);
      assert.equal(
        value.coordinator.reconcile({ ctx: value.ctx, request }).replayed,
        true,
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("uses the same dispatcher-owned handoff API in non-worktree Flow", () => {
    const value = fixture("draft", { worktree: false });
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      assert.ok(request);
      assert.equal(request.executionRoot, value.mainRoot);
      assert.equal(
        request.directory.startsWith(executionHandoffRoot(value)),
        true,
      );
      const expectedDraft = draftDocument("local handoff");
      fs.writeFileSync(request.payloadPath("draft.json"), json(expectedDraft));
      seal(request);

      value.coordinator.reconcile({ ctx: value.ctx, request });

      assert.deepEqual(readCatalogJson(value, "draft", "draft-questions-review"), expectedDraft);
      assert.equal(findStepById(value.flowManager.load().steps, "draft").status, "done");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("retains unknown and conflicting triage siblings in the canonical review audit", () => {
    const value = prepareSpecTriageFixture();
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: {
          ...value.invocation,
          id: "dispatch-spec-triage-handoff",
          action: {
            ...value.invocation.action,
            nextAction: { step: "spec-triage" },
          },
        },
      });
      const review = new CanonicalSpecReview(request.inputs.find((input) => input.name === "review.json").document);
      fs.writeFileSync(request.payloadPath("review.delta.json"), json({
        version: 2,
        stage: "spec-triage",
        identity: review.identity.toJSON(),
        baseReviewDigest: review.digest,
        operations: [],
        findings: [
          {
            findingId: "F-valid",
            disposition: "invalid",
            evidence: "The valid sibling remains independently classified.",
          },
          {
            findingId: "F-unknown",
            disposition: "invalid",
            evidence: "Unknown findings must be audited without blocking valid siblings.",
          },
          {
            findingId: "F-conflict",
            disposition: "invalid",
            evidence: "This conflicts with the following update.",
          },
          {
            findingId: "F-conflict",
            disposition: "already_resolved",
            evidence: "This conflicts with the prior update.",
          },
        ],
      }));
      seal(request);

      value.coordinator.reconcile({ ctx: value.ctx, request });

      const published = value.flowManager.readCurrentSpecReview({
        specId: value.specId,
        consumerNodeId: "spec-repair",
      }).review;
      assert.equal(published.findings.byId("F-valid").disposition, "invalid");
      assert.equal(published.findings.byId("F-conflict").disposition, undefined);
      const discarded = published.audit.at(-1).discardedOperations;
      assert.ok(discarded.some((entry) => entry.findingId === "F-unknown" && entry.reason === "unknown finding"));
      assert.equal(
        discarded.filter((entry) => entry.findingId === "F-conflict" && entry.reason === "conflicting duplicate triage update").length,
        2,
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects direct completion of a dispatcher-owned step in every execution mode", async () => {
    for (const worktree of [true, false]) {
      const value = fixture("spec-triage", { worktree });
      try {
        const result = await new SetStepCommand().execute({
          ...value.ctx,
          id: "spec-triage",
          status: "done",
        });
        assert.equal(result.ok, false);
        assert.equal(result.errors[0].code, "FLOW_ARTIFACT_HANDOFF_REQUIRED");
        assert.equal(findStepById(value.flowManager.load().steps, "spec-triage").status, "in_progress");
        assert.equal(
          fs.existsSync(path.join(canonicalSpecDir(value), "revisions", "001", "review.json")),
          true,
        );
      } finally {
        removeTmpDir(value.mainRoot);
      }
    }
  });

  it("validates and publishes spec and spec-test payload types", () => {
    const specValue = fixture("spec", {
      beforeActivate(value) {
        publishDraftBeforeTarget(value, draftDocument("draft input"));
      },
    });
    try {
      const proposed = {
        ...validSpec(),
        tasks: [{
          id: "T1", title: "Publish source handoff", goal: "Exercise approval admission.",
          origin: "plan", added_round: 0, status: "pending",
        }],
      };
      publishSpecProposal(specValue, proposed);
      assert.equal(findStepById(specValue.flowManager.load().steps, "spec").status, "done");
      assert.deepEqual(
        JSON.parse(fs.readFileSync(specValue.flowManager.specLocation(specValue.specId).specFile, "utf8")),
        proposed,
      );
      specValue.flow.activate("approval");
      const approval = specValue.flowManager.approveSpecContinuation({
        specId: specValue.specId,
        approval: new CanonicalSpecApproval({ confirmedAt: "2026-08-04T00:00:00.000Z" }),
      });
      assert.deepEqual(approval.added, ["T1"]);
      assert.equal(specValue.flowManager.load(specValue.specId).tasks[0].id, "T1");
      assert.equal(specValue.flowManager.activityLedger(specValue.specId).at(-2).transition.operation, "add_approval_task");
    } finally {
      removeTmpDir(specValue.mainRoot);
    }

    const testValue = fixture("test", { specRecord: validSpec() });
    try {
      const testRequest = testValue.coordinator.createRequest({
        ctx: testValue.ctx,
        state: testValue.flowManager.load(),
        invocation: testValue.invocation,
      });
      const testFile = path.join(testRequest.payloadPath("spec-tests"), "handoff.test.js");
      fs.writeFileSync(testFile, [
        "// spec: R1",
        "import test from \"node:test\";",
        "test(\"R1: publishes a validated artifact\", () => {});",
        "",
      ].join("\n"));
      seal(testRequest);
      testValue.coordinator.reconcile({ ctx: testValue.ctx, request: testRequest });
      assert.equal(findStepById(testValue.flowManager.load().steps, "test").status, "done");
      assert.equal(
        testValue.flowManager.artifactCatalog(testValue.specId)
          .resolve("artifacts/tests/handoff.test.js").logicalKey,
        "tests.source",
      );
      const cleanObservation = readCanonicalSpecTestBootstrapObservation({
        flowManager: testValue.flowManager,
        specId: testValue.specId,
        consumerNodeId: "test-review",
      });
      assert.notEqual(cleanObservation, null);
      assert.equal(cleanObservation.deferred, false);
      assert.deepEqual(cleanObservation.issues, []);
    } finally {
      removeTmpDir(testValue.mainRoot);
    }
  });

  it("replays approval Task admission after a definition-owned draft recovery", () => {
    const value = fixture("spec", {
      beforeActivate(input) {
        publishDraftBeforeTarget(input, draftDocument("draft input"));
      },
    });
    try {
      const proposed = {
        ...validSpec(),
        requirements: [{ ...validSpec().requirements[0], task_ids: ["T1", "T2"] }],
        tasks: [
          { id: "T1", title: "First admitted Task", goal: "Exercise recovery admission.", origin: "plan", added_round: 0, status: "pending" },
          { id: "T2", title: "Second admitted Task", goal: "Exercise recovery admission.", origin: "plan", added_round: 0, status: "pending" },
        ],
      };
      publishSpecProposal(value, proposed);

      value.flow.activate("approval");
      value.flowManager.reopenDraft({ specId: value.specId, route: "preimplementation" });
      value.flow.activate("approval");
      const beforeRejectedAdmission = value.flowManager.canonicalState(value.specId).confirmationOrder;
      assert.throws(
        () => value.flowManager._store.runtime.addApprovalTask({
          specId: value.specId,
          activityId: crypto.randomUUID(),
          taskId: "forged-approval-task",
          key: "forged-approval-task",
          taskSpec: { id: "forged-approval-task", title: "Forged approval Task" },
        }),
        /requires a durable approval Task source binding/,
      );
      const admissionSource = value.flowManager.readArtifact({
        specId: value.specId,
        logicalKey: "spec.record",
        consumerNodeId: "approval",
      });
      assert.throws(
        () => value.flowManager._store.runtime.addApprovalTask({
          specId: value.specId,
          activityId: crypto.randomUUID(),
          taskId: "forged-approval-task",
          key: "forged-approval-task",
          taskSpec: { id: "forged-approval-task", title: "Forged approval Task" },
          admission: new ApprovalTaskAdmission({
            sourceDescriptor: admissionSource.descriptor,
            sourceTask: { id: "forged-approval-task", title: "Forged approval Task" },
          }),
        }),
        /source Task changed|Task admission has no mapped Requirement/,
      );
      assert.throws(
        () => value.flowManager._store.runtime.addApprovalTask({
          specId: value.specId,
          activityId: crypto.randomUUID(),
          taskId: "T1",
          key: "T1",
          taskSpec: proposed.tasks[0],
          admission: new ApprovalTaskAdmission({
            sourceDescriptor: { ...admissionSource.descriptor, activityId: crypto.randomUUID() },
            sourceTask: proposed.tasks[0],
          }),
        }),
        /spec\.record descriptor changed/,
      );
      assert.throws(
        () => value.flowManager._store.runtime.addApprovalTask({
          specId: value.specId,
          activityId: crypto.randomUUID(),
          taskId: "T1",
          key: "T1",
          taskSpec: { ...proposed.tasks[0], title: "Changed outside the approved Spec" },
          admission: new ApprovalTaskAdmission({
            sourceDescriptor: admissionSource.descriptor,
            sourceTask: proposed.tasks[0],
          }),
        }),
        /Task document does not match its durable source binding/,
      );
      assert.equal(value.flowManager.canonicalState(value.specId).confirmationOrder, beforeRejectedAdmission);
      const approval = value.flowManager.approveSpecContinuation({
        specId: value.specId,
        approval: new CanonicalSpecApproval({ confirmedAt: "2026-08-04T00:00:00.000Z" }),
      });

      assert.deepEqual(approval.added, ["T1", "T2"]);
      assert.deepEqual(value.flowManager.load(value.specId).tasks.map((task) => task.id), ["T1", "T2"]);
      assert.equal(value.flowManager.canonicalState(value.specId).findNode("test-execute").status, "invalidated");
      assert.equal(value.flowManager.activityLedger(value.specId).filter((activity) => (
        activity.transition.operation === "add_approval_task"
      )).length, 2);
      const restarted = new FlowManager({
        root: value.executionRoot,
        mainRoot: value.mainRoot,
        inWorktree: true,
        specId: value.specId,
      });
      const replayed = restarted.canonicalState(value.specId);
      assert.deepEqual(replayed.findNode(replayed.definition.dynamicTaskContainerId).steps
        .filter((node) => node.kind === "task")
        .map((task) => task.id), ["T1", "T2"]);
      assert.equal(replayed.confirmationOrder, value.flowManager.canonicalState(value.specId).confirmationOrder);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("resumes approval after a partial multi-Task admission without duplicates", () => {
    let admissionAttempts = 0;
    const value = fixture("spec", {
      versionStoreFaultInjector({ phase, activity }) {
        if (phase !== "activity-ready-to-append" || activity.transition.operation !== "add_approval_task") return;
        admissionAttempts += 1;
        if (admissionAttempts === 2) throw new Error("simulated interruption before the second approval Task");
      },
      beforeActivate(input) {
        publishDraftBeforeTarget(input, draftDocument("draft input"));
      },
    });
    try {
      publishSpecProposal(value, {
        ...validSpec(),
        requirements: [{ ...validSpec().requirements[0], task_ids: ["T1", "T2"] }],
        tasks: [
          { id: "T1", title: "First admitted Task", goal: "Persist before interruption.", origin: "plan", added_round: 0, status: "pending" },
          { id: "T2", title: "Second admitted Task", goal: "Resume after interruption.", origin: "plan", added_round: 0, status: "pending" },
        ],
      });
      value.flow.activate("approval");

      assert.throws(
        () => value.flowManager.approveSpecContinuation({
          specId: value.specId,
          approval: new CanonicalSpecApproval({ confirmedAt: "2026-08-04T00:00:00.000Z" }),
        }),
        /simulated interruption/,
      );
      assert.deepEqual(value.flowManager.load(value.specId).tasks.map((task) => task.id), ["T1"]);
      assert.equal(findStepById(value.flowManager.load(value.specId).steps, "approval").status, "in_progress");

      const resumed = value.flowManager.approveSpecContinuation({
        specId: value.specId,
        approval: new CanonicalSpecApproval({ confirmedAt: "2026-08-04T00:00:00.000Z" }),
      });
      const activities = value.flowManager.activityLedger(value.specId);

      assert.deepEqual(resumed.added, ["T2"]);
      assert.deepEqual(value.flowManager.load(value.specId).tasks.map((task) => task.id), ["T1", "T2"]);
      assert.equal(findStepById(value.flowManager.load(value.specId).steps, "approval").status, "done");
      assert.deepEqual(
        activities.filter((activity) => activity.transition.operation === "add_approval_task")
          .map((activity) => activity.transition.task.id),
        ["T1", "T2"],
      );
      assert.equal(activities.filter((activity) => (
        activity.transition.operation === "confirm_attempt" && activity.nodeId === "approval"
      )).length, 1);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("admits only the appended Task after the definition-owned task-addition reopen route", () => {
    const value = fixture("spec", {
      beforeActivate(input) {
        publishDraftBeforeTarget(input, draftDocument("draft input"));
      },
    });
    const first = {
      id: "T1", title: "Existing Task", goal: "Complete before reopening the plan.",
      origin: "plan", added_round: 0, status: "pending",
    };
    const second = {
      id: "T2", title: "Appended Task", goal: "Admit during the second approval round.",
      origin: "plan", added_round: 1, status: "pending",
    };
    try {
      publishSpecProposal(value, { ...validSpec(), tasks: [first] });
      value.flow.activate("approval");
      value.flowManager.approveSpecContinuation({
        specId: value.specId,
        approval: new CanonicalSpecApproval({ confirmedAt: "2026-08-04T00:00:00.000Z" }),
      });
      value.flow.settleBefore("T1-gate").settle("T1-gate").activate("test-execute");

      value.flowManager.reopenDraft({ specId: value.specId, route: "task-addition" });
      value.flow.activate("spec");
      publishSpecProposal(value, {
        ...validSpec(),
        requirements: [{ ...validSpec().requirements[0], task_ids: ["T1", "T2"] }],
        tasks: [first, second],
      });
      value.flow.activate("approval");
      const approval = value.flowManager.approveSpecContinuation({
        specId: value.specId,
        approval: new CanonicalSpecApproval({ confirmedAt: "2026-08-04T01:00:00.000Z" }),
      });

      const state = value.flowManager.load(value.specId);
      assert.deepEqual(approval.added, ["T2"]);
      assert.deepEqual(state.tasks.map((task) => task.id), ["T1", "T2"]);
      assert.equal(state.tasks.find((task) => task.id === "T1").status, "invalidated");
      assert.equal(state.tasks.find((task) => task.id === "T2").status, "pending");
      assert.equal(findStepById(state.steps, "approval").status, "done");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("merges append-only worker Task proposals while rejecting admitted topology changes", () => {
    const task = {
      id: "T1", title: "Keep identity", goal: "Keep the approved Task immutable.",
      origin: "plan", added_round: 0, status: "pending",
    };
    const previous = new CurrentFlowSpecRecord({ ...validSpec(), tasks: [task] }, { specId: "500-worker-handoff" });
    const accepted = new CanonicalWorkerSpecPublication({
      ...validSpec(),
      tasks: [
        { ...task, title: "Corrected title", goal: "Corrected task description." },
        { id: "T2", title: "New task", goal: "Admit after approval.", origin: "plan", added_round: 1, status: "pending" },
      ],
    });
    const merged = accepted.materialize(previous, {
      specId: "500-worker-handoff",
      admittedTaskIds: ["T1"],
    }).toJSON();
    assert.deepEqual(merged.tasks.map((entry) => entry.id), ["T1", "T2"]);
    assert.equal(merged.tasks[0].title, "Corrected title");
    assert.equal(merged.tasks[0].goal, "Corrected task description.");
    for (const proposal of [
      [{ id: "T2", title: "New", goal: "New.", origin: "plan", added_round: 1, status: "pending" }],
      [{ ...task, added_round: 1 }],
      [{ id: "T2", title: "New", goal: "New.", origin: "plan", added_round: 1, status: "pending" }, task],
      [{ ...task }, { id: "T2", title: "New", goal: "New.", origin: "plan", added_round: 0, status: "pending" }],
    ]) {
      assert.throws(() => new CanonicalWorkerSpecPublication({ ...validSpec(), tasks: proposal })
        .materialize(previous, { specId: "500-worker-handoff", admittedTaskIds: ["T1"] }), /proposal/);
    }
  });

  it("preserves canonical Spec order when parent-first admission differs from the proposal", () => {
    const parent = {
      id: "T-parent", title: "Parent", goal: "Complete the parent Task.", parent: null,
      origin: "plan", added_round: 0, status: "pending",
    };
    const child = {
      id: "T-child", title: "Child", goal: "Complete the child Task.", parent: "T-parent",
      origin: "plan", added_round: 0, status: "pending",
    };
    const previous = new CurrentFlowSpecRecord({ ...validSpec(), tasks: [child, parent] }, { specId: "500-worker-handoff" });
    const publication = new CanonicalWorkerSpecPublication({
      ...validSpec(),
      tasks: [
        { ...child, title: "Corrected child title" },
        { ...parent, goal: "Corrected parent goal." },
      ],
    });

    assert.deepEqual(
      publication.materialize(previous, {
        specId: "500-worker-handoff",
        admittedTaskIds: ["T-parent", "T-child"],
      }).toJSON().tasks,
      [
        { ...child, title: "Corrected child title" },
        { ...parent, goal: "Corrected parent goal." },
      ],
    );
  });

  it("allows a pre-approval worker repair to replace unadmitted Task instructions", () => {
    const original = {
      id: "T1",
      title: "Original title",
      goal: "Original goal.",
      acceptance: ["Original acceptance."],
      implementation_notes: "Original implementation note.",
      test_strategy: "Original test strategy.",
      origin: "plan",
      added_round: 0,
      status: "pending",
    };
    const repaired = {
      ...original,
      title: "Repaired title",
      goal: "Repaired goal.",
      acceptance: ["Repaired acceptance."],
      implementation_notes: "Repaired implementation note.",
      test_strategy: "Repaired test strategy.",
    };
    const previous = new CurrentFlowSpecRecord({ ...validSpec(), tasks: [original] }, { specId: "500-worker-handoff" });
    const publication = new CanonicalWorkerSpecPublication({ ...validSpec(), tasks: [repaired] });

    assert.deepEqual(
      publication.materialize(previous, {
        specId: "500-worker-handoff",
        admittedTaskIds: [],
      }).toJSON().tasks,
      [repaired],
    );
  });

  it("derives Task immutability from admitted Flow state rather than the prior Spec proposal", () => {
    const value = fixture("spec", {
      specRecord: validSpec(),
      beforeActivate(fixtureValue) {
        publishDraftBeforeTarget(fixtureValue, draftDocument("draft input"));
      },
    });
    try {
      const initial = {
        id: "T1",
        title: "Initial title",
        goal: "Initial goal.",
        acceptance: ["Initial acceptance."],
        implementation_notes: "Initial implementation note.",
        test_strategy: "Initial test strategy.",
        origin: "plan",
        added_round: 0,
        status: "pending",
      };
      value.flowManager.confirmCurrentAttempt({
        specId: value.specId,
        specRecord: new CanonicalWorkerSpecPublication({ ...validSpec(), tasks: [initial] }),
      });

      value.flow.activate("spec-repair");
      const repaired = {
        ...initial,
        acceptance: ["Repaired acceptance."],
        implementation_notes: "Repaired implementation note.",
        test_strategy: "Repaired test strategy.",
      };
      value.flowManager.confirmCurrentAttempt({
        specId: value.specId,
        specRecord: new CanonicalWorkerSpecPublication({ ...validSpec(), tasks: [repaired] }),
      });

      assert.deepEqual(
        JSON.parse(fs.readFileSync(value.flowManager.specLocation(value.specId).specFile, "utf8")).tasks,
        [repaired],
      );
      assert.deepEqual(value.flowManager.load(value.specId).tasks, []);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("protects only admitted Tasks when a repaired Spec also has pending Task proposals", () => {
    const admitted = {
      id: "T1",
      title: "Admitted title",
      goal: "Admitted goal.",
      acceptance: ["Admitted acceptance."],
      implementation_notes: "Admitted implementation note.",
      test_strategy: "Admitted test strategy.",
      origin: "plan",
      added_round: 0,
      status: "pending",
    };
    const pending = {
      id: "T2",
      title: "Pending title",
      goal: "Pending goal.",
      acceptance: ["Pending acceptance."],
      implementation_notes: "Pending implementation note.",
      test_strategy: "Pending test strategy.",
      origin: "plan",
      added_round: 1,
      status: "pending",
    };
    const value = fixture("spec", {
      specRecord: validSpec(),
      beforeActivate(fixtureValue) {
        publishDraftBeforeTarget(fixtureValue, draftDocument("draft input"));
        fixtureValue.flow.addTask(admitted);
      },
    });
    try {
      value.flowManager.confirmCurrentAttempt({
        specId: value.specId,
        specRecord: new CanonicalWorkerSpecPublication({ ...validSpec(), tasks: [admitted, pending] }),
      });

      value.flow.activate("spec-repair");
      const illegal = { ...admitted, acceptance: ["Rewritten admitted acceptance."] };
      assert.throws(() => value.flowManager.confirmCurrentAttempt({
        specId: value.specId,
        specRecord: new CanonicalWorkerSpecPublication({ ...validSpec(), tasks: [illegal, pending] }),
      }), /only correct admitted Task title or goal/);

      const repairedPending = {
        ...pending,
        acceptance: ["Repaired pending acceptance."],
        implementation_notes: "Repaired pending implementation note.",
        test_strategy: "Repaired pending test strategy.",
      };
      value.flowManager.confirmCurrentAttempt({
        specId: value.specId,
        specRecord: new CanonicalWorkerSpecPublication({
          ...validSpec(),
          tasks: [{ ...admitted, title: "Corrected admitted title" }, repairedPending],
        }),
      });

      assert.deepEqual(
        JSON.parse(fs.readFileSync(value.flowManager.specLocation(value.specId).specFile, "utf8")).tasks,
        [{ ...admitted, title: "Corrected admitted title" }, repairedPending],
      );
      assert.deepEqual(value.flowManager.load(value.specId).tasks.map((task) => task.id), ["T1"]);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects noncurrent command evidence while replacing the worker-owned test tree", () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      value.flowManager.publishArtifacts({
        specId: value.specId,
        nodeId: "test",
        artifactWrites: [{
          logicalKey: "tests.source",
          parameters: { testPath: "obsolete.test.js" },
          mediaType: "text/javascript",
          bytes: Buffer.from("// spec: R1\n", "utf8"),
        }],
      });
      assert.throws(
        () => writeScenarioRuntimeLog(value, "noncurrent command evidence\n"),
        /producer does not own the active Attempt/,
      );

      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(
        path.join(request.payloadPath("spec-tests"), "current.test.js"),
        "// spec: R1\nimport test from \"node:test\";\ntest(\"R1: current\", () => {});\n",
      );
      seal(request);
      value.coordinator.reconcile({ ctx: value.ctx, request });

      assert.throws(() => value.flowManager.artifactCatalog(value.specId).resolve("artifacts/tests/obsolete.test.js"));
      assert.equal(
        value.flowManager.artifactCatalog(value.specId)
          .resolve("artifacts/tests/current.test.js").logicalKey,
        "tests.source",
      );
      assert.equal(findStepById(value.flowManager.load().steps, "test").status, "done");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects spec tests that statically import a missing execution module", () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(
        path.join(request.payloadPath("spec-tests"), "future-module.test.js"),
        [
          "// spec: R1",
          "import test from 'node:test';",
          "import value from '../../../src/not-yet-implemented.js';",
          "test('R1: future module', () => value);",
          "",
        ].join("\n"),
      );
      seal(request);

      assert.throws(
        () => value.coordinator.reconcile({ ctx: value.ctx, request }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.classification === "invalid"
          && error.code === "FLOW_SPEC_TEST_BOOTSTRAP_INVALID"
          && error.retryable === true
          && /missing pre-implementation module/.test(error.message),
      );
      assert.equal(findStepById(value.flowManager.load().steps, "test").status, "in_progress");
      assert.equal(value.flowManager.artifactCatalog(value.specId).artifacts
        .some((entry) => entry.relativePath === "artifacts/tests/future-module.test.js"), false);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects worker output in the command-owned test evidence directory", () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const evidenceDir = path.join(request.payloadPath("spec-tests"), ".raw");
      fs.mkdirSync(evidenceDir);
      fs.writeFileSync(path.join(evidenceDir, "worker.log"), "not command-owned\n");

      assert.throws(
        () => seal(request),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.classification === "invalid"
          && error.code === "FLOW_ARTIFACT_HANDOFF_INVALID",
      );
      assert.equal(findStepById(value.flowManager.load().steps, "test").status, "in_progress");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("lets worktree and non-worktree dispatchers consume a sealed payload", async () => {
    for (const worktree of [true, false]) {
      const value = fixture("draft", { worktree });
      try {
      const nextAction = {
        async run() {
          return findStepById(value.flowManager.load().steps, "draft").status === "done"
            ? {
                taskId: null,
                step: null,
                action: "completed",
                instructions: null,
                context: null,
                output_schema: null,
                requires_approval: false,
                directive: { kind: "completed", terminal: true, requiresUserAction: false },
              }
            : {
                taskId: null,
                step: "draft",
                action: "write-draft",
                instructions: { key: "plan.draft", content: "Write the draft." },
                context: { workerArtifactHandoff: { required: true } },
                output_schema: {},
                requires_approval: false,
                maxAttempts: 1,
                directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "write-draft" },
              };
        },
      };
      let calls = 0;
      const dispatcher = new RunDispatchCommand({
        nextAction,
        agent: {
          async call(prompt, options) {
            calls += 1;
            assert.match(prompt, /parent dispatcher alone validates, publishes/i);
            const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
            const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
            fs.writeFileSync(
              request.payloads.find((entry) => entry.logicalName === "draft.json").payloadPath,
              json(draftDocument("dispatcher-owned handoff")),
            );
            sealWorkerArtifactHandoff({
              requestPath,
              invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
            });
            await persistAgentInvocationMetric({
              flowManager: value.flowManager,
              provider: "test-provider",
              profileKey: "flow-dispatch",
              usage: null,
              responseChars: 42,
              model: null,
              durationMs: 1,
            }, options.deferredMetric);
            return "worker report is not the completion signal";
          },
        },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(),
        expectRunId: "run-worker-handoff",
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(result.dispatch.boundary, "completed");
      assert.equal(result.dispatch.dispatchCount, 1);
      assert.equal(calls, 1);
      const completed = value.flowManager.load();
      assert.equal(findStepById(completed.steps, "draft").status, "done");
      assert.equal(completed.metrics.filter((entry) => entry.kind === "agent").length, 1);
      } finally {
        removeTmpDir(value.mainRoot);
      }
    }
  });

  it("allows an independent issue-log append while draft-refine publishes its declared output", async () => {
    const value = fixture("draft-refine", {
      beforeActivate(candidate) {
        publishDraftBeforeTarget(candidate, draftWithQuestionLedger([]));
      },
    });
    try {
      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run() {
            return findStepById(value.flowManager.load().steps, "draft-refine").status === "done"
              ? completedWorkerAction()
              : draftWorkerAction("draft-refine");
          },
        },
        agent: {
          async call(_prompt, options) {
            const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
            const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
            fs.writeFileSync(
              request.payloads.find((entry) => entry.logicalName === "draft.json").payloadPath,
              json({ ...draftWithQuestionLedger([]), goal: "refined after issue-log append" }),
            );
            sealWorkerArtifactHandoff({
              requestPath,
              invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
            });
            value.flowManager.appendIssueLog({
              specId: value.specId,
              entry: {
                step: "draft-refine",
                reason: "Independent observation recorded during worker execution.",
              },
              idempotencyKey: "draft-refine-concurrent-issue-log",
            });
          },
        },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};

      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(),
        expectRunId: "run-worker-handoff",
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(result.dispatch.boundary, "completed");
      assert.equal(result.dispatch.dispatchCount, 1);
      assert.equal(findStepById(value.flowManager.load().steps, "draft-refine").status, "done");
      assert.deepEqual(readCatalogJson(value, "draft", "draft-refine"), {
        ...draftWithQuestionLedger([]),
        goal: "refined after issue-log append",
      });
      const issueLog = readCatalogJson(value, "issue.log", "draft-refine");
      assert.equal(issueLog.entries.length, 1);
      assert.equal(issueLog.entries[0].issueLogId, "draft-refine-concurrent-issue-log");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("promotes a sealed draft-refine Candidate, retains the Attempt, and records an idempotent receipt", async () => {
    const candidate = draftWithQuestionLedger([candidateDraftQuestion({ revision: 4 })]);
    const value = fixture("draft-refine", {
      beforeActivate(fixtureValue) {
        publishDraftBeforeTarget(fixtureValue, candidate);
      },
    });
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(request.payloadPath("draft.json"), json(candidate));
      seal(request);
      const submission = JSON.parse(fs.readFileSync(request.submissionPath, "utf8"));
      const beforeActivities = value.flowManager.activityLedger(value.specId).length;

      const completed = value.coordinator.reconcile({ ctx: value.ctx, request });
      const persisted = readCatalogJson(value, "draft", "draft-refine");
      const activity = value.flowManager.activityLedger(value.specId).at(-1);
      const next = await new GetNextActionCommand().execute({
        ...value.ctx,
        specId: value.specId,
        flowState: value.flowManager.load(value.specId),
      });

      assert.equal(completed.completed, true);
      assert.equal(completed.replayed, false);
      assert.equal(completed.handoffDigest, submission.handoffDigest);
      assert.equal(fs.existsSync(request.directory), false, "completed handoff must be cleaned up");
      assert.equal(findStepById(value.flowManager.load().steps, "draft-refine").status, "in_progress");
      assert.equal(value.flowManager.canonicalState(value.specId).current.at(-1), "draft-refine");
      assert.equal(persisted.questionLedger.revision, 1);
      assert.equal(persisted.questionLedger.questions[0].state, "AwaitingUserAnswer");
      assert.equal(persisted.questionLedger.questions[0].revision, 5);
      assert.deepEqual(activity.references.artifacts.map(({ id, label }) => ({ id, label })), [
        { id: submission.handoffDigest, label: "draft-refine handoff" },
        { id: request.requestDigest, label: "draft-refine handoff request" },
        { id: submission.payloadManifest[0].digest, label: "draft-refine sealed draft payload" },
        {
          id: value.flowManager.readArtifact({
            specId: value.specId,
            logicalKey: "draft",
            consumerNodeId: "draft-refine",
          }).descriptor.hash,
          label: "draft question q1@4 promoted artifact",
        },
      ]);
      assert.equal(next.directive.kind, "await_draft_question");
      assert.equal(next.directive.questionId, "q1");
      assert.equal(next.directive.questionRevision, 5);

      const replay = value.coordinator.reconcile({ ctx: value.ctx, request });
      assert.equal(replay.completed, true);
      assert.equal(replay.replayed, true);
      assert.equal(value.flowManager.activityLedger(value.specId).length, beforeActivities + 1);
      assert.equal(readCatalogJson(value, "draft", "draft-refine").questionLedger.questions[0].revision, 5);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("keeps normal draft-refine confirmation and coverage advance when promotion is not selected", async () => {
    for (const { name, autoApprove, source } of [
      { name: "no Candidate", autoApprove: false, source: draftWithQuestionLedger([]) },
      { name: "autoApprove Candidate", autoApprove: true, source: draftWithQuestionLedger([candidateDraftQuestion()]) },
    ]) {
      const value = fixture("draft-refine", {
        autoApprove,
        beforeActivate(fixtureValue) {
          publishDraftBeforeTarget(fixtureValue, source);
        },
      });
      try {
        const request = value.coordinator.createRequest({
          ctx: value.ctx,
          state: value.flowManager.load(),
          invocation: value.invocation,
        });
        fs.writeFileSync(request.payloadPath("draft.json"), json(source));
        seal(request);
        value.coordinator.reconcile({ ctx: value.ctx, request });
        const next = await new GetNextActionCommand().execute({
          ...value.ctx,
          specId: value.specId,
          flowState: value.flowManager.load(value.specId),
        });

        assert.equal(findStepById(value.flowManager.load().steps, "draft-refine").status, "done", name);
        assert.equal(next.step, "draft-coverage-review", name);
      } finally {
        removeTmpDir(value.mainRoot);
      }
    }
  });

  it("rejects an AwaitingUserAnswer left in draft-refine output for manual and autoApprove flows", () => {
    for (const autoApprove of [false, true]) {
      const source = draftWithQuestionLedger([]);
      const awaiting = draftWithQuestionLedger([{
        state: "AwaitingUserAnswer",
        id: "q1",
        category: "goal-confirmation",
        question: "Which public behavior should be selected?",
        revision: 0,
        provenance: { producer: "worker" },
        evidenceDigest: "a".repeat(64),
      }]);
      const value = fixture("draft-refine", {
        autoApprove,
        beforeActivate(fixtureValue) {
          publishDraftBeforeTarget(fixtureValue, source);
        },
      });
      try {
        const request = value.coordinator.createRequest({
          ctx: value.ctx,
          state: value.flowManager.load(),
          invocation: value.invocation,
        });
        fs.writeFileSync(request.payloadPath("draft.json"), json(awaiting));
        seal(request);
        const before = {
          bytes: value.flowManager.readArtifact({ specId: value.specId, logicalKey: "draft", consumerNodeId: "draft-refine" }).bytes,
          activities: value.flowManager.activityLedger(value.specId).length,
          state: value.flowManager.canonicalState(value.specId).toJSON(),
        };

        assert.throws(
          () => value.coordinator.reconcile({ ctx: value.ctx, request }),
          (error) => error instanceof WorkerArtifactHandoffError && error.code === "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED",
        );
        assert.deepEqual(value.flowManager.readArtifact({ specId: value.specId, logicalKey: "draft", consumerNodeId: "draft-refine" }).bytes, before.bytes);
        assert.equal(value.flowManager.activityLedger(value.specId).length, before.activities);
        assert.deepEqual(value.flowManager.canonicalState(value.specId).toJSON(), before.state);
        assert.equal(fs.existsSync(request.directory), true);
      } finally {
        removeTmpDir(value.mainRoot);
      }
    }
  });

  it("does not publish or consume a Candidate handoff interrupted before promotion", () => {
    const candidate = draftWithQuestionLedger([candidateDraftQuestion()]);
    const value = fixture("draft-refine", {
      beforeActivate(fixtureValue) {
        publishDraftBeforeTarget(fixtureValue, candidate);
      },
    });
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(request.payloadPath("draft.json"), json(candidate));
      seal(request);
      const before = {
        bytes: value.flowManager.readArtifact({ specId: value.specId, logicalKey: "draft", consumerNodeId: "draft-refine" }).bytes,
        catalog: value.flowManager.artifactCatalog(value.specId).toJSON(),
        activities: value.flowManager.activityLedger(value.specId).length,
        state: value.flowManager.canonicalState(value.specId).toJSON(),
      };
      const crashing = new WorkerArtifactHandoffCoordinator({
        faultInjector({ phase }) {
          if (phase === "before-worker-handoff-publication") throw new Error("simulated promotion crash");
        },
      });

      assert.throws(
        () => crashing.reconcile({ ctx: value.ctx, request }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED",
      );
      assert.deepEqual(value.flowManager.readArtifact({ specId: value.specId, logicalKey: "draft", consumerNodeId: "draft-refine" }).bytes, before.bytes);
      assert.deepEqual(value.flowManager.artifactCatalog(value.specId).toJSON(), before.catalog);
      assert.equal(value.flowManager.activityLedger(value.specId).length, before.activities);
      assert.deepEqual(value.flowManager.canonicalState(value.specId).toJSON(), before.state);
      assert.equal(fs.existsSync(request.directory), true, "uncommitted handoff must remain recoverable");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects canonical-main mutations made outside the handoff payload authority and keeps the catalog fail-closed", () => {
    const value = fixture("draft", { worktree: true });
    try {
      initializeGitRepository(value);
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      const illicitPath = path.join(canonicalSpecDir(value), "draft.json");
      fs.writeFileSync(illicitPath, json({ goal: "illicit canonical write" }));

      assert.throws(
        () => authority.assertUnchanged(),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_VIOLATION"
          && error.data.authorities.includes("canonical")
          && error.data.changedPaths.some((entry) => entry.endsWith("draft.json")),
      );
      assert.throws(
        () => value.flowManager.load(),
        /Version storage contains an unclassified artifact: draft\.json/,
      );
      fs.unlinkSync(illicitPath);
      assert.equal(findStepById(value.flowManager.load().steps, "draft").status, "in_progress");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("accepts unchanged pre-existing Git dirt but rejects any further mutation", () => {
    const value = fixture("draft", { worktree: false });
    try {
      initializeGitRepository(value);
      const productPath = path.join(value.mainRoot, "product.js");
      const untrackedPath = path.join(value.mainRoot, "preexisting.json");
      fs.writeFileSync(productPath, "export const value = 2;\n");
      fs.writeFileSync(untrackedPath, json({ value: 1 }));
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);

      fs.writeFileSync(request.payloadPath("draft.json"), json({ goal: "payload-only write" }));
      seal(request);
      assert.doesNotThrow(() => authority.assertUnchanged());

      fs.writeFileSync(productPath, "export const value = 3;\n");
      fs.writeFileSync(untrackedPath, json({ value: 2 }));
      assert.throws(
        () => authority.assertUnchanged(),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_VIOLATION"
          && error.data.changedPaths.includes("product.js")
          && error.data.changedPaths.includes(
            path.relative(value.mainRoot, untrackedPath).split(path.sep).join("/"),
          ),
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("ignores current Version Store locks but rejects another Version and source mutations", () => {
    const value = fixture("draft", { worktree: false });
    try {
      initializeGitRepository(value);
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
      const currentLocation = value.flowManager.specLocation(value.specId);
      const currentLocks = [
        acquireRuntimeLock(currentLocation, "runtime.lock.artifact-catalog"),
        acquireRuntimeLock(currentLocation, "runtime.lock.current-flow-state"),
      ];
      const ownerTemp = path.join(
        currentLocks[0].runtimeLock.directory,
        ProcessLock.ownerTemporaryFileName(currentLocks[0].runtimeLock.fileName, crypto.randomUUID()),
      );
      fs.writeFileSync(ownerTemp, "transient owner publication\n");
      const runtimeDirectory = path.join(value.mainRoot, ".sennel");
      fs.writeFileSync(path.join(runtimeDirectory, ".repository-flow-operation.lock"), "runtime lock\n");
      fs.writeFileSync(path.join(runtimeDirectory, ".flow-dispatch-concurrent.lock"), "dispatch lock\n");
      fs.mkdirSync(path.join(runtimeDirectory, "output"), { recursive: true });
      fs.writeFileSync(path.join(runtimeDirectory, "output", "concurrent.json"), "{}\n");

      try {
        assert.doesNotThrow(() => authority.assertUnchanged());

        const foreignReviewWorkUnit = path.join(
          value.mainRoot,
          ".sennel",
          "review-work-units",
          "foreign-run",
          "foreign-attempt",
          "impl-review.json",
        );
        fs.mkdirSync(path.dirname(foreignReviewWorkUnit), { recursive: true });
        fs.writeFileSync(foreignReviewWorkUnit, "{}\n");
        try {
          assert.throws(
            () => authority.assertUnchanged(),
            (error) => error instanceof WorkerArtifactHandoffError
              && error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_VIOLATION"
              && error.data.changedPaths.includes(path.relative(
                value.mainRoot,
                foreignReviewWorkUnit,
              ).split(path.sep).join("/")),
          );
        } finally {
          fs.rmSync(path.join(value.mainRoot, ".sennel", "review-work-units"), { recursive: true, force: true });
        }

        const unexpectedCurrentVersionRuntimePath = path.join(
          currentLocks[0].runtimeLock.directory,
          "unexpected-worker-runtime.lock",
        );
        fs.writeFileSync(unexpectedCurrentVersionRuntimePath, "worker mutation\n");
        try {
          assert.throws(
            () => authority.assertUnchanged(),
            (error) => error instanceof WorkerArtifactHandoffError
              && error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_VIOLATION"
              && error.data.changedPaths.includes(path.relative(
                value.mainRoot,
                unexpectedCurrentVersionRuntimePath,
              ).split(path.sep).join("/")),
          );
        } finally {
          fs.rmSync(unexpectedCurrentVersionRuntimePath, { force: true });
        }

        const otherLocation = new FlowManager({
          root: value.mainRoot,
          mainRoot: value.mainRoot,
          inWorktree: false,
          specId: "501-other-version",
        }).specLocation("501-other-version");
        const otherLock = acquireRuntimeLock(otherLocation, "runtime.lock.artifact-catalog");
        try {
          assert.throws(
            () => authority.assertUnchanged(),
            (error) => error instanceof WorkerArtifactHandoffError
              && error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_VIOLATION"
              && error.data.changedPaths.includes(otherLock.runtimeLock.relativeRepositoryPath),
          );
        } finally {
          otherLock.lock.release();
        }

        fs.writeFileSync(path.join(value.mainRoot, "product.js"), "export const value = 2;\n");
        assert.throws(
          () => authority.assertUnchanged(),
          (error) => error instanceof WorkerArtifactHandoffError
            && error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_VIOLATION"
            && error.data.changedPaths.includes("product.js"),
        );
      } finally {
        fs.rmSync(ownerTemp, { force: true });
        for (const entry of currentLocks.reverse()) entry.lock.release();
      }
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("isolates the current canonical Version from pre-existing and newly-created Flow Versions in a worktree", () => {
    const value = fixture("draft", { worktree: true });
    try {
      const otherSpecId = "501-unrelated-flow";
      const otherManager = new FlowManager({
        root: value.mainRoot,
        mainRoot: value.mainRoot,
        inWorktree: false,
        specId: otherSpecId,
      });
      new CanonicalFlowFixture({
        flowManager: otherManager,
        specId: otherSpecId,
        runId: "run-unrelated-flow",
        request: "Publish unrelated Flow state.",
        execution: { mode: "direct", baseBranch: "main", featureBranch: null },
      }).create().activate("draft");
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);

      otherManager.updateStepStatus({ specId: otherSpecId, stepId: "draft", requestedStatus: "done" });
      assert.doesNotThrow(() => authority.assertUnchanged(), "an existing unrelated Version is outside this handoff scope");

      const laterSpecId = "502-later-unrelated-flow";
      const laterManager = new FlowManager({
        root: value.mainRoot,
        mainRoot: value.mainRoot,
        inWorktree: false,
        specId: laterSpecId,
      });
      new CanonicalFlowFixture({
        flowManager: laterManager,
        specId: laterSpecId,
        runId: "run-later-unrelated-flow",
        request: "Create a later unrelated Flow.",
        execution: { mode: "direct", baseBranch: "main", featureBranch: null },
      }).create();
      assert.doesNotThrow(() => authority.assertUnchanged(), "a Version created after capture is outside this handoff scope");

      const illicitPath = path.join(canonicalSpecDir(value), "draft.json");
      fs.writeFileSync(illicitPath, json({ goal: "current Version mutation" }));
      assert.throws(
        () => authority.assertUnchanged(),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_VIOLATION"
          && error.data.authorities.includes("canonical"),
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects execution source, Git index, HEAD, and untracked project mutations", () => {
    const cases = [
      {
        expected: "product.js",
        mutate(value) {
          fs.writeFileSync(path.join(value.mainRoot, "product.js"), "export const value = 2;\n");
        },
      },
      {
        expected: "<index>",
        mutate(value) {
          fs.writeFileSync(path.join(value.mainRoot, "product.js"), "export const value = 2;\n");
          execFileSync("git", ["add", "product.js"], { cwd: value.mainRoot });
        },
      },
      {
        expected: "<HEAD>",
        mutate(value) {
          execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "worker mutation"], {
            cwd: value.mainRoot,
          });
        },
      },
      {
        expected: "worker-untracked.txt",
        mutate(value) {
          fs.writeFileSync(path.join(value.mainRoot, "worker-untracked.txt"), "worker mutation\n");
        },
      },
    ];

    for (const scenario of cases) {
      const value = fixture("draft", { worktree: false });
      try {
        initializeGitRepository(value);
        const request = value.coordinator.createRequest({
          ctx: value.ctx,
          state: value.flowManager.load(),
          invocation: value.invocation,
        });
        const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);
        scenario.mutate(value);

        assert.throws(
          () => authority.assertUnchanged(),
          (error) => error instanceof WorkerArtifactHandoffError
            && error.code === "FLOW_ARTIFACT_HANDOFF_AUTHORITY_VIOLATION"
            && error.data.changedPaths.includes(scenario.expected),
          scenario.expected,
        );
      } finally {
        removeTmpDir(value.mainRoot);
      }
    }
  });

  it("does not content-scan clean historical specs in a Git repository", () => {
    const value = fixture("draft", { worktree: false });
    try {
      const historyDir = path.join(value.mainRoot, "specs", "history");
      fs.mkdirSync(historyDir, { recursive: true });
      for (let index = 0; index < 200; index += 1) {
        fs.writeFileSync(path.join(historyDir, `${index}.json`), json({ index }));
      }
      initializeGitRepository(value);
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const authority = WorkerArtifactMutationAuthoritySnapshot.capture(request);

      assert.equal(authority.repositories.length, 1);
      assert.equal(authority.repositories[0].mode, "git");
      assert.deepEqual(authority.repositories[0].entries, []);
      assert.doesNotThrow(() => authority.assertUnchanged());
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("retries one missing handoff without spending semantic retries", async () => {
    const value = fixture();
    try {
      let calls = 0;
      const action = {
        taskId: null,
        step: "draft",
        action: "write-draft",
        instructions: { key: "plan.draft", content: "Write the draft." },
        context: { workerArtifactHandoff: { required: true } },
        output_schema: {},
        requires_approval: false,
        maxAttempts: 1,
        directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "write-draft" },
      };
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() { return structuredClone(action); } },
        agent: { async call() { calls += 1; return "premature report"; } },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(),
        expectRunId: "run-worker-handoff",
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(result.errors[0].code, "FLOW_ARTIFACT_HANDOFF_RETRY_EXHAUSTED");
      assert.equal(result.data.retryBudgetConsumed, false);
      assert.equal(result.data.dispatch.dispatchCount, 2);
      assert.equal(calls, 2);
      const state = value.flowManager.load();
      assert.equal(findStepById(state.steps, "draft").status, "in_progress");
      assert.equal(state.metrics.filter((entry) => entry.kind === "agent").length, 2);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("retries malformed JSON transport once and preserves ordered failure evidence on re-failure", async () => {
    for (const scenario of [
      { name: "recovers", secondPayload: json(draftDocument("recovered after malformed transport")), expectedCode: null },
      { name: "exhausts", secondPayload: "{ malformed again\n", expectedCode: "FLOW_ARTIFACT_HANDOFF_RETRY_EXHAUSTED" },
    ]) {
      const value = fixture("draft", { specRecord: validSpec() });
      try {
        let calls = 0;
        const action = draftWorkerAction();
        const dispatcher = new RunDispatchCommand({
          nextAction: {
            async run() {
              return calls >= 2 && scenario.expectedCode === null
                ? completedWorkerAction()
                : structuredClone(action);
            },
          },
          agent: {
            async call(prompt, options) {
              calls += 1;
              const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
              const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
              const payloadPath = request.payloads.find((entry) => entry.logicalName === "draft.json").payloadPath;
              if (calls === 1) {
                fs.writeFileSync(payloadPath, "{ malformed\n");
                if (scenario.expectedCode !== null) {
                  options.onSupervisorEvent({ type: "timeout", attempt: "first" });
                  throw new AgentTimeoutFailure({ message: "first retryable producer timeout", cause: Object.assign(new Error("first timeout"), { stdout: "first stdout", stderr: "first stderr" }) });
                }
                return;
              }
              assert.match(prompt, /Fresh worker handoff retry feedback/);
              fs.writeFileSync(payloadPath, scenario.secondPayload);
              if (scenario.expectedCode === null) {
                sealWorkerArtifactHandoff({
                  requestPath,
                  invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
                });
              } else {
                options.onSupervisorEvent({ type: "timeout", attempt: "second" });
                throw new AgentTimeoutFailure({ message: "second retryable producer timeout", cause: Object.assign(new Error("second timeout"), { stdout: "second stdout", stderr: "second stderr" }) });
              }
            },
          },
          repositoryFingerprint: () => "stable-fixture",
          leaseFactory: () => ({ acquire() {}, release() {} }),
        });
        dispatcher.container = {};

        const result = await dispatcher.execute({
          ...value.ctx,
          flowState: value.flowManager.load(),
          expectRunId: value.flowManager.load().runId,
          expectSpec: value.specId,
          _envelopeType: "run",
          _envelopeKey: "dispatch",
        });

        assert.equal(calls, 2, scenario.name);
        if (scenario.expectedCode === null) {
          assert.equal(result.dispatch.boundary, "completed", scenario.name);
          assert.equal(findStepById(value.flowManager.load().steps, "draft").status, "done");
        } else {
          assert.equal(result.errors[0].code, scenario.expectedCode, scenario.name);
          assert.equal(result.data.retryExhausted, true, scenario.name);
          assert.equal(result.data.attempts, 2, scenario.name);
          assert.match(result.data.first.message, /malformed JSON/, scenario.name);
          assert.deepEqual(result.data.agentFailures.map((entry) => entry.code), ["AGENT_TIMEOUT", "AGENT_TIMEOUT"], scenario.name);
          assert.deepEqual(result.data.agentFailures.map((entry) => entry.stdout), ["first stdout", "second stdout"], scenario.name);
          assert.deepEqual(result.data.agentFailures.map((entry) => entry.supervisorEvents.at(-1).attempt), ["first", "second"], scenario.name);
          assert.deepEqual(result.data.agentFailures.map((entry) => entry.cause.message), ["first timeout", "second timeout"], scenario.name);
          assert.match(result.data.second.message, /malformed JSON/, scenario.name);
          assert.equal(findStepById(value.flowManager.load().steps, "draft").status, "in_progress");
        }
      } finally {
        removeTmpDir(value.mainRoot);
      }
    }
  });

  it("exposes the complete spec-triage delta schema and retries old missing payload fields once", async () => {
    const value = prepareSpecTriageFixture();
    try {
      const action = specTriageWorkerAction();
      const schema = specTriageDeltaPayloadSchema();
      assert.notDeepEqual(schema, action.output_schema);
      let calls = 0;
      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run() {
            return findStepById(value.flowManager.load().steps, "spec-triage").status === "done"
              ? completedWorkerAction()
              : structuredClone(action);
          },
        },
        agent: {
          async call(prompt, options) {
            calls += 1;
            assert.deepEqual(options.jsonSchema, action.output_schema);
            assert.match(options.fmtFallback, /Spec triage review delta schema:/);
            assert.ok(options.fmtFallback.includes(JSON.stringify(schema, null, 2)));
            assert.match(prompt, /canonical spec-triage review delta guidance when writing review\.delta\.json:/);
            assert.doesNotMatch(prompt, /canonical spec artifact guidance when writing spec\.json:/);
            assert.match(prompt, /Spec triage review delta schema:/);
            assert.ok(prompt.includes(JSON.stringify(schema, null, 2)));
            const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
            const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
            const payloadPath = request.payloads.find((entry) => entry.logicalName === "review.delta.json").payloadPath;
            if (calls === 1) {
              const missingFields = validSpecTriagePayload(request);
              delete missingFields.baseReviewDigest;
              delete missingFields.operations;
              fs.writeFileSync(payloadPath, json(missingFields));
              assert.throws(
                () => sealWorkerArtifactHandoff({
                  requestPath,
                  invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
                }),
                (error) => error instanceof WorkerArtifactHandoffError
                  && error.code === "FLOW_ARTIFACT_HANDOFF_INVALID"
                  && error.retryable === true,
              );
              return;
            }
            assert.match(prompt, /Fresh worker handoff retry feedback/);
            fs.writeFileSync(payloadPath, json(validSpecTriagePayload(request)));
            sealWorkerArtifactHandoff({
              requestPath,
              invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
            });
          },
        },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};

      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(),
        expectRunId: value.flowManager.load().runId,
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });
      assert.equal(calls, 2);
      assert.equal(result.dispatch.boundary, "completed", JSON.stringify(result, null, 2));
      assert.equal(findStepById(value.flowManager.load().steps, "spec-triage").status, "done");
      assert.equal(
        value.flowManager.readCurrentSpecReview({ specId: value.specId, consumerNodeId: "spec-repair" })
          .review.audit.at(-1).stage,
        "spec-triage",
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("exposes the complete spec-repair delta schema and retries old missing payload fields once", async () => {
    const value = prepareSpecRepairFixture();
    try {
      const action = specRepairWorkerAction();
      const schema = specRepairDeltaPayloadSchema();
      assert.notDeepEqual(schema, action.output_schema);
      assert.equal(schema.properties.stage.const, "spec-repair");
      assert.equal(schema.properties.findings.maxItems, 0);
      let calls = 0;
      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run() {
            return findStepById(value.flowManager.load().steps, "spec-repair").status === "done"
              ? completedWorkerAction()
              : structuredClone(action);
          },
        },
        agent: {
          async call(prompt, options) {
            calls += 1;
            assert.deepEqual(options.jsonSchema, action.output_schema);
            assert.match(options.fmtFallback, /Spec repair review delta schema:/);
            assert.doesNotMatch(options.fmtFallback, /Spec triage review delta schema:/);
            assert.ok(options.fmtFallback.includes(JSON.stringify(schema, null, 2)));
            assert.match(prompt, /canonical spec-repair review delta guidance when writing review\.delta\.json:/);
            assert.doesNotMatch(prompt, /canonical spec-triage review delta guidance/i);
            assert.ok(prompt.includes(JSON.stringify(schema, null, 2)));
            const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
            const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
            const payloadPath = request.payloads.find((entry) => entry.logicalName === "review.delta.json").payloadPath;
            if (calls === 1) {
              const invalid = validSpecRepairPayload(request);
              delete invalid.baseReviewDigest;
              delete invalid.findings;
              fs.writeFileSync(payloadPath, json(invalid));
              assert.throws(
                () => sealWorkerArtifactHandoff({
                  requestPath,
                  invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
                }),
                (error) => error instanceof WorkerArtifactHandoffError && error.retryable === true,
              );
              return;
            }
            assert.match(prompt, /Fresh worker handoff retry feedback/);
            fs.writeFileSync(payloadPath, json(validSpecRepairPayload(request)));
            sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
          },
        },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(),
        expectRunId: value.flowManager.load().runId,
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });
      assert.equal(calls, 2);
      assert.ok(result.dispatch, JSON.stringify(result, null, 2));
      assert.equal(result.dispatch.boundary, "completed", JSON.stringify(result, null, 2));
      assert.equal(findStepById(value.flowManager.load().steps, "spec-repair").status, "done");
      assert.equal(
        value.flowManager.readCurrentSpecReview({ specId: value.specId, consumerNodeId: "spec-gate" })
          .review.audit.at(-1).stage,
        "spec-repair",
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("stops spec-repair after its one payload-format retry while leaving revision binding terminal", async () => {
    const scenarios = [
      {
        name: "format retry exhaustion",
        payload(request) {
          const invalid = validSpecRepairPayload(request);
          delete invalid.findings;
          return invalid;
        },
        expectedCode: "FLOW_ARTIFACT_HANDOFF_RETRY_EXHAUSTED",
        expectedCalls: 2,
      },
      {
        name: "review binding failure",
        payload(request) {
          return { ...validSpecRepairPayload(request), baseReviewDigest: "f".repeat(64) };
        },
        expectedCode: "FLOW_ARTIFACT_HANDOFF_INVALID",
        expectedCalls: 1,
      },
      {
        name: "identity binding failure",
        payload(request) {
          const invalid = validSpecRepairPayload(request);
          invalid.identity = { ...invalid.identity, digest: "f".repeat(64) };
          return invalid;
        },
        expectedCode: "FLOW_ARTIFACT_HANDOFF_INVALID",
        expectedCalls: 1,
      },
    ];
    for (const scenario of scenarios) {
      const value = prepareSpecRepairFixture();
      try {
        let calls = 0;
        const dispatcher = new RunDispatchCommand({
          nextAction: { async run() { return structuredClone(specRepairWorkerAction()); } },
          agent: {
            async call(_prompt, options) {
              calls += 1;
              const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
              const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
              const payloadPath = request.payloads.find((entry) => entry.logicalName === "review.delta.json").payloadPath;
              fs.writeFileSync(payloadPath, json(scenario.payload(request)));
              assert.throws(
                () => sealWorkerArtifactHandoff({
                  requestPath,
                  invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
                }),
                (error) => error instanceof WorkerArtifactHandoffError
                  && error.code === "FLOW_ARTIFACT_HANDOFF_INVALID"
                  && error.retryable === (scenario.expectedCalls === 2),
              );
            },
          },
          repositoryFingerprint: () => "stable-fixture",
          leaseFactory: () => ({ acquire() {}, release() {} }),
        });
        dispatcher.container = {};

        const result = await dispatcher.execute({
          ...value.ctx,
          flowState: value.flowManager.load(),
          expectRunId: value.flowManager.load().runId,
          expectSpec: value.specId,
          _envelopeType: "run",
          _envelopeKey: "dispatch",
        });

        assert.equal(calls, scenario.expectedCalls, scenario.name);
        assert.equal(result.errors[0].code, scenario.expectedCode, scenario.name);
        if (scenario.expectedCalls === 2) {
          assert.equal(result.data.retryExhausted, true, scenario.name);
          assert.equal(result.data.attempts, 2, scenario.name);
        } else {
          assert.equal(result.data.retryable, false, scenario.name);
        }
        assert.equal(findStepById(value.flowManager.load().steps, "spec-repair").status, "in_progress", scenario.name);
        assert.equal(
          value.flowManager.readCurrentSpecReview({ specId: value.specId, consumerNodeId: "spec-repair" })
            .review.audit.length,
          2,
          scenario.name,
        );
      } finally {
        removeTmpDir(value.mainRoot);
      }
    }
  });

  it("stops spec-triage after its one payload-format retry while leaving revision binding terminal", async () => {
    const scenarios = [
      {
        name: "format retry exhaustion",
        payload(request) {
          const invalid = validSpecTriagePayload(request);
          delete invalid.operations;
          return invalid;
        },
        expectedCode: "FLOW_ARTIFACT_HANDOFF_RETRY_EXHAUSTED",
        expectedCalls: 2,
      },
      {
        name: "revision binding failure",
        payload(request) {
          return { ...validSpecTriagePayload(request), baseReviewDigest: "f".repeat(64) };
        },
        expectedCode: "FLOW_ARTIFACT_HANDOFF_INVALID",
        expectedCalls: 1,
      },
      {
        name: "identity binding failure",
        payload(request) {
          const invalid = validSpecTriagePayload(request);
          invalid.identity = { ...invalid.identity, digest: "f".repeat(64) };
          return invalid;
        },
        expectedCode: "FLOW_ARTIFACT_HANDOFF_INVALID",
        expectedCalls: 1,
      },
    ];
    for (const scenario of scenarios) {
      const value = prepareSpecTriageFixture();
      try {
        let calls = 0;
        const dispatcher = new RunDispatchCommand({
          nextAction: { async run() { return structuredClone(specTriageWorkerAction()); } },
          agent: {
            async call(_prompt, options) {
              calls += 1;
              const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
              const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
              const payloadPath = request.payloads.find((entry) => entry.logicalName === "review.delta.json").payloadPath;
              fs.writeFileSync(payloadPath, json(scenario.payload(request)));
              assert.throws(
                () => sealWorkerArtifactHandoff({
                  requestPath,
                  invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
                }),
                (error) => error instanceof WorkerArtifactHandoffError
                  && error.code === "FLOW_ARTIFACT_HANDOFF_INVALID"
                  && error.retryable === (scenario.expectedCalls === 2),
              );
            },
          },
          repositoryFingerprint: () => "stable-fixture",
          leaseFactory: () => ({ acquire() {}, release() {} }),
        });
        dispatcher.container = {};

        const result = await dispatcher.execute({
          ...value.ctx,
          flowState: value.flowManager.load(),
          expectRunId: value.flowManager.load().runId,
          expectSpec: value.specId,
          _envelopeType: "run",
          _envelopeKey: "dispatch",
        });

        assert.equal(calls, scenario.expectedCalls, scenario.name);
        assert.equal(result.errors[0].code, scenario.expectedCode, scenario.name);
        if (scenario.expectedCalls === 2) {
          assert.equal(result.data.retryExhausted, true, scenario.name);
          assert.equal(result.data.attempts, 2, scenario.name);
        } else {
          assert.equal(result.data.retryable, false, scenario.name);
        }
        assert.equal(findStepById(value.flowManager.load().steps, "spec-triage").status, "in_progress", scenario.name);
        assert.equal(
          value.flowManager.readCurrentSpecReview({ specId: value.specId, consumerNodeId: "spec-triage" })
            .review.audit.length,
          1,
          scenario.name,
        );
      } finally {
        removeTmpDir(value.mainRoot);
      }
    }
  });

  it("keeps handoff failure precedence when deferred metric persistence is advisory", async () => {
    const value = fixture();
    const originalWrite = process.stderr.write;
    const originalAccumulate = value.flowManager.accumulateAgentMetrics;
    let stderr = "";
    let calls = 0;
    try {
      const action = {
        taskId: null,
        step: "draft",
        action: "write-draft",
        instructions: { key: "plan.draft", content: "Write the draft." },
        context: { workerArtifactHandoff: { required: true } },
        output_schema: {},
        requires_approval: false,
        maxAttempts: 1,
        directive: { kind: "execute_step", terminal: false, requiresUserAction: false, action: "write-draft" },
      };
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() { return structuredClone(action); } },
        agent: {
          async call() {
            calls += 1;
            throw new Error("simulated provider failure");
          },
        },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      value.flowManager.accumulateAgentMetrics = () => {
        throw new Error("simulated metric persistence failure");
      };
      process.stderr.write = (chunk) => { stderr += String(chunk); return true; };

      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(),
        expectRunId: "run-worker-handoff",
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(result.errors[0].code, "FLOW_ARTIFACT_HANDOFF_RETRY_EXHAUSTED");
      assert.equal(calls, 2);
      assert.match(stderr, /metric accumulation failed: simulated metric persistence failure/);
      assert.equal(findStepById(value.flowManager.load().steps, "draft").status, "in_progress");
    } finally {
      process.stderr.write = originalWrite;
      value.flowManager.accumulateAgentMetrics = originalAccumulate;
      removeTmpDir(value.mainRoot);
    }
  });

  it("classifies a missing sealed submission without consuming semantic retry budget", () => {
    const value = fixture();
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      assert.throws(
        () => value.coordinator.reconcile({ ctx: value.ctx, request }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.classification === "missing"
          && error.code === "FLOW_ARTIFACT_HANDOFF_MISSING",
      );
      const state = value.flowManager.load();
      assert.equal(findStepById(state.steps, "draft").status, "in_progress");
      assert.equal(state.workerArtifactPublication, undefined);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects symlink payloads and post-seal payload tampering", () => {
    const value = fixture();
    const outside = path.join(value.mainRoot, "outside.json");
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(outside, json({ goal: "outside" }));
      fs.symlinkSync(outside, request.payloadPath("draft.json"));
      assert.throws(
        () => seal(request),
        (error) => error instanceof WorkerArtifactHandoffError && error.classification === "invalid",
      );
      fs.unlinkSync(request.payloadPath("draft.json"));
      fs.writeFileSync(request.payloadPath("draft.json"), json(draftDocument("sealed")));
      seal(request);
      fs.writeFileSync(request.payloadPath("draft.json"), json(draftDocument("tampered")));
      assert.throws(
        () => value.coordinator.reconcile({ ctx: value.ctx, request }),
        (error) => error instanceof WorkerArtifactHandoffError && error.classification === "invalid",
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("parent validation rejects every undeclared entry added after sealing", () => {
    for (const kind of ["file", "directory", "symlink"]) {
      const value = fixture();
      const outside = path.join(value.mainRoot, "outside.js");
      try {
        const request = value.coordinator.createRequest({
          ctx: value.ctx,
          state: value.flowManager.load(),
          invocation: value.invocation,
        });
        fs.writeFileSync(request.payloadPath("draft.json"), json(draftDocument("sealed")));
        seal(request);
        if (kind === "file") {
          fs.writeFileSync(path.join(request.payloadDirectory, "unknown.js"), "export default true;\n");
        } else if (kind === "directory") {
          fs.mkdirSync(path.join(request.payloadDirectory, "unknown"));
        } else {
          fs.writeFileSync(outside, "export default false;\n");
          fs.symlinkSync(outside, path.join(request.payloadDirectory, "unknown.js"));
        }

        assert.throws(
          () => value.coordinator.reconcile({ ctx: value.ctx, request }),
          (error) => error instanceof WorkerArtifactHandoffError
            && error.classification === "invalid"
            && error.code === "FLOW_ARTIFACT_HANDOFF_INVALID",
          kind,
        );
        const unknownPath = path.join(request.payloadDirectory, kind === "directory" ? "unknown" : "unknown.js");
        if (kind === "directory") fs.rmSync(unknownPath, { recursive: true });
        else fs.unlinkSync(unknownPath);
        assert.equal(findStepById(value.flowManager.load().steps, "draft").status, "in_progress");
        assert.equal(fs.existsSync(path.join(canonicalSpecDir(value), "draft.json")), false);
      } finally {
        removeTmpDir(value.mainRoot);
      }
    }
  });

  it("rejects stale identity bindings independently of the handoff digest", () => {
    const mutations = [
      ["requestDigest", "b".repeat(64)],
      ["runId", "another-run"],
      ["specId", "another-spec"],
      ["issue", 99999],
      ["stepId", "spec"],
      ["actionDigest", "b".repeat(64)],
      ["dispatchInvocationId", "another-dispatch"],
      ["targetAuthority", "execution-checkout"],
      ["inputDigest", "b".repeat(64)],
      ["inputRevision", "b".repeat(64)],
    ];
    for (const [field, replacement] of mutations) {
      const value = fixture();
      try {
        const request = value.coordinator.createRequest({
          ctx: value.ctx,
          state: value.flowManager.load(),
          invocation: value.invocation,
        });
        fs.writeFileSync(request.payloadPath("draft.json"), json(draftDocument("sealed")));
        seal(request);
        rewriteSubmission(request, (document) => { document[field] = replacement; });

        assert.throws(
          () => value.coordinator.reconcile({ ctx: value.ctx, request }),
          (error) => error instanceof WorkerArtifactHandoffError
            && error.classification === "stale"
            && error.code === "FLOW_ARTIFACT_HANDOFF_STALE",
          field,
        );
      } finally {
        removeTmpDir(value.mainRoot);
      }
    }
  });

  it("rejects request-contract tampering performed after sealing", () => {
    const value = fixture();
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(request.payloadPath("draft.json"), json(draftDocument("sealed")));
      seal(request);
      const stored = JSON.parse(fs.readFileSync(request.requestPath, "utf8"));
      stored.generatedAt = "2026-08-04T00:00:03.000Z";
      fs.writeFileSync(request.requestPath, `${JSON.stringify(stored, null, 2)}\n`);

      assert.throws(
        () => value.coordinator.reconcile({ ctx: value.ctx, request }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.classification === "stale"
          && error.code === "FLOW_ARTIFACT_HANDOFF_STALE",
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects cataloged canonical input changes made after sealing as stale", () => {
    const value = fixture("draft-refine", {
      beforeActivate(candidate) {
        publishDraftBeforeTarget(candidate, draftDocument("sealed input"));
      },
    });
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(request.payloadPath("draft.json"), json(draftDocument("worker output")));
      seal(request);
      const staleDraft = draftDocument("stale input");
      value.flowManager.publishArtifacts({
        specId: value.specId,
        nodeId: "draft-refine",
        artifactWrites: [{
          logicalKey: "draft",
          mediaType: "application/json",
          bytes: Buffer.from(json(staleDraft), "utf8"),
        }],
      });

      assert.throws(
        () => value.coordinator.reconcile({ ctx: value.ctx, request }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.classification === "stale"
          && error.code === "FLOW_ARTIFACT_HANDOFF_STALE",
      );
      assert.equal(findStepById(value.flowManager.load().steps, "draft-refine").status, "in_progress");
      assert.deepEqual(readCatalogJson(value, "draft", "draft-refine"), staleDraft);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects a draft handoff when a materialized project overview changes before publication", () => {
    const value = fixture("draft");
    try {
      const docsDirectory = path.join(value.executionRoot, "docs");
      const overviewPath = path.join(docsDirectory, "overview.md");
      fs.mkdirSync(docsDirectory, { recursive: true });
      fs.writeFileSync(overviewPath, "# Project overview\n\nCaptured worker context.\n");
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(request.payloadPath("draft.json"), json(draftDocument("worker output")));
      seal(request);
      fs.writeFileSync(overviewPath, "# Project overview\n\nChanged worker context.\n");

      assert.throws(
        () => value.coordinator.reconcile({ ctx: value.ctx, request }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.classification === "stale"
          && error.code === "FLOW_ARTIFACT_HANDOFF_STALE",
      );
      assert.equal(findStepById(value.flowManager.load().steps, "draft").status, "in_progress");
      assert.equal(fs.existsSync(path.join(canonicalSpecDir(value), "draft.json")), false);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects a handoff captured by a replaced Attempt without publishing its output", () => {
    const value = fixture("draft");
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(request.payloadPath("draft.json"), json(draftDocument("stale Attempt output")));
      seal(request);
      const confirmedDraft = draftDocument("newer confirmed draft");
      value.flowManager.confirmCurrentAttempt({
        specId: value.specId,
        artifactWrites: [{
          logicalKey: "draft",
          mediaType: "application/json",
          bytes: Buffer.from(json(confirmedDraft), "utf8"),
        }],
      });
      value.flowManager.rewindTo("draft", { specId: value.specId });

      assert.throws(
        () => value.coordinator.reconcile({ ctx: value.ctx, request }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.classification === "stale"
          && error.code === "FLOW_ARTIFACT_HANDOFF_STALE",
      );
      const state = value.flowManager.canonicalState(value.specId);
      assert.equal(state.attempt.sequence, 2);
      assert.equal(state.attempt.failure, null);
      assert.equal(findStepById(value.flowManager.load().steps, "draft").status, "in_progress");
      assert.deepEqual(readCatalogJson(value, "draft", "draft-refine"), confirmedDraft);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects traversal and oversized payloads as typed invalid handoffs", () => {
    const traversal = fixture();
    try {
      const request = traversal.coordinator.createRequest({
        ctx: traversal.ctx,
        state: traversal.flowManager.load(),
        invocation: traversal.invocation,
      });
      fs.writeFileSync(request.payloadPath("draft.json"), json(draftDocument("sealed")));
      seal(request);
      rewriteSubmission(request, (document) => {
        document.payloadManifest[0].relativePath = "../outside.json";
      });
      assert.throws(
        () => traversal.coordinator.reconcile({ ctx: traversal.ctx, request }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.classification === "invalid",
      );
    } finally {
      removeTmpDir(traversal.mainRoot);
    }

    const oversized = fixture();
    try {
      const request = oversized.coordinator.createRequest({
        ctx: oversized.ctx,
        state: oversized.flowManager.load(),
        invocation: oversized.invocation,
      });
      fs.writeFileSync(request.payloadPath("draft.json"), Buffer.alloc((2 * 1024 * 1024) + 1));
      assert.throws(
        () => seal(request),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.classification === "invalid"
          && error.code === "FLOW_ARTIFACT_HANDOFF_INVALID",
      );
    } finally {
      removeTmpDir(oversized.mainRoot);
    }
  });

  it("rejects malformed JSON without publishing or completing", () => {
    const value = fixture();
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(request.payloadPath("draft.json"), "{ malformed\n");
      assert.throws(
        () => seal(request),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.classification === "invalid"
          && error.code === "FLOW_ARTIFACT_HANDOFF_INVALID",
      );
      assert.equal(findStepById(value.flowManager.load().steps, "draft").status, "in_progress");
      assert.equal(fs.existsSync(path.join(canonicalSpecDir(value), "draft.json")), false);
      assert.equal(fs.existsSync(request.submissionPath), false);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("terminalizes an invalid pre-publication payload after one sealed handoff", async () => {
    const value = fixture("draft", { specRecord: validSpec() });
    try {
      const current = { value: draftWorkerAction() };
      let calls = 0;
      let firstHandoffDirectory = null;
      let firstPayloadBytes = null;
      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run() {
            return findStepById(value.flowManager.load().steps, "draft").status === "done"
              ? completedWorkerAction()
              : structuredClone(current.value);
          },
        },
        agent: {
          async call(_prompt, options) {
            calls += 1;
            assert.equal(options.jsonSchema, undefined);
            assert.equal(options.fmtFallback, undefined);
            const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
            const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
            const payloadPath = request.payloads.find((entry) => entry.logicalName === "draft.json").payloadPath;
            fs.writeFileSync(payloadPath, "[]\n");
            sealWorkerArtifactHandoff({
              requestPath,
              invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
            });
            if (calls === 1) {
              firstHandoffDirectory = path.dirname(requestPath);
              firstPayloadBytes = fs.readFileSync(payloadPath);
            }
          },
        },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};

      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(),
        expectRunId: value.flowManager.load().runId,
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(result.errors[0].code, "FLOW_ARTIFACT_HANDOFF_INVALID");
      assert.equal(calls, 1);
      assert.ok(firstHandoffDirectory);
      assert.equal(fs.existsSync(firstHandoffDirectory), true);
      assert.deepEqual(
        fs.readFileSync(path.join(firstHandoffDirectory, "payload", "draft.json")),
        firstPayloadBytes,
      );
      assert.equal(findStepById(value.flowManager.load().steps, "draft").status, "in_progress");
      assert.equal(fs.existsSync(path.join(canonicalSpecDir(value), "draft.json")), false);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("keeps timeout diagnostics, payload state, progress, and the provider cause on a rejected handoff", async () => {
    const value = fixture("draft", { specRecord: validSpec() });
    try {
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() { return draftWorkerAction(); } },
        agent: {
          async call(_prompt, options) {
            const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
            const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
            fs.writeFileSync(request.payloads.find((entry) => entry.logicalName === "draft.json").payloadPath, "[]\n");
            sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
            const cause = Object.assign(new Error("provider timed out after sealing"), {
              stdout: "partial worker stdout", stderr: "provider timeout stderr", timeoutMs: 42_000,
            });
            throw new AgentTimeoutFailure({ message: "provider timed out", cause });
          },
        },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...value.ctx, flowState: value.flowManager.load(),
        expectRunId: "run-worker-handoff", expectSpec: value.specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      });

      assert.equal(result.ok, false);
      assert.equal(result.errors[0].code, "FLOW_ARTIFACT_HANDOFF_INVALID");
      assert.equal(result.data.agentFailure.code, "AGENT_TIMEOUT");
      assert.equal(result.data.agentFailure.attemptCount, 1);
      assert.equal(result.data.agentFailure.stdout, "partial worker stdout");
      assert.equal(result.data.agentFailure.stderr, "provider timeout stderr");
      assert.equal(result.data.agentFailure.timeoutMs, 42_000);
      assert.equal(result.data.lastProgress.stepId, "draft");
      assert.equal(result.data.lastProgress.dispatchCount, 1);
      assert.equal(result.data.payload.sealed, true);
      assert.match(result.data.payload.requestPath, /request\.json$/);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("does not apply a repair deadline reserve to an ordinary draft worker", async () => {
    const value = fixture("draft", { specRecord: validSpec() });
    try {
      let calls = 0;
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() {
          return findStepById(value.flowManager.load().steps, "draft").status === "done"
            ? completedWorkerAction() : draftWorkerAction();
        } },
        agent: { async call(_prompt, options) {
          calls += 1;
          const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
          const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
          fs.writeFileSync(request.payloads.find((entry) => entry.logicalName === "draft.json").payloadPath, json(draftDocument("ordinary deadline")));
          sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
        } },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...value.ctx, flowState: value.flowManager.load(), config: { agent: { timeout: 42 } },
        expectRunId: "run-worker-handoff", expectSpec: value.specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      });

      assert.equal(result.dispatch.boundary, "completed", JSON.stringify(result));
      assert.equal(calls, 1);
      assert.equal(findStepById(value.flowManager.load().steps, "draft").status, "done");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("keeps an ordinary worker on its configured Agent timeout despite a dispatch reserve", async () => {
    const value = fixture("draft", { specRecord: validSpec() });
    try {
      let timeoutMs = null;
      let activityMonitor = null;
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() {
          return findStepById(value.flowManager.load().steps, "draft").status === "done"
            ? completedWorkerAction() : draftWorkerAction();
        } },
        agent: { async call(_prompt, options) {
          timeoutMs = options.timeoutMs;
          activityMonitor = options.activityMonitor;
          const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
          const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
          fs.writeFileSync(request.payloads.find((entry) => entry.logicalName === "draft.json").payloadPath, json(draftDocument("deadline budget")));
          sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
        } },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...value.ctx, flowState: value.flowManager.load(), config: { agent: { timeout: 42 } },
        expectRunId: "run-worker-handoff", expectSpec: value.specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      });
      assert.equal(result.dispatch.boundary, "completed", JSON.stringify(result));
      assert.equal(timeoutMs, undefined, "ordinary worker delegates timeout unchanged to Agent");
      assert.equal(activityMonitor, undefined, "ordinary worker does not receive repair activity monitoring");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("uses the test-review repair worker maximum lifetime instead of a dispatch reserve", async () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      prepareCanonicalTestReviewRepair(value);
      const nextAction = new GetNextActionCommand();
      const repairAction = await nextAction.execute({ ...value.ctx, flowState: value.flowManager.load(value.specId) });
      assert.equal(repairAction.step, "test");
      assert.ok(repairAction.context.testReviewRepair, "production next-action selects one repair capability");
      let timeoutMs = null;
      let inactivityTimeoutMs = null;
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() {
          return findStepById(value.flowManager.load().steps, "test").status === "done"
            ? completedWorkerAction() : repairAction;
        } },
        agent: { async call(_prompt, options) {
          timeoutMs = options.timeoutMs;
          inactivityTimeoutMs = options.activityMonitor.inactivityTimeoutMs;
          const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
          const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
          const tree = request.payloads.find((entry) => entry.logicalName === "spec-tests").payloadPath;
          fs.appendFileSync(path.join(tree, "r1.test.js"), "// repaired\n");
          sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
        } },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...value.ctx, flowState: value.flowManager.load(value.specId), config: { agent: { timeout: 42 } },
        expectRunId: "run-worker-handoff", expectSpec: value.specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      });
      assert.equal(result.dispatch.boundary, "completed", JSON.stringify(result));
      assert.equal(timeoutMs, 7_200_000);
      assert.equal(inactivityTimeoutMs, 42_000, "configured Agent timeout is the repair inactivity threshold");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("uses the default 900-second Agent timeout as the repair inactivity threshold", async () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      prepareCanonicalTestReviewRepair(value);
      let inactivityTimeoutMs = null;
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() {
          return findStepById(value.flowManager.load().steps, "test").status === "done"
            ? completedWorkerAction()
            : new GetNextActionCommand().execute({ ...value.ctx, flowState: value.flowManager.load(value.specId) });
        } },
        agent: { async call(_prompt, options) {
          inactivityTimeoutMs = options.activityMonitor.inactivityTimeoutMs;
          const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
          const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
          fs.appendFileSync(path.join(request.payloads.find((entry) => entry.logicalName === "spec-tests").payloadPath, "r1.test.js"), "// repaired\n");
          sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
        } },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...value.ctx, flowState: value.flowManager.load(value.specId), config: { agent: {} },
        expectRunId: "run-worker-handoff", expectSpec: value.specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      });
      assert.equal(result.dispatch.boundary, "completed", JSON.stringify(result));
      assert.equal(inactivityTimeoutMs, 1_800_000);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("does not shorten a test-review repair worker below its absolute lifetime", async () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      prepareCanonicalTestReviewRepair(value);
      const repairAction = await new GetNextActionCommand().execute({ ...value.ctx, flowState: value.flowManager.load(value.specId) });
      let timeoutMs = null;
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() { return repairAction; } },
        agent: { async call(_prompt, options) {
          timeoutMs = options.timeoutMs;
          throw new Error("stop after observing repair timeout cap");
        } },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      await dispatcher.execute({
        ...value.ctx, flowState: value.flowManager.load(value.specId), config: { agent: { timeout: 42 } },
        expectRunId: "run-worker-handoff", expectSpec: value.specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      });
      assert.equal(timeoutMs, 7_200_000, "repair worker has a fixed hard lifetime independent of dispatcher time");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("settles an unsubmitted inactivity timeout once and leaves review findings pending", async () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      prepareCanonicalTestReviewRepair(value);
      let calls = 0;
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() {
          return findStepById(value.flowManager.load().steps, "test").status === "done"
            ? completedWorkerAction()
            : new GetNextActionCommand().execute({ ...value.ctx, flowState: value.flowManager.load(value.specId) });
        } },
        agent: { async call() {
          calls += 1;
          throw new AgentTimeoutFailure({
            message: "repair worker became inactive",
            cause: Object.assign(new Error("repair worker became inactive"), { timeoutReason: "inactivity" }),
          });
        } },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...value.ctx, flowState: value.flowManager.load(value.specId), config: { agent: { timeout: 42 } },
        expectRunId: "run-worker-handoff", expectSpec: value.specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      });

      assert.equal(result.dispatch.boundary, "completed", JSON.stringify(result));
      assert.equal(calls, 1, "the timed-out repair worker is not retried in place");
      assert.equal(findStepById(value.flowManager.load().steps, "test").status, "done");
      const next = await new GetNextActionCommand().execute({
        ...value.ctx,
        flowState: value.flowManager.load(value.specId),
      });
      assert.equal(next.step, "scenario-validity", "retained canonical tests return to scenario validity");
      assert.doesNotThrow(() => value.flowManager.readArtifact({
        specId: value.specId,
        logicalKey: "tests.source",
        parameters: { testPath: "r1.test.js" },
        consumerNodeId: "scenario-validity",
      }));
      const failures = value.flowManager.activityLedger(value.specId).filter((entry) => entry.transition.operation === "fail_attempt");
      assert.equal(failures.at(-1).failure.code, "FLOW_TEST_REVIEW_REPAIR_WORKER_INACTIVITY_TIMEOUT");
      assert.equal(
        value.flowManager.activityLedger(value.specId).some((entry) => entry.references.artifacts.some((reference) => reference.kind === "worker-handoff")),
        false,
        "the timeout creates no repair handoff evidence that could mark the finding fixed",
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("returns a timed-out repair through scenario validity and a fresh rejected review to repair", async () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      prepareCanonicalTestReviewRepair(value);
      value.flowManager.failCurrentAttempt({
        specId: value.specId,
        failure: {
          category: "tooling",
          code: "FLOW_TEST_REVIEW_REPAIR_WORKER_INACTIVITY_TIMEOUT",
          message: "repair worker became inactive",
          retryable: false,
          retryKind: null,
        },
        result: {
          outcome: "failed",
          summary: "Repair worker became inactive.",
          confirmedAt: new Date().toISOString(),
          artifactRefs: [],
        },
      });
      value.flowManager.settleTimedOutTestReviewRepair({ specId: value.specId });
      assert.equal((await new GetNextActionCommand().execute({
        ...value.ctx, flowState: value.flowManager.load(value.specId),
      })).step, "scenario-validity");

      value.flow.settle("scenario-validity").activate("test-review");
      const freshReview = JSON.parse(value.flowManager.readArtifact({
        specId: value.specId,
        logicalKey: "test.review",
        consumerNodeId: "test-review",
      }).bytes);
      freshReview.attempts.push({
        ...structuredClone(freshReview.attempts.at(-1)),
        attempt: value.flowManager.canonicalState(value.specId).attempt.sequence,
      });
      value.flowManager.publishArtifacts({
        specId: value.specId,
        nodeId: "test-review",
        artifactWrites: [{
          logicalKey: "test.review",
          mediaType: "application/json",
          bytes: Buffer.from(`${JSON.stringify(freshReview)}\n`, "utf8"),
        }],
      });
      const repaired = new RunRepairTestReviewCommand().execute({
        ...value.ctx,
        flowState: value.flowManager.load(value.specId),
        flowCommandBoundary: true,
      });
      assert.equal(repaired.ok, true, JSON.stringify(repaired));
      const next = await new GetNextActionCommand().execute({
        ...value.ctx, flowState: value.flowManager.load(value.specId),
      });
      assert.equal(next.step, "test", "the unresolved finding is rediscovered by the fresh rejection and returns to repair");
      assert.ok(next.context.testReviewRepair);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("discards an invalid sealed timeout handoff without replacing retained canonical tests", async () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      prepareCanonicalTestReviewRepair(value);
      const retained = value.flowManager.readArtifact({
        specId: value.specId,
        logicalKey: "tests.source",
        parameters: { testPath: "r1.test.js" },
        consumerNodeId: "test",
      }).bytes;
      let handoffDirectory = null;
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() {
          return findStepById(value.flowManager.load().steps, "test").status === "done"
            ? completedWorkerAction()
            : new GetNextActionCommand().execute({ ...value.ctx, flowState: value.flowManager.load(value.specId) });
        } },
        agent: { async call(_prompt, options) {
          const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
          handoffDirectory = path.dirname(requestPath);
          const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
          const tree = request.payloads.find((entry) => entry.logicalName === "spec-tests").payloadPath;
          fs.writeFileSync(path.join(tree, "r1.test.js"), "");
          sealWorkerArtifactHandoff({
            requestPath,
            invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
          });
          throw new AgentTimeoutFailure({
            message: "repair worker became inactive after sealing invalid output",
            cause: Object.assign(new Error("repair worker became inactive"), { timeoutReason: "inactivity" }),
          });
        } },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};

      const result = await dispatcher.execute({
        ...value.ctx, flowState: value.flowManager.load(value.specId), config: { agent: { timeout: 42 } },
        expectRunId: "run-worker-handoff", expectSpec: value.specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      });

      assert.equal(result.dispatch.boundary, "completed", JSON.stringify(result));
      assert.equal(fs.existsSync(handoffDirectory), false, "the rejected transient handoff is removed");
      const canonical = value.flowManager.readArtifact({
        specId: value.specId,
        logicalKey: "tests.source",
        parameters: { testPath: "r1.test.js" },
        consumerNodeId: "scenario-validity",
      });
      assert.deepEqual(canonical.bytes, retained, "the last accepted test revision is retained");
      const next = await new GetNextActionCommand().execute({
        ...value.ctx,
        flowState: value.flowManager.load(value.specId),
      });
      assert.equal(next.step, "scenario-validity", "the retained revision returns to the formal review route");
      assert.equal(
        value.flowManager.activityLedger(value.specId).some((entry) => entry.references.artifacts.some((reference) => reference.kind === "worker-handoff")),
        false,
        "the invalid sealed output leaves no accepted repair evidence",
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("discards an unsealed partial timeout payload and retains canonical tests byte-for-byte", async () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      prepareCanonicalTestReviewRepair(value);
      const retained = value.flowManager.readArtifact({
        specId: value.specId,
        logicalKey: "tests.source",
        parameters: { testPath: "r1.test.js" },
        consumerNodeId: "test",
      }).bytes;
      let handoffDirectory = null;
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() {
          return findStepById(value.flowManager.load().steps, "test").status === "done"
            ? completedWorkerAction()
            : new GetNextActionCommand().execute({ ...value.ctx, flowState: value.flowManager.load(value.specId) });
        } },
        agent: { async call(_prompt, options) {
          const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
          handoffDirectory = path.dirname(requestPath);
          const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
          fs.writeFileSync(path.join(request.payloads.find((entry) => entry.logicalName === "spec-tests").payloadPath, "r1.test.js"), "partial and unsealed\n");
          throw new AgentTimeoutFailure({
            message: "repair worker became inactive before sealing output",
            cause: Object.assign(new Error("repair worker became inactive"), { timeoutReason: "inactivity" }),
          });
        } },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...value.ctx, flowState: value.flowManager.load(value.specId), config: { agent: { timeout: 42 } },
        expectRunId: "run-worker-handoff", expectSpec: value.specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      });
      assert.equal(result.dispatch.boundary, "completed", JSON.stringify(result));
      assert.equal(fs.existsSync(handoffDirectory), false);
      const canonical = value.flowManager.readArtifact({
        specId: value.specId,
        logicalKey: "tests.source",
        parameters: { testPath: "r1.test.js" },
        consumerNodeId: "scenario-validity",
      });
      assert.deepEqual(canonical.bytes, retained);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("persists provider timeout as a distinct test-review repair stop reason", async () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      prepareCanonicalTestReviewRepair(value);
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() {
          return findStepById(value.flowManager.load().steps, "test").status === "done"
            ? completedWorkerAction()
            : new GetNextActionCommand().execute({ ...value.ctx, flowState: value.flowManager.load(value.specId) });
        } },
        agent: { async call() {
          throw new AgentTimeoutFailure({
            message: "provider timed out without a monitor reason",
            cause: new Error("provider timeout"),
          });
        } },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};

      const result = await dispatcher.execute({
        ...value.ctx, flowState: value.flowManager.load(value.specId), config: { agent: { timeout: 42 } },
        expectRunId: "run-worker-handoff", expectSpec: value.specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      });

      assert.equal(result.dispatch.boundary, "completed", JSON.stringify(result));
      const failures = value.flowManager.activityLedger(value.specId).filter((entry) => entry.transition.operation === "fail_attempt");
      assert.equal(failures.at(-1).failure.code, "FLOW_TEST_REVIEW_REPAIR_WORKER_PROVIDER_TIMEOUT");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("maps a supervisor maximum-lifetime dispatch failure to its canonical repair timeout code", async () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      prepareCanonicalTestReviewRepair(value);
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() {
          return findStepById(value.flowManager.load().steps, "test").status === "done"
            ? completedWorkerAction()
            : new GetNextActionCommand().execute({ ...value.ctx, flowState: value.flowManager.load(value.specId) });
        } },
        agent: { async call() {
          throw new AgentTimeoutError({
            timeoutMs: 7_200_000,
            graceMs: 100,
            finalAction: "SIGTERM",
            timeoutDiagnostic: new AgentTimeoutDiagnostic({ reason: "maximum_lifetime", timeoutMs: 7_200_000 }),
          });
        } },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...value.ctx, flowState: value.flowManager.load(value.specId), config: { agent: { timeout: 42 } },
        expectRunId: "run-worker-handoff", expectSpec: value.specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      });
      assert.equal(result.dispatch.boundary, "completed", JSON.stringify(result));
      const failures = value.flowManager.activityLedger(value.specId).filter((entry) => entry.transition.operation === "fail_attempt");
      assert.equal(failures.at(-1).failure.code, "FLOW_TEST_REVIEW_REPAIR_WORKER_MAXIMUM_LIFETIME_TIMEOUT");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("accepts a valid sealed repair exactly once when submission races with timeout", async () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      prepareCanonicalTestReviewRepair(value);
      let calls = 0;
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() {
          return findStepById(value.flowManager.load().steps, "test").status === "done"
            ? completedWorkerAction()
            : new GetNextActionCommand().execute({ ...value.ctx, flowState: value.flowManager.load(value.specId) });
        } },
        agent: { async call(_prompt, options) {
          calls += 1;
          const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
          const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
          const tree = request.payloads.find((entry) => entry.logicalName === "spec-tests").payloadPath;
          fs.appendFileSync(path.join(tree, "r1.test.js"), "// repaired before timeout\n");
          sealWorkerArtifactHandoff({
            requestPath,
            invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
          });
          throw new AgentTimeoutFailure({
            message: "maximum lifetime reached after submission",
            cause: Object.assign(new Error("maximum lifetime reached after submission"), {
              timeoutReason: "maximum_lifetime",
            }),
          });
        } },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};

      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(value.specId),
        config: { agent: { timeout: 42 } },
        expectRunId: "run-worker-handoff",
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(result.dispatch.boundary, "completed", JSON.stringify(result));
      assert.equal(calls, 1);
      const repaired = value.flowManager.readArtifact({
        specId: value.specId,
        logicalKey: "tests.source",
        parameters: { testPath: "r1.test.js" },
        consumerNodeId: "scenario-validity",
      });
      assert.match(repaired.bytes.toString("utf8"), /repaired before timeout/);
      const progress = JSON.parse(value.flowManager.readArtifact({
        specId: value.specId,
        logicalKey: "test.review.repair.progress",
        consumerNodeId: "test",
      }).bytes);
      assert.deepEqual(progress.entries.map((entry) => entry.status), ["done"]);
      assert.equal(
        value.flowManager.activityLedger(value.specId).filter((entry) => entry.transition.operation === "settle_test_review_repair_timeout").length,
        0,
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("retains a timed-out repair handoff when reconciliation requires durable recovery", async () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      prepareCanonicalTestReviewRepair(value);
      let handoffDirectory = null;
      const coordinator = new WorkerArtifactHandoffCoordinator();
      coordinator.reconcile = () => {
        throw new WorkerArtifactHandoffError(
          "recovery-required",
          "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED",
          "publication journal must be recovered before deciding the handoff",
        );
      };
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() {
          return new GetNextActionCommand().execute({ ...value.ctx, flowState: value.flowManager.load(value.specId) });
        } },
        agent: { async call(_prompt, options) {
          handoffDirectory = path.dirname(options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST);
          throw new AgentTimeoutFailure({
            message: "repair worker became inactive",
            cause: Object.assign(new Error("repair worker became inactive"), { timeoutReason: "inactivity" }),
          });
        } },
        handoffCoordinator: coordinator,
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const result = await dispatcher.execute({
        ...value.ctx, flowState: value.flowManager.load(value.specId), config: { agent: { timeout: 42 } },
        expectRunId: "run-worker-handoff", expectSpec: value.specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      });

      assert.equal(result.ok, false);
      assert.equal(result.errors[0].code, "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED");
      assert.ok(fs.existsSync(handoffDirectory), "recovery-required handoff is retained for deterministic recovery");
      assert.equal(findStepById(value.flowManager.load().steps, "test").status, "in_progress");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("replays a persisted repair timeout settlement exactly once without starting another worker", async () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      prepareCanonicalTestReviewRepair(value);
      value.flowManager.failCurrentAttempt({
        specId: value.specId,
        failure: {
          category: "tooling",
          code: "FLOW_TEST_REVIEW_REPAIR_WORKER_MAXIMUM_LIFETIME_TIMEOUT",
          message: "persisted maximum-lifetime timeout",
          retryable: false,
          retryKind: null,
        },
        result: {
          outcome: "failed",
          summary: "Persisted maximum-lifetime timeout.",
          confirmedAt: new Date().toISOString(),
          artifactRefs: [],
        },
      });
      assert.equal(value.flowManager.canonicalState(value.specId).attempt.failure.code, "FLOW_TEST_REVIEW_REPAIR_WORKER_MAXIMUM_LIFETIME_TIMEOUT");
      let calls = 0;
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() { return completedWorkerAction(); } },
        agent: { async call() { calls += 1; } },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};
      const context = {
        ...value.ctx, flowState: value.flowManager.load(value.specId), config: { agent: { timeout: 42 } },
        expectRunId: "run-worker-handoff", expectSpec: value.specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      };
      assert.equal((await dispatcher.execute(context)).dispatch.boundary, "completed");
      assert.equal((await dispatcher.execute({ ...context, flowState: value.flowManager.load(value.specId) })).dispatch.boundary, "completed");
      assert.equal(calls, 0);
      assert.equal(
        value.flowManager.activityLedger(value.specId).filter((entry) => entry.transition.operation === "settle_test_review_repair_timeout").length,
        1,
      );
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("uses one bounded repair batch for overlapping findings", async () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      prepareCanonicalTestReviewRepair(value, { findingCount: 2 });
      let calls = 0;
      const nextAction = {
        async run() {
          if (calls >= 1) return completedWorkerAction();
          return new GetNextActionCommand().execute({ ...value.ctx, flowState: value.flowManager.load(value.specId) });
        },
      };
      const worker = async (_prompt, options) => {
        calls += 1;
        const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
        const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
        const tree = request.payloads.find((entry) => entry.logicalName === "spec-tests").payloadPath;
        fs.appendFileSync(path.join(tree, "r1.test.js"), `// repaired ${calls}\n`);
        sealWorkerArtifactHandoff({ requestPath, invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID });
      };
      const first = new RunDispatchCommand({
        nextAction,
        agent: { call: worker },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      first.container = {};
      const completed = await first.execute({
        ...value.ctx, flowState: value.flowManager.load(value.specId), config: { agent: { timeout: 42 } },
        expectRunId: "run-worker-handoff", expectSpec: value.specId,
        _envelopeType: "run", _envelopeKey: "dispatch",
      });
      assert.equal(completed.dispatch.boundary, "completed", JSON.stringify(completed));
      assert.equal(calls, 1);
      const progress = JSON.parse(value.flowManager.readArtifact({
        specId: value.specId, logicalKey: "test.review.repair.progress", consumerNodeId: "test",
      }).bytes);
      assert.deepEqual(progress.entries.map((entry) => entry.status), ["done", "done"]);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("uses canonical topology feedback to regenerate an invalid spec-test handoff", async () => {
    const value = fixture("test", { specRecord: validSpec() });
    try {
      const canonicalSourcePath = path.join(value.mainRoot, "src", "existing.js");
      const executionSourcePath = path.join(value.executionRoot, "src", "existing.js");
      fs.mkdirSync(path.dirname(canonicalSourcePath), { recursive: true });
      fs.mkdirSync(path.dirname(executionSourcePath), { recursive: true });
      fs.writeFileSync(canonicalSourcePath, "export default true;\n");
      fs.writeFileSync(executionSourcePath, "export default true;\n");
      const canonicalTestRoot = path.join(canonicalSpecDir(value), "artifacts", "tests");
      const canonicalImport = path.relative(canonicalTestRoot, canonicalSourcePath).split(path.sep).join("/");
      const ordinaryTestImport = "../../src/existing.js";
      const requests = [];
      let firstPayload = null;
      let calls = 0;
      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run() {
            return findStepById(value.flowManager.load().steps, "test").status === "done"
              ? completedWorkerAction()
              : draftWorkerAction("test");
          },
        },
        agent: {
          async call(prompt, options) {
            calls += 1;
            const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
            const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
            requests.push(request);
            const testPath = path.join(
              request.payloads.find((entry) => entry.logicalName === "spec-tests").payloadPath,
              "topology.test.js",
            );
            if (calls === 1) {
              assert.match(prompt, /Spec-test topology:/);
              assert.ok(prompt.includes(`"canonicalTestRoot": ${JSON.stringify(path.relative(value.mainRoot, canonicalTestRoot).split(path.sep).join("/"))}`));
              assert.doesNotMatch(prompt, /Fresh worker handoff retry feedback/);
              fs.writeFileSync(testPath, [
                "// spec: R1",
                "import test from 'node:test';",
                `import value from '${ordinaryTestImport}';`,
                "test('R1: uses an existing module', () => value);",
                "",
              ].join("\n"));
              firstPayload = fs.readFileSync(testPath);
            } else {
              assert.match(prompt, /Fresh worker handoff retry feedback/);
              assert.match(prompt, /missing pre-implementation module/);
              fs.writeFileSync(testPath, [
                "// spec: R1",
                "import test from 'node:test';",
                `import value from '${canonicalImport}';`,
                "test('R1: uses an existing module', () => value);",
                "",
              ].join("\n"));
            }
            sealWorkerArtifactHandoff({
              requestPath,
              invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
            });
          },
        },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};

      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(),
        expectRunId: value.flowManager.load().runId,
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(result.dispatch?.boundary, "completed", JSON.stringify(result));
      assert.equal(calls, 2);
      assert.equal(requests.length, 2);
      assert.deepEqual(
        fs.readFileSync(path.join(requests[0].payloads[0].payloadPath, "topology.test.js")),
        firstPayload,
      );
      assert.equal(findStepById(value.flowManager.load().steps, "test").status, "done");
      assert.match(fs.readFileSync(path.join(canonicalTestRoot, "topology.test.js"), "utf8"), new RegExp(canonicalImport.replaceAll(".", "\\.")));
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("passes the guarded output schema and schema guidance to the spec artifact worker", async () => {
    const value = fixture("spec", {
      beforeActivate(candidate) {
        publishDraftBeforeTarget(candidate, draftDocument("Create the specification."));
      },
    });
    try {
      const current = { value: {
        ...draftWorkerAction(),
        step: "spec",
        action: "write-spec",
        instructions: { key: "plan.spec", content: "Write the specification." },
        output_schema: loadWorkerArtifactHandoffSchema(),
      } };
      let guardedOutputSchema = null;
      let workerOptions = null;
      let workerPrompt = null;
      let calls = 0;
      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run() {
            const nextAction = findStepById(value.flowManager.load().steps, "spec").status === "done"
              ? completedWorkerAction()
              : structuredClone(current.value);
            if (nextAction.step === "spec") guardedOutputSchema = nextAction.output_schema;
            return nextAction;
          },
        },
        agent: {
          async call(prompt, options) {
            calls += 1;
            workerOptions = options;
            workerPrompt = prompt;
            const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
            const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
            fs.writeFileSync(
              request.payloads.find((entry) => entry.logicalName === "spec.json").payloadPath,
              json(validWorkerHandoffTaskSpec()),
            );
            sealWorkerArtifactHandoff({
              requestPath,
              invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
            });
          },
        },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};

      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(),
        expectRunId: value.flowManager.load().runId,
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.deepEqual(workerOptions.jsonSchema, guardedOutputSchema);
      assert.deepEqual(workerOptions.jsonSchema, loadWorkerArtifactHandoffSchema());
      assert.notDeepEqual(workerOptions.jsonSchema, loadSpecJsonSchema());
      assert.ok(workerOptions.jsonSchema.properties.runtimeLog);
      assert.match(workerOptions.fmtFallback, /Spec artifact schema:/);
      assert.match(workerPrompt, /Spec artifact schema:/);
      assert.equal(result.dispatch.boundary, "completed", JSON.stringify(result, null, 2));
      assert.equal(result.dispatch.dispatchCount, 1);
      assert.equal(calls, 1);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("terminalizes an invalid output without a semantic retry", async () => {
    const value = fixture("draft", { specRecord: validSpec() });
    try {
      const current = { value: draftWorkerAction() };
      const handoffDirectories = [];
      let calls = 0;
      const dispatcher = new RunDispatchCommand({
        nextAction: {
          async run() {
            return structuredClone(current.value);
          },
        },
        agent: {
          async call(_prompt, options) {
            calls += 1;
            const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
            const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
            fs.writeFileSync(
              request.payloads.find((entry) => entry.logicalName === "draft.json").payloadPath,
              "[]\n",
            );
            sealWorkerArtifactHandoff({
              requestPath,
              invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
            });
            handoffDirectories.push(path.dirname(requestPath));
          },
        },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
      });
      dispatcher.container = {};

      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(),
        expectRunId: value.flowManager.load().runId,
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(result.ok, false);
      assert.equal(result.errors[0].code, "FLOW_ARTIFACT_HANDOFF_INVALID");
      assert.equal(calls, 1);
      assert.equal(findStepById(value.flowManager.load().steps, "draft").status, "in_progress");
      assert.equal(fs.existsSync(path.join(canonicalSpecDir(value), "draft.json")), false);

      const issueLog = readCatalogJson(value, "issue.log", "impl-gate");
      const entry = issueLog.entries.find((candidate) => candidate.issueLogId === (
        `worker-handoff-${result.data.actionDigest}-invalid`
      ));
      assert.ok(entry);
      assert.match(entry.reason, /Worker artifact handoff invalid:/);
      assert.equal(entry.diagnostic, undefined);
      assert.match(entry.resolution, /Correct the worker artifact payload/);
      assert.equal(handoffDirectories.length, 1);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("terminalizes semantic spec-repair deltas after one worker call without changing state", async () => {
    for (const scenario of [
      {
        name: "required targets",
        scopeExpansion: false,
        code: "FLOW_ARTIFACT_HANDOFF_INVALID",
      },
      {
        name: "scope expansion",
        scopeExpansion: true,
        code: "FLOW_ARTIFACT_HANDOFF_INVALID",
      },
    ]) {
      const value = prepareSpecRepairFixture();
      try {
        const action = specRepairWorkerAction();
        const before = specRepairSnapshot(value);
        let nextActionCalls = 0;
        let workerCalls = 0;
        const dispatcher = new RunDispatchCommand({
          nextAction: {
            async run() {
              nextActionCalls += 1;
              return workerCalls === 0 ? structuredClone(action) : completedWorkerAction();
            },
          },
          agent: {
            async call(_prompt, options) {
              workerCalls += 1;
              const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
              const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
              fs.writeFileSync(
                request.payloads.find((entry) => entry.logicalName === "review.delta.json").payloadPath,
                json(specRepairPayload(request, scenario)),
              );
              sealWorkerArtifactHandoff({
                requestPath,
                invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
              });
            },
          },
          repositoryFingerprint: () => "stable-fixture",
          leaseFactory: () => ({ acquire() {}, release() {} }),
        });
        dispatcher.container = {};

        const result = await dispatcher.execute({
          ...value.ctx,
          flowState: value.flowManager.load(),
          expectRunId: value.flowManager.load().runId,
          expectSpec: value.specId,
          _envelopeType: "run",
          _envelopeKey: "dispatch",
        });

        assert.equal(result.dispatch.boundary, "completed", scenario.name);
        assert.equal(workerCalls, 1, `${scenario.name}: semantic delta has no correction retry`);
        assert.ok(nextActionCalls <= 3, `${scenario.name}: confirmation performs only bounded completion reads`);
        const review = value.flowManager.readCurrentSpecReview({ specId: value.specId, consumerNodeId: "spec-gate" }).review;
        const audit = review.audit.at(-1);
        assert.equal(audit.stage, "spec-repair");
        if (scenario.scopeExpansion) assert.equal(audit.acceptedOperations.length, 1);
        else assert.equal(audit.acceptedOperations.length, 0);
      } finally {
        removeTmpDir(value.mainRoot);
      }
    }
  });

  it("does not partially publish a valid spec-repair handoff when publication is interrupted", async () => {
    const value = prepareSpecRepairFixture();
    try {
      const before = specRepairSnapshot(value);
      let workerCalls = 0;
      const dispatcher = new RunDispatchCommand({
        nextAction: { async run() { return structuredClone(specRepairWorkerAction()); } },
        agent: {
          async call(_prompt, options) {
            workerCalls += 1;
            const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
            const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
            fs.writeFileSync(
              request.payloads.find((entry) => entry.logicalName === "review.delta.json").payloadPath,
              json(specRepairPayload(request, { valid: true })),
            );
            sealWorkerArtifactHandoff({
              requestPath,
              invocationId: options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID,
            });
          },
        },
        repositoryFingerprint: () => "stable-fixture",
        leaseFactory: () => ({ acquire() {}, release() {} }),
        handoffCoordinator: new WorkerArtifactHandoffCoordinator({
          faultInjector({ phase }) {
            if (phase === "before-worker-handoff-publication") throw new Error("simulated pre-commit crash");
          },
        }),
      });
      dispatcher.container = {};

      const result = await dispatcher.execute({
        ...value.ctx,
        flowState: value.flowManager.load(),
        expectRunId: value.flowManager.load().runId,
        expectSpec: value.specId,
        _envelopeType: "run",
        _envelopeKey: "dispatch",
      });

      assert.equal(result.ok, false);
      assert.equal(result.errors[0].code, "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED");
      assert.equal(workerCalls, 1);
      assert.deepEqual(specRepairSnapshot(value), before);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects a pre-existing symlink in the staging directory authority", () => {
    const value = fixture();
    const outside = path.join(value.mainRoot, "outside-handoffs");
    try {
      const state = value.flowManager.load();
      fs.mkdirSync(outside);
      const handoffRoot = path.join(value.executionRoot, ".sennel", "handoffs");
      fs.mkdirSync(path.dirname(handoffRoot), { recursive: true });
      fs.symlinkSync(outside, handoffRoot);
      assert.throws(
        () => value.coordinator.createRequest({
          ctx: value.ctx,
          state,
          invocation: value.invocation,
        }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.classification === "invalid"
          && error.code === "FLOW_ARTIFACT_HANDOFF_INVALID",
      );
      assert.deepEqual(fs.readdirSync(outside), []);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("rejects a concurrent cataloged worker target update before publishing a stale handoff", () => {
    const value = fixture("draft-refine", {
      beforeActivate(candidate) {
        publishDraftBeforeTarget(candidate, draftDocument("before concurrent update"));
      },
    });
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(request.payloadPath("draft.json"), json(draftDocument("worker")));
      seal(request);
      const concurrentDraft = draftDocument("concurrent");
      value.flowManager.publishArtifacts({
        specId: value.specId,
        nodeId: "draft-refine",
        artifactWrites: [{
          logicalKey: "draft",
          mediaType: "application/json",
          bytes: Buffer.from(json(concurrentDraft), "utf8"),
        }],
      });
      assert.throws(
        () => value.coordinator.reconcile({ ctx: value.ctx, request }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.classification === "stale"
          && error.code === "FLOW_ARTIFACT_HANDOFF_STALE",
      );
      assert.deepEqual(readCatalogJson(value, "draft", "draft-refine"), concurrentDraft);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("discards an unsealed work unit from the current Run during recovery", () => {
    const value = fixture();
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });

      const recovered = value.coordinator.recoverPending({ ctx: value.ctx });

      assert.equal(recovered.completed, true);
      assert.equal(recovered.cleanedHandoffs, 1);
      assert.equal(fs.existsSync(request.directory), false);
      assert.equal(fs.existsSync(executionHandoffRoot(value)), false);
      assert.equal(fs.existsSync(path.join(value.executionRoot, ".sennel", "handoffs")), true);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("preserves an unsealed work unit owned by another Run", () => {
    const value = fixture();
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      const otherRunId = "another-run-worker-handoff";
      const document = JSON.parse(fs.readFileSync(request.requestPath, "utf8"));
      document.runId = otherRunId;
      fs.writeFileSync(request.requestPath, `${JSON.stringify(document, null, 2)}\n`);
      const currentRunDirectory = path.dirname(path.dirname(request.directory));
      const otherRunDirectory = path.join(request.handoffRoot, identityDigest(otherRunId).slice(0, 24));
      fs.renameSync(currentRunDirectory, otherRunDirectory);
      const otherRequestPath = path.join(
        otherRunDirectory,
        path.basename(path.dirname(request.directory)),
        path.basename(request.directory),
        "request.json",
      );

      assert.throws(
        () => value.coordinator.recoverPending({ ctx: value.ctx }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.code === "FLOW_ARTIFACT_HANDOFF_RECOVERY_REQUIRED"
          && error.data.runId === otherRunId,
      );
      assert.equal(fs.existsSync(otherRequestPath), true);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("does not scan another Spec handoff namespace during recovery", () => {
    const value = fixture();
    try {
      const foreignRoot = path.join(
        value.executionRoot,
        ".sennel",
        "handoffs",
        identityDigest("501-foreign-worker-handoff").slice(0, 24),
      );
      fs.mkdirSync(foreignRoot, { recursive: true });
      const marker = path.join(foreignRoot, "preserve.txt");
      fs.writeFileSync(marker, "foreign handoff\n");

      assert.equal(value.coordinator.recoverPending({ ctx: value.ctx }), null);
      assert.equal(fs.readFileSync(marker, "utf8"), "foreign handoff\n");
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("prunes only the completed Spec namespace after publication", () => {
    const value = fixture();
    try {
      const foreignRoot = path.join(
        value.executionRoot,
        ".sennel",
        "handoffs",
        identityDigest("501-foreign-worker-handoff").slice(0, 24),
      );
      fs.mkdirSync(foreignRoot, { recursive: true });
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(
        request.payloadPath("draft.json"),
        json(draftDocument("prune current namespace")),
      );
      seal(request);

      value.coordinator.reconcile({ ctx: value.ctx, request });

      assert.equal(fs.existsSync(executionHandoffRoot(value)), false);
      assert.equal(fs.existsSync(foreignRoot), true);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("recovers every V1 runtime cleanup interruption without reopening the Step", () => {
    const cleanupFaults = [
      "before-worker-handoff-cleanup-rename",
      "after-worker-handoff-cleanup-rename",
      "after-worker-handoff-cleanup",
    ];
    for (const faultPhase of cleanupFaults) {
      const value = fixture();
      try {
        const request = value.coordinator.createRequest({
          ctx: value.ctx,
          state: value.flowManager.load(),
          invocation: value.invocation,
        });
        fs.writeFileSync(request.payloadPath("draft.json"), json(draftDocument(faultPhase)));
        seal(request);
        const interrupted = new WorkerArtifactHandoffCoordinator({
          faultInjector({ phase }) {
            if (phase === faultPhase) throw new Error("simulated cleanup crash");
          },
        });
        assert.throws(
          () => interrupted.reconcile({ ctx: value.ctx, request }),
          (error) => error instanceof WorkerArtifactHandoffError
            && error.classification === "recovery-required"
            && error.data.stepId === "draft"
            && error.data.actionDigest === ACTION_DIGEST,
          faultPhase,
        );
        assert.equal(findStepById(value.flowManager.load().steps, "draft").status, "done", faultPhase);

        const recovered = value.coordinator.recoverPending({ ctx: value.ctx });
        if (faultPhase === "after-worker-handoff-cleanup") {
          assert.equal(recovered, null, faultPhase);
        } else {
          assert.equal(recovered.completed, true, faultPhase);
          assert.equal(recovered.cleanedHandoffs, 1, faultPhase);
        }
        assert.equal(fs.existsSync(request.directory), false, faultPhase);
        assert.equal(value.coordinator.recoverPending({ ctx: value.ctx }), null, faultPhase);
      } finally {
        removeTmpDir(value.mainRoot);
      }
    }
  });

  it("cleans a completed V1 runtime handoff when temporary request metadata is deleted", () => {
    const value = fixture();
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(
        request.payloadPath("draft.json"),
        json(draftDocument("recover metadata cleanup")),
      );
      seal(request);
      const interrupted = new WorkerArtifactHandoffCoordinator({
        faultInjector({ phase }) {
          if (phase === "before-worker-handoff-cleanup-rename") throw new Error("simulated cleanup interruption");
        },
      });
      assert.throws(
        () => interrupted.reconcile({ ctx: value.ctx, request }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.classification === "recovery-required",
      );
      assert.equal(findStepById(value.flowManager.load().steps, "draft").status, "done");
      fs.unlinkSync(request.requestPath);

      const recovered = value.coordinator.recoverPending({ ctx: value.ctx });
      const state = value.flowManager.load();
      assert.equal(recovered.completed, true);
      assert.equal(recovered.cleanedHandoffs, 1);
      assert.equal(findStepById(state.steps, "draft").status, "done");
      assert.equal(fs.existsSync(request.directory), false);
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });

  it("retains the guarded V1 run identity through cleanup recovery", () => {
    const runId = "b672ac1a-d8c7-4ea5-98c3-27431f6fbc8c";
    const value = fixture("draft", {
      runId,
      specId: "485-flow-authority-boundaries",
    });
    try {
      const request = value.coordinator.createRequest({
        ctx: value.ctx,
        state: value.flowManager.load(),
        invocation: value.invocation,
      });
      fs.writeFileSync(
        request.payloadPath("draft.json"),
        json(draftDocument("resume preserved run")),
      );
      seal(request);
      const interrupted = new WorkerArtifactHandoffCoordinator({
        faultInjector({ phase }) {
          if (phase === "before-worker-handoff-cleanup-rename") throw new Error("simulated interruption");
        },
      });
      assert.throws(
        () => interrupted.reconcile({ ctx: value.ctx, request }),
        (error) => error instanceof WorkerArtifactHandoffError
          && error.classification === "recovery-required",
      );

      value.coordinator.recoverPending({ ctx: value.ctx });
      const state = value.flowManager.load();
      assert.equal(state.runId, runId);
      assert.equal(findStepById(state.steps, "draft").status, "done");
      assert.ok(findStepById(state.steps, "draft").result.artifactRefs.some((entry) => (
        entry.kind === "worker-handoff"
      )));
    } finally {
      removeTmpDir(value.mainRoot);
    }
  });
});

function repairDigest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function repairTargetPermission(target, operationKinds) {
  return { target: structuredClone(target), operationKinds: [...operationKinds] };
}

function canonicalRepairSpec() {
  return {
    ...validSpec(),
    background: "The original background.",
    constraints: ["duplicate element", "duplicate element"],
    tasks: [{
      id: "T1",
      title: "Preserve the bounded repair",
      goal: "Keep the repaired specification executable.",
      acceptance: ["The canonical repair remains valid."],
      implementation_notes: "Use only the reviewed operation.",
      test_strategy: "Run the focused repair test.",
      parent: null,
      origin: "plan",
      added_round: 0,
      status: "pending",
    }],
  };
}

function repairDelta(baseRevision, operations, scopeExpansions = []) {
  return {
    version: 2,
    stage: "spec-repair",
    identity: { specId: "repair-fixture", revision: 1, digest: baseRevision, byteLength: 1 },
    baseReviewDigest: "a".repeat(64),
    findings: [],
    operations,
    scopeExpansions,
  };
}

function repairOperation({ findingId, kind, target, expectedDigest = null, replacement, reason = "The reviewed target requires correction." }) {
  return {
    findingIds: [findingId],
    kind,
    target: structuredClone(target),
    expectedDigest,
    replacement,
    reason,
  };
}

function triageDelta(items) {
  return { findings: items.map(({ findingId, decision, evidence, allowedTargets }) => ({
    findingId, disposition: decision, evidence, ...(decision === "apply" ? { allowedTargets } : {}),
  })) };
}

function applyFinding(findingId, allowedTargets) {
  return {
    findingId,
    title: "Bounded repair target",
    target: "reviewed target",
    decision: "apply",
    rationale: "The finding is actionable.",
    evidence: "The target is present in the immutable spec.",
    allowedTargets: allowedTargets.map(({ target, operationKinds }) => repairTargetPermission(target, operationKinds)),
  };
}

describe("spec-repair worker V2 delta contract", () => {
  it("accepts a V2 worker delta while publishing only a CLI-owned audit", () => {
    const revision = "b".repeat(64);
    const target = { entity: "requirement", id: "R1", field: "desc" };
    const triage = triageDelta([
      applyFinding("F-canonical", [repairTargetPermission(target, ["replace-entity-field"])]),
    ]);
    const proposal = repairDelta(revision, [repairOperation({
      findingId: "F-canonical",
      kind: "replace-entity-field",
      target,
      expectedDigest: repairDigest("Publish a validated artifact."),
      replacement: "The requirement was repaired through a bounded canonical delta.",
    })]);

    const result = applySpecRepairOperations({
      spec: canonicalRepairSpec(),
      triage,
      repair: proposal,
      inputRevision: revision,
    });

    assert.equal(result.spec.requirements[0].desc, "The requirement was repaired through a bounded canonical delta.");
    assert.equal(result.audit.version, 2);
    assert.equal(result.audit.phase, "spec-repair");
    assert.equal(result.audit.acceptedOperations[0].operation.kind, "replace-entity-field");
    assert.equal(result.audit.acceptedOperations[0].operation.replacement, "The requirement was repaired through a bounded canonical delta.");
    assert.equal(Object.hasOwn(result.audit, "rawResponse"), false);
    assert.equal(Object.hasOwn(result.audit, "operations"), false);
  });

  it("rejects full-spec and legacy repair envelopes at the worker boundary", () => {
    const revision = "c".repeat(64);
    const target = { entity: "requirement", id: "R1", field: "desc" };
    const triage = triageDelta([
      applyFinding("F-invalid-envelope", [repairTargetPermission(target, ["replace-entity-field"])]),
    ]);
    const apply = (repair) => applySpecRepairOperations({
      spec: canonicalRepairSpec(), triage, repair, inputRevision: revision,
    });
    assert.throws(
      () => apply({ ...repairDelta(revision, []), goal: "unauthorized full spec" }),
      (error) => error.code === "FLOW_SPEC_REPAIR_OPERATION_VALIDATION_FAILURE",
    );
    assert.throws(
      () => apply({
        ...repairDelta(revision, []),
        version: 1,
      }),
      (error) => error.code === "FLOW_SPEC_REPAIR_OPERATION_VALIDATION_FAILURE",
    );
  });

  it("discards a forbidden array kind while publishing independent authorized operations", () => {
    const revision = "d".repeat(64);
    const requirementTarget = { entity: "requirement", id: "R1", field: "desc" };
    const constraintsTarget = { collection: "constraints" };
    const triage = triageDelta([
      applyFinding(
        "F-permissions",
        [
          repairTargetPermission(requirementTarget, ["replace-entity-field"]),
          repairTargetPermission(constraintsTarget, ["replace-array-element"]),
        ],
      ),
    ]);
    const result = applySpecRepairOperations({
      spec: canonicalRepairSpec(),
      triage,
      repair: repairDelta(revision, [
        repairOperation({
          findingId: "F-permissions",
          kind: "add-array-element",
          target: constraintsTarget,
          replacement: "forbidden addition",
        }),
        repairOperation({
          findingId: "F-permissions",
          kind: "replace-entity-field",
          target: requirementTarget,
          expectedDigest: repairDigest("Publish a validated artifact."),
          replacement: "The independently authorized requirement correction.",
        }),
      ]),
      inputRevision: revision,
    });

    assert.equal(result.spec.requirements[0].desc, "The independently authorized requirement correction.");
    assert.deepEqual(result.spec.constraints, ["duplicate element", "duplicate element"]);
    assert.equal(result.audit.acceptedOperations.length, 1);
    assert.equal(result.audit.discardedOperations.length, 1);
    assert.equal(result.audit.discardedOperations[0].kind, "add-array-element");
  });

  it("discards a same-target conflict and retains a later independent operation", () => {
    const revision = "e".repeat(64);
    const requirementTarget = { entity: "requirement", id: "R1", field: "desc" };
    const backgroundTarget = { entity: "spec", field: "background" };
    const triage = triageDelta([
      applyFinding(
        "F-conflict",
        [
          repairTargetPermission(requirementTarget, ["replace-entity-field"]),
          repairTargetPermission(backgroundTarget, ["replace-field"]),
        ],
      ),
    ]);
    const result = applySpecRepairOperations({
        spec: canonicalRepairSpec(),
        triage,
        repair: repairDelta(revision, [
          repairOperation({ findingId: "F-conflict", kind: "replace-entity-field", target: requirementTarget, expectedDigest: repairDigest("Publish a validated artifact."), replacement: "first" }),
          repairOperation({ findingId: "F-conflict", kind: "replace-entity-field", target: requirementTarget, expectedDigest: repairDigest("Publish a validated artifact."), replacement: "conflicting second" }),
          repairOperation({ findingId: "F-conflict", kind: "replace-field", target: backgroundTarget, expectedDigest: repairDigest("The original background."), replacement: "independent retained correction" }),
        ]),
        inputRevision: revision,
      });
    assert.equal(result.audit.acceptedOperations.length, 1);
    assert.equal(result.audit.acceptedOperations[0].operation.target.field, "background");
    assert.equal(result.audit.discardedOperations.length, 2);
    assert.ok(result.audit.discardedOperations.every((entry) => /conflict/i.test(entry.reason)));
  });

  it("uses the optional base position to resolve a duplicate no-ID array element", () => {
    const revision = "f".repeat(64);
    const value = "duplicate element";
    const target = { collection: "constraints", position: 1 };
    const triage = triageDelta([
      applyFinding("F-position", [repairTargetPermission(target, ["replace-array-element"])]),
    ]);
    const result = applySpecRepairOperations({
      spec: canonicalRepairSpec(),
      triage,
      repair: repairDelta(revision, [repairOperation({
        findingId: "F-position",
        kind: "replace-array-element",
        target,
        expectedDigest: repairDigest(value),
        replacement: "the second duplicate is safely replaced",
      })]),
      inputRevision: revision,
    });

    assert.deepEqual(result.spec.constraints, [value, "the second duplicate is safely replaced"]);
  });
});
