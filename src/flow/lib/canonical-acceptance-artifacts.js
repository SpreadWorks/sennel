/**
 * Canonical acceptance persistence boundary.
 *
 * Acceptance review intentionally keeps the established prompt and response
 * schema.  What changes in Version 1 is the source of its evidence: every
 * durable input is resolved from the catalog by logical key, and both the
 * review and an explicit user decision are producer-owned Attempt results.
 * No caller of this module constructs a Version directory or reads a retired
 * sibling artifact.
 */

import crypto from "node:crypto";
import path from "node:path";

import { resolveMergeBase, runGit } from "../../lib/git-helpers.js";
import {
  AcceptanceTestEvidenceProjection,
  changedPathsFromDiff,
  MechanicalBlocker,
  validateAcceptanceReviewArtifact,
} from "./acceptance-review-artifacts.js";
import {
  CanonicalCommandAttemptArtifactHistory,
  CanonicalCommandResultArtifact,
  CanonicalCommandResultPublication,
  attachCanonicalCommandResultArtifact,
  attachCanonicalCommandResultPublications,
} from "./canonical-command-result.js";
import {
  FlowFindingsArtifact,
  readCatalogedSourceArtifact,
} from "./flow-findings.js";
import { collectUntrackedDiff } from "./run-gate.js";
import { matchUpgradeRequiredSourcePaths, validateCanonicalUpgradeEvidence } from "./test-artifacts.js";
import { ReviewFindingCycle } from "./finding-disposition-policy.js";
import { TaskReviewConvergenceEvidence } from "./review-recurrence.js";

const REVIEW_NODE_ID = "acceptance-review";
const DECISION_NODE_ID = "acceptance-decision";
const DECISION_CHOICES = new Set(["accept_risk_and_continue", "abort"]);
const MAX_CANONICAL_ACCEPTANCE_DIFF_CHARS = 900_000;
const REQUIRED_EVIDENCE = Object.freeze([
  Object.freeze({ logicalKey: "test.execute", alias: "test-execute-result.json" }),
  Object.freeze({ logicalKey: "test.result.review", alias: "test-result-review.json" }),
  Object.freeze({ logicalKey: "impl.review", alias: "impl-review.json" }),
  Object.freeze({ logicalKey: "impl.gate", alias: "impl-gate-result.json" }),
  Object.freeze({ logicalKey: "retro", alias: "retro.json", history: false }),
]);

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function jsonObject(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return value;
}

function canonicalState(state) {
  if (state?.schemaRevision !== 3 || typeof state.specId !== "string" || state.specId === "") {
    throw new Error("canonical acceptance requires a Version-1 Flow state");
  }
  return state;
}

