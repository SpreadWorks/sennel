/** Definition facts adapter for the scenario/test execution chain. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  DraftStepSettlementReceipt, settleImplStepResult,
  NonGateAttemptIdentity,
  NonGateCatalogPublication,
  NonGateCompletionFacts,
  NonGateLineage,
  NonGateProducerOwnership,
  NonGateSourcePublication,
  NonGateStepFacts,
  NonGateTargetBinding,
  NonGateTransitionFacts,
  TestExecuteStepFacts,
  TestResultReviewStepFacts,
  resolveMaxAttempts,
} from "../definition.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { CanonicalTestSourceRevision, canonicalRawEvidenceFingerprint } from "./canonical-test-artifacts.js";
import { validateTestResultReviewObservationCoherence } from "./test-artifacts.js";
import { StepExecutionContract } from "../engine/composition/step-execution-contract.js";
import { StepAdmissionRefusal } from "./step-admission-refusal.js";
import { projectNonGateTransitionDecision } from "./non-gate-transition-application.js";
import { StepResult, stepResultDigest } from "../engine/step-result.js";
import { AuthenticatedTestExecutionCompletion } from "./test-chain-observation-values.js";
import { BlockedDirective } from "./next-action-directive.js";

const RESULT_KEYS = Object.freeze({
  "test-execute": "test.execute",
  "test-result-review": "test.result.review",
});

/** Typed placeholder for an artifact rejected before Definition selection. */
class InvalidTestChainObservationFacts extends NonGateStepFacts {
  constructor({ stepId, payload, reason } = {}) {
    super({
      kind: "test-chain-invalid-observation",
      values: { stepId, payload, reason },
    });
  }
}

function currentActivity(snapshot, descriptor) {
  const activity = snapshot.activities.find((entry) => entry.id === descriptor.activityId) ?? null;
  if (activity === null) throw new Error("test-chain catalog publication has no persisted Activity");
  return activity;
}

function publication(snapshot, descriptor) {
  const activity = currentActivity(snapshot, descriptor);
  return new NonGateCatalogPublication({
    runId: snapshot.runId ?? snapshot.state.runId,
    specId: snapshot.specId ?? snapshot.state.specId,
    stepId: activity.nodeId,
    attemptId: activity.attemptId,
    sequence: activity.sequence,
    producerActivityId: activity.id,
    artifactId: descriptor.relativePath,
    fingerprint: descriptor.hash,
  });
}

function currentDescriptor(snapshot, logicalKey) {
  const descriptor = snapshot.catalog.find((entry) => (
    entry.logicalKey === logicalKey && entry.activityId != null
  )) ?? null;
  if (descriptor === null) throw new Error(`test-chain canonical artifact is absent: ${logicalKey}`);
  const activity = currentActivity(snapshot, descriptor);
  if (activity.nodeId !== snapshot.stepId
    || activity.attemptId !== snapshot.attempt.id
    || activity.sequence !== snapshot.attempt.sequence) {
    throw new Error("test-chain canonical artifact does not belong to the current Attempt");
  }
  return descriptor;
}

function sourcePublication(snapshot, descriptor) {
  const source = publication(snapshot, descriptor);
  return new NonGateSourcePublication(source.toJSON());
}

function catalogDigest(snapshot) {
  return createHash("sha256").update(JSON.stringify(snapshot.catalog)).digest("hex");
}

function immutableTransitionDescriptor(descriptor) {
  const value = structuredClone(descriptor?.toJSON?.() ?? descriptor);
  // FlowArtifactDescriptor serializes its authority slot flat for the catalog
  // format; test-source provenance consumes the typed slot relationship.
  if (value?.slot === undefined && value?.publicationStep !== undefined) {
    value.slot = { publicationStep: value.publicationStep };
  }
  return Object.freeze(value);
}

/** One immutable atomic view consumed by the test-chain facts adapter. */
export class TestChainTransitionSnapshot {
  constructor({ state, revision, activities, catalog, runId = null, specId = null, stepId = null, attempt = null } = {}) {
    const currentStep = state?.current?.at(-1) ?? stepId;
    const currentAttempt = state?.attempt ?? attempt;
    if (!state || typeof state !== "object" || typeof currentStep !== "string" || currentStep === "" || !currentAttempt) {
      throw new Error("test-chain transition snapshot requires an active canonical Attempt");
    }
    if (typeof revision !== "string" || revision === "") throw new Error("test-chain transition snapshot revision is required");
    const descriptors = Array.isArray(catalog) ? catalog : catalog?.artifacts;
    if (!Array.isArray(activities) || !Array.isArray(descriptors)) throw new Error("test-chain transition snapshot requires Activities and catalog");
    this.state = state;
    this.runId = state.runId ?? runId;
    this.specId = state.specId ?? specId;
    this.stepId = currentStep;
    this.revision = revision;
    this.attempt = Object.freeze({
      id: currentAttempt.id,
      sequence: currentAttempt.sequence,
      consumption: Object.freeze(structuredClone(currentAttempt.consumption?.toJSON?.() ?? currentAttempt.consumption)),
    });
    this.activities = Object.freeze(activities.map((activity) => Object.freeze(structuredClone(activity?.toJSON?.() ?? activity))));
    this.catalog = Object.freeze(descriptors.map(immutableTransitionDescriptor));
    Object.freeze(this);
  }
}

