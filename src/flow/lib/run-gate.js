/**
 * src/flow/lib/run-gate.js
 *
 * FlowCommand: gate — check deliverable readiness for each phase.
 *
 * Phases (issue #184, cac6/T3):
 *   draft        (level=parent)       check draft.json structure + guardrail compliance
 *   spec         (level=parent)       check spec.json structure + guardrail compliance
 *   task-spec    (level=task)         check task spec + guardrail compliance
 *   task-impl    (level=task)         check task impl against spec + guardrail compliance
 *   integration  (level=integration)  check integration task + guardrail compliance
 *
 * AI evaluation output is a structured JSON schema:
 *   { "evaluations": [{ "guardrail_id": string, "result": "pass"|"fail"|"skip", "reason": string }] }
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execFile, execFileSync } from "child_process";
import { promisify } from "util";
import { assertOk } from "../../lib/process.js";
import { PKG_DIR } from "../../lib/cli.js";
import { PRODUCT } from "../../lib/product.js";
import { runGit } from "../../lib/git-helpers.js";
import { computeGitState } from "../../lib/git-state.js";

const execFileAsync = promisify(execFile);
import { container } from "../../lib/container.js";
import { PromptBuilder } from "../../lib/prompt-builder.js";
import { GLOBAL_PROMPT_ELEMENT_HARD_MAX, PromptRequestLimit, PromptBatchingError, PromptBatchPlan, PromptExecutionBudget, PromptExecutionLimit, PromptLogicalFootprint } from "../../lib/prompt-batching.js";
import {
  RequirementEvidenceInput, RequirementEvidencePlan, RequirementObservationResponse,
  executeGatePlan, gatePromptFits,
  reduceRequirementEvidence,
} from "./gate-prompt-plan.js";
import { filterByPhase, loadMergedGuardrails } from "../../lib/guardrail.js";
import { validateConfiguredPresetChains } from "../../lib/presets.js";
import { getSpecName } from "../../lib/flow-helpers.js";
import { AgentFailure } from "../../lib/agent-failure.js";
import {
  enumerateUsableRequirementIds,
  specJsonToPromptText,
  validateSpecJsonObject,
} from "../../lib/spec-json.js";
import { reconcileFileMap } from "./req-map.js";
import {
  CanonicalFileMap,
  CanonicalSourceRequirementAuthority,
  CanonicalSourceRequirementScope,
} from "./canonical-file-map.js";
import { buildAcknowledgedRationaleSection } from "./acknowledged-rationale.js";
import { checkTasksMonotonic } from "./check-tasks-monotonic.js";
import {
  VALID_GATE_PHASES,
  VALID_GATE_LEVELS,
  VALID_LEVEL_PHASE_COMBINATIONS,
} from "../../lib/constants.js";
import { FlowCommand } from "./base-command.js";
import { appendCanonicalIssueLogEntry } from "./set-issue-log.js";
import {
  resolveGatePhaseFromState,
  resolveGateStepId,
} from "./gate-step.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { contractFromGateArtifact, repoRelative } from "./flow-judgment-contract.js";
import { validateDraftLifecycle } from "./draft-lifecycle.js";
import {
  IMPL_GATE_RESULT_FILE,
  IntegrationArtifactFingerprintAuthority,
  listUpgradeRequiredChangedPaths,
  readJsonStrict,
  validateCanonicalUpgradeEvidence,
} from "./test-artifacts.js";
import {
  Observation,
  Diagnosis,
  NextAction,
  legacyEvaluationsToNextAction,
} from "./observation.js";
import {
  assertAuditedBroadMode,
  evaluateTaskScope,
  taskScopeViolationMessages,
} from "./task-scope.js";
import {
  completeDraftArtifactChange,
  completeSpecArtifactChange,
} from "./artifact-completion.js";
export { evaluateReviewFindingGateReadiness } from "./review-finding-gate-readiness.js";
import { flattenSteps } from "./step-tree.js";
import { StaleTestEvidenceMismatch, StaleTestEvidenceRefreshResult } from "./stale-test-evidence-refresh.js";
import { buildRepairFingerprint } from "./repair-fingerprint.js";
import { RepairArtifactRegistry } from "./repair-state-identity.js";
import {
  SPEC_TEST_COVERAGE_GUARDRAIL_ID,
  SpecTestCoverageDecision,
} from "./spec-test-coverage.js";
import {
  CanonicalGateInputStore,
  CanonicalGatePromotion,
  CanonicalGatePublishedResultRecovery,
  canonicalGateNodeId,
  canonicalGateLogicalKeys,
  taskGateSettlementIssueLogId,
} from "./canonical-gate-artifacts.js";
import {
  attachedCanonicalCommandResultArtifact,
  CanonicalCommandAttemptArtifactHistory,
} from "./canonical-command-result.js";
import { isCanonicalFlowState } from "./canonical-test-artifacts.js";
import { readCurrentGateTransitionFacts } from "./gate-transition-facts.js";
import { checkSpecGateReadiness } from "./spec-gate-readiness.js";
import { CanonicalTaskContext } from "./task-canonical-context.js";
import { captureCurrentTaskSource } from "./task-mutation-lineage.js";
import { TaskGateSettlementAdmission } from "./canonical-flow-manager-store.js";

export { resolveGateStepId };

/**
 * Parse the small, security-sensitive subset of gate arguments whose only
 * purpose is to detect and reject public evaluation-bypass attempts.
 */
export function parsePublicGateArguments(argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (const arg of args) {
    if (arg === "--skip-required-evaluation" || arg === "--skip-guardrail") {
      const error = new Error("required gate evaluations cannot be bypassed from the public CLI");
      error.code = "GATE_REQUIRED_EVALUATION_BYPASS_FORBIDDEN";
      throw error;
    }
  }
  return {};
}

export async function completeGateArtifactBeforeSemanticEvaluation({
  completeArtifact,
  evaluateSemanticGuardrail,
} = {}) {
  const completed = await completeArtifact();
  if (completed?.constructor?.name === "ArtifactCompletionMechanicalFailure" || completed?.ok === false) {
    return completed;
  }
  return evaluateSemanticGuardrail(completed);
}

// ---------------------------------------------------------------------------
// Level / phase validation
// ---------------------------------------------------------------------------

/**
 * Map from gate phase to its canonical gate level.
 */
export const PHASE_TO_LEVEL = Object.freeze({
  "draft": "parent",
  "spec": "parent",
  "task-spec": "task",
  "task-impl": "task",
  "integration": "integration",
});

export function checkIntegrationTestArtifacts({ artifacts, currentFingerprint } = {}) {
  const values = artifacts instanceof Map ? artifacts : new Map(Object.entries(artifacts || {}));
  return StaleTestEvidenceMismatch.detect({ artifacts: values, currentFingerprint }) || null;
}

/**
 * Validate a (level, phase) pair against the allowed combinations.
 * Throws Error if invalid.
 */
export function validateLevelPhase(level, phase) {
  if (!VALID_GATE_LEVELS.includes(level)) {
    throw new Error(
      `invalid level: ${level} (valid: ${VALID_GATE_LEVELS.join(", ")})`,
    );
  }
  if (!VALID_GATE_PHASES.includes(phase)) {
    throw new Error(
      `invalid phase: ${phase} (valid: ${VALID_GATE_PHASES.join(", ")})`,
    );
  }
  const ok = VALID_LEVEL_PHASE_COMBINATIONS.some(
    (c) => c.level === level && c.phase === phase,
  );
  if (!ok) {
    throw new Error(
      `invalid level/phase combination: (${level}, ${phase}). ` +
        `allowed: ${VALID_LEVEL_PHASE_COMBINATIONS.map((c) => `(${c.level},${c.phase})`).join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runGitDiff(args, errorMessage, cwd) {
  const res = runGit(["diff", ...args], { cwd });
  assertOk(res, errorMessage);
  return res.stdout;
}

const UNTRACKED_DEFAULT_MAX_FILES = 500;
const UNTRACKED_DEFAULT_MAX_FILE_SIZE = 1024 * 1024; // 1 MiB
const TASK_IMPL_GATE_DIFF_MAX_BYTES = 1024 * 1024; // 1 MiB
const MAX_IMPL_REQUIREMENT_BATCH_CHARS = GLOBAL_PROMPT_ELEMENT_HARD_MAX;
const GATE_SOURCE_ARTIFACT_BY_PHASE = Object.freeze({
  draft: "draft-gate-source.json",
  spec: "spec-gate-source.json",
  "task-impl": "task-impl-gate-source.json",
  integration: IMPL_GATE_RESULT_FILE,
});
const GATE_RESULT_ARTIFACT_BY_PHASE = Object.freeze({
  draft: "draft-gate-result.json",
  spec: "spec-gate-result.json",
  "task-impl": "task-impl-gate-result.json",
  integration: IMPL_GATE_RESULT_FILE,
});

/**
 * Synthesize a unified diff for every untracked file in `root` and return the
 * concatenated diff text. Untracked-file omission in `git diff` is the root
 * cause of spec 221 — a test-first new test file becomes invisible to
 * impl-gate unless we splice it back in here.
 *
 * Read-only: uses `git ls-files --others --exclude-standard` for enumeration
 * and `git diff --no-index /dev/null <path>` for synthesis. Neither mutates
 * the index or working tree (REQ-4 / REQ-5).
 *
 * Exit-code contract for `git diff --no-index`:
 *   - 0 → no differences (impossible here since we compare against /dev/null
 *         for a non-empty file, but accepted for completeness)
 *   - 1 → differences present (the normal, expected case)
 *   - ≥2 (or signal / killed) → real git error → re-throw via `assertOk`
 *
 * Bounded resource usage: refuses to process more than `maxFiles` files or
 * any single file larger than `maxFileSize` bytes (REQ-6). Exceeding either
 * limit throws an Error tagged with `code = "UNTRACKED_LIMIT_EXCEEDED"`.
 *
 * @param {string} root absolute path to the repository (or worktree) root
 * @param {{maxFiles?: number, maxFileSize?: number, excludeFile?: Function}} [options]
 * @returns {Promise<string>} concatenated unified diff text, or "" if none
 */
export async function collectUntrackedDiff(root, options = {}) {
  const maxFiles = options.maxFiles ?? UNTRACKED_DEFAULT_MAX_FILES;
  const maxFileSize = options.maxFileSize ?? UNTRACKED_DEFAULT_MAX_FILE_SIZE;

  // Single async git invocation — not in any loop, so no bulk-path concern.
  let listStdout;
  try {
    ({ stdout: listStdout } = await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { cwd: root },
    ));
  } catch (err) {
    const wrapped = new Error(`failed to list untracked files: ${err.message}`);
    wrapped.cause = err;
    throw wrapped;
  }
  // -z output: NUL-separated, no trailing entry
  const excludeFile = typeof options.excludeFile === "function" ? options.excludeFile : () => false;
  const files = listStdout
    .split("\0")
    .filter((p) => p.length > 0)
    .filter((p) => !excludeFile(p));
  if (files.length === 0) return "";

  if (files.length > maxFiles) {
    const err = new Error(
      `untracked file count ${files.length} exceeds limit ${maxFiles}`,
    );
    err.code = "UNTRACKED_LIMIT_EXCEEDED";
    throw err;
  }

  // Stat every candidate in parallel (avoids serial sync I/O in this loop)
  // and enforce per-file size limits before invoking git.
  const sizes = await Promise.all(
    files.map((rel) => fs.promises.stat(path.join(root, rel)).then((s) => s.size)),
  );
  for (let i = 0; i < files.length; i++) {
    if (sizes[i] > maxFileSize) {
      const err = new Error(
        `untracked file ${files[i]} is ${sizes[i]} bytes, exceeds limit ${maxFileSize}`,
      );
      err.code = "UNTRACKED_LIMIT_EXCEEDED";
      throw err;
    }
  }

  // Run every per-file `git diff --no-index` in parallel. Async execFile
  // avoids blocking on per-file synchronous I/O when the untracked set
  // grows. `git diff --no-index` exits 1 when differences exist (the
  // expected outcome here); execFileAsync rejects on non-zero, so we
  // resolve that rejection only for the well-defined exit-1 case and
  // re-throw anything else as a real git failure.
  const parts = await Promise.all(files.map(async (rel) => {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["diff", "--no-index", "--no-color", "--", "/dev/null", rel],
        { cwd: root, maxBuffer: maxFileSize * 4 },
      );
      return stdout;
    } catch (err) {
      // Differences-present is signalled as exit code 1 — accept it.
      if (err && err.code === 1 && typeof err.stdout === "string") return err.stdout;
      const wrapped = new Error(
        `failed to synthesize untracked diff for ${rel}: ${err.message}`,
      );
      wrapped.cause = err;
      throw wrapped;
    }
  }));
  return parts.join("");
}

function parseGitQuotedPath(value, index) {
  if (value[index] !== '"') return null;
  const parts = [];
  let cursor = index + 1;
  while (cursor < value.length) {
    const char = String.fromCodePoint(value.codePointAt(cursor));
    if (char === '"') {
      return { value: Buffer.concat(parts).toString("utf8"), next: cursor + 1 };
    }
    if (char !== "\\") {
      parts.push(Buffer.from(char, "utf8"));
      cursor += char.length;
      continue;
    }
    cursor += 1;
    const escape = value[cursor];
    if (escape === undefined) return null;
    const control = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\x0b" };
    if (Object.hasOwn(control, escape)) {
      parts.push(Buffer.from(control[escape], "utf8"));
      cursor += 1;
      continue;
    }
    if (escape === '"' || escape === "\\") {
      parts.push(Buffer.from(escape, "utf8"));
      cursor += 1;
      continue;
    }
    if (/^[0-7]$/.test(escape) && /^[0-7]{3}$/.test(value.slice(cursor, cursor + 3))) {
      parts.push(Buffer.from([Number.parseInt(value.slice(cursor, cursor + 3), 8)]));
      cursor += 3;
      continue;
    }
    return null;
  }
  return null;
}

function parseGitDiffPathToken(value, index) {
  if (value[index] === '"') return parseGitQuotedPath(value, index);
  const end = value.indexOf(" ", index);
  if (end === -1) return { value: value.slice(index), next: value.length };
  return { value: value.slice(index, end), next: end };
}

function parseGitPatchPath(value) {
  if (value.startsWith('"')) {
    const parsed = parseGitQuotedPath(value, 0);
    return parsed && parsed.next === value.length ? parsed.value : null;
  }
  return value;
}

function pathFromPatchMetadata(text, prefix) {
  const hunkStart = text.search(/^@@@? /m);
  const metadata = hunkStart === -1 ? text : text.slice(0, hunkStart);
  const match = metadata.match(new RegExp(`^${prefix} (.+?)(?:\\t.*)?\\r?$`, "m"));
  return match ? parseGitPatchPath(match[1]) : null;
}

function addGitDiffPath(paths, value, prefix = "") {
  if (value?.startsWith(prefix)) paths.push(value.slice(prefix.length));
}

function parseGitDiffPaths(header, text) {
  const prefix = "diff --git ";
  if (!header.startsWith(prefix)) return [];
  const paths = [];
  addGitDiffPath(paths, pathFromPatchMetadata(text, "---"), "a/");
  const addedPath = pathFromPatchMetadata(text, "\\+\\+\\+");
  addGitDiffPath(paths, addedPath, "b/");
  const renamedFrom = pathFromPatchMetadata(text, "rename from") || pathFromPatchMetadata(text, "copy from");
  const renamedTo = pathFromPatchMetadata(text, "rename to") || pathFromPatchMetadata(text, "copy to");
  if (renamedFrom) paths.push(renamedFrom);
  if (renamedTo) paths.push(renamedTo);
  if (paths.length > 0) return [...new Set(paths)];

  const headerPaths = header.slice(prefix.length);
  const oldPath = parseGitDiffPathToken(headerPaths, 0);
  if (!oldPath || headerPaths[oldPath.next] !== " ") return [];
  const newPath = parseGitDiffPathToken(headerPaths, oldPath.next + 1);
  if (!newPath || newPath.next !== headerPaths.length) return [];
  if (!oldPath.value.startsWith("a/") || !newPath.value.startsWith("b/")) return [];
  return [...new Set([oldPath.value.slice(2), newPath.value.slice(2)])];
}

class GitDiffSegment {
  constructor(text, paths = null) {
    if (typeof text !== "string" || text === "") throw new Error("diff segment must be a non-empty string");
    this.text = text;
    const newline = text.indexOf("\n");
    const header = (newline === -1 ? text : text.slice(0, newline)).replace(/\r$/, "");
    this.paths = Object.freeze(paths === null ? parseGitDiffPaths(header, text) : [...paths]);
    this.path = this.paths.at(-1) || null;
    Object.freeze(this);
  }

  static fromMappedPath(path, text) {
    return new GitDiffSegment(text, [path]);
  }

  hasPath() {
    return this.path !== null;
  }
}

class GateDiffCollection extends Map {
  constructor(entries = [], unparsedSegments = [], parsedSegments = [], preambleText = "") {
    super(entries);
    if (!Array.isArray(unparsedSegments) || !unparsedSegments.every((segment) => segment instanceof GitDiffSegment)) {
      throw new Error("unparsedSegments must contain GitDiffSegment values");
    }
    if (!Array.isArray(parsedSegments) || !parsedSegments.every((segment) => segment instanceof GitDiffSegment)) {
      throw new Error("parsedSegments must contain GitDiffSegment values");
    }
    if (typeof preambleText !== "string") throw new Error("preambleText must be a string");
    this.unparsedSegments = Object.freeze([...unparsedSegments]);
    this.parsedSegments = Object.freeze([...parsedSegments]);
    this.preambleText = preambleText;
  }

  static from(value) {
    if (value instanceof GateDiffCollection) return value;
    if (!(value instanceof Map)) throw new Error("perFileDiffs must be a Map");
    return new GateDiffCollection(value);
  }

  append(collection) {
    const next = GateDiffCollection.from(collection);
    const entries = new Map(this);
    for (const [file, diff] of next) entries.set(file, (entries.get(file) || "") + diff);
    return new GateDiffCollection(entries, [...this.unparsedSegments, ...next.unparsedSegments], [
      ...this.parsedSegments,
      ...next.parsedSegments,
    ], this.preambleText + next.preambleText);
  }

  retainingFiles(predicate) {
    return new GateDiffCollection(
      [...this].filter(([file]) => predicate(file)),
      this.unparsedSegments,
      this.parsedSegments.filter((segment) => predicate(segment.path)),
      this.preambleText,
    );
  }

  unparsedText() {
    return this.unparsedSegments.map((segment) => segment.text).join("");
  }

  evidenceSegments() {
    return this.parsedSegments.length > 0
      ? this.parsedSegments
      : [...this].map(([file, text]) => GitDiffSegment.fromMappedPath(file, text));
  }
}

function splitGitDiffSegments(diffText) {
  if (!diffText) return [];
  return diffText
    .split(/(?=^diff --git )/m)
    .filter((segment) => segment !== "")
    .map((segment) => new GitDiffSegment(segment));
}

function splitDiffByFile(diffText) {
  const entries = new Map();
  const unparsed = [];
  const parsed = [];
  let preambleText = "";
  for (const segment of splitGitDiffSegments(diffText)) {
    if (!segment.text.startsWith("diff --git ")) {
      preambleText += segment.text;
      continue;
    }
    if (!segment.hasPath()) {
      unparsed.push(segment);
      continue;
    }
    parsed.push(segment);
    entries.set(segment.path, (entries.get(segment.path) || "") + segment.text);
  }
  return new GateDiffCollection(entries, unparsed, parsed, preambleText);
}

function filterDiffSegments(diff, includesPath) {
  return splitGitDiffSegments(diff)
    .filter((segment) => !segment.hasPath() || includesPath(segment.path))
    .map((segment) => segment.text)
    .join("");
}

export function excludeScenarioValidityEvidenceFromTaskGateDiff(diff, specPath) {
  if (typeof diff !== "string") throw new Error("diff must be a string");
  if (typeof specPath !== "string" || specPath.trim() === "") {
    throw new Error("specPath must be a non-empty string");
  }
  const registry = new RepairArtifactRegistry(specPath);
  return filterDiffSegments(diff, (file) => !registry.owns(file));
}

export function excludeGateLifecycleArtifactsFromGateDiff(diff, specPath) {
  if (typeof diff !== "string") throw new Error("diff must be a string");
  return filterDiffSegments(diff, (file) => !isGateLifecycleArtifactForGate(file, specPath));
}

export function excludeGeneratedSpecArtifactsFromGateDiff(diff, specPath) {
  if (typeof diff !== "string") throw new Error("diff must be a string");
  return filterDiffSegments(diff, (file) => shouldIncludeGateDiffFile(file, specPath));
}

function shouldIncludeGateDiffFile(relPath, specPath) {
  return !isGeneratedSpecArtifactForGate(relPath, specPath);
}

function excludeGeneratedSpecArtifactsFromPerFileDiffs(perFileDiffs, specPath) {
  return GateDiffCollection.from(perFileDiffs)
    .retainingFiles((file) => shouldIncludeGateDiffFile(file, specPath));
}

function buildGateEvaluationDiff({ committed, uncommitted, untracked, specPath }) {
  return excludeGateLifecycleArtifactsFromGateDiff(
    excludeGeneratedSpecArtifactsFromGateDiff(committed + uncommitted + untracked, specPath),
    specPath,
  );
}

function collectPerFileDiffsForGate(committed, uncommitted, untracked) {
  return splitDiffByFile(committed)
    .append(splitDiffByFile(uncommitted))
    .append(splitDiffByFile(untracked));
}

function taskCursorRequiredGateFailure(scopeDecision, phase, state) {
  return Envelope.fail(
    "run",
    "gate",
    "TASK_CURSOR_REQUIRED",
    taskScopeViolationMessages(scopeDecision, "impl-gate"),
    { phase, currentTaskId: state.currentTaskId ?? null },
  );
}

function isGeneratedSpecArtifactForGate(relPath, specPath) {
  if (!specPath) return false;
  return new RepairArtifactRegistry(specPath).owns(relPath);
}

function isGateLifecycleArtifactForGate(relPath, specPath) {
  if (!specPath) return false;
  return new RepairArtifactRegistry(specPath).owns(relPath);
}

function sectionAt(lines, lineIdx) {
  for (let i = lineIdx - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*##\s+(.+)/);
    if (m) return m[1].trim();
  }
  return "";
}

// ---------------------------------------------------------------------------
// Unresolved-marker patterns (shared by markdown and JSON checkers)
// ---------------------------------------------------------------------------

const UNRESOLVED_PATTERNS = Object.freeze([
  /\[NEEDS CLARIFICATION\]/i,
  /\bTBD\b/i,
  /\bTODO\b/i,
  /\bFIXME\b/i,
]);

function findUnresolvedMatch(text) {
  for (const p of UNRESOLVED_PATTERNS) {
    const m = text.match(p);
    if (m) return m[0];
  }
  return null;
}

// ---------------------------------------------------------------------------
// Text checks — task draft markdown (used by phase=task-spec)
// ---------------------------------------------------------------------------

/**
 * @param {string} text
 * @returns {string[]} issues
 */
function checkSpecText(text) {
  const issues = [];
  const lines = text.split("\n");

  const PRE_SKIP_SECTIONS = /^(Status|Acceptance Criteria|User Scenarios\s*&?\s*Testing|User Confirmation)/i;

  for (const [idx, line] of lines.entries()) {
    if (/^\s*\|/.test(line)) continue;

    if (findUnresolvedMatch(line)) {
      issues.push(`line ${idx + 1}: unresolved token (${line.trim()})`);
    }
    if (/^\s*-\s*\[\s\]\s+/.test(line)) {
      const section = sectionAt(lines, idx);
      if (PRE_SKIP_SECTIONS.test(section)) continue;
      issues.push(`line ${idx + 1}: unchecked task/question (${line.trim()})`);
    }
  }

  if (!/^\s*##\s+Clarifications\b/im.test(text)) {
    issues.push("missing section: ## Clarifications");
  }
  if (!/^\s*##\s+Open Questions\b/im.test(text)) {
    issues.push("missing section: ## Open Questions");
  }
  if (!/^\s*##\s+User Confirmation\b/im.test(text)) {
    issues.push("missing section: ## User Confirmation");
  }
  const hasAcceptance =
    /^\s*##\s+Acceptance Criteria\b/im.test(text) ||
    /^\s*##\s+User Scenarios\s*&\s*Testing\b/im.test(text) ||
    /^\s*##\s+User Scenarios\b/im.test(text);
  if (!hasAcceptance) {
    issues.push(
      "missing section: ## Acceptance Criteria (or ## User Scenarios & Testing)",
    );
  }

  return issues;
}

// ---------------------------------------------------------------------------
// JSON checks — parent spec.json (used by phase=spec)
// ---------------------------------------------------------------------------

/**
 * Scan a parsed spec.json tree for unresolved markers in human-authored
 * string values. Schema validation is performed at the caller via
 * `validateSpecJsonObject()`; this function operates on an already-validated
 * cataloged spec object.
 *
 * @param {object} spec - parsed and schema-validated spec.json
 * @returns {string[]} issues, each prefixed with the dotted field path
 */
function checkSpecJson(spec) {
  return checkSpecGateReadiness(spec);
}

// ---------------------------------------------------------------------------
// JSON checks — draft (spec 229: draft.md → draft.json)
// ---------------------------------------------------------------------------

function checkDraftJson(draft) {
  return validateDraftLifecycle(draft);
}

// ---------------------------------------------------------------------------
// Guardrail AI prompt (structured JSON schema)
// ---------------------------------------------------------------------------

export const IMPL_DIFF_SCOPE_LINES = [
  "## Diff Scope Constraint",
  "The content includes a `## Git Diff` section. Restrict violation judgment to code changes",
  "actually introduced by this diff — that is, lines added or modified (lines starting with `+`",
  "in the diff). Context lines (unchanged, pre-existing code shown without `+`/`-` markers, or",
  "removed-only `-` lines that are not being replaced) MUST NOT be counted as violations of any",
  "guardrail. If a pattern that appears to violate a guardrail exists only in pre-existing,",
  "unchanged code, mark the article as pass with a reason stating the violation is out of diff scope.",
  "",
];

// Phases where diff-scope constraint applies (task-impl and integration both operate on git diff).
const DIFF_SCOPED_PHASES = Object.freeze(["task-impl", "integration"]);

function filterGuardrailsForEvaluation(guardrails, phase, excludedIds = []) {
  const excluded = new Set(excludedIds);
  return filterByPhase(guardrails, phase)
    .filter((guardrail) => !excluded.has(guardrail.id));
}

/**
 * Build AI prompt for structured guardrail-article evaluation.
 *
 * Accepts ALL guardrails and filters them internally by phase. When a caller
 * has already filtered, use {@link buildGuardrailArticleEvalPrompt} instead
 * to avoid re-filtering.
 *
 * @param {string} targetText - text to evaluate
 * @param {Array} guardrails - guardrails (unfiltered)
 * @param {string} phase - gate phase
 * @param {string} [role] - checker role override
 * @param {string[]} [previouslyPassedIds] - guardrail IDs that passed in previous evaluation
 * @returns {string|null} prompt, or null if no guardrails match phase
 */
function buildGuardrailPrompt(targetText, guardrails, phase, role, previouslyPassedIds, options = {}) {
  const filtered = filterGuardrailsForEvaluation(
    guardrails,
    phase,
    options.excludedGuardrailIds,
  );
  const pb = buildGuardrailArticleEvalPrompt(
    targetText,
    filtered,
    phase,
    role,
    previouslyPassedIds,
    options,
  );
  if (!pb) return null;
  const built = pb.build();
  const parts = [];
  if (built.systemPrompt) parts.push(built.systemPrompt);
  if (built.fmtFallback) parts.push(built.fmtFallback);
  if (built.userPrompt) parts.push(built.userPrompt);
  return parts.join("\n\n");
}

/**
 * Variant of {@link buildGuardrailPrompt} that takes pre-filtered guardrails.
 * Used by internal callers (e.g. {@link checkGuardrail}) that have already
 * filtered by phase and want to avoid the redundant pass.
 *
 * @param {string[]} [previouslyPassedIds] - guardrail IDs that passed in a prior evaluation (spec 229)
 */
// spec 255 R1: split the shared GUARDRAIL_EVAL_SCHEMA into two distinct schemas.
// Article evaluation: per-FAIL violations[] structured enumeration with target/where/why_violates.
// Implementation requirement check: unchanged single-reason shape.
export const GUARDRAIL_ARTICLE_EVAL_SCHEMA = {
  type: "object",
  properties: {
    observations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          failureMode: { type: "string", enum: ["guardrail-violation"] },
          requirementRef: { type: "string" },
          where: {
            type: ["object", "null"],
            properties: {
              file: { type: "string" },
              locator: { type: ["string", "null"] },
            },
            required: ["file", "locator"],
            additionalProperties: false,
          },
          observed: { type: "string" },
        },
        required: ["failureMode", "requirementRef", "where", "observed"],
        additionalProperties: false,
      },
    },
  },
  required: ["observations"],
  additionalProperties: false,
};

