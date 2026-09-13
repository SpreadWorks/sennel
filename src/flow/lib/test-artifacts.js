import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "child_process";
import { globToRegex } from "../../lib/glob.js";
import { listChangedFilesDetailed } from "../../lib/git-helpers.js";
import { validateSchema } from "../../lib/schema-validate.js";
import { RegressionFileSnapshotList } from "./regression-file-snapshot.js";
import { RequirementTestDeferredReceipt } from "./requirement-test-artifacts.js";
import { UPGRADE_RESULT_FILE } from "./upgrade-evidence-paths.js";
import {
  UpgradeResultArtifact,
  upgradeResultFailure,
  upgradeResultSuccess,
  validateUpgradeResultArtifact,
} from "./upgrade-result-artifact.js";
export { UPGRADE_RESULT_FILE } from "./upgrade-evidence-paths.js";
export { UpgradeResultArtifact, validateUpgradeResultArtifact } from "./upgrade-result-artifact.js";

export const TEST_EXECUTE_RESULT_FILE = "test-execute-result.json";
export const TEST_RESULT_REVIEW_FILE = "test-result-review.json";
export const IMPL_GATE_RESULT_FILE = "impl-gate-result.json";
export const MAX_RAW_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_RAW_OUTPUT_LINES = 200_000;
const MAX_EVIDENCE_RAW_OUTPUT_LINES = 2_000;
const MAX_TEST_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_SUMMARY_ITEMS = 500;
const MAX_REVIEW_CHECKED_ITEMS = 500;
const SUMMARY_RESULT_VALUES = Object.freeze(["pass", "fail", "deferred", "not_applicable"]);
const SUMMARY_NO_TESTS_REASON = "no_tests_declared";
const FINAL_REGRESSION_SKIP_KINDS = Object.freeze([
  "covered_by_test_execute_full_regression",
  "skipped_by_project_policy",
]);
const REPAIR_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;
const ARTIFACT_SCHEMA_DIRECTORY = fileURLToPath(new URL("../schemas/", import.meta.url));
const artifactSchemas = new Map();

/**
 * The checked-in JSON schema is the structural contract at every producer
 * and publication boundary. Semantic validators below deliberately add only
 * evidence and cross-artifact invariants; they never grow a competing shape.
 */
function validateArtifactSchema(value, schemaFile, label) {
  let schema = artifactSchemas.get(schemaFile);
  if (schema === undefined) {
    schema = JSON.parse(fs.readFileSync(path.join(ARTIFACT_SCHEMA_DIRECTORY, schemaFile), "utf8"));
    artifactSchemas.set(schemaFile, schema);
  }
  const errors = validateSchema(value, schema);
  if (errors.length > 0) throw new Error(`${label} schema validation failed: ${errors.join("; ")}`);
  return value;
}

export function validateTestExecuteResultShape(result) {
  return validateArtifactSchema(result, "test-execute-result.schema.json", "test-execute-result.json");
}

export function validateTestResultReviewShape(review) {
  return validateArtifactSchema(review, "test-result-review.schema.json", "test-result-review.json");
}

/**
 * Review verdicts are derived from checked observations.  A failed project
 * regression is itself an implementation-gate concern, while this review
 * records whether its evidence is structurally usable; therefore no
 * individual check is privileged here.
 */
export function validateTestResultReviewObservationCoherence(review) {
  if (!review || typeof review !== "object" || !Array.isArray(review.checked_items)) {
    throw new Error("test-result-review observations require checked_items[]");
  }
  if (review.checked_items.length === 0) {
    throw new Error("test-result-review must provide at least one checked observation");
  }
  const names = new Set();
  let hasFailedObservation = false;
  for (const item of review.checked_items) {
    if (!item || typeof item.check !== "string" || item.check.trim() === "") {
      throw new Error("test-result-review checked_items[].check must be non-empty");
    }
    if (item.result !== "pass" && item.result !== "fail") {
      throw new Error("test-result-review checked_items[].result must be pass or fail");
    }
    if (names.has(item.check)) {
      throw new Error(`test-result-review checked_items[] contains duplicate check: ${item.check}`);
    }
    names.add(item.check);
    hasFailedObservation ||= item.result === "fail";
  }
  const expectedVerdict = hasFailedObservation ? "fail" : "pass";
  if (review.verdict !== expectedVerdict) {
    throw new Error(`test-result-review verdict must be ${expectedVerdict} for its checked observations`);
  }
  return review;
}

export const UPGRADE_REQUIRED_SOURCE_PATTERNS = Object.freeze([
  "src/upgrade.js",
  "src/skills/**",
  "src/presets/**",
  "src/templates/**",
  "src/lib/skills.js",
  "src/lib/include.js",
  "src/lib/skill-rules.js",
  "src/docs/lib/directive-parser.js",
  "src/lib/preset-deploy.js",
  "src/lib/presets.js",
  "src/lib/agent-defaults.js",
  "src/lib/config.js",
]);
function normalizeRepoPath(filePath) {
  return String(filePath || "").split(path.sep).join("/");
}

const UPGRADE_REQUIRED_SOURCE_MATCHERS = Object.freeze(
  UPGRADE_REQUIRED_SOURCE_PATTERNS.map((pattern) => globToRegex(pattern)),
);

export function matchUpgradeRequiredSourcePaths(filePaths = []) {
  return [...new Set(filePaths
    .map(normalizeRepoPath)
    .filter((filePath) => UPGRADE_REQUIRED_SOURCE_MATCHERS.some((matcher) => matcher.test(filePath))))]
    .sort();
}

export function listUpgradeRequiredChangedPaths({ root, baseBranch }) {
  if (!baseBranch) return [];
  const files = listChangedFilesDetailed({ cwd: root, baseBranch })
    .flatMap((entry) => [entry.path, entry.old_path].filter(Boolean));
  return matchUpgradeRequiredSourcePaths(files);
}


export function createUpgradeResultArtifact({
  root,
  baseBranch,
  command,
  dryRun,
  exitCode,
  result,
  summary,
}) {
  const checkedPaths = listUpgradeRequiredChangedPaths({ root, baseBranch });
  return new UpgradeResultArtifact({ command, dryRun, exitCode, result, summary, checkedPaths });
}

/**
 * Resolve Version-1 upgrade evidence only through the active artifact
 * catalog.  There is deliberately no sibling-file fallback for a canonical
 * Flow: catalog absence is missing evidence.
 */
