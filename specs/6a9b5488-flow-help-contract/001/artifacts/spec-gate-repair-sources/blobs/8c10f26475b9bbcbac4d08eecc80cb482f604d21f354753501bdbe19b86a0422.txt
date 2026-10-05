import crypto from "node:crypto";
import path from "node:path";

import {
  RequirementTestBudget,
  RequirementTestBundleRevision,
  RequirementTestExpectation,
  RequirementTestPlan,
  RequirementTestSourceAttempt,
} from "./requirement-test-lifecycle.js";
import { SpecRevisionIdentity } from "./spec-revision-identity.js";

const SHA256 = /^[a-f0-9]{64}$/;
const OBSERVATIONS = new Set([
  "assertion_failed",
  "assertion_passed",
  "invalid_test",
  "tooling_failure",
  "skipped",
  "missing",
]);

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value.trim();
}

function digest(value, field) {
  const result = requiredText(value, field);
  if (!SHA256.test(result)) throw new Error(`${field} must be a lowercase SHA-256 digest`);
  return result;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative integer`);
  return value;
}

function exactKeys(value, fields, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${field} has an invalid schema`);
  }
  return value;
}

function canonicalTestPath(value, field) {
  const result = requiredText(value, field);
  if (!result.startsWith("tests/") || result.length === "tests/".length
    || result.includes("\\") || path.posix.normalize(result) !== result
    || result.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${field} must be a canonical path below tests/`);
  }
  return result;
}

function canonicalSupportPath(value, field) {
  const result = canonicalTestPath(value, field);
  if (!result.startsWith("tests/support/")) {
    throw new Error(`${field} must be below tests/support/`);
  }
  return result;
}

function canonicalRelativePath(value, field) {
  const result = requiredText(value, field);
  if (path.posix.isAbsolute(result) || result.includes("\\") || path.posix.normalize(result) !== result
    || result.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${field} must be a canonical repository-relative path`);
  }
  return result;
}

function revision(value) {
  return value instanceof SpecRevisionIdentity ? value : new SpecRevisionIdentity(value);
}

function sourceAttempt(value) {
  return value instanceof RequirementTestSourceAttempt ? value : RequirementTestSourceAttempt.fromJSON(value);
}

/**
 * Immutable identity of a helper shared by Requirement candidates.
 *
 * Helpers are deliberately not candidate test sources: one Requirement owns
 * the publication and every consumer binds to that owner's exact bytes.  The
 * owner is part of the identity even when two helpers happen to have the same
 * digest, so a path cannot silently change hands after a restart.
 */
export class RequirementTestSupportArtifact {
  constructor({ ownerRequirementId, supportPath, digest: supportDigest, byteLength } = {}) {
    this.ownerRequirementId = requiredText(ownerRequirementId, "Requirement test support ownerRequirementId");
    this.supportPath = canonicalSupportPath(supportPath, "Requirement test support path");
    this.digest = digest(supportDigest, "Requirement test support digest");
    this.byteLength = nonNegativeInteger(byteLength, "Requirement test support byteLength");
    Object.freeze(this);
  }

  static fromBytes({ ownerRequirementId, supportPath, bytes } = {}) {
    if (!Buffer.isBuffer(bytes)) throw new Error("Requirement test support bytes must be a Buffer");
    return new RequirementTestSupportArtifact({
      ownerRequirementId,
      supportPath,
      digest: crypto.createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.length,
    });
  }

  static fromJSON(value) {
    exactKeys(value, ["ownerRequirementId", "supportPath", "digest", "byteLength"], "Requirement test support artifact");
    return new RequirementTestSupportArtifact(value);
  }

  matchesBytes(bytes) {
    return Buffer.isBuffer(bytes)
      && bytes.length === this.byteLength
      && crypto.createHash("sha256").update(bytes).digest("hex") === this.digest;
  }

  toJSON() {
    return {
      ownerRequirementId: this.ownerRequirementId,
      supportPath: this.supportPath,
      digest: this.digest,
      byteLength: this.byteLength,
    };
  }
}

/** Exact bytes staged below a Requirement candidate bundle, never active tests.source. */
export class RequirementTestCandidateSource {
  constructor({ testPath, digest: sourceDigest, byteLength } = {}) {
    this.testPath = canonicalTestPath(testPath, "Requirement test candidate source path");
    if (this.testPath.startsWith("tests/support/")) {
      throw new Error("Requirement test candidate source must not be a support artifact");
    }
    this.digest = digest(sourceDigest, "Requirement test candidate source digest");
    this.byteLength = nonNegativeInteger(byteLength, "Requirement test candidate source byteLength");
    Object.freeze(this);
  }

