/**
 * src/flow/lib/run-retro.js
 *
 * FlowCommand: retro — aggregate per-requirement pass/fail from cataloged
 * test.execute and test.result.review Attempt histories, then attach the retro
 * publication to the active Attempt. Performs no test execution.
 */

import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { validateTestExecuteResultV2, validateTestResultReview } from "./test-artifacts.js";
import { buildRepairFingerprint } from "./repair-fingerprint.js";
import {
  CanonicalTestArtifactStore,
  isCanonicalFlowState,
} from "./canonical-test-artifacts.js";
import { attachCanonicalCommandResultPublications } from "./canonical-command-result.js";
import { resolveRetroStaleEvidenceRecovery } from "../definition.js";
import { readCurrentRetroStaleEvidenceRecoveryFacts } from "./retro-stale-evidence-transition-facts.js";

function aggregate(requirements, summary) {
  const summaryById = new Map();
  for (const entry of summary || []) {
    if (entry?.id) summaryById.set(entry.id, entry);
  }

  const testableReqs = requirements.filter((r) => r.testable !== false);
  const naCount = requirements.length - testableReqs.length;

  const reqs = testableReqs.map((r) => {
    const entry = summaryById.get(r.id);
    if (!entry) {
      return { desc: r.desc, status: "not_done", note: "missing from test-execute-result.json summary[]" };
    }
    if (entry.result === "pass") {
      return { desc: r.desc, status: "done", note: entry.evidence?.test_name || "" };
    }
    if (entry.result === "not_applicable") {
      return { desc: r.desc, status: "not_applicable", note: entry.reason || "no_tests_declared" };
    }
    if (entry.result === "deferred") {
      return {
        desc: r.desc,
        status: "deferred",
        note: `Requirement test work deferred by ${entry.deferred_receipt.sourceArtifact}`,
      };
    }
    return { desc: r.desc, status: "not_done", note: entry.error || entry.evidence?.test_name || "" };
  });

  const total = reqs.length;
  const done = reqs.filter((x) => x.status === "done").length;
  const notApplicable = reqs.filter((x) => x.status === "not_applicable").length;
  const deferred = reqs.filter((x) => x.status === "deferred").length;
  const notDone = total - done - notApplicable - deferred;
  const rate = total > 0 ? done / total : 0;

  return {
    requirements: reqs,
    unplanned: [],
    summary: {
      total,
      done,
      partial: 0,
      not_done: notDone,
      not_applicable_count: notApplicable,
      deferred_count: deferred,
      na_count: naCount,
      not_testable_count: naCount,
      rate: Math.round(rate * 100) / 100,
      notes: "aggregated from test-execute-result.json",
    },
  };
}

function executeCanonicalRetro(ctx) {
  const store = new CanonicalTestArtifactStore({ flowManager: ctx.flowManager, state: ctx.flowState });
  const reviewArtifact = store.readCurrentAttempt({
    logicalKey: "test.result.review",
    consumerNodeId: "retro",
    optional: true,
  });
  if (reviewArtifact === null) {
    return Envelope.fail(
      "run",
      "retro",
      "TEST_RESULT_REVIEW_MISSING",
      "test-result-review canonical artifact is absent: test-result-review step has not been run",
    );
  }
  const resultArtifact = store.readCurrentAttempt({
    logicalKey: "test.execute",
    consumerNodeId: "retro",
    optional: true,
  });
  if (resultArtifact === null) {
    return Envelope.fail(
      "run",
      "retro",
      "TEST_EXECUTE_RESULT_MISSING",
      "test-execute canonical artifact is absent: test-execute step has not been run",
    );
  }
  const review = reviewArtifact.payload;
  const result = resultArtifact.payload;
  try {
    validateTestResultReview(review);
    validateTestExecuteResultV2(result);
  } catch (error) {
    return Envelope.fail("run", "retro", "TEST_ARTIFACT_INVALID", error.message);
  }
  const currentFingerprint = buildRepairFingerprint({
    root: ctx.executionRoot || ctx.root,
    artifactRoot: ctx.root,
    specPath: store.location.relativeSpecFile,
  });
  const staleFacts = readCurrentRetroStaleEvidenceRecoveryFacts({
    flowManager: ctx.flowManager,
    specId: ctx.flowState.specId,
    currentFingerprint: currentFingerprint.hash,
  });
  if (staleFacts !== null) {
    const decision = resolveRetroStaleEvidenceRecovery(staleFacts);
    ctx.flowManager.applyRetroStaleEvidenceRecoveryDecision({
      specId: ctx.flowState.specId,
      decision,
    });
    return {
      result: "recovered",
      changed: [],
      artifacts: {
        staleArtifacts: [...staleFacts.artifactNames],
        evidenceRefresh: {
          recovered: true,
          previousFingerprint: staleFacts.previousFingerprint,
          currentFingerprint: staleFacts.currentFingerprint,
          invalidatedArtifacts: [],
          invalidations: [],
          activeStep: "test-execute",
        },
      },
    };
  }
  if (review.verdict !== "pass") {
    return Envelope.fail(
      "run",
      "retro",
      "TEST_RESULT_REVIEW_NOT_PASSED",
      "test-result-review canonical verdict is not pass; cannot aggregate untrusted results.",
    );
  }
  const spec = store.readSpec("retro");
  const requirements = Array.isArray(spec.requirements) ? spec.requirements : [];
  if (requirements.length === 0) {
    return Envelope.fail("run", "retro", "NO_REQUIREMENTS", "no requirements found in canonical spec.json");
  }
  const retro = {
    spec: store.location.relativeSpecFile,
    date: new Date().toISOString(),
    mode: "attempt-history",
    ...aggregate(requirements, result.summary),
  };
  const retroPath = store.location.relativeArtifact("retro");
  if (ctx.dryRun === true) {
    return {
      result: "dry-run",
      artifacts: { spec: store.location.relativeSpecFile, retroPath, summary: retro.summary, requirements: retro.requirements },
    };
  }
  return attachCanonicalCommandResultPublications({
    result: "ok",
    changed: [retroPath],
    artifacts: {
      spec: store.location.relativeSpecFile,
      retroPath,
      summary: retro.summary,
      requirements: retro.requirements,
      mode: "attempt-history",
    },
  }, [{ logicalKey: "retro", payload: retro }]);
}

export class RunRetroCommand extends FlowCommand {
  async execute(ctx) {
    const state = ctx.flowState;
    if (isCanonicalFlowState(state)) return executeCanonicalRetro(ctx);
    throw new Error("retro requires a Version-1 Flow");
  }
}

export default RunRetroCommand;
