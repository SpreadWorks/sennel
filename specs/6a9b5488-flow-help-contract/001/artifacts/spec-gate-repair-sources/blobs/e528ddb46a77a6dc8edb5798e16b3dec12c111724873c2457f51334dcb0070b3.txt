/**
 * src/flow/run/report.js
 *
 * Generate a work report from finalize pipeline data.
 * Called by the independent report flow step before finalize-commit.
 */

import crypto from "node:crypto";
import fs from "fs";
import path from "path";
import { runGit } from "../../lib/git-helpers.js";
import { buildMetricsSummary, buildReportTotals } from "../lib/get-status.js";
import { buildBoundedBroadModeHistory } from "../lib/task-scope.js";
import { pushSection, DIVIDER, formatDurationSeconds } from "../../lib/formatter.js";
import { BROAD_MODE_HISTORY_MAX_ENTRIES } from "../../lib/constants.js";
import { relativeFlowSpecFile } from "../../lib/flow-workspace.js";

const MAX_REPORT_TASK_ROWS = 100;
const MAX_REPORT_FIELD_CHARS = 240;
const MAX_IMPORTANT_ISSUE_LOG_ENTRIES = 10;
const MAX_RECENT_OTHER_ISSUE_LOG_ENTRIES = 5;
const IMPORTANT_TERMS = [
  "fail",
  "failed",
  "error",
  "blocked",
  "recovery",
  "recover",
  "workaround",
  "force",
  "forced",
];
const FAILURE_ORIGIN_STEPS = ["gate", "review", "final-regression"];
const FAILURE_SIGNAL_TERMS = ["fail", "failed", "error", "blocked"];
const GIT_OBJECT_ID_RE = /^[0-9a-f]{40,64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

export class ReportBindingError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "ReportBindingError";
    this.code = code;
  }
}

function reportBindingInvalid(message) {
  return new ReportBindingError("REPORT_BINDING_INVALID", message);
}

function reportBindingStale(message) {
  return new ReportBindingError("REPORT_BINDING_STALE", message);
}

function normalizeSourceArtifact(root, source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw reportBindingInvalid("source artifact must be an object");
  }
  if (typeof source.path !== "string" || source.path.trim() === "") {
    throw reportBindingInvalid("source artifact path is required");
  }
  if (!SHA256_RE.test(source.sha256 || "")) {
    throw reportBindingInvalid("source artifact sha256 must be a SHA-256 digest");
  }
  const absolutePath = path.resolve(root, source.path);
  const relativePath = path.relative(root, absolutePath);
  if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw reportBindingInvalid("source artifact path must be project-relative");
  }
  return {
    path: relativePath.split(path.sep).join("/"),
    sha256: source.sha256,
  };
}

function currentGitTarget(root) {
  const head = runGit(["rev-parse", "HEAD"], { cwd: root });
  const tree = runGit(["rev-parse", "HEAD^{tree}"], { cwd: root });
  if (!head.ok || !tree.ok) {
    throw reportBindingInvalid("current Git target is unavailable");
  }
  return { headOid: head.stdout.trim(), treeSha: tree.stdout.trim() };
}

export class ReportBinding {
  constructor({ headOid, treeSha, sourceArtifacts } = {}) {
    if (!GIT_OBJECT_ID_RE.test(headOid || "") || !GIT_OBJECT_ID_RE.test(treeSha || "")) {
      throw reportBindingInvalid("headOid and treeSha must be Git object IDs");
    }
    if (!Array.isArray(sourceArtifacts)) {
      throw reportBindingInvalid("sourceArtifacts must be an array");
    }
    this.headOid = headOid;
    this.treeSha = treeSha;
    this.sourceArtifacts = sourceArtifacts.map((source) => ({ ...source }));
  }

  toJSON() {
    return {
      headOid: this.headOid,
      treeSha: this.treeSha,
      sourceArtifacts: this.sourceArtifacts.map((source) => ({ ...source })),
    };
  }