function rawEvidence(readRuntimeArtifact, logicalKey) {
  return readRuntimeArtifact({ logicalKey });
}

function testSourceRevision(snapshot, { catalog = snapshot.catalog, activities = snapshot.activities } = {}) {
  return CanonicalTestSourceRevision.fromCatalog({
    state: snapshot.state,
    catalog: Array.isArray(catalog) ? { artifacts: catalog } : catalog,
    activities,
  }).digest;
}

function assertCurrentTestSourceRevision(payload, snapshot, testSource, field = "test-chain artifact") {
  const revision = testSourceRevision(snapshot, testSource);
  if (payload?.testSourceRevision !== revision) {
    throw new Error(`${field} test source revision does not match the finalized catalog`);
  }
  return revision;
}

/** Authenticate a completed producer through the same Result/receipt contract as readback. */
function authenticatedExecutionCompletion(snapshot, descriptor, payload) {
  const activity = currentActivity(snapshot, descriptor);
  const stored = activity.result?.stepResult;
  const receipt = activity.result?.draftSettlementReceipt;
  if (stored == null || receipt == null) return null;
  const result = StepResult.fromStored("test-execute", stored.toJSON?.() ?? stored);
  if (result.kind !== "test-execute-observed" || !result.evidence.completion.completed
    || !result.evidence.observation.rawAvailable) return null;
  const settlement = settleImplStepResult("test-execute", result);
  DraftStepSettlementReceipt.assertStored(receipt.toJSON?.() ?? receipt, { result, settlement,
    binding: { runId: snapshot.state.runId, specId: snapshot.state.specId, stepId: "test-execute",
      attempt: { id: activity.attemptId, sequence: activity.sequence } } });
  const node = snapshot.state.findNode("test-execute");
  const selected = sourcePublication(snapshot, descriptor);
  if (node?.status !== "done" || node.attemptSequence !== activity.sequence
    || node.result?.draftSettlementReceipt?.id !== receipt.id
    || !isDeepStrictEqual(node.result.stepResult.toJSON(), result.toJSON())
    || !isDeepStrictEqual(result.evidence.publication.toJSON(), selected.toJSON())
    || result.evidence.observation.value("rawEvidenceFingerprint") !== payload.rawEvidenceFingerprint
    || result.evidence.observation.value("repairFingerprint") !== payload.repairFingerprint
    || result.evidence.observation.value("testSourceRevision") !== payload.testSourceRevision) {
    throw new StepAdmissionRefusal("Completed test execution no longer owns its publication and receipt");
  }
  return new AuthenticatedTestExecutionCompletion({ publication: selected,
    receiptId: receipt.id, resultDigest: receipt.resultDigest,
    rawEvidenceFingerprint: payload.rawEvidenceFingerprint });
}

/** Acquire the original completed execution before consuming an optional diagnostic. */
export function readAuthenticatedTestExecutionCompletion({ flowManager, specId }) {
  return flowManager.readCanonicalTransitionView({ specId, read(view) {
    const descriptor = view.catalog.artifacts.find((entry) => entry.logicalKey === "test.execute");
    if (descriptor === undefined) return null;
    const payload = currentPayload(descriptor, (entry) => view.readCatalogedArtifact(entry));
    assertCurrentTestSourceRevision(payload, view);
    const completion = authenticatedExecutionCompletion(view, descriptor, payload);
    const raw = view.readRuntimeArtifact({ logicalKey: "test.execute.raw-log", consumerNodeId: "test-result-review", optional: true });
    if (raw !== null && canonicalRawEvidenceFingerprint(raw.bytes) !== payload.rawEvidenceFingerprint) {
      throw new StepAdmissionRefusal("Completed test execution diagnostic fingerprint changed");
    }
    return completion;
  } });
}

