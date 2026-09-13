/** Immutable Requirement-scoped preimplementation test lifecycle values. */

import path from "node:path";
import { validateSpecJsonObject } from "../../lib/spec-json.js";
import { SpecRevisionIdentity } from "./spec-revision-identity.js";

const EXPECTATIONS = new Set(["fail", "pass"]);
const STATUSES = new Set(["pending", "in_progress", "candidate_saved", "reviewed", "promoted", "deferred"]);
const BUDGET_KINDS = new Set(["autoSemantic", "manualSemantic", "tooling"]);
const LIFECYCLE_LEAVES = new Set(["test-generate", "test-review", "test-repair", "test-gate"]);

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function canonicalRelativePath(value, field) {
  const candidate = requiredText(value, field);
  const segments = candidate.split("/");
  if (candidate !== value || path.posix.isAbsolute(candidate) || candidate.includes("\\")
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")
    || path.posix.normalize(candidate) !== candidate) {
    throw new Error(`${field} must be a canonical repository-relative path`);
  }
  return candidate;
}

function exactKeys(value, required, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has an invalid schema`);
  }
}

function specRevision(value) {
  return value instanceof SpecRevisionIdentity ? value : new SpecRevisionIdentity(value);
}

function sameSpecRevision(left, right) {
  return left.equals(right);
}

/** Per-Requirement persisted counters. Definition owns limits and exhaustion policy. */
export class RequirementTestBudget {
  constructor({ autoSemantic = 0, manualSemantic = 0, tooling = 0 } = {}) {
    for (const [kind, value] of Object.entries({ autoSemantic, manualSemantic, tooling })) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`Requirement test ${kind} counter must be a non-negative integer`);
      }
      this[kind] = value;
    }
    Object.freeze(this);
  }

  static initial() { return new RequirementTestBudget(); }

  static fromJSON(value) {
    exactKeys(value, ["autoSemantic", "manualSemantic", "tooling"], "Requirement test budget");
    return new RequirementTestBudget(value);
  }

  increment(kind) {
    if (!BUDGET_KINDS.has(kind)) throw new Error("Requirement test budget kind is invalid");
    return new RequirementTestBudget({
      autoSemantic: this.autoSemantic + (kind === "autoSemantic" ? 1 : 0),
      manualSemantic: this.manualSemantic + (kind === "manualSemantic" ? 1 : 0),
      tooling: this.tooling + (kind === "tooling" ? 1 : 0),
    });
  }

  toJSON() {
    return {
      autoSemantic: this.autoSemantic,
      manualSemantic: this.manualSemantic,
      tooling: this.tooling,
    };
  }
}

/** One canonical semantic finding that has consumed this Requirement's retry budget. */
export class RequirementTestSemanticFinding {
  constructor({ requirementId, bundleRevision, fingerprint } = {}) {
    this.requirementId = requiredText(requirementId, "Requirement test semantic finding requirementId");
    this.bundleRevision = positiveInteger(bundleRevision, "Requirement test semantic finding bundleRevision");
    if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new Error("Requirement test semantic finding fingerprint must be a SHA-256 digest");
    }
    this.fingerprint = fingerprint;
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, ["requirementId", "bundleRevision", "fingerprint"], "Requirement test semantic finding");
    return new RequirementTestSemanticFinding(value);
  }

  equals(other) {
    return other instanceof RequirementTestSemanticFinding
      && other.requirementId === this.requirementId
      && other.bundleRevision === this.bundleRevision
      && other.fingerprint === this.fingerprint;
  }

  toJSON() { return { requirementId: this.requirementId, bundleRevision: this.bundleRevision, fingerprint: this.fingerprint }; }
}

/** Explicit red/green expectation captured in the approved Spec. */
export class RequirementTestExpectation {
  constructor(value) {
    if (!EXPECTATIONS.has(value)) throw new Error("Requirement test expectation must be fail or pass");
    this.value = value;
    Object.freeze(this);
  }

  static from(value) {
    return value instanceof RequirementTestExpectation ? value : new RequirementTestExpectation(value);
  }

  toJSON() { return this.value; }
  toString() { return this.value; }
}

/** Canonical producer Attempt that created a candidate or repair bundle. */
export class RequirementTestSourceAttempt {
  constructor({ id, sequence } = {}) {
    this.id = requiredText(id, "Requirement test source Attempt id");
    this.sequence = positiveInteger(sequence, "Requirement test source Attempt sequence");
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, ["id", "sequence"], "Requirement test source Attempt");
    return new RequirementTestSourceAttempt(value);
  }

  toJSON() { return { id: this.id, sequence: this.sequence }; }
}

/** Exact catalog publication which supplied the mutable Requirement plan. */
export class RequirementTestPlanPublication {
  constructor({ logicalKey, relativePath, hash, size, activityId } = {}) {
    if (logicalKey !== "test.requirement.plan" || relativePath !== "steps/test-generate/plan.json") {
      throw new Error("Requirement test plan publication must identify the canonical plan artifact");
    }
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error("Requirement test plan publication hash is invalid");
    }
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("Requirement test plan publication size is invalid");
    }
    this.logicalKey = logicalKey;
    this.relativePath = relativePath;
    this.hash = hash;
    this.size = size;
    this.activityId = requiredText(activityId, "Requirement test plan publication activityId");
    Object.freeze(this);
  }

  static fromDescriptor(value) {
    return value instanceof RequirementTestPlanPublication
      ? value
      : new RequirementTestPlanPublication(value);
  }

  matches(descriptor) {
    return descriptor?.logicalKey === this.logicalKey
      && descriptor.relativePath === this.relativePath
      && descriptor.hash === this.hash
      && descriptor.size === this.size
      && descriptor.activityId === this.activityId;
  }

  toJSON() {
    return {
      logicalKey: this.logicalKey,
      relativePath: this.relativePath,
      hash: this.hash,
      size: this.size,
      activityId: this.activityId,
    };
  }
}

/** Stable state and plan authority captured when Definition selected a route. */
export class RequirementTestLifecycleAuthority {
  constructor({ runId, specId, leaf, attempt, planPublication, autoApprove = false } = {}) {
    this.runId = requiredText(runId, "Requirement test lifecycle runId");
    this.specId = requiredText(specId, "Requirement test lifecycle specId");
    if (!LIFECYCLE_LEAVES.has(leaf)) throw new Error("Requirement test lifecycle authority leaf is invalid");
    this.leaf = leaf;
    this.attempt = attempt instanceof RequirementTestSourceAttempt
      ? attempt
      : RequirementTestSourceAttempt.fromJSON(attempt);
    this.planPublication = RequirementTestPlanPublication.fromDescriptor(planPublication);
    if (typeof autoApprove !== "boolean") throw new Error("Requirement test lifecycle autoApprove policy must be boolean");
    this.autoApprove = autoApprove;
    Object.freeze(this);
  }

  static capture({ state, planDescriptor } = {}) {
    const leaf = state?.current?.at?.(-1) ?? state?.currentNodeId ?? null;
    return new RequirementTestLifecycleAuthority({
      runId: state?.runId,
      specId: state?.specId,
      leaf,
      attempt: state?.attempt == null ? null : {
        id: state.attempt.id,
        sequence: state.attempt.sequence,
      },
      planPublication: planDescriptor,
      autoApprove: state?.policy?.autoApprove === true,
    });
  }

  toJSON() {
    return {
      runId: this.runId,
      specId: this.specId,
      leaf: this.leaf,
      attempt: this.attempt.toJSON(),
      planPublication: this.planPublication.toJSON(),
      autoApprove: this.autoApprove,
    };
  }
}

/** Producer and predecessor evidence binding for one candidate bundle revision. */
export class RequirementTestBundleLineage {
  constructor({
    requirementId,
    specRevision: revision,
    bundleRevision,
    predecessorRevision,
    sourceAttempt,
    sourceFindingFingerprints,
  } = {}) {
    this.requirementId = requiredText(requirementId, "Requirement test bundle lineage requirementId");
    this.specRevision = specRevision(revision);
    this.bundleRevision = positiveInteger(bundleRevision, "Requirement test bundle lineage revision");
    this.predecessorRevision = predecessorRevision === null
      ? null
      : positiveInteger(predecessorRevision, "Requirement test bundle lineage predecessorRevision");
    this.sourceAttempt = sourceAttempt instanceof RequirementTestSourceAttempt
      ? sourceAttempt
      : RequirementTestSourceAttempt.fromJSON(sourceAttempt);
    if (!Array.isArray(sourceFindingFingerprints)
      || sourceFindingFingerprints.some((fingerprint) => typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint))
      || new Set(sourceFindingFingerprints).size !== sourceFindingFingerprints.length) {
      throw new Error("Requirement test bundle lineage sourceFindingFingerprints must be unique SHA-256 digests");
    }
    this.sourceFindingFingerprints = Object.freeze([...sourceFindingFingerprints]);
    if (this.bundleRevision === 1) {
      if (this.predecessorRevision !== null || this.sourceFindingFingerprints.length !== 0) {
        throw new Error("Initial Requirement test bundle lineage cannot carry repair evidence");
      }
    } else if (this.predecessorRevision !== this.bundleRevision - 1 || this.sourceFindingFingerprints.length === 0) {
      throw new Error("Repair Requirement test bundle lineage requires the preceding revision and source findings");
    }
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, [
      "requirementId", "specRevision", "bundleRevision", "predecessorRevision", "sourceAttempt",
      "sourceFindingFingerprints",
    ], "Requirement test bundle lineage");
    return new RequirementTestBundleLineage(value);
  }

  toJSON() {
    return {
      requirementId: this.requirementId,
      specRevision: this.specRevision.toJSON(),
      bundleRevision: this.bundleRevision,
      predecessorRevision: this.predecessorRevision,
      sourceAttempt: this.sourceAttempt.toJSON(),
      sourceFindingFingerprints: [...this.sourceFindingFingerprints],
    };
  }
}

/** One candidate test bundle, assigned to exactly one primary Requirement. */
export class RequirementTestBundleRevision {
  constructor({ requirementId, specRevision: revision, revision: bundleRevision, paths, lineage } = {}) {
    this.requirementId = requiredText(requirementId, "Requirement test bundle requirementId");
    this.specRevision = specRevision(revision);
    this.revision = positiveInteger(bundleRevision, "Requirement test bundle revision");
    if (!Array.isArray(paths) || paths.length === 0) throw new Error("Requirement test bundle paths must be non-empty");
    this.paths = Object.freeze(paths.map((entry, index) => (
      canonicalRelativePath(entry, `Requirement test bundle paths[${index}]`)
    )));
    if (new Set(this.paths).size !== this.paths.length) throw new Error("Requirement test bundle paths must be unique");
    this.lineage = lineage instanceof RequirementTestBundleLineage
      ? lineage
      : RequirementTestBundleLineage.fromJSON(lineage);
    if (this.requirementId !== this.lineage.requirementId
      || !sameSpecRevision(this.specRevision, this.lineage.specRevision)
      || this.revision !== this.lineage.bundleRevision) {
      throw new Error("Requirement test bundle revision and lineage identity do not match");
    }
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, ["requirementId", "specRevision", "revision", "paths", "lineage"], "Requirement test bundle revision");
    return new RequirementTestBundleRevision(value);
  }

  toJSON() {
    return {
      requirementId: this.requirementId,
      specRevision: this.specRevision.toJSON(),
      revision: this.revision,
      paths: [...this.paths],
      lineage: this.lineage.toJSON(),
    };
  }
}

/** Immutable lifecycle state for one Requirement-owned test work item. */
export class RequirementTestWorkItem {
  constructor({ requirementId, specRevision: revision, expectation, status = "pending", bundleRevision = null, budget = RequirementTestBudget.initial(), semanticFindings = [] } = {}) {
    this.requirementId = requiredText(requirementId, "Requirement test work item requirementId");
    this.specRevision = specRevision(revision);
    this.expectation = RequirementTestExpectation.from(expectation);
    if (!STATUSES.has(status)) throw new Error("Requirement test work item status is invalid");
    this.status = status;
    this.bundleRevision = bundleRevision === null
      ? null
      : bundleRevision instanceof RequirementTestBundleRevision ? bundleRevision : RequirementTestBundleRevision.fromJSON(bundleRevision);
    this.budget = budget instanceof RequirementTestBudget ? budget : RequirementTestBudget.fromJSON(budget);
    if (!Array.isArray(semanticFindings)) throw new Error("Requirement test semantic findings must be an array");
    this.semanticFindings = Object.freeze(semanticFindings.map((finding) => (
      finding instanceof RequirementTestSemanticFinding ? finding : RequirementTestSemanticFinding.fromJSON(finding)
    )));
    if (this.semanticFindings.some((finding) => finding.requirementId !== this.requirementId)
      || new Set(this.semanticFindings.map((finding) => JSON.stringify(finding.toJSON()))).size !== this.semanticFindings.length) {
      throw new Error("Requirement test semantic findings do not match this Requirement");
    }
    if (["pending", "in_progress"].includes(this.status) && this.bundleRevision !== null) {
      throw new Error("Requirement test pending work cannot carry a bundle revision");
    }
    if (["candidate_saved", "reviewed", "promoted"].includes(this.status) && this.bundleRevision === null) {
      throw new Error("Requirement test candidate state requires a bundle revision");
    }
    if (this.bundleRevision !== null && (this.requirementId !== this.bundleRevision.requirementId
      || !sameSpecRevision(this.specRevision, this.bundleRevision.specRevision))) {
      throw new Error("Requirement test work item and bundle revision identity do not match");
    }
    Object.freeze(this);
  }

  static pending({ requirementId, specRevision: revision, expectation }) {
    return new RequirementTestWorkItem({ requirementId, specRevision: revision, expectation });
  }

  static fromJSON(value) {
    exactKeys(value, ["requirementId", "specRevision", "expectation", "status", "bundleRevision", "budget", "semanticFindings"], "Requirement test work item");
    return new RequirementTestWorkItem(value);
  }

  /** Reconstruct facts selected by Definition-owned connector policy. */
  withState({ status = this.status, bundleRevision = this.bundleRevision, budget = this.budget, semanticFindings = this.semanticFindings } = {}) {
    return new RequirementTestWorkItem({
      requirementId: this.requirementId,
      specRevision: this.specRevision,
      expectation: this.expectation,
      status,
      bundleRevision,
      budget,
      semanticFindings,
    });
  }

  hasSemanticFinding(finding) {
    const candidate = finding instanceof RequirementTestSemanticFinding
      ? finding
      : RequirementTestSemanticFinding.fromJSON(finding);
    return this.semanticFindings.some((entry) => entry.equals(candidate));
  }

  toJSON() {
    return {
      requirementId: this.requirementId,
      specRevision: this.specRevision.toJSON(),
      expectation: this.expectation.toJSON(),
      status: this.status,
      bundleRevision: this.bundleRevision?.toJSON() ?? null,
      budget: this.budget.toJSON(),
      semanticFindings: this.semanticFindings.map((finding) => finding.toJSON()),
    };
  }
}

/** Ordered Requirement work derived only from one validated approved Spec revision. */
export class RequirementTestPlan {
  constructor({ specRevision: revision, workItems } = {}) {
    this.specRevision = specRevision(revision);
    if (!Array.isArray(workItems)) throw new Error("Requirement test plan workItems must be an array");
    this.workItems = Object.freeze(workItems.map((item) => (
      item instanceof RequirementTestWorkItem ? item : RequirementTestWorkItem.fromJSON(item)
    )));
    const ids = this.workItems.map((item) => item.requirementId);
    if (new Set(ids).size !== ids.length) throw new Error("Requirement test plan requirementIds must be unique");
    if (this.workItems.some((item) => !sameSpecRevision(this.specRevision, item.specRevision))) {
      throw new Error("Requirement test plan and work item Spec revisions do not match");
    }
    Object.freeze(this);
  }

  static fromApprovedSpec({ spec, specRevision: revision } = {}) {
    validateSpecJsonObject(spec);
    const identity = specRevision(revision);
    return new RequirementTestPlan({
      specRevision: identity,
      workItems: spec.requirements
        .filter((requirement) => requirement.testable !== false)
        .map((requirement) => RequirementTestWorkItem.pending({
          requirementId: requirement.id,
          specRevision: identity,
          expectation: requirement.preimplementation_test_expectation,
        })),
    });
  }

  static fromJSON(value) {
    exactKeys(value, ["specRevision", "workItems"], "Requirement test plan");
    return new RequirementTestPlan(value);
  }

  workItem(requirementId) {
    const id = requiredText(requirementId, "Requirement test plan lookup requirementId");
    return this.workItems.find((item) => item.requirementId === id) ?? null;
  }

  withWorkItem(workItem) {
    const next = workItem instanceof RequirementTestWorkItem
      ? workItem
      : RequirementTestWorkItem.fromJSON(workItem);
    const index = this.workItems.findIndex((item) => item.requirementId === next.requirementId);
    if (index < 0) throw new Error(`Requirement test plan does not contain ${next.requirementId}`);
    if (!sameSpecRevision(this.specRevision, next.specRevision)) {
      throw new Error("Requirement test plan replacement has a stale Spec revision");
    }
    return new RequirementTestPlan({
      specRevision: this.specRevision,
      workItems: this.workItems.map((item, itemIndex) => itemIndex === index ? next : item),
    });
  }

  activeWorkItem() {
    // Generation deliberately stages every Requirement before review begins.
    // A saved predecessor is therefore not an active generator while one
    // later Requirement is in progress. Once generation is exhausted, the
    // earliest staged candidate becomes the review frontier.
    const generating = this.workItems.filter((item) => item.status === "in_progress");
    if (generating.length > 1) throw new Error("Requirement test plan contains multiple generating work items");
    if (generating.length === 1) {
      if (this.workItems.some((item) => item.status === "reviewed")) {
        throw new Error("Requirement test plan cannot generate while a Requirement is under review");
      }
      return generating[0];
    }
    const staged = this.workItems.filter((item) => ["candidate_saved", "reviewed"].includes(item.status));
    if (staged.length === 0) return null;
    const reviewed = staged.filter((item) => item.status === "reviewed");
    if (reviewed.length > 1) throw new Error("Requirement test plan contains multiple reviewed work items");
    return reviewed[0] ?? staged[0];
  }

  nextPendingWorkItem() {
    return this.workItems.find((item) => item.status === "pending") ?? null;
  }

  get settled() {
    return this.workItems.every((item) => item.status === "promoted" || item.status === "deferred");
  }

  toJSON() {
    return {
      specRevision: this.specRevision.toJSON(),
      workItems: this.workItems.map((item) => item.toJSON()),
    };
  }
}