export const IMPL_REQUIREMENT_EVAL_SCHEMA = {
  type: "object",
  properties: {
    evaluations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          guardrail_id: { type: "string" },
          result: { type: "string", enum: ["pass", "fail", "skip"] },
          reason: { type: "string" },
        },
        required: ["guardrail_id", "result", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["evaluations"],
  additionalProperties: false,
};

export const GUARDRAIL_FMT_FALLBACK = [
  "OUTPUT FORMAT — strictly required:",
  "Return a single JSON object matching this shape:",
  '  {"observations":[{"failureMode":"guardrail-violation","requirementRef":"<guardrail id>","where":{"file":"<path or artifact>","locator":"<locator or null>"},"observed":"<concrete violation>"}]}',
  "  - Include one observation per concrete FAIL occurrence/edit location.",
  "  - Use null for where.locator when it does not apply.",
  "  - If every listed guardrail passes, return {\"observations\":[]}.",
  "Output MUST be valid JSON. No preamble, no trailing commentary, no Markdown prose — JSON only.",
].join("\n");

const IMPL_REQUIREMENT_FMT_FALLBACK = [
  "OUTPUT FORMAT — strictly required:",
  "Return a single JSON object matching this shape:",
  '  {"evaluations":[{"guardrail_id":"<id>","result":"pass"|"fail"|"skip","reason":"<brief>"}]}',
  "Output MUST be valid JSON. No preamble, no trailing commentary, no Markdown prose — JSON only.",
].join("\n");

function exactIdSchema(baseSchema, collectionKey, idKey, knownIds) {
  const ids = [...knownIds];
  return {
    ...baseSchema,
    properties: {
      ...baseSchema.properties,
      [collectionKey]: {
        ...baseSchema.properties[collectionKey],
        items: {
          ...baseSchema.properties[collectionKey].items,
          properties: {
            ...baseSchema.properties[collectionKey].items.properties,
            [idKey]: { type: "string", enum: ids },
          },
        },
      },
    },
  };
}

function exactIdFallback(baseFallback, placeholder, knownIds) {
  const ids = [...knownIds];
  return [
    baseFallback.replace(placeholder, ids.join("|")),
    `Allowed IDs (exact match only): ${ids.join(", ")}`,
    "Do not add prefixes, suffixes, descriptions, or explanatory text to an ID.",
  ].join("\n");
}

// spec 255 R6: rename buildGuardrailPromptFromFiltered to buildGuardrailArticleEvalPrompt
// and add exhaustive-enumeration directive in the rules text.
class GuardrailEvidenceObligation {
  constructor(article) {
    this.id = article.id;
    this.title = article.title;
    this.body = article.body;
    Object.freeze(this);
  }

  toPromptText() {
    return `Guardrail ${this.id}: ${this.title}\n${this.body}`;
  }
}

export function buildGuardrailArticleEvalPrompt(targetText, filtered, phase, role, previouslyPassedIds, options = {}) {
  if (filtered.length === 0) return null;

  const articleList = filtered
    .map((g) => options.completeEvidence
      ? `- id: ${g.id}\n  title: ${g.title}`
      : `- id: ${g.id}\n  title: ${g.title}\n  body: ${g.body.trim()}`)
    .join("\n");

  const checkerRole = role || `You are a ${phase} compliance checker.`;

  const pb = new PromptBuilder();
  pb.setRole(`${checkerRole} Check the following content against each guardrail article.`);

  const rules = [
    "- Evaluate every guardrail article listed below, identified by its id.",
    "- Evaluate only explicit requirements stated in the listed guardrail article body. Do not invent additional design, codebase-context, or completeness criteria.",
    "- This is a readiness gate, not a design review. Do not search for new implementation-target gaps, existing-behavior gaps, integration choices, or product-scope issues unless the guardrail article explicitly requires that check.",
    "- If a concern is not directly grounded in a listed guardrail article, it must not be reported as a FAIL here.",
    "- Return `observations` only. Do not return `evaluations`, `result`, `reason`, `violations`, `kind`, `severity`, or `refs`.",
    "- Exhaustive enumeration: emit ONE observation per occurrence/edit location. Repeated occurrences of the same vague phrase in different places are distinct entries — distinguishable by `where`. Do NOT group or summarize.",
    "- For document-level guardrails (rule violations that have no concrete passage to quote — e.g. a missing required section): emit one OR MORE observations, one per distinct gap. Use `where.file` as the artifact name (e.g. \"spec.json\").",
    "- When a diff-scope section is present below, list ONLY violations introduced by the diff (lines added or modified, marked with `+`).",
    "- Omit observations for passing, skipped, inapplicable, or runtime-dependent guardrails.",
    "- Matched Spec Acknowledgment Rationale is context only. Exception permission comes from the guardrail article clause, not from the rationale section alone.",
    "- To acknowledge a guardrail exception in a spec, write the target guardrail_id directly in constraints, clarifications, or alternatives_considered.",
    "- For each FAIL, describe the actionable Observation using these AI-owned fields: failureMode, requirementRef, where, observed. The system derives kind, severity, and refs.",
  ].join("\n");
  pb.setRules(rules);
  const knownIds = filtered.map((guardrail) => guardrail.id);
  pb.setJsonSchema(exactIdSchema(
    GUARDRAIL_ARTICLE_EVAL_SCHEMA,
    "observations",
    "requirementRef",
    knownIds,
  ));
  pb.setFmtFallback(exactIdFallback(GUARDRAIL_FMT_FALLBACK, "<guardrail id>", knownIds));

  if (Array.isArray(previouslyPassedIds) && previouslyPassedIds.length > 0) {
    pb.addUserPrompt(
      "## Previously Passed Guardrails",
      "The following guardrail IDs passed in a previous evaluation of this content.\n"
        + "Only FAIL these if the current content specifically introduces a new violation.\n"
        + "IDs: " + previouslyPassedIds.join(", "),
    );
  }

  if (DIFF_SCOPED_PHASES.includes(phase)) {
    pb.addUserPrompt("## Diff Scope Constraint", IMPL_DIFF_SCOPE_LINES.slice(1).join("\n"));
  }

  pb.addUserPrompt(
    "## Observation Output Fields",
    "For each FAIL, emit only these AI-owned Observation fields: failureMode, requirementRef, where, observed.",
  );

  pb.addUserPrompt("## Guardrail Articles", articleList);
  if (options.completeEvidence) {
    pb.addUserPrompt("## Complete Evidence Judgment", [
      "Every canonical source/context range has been evaluated. Reconcile supporting facts, contradictions, and unresolved questions across all ranges before judging.",
      "Evaluate document-level omissions across the full collected evidence, not by absence from one source range.",
      "Apply explicit article exception clauses using the collected acknowledgment rationale. Rationale alone cannot grant an exception.",
      "Report each remaining violation at its original location; preserve distinct occurrences. Do not cite evidence serialization as project content.",
    ].join("\n"));
  }
  if (options?.acknowledgedRationale?.markdown) {
    pb.addUserRaw(options.acknowledgedRationale.markdown);
  }
  if (options?.priorMemoryMarkdown) {
    pb.addUserRaw(options.priorMemoryMarkdown);
  }
  pb.addUserPrompt("## Content", targetText);

  return pb;
}

// ---------------------------------------------------------------------------
// Structured evaluation parser (REQ-5/6/7)
// ---------------------------------------------------------------------------

class EvaluationSchemaEvidence {
  constructor(input = {}) {
    this.failureMode = input.failureMode || "schema_validation_failure";
    this.locator = input.locator ?? null;
    this.invalidValue = input.invalidValue ?? null;
    this.primary = input.primary !== false;
    Object.freeze(this);
  }
}

export class EvaluationSchemaError extends Error {
  constructor(message, evidence = {}) {
    super(message);
    this.name = "EvaluationSchemaError";
    this.code = "EVALUATION_SCHEMA_ERROR";
    this.data = evidence instanceof EvaluationSchemaEvidence
      ? evidence
      : new EvaluationSchemaEvidence(evidence);
  }
}

const ALLOWED_RESULT_VALUES = Object.freeze(["pass", "fail", "skip"]);

/**
 * Strip common wrappers (code fences, leading/trailing noise) and extract
 * the first complete JSON object. If no complete object is detectable, return
 * the original text so JSON.parse can surface a clear error.
 */
function extractJsonCandidate(raw) {
  let text = String(raw).trim();
  // Strip ``` or ```json fences
  const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  // Trim to the first balanced object. Providers can append a second JSON
  // payload or prose after a valid response; using the final brace would join
  // those distinct values into invalid JSON.
  const firstBrace = text.indexOf("{");
  if (firstBrace < 0) return text;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = firstBrace; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(firstBrace, index + 1);
    }
  }
  return text;
}

// spec 255 R2/R3/R4/R19/R20: split parseEvaluationResponse into two parsers.
//   parseGuardrailArticleEvaluation: enforces FAIL→violations[] / PASS|SKIP→reason,
//     derives reason summary on FAIL, rejects unknown / duplicate / missing ids and extra keys.
//   parseImplRequirementEvaluation: preserves the legacy single-reason contract verbatim.

const ARTICLE_ENTRY_KEYS = new Set(["guardrail_id", "result", "reason", "violations"]);
const REQUIREMENT_ENTRY_KEYS = new Set(["guardrail_id", "result", "reason"]);
const VIOLATION_KEYS = new Set(["target", "where", "why_violates"]);
const AI_OBSERVATION_KEYS = new Set(["failureMode", "requirementRef", "where", "observed"]);

function parseEvaluationsArray(rawResponse) {
  const candidate = extractJsonCandidate(rawResponse);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new EvaluationSchemaError(
      `AI evaluation response is not valid JSON: ${err.message}`,
      { failureMode: "parse_failure", locator: "$", invalidValue: candidate },
    );
  }
  if (!parsed || typeof parsed !== "object") {
    throw new EvaluationSchemaError("AI evaluation response is not a JSON object");
  }
  if (!Array.isArray(parsed.evaluations)) {
    throw new EvaluationSchemaError(
      'AI evaluation response missing "evaluations" array',
    );
  }
  return parsed.evaluations;
}

function parseJsonObject(rawResponse) {
  const candidate = extractJsonCandidate(rawResponse);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    throw new EvaluationSchemaError(
      `AI evaluation response is not valid JSON: ${err.message}`,
      { failureMode: "parse_failure", locator: "$", invalidValue: candidate },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EvaluationSchemaError("AI evaluation response is not a JSON object");
  }
  return parsed;
}

function checkExtraKeys(entry, idx, allowed, label) {
  for (const k of Object.keys(entry)) {
    if (!allowed.has(k)) {
      throw new EvaluationSchemaError(
        `${label}[${idx}]: unknown property "${k}"`,
      );
    }
  }
}

function deriveArticleFailReason(violations) {
  return violations
    .map((v) => `${v.target} — ${v.why_violates} (at ${v.where})`)
    .join("; ");
}

function buildPassEvaluationsForObservedGuardrails(guardrails) {
  return guardrails.map((guardrail) => ({
    guardrail_id: guardrail.id,
    result: "pass",
    reason: "no observations emitted",
    category: guardrail.meta.category || "guardrail",
    title: guardrail.title || guardrail.id,
    observations: [],
  }));
}

/**
 * Parse the structured AI guardrail-article evaluation response (spec 255).
 *
 * @param {string} rawResponse
 * @param {string[]} knownIds
 * @returns {Array<Object>} Observation JSON entries
 * @throws {EvaluationSchemaError}
 */
