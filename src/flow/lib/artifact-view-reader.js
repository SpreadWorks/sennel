/**
 * Catalog-authorized reader for the closed human artifact-view registry.
 *
 * The FlowManager's normal read API intentionally enforces active-Step
 * consumer ownership.  A human display is neither an active Step nor an
 * arbitrary file browser, so this reader starts from one exact Version
 * location, validates its catalog, and reads only dependencies declared by
 * ArtifactViewRegistryEntry.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FlowArtifactCatalog,
  FlowArtifactCatalogStore,
  FlowVersionLocation,
} from "../../lib/flow-version.js";
import { flowStateSpecLocation } from "../../lib/flow-workspace.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../lib/flow-artifact-contract.js";
import { validateSchema } from "../../lib/schema-validate.js";
import { CanonicalCommandAttemptArtifactHistory } from "./canonical-command-result.js";
import { validateAcceptanceReviewArtifact } from "./acceptance-review-artifacts.js";
import {
  CanonicalFlowFindingSourceArtifact,
  FlowFindingSourceIdentity,
  FlowFindingsArtifact,
  normalizeSourceArtifactPath,
} from "./flow-findings.js";
import { FLOW_ARTIFACT_VIEW_REGISTRY } from "./artifact-view-registry.js";
import { artifactViewSha256 } from "./artifact-view-fingerprint.js";
import { buildCurrentFlowDefinition } from "../definition.js";
import {
  CurrentFlowStateSerializer,
  CurrentFlowStateValidator,
} from "./current-flow-state.js";

const SPEC_SCHEMA_PATH = fileURLToPath(new URL("../schemas/spec.schema.json", import.meta.url));
const DECISION_CHOICES = new Set(["accept_risk_and_continue", "abort"]);
const UNRESOLVED_DEFERRED_DISPOSITIONS = new Set(["still_open", "blocking"]);
const FINAL_DEFERRED_DISPOSITIONS = new Set([
  "fixed", "not_needed", "false_positive", "pre_existing", "still_open", "blocking",
]);
const FLOW_STATE_SERIALIZER = new CurrentFlowStateSerializer({
  validator: new CurrentFlowStateValidator({ definition: buildCurrentFlowDefinition() }),
});

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function parsedJson(bytes, field) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("must contain an object");
    }
    return value;
  } catch (error) {
    throw new Error(`${field} must be JSON: ${error.message}`);
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function immutableJson(value, field) {
  try {
    return deepFreeze(JSON.parse(JSON.stringify(value)));
  } catch (error) {
    throw new Error(`${field} must be JSON-serializable: ${error.message}`);
  }
}

function readSpecSchema() {
  return JSON.parse(fs.readFileSync(SPEC_SCHEMA_PATH, "utf8"));
}

function deferredProjection(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return Object.freeze({
    findingId: text(value.findingId, `${field}.findingId`),
    sourceStep: text(value.sourceStep, `${field}.sourceStep`),
    sourceArtifact: normalizeSourceArtifactPath(value.sourceArtifact, `${field}.sourceArtifact`),
    sourceFindingId: text(value.sourceFindingId, `${field}.sourceFindingId`),
    finalDisposition: text(value.finalDisposition, `${field}.finalDisposition`),
  });
}

/**
 * Hard blockers are not an independent source: they must be precisely the
 * unresolved subset of the review's deferred finding projections. This makes
 * corrupt omissions/additions fatal before a human sees a partial view.
 */
