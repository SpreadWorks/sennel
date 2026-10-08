import { TaskStepIdentity } from "./task-step-identity.js";
import { CANONICAL_NODE_STATUSES } from "./canonical-node-status.js";
import { TaskId } from "../../spec/lib/task-values.js";
import { TaskReviewStageFacts, TaskReviewStageMeaning } from "./task-review-stage-transition.js";
import { requiredText as requiredString, exactKeys as exactObjectKeys, normalizedRelativePath } from "./source-effect-fields.js";
import { WorkerArtifactHandoffError } from "./worker-artifact-handoff-error.js";
import { requiresWorkerSourceHandoff } from "./flow-artifact-authority.js";
import { validateAdditions } from "./overview-merge.js";
import { RepairFindingMutations, RepairFindingPathClaims } from "./repair-mutation-contract.js";
import { SourceTriageEffect } from "./source-triage-contract.js";
import { CanonicalSourceRequirementAuthority } from "./canonical-file-map.js";
import { GateRepairReport, SourceGateRepairLineage, SourceGateRepairObservationResult,
  ArtifactGateRepairLineage, ArtifactGateRepairObservationResult, GateRepairMutationLineageEntry } from "./gate-observation-convergence.js";
const MAX_PAYLOAD_FILES = 256;
const SHA256 = /^[a-f0-9]{64}$/;
function requiredDigest(value, field) {
  const digest = requiredString(value, field);
  if (!SHA256.test(digest)) throw new Error(`${field} must be a SHA-256 digest`);
  return digest;
}
const SOURCE_EFFECT_BASE_KEYS = Object.freeze([
  "version",
  "stepId",
  "completionStatus",
  "files",
  "issues",
  "overview",
  "triage",
  "repair",
  "noChangeReason",
]);

function sourceEffectKeys(stepId, { workerReport = false } = {}) {
  const keys = SOURCE_EFFECT_BASE_KEYS.filter((key) => !(workerReport && key === "files"));
  return stepId === "task-impl" ? [...keys, "gateRepair"] : keys;
}