export function parseGuardrailArticleEvaluation(rawResponse, knownIds) {
  const rawObject = parseJsonObject(rawResponse);
  if (Array.isArray(rawObject.observations)) {
    const known = new Set(knownIds);
    return rawObject.observations.map((entry, idx) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new EvaluationSchemaError(`observations[${idx}] is not an object`);
      }
      checkExtraKeys(entry, idx, AI_OBSERVATION_KEYS, "observations");
      for (const key of AI_OBSERVATION_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(entry, key)) {
          throw new EvaluationSchemaError(`observations[${idx}]: missing required "${key}"`);
        }
      }
      if (!known.has(entry.requirementRef)) {
        throw new EvaluationSchemaError(
          `observations[${idx}]: unknown requirementRef "${entry.requirementRef}"`,
          {
            locator: `observations[${idx}].requirementRef`,
            invalidValue: entry.requirementRef,
          },
        );
      }
      return new Observation({
        kind: "violation",
        failureMode: entry.failureMode,
        requirementRef: entry.requirementRef,
        where: entry.where ?? null,
        observed: entry.observed,
        severity: "blocking",
        refs: [entry.requirementRef],
      }).toJSON();
    });
  }
  if (!Array.isArray(rawObject.evaluations)) {
    throw new EvaluationSchemaError('AI evaluation response missing "evaluations" or "observations" array');
  }
  const evaluations = rawObject.evaluations;
  const known = new Set(knownIds);
  const seen = new Set();
  const results = [];
  for (const [idx, entry] of evaluations.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new EvaluationSchemaError(`evaluations[${idx}] is not an object`);
    }
    checkExtraKeys(entry, idx, ARTICLE_ENTRY_KEYS, "evaluations");

    const { guardrail_id, result } = entry;
    if (typeof guardrail_id !== "string" || !guardrail_id) {
      throw new EvaluationSchemaError(
        `evaluations[${idx}]: guardrail_id must be a non-empty string`,
      );
    }
    if (!known.has(guardrail_id)) {
      throw new EvaluationSchemaError(
        `evaluations[${idx}]: unknown guardrail_id "${guardrail_id}"`,
        {
          locator: `evaluations[${idx}].guardrail_id`,
          invalidValue: guardrail_id,
        },
      );
    }
    if (seen.has(guardrail_id)) {
      throw new EvaluationSchemaError(
        `evaluations[${idx}]: duplicate guardrail_id "${guardrail_id}"`,
      );
    }
    seen.add(guardrail_id);
    if (!ALLOWED_RESULT_VALUES.includes(result)) {
      throw new EvaluationSchemaError(
        `evaluations[${idx}]: result must be one of pass|fail|skip (got "${result}")`,
      );
    }

    if (result === "fail") {
      if (!Array.isArray(entry.violations) || entry.violations.length === 0) {
        throw new EvaluationSchemaError(
          `evaluations[${idx}]: FAIL requires non-empty violations[]`,
        );
      }
      const violationKey = new Set();
      const violations = [];
      for (const [vIdx, v] of entry.violations.entries()) {
        if (!v || typeof v !== "object" || Array.isArray(v)) {
          throw new EvaluationSchemaError(
            `evaluations[${idx}].violations[${vIdx}] is not an object`,
          );
        }
        checkExtraKeys(v, vIdx, VIOLATION_KEYS, `evaluations[${idx}].violations`);
        for (const field of ["target", "where", "why_violates"]) {
          if (typeof v[field] !== "string" || !v[field].trim()) {
            throw new EvaluationSchemaError(
              `evaluations[${idx}].violations[${vIdx}]: ${field} must be a non-empty string`,
            );
          }
        }
        const key = `${v.target.trim()}|${v.where.trim()}`;
        if (violationKey.has(key)) {
          throw new EvaluationSchemaError(
            `evaluations[${idx}].violations[${vIdx}]: duplicate (target, where) pair "${key}"`,
          );
        }
        violationKey.add(key);
        violations.push({
          target: v.target.trim(),
          where: v.where.trim(),
          why_violates: v.why_violates.trim(),
        });
      }
      results.push({
        guardrail_id,
        result,
        reason: deriveArticleFailReason(violations),
        violations,
      });
    } else {
      // pass / skip
      if (entry.violations !== undefined) {
        throw new EvaluationSchemaError(
          `evaluations[${idx}]: ${result.toUpperCase()} entry must not include violations`,
        );
      }
      const reason = entry.reason;
      if (typeof reason !== "string" || !reason.trim()) {
        throw new EvaluationSchemaError(
          `evaluations[${idx}]: ${result.toUpperCase()} entry requires a non-empty reason`,
        );
      }
      results.push({ guardrail_id, result, reason: reason.trim() });
    }
  }
  const missing = knownIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new EvaluationSchemaError(
      `evaluations missing for guardrail_id(s): ${missing.join(", ")}`,
    );
  }
  return legacyEvaluationsToNextAction({
    evaluations: results,
    prescription: "gate",
  }).diagnosis.observations.map((observation) => observation.toJSON());
}

/**
 * Parse the structured AI implementation-requirement evaluation response (spec 255).
 * Preserves the legacy single-reason contract verbatim.
 *
 * @param {string} rawResponse
 * @param {string[]} knownIds
 * @returns {Array<{guardrail_id: string, result: string, reason: string}>}
 * @throws {EvaluationSchemaError}
 */
export function parseImplRequirementEvaluation(rawResponse, knownIds) {
  const evaluations = parseEvaluationsArray(rawResponse);
  const known = new Set(knownIds);
  const seen = new Set();
  const results = [];
  for (const [idx, entry] of evaluations.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new EvaluationSchemaError(`evaluations[${idx}] is not an object`);
    }
    checkExtraKeys(entry, idx, REQUIREMENT_ENTRY_KEYS, "evaluations");

    const { guardrail_id, result, reason } = entry;
    if (typeof guardrail_id !== "string" || !guardrail_id) {
      throw new EvaluationSchemaError(
        `evaluations[${idx}]: guardrail_id must be a non-empty string`,
      );
    }
    if (!known.has(guardrail_id)) {
      throw new EvaluationSchemaError(
        `evaluations[${idx}]: unknown guardrail_id "${guardrail_id}"`,
        {
          locator: `evaluations[${idx}].guardrail_id`,
          invalidValue: guardrail_id,
        },
      );
    }
    if (seen.has(guardrail_id)) {
      throw new EvaluationSchemaError(
        `evaluations[${idx}]: duplicate guardrail_id "${guardrail_id}"`,
      );
    }
    seen.add(guardrail_id);
    if (!ALLOWED_RESULT_VALUES.includes(result)) {
      throw new EvaluationSchemaError(
        `evaluations[${idx}]: result must be one of pass|fail|skip (got "${result}")`,
      );
    }
    if (typeof reason !== "string" || !reason.trim()) {
      throw new EvaluationSchemaError(
        `evaluations[${idx}]: reason must be a non-empty string`,
      );
    }
    results.push({ guardrail_id, result, reason: reason.trim() });
  }
  const missing = knownIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new EvaluationSchemaError(
      `evaluations missing for guardrail_id(s): ${missing.join(", ")}`,
    );
  }
  return results;
}

// ---------------------------------------------------------------------------
// Gate report builder (REQ-8)
// ---------------------------------------------------------------------------

/**
 * Build a structured gate report. Throws if any required field is missing
 * or malformed — callers must pass a complete input.
 */
export function buildGateReport({ level, phase, evaluations }) {
  if (!level) throw new Error("buildGateReport: level is required");
  if (!phase) throw new Error("buildGateReport: phase is required");
  validateLevelPhase(level, phase);
  if (arguments[0]?.observations !== undefined) {
    const input = arguments[0];
    const observations = normalizeObservations(input.observations || []);
    const hasBlocking = observations.some((observation) => observation.severity === "blocking");
    const verdict = hasBlocking ? "fail" : "pass";
    const prescription = verdict === "fail" ? input.failPrescription : input.passPrescription;
    return {
      level,
      phase,
      verdict,
      nextAction: new NextAction({
        diagnosis: new Diagnosis({
          summary: observations.length === 0
            ? "No observations."
            : `${observations.length} observation(s).`,
          observations,
        }),
        prescription,
      }).toJSON(),
    };
  }
  if (!Array.isArray(evaluations)) {
    throw new Error("buildGateReport: evaluations array is required");
  }
  for (const [idx, ev] of evaluations.entries()) {
    if (!ev.guardrail_id) {
      throw new Error(`buildGateReport: evaluations[${idx}].guardrail_id is required`);
    }
    if (!ALLOWED_RESULT_VALUES.includes(ev.result)) {
      throw new Error(
        `buildGateReport: evaluations[${idx}].result must be one of pass|fail|skip`,
      );
    }
    if (typeof ev.reason !== "string" || !ev.reason) {
      throw new Error(`buildGateReport: evaluations[${idx}].reason is required`);
    }
    if (!ev.category) {
      throw new Error(`buildGateReport: evaluations[${idx}].category is required`);
    }
  }
  return { level, phase, evaluations };
}

function normalizeObservations(observations) {
  if (!Array.isArray(observations)) throw new Error("observations must be an array");
  return observations.map((entry) => entry instanceof Observation ? entry : Observation.fromJSON(entry));
}

export function buildGateResultArtifact({
  level,
  phase,
  target,
  verdict,
  observations,
  evaluations,
  passPrescription,
  failPrescription,
}) {
  const report = observations !== undefined
    ? buildGateReport({ level, phase, observations, passPrescription, failPrescription })
    : { nextAction: legacyEvaluationsToNextAction({
        evaluations,
        prescription: verdict === "fail" ? failPrescription : passPrescription,
      }).toJSON() };
  return {
    result: verdict,
    changed: [],
    artifacts: {
      target,
      level,
      phase,
      evaluations: evaluations || [],
      nextAction: report.nextAction,
    },
  };
}

// ---------------------------------------------------------------------------
// Guardrail AI check — shared
// ---------------------------------------------------------------------------

async function callGateAgent(agent, built, attempt, providerCallAdmission) {
  let cacheDecision = null;
  const text = await agent.call(built.userPrompt, {
    commandId: "flow.spec.gate",
    systemPrompt: built.systemPrompt,
    jsonSchema: built.jsonSchema,
    fmtFallback: built.fmtFallback,
    providerCallAdmission,
    cacheMode: attempt.cacheMode,
    onCacheDecision(decision) { cacheDecision = decision; },
  });
  return {
    text,
    cacheOutcome: cacheDecision?.cacheOutcome || attempt.cacheMode,
    fresh: cacheDecision?.fresh ?? attempt.repair,
    providerCalled: cacheDecision?.providerCalled ?? true,
  };
}

function createGateExecutionBudget() {
  return new PromptExecutionBudget(new PromptExecutionLimit({ maxProtocolRetryCount: 1 }));
}

function gateInvocationProjector(agent) {
  return typeof agent.projectInvocation === "function"
    ? (request) => agent.projectInvocation(request.userPrompt, { ...request, commandId: "flow.spec.gate" })
    : undefined;
}

function requiredGuardrailFailure(failureKind, failureCode, failureReason, details = {}) {
  return {
    passed: false,
    evaluations: [],
    failureKind,
    failureCode,
    failureReason,
    ...details,
  };
}

function requiredGateAgentResolutionFailure(agent) {
  try {
    if (agent.resolve("flow.spec.gate")) return null;
  } catch (error) {
    const failure = error instanceof AgentFailure ? error : AgentFailure.from(error);
    return requiredGuardrailFailure(
      "agent-configuration",
      failure.code,
      failure.message,
      {
        retryable: failure.retryable,
        recoveryHint: failure.recoveryHint,
        agentFailureKind: failure.kind,
        agentAttemptCount: failure.attemptCount,
        agentMaxAttempts: failure.maxAttempts,
      },
    );
  }
  return requiredGuardrailFailure(
    "agent-unset",
    "GATE_REQUIRED_AGENT_UNSET",
    "required gate evaluation agent is not configured",
    {
      retryable: false,
      recoveryHint: "Configure flow.spec.gate to a usable provider before starting a new gate attempt.",
    },
  );
}

function requiredGateEvaluationFailure(error) {
  // Preserve the existing protocol/provider recovery classification through
  // the shared executor's incomplete-batch wrapper.
  while (error instanceof PromptBatchingError && error.cause) error = error.cause;
  const sourceError = error instanceof GateOutputProtocolFailure ? error.cause : error;
  if (sourceError instanceof PromptBatchingError) {
    return requiredGuardrailFailure("input", sourceError.code, sourceError.message, {
      retryable: false,
      recoveryHint: "Inspect the named prompt input, coverage, or execution limit before retrying.",
    });
  }
  const agentFailure = sourceError instanceof AgentFailure ? sourceError : null;
  const schema = error instanceof EvaluationSchemaError
    || (error instanceof GateOutputProtocolFailure
      && error.data?.failureMode === "schema_validation_failure");
  const spawn = sourceError?.code === "ENOENT"
    || /spawn|executable|not found/i.test(sourceError?.message || "");
  const output = schema || (error instanceof GateOutputProtocolFailure
    && error.data?.failureMode === "parse_failure");
  return requiredGuardrailFailure(
    output ? (schema ? "schema" : "output") : (spawn ? "agent-spawn" : "agent-evaluation"),
    output
      ? (schema ? "GATE_REQUIRED_SCHEMA" : "GATE_REQUIRED_OUTPUT")
      : (agentFailure?.code || (spawn ? "GATE_REQUIRED_AGENT_SPAWN" : "GATE_REQUIRED_AGENT_EVALUATION")),
    error.message,
    {
      retryable: agentFailure?.retryable ?? false,
      recoveryHint: agentFailure?.recoveryHint
        || (output
          ? "Correct the gate response protocol before starting a new attempt."
          : "Repair the gate provider failure before starting a new attempt."),
      ...(agentFailure ? {
        agentFailureKind: agentFailure.kind,
        agentAttemptCount: agentFailure.attemptCount,
        agentMaxAttempts: agentFailure.maxAttempts,
      } : {}),
    },
  );
}

async function checkGuardrail(root, targetText, phase, role, previouslyPassedIds, options = {}) {
  const loadGuardrails = options.loadGuardrails || loadMergedGuardrails;
  let guardrails;
  try {
    guardrails = loadGuardrails(root);
  } catch (error) {
    if (error instanceof PromptBatchingError) return requiredGateEvaluationFailure(error);
    const spawn = error?.code === "ENOENT" || /spawn|executable|not found/i.test(error?.message || "");
    return requiredGuardrailFailure(
      spawn ? "guardrail-spawn" : "guardrail-evaluation",
      spawn ? "GATE_REQUIRED_GUARDRAIL_SPAWN" : "GATE_REQUIRED_GUARDRAIL",
      error.message,
    );
  }
  if (!guardrails || guardrails.length === 0) {
    return requiredGuardrailFailure(
      "guardrail-unset",
      "GATE_REQUIRED_GUARDRAIL_UNSET",
      "required gate guardrail evaluation is not configured",
    );
  }

  const filtered = filterGuardrailsForEvaluation(
    guardrails,
    phase,
    options.excludedGuardrailIds,
  );
  if (filtered.length === 0) return { passed: true, evaluations: [] };
  const filteredIds = new Set(filtered.map((g) => g.id));
  const promptPreviouslyPassedIds = Array.isArray(previouslyPassedIds)
    ? previouslyPassedIds.filter((id) => filteredIds.has(id))
    : previouslyPassedIds;

  const agent = options.agent || container.get("agent");
  const resolutionFailure = requiredGateAgentResolutionFailure(agent);
  if (resolutionFailure) return resolutionFailure;

  const pb = buildGuardrailArticleEvalPrompt(
    targetText,
    filtered,
    phase,
    role,
    promptPreviouslyPassedIds,
    options,
  );
  if (!pb) return { passed: true, evaluations: [] };

  const built = pb.build();
  const knownIds = filtered.map((g) => g.id);
  let parsed;
  try {
    const limit = new PromptRequestLimit({ maxCharacters: agent.promptCharacterLimit ?? MAX_IMPL_REQUIREMENT_BATCH_CHARS });
    const projectInvocation = gateInvocationProjector(agent);
    const direct = gatePromptFits(built, limit);
    const evidencePlans = direct ? [] : filtered.map((article) => new RequirementEvidencePlan({
      requirement: new GuardrailEvidenceObligation(article), limit,
      inputs: [
        new RequirementEvidenceInput({ id: `${article.id}:source`, text: targetText }),
        new RequirementEvidenceInput({ id: `${article.id}:rationale`, text: options.acknowledgedRationale?.markdown ?? "" }),
        new RequirementEvidenceInput({ id: `${article.id}:prior-memory`, text: options.priorMemoryMarkdown ?? "" }),
      ],
    }));
    const plans = direct
      ? [PromptBatchPlan.fromRequest({ request: built, limit, id: "guardrail-request" })]
      : evidencePlans.map((evidence) => evidence.plan);
    if (projectInvocation) {
      for (const plan of plans) {
        for (const batch of plan.batches) projectInvocation(batch.request).assertWithinLimit(limit);
      }
    }
    const executionBudget = options.executionBudget ?? createGateExecutionBudget();
    executionBudget.assertCanExecute(plans.reduce((count, plan) => count + plan.batches.length, evidencePlans.length));
    const observations = [];
    const callAgent = (request, _batch, _index, attempt, providerCallAdmission) => callGateAgent(agent, request, attempt, providerCallAdmission);
    for (const [index, initialPlan] of plans.entries()) {
      let plan = initialPlan;
      if (!direct) {
        const evidencePlan = evidencePlans[index];
        const article = filtered[index];
        const protocolPolicy = new GateOutputProtocolPolicy({
          phase,
          parseResponse: (raw, batch) => new RequirementObservationResponse(parseJsonObject(raw), article.id, batch),
        });
        const evidence = await evidencePlan.execute({ callAgent, projectInvocation, protocolPolicy, executionBudget });
        const request = await reduceRequirementEvidence({
          evidence, requirement: evidencePlan.requirement, limit, projectInvocation, protocolPolicy, executionBudget,
          evaluateBatch: callAgent,
          buildFinalRequest: (facts) => buildGuardrailArticleEvalPrompt(
            "Complete evidence collected from all canonical ranges:\n" + facts,
            [article], phase, role, promptPreviouslyPassedIds,
            { completeEvidence: true },
          ).build(),
        });
        plan = PromptBatchPlan.fromRequest({ request, limit, id: `${article.id}:final-judgment` });
      }
      const result = await executeGatePlan({
        plan, projectInvocation, executionBudget,
        callAgent,
        protocolPolicy: new GateOutputProtocolPolicy({
          phase,
          parseResponse: (raw, batch) => parseGuardrailArticleEvaluation(raw,
            batch.request.jsonSchema.properties.observations.items.properties.requirementRef.enum),
        }),
        parseResponse: (response) => response,
      });
      observations.push(...result.results.flat());
    }
    parsed = [...new Map(observations.map((entry) => [JSON.stringify([
      entry.requirementRef ?? entry.guardrail_id, entry.where ?? entry.violations, entry.observed ?? entry.reason,
    ]), entry])).values()];
  } catch (error) {
    return requiredGateEvaluationFailure(error);
  }
  const byId = new Map(filtered.map((g) => [g.id, g]));
  if (parsed.length === 0) {
    return { passed: true, evaluations: buildPassEvaluationsForObservedGuardrails(filtered) };
  }
  if (parsed[0]?.requirementRef) {
    const evaluations = parsed.map((observation) => ({
      guardrail_id: observation.requirementRef,
      result: observation.severity === "blocking" ? "fail" : "pass",
      reason: observation.observed,
      category: byId.get(observation.requirementRef)?.meta.category || "guardrail",
      title: byId.get(observation.requirementRef)?.title || observation.requirementRef,
      observations: [observation],
    }));
    const passed = evaluations.every((e) => e.result === "pass" || e.result === "skip");
    return { passed, evaluations };
  }
  const evaluations = parsed.map((e) => ({
    ...e,
    category: byId.get(e.guardrail_id).meta.category,
    title: byId.get(e.guardrail_id).title,
  }));
  const passed = evaluations.every((e) => e.result === "pass" || e.result === "skip");
  return { passed, evaluations };
}

// ---------------------------------------------------------------------------
// Read-only Gate observation support
// ---------------------------------------------------------------------------

import {
  gateReportPrescription,
  resolveGatePublicationRecovery,
  resolveGateTransition,
  resolveTaskGateSettlementRecovery,
} from "../definition.js";

const GATE_OBSERVATION_PHASES = VALID_GATE_PHASES;

/**
 * Replay a reset-aware `gateRetry` counter for the given phase against the
 * flat append-only metrics entries. PASS writes a `reset: true` entry which
 * zeros the running count; FAIL writes a `delta: 1` entry which increments.
 * Exported for reuse by tests and any other counter consumers.
 *
 * @param {Array<Object>} entries — `state.metrics`
 * @param {string} phase — phase to scope the scan to
 * @returns {number} current post-reset count
 */