function testStepFacts(stepId, payload, { snapshot, readRuntimeArtifact, sourcePayload = null, executionCompletion = null } = {}) {
  const digest = catalogDigest(snapshot);
  if (stepId === "test-execute") {
    return new TestExecuteStepFacts({
    summary: payload.summary ?? [], regression: payload.regression ?? {},
    rawAvailable: rawEvidence(readRuntimeArtifact, "test.execute.raw-log") !== null,
    testSourceRevision: payload.testSourceRevision,
    repairFingerprint: payload.repairFingerprint, rawEvidenceFingerprint: payload.rawEvidenceFingerprint, catalogDigest: digest,
    process: payload.process,
    });
  }
  if (stepId === "test-result-review") return new TestResultReviewStepFacts({
    executionCompletion,
    verdict: payload.verdict, checkedItems: payload.checked_items ?? [],
    rawAvailable: rawEvidence(readRuntimeArtifact, "test.execute.raw-log") !== null,
    testSourceRevision: payload.testSourceRevision,
    sourceRepairFingerprint: sourcePayload?.repairFingerprint,
    sourceRawEvidenceFingerprint: sourcePayload?.rawEvidenceFingerprint,
    repairFingerprint: payload.repairFingerprint, rawEvidenceFingerprint: payload.rawEvidenceFingerprint, catalogDigest: digest,
  });
  throw new Error(`test-chain has no Definition facts for ${stepId}`);
}

function currentPayload(descriptor, readCatalogedArtifact) {
  return CanonicalCommandAttemptArtifactHistory.fromBytes({
    logicalKey: descriptor.logicalKey,
    bytes: readCatalogedArtifact(descriptor),
  }).current.payload;
}

function observationCoherenceFailure(stepId, payload) {
  try {
    if (stepId === "test-result-review") validateTestResultReviewObservationCoherence(payload);
    return null;
  } catch {
    return `${stepId.replaceAll("-", "_")}_observation_contradiction`;
  }
}

/**
 * Rebuild one complete typed fact object exclusively from one lock-scoped
 * current Attempt view. The review source is additionally bound to the exact
 * producer repair fingerprint, so stale execution evidence cannot be
 * promoted by a fresh review Attempt.
 */
