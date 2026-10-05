/**
 * src/flow/lib/run-test-result-review.js
 *
 * Deterministically validates test-execute-result.json v2 against raw output,
 * spec-local test files, and the project regression contract.
 */

import { FlowCommand } from "./base-command.js";
import {
  MAX_RAW_OUTPUT_BYTES,
  validateSummaryEvidence,
  validateTestExecuteResultEvidence,
  validateTestExecuteResultV2,
  IntegrationArtifactFingerprintAuthority,
} from "./test-artifacts.js";
import { contractFromTestResultReviewArtifact } from "./flow-judgment-contract.js";
import {
  CanonicalTestArtifactStore,
  CanonicalTestExecutionObservation,
  canonicalRawEvidenceFingerprint,
  isCanonicalFlowState,
} from "./canonical-test-artifacts.js";
import { attachCanonicalCommandResultArtifact } from "./canonical-command-result.js";
import { admitTestChainDirectExecution } from "./test-chain-transition-facts.js";

function pass(check, detail) {
  return { check, result: "pass", detail };
}

function fail(check, detail) {
  return { check, result: "fail", detail };
}

function validateSummary(result, { root, rawOutputText, rawLines, requirements, hasRawOutput }) {
  try {
    validateSummaryEvidence(result.summary, {
      root,
      rawText: rawOutputText,
      rawLines,
      requirements,
      validateRawOutputRange: hasRawOutput,
    });
  } catch (err) {
    return fail("summary_evidence", err.message);
  }
  return pass("summary_evidence", "summary membership, executable test evidence, no-tests decisions, commands, raw ranges, and output ids are valid");
}

function validateRegressionRawRange(result, rawLines, hasRawOutput) {
  if (!hasRawOutput) return pass("raw_output_lines", "raw diagnostic is absent; structured regression facts remain authoritative");
  const regression = result.regression;
  if (regression.required) {
    const range = regression.raw_output_lines;
    if (!range || range.end_line > rawLines.length) {
      return fail("project_regression_verification", "regression.raw_output_lines is outside raw output");
    }
  }
  return pass("raw_output_lines", "regression line range is within raw output");
}

function validateProjectRegression(result, { root, rawOutputText, rawLines, requirements, hasRawOutput }) {
  try {
    validateTestExecuteResultEvidence(result, {
      root, rawOutputText, rawLines, requirements, summary: false,
      validateRawOutputRange: hasRawOutput,
    });
  } catch (err) {
    return fail("project_regression_verification", err.message);
  }
  return pass("project_regression_verification", "project regression evidence is valid; impl-gate owns blocking on regression.result fail");
}

/**
 * Consume the durable test-execute attempts[] result and optional transient
 * raw diagnostic through the Version Store.  No Markdown view is generated:
 * the structured review attempt is the durable authority.
 */
function executeCanonicalTestResultReview(ctx) {
  const store = new CanonicalTestArtifactStore({ flowManager: ctx.flowManager, state: ctx.flowState });
  const repositoryRoot = store.location.repositoryRoot;
  const spec = store.readSpec("test-result-review");
  const execution = store.readCurrentAttempt({
    logicalKey: "test.execute",
    consumerNodeId: "test-result-review",
  });
  const loadedResult = execution.payload;
  const producer = store.flowManager.activityLedger(store.specId)
    .find((activity) => activity.id === execution.descriptor.activityId) ?? null;
  const executionObservation = new CanonicalTestExecutionObservation({
    historyAttempt: execution.attempt,
    producerActivityId: execution.descriptor.activityId,
    attemptId: producer?.attemptId,
    sequence: producer?.sequence,
  });
  const raw = store.readRaw({
    logicalKey: "test.execute.raw-log",
    consumerNodeId: "test-result-review",
    optional: true,
  });
  const rawOutputText = raw === null ? "" : readRawOutputBytes(raw.bytes);
  const rawEvidenceFingerprint = canonicalRawEvidenceFingerprint(raw?.bytes ?? Buffer.alloc(0));
  const rawLines = raw === null ? [] : rawOutputText.split(/\r?\n/);
  const requirements = Array.isArray(spec.requirements) ? spec.requirements : [];
  const evidenceContext = {
    root: repositoryRoot,
    rawOutputText,
    rawLines,
    requirements,
    hasRawOutput: raw !== null,
  };
  const resultRelativePath = execution.relativePath;
  const rawRelativePath = raw?.relativePath ?? store.location.relativeArtifact("test.execute.raw-log");
  let review;
  try {
    validateTestExecuteResultV2(loadedResult);
  } catch (err) {
    review = {
      verdict: "fail",
      checked_items: [fail("test_execute_artifact", `test artifact invalid: ${err.message}`)],
      invalid_reason: `test artifact invalid: ${err.message}`,
      result_file_path: resultRelativePath,
      raw_output_path: rawRelativePath,
    };
  }
  if (review === undefined) {
    const checked_items = [
      validateSummary(loadedResult, evidenceContext),
      validateRegressionRawRange(loadedResult, rawLines, raw !== null),
      validateProjectRegression(loadedResult, evidenceContext),
    ];
    const failed = checked_items.filter((item) => item.result !== "pass");
    review = {
      verdict: failed.length === 0 ? "pass" : "fail",
      checked_items,
      ...(failed.length ? { invalid_reason: failed.map((item) => item.detail).join("; ") } : {}),
      result_file_path: resultRelativePath,
      raw_output_path: rawRelativePath,
    };
  }
  review.repairFingerprint = loadedResult.repairFingerprint;
  review.testSourceRevision = loadedResult.testSourceRevision;
  review.testExecute = executionObservation.toJSON();
  review.rawEvidenceFingerprint = rawEvidenceFingerprint;
  new IntegrationArtifactFingerprintAuthority({ result: loadedResult, review });
  review.contractSummary = contractFromTestResultReviewArtifact(review, {
    artifactPath: store.location.relativeArtifact("test.result.review"),
  }).summary.toJSON();
  const reviewRelativePath = store.location.relativeArtifact("test.result.review");
  return attachCanonicalCommandResultArtifact({
    result: review.verdict === "pass" ? "ok" : "fail",
    changed: [reviewRelativePath],
    artifacts: {
      verdict: review.verdict,
      review_path: reviewRelativePath,
    },
  }, {
    logicalKey: "test.result.review",
    payload: review,
  });
}

function readRawOutputBytes(bytes) {
  if (!Buffer.isBuffer(bytes)) throw new Error("canonical raw output must be a Buffer");
  if (bytes.length > MAX_RAW_OUTPUT_BYTES) {
    throw new Error(`test-execute raw output exceeds max size ${MAX_RAW_OUTPUT_BYTES} bytes`);
  }
  return bytes.toString("utf8");
}

export default class RunTestResultReviewCommand extends FlowCommand {
  async execute(ctx) {
    if (isCanonicalFlowState(ctx.flowState)) {
      admitTestChainDirectExecution({ flowManager: ctx.flowManager, specId: ctx.flowState.specId, stepId: "test-result-review" });
      return executeCanonicalTestResultReview(ctx);
    }
    throw new Error("test-result-review requires a Version-1 Flow");
  }
}