export function countGateRetry(entries, phase) {
  if (!Array.isArray(entries)) return 0;
  let count = 0;
  for (const e of entries) {
    if (e.phase !== phase || e.counter !== "gateRetry") continue;
    if (e.reset) count = 0;
    else count += e.delta ?? 1;
  }
  return count;
}


export class GateOutputAttemptEvidence {
  constructor(input = {}) {
    if (!Number.isInteger(input.attempt) || input.attempt < 1 || input.attempt > 2) {
      throw new Error("attempt must be 1 or 2");
    }
    if (typeof input.cacheOutcome !== "string" || input.cacheOutcome.trim() === "") {
      throw new Error("cacheOutcome must be a non-empty string");
    }
    this.attempt = input.attempt;
    this.repair = input.repair === true;
    this.cacheOutcome = input.cacheOutcome.trim();
    this.fresh = input.fresh === true;
    this.providerCalled = input.providerCalled ?? this.cacheOutcome !== "hit";
    this.error = input.error ? String(input.error) : null;
    Object.freeze(this);
  }

  withError(error) {
    return new GateOutputAttemptEvidence({
      ...this.toJSON(),
      error: error?.message || String(error),
    });
  }

  toJSON() {
    return {
      attempt: this.attempt,
      repair: this.repair,
      cacheOutcome: this.cacheOutcome,
      fresh: this.fresh,
      providerCalled: this.providerCalled,
      error: this.error,
    };
  }
}

export class GateOutputProtocolFailure extends Error {
  constructor({ phase, originalError, attempts, classification, failureMode } = {}) {
    if (typeof phase !== "string" || phase.trim() === "") {
      throw new Error("phase must be a non-empty string");
    }
    if (!(originalError instanceof Error)) {
      throw new Error("originalError must be an Error");
    }
    if (!Array.isArray(attempts) || attempts.length === 0) {
      throw new Error("attempts must be a non-empty array");
    }
    if (typeof classification !== "string" || classification.trim() === "") {
      throw new Error("classification must be a non-empty string");
    }
    const evidence = attempts.map((entry) => (
      entry instanceof GateOutputAttemptEvidence ? entry : new GateOutputAttemptEvidence(entry)
    ));
    super(originalError.message);
    this.name = "GateOutputProtocolFailure";
    this.code = "GATE_OUTPUT_TOOLING_FAILURE";
    this.cause = originalError;
    this.attempts = Object.freeze(evidence);
    this.data = {
      classification: classification.trim(),
      failureMode: failureMode || originalError.data?.failureMode || "schema_validation_failure",
      effectivePhase: phase.trim(),
      originalError: originalError.message,
      originalErrorCode: originalError.code || null,
      attemptCount: evidence.length,
      attempts: evidence.map((entry) => entry.toJSON()),
      providerCalls: evidence.filter((entry) => entry.providerCalled).length,
      freshRepairAttempts: evidence.filter((entry) => entry.repair && entry.fresh && entry.providerCalled).length,
    };
  }
}

class GateAgentResponse {
  constructor(value, attempt) {
    const structured = value && typeof value === "object" && !Array.isArray(value);
    this.text = structured ? String(value.text ?? "") : String(value);
    this.evidence = new GateOutputAttemptEvidence({
      attempt: attempt.attempt,
      repair: attempt.repair,
      cacheOutcome: structured ? value.cacheOutcome : attempt.cacheMode,
      fresh: structured ? value.fresh : attempt.repair,
      providerCalled: structured ? value.providerCalled : true,
    });
    Object.freeze(this);
  }
}

function gateOutputFailure({ phase, originalError, attempts, failureMode }) {
  return new GateOutputProtocolFailure({
    phase,
    originalError,
    attempts,
    classification: "tooling_provider_failure",
    failureMode,
  });
}

async function evaluateGateOutputWithRepair({
  phase,
  callAgent,
  parseResponse,
  freshRepairAvailable = true,
}) {
  const attempts = [];
  let originalError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const repair = attempt === 2;
    if (repair && freshRepairAvailable !== true) {
      throw gateOutputFailure({
        phase,
        originalError,
        attempts,
        failureMode: "freshness_unavailable",
      });
    }
    const request = {
      attempt,
      repair,
      cacheMode: repair ? "bypass" : "default",
    };
    let response;
    try {
      response = new GateAgentResponse(await callAgent(request), request);
    } catch (err) {
      const evidence = new GateOutputAttemptEvidence({
        ...request,
        cacheOutcome: repair ? "bypass" : "provider_error",
        fresh: repair,
        providerCalled: true,
        error: err.message || String(err),
      });
      throw gateOutputFailure({
        phase,
        originalError: originalError || err,
        attempts: [...attempts, evidence],
        failureMode: "provider_failure",
      });
    }
    attempts.push(response.evidence);
    if (repair && !response.evidence.fresh) {
      throw gateOutputFailure({
        phase,
        originalError,
        attempts,
        failureMode: "cached_replay",
      });
    }
    try {
      return parseResponse(response.text);
    } catch (err) {
      attempts[attempts.length - 1] = response.evidence.withError(err);
      originalError ||= err;
      if (attempt === 2) {
        throw gateOutputFailure({ phase, originalError, attempts });
      }
    }
  }
  throw gateOutputFailure({ phase, originalError, attempts });
}

/** Keep Gate retry/freshness in its existing protocol while the shared executor counts every call. */
class GateOutputProtocolPolicy {
  constructor({ phase, parseResponse }) {
    this.phase = phase;
    this.parseResponse = parseResponse;
  }

  execute({ request, batch, call }) {
    return evaluateGateOutputWithRepair({
      phase: this.phase,
      callAgent: (attempt) => call(request, attempt),
      parseResponse: (raw) => this.parseResponse(raw, batch),
    });
  }
}

export async function evaluateGuardrailObservationsWithRetry({
  knownIds,
  callAgent,
  phase = "task-impl",
  freshRepairAvailable = true,
}) {
  const observations = await evaluateGateOutputWithRepair({
    phase,
    callAgent,
    freshRepairAvailable,
    parseResponse: (raw) => parseGuardrailArticleEvaluation(raw, knownIds),
  });
  return { observations };
}

// ---------------------------------------------------------------------------
// No-progress-since-last-fail guard (spec 210)
// ---------------------------------------------------------------------------

/**
 * Compute a state identifier for the current working tree. `headSha` is the
 * current HEAD commit; `worktreeHash` is a sha256 over the tracked diff and
 * the porcelain status output, so any modification — tracked content change
 * or untracked file addition — changes the hash.
 */
export { computeGitState } from "../../lib/git-state.js";

const PLAN_GATE_EVIDENCE_LOGICAL_KEYS = Object.freeze({
  draft: Object.freeze([
    "draft",
    "draft.questions.review",
    "draft.questions.triage",
    "draft.questions.repair",
    "draft.coverage.review",
    "draft.coverage.triage",
    "draft.coverage.repair",
  ]),
  spec: Object.freeze([
    "spec.record",
    "spec.snapshot",
    "spec.review",
  ]),
});

export class PlanGateEvidenceTarget {
  constructor({ phase, artifacts }) {
    if (!new Set(["draft", "spec"]).has(phase)) {
      throw new Error(`invalid plan gate evidence phase: ${phase}`);
    }
    this.phase = phase;
    if (!Array.isArray(artifacts)) throw new Error("plan gate evidence artifacts must be an array");
    const allowed = new Set(PLAN_GATE_EVIDENCE_LOGICAL_KEYS[phase]);
    this.artifacts = Object.freeze(artifacts
      .filter((artifact) => allowed.has(artifact.logicalKey))
      .map((artifact) => Object.freeze({
        logicalKey: artifact.logicalKey,
        relativePath: artifact.relativePath,
        hash: artifact.hash,
        activityId: artifact.activityId,
      }))
      .sort((left, right) => left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0));
    if (this.artifacts.some((artifact) => typeof artifact.hash !== "string" || !/^[a-f0-9]{64}$/.test(artifact.hash))) {
      throw new Error("plan gate evidence artifact hash must be a SHA-256 digest");
    }
    Object.freeze(this);
  }

  static resolve({ flowManager, flowState, phase }) {
    if (!PLAN_GATE_EVIDENCE_LOGICAL_KEYS[phase]) return null;
    if (flowState?.schemaRevision !== 3 || typeof flowManager?.artifactCatalog !== "function") {
      throw new Error("plan gate evidence requires a Version-1 Flow artifact catalog");
    }
    return new PlanGateEvidenceTarget({
      phase,
      artifacts: flowManager.artifactCatalog(flowState.specId).artifacts,
    });
  }

  fingerprint() {
    const hash = crypto.createHash("sha256");
    for (const artifact of this.artifacts) {
      hash.update(artifact.logicalKey).update("\x00");
      hash.update(artifact.relativePath).update("\x00");
      hash.update(artifact.hash).update("\x00");
      hash.update(artifact.activityId || "").update("\x00");
      hash.update("\x00");
    }
    return hash.digest("hex");
  }
}

export function computeGateEvidenceState({
  executionRoot,
  flowManager = null,
  flowState,
  phase,
}) {
  if (!PLAN_GATE_EVIDENCE_LOGICAL_KEYS[phase]) return computeGitState(executionRoot);
  const head = runGit(["rev-parse", "HEAD"], { cwd: executionRoot });
  assertOk(head, "failed to read HEAD sha");
  const target = PlanGateEvidenceTarget.resolve({ flowManager, flowState, phase });
  return { headSha: head.stdout.trim(), worktreeHash: target.fingerprint() };
}

function stableGateEvaluationValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (value instanceof RegExp) return { regexp: value.toString() };
  if (Array.isArray(value)) return value.map((entry) => stableGateEvaluationValue(entry));
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableGateEvaluationValue(value[key])]));
  }
  return String(value);
}

function validatedGateEvaluationScopeIdentity({ phase, taskId, sourceFingerprint }, stored = false) {
  const prefix = stored ? "stored Gate evaluation scope" : "Gate evaluation scope";
  if (!VALID_GATE_PHASES.includes(phase)) throw new Error(`${prefix} phase is invalid`);
  if ((taskId === null) !== (sourceFingerprint === null)) {
    throw new Error(`${prefix} Task identity requires its source fingerprint`);
  }
  if (taskId !== null && (typeof taskId !== "string" || taskId.trim() === "")) {
    throw new Error(`${prefix} Task id is invalid`);
  }
  if (sourceFingerprint !== null && !/^[a-f0-9]{64}$/.test(sourceFingerprint)) {
    throw new Error(`${prefix} source fingerprint is invalid`);
  }
  return { phase, taskId, sourceFingerprint };
}

/**
 * Stable identity of the inputs one Gate evaluation was allowed to reuse.
 * Activity and catalog revisions are deliberately absent: they do not change
 * the evaluated contract, whereas the rendered source, requirement context,
 * or guardrail definition does.
 */
export class GateEvaluationScope {
  constructor({ phase, taskId = null, sourceFingerprint = null, inputs } = {}) {
    Object.assign(this, validatedGateEvaluationScopeIdentity({ phase, taskId, sourceFingerprint }));
    this.contentFingerprint = crypto.createHash("sha256")
      .update(JSON.stringify(stableGateEvaluationValue(inputs)))
      .digest("hex");
    Object.freeze(this);
  }

  static fromJSON(value) {
    if (value instanceof GateEvaluationScope) return value;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("stored Gate evaluation scope is invalid");
    }
    const scope = Object.create(GateEvaluationScope.prototype);
    Object.assign(scope, validatedGateEvaluationScopeIdentity(value, true));
    if (typeof value.contentFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.contentFingerprint)) {
      throw new Error("stored Gate evaluation scope content fingerprint is invalid");
    }
    scope.contentFingerprint = value.contentFingerprint;
    return Object.freeze(scope);
  }

  matches(other) {
    const candidate = GateEvaluationScope.fromJSON(other);
    return this.phase === candidate.phase
      && this.taskId === candidate.taskId
      && this.sourceFingerprint === candidate.sourceFingerprint
      && this.contentFingerprint === candidate.contentFingerprint;
  }

  toJSON() {
    return {
      phase: this.phase,
      taskId: this.taskId,
      sourceFingerprint: this.sourceFingerprint,
      contentFingerprint: this.contentFingerprint,
    };
  }
}

function currentGateEvaluationScope({ root, phase, taskId = null, sourceFingerprint = null, inputs }) {
  let guardrails;
  try {
    guardrails = filterGuardrailsForEvaluation(loadMergedGuardrails(root), phase);
  } catch (error) {
    // Gate evaluation itself owns this configuration failure.  It cannot have
    // produced a reusable PASS, so the failure identity is sufficient here.
    guardrails = { unavailable: error.message };
  }
  return new GateEvaluationScope({
    phase,
    taskId,
    sourceFingerprint,
    inputs: { guardrails, ...inputs },
  });
}

function attachGateEvaluationScope(result, scope) {
  if (!result || !["pass", "fail", "recovered"].includes(result.result) || !(scope instanceof GateEvaluationScope)) {
    return result;
  }
  result.artifacts ||= {};
  result.artifacts.evaluationScope = scope.toJSON();
  return result;
}

/**
 * Extract FAIL-only evaluations as `{ guardrail_id, reason }` pairs for
 * persistence in issue-log. PASS / SKIP are dropped.
 */
export function buildFailedEvaluations(evaluations) {
  if (!Array.isArray(evaluations)) return [];
  return evaluations
    .filter((e) => e && e.result === "fail" && typeof e.guardrail_id === "string")
    .map((e) => ({ guardrail_id: e.guardrail_id, reason: String(e.reason ?? "") }));
}

function observationsFromGateEvaluations(evaluations) {
  if (!Array.isArray(evaluations)) return [];
  return evaluations.flatMap((entry) => (
    Array.isArray(entry?.observations) ? entry.observations : []
  ));
}

// ---------------------------------------------------------------------------
// PASS→FAIL flip detection (spec 228)
// ---------------------------------------------------------------------------

export function buildPassedGuardrails(evaluations) {
  if (!Array.isArray(evaluations)) return [];
  return evaluations
    .filter((e) => e && e.result === "pass" && typeof e.guardrail_id === "string")
    .map((e) => e.guardrail_id);
}

/**
 * Return only PASS evidence bound to the exact current evaluation inputs.
 * The producer-owned canonical result history is the authority; the older
 * issue log remains an audit projection and cannot omit an evaluation.
 */
export function findReusablePassedGuardrails({ flowManager, flowState, evaluationScope }) {
  const scope = GateEvaluationScope.fromJSON(evaluationScope);
  if (!flowManager || typeof flowManager.readProducerArtifact !== "function" || !flowState?.specId) return null;
  const nodeId = canonicalGateNodeId({ phase: scope.phase, taskId: scope.taskId });
  const keys = canonicalGateLogicalKeys(scope.phase, scope.taskId);
  const source = flowManager.readProducerArtifact({
    specId: flowState.specId,
    nodeId,
    logicalKey: keys.result,
    parameters: keys.parameters,
    optional: true,
  });
  if (source === null) return null;
  const history = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: keys.result, bytes: source.bytes });
  for (let i = history.attempts.length - 1; i >= 0; i--) {
    const payload = history.attempts[i]?.payload;
    if ((payload?.result !== "pass" && payload?.result !== "fail")
      || !Array.isArray(payload?.artifacts?.evaluations)) continue;
    try {
      const prior = GateEvaluationScope.fromJSON(payload.artifacts.evaluationScope);
      if (!scope.matches(prior)) continue;
      if (scope.taskId !== null) {
        if (payload.artifacts.taskId !== scope.taskId
          || payload.artifacts.sourceFingerprint !== scope.sourceFingerprint) continue;
      }
      const passedGuardrails = buildPassedGuardrails(payload.artifacts.evaluations);
      if (passedGuardrails.length > 0) return { passedGuardrails };
    } catch {
      // A malformed historical result remains auditable but cannot authorize
      // semantic evaluation reuse.
    }
  }
  return null;
}

export function applyFlipOverride({ evaluations, previousEntry }) {
  if (!previousEntry) return evaluations;

  const prevPassed = new Set(previousEntry.passedGuardrails || []);
  return evaluations.map((e) => {
    if (e.result === "fail" && prevPassed.has(e.guardrail_id)) {
      // spec 255 R17: drop violations[] when flipping FAIL→PASS (PASS entries must not carry violations).
      const { violations, ...rest } = e;
      return { ...rest, result: "pass", reason: `${e.reason} [flip override: previously passed on identical content]` };
    }
    return e;
  });
}

// ---------------------------------------------------------------------------
// Task-impl / integration: requirements check
// ---------------------------------------------------------------------------

const SAME_SPEC_SECTION_TITLES = Object.freeze({
  requirements: "Requirements",
  "overview.decisions": "Overview Decisions",
  clarifications: "Clarifications",
});

export class SameSpecContractRecord {
  constructor({ section, locator, content, sourceCharacters, requirementId = null, current = false }) {
    if (!Object.hasOwn(SAME_SPEC_SECTION_TITLES, section)) {
      throw new Error(`unknown same-spec contract section: ${section}`);
    }
    if (typeof locator !== "string" || locator.trim() === "") {
      throw new Error("same-spec contract record locator must be a non-empty string");
    }
    if (typeof content !== "string" || content.trim() === "") {
      throw new Error("same-spec contract record content must be a non-empty string");
    }
    if (!Number.isInteger(sourceCharacters) || sourceCharacters < 0) {
      throw new Error("same-spec contract record sourceCharacters must be a non-negative integer");
    }
    if (requirementId !== null && (typeof requirementId !== "string" || requirementId.trim() === "")) {
      throw new Error("same-spec contract requirementId must be a non-empty string or null");
    }
    this.section = section;
    this.locator = locator.trim();
    this.content = content.trim();
    this.sourceCharacters = sourceCharacters;
    this.requirementId = requirementId === null ? null : requirementId.trim();
    this.current = Boolean(current);
    Object.freeze(this);
  }

  toPromptText() {
    if (this.section === "requirements") {
      const kind = this.current ? "current" : "summary";
      return `- [${kind}] ${this.locator} ${this.requirementId}: ${this.content}`;
    }
    const lines = this.content.split("\n");
    return [`- ${this.locator}: ${lines[0]}`, ...lines.slice(1).map((line) => `  ${line}`)].join("\n");
  }
}

export class SameSpecContractSection {
  constructor({ name, records }) {
    if (!Object.hasOwn(SAME_SPEC_SECTION_TITLES, name)) {
      throw new Error(`unknown same-spec contract section: ${name}`);
    }
    if (!Array.isArray(records) || !records.every((record) => record instanceof SameSpecContractRecord)) {
      throw new Error("same-spec contract section records must contain SameSpecContractRecord values");
    }
    if (!records.every((record) => record.section === name)) {
      throw new Error("same-spec contract records must belong to their section");
    }
    this.name = name;
    this.records = Object.freeze([...records]);
    Object.freeze(this);
  }

  toPromptText() {
    const records = this.records.length > 0
      ? this.records.map((record) => record.toPromptText())
      : ["- (none)"];
    return [`### ${SAME_SPEC_SECTION_TITLES[this.name]}`, ...records].join("\n");
  }
}

function sameSpecRequirementRecord(requirement, index, current) {
  const excerpt = normalizeRequirementPromptInput(requirement);
  return new SameSpecContractRecord({
    section: "requirements",
    locator: `requirements[${index}]`,
    content: excerpt.desc,
    sourceCharacters: excerpt.desc.length,
    requirementId: excerpt.id,
    current,
  });
}

function sameSpecDecisionRecord(decision, index) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    throw new Error(`overview.decisions[${index}] must be an object`);
  }
  const fields = [
    ["text", decision.text],
    ["evidence", decision.evidence],
    ["consideredAlternatives", decision.consideredAlternatives],
  ];
  if (typeof decision.text !== "string" || decision.text.trim() === "") {
    throw new Error(`overview.decisions[${index}].text must be a non-empty string`);
  }
  const contentFields = fields
    .filter(([, value]) => typeof value === "string" && value.trim() !== "")
    .map(([name, value]) => `${name}: ${value.trim()}`);
  return new SameSpecContractRecord({
    section: "overview.decisions",
    locator: `overview.decisions[${index}]`,
    content: contentFields.join("\n"),
    sourceCharacters: fields.reduce(
      (total, [, value]) => total + (typeof value === "string" ? value.trim().length : 0),
      0,
    ),
  });
}

