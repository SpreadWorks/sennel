/**
 * src/flow/lib/run-report.js
 *
 * FlowCommand: report — generate a work report from the current flow state.
 *
 * spec 251: report consumes the persisted artifacts produced by impl-phase
 * mainline steps:
 *   - retro (aggregated requirement pass/fail from retro)
 *   - test.execute (per-requirement evidence from test-execute)
 *   - test.result.review (artifact integrity verdict)
 * It does NOT read state.test.summary; the legacy aggregator path was removed.
 */

import path from "path";
import {
  collectGitSummary,
  commentOnIssueOnce,
  isGhAvailable,
} from "../../lib/git-helpers.js";
import { generateReport, ReportBinding } from "../commands/report.js";
import { FlowCommand } from "./base-command.js";
import {
  validateFinalRegressionResult,
  validateUpgradeResultArtifact,
} from "./test-artifacts.js";
import { advisorySummary } from "./nonblocking.js";
import { CanonicalReportArtifactStore } from "./canonical-report-artifacts.js";
import { CanonicalFileMap } from "./canonical-file-map.js";
import {
  CanonicalCommandResultPublication,
  attachCanonicalCommandResultPublications,
} from "./canonical-command-result.js";
import { isCanonicalFlowState } from "./canonical-test-artifacts.js";

function withAdvisorySummary(report, state) {
  const advisory = advisorySummary(state);
  if (advisory.length === 0) return report;
  const lines = advisory.map((entry) => `- ${entry.stepId}: ${entry.evidenceRef}; risk: ${entry.remainingRisk}; rationale: ${entry.rationale}`);
  return {
    ...report,
    text: `${report.text}\n\n## Advisory continuations\n${lines.join("\n")}`,
    data: { ...report.data, assurance: "advisory", advisorySummary: advisory },
  };
}

function withDelivery(report, delivery) {
  return {
    ...report,
    data: {
      ...report.data,
      delivery,
    },
  };
}

function deliveryState(status, reason = null, idempotencyKey = null) {
  return {
    status,
    ...(reason == null ? {} : { reason }),
    ...(idempotencyKey == null ? {} : { idempotencyKey }),
  };
}

function hasPendingDelivery(report, idempotencyKey) {
  const delivery = report?.data?.delivery;
  return (delivery?.status === "pending" || delivery?.status === "unsent")
    && (delivery.idempotencyKey == null || delivery.idempotencyKey === idempotencyKey);
}

function hasCompletedDelivery(report, idempotencyKey) {
  const delivery = report?.data?.delivery;
  return delivery?.status === "done"
    && (delivery.idempotencyKey == null || delivery.idempotencyKey === idempotencyKey);
}

function canonicalReportResults(store) {
  const results = {};
  const retro = store.readDocument({ logicalKey: "retro", optional: true });
  if (retro !== null) results.retro = retro.value;

  const testExecute = store.readCurrentAttempt({ logicalKey: "test.execute", optional: true });
  const testResultReview = store.readCurrentAttempt({ logicalKey: "test.result.review", optional: true });
  if (testExecute !== null) {
    const artifact = testExecute.value;
    results.testExecute = {
      status: "done",
      version: artifact.version,
      rawOutputPath: artifact.raw_output_path,
      summary: artifact.summary,
      projectRegression: artifact.regression,
    };
  }
  if (testResultReview !== null) {
    const artifact = testResultReview.value;
    results.testResultReview = {
      status: "done",
      verdict: artifact.verdict,
      checkedItems: artifact.checked_items,
      invalidReason: artifact.invalid_reason,
    };
  }

  const finalRegression = store.readCurrentAttempt({ logicalKey: "final.regression", optional: true });
  if (finalRegression !== null) {
    const artifact = validateFinalRegressionResult(finalRegression.value);
    results.finalRegression = {
      status: "done",
      result: artifact.result,
      failureKind: artifact.failureKind,
      failureCategory: artifact.failureCategory || null,
      failureNature: artifact.failureNature || null,
      skipKind: artifact.skipKind || null,
      rawOutputPath: artifact.rawOutputPath,
      command: artifact.command,
      process: artifact.process,
      exitCode: artifact.process?.exitCode ?? null,
      failureSummary: artifact.failureSummary || null,
      currentDiffRelationship: artifact.currentDiffRelationship || null,
      changedFiles: artifact.changedFiles || [],
      changedFileFingerprints: artifact.changedFileFingerprints || [],
      fixAttempts: artifact.fixAttempts ?? null,
      selectedAction: artifact.selectedAction || null,
      remainingRisk: artifact.remainingRisk || null,
      recordAndProceed: artifact.recordAndProceed || null,
      humanSummary: artifact.humanSummary || null,
    };
  }

  const upgrade = store.readDocument({ logicalKey: "upgrade.result", optional: true });
  if (upgrade !== null) {
    const validation = validateUpgradeResultArtifact(upgrade.value);
    if (!validation.ok) throw new Error(`upgrade artifact invalid: ${validation.reason}`);
    const artifact = upgrade.value;
    results.upgrade = {
      result: artifact.result,
      summary: artifact.summary,
      failureReason: artifact.failureReason,
    };
  }
  return Object.freeze(results);
}