function assertSourceEffectDocumentKeys(value, stepId, options = {}) {
  const keys = sourceEffectKeys(stepId, options);
  const expected = stepId === "task-impl" && !Object.hasOwn(value, "gateRepair")
    ? keys.filter((key) => key !== "gateRepair")
    : keys;
  exactObjectKeys(value, expected, "source worker effect");
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function assertUniqueSourceRequirementClaims(files, label) {
  const duplicateRequirementIds = duplicateValues(files.map((entry) => entry.requirementId));
  if (duplicateRequirementIds.length > 0) {
    throw new WorkerArtifactHandoffError(
      "invalid",
      "FLOW_SOURCE_HANDOFF_EFFECT_REQUIREMENT_CLAIM_DUPLICATE",
      `${label} must contain at most one file claim for each requirement`,
      { retryable: false, data: { duplicateRequirementIds: duplicateRequirementIds.slice(0, 20) } },
    );
  }
}

/**
 * One parent-derived, sealed source effect for a canonical Requirement.
 */
export class SourceFileEffect {
  constructor({ requirementId, mutationIds } = {}) {
    this.requirementId = requiredString(requirementId, "source worker file requirementId");
    if (!Array.isArray(mutationIds) || mutationIds.length === 0 || mutationIds.length > MAX_PAYLOAD_FILES) {
      throw new Error("source worker file mutationIds must be a bounded non-empty array");
    }
    this.mutationIds = Object.freeze(mutationIds.map((candidate) => requiredDigest(candidate, "source worker file mutationId")));
    const duplicateMutationIds = duplicateValues(this.mutationIds);
    if (duplicateMutationIds.length > 0) {
      throw new WorkerArtifactHandoffError(
        "invalid",
        "FLOW_SOURCE_HANDOFF_EFFECT_PATH_CLAIM_DUPLICATE",
        "source worker file mutationIds must not duplicate within one requirement claim",
        { retryable: false, data: { duplicateMutationIds: duplicateMutationIds.slice(0, 20) } },
      );
    }
    Object.freeze(this);
  }
  resolvePaths(manifest) {
    return this.mutationIds.map((mutationId) => manifest.pathForMutationId(mutationId));
  }
  toJSON() { return { requirementId: this.requirementId, mutationIds: [...this.mutationIds] }; }
}

export class SourceIssueEffect {
  constructor({ classification, reason, remainingRisk } = {}) {
    if (classification !== "quality") throw new Error("source worker issue classification must be quality");
    this.classification = "quality";
    this.reason = requiredString(reason, "source worker issue reason");
    if (this.reason.length < 20) throw new Error("source worker issue reason must be at least 20 characters");
    this.remainingRisk = requiredString(remainingRisk, "source worker issue remainingRisk");
    if (this.remainingRisk.length < 20) throw new Error("source worker issue remainingRisk must be at least 20 characters");
    Object.freeze(this);
  }
  toJSON() { return { classification: this.classification, reason: this.reason, remainingRisk: this.remainingRisk }; }
}

export class SourceOverviewEffect {
  constructor(additions) {
    const errors = validateAdditions(additions);
    if (errors.length > 0) throw new Error(`invalid source worker overview additions: ${errors.join("; ")}`);
    this.additions = Object.freeze({
      modules: Object.freeze([...additions.modules]),
      data_flow: Object.freeze([...additions.data_flow]),
      decisions: Object.freeze([...additions.decisions]),
    });
    Object.freeze(this);
  }
  toJSON() { return { ...this.additions, modules: [...this.additions.modules], data_flow: [...this.additions.data_flow], decisions: [...this.additions.decisions] }; }
}

export class SourceRepairRecurrenceResolution {
  constructor({ findingKey, fingerprint, priorRepairInsufficiency, repairStrategy } = {}) {
    this.findingKey = requiredString(findingKey, "source repair recurrence findingKey");
    this.fingerprint = requiredDigest(fingerprint, "source repair recurrence fingerprint");
    this.priorRepairInsufficiency = requiredString(
      priorRepairInsufficiency,
      "source repair recurrence priorRepairInsufficiency",
    );
    this.repairStrategy = requiredString(
      repairStrategy,
      "source repair recurrence repairStrategy",
    );
    Object.freeze(this);
  }

  toJSON() {
    return {
      findingKey: this.findingKey,
      fingerprint: this.fingerprint,
      priorRepairInsufficiency: this.priorRepairInsufficiency,
      repairStrategy: this.repairStrategy,
    };
  }
}

function assertRepairRecurrenceResolutions(appliedFindingKeys, resolutions, recurrence) {
  const recurring = Array.isArray(recurrence?.entries) ? recurrence.entries : [];
  const recurrenceByFingerprint = new Map(recurring.map((entry) => (
    [entry.fingerprint, entry.findingKey]
  )));
  const recurrenceFindingKeys = [...recurrenceByFingerprint.values()];
  if (
    recurrenceByFingerprint.size !== recurring.length
    || recurrenceFindingKeys.some((findingKey) => !appliedFindingKeys.includes(findingKey))
    || recurrenceByFingerprint.size !== resolutions.length
    || resolutions.some((entry) => (
      recurrenceByFingerprint.get(entry.fingerprint) !== entry.findingKey
      || !appliedFindingKeys.includes(entry.findingKey)
    ))
  ) {
    throw new Error("implementation repair recurrence resolutions must exactly match canonical recurrence context");
  }
}

function rethrowRepairContractViolation(cause) {
  if (typeof cause?.code === "string" && cause.code.startsWith("FLOW_REPAIR_")) {
    throw new WorkerArtifactHandoffError(
      "invalid",
      cause.code,
      cause.message,
      { cause, retryable: false, data: cause.data ?? {} },
    );
  }
  throw cause;
}

export class SourceRepairEffect {
  constructor(value = {}) {
    const allowedKeys = new Set([
      "version",
      "appliedFindingKeys",
      "findingMutations",
      "summary",
      "recurrenceResolutions",
    ]);
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !allowedKeys.has(key))) {
      throw new Error("source repair effect has an invalid schema");
    }
    const { version, appliedFindingKeys, findingMutations, summary, recurrenceResolutions = [] } = value;
    if (version !== 1) throw new Error("source repair effect version must be 1");
    this.findingMutations = new RepairFindingMutations(findingMutations);
    this.appliedFindingKeys = this.findingMutations.appliedFindingKeys;
    if (!Array.isArray(appliedFindingKeys)
      || appliedFindingKeys.length !== this.appliedFindingKeys.length
      || appliedFindingKeys.some((findingKey) => !this.appliedFindingKeys.includes(findingKey))) {
      throw new Error("source repair appliedFindingKeys must match findingMutations");
    }
    this.summary = requiredString(summary, "source repair summary");
    if (this.summary.length < 10) throw new Error("source repair summary must be at least 10 characters");
    if (!Array.isArray(recurrenceResolutions) || recurrenceResolutions.length > MAX_PAYLOAD_FILES) {
      throw new Error("source repair recurrence resolutions are invalid");
    }
    this.recurrenceResolutions = Object.freeze(recurrenceResolutions.map((entry) => (
      entry instanceof SourceRepairRecurrenceResolution
        ? entry
        : new SourceRepairRecurrenceResolution(entry)
    )));
    if (
      new Set(this.recurrenceResolutions.map((entry) => entry.fingerprint)).size
      !== this.recurrenceResolutions.length
    ) {
      throw new Error("source repair recurrence resolutions must not duplicate fingerprints");
    }
    Object.freeze(this);
  }
  toJSON() {
    return {
      version: 1, appliedFindingKeys: [...this.appliedFindingKeys], summary: this.summary,
      findingMutations: this.findingMutations.toJSON(),
      ...(this.recurrenceResolutions.length === 0 ? {} : {
        recurrenceResolutions: this.recurrenceResolutions.map((entry) => entry.toJSON()),
      }),
    };
  }

  assertManifest(manifest) {
    try { this.findingMutations.assertManifest(manifest); }
    catch (cause) { rethrowRepairContractViolation(cause); }
    return this;
  }

  assertAppliedFindingKeys(findingKeys) {
    try { this.findingMutations.assertFindingKeys(findingKeys); }
    catch (cause) { rethrowRepairContractViolation(cause); }
    return this;
  }

  assertRecurrenceResolutions(recurrence) {
    assertRepairRecurrenceResolutions(this.appliedFindingKeys, this.recurrenceResolutions, recurrence);
    return this;
  }

}

