/** Definition facts adapter for the scenario/test execution chain. */
import { createHash } from "node:crypto";
import {
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
  resolveNonGateTransition,
  testExecuteTransitionDefinition,
  testResultReviewTransitionDefinition,
} from "../definition.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { CanonicalTestSourceRevision, canonicalRawEvidenceFingerprint } from "./canonical-test-artifacts.js";
import { validateTestResultReviewObservationCoherence } from "./test-artifacts.js";

const RESULT_KEYS = Object.freeze({
  "test-execute": "test.execute",
  "test-result-review": "test.result.review",
});

const DEFINITIONS = Object.freeze({
  "test-execute": testExecuteTransitionDefinition,
  "test-result-review": testResultReviewTransitionDefinition,
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
    runId: snapshot.runId,
    specId: snapshot.specId,
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

function testStepFacts(stepId, payload, { snapshot, readRuntimeArtifact, sourcePayload = null } = {}) {
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
    const rawFingerprint = canonicalRawEvidenceFingerprint(raw?.bytes ?? Buffer.alloc(0));
    if (executionPayload.rawEvidenceFingerprint !== rawFingerprint) observedIntegrityFailure ??= "stale_execute_raw_fingerprint";
    if (payload.rawEvidenceFingerprint !== executionPayload.rawEvidenceFingerprint) observedIntegrityFailure ??= "review_execute_raw_fingerprint_mismatch";
    if (payload.rawEvidenceFingerprint !== rawFingerprint) observedIntegrityFailure ??= "review_raw_fingerprint_mismatch";
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
    ? testStepFacts(snapshot.stepId, payload, { snapshot, readRuntimeArtifact, sourcePayload })
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
    completion: stepFacts.rawAvailable
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
export function admitTestChainDirectExecution({ flowManager, specId, stepId, readFacts = readCurrentTestChainTransitionFacts } = {}) {
  const logicalKey = RESULT_KEYS[stepId];
  const definition = DEFINITIONS[stepId];
  if (!logicalKey || !definition) throw new Error(`test-chain direct admission has no Definition: ${stepId}`);
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
  try {
    const facts = readFacts({ flowManager, specId });
    const decision = resolveNonGateTransition(facts, definition);
    throw new Error(`test-chain direct admission rejected Definition-selected ${decision.disposition.operation}`);
  } catch (error) {
    if (String(error.message).startsWith("test-chain direct admission rejected")) throw error;
    throw new Error(`test-chain direct admission rejected unreadable observed evidence: ${error.message}`);
  }
}
