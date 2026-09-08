/**
 * Canonical ownership table for every Flow and task leaf.
 *
 * This table is deliberately executable domain data rather than prose.  The
 * dispatcher and its tests use the same entries that document producer,
 * writable authority, publication, validation, source binding, and recovery
 * ownership.
 */

import { ArtifactAuthority, ArtifactAuthoritySlot } from "../../lib/artifact-authority.js";

const CLAIM_MINT = Symbol("canonical-flow-artifact-publication-claim");

export class ArtifactPublicationClaim {
  constructor({ producer, stepId, authority } = {}, mint = null) {
    if (mint !== CLAIM_MINT) throw new Error("artifact publication claims can only be issued by the canonical Flow authority matrix");
    this.producer = requiredString(producer, "publication producer");
    this.stepId = requiredString(stepId, "publication stepId");
    this.authority = ArtifactAuthority.from(authority);
    Object.freeze(this);
  }
  assertSlot(slot, { contractBound = false } = {}) {
    if (!(slot instanceof ArtifactAuthoritySlot)) throw new Error("ArtifactAuthoritySlot is required for publication authority");
    if (!contractBound && this.authority.toString() !== slot.authority.toString()) {
      throw new Error(`artifact publication claim authority mismatch for ${this.stepId}`);
    }
    if (slot.publicationStep !== this.stepId) {
      throw new Error(`artifact publication claim step mismatch: ${this.stepId} cannot publish ${slot.publicationStep}`);
    }
    const entry = BY_STEP.get(this.stepId);
    if (entry !== undefined && entry.producer !== this.producer) {
      throw new Error(`artifact publication claim producer mismatch for ${this.stepId}`);
    }
    return slot;
  }
}

/**
 * A source worker may carry an optional upgrade result in its sealed handoff.
 * The parent still publishes that system-owned artifact, as part of the
 * source Attempt transaction.  This deliberately delegates only that one
 * logical artifact while retaining the ordinary source Step claim for every
 * state and effect artifact in the same publication.
 */
class SourceWorkerUpgradePublicationClaim extends ArtifactPublicationClaim {
  assertSlot(slot, { contractBound = false, logicalKey = null } = {}) {
    if (logicalKey === "upgrade.result") {
      if (!(slot instanceof ArtifactAuthoritySlot)) {
        throw new Error("ArtifactAuthoritySlot is required for publication authority");
      }
      if (slot.publicationStep !== "system" || slot.authority.toString() !== "canonical-flow-artifacts") {
        throw new Error("source worker upgrade evidence requires the system upgrade.result slot");
      }
      return slot;
    }
    return super.assertSlot(slot, { contractBound });
  }
}