export function validateCanonicalUpgradeEvidence({
  flowManager,
  state,
  consumerNodeId,
  root = null,
  baseBranch = state?.baseBranch ?? null,
  currentRequiredPaths = null,
} = {}) {
  if (!flowManager || typeof flowManager.readArtifact !== "function") {
    throw new Error("canonical upgrade evidence requires FlowManager.readArtifact");
  }
  if (!state?.specId || state.schemaRevision !== 3) {
    throw new Error("canonical upgrade evidence requires a Version-1 Flow state");
  }
  const requiredPaths = currentRequiredPaths
    ? matchUpgradeRequiredSourcePaths(currentRequiredPaths)
    : listUpgradeRequiredChangedPaths({ root, baseBranch });
  if (requiredPaths.length === 0) return upgradeResultSuccess({ currentRequiredPaths: requiredPaths });
  const resolved = flowManager.readArtifact({
    specId: state.specId,
    logicalKey: "upgrade.result",
    consumerNodeId,
    optional: true,
  });
  if (resolved === null) return upgradeResultFailure(`${UPGRADE_RESULT_FILE} missing`, { currentRequiredPaths: requiredPaths });
  let artifact;
  try {
    artifact = JSON.parse(resolved.bytes.toString("utf8"));
  } catch (error) {
    return upgradeResultFailure(`${UPGRADE_RESULT_FILE} must be JSON: ${error.message}`, { currentRequiredPaths: requiredPaths });
  }
  const validation = validateUpgradeResultArtifact(artifact);
  if (!validation.ok) return upgradeResultFailure(validation.reason, { currentRequiredPaths: requiredPaths });
  if (validation.artifact.dryRun) {
    return upgradeResultFailure("upgrade-result.json dryRun evidence cannot satisfy a materialized upgrade requirement", {
      currentRequiredPaths: requiredPaths,
    });
  }
  if (validation.artifact.result === "failed") {
    return upgradeResultFailure("upgrade-result.json result=failed", { currentRequiredPaths: requiredPaths });
  }
  if (JSON.stringify(validation.artifact.checkedPaths) !== JSON.stringify(requiredPaths)) {
    return upgradeResultFailure("upgrade-result.json checkedPaths is stale", {
      currentRequiredPaths: requiredPaths,
      checkedPaths: validation.artifact.checkedPaths,
    });
  }
  return upgradeResultSuccess({
    currentRequiredPaths: requiredPaths,
    artifact: validation.artifact,
    relativePath: resolved.relativePath,
  });
}

export class IntegrationArtifactFingerprintAuthority {
  constructor({ result, review }) {
    const resultFingerprint = result?.repairFingerprint;
    const reviewFingerprint = review?.repairFingerprint;
    if (!REPAIR_FINGERPRINT_PATTERN.test(resultFingerprint || "")) {
      throw new Error(
        `${TEST_EXECUTE_RESULT_FILE} repairFingerprint must be a 64-character SHA-256 digest`,
      );
    }
    if (!REPAIR_FINGERPRINT_PATTERN.test(reviewFingerprint || "")) {
      throw new Error(
        `${TEST_RESULT_REVIEW_FILE} repairFingerprint must be a 64-character SHA-256 digest`,
      );
    }
    if (resultFingerprint !== reviewFingerprint) {
      throw new Error("test artifacts have inconsistent repairFingerprint values");
    }
    this.fingerprint = resultFingerprint;
    this.result = result;
    this.review = review;
    Object.freeze(this);
  }

  toArtifactMap() {
    return new Map([
      [TEST_EXECUTE_RESULT_FILE, this.result],
      [TEST_RESULT_REVIEW_FILE, this.review],
    ]);
  }
}

export function readJsonStrict(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(`${path.basename(filePath)} is not valid JSON: ${err.message}`);
  }
}

function assertFileSizeWithinLimit(filePath, label, maxBytes) {
  const size = fs.statSync(filePath).size;
  if (size > maxBytes) {
    throw new Error(`${label} exceeds max size ${maxBytes} bytes`);
  }
}

function assertMaxItems(label, items, maxItems) {
  if (items.length > maxItems) {
    throw new Error(`${label} exceeds max item count ${maxItems}`);
  }
}

function readBoundedText(filePath, label, maxBytes) {
  assertFileSizeWithinLimit(filePath, label, maxBytes);
  return fs.readFileSync(filePath, "utf8");
}

function resolveRepoRelativePathInside({ root, allowedBaseDir, relPath, label, mustExist = true }) {
  if (typeof relPath !== "string" || relPath.trim().length === 0) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  if (path.isAbsolute(relPath)) {
    throw new Error(`${label} must be relative: ${relPath}`);
  }
  const resolved = path.resolve(root, relPath);
  const relToBase = path.relative(allowedBaseDir, resolved);
  if (relToBase.startsWith("..") || path.isAbsolute(relToBase)) {
    throw new Error(`${label} escapes allowed root: ${relPath}`);
  }
  if (mustExist && !fs.existsSync(resolved)) {
    throw new Error(`${label} points to missing path: ${relPath}`);
  }
  return resolved;
}

function assertRange(range, label) {
  if (!range || typeof range !== "object") throw new Error(`${label}.raw_output_lines must be an object`);
  if (!Number.isInteger(range.start_line) || !Number.isInteger(range.end_line)) {
    throw new Error(`${label}.raw_output_lines must contain integer start_line/end_line`);
  }
  if (range.start_line < 1 || range.end_line < range.start_line) {
    throw new Error(`${label}.raw_output_lines must be 1-based inclusive range`);
  }
}

function assertCamelRange(range, label) {
  if (!range || typeof range !== "object") throw new Error(`${label}.rawOutputLines must be an object`);
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) {
    throw new Error(`${label}.rawOutputLines must contain integer start/end`);
  }
  if (range.start < 1 || range.end < range.start) {
    throw new Error(`${label}.rawOutputLines must be 1-based inclusive range`);
  }
}

function assertEvidenceRangeWithinLimit(range, label) {
  const lineCount = range.end_line - range.start_line + 1;
  if (lineCount > MAX_EVIDENCE_RAW_OUTPUT_LINES) {
    throw new Error(`${label}.raw_output_lines exceeds max evidence range ${MAX_EVIDENCE_RAW_OUTPUT_LINES}`);
  }
}

