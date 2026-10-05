import crypto from "node:crypto";
import path from "node:path";
import { IMPL_GATE_RESULT_FILE } from "./test-artifacts.js";

const TARGET_ARTIFACT_FILE_BY_STEP = Object.freeze({
  "test-review": "test-review.json",
  "impl-review": "impl-review.json",
  "impl-gate": IMPL_GATE_RESULT_FILE,
  "test-result-review": "test-result-review.json",
  "acceptance-review": "acceptance-review.json",
  "final-regression": "final-regression-result.json",
});

const ALLOWED_DISPOSITIONS = Object.freeze(new Set([
  "out_of_scope",
  "transferred_to_successor",
  "accepted_risk",
  "false_positive",
]));

function requireOwn(input, field) {
  if (!Object.prototype.hasOwnProperty.call(input, field)) {
    throw new Error(`${field} is required`);
  }
}

function requireNonEmptyString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function repoRelative(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function normalizeFindings(findings) {
  if (!Array.isArray(findings)) throw new Error("blockingFindings must be an array");
  return Object.freeze(findings.map((finding) => Object.freeze({ ...(finding || {}) })));
}

export class FlowJudgmentContract {
  constructor(input = {}) {
    requireOwn(input, "targetStep");
    requireOwn(input, "artifactPath");
    requireOwn(input, "verdict");
    requireOwn(input, "blockingFindings");
    requireOwn(input, "failureKind");
    requireOwn(input, "rawArtifactPath");
    requireOwn(input, "inputFingerprint");
    requireOwn(input, "artifactFingerprint");

    this.targetStep = requireNonEmptyString(input.targetStep, "targetStep");
    this.artifactPath = requireNonEmptyString(input.artifactPath, "artifactPath");
    this.verdict = requireNonEmptyString(input.verdict, "verdict");
    this.blockingFindings = normalizeFindings(input.blockingFindings);
    if (input.failureKind !== null && typeof input.failureKind !== "string") {
      throw new Error("failureKind must be a string or null");
    }
    this.failureKind = input.failureKind;
    this.rawArtifactPath = input.rawArtifactPath === null
      ? null
      : requireNonEmptyString(input.rawArtifactPath, "rawArtifactPath");
    this.inputFingerprint = requireNonEmptyString(input.inputFingerprint, "inputFingerprint");
    this.artifactFingerprint = requireNonEmptyString(input.artifactFingerprint, "artifactFingerprint");
    Object.freeze(this);
  }

  get blockingCount() {
    return this.blockingFindings.length;
  }

  get summary() {
    const policy = StepCompletionPolicy.maybeForStep(this.targetStep);
    return new JudgmentContractSummary({
      targetStep: this.targetStep,
      artifactPath: this.artifactPath,
      verdict: this.verdict,
      result: this.verdict,
      blockingCount: this.blockingCount,
      failureKind: this.failureKind,
      completionKind: policy?.allowsNormal(this) ? "normal" : "non_normal",
      progressSignature: progressSignature(this),
    });
  }

  toJSON() {
    return {
      targetStep: this.targetStep,
      artifactPath: this.artifactPath,
      verdict: this.verdict,
      blockingFindings: this.blockingFindings,
      failureKind: this.failureKind,
      rawArtifactPath: this.rawArtifactPath,
      inputFingerprint: this.inputFingerprint,
      artifactFingerprint: this.artifactFingerprint,
      summary: this.summary.toJSON(),
    };
  }
}

export class JudgmentContractSummary {
  constructor(input = {}) {
    this.targetStep = requireNonEmptyString(input.targetStep, "targetStep");
    this.artifactPath = requireNonEmptyString(input.artifactPath, "artifactPath");
    this.verdict = requireNonEmptyString(input.verdict, "verdict");
    this.result = requireNonEmptyString(input.result, "result");
    this.blockingCount = Number(input.blockingCount);
    if (!Number.isInteger(this.blockingCount) || this.blockingCount < 0) {
      throw new Error("blockingCount must be a non-negative integer");
    }
    this.failureKind = input.failureKind;
    this.completionKind = requireNonEmptyString(input.completionKind, "completionKind");
    this.progressSignature = requireNonEmptyString(input.progressSignature, "progressSignature");
    Object.freeze(this);
  }

  toJSON() {
    return {
      targetStep: this.targetStep,
      artifactPath: this.artifactPath,
      verdict: this.verdict,
      result: this.result,
      blockingCount: this.blockingCount,
      failureKind: this.failureKind,
      completionKind: this.completionKind,
      progressSignature: this.progressSignature,
    };
  }
}

export class StepCompletionPolicy {
  constructor({ stepId, allowedVerdicts, requireNoBlocking = true, failureKind = undefined }) {
    this.stepId = requireNonEmptyString(stepId, "stepId");
    if (!Array.isArray(allowedVerdicts) || allowedVerdicts.length === 0) {
      throw new Error("allowedVerdicts must be a non-empty array");
    }
    this.allowedVerdicts = Object.freeze(allowedVerdicts.map((value) => requireNonEmptyString(value, "allowedVerdicts[]")));
    this.requireNoBlocking = Boolean(requireNoBlocking);
    this.requiredFailureKind = failureKind;
    Object.freeze(this);
  }

  allowsNormal(contract) {
    if (!(contract instanceof FlowJudgmentContract)) throw new Error("contract must be a FlowJudgmentContract");
    if (contract.targetStep !== this.stepId) return false;
    if (this.stepId === "final-regression") {
      if (contract.verdict === "pass" || contract.verdict === "skipped") {
        return contract.failureKind === null;
      }
      return contract.verdict === "fail"
        && contract.blockingCount === 0
        && typeof contract.failureKind === "string";
    }
    if (!this.allowedVerdicts.includes(contract.verdict)) return false;
    if (this.requireNoBlocking && contract.blockingCount !== 0) return false;
    if (this.requiredFailureKind !== undefined && contract.failureKind !== this.requiredFailureKind) return false;
    return true;
  }

  static defaultPolicies() {
    return new Map([
      ["test-review", new StepCompletionPolicy({ stepId: "test-review", allowedVerdicts: ["PASS", "ADVISORY"] })],
      ["impl-review", new StepCompletionPolicy({
        stepId: "impl-review",
        allowedVerdicts: ["PASS", "ADVISORY", "REJECTED"],
        requireNoBlocking: false,
      })],
      ["impl-gate", new StepCompletionPolicy({ stepId: "impl-gate", allowedVerdicts: ["pass"] })],
      ["test-result-review", new StepCompletionPolicy({ stepId: "test-result-review", allowedVerdicts: ["pass"], requireNoBlocking: false })],
      ["acceptance-review", new StepCompletionPolicy({
        stepId: "acceptance-review",
        allowedVerdicts: ["pass"],
        requireNoBlocking: true,
        failureKind: null,
      })],
      ["final-regression", new StepCompletionPolicy({
        stepId: "final-regression",
        allowedVerdicts: ["pass", "skipped"],
        requireNoBlocking: false,
        failureKind: null,
      })],
    ]);
  }

  static maybeForStep(stepId) {
    return StepCompletionPolicy.defaultPolicies().get(stepId) || null;
  }

  static forStep(stepId) {
    const policy = StepCompletionPolicy.maybeForStep(stepId);
    if (!policy) throw new Error(`no completion policy for step: ${stepId}`);
    return policy;
  }
}

export class FindingDisposition {
  constructor(input = {}) {
    this.findingId = requireNonEmptyString(input.findingId, "findingId");
    this.disposition = requireNonEmptyString(input.disposition, "disposition");
    if (!ALLOWED_DISPOSITIONS.has(this.disposition)) {
      throw new Error(`invalid disposition: ${this.disposition}`);
    }
    this.successorOwner = requireNonEmptyString(input.successorOwner, "successorOwner");
    this.acceptedRisk = requireNonEmptyString(input.acceptedRisk, "acceptedRisk");
    Object.freeze(this);
  }

  toJSON() {
    return {
      findingId: this.findingId,
      disposition: this.disposition,
      successorOwner: this.successorOwner,
      acceptedRisk: this.acceptedRisk,
    };
  }
}

export class OverrideCompletionEvidence {
  constructor(input = {}) {
    this.stepId = requireNonEmptyString(input.stepId, "stepId");
    if (input.userApproval !== true) throw new Error("userApproval must be true");
    this.userApproval = true;
    this.reason = requireNonEmptyString(input.reason, "reason");
    this.approvedAt = requireNonEmptyString(input.approvedAt, "approvedAt");
    this.approvedBy = requireNonEmptyString(input.approvedBy, "approvedBy");
    if (!Array.isArray(input.findings) || input.findings.length === 0) {
      throw new Error("findings must be a non-empty array");
    }
    this.findings = Object.freeze(input.findings.map((finding) => new FindingDisposition(finding)));
    Object.freeze(this);
  }

  appliesTo(contract) {
    return contract instanceof FlowJudgmentContract && contract.targetStep === this.stepId;
  }

  toJSON() {
    return {
      stepId: this.stepId,
      userApproval: this.userApproval,
      reason: this.reason,
      approvedAt: this.approvedAt,
      approvedBy: this.approvedBy,
      findings: this.findings.map((finding) => finding.toJSON()),
    };
  }
}

export class CompletionValidationResult {
  constructor({ kind, reason, contract, override = null }) {
    this.kind = requireNonEmptyString(kind, "kind");
    this.reason = requireNonEmptyString(reason, "reason");
    this.contract = contract;
    this.override = override;
    Object.freeze(this);
  }
}

export class CompletionValidator {
  constructor(policies = StepCompletionPolicy.defaultPolicies()) {
    if (policies instanceof Map) {
      this.policies = new Map(policies);
    } else if (Array.isArray(policies)) {
      this.policies = new Map(policies.map((policy) => [policy.stepId, policy]));
    } else {
      throw new Error("policies must be a Map or array");
    }
  }

  validate({ contract, requestedStatus, overrideEvidence = null, deferredEvidence = null }) {
    if (!(contract instanceof FlowJudgmentContract)) throw new Error("contract must be a FlowJudgmentContract");
    if (requestedStatus !== "done") {
      return new CompletionValidationResult({ kind: "normal", reason: `status ${requestedStatus} does not require completion validation`, contract });
    }
    const policy = this.policies.get(contract.targetStep);
    if (!policy) {
      return new CompletionValidationResult({ kind: "normal", reason: `no completion policy for ${contract.targetStep}`, contract });
    }
    if (policy.allowsNormal(contract)) {
      return new CompletionValidationResult({ kind: "normal", reason: "normal completion policy satisfied", contract });
    }
    if (overrideEvidence instanceof OverrideCompletionEvidence && overrideEvidence.appliesTo(contract)) {
      return new CompletionValidationResult({ kind: "override", reason: "valid override completion evidence found", contract, override: overrideEvidence });
    }
    if (deferredEvidence === true) {
      return new CompletionValidationResult({ kind: "deferred", reason: "valid deferred flow finding evidence found", contract });
    }
    return new CompletionValidationResult({
      kind: "inconsistent",
      reason: "normal completion policy failed and no valid override evidence was found",
      contract,
    });
  }
}

export function progressSignature(contract) {
  if (!(contract instanceof FlowJudgmentContract)) throw new Error("contract must be a FlowJudgmentContract");
  return fingerprint({
    targetStep: contract.targetStep,
    artifactPath: contract.artifactPath,
    verdict: contract.verdict,
    blockingCount: contract.blockingCount,
    failureKind: contract.failureKind,
    inputFingerprint: contract.inputFingerprint,
    artifactFingerprint: contract.artifactFingerprint,
  });
}

function contractInput(targetStep, artifact, opts) {
  const artifactPath = opts.artifactPath || TARGET_ARTIFACT_FILE_BY_STEP[targetStep] || `${targetStep}.json`;
  return {
    targetStep,
    artifactPath,
    rawArtifactPath: opts.rawArtifactPath || artifact.rawOutputPath || artifact.raw_output_path || artifact.coverageArtifact || artifactPath,
    inputFingerprint: opts.inputFingerprint || fingerprint({ targetStep, artifactPath }),
    artifactFingerprint: opts.artifactFingerprint || fingerprint(artifact),
  };
}

export function contractFromTestReviewArtifact(artifact, opts = {}) {
  if (artifact?.toolingOutcome) {
    throw new Error("TOOLING_ERROR outcome cannot satisfy the test-review judgment contract");
  }
  return new FlowJudgmentContract({
    ...contractInput("test-review", artifact, opts),
    verdict: artifact.verdict,
    blockingFindings: artifact.blockingFindings || [],
    failureKind: null,
  });
}

export function contractFromImplReviewArtifact(artifact, opts = {}) {
  if (!Array.isArray(artifact?.blockingFindings)) {
    throw new Error("impl-review blockingFindings must be an array");
  }
  if (!Array.isArray(artifact.nonBlockingImprovements)) {
    throw new Error("impl-review nonBlockingImprovements must be an array");
  }
  const expectedVerdict = artifact.blockingFindings.length > 0
    ? "REJECTED"
    : artifact.nonBlockingImprovements.length > 0
      ? "ADVISORY"
      : "PASS";
  if (artifact.verdict !== expectedVerdict) {
    throw new Error(`impl-review verdict must be ${expectedVerdict} for the recorded finding buckets`);
  }
  return new FlowJudgmentContract({
    ...contractInput("impl-review", artifact, opts),
    verdict: artifact.verdict,
    blockingFindings: artifact.blockingFindings,
    failureKind: null,
  });
}

export function contractFromTestResultReviewArtifact(artifact, opts = {}) {
  const failed = Array.isArray(artifact.checked_items)
    ? artifact.checked_items.filter((item) => item?.result !== "pass")
    : [];
  return new FlowJudgmentContract({
    ...contractInput("test-result-review", artifact, opts),
    verdict: artifact.verdict,
    blockingFindings: failed,
    failureKind: artifact.verdict === "pass" ? null : "invalid_test_result",
    rawArtifactPath: opts.rawArtifactPath || artifact.raw_output_path,
  });
}

export function contractFromFinalRegressionArtifact(artifact, opts = {}) {
  const failedRecorded = artifact.result === "fail"
    && artifact.completed === true
    && artifact.selectedAction === "explicit-record-and-proceed"
    && artifact.recordAndProceed?.validated === true;
  const blockingFindings = artifact.result === "pass" || artifact.result === "skipped" || failedRecorded
    ? []
    : [{ failureKind: artifact.failureKind }];
  return new FlowJudgmentContract({
    ...contractInput("final-regression", artifact, opts),
    verdict: artifact.result,
    blockingFindings,
    failureKind: artifact.failureKind,
    rawArtifactPath: opts.rawArtifactPath || artifact.rawOutputPath,
  });
}

export function contractFromAcceptanceReviewArtifact(artifact, opts = {}) {
  const mechanical = Array.isArray(artifact.mechanicalBlockers) ? artifact.mechanicalBlockers : [];
  const hard = Array.isArray(artifact.hardBlockers) ? artifact.hardBlockers : [];
  return new FlowJudgmentContract({
    ...contractInput("acceptance-review", artifact, opts),
    verdict: artifact.verdict,
    blockingFindings: [...mechanical, ...hard],
    failureKind: artifact.verdict === "pass" ? null : "acceptance_review_not_pass",
    rawArtifactPath: opts.rawArtifactPath || opts.artifactPath || TARGET_ARTIFACT_FILE_BY_STEP["acceptance-review"],
  });
}

export function contractFromGateArtifact(artifact, opts = {}) {
  const phase = opts.phase || artifact.phase;
  const targetStep = phase === "integration" ? "impl-gate" : `${phase}-gate`;
  const issues = Array.isArray(artifact.issues) ? artifact.issues : [];
  const failedEvaluations = Array.isArray(artifact.evaluations)
    ? artifact.evaluations.filter((item) => item?.result === "fail")
    : [];
  return new FlowJudgmentContract({
    ...contractInput(targetStep, artifact, opts),
    verdict: artifact.verdict || artifact.result,
    blockingFindings: [...issues.map((issue) => ({ issue })), ...failedEvaluations],
    failureKind: artifact.verdict === "pass" || artifact.result === "pass" ? null : "gate_failure",
    rawArtifactPath: opts.rawArtifactPath || opts.artifactPath || TARGET_ARTIFACT_FILE_BY_STEP[targetStep],
  });
}

export function withContractSummary(contract) {
  return contract.summary.toJSON();
}