function sameSpecClarificationRecord(clarification, index) {
  if (!clarification || typeof clarification !== "object" || Array.isArray(clarification)) {
    throw new Error(`clarifications[${index}] must be an object`);
  }
  if (typeof clarification.q !== "string" || clarification.q.trim() === "") {
    throw new Error(`clarifications[${index}].q must be a non-empty string`);
  }
  if (typeof clarification.a !== "string" || clarification.a.trim() === "") {
    throw new Error(`clarifications[${index}].a must be a non-empty string`);
  }
  return new SameSpecContractRecord({
    section: "clarifications",
    locator: `clarifications[${index}]`,
    content: `q: ${clarification.q.trim()}\na: ${clarification.a.trim()}`,
    sourceCharacters: clarification.q.trim().length + clarification.a.trim().length,
  });
}


function requirementIdIsReferenced(text, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, (character) => `\\${character}`);
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`).test(text);
}

export class SameSpecContractContext {
  constructor({ spec, currentRequirementIds }) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new Error("structured spec must be an object");
    }
    if (!Array.isArray(spec.requirements)) throw new Error("spec requirements must be an array");
    if (!spec.overview || typeof spec.overview !== "object" || Array.isArray(spec.overview)) {
      throw new Error("spec overview must be an object");
    }
    if (!Array.isArray(spec.overview.decisions)) throw new Error("spec overview.decisions must be an array");
    if (!Array.isArray(spec.clarifications)) throw new Error("spec clarifications must be an array");
    if (!Array.isArray(currentRequirementIds) || currentRequirementIds.length === 0) {
      throw new Error("currentRequirementIds must be a non-empty array");
    }
    const currentIds = new Set();
    for (const id of currentRequirementIds) {
      if (typeof id !== "string" || id.trim() === "") {
        throw new Error("currentRequirementIds must contain non-empty strings");
      }
      const normalized = id.trim();
      if (currentIds.has(normalized)) throw new Error(`duplicate current requirement id: ${normalized}`);
      currentIds.add(normalized);
    }

    const requirementEntries = spec.requirements.map((requirement, index) => ({
      requirement: normalizeRequirementPromptInput(requirement),
      index,
    }));
    const knownIds = new Set();
    for (const { requirement } of requirementEntries) {
      if (knownIds.has(requirement.id)) throw new Error(`duplicate structured spec requirement id: ${requirement.id}`);
      knownIds.add(requirement.id);
    }
    for (const id of currentIds) {
      if (!knownIds.has(id)) throw new Error(`current requirement id not found in structured spec: ${id}`);
    }

    const currentEntries = requirementEntries.filter(({ requirement }) => currentIds.has(requirement.id));
    const currentDescriptions = currentEntries.map(({ requirement }) => requirement.desc).join("\n");
    const referencedEntries = requirementEntries.filter(({ requirement }) => (
      !currentIds.has(requirement.id)
      && requirementIdIsReferenced(currentDescriptions, requirement.id)
    ));
    const referencedIds = new Set(referencedEntries.map(({ requirement }) => requirement.id));
    const remainingEntries = requirementEntries.filter(({ requirement }) => (
      !currentIds.has(requirement.id) && !referencedIds.has(requirement.id)
    ));

    const currentRecords = currentEntries.map(({ requirement, index }) => (
      sameSpecRequirementRecord(requirement, index, true)
    ));
    const sections = {
      requirements: new SameSpecContractSection({
        name: "requirements",
        records: [...currentRecords, ...[...referencedEntries, ...remainingEntries]
          .map(({ requirement, index }) => sameSpecRequirementRecord(requirement, index, false))],
      }),
      decisions: new SameSpecContractSection({
        name: "overview.decisions", records: spec.overview.decisions.map(sameSpecDecisionRecord),
      }),
      clarifications: new SameSpecContractSection({
        name: "clarifications", records: spec.clarifications.map(sameSpecClarificationRecord),
      }),
    };
    const renderSections = (value) => [
      value.requirements.toPromptText(), value.decisions.toPromptText(), value.clarifications.toPromptText(),
    ].join("\n\n");

    this.requirements = sections.requirements;
    this.decisions = sections.decisions;
    this.clarifications = sections.clarifications;
    this.serialized = renderSections(sections);
    Object.freeze(this);
  }

  toPromptText() {
    return this.serialized;
  }
}

const REQUIREMENT_CONTEXT_SECTION_ORDER = Object.freeze([
  "requirement",
  "acceptance",
  "out-of-scope",
  "constraint",
  "principle",
  "module",
  "data-flow",
  "decision",
  "schema",
  "task",
  "target",
  "file-map",
  "execution",
  "evidence",
]);
const REQUIREMENT_CONTEXT_SECTIONS = new Set(REQUIREMENT_CONTEXT_SECTION_ORDER);
const REQUIREMENT_OBLIGATION_KINDS = new Set([
  "implementation",
  "regression-only",
  "preservation/non-interception",
]);
const PRESERVATION_OBLIGATION_PHRASES = Object.freeze([
  "preservation",
  "preserve",
  "non-interception",
  "non-interference",
  "do not intercept",
  "remain unchanged",
  "retain existing",
  "byte-identical",
]);
const REGRESSION_OBLIGATION_PHRASES = Object.freeze([
  "regression-only",
  "no regression",
  "continue existing behavior",
]);
const CHANGED_BEHAVIOR_VERBS = Object.freeze([
  "add",
  "create",
  "change",
  "introduce",
  "implement",
  "return",
  "write",
  "set",
  "support",
  "reject",
  "require",
]);

export class RequirementContextEntry {
  constructor({ section, reference, text }) {
    if (!REQUIREMENT_CONTEXT_SECTIONS.has(section)) throw new Error(`unknown requirement context section: ${section}`);
    if (typeof reference !== "string" || !/^\[[^\]]+\]$/.test(reference.trim())) {
      throw new Error("reference must be a non-empty bracketed source reference");
    }
    if (typeof text !== "string" || text.trim() === "") throw new Error("text must be a non-empty string");
    this.section = section;
    this.reference = reference.trim();
    this.text = text.trim();
    Object.freeze(this);
  }

  toPromptText() {
    return `${this.reference} ${this.text}`;
  }
}

export class RequirementObligation {
  constructor(kind) {
    if (!REQUIREMENT_OBLIGATION_KINDS.has(kind)) throw new Error(`unknown requirement obligation kind: ${kind}`);
    this.kind = kind;
    Object.freeze(this);
  }

  toPromptText() {
    if (this.kind === "regression-only") {
      return "Evaluate cited regression evidence and non-interference only. Must not demand reimplementation or require delegated existing behavior to be reimplemented. Return FAIL when required regression evidence is missing or mapped changes intercept, remove, or contradict preserved behavior.";
    }
    if (this.kind === "preservation/non-interception") {
      return "Evaluate cited preservation, regression evidence, and non-interference only. Must not demand reimplementation or require delegated existing behavior to be reimplemented. Return FAIL when evidence is missing or mapped changes intercept, remove, or contradict preserved behavior.";
    }
    return "Evaluate whether mapped implementation evidence supplies every changed behavior, integration, and exact field required by the cited authoritative context. Return FAIL when required behavior is omitted or contradicted.";
  }
}

export class IntegrationExecutionEvidence {
  constructor({ result, review }) {
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      throw new Error("test execution result must be an object");
    }
    if (!Array.isArray(result.summary)) throw new Error("test execution result summary must be an array");
    if (!review || typeof review !== "object" || Array.isArray(review)) {
      throw new Error("test result review must be an object");
    }
    this.result = result;
    this.review = review;
    Object.freeze(this);
  }

  entriesFor(requirementId) {
    const entry = this.result.summary.find((item) => item?.id === requirementId && item.result === "pass");
    const entries = [];
    if (entry?.evidence) {
      entries.push(new RequirementContextEntry({
        section: "execution",
        reference: `[TEST:${requirementId}]`,
        text: `Validated test-execute result=pass. Executed ${entry.evidence.command}; test ${entry.evidence.test_name}.`,
      }));
    }
    if (this.review.verdict === "pass") {
      entries.push(new RequirementContextEntry({
        section: "execution",
        reference: "[TEST-REVIEW]",
        text: "Validated test-result-review verdict=pass.",
      }));
    }
    if (this.result.regression?.category === "full-regression-deferred") {
      entries.push(new RequirementContextEntry({
        section: "execution",
        reference: "[REGRESSION]",
        text: "Validated test-execute classification is full-regression-deferred; final-regression is the default owner of the full project regression.",
      }));
    }
    return entries;
  }
}

export class RequirementGateContext {
  constructor({
    requirementId,
    obligation,
    entries,
  }) {
    if (typeof requirementId !== "string" || requirementId.trim() === "") {
      throw new Error("requirementId must be a non-empty string");
    }
    if (!(obligation instanceof RequirementObligation)) throw new Error("obligation must be a RequirementObligation");
    if (!Array.isArray(entries)) throw new Error("entries must be an array");
    if (!entries.every((entry) => entry instanceof RequirementContextEntry)) {
      throw new Error("entries must contain RequirementContextEntry values");
    }
    this.requirementId = requirementId.trim();
    this.obligation = obligation;
    this.entries = Object.freeze([...entries]);
    this.promptText = this.#render();
    Object.freeze(this);
  }

  #render() {
    const lines = [
      `### ${this.requirementId}`,
      `Obligation: ${this.obligation.kind}`,
      `Evaluation contract: ${this.obligation.toPromptText()}`,
    ];
    for (const section of REQUIREMENT_CONTEXT_SECTION_ORDER) {
      for (const entry of this.entries.filter((value) => value.section === section)) {
        lines.push(entry.toPromptText());
      }
    }
    return lines.join("\n");
  }

  toPromptText() {
    return this.promptText;
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsRequirementId(text, requirementId) {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(requirementId)}([^A-Za-z0-9_]|$)`);
  return pattern.test(String(text || ""));
}

function backtickIdentifiers(text) {
  return [...String(text || "").matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

function textHasLinkedIdentifier(text, identifiers) {
  if (identifiers.size === 0) return false;
  return backtickIdentifiers(text).some((identifier) => identifiers.has(identifier));
}

function taskPromptSourceText(task) {
  return [
    task.title,
    task.goal,
    ...(Array.isArray(task.acceptance) ? task.acceptance : []),
    task.implementation_notes,
    task.test_strategy,
  ].filter((value) => typeof value === "string" && value.trim() !== "").join(" | ");
}

function overviewSourceEntries(spec) {
  return [
    ["principle", "PRINCIPLE", spec.design_principles || []],
    ["module", "MODULE", spec.overview?.modules || []],
    ["data-flow", "DATA", spec.overview?.data_flow || []],
    ["decision", "DECISION", spec.overview?.decisions || []],
  ];
}

export function classifyRequirementObligation(requirement, acceptanceCriteria = []) {
  if (!requirement || typeof requirement.desc !== "string") throw new Error("requirement.desc must be a string");
  if (!Array.isArray(acceptanceCriteria)) throw new Error("acceptanceCriteria must be an array");
  const text = [requirement.desc, ...acceptanceCriteria].join("\n").toLowerCase();
  if (PRESERVATION_OBLIGATION_PHRASES.some((phrase) => text.includes(phrase))) {
    return new RequirementObligation("preservation/non-interception");
  }
  const regression = REGRESSION_OBLIGATION_PHRASES.some((phrase) => text.includes(phrase));
  const changedBehavior = CHANGED_BEHAVIOR_VERBS.some((verb) => new RegExp(`\\b${verb}\\b`).test(text));
  return new RequirementObligation(regression && !changedBehavior ? "regression-only" : "implementation");
}

export function buildRequirementGateContext({
  spec,
  requirement,
  fileMap = {},
  relatedDiff = "",
  sharedDiffEvidence = false,
  executionEvidence = null,
}) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) throw new Error("spec must be an object");
  const normalizedRequirement = normalizeRequirementPromptInput(requirement);
  if (!fileMap || typeof fileMap !== "object" || Array.isArray(fileMap)) throw new Error("fileMap must be an object");
  if (typeof relatedDiff !== "string") throw new Error("relatedDiff must be a string");
  if (typeof sharedDiffEvidence !== "boolean") throw new Error("sharedDiffEvidence must be a boolean");
  if (executionEvidence !== null && !(executionEvidence instanceof IntegrationExecutionEvidence)) {
    throw new Error("executionEvidence must be an IntegrationExecutionEvidence or null");
  }

  const requirementId = normalizedRequirement.id;
  const acceptance = (spec.acceptance_criteria || [])
    .map((text, index) => ({ text, sourceIndex: index + 1 }))
    .filter(({ text }) => containsRequirementId(text, requirementId));
  const acceptanceTexts = acceptance.map(({ text }) => text);
  const obligation = classifyRequirementObligation(normalizedRequirement, acceptanceTexts);
  const entries = [new RequirementContextEntry({
    section: "requirement",
    reference: `[REQ:${requirementId}]`,
    text: normalizedRequirement.toPromptText().replace(/^[- ]+/, ""),
  })];
  acceptance.forEach(({ text, sourceIndex }) => entries.push(new RequirementContextEntry({
    section: "acceptance",
    reference: `[AC:${sourceIndex}]`,
    text,
  })));
  (spec.scope?.out || []).forEach((text, index) => entries.push(new RequirementContextEntry({
    section: "out-of-scope",
    reference: `[OUT:${index + 1}]`,
    text,
  })));
  (spec.constraints || []).forEach((text, index) => entries.push(new RequirementContextEntry({
    section: "constraint",
    reference: `[CONSTRAINT:${index + 1}]`,
    text,
  })));

  const linkedIdentifiers = new Set(backtickIdentifiers([
    normalizedRequirement.desc,
    ...acceptanceTexts,
    ...(spec.scope?.out || []),
    ...(spec.constraints || []),
  ].join("\n")));
  const linkedTasks = [];
  (spec.tasks || []).forEach((task) => {
    const text = taskPromptSourceText(task);
    if (!containsRequirementId(text, requirementId) && !textHasLinkedIdentifier(text, linkedIdentifiers)) return;
    linkedTasks.push({ task, text });
    for (const identifier of backtickIdentifiers(text)) linkedIdentifiers.add(identifier);
  });

  const linkedSources = [];
  for (const [section, label, sources] of overviewSourceEntries(spec)) {
    sources.forEach((source, index) => {
      const text = typeof source === "string" ? source : source?.text;
      if (typeof text !== "string" || text.trim() === "") return;
      if (!containsRequirementId(text, requirementId) && !textHasLinkedIdentifier(text, linkedIdentifiers)) return;
      const reference = `[${label}:${index + 1}]`;
      entries.push(new RequirementContextEntry({ section, reference, text }));
      linkedSources.push({ label, index: index + 1, text });
    });
  }

  const schemaSources = [
    { label: "REQ", index: requirementId, text: normalizedRequirement.desc },
    ...acceptance.map(({ text, sourceIndex }) => ({ label: "AC", index: sourceIndex, text })),
    ...(spec.constraints || []).map((text, index) => ({ label: "CONSTRAINT", index: index + 1, text })),
    ...linkedSources,
    ...linkedTasks.map(({ task, text }) => ({ label: "TASK", index: task.id, text })),
  ];
  schemaSources.forEach((source) => {
    if (!/\b(schema|field|contract)\b/i.test(source.text)) return;
    backtickIdentifiers(source.text).forEach((identifier, index) => entries.push(new RequirementContextEntry({
      section: "schema",
      reference: `[SCHEMA:${source.label}:${source.index}:${index + 1}]`,
      text: identifier,
    })));
  });

  linkedTasks.forEach(({ task, text }) => entries.push(new RequirementContextEntry({
    section: "task",
    reference: `[TASK:${task.id}]`,
    text,
  })));

  const mappedFiles = Array.isArray(fileMap[requirementId])
    ? [...new Set(fileMap[requirementId].map(String))].sort()
    : [];
  (spec.implementationTargets || []).forEach((target, index) => {
    if (!mappedFiles.includes(target) && !linkedIdentifiers.has(target)) return;
    entries.push(new RequirementContextEntry({
      section: "target",
      reference: `[TARGET:${index + 1}]`,
      text: target,
    }));
  });
  mappedFiles.forEach((file, index) => entries.push(new RequirementContextEntry({
    section: "file-map",
    reference: `[FILE-MAP:${requirementId}:${index + 1}]`,
    text: file,
  })));
  if (executionEvidence) entries.push(...executionEvidence.entriesFor(requirementId));
  if (relatedDiff.trim() !== "") {
    entries.push(new RequirementContextEntry({
      section: "evidence",
      reference: `[EVIDENCE:${requirementId}]`,
      text: relatedDiff,
    }));
  } else if (sharedDiffEvidence) {
    entries.push(new RequirementContextEntry({
      section: "evidence",
      reference: `[EVIDENCE:${requirementId}]`,
      text: "See this batch's shared Git Diff section for the mapped implementation evidence.",
    }));
  }
  return new RequirementGateContext({ requirementId, obligation, entries });
}


export class RequirementPromptExcerpt {
  constructor(requirement) {
    if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) {
      throw new Error("requirement must be an object");
    }
    if (typeof requirement.id !== "string" || requirement.id.trim() === "") {
      throw new Error("requirement.id must be a non-empty string");
    }
    if (typeof requirement.desc !== "string" || requirement.desc.trim() === "") {
      throw new Error("requirement.desc must be a non-empty string");
    }
    this.id = requirement.id.trim();
    this.desc = requirement.desc.trim();
    this.priority = typeof requirement.priority === "string" && requirement.priority.trim() !== ""
      ? requirement.priority.trim()
      : null;
    this.testable = requirement.testable;
    Object.freeze(this);
  }

  toPromptText() {
    return [
      `- ${this.id}: ${this.desc}`,
      ...(this.priority ? [`  priority: ${this.priority}`] : []),
      ...(this.testable === false ? ["  testing not required"] : []),
    ].join("\n");
  }
}

function normalizeRequirementPromptInput(input) {
  if (input instanceof RequirementPromptExcerpt) return input;
  return new RequirementPromptExcerpt(input);
}

function renderRequirementPromptSection(requirements) {
  return requirements.map((requirement) => normalizeRequirementPromptInput(requirement).toPromptText()).join("\n");
}

function normalizeRequirementContext(input, requirementId) {
  if (!(input instanceof RequirementGateContext)) throw new Error("contexts must contain RequirementGateContext values");
  if (input.requirementId !== requirementId) {
    throw new Error(`context requirement id ${input.requirementId} does not match ${requirementId}`);
  }
  return input;
}

function renderRequirementContextSection(contexts) {
  return contexts.map((context) => context.toPromptText()).join("\n\n");
}

export class RequirementGateBatch {
  constructor({
    requirements,
    contexts = null,
    diff,
    maxChars = MAX_IMPL_REQUIREMENT_BATCH_CHARS,
    usesFullSpec = false,
    fullSpecText = null,
    structuredSpec = null,
    sourceScope = null,
  }) {
    if (!Array.isArray(requirements) || requirements.length === 0) {
      throw new Error("requirements must be a non-empty array");
    }
    if (typeof diff !== "string") throw new Error("diff must be a string");
    if (!Number.isInteger(maxChars) || maxChars <= 0) throw new Error("maxChars must be a positive integer");
    if (fullSpecText !== null && typeof fullSpecText !== "string") throw new Error("fullSpecText must be a string or null");
    if (structuredSpec !== null && (!structuredSpec || typeof structuredSpec !== "object" || Array.isArray(structuredSpec))) {
      throw new Error("structuredSpec must be an object or null");
    }
    this.requirements = Object.freeze(requirements.map(normalizeRequirementPromptInput));
    this.diff = diff;
    this.maxChars = maxChars;
    this.usesFullSpec = Boolean(usesFullSpec);
    this.fullSpecText = fullSpecText;
    this.requirementIds = Object.freeze(this.requirements.map((requirement) => requirement.id));
    this.structuredSpec = structuredSpec;
    if (sourceScope !== null && !(sourceScope instanceof CanonicalSourceRequirementScope)) {
      throw new Error("sourceScope must be a CanonicalSourceRequirementScope or null");
    }
    this.sourceScope = sourceScope;
    this.sameSpecContractContext = structuredSpec === null
      ? null
      : new SameSpecContractContext({ spec: structuredSpec, currentRequirementIds: this.requirementIds });
    if (contexts !== null && (!Array.isArray(contexts) || contexts.length !== this.requirements.length)) {
      throw new Error("contexts must be null or match requirements length");
    }
    this.contexts = contexts === null
      ? null
      : Object.freeze(contexts.map((context, index) => normalizeRequirementContext(context, this.requirementIds[index])));
    this.category = "requirements";
    this.promptCharCount = PromptLogicalFootprint.measure(this.buildPrompt().build()).total;
    Object.freeze(this);
  }

  fitsWith(requirement, context = null) {
    return this.withRequirement(requirement, context).promptCharCount <= this.maxChars;
  }

  withRequirement(requirement, context = null) {
    const normalized = normalizeRequirementPromptInput(requirement);
    return new RequirementGateBatch({
      requirements: [...this.requirements, normalized],
      contexts: this.contexts
        ? [...this.contexts, normalizeRequirementContext(context, normalized.id)]
        : null,
      diff: this.diff,
      maxChars: this.maxChars,
      usesFullSpec: this.usesFullSpec,
      fullSpecText: this.fullSpecText,
      structuredSpec: this.structuredSpec,
      sourceScope: this.sourceScope,
    });
  }

  buildPrompt() {
    return buildImplCheckPrompt({
      requirements: this.usesFullSpec ? this.fullSpecText : this.requirements,
      contexts: this.contexts,
      diff: this.diff,
      knownIds: this.requirementIds,
      sameSpecContractContext: this.sameSpecContractContext,
      sourceScope: this.sourceScope,
    });
  }
}

class SpecTestPromptEvidence {
  constructor(diff) {
    this.entries = [];
    for (const [file, fileDiff] of splitDiffByFile(diff)) {
      if (!/^specs\/[^/]+\/tests\/[^/]+\.(test|spec)\.(js|mjs|ts)$/.test(file)) continue;
      const header = fileDiff.match(/^\+\s*(\/\/\s*spec:\s*R\d+(?:\s+R\d+)*)\s*$/m)?.[1];
      if (!header) continue;
      const declarations = [];
      const pattern = /^\+\s*(?:(?:test|it)(?:\.(?:only|skip|todo))?)\s*\(\s*(["'`])(.+?)\1/gm;
      for (const match of fileDiff.matchAll(pattern)) {
        declarations.push(match[2]);
      }
      this.entries.push({
        file,
        header,
        declarations,
      });
    }
    Object.freeze(this.entries);
    Object.freeze(this);
  }

  toMarkdown() {
    if (this.entries.length === 0) return "";
    const lines = [
      "## Spec Test Header And Declaration Evidence",
      "The following evidence is extracted from added spec-local test lines; the full diff remains authoritative.",
    ];
    for (const entry of this.entries) {
      lines.push(`- ${entry.file}: ${entry.header}`);
      for (const declaration of entry.declarations) {
        lines.push(`  - test: ${declaration}`);
      }
    }
    return `${lines.join("\n")}\n\n`;
  }
}