  static fromBytes({ testPath, bytes } = {}) {
    if (!Buffer.isBuffer(bytes)) throw new Error("Requirement test candidate source bytes must be a Buffer");
    return new RequirementTestCandidateSource({
      testPath,
      digest: crypto.createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.length,
    });
  }

  static fromJSON(value) {
    exactKeys(value, ["testPath", "digest", "byteLength"], "Requirement test candidate source");
    return new RequirementTestCandidateSource(value);
  }

  toJSON() { return { testPath: this.testPath, digest: this.digest, byteLength: this.byteLength }; }
}

/** Immutable catalog manifest binding a bundle revision to every staged source member. */
export class RequirementTestCandidateBundle {
  constructor({ bundle, sources, support = [] } = {}) {
    this.bundle = bundle instanceof RequirementTestBundleRevision
      ? bundle
      : RequirementTestBundleRevision.fromJSON(bundle);
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new Error("Requirement test candidate bundle sources must be non-empty");
    }
    this.sources = Object.freeze(sources.map((entry) => (
      entry instanceof RequirementTestCandidateSource ? entry : RequirementTestCandidateSource.fromJSON(entry)
    )).sort((left, right) => left.testPath.localeCompare(right.testPath)));
    const sourcePaths = this.sources.map((source) => source.testPath);
    if (new Set(sourcePaths).size !== sourcePaths.length) {
      throw new Error("Requirement test candidate bundle sources must be unique");
    }
    if (!Array.isArray(support)) {
      throw new Error("Requirement test candidate bundle support must be an array");
    }
    this.support = Object.freeze(support.map((entry) => (
      entry instanceof RequirementTestSupportArtifact ? entry : RequirementTestSupportArtifact.fromJSON(entry)
    )).sort((left, right) => left.supportPath.localeCompare(right.supportPath)));
    const supportPaths = this.support.map((entry) => entry.supportPath);
    if (new Set(supportPaths).size !== supportPaths.length) {
      throw new Error("Requirement test candidate bundle support paths must be unique");
    }
    if (supportPaths.some((supportPath) => sourcePaths.includes(supportPath))) {
      throw new Error("Requirement test candidate bundle cannot use one path as source and support");
    }
    const bundlePaths = [...this.bundle.paths].sort();
    if (bundlePaths.length !== sourcePaths.length
      || bundlePaths.some((candidatePath, index) => candidatePath !== sourcePaths[index])) {
      throw new Error("Requirement test candidate bundle sources must exactly match bundle paths");
    }
    this.digest = crypto.createHash("sha256").update([
      ...this.sources.map((source) => `source\0${source.testPath}\0${source.digest}\0${source.byteLength}`),
      ...this.support.map((entry) => `support\0${entry.ownerRequirementId}\0${entry.supportPath}\0${entry.digest}\0${entry.byteLength}`),
    ].join("\n")).digest("hex");
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, ["bundle", "sources", "support", "digest"], "Requirement test candidate bundle");
    const bundle = new RequirementTestCandidateBundle(value);
    if (bundle.digest !== value.digest) throw new Error("Requirement test candidate bundle digest does not match sources");
    return bundle;
  }

  toJSON() {
    return {
      bundle: this.bundle.toJSON(),
      sources: this.sources.map((source) => source.toJSON()),
      support: this.support.map((entry) => entry.toJSON()),
      digest: this.digest,
    };
  }
}