  static fromSourcePaths({ root, artifactRoot = root, sourcePaths }) {
    const target = currentGitTarget(root);
    const sourceArtifacts = sourcePaths.map((sourcePath) => {
      const absolutePath = path.resolve(artifactRoot, sourcePath);
      const bytes = fs.readFileSync(absolutePath);
      return {
        path: path.relative(artifactRoot, absolutePath).split(path.sep).join("/"),
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      };
    });
    return new ReportBinding({ ...target, sourceArtifacts });
  }

  static validate(binding, { root, artifactRoot = root, current = null }) {
    const parsed = new ReportBinding(binding);
    const normalizedSources = parsed.sourceArtifacts.map((source) => normalizeSourceArtifact(artifactRoot, source));
    const sourcePaths = new Set();
    for (const source of normalizedSources) {
      if (sourcePaths.has(source.path)) throw reportBindingInvalid("source artifact paths must be unique");
      sourcePaths.add(source.path);
    }
    const target = current || currentGitTarget(root);
    if (target.headOid !== parsed.headOid || target.treeSha !== parsed.treeSha) {
      throw reportBindingStale("Git target has changed");
    }
    for (const source of normalizedSources) {
      let bytes;
      try {
        bytes = fs.readFileSync(path.resolve(artifactRoot, source.path));
      } catch {
        throw reportBindingStale(`source artifact is unavailable: ${source.path}`);
      }
      const currentSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      if (currentSha256 !== source.sha256) {
        throw reportBindingStale(`source artifact has changed: ${source.path}`);
      }
    }
    return new ReportBinding({ ...parsed, sourceArtifacts: normalizedSources });
  }
}

function capReportField(value) {
  const text = String(value ?? "");
  if (text.length <= MAX_REPORT_FIELD_CHARS) return text;
  return `${text.slice(0, MAX_REPORT_FIELD_CHARS - 3)}...`;
}

function finalRegressionHumanSummary(result) {
  if (!result) return null;
  const parts = [
    `result=${result.result}`,
    result.failureCategory ? `failureCategory=${result.failureCategory}` : null,
    result.failureKind ? `failureKind=${result.failureKind}` : null,
    result.rawOutputPath ? `raw_output=${result.rawOutputPath}` : null,
    Number.isInteger(result.fixAttempts) ? `fixAttempts=${result.fixAttempts}` : null,
    result.selectedAction ? `selectedAction=${result.selectedAction}` : null,
    result.remainingRisk ? `remainingRisk=${result.remainingRisk}` : null,
  ].filter(Boolean);
  return parts.map(capReportField).join(" ");
}

function issueLogPathForSpec(specPath) {
  if (!specPath) return null;
  return path.join(path.dirname(specPath), "issue-log.json");
}

function lowerText(value) {
  return String(value ?? "").toLowerCase();
}

function textIncludesAny(value, terms) {
  const text = lowerText(value);
  return terms.some((term) => text.includes(term));
}

function entryHasFailureSignal(entry) {
  return [entry?.level, entry?.result, entry?.status, entry?.failureKind]
    .some((value) => textIncludesAny(value, FAILURE_SIGNAL_TERMS));
}

class IssueLogSummary {
  constructor({ entries, specPath }) {
    this.total = entries.length;
    this.fullLogPath = issueLogPathForSpec(specPath);
    this.important = entries
      .filter((entry) => this.isImportant(entry));
    const importantSet = new Set(this.important);
    this.recentOther = entries
      .filter((entry) => !importantSet.has(entry))
      .slice(-MAX_RECENT_OTHER_ISSUE_LOG_ENTRIES);
  }

  isImportant(entry) {
    const fields = [
      entry?.step,
      entry?.level,
      entry?.reason,
      entry?.trigger,
      entry?.resolution,
      entry?.guardrailCandidate,
      entry?.result,
      entry?.status,
      entry?.failureKind,
    ];
    if (fields.some((field) => textIncludesAny(field, IMPORTANT_TERMS))) return true;
    if (!textIncludesAny(entry?.step, FAILURE_ORIGIN_STEPS)) return false;
    return entryHasFailureSignal(entry);
  }

