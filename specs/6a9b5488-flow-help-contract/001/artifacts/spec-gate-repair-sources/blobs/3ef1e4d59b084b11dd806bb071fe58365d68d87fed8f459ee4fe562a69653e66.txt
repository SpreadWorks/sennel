/**
 * Canonical reader for the retro stale-evidence recovery facts.
 *
 * The runner supplies only the current repository fingerprint. This reader
 * obtains the active retro Attempt and both producer publications under the
 * Version Store catalog lock; Definition then selects the fixed recovery.
 */

import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { RetroStaleEvidencePublication, RetroStaleEvidenceRecoveryFacts } from "../definition.js";
import { StaleTestEvidenceMismatch } from "./stale-test-evidence-refresh.js";

const REQUIRED_KEYS = Object.freeze(["test.execute", "test.result.review"]);

function currentPayload(view, descriptor) {
  return CanonicalCommandAttemptArtifactHistory.fromBytes({
    logicalKey: descriptor.logicalKey,
    bytes: view.readCatalogedArtifact(descriptor),
  }).current.payload;
}

function requiredDescriptor(view, logicalKey) {
  const descriptor = view.catalog.artifacts.find((entry) => entry.logicalKey === logicalKey) ?? null;
  if (descriptor === null || descriptor.activityId === null) {
    throw new Error(`retro stale evidence requires canonical ${logicalKey} publication`);
  }
  return descriptor;
}

/**
 * Returns null when current producer evidence is not stale. A non-null value
 * contains every persisted fact the Definition and Store need to seal one
 * retro -> test-execute recovery.
 */
export function readCurrentRetroStaleEvidenceRecoveryFacts({ flowManager, specId, currentFingerprint } = {}) {
  if (!flowManager || typeof flowManager.readCanonicalTransitionView !== "function") {
    throw new Error("retro stale evidence facts require canonical FlowManager transition views");
  }
  return flowManager.readCanonicalTransitionView({
    specId,
    read: (view) => {
      const state = view.state;
      if (state.current?.at(-1) !== "retro" || state.attempt === null) {
        throw new Error("retro stale evidence facts require the active retro Attempt");
      }
      const descriptors = REQUIRED_KEYS.map((logicalKey) => requiredDescriptor(view, logicalKey));
      const payloads = new Map(descriptors.map((descriptor) => [descriptor.logicalKey, currentPayload(view, descriptor)]));
      const stale = StaleTestEvidenceMismatch.detect({
        artifacts: new Map([
          ["test-execute-result.json", payloads.get("test.execute")],
          ["test-result-review.json", payloads.get("test.result.review")],
        ]),
        currentFingerprint,
      });
      if (stale === null) return null;
      return new RetroStaleEvidenceRecoveryFacts({
        runId: state.runId,
        specId: state.specId,
        stepId: "retro",
        attemptId: state.attempt.id,
        sequence: state.attempt.sequence,
        snapshotRevision: view.revision,
        publications: descriptors.map((descriptor) => new RetroStaleEvidencePublication({
          logicalKey: descriptor.logicalKey,
          relativePath: descriptor.relativePath,
          hash: descriptor.hash,
          activityId: descriptor.activityId,
        })),
        artifactNames: stale.artifactNames,
        previousFingerprint: stale.previousFingerprint,
        currentFingerprint: stale.currentFingerprint,
      });
    },
  });
}