/** Worker repair report. Finding paths acquire mutation identity only in the parent. */
export class SourceRepairReport {
  constructor(value = {}) {
    const allowedKeys = new Set(["version", "findings", "summary", "recurrenceResolutions"]);
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).some((key) => !allowedKeys.has(key))) {
      throw new Error("source repair report has an invalid schema");
    }
    const { version, findings, summary, recurrenceResolutions } = value;
    if (version !== 1) throw new Error("source repair report version must be 1");
    this.findings = new RepairFindingPathClaims(findings);
    this.summary = requiredString(summary, "source repair summary");
    if (this.summary.length < 10) throw new Error("source repair summary must be at least 10 characters");
    if (!Array.isArray(recurrenceResolutions) || recurrenceResolutions.length > MAX_PAYLOAD_FILES) {
      throw new Error("source repair recurrence resolutions are invalid");
    }
    this.recurrenceResolutions = Object.freeze(recurrenceResolutions.map((entry) => (
      entry instanceof SourceRepairRecurrenceResolution ? entry : new SourceRepairRecurrenceResolution(entry)
    )));
    if (new Set(this.recurrenceResolutions.map((entry) => entry.fingerprint)).size !== this.recurrenceResolutions.length) {
      throw new Error("source repair recurrence resolutions must not duplicate fingerprints");
    }
    Object.freeze(this);
  }

  bind(manifest) {
    let findingMutations;
    try { findingMutations = this.findings.bind(manifest); }
    catch (cause) { rethrowRepairContractViolation(cause); }
    return new SourceRepairEffect({
      version: 1,
      appliedFindingKeys: findingMutations.appliedFindingKeys,
      findingMutations: findingMutations.toJSON(),
      summary: this.summary,
      ...(this.recurrenceResolutions.length === 0 ? {} : {
        recurrenceResolutions: this.recurrenceResolutions.map((entry) => entry.toJSON()),
      }),
    });
  }

  assertRecurrenceResolutions(recurrence) {
    assertRepairRecurrenceResolutions(this.findings.appliedFindingKeys, this.recurrenceResolutions, recurrence);
    return this;
  }

  assertAppliedFindingKeys(findingKeys) {
    try { this.findings.assertFindingKeys(findingKeys); }
    catch (cause) { rethrowRepairContractViolation(cause); }
    return this;
  }

  toJSON() {
    return {
      version: 1,
      findings: this.findings.toJSON(),
      summary: this.summary,
      recurrenceResolutions: this.recurrenceResolutions.map((entry) => entry.toJSON()),
    };
  }
}

class GateRepairWorkerObservationResult {
  constructor({ fingerprint, strategy, summary, priorRepairInsufficiency = null, paths = null } = {}) {
    this.fingerprint = requiredDigest(fingerprint, "Gate repair worker observation fingerprint");
    this.strategy = requiredString(strategy, "Gate repair worker observation strategy");
    this.summary = requiredString(summary, "Gate repair worker observation summary");
    this.priorRepairInsufficiency = priorRepairInsufficiency === null
      ? null
      : requiredString(priorRepairInsufficiency, "Gate repair worker priorRepairInsufficiency");
    if (paths !== null && (!Array.isArray(paths) || paths.length > MAX_PAYLOAD_FILES)) {
      throw new Error("Gate repair worker observation paths must be a bounded array");
    }
    this.paths = paths === null ? null : Object.freeze(paths.map((entry) => (
      normalizedRelativePath(entry, "Gate repair worker observation path")
    )));
    if (this.paths !== null && duplicateValues(this.paths).length > 0) {
      throw new WorkerArtifactHandoffError(
        "invalid",
        "FLOW_GATE_REPAIR_OBSERVATION_MUTATION_CLAIM_DUPLICATE",
        "Gate repair observation paths must not duplicate within one observation",
        { retryable: false, data: { fingerprint: this.fingerprint } },
      );
    }
    Object.freeze(this);
  }
  toJSON() {
    return {
      fingerprint: this.fingerprint,
      strategy: this.strategy,
      summary: this.summary,
      priorRepairInsufficiency: this.priorRepairInsufficiency,
      ...(this.paths === null ? {} : { paths: [...this.paths] }),
    };
  }
}

/** Worker claim only; the parent adds observed artifact/source lineage. */
export class GateRepairWorkerReport {
  constructor({ version, summary, results } = {}) {
    if (version !== 1) throw new Error("Gate repair worker report version must be 1");
    this.version = 1;
    this.summary = requiredString(summary, "Gate repair worker report summary");
    if (!Array.isArray(results) || results.length === 0 || results.length > MAX_PAYLOAD_FILES) {
      throw new Error("Gate repair worker report requires bounded observation results");
    }
    this.results = Object.freeze(results.map((entry) => {
      const hasPaths = Object.hasOwn(entry ?? {}, "paths");
      exactObjectKeys(entry, ["fingerprint", "strategy", "summary", "priorRepairInsufficiency", ...(hasPaths ? ["paths"] : [])], "Gate repair worker observation result");
      return new GateRepairWorkerObservationResult(entry);
    }));
    if (new Set(this.results.map((entry) => entry.fingerprint)).size !== this.results.length) {
      throw new Error("Gate repair worker report must not duplicate observation fingerprints");
    }
    Object.freeze(this);
  }

  static fromDocument(value) {
    exactObjectKeys(value, ["version", "summary", "results"], "Gate repair worker report");
    return new GateRepairWorkerReport(value);
  }