export function validateTestExecuteResultV2(result) {
  validateTestExecuteResultShape(result);
  if (!result || typeof result !== "object") throw new Error("test-execute-result.json must be an object");
  if (result.version !== "2") throw new Error(`test-execute-result.json version='${result.version}', expected '2'`);
  if (typeof result.testSourceRevision !== "string" || !REPAIR_FINGERPRINT_PATTERN.test(result.testSourceRevision)) {
    throw new Error("test-execute-result.json testSourceRevision must be a 64-character SHA-256 digest");
  }
  if (typeof result.rawEvidenceFingerprint !== "string" || !REPAIR_FINGERPRINT_PATTERN.test(result.rawEvidenceFingerprint)) {
    throw new Error("test-execute-result.json rawEvidenceFingerprint must be a 64-character SHA-256 digest");
  }
  assertProcessMetadata(result.process, "test-execute-result.json process");
  if (!Array.isArray(result.summary)) throw new Error("test-execute-result.json summary[] is required");
  assertMaxItems("test-execute-result.json summary[]", result.summary, MAX_SUMMARY_ITEMS);
  if (!result.regression || typeof result.regression !== "object") throw new Error("regression object is required");
  for (const entry of result.summary) {
    if (typeof entry.id !== "string") throw new Error("summary[].id is required");
    if (!["executed", "deferred_no_active_test"].includes(entry.execution)) {
      throw new Error(`summary[].execution invalid for ${entry.id}`);
    }
    if (!SUMMARY_RESULT_VALUES.includes(entry.result)) throw new Error(`summary[].result invalid for ${entry.id}`);
    if (entry.result === "deferred") {
      if (entry.execution !== "deferred_no_active_test") {
        throw new Error(`summary[${entry.id}].execution must be deferred_no_active_test for deferred result`);
      }
      RequirementTestDeferredReceipt.fromJSON(entry.deferred_receipt);
      continue;
    }
    if (entry.execution !== "executed") {
      throw new Error(`summary[${entry.id}].execution must be executed for active result`);
    }
    if (!entry.evidence || typeof entry.evidence !== "object") throw new Error(`summary[].evidence missing for ${entry.id}`);
    if (typeof entry.evidence.command !== "string" || entry.evidence.command.length === 0) {
      throw new Error(`summary[${entry.id}].evidence.command is required`);
    }
    assertRange(entry.evidence.raw_output_lines, `summary[${entry.id}].evidence`);
    assertEvidenceRangeWithinLimit(entry.evidence.raw_output_lines, `summary[${entry.id}].evidence`);
    if (entry.result === "not_applicable") {
      if (entry.reason !== SUMMARY_NO_TESTS_REASON) {
        throw new Error(`summary[${entry.id}].reason must be ${SUMMARY_NO_TESTS_REASON}`);
      }
      continue;
    }
    if (typeof entry.evidence.test_file !== "string" || entry.evidence.test_file.length === 0) {
      throw new Error(`summary[${entry.id}].evidence.test_file is required`);
    }
    if (typeof entry.evidence.test_name !== "string" || entry.evidence.test_name.length === 0) {
      throw new Error(`summary[${entry.id}].evidence.test_name is required`);
    }
  }
  validateRegression(result.regression);
  return result;
}

function assertProcessMetadata(processMetadata, label = "process") {
  if (!processMetadata || typeof processMetadata !== "object") throw new Error(`${label} is required`);
  if (typeof processMetadata.started !== "boolean") throw new Error(`${label}.started must be boolean`);
  if (processMetadata.exitCode !== null
    && (!Number.isSafeInteger(processMetadata.exitCode) || processMetadata.exitCode < 0)) {
    throw new Error(`${label}.exitCode must be a non-negative integer or null`);
  }
  if (processMetadata.signal !== null
    && (typeof processMetadata.signal !== "string" || processMetadata.signal === "")) {
    throw new Error(`${label}.signal must be a non-empty string or null`);
  }
  if (typeof processMetadata.timedOut !== "boolean") throw new Error(`${label}.timedOut must be boolean`);
  if (processMetadata.spawnError !== null
    && (typeof processMetadata.spawnError !== "string" || processMetadata.spawnError === "")) {
    throw new Error(`${label}.spawnError must be a non-empty string or null`);
  }
}

function assertRequiredFields(value, fields, label) {
  if (!value || typeof value !== "object") throw new Error(`${label} is required`);
  for (const field of fields) {
    if (value[field] == null) throw new Error(`${label}.${field} is required`);
  }
}

function validateRegression(regression) {
  if (typeof regression.required !== "boolean") throw new Error("regression.required must be boolean");
  if (!Array.isArray(regression.changed_files)) throw new Error("regression.changed_files[] is required");
  if (!Array.isArray(regression.trigger_relevant_changed_files)) {
    throw new Error("regression.trigger_relevant_changed_files[] is required");
  }
  RegressionFileSnapshotList.fromJSON(
    regression.changed_files,
    "regression.changed_files",
  );
  RegressionFileSnapshotList.fromJSON(
    regression.trigger_relevant_changed_files,
    "regression.trigger_relevant_changed_files",
  );
  if (regression.required) {
    for (const key of ["mode", "root_test_command", "root_test_command_source", "command", "result", "raw_output_lines"]) {
      if (regression[key] == null) throw new Error(`regression.${key} is required`);
    }
    if (!["full", "targeted"].includes(regression.mode)) throw new Error("regression.mode must be full or targeted");
    if (!["pass", "fail"].includes(regression.result)) throw new Error("regression.result must be pass or fail");
    if (regression.mode === "targeted" && !Array.isArray(regression.target_paths)) {
      throw new Error("regression.target_paths[] is required for targeted mode");
    }
    assertRange(regression.raw_output_lines, "regression");
    assertProcessMetadata(regression.process, "regression.process");
  } else {
    assertRequiredFields(regression, ["category", "reason", "classified_paths"], "regression");
    if (![
      "docs-only",
      "spec-artifact-only",
      "non-project-only",
      "mixed-non-trigger",
      "full-regression-deferred",
      "project-regression-skipped",
    ].includes(regression.category)) {
      throw new Error(`regression.category invalid: ${regression.category}`);
    }
  }
}