function jsonFromBytes(bytes, field) {
  if (!Buffer.isBuffer(bytes)) throw new Error(`${field} bytes must be a Buffer`);
  try {
    return jsonObject(JSON.parse(bytes.toString("utf8")), field);
  } catch (error) {
    throw new Error(`${field} must be JSON: ${error.message}`);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function isCanonicalFlowPath(relativePath, location) {
  const canonicalRoot = location.relativeDirectory;
  return relativePath === canonicalRoot || relativePath.startsWith(`${canonicalRoot}/`);
}

async function canonicalDiff({ root, state, location }) {
  const baseBranch = state.baseBranch || state.execution?.baseBranch || "HEAD";
  const baseRef = resolveMergeBase(root, baseBranch);
  const excludedSpec = `:(exclude)${location.relativeDirectory}/**`;
  const result = runGit([
    "diff",
    "--no-ext-diff",
    "--no-color",
    baseRef,
    "--",
    ".",
    excludedSpec,
  ], { cwd: root });
  if (!result.ok) throw new Error(`failed to build canonical acceptance diff: ${result.stderr || result.stdout}`);
  const untracked = await collectUntrackedDiff(root, {
    maxFileSize: MAX_CANONICAL_ACCEPTANCE_DIFF_CHARS,
    excludeFile: (relativePath) => isCanonicalFlowPath(relativePath, location),
  });
  const diff = `${result.stdout}${untracked}`;
  if (diff.length > MAX_CANONICAL_ACCEPTANCE_DIFF_CHARS) {
    throw new Error(`canonical acceptance diff exceeds ${MAX_CANONICAL_ACCEPTANCE_DIFF_CHARS} characters`);
  }
  return diff;
}

function blocker(blockers, kind, summary, detail = null) {
  blockers.push(new MechanicalBlocker({
    blockerId: `M-${blockers.length + 1}`,
    kind,
    summary,
    ...(detail == null ? {} : { detail }),
  }).toJSON());
}

function currentGateEvidence(payload) {
  const source = jsonObject(payload, "canonical impl gate result");
  const artifacts = source.artifacts && typeof source.artifacts === "object" && !Array.isArray(source.artifacts)
    ? source.artifacts
    : {};
  return Object.freeze({
    verdict: source.result ?? artifacts.verdict ?? null,
    phase: artifacts.phase ?? null,
    issues: Array.isArray(artifacts.issues) ? structuredClone(artifacts.issues) : [],
    evaluations: Array.isArray(artifacts.evaluations) ? structuredClone(artifacts.evaluations) : [],
    observations: Array.isArray(artifacts.observations) ? structuredClone(artifacts.observations) : [],
  });
}

/**
 * The acceptance worker's evidence object is an established agent boundary.
 * Its path-valued fields remain logical pre-V1 input names even though the
 * bytes now come from Version-1 catalog entries.  These are display/input
 * references only: no persistence reader or writer resolves them.
 */
class CanonicalAcceptanceInputPaths {
  constructor(location) {
    if (!location || typeof location.specRoot !== "string" || !location.specId) {
      throw new Error("canonical acceptance input paths require a Version location");
    }
    this.specDirectory = path.posix.join(location.specRoot, location.specId.toString());
    this.testExecuteResult = path.posix.join(this.specDirectory, "test-execute-result.json");
    this.testExecuteRawOutput = path.posix.join(this.specDirectory, "tests/.raw/test-execution.log");
    Object.freeze(this);
  }

  projectTestExecute(payload, location) {
    return this.#replace(payload, {
      raw_output_path: [location.relativeArtifact("test.execute.raw-log"), this.testExecuteRawOutput],
    });
  }

  projectTestResultReview(payload, location) {
    return this.#replace(payload, {
      result_file_path: [location.relativeArtifact("test.execute"), this.testExecuteResult],
      raw_output_path: [location.relativeArtifact("test.execute.raw-log"), this.testExecuteRawOutput],
    });
  }

  #replace(payload, replacements) {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
    const projected = structuredClone(payload);
    for (const [field, [canonicalPath, inputPath]] of Object.entries(replacements)) {
      if (projected[field] === canonicalPath) projected[field] = inputPath;
    }
    return Object.freeze(projected);
  }
}

function decisionEntry({ state, reviewAttempt, review, choice, decidedAt }) {
  return Object.freeze({
    issueLogId: `acceptance-decision-${state.flowId}-${reviewAttempt}-${choice}`,
    step: DECISION_NODE_ID,
    reason: "User explicitly selected accept_risk_and_continue for unresolved acceptance risk.",
    trigger: "flow set acceptance-decision",
    resolution: "Continue to final-regression with the explicitly accepted acceptance risk.",
    taskId: null,
    timestamp: decidedAt,
    acceptanceReviewAttempt: reviewAttempt,
    repairFingerprint: review.repairFingerprint,
  });
}

function appendIssueLog(document, entry) {
  const entries = Array.isArray(document?.entries) ? structuredClone(document.entries) : [];
  const existing = entries.find((candidate) => candidate?.issueLogId === entry.issueLogId) ?? null;
  if (existing !== null) return Object.freeze({ entries, appended: false });
  entries.push(structuredClone(entry));
  return Object.freeze({ entries, appended: true });
}

/** Catalog-only durable inputs for the acceptance worker and decision command. */
export class CanonicalAcceptanceArtifactStore {
  constructor({ flowManager, state, nodeId = REVIEW_NODE_ID } = {}) {
    if (!flowManager
      || typeof flowManager.readArtifact !== "function"
      || typeof flowManager.readCatalogArtifact !== "function"
      || typeof flowManager.artifactCatalog !== "function"
      || typeof flowManager.activityLedger !== "function"
      || typeof flowManager.specLocation !== "function") {
      throw new Error("CanonicalAcceptanceArtifactStore requires the canonical FlowManager surface");
    }
    this.flowManager = flowManager;
    this.state = canonicalState(state);
    this.nodeId = requiredText(nodeId, "canonical acceptance consumer nodeId");
    this.specId = this.state.specId;
    this.location = flowManager.specLocation(this.specId);
    Object.freeze(this);
  }