export function assertAcceptanceHardBlockerProjection(review) {
  if (review === null || typeof review !== "object" || Array.isArray(review)) {
    throw new Error("acceptance.review must be an object");
  }
  if (!Array.isArray(review.deferredFindings) || !Array.isArray(review.hardBlockers)) {
    throw new Error("acceptance.review deferredFindings and hardBlockers must be arrays");
  }
  const expected = review.deferredFindings
    .map((value, index) => deferredProjection(value, `acceptance.review.deferredFindings[${index}]`))
    .filter((value) => UNRESOLVED_DEFERRED_DISPOSITIONS.has(value.finalDisposition));
  const actual = review.hardBlockers
    .map((value, index) => deferredProjection(value, `acceptance.review.hardBlockers[${index}]`));
  const index = (values, field) => {
    const result = new Map();
    for (const value of values) {
      if (result.has(value.findingId)) throw new Error(`${field} has duplicate findingId: ${value.findingId}`);
      result.set(value.findingId, value);
    }
    return result;
  };
  const expectedById = index(expected, "acceptance.review.deferredFindings");
  const actualById = index(actual, "acceptance.review.hardBlockers");
  if (actualById.size !== expectedById.size) {
    throw new Error("acceptance.review hardBlockers must equal unresolved deferredFindings");
  }
  for (let position = 0; position < expected.length; position += 1) {
    const value = expected[position];
    const hard = actual[position] ?? null;
    if (hard === null
      || hard.findingId !== value.findingId
      || hard.sourceStep !== value.sourceStep
      || hard.sourceArtifact !== value.sourceArtifact
      || hard.sourceFindingId !== value.sourceFindingId
      || hard.finalDisposition !== value.finalDisposition) {
      throw new Error(`acceptance.review hardBlockers is not linked to deferred finding in source order: ${value.findingId}`);
    }
  }
  return review;
}

/** Exact read-only Version target. No latest/current inference is permitted. */
export class ArtifactViewTarget {
  constructor({ location, active = false } = {}) {
    if (!(location instanceof FlowVersionLocation)) throw new Error("artifact view target requires a FlowVersionLocation");
    location.requireScope("canonical");
    if (active !== true && active !== false) throw new Error("artifact view target active must be boolean");
    this.location = location;
    this.active = active;
    Object.freeze(this);
  }

  get specId() { return this.location.specId.toString(); }
  get version() { return this.location.version.value; }

  /**
   * An explicit Version selector is historical authority, not an alternative
   * spelling of the active selector. Its canonical lifecycle must therefore
   * be finalized before any primary artifact, cache, or summary agent is
   * touched. Active targets already carry the command's guarded state and do
   * not pass through this historical eligibility check.
   */
  assertReadable(catalog) {
    if (this.active) return this;
    if (!(catalog instanceof FlowArtifactCatalog)) {
      throw new Error("completed artifact view target requires a canonical Artifact catalog");
    }
    const contract = FLOW_ARTIFACT_CONTRACTS.require("flow.state");
    const relativePath = contract.resolve().relativePath;
    const descriptor = catalog.resolve(relativePath);
    if (descriptor.logicalKey !== "flow.state") {
      throw new Error("completed artifact view flow.state catalog identity is invalid");
    }
    descriptor.verify(this.location);
    this.location.assertAuthority(descriptor.relativePath, { mustExist: true });
    const bytes = fs.readFileSync(this.location.resolve(descriptor.relativePath));
    if (artifactViewSha256(bytes) !== descriptor.hash) {
      throw new Error("completed artifact view flow.state content does not match the Artifact catalog");
    }
    let state;
    try {
      state = FLOW_STATE_SERIALIZER.deserialize(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
      throw new Error(`completed artifact view flow.state is invalid: ${error.message}`);
    }
    if (!state.identity.matchesLocation(this.location)) {
      throw new Error("completed artifact view flow.state identity does not match its Version location");
    }
    if (state.lifecycle.state !== "finalized") {
      throw new Error(`completed artifact view requires a finalized Version (got: ${state.lifecycle.state})`);
    }
    return this;
  }

  toJSON() {
    return {
      specId: this.specId,
      version: this.version,
      active: this.active,
      relativeDirectory: this.location.relativeDirectory,
    };
  }
}

/** A catalog descriptor plus the exact bytes which were hash-verified for display. */
export class ArtifactViewSource {
  #bytes;

  constructor({ logicalKey, relativePath, hash, bytes } = {}) {
    this.logicalKey = text(logicalKey, "artifact view source logicalKey");
    this.relativePath = text(relativePath, "artifact view source relativePath");
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error("artifact view source hash must be a SHA-256 digest");
    }
    if (!Buffer.isBuffer(bytes)) throw new Error("artifact view source bytes must be a Buffer");
    const captured = Buffer.from(bytes);
    if (artifactViewSha256(captured) !== hash) throw new Error(`artifact view source hash mismatch: ${this.relativePath}`);
    this.hash = hash;
    this.#bytes = captured;
    Object.freeze(this);
  }