function canonicalReportSourcePaths(documents, versionRelativeDirectory) {
  if (typeof versionRelativeDirectory !== "string" || versionRelativeDirectory === "") {
    throw new Error("canonical report Version directory is required");
  }
  return documents
    .filter((document) => document !== null)
    .map((document) => path.posix.join(versionRelativeDirectory, document.relativePath));
}

function canonicalReportPublication(report) {
  return new CanonicalCommandResultPublication({
    logicalKey: "report",
    payload: report,
  });
}

/**
 * Publish the pending external-effect view before touching GitHub.  This is
 * intentionally a separate Activity from final confirmation: a crash after
 * the side effect leaves one cataloged, idempotency-bound report for the
 * exact outbox recovery to inspect and resume.
 */
function publishCanonicalReport(ctx, report) {
  ctx.flowManager.publishCurrentAttemptResult({
    specId: ctx.flowState.specId,
    commandResult: attachCanonicalCommandResultPublications({ result: "pending" }, [
      canonicalReportPublication(report),
    ]),
  });
}

function canonicalDeliverySuccess({ report, issueComment, changed }) {
  return attachCanonicalCommandResultPublications({
    result: "ok",
    changed,
    issueComment,
    artifacts: { report, issueComment },
  }, [canonicalReportPublication(report)]);
}

function requireCanonicalReportOutboxKey(ctx) {
  const key = ctx.flowOutboxEntry?.idempotencyKey;
  if (typeof key !== "string" || key === "") {
    throw new Error("canonical linked-Issue report delivery requires the report outbox identity");
  }
  return key;
}

function resumeCanonicalReportDelivery(ctx, report, reportPath) {
  const { root, flowState: state } = ctx;
  const executionRoot = ctx.executionRoot || root;
  const idempotencyKey = requireCanonicalReportOutboxKey(ctx);
  if (!state.issue) throw new Error("canonical report delivery retry requires a linked issue");
  if (hasCompletedDelivery(report, idempotencyKey)) {
    return canonicalDeliverySuccess({
      report,
      issueComment: completedIssueComment(state, ctx.flowOutboxEntry, true),
      changed: [],
    });
  }
  if (!hasPendingDelivery(report, idempotencyKey)) {
    throw new Error("canonical report delivery retry requires a pending or unsent report");
  }
  RunReportCommand.validateFinalEvidence(report, {
    root: executionRoot,
    artifactRoot: root,
  });
  const delivery = postReportToIssue({ root, state, report, flowOutboxEntry: ctx.flowOutboxEntry });
  if (!delivery.ok) {
    const pending = withDelivery(report, deliveryState("pending", delivery.reason, idempotencyKey));
    publishCanonicalReport(ctx, pending);
    throw new Error(`failed to post report to issue #${state.issue}: ${delivery.reason}`);
  }
  const delivered = withDelivery(report, deliveryState("done", null, idempotencyKey));
  return canonicalDeliverySuccess({
    report: delivered,
    issueComment: completedIssueComment(state, ctx.flowOutboxEntry, delivery.posted.resumed),
    changed: [reportPath],
  });
}

/**
 * Build the regular report output solely from catalog-resolved V1 inputs.
 * The returned publication is intentionally attached, not written here: the
 * registry confirms the active report Attempt and publishes its report.json
 * in the same Version Store transaction.
 */