  readDocument(logicalKey, { optional = false, consumerNodeId = this.nodeId } = {}) {
    const resolved = this.flowManager.readArtifact({
      specId: this.specId,
      logicalKey,
      consumerNodeId,
      optional,
    });
    if (resolved === null) return null;
    return Object.freeze({
      relativePath: resolved.relativePath,
      descriptor: resolved.descriptor,
      value: Object.freeze(structuredClone(jsonFromBytes(resolved.bytes, `canonical ${logicalKey}`))),
    });
  }

  readCurrentAttempt(logicalKey, { optional = false, consumerNodeId = this.nodeId } = {}) {
    const document = this.readDocument(logicalKey, { optional, consumerNodeId });
    if (document === null) return null;
    const history = CanonicalCommandAttemptArtifactHistory.fromBytes({
      logicalKey,
      bytes: Buffer.from(`${JSON.stringify(document.value)}\n`, "utf8"),
    });
    return Object.freeze({
      attempt: history.current.attempt,
      relativePath: document.relativePath,
      descriptor: document.descriptor,
      payload: Object.freeze(structuredClone(history.current.payload)),
    });
  }

  spec() {
    return this.readDocument("spec.record").value;
  }

  issueLog() {
    return this.readDocument("issue.log", { optional: true })?.value ?? Object.freeze({ entries: [] });
  }

  fingerprint({ diff }) {
    const catalog = this.flowManager.artifactCatalog(this.specId);
    const descriptors = catalog.artifacts.map((entry) => entry.toJSON()).sort((left, right) => (
      left.relativePath.localeCompare(right.relativePath)
    ));
    return digest({
      flowId: this.state.flowId,
      flowVersionId: this.state.flowVersionId,
      runId: this.state.runId,
      request: this.state.request,
      diff,
      descriptors,
    });
  }

  deferredFindings(blockers) {
    const flowFindings = this.readDocument("flow.findings", { optional: true });
    if (flowFindings === null) return Object.freeze({ findings: [], evidence: [] });
    const stored = new FlowFindingsArtifact(flowFindings.value);
    const findings = [];
    const evidence = [];
    for (const entry of stored.entries) {
      if (entry.runId !== null && entry.runId !== this.state.runId) continue;
      const finding = {
        findingId: entry.findingId,
        sourceStep: entry.sourceStep,
        sourceArtifact: entry.sourceArtifact,
        sourceFindingId: entry.sourceFindingId,
        finalDisposition: entry.finalDisposition ?? "still_open",
        evidenceRefs: [],
      };
      findings.push(finding);
      let source = null;
      try {
        source = readCatalogedSourceArtifact({
          flowManager: this.flowManager,
          flowState: this.state,
          nodeId: this.nodeId,
          sourceArtifact: finding.sourceArtifact,
        });
      } catch (_) {
        source = null;
      }
      const sourceFinding = source === null
        ? null
        : source.findFinding(finding.sourceStep, finding.sourceFindingId);
      if (sourceFinding === null) {
        blocker(
          blockers,
          "missing_deferred_source",
          `Deferred source evidence is missing: ${finding.sourceArtifact}#${finding.sourceFindingId}.`,
        );
        continue;
      }
      evidence.push({
        findingId: finding.findingId,
        sourceRef: `${finding.sourceArtifact}#${finding.sourceFindingId}`,
        sourceFinding,
      });
    }
    return Object.freeze({ findings: Object.freeze(findings), evidence: Object.freeze(evidence) });
  }

  /** Derive, rather than persist, fourth-review handoffs for final judgment. */
  taskReviewHandoffs() {
    const cycle = ReviewFindingCycle.fromActivityLedger({
      runId: this.state.runId,
      activities: this.flowManager.activityLedger(this.specId),
    });
    return new TaskReviewConvergenceEvidence({ flowManager: this.flowManager, state: this.state, cycle }).handoffs();
  }