  bytes() { return Buffer.from(this.#bytes); }
  text() { return this.#bytes.toString("utf8"); }
  fingerprintInput() { return { logicalKey: this.logicalKey, hash: this.hash }; }
  toJSON() { return { logicalKey: this.logicalKey, relativePath: this.relativePath, hash: this.hash }; }
}

/**
 * The human-relevant authoritative disposition recorded in flow.findings.
 * It remains distinct from the original source finding, which supplies the
 * detailed issue text; this projection supplies the bounded rationale for
 * deferral and the final decision-relevant disposition.
 */
export class ArtifactViewFlowFindingProjection {
  constructor({ findingId, sourceStep, sourceArtifact, sourceFindingId, fingerprint, rationale, disposition, finalDisposition = null } = {}) {
    this.findingId = text(findingId, "artifact view flow findingId");
    const identity = new FlowFindingSourceIdentity({ sourceStep, sourceArtifact, sourceFindingId, fingerprint });
    this.sourceStep = identity.sourceStep;
    this.sourceArtifact = identity.sourceArtifact;
    this.sourceFindingId = identity.sourceFindingId;
    this.fingerprint = identity.fingerprint;
    this.rationale = text(rationale, "artifact view flow finding rationale");
    this.disposition = text(disposition, "artifact view flow finding disposition");
    if (this.disposition !== "deferred") throw new Error("artifact view flow finding disposition must be deferred");
    this.finalDisposition = finalDisposition === null ? null : text(finalDisposition, "artifact view flow finding finalDisposition");
    if (this.finalDisposition !== null && !FINAL_DEFERRED_DISPOSITIONS.has(this.finalDisposition)) {
      throw new Error("artifact view flow finding finalDisposition is invalid");
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      findingId: this.findingId,
      sourceStep: this.sourceStep,
      sourceArtifact: this.sourceArtifact,
      sourceFindingId: this.sourceFindingId,
      fingerprint: this.fingerprint,
      rationale: this.rationale,
      disposition: this.disposition,
      finalDisposition: this.finalDisposition,
    };
  }
}

/** One catalog-verified deferred-finding source expansion. */
export class ArtifactViewResolvedReference {
  constructor({ findingId, sourceStep, sourceArtifact, sourceFindingId, fingerprint, source, finding, flowFinding } = {}) {
    this.findingId = text(findingId, "artifact view findingId");
    const identity = new FlowFindingSourceIdentity({ sourceStep, sourceArtifact, sourceFindingId, fingerprint });
    this.sourceStep = identity.sourceStep;
    this.sourceArtifact = identity.sourceArtifact;
    this.sourceFindingId = identity.sourceFindingId;
    this.fingerprint = identity.fingerprint;
    if (!(source instanceof ArtifactViewSource)) throw new Error("artifact view resolved reference requires an ArtifactViewSource");
    if (finding === null || typeof finding !== "object" || Array.isArray(finding)) {
      throw new Error("artifact view resolved reference finding must be an object");
    }
    if (!(flowFinding instanceof ArtifactViewFlowFindingProjection)) {
      throw new Error("artifact view resolved reference requires an ArtifactViewFlowFindingProjection");
    }
    if (
      flowFinding.findingId !== this.findingId
      || flowFinding.sourceStep !== this.sourceStep
      || flowFinding.sourceArtifact !== this.sourceArtifact
      || flowFinding.sourceFindingId !== this.sourceFindingId
      || flowFinding.fingerprint !== this.fingerprint
    ) {
      throw new Error(`artifact view authoritative flow finding is not linked: ${this.findingId}`);
    }
    this.source = source;
    this.finding = immutableJson(finding, "artifact view resolved reference finding");
    this.flowFinding = flowFinding;
    Object.freeze(this);
  }

  toJSON() {
    return {
      findingId: this.findingId,
      sourceStep: this.sourceStep,
      sourceArtifact: this.sourceArtifact,
      sourceFindingId: this.sourceFindingId,
      fingerprint: this.fingerprint,
      source: this.source.toJSON(),
      finding: this.finding,
      flowFinding: this.flowFinding.toJSON(),
    };
  }
}

/** A validated acceptance decision linked to the reviewed attempt, or null. */
export class ArtifactViewAcceptanceDecision {
  constructor({ choice, decidedAt, source = null } = {}) {
    this.choice = text(choice, "acceptance decision choice");
    if (!DECISION_CHOICES.has(this.choice)) throw new Error("acceptance decision choice is invalid");
    this.decidedAt = text(decidedAt, "acceptance decision decidedAt");
    if (source !== null && !(source instanceof ArtifactViewSource)) {
      throw new Error("acceptance decision source must be an ArtifactViewSource or null");
    }
    this.source = source;
    Object.freeze(this);
  }

  toJSON() {
    return { choice: this.choice, decidedAt: this.decidedAt, ...(this.source ? { source: this.source.toJSON() } : {}) };
  }

  /**
   * A saved value on the reviewed artifact is valid display authority. It is
   * still constrained to the only review verdict that can ask for a decision.
   */
  static fromEmbedded(review) {
    if (review === null || typeof review !== "object" || Array.isArray(review)) {
      throw new Error("acceptance.review must be an object");
    }
    if (review.userDecision === null) return null;
    if (review.verdict !== "user_decision_required") {
      throw new Error("acceptance.review.userDecision requires user_decision_required verdict");
    }
    return new ArtifactViewAcceptanceDecision({
      choice: review.userDecision?.choice,
      decidedAt: review.userDecision?.decidedAt,
    });
  }

  /**
   * Resolve the optional separately cataloged decision. When it exists it
   * must link to this exact review Attempt and agree with a saved embedded
   * display value; it never makes the embedded value mandatory.
   */
  static resolve({ review, reviewAttempt, reviewSource, decisionSource = null } = {}) {
    const embedded = ArtifactViewAcceptanceDecision.fromEmbedded(review);
    if (decisionSource === null) return embedded;
    if (!(reviewSource instanceof ArtifactViewSource) || reviewSource.logicalKey !== "acceptance.review") {
      throw new Error("acceptance.review source must be an ArtifactViewSource");
    }
    if (!(decisionSource instanceof ArtifactViewSource)) {
      throw new Error("acceptance.decision source must be an ArtifactViewSource or null");
    }
    if (decisionSource.logicalKey !== "acceptance.decision") {
      throw new Error("acceptance.decision source logicalKey is invalid");
    }
    if (review.verdict !== "user_decision_required") {
      throw new Error("acceptance.decision is present for a review that does not require a user decision");
    }
    if (!Number.isSafeInteger(reviewAttempt) || reviewAttempt < 1) {
      throw new Error("acceptance.review attempt must be a positive safe integer");
    }
    const history = CanonicalCommandAttemptArtifactHistory.fromBytes({
      logicalKey: "acceptance.decision",
      bytes: decisionSource.bytes(),
    });
    const payload = history.current.payload;
    if (payload.version !== 1 || !DECISION_CHOICES.has(payload.choice) || typeof payload.decidedAt !== "string" || payload.decidedAt.trim() === "") {
      throw new Error("canonical acceptance.decision payload is invalid");
    }
    if (!Number.isSafeInteger(payload.acceptanceReviewAttempt) || payload.acceptanceReviewAttempt !== reviewAttempt) {
      throw new Error("canonical acceptance.decision is not linked to the current acceptance.review attempt");
    }
    if (typeof payload.acceptanceReviewDigest !== "string" || payload.acceptanceReviewDigest !== reviewSource.hash) {
      throw new Error("canonical acceptance.decision review digest does not match acceptance.review");
    }
    if (payload.repairFingerprint !== review.repairFingerprint) {
      throw new Error("canonical acceptance.decision repair fingerprint does not match acceptance.review");
    }
    const resolved = new ArtifactViewAcceptanceDecision({
      choice: payload.choice,
      decidedAt: payload.decidedAt,
      source: decisionSource,
    });
    if (embedded !== null && (embedded.choice !== resolved.choice || embedded.decidedAt !== resolved.decidedAt)) {
      throw new Error("acceptance.review.userDecision conflicts with canonical acceptance.decision");
    }
    return resolved;
  }
}

/** Named helper for the accepted embedded display value. */
export function embeddedAcceptanceDecision(review) {
  return ArtifactViewAcceptanceDecision.fromEmbedded(review);
}

/** Immutable renderer input. Every source came from the verified catalog. */
export class ArtifactViewDocument {
  constructor({ target, entry, primary, primaryValue, dependencies = [], references = [], decision = null } = {}) {
    if (!(target instanceof ArtifactViewTarget)) throw new Error("artifact view document requires an ArtifactViewTarget");
    if (!entry || typeof entry.logicalKey !== "string") throw new Error("artifact view document requires a registry entry");
    if (!(primary instanceof ArtifactViewSource) || primary.logicalKey !== entry.logicalKey) {
      throw new Error("artifact view document primary source does not match the registry entry");
    }
    if (!Array.isArray(dependencies) || dependencies.some((source) => !(source instanceof ArtifactViewSource))) {
      throw new Error("artifact view document dependencies must be ArtifactViewSource values");
    }
    if (!Array.isArray(references) || references.some((reference) => !(reference instanceof ArtifactViewResolvedReference))) {
      throw new Error("artifact view document references must be ArtifactViewResolvedReference values");
    }
    if (decision !== null && !(decision instanceof ArtifactViewAcceptanceDecision)) {
      throw new Error("artifact view document decision must be an ArtifactViewAcceptanceDecision or null");
    }
    this.target = target;
    this.entry = entry;
    this.logicalKey = entry.logicalKey;
    this.primary = primary;
    this.primaryValue = immutableJson(primaryValue, "artifact view primary value");
    this.dependencies = Object.freeze([...dependencies]);
    this.references = Object.freeze([...references]);
    this.decision = decision;
    const sources = [
      primary,
      ...dependencies,
      ...references.map((reference) => reference.source),
      ...(decision?.source ? [decision.source] : []),
    ];
    const unique = [];
    const identities = new Set();
    for (const source of sources) {
      const identity = `${source.logicalKey}\u0000${source.relativePath}`;
      if (identities.has(identity)) continue;
      identities.add(identity);
      unique.push(source);
    }
    this.sourceArtifacts = Object.freeze(unique);
    Object.freeze(this);
  }

  dependency(logicalKey) {
    const key = text(logicalKey, "artifact view dependency logicalKey");
    const source = this.dependencies.find((candidate) => candidate.logicalKey === key) ?? null;
    if (source === null) throw new Error(`artifact view dependency is absent: ${key}`);
    return source;
  }

  fingerprintSources() {
    return this.sourceArtifacts.map((source) => source.fingerprintInput());
  }
}

/**
 * Reads only renderer-declared primary/static/dynamic sources from one
 * cataloged Version. A failed validation is deliberately fatal: callers never
 * receive a partial human display.
 */
export class ArtifactViewReader {
  constructor({ target, registry = FLOW_ARTIFACT_VIEW_REGISTRY } = {}) {
    if (!(target instanceof ArtifactViewTarget)) throw new Error("artifact view reader requires an ArtifactViewTarget");
    if (!registry || typeof registry.require !== "function") throw new Error("artifact view reader requires an ArtifactViewRegistry");
    this.target = target;
    this.registry = registry;
    this.catalog = new FlowArtifactCatalogStore({ location: target.location }).require();
    target.assertReadable(this.catalog);
    Object.freeze(this);
  }

  read(logicalKey) {
    const entry = this.registry.require(logicalKey);
    const primary = this.#readDeclaredSingleton(entry.logicalKey);
    if (entry.logicalKey === "spec.record") {
      const spec = this.#readSpec(primary);
      return new ArtifactViewDocument({ target: this.target, entry, primary, primaryValue: spec });
    }
    if (entry.logicalKey === "acceptance.review") return this.#readAcceptance(entry, primary);
    throw new Error(`artifact view renderer is not implemented: ${entry.logicalKey}`);
  }

  #readSpec(source) {
    const spec = parsedJson(source.bytes(), "canonical spec.record");
    const errors = validateSchema(spec, readSpecSchema());
    if (errors.length > 0) throw new Error(`canonical spec.record schema validation failed: ${errors.join("; ")}`);
    const requirementIds = spec.requirements.map((requirement) => requirement.id);
    if (new Set(requirementIds).size !== requirementIds.length) throw new Error("canonical spec.record has duplicate requirement ids");
    const taskIds = (spec.tasks || []).map((task) => task.id);
    if (new Set(taskIds).size !== taskIds.length) throw new Error("canonical spec.record has duplicate task ids");
    const knownTasks = new Set(taskIds);
    for (const task of spec.tasks || []) {
      if (task.parent !== null && task.parent !== undefined && !knownTasks.has(task.parent)) {
        throw new Error(`canonical spec.record task parent is absent: ${task.id}/${task.parent}`);
      }
    }
    return spec;
  }

  #readAcceptance(entry, primary) {
    const dependencySources = [];
    const specDependency = entry.dependency("spec.record");
    if (!specDependency.required) throw new Error("acceptance.review requires spec.record as a required dependency");
    const specSource = this.#readDeclaredSingleton(specDependency.logicalKey);
    dependencySources.push(specSource);
    const spec = this.#readSpec(specSource);

    const reviewHistory = CanonicalCommandAttemptArtifactHistory.fromBytes({
      logicalKey: "acceptance.review",
      bytes: primary.bytes(),
    });
    const reviewAttempt = reviewHistory.current.attempt;
    const review = validateAcceptanceReviewArtifact(reviewHistory.current.payload, {
      requirementIds: spec.requirements.map((requirement) => requirement.id),
    });
    assertAcceptanceHardBlockerProjection(review);

    const decisionDependency = entry.dependency("acceptance.decision");
    const decisionSource = this.#readOptionalDeclaredSingleton(decisionDependency);
    if (decisionSource !== null) dependencySources.push(decisionSource);
    const decision = this.#resolveDecision({ review, reviewAttempt, reviewSource: primary, decisionSource });

    const findingsDependency = entry.dependency("flow.findings");
    const findingsSource = review.deferredFindings.length === 0
      ? null
      : this.#readOptionalDeclaredSingleton(findingsDependency);
    if (findingsSource !== null) dependencySources.push(findingsSource);
    const flowFindings = findingsSource === null
      ? null
      : new FlowFindingsArtifact(parsedJson(findingsSource.bytes(), "canonical flow.findings"));
    const referenceRule = entry.referenceRule("deferredFindingSource");
    const references = this.#resolveDeferredFindingReferences({ review, flowFindings, referenceRule });
    return new ArtifactViewDocument({
      target: this.target,
      entry,
      primary,
      primaryValue: review,
      dependencies: dependencySources,
      references,
      decision,
    });
  }

  #resolveDecision({ review, reviewAttempt, reviewSource, decisionSource }) {
    return ArtifactViewAcceptanceDecision.resolve({ review, reviewAttempt, reviewSource, decisionSource });
  }