  bindArtifact({ repair, beforeEvidenceDigest, outputEvidenceDigest, deltaIds }) {
    if (this.results.some((entry) => entry.paths !== null)) {
      throw new Error("artifact Gate repair report must not claim source mutation paths");
    }
    const lineage = new ArtifactGateRepairLineage({ deltaIds });
    return this.#bind({
      repair, beforeEvidenceDigest, outputEvidenceDigest, lineage,
      Result: ArtifactGateRepairObservationResult,
      changes: { deltaIds: lineage.changeIds() },
    });
  }

  bindSource({ repair, beforeEvidenceDigest, outputEvidenceDigest, manifest }) {
    if (!(Array.isArray(manifest?.mutations))) {
      throw new Error("Gate repair source report requires a SourceMutationManifest");
    }
    if (this.results.some((entry) => entry.paths === null)) {
      throw new WorkerArtifactHandoffError(
        "invalid",
        "FLOW_REPAIR_FINDING_MUTATION_COVERAGE_INVALID",
        "source Gate repair report requires a path claim for every observation",
        { retryable: false, data: {} },
      );
    }
    const duplicatePaths = duplicateValues(this.results.flatMap((entry) => entry.paths));
    if (duplicatePaths.length > 0) {
      throw new WorkerArtifactHandoffError(
        "invalid",
        "FLOW_GATE_REPAIR_OBSERVATION_MUTATION_CLAIM_DUPLICATE",
        "Gate repair observations must not claim the same source mutation path",
        { retryable: false, data: { duplicatePaths: duplicatePaths.slice(0, 20) } },
      );
    }
    const mutationIdsByFingerprint = new Map();
    if (manifest.mutations.length === 0) {
      if (this.results.some((entry) => entry.paths.length !== 0)) {
        throw new WorkerArtifactHandoffError(
          "invalid",
          "FLOW_REPAIR_FINDING_MUTATION_COVERAGE_INVALID",
          "no-progress Gate repair may not claim a source mutation",
          { retryable: false, data: { unknown: this.results.flatMap((entry) => entry.paths) } },
        );
      }
      for (const entry of this.results) mutationIdsByFingerprint.set(entry.fingerprint, []);
    } else {
      const unboundFingerprints = this.results
        .filter((entry) => entry.paths.length === 0)
        .map((entry) => entry.fingerprint);
      if (unboundFingerprints.length > 0) {
        const claimed = new Set(this.results.flatMap((entry) => entry.paths));
        throw new WorkerArtifactHandoffError(
          "invalid",
          "FLOW_REPAIR_FINDING_MUTATION_COVERAGE_INVALID",
          "changed source Gate repair requires a mutation claim for every observation",
          {
            retryable: false,
            data: {
              missing: manifest.paths().filter((relativePath) => !claimed.has(relativePath)).slice(0, 20),
              unboundFingerprints: unboundFingerprints.slice(0, 20),
            },
          },
        );
      }
      let claims;
      try {
        claims = new RepairFindingPathClaims(this.results.map((entry) => ({
          findingKey: entry.fingerprint,
          paths: entry.paths,
        }))).bind(manifest);
      } catch (cause) {
        rethrowRepairContractViolation(cause);
      }
      for (const entry of claims.toJSON()) {
        mutationIdsByFingerprint.set(entry.findingKey, entry.mutationIds);
      }
    }
    const mutations = manifest.mutations.map((mutation) => new GateRepairMutationLineageEntry({
      mutationId: mutation.mutationId,
      path: mutation.path,
    }));
    const lineage = new SourceGateRepairLineage({ currentCheckout: true, mutations });
    return this.#bind({
      repair, beforeEvidenceDigest, outputEvidenceDigest, lineage,
      Result: SourceGateRepairObservationResult,
      changesFor: (entry) => ({ mutationIds: mutationIdsByFingerprint.get(entry.fingerprint) }),
    });
  }

  #bind({ repair, beforeEvidenceDigest, outputEvidenceDigest, lineage, Result, changes = null, changesFor = null }) {
    const requests = repair.requests;
    const expected = requests.map((entry) => entry.fingerprint.toString());
    const reported = this.results.map((entry) => entry.fingerprint);
    if (expected.length !== reported.length || reported.some((fingerprint) => !expected.includes(fingerprint))) {
      throw new Error("Gate repair worker report must resolve every blocking observation exactly once");
    }
    return new GateRepairReport({
      beforeEvidenceDigest,
      outputEvidenceDigest,
      summary: this.summary,
      requests,
      lineage,
      results: this.results.map((entry) => new Result({
        ...entry.toJSON(),
        ...(changesFor === null ? changes : changesFor(entry)),
      })),
    });
  }

  toJSON() {
    return { version: this.version, summary: this.summary, results: this.results.map((entry) => entry.toJSON()) };
  }
}

/** Durable explanation for a successful source Attempt with no mutation. */
export class SourceNoChangeReason {
  constructor(value) {
    this.text = requiredString(value, "source worker noChangeReason");
    Object.freeze(this);
  }
  toJSON() { return this.text; }
}