const PRODUCERS = new Set(["cli", "worker", "user"]);
const OWNERS = new Set(["cli", "dispatcher", "worker", "user"]);
const CATEGORIES = new Set(["preparation", "command", "artifact", "source", "user"]);
const SOURCE_MUTATION_MODES = new Set(["required", "optional", "forbidden"]);

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Flow artifact authority ${field} is required`);
  }
  return value.trim();
}

/** Source-diff behavior owned by one source handoff authority entry. */
export class SourceMutationAuthority {
  constructor(mode) {
    this.mode = requiredString(mode, "sourceMutation.mode");
    if (!SOURCE_MUTATION_MODES.has(this.mode)) {
      throw new Error(`invalid source mutation authority mode: ${this.mode}`);
    }
    Object.freeze(this);
  }

  requiresDiff(completionStatus) {
    return this.mode === "required" && completionStatus === "done";
  }

  forbidsDiff(completionStatus) {
    return this.mode === "forbidden" || completionStatus === "skipped";
  }

  effectContract() {
    return this.mode === "required"
      ? "required for done; every changed source mutation must occur in files[].mutationIds"
      : this.mode === "optional"
        ? "optional; an empty manifest requires a recorded no-change reason"
      : "forbidden";
  }

  toJSON() { return this.mode; }
}

export class FlowArtifactAuthorityEntry {
  constructor({
    stepId,
    producer,
    writableAuthority,
    consumer,
    publicationOwner,
    completionValidator,
    sourceBinding,
    recoveryOwner,
    category,
    workerHandoff = false,
    sourceHandoff = false,
    sourceMutation = null,
  }) {
    this.stepId = requiredString(stepId, "stepId");
    this.producer = requiredString(producer, `${this.stepId}.producer`);
    this.writableAuthority = requiredString(
      writableAuthority,
      `${this.stepId}.writableAuthority`,
    );
    this.consumer = requiredString(consumer, `${this.stepId}.consumer`);
    this.publicationOwner = requiredString(
      publicationOwner,
      `${this.stepId}.publicationOwner`,
    );
    this.completionValidator = requiredString(
      completionValidator,
      `${this.stepId}.completionValidator`,
    );
    this.sourceBinding = requiredString(sourceBinding, `${this.stepId}.sourceBinding`);
    this.recoveryOwner = requiredString(recoveryOwner, `${this.stepId}.recoveryOwner`);
    this.category = requiredString(category, `${this.stepId}.category`);
    if (!PRODUCERS.has(this.producer)) throw new Error(`invalid producer for ${this.stepId}`);
    ArtifactAuthority.from(this.writableAuthority);
    if (!OWNERS.has(this.publicationOwner) || !OWNERS.has(this.recoveryOwner)) {
      throw new Error(`invalid owner for ${this.stepId}`);
    }
    if (!CATEGORIES.has(this.category)) throw new Error(`invalid category for ${this.stepId}`);
    this.workerHandoff = workerHandoff === true;
    this.sourceHandoff = sourceHandoff === true;
    this.sourceMutation = sourceMutation === null ? null : new SourceMutationAuthority(sourceMutation);
    if (this.workerHandoff && (
      this.producer !== "worker"
      || this.writableAuthority !== "dispatcher-handoff"
      || this.publicationOwner !== "dispatcher"
      || this.recoveryOwner !== "dispatcher"
    )) {
      throw new Error(`worker handoff ownership is inconsistent for ${this.stepId}`);
    }
    if (this.sourceHandoff && (
      this.category !== "source"
      || this.producer !== "worker"
      || this.writableAuthority !== "execution-checkout"
      || this.publicationOwner !== "dispatcher"
      || this.recoveryOwner !== "dispatcher"
    )) {
      throw new Error(`worker source handoff ownership is inconsistent for ${this.stepId}`);
    }
    if (this.sourceHandoff !== (this.sourceMutation instanceof SourceMutationAuthority)) {
      throw new Error(`source mutation authority is inconsistent for ${this.stepId}`);
    }
    if ((this.workerHandoff || this.sourceHandoff) && this.category === "command") {
      throw new Error(`handoff entry cannot be a command for ${this.stepId}`);
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      stepId: this.stepId,
      producer: this.producer,
      writableAuthority: this.writableAuthority,
      consumer: this.consumer,
      publicationOwner: this.publicationOwner,
      completionValidator: this.completionValidator,
      sourceBinding: this.sourceBinding,
      recoveryOwner: this.recoveryOwner,
      category: this.category,
      workerHandoff: this.workerHandoff,
      sourceHandoff: this.sourceHandoff,
      sourceMutation: this.sourceMutation?.toJSON() ?? null,
    };
  }
}

function commandOwned(stepId, consumer = "next Flow leaf") {
  return new FlowArtifactAuthorityEntry({
    stepId,
    producer: "cli",
    writableAuthority: "canonical-flow-artifacts",
    consumer,
    publicationOwner: "cli",
    completionValidator: "definition lifecycle hook",
    sourceBinding: "guarded Flow target and command input fingerprint",
    recoveryOwner: "cli",
    category: "command",
  });
}

function preparationOwned(stepId, consumer = "next Flow leaf") {
  return new FlowArtifactAuthorityEntry({
    stepId,
    producer: "cli",
    writableAuthority: "canonical-flow-artifacts",
    consumer,
    publicationOwner: "cli",
    completionValidator: "prepare-spec transaction",
    sourceBinding: "prepared Flow identity and execution plan",
    recoveryOwner: "cli",
    category: "preparation",
  });
}

function workerSourceOwned(stepId, sourceMutation, consumer = "next Flow leaf") {
  return new FlowArtifactAuthorityEntry({
    stepId,
    producer: "worker",
    writableAuthority: "execution-checkout",
    consumer,
    publicationOwner: "dispatcher",
    completionValidator: "sealed source effect and source-diff transaction",
    sourceBinding: "run, spec, Issue, step, action, invocation, immutable source baseline, and effect schema",
    recoveryOwner: "dispatcher",
    category: "source",
    sourceHandoff: true,
    sourceMutation,
  });
}

function workerHandoffOwned(stepId, consumer, completionValidator) {
  return new FlowArtifactAuthorityEntry({
    stepId,
    producer: "worker",
    writableAuthority: "dispatcher-handoff",
    consumer,
    publicationOwner: "dispatcher",
    completionValidator,
    sourceBinding: "run, spec, Issue, step, action, invocation, input digest, and revision",
    recoveryOwner: "dispatcher",
    category: "artifact",
    workerHandoff: true,
  });
}

function userOwned(stepId, consumer = "next Flow leaf") {
  return new FlowArtifactAuthorityEntry({
    stepId,
    producer: "user",
    writableAuthority: "user-decision",
    consumer,
    publicationOwner: "cli",
    completionValidator: "digest-guarded explicit decision",
    sourceBinding: "guarded Flow target and action digest",
    recoveryOwner: "user",
    category: "user",
  });
}

const ENTRIES = Object.freeze([
  preparationOwned("branch", "prepare-spec"),
  preparationOwned("prepare-spec", "draft"),
  workerHandoffOwned("draft", "draft-questions-review", "draft schema and revision transaction"),
  commandOwned("draft-questions-review", "draft-questions-triage or draft-refine"),
  workerHandoffOwned("draft-questions-triage", "draft-questions-repair", "draft triage linkage validator"),
  workerHandoffOwned("draft-questions-repair", "draft-refine", "draft repair and revision transaction"),
  workerHandoffOwned("draft-refine", "draft-coverage-review", "draft schema and revision transaction"),
  commandOwned("draft-coverage-review", "draft-coverage-triage or draft-gate"),
  workerHandoffOwned("draft-coverage-triage", "draft-coverage-repair", "draft triage linkage validator"),
  workerHandoffOwned("draft-coverage-repair", "draft-gate", "draft repair and Definition-owned completion transaction"),
  commandOwned("draft-gate", "spec"),
  workerHandoffOwned("spec", "spec-review", "spec schema and revision transaction"),
  commandOwned("spec-review", "spec-triage or spec-gate"),
  workerHandoffOwned("spec-triage", "spec-repair", "spec triage linkage validator"),
  workerHandoffOwned("spec-repair", "spec-gate", "spec repair and revision transaction"),
  commandOwned("spec-gate", "approval"),
  userOwned("approval", "test"),
  workerHandoffOwned("test", "scenario-validity", "spec-test manifest and coverage validator"),
  commandOwned("scenario-validity", "governed test repair or test-review"),
  commandOwned("test-review", "governed test repair or implement"),
  workerSourceOwned("implement", "required", "test-execute"),
  commandOwned("test-execute", "test-result-review"),
  commandOwned("test-result-review", "impl-review"),
  commandOwned("impl-review", "impl-triage or impl-gate"),
  workerSourceOwned("impl-triage", "forbidden", "impl-repair or impl-gate"),
  workerSourceOwned("impl-repair", "required", "test-execute"),
  commandOwned("impl-gate", "retro"),
  commandOwned("retro", "acceptance-review"),
  commandOwned("acceptance-review", "acceptance-decision or final-regression"),
  userOwned("acceptance-decision", "final-regression"),
  commandOwned("final-regression", "report"),
  commandOwned("report", "finalize-commit"),
  commandOwned("finalize-commit", "finalize-merge"),
  commandOwned("finalize-merge", "finalize-sync"),
  commandOwned("finalize-sync", "finalize-cleanup"),
  commandOwned("finalize-cleanup", "terminal Flow state"),
  workerSourceOwned("task-impl", "optional", "task-review"),
  commandOwned("task-review", "task-triage or task-gate"),
  workerSourceOwned("task-triage", "forbidden", "task-repair or task-gate"),
  workerSourceOwned("task-repair", "required", "task-review or task-gate"),
  commandOwned("task-gate", "next task or implement"),
]);

const BY_STEP = new Map(ENTRIES.map((entry) => [entry.stepId, entry]));
if (BY_STEP.size !== ENTRIES.length) throw new Error("duplicate Flow artifact authority step");

export const FLOW_ARTIFACT_AUTHORITY_MATRIX = ENTRIES;
export const WORKER_ARTIFACT_HANDOFF_STEPS = Object.freeze(
  ENTRIES.filter((entry) => entry.workerHandoff).map((entry) => entry.stepId),
);
export const WORKER_SOURCE_HANDOFF_STEPS = Object.freeze(
  ENTRIES.filter((entry) => entry.sourceHandoff).map((entry) => entry.stepId),
);

export function flowArtifactAuthorityForStep(stepId) {
  return BY_STEP.get(stepId) || null;
}

export function requiresWorkerArtifactHandoff(stepId) {
  return flowArtifactAuthorityForStep(stepId)?.workerHandoff === true;
}

export function requiresWorkerSourceHandoff(stepId) {
  return flowArtifactAuthorityForStep(stepId)?.sourceHandoff === true;
}

export function assertCatalogPublicationAuthority(stepId, authority) {
  const entry = flowArtifactAuthorityForStep(stepId);
  if (!entry) throw new Error(`unknown Flow artifact authority step: ${stepId}`);
  const catalogAuthority = ArtifactAuthority.from(authority);
  if (entry.writableAuthority !== catalogAuthority.toString()) throw new Error(`catalog authority mismatch for ${stepId}: expected ${entry.writableAuthority}`);
  return entry;
}

export function artifactPublicationClaimForStep(stepId) {
  const entry = flowArtifactAuthorityForStep(stepId);
  if (!entry) throw new Error(`unknown Flow artifact authority step: ${stepId}`);
  return new ArtifactPublicationClaim({
    producer: entry.producer, stepId: entry.stepId, authority: entry.writableAuthority,
  }, CLAIM_MINT);
}

/** Issue the parent-only mixed claim used for a sealed source-worker upgrade. */
export function sourceWorkerUpgradePublicationClaimForStep(stepId) {
  const entry = flowArtifactAuthorityForStep(stepId);
  if (!entry?.sourceHandoff) {
    throw new Error(`source worker upgrade publication requires a source handoff Step: ${stepId}`);
  }
  return new SourceWorkerUpgradePublicationClaim({
    producer: entry.producer, stepId: entry.stepId, authority: entry.writableAuthority,
  }, CLAIM_MINT);
}