  importantShown() {
    return this.important.slice(0, MAX_IMPORTANT_ISSUE_LOG_ENTRIES);
  }

  importantOmitted() {
    return Math.max(0, this.important.length - this.importantShown().length);
  }

  toReportData() {
    const shownImportant = this.importantShown();
    const entries = [
      ...shownImportant.map((entry) => this.toSummaryEntry(entry, "important")),
      ...this.recentOther.map((entry) => this.toSummaryEntry(entry, "recent-other")),
    ];
    const recentOtherTotal = this.total - this.important.length;
    return {
      count: this.total,
      fullLogPath: this.fullLogPath,
      importantTotal: this.important.length,
      importantShown: shownImportant.length,
      importantOmitted: Math.max(0, this.important.length - shownImportant.length),
      recentOtherTotal,
      recentOtherShown: this.recentOther.length,
      recentOtherOmitted: Math.max(0, recentOtherTotal - this.recentOther.length),
      entries,
    };
  }

  toSummaryEntry(entry, classification) {
    if (!["important", "recent-other"].includes(classification)) {
      throw new Error(`invalid issue-log summary classification: ${classification}`);
    }
    return {
      classification,
      step: capReportField(entry.step),
      reason: capReportField(entry.reason),
      resolution: entry.resolution ? capReportField(entry.resolution) : null,
    };
  }
}

/**
 * Build the structured report data object.
 * @param {Object} input
 * @param {Object} input.state - flow.json state
 * @param {Object} input.results - finalize step results
 * @param {Object} input.issueLog - issue-log data { entries: [] }
 * @param {string} input.implDiffStat - git diff --stat output for implementation
 * @param {string[]} input.commitMessages - commit messages from feature branch
 * @returns {{ data: Object, text: string }}
 */
export function generateReport(input) {
  const { state, results, implDiffStat, commitMessages } = input;
  const issueLog = input.issueLog || input.redolog || { entries: [] };

  // Implementation
  const implementation = {
    diffStat: implDiffStat || null,
    commits: commitMessages || [],
  };

  // Retro
  const retroResult = results.retro;
  let retro = null;
  if (retroResult && retroResult.status === "done" && retroResult.summary) {
    retro = { ...retroResult.summary };
    if (retroResult.requirements) {
      retro.requirements = retroResult.requirements;
    }
  }

  // Issue log
  const entries = issueLog?.entries || [];
  const issueLogData = new IssueLogSummary({
    entries,
    specPath: state?.specId ? relativeFlowSpecFile(state) : null,
  }).toReportData();

  // Metrics (derive from the single source of truth: buildMetricsSummary)
  const summary = buildMetricsSummary(state.metrics || []);
  const { activity: metrics, tokens: tokenMetrics } = buildReportTotals(summary.total);

  // Sync
  let sync;
  const syncResult = results.sync;
  if (!syncResult || syncResult.status === "skipped") {
    sync = {
      status: "skipped",
      reason: syncResult?.message || "sync was skipped",
    };
  } else if (syncResult.status === "done") {
    sync = {
      status: "done",
      diffStat: syncResult.diffStat || null,
      diffSummary: syncResult.diffSummary || null,
    };
  } else {
    sync = {
      status: syncResult.status || "unknown",
      reason: syncResult.message || null,
    };
  }

  // Tests (spec 251): consume test-execute-result.json + test-result-review.json
  // via results.testExecute / results.testResultReview, populated by
  // run-report.js. Legacy state.test.summary is no longer the source of truth.
  let tests = null;
  const testExecute = results.testExecute;
  const testResultReview = results.testResultReview;
  const finalRegression = results.finalRegression;
  if (testExecute || testResultReview || finalRegression) {
    const summary = Array.isArray(testExecute?.summary) ? testExecute.summary : [];
    const passed = summary.filter((s) => s.result === "pass").length;
    const failed = summary.filter((s) => s.result === "fail").length;
    tests = {
      total: summary.length,
      passed,
      failed,
      verdict: testResultReview?.verdict || null,
      invalidReason: testResultReview?.invalidReason || null,
      rawOutputPath: testExecute?.rawOutputPath || null,
      projectRegression: testExecute?.projectRegression || null,
      finalRegression: finalRegression ? {
        ...finalRegression,
        humanSummary: finalRegression.humanSummary || finalRegressionHumanSummary(finalRegression),
      } : null,
    };
  }

  const taskRows = buildTaskReportRows(state, results);
  const boundedBroadMode = buildBoundedBroadModeHistory(state, BROAD_MODE_HISTORY_MAX_ENTRIES);
  const taskTotal = Array.isArray(state?.tasks) ? state.tasks.length : 0;
  const tasks = taskRows.slice(0, MAX_REPORT_TASK_ROWS);
  const broadModeHistory = boundedBroadMode.entries.map((entry) => ({
    step: capReportField(entry.step),
    reason: capReportField(entry.reason),
    ts: capReportField(entry.ts),
    currentTaskId: entry.currentTaskId == null ? null : capReportField(entry.currentTaskId),
  }));

  const data = {
    implementation,
    retro,
    upgrade: results.upgrade || null,
    issueLog: issueLogData,
    metrics,
    tokenMetrics,
    tests,
    sync,
    tasks,
    taskTotal,
    tasksTruncated: Math.max(0, taskTotal - tasks.length),
    broadModeHistory,
    broadModeHistoryTotal: boundedBroadMode.total,
    broadModeHistoryTruncated: boundedBroadMode.truncated,
  };
  const text = formatText(data);

  return { data, text };
}