function validateFinalRegressionFailureKind(result) {
  if (result.result === "skipped") {
    if (result.failureKind !== null) throw new Error("final-regression failureKind must be null on skipped");
    return;
  }
  if (result.result === "pass") {
    if (result.failureKind !== null) throw new Error("final-regression failureKind must be null on pass");
    return;
  }
  const allowed = [
    "caused_by_current_change",
    "unattributed_existing_failure",
    "unattributed_unknown_failure",
    "infra_failure",
    "timeout",
    "dependency_failure",
    "sandbox_restriction",
    "permission_error",
    "child_process_eperm",
    "invalid_project_test",
  ];
  if (!allowed.includes(result.failureKind)) {
    throw new Error(`final-regression failureKind invalid: ${result.failureKind}`);
  }
}

function validateFinalRegressionRecordAndProceed(result) {
  if (Object.hasOwn(result, "nextRecommendedAction")) {
    throw new Error("final-regression nextRecommendedAction is obsolete; route through the typed Definition");
  }
  if (!Array.isArray(result.changedFileFingerprints)) {
    throw new Error("final-regression changedFileFingerprints must be array");
  }
  if (typeof result.changedFileSnapshotDigest !== "string" || !/^[a-f0-9]{64}$/.test(result.changedFileSnapshotDigest)) {
    throw new Error("final-regression changedFileSnapshotDigest must be sha256");
  }
  if (result.executionBinding?.worktreeSha256 !== undefined
    && result.executionBinding.worktreeSha256 !== result.changedFileSnapshotDigest) {
    throw new Error("final-regression changed-file snapshot does not match execution binding");
  }
  if (result.result !== "fail") {
    if (result.completed === true && result.selectedAction === "record-and-proceed") {
      throw new Error("final-regression record-and-proceed is only valid on fail");
    }
    return;
  }
  if (typeof result.failureCategory !== "string" || result.failureCategory.length === 0) {
    throw new Error("final-regression failureCategory is required on fail");
  }
  if (![
    "caused_by_current_change",
    "existing_failure",
    "unknown",
    "environment",
    "sandbox",
    "timeout",
    "dependency",
    "out_of_scope",
    "flaky_suspected",
  ].includes(result.failureCategory)) {
    throw new Error(`final-regression failureCategory invalid: ${result.failureCategory}`);
  }
  if (!["assertion", "execution"].includes(result.failureNature)) {
    throw new Error("final-regression failureNature must be assertion or execution");
  }
  if (!Number.isInteger(result.fixAttempts) || result.fixAttempts < 0) {
    throw new Error("final-regression fixAttempts must be a non-negative integer");
  }
  if (result.recordAndProceed?.eligible === true || result.completed === true) {
    if (!result.commandIdentity || typeof result.commandIdentity !== "object" || Array.isArray(result.commandIdentity)) {
      throw new Error("final-regression commandIdentity is required on eligible fail");
    }
    for (const field of ["command", "commandSource", "argv", "env", "source", "metadata", "resolvedScriptDigest", "resolvedConfigDigest"]) {
      if (!Object.hasOwn(result.commandIdentity, field)) throw new Error(`final-regression commandIdentity missing ${field}`);
    }
    if (!Array.isArray(result.commandIdentity.argv) || result.commandIdentity.argv.some((entry) => typeof entry !== "string")) {
      throw new Error("final-regression commandIdentity.argv must be string array");
    }
  }
  if (!result.recordAndProceed || typeof result.recordAndProceed !== "object" || Array.isArray(result.recordAndProceed)) {
    throw new Error("final-regression record-and-proceed evidence is required on fail");
  }
  if (typeof result.recordAndProceed.eligible !== "boolean") {
    throw new Error("final-regression record-and-proceed eligible must be boolean");
  }
  if (typeof result.recordAndProceed.validated !== "boolean") {
    throw new Error("final-regression record-and-proceed validated must be boolean");
  }
  if (result.completed === true) {
    const recordCategory = [
      "existing_failure", "environment", "sandbox", "timeout", "dependency",
      "out_of_scope", "flaky_suspected",
    ].includes(result.failureCategory);
    const recordEligible = recordCategory && (
      [
        "unattributed_existing_failure", "timeout", "dependency_failure",
        "sandbox_restriction", "permission_error", "child_process_eperm",
      ].includes(result.failureKind)
      || (result.failureKind === "caused_by_current_change" && result.failureCategory === "out_of_scope")
    );
    if (!recordEligible) {
      throw new Error("final-regression completed fail category is not eligible for record-and-proceed");
    }
    if (result.selectedAction !== "explicit-record-and-proceed") {
      throw new Error("final-regression completed fail requires explicit operator proceed");
    }
    if (result.recordAndProceed.eligible !== true || result.recordAndProceed.validated !== true) {
      throw new Error("final-regression completed fail requires validated failed-recorded record-and-proceed evidence");
    }
    if (typeof result.recordAndProceed.evidence !== "string" || result.recordAndProceed.evidence.trim().length === 0) {
      throw new Error("final-regression record-and-proceed evidence must be non-empty");
    }
    if (typeof result.recordAndProceed.remainingRisk !== "string" || result.recordAndProceed.remainingRisk.trim().length === 0) {
      throw new Error("final-regression remainingRisk is required for record-and-proceed");
    }
    for (const field of ["failureClassification", "operatorJustification", "remainingRisk", "executionBinding"]) {
      if (!Object.hasOwn(result.recordAndProceed, field)) throw new Error(`final-regression explicit operator ${field} is required`);
    }
    if (typeof result.recordAndProceed.operatorJustification !== "string" || result.recordAndProceed.operatorJustification.trim().length === 0) {
      throw new Error("final-regression explicit operator justification must be non-empty");
    }
  } else if (result.selectedAction === "explicit-record-and-proceed") {
    throw new Error("final-regression record-and-proceed selection requires completed fail");
  }
}