function executeCanonicalReport(ctx) {
  const { root, flowState: state } = ctx;
  const executionRoot = ctx.executionRoot || root;
  const store = new CanonicalReportArtifactStore({ flowManager: ctx.flowManager, state });
  const location = ctx.flowManager.specLocation(state.specId);
  const reportPath = location.relativeArtifact("report");
  const persisted = state.issue === null
    ? null
    : store.readDocument({ logicalKey: "report", optional: true });
  if (persisted !== null && hasPendingDelivery(persisted.value, ctx.flowOutboxEntry?.idempotencyKey)) {
    return resumeCanonicalReportDelivery(ctx, persisted.value, reportPath);
  }
  const spec = store.readDocument({ logicalKey: "spec.record" });
  const fileMap = store.readDocument({ logicalKey: "file.map", optional: true });
  if (fileMap !== null) new CanonicalFileMap(fileMap.value).assertAgainstSpec(spec.value);
  const issueLog = store.readDocument({ logicalKey: "issue.log", optional: true });
  const retro = store.readDocument({ logicalKey: "retro", optional: true });
  const testExecute = store.readDocument({ logicalKey: "test.execute", optional: true });
  const testResultReview = store.readDocument({ logicalKey: "test.result.review", optional: true });
  const finalRegression = store.readDocument({ logicalKey: "final.regression", optional: true });
  const upgrade = store.readDocument({ logicalKey: "upgrade.result", optional: true });
  const baseBranch = state.baseBranch;
  if (!baseBranch) throw new Error("baseBranch not set in canonical flow.json");

  const { diffStat: implDiffStat, commitMessages } = collectGitSummary(executionRoot, baseBranch);
  const report = withAdvisorySummary(generateReport({
    state,
    results: canonicalReportResults(store),
    redolog: issueLog?.value ?? { entries: [] },
    implDiffStat,
    commitMessages,
  }), state);
  const binding = ReportBinding.fromSourcePaths({
    root: executionRoot,
    artifactRoot: root,
    sourcePaths: canonicalReportSourcePaths([
      spec,
      fileMap,
      issueLog,
      retro,
      testExecute,
      testResultReview,
      finalRegression,
      upgrade,
    ], location.relativeDirectory),
  });
  const boundReport = {
    ...report,
    data: {
      ...report.data,
      binding: binding.toJSON(),
    },
  };
  RunReportCommand.validateFinalEvidence(boundReport, { root: executionRoot, artifactRoot: root });
  if (ctx.dryRun === true) {
    return {
      result: "dry-run",
      artifacts: { report: boundReport },
    };
  }
  if (state.issue !== null) {
    const idempotencyKey = requireCanonicalReportOutboxKey(ctx);
    const pendingReport = withDelivery(boundReport, deliveryState("pending", null, idempotencyKey));
    publishCanonicalReport(ctx, pendingReport);
    const delivery = postReportToIssue({ root, state, report: pendingReport, flowOutboxEntry: ctx.flowOutboxEntry });
    if (!delivery.ok) {
      const pending = withDelivery(pendingReport, deliveryState("pending", delivery.reason, idempotencyKey));
      publishCanonicalReport(ctx, pending);
      throw new Error(`failed to post report to issue #${state.issue}: ${delivery.reason}`);
    }
    const delivered = withDelivery(boundReport, deliveryState("done", null, idempotencyKey));
    return canonicalDeliverySuccess({
      report: delivered,
      issueComment: completedIssueComment(state, ctx.flowOutboxEntry, delivery.posted.resumed),
      changed: [reportPath],
    });
  }
  const persistedReport = withDelivery(boundReport, deliveryState("not_required"));
  return canonicalDeliverySuccess({
    report: persistedReport,
    issueComment: { status: "skipped", reason: "no linked issue" },
    changed: [reportPath],
  });
}

function postReportToIssue({ root, state, report, flowOutboxEntry }) {
  if (!isGhAvailable()) {
    return { ok: false, reason: "gh unavailable" };
  }
  const posted = commentOnIssueOnce(
    state.issue,
    report.text,
    root,
    flowOutboxEntry?.idempotencyKey,
  );
  if (!posted.ok) return { ok: false, reason: posted.error };
  return { ok: true, posted };
}

function completedIssueComment(state, flowOutboxEntry, resumed) {
  return {
    status: "done",
    issue: state.issue,
    resumed,
    idempotencyKey: flowOutboxEntry?.idempotencyKey,
  };
}

export class RunReportCommand extends FlowCommand {
  static validateBinding(binding, context) {
    return ReportBinding.validate(binding, context);
  }

  static validateFinalEvidence(report, context) {
    return this.validateBinding(report?.data?.binding, context);
  }

  async execute(ctx) {
    const state = ctx.flowState;
    if (!isCanonicalFlowState(state)) {
      throw new Error("report requires a Version-1 Flow");
    }
    return executeCanonicalReport(ctx);
  }
}

export default RunReportCommand;