  async buildContext({ executionRoot }) {
    const root = requiredText(executionRoot, "canonical acceptance executionRoot");
    const spec = this.spec();
    const requirements = Array.isArray(spec.requirements) ? structuredClone(spec.requirements) : [];
    const requirementIds = requirements.map((entry) => entry?.id).filter((id) => typeof id === "string" && id !== "");
    const blockers = [];
    if (requirementIds.length !== requirements.length || new Set(requirementIds).size !== requirementIds.length) {
      blocker(blockers, "invalid_spec", "Canonical spec requirements must have unique non-empty ids.");
    }
    if (this.state.request.trim() === "") {
      blocker(blockers, "missing_request", "The original flow request is missing.");
    }
    const diff = await canonicalDiff({ root, state: this.state, location: this.location });
    const inputs = Object.fromEntries(REQUIRED_EVIDENCE.map((entry) => [entry.logicalKey, null]));
    for (const entry of REQUIRED_EVIDENCE) {
      const value = entry.history === false
        ? this.readDocument(entry.logicalKey, { optional: true })?.value ?? null
        : this.readCurrentAttempt(entry.logicalKey, { optional: true })?.payload ?? null;
      inputs[entry.logicalKey] = value;
      if (value === null) blocker(blockers, "missing_artifact", `Required artifact is missing: ${entry.alias}.`);
    }
    const testExecute = inputs["test.execute"];
    if (testExecute !== null && (!Array.isArray(testExecute.summary) || testExecute.summary.some((entry) => entry?.result === "fail"))) {
      blocker(blockers, "failed_tests", "Test evidence contains failures.");
    }
    if (inputs["test.result.review"]?.verdict !== "pass") {
      blocker(blockers, "failed_tests", "Test-result-review evidence is not passing.");
    }
    if (!["PASS", "ADVISORY"].includes(inputs["impl.review"]?.verdict)) {
      blocker(blockers, "failed_review", "Implementation review evidence is not passing.");
    }
    const implGate = inputs["impl.gate"] === null ? null : currentGateEvidence(inputs["impl.gate"]);
    if (implGate?.verdict !== "pass") {
      blocker(blockers, "failed_gate", "Implementation gate evidence is not passing.");
    }
    if (Number(inputs.retro?.summary?.not_done || 0) > 0) {
      blocker(blockers, "failed_retro", "Retrospective evidence contains requirements that are not done.");
    }
    const deferred = this.deferredFindings(blockers);
    const taskReviewHandoffs = this.taskReviewHandoffs();
    const repair = this.readDocument("impl.repair", { optional: true })?.value ?? null;
    const upgrade = this.readDocument("upgrade.result", { optional: true })?.value ?? null;
    const upgradeValidation = validateCanonicalUpgradeEvidence({
      flowManager: this.flowManager,
      state: this.state,
      consumerNodeId: REVIEW_NODE_ID,
      root,
      currentRequiredPaths: matchUpgradeRequiredSourcePaths(changedPathsFromDiff(diff)),
    });
    if (!upgradeValidation.ok) blocker(blockers, "invalid_upgrade", `Upgrade result evidence is invalid: ${upgradeValidation.reason}`);
    const inputPaths = new CanonicalAcceptanceInputPaths(this.location);
    const evidenceArtifacts = {
      "test-execute-result.json": inputPaths.projectTestExecute(testExecute, this.location),
      "test-result-review.json": inputPaths.projectTestResultReview(inputs["test.result.review"], this.location),
      "impl-review.json": inputs["impl.review"],
      "impl-gate-result.json": implGate,
      "retro.json": inputs.retro,
    };
    return Object.freeze({
      fingerprint: Object.freeze({ hash: this.fingerprint({ diff }) }),
      requirementIds: Object.freeze(requirementIds),
      mechanicalBlockers: Object.freeze(blockers),
      deferredFindings: deferred.findings,
      evidence: Object.freeze({
        originalRequest: this.state.request,
        requirements,
        diff,
        repairEvidence: repair === null
          ? { kind: "no-repair", ref: "acceptance:no-repair", artifact: { reason: "No implementation repair was required." } }
          : { kind: "repair-audit", ref: "impl-repair.json", artifact: repair },
        upgradeEvidence: {
          required: upgradeValidation.currentRequiredPaths.length > 0,
          requiredPaths: upgradeValidation.currentRequiredPaths,
          valid: upgradeValidation.ok,
          ref: upgrade === null ? null : "upgrade-result.json",
          artifact: upgrade,
          invalidReason: upgradeValidation.ok ? null : upgradeValidation.reason,
        },
        testEvidence: new AcceptanceTestEvidenceProjection(evidenceArtifacts).toJSON(),
        reviewEvidence: inputs["impl.review"]?.canonicalEvidence ?? null,
        taskReviewHandoffs: taskReviewHandoffs.map((handoff) => handoff.toJSON()),
        deferredFindings: deferred.findings,
        deferredFindingEvidence: deferred.evidence,
      }),
    });
  }
}