/** Candidate-only identity passed to the bounded Requirement test reviewer. */
export class RequirementTestReviewSource {
  constructor({ runId, requirementId, specRevision, bundleRevision, candidateDigest, sourceAttempt: attempt, candidatePaths, gateEvidence = null } = {}) {
    this.runId = requiredText(runId, "Requirement test review source runId");
    this.requirementId = requiredText(requirementId, "Requirement test review source requirementId");
    this.specRevision = revision(specRevision);
    this.bundleRevision = positiveInteger(bundleRevision, "Requirement test review source bundleRevision");
    this.candidateDigest = digest(candidateDigest, "Requirement test review source candidateDigest");
    this.sourceAttempt = sourceAttempt(attempt);
    if (!Array.isArray(candidatePaths) || candidatePaths.length === 0) {
      throw new Error("Requirement test review source candidatePaths must be non-empty");
    }
    this.candidatePaths = Object.freeze(candidatePaths.map((entry) => canonicalTestPath(entry, "Requirement test review source candidate path")).sort());
    if (new Set(this.candidatePaths).size !== this.candidatePaths.length) {
      throw new Error("Requirement test review source candidatePaths must be unique");
    }
    this.gateEvidence = gateEvidence === null ? null : gateEvidence instanceof RequirementTestReviewGateEvidence
      ? gateEvidence : RequirementTestReviewGateEvidence.fromJSON(gateEvidence);
    if (this.gateEvidence !== null && !this.gateEvidence.matches(this)) {
      throw new Error("Requirement test review source Gate evidence does not match its candidate");
    }
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, ["runId", "requirementId", "specRevision", "bundleRevision", "candidateDigest", "sourceAttempt", "candidatePaths", "gateEvidence"], "Requirement test review source");
    return new RequirementTestReviewSource(value);
  }

  assertFlow(state) {
    if (state?.runId !== this.runId || state?.specId !== this.specRevision.specId) {
      throw new Error("Requirement test review source does not match the active Flow");
    }
    return this;
  }

  toJSON() {
    return {
      runId: this.runId,
      requirementId: this.requirementId,
      specRevision: this.specRevision.toJSON(),
      bundleRevision: this.bundleRevision,
      candidateDigest: this.candidateDigest,
      sourceAttempt: this.sourceAttempt.toJSON(),
      candidatePaths: [...this.candidatePaths],
      gateEvidence: this.gateEvidence?.toJSON() ?? null,
    };
  }
}

/** Gate execution fact bound to exactly one candidate bundle and named Requirement test. */
export class RequirementTestGateObservation {
  constructor({ requirementId, specRevision, bundleRevision, candidateDigest, testName, kind, sourceAttempt: attempt } = {}) {
    this.requirementId = requiredText(requirementId, "Requirement test gate observation requirementId");
    this.specRevision = revision(specRevision);
    this.bundleRevision = positiveInteger(bundleRevision, "Requirement test gate observation bundleRevision");
    this.candidateDigest = digest(candidateDigest, "Requirement test gate observation candidateDigest");
    this.testName = requiredText(testName, "Requirement test gate observation testName");
    if (!OBSERVATIONS.has(kind)) throw new Error("Requirement test gate observation kind is invalid");
    this.kind = kind;
    this.sourceAttempt = sourceAttempt(attempt);
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, [
      "requirementId", "specRevision", "bundleRevision", "candidateDigest", "testName", "kind", "sourceAttempt",
    ], "Requirement test gate observation");
    return new RequirementTestGateObservation(value);
  }

  toJSON() {
    return {
      requirementId: this.requirementId,
      specRevision: this.specRevision.toJSON(),
      bundleRevision: this.bundleRevision,
      candidateDigest: this.candidateDigest,
      testName: this.testName,
      kind: this.kind,
      sourceAttempt: this.sourceAttempt.toJSON(),
    };
  }
}

/** Stable acceptance-facing finding derived from one Gate observation. */
export class RequirementTestGateFinding {
  constructor({ findingId, requirementId, category, reason, fingerprint } = {}) {
    this.findingId = requiredText(findingId, "Requirement test Gate finding id");
    this.requirementId = requiredText(requirementId, "Requirement test Gate finding requirementId");
    this.category = requiredText(category, "Requirement test Gate finding category");
    this.reason = requiredText(reason, "Requirement test Gate finding reason");
    this.fingerprint = digest(fingerprint, "Requirement test Gate finding fingerprint");
    Object.freeze(this);
  }

  static fromObservation(observation) {
    const fact = observation instanceof RequirementTestGateObservation
      ? observation
      : RequirementTestGateObservation.fromJSON(observation);
    const content = {
      findingId: `${fact.requirementId}-gate-${fact.bundleRevision}-${fact.kind}`,
      requirementId: fact.requirementId,
      category: fact.kind,
      reason: `Requirement test Gate observed ${fact.kind} for ${fact.testName}`,
    };
    return new RequirementTestGateFinding({
      ...content,
      fingerprint: crypto.createHash("sha256").update(JSON.stringify(content)).digest("hex"),
    });
  }

  static fromJSON(value) {
    exactKeys(value, ["findingId", "requirementId", "category", "reason", "fingerprint"], "Requirement test Gate finding");
    return new RequirementTestGateFinding(value);
  }

  toJSON() {
    return {
      findingId: this.findingId,
      requirementId: this.requirementId,
      category: this.category,
      reason: this.reason,
      fingerprint: this.fingerprint,
    };
  }
}