export function readTestChainTransitionFactsFromSnapshot({
  snapshot,
  readCatalogedArtifact,
  readRuntimeArtifact,
  testSource = undefined,
} = {}) {
  if (!(snapshot instanceof TestChainTransitionSnapshot)) {
    throw new Error("test-chain facts require a typed transition snapshot");
  }
  if (typeof readCatalogedArtifact !== "function" || typeof readRuntimeArtifact !== "function") {
    throw new Error("test-chain facts require authoritative artifact readers");
  }
  const logicalKey = RESULT_KEYS[snapshot.stepId];
  if (!logicalKey) return null;
  const descriptor = currentDescriptor(snapshot, logicalKey);
  const canonical = publication(snapshot, descriptor);
  const payload = currentPayload(descriptor, readCatalogedArtifact);
  let source = sourcePublication(snapshot, descriptor);
  let sourcePayload = null;
  let executionCompletion = null;
  let observedIntegrityFailure = observationCoherenceFailure(snapshot.stepId, payload);
  let lineage = new NonGateLineage({
    sourceAttempt: source.attempt,
    canonicalAttempt: canonical.attempt,
    sourceFingerprint: source.fingerprint,
    canonicalFingerprint: canonical.fingerprint,
  });
  if (snapshot.stepId === "test-result-review") {
    const executionDescriptor = snapshot.catalog.find((entry) => entry.logicalKey === "test.execute") ?? null;
    if (executionDescriptor === null) throw new Error("test-chain execution artifact is absent");
    const executionHistory = CanonicalCommandAttemptArtifactHistory.fromBytes({
      logicalKey: "test.execute", bytes: readCatalogedArtifact(executionDescriptor),
    });
    const executionPayload = executionHistory.current.payload;
    sourcePayload = executionPayload;
    source = sourcePublication(snapshot, executionDescriptor);
    let revision;
    try { revision = assertCurrentTestSourceRevision(executionPayload, snapshot, testSource, "test-execute artifact"); } catch (error) {
      if (error.code === "CANONICAL_TEST_SOURCE_REVISION_UNAVAILABLE") throw error;
      observedIntegrityFailure ??= "stale_test_source_revision";
    }
    if (revision !== undefined && payload.testSourceRevision !== revision) observedIntegrityFailure ??= "review_test_source_revision_mismatch";
    const consumed = payload.testExecute;
    if (consumed?.historyAttempt !== executionHistory.current.attempt
      || consumed?.producerActivityId !== source.producerActivityId
      || consumed?.attemptId !== source.attempt.id
      || consumed?.sequence !== source.attempt.sequence) {
      observedIntegrityFailure ??= "review_execute_attempt_mismatch";
    }
    const raw = rawEvidence(readRuntimeArtifact, "test.execute.raw-log");
    executionCompletion = raw === null ? authenticatedExecutionCompletion(snapshot, executionDescriptor, executionPayload) : null;
    const rawFingerprint = raw === null ? null : canonicalRawEvidenceFingerprint(raw.bytes);
    if (raw !== null && executionPayload.rawEvidenceFingerprint !== rawFingerprint) observedIntegrityFailure ??= "stale_execute_raw_fingerprint";
    if (payload.rawEvidenceFingerprint !== executionPayload.rawEvidenceFingerprint) observedIntegrityFailure ??= "review_execute_raw_fingerprint_mismatch";
    if (raw !== null && payload.rawEvidenceFingerprint !== rawFingerprint) observedIntegrityFailure ??= "review_raw_fingerprint_mismatch";
    const sourceRevision = executionPayload.repairFingerprint;
    const canonicalRevision = payload.repairFingerprint;
    if (typeof sourceRevision !== "string" || sourceRevision === "" || sourceRevision !== canonicalRevision) {
      observedIntegrityFailure ??= "review_repair_fingerprint_mismatch";
    }
    lineage = new NonGateLineage({
      sourceAttempt: source.attempt,
      canonicalAttempt: canonical.attempt,
      sourceFingerprint: source.fingerprint,
      canonicalFingerprint: canonical.fingerprint,
      sourceRevisionFingerprint: sourceRevision,
      canonicalRevisionFingerprint: canonicalRevision,
    });
  }
  const current = new NonGateAttemptIdentity(snapshot.attempt);
  if (snapshot.stepId !== "test-result-review") {
    try { assertCurrentTestSourceRevision(payload, snapshot, testSource, `${snapshot.stepId} artifact`); } catch (error) {
      if (error.code === "CANONICAL_TEST_SOURCE_REVISION_UNAVAILABLE") throw error;
      observedIntegrityFailure ??= "stale_test_source_revision";
    }
    if (snapshot.stepId === "test-execute") {
      const raw = rawEvidence(readRuntimeArtifact, "test.execute.raw-log");
      if (payload.rawEvidenceFingerprint !== canonicalRawEvidenceFingerprint(raw?.bytes ?? Buffer.alloc(0))) {
        observedIntegrityFailure ??= "stale_execute_raw_fingerprint";
      }
    }
  }
  const stepFacts = observedIntegrityFailure === null
    ? testStepFacts(snapshot.stepId, payload, { snapshot, readRuntimeArtifact, sourcePayload, executionCompletion })
    : new InvalidTestChainObservationFacts({
      stepId: snapshot.stepId,
      payload,
      reason: observedIntegrityFailure,
    });
  return new NonGateTransitionFacts({
    runId: snapshot.runId,
    specId: snapshot.specId,
    stepId: snapshot.stepId,
    snapshotRevision: snapshot.revision,
    producer: new NonGateProducerOwnership({
      runId: snapshot.runId, specId: snapshot.specId, activityId: canonical.producerActivityId,
      stepId: snapshot.stepId, attempt: current,
    }),
    target: new NonGateTargetBinding({ runId: snapshot.runId, specId: snapshot.specId, stepId: snapshot.stepId, attempt: current }),
    currentAttempt: current,
    catalogPublication: canonical,
    sourcePublication: source,
    lineage,
    retry: {
      // Sequence is a monotonic node cursor, while consumption is the retry
      // budget for this recovery episode. A rejected current observation
      // consumes its prospective semantic retry slot, not every historical
      // Attempt that preceded a reset/recovery.
      used: snapshot.attempt.consumption.semantic + 1,
      maximum: resolveMaxAttempts({ scope: "flow", stepId: snapshot.stepId, context: snapshot.state }) ?? 1,
    },
    completion: stepFacts.rawAvailable || executionCompletion !== null
      ? new NonGateCompletionFacts({ completed: true })
      : new NonGateCompletionFacts({ partial: true }),
    nonblocking: snapshot.state.policy?.nonblocking?.enabled === true,
    stepFacts,
    integrityFailure: observedIntegrityFailure,
  });
}

/**
 * Read the complete test-chain observation through the Store's one-lock view
 * when available. Lightweight fixture managers retain the same adapter via a
 * read-only fallback so Definition tests do not need a running dispatcher.
 */