function buildGuardrailTargetTextForPrompt(specText, diff) {
  if (typeof specText !== "string") throw new Error("specText must be a string");
  if (typeof diff !== "string") throw new Error("diff must be a string");
  const specTestEvidence = new SpecTestPromptEvidence(diff).toMarkdown();
  return `${specText}\n\n${specTestEvidence}## Git Diff\n${diff}`;
}

class RequirementGatePlan {
  constructor({ calls, evaluations }) {
    if (!Array.isArray(calls)) throw new Error("calls must be an array");
    if (!Array.isArray(evaluations)) throw new Error("evaluations must be an array");
    this.calls = Object.freeze(calls);
    this.evaluations = Object.freeze(evaluations);
    Object.freeze(this);
  }
}

function requirementEvaluation(reqId, result, reason) {
  return {
    guardrail_id: reqId,
    result,
    reason,
    title: reqId,
    category: "requirements",
  };
}

export function buildRequirementGateBatches({
  requirements,
  contexts = null,
  relatedDiffs,
  maxChars = MAX_IMPL_REQUIREMENT_BATCH_CHARS,
  structuredSpec = null,
  sourceScope = null,
}) {
  if (!Array.isArray(requirements)) throw new Error("requirements must be an array");
  if (contexts !== null && !(contexts instanceof Map)) throw new Error("contexts must be a Map or null");
  if (!(relatedDiffs instanceof Map)) throw new Error("relatedDiffs must be a Map");
  const groups = new Map();
  for (const requirementInput of requirements) {
    const requirement = normalizeRequirementPromptInput(requirementInput);
    const diff = relatedDiffs.get(requirement.id) || "";
    if (!groups.has(diff)) groups.set(diff, []);
    groups.get(diff).push(requirement);
  }

  const batches = [];
  for (const [diff, group] of groups) {
    let current = null;
    for (const requirement of group) {
      if (!current) {
        current = new RequirementGateBatch({
          requirements: [requirement],
          contexts: contexts ? [contexts.get(requirement.id)] : null,
          diff,
          maxChars,
          structuredSpec,
          sourceScope,
        });
        continue;
      }
      const context = contexts?.get(requirement.id) || null;
      if (current.fitsWith(requirement, context)) {
        current = current.withRequirement(requirement, context);
        continue;
      }
      batches.push(current);
      current = new RequirementGateBatch({
        requirements: [requirement],
        contexts: contexts ? [context] : null,
        diff,
        maxChars,
        structuredSpec,
        sourceScope,
      });
    }
    if (current) batches.push(current);
  }
  return batches;
}

export function planRequirementGateCalls({
  requirements,
  contexts = null,
  relatedDiffs,
  previouslyPassed = new Set(),
  fullSpecText = "",
  fullDiff = "",
  phase = "task-impl",
  maxChars = MAX_IMPL_REQUIREMENT_BATCH_CHARS,
  structuredSpec = null,
  sourceScope = null,
}) {
  const requirementExcerpts = requirements.map(normalizeRequirementPromptInput);
  if (contexts !== null && !(contexts instanceof Map)) throw new Error("contexts must be a Map or null");
  if (relatedDiffs == null) {
    if (phase === "integration") throw new Error("file-map trust input is required for integration gate");
    return new RequirementGatePlan({
      calls: [new RequirementGateBatch({
        requirements: requirementExcerpts,
        contexts: contexts ? requirementExcerpts.map((requirement) => contexts.get(requirement.id)) : null,
        diff: fullDiff,
        maxChars,
        usesFullSpec: contexts === null,
        fullSpecText,
        sourceScope,
      })],
      evaluations: [],
    });
  }
  if (!(relatedDiffs instanceof Map)) throw new Error("relatedDiffs must be a Map or null");
  const previousSet = previouslyPassed instanceof Set ? previouslyPassed : new Set(previouslyPassed || []);
  const callRequirements = [];
  const evaluations = [];
  for (const requirement of requirementExcerpts) {
    if (previousSet.has(requirement.id)) {
      evaluations.push(requirementEvaluation(requirement.id, "pass", "previously passed (skipped on retry)"));
      continue;
    }
    const reqDiff = relatedDiffs.get(requirement.id) || "";
    if (!reqDiff.trim()) {
      evaluations.push(requirementEvaluation(requirement.id, "skip", "no related diff found"));
      continue;
    }
    callRequirements.push(requirement);
  }
  if (phase === "integration" && callRequirements.length > 0
    && (!structuredSpec || typeof structuredSpec !== "object" || Array.isArray(structuredSpec))) {
    throw new Error("structured spec is required for same-spec contract context in the integration gate");
  }
  return new RequirementGatePlan({
    calls: buildRequirementGateBatches({
      requirements: callRequirements,
      contexts,
      relatedDiffs,
      maxChars,
      structuredSpec: phase === "integration" ? structuredSpec : null,
      sourceScope,
    }),
    evaluations,
  });
}

export class RequirementGateExecutionPlan {
  constructor({ batch, limit, direct = null, evidence = null, requirement = null }) {
    this.batch = batch;
    this.limit = limit;
    this.direct = direct;
    this.evidence = evidence;
    this.requirement = requirement;
    Object.freeze(this);
  }

  static create(batch, limit) {
    const request = batch.buildPrompt().build();
    if (gatePromptFits(request, limit)) {
      return [new RequirementGateExecutionPlan({ batch, limit, direct: PromptBatchPlan.fromRequest({ request, limit, id: "requirement-gate-request" }) })];
    }
    return batch.requirements.map((requirement) => {
      const inputs = [];
      const currentContractRecord = batch.sameSpecContractContext?.requirements.records.find((record) => (
        record.current && record.requirementId === requirement.id
      ));
      const canonicalInput = currentContractRecord
        ? new RequirementEvidenceInput({
          id: `${requirement.id}:contract:${currentContractRecord.locator}`,
          text: currentContractRecord.toPromptText(),
        })
        : null;
      const context = batch.contexts?.find((entry) => entry.requirementId === requirement.id);
      if (context) {
        inputs.push(new RequirementEvidenceInput({
          id: `${requirement.id}:obligation`, text: context.obligation.toPromptText(),
        }));
        context.entries.forEach((entry, index) => {
          if (entry.section === "requirement") return;
          inputs.push(new RequirementEvidenceInput({
            id: `${requirement.id}:context:${index}:${entry.reference}`, text: entry.toPromptText(),
          }));
        });
      } else if (batch.usesFullSpec) {
        inputs.push(new RequirementEvidenceInput({ id: `${requirement.id}:spec`, text: batch.fullSpecText }));
      }
      for (const section of [batch.sameSpecContractContext?.requirements, batch.sameSpecContractContext?.decisions, batch.sameSpecContractContext?.clarifications]) {
        for (const record of section?.records || []) {
          if (record === currentContractRecord) continue;
          inputs.push(new RequirementEvidenceInput({ id: `${requirement.id}:contract:${record.locator}`, text: record.toPromptText() }));
        }
      }
      if (batch.sourceScope) {
        inputs.push(new RequirementEvidenceInput({ id: `${requirement.id}:mapping`, text: batch.sourceScope.toPromptText() }));
      }
      const source = GateDiffCollection.from(splitDiffByFile(batch.diff));
      if (source.preambleText) inputs.push(new RequirementEvidenceInput({ id: `${requirement.id}:source:preamble`, text: source.preambleText }));
      source.unparsedSegments.forEach((segment, index) => inputs.push(new RequirementEvidenceInput({
        id: `${requirement.id}:source:unparsed:${index}`, text: segment.text,
      })));
      for (const [file, text] of source) inputs.push(new RequirementEvidenceInput({ id: `${requirement.id}:source:${file}`, text }));
      if (source.size === 0 && !source.preambleText && source.unparsedSegments.length === 0) {
        inputs.push(new RequirementEvidenceInput({ id: `${requirement.id}:source`, text: batch.diff }));
      }
      return new RequirementGateExecutionPlan({
        batch, limit, requirement,
        evidence: new RequirementEvidencePlan({ requirement, inputs, canonicalInput, limit }),
      });
    });
  }

  preflight(projectInvocation) {
    if (!projectInvocation) return;
    const plan = this.direct ?? this.evidence.plan;
    for (const batch of plan.batches) projectInvocation(batch.request).assertWithinLimit(this.limit);
  }

  async execute({ agent, phase, projectInvocation, executionBudget }) {
    const invocationProjector = projectInvocation ?? gateInvocationProjector(agent);
    const callAgent = (request, _batch, _index, attempt, providerCallAdmission) => callGateAgent(agent, request, attempt, providerCallAdmission);
    if (this.direct) {
      const result = await executeGatePlan({
        plan: this.direct, projectInvocation: invocationProjector, callAgent, executionBudget,
        protocolPolicy: new GateOutputProtocolPolicy({
          phase, parseResponse: (raw) => parseImplRequirementEvaluation(raw, this.batch.requirementIds),
        }),
        parseResponse: (response) => response,
      });
      return result.results.flat();
    }
    const protocolPolicy = new GateOutputProtocolPolicy({
      phase,
      parseResponse: (raw, batch) => new RequirementObservationResponse(parseJsonObject(raw), this.requirement.id, batch),
    });
    const evidence = await this.evidence.execute({ projectInvocation: invocationProjector, callAgent, protocolPolicy, executionBudget });
    const built = await reduceRequirementEvidence({
      evidence, requirement: this.requirement, limit: this.limit, projectInvocation: invocationProjector, protocolPolicy, executionBudget,
      buildFinalRequest: (observationEvidence) => buildImplCheckPrompt({
        requirements: [this.requirement], knownIds: [this.requirement.id], observationEvidence,
      }).build(),
      evaluateBatch: callAgent,
    });
    const result = await executeGatePlan({
      plan: PromptBatchPlan.fromRequest({ request: built, limit: this.limit, id: "requirement-gate-judgment" }), projectInvocation: invocationProjector, callAgent, executionBudget,
      protocolPolicy: new GateOutputProtocolPolicy({
        phase, parseResponse: (raw) => parseImplRequirementEvaluation(raw, [this.requirement.id]),
      }),
      parseResponse: (response) => response,
    });
    return result.results.flat();
  }
}

async function evaluateCanonicalRequirements({
  level,
  phase,
  targetPath,
  spec,
  requirements,
  fileMap,
  relatedDiffs,
  fullDiff,
  previousResult = null,
  executionEvidence = null,
  structuredSpec = null,
  sourceScope = null,
  executionBudget = createGateExecutionBudget(),
}) {
  const requirementContexts = new Map(requirements.map((requirement) => [
    requirement.id,
    buildRequirementGateContext({
      spec,
      requirement,
      fileMap: sourceScope === null ? fileMap : {},
      // The batch carries one authoritative diff for all Requirements with
      // the same source scope. Repeating it inside every context inflates the
      // prompt and call count without adding evidence.
      relatedDiff: "",
      sharedDiffEvidence: (relatedDiffs?.get(requirement.id) ?? fullDiff).trim() !== "",
      executionEvidence,
    }),
  ]));
  const plan = planRequirementGateCalls({
    requirements,
    contexts: requirementContexts,
    relatedDiffs,
    previouslyPassed: new Set(previousResult?.passedGuardrails || []),
    fullDiff,
    phase,
    maxChars: MAX_IMPL_REQUIREMENT_BATCH_CHARS,
    structuredSpec,
    sourceScope,
  });
  const evaluations = [...plan.evaluations];
  if (plan.calls.length === 0) return evaluations;
  const agent = container.get("agent");
  const agentResolutionFailure = requiredGateAgentResolutionFailure(agent);
  if (agentResolutionFailure) {
    return gateRequiredEvaluationFail(level, phase, targetPath, agentResolutionFailure);
  }
  try {
    const limit = new PromptRequestLimit({ maxCharacters: agent.promptCharacterLimit ?? MAX_IMPL_REQUIREMENT_BATCH_CHARS });
    const projectInvocation = gateInvocationProjector(agent);
    const executions = plan.calls.flatMap((batch) => RequirementGateExecutionPlan.create(batch, limit));
    executionBudget.assertCanExecute(executions.reduce((count, execution) => count
      + (execution.direct?.batches.length ?? execution.evidence.plan.batches.length + 1), 0));
    // Every source and context range is planned before the first provider call.
    for (const execution of executions) execution.preflight(projectInvocation);
    for (const execution of executions) {
      const result = await execution.execute({ agent, phase, projectInvocation, executionBudget });
      evaluations.push(...result.map((entry) => ({
        ...entry,
        title: entry.guardrail_id,
        category: "requirements",
      })));
    }
  } catch (error) {
    return gateRequiredEvaluationFail(
      level,
      phase,
      targetPath,
      requiredGateEvaluationFailure(error),
    );
  }
  if (!evaluations.every((entry) => entry.result === "pass" || entry.result === "skip")) {
    return gateFail(level, phase, targetPath, evaluations, []);
  }
  return evaluations;
}

function buildImplCheckPrompt(specTextOrOptions, diffArg, knownIdsArg) {
  const options = typeof specTextOrOptions === "object" && specTextOrOptions !== null && !Array.isArray(specTextOrOptions)
    ? specTextOrOptions
    : { requirements: specTextOrOptions, diff: diffArg, knownIds: knownIdsArg };
  const requirements = options.requirements;
  const contexts = options.contexts || null;
  const diff = options.diff || "";
  const knownIds = options.knownIds || [];
  const sameSpecContractContext = options.sameSpecContractContext || null;
  const sourceScope = options.sourceScope || null;
  if (sameSpecContractContext !== null && !(sameSpecContractContext instanceof SameSpecContractContext)) {
    throw new Error("sameSpecContractContext must be a SameSpecContractContext or null");
  }
  if (sourceScope !== null && !(sourceScope instanceof CanonicalSourceRequirementScope)) {
    throw new Error("sourceScope must be a CanonicalSourceRequirementScope or null");
  }
  const pb = new PromptBuilder();
  pb.setRole("You are an implementation compliance checker.\nCheck whether each spec requirement has been implemented in the diff.");

  const rules = [
    "- guardrail_id MUST be one of the requirement ids listed below.",
    "- result MUST be one of the lowercase strings: pass, fail, skip.",
    "- Every evaluation reason MUST cite [REQ:<id>] and every additional source reference used by the reason.",
    "- A finding cannot require a field, outcome, rejection rule, or behavior absent from the rendered authoritative context.",
    "- Return FAIL when authoritative context requires changed behavior, an integration, or an exact field and mapped implementation evidence omits or contradicts it.",
    "- Use skip only when the requirement can only be verified by running tests and no execution evidence is provided.",
    "- Deferred full-project regression evidence is valid at this integration gate: final-regression, not this gate, owns the default full project test command. Do not fail solely because that deferred evidence does not yet contain a passing full regression result.",
    "- Treat [TEST:<id>] and [TEST-REVIEW] entries as validated execution evidence. When [REGRESSION] records full-regression-deferred, full-project execution belongs exclusively to final-regression and its absence is not a FAIL at this gate.",
    "- Respect later-step ownership. When a requirement explicitly assigns its observable output to a later normal Flow step, evaluate whether the mapped implementation preserves and correctly configures that step. Do not require the later step's output before that step has run.",
    "- Preserve typed retry behavior: Definition owns semantic retry exhaustion and deferred findings, while structural, tooling, failed-test, or missing-repair failures remain blocking.",
    ...(sameSpecContractContext ? [
      "- Assess preservation against the explicit same-spec current contract, not legacy behavior that it replaces, retires, or invalidates.",
      "- Explicit same-spec replacement, retirement, or invalidation statements override legacy preservation obligations; otherwise preserve existing behavior.",
    ] : []),
  ].join("\n");
  pb.setRules(rules);
  pb.setJsonSchema(exactIdSchema(
    IMPL_REQUIREMENT_EVAL_SCHEMA,
    "evaluations",
    "guardrail_id",
    knownIds,
  ));
  pb.setFmtFallback(exactIdFallback(IMPL_REQUIREMENT_FMT_FALLBACK, "<id>", knownIds));

  pb.addUserPrompt("## Requirement IDs", knownIds.map((id) => `- ${id}`).join("\n"));
  if (options.observationEvidence === undefined) {
    if (Array.isArray(contexts)) {
      pb.addUserPrompt("## Requirement Contexts", renderRequirementContextSection(contexts));
    } else if (Array.isArray(requirements)) {
      pb.addUserPrompt("## Requirements", renderRequirementPromptSection(requirements));
    } else {
      pb.addUserPrompt("## Spec", requirements || "");
    }
  }
  if (sameSpecContractContext && options.observationEvidence === undefined) {
    pb.addUserPrompt("## Same-Spec Contract Context", sameSpecContractContext.toPromptText());
  }
  if (sourceScope && options.observationEvidence === undefined) {
    pb.addUserPrompt("## Canonical Requirement-Source Mapping", sourceScope.toPromptText());
  }
  if (options.observationEvidence !== undefined) {
    pb.addUserPrompt("## Complete canonical evidence observations", options.observationEvidence);
    pb.addUserPrompt("## Final judgment contract", [
      "All source and contract ranges have been scanned. Make one final requirement judgment from the complete observation set.",
      "Distinguish source facts from authoritative contract facts, preserve contradictions, and resolve questions across ranges.",
      "The absence of a fact from one range alone is not evidence of missing implementation.",
    ].join("\n"));
  } else {
    pb.addUserPrompt("## Git Diff", diff);
  }

  return pb;
}

