/**
 * Canonical reader for non-Gate transition facts.
 *
 * The callback reads Step-specific artifacts through the catalog and returns
 * typed facts.  This boundary then binds them to a freshly reloaded Version
 * Store snapshot; a caller cache or an old Attempt can never be promoted.
 */
import { NonGateTransitionFacts } from "./non-gate-transition.js";

function requireFlowManager(flowManager) {
  if (flowManager === null || typeof flowManager !== "object"
    || typeof flowManager.readCanonicalTransitionSnapshot !== "function") {
    throw new Error("non-Gate transition facts require canonical FlowManager snapshot APIs");
  }
}

function assertCatalogPublication(snapshot, publication, { label, current = false } = {}) {
  if (publication.runId !== snapshot.runId || publication.specId !== snapshot.specId) {
    throw new Error(`non-Gate ${label} publication does not belong to the current Flow`);
  }
  const activity = snapshot.activities.find((candidate) => candidate.id === publication.producerActivityId) ?? null;
  if (activity === null
    || activity.nodeId !== publication.stepId
    || activity.attemptId !== publication.attempt.id
    || activity.sequence !== publication.attempt.sequence) {
    throw new Error(`non-Gate ${label} publication is not owned by its persisted Activity`);
  }
  if (current && (publication.stepId !== snapshot.stepId
    || publication.attempt.id !== snapshot.attempt.id
    || publication.attempt.sequence !== snapshot.attempt.sequence)) {
    throw new Error("non-Gate canonical publication is not owned by the current Attempt");
  }
  const descriptor = snapshot.catalog.find((candidate) => candidate.relativePath === publication.artifactId) ?? null;
  if (descriptor === null
    || descriptor.hash !== publication.fingerprint
    || descriptor.activityId !== publication.producerActivityId) {
    throw new Error(`non-Gate ${label} publication does not match the canonical descriptor`);
  }
}

/**
 * `readFacts` is a Step-specific read-only adapter.  It receives the current
 * persisted snapshot and may read catalog artifacts, but it cannot choose a
 * transition; Definition receives its returned facts separately.
 */
export function readCurrentNonGateTransitionFacts({ flowManager, specId, readFacts } = {}) {
  requireFlowManager(flowManager);
  if (typeof readFacts !== "function") throw new Error("non-Gate transition facts require readFacts()");
  const snapshot = flowManager.readCanonicalTransitionSnapshot(specId);
  if (snapshot === null) return null;
  const facts = readFacts(snapshot);
  if (!(facts instanceof NonGateTransitionFacts)) {
    throw new Error("non-Gate transition facts reader must return NonGateTransitionFacts");
  }
  if (facts.runId !== snapshot.runId || facts.specId !== snapshot.specId || facts.stepId !== snapshot.stepId) {
    throw new Error("non-Gate transition facts do not match the current canonical target");
  }
  if (facts.snapshotRevision !== snapshot.revision) {
    throw new Error("non-Gate transition facts were read from a stale canonical snapshot");
  }
  if (facts.currentAttempt.id !== snapshot.attempt.id || facts.currentAttempt.sequence !== snapshot.attempt.sequence) {
    throw new Error("non-Gate transition facts belong to a stale Attempt");
  }
  assertCatalogPublication(snapshot, facts.catalogPublication, { label: "canonical", current: true });
  assertCatalogPublication(snapshot, facts.sourcePublication, { label: "source" });
  if (facts.repairPublication !== null) {
    assertCatalogPublication(snapshot, facts.repairPublication, { label: "repair" });
  }
  return facts;
}