export function readCurrentTestChainTransitionFacts({ flowManager, specId } = {}) {
  if (typeof flowManager?.readCanonicalTransitionView === "function") {
    return flowManager.readCanonicalTransitionView({
      specId,
      read: (view) => readTestChainTransitionFactsFromSnapshot({
      snapshot: new TestChainTransitionSnapshot(view),
        readCatalogedArtifact: (descriptor) => view.readCatalogedArtifact(descriptor),
        readRuntimeArtifact: (input) => view.readRuntimeArtifact(input),
      }),
    });
  }
  const current = flowManager.readCanonicalTransitionSnapshot(specId);
  if (current === null) return null;
  const snapshot = new TestChainTransitionSnapshot({
    state: current.state,
    revision: current.revision,
    activities: current.activities,
    catalog: current.catalog,
    runId: current.runId,
    specId: current.specId,
    stepId: current.stepId,
    attempt: current.attempt,
  });
  const currentKey = RESULT_KEYS[snapshot.stepId];
  const fullCatalog = typeof flowManager.artifactCatalog === "function"
    ? flowManager.artifactCatalog(snapshot.specId)
    : undefined;
  const fullActivities = typeof flowManager.activityLedger === "function"
    ? flowManager.activityLedger(snapshot.specId)
    : undefined;
  return readTestChainTransitionFactsFromSnapshot({
    snapshot,
    readCatalogedArtifact: (descriptor) => {
      if (descriptor.logicalKey === currentKey) {
        return flowManager.readActiveProducerArtifact({
          specId: snapshot.specId,
          nodeId: snapshot.stepId,
          logicalKey: descriptor.logicalKey,
        }).bytes;
      }
      return flowManager.readArtifact({
        specId: snapshot.specId,
        logicalKey: descriptor.logicalKey,
        consumerNodeId: snapshot.stepId,
      }).bytes;
    },
    readRuntimeArtifact: ({ logicalKey }) => flowManager.readRuntimeArtifact({
      specId: snapshot.specId,
      logicalKey,
      consumerNodeId: snapshot.stepId,
      optional: true,
    }),
    ...(fullCatalog !== undefined && fullActivities !== undefined && {
      testSource: { catalog: fullCatalog, activities: fullActivities },
    }),
  });
}

export function hasCurrentTestChainPublication(snapshot, logicalKey) {
  return snapshot.catalog.some((descriptor) => {
    if (descriptor.logicalKey !== logicalKey || descriptor.activityId == null) return false;
    const activity = snapshot.activities.find((entry) => entry.id === descriptor.activityId) ?? null;
    return activity?.nodeId === snapshot.stepId
      && activity.attemptId === snapshot.attempt.id
      && activity.sequence === snapshot.attempt.sequence;
  });
}

/**
 * Admission at the worker/process boundary. The canonical state already
 * projects the Definition-selected Action descriptor; this guard verifies
 * that it is this execute leaf before inspecting publication state. It does
 * not choose a route. A new execution is permitted only for that resume
 * descriptor with no observation yet published. Once a current result is
 * cataloged, Definition owns the next route; re-running the producer would
 * overwrite that evidence.
 */
export function admitTestChainDirectExecution({ flowManager, specId, stepId } = {}) {
  const logicalKey = RESULT_KEYS[stepId];
  if (!logicalKey) throw new Error(`test-chain direct admission has no Definition: ${stepId}`);
  const typedState = flowManager.canonicalState(specId);
  const selected = typedState?.nextAction?.() ?? null;
  if (selected?.nodeId !== stepId || selected.operation !== "resume") {
    throw new Error(`test-chain direct admission rejected Definition-selected ${selected?.operation ?? "missing"}`);
  }
  const snapshot = flowManager.readCanonicalTransitionSnapshot(specId);
  if (snapshot === null || snapshot.stepId !== stepId) {
    throw new Error("test-chain direct admission rejected a non-current execute Action");
  }
  if (!hasCurrentTestChainPublication(snapshot, logicalKey)) return Object.freeze({ state: "execute", snapshot });
  const saved = readCurrentTestChainSettlement({ flowManager, specId, stepId });
  throw new StepAdmissionRefusal(`test-chain direct admission rejected ${saved === null
    ? "observed publication without its settlement receipt" : `Definition-selected ${saved.settlement.kind}`}`);
}