function buildPerRequirementDiffs(fileMap, perFileDiffs, reqIds, fullDiff) {
  if (!fileMap || Object.keys(fileMap).length === 0) return null;
  const collection = GateDiffCollection.from(perFileDiffs);
  if (collection.size === 0 && fullDiff.trim() !== "") {
    return new Map(reqIds.map((reqId) => [reqId, fullDiff]));
  }

  const allMappedFiles = new Set();
  for (const files of Object.values(fileMap)) {
    if (Array.isArray(files)) {
      for (const f of files) allMappedFiles.add(f);
    }
  }
  const isMappedFile = (file) => {
    if (allMappedFiles.has(file)) return true;
    for (const mapped of allMappedFiles) {
      const prefix = String(mapped).replace(/\/$/, "");
      if (prefix && file.startsWith(`${prefix}/`)) return true;
    }
    return false;
  };

  const result = new Map();
  const unscopedEvidence = collection.preambleText + collection.unparsedText();
  for (const reqId of reqIds) {
    const mappedFiles = fileMap[reqId];
    if (!Array.isArray(mappedFiles)) {
      result.set(reqId, fullDiff);
      continue;
    }
    const normalized = mappedFiles.map((file) => String(file).replace(/\/$/, ""));
    const selected = [];
    for (const segment of collection.evidenceSegments()) {
      const mappedToRequirement = segment.paths.some((diffFile) => normalized.some((file) => (
        file === diffFile || (file && diffFile.startsWith(`${file}/`))
      )));
      // A changed file outside the canonical map may affect any Requirement,
      // so every evaluation receives it. Each file is appended at most once,
      // including overlapping file/directory mappings or rename aliases.
      if (mappedToRequirement || !segment.paths.some((file) => isMappedFile(file))) selected.push(segment.text);
    }
    // Leading and unparseable Git text cannot be scoped safely. It remains
    // visible to every Requirement instead of being silently discarded or
    // marking a mapped Requirement as having no evidence.
    if (unscopedEvidence) selected.push(unscopedEvidence);
    result.set(reqId, selected.join(""));
  }
  return result;
}

function renderCanonicalTaskSourceEntry(entry) {
  return entry.status === "deleted"
    ? `## ${entry.path}\n(deleted)`
    : `## ${entry.path}\n${entry.content}`;
}

function renderCanonicalTaskSource(entries) {
  return entries.map(renderCanonicalTaskSourceEntry).join("\n\n");
}

function canonicalTaskSourceEntriesByPath(entries) {
  return new Map(entries.map((entry) => [
    entry.path,
    `${renderCanonicalTaskSourceEntry(entry)}\n\n`,
  ]));
}

// ---------------------------------------------------------------------------
// Result builders
// ---------------------------------------------------------------------------

// spec 255 R9: emit ONE row per violation on FAIL article entries.
// detail includes `(at <where>)` so the location is preserved when persisted to issue-log.
export function reasonsFromEvaluations(evaluations) {
  const rows = [];
  for (const e of evaluations || []) {
    const verdict = e.result === "pass" ? "PASS" : e.result === "fail" ? "FAIL" : "SKIP";
    const title = e.title || e.guardrail_id;
    if (verdict === "FAIL" && Array.isArray(e.violations) && e.violations.length > 0) {
      for (const v of e.violations) {
        rows.push({
          verdict,
          detail: `${title} — ${v.target} — ${v.why_violates} (at ${v.where})`,
          guardrail_id: e.guardrail_id,
          category: e.category,
          where: v.where,
        });
      }
      continue;
    }
    rows.push({
      verdict,
      detail: `${title} — ${e.reason}`,
      guardrail_id: e.guardrail_id,
      category: e.category,
    });
  }
  return rows;
}

function nextActionFromGateEvaluations(evaluations, prescription) {
  const observations = observationsFromGateEvaluations(evaluations);
  const legacyFailures = Array.isArray(evaluations)
    ? evaluations.filter((entry) => (
        entry?.result === "fail"
        && (!Array.isArray(entry.observations) || entry.observations.length === 0)
      ))
    : [];
  const legacyObservations = legacyFailures.length > 0
    ? legacyEvaluationsToNextAction({ evaluations: legacyFailures, prescription }).diagnosis.observations
    : [];
  const combined = [...observations, ...legacyObservations.map((observation) => observation.toJSON())];
  if (combined.length > 0) {
    return new NextAction({
      diagnosis: new Diagnosis({
        summary: `${combined.length} observation(s).`,
        observations: combined,
      }),
      prescription,
    }).toJSON();
  }
  return legacyEvaluationsToNextAction({ evaluations, prescription }).toJSON();
}

function gatePass(level, phase, targetPath, evaluations, warnings) {
  const artifacts = {
    target: targetPath,
    level,
    phase,
    evaluations: evaluations || [],
    reasons: reasonsFromEvaluations(evaluations),
    nextAction: nextActionFromGateEvaluations(evaluations || [], gateReportPrescription(phase, "pass")),
  };
  if (Array.isArray(warnings) && warnings.length > 0) {
    artifacts.warnings = warnings;
  }
  return {
    result: "pass",
    changed: [],
    artifacts,
  };
}

function gateFail(level, phase, targetPath, evaluations, issues) {
  const failedSemanticEvaluations = Array.isArray(evaluations)
    && evaluations.some((entry) => entry?.result === "fail" && entry?.authority !== "mechanical");
  const failedMechanicalEvaluations = Array.isArray(evaluations)
    && evaluations.some((entry) => entry?.result === "fail" && entry?.authority === "mechanical");
  const observations = issues?.length
    ? issues.map((issue) => Observation.processEvidenceMissing({
        requirementRef: "process:gate-structure",
        where: null,
        observed: issue,
        diffVerifiable: true,
      }).toJSON())
    : null;
  const nextAction = observations
    ? new NextAction({
        diagnosis: new Diagnosis({ summary: `${observations.length} structural issue(s).`, observations }),
        prescription: gateReportPrescription(phase, "fail"),
      }).toJSON()
    : nextActionFromGateEvaluations(evaluations || [], gateReportPrescription(phase, "fail"));
  return {
    result: "fail",
    changed: [],
    artifacts: {
      target: targetPath,
      level,
      phase,
      evaluations: evaluations || [],
      reasons: reasonsFromEvaluations(evaluations),
      issues: issues || [],
      failureKind: failedSemanticEvaluations
        ? "ai_semantic_fail"
        : failedMechanicalEvaluations
          ? "mechanical_guardrail_fail"
          : "mechanical",
      ...(!failedSemanticEvaluations ? { failureCode: "GATE_LOCAL_INPUT_INVALID" } : {}),
      nextAction,
    },
  };
}

function gateRequiredEvaluationFail(level, phase, targetPath, result) {
  const failure = gateFail(level, phase, targetPath, [], [result.failureReason]);
  failure.artifacts.failureKind = result.failureKind;
  failure.artifacts.failureCode = result.failureCode;
  failure.artifacts.retryable = result.retryable === true;
  failure.artifacts.recoveryHint = result.recoveryHint
    || "Repair the required gate evaluation failure before starting a new attempt.";
  if (result.agentFailureKind) failure.artifacts.agentFailureKind = result.agentFailureKind;
  if (result.agentAttemptCount != null) failure.artifacts.agentAttemptCount = result.agentAttemptCount;
  if (result.agentMaxAttempts != null) failure.artifacts.agentMaxAttempts = result.agentMaxAttempts;
  return failure;
}


// ---------------------------------------------------------------------------
// Common gate flow
// ---------------------------------------------------------------------------

/**
 * Shared orchestrator: resolve target, run text check, run guardrail AI check.
 *
 * @param {Object} args
 * @param {string} args.root
 * @param {Object} args.config
 * @param {string} args.level
 * @param {string} args.phase
 * @param {string} args.targetPath - relative path used in report
 * @param {string} args.targetText - content to evaluate
 * @param {() => string[]} args.textCheck - returns structural issues
 * @param {string} args.checkerRole - guardrail checker role
 * @param {boolean} args.skipGuardrail
 * @param {Object} [args.ctx] - optional context for retry guards (spec 228)
 * @param {Object} [args.guardrailPromptOptions] - optional guardrail prompt context
 */