function validateFinalRegressionSkipKind(result) {
  if (result.result !== "skipped") {
    if (Object.hasOwn(result, "skipKind")) throw new Error("final-regression skipKind is only valid on skipped");
    if (Object.hasOwn(result, "proof")) throw new Error("final-regression proof is only valid on skipped");
    return;
  }
  if (!FINAL_REGRESSION_SKIP_KINDS.includes(result.skipKind)) throw new Error(`final-regression skipKind invalid: ${result.skipKind}`);
  if (typeof result.reason !== "string" || result.reason.length === 0) throw new Error("final-regression skipped reason is required");
  if (result.completed !== true) throw new Error("final-regression skipped completed must be true");
  if (!result.proof || typeof result.proof !== "object" || Array.isArray(result.proof)) {
    throw new Error("final-regression skipped proof is required");
  }
  if (result.proof.kind !== result.skipKind) throw new Error("final-regression skipped proof.kind must match skipKind");
  if (result.skipKind === "covered_by_test_execute_full_regression") {
    for (const field of ["reusedArtifactPath", "commandIdentity", "changedFileFingerprints", "staleCheck"]) {
      if (!Object.hasOwn(result.proof, field)) throw new Error(`final-regression covered proof missing ${field}`);
    }
    const identity = result.proof.commandIdentity;
    for (const field of ["command", "commandSource", "argv", "env", "source", "metadata", "resolvedScriptDigest", "resolvedConfigDigest"]) {
      if (!Object.hasOwn(identity, field)) throw new Error(`final-regression commandIdentity missing ${field}`);
    }
    if (!Array.isArray(identity.argv) || identity.argv.some((entry) => typeof entry !== "string")) {
      throw new Error("final-regression commandIdentity.argv must be string array");
    }
    if (!Array.isArray(result.proof.changedFileFingerprints)) {
      throw new Error("final-regression changedFileFingerprints must be array");
    }
    if (JSON.stringify(result.proof.staleCheck) !== JSON.stringify({
      sameFlow: true,
      commandIdentityMatched: true,
      changedFileFingerprintsMatched: true,
    })) {
      throw new Error("final-regression staleCheck must prove same-flow matched evidence");
    }
  } else {
    const discovery = result.proof.commandDiscovery;
    if (!discovery || typeof discovery !== "object" || Array.isArray(discovery)) {
      throw new Error("final-regression project policy proof missing commandDiscovery");
    }
    if (!Array.isArray(discovery.checkedSources) || discovery.checkedSources.length === 0) {
      throw new Error("final-regression project policy checkedSources must be a non-empty array");
    }
    if (discovery.checkedSources.some((entry) => typeof entry !== "string" || entry.length === 0)) {
      throw new Error("final-regression project policy checkedSources must contain non-empty strings");
    }
    if (discovery.supportedCommandFound !== false) {
      throw new Error("final-regression project policy supportedCommandFound must be false");
    }
    if (discovery.invalidConfiguredCommand !== false) {
      throw new Error("final-regression project policy invalidConfiguredCommand must be false");
    }
    if (typeof discovery.reason !== "string" || discovery.reason.length === 0) {
      throw new Error("final-regression project policy reason is required");
    }
  }
}

function validateFinalRegressionStreamEvidence(stream, label) {
  if (!stream || typeof stream !== "object" || Array.isArray(stream)) {
    throw new Error(`${label} must be an object`);
  }
  if (Object.hasOwn(stream, "content")) throw new Error(`${label}.content must not duplicate raw output`);
  if (!Number.isSafeInteger(stream.originalByteLength) || stream.originalByteLength < 0) {
    throw new Error(`${label}.originalByteLength must be a non-negative safe integer`);
  }
  if (!Number.isSafeInteger(stream.capturedByteLength) || stream.capturedByteLength < 0) {
    throw new Error(`${label}.capturedByteLength must be a non-negative safe integer`);
  }
  if (typeof stream.truncated !== "boolean") throw new Error(`${label}.truncated must be boolean`);
  if (stream.truncated !== (stream.capturedByteLength < stream.originalByteLength)) {
    throw new Error(`${label}.truncated does not match byte lengths`);
  }
  if (typeof stream.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(stream.sha256)) {
    throw new Error(`${label}.sha256 must be a SHA-256 digest`);
  }
  if (Object.hasOwn(stream, "rawOutputPath")) throw new Error(`${label}.rawOutputPath must be stored only on its process record`);
}

function validateFinalRegressionChildProcesses(result) {
  if (!Array.isArray(result.childProcesses)) {
    throw new Error("final-regression childProcesses[] is required");
  }
  if (result.childProcesses.length > 128) {
    throw new Error("final-regression childProcesses[] exceeds 128 entries");
  }
  const kinds = [
    "passed",
    "assertion-failure",
    "nonzero-exit",
    "spawn-error",
    "signal",
    "timeout",
    "max-buffer",
  ];
  for (const [index, child] of result.childProcesses.entries()) {
    const label = `final-regression.childProcesses[${index}]`;
    if (!child || typeof child !== "object" || Array.isArray(child)) {
      throw new Error(`${label} must be an object`);
    }
    if (!kinds.includes(child.kind)) throw new Error(`${label}.kind invalid: ${child.kind}`);
    if (!Array.isArray(child.command) || child.command.length === 0 || child.command.some((entry) => typeof entry !== "string" || entry.length === 0)) {
      throw new Error(`${label}.command must contain non-empty strings`);
    }
    for (const field of ["started", "completed", "timedOut"]) {
      if (typeof child[field] !== "boolean") throw new Error(`${label}.${field} must be boolean`);
    }
    if (child.exitCode !== null && !Number.isInteger(child.exitCode)) {
      throw new Error(`${label}.exitCode must be an integer or null`);
    }
    for (const field of ["signal", "errorCode", "spawnError"]) {
      if (child[field] !== null && typeof child[field] !== "string") {
        throw new Error(`${label}.${field} must be a string or null`);
      }
    }
    if (child.rawOutputPath !== result.rawOutputPath) {
      throw new Error(`${label}.rawOutputPath must reference final-regression rawOutputPath`);
    }
    validateFinalRegressionStreamEvidence(child.stdout, `${label}.stdout`);
    validateFinalRegressionStreamEvidence(child.stderr, `${label}.stderr`);
  }
}

function validateFinalRegressionExecutionBinding(result) {
  if (result.result === "skipped") {
    if (Object.hasOwn(result, "executionBinding")) throw new Error("final-regression skipped result must not contain executionBinding");
    return;
  }
  const binding = result.executionBinding;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error("final-regression executionBinding is required");
  }
  if (binding.command !== null && (typeof binding.command !== "string" || binding.command.length === 0)) {
    throw new Error("final-regression executionBinding.command must be a string or null");
  }
  for (const field of ["rawOutputPath", "rawOutputSha256", "parsedResult", "worktreeSha256"]) {
    if (typeof binding[field] !== "string" || binding[field].length === 0) {
      throw new Error(`final-regression executionBinding.${field} is required`);
    }
  }
  if (!Number.isSafeInteger(binding.testCount) || binding.testCount < 0) {
    throw new Error("final-regression executionBinding.testCount must be a non-negative safe integer");
  }
  if (typeof binding.truncated !== "boolean") throw new Error("final-regression executionBinding.truncated must be boolean");
  validateFinalRegressionStreamEvidence(binding.stdout, "final-regression.executionBinding.stdout");
  validateFinalRegressionStreamEvidence(binding.stderr, "final-regression.executionBinding.stderr");
}