/** Authenticate saved evidence against one current catalog view; never reinterpret its meaning. */
export function readCurrentTestChainSettlement({ flowManager, specId, stepId, completed = false, view = null, captured = null }) {
  try {
    const saved = captured ?? flowManager.readCurrentStepSettlement({ specId, stepId, completed });
    if (saved === null) return null;
    // The common projection boundary authenticates the Result/settlement/receipt relation.
    projectNonGateTransitionDecision(saved);
    const assertCurrentPublication = (view) => {
      const binding = saved.receipt.binding;
      const node = view.state.findNode(stepId);
      const activity = view.activities.find((entry) => entry.id === saved.activityId);
      if (binding.runId !== view.state.runId || binding.specId !== view.state.specId
        || binding.stepId !== stepId || activity?.nodeId !== stepId
        || activity.attemptId !== binding.attemptId || activity.sequence !== binding.attemptSequence
        || activity.result?.draftSettlementReceipt?.id !== saved.receipt.id
        || !isDeepStrictEqual(activity.result.stepResult.toJSON(), saved.result.toJSON())
        || (completed ? node?.result?.draftSettlementReceipt?.id !== saved.receipt.id
          : view.state.attempt?.nodeId !== stepId || view.state.attempt.id !== binding.attemptId
            || view.state.attempt.sequence !== binding.attemptSequence)) {
        throw new StepAdmissionRefusal("Saved test-chain settlement no longer owns its current Attempt");
      }
      const evidence = saved.result.evidence?.toJSON() ?? saved.result.error?.data?.evidence ?? null;
      if (evidence?.publication == null) return saved;
      let producerBinding = binding;
      let producerActivityId = saved.activityId;
      const accepted = saved.result.evidence?.acceptedDecision;
      if (accepted != null) {
        const original = view.activities.findLast((entry) => entry.result?.draftSettlementReceipt?.id === accepted.sourceReceiptId);
        const originalReceipt = original?.result?.draftSettlementReceipt;
        if (original === undefined || !["fail_attempt", "record_failure"].includes(original.transition.operation)
          || original.nodeId !== stepId || original.result.outcome !== "failed"
          || original.confirmationOrder >= activity.confirmationOrder
          || original.attemptId !== evidence.identity.attempt.id || original.sequence !== evidence.identity.attempt.sequence
          || originalReceipt.binding.runId !== view.state.runId || originalReceipt.binding.specId !== view.state.specId
          || originalReceipt.binding.stepId !== stepId || originalReceipt.binding.attemptId !== original.attemptId
          || originalReceipt.binding.attemptSequence !== original.sequence
          || !accepted.settlementAttempt.matches(new NonGateAttemptIdentity({ id: binding.attemptId, sequence: binding.attemptSequence }))) {
          throw new StepAdmissionRefusal("Accepted test Review lost its original failed source generation");
        }
        const latestOriginal = view.activities.findLast((entry) => entry.result?.draftSettlementReceipt?.binding?.stepId === stepId
          && entry.attemptId === original.attemptId && entry.sequence === original.sequence);
        if (latestOriginal !== original) throw new StepAdmissionRefusal("Accepted test Review source receipt generation changed");
        const originalResult = StepResult.fromStored(stepId, original.result.stepResult.toJSON());
        if (originalResult.kind !== saved.result.kind || originalResult.type !== saved.result.type
          || originalResult.evidence.acceptedDecision !== null) throw new StepAdmissionRefusal("Accepted test Review changed its original Result kind or type");
        DraftStepSettlementReceipt.assertStored(originalReceipt.toJSON?.() ?? originalReceipt, {
          result: originalResult, settlement: settleImplStepResult(stepId, originalResult),
          binding: { runId: view.state.runId, specId: view.state.specId, stepId,
            attempt: { id: original.attemptId, sequence: original.sequence } },
        });
        accepted.assertRecord(activity.transition.nonblocking);
        accepted.assertOriginalSource({ receipt: originalReceipt, resultDigest: stepResultDigest(originalResult),
          evidence: saved.result.evidence, originalEvidence: originalResult.evidence.toJSON() });
        producerBinding = originalReceipt.binding;
        producerActivityId = original.id;
      }
      const readPublication = (expected) => {
        const descriptor = view.catalog.artifacts.find((entry) => entry.relativePath === expected.artifactId);
        if (descriptor === undefined || descriptor.logicalKey !== RESULT_KEYS[expected.stepId]
          || !isDeepStrictEqual(publication(view, descriptor).toJSON(), expected)) {
          throw new StepAdmissionRefusal("Saved test-chain publication or producer identity changed");
        }
        const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: descriptor.logicalKey,
          bytes: view.readCatalogedArtifact(descriptor) });
        if (history.current.attempt !== expected.sequence) throw new StepAdmissionRefusal("Saved test-chain publication Attempt changed");
        return history.current.payload;
      };
      const payload = readPublication(evidence.publication);
      const source = readPublication(evidence.source);
      if (evidence.publication.producerActivityId !== producerActivityId
        || evidence.identity.runId !== producerBinding.runId || evidence.identity.specId !== producerBinding.specId
        || evidence.identity.stepId !== stepId || evidence.identity.attempt.id !== producerBinding.attemptId
        || evidence.identity.attempt.sequence !== producerBinding.attemptSequence
        || evidence.lineage.sourceAttempt.id !== evidence.source.attemptId
        || evidence.lineage.sourceAttempt.sequence !== evidence.source.sequence
        || evidence.lineage.canonicalAttempt.id !== evidence.publication.attemptId
        || evidence.lineage.canonicalAttempt.sequence !== evidence.publication.sequence
        || evidence.lineage.sourceFingerprint !== evidence.source.fingerprint
        || evidence.lineage.canonicalFingerprint !== evidence.publication.fingerprint) {
        throw new StepAdmissionRefusal("Saved test-chain source lineage changed");
      }
      // A saved failure remains a stop; it grants no authority to reuse incomplete raw evidence.
      if (saved.result.type === "error") return saved;
      assertCurrentTestSourceRevision(payload, view);
      assertCurrentTestSourceRevision(source, view);
      const raw = flowManager.readRuntimeArtifact({ specId, logicalKey: "test.execute.raw-log",
        consumerNodeId: stepId, optional: true });
      const retainedCompletion = saved.result.evidence?.observation?.executionCompletion ?? null;
      const executionDescriptor = view.catalog.artifacts.find((entry) => entry.logicalKey === "test.execute");
      const executionCompletion = executionDescriptor === undefined || raw !== null && retainedCompletion === null ? null
        : authenticatedExecutionCompletion(view, executionDescriptor, source);
      if (retainedCompletion !== null && (executionCompletion === null
        || !isDeepStrictEqual(retainedCompletion.toJSON(), executionCompletion.toJSON()))) {
        throw new StepAdmissionRefusal("Saved test Review completion receipt changed");
      }
      if (raw === null && executionCompletion === null
        || raw !== null && canonicalRawEvidenceFingerprint(raw.bytes) !== payload.rawEvidenceFingerprint
        || payload.rawEvidenceFingerprint !== source.rawEvidenceFingerprint
        || payload.repairFingerprint !== source.repairFingerprint) {
        throw new StepAdmissionRefusal("Saved test-chain raw evidence or repair lineage changed");
      }
      return saved;
    };
    return view === null ? flowManager.readCanonicalTransitionView({ specId, read: assertCurrentPublication })
      : assertCurrentPublication(view);
  } catch (cause) {
    if (cause instanceof StepAdmissionRefusal) throw cause;
    throw new StepAdmissionRefusal(`Test-chain settlement authentication refused: ${cause.message}`, cause);
  }
}