/** Canonical no-change/unrepairable outcome for every selected Task finding. */
export class TaskRepairNoChangeEffect {
  constructor({ classification, findingKeys, reason } = {}) {
    if (!new Set(["no-change", "unrepairable"]).has(classification)) {
      throw new Error("Task repair no-change classification is invalid");
    }
    this.classification = classification;
    if (!Array.isArray(findingKeys) || findingKeys.length === 0 || findingKeys.length > MAX_PAYLOAD_FILES) {
      throw new Error("Task repair no-change requires bounded findingKeys");
    }
    this.findingKeys = Object.freeze(findingKeys.map((key) => requiredString(key, "Task repair no-change findingKey")));
    if (new Set(this.findingKeys).size !== this.findingKeys.length) throw new Error("Task repair no-change findingKeys must be unique");
    this.reason = requiredString(reason, "Task repair no-change reason");
    Object.freeze(this);
  }
  assertManifest(manifest) {
    if (manifest.paths().length !== 0) {
      throw new Error("Task repair no-change requires zero observed source mutations");
    }
    return this;
  }
  toJSON() { return { classification: this.classification, findingKeys: [...this.findingKeys], reason: this.reason }; }
}

function assertSourceEffectShape({ stepId, completionStatus, files, issues, overview, triage, repair, gateRepair, noChangeReason }) {
  if (!new Set(["done", "skipped"]).has(completionStatus)) throw new Error("source worker completionStatus is invalid");
  if (completionStatus === "skipped" && stepId !== "implement") {
    throw new Error("only implement may report a skipped source completion");
  }
  if (stepId === "task-impl" && overview === null) throw new Error("task-impl source effect requires overview additions");
  if (stepId !== "task-impl" && overview !== null) throw new Error("only task-impl may submit overview additions");
  if ((stepId === "impl-triage") !== (triage !== null)) throw new Error("source triage effect is required only for impl-triage");
  const repairStep = stepId === "impl-repair" || stepId === "task-repair";
  if (repair !== null && !repairStep) throw new Error("source repair effect is allowed only for repair steps");
  if (stepId === "impl-repair" && repair === null) throw new Error("source repair effect is required for impl-repair");
  if (stepId !== "task-impl" && gateRepair !== null) {
    throw new Error("only task-impl may submit a Gate repair report");
  }
  if (stepId === "task-repair") {
    if ((repair === null) === (noChangeReason === null) || (noChangeReason !== null && !(noChangeReason instanceof TaskRepairNoChangeEffect))) {
      throw new Error("task-repair requires exactly one changed repair or typed no-change outcome");
    }
  } else if (stepId !== "task-impl" && noChangeReason !== null) {
    throw new Error("only task-impl and task-repair may submit a source no-change reason");
  }
  if (stepId === "impl-triage" && (files.length > 0 || issues.length > 0 || overview !== null || repair !== null)) {
    throw new Error("impl-triage source effect may contain only typed triage dispositions");
  }
  if (new Set(["impl-repair", "task-repair"]).has(stepId) && (overview !== null || triage !== null)) {
    throw new Error("impl-repair source effect may contain source files, issues, and one typed repair only");
  }
}

export class SourceWorkerEffect {
  constructor({ version, stepId, completionStatus, files = [], issues = [], overview = null, triage = null, repair = null, gateRepair = null, noChangeReason = null } = {}) {
    if (version !== 1) throw new Error("source worker effect version must be 1");
    this.version = 1;
    this.stepId = requiredString(stepId, "source worker effect stepId");
    if (!requiresWorkerSourceHandoff(this.stepId)) throw new Error(`source worker effect step is not source-owned: ${this.stepId}`);
    this.completionStatus = requiredString(completionStatus, "source worker completionStatus");
    if (!Array.isArray(files) || files.length > MAX_PAYLOAD_FILES || !Array.isArray(issues) || issues.length > MAX_PAYLOAD_FILES) {
      throw new Error("source worker effect collections must be bounded arrays");
    }
    this.files = Object.freeze(files.map((entry) => {
      exactObjectKeys(entry, ["requirementId", "mutationIds"], "source worker file effect");
      return new SourceFileEffect(entry);
    }));
    assertUniqueSourceRequirementClaims(this.files, "source worker file effects");
    this.issues = Object.freeze(issues.map((entry) => {
      exactObjectKeys(entry, ["classification", "reason", "remainingRisk"], "source worker issue effect");
      return new SourceIssueEffect(entry);
    }));
    this.overview = overview === null ? null : new SourceOverviewEffect(overview);
    this.triage = triage === null ? null : new SourceTriageEffect(triage);
    this.repair = repair === null ? null : new SourceRepairEffect(repair);
    this.gateRepair = gateRepair === null ? null : GateRepairReport.fromJSON(gateRepair);
    this.noChangeReason = noChangeReason === null ? null : this.stepId === "task-repair"
      ? new TaskRepairNoChangeEffect(noChangeReason)
      : new SourceNoChangeReason(noChangeReason);
    assertSourceEffectShape(this);
    Object.freeze(this);
  }

  static fromDocument(value, expectedStepId) {
    assertSourceEffectDocumentKeys(value, expectedStepId);
    const effect = new SourceWorkerEffect(value);
    if (effect.stepId !== expectedStepId) throw new Error("source worker effect step does not match the handoff");
    return effect;
  }

  toJSON() {
    return {
      version: this.version,
      stepId: this.stepId,
      completionStatus: this.completionStatus,
      files: this.files.map((entry) => entry.toJSON()),
      issues: this.issues.map((entry) => entry.toJSON()),
      overview: this.overview?.toJSON() ?? null,
      triage: this.triage?.toJSON() ?? null,
      repair: this.repair?.toJSON() ?? null,
      ...(this.stepId === "task-impl" ? { gateRepair: this.gateRepair?.toJSON() ?? null } : {}),
      noChangeReason: this.noChangeReason?.toJSON() ?? null,
    };
  }
}

