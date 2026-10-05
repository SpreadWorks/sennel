/** Closed-world extraction of eligible post-implementation evidence. */

import { GateFailureCategory } from "./gate-transition.js";

const RESULT_KINDS = new Set(["quality", "tooling", "unavailable"]);

export class NonblockingEvidenceClassificationError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = "NonblockingEvidenceClassificationError";
    this.code = "NONBLOCKING_EVIDENCE_UNCLASSIFIED";
  }
}

/** Canonical non-Gate failure classification shared by Definition and readers. */
export class NonblockingFailureClassification {
  constructor({ resultKind } = {}) {
    if (!RESULT_KINDS.has(resultKind)) throw new Error("nonblocking failure result kind is invalid");
    this.resultKind = resultKind;
    Object.freeze(this);
  }

  static fromStepFacts(step, facts) {
    if (step === "scenario-validity") {
      return new NonblockingFailureClassification({
        resultKind: facts.toolingFailure ? "tooling" : "unavailable",
      });
    }
    if (step === "test-result-review") {
      return new NonblockingFailureClassification({
        resultKind: facts.toolingFailure ? "tooling" : "quality",
      });
    }
    if (step === "final-regression") {
      const failure = facts.failure;
      return NonblockingFailureClassification.fromFinalRegressionFailure(failure);
    }
    throw new Error(`nonblocking failure classification is unavailable for ${step}`);
  }

  static fromArtifact(step, artifact) {
    if (step === "scenario-validity") {
      const process = artifact.process;
      if (process == null) {
        return new NonblockingFailureClassification({ resultKind: "unavailable" });
      }
      const tooling = process.started === false || process.spawnError != null
        || process.signal != null || process.timedOut === true || process.exitCode == null;
      return new NonblockingFailureClassification({ resultKind: tooling ? "tooling" : "unavailable" });
    }
    if (step === "test-result-review") {
      return new NonblockingFailureClassification({ resultKind: artifact.toolingFailure === true ? "tooling" : "quality" });
    }
    if (step === "final-regression") {
      return NonblockingFailureClassification.fromFinalRegressionFailure({
        kind: artifact.failureKind ?? null,
        category: artifact.failureCategory ?? null,
      });
    }
    throw new Error(`nonblocking failure classification is unavailable for ${step}`);
  }

  static fromFinalRegressionFailure(failure) {
    if (failure.kind === "invalid_project_test") {
      return new NonblockingFailureClassification({ resultKind: "unavailable" });
    }
    const toolingKinds = new Set([
      "infra_failure", "timeout", "dependency_failure", "sandbox_restriction",
      "child_process_eperm", "permission_error", "unattributed_existing_failure",
      "unattributed_unknown_failure",
    ]);
    const tooling = failure.tooling === true
      || (failure.category != null && failure.category !== "caused_by_current_change")
      || toolingKinds.has(failure.kind);
    return new NonblockingFailureClassification({ resultKind: tooling ? "tooling" : "quality" });
  }

  toJSON() { return { resultKind: this.resultKind }; }
}

function source(ref, source) {
  return { ref, source, value: JSON.parse(source) };
}

export function fromReviewResult({ ref, source: body }) {
  const found = source(ref, body);
  if (found.value.verdict === "REJECTED") return { ...found, resultKind: "quality" };
  if (found.value.toolingOutcome != null) return { ...found, resultKind: "tooling" };
  return null;
}

export function fromGateResult({ ref, source: body }) {
  const found = source(ref, body);
  if (found.value.verdict !== "fail" && found.value.result !== "fail") return null;
  // Gate owns one canonical classifier at its producer boundary. Reuse that
  // closed vocabulary here: the command result stores failureKind beneath
  // `artifacts`, never at the result root.
  let failure;
  try {
    failure = GateFailureCategory.fromObservedGateResult(found.value);
  } catch (error) {
    throw new NonblockingEvidenceClassificationError(error.message, { cause: error });
  }
  return {
    ...found,
    resultKind: failure.category === "semantic"
      ? "quality"
      : failure.category === "local" ? "unavailable" : "tooling",
  };
}

export function fromAcceptanceResult({ ref, source: body }) {
  const found = source(ref, body);
  // The acceptance artifact's current canonical vocabulary expresses the
  // rejected and inconclusive branches as repair_required and
  // user_decision_required.  Keep the artifact authoritative rather than
  // inventing a second result representation for nonblocking.
  return ["repair_required", "user_decision_required", "rejected", "inconclusive", "aborted", "blocked"].includes(found.value.verdict)
    ? { ...found, resultKind: "quality" }
    : null;
}

/**
 * Verification checkpoints have a durable result but no semantic finding
 * schema shared with reviews and gates.  A continuation records a typed
 * handoff for acceptance instead of pretending that the verification passed.
 */
export function fromVerificationResult({ ref, source: body }, step, classification = null) {
  const found = source(ref, body);
  if (step === "test-result-review" && found.value.verdict !== "pass") {
    return { ...found, resultKind: (classification ?? NonblockingFailureClassification.fromArtifact(step, found.value)).resultKind };
  }
  if (step === "retro" && Number(found.value?.summary?.not_done || 0) > 0) {
    return { ...found, resultKind: "quality" };
  }
  return null;
}

export function fromFinalRegressionResult({ ref, source: body }, classification = null) {
  const found = source(ref, body);
  if (!["fail", "unavailable", "not-run"].includes(found.value.result)) return null;
  if (found.value.result === "unavailable" || found.value.result === "not-run") {
    return { ...found, resultKind: "unavailable" };
  }
  return {
    ...found,
    resultKind: (classification ?? NonblockingFailureClassification.fromArtifact("final-regression", found.value)).resultKind,
  };
}