/** One selection shared by direct execution, dispatch projection and recovery. */
class TestChainProjectionPreparation {
  constructor({ flowManager, state, stepId }) {
    const snapshot = state.attempt !== null && state.current?.at(-1) === stepId
      ? flowManager.readCanonicalTransitionSnapshot(state.specId) : null;
    const published = snapshot?.stepId === stepId && hasCurrentTestChainPublication(snapshot, RESULT_KEYS[stepId]);
    this.saved = snapshot === null ? null : readCurrentTestChainSettlement({ flowManager, specId: state.specId, stepId });
    this.decision = this.saved?.settlement ?? null;
    this.action = this.saved === null ? null : projectNonGateTransitionDecision(this.saved);
    const awaiting = this.decision?.kind === "await";
    const failed = this.decision?.kind === "failure";
    this.directive = this.saved === null && published ? new BlockedDirective({
      code: "TEST_CHAIN_SETTLEMENT_MISSING", reason: "The observed test-chain publication has no saved Result and settlement receipt.",
      resumeInstruction: "Recover the exact canonical test-chain settlement before continuing.",
    }) : awaiting || failed ? new BlockedDirective({
      code: failed ? this.saved.result.error.code ?? "TEST_CHAIN_EVIDENCE_BLOCKED" : "TEST_CHAIN_NONBLOCKING_DECISION_REQUIRED",
      reason: failed ? this.saved.result.error.message : "Definition selected an explicit test-chain decision boundary.",
      resumeInstruction: "Resume from the saved test-chain settlement; do not rerun the observed producer directly.",
    }) : null;
    Object.freeze(this);
  }
}