/** History-bound Gate evidence made available to the reopened Requirement review. */
export class RequirementTestReviewGateEvidence {
  constructor({ attempt, observation, finding } = {}) {
    this.attempt = positiveInteger(attempt, "Requirement test review Gate Attempt");
    this.observation = observation instanceof RequirementTestGateObservation
      ? observation : RequirementTestGateObservation.fromJSON(observation);
    this.finding = finding instanceof RequirementTestGateFinding
      ? finding : RequirementTestGateFinding.fromJSON(finding);
    if (this.finding.requirementId !== this.observation.requirementId) {
      throw new Error("Requirement test review Gate finding does not match its observation");
    }
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, ["attempt", "observation", "finding"], "Requirement test review Gate evidence");
    return new RequirementTestReviewGateEvidence(value);
  }

  matches(source) {
    return source.requirementId === this.observation.requirementId
      && source.specRevision.equals(this.observation.specRevision)
      && source.bundleRevision === this.observation.bundleRevision
      && source.candidateDigest === this.observation.candidateDigest
      && source.sourceAttempt.id === this.observation.sourceAttempt.id
      && source.sourceAttempt.sequence === this.observation.sourceAttempt.sequence;
  }

  toJSON() {
    return { attempt: this.attempt, observation: this.observation.toJSON(), finding: this.finding.toJSON() };
  }
}

/** Persisted Gate attempt payload; policy consumes only its typed observation. */
export class RequirementTestGateResult {
  constructor({ observation, command, rawOutputPath, process: processResult, findings = null } = {}) {
    this.observation = observation instanceof RequirementTestGateObservation
      ? observation
      : RequirementTestGateObservation.fromJSON(observation);
    if (command !== null && (typeof command !== "string" || command.trim() === "")) {
      throw new Error("Requirement test Gate command must be null or non-empty text");
    }
    this.command = command;
    this.rawOutputPath = canonicalRelativePath(rawOutputPath, "Requirement test Gate raw output path");
    if (this.rawOutputPath !== "steps/test-gate/output.log") {
      throw new Error("Requirement test Gate raw output path is not canonical");
    }
    exactKeys(processResult, ["started", "exitCode", "signal", "timedOut", "spawnError"], "Requirement test Gate process");
    if (typeof processResult.started !== "boolean" || typeof processResult.timedOut !== "boolean"
      || (processResult.exitCode !== null && !Number.isSafeInteger(processResult.exitCode))
      || (processResult.signal !== null && typeof processResult.signal !== "string")
      || (processResult.spawnError !== null && typeof processResult.spawnError !== "string")) {
      throw new Error("Requirement test Gate process is invalid");
    }
    this.process = Object.freeze({ ...processResult });
    const values = findings === null ? [RequirementTestGateFinding.fromObservation(this.observation)] : findings;
    if (!Array.isArray(values) || values.length !== 1) {
      throw new Error("Requirement test Gate result requires one observation finding");
    }
    this.findings = Object.freeze(values.map((finding) => (
      finding instanceof RequirementTestGateFinding ? finding : RequirementTestGateFinding.fromJSON(finding)
    )));
    if (this.findings[0].requirementId !== this.observation.requirementId) {
      throw new Error("Requirement test Gate finding does not match its observation");
    }
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, ["version", "observation", "command", "rawOutputPath", "process", "findings"], "Requirement test Gate result");
    if (value.version !== 1) throw new Error("Requirement test Gate result version must be 1");
    return new RequirementTestGateResult(value);
  }

  toJSON() {
    return {
      version: 1,
      observation: this.observation.toJSON(),
      command: this.command,
      rawOutputPath: this.rawOutputPath,
      process: { ...this.process },
      findings: this.findings.map((finding) => finding.toJSON()),
    };
  }
}