/** Worker-facing report bound to observed source mutations only by the parent. */
export class SourceWorkerEffectReport {
  constructor({ version, stepId, completionStatus, issues = [], overview = null, triage = null, repair = null, gateRepair = null, noChangeReason = null } = {}) {
    if (version !== 1) throw new Error("source worker effect report version must be 1");
    this.version = 1;
    this.stepId = requiredString(stepId, "source worker effect report stepId");
    this.completionStatus = requiredString(completionStatus, "source worker effect report completionStatus");
    if (!Array.isArray(issues) || issues.length > MAX_PAYLOAD_FILES) {
      throw new Error("source worker effect report issues must be a bounded array");
    }
    this.issues = Object.freeze(issues.map((entry) => {
      exactObjectKeys(entry, ["classification", "reason", "remainingRisk"], "source worker issue claim");
      return new SourceIssueEffect(entry);
    }));
    this.overview = overview === null ? null : new SourceOverviewEffect(overview);
    this.triage = triage === null ? null : new SourceTriageEffect(triage);
    this.repair = repair === null ? null : new SourceRepairReport(repair);
    this.gateRepair = gateRepair === null ? null : GateRepairWorkerReport.fromDocument(gateRepair);
    this.noChangeReason = noChangeReason === null ? null : this.stepId === "task-repair"
      ? new TaskRepairNoChangeEffect(noChangeReason)
      : new SourceNoChangeReason(noChangeReason);
    assertSourceEffectShape({ ...this, files: [] });
    Object.freeze(this);
  }
  static fromDocument(value, expectedStepId) {
    assertSourceEffectDocumentKeys(value, expectedStepId, { workerReport: true });
    const report = new SourceWorkerEffectReport(value);
    if (report.stepId !== expectedStepId) throw new Error("source worker effect report step does not match the handoff");
    return report;
  }
  bind(manifest, requirementAuthority, gateRepairBinding = null) {
    if (!(requirementAuthority instanceof CanonicalSourceRequirementAuthority)) {
      throw new Error("source worker effect report requires canonical Requirement authority");
    }
    const files = requirementAuthority.bindMutationIds(
      manifest.mutations.map((mutation) => mutation.mutationId),
    );
    if ((this.gateRepair !== null) !== (gateRepairBinding !== null)) {
      throw new Error("source Gate repair report is required exactly for a selected plan-Gate repair");
    }
    const gateRepair = this.gateRepair === null ? null : this.gateRepair.bindSource({
      repair: gateRepairBinding.repair,
      beforeEvidenceDigest: gateRepairBinding.beforeEvidenceDigest,
      outputEvidenceDigest: gateRepairBinding.outputEvidenceDigest,
      manifest,
    });
    this.noChangeReason?.assertManifest?.(manifest);
    return new SourceWorkerEffect({
      version: this.version, stepId: this.stepId, completionStatus: this.completionStatus,
      files: files.map((entry) => entry.toJSON()),
      issues: this.issues.map((entry) => entry.toJSON()),
      overview: this.overview?.toJSON() ?? null, triage: this.triage?.toJSON() ?? null,
      repair: this.repair?.bind(manifest).toJSON() ?? null,
      ...(this.stepId === "task-impl" ? { gateRepair: gateRepair?.toJSON() ?? null } : {}),
      noChangeReason: this.noChangeReason?.toJSON() ?? null,
    });
  }
  toJSON() {
    return {
      version: this.version, stepId: this.stepId, completionStatus: this.completionStatus,
      issues: this.issues.map((entry) => entry.toJSON()),
      overview: this.overview?.toJSON() ?? null, triage: this.triage?.toJSON() ?? null,
      repair: this.repair?.toJSON() ?? null,
      ...(this.stepId === "task-impl" ? { gateRepair: this.gateRepair?.toJSON() ?? null } : {}),
      noChangeReason: this.noChangeReason?.toJSON() ?? null,
    };
  }
}


/** One canonical Task identity and observed lifecycle status, in admission order. */
export class ImplementationTaskFrontierEntry {
  constructor({ taskId, status }) {
    this.taskId = taskId instanceof TaskId ? taskId : new TaskId(taskId);
    if (!CANONICAL_NODE_STATUSES.includes(status)) {
      throw new TypeError("implementation Task frontier status is invalid");
    }
    this.status = status;
    Object.freeze(this);
  }
  toJSON() { return { taskId: this.taskId.toString(), status: this.status }; }
}

export class ImplementationTaskFrontier {
  constructor(entries = []) {
    if (!Array.isArray(entries)) throw new TypeError("implementation Task frontier requires entries");
    this.entries = Object.freeze(entries.map((entry) => entry instanceof ImplementationTaskFrontierEntry
      ? entry : new ImplementationTaskFrontierEntry(entry)));
    if (new Set(this.entries.map((entry) => entry.taskId.toString())).size !== this.entries.length) {
      throw new TypeError("implementation Task frontier identities must be unique");
    }
    Object.freeze(this);
  }
  static fromJSON(value) { return value instanceof ImplementationTaskFrontier ? value : new ImplementationTaskFrontier(value); }
  toJSON() { return this.entries.map((entry) => entry.toJSON()); }
}