/** Attach a validated acceptance result and its disposition evidence to one Attempt. */
export class CanonicalAcceptanceReviewPromotion {
  constructor({ state, requirementIds } = {}) {
    this.state = canonicalState(state);
    if (this.state.currentNodeId !== REVIEW_NODE_ID) {
      throw new Error("canonical acceptance review requires its active Attempt");
    }
    if (!Array.isArray(requirementIds)) throw new Error("canonical acceptance review requirementIds are required");
    this.requirementIds = Object.freeze([...requirementIds]);
    Object.freeze(this);
  }

  promote(result, artifact) {
    jsonObject(result, "canonical acceptance command result");
    const normalized = validateAcceptanceReviewArtifact(structuredClone(artifact), {
      requirementIds: this.requirementIds,
    });
    attachCanonicalCommandResultArtifact(result, new CanonicalCommandResultArtifact({
      logicalKey: "acceptance.review",
      payload: normalized,
    }));
    attachCanonicalCommandResultPublications(result, [new CanonicalCommandResultPublication({
      logicalKey: "acceptance.review.evidence",
      mediaType: "application/json",
      payload: {
        version: 1,
        deferredFindingDispositions: normalized.deferredFindings.map((finding) => ({
          findingId: finding.findingId,
          finalDisposition: finding.finalDisposition,
          evidenceRefs: structuredClone(finding.evidenceRefs),
        })),
      },
    })]);
    return result;
  }
}

/** Immutable user-decision result for an acceptance review that requires risk acknowledgement. */
export class CanonicalAcceptanceDecision {
  constructor({ flowManager, state, choice } = {}) {
    if (!flowManager || typeof flowManager.readArtifact !== "function") {
      throw new Error("canonical acceptance decision requires FlowManager.readArtifact");
    }
    this.flowManager = flowManager;
    this.state = canonicalState(state);
    this.choice = requiredText(choice, "acceptance decision choice");
    if (!DECISION_CHOICES.has(this.choice)) throw new Error(`invalid acceptance decision choice: ${this.choice}`);
    if (this.state.currentNodeId !== DECISION_NODE_ID) {
      throw new Error("canonical acceptance decision requires its active Attempt");
    }
    this.store = new CanonicalAcceptanceArtifactStore({ flowManager, state, nodeId: DECISION_NODE_ID });
    Object.freeze(this);
  }

  resolve() {
    const review = this.store.readCurrentAttempt("acceptance.review", {
      consumerNodeId: DECISION_NODE_ID,
    });
    const spec = this.store.spec();
    const requirements = Array.isArray(spec.requirements) ? spec.requirements : [];
    const requirementIds = requirements.map((entry) => entry?.id).filter((id) => typeof id === "string" && id !== "");
    const acceptance = validateAcceptanceReviewArtifact(review.payload, { requirementIds });
    if (acceptance.verdict !== "user_decision_required") {
      throw new Error(`acceptance-decision is not available for verdict: ${acceptance.verdict}`);
    }
    const decidedAt = new Date().toISOString();
    const userDecision = Object.freeze({ choice: this.choice, decidedAt });
    const result = {
      result: "ok",
      verdict: acceptance.verdict,
      choice: this.choice,
      userDecision,
    };
    attachCanonicalCommandResultArtifact(result, new CanonicalCommandResultArtifact({
      logicalKey: "acceptance.decision",
      payload: {
        version: 1,
        choice: this.choice,
        decidedAt,
        acceptanceReviewAttempt: review.attempt,
        acceptanceReviewDigest: review.descriptor.hash,
        repairFingerprint: acceptance.repairFingerprint,
      },
    }));
    if (this.choice === "accept_risk_and_continue") {
      const entry = decisionEntry({
        state: this.state,
        reviewAttempt: review.attempt,
        review: acceptance,
        choice: this.choice,
        decidedAt,
      });
      const nextLog = appendIssueLog(this.store.issueLog(), entry);
      attachCanonicalCommandResultPublications(result, [new CanonicalCommandResultPublication({
        logicalKey: "issue.log",
        mediaType: "application/json",
        payload: { entries: nextLog.entries },
      })]);
    }
    return result;
  }
}

export async function canonicalAcceptanceDiff({ flowManager, state, executionRoot } = {}) {
  const store = new CanonicalAcceptanceArtifactStore({ flowManager, state });
  return canonicalDiff({ root: executionRoot, state: store.state, location: store.location });
}