export function validateFinalRegressionResult(result) {
  if (!result || typeof result !== "object") throw new Error("final-regression-result.json must be an object");
  if (result.version !== "1") throw new Error(`final-regression-result.json version='${result.version}', expected '1'`);
  if (!["pass", "fail", "skipped"].includes(result.result)) throw new Error("final-regression result must be pass, fail, or skipped");
  if (typeof result.completed !== "boolean") throw new Error("final-regression completed must be boolean");
  if (typeof result.command !== "string" && result.command !== null) throw new Error("final-regression command must be string or null");
  if (typeof result.commandSource !== "string" && result.commandSource !== null) throw new Error("final-regression commandSource must be string or null");
  if (typeof result.rawOutputPath !== "string" || result.rawOutputPath.length === 0) throw new Error("final-regression rawOutputPath is required");
  if (!Array.isArray(result.changedFiles)) throw new Error("final-regression changedFiles[] is required");
  if (result.result === "skipped") assertCamelRange(result.rawOutputLines, "final-regression");
  else assertRange(result.rawOutputLines, "final-regression");
  assertProcessMetadata(result.process, "final-regression.process");
  validateFinalRegressionChildProcesses(result);
  validateFinalRegressionExecutionBinding(result);
  validateFinalRegressionFailureKind(result);
  validateFinalRegressionSkipKind(result);
  validateFinalRegressionRecordAndProceed(result);
  return result;
}

function finalRegressionEvidenceFailure(reason) {
  return { ok: false, reason };
}

function readFinalRegressionManifest(rawText) {
  const values = new Map(String(rawText).split(/\r?\n/)
    .map((line) => line.match(/^evidence\.([^:]+):\s*(.*)$/))
    .filter(Boolean)
    .map((match) => [match[1], match[2]]));
  if (values.size === 0) throw new Error("execution evidence manifest missing from raw output");
  const number = (key) => {
    const value = Number(values.get(key));
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`execution evidence ${key} invalid`);
    return value;
  };
  const boolean = (key) => {
    const value = values.get(key);
    if (value !== "true" && value !== "false") throw new Error(`execution evidence ${key} invalid`);
    return value === "true";
  };
  return {
    command: values.get("command"),
    result: values.get("result"),
    testCount: number("testCount"),
    truncated: boolean("truncated"),
    worktreeSha256: values.get("worktreeSha256"),
    streams: Object.fromEntries(["stdout", "stderr"].map((name) => [name, {
      originalByteLength: number(`${name}.originalByteLength`),
      capturedByteLength: number(`${name}.capturedByteLength`),
      truncated: boolean(`${name}.truncated`),
      sha256: values.get(`${name}.sha256`),
    }])),
  };
}

class FinalRegressionTestSummary {
  static #ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

  static #REPORTER_PATTERNS = Object.freeze([
    /^\s*1\.\.(\d+)\s*$/,
    /^\s*#\s*tests\s+(\d+)\s*$/i,
    /^\s*ℹ\s*tests\s+(\d+)\s*$/i,
    /^\s*Tests:\s*(\d+)\s+(?:passed|total)\b/i,
    /^\s*(\d+)\s+passing\b/i,
  ]);

  constructor(testCount) {
    if (!Number.isSafeInteger(testCount) || testCount < 0) {
      throw new Error("final regression test count must be a non-negative safe integer");
    }
    this.testCount = testCount;
    Object.freeze(this);
  }

  static parse(stdout) {
    const lines = String(stdout || "")
      .replace(FinalRegressionTestSummary.#ANSI_ESCAPE_PATTERN, "")
      .split(/\r?\n/);
    for (const pattern of FinalRegressionTestSummary.#REPORTER_PATTERNS) {
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const match = lines[index].match(pattern);
        if (match) return new FinalRegressionTestSummary(Number.parseInt(match[1], 10));
      }
    }
    return new FinalRegressionTestSummary(0);
  }
}

export function finalRegressionTestCount(stdout) {
  return FinalRegressionTestSummary.parse(stdout).testCount;
}

// This covers staged, unstaged, and untracked content. Callers that own
// generated state can exclude it with Git pathspecs so telemetry does not
// masquerade as a product mutation.
export function finalRegressionWorktreeFingerprint(root, { pathspecExcludes = [] } = {}) {
  const pathspec = ["--", ".", ...pathspecExcludes];
  const staged = execFileSync("git", [
    "diff", "--cached", "--no-ext-diff", "--binary", "HEAD", ...pathspec,
  ], {
    cwd: root,
    encoding: "utf8",
  });
  const unstaged = execFileSync("git", [
    "diff", "--no-ext-diff", "--binary", ...pathspec,
  ], {
    cwd: root,
    encoding: "utf8",
  });
  const untracked = execFileSync("git", [
    "ls-files", "--others", "--exclude-standard", "-z", ...pathspec,
  ], {
    cwd: root,
    encoding: "utf8",
  }).split("\0").filter(Boolean).sort();
  const hash = crypto.createHash("sha256")
    .update("staged\0")
    .update(staged)
    .update("\0unstaged\0")
    .update(unstaged);
  for (const relativePath of untracked) {
    const absolutePath = path.join(root, relativePath);
    const stat = fs.lstatSync(absolutePath);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    hash.update("\0").update(relativePath).update("\0").update(fs.readFileSync(absolutePath));
  }
  return hash.digest("hex");
}

// The three values must always describe the same repository instant.
export class FinalRegressionRepositoryBinding {
  constructor({ headSha, treeSha, worktreeSha256 }) {
    if (!/^[a-f0-9]{40}$/.test(headSha)) throw new Error("final-regression headSha must be a Git SHA");
    if (!/^[a-f0-9]{40}$/.test(treeSha)) throw new Error("final-regression treeSha must be a Git SHA");
    if (!/^[a-f0-9]{64}$/.test(worktreeSha256)) throw new Error("final-regression worktreeSha256 must be a SHA-256 digest");
    this.headSha = headSha;
    this.treeSha = treeSha;
    this.worktreeSha256 = worktreeSha256;
    Object.freeze(this);
  }