  #resolveDeferredFindingReferences({ review, flowFindings, referenceRule }) {
    const references = [];
    const findingIds = new Set();
    const sourceIdentities = new Set();
    if (review.deferredFindings.length > 0 && flowFindings === null) {
      throw new Error("acceptance.review deferred findings require the cataloged flow.findings dependency");
    }
    const findingById = new Map();
    for (const finding of flowFindings?.entries || []) {
      if (findingById.has(finding.findingId)) {
        throw new Error(`canonical flow.findings has duplicate findingId: ${finding.findingId}`);
      }
      findingById.set(finding.findingId, finding);
    }
    for (const deferred of review.deferredFindings) {
      if (findingIds.has(deferred.findingId)) throw new Error(`acceptance.review has duplicate deferred finding: ${deferred.findingId}`);
      findingIds.add(deferred.findingId);
      const authoritativeFinding = findingById.get(deferred.findingId) ?? null;
      if (authoritativeFinding === null) {
        throw new Error(`acceptance.review deferred finding is absent from canonical flow.findings: ${deferred.findingId}`);
      }
      const expectedDisposition = authoritativeFinding.finalDisposition ?? "still_open";
      if (
        deferred.sourceStep !== authoritativeFinding.sourceStep
        || deferred.sourceArtifact !== authoritativeFinding.sourceArtifact
        || deferred.sourceFindingId !== authoritativeFinding.sourceFindingId
        || deferred.finalDisposition !== expectedDisposition
      ) {
        throw new Error(`acceptance.review deferred finding conflicts with canonical flow.findings: ${deferred.findingId}`);
      }
      const reference = referenceRule.assertReference(authoritativeFinding);
      const expectedEvidenceRef = `${reference.sourceArtifact}#${reference.sourceFindingId}`;
      if (!deferred.evidenceRefs.includes(expectedEvidenceRef)) {
        throw new Error(`acceptance.review deferred finding lacks its canonical evidence reference: ${deferred.findingId}`);
      }
      const sourceContract = FLOW_ARTIFACT_CONTRACTS.classify(reference.sourceArtifact);
      const sourceLogicalKey = referenceRule.assertSourceLogicalKey(sourceContract.logicalKey.toString());
      const source = this.#readDeclaredDynamicSource({
        logicalKey: sourceLogicalKey,
        relativePath: reference.sourceArtifact,
      });
      const sourceIdentity = reference.toString();
      if (sourceIdentities.has(sourceIdentity)) {
        throw new Error(`acceptance.review has duplicate deferred finding source reference: ${sourceIdentity}`);
      }
      sourceIdentities.add(sourceIdentity);
      const finding = CanonicalFlowFindingSourceArtifact.fromBytes({
        logicalKey: source.logicalKey,
        relativePath: source.relativePath,
        bytes: source.bytes(),
      }).resolveFinding(reference);
      if (finding === null) {
        throw new Error(`acceptance.review deferred finding source cannot be resolved: ${sourceIdentity}`);
      }
      references.push(new ArtifactViewResolvedReference({
        findingId: deferred.findingId,
        sourceStep: deferred.sourceStep,
        sourceArtifact: reference.sourceArtifact,
        sourceFindingId: reference.sourceFindingId,
        fingerprint: reference.fingerprint,
        source,
        finding,
        flowFinding: new ArtifactViewFlowFindingProjection({
          findingId: authoritativeFinding.findingId,
          sourceStep: authoritativeFinding.sourceStep,
          sourceArtifact: authoritativeFinding.sourceArtifact,
          sourceFindingId: authoritativeFinding.sourceFindingId,
          fingerprint: authoritativeFinding.fingerprint,
          rationale: authoritativeFinding.rationale,
          disposition: authoritativeFinding.disposition,
          finalDisposition: authoritativeFinding.finalDisposition,
        }),
      }));
    }
    return references;
  }

  #readDeclaredSingleton(logicalKey) {
    const contract = FLOW_ARTIFACT_CONTRACTS.require(logicalKey);
    if (contract.canonicalPath.parameters.length !== 0) {
      throw new Error(`artifact view singleton dependency must not be parameterized: ${logicalKey}`);
    }
    return this.#readCatalogDescriptor({ logicalKey, relativePath: contract.resolve().relativePath });
  }

  #readOptionalDeclaredSingleton(dependency) {
    if (!dependency || dependency.required !== false) throw new Error("artifact view optional dependency declaration is required");
    const contract = FLOW_ARTIFACT_CONTRACTS.require(dependency.logicalKey);
    if (contract.canonicalPath.parameters.length !== 0) {
      throw new Error(`artifact view optional singleton dependency must not be parameterized: ${dependency.logicalKey}`);
    }
    const descriptor = this.#optionalDescriptor(contract.resolve().relativePath);
    if (descriptor === null) return null;
    return this.#sourceFromDescriptor(descriptor, dependency.logicalKey);
  }

  #readDeclaredDynamicSource({ logicalKey, relativePath }) {
    const contract = FLOW_ARTIFACT_CONTRACTS.require(logicalKey);
    if (!contract.matchesCanonicalPath(relativePath)) {
      throw new Error(`artifact view dynamic source path does not match its contract: ${relativePath}`);
    }
    return this.#readCatalogDescriptor({ logicalKey, relativePath });
  }

  #readCatalogDescriptor({ logicalKey, relativePath }) {
    const descriptor = this.catalog.resolve(relativePath);
    return this.#sourceFromDescriptor(descriptor, logicalKey);
  }

  #optionalDescriptor(relativePath) {
    try {
      return this.catalog.resolve(relativePath);
    } catch (error) {
      if (String(error.message).startsWith("artifact is not cataloged:")) return null;
      throw error;
    }
  }

  #sourceFromDescriptor(descriptor, expectedLogicalKey) {
    if (descriptor.logicalKey !== expectedLogicalKey) {
      throw new Error(`artifact catalog logicalKey conflicts with view dependency: ${descriptor.relativePath}`);
    }
    const contract = FLOW_ARTIFACT_CONTRACTS.require(expectedLogicalKey);
    if (!contract.matchesCanonicalPath(descriptor.relativePath)) {
      throw new Error(`artifact catalog path conflicts with view dependency: ${descriptor.relativePath}`);
    }
    descriptor.verify(this.target.location);
    this.target.location.assertAuthority(descriptor.relativePath, { mustExist: true });
    const bytes = fs.readFileSync(this.target.location.resolve(descriptor.relativePath));
    if (artifactViewSha256(bytes) !== descriptor.hash) {
      throw new Error(`artifact content changed while preparing the view: ${descriptor.relativePath}`);
    }
    return new ArtifactViewSource({
      logicalKey: expectedLogicalKey,
      relativePath: descriptor.relativePath,
      hash: descriptor.hash,
      bytes,
    });
  }
}