function buildTaskReportRows(state, results) {
  if (!Array.isArray(state?.tasks) || state.tasks.length === 0) return [];
  return state.tasks.map((task) => ({
    id: capReportField(task.id),
    status: capReportField(task.status || "unknown"),
    implementationSummary: task.summary ? "available" : "missing",
    testExecute: taskArtifactResult(results.testExecute, task, "missing"),
    review: taskArtifactResult(results.review, task, taskStepResult(task, "task-review")),
    gateImpl: taskArtifactResult(results.gateImpl || results.gate, task, taskStepResult(task, "task-gate")),
  }));
}

function taskStepResult(task, stepId) {
  if (!Array.isArray(task?.steps)) return task.status === "done" ? "available" : "unavailable";
  const step = task.steps.find((s) => s.id === stepId);
  return step?.status ? capReportField(step.status) : "unavailable";
}

function taskArtifactResult(artifact, task, missingValue) {
  if (!artifact) return missingValue;
  const taskMatch = taskResultFromArtifact(artifact, task);
  if (taskMatch) return capReportField(taskMatch);
  const requirementMatch = requirementResultFromArtifact(artifact, task);
  if (requirementMatch) return capReportField(requirementMatch);
  return "available";
}

function taskResultFromArtifact(artifact, task) {
  const entries = [
    ...asArray(artifact.taskResults),
    ...asArray(artifact.tasks),
    ...asArray(artifact.summary),
    ...asArray(artifact.evaluations),
  ];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.taskId !== task.id && entry.id !== task.id) continue;
    return entry.result || entry.verdict || entry.status || "available";
  }
  const byTask = artifact.taskResultsById || artifact.tasksById || artifact.byTask;
  if (byTask && typeof byTask === "object" && byTask[task.id]) {
    const entry = byTask[task.id];
    if (typeof entry === "string") return entry;
    return entry.result || entry.verdict || entry.status || "available";
  }
  return null;
}

function requirementResultFromArtifact(artifact, task) {
  const requirementIds = new Set(taskRequirementIds(task));
  if (requirementIds.size === 0) return null;
  const entries = asArray(artifact.summary).filter((entry) =>
    requirementIds.has(entry?.id) || requirementIds.has(entry?.requirementId),
  );
  if (entries.length === 0) return null;
  const results = new Set(entries.map((entry) => entry.result || entry.verdict || entry.status || "available"));
  if (results.size === 1) return results.values().next().value;
  return [...results].sort().join(",");
}