/** Durable acceptance handoff for one Requirement whose bounded test work was exhausted. */
export class RequirementTestDeferredReceipt {
  constructor({
    requirementId,
    specRevision,
    bundleRevision,
    candidateDigest,
    expectation,
    budget,
    sourceAttempt: attempt,
    sourceArtifact,
    sourceFindingFingerprints,
  } = {}) {
    this.requirementId = requiredText(requirementId, "Requirement test deferred receipt requirementId");
    this.specRevision = revision(specRevision);
    this.bundleRevision = bundleRevision === null
      ? null
      : positiveInteger(bundleRevision, "Requirement test deferred receipt bundleRevision");
    this.candidateDigest = candidateDigest === null
      ? null
      : digest(candidateDigest, "Requirement test deferred receipt candidateDigest");
    if ((this.bundleRevision === null) !== (this.candidateDigest === null)) {
      throw new Error("Requirement test deferred receipt candidate identity must be wholly present or absent");
    }
    this.expectation = RequirementTestExpectation.from(expectation);
    this.budget = budget instanceof RequirementTestBudget ? budget : RequirementTestBudget.fromJSON(budget);
    this.sourceAttempt = sourceAttempt(attempt);
    this.sourceArtifact = canonicalRelativePath(sourceArtifact, "Requirement test deferred receipt sourceArtifact");
    if (!["steps/test-generate/", "steps/test-review/", "steps/test-repair/", "steps/test-gate/", "artifacts/test-findings/"]
      .some((prefix) => this.sourceArtifact.startsWith(prefix))) {
      throw new Error("Requirement test deferred receipt sourceArtifact must reference canonical Requirement test evidence");
    }
    if (!Array.isArray(sourceFindingFingerprints) || sourceFindingFingerprints.length === 0
      || sourceFindingFingerprints.some((value) => typeof value !== "string" || !SHA256.test(value))
      || new Set(sourceFindingFingerprints).size !== sourceFindingFingerprints.length) {
      throw new Error("Requirement test deferred receipt sourceFindingFingerprints must be unique non-empty SHA-256 digests");
    }
    this.sourceFindingFingerprints = Object.freeze([...sourceFindingFingerprints]);
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, [
      "requirementId", "specRevision", "bundleRevision", "candidateDigest", "expectation", "budget",
      "sourceAttempt", "sourceArtifact", "sourceFindingFingerprints",
    ], "Requirement test deferred receipt");
    return new RequirementTestDeferredReceipt(value);
  }

  toJSON() {
    return {
      requirementId: this.requirementId,
      specRevision: this.specRevision.toJSON(),
      bundleRevision: this.bundleRevision,
      candidateDigest: this.candidateDigest,
      expectation: this.expectation.toJSON(),
      budget: this.budget.toJSON(),
      sourceAttempt: this.sourceAttempt.toJSON(),
      sourceArtifact: this.sourceArtifact,
      sourceFindingFingerprints: [...this.sourceFindingFingerprints],
    };
  }
}

/** Immutable address of one Requirement-scoped lifecycle failure. */
export class RequirementTestFailureArtifact {
  constructor({ requirementId, bundleRevision, fingerprint } = {}) {
    this.requirementId = requiredText(requirementId, "Requirement test failure requirementId");
    this.bundleRevision = positiveInteger(bundleRevision, "Requirement test failure bundleRevision");
    this.fingerprint = digest(fingerprint, "Requirement test failure fingerprint");
    this.parameters = Object.freeze({
      requirementId: this.requirementId,
      bundleRevision: String(this.bundleRevision),
      fingerprint: this.fingerprint,
    });
    this.relativePath = `artifacts/test-findings/${this.requirementId}/revision-${this.bundleRevision}/${this.fingerprint}.json`;
    Object.freeze(this);
  }

  static fromRelativePath(value) {
    const relativePath = requiredText(value, "Requirement test failure relative path");
    const match = /^artifacts\/test-findings\/([^/]+)\/revision-([1-9][0-9]*)\/([a-f0-9]{64})\.json$/.exec(relativePath);
    if (match === null) throw new Error("Requirement test failure relative path is invalid");
    const artifact = new RequirementTestFailureArtifact({
      requirementId: match[1],
      bundleRevision: Number(match[2]),
      fingerprint: match[3],
    });
    if (artifact.relativePath !== relativePath) {
      throw new Error("Requirement test failure relative path does not match its identity");
    }
    return artifact;
  }

  artifactWrite(sourcePayload) {
    if (sourcePayload === null || typeof sourcePayload !== "object" || Array.isArray(sourcePayload)) {
      throw new Error("Requirement test failure source payload must be an object");
    }
    return Object.freeze({
      logicalKey: "test.requirement.failure",
      parameters: this.parameters,
      mediaType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(sourcePayload, null, 2)}\n`, "utf8"),
    });
  }
}

/** Canonical JSON boundary for the singleton Requirement test plan. */
export class RequirementTestPlanArtifact {
  constructor({ plan } = {}) {
    this.plan = plan instanceof RequirementTestPlan ? plan : RequirementTestPlan.fromJSON(plan);
    Object.freeze(this);
  }

  static fromJSON(value) {
    exactKeys(value, ["version", "plan"], "Requirement test plan artifact");
    if (value.version !== 1) throw new Error("Requirement test plan artifact version must be 1");
    return new RequirementTestPlanArtifact(value);
  }

  toJSON() { return { version: 1, plan: this.plan.toJSON() }; }
  toBytes() { return Buffer.from(`${JSON.stringify(this.toJSON(), null, 2)}\n`, "utf8"); }
}