/** Resolve an exact active or completed Version target without loading ambient state. */
export function resolveArtifactViewTarget({ flowManager, specId = null, version = null, activeState = null, location = null } = {}) {
  if (!flowManager || typeof flowManager.specLocation !== "function" || typeof flowManager.canonicalVersionLocation !== "function") {
    throw new Error("artifact view target resolution requires FlowManager Version location APIs");
  }
  const hasSpecId = specId !== null && specId !== undefined;
  const hasVersion = version !== null && version !== undefined;
  if (hasSpecId !== hasVersion) {
    throw new Error("artifact view completed Version requires both specId and version");
  }
  if (location !== null && location !== undefined) {
    if (!(location instanceof FlowVersionLocation)) throw new Error("artifact view location must be a FlowVersionLocation");
    if (hasSpecId || activeState !== null) throw new Error("artifact view location cannot be combined with another target selector");
    return new ArtifactViewTarget({ location, active: false });
  }
  if (hasSpecId) {
    if (activeState !== null) throw new Error("artifact view completed Version cannot be combined with active state");
    return new ArtifactViewTarget({ location: flowManager.canonicalVersionLocation(version, { specId }), active: false });
  }
  if (activeState === null || typeof activeState !== "object" || Array.isArray(activeState)) {
    throw new Error("artifact view active target requires an explicit activeState");
  }
  const activeSpecId = text(activeState.specId, "artifact view activeState.specId");
  const boundLocation = flowStateSpecLocation(activeState);
  if (boundLocation instanceof FlowVersionLocation) {
    if (boundLocation.specId.toString() !== activeSpecId) {
      throw new Error("artifact view activeState location conflicts with specId");
    }
    return new ArtifactViewTarget({ location: boundLocation, active: true });
  }
  return new ArtifactViewTarget({ location: flowManager.specLocation(activeSpecId), active: true });
}

/**
 * Utility for cache path callers that need a normalized fixed filename rather
 * than an arbitrary artifact-derived path.
 */
export function artifactViewRuntimeDirectory(target) {
  if (!(target instanceof ArtifactViewTarget)) throw new Error("artifact view runtime directory requires an ArtifactViewTarget");
  const directory = target.location.resolve(path.posix.join(".runtime", "views"));
  return directory;
}