/** Replay capability acquired by authenticating the exact canonical Result receipt. */
export class TestChainReceiptReplay {
  #flowManager;
  #specId;
  #stepId;
  constructor({ flowManager, specId, stepId, receipt }) {
    const saved = readCurrentTestChainSettlement({ flowManager, specId, stepId, completed: true });
    if (saved === null || !isDeepStrictEqual(saved.receipt.toJSON(), receipt.toJSON())) {
      throw new StepAdmissionRefusal("Test-chain replay requires its exact authenticated receipt");
    }
    this.#flowManager = flowManager;
    this.#specId = specId;
    this.#stepId = stepId;
    this.receipt = saved.receipt;
    Object.freeze(this);
  }
  assertCurrent() {
    const saved = readCurrentTestChainSettlement({ flowManager: this.#flowManager,
      specId: this.#specId, stepId: this.#stepId, completed: true });
    if (saved === null || !isDeepStrictEqual(saved.receipt.toJSON(), this.receipt.toJSON())) {
      throw new StepAdmissionRefusal("Test-chain replay selection is stale for its canonical receipt");
    }
  }
}

export class TestChainExecutionSelection {
  constructor({ state, stepId, registration, binding, preparation, receipt }) {
    if (registration?.stepId !== stepId
      || registration.executionContract !== testChainStepExecutionContract) {
      throw new StepAdmissionRefusal("Test-chain selection requires its registered execution contract");
    }
    this.runId = state.runId;
    this.specId = state.specId;
    this.stepId = stepId;
    this.registration = registration;
    this.binding = binding;
    this.preparation = preparation;
    this.receipt = receipt;
    Object.freeze(this);
  }

  get decision() { return this.preparation instanceof TestChainProjectionPreparation ? this.preparation.decision : null; }
  get action() { return this.preparation instanceof TestChainProjectionPreparation ? this.preparation.action : null; }
  get directive() { return this.preparation instanceof TestChainProjectionPreparation ? this.preparation.directive : null; }
}

export function selectTestChainExecution(input) {
  const flowManager = input.flowManager ?? input.ctx?.flowManager;
  const specId = input.specId ?? input.ctx?.flowState?.specId ?? input.binding?.specId;
  const state = flowManager.canonicalState(specId);
  const binding = input.binding ?? null;
  const preparation = input.preparation ?? (binding === null
    ? new TestChainProjectionPreparation({ flowManager, state, stepId: input.stepId }) : null);
  const receipt = input.receipt == null ? null : new TestChainReceiptReplay({
    flowManager, specId, stepId: input.stepId,
    receipt: input.receipt instanceof TestChainReceiptReplay ? input.receipt.receipt : input.receipt,
  });
  if (!Object.hasOwn(RESULT_KEYS, input.stepId)) throw new StepAdmissionRefusal("Unknown test-chain responsibility");
  if (binding !== null) {
    binding.assertCurrent();
    if (binding.stepId !== input.stepId || preparation?.observed?.stepId !== input.stepId) {
      throw new StepAdmissionRefusal("Test-chain adoption requires its exact acquired publication");
    }
    const identity = preparation.observed.evidence.identity;
    if (identity.runId !== state.runId || identity.specId !== state.specId
      || identity.attempt.id !== binding.attempt.id || identity.attempt.sequence !== binding.attempt.sequence) {
      throw new StepAdmissionRefusal("Test-chain observation belongs to another Attempt");
    }
  }
  return new TestChainExecutionSelection({ state, stepId: input.stepId, registration: input.registration,
    binding, preparation, receipt });
}

export function projectTestChainExecution(selection) {
  return selection;
}

export async function executeTestChainSelection(selection, input) {
  if (!(selection instanceof TestChainExecutionSelection)
    || selection.registration !== input.registration
    || selection.stepId !== input.registration.stepId) {
    throw new StepAdmissionRefusal("Test-chain execution requires its registered selection");
  }
  if (selection.receipt !== null) {
    selection.receipt.assertCurrent();
    return selection.receipt.receipt;
  }
  if (selection.binding === null || selection.preparation === null) {
    throw new StepAdmissionRefusal("Test-chain adoption requires its bound publication");
  }
  selection.binding.assertCurrent();
  const prepared = await input.registration.create({
    flowManager: input.flowManager, binding: selection.binding,
    preparation: selection.preparation, commandResult: input.commandResult,
  });
  await prepared.step.execute();
  return prepared.dependency(input.registration.ServiceClass).settlementOutcome;
}

export const testChainStepExecutionContract = new StepExecutionContract({
  select: selectTestChainExecution, project: projectTestChainExecution, execute: executeTestChainSelection,
});