function taskRequirementIds(task) {
  const values = [
    ...asArray(task.requirements),
    ...asArray(task.requirementIds),
    ...asArray(task.requirement_ids),
  ];
  return values.map((value) => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") return value.id || value.requirementId || value.requirement_id;
    return null;
  }).filter(Boolean);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function summaryGroupTitle(label, shown, total) {
  return shown === total ? `${label} (${shown})` : `${label} (${shown} of ${total})`;
}

function omittedLine(count, label) {
  const noun = count === 1 ? "entry" : "entries";
  return `    ... ${count} ${label} issue-log ${noun} omitted`;
}

function pushIssueLogGroup(lines, { title, entries, total, omitted, omittedLabel }) {
  if (entries.length === 0) return;
  lines.push("");
  lines.push(`    ${summaryGroupTitle(title, entries.length, total)}`);
  for (const entry of entries) {
    lines.push(`    - [${entry.step}] ${entry.reason}`);
  }
  if (omitted > 0) {
    lines.push(omittedLine(omitted, omittedLabel));
  }
}

/**
 * Push a section header (blank line + title + divider) onto lines.
 * @param {string[]} lines
 * @param {string} title
 * @param {string} thin - divider string
 */
/**
 * Format report data as human-readable plain text.
 * @param {Object} data - structured report data
 * @returns {string}
 */