/** One semantic source meaning, computed once from explicit acquired evidence. */
export class SourceStepMeaning {
  constructor(evidence) {
    if (!(evidence instanceof ImplementationSourceEvidence)) throw new TypeError("Source meaning requires its nominal evidence");
    const changed = evidence.mutationCount > 0;
    const noChange = evidence.noChangeReason !== null;
    let resultKind;
    let taskStageMeaning = null;
    switch (evidence.stepId) {
      case "implement":
        if (evidence.completionStatus === "skipped" && changed) throw new TypeError("Existing implementation completion cannot adopt source mutations");
        resultKind = evidence.completionStatus === "skipped" ? "implement-existing-completion"
          : evidence.qualityIssueCount > 0 ? "implement-quality-issue" : "implement-applied";
        break;
      case "task-impl":
        if (changed === noChange) throw new TypeError("Task implementation no-change evidence contradicts its mutations");
        resultKind = evidence.qualityIssueCount > 0 ? "task-impl-quality-issue"
          : noChange ? "task-impl-no-change" : "task-impl-applied";
        break;
      case "impl-triage":
        if (changed || evidence.qualityIssueCount > 0 || noChange) throw new TypeError("Implementation triage requires readonly disposition evidence");
        resultKind = evidence.appliedFindingKeys.length > 0 ? "impl-triage-repair-required" : "impl-triage-gate-required";
        break;
      case "impl-repair":
        if (!changed || evidence.appliedFindingKeys.length === 0 || noChange) throw new TypeError("Implementation repair requires its applied mutation evidence");
        resultKind = evidence.qualityIssueCount > 0 ? "impl-repair-quality-issue" : "impl-repair-applied";
        break;
      case "task-repair":
        if (changed === noChange || evidence.taskStageFacts.repairChanged !== changed
          || changed && evidence.appliedFindingKeys.length === 0) throw new TypeError("Task repair outcome contradicts its mutation evidence");
        taskStageMeaning = new TaskReviewStageMeaning(evidence.taskStageFacts);
        resultKind = taskStageMeaning.resultKind;
        break;
      default: throw new TypeError("Source evidence has no declared semantic meaning");
    }
    this.resultKind = resultKind;
    this.taskStageMeaning = taskStageMeaning;
    Object.freeze(this);
  }
  assertResultKind(kind) {
    if (kind !== this.resultKind) throw new TypeError("Source Result kind contradicts its canonical semantic evidence");
    return this;
  }
}

