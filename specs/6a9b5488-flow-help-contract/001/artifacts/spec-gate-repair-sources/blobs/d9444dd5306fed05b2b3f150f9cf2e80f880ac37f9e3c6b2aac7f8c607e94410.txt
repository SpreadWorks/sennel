/** Canonical reader for final-regression Definition facts. */
import {
  FinalRegressionRepositoryBinding,
  validateFinalRegressionResult,
} from "./test-artifacts.js";
import { CanonicalTestArtifactStore } from "./canonical-test-artifacts.js";
import { RepairArtifactRegistry } from "./repair-state-identity.js";
import {
  NonGateAttemptIdentity,
  NonGateCatalogPublication,
  NonGateCompletionFacts,
  NonGateLineage,
  NonGateProducerOwnership,
  NonGateRecoveryEvidence,
  NonGateRetryMetrics,
  NonGateSourcePublication,
  NonGateTargetBinding,
  NonGateTransitionFacts,
} from "./non-gate-transition.js";
import { FinalRegressionArtifactDigest, FinalRegressionStepFacts } from "./final-regression-transition.js";
import { readCurrentNonGateTransitionFacts } from "./non-gate-transition-facts.js";
import { FINAL_REGRESSION_STEP_DEFINITION, resolveNonGateTransition } from "../definition.js";

function attemptFor(snapshot) { return new NonGateAttemptIdentity(snapshot.attempt); }

function finalArtifact(flowManager, snapshot) {
  const document = new CanonicalTestArtifactStore({ flowManager, state: snapshot.state }).readCurrentAttempt({
    logicalKey: "final.regression",
    consumerNodeId: "final-regression",
  });
  const descriptor = snapshot.catalog.find((entry) => entry.relativePath === document.relativePath) ?? null;
  if (descriptor === null || descriptor.logicalKey !== "final.regression") throw new Error("final-regression canonical catalog publication is unavailable");
  for (const field of ["relativePath", "logicalKey", "hash", "activityId"]) {
    if (descriptor[field] !== document.descriptor[field]) {
      throw new Error(`final-regression snapshot catalog ${field} is stale`);
    }
  }
  if (document.attempt !== snapshot.attempt.sequence) {
    throw new Error("final-regression attempt history does not belong to the current Attempt");
  }
  const artifact = validateFinalRegressionResult(document.payload);
  return { artifact, descriptor, relativePath: document.relativePath };
}

export function captureFinalRegressionChangedSnapshotDigest({ root, relativeSpecFile } = {}) {
  const pathspecExcludes = new RepairArtifactRegistry(relativeSpecFile).gitPathspecExcludes();
  return FinalRegressionRepositoryBinding.capture(root, { pathspecExcludes }).worktreeSha256;
}

/**
 * Reconstruct one sealed non-Gate input only from the current Version
 * snapshot and its cataloged final-regression artifact.  A caller supplies
 * the current changed-file digest; unequal snapshots intentionally become a
 * Definition block rather than a runner-selected route.
 */
export function readFinalRegressionTransitionFacts({
  flowManager,
  specId,
  changedFileSnapshotDigest,
  candidateArtifact = null,
} = {}) {
  if (typeof changedFileSnapshotDigest !== "function") throw new Error("final-regression facts require changedFileSnapshotDigest()");
  return readCurrentNonGateTransitionFacts({
    flowManager,
    specId,
    readFacts(snapshot) {
      if (snapshot.stepId !== "final-regression") throw new Error("final-regression facts require the current final-regression Attempt");
      const current = finalArtifact(flowManager, snapshot);
      const artifact = candidateArtifact === null
        ? current.artifact
        : validateFinalRegressionResult(candidateArtifact);
      const { descriptor, relativePath } = current;
      const attempt = attemptFor(snapshot);
      const activity = snapshot.activities.find((entry) => entry.id === descriptor.activityId) ?? null;
      if (activity === null) throw new Error("final-regression catalog publication has no Activity");
      const artifactDigest = candidateArtifact === null
        ? descriptor.hash
        : FinalRegressionArtifactDigest.fromArtifact(artifact).value;
      const catalogFingerprint = descriptor.hash;
      const recordedSnapshotDigest = artifact.changedFileSnapshotDigest;
      const currentSnapshotDigest = changedFileSnapshotDigest({ snapshot, artifact });
      const retry = { used: snapshot.state.attempt.consumption.semantic, maximum: snapshot.state.definition.contractFor("final-regression", snapshot.state.root).semanticRetryLimit };
      const stepFacts = FinalRegressionStepFacts.fromCanonicalArtifact({
        artifact,
        artifactDigest,
        retry,
        changedFileSnapshot: { digest: recordedSnapshotDigest, current: currentSnapshotDigest === recordedSnapshotDigest },
        nonblocking: snapshot.state.policy?.nonblocking?.enabled === true,
        failureRecorded: snapshot.state.attempt.failure !== null,
      });
      return new NonGateTransitionFacts({
        runId: snapshot.runId, specId: snapshot.specId, stepId: "final-regression", snapshotRevision: snapshot.revision,
        producer: new NonGateProducerOwnership({ runId: snapshot.runId, specId: snapshot.specId, activityId: activity.id, stepId: "final-regression", attempt }),
        target: new NonGateTargetBinding({ runId: snapshot.runId, specId: snapshot.specId, stepId: "final-regression", attempt }), currentAttempt: attempt,
        catalogPublication: new NonGateCatalogPublication({ runId: snapshot.runId, specId: snapshot.specId, stepId: "final-regression", attemptId: attempt.id, sequence: attempt.sequence, producerActivityId: activity.id, artifactId: relativePath, fingerprint: catalogFingerprint }),
        sourcePublication: new NonGateSourcePublication({ runId: snapshot.runId, specId: snapshot.specId, stepId: "final-regression", attemptId: attempt.id, sequence: attempt.sequence, producerActivityId: activity.id, artifactId: relativePath, fingerprint: catalogFingerprint }),
        lineage: new NonGateLineage({ sourceAttempt: attempt, canonicalAttempt: attempt, sourceFingerprint: catalogFingerprint, canonicalFingerprint: catalogFingerprint }),
        retry: new NonGateRetryMetrics(retry),
        completion: new NonGateCompletionFacts({ completed: artifact.completed === true }), recoveryEvidence: new NonGateRecoveryEvidence(),
        nonblocking: snapshot.state.policy?.nonblocking?.enabled === true, stepFacts,
      });
    },
  });
}

/** The sole final-regression decision entrypoint for readers and appliers. */
export function resolveCanonicalFinalRegressionTransition(input = {}) {
  const facts = readFinalRegressionTransitionFacts(input);
  return facts === null ? null : resolveNonGateTransition(facts, FINAL_REGRESSION_STEP_DEFINITION);
}