function formatText(data) {
  const lines = [];
  const thin = DIVIDER;

  lines.push("  Report");

  // Implementation
  pushSection(lines, "Implementation", thin);
  if (data.implementation.commits.length > 0) {
    for (const msg of data.implementation.commits) {
      lines.push(`    ${msg}`);
    }
  }
  if (data.implementation.diffStat) {
    const last = data.implementation.diffStat.split("\n").pop()?.trim();
    if (last) lines.push(`    ${last}`);
  }
  if (!data.implementation.commits.length && !data.implementation.diffStat) {
    lines.push("    -");
  }

  // Retro
  pushSection(lines, "Retro", thin);
  if (data.retro) {
    const r = data.retro;
    const pct = (r.rate * 100).toFixed(0);
    const bar8 = Math.round(r.rate * 8);
    const filled = "\u2588".repeat(bar8);
    const empty = "\u2591".repeat(8 - bar8);
    lines.push(`    ${filled}${empty} ${pct}%  (${r.done} done / ${r.partial} partial / ${r.not_done} miss)`);
    if (r.rate < 1.0 && r.requirements) {
      for (const req of r.requirements) {
        if (req.status === "partial" || req.status === "not_done") {
          lines.push(`    [${req.status}] ${req.desc}`);
          if (req.note) lines.push(`               ${req.note}`);
        }
      }
    }
  } else {
    lines.push("    -");
  }

  const formatInt = (value) => Number(value || 0).toLocaleString("en-US");
  const metricLine = (label, value) => {
    const dots = ".".repeat(Math.max(1, 28 - label.length));
    return `    ${label} ${dots} ${value}`;
  };

  // Metrics
  pushSection(lines, "Metrics", thin);
  const m = data.metrics;
  lines.push(metricLine("docs read", formatInt(m.docsRead)));
  lines.push(metricLine("src read", formatInt(m.srcRead)));
  lines.push(metricLine("Q&A", formatInt(m.question)));
  lines.push(metricLine("issue-log", formatInt(m.issueLog)));

  // Agent metrics (token/cost) — R3-1, R3-2
  if (data.tokenMetrics && data.tokenMetrics.callCount > 0) {
    const t = data.tokenMetrics;
    const costStr = t.cost != null && t.cost !== 0 ? `$${t.cost.toFixed(4)}` : "N/A+";
    lines.push(metricLine("agent calls", formatInt(t.callCount)));
    lines.push(metricLine("input tokens", formatInt(t.input)));
    lines.push(metricLine("output tokens", formatInt(t.output)));
    lines.push(metricLine("cache-read tokens", formatInt(t.cacheRead)));
    lines.push(metricLine("cache-create tokens", formatInt(t.cacheCreation)));
    lines.push(metricLine("cost", costStr));
    if (t.durationMs > 0) {
      lines.push(metricLine("duration (total)", formatDurationSeconds(t.durationMs)));
      for (const { phase, durationMs } of t.phaseDurations) {
        lines.push(metricLine(`  ${phase}`, formatDurationSeconds(durationMs)));
      }
    }
  }

  // Tests (always shown) — spec 251: per-requirement test-execute summary +
  // test-result-review verdict. Categorical unit/integration/acceptance counts
  // are no longer surfaced (the runner is language-agnostic).
  pushSection(lines, "Tests", thin);
  if (data.tests) {
    const t = data.tests;
    const verdict = t.verdict ? ` verdict=${t.verdict}` : "";
    lines.push(`    total ${t.total}  passed ${t.passed}  failed ${t.failed}${verdict}`);
    if (t.invalidReason) {
      lines.push(`    invalid_reason: ${t.invalidReason}`);
    }
    if (t.rawOutputPath) {
      lines.push(`    raw_output: ${t.rawOutputPath}`);
    }
    if (t.projectRegression) {
      const r = t.projectRegression;
      lines.push(`    Project regression: required=${r.required} result=${r.result || "skipped"} mode=${r.mode || "none"}${r.category ? ` category=${r.category}` : ""}`);
    }
    if (t.finalRegression) {
      const r = t.finalRegression;
      lines.push([
        `    Final regression: result=${r.result}`,
        r.skipKind ? `skipKind=${r.skipKind}` : null,
        r.failureKind ? `failureKind=${r.failureKind}` : null,
        r.failureCategory ? `failureCategory=${r.failureCategory}` : null,
        r.rawOutputPath ? `raw_output=${r.rawOutputPath}` : null,
        Number.isInteger(r.fixAttempts) ? `fixAttempts=${r.fixAttempts}` : null,
        r.selectedAction ? `selectedAction=${r.selectedAction}` : null,
        r.remainingRisk ? `remainingRisk=${r.remainingRisk}` : null,
      ].filter(Boolean).join(" "));
    }
  } else {
    lines.push("    No test data");
  }

  if (data.tasks.length > 0) {
    pushSection(lines, `Tasks (${data.tasks.length}/${data.taskTotal})`, thin);
    for (const task of data.tasks) {
      lines.push(
        `    ${task.id} status=${task.status} impl=${task.implementationSummary} test=${task.testExecute} review=${task.review} gate=${task.gateImpl}`,
      );
    }
    if (data.tasksTruncated > 0) {
      lines.push(`    ... ${data.tasksTruncated} more task(s) omitted`);
    }
  }

  if (data.broadModeHistory.length > 0) {
    pushSection(lines, `Broad Mode (${data.broadModeHistory.length}/${data.broadModeHistoryTotal})`, thin);
    for (const entry of data.broadModeHistory) {
      lines.push(`    ${entry.ts} ${entry.step} currentTaskId=${entry.currentTaskId ?? "null"} reason=${entry.reason}`);
    }
    if (data.broadModeHistoryTruncated > 0) {
      lines.push(`    ... ${data.broadModeHistoryTruncated} older record(s) omitted`);
    }
  }

  // Issue log summary (only if entries exist)
  if (data.issueLog.count > 0) {
    pushSection(lines, `Issue Log Summary (${data.issueLog.count} total)`, thin);
    if (data.issueLog.fullLogPath) {
      lines.push(`    Full issue log: ${data.issueLog.fullLogPath}`);
    }
    const important = data.issueLog.entries.filter((entry) => entry.classification === "important");
    pushIssueLogGroup(lines, {
      title: "Important",
      entries: important,
      total: data.issueLog.importantTotal,
      omitted: data.issueLog.importantOmitted,
      omittedLabel: "important",
    });
    const recentOther = data.issueLog.entries.filter((entry) => entry.classification === "recent-other");
    pushIssueLogGroup(lines, {
      title: "Recent Other",
      entries: recentOther,
      total: data.issueLog.recentOtherTotal,
      omitted: data.issueLog.recentOtherOmitted,
      omittedLabel: "other",
    });
  }

  return lines.join("\n");
}