/** Immutable semantic evidence for one adopted, parent-validated source handoff. */
export class ImplementationSourceEvidence {
  #meaning;
  constructor({ stepId, runId, specId, nodeId, attemptId, attemptSequence,
    taskId = null, taskRound = null, reviewResultCount = null, handoffDigest,
    mutationManifestDigest, mutationCount, completionStatus, qualityIssueCount,
    noChangeReason = null, appliedFindingKeys = [], taskFrontier = null, taskStageFacts = null } = {}) {
    for (const [field, value] of Object.entries({ stepId, runId, specId, nodeId, attemptId })) {
      this[field] = requiredString(value, `source evidence ${field}`);
    }
    if (!requiresWorkerSourceHandoff(this.stepId)) throw new TypeError("source evidence requires a source Step");
    if (!Number.isSafeInteger(attemptSequence) || attemptSequence < 1) throw new TypeError("source evidence requires an Attempt sequence");
    this.attemptSequence = attemptSequence;
    const taskSource = this.stepId.startsWith("task-");
    if (taskSource !== (taskId !== null) || taskSource !== (taskRound !== null)
      || taskSource && (![1, 2].includes(taskRound) || !new TaskStepIdentity({ taskId, role: stepId.slice(5) }).matchesNode(nodeId))
      || !taskSource && nodeId !== stepId) throw new TypeError("source evidence Task identity is invalid");
    this.taskId = taskId === null ? null : requiredString(taskId, "source evidence Task");
    this.taskRound = taskRound;
    if ((stepId === "task-repair") !== (reviewResultCount !== null)
      || reviewResultCount !== null && (!Number.isSafeInteger(reviewResultCount) || reviewResultCount < 1 || reviewResultCount > 4)) {
      throw new TypeError("source evidence Review ordinal is invalid");
    }
    this.reviewResultCount = reviewResultCount;
    if ((stepId === "implement") !== (taskFrontier !== null)) throw new TypeError("implement evidence requires its Task frontier");
    this.taskFrontier = taskFrontier === null ? null : ImplementationTaskFrontier.fromJSON(taskFrontier);
    if ((stepId === "task-repair") !== (taskStageFacts !== null)) throw new TypeError("Task repair evidence requires its stage facts");
    this.taskStageFacts = taskStageFacts === null ? null : taskStageFacts instanceof TaskReviewStageFacts
      ? taskStageFacts : new TaskReviewStageFacts(taskStageFacts);
    if (this.taskStageFacts !== null && (this.taskStageFacts.binding.runId !== runId
      || this.taskStageFacts.binding.specId !== specId || this.taskStageFacts.binding.stage !== "repair"
      || this.taskStageFacts.binding.taskId !== taskId
      || this.taskStageFacts.taskRound !== taskRound || this.taskStageFacts.reviewResultCount !== reviewResultCount
      || this.taskStageFacts.binding.attemptId !== attemptId || this.taskStageFacts.binding.attemptSequence !== attemptSequence)) {
      throw new TypeError("Task repair evidence stage identity is invalid");
    }
    this.handoffDigest = requiredDigest(handoffDigest, "source evidence handoff digest");
    this.mutationManifestDigest = requiredDigest(mutationManifestDigest, "source evidence manifest digest");
    for (const [field, value] of Object.entries({ mutationCount, qualityIssueCount })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`source evidence ${field} is invalid`);
      this[field] = value;
    }
    if (!["done", "skipped"].includes(completionStatus) || completionStatus === "skipped" && stepId !== "implement") {
      throw new TypeError("source evidence completion status is invalid");
    }
    this.completionStatus = completionStatus;
    this.noChangeReason = noChangeReason === null ? null : requiredString(noChangeReason, "source evidence no-change reason");
    if (!Array.isArray(appliedFindingKeys) || new Set(appliedFindingKeys).size !== appliedFindingKeys.length) {
      throw new TypeError("source evidence finding keys must be unique");
    }
    this.appliedFindingKeys = Object.freeze(appliedFindingKeys.map((key) => requiredString(key, "source evidence finding key")));
    this.#meaning = new SourceStepMeaning(this);
    Object.freeze(this);
  }
  get resultKind() { return this.#meaning.resultKind; }
  get taskStageMeaning() { return this.#meaning.taskStageMeaning; }
  assertResultKind(kind) { this.#meaning.assertResultKind(kind); return this; }
  assertTaskStageResultKind(kind) {
    if (this.taskStageMeaning === null) throw new TypeError("Source evidence has no Task repair stage meaning");
    this.taskStageMeaning.assertResultKind(kind);
    return this;
  }
  static fromJSON(value) { return value instanceof ImplementationSourceEvidence ? value : new ImplementationSourceEvidence(value); }
  toJSON() {
    return { stepId: this.stepId, runId: this.runId, specId: this.specId, nodeId: this.nodeId,
      attemptId: this.attemptId, attemptSequence: this.attemptSequence,
      taskId: this.taskId, taskRound: this.taskRound, reviewResultCount: this.reviewResultCount,
      handoffDigest: this.handoffDigest, mutationManifestDigest: this.mutationManifestDigest,
      mutationCount: this.mutationCount, completionStatus: this.completionStatus,
      qualityIssueCount: this.qualityIssueCount, noChangeReason: this.noChangeReason,
      appliedFindingKeys: [...this.appliedFindingKeys], taskFrontier: this.taskFrontier?.toJSON() ?? null,
      taskStageFacts: this.taskStageFacts?.toJSON() ?? null };
  }
}

/** Only acquired values enter a Source Step; filesystem and manager authority stay outside. */
export class SourceStepFacts {
  constructor({ stepId, effect = null, evidence = null, completionFailure = null } = {}) {
    if (!requiresWorkerSourceHandoff(stepId)
      || (effect === null) !== (evidence === null)
      || effect !== null && (!(effect instanceof SourceWorkerEffect)
        || !(evidence instanceof ImplementationSourceEvidence)
        || effect.stepId !== stepId || evidence.stepId !== stepId
        || effect.completionStatus !== evidence.completionStatus
        || effect.issues.length !== evidence.qualityIssueCount)) {
      throw new TypeError("Source Step facts require an exact typed effect and evidence");
    }
    this.stepId = stepId;
    if (effect !== null) {
      const reason = effect.noChangeReason?.text ?? effect.noChangeReason?.reason ?? null;
      const applied = effect.triage?.dispositions.filter((entry) => entry.disposition === "apply")
        .map((entry) => entry.findingKey) ?? effect.repair?.appliedFindingKeys ?? [];
      if (reason !== evidence.noChangeReason || JSON.stringify(applied) !== JSON.stringify(evidence.appliedFindingKeys)) {
        throw new TypeError("Source facts must bind the exact no-change and finding evidence");
      }
    }
    this.effect = effect;
    this.evidence = evidence;
    if (completionFailure !== null && (effect === null || !(completionFailure instanceof Error))) throw new TypeError("source completion failure must be typed");
    this.completionFailure = completionFailure;
    Object.freeze(this);
  }
}

/** The Step adopts this exact evidence and effect with its one semantic Result. */
export class SourceStepSelection {
  constructor({ facts, result }) {
    if (!(facts instanceof SourceStepFacts) || result?.stepId !== facts.stepId) {
      throw new TypeError("Source selection requires its Step facts and Result");
    }
    if (facts.effect === null) {
      if (result.kind !== `${facts.stepId}-worker-required` || result.type !== "loop-required") {
        throw new TypeError("Unexecuted Source selection requires its worker checkpoint Result");
      }
    } else if (facts.completionFailure !== null) {
      if (result.type !== "error" || result.kind !== `${facts.stepId}-error`
        || result.error?.code !== facts.completionFailure.code || result.error?.message !== facts.completionFailure.message
        || JSON.stringify(result.error?.data ?? null) !== JSON.stringify(facts.completionFailure.data ?? null)) {
        throw new TypeError("Source failed selection requires its exact bound completion failure");
      }
    } else {
      if (result.evidence !== facts.evidence) throw new TypeError("Source selection requires the exact adopted evidence");
      facts.evidence.assertResultKind(result.kind);
    }
    this.facts = facts;
    this.result = result;
    Object.freeze(this);
  }
}