export async function runGateFlow(args) {
  const {
    root, config, level, phase,
    targetPath, targetText, textCheck, checkerRole, skipGuardrail,
    ctx, guardrailPromptOptions = {}, checkGuardrailFn = checkGuardrail,
    authoritativeEvaluations = [],
  } = args;
  const artifactRoot = args.artifactRoot || root;
  const priorMemoryMarkdown = "";

  validateLevelPhase(level, phase);

  if (ctx && !(ctx.evaluationScope instanceof GateEvaluationScope)) {
    ctx.evaluationScope = currentGateEvaluationScope({
      root,
      phase,
      inputs: { targetText, authoritativeEvaluations },
    });
  }

  try {
    validateConfiguredPresetChains(root, config);
  } catch (error) {
    const failure = gateFail(level, phase, targetPath, [], [error.message]);
    failure.artifacts.failureKind = "prerequisite";
    failure.artifacts.failureCode = "GATE_PRESET_NOT_FOUND";
    failure.artifacts.warnings = [error.message];
    return failure;
  }

  const issues = textCheck();
  if (issues.length > 0) {
    return gateFail(level, phase, targetPath, [], issues);
  }

  const ownedEvaluations = authoritativeEvaluations.map((evaluation) => ({ ...evaluation }));
  if (ownedEvaluations.some((evaluation) => evaluation.result === "fail")) {
    return gateFail(level, phase, targetPath, ownedEvaluations, []);
  }

  if (skipGuardrail) {
    return gatePass(level, phase, targetPath, ownedEvaluations);
  }

  let previousEntry = null;
  let previouslyPassedIds;
  if (ctx && GATE_OBSERVATION_PHASES.includes(phase)) {
    previousEntry = findReusablePassedGuardrails({
      flowManager: ctx.flowManager,
      flowState: ctx.flowState,
      evaluationScope: ctx.evaluationScope,
    });
    if (previousEntry) {
      previouslyPassedIds = previousEntry.passedGuardrails;
    }
  }

  const result = await checkGuardrailFn(
    root,
    targetText,
    phase,
    checkerRole,
    previouslyPassedIds,
    {
      ...guardrailPromptOptions,
      executionBudget: ctx?.promptExecutionBudget ?? guardrailPromptOptions.executionBudget,
      priorMemoryMarkdown,
      excludedGuardrailIds: ownedEvaluations.map((evaluation) => evaluation.guardrail_id),
    },
  );
  if (!result) {
    return gatePass(level, phase, targetPath, ownedEvaluations);
  }

  if (result.failureCode) {
    return gateRequiredEvaluationFail(level, phase, targetPath, result);
  }

  let evaluations = [...ownedEvaluations, ...result.evaluations];

  if (previousEntry !== null) {
    evaluations = applyFlipOverride({
      evaluations,
      previousEntry,
    });
  }

  const passed = evaluations.every((e) => e.result === "pass" || e.result === "skip");
  if (!passed) return gateFail(level, phase, targetPath, evaluations, []);
  return gatePass(level, phase, targetPath, evaluations);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function resolveEffectiveGatePhase(ctx, inferredResolution = null) {
  const explicit = typeof ctx?.phase === "string" ? ctx.phase.trim() : "";
  const phase = explicit || (inferredResolution ?? resolveGatePhaseFromState(ctx?.flowState))?.phase || null;
  if (phase) ctx.phase = phase;
  return phase;
}

export class RunGateCommand extends FlowCommand {
  constructor() {
    super({ requiresFlow: false });
  }

  async run(container, input = {}) {
    if (input.skipGuardrail || input.skipRequiredEvaluation) {
      return Envelope.fail(
        "run",
        "gate",
        "GATE_REQUIRED_EVALUATION_BYPASS_FORBIDDEN",
        "required gate evaluations cannot be bypassed from the public CLI",
      );
    }
    try {
      parsePublicGateArguments(input._rawArgs);
    } catch (error) {
      return Envelope.fail("run", "gate", error.code, error.message);
    }
    const result = await super.run(container, input);
    return result;
  }

  async execute(ctx) {
    const { root } = ctx;
    const executionRoot = ctx.executionRoot || root;
    if (typeof ctx.flowManager?.loadReadOnly === "function" && ctx.flowState?.specId) {
      ctx.flowState = ctx.flowManager.loadReadOnly(ctx.specId ?? ctx.flowState.specId);
    }
    const inferPhase = ctx.phase == null || ctx.phase === "";
    const resolution = inferPhase ? resolveGatePhaseFromState(ctx.flowState) : null;
    const phase = resolveEffectiveGatePhase(ctx, resolution);

    if (!phase) {
      if (!resolution) {
        return Envelope.fail(
          "run",
          "gate",
          "NO_GATE_STEP_IN_PROGRESS",
          `no gate-type step is in_progress; specify --phase explicitly. ` +
            `valid phases: ${VALID_GATE_PHASES.join(", ")}`,
        );
      }
    }

    if (!VALID_GATE_PHASES.includes(phase)) {
      throw new Error(
        `invalid phase: ${phase} (valid: ${VALID_GATE_PHASES.join(", ")}). ` +
          `legacy names pre/post/impl have been retired — use spec / task-spec / task-impl / integration.`,
      );
    }
    const level = PHASE_TO_LEVEL[phase];
    if (!isCanonicalFlowState(ctx.flowState)) {
      throw new Error("gate requires an active canonical Flow state");
    }
    const result = await this.executeCanonical(ctx, {
      phase,
      level,
      skipGuardrail: ctx.skipGuardrail === true,
      executionRoot,
    });
    return result;
  }

  /**
   * Run the normal gate evaluator against Version-1 catalog inputs.  Gate
   * prompts retain their existing target text and phase; only persistence is
   * replaced by the Store-attached result returned at the end of this method.
   */
  async executeCanonical(ctx, { phase, level, skipGuardrail, executionRoot }) {
    ctx.promptExecutionBudget = createGateExecutionBudget();
    const flowManager = ctx.flowManager;
    if (!flowManager || typeof flowManager.canonicalState !== "function") {
      throw new Error("canonical gate requires FlowManager.canonicalState");
    }
    const state = flowManager.canonicalState(ctx.specId ?? ctx.flowState.specId);
    if (state === null) throw new Error("canonical gate requires a loaded Version-1 Flow");
    const activeTaskId = ctx.flowState.currentTaskId ?? null;
    const nodeId = canonicalGateNodeId({ phase, taskId: activeTaskId });
    if (state.current?.at(-1) !== nodeId || state.attempt?.nodeId !== nodeId) {
      throw new Error(`canonical gate requires active ${nodeId}, found ${state.current?.at(-1) ?? "none"}`);
    }
    if (phase === "task-impl" && activeTaskId !== null) {
      try {
        CanonicalTaskContext.capture({
          root: executionRoot,
          flowManager,
          state: ctx.flowState,
          taskId: activeTaskId,
        });
      } catch (error) {
        return Envelope.fail(
          "run",
          "gate",
          "TASK_CONTEXT_INVALID",
          `canonical Task context is invalid: ${error.message}`,
          { taskId: activeTaskId },
        );
      }
    }
    const existingFacts = readCurrentGateTransitionFacts({
      flowManager,
      flowState: ctx.flowState,
      phase,
    });
    if (existingFacts !== null) {
      // Task settlement is considered before the generic publication
      // recovery so a saved Task Gate result is reconciled without invoking
      // its worker again.
      const taskSettlementRecovery = resolveTaskGateSettlementRecovery(existingFacts);
      const recovery = taskSettlementRecovery ?? resolveGatePublicationRecovery(existingFacts);
      if (recovery !== null) {
        const selected = state.nextAction();
        if (taskSettlementRecovery === null
          && (selected?.operation !== "resume" || selected.action?.action !== "run-gate")) {
          throw new Error(
            `canonical Gate publication recovery rejected; state selected ${selected?.operation ?? "no action"}`,
          );
        }
        return new CanonicalGatePublishedResultRecovery({
          flowManager,
          state,
          phase,
          nodeId,
          activeTaskId,
          facts: existingFacts,
          recoveryDecision: recovery,
        }).rehydrate();
      }
      const decision = resolveGateTransition(existingFacts);
      throw new Error(
        `canonical gate admission rejected evaluation; definition selected ${decision.disposition.operation}`,
      );
    }
    const selected = state.nextAction();
    if (selected?.operation !== "resume" || selected.action?.action !== "run-gate") {
      throw new Error(
        `canonical gate admission rejected evaluation; state selected ${selected?.operation ?? "no action"}`,
      );
    }
    const inputs = new CanonicalGateInputStore({ flowManager, state: ctx.flowState, nodeId });
    const specPath = flowManager.specLocation(ctx.flowState.specId).relativeSpecFile;
    const issueLog = inputs.issueLog();
    const canonicalCtx = { ...ctx, flowState: ctx.flowState, issueLog };
    let result;

    if (phase === "draft") {
      const draft = inputs.draft();
      const targetPath = path.posix.join(path.posix.dirname(specPath), "draft.json");
      result = await runGateFlow({
        root: executionRoot,
        artifactRoot: executionRoot,
        config: ctx.config,
        level,
        phase,
        targetPath,
        targetText: `${JSON.stringify(draft, null, 2)}\n`,
        textCheck: () => checkDraftJson(draft),
        checkerRole: "You are a draft compliance checker. Check whether the draft satisfies each guardrail perspective.",
        skipGuardrail,
        ctx: canonicalCtx,
      });
    } else if (phase === "spec") {
      const spec = inputs.spec();
      let loadError = null;
      try {
        validateSpecJsonObject(spec);
      } catch (error) {
        loadError = error.message;
      }
      const guardrails = filterByPhase(loadMergedGuardrails(executionRoot), "spec");
      const testCoverage = guardrails.find((guardrail) => guardrail.id === SPEC_TEST_COVERAGE_GUARDRAIL_ID);
      const authoritativeEvaluations = testCoverage
        ? [new SpecTestCoverageDecision({ phase: "spec", guardrail: testCoverage }).toGateEvaluation()]
        : [];
      result = await runGateFlow({
        root: executionRoot,
        artifactRoot: executionRoot,
        config: ctx.config,
        level,
        phase,
        targetPath: specPath,
        targetText: `${JSON.stringify(spec, null, 2)}\n`,
        textCheck: () => loadError ? [`schema: ${loadError}`] : checkSpecJson(spec),
        checkerRole: undefined,
        skipGuardrail,
        ctx: canonicalCtx,
        guardrailPromptOptions: { acknowledgedRationale: buildAcknowledgedRationaleSection({ spec, guardrails }) },
        authoritativeEvaluations,
      });
    } else if (phase === "task-spec") {
      // An explicit task-spec is a public command input, not a Flow artifact.
      // Its producer remains the spec-gate Attempt, while its text is checked
      // without consulting a source-era spec directory.
      const targetPath = ctx.spec || specPath;
      const absoluteTarget = path.resolve(executionRoot, targetPath);
      if (!fs.existsSync(absoluteTarget)) throw new Error(`spec not found: ${absoluteTarget}`);
      const text = fs.readFileSync(absoluteTarget, "utf8");
      result = await runGateFlow({
        root: executionRoot,
        artifactRoot: executionRoot,
        config: ctx.config,
        level,
        phase,
        targetPath,
        targetText: text,
        textCheck: () => checkSpecText(text),
        checkerRole: undefined,
        skipGuardrail,
        ctx: canonicalCtx,
      });
    } else if (phase === "task-impl" && activeTaskId !== null) {
      result = await this.executeCanonicalTaskGate({
        ctx: canonicalCtx,
        inputs,
        level,
        phase,
        executionRoot,
        skipGuardrail,
      });
    } else {
      result = await this.executeCanonicalImplementationGate({
        ctx: canonicalCtx,
        inputs,
        level,
        phase,
        executionRoot,
        skipGuardrail,
      });
    }

    // No filesystem result/source writer is permitted here.  The registry
    // confirms a pass with its lifecycle Activity; a non-pass is published
    // before the retry lifecycle keeps the Attempt active.
    attachGateEvaluationScope(result, canonicalCtx.evaluationScope);
    if (result?.result === "pass" || result?.result === "fail" || result?.result === "recovered") {
      new CanonicalGatePromotion({
        state: ctx.flowManager.canonicalState(ctx.flowState.specId),
        phase,
        nodeId,
        activeTaskId,
      }).promote(result);
    }
    return result;
  }

  async executeCanonicalTaskGate({ ctx, inputs, level, phase, executionRoot, skipGuardrail }) {
    const state = ctx.flowState;
    const task = inputs.task();
    const spec = inputs.spec();
    const specPath = ctx.flowManager.specLocation(state.specId).relativeSpecFile;
    const source = captureCurrentTaskSource({ root: executionRoot, flowManager: ctx.flowManager, state, taskId: task.id });
    const context = CanonicalTaskContext.capture({
      root: executionRoot,
      flowManager: ctx.flowManager,
      state,
      taskId: task.id,
      spec,
      source,
    });
    const targetPath = path.posix.join(path.posix.dirname(specPath), "tasks", `${task.id}.md`);
    const complete = (result) => this.completeCanonicalTaskGateResult({
      result,
      root: executionRoot,
      flowManager: ctx.flowManager,
      state,
      taskId: task.id,
      source,
      evaluationScope: ctx.evaluationScope,
    });
    const requirementAuthority = CanonicalSourceRequirementAuthority
      .fromTaskRequirements(context.requirements);
    const sourcePaths = source.entries.map((entry) => entry.path);
    const sourceScope = requirementAuthority.bindSourceScope(sourcePaths);
    ctx.evaluationScope = currentGateEvaluationScope({
      root: executionRoot,
      phase,
      taskId: task.id,
      sourceFingerprint: source.fingerprint,
      inputs: {
        spec,
        taskContext: context.readOnlyInput(),
        source: source.toJSON(),
        sourceScope: sourceScope.toJSON(),
      },
    });
    if (source.entries.length === 0) {
      const result = gateFail(level, phase, targetPath, [], [
        "Task Gate is inadmissible for an empty mutation manifest; Definition must settle the reviewed no-change result",
      ]);
      return complete(result);
    }
    const currentSource = renderCanonicalTaskSource(source.entries);
    const diffBytes = Buffer.byteLength(currentSource, "utf8");
    if (diffBytes > TASK_IMPL_GATE_DIFF_MAX_BYTES) {
      return complete(gateFail(level, phase, targetPath, [], [
        `Task current source is ${diffBytes} bytes, exceeds limit ${TASK_IMPL_GATE_DIFF_MAX_BYTES}`,
      ]));
    }
    const gitState = computeGitState(executionRoot);
    ctx.gitState = gitState;
    const fileMap = requirementAuthority.bindPaths(sourcePaths).toJSON();
    const requirements = context.requirements.map((requirement) => new RequirementPromptExcerpt(requirement));
    const relatedDiffs = buildPerRequirementDiffs(
      fileMap,
      canonicalTaskSourceEntriesByPath(source.entries),
      requirements.map((requirement) => requirement.id),
      currentSource,
    );
    if (relatedDiffs === null) {
      return complete(gateFail(level, phase, targetPath, [], [
        "Task Gate requires a canonical Requirement-to-source mapping",
      ]));
    }
    const previousResult = findReusablePassedGuardrails({
      flowManager: ctx.flowManager,
      flowState: state,
      evaluationScope: ctx.evaluationScope,
    });
    const requirementEvaluation = await evaluateCanonicalRequirements({
      level,
      phase,
      targetPath,
      spec,
      requirements,
      fileMap,
      relatedDiffs,
      fullDiff: currentSource,
      executionBudget: ctx.promptExecutionBudget,
      previousResult,
      sourceScope,
    });
    if (!Array.isArray(requirementEvaluation)) return complete(requirementEvaluation);
    const result = await runGateFlow({
      root: executionRoot,
      artifactRoot: executionRoot,
      config: ctx.config,
      level,
      phase,
      targetPath,
      targetText: `${task.markdown}\n\n## Canonical Task Context\n${JSON.stringify(context.readOnlyInput(), null, 2)}\n\n## Current Allow-listed Source\n${currentSource}`,
      textCheck: () => [],
      checkerRole: "You are a task implementation compliance checker. Check only this Task's mapped requirements against its current allow-listed source. Do not run tests.",
      skipGuardrail,
      ctx,
      authoritativeEvaluations: requirementEvaluation,
    });
    return complete(result);
  }

  completeCanonicalTaskGateResult({ result, root, flowManager, state, taskId, source, evaluationScope }) {
    const currentState = flowManager.loadReadOnly(state.specId);
    const recapturedSource = captureCurrentTaskSource({
      root,
      flowManager,
      state: currentState,
      taskId,
    });
    if (recapturedSource.fingerprint !== source.fingerprint) {
      throw new Error("Task Gate source changed during evaluation; reload the current Task context");
    }
    const specSource = flowManager.readArtifact({
      specId: currentState.specId,
      logicalKey: "spec.record",
      consumerNodeId: currentState.currentNodeId,
    });
    const currentSpec = JSON.parse(specSource.bytes.toString("utf8"));
    const currentContext = CanonicalTaskContext.capture({
      root,
      flowManager,
      state: currentState,
      taskId,
      spec: currentSpec,
      source: recapturedSource,
    });
    const currentScope = currentGateEvaluationScope({
      root,
      phase: "task-impl",
      taskId,
      sourceFingerprint: recapturedSource.fingerprint,
      inputs: {
        spec: currentSpec,
        taskContext: currentContext.readOnlyInput(),
        source: recapturedSource.toJSON(),
        sourceScope: CanonicalSourceRequirementAuthority
          .fromTaskRequirements(currentContext.requirements)
          .bindSourceScope(recapturedSource.entries.map((entry) => entry.path))
          .toJSON(),
      },
    });
    if (!(evaluationScope instanceof GateEvaluationScope) || !evaluationScope.matches(currentScope)) {
      throw new Error("Task Gate evaluation inputs changed during evaluation; reload the current Task context");
    }
    result.artifacts ||= {};
    result.artifacts.sourceFingerprint = source.fingerprint;
    return result;
  }

  async executeCanonicalImplementationGate({ ctx, inputs, level, phase, executionRoot, skipGuardrail }) {
    const state = ctx.flowState;
    const specPath = ctx.flowManager.specLocation(state.specId).relativeSpecFile;
    const spec = inputs.spec();
    if (!state.baseBranch) throw new Error("baseBranch not set in canonical Flow execution");
    let integrationExecutionEvidence = null;
    if (phase === "integration") {
      const execution = inputs.attemptResult("test.execute", {
        consumerNodeId: "impl-gate",
        optional: true,
      });
      const review = inputs.attemptResult("test.result.review", {
        consumerNodeId: "impl-gate",
        optional: true,
      });
      if (execution === null || review === null) {
        const blocked = gateFail(level, phase, specPath, [], [
          "integration test artifact trust validation failed: test-execute and test-result-review are required",
        ]);
        blocked.artifacts.failureKind = "artifact_trust_failure";
        blocked.artifacts.failureCode = "CANONICAL_TEST_EVIDENCE_MISSING";
        return blocked;
      }
      const upgrade = validateCanonicalUpgradeEvidence({
        flowManager: ctx.flowManager,
        state,
        consumerNodeId: "impl-gate",
        root: executionRoot,
      });
      if (!upgrade.ok) {
        const blocked = gateFail(level, phase, specPath, [], [
          `integration upgrade evidence validation failed: ${upgrade.reason}`,
        ]);
        blocked.artifacts.failureKind = "artifact_trust_failure";
        blocked.artifacts.failureCode = "CANONICAL_UPGRADE_EVIDENCE_INVALID";
        return blocked;
      }
      try {
        const fingerprintAuthority = new IntegrationArtifactFingerprintAuthority({
          result: execution.payload,
          review: review.payload,
        });
        integrationExecutionEvidence = new IntegrationExecutionEvidence({
          result: execution.payload,
          review: review.payload,
        });
        const currentFingerprint = buildRepairFingerprint({
          root: executionRoot,
          artifactRoot: ctx.root,
          specPath,
        });
        const staleEvidence = StaleTestEvidenceMismatch.detect({
          artifacts: fingerprintAuthority.toArtifactMap(),
          currentFingerprint: currentFingerprint.hash,
        });
        if (staleEvidence !== null) {
          // The evaluator only reports the durable stale-evidence fact.  The
          // Definition-selected recovery plan owns the test-execute rewind.
          const evidenceRefresh = new StaleTestEvidenceRefreshResult({
            previousFingerprint: staleEvidence.previousFingerprint,
            currentFingerprint: staleEvidence.currentFingerprint,
            invalidatedArtifacts: staleEvidence.artifactNames,
          });
          return {
            result: "recovered",
            changed: [],
            artifacts: {
              phase,
              staleArtifacts: [...staleEvidence.artifactNames],
              evidenceRefresh: evidenceRefresh.toJSON(),
            },
          };
        }
      } catch (error) {
        const blocked = gateFail(level, phase, specPath, [], [
          `integration test artifact trust validation failed: ${error.message}`,
        ]);
        blocked.artifacts.failureKind = "artifact_trust_failure";
        blocked.artifacts.failureCode = "CANONICAL_TEST_EVIDENCE_INVALID";
        return blocked;
      }
    }
    const committed = runGitDiff([`${state.baseBranch}...HEAD`], "failed to get git diff", executionRoot);
    const uncommitted = runGitDiff(["HEAD"], "failed to get uncommitted git diff", executionRoot);
    const untracked = await collectUntrackedDiff(executionRoot, {
      excludeFile: (relPath) => isGeneratedSpecArtifactForGate(relPath, specPath),
    });
    const diff = buildGateEvaluationDiff({ committed, uncommitted, untracked, specPath });
    if (!diff.trim()) {
      return gateFail(level, phase, specPath, [], [
        "no changes found (committed or uncommitted) against base branch",
      ]);
    }
    const gitState = computeGitState(executionRoot);
    ctx.gitState = gitState;
    const requirements = enumerateUsableRequirementIds(spec);
    if (requirements.length === 0) {
      return gateFail(level, phase, specPath, [], ["spec.json has no requirements with usable ids"]);
    }
    const specification = specJsonToPromptText(spec, { title: getSpecName(state) });
    const reqIds = requirements;
    const requirementEntries = spec.requirements
      .filter((requirement) => reqIds.includes(requirement.id))
      .map((requirement) => new RequirementPromptExcerpt(requirement));
    let fileMap;
    try {
      fileMap = new CanonicalFileMap(inputs.readJson("file.map", {
        consumerNodeId: "impl-gate",
        optional: true,
      }) ?? {}).assertAgainstSpec(spec).toJSON();
    } catch (error) {
      return gateFail(level, phase, specPath, [], [error.message]);
    }
    let perReqDiffs = null;
    if (Object.keys(fileMap).length > 0) {
      const perFileDiffs = excludeGeneratedSpecArtifactsFromPerFileDiffs(
        collectPerFileDiffsForGate(committed, uncommitted, untracked),
        specPath,
      );
      perReqDiffs = buildPerRequirementDiffs(fileMap, perFileDiffs, reqIds, diff);
    }
    ctx.evaluationScope = currentGateEvaluationScope({
      root: executionRoot,
      phase,
      inputs: {
        spec,
        diff,
        fileMap,
        executionEvidence: integrationExecutionEvidence,
      },
    });
    const previousResult = findReusablePassedGuardrails({
      flowManager: ctx.flowManager,
      flowState: state,
      evaluationScope: ctx.evaluationScope,
    });
    const requirementEvaluation = await evaluateCanonicalRequirements({
      level,
      phase,
      targetPath: specPath,
      spec,
      requirements: requirementEntries,
      fileMap,
      relatedDiffs: perReqDiffs,
      fullDiff: diff,
      executionBudget: ctx.promptExecutionBudget,
      previousResult,
      executionEvidence: integrationExecutionEvidence,
      structuredSpec: phase === "integration" ? spec : null,
    });
    if (!Array.isArray(requirementEvaluation)) return requirementEvaluation;
    const reqEvaluations = requirementEvaluation;
    const fileMapWarnings = this.reconcileCanonicalFileMapWarnings({
      executionRoot,
      state,
      fileMap,
    });
    if (skipGuardrail) return gatePass(level, phase, specPath, reqEvaluations, fileMapWarnings);
    const diffGuardrails = filterByPhase(loadMergedGuardrails(executionRoot), phase);
    const grResult = await checkGuardrail(
      executionRoot,
      buildGuardrailTargetTextForPrompt(specification, diff),
      phase,
      "You are an implementation compliance checker. Check the implementation against each guardrail.",
      previousResult?.passedGuardrails,
      {
        acknowledgedRationale: buildAcknowledgedRationaleSection({ spec, guardrails: diffGuardrails }),
        executionBudget: ctx.promptExecutionBudget,
      },
    );
    if (!grResult) return gatePass(level, phase, specPath, reqEvaluations, fileMapWarnings);
    if (grResult.failureCode) return gateRequiredEvaluationFail(level, phase, specPath, grResult);
    const combined = [...reqEvaluations, ...grResult.evaluations];
    if (!grResult.passed) return gateFail(level, phase, specPath, combined, []);
    return gatePass(level, phase, specPath, combined, fileMapWarnings);
  }

  reconcileCanonicalFileMapWarnings({ executionRoot, state, fileMap }) {
    try {
      if (Object.keys(fileMap).length === 0) return [];
      const diffRes = runGit(["diff", "--name-only", `${state.baseBranch}...HEAD`], { cwd: executionRoot });
      if (!diffRes.ok) return [];
      const unrecorded = reconcileFileMap(fileMap, diffRes.stdout.trim().split("\n").filter(Boolean));
      return unrecorded.length === 0
        ? []
        : [`file-map: ${unrecorded.length} file(s) in diff but not recorded: ${unrecorded.join(", ")}`];
    } catch (error) {
      process.stderr.write(`[sennel] canonical file-map reconciliation skipped: ${error.message}\n`);
      return [];
    }
  }

}

export default RunGateCommand;

export {
  checkSpecText,
  checkSpecJson,
  checkDraftJson,
  buildGuardrailPrompt,
  buildImplCheckPrompt,
  MAX_IMPL_REQUIREMENT_BATCH_CHARS,
  checkGuardrail,
  splitDiffByFile,
  buildGuardrailTargetTextForPrompt,
  collectPerFileDiffsForGate,
  buildPerRequirementDiffs,
  renderCanonicalTaskSource,
};

export class GateIssueLogEntry {
  constructor({ ctx, result }) {
    if (result?.result !== "pass" && result?.result !== "fail") {
      throw new Error("gate issue-log entry requires a pass or fail result");
    }
    let canonicalResult = result;
    let taskFacts = null;
    const taskDecision = ctx.gateTransitionDecision?.facts?.scope === "task"
      ? ctx.gateTransitionDecision
      : null;
    if (taskDecision !== null) {
      taskFacts = readCurrentGateTransitionFacts({
        flowManager: ctx.flowManager,
        flowState: ctx.flowManager.loadReadOnly(ctx.flowState.specId),
        phase: "task-impl",
      });
      if (taskFacts === null || taskFacts.target.taskId !== taskDecision.facts.target.taskId) {
        throw new Error("Task Gate issue-log entry requires current canonical Gate facts");
      }
      const source = ctx.flowManager.readProducerArtifact({
        specId: taskFacts.target.specId,
        nodeId: taskFacts.target.stepId,
        logicalKey: "task.gate",
        parameters: { taskId: taskFacts.target.taskId },
      });
      const history = CanonicalCommandAttemptArtifactHistory.fromBytes({
        logicalKey: "task.gate", bytes: source.bytes,
      });
      const attached = attachedCanonicalCommandResultArtifact(result);
      if (source.descriptor.hash !== taskFacts.catalogPublication.fingerprint
        || source.descriptor.activityId !== taskFacts.catalogPublication.producerActivityId
        || history.current.attempt !== taskFacts.currentAttempt.sequence
        || attached?.logicalKey !== "task.gate"
        || JSON.stringify(attached.payload) !== JSON.stringify(history.current.payload)) {
        throw new Error("Task Gate issue-log result is not the current canonical result");
      }
      canonicalResult = attached.payload;
    }
    const phase = canonicalResult?.artifacts?.phase || ctx.phase;
    if (!phase) throw new Error("gate issue-log phase is unavailable");
    const observations = canonicalResult?.artifacts?.nextAction?.diagnosis?.observations || [];
    const needsProgressIdentity = canonicalResult.result === "fail"
      && (canonicalResult?.artifacts?.failureKind === "ai_semantic_fail" || observations.length > 0);
    const gitState = ctx.gitState || (needsProgressIdentity && GATE_OBSERVATION_PHASES.includes(phase)
      ? computeGateEvidenceState({
          executionRoot: ctx.executionRoot || ctx.root,
          flowManager: ctx.flowManager,
          flowState: ctx.flowState,
          phase,
        })
      : null);
    const reasons = canonicalResult?.artifacts?.issues?.length
      ? canonicalResult.artifacts.issues.join("; ")
      : observations.map((observation) => observation.observed).join("; ")
        || (canonicalResult?.artifacts?.reasons || []).map((reason) => reason.detail || reason).join("; ");
    const taskGateStepId = phase === "task-impl" && canonicalResult?.artifacts?.taskId
      ? `${canonicalResult.artifacts.taskId}-gate`
      : null;
    const entry = {
      step: taskGateStepId || resolveGateStepId(phase),
      level: canonicalResult?.artifacts?.level,
      phase,
      reason: reasons || `gate ${canonicalResult.result.toUpperCase()} (no details)`,
      trigger: "gate post hook (auto)",
      timestamp: new Date().toISOString(),
      passedGuardrails: buildPassedGuardrails(canonicalResult?.artifacts?.evaluations),
    };
    if (taskGateStepId !== null) {
      if (taskFacts === null || taskFacts.target.taskId !== canonicalResult.artifacts.taskId) {
        throw new Error("Task Gate issue-log entry requires current canonical Gate facts");
      }
      entry.taskId = taskFacts.target.taskId;
      entry.gateReceipt = {
        attempt: taskFacts.currentAttempt.toJSON(),
        catalogFingerprint: taskFacts.catalogPublication.fingerprint,
        lineage: taskFacts.lineage.toJSON(),
      };
      entry.issueLogId = taskGateSettlementIssueLogId({
        runId: taskFacts.target.runId,
        nodeId: taskFacts.target.stepId,
        attempt: taskFacts.currentAttempt,
        publicationActivityId: taskFacts.catalogPublication.producerActivityId,
        catalogFingerprint: taskFacts.catalogPublication.fingerprint,
      });
    }
    if (gitState && GATE_OBSERVATION_PHASES.includes(phase)) {
      entry.headSha = gitState.headSha;
      entry.worktreeHash = gitState.worktreeHash;
    }
    if (observations.length > 0) entry.observations = observations;
    const failedEvaluations = buildFailedEvaluations(canonicalResult?.artifacts?.evaluations);
    if (failedEvaluations.length > 0) entry.failedEvaluations = failedEvaluations;
    this.value = Object.freeze(entry);
    Object.freeze(this);
  }

  toJSON() {
    return structuredClone(this.value);
  }
}

export function appendIssueLogFromGateResult(ctx, result) {
  if (result?.result !== "pass" && result?.result !== "fail") return;
  const decision = ctx.gateTransitionDecision;
  const taskGate = (result?.artifacts?.phase || ctx.phase) === "task-impl"
    && typeof result?.artifacts?.taskId === "string";
  if (taskGate && decision?.facts?.scope !== "task") {
    throw new Error("Task Gate issue-log settlement requires its Definition decision");
  }
  const entry = new GateIssueLogEntry({ ctx, result }).toJSON();
  appendCanonicalIssueLogEntry(
    ctx.flowManager,
    ctx.flowState,
    entry,
    null,
    decision?.facts?.scope === "task" ? new TaskGateSettlementAdmission(decision, "issue-log", entry) : undefined,
  );
}

export function appendIssueLogFromGateError(ctx, err) {
  const evidence = err?.data || {};
  const phase = evidence.effectivePhase || evidence.phase || ctx.phase;
  if (!phase) throw new Error("gate error issue-log phase is unavailable");
  const entry = {
    step: resolveGateStepId(phase),
    phase,
    reason: err.message || String(err),
    trigger: "gate onError hook (auto)",
    timestamp: new Date().toISOString(),
  };
  if (evidence.classification) entry.classification = evidence.classification;
  if (evidence.failureMode) entry.failureMode = evidence.failureMode;
  if (evidence.originalError) entry.originalError = evidence.originalError;
  if (Number.isInteger(evidence.attemptCount)) entry.attemptCount = evidence.attemptCount;
  if (Array.isArray(evidence.attempts)) entry.attempts = evidence.attempts;
  if (Number.isInteger(evidence.providerCalls)) entry.providerCalls = evidence.providerCalls;
  if (Number.isInteger(evidence.freshRepairAttempts)) {
    entry.freshRepairAttempts = evidence.freshRepairAttempts;
  }
  appendCanonicalIssueLogEntry(ctx.flowManager, ctx.flowState, entry);
}