  static capture(root, options = {}) {
    return new FinalRegressionRepositoryBinding({
      headSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
      treeSha: execFileSync("git", ["write-tree"], { cwd: root, encoding: "utf8" }).trim(),
      worktreeSha256: finalRegressionWorktreeFingerprint(root, options),
    });
  }

  matches(other) {
    return other instanceof FinalRegressionRepositoryBinding
      && this.headSha === other.headSha
      && this.treeSha === other.treeSha
      && this.worktreeSha256 === other.worktreeSha256;
  }
}

function resolveFinalRegressionRawOutputPath(root, rawOutputPath) {
  const resolved = resolveRepoRelativePathInside({
    root,
    allowedBaseDir: path.resolve(root),
    relPath: rawOutputPath,
    label: "final-regression rawOutputPath",
    mustExist: false,
  });
  if (!fs.existsSync(resolved)) return null;
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("final-regression rawOutputPath must reference a regular repository file");
  }
  return resolved;
}

export function validateFinalRegressionEvidence({ root, artifact, repositoryBindingOptions = {} }) {
  try {
    validateFinalRegressionResult(artifact);
    const binding = artifact.executionBinding;
    if (!binding || typeof binding !== "object") throw new Error("executionBinding is required");
    if (binding.command !== artifact.command) throw new Error("execution binding command mismatch");
    if (binding.parsedResult !== artifact.result) throw new Error("execution binding result mismatch");
    if (!/^[a-f0-9]{64}$/.test(binding.worktreeSha256)) {
      throw new Error("execution binding worktree fingerprint mismatch");
    }
    if (artifact.completed) {
      const recordedRepository = new FinalRegressionRepositoryBinding(binding);
      const currentRepository = FinalRegressionRepositoryBinding.capture(root, repositoryBindingOptions);
      if (recordedRepository.headSha !== currentRepository.headSha) throw new Error("execution binding HEAD is stale");
      if (recordedRepository.treeSha !== currentRepository.treeSha) throw new Error("execution binding tree is stale");
      if (recordedRepository.worktreeSha256 !== currentRepository.worktreeSha256) throw new Error("execution binding worktree is stale");
    }
    const rawPath = resolveFinalRegressionRawOutputPath(root, binding.rawOutputPath || artifact.rawOutputPath);
    if (rawPath === null) return { ok: true, rawEvidence: "absent" };
    const rawText = fs.readFileSync(rawPath, "utf8");
    const manifest = readFinalRegressionManifest(rawText);
    if (binding.command !== manifest.command) throw new Error("execution binding command mismatch");
    if (binding.parsedResult !== manifest.result) throw new Error("execution binding result mismatch");
    const rawResult = rawText.match(/(?:^|\n)result:\s*(pass|fail|skipped)(?:\s|$)/)?.[1];
    if (rawResult !== binding.parsedResult) throw new Error("execution binding parsed result mismatch");
    if (binding.worktreeSha256 !== manifest.worktreeSha256) throw new Error("execution binding worktree fingerprint mismatch");
    if (binding.rawOutputSha256 !== crypto.createHash("sha256").update(rawText).digest("hex")) throw new Error("execution binding raw output mismatch");
    for (const stream of ["stdout", "stderr"]) {
      const evidence = manifest.streams[stream];
      if (!binding[stream]
        || binding[stream].originalByteLength !== evidence.originalByteLength
        || binding[stream].capturedByteLength !== evidence.capturedByteLength
        || binding[stream].truncated !== evidence.truncated
        || binding[stream].sha256 !== evidence.sha256) {
        throw new Error(`execution binding ${stream} mismatch`);
      }
    }
    if (binding.testCount !== manifest.testCount) {
      throw new Error("execution binding test count mismatch");
    }
    if (binding.truncated !== manifest.truncated || binding.truncated !== Boolean(manifest.streams.stdout.truncated || manifest.streams.stderr.truncated)) {
      throw new Error("execution binding truncation mismatch");
    }
    return { ok: true, rawEvidence: "verified" };
  } catch (err) {
    return finalRegressionEvidenceFailure(err.message);
  }
}

export function validateExplicitFinalRegressionProceed({ root, artifact, repositoryBindingOptions = {} }) {
  try {
    validateFinalRegressionResult(artifact);
    if (artifact.selectedAction !== "explicit-record-and-proceed" || artifact.completed !== true) {
      throw new Error("explicit operator proceed is required");
    }
    const evidence = artifact.recordAndProceed;
    if (evidence.failureClassification !== artifact.failureCategory) throw new Error("operator failure classification mismatch");
    if (typeof artifact.remainingRisk !== "string" || artifact.remainingRisk.length === 0) {
      throw new Error("operator remaining risk is required");
    }
    if (evidence.remainingRisk !== artifact.remainingRisk) {
      throw new Error("operator remaining risk mismatch");
    }
    const binding = evidence.executionBinding;
    for (const field of ["rawOutputPath", "rawOutputSha256", "headSha", "treeSha"]) {
      if (!binding || !binding[field]) throw new Error(`operator ${field} is required`);
    }
    if (binding.rawOutputPath !== artifact.rawOutputPath) throw new Error("operator raw output path mismatch");
    for (const field of ["rawOutputSha256", "headSha", "treeSha"]) {
      if (binding[field] !== artifact.executionBinding?.[field]) throw new Error(`operator ${field} mismatch`);
    }
    return validateFinalRegressionEvidence({ root, artifact, repositoryBindingOptions });
  } catch (err) {
    return finalRegressionEvidenceFailure(err.message);
  }
}

export function validateSummaryEvidence(summary, {
  root,
  validateRawOutputRange = false,
  rawLines,
  requirements = [],
  specDir = null,
  deferredReceipts = [],
}) {
  const expected = requirements.filter((r) => r.testable !== false).map((r) => r.id);
  const actual = summary.map((entry) => entry.id);
  const missing = expected.filter((id) => !actual.includes(id));
  const unknown = actual.filter((id) => !expected.includes(id));
  const duplicates = actual.filter((id, index) => actual.indexOf(id) !== index);
  if (missing.length || unknown.length || duplicates.length) {
    throw new Error(`summary membership invalid: missing=${missing.join(",")} unknown=${unknown.join(",")} duplicate=${duplicates.join(",")}`);
  }
  const deferredById = new Map(deferredReceipts.map((receipt) => [receipt.requirementId, receipt]));
  if (deferredById.size !== deferredReceipts.length) throw new Error("deferred receipt membership contains duplicate requirements");

  for (const entry of summary) {
    if (typeof entry.id !== "string" || entry.id.trim().length === 0) {
      throw new Error("summary[].id must be a non-empty requirement id");
    }
    if (entry.result === "deferred") {
      if (entry.execution !== "deferred_no_active_test") {
        throw new Error(`${entry.id}: deferred result requires execution=deferred_no_active_test`);
      }
      const entryReceipt = entry.deferred_receipt instanceof RequirementTestDeferredReceipt
        ? entry.deferred_receipt
        : RequirementTestDeferredReceipt.fromJSON(entry.deferred_receipt);
      const receipt = deferredById.get(entry.id);
      if (deferredReceipts.length > 0 && (!receipt || JSON.stringify(receipt.toJSON()) !== JSON.stringify(entryReceipt.toJSON()))) {
        throw new Error(`${entry.id}: deferred receipt does not match canonical receipt`);
      }
      continue;
    }
    if (entry.execution !== "executed") {
      throw new Error(`${entry.id}: active result requires execution=executed`);
    }
    const evidence = entry.evidence;
    if (!evidence || typeof evidence !== "object") {
      throw new Error(`${entry.id}: evidence is required`);
    }
    assertRange(evidence.raw_output_lines, `${entry.id}: evidence`);
    assertEvidenceRangeWithinLimit(evidence.raw_output_lines, `${entry.id}: evidence`);
    if (typeof evidence.command !== "string" || evidence.command.length === 0) {
      throw new Error(`${entry.id}: evidence.command is required`);
    }
    if (validateRawOutputRange && evidence.raw_output_lines.end_line > rawLines.length) {
      throw new Error(`${entry.id}: summary raw_output_lines is outside raw output`);
    }
    if (entry.result === "not_applicable") {
      if (entry.reason !== SUMMARY_NO_TESTS_REASON) {
        throw new Error(`${entry.id}: reason must be ${SUMMARY_NO_TESTS_REASON}`);
      }
      if (validateRawOutputRange) {
        const rawRangeText = rawLines
          .slice(evidence.raw_output_lines.start_line - 1, evidence.raw_output_lines.end_line)
          .join("\n");
        if (!rawRangeText.includes(entry.id)
          || !rawRangeText.includes("not_applicable")
          || !rawRangeText.includes(SUMMARY_NO_TESTS_REASON)) {
          throw new Error(`${entry.id}: raw output range does not contain no-tests decision evidence`);
        }
      }
      continue;
    }
    if (entry.result !== "pass" && entry.result !== "fail") {
      throw new Error(`${entry.id}: result invalid: ${entry.result}`);
    }
    const testPath = specDir
      ? resolveRepoRelativePathInside({
        root,
        allowedBaseDir: path.resolve(specDir, "tests"),
        relPath: evidence.test_file,
        label: `${entry.id}: test_file`,
      })
      : path.resolve(root, evidence.test_file);
    if (!specDir && !fs.existsSync(testPath)) throw new Error(`${entry.id}: test file missing: ${evidence.test_file}`);
    const src = readBoundedText(testPath, evidence.test_file, MAX_TEST_SOURCE_BYTES);
    if (!src.includes(evidence.test_name)) {
      throw new Error(`${entry.id}: test name not found in ${evidence.test_file}: ${evidence.test_name}`);
    }
    if (validateRawOutputRange && entry.result === "pass") {
      const rawRangeText = rawLines
        .slice(evidence.raw_output_lines.start_line - 1, evidence.raw_output_lines.end_line)
        .join("\n");
      if (!rawRangeText.includes(entry.id)) {
        throw new Error(`${entry.id}: raw output range does not contain requirement evidence`);
      }
    }
  }

  return summary;
}

export function validateTestExecuteResultEvidence(result, {
  root,
  rawOutputText,
  rawLines,
  requirements = [],
  summary = true,
  specDir = null,
  validateRawOutputRange = true,
}) {
  if (summary) {
    validateSummaryEvidence(result.summary, {
      root,
      validateRawOutputRange,
      rawLines,
      requirements,
      specDir,
    });
  }

  const regression = result.regression;
  if (regression.required && validateRawOutputRange) {
    if (regression.raw_output_lines.end_line > rawLines.length) {
      throw new Error("regression.raw_output_lines is outside raw output");
    }
    const startMarker = `[sennel] project regression start command=${regression.command} mode=${regression.mode}`;
    const endMarker = `[sennel] project regression end result=${regression.result}`;
    if (!rawOutputText.includes(startMarker) || !rawOutputText.includes(endMarker)) {
      throw new Error("raw output missing project regression start/end markers matching artifact command/result");
    }
  }

  return result;
}

export function validateTestResultReview(review) {
  validateTestResultReviewShape(review);
  if (!review || typeof review !== "object") throw new Error("test-result-review.json must be an object");
  if (review.verdict !== "pass" && review.verdict !== "fail") throw new Error("test-result-review verdict must be pass or fail");
  if (!Array.isArray(review.checked_items)) throw new Error("checked_items[] is required");
  if (typeof review.testSourceRevision !== "string" || !REPAIR_FINGERPRINT_PATTERN.test(review.testSourceRevision)) {
    throw new Error("test-result-review testSourceRevision must be a 64-character SHA-256 digest");
  }
  if (typeof review.rawEvidenceFingerprint !== "string" || !REPAIR_FINGERPRINT_PATTERN.test(review.rawEvidenceFingerprint)) {
    throw new Error("test-result-review rawEvidenceFingerprint must be a 64-character SHA-256 digest");
  }
  const source = review.testExecute;
  if (!source || typeof source !== "object"
    || !Number.isSafeInteger(source.historyAttempt) || source.historyAttempt < 1
    || typeof source.producerActivityId !== "string" || source.producerActivityId === ""
    || typeof source.attemptId !== "string" || source.attemptId === ""
    || !Number.isSafeInteger(source.sequence) || source.sequence < 1) {
    throw new Error("test-result-review testExecute must bind a canonical execution Attempt");
  }
  assertMaxItems("checked_items[]", review.checked_items, MAX_REVIEW_CHECKED_ITEMS);
  return validateTestResultReviewObservationCoherence(review);
}
