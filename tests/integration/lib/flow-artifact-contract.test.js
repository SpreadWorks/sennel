import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  FLOW_ARTIFACT_CONTRACTS,
  FLOW_ARTIFACT_LEGACY_SWITCH_TARGETS,
  FLOW_ARTIFACT_NORMAL_FLOW_FILES,
  FLOW_ARTIFACT_SWITCH_TARGETS,
  FlowArtifactAuthoritySlot,
  FlowArtifactAttempt,
  FlowArtifactAttemptSequence,
  FlowArtifactAttemptHistory,
  FlowArtifactAttemptRecord,
  FlowArtifactActivityEvidence,
  FLOW_ARTIFACT_NO_ARTIFACT_STEPS,
  FlowArtifactCanonicalPath,
  FlowArtifactContract,
  FlowArtifactOwnership,
  FlowArtifactPlacement,
  FlowArtifactLegacyPattern,
  FlowArtifactKnownFile,
  FlowArtifactRegistry,
  FlowArtifactStepOwner,
  FlowArtifactSwitchTarget,
  FlowArtifactUpdater,
} from "../../../src/lib/flow-artifact-contract.js";
import {
  FLOW_ARTIFACT_AUTHORITY_MATRIX,
  WORKER_ARTIFACT_HANDOFF_STEPS,
} from "../../../src/flow/lib/flow-artifact-authority.js";
import { collectFlowLeafIds, collectTaskLeafIds } from "../../../src/flow/definition.js";
import { workerArtifactHandoffPolicy } from "../../../src/flow/lib/worker-artifact-handoff.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function contract(key, artifactPath, kind, stepOwner = null) {
  const root = ["flow.state", "flow.activities", "spec.record", "issue.log", "artifact.catalog", "issue.snapshot"].includes(key);
  return new FlowArtifactContract({
    logicalKey: key,
    canonicalPath: artifactPath,
    placement: root ? "root-authority" : "step-owner",
    stepOwner: root ? null : stepOwner,
    retention: "permanent",
    cataloged: key !== "artifact.catalog",
    ownership: new FlowArtifactOwnership({ producers: ["system"], updaters: ["system"], consumers: ["system"] }),
    authoritySlot: new FlowArtifactAuthoritySlot({ kind, authority: "repository-metadata" }),
  });
}

describe("Flow artifact contract registry", () => {
  it("declares the complete root, task, shared, evidence, recovery, and runtime inventory", () => {
    const paths = new Map(FLOW_ARTIFACT_CONTRACTS.inventory().map((entry) => [entry.logicalKey.toString(), entry.canonicalPath.toString()]));
    assert.deepEqual([...paths.entries()].filter(([, value]) => !value.includes("/")), [
      ["flow.state", "flow.json"], ["flow.activities", "activities.jsonl"], ["spec.record", "spec.json"],
      ["issue.log", "issue-log.json"], ["artifact.catalog", "artifact-catalog.json"], ["issue.snapshot", "issue.md"],
    ]);
    assert.equal(paths.get("draft"), "steps/draft/result.json");
    assert.equal(paths.get("retro"), "steps/impl/retro/result.json");
    assert.equal(paths.get("report"), "artifacts/report.json");
    assert.equal(paths.get("ideas"), "artifacts/ideas.json");
    assert.equal(paths.get("plugin.lifecycle.artifact"), "artifacts/plugin-artifacts/:{pluginArtifactPath}");
    assert.equal(paths.get("task.gate"), "steps/impl/:{taskId}/gate/result.json");
    assert.equal(paths.get("task.gate.source"), "steps/impl/:{taskId}/gate/source.json");
    assert.equal(paths.has("task.impl"), false);
    assert.equal(paths.get("task.review"), "steps/impl/:{taskId}/review/result.json");
    assert.equal(paths.get("task.review.unsealed.checkpoint"), "steps/impl/:{taskId}/review/recovery/unsealed/:{attemptId}.json");
    assert.equal(paths.get("task.review.recovery.authorization"), "steps/impl/:{taskId}/review/recovery/authorizations/:{attemptId}.json");
    assert.equal(paths.get("task.review.reconciliation"), "steps/impl/:{taskId}/review/recovery/reconciliations/:{attemptId}.json");
    assert.equal(paths.get("task.mutation.lineage"), "steps/impl/:{taskId}/impl/mutation-lineage/:{attemptId}.json");
    assert.equal(paths.get("activity.evidence"), "steps/:{ownerPath}/activity-evidence/:{digest}.json");
    assert.deepEqual(
      FLOW_ARTIFACT_SWITCH_TARGETS.filter((entry) => entry.action === "new").map((entry) => entry.logicalKey),
      [
        "flow.activities", "spec.snapshot", "spec.review", "artifact.catalog", "test.review.repair.progress", "test.bootstrap.observation", "acceptance.decision",
        "retry.recovery.baseline", "retry.recovery.receipt",
        "task.review.unsealed.checkpoint", "task.review.recovery.authorization", "task.review.reconciliation",
        "task.triage", "task.repair", "task.triage.source.handoff.baseline", "task.repair.source.handoff.baseline",
        "task.review", "task.mutation.lineage", "activity.evidence", "runtime.step-metadata",
      ],
    );
    assert.equal(paths.get("draft.gate.source"), "steps/draft-gate/source.json");
    assert.equal(paths.get("spec.gate.source"), "steps/spec-gate/source.json");
    assert.equal(paths.has("test.coverage"), false);
    assert.equal(paths.get("test.review"), "steps/test-review/result.json");
    assert.equal(paths.get("test.review.repair.progress"), "steps/test/repair-progress.json");
    assert.equal(paths.get("test.bootstrap.observation"), "steps/test/bootstrap-observation.json");
    assert.deepEqual(
      FLOW_ARTIFACT_CONTRACTS.require("test.bootstrap.observation").ownership.consumers,
      ["test", "scenario-validity", "test-review"],
    );
    assert.equal(paths.get("placeholder.permission"), "steps/test/permission.json");
    assert.equal(paths.get("acceptance.review.evidence"), "steps/acceptance-review/dispositions.json");
    assert.equal(paths.get("repair.fingerprint"), "steps/impl/repair/fingerprint.json");
    assert.equal(paths.get("repair.delta"), "steps/impl/repair/deltas/:{deltaId}.json");
    assert.equal(paths.get("retry.recovery.transaction"), ".runtime/retry-recovery/transaction.json");
    assert.equal(paths.get("retry.recovery.baseline"), "artifacts/retry-recovery/baselines/:{routeId}/:{attemptId}.json");
    assert.equal(paths.get("retry.recovery.receipt"), "artifacts/retry-recovery/receipts/:{routeId}/:{attemptId}.json");
    assert.equal(paths.get("test.requirement.summary"), ".runtime/test-execute/requirement-summary.json");
    assert.equal(paths.has("worker.handoff"), false);
    assert.equal(paths.get("flow.findings"), "steps/flow-findings.json");
    assert.equal(paths.get("nonblocking.handoffs"), "steps/nonblocking-handoffs.json");
    assert.equal(paths.get("scenario.validity.raw-log"), "steps/scenario-validity/output.log");
    assert.equal(paths.get("test.execute.raw-log"), "steps/test-execute/output.log");
    assert.equal(paths.get("final.regression.raw-log"), "steps/final-regression/attempt-:{attempt}.log");
    assert.equal(paths.get("finalize.cleanup.agent-metrics"), "steps/finalize-cleanup/agent-metrics.json");
    assert.equal(paths.get("finalize.cleanup.runtime-log"), ".runtime/finalize-cleanup/runtime-log.json");
    assert.equal(paths.get("runtime.lock.artifact-catalog"), ".runtime/locks/artifact-catalog.lock");
    assert.deepEqual(FLOW_ARTIFACT_LEGACY_SWITCH_TARGETS.map(String), ["flow-version.json", "artifacts", "review-evidence"]);
    for (const target of FLOW_ARTIFACT_LEGACY_SWITCH_TARGETS) assert.equal(FLOW_ARTIFACT_CONTRACTS.isLegacyTarget(target.toString()), true);
  });

  it("keeps Version-scoped transient step raw logs out of the repository index", () => {
    const gitignore = fs.readFileSync(new URL("../../../.gitignore", import.meta.url), "utf8");
    const patterns = new Set(gitignore.split("\n"));
    for (const pattern of [
      "**/[0-9][0-9][0-9]/steps/scenario-validity/output.log",
      "**/[0-9][0-9][0-9]/steps/test-execute/output.log",
      "**/[0-9][0-9][0-9]/steps/final-regression/attempt-*.log",
    ]) assert.equal(patterns.has(pattern), true, pattern);
    for (const broadPattern of [
      "**/steps/scenario-validity/output.log",
      "**/steps/test-execute/output.log",
      "**/steps/final-regression/attempt-*.log",
    ]) assert.equal(patterns.has(broadPattern), false, broadPattern);
  });

  it("keeps raw logs diagnostic-only while test source serves every dependent step", () => {
    assert.deepEqual(FLOW_ARTIFACT_CONTRACTS.require("scenario.validity.raw-log").ownership.consumers, ["scenario-validity", "acceptance-review"]);
    assert.deepEqual(FLOW_ARTIFACT_CONTRACTS.require("test.execute.raw-log").ownership.consumers, ["test-execute", "test-result-review", "impl-gate"]);
    assert.deepEqual(FLOW_ARTIFACT_CONTRACTS.require("final.regression.raw-log").ownership.consumers, ["final-regression"]);
    const testsSource = FLOW_ARTIFACT_CONTRACTS.require("tests.source");
    assert.deepEqual(testsSource.ownership.consumers, ["test", "scenario-validity", "test-review", "implement", "test-execute", "final-regression"]);
    assert.deepEqual(testsSource.ownership.updaters, ["system", "test"]);
    for (const actor of ["scenario-validity", "test-execute", "acceptance-review", "retro"]) {
      assert.equal(FLOW_ARTIFACT_CONTRACTS.require("spec.record").ownership.consumers.includes(actor), true, actor);
    }
    for (const key of ["test.execute", "test.result.review"]) {
      for (const actor of ["impl-review", "impl-gate", "acceptance-review", "final-regression", "retro", "report"]) {
        assert.equal(FLOW_ARTIFACT_CONTRACTS.require(key).ownership.consumers.includes(actor), true, `${key}/${actor}`);
      }
    }
    assert.equal(FLOW_ARTIFACT_CONTRACTS.require("scenario.validity").ownership.consumers.includes("acceptance-review"), true);
    for (const key of ["upgrade.result"]) {
      assert.equal(FLOW_ARTIFACT_CONTRACTS.require(key).ownership.consumers.includes("acceptance-review"), true, key);
    }
    for (const key of ["draft.questions.repair", "draft.coverage.repair"]) {
      assert.equal(FLOW_ARTIFACT_CONTRACTS.require(key).ownership.consumers.includes("acceptance-review"), true, key);
    }
    assert.equal(FLOW_ARTIFACT_CONTRACTS.require("draft.questions.triage").ownership.consumers.includes("draft-gate"), true);
    assert.deepEqual(FLOW_ARTIFACT_CONTRACTS.require("file.map").ownership.consumers, [
      "system", "implement", "impl-repair", "task-impl", "task-repair", "test-execute", "test-result-review", "impl-review", "impl-gate", "report",
    ]);
    assert.deepEqual(FLOW_ARTIFACT_CONTRACTS.require("completion.overrides").ownership.consumers, [
      "test-review", "test-result-review", "impl-review", "impl-gate", "acceptance-review", "final-regression",
    ]);
  });

  it("records real decision and snapshot ownership instead of classifying writers as artifact-free", () => {
    const noArtifact = new Set(FLOW_ARTIFACT_NO_ARTIFACT_STEPS.map((entry) => entry.stepId));
    assert.equal(noArtifact.has("approval"), false);
    assert.equal(noArtifact.has("acceptance-decision"), false);
    assert.equal(FLOW_ARTIFACT_CONTRACTS.require("spec.record").ownership.updaters.includes("approval"), true);
    assert.equal(FLOW_ARTIFACT_CONTRACTS.require("flow.state").ownership.updaters.includes("acceptance-decision"), true);
    assert.deepEqual(FLOW_ARTIFACT_CONTRACTS.require("acceptance.decision").ownership.producers, ["acceptance-decision"]);
    assert.equal(FLOW_ARTIFACT_CONTRACTS.require("acceptance.review").ownership.updaters.includes("acceptance-decision"), false);
    assert.equal(FLOW_ARTIFACT_CONTRACTS.require("issue.log").ownership.updaters.includes("acceptance-decision"), true);
    assert.equal(FLOW_ARTIFACT_CONTRACTS.require("issue.snapshot").ownership.consumers.includes("system"), true);
    assert.equal(FLOW_ARTIFACT_CONTRACTS.require("issue.snapshot").ownership.consumers.includes("draft-questions-review"), true);
    assert.equal(FLOW_ARTIFACT_CONTRACTS.require("issue.snapshot").ownership.consumers.includes("draft-coverage-review"), true);
    assert.notEqual(FLOW_ARTIFACT_CONTRACTS.require("final.regression").contentContract, null);
  });

  it("assigns shared finding records to every materializing route", () => {
    const findingSources = [
      "draft-questions-review", "draft-coverage-review", "draft-gate", "spec-review", "spec-gate",
      "scenario-validity", "test-review", "test-result-review", "task-review", "task-gate",
      "impl-review", "impl-gate", "retro",
    ];
    const findings = FLOW_ARTIFACT_CONTRACTS.require("flow.findings");
    assert.deepEqual(findings.ownership.producers, findingSources);
    assert.deepEqual(findings.ownership.updaters, [...findingSources, "acceptance-review"]);
    for (const actor of ["system", ...findingSources, "acceptance-review", "final-regression"]) {
      assert.equal(findings.ownership.consumers.includes(actor), true, actor);
    }

    const handoffs = FLOW_ARTIFACT_CONTRACTS.require("nonblocking.handoffs");
    assert.deepEqual(handoffs.ownership.producers, ["scenario-validity", "test-result-review", "retro"]);
    assert.deepEqual(handoffs.ownership.updaters, ["scenario-validity", "test-result-review", "retro"]);
    assert.deepEqual(handoffs.ownership.consumers, ["scenario-validity", "test-result-review", "retro", "acceptance-review"]);
  });

  it("keeps dispatcher-owned worker handoffs outside the durable artifact inventory", () => {
    assert.equal(FLOW_ARTIFACT_CONTRACTS.inventory().some((entry) => entry.logicalKey.toString() === "worker.handoff"), false);
    assert.deepEqual(FLOW_ARTIFACT_CONTRACTS.require("draft").ownership.consumers, [
      "draft-questions-review", "draft-questions-triage", "draft-questions-repair", "draft-refine",
      "draft-coverage-review", "draft-coverage-triage", "draft-coverage-repair", "draft-gate", "spec",
    ]);
    assert.deepEqual(FLOW_ARTIFACT_CONTRACTS.require("draft").ownership.updaters, [
      "system", "draft", "draft-questions-repair", "draft-refine", "draft-coverage-repair",
    ]);
    assert.equal(FLOW_ARTIFACT_CONTRACTS.require("spec.record").ownership.updaters.includes("spec-repair"), true);
    assert.deepEqual(
      FLOW_ARTIFACT_CONTRACTS.require("spec.review").ownership.producers,
      ["system", "spec-review", "spec-triage", "spec-repair"],
    );
    assert.deepEqual(
      FLOW_ARTIFACT_CONTRACTS.require("spec.review").ownership.updaters,
      ["system", "spec-review", "spec-triage", "spec-repair"],
    );

    const logicalKeyByInput = new Map([
      ["draft.json", "draft"],
      ["draft-review-questions.json", "draft.questions.review"],
      ["draft-questions-triage.json", "draft.questions.triage"],
      ["draft-review-coverage.json", "draft.coverage.review"],
      ["draft-coverage-triage.json", "draft.coverage.triage"],
      ["spec.json", "spec.record"],
      ["review.json", "spec.review"],
      ["scenario-validity-result.json", "scenario.validity"],
      ["test-review.json", "test.review"],
    ]);
    const logicalKeyByPayload = new Map([
      ["draft.json", "draft"],
      ["draft-questions-triage.json", "draft.questions.triage"],
      ["draft-questions-repair.json", "draft.questions.repair"],
      ["draft-coverage-triage.json", "draft.coverage.triage"],
      ["draft-coverage-repair.json", "draft.coverage.repair"],
      ["spec.json", "spec.record"],
      ["review.delta.json", null],
      ["spec-tests", "tests.source"],
    ]);
    for (const stepId of WORKER_ARTIFACT_HANDOFF_STEPS) {
      const policy = workerArtifactHandoffPolicy(stepId);
      const inputs = new Set([
        ...policy.inputContract.inputs,
        ...Object.values(policy.inputContract.repairInputs).flat(),
        ...policy.inputContract.testReviewRepairInputs,
      ]);
      for (const input of inputs) {
        const logicalKey = logicalKeyByInput.get(input);
        assert.notEqual(logicalKey, undefined, `${stepId}/${input}`);
        assert.equal(FLOW_ARTIFACT_CONTRACTS.require(logicalKey).ownership.consumers.includes(stepId), true, `${logicalKey}/${stepId}`);
      }
      for (const payload of policy.payloads) {
        const logicalKey = logicalKeyByPayload.get(payload.logicalName);
        assert.notEqual(logicalKey, undefined, `${stepId}/${payload.logicalName}`);
        if (logicalKey === null) {
          assert.equal(["spec-triage", "spec-repair"].includes(stepId), true, `${stepId} owns only a transient review delta`);
          continue;
        }
        const ownership = FLOW_ARTIFACT_CONTRACTS.require(logicalKey).ownership;
        assert.equal(
          ownership.producers.includes(stepId) || ownership.updaters.includes(stepId),
          true,
          `${logicalKey}/${stepId}`,
        );
      }
    }
  });

  it("maps real source-era paths explicitly and never invents logical-key filenames", () => {
    const targets = new Map(FLOW_ARTIFACT_SWITCH_TARGETS.map((entry) => [entry.logicalKey, entry]));
    assert.deepEqual(targets.get("draft").legacyPaths.map(String), ["draft.json"]);
    assert.deepEqual(targets.get("draft.gate.source").legacyPaths.map(String), ["draft-gate-source.json"]);
    assert.deepEqual(targets.get("task.gate").legacyPaths.map(String), ["task-impl-gate-result.json"]);
    assert.deepEqual(targets.get("acceptance.review.evidence").legacyPaths.map(String), ["acceptance-review-evidence.json"]);
    assert.deepEqual(targets.get("test.review").legacyPaths.map(String), ["test-review.json", "test-coverage.json"]);
    assert.deepEqual(targets.get("issue.log").legacyPaths.map(String), ["issue-log.json", "redolog.json"]);
    assert.deepEqual(targets.get("ideas").legacyPaths.map(String), ["ideas.json", "plugin-artifacts/workflow/ideas.json"]);
    assert.deepEqual(targets.get("plugin.lifecycle.artifact").legacyPatterns.map(String), ["plugin-artifacts/:{pluginArtifactPath}"]);
    assert.deepEqual(targets.get("review.evidence").legacyPatterns.map(String), ["review-evidence/:{digest}.json"]);
    assert.deepEqual(targets.get("legacy.task.views").legacyPatterns.map(String), ["tasks/:{taskView}.md"]);
    assert.equal(targets.get("legacy.derived.views").legacyPaths.some((entry) => entry.toString() === "test.md"), true);
    assert.equal(targets.get("flow.state").action, "switch");
    assert.equal(targets.get("draft").legacyPaths.some((entry) => entry.toString() === "draft.json"), true);
    for (const fabricated of ["draft-questions-review.json", "draft-coverage-review.json", "spec-gate.json", "impl-gate.json"]) {
      assert.equal(FLOW_ARTIFACT_SWITCH_TARGETS.some((entry) => entry.legacyPaths.some((path) => path.toString() === fabricated)), false, fabricated);
    }
  });

  it("classifies every normal Flow source filename or typed pattern exactly once", () => {
    const samples = new Map([
      ["draft.json", "draft"],
      ["draft-gate-source.json", "draft.gate.source"],
      ["spec-gate-result.json", "spec.gate"],
      ["task-impl-gate-source.json", "task.gate.source"],
      ["steps/impl/T-1/review/result.json", "task.review"],
      ["steps/impl/T-1/impl/mutation-lineage/attempt-1.json", "task.mutation.lineage"],
      ["acceptance-review-evidence.json", "acceptance.review.evidence"],
      ["repair-deltas/repair-001.json", "repair.delta"],
      ["review-evidence/evidence.json", "review.evidence"],
      ["tests/scenarios/flow.test.js", "tests.source"],
      ["tests/.raw/test-execution.log", "test.execute.raw-log"],
      ["tests/.raw/final-regression-attempt-001.log", "final.regression.raw-log"],
      ["review-history/work-units/impl-review/unit.json", "review.work.unit"],
      ["review-history/impl-review-attempt-001.json", "legacy.review.history"],
      ["plugin-artifacts/example-plugin/output.json", "plugin.lifecycle.artifact"],
      ["plugin-artifacts/workflow/ideas.json", "ideas"],
      ["agent-metrics.json", "finalize.cleanup.agent-metrics"],
      ["finalize-cleanup.json", "finalize.cleanup.journal"],
      [".current-flow-state.lock", "runtime.lock.current-flow-state"],
      [".flow.json.writer.owner-1.owner.tmp", "runtime.lock.flow-state-writer-owner"],
      [".impl-repair.lock/owner.json", "runtime.lock.impl-repair"],
      ["..issue-log.lock.owner-1.owner.tmp", "runtime.lock.issue-log-owner"],
      ["..current-flow-state.lock.owner-1.owner.tmp", "runtime.lock.current-flow-state-owner"],
      ["..artifact-catalog.lock.owner-1.owner.tmp", "runtime.lock.artifact-catalog-owner"],
      ["..retry-recovery.lock.owner-1.owner.tmp", "runtime.lock.retry-recovery-owner"],
      ["report-envelope.json", "legacy.finalize.envelopes"],
    ]);
    for (const [file, logicalKey] of samples) {
      assert.equal(FLOW_ARTIFACT_CONTRACTS.classifyKnownFile(file).logicalKey, logicalKey, file);
    }
    for (const entry of FLOW_ARTIFACT_NORMAL_FLOW_FILES) {
      const target = FLOW_ARTIFACT_CONTRACTS.target(entry.logicalKey);
      assert.equal(target.action, entry.action, entry.toString());
    }
  });

  it("preserves migrated Task views outside the legacy source inventory while typed source views remain removal targets", () => {
    const migrated = execFileSync("git", ["ls-files", "specs/**/artifacts/migration/legacy-files/tasks/*.md"], {
      cwd: new URL("../../..", import.meta.url), encoding: "utf8",
    }).trim().split("\n").filter(Boolean);
    assert.notEqual(migrated.length, 0);
    for (const file of migrated) assert.match(file, /^specs\/[^/]+\/001\/artifacts\/migration\/legacy-files\/tasks\/[^/]+\.md$/, file);
    const classification = FLOW_ARTIFACT_CONTRACTS.classifyKnownFile("tasks/T-1.md");
    assert.equal(classification.logicalKey, "legacy.task.views");
    assert.equal(classification.action, "remove");
  });

  it("accounts for every Git-tracked live legacy Flow path outside canonical Versions", () => {
    const options = { cwd: new URL("../../..", import.meta.url), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
    const legacyRoots = new Set(execFileSync("git", ["ls-files", "--", ":(glob)specs/*/flow.json"], options)
      .trim().split("\n").filter(Boolean).map((file) => path.posix.dirname(file)));
    assert.notEqual(legacyRoots.size, 0);
    const tracked = execFileSync("git", ["ls-files", "specs"], options)
      .trim().split("\n").filter(Boolean)
      .filter((file) => [...legacyRoots].some((root) => file.startsWith(`${root}/`)))
      .map((file) => file.split("/").slice(2).join("/"));
    const unclassified = [];
    for (const file of tracked) {
      try { FLOW_ARTIFACT_CONTRACTS.classifyKnownFile(file); } catch {
        unclassified.push(file);
      }
    }
    assert.deepEqual([...new Set(unclassified)].sort(), []);
  });

  it("resolves structured task and owner-hierarchy paths while rejecting unsafe input", () => {
    assert.equal(FLOW_ARTIFACT_CONTRACTS.taskDirectory("T-1", "impl"), "steps/impl/T-1/impl");
    assert.equal(FLOW_ARTIFACT_CONTRACTS.taskDirectory("T-1", "review"), "steps/impl/T-1/review");
    assert.equal(FLOW_ARTIFACT_CONTRACTS.taskDirectory("T-1", "gate"), "steps/impl/T-1/gate");
    assert.equal(FLOW_ARTIFACT_CONTRACTS.resolve("task.review", { taskId: "T-1" }).relativePath, "steps/impl/T-1/review/result.json");
    assert.equal(FLOW_ARTIFACT_CONTRACTS.resolve("task.mutation.lineage", { taskId: "T-1", attemptId: "attempt-1" }).relativePath, "steps/impl/T-1/impl/mutation-lineage/attempt-1.json");
    assert.equal(FLOW_ARTIFACT_CONTRACTS.resolve("task.gate", { taskId: "T-1" }).relativePath, "steps/impl/T-1/gate/result.json");
    assert.equal(FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ taskId: "T-1", digest: DIGEST_A }).relativePath, `steps/impl/T-1/review/evidence/${DIGEST_A}.json`);
    assert.throws(() => FLOW_ARTIFACT_CONTRACTS.resolve("review.evidence", { ownerPath: "impl/T-1/review", digest: DIGEST_A }), /typed registry/);
    assert.throws(() => FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ taskId: "T-1", digest: "abc" }), /SHA-256/);
    assert.throws(() => FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep: "impl-review", taskId: "T-1", digest: DIGEST_A }), /exactly one/);
    assert.throws(() => FLOW_ARTIFACT_CONTRACTS.resolve("tests.source", { testPath: ".raw/output.log" }), /diagnostic/);
    assert.throws(() => FLOW_ARTIFACT_CONTRACTS.resolve("plugin.lifecycle.artifact", { pluginArtifactPath: "workflow/ideas.json" }), /canonical ideas/);
    assert.throws(() => new FlowArtifactCanonicalPath("steps/../escape.json"), /normalized/);
  });

  it("derives collection authority members from resolved paths", () => {
    for (const [logicalKey, firstParameters, secondParameters] of [
      ["task.review", { taskId: "T-1" }, { taskId: "T-2" }],
      ["task.gate.source", { taskId: "T-1" }, { taskId: "T-2" }],
      ["task.gate", { taskId: "T-1" }, { taskId: "T-2" }],
      ["task.mutation.lineage", { taskId: "T-1", attemptId: "attempt-1" }, { taskId: "T-1", attemptId: "attempt-2" }],
      ["tests.source", { testPath: "scenarios/one.test.js" }, { testPath: "scenarios/two.test.js" }],
    ]) {
      const first = FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, firstParameters);
      const second = FLOW_ARTIFACT_CONTRACTS.resolve(logicalKey, secondParameters);
      assert.equal(first.contract.authoritySlot.cardinality.toString(), "collection", logicalKey);
      assert.notEqual(first.authoritySlot().memberId, second.authoritySlot().memberId, logicalKey);
      assert.notEqual(first.authoritySlot().claimKey(), second.authoritySlot().claimKey(), logicalKey);
    }
    assert.equal(FlowArtifactUpdater.fromActivityNodeId("impl-review").toString(), "impl-review");
    assert.equal(FlowArtifactUpdater.fromActivityNodeId("T-1-review").toString(), "task-review");
    assert.equal(FlowArtifactUpdater.fromActivityNodeId("T-1/task-gate").toString(), "task-gate");
  });

  it("authorizes each declared updater without copying a canonical contract", () => {
    const draft = FLOW_ARTIFACT_CONTRACTS.resolve("draft");
    assert.equal(draft.authoritySlotFor("draft-refine").publicationStep, "draft-refine");
    assert.equal(draft.authoritySlotFor("draft").claimKey(), draft.authoritySlotFor("draft-refine").claimKey());
    assert.throws(() => draft.authoritySlotFor("spec-review"), /not authorized/);
    assert.equal(FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep: "spec-review", digest: DIGEST_A }).relativePath, `steps/spec-review/evidence/${DIGEST_A}.json`);
    assert.equal(FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep: "test-review", digest: DIGEST_A }).relativePath, `steps/test-review/evidence/${DIGEST_A}.json`);
    assert.equal(FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep: "impl-review", digest: DIGEST_A }).relativePath, `steps/impl/review/evidence/${DIGEST_A}.json`);
    const reviewEvidence = FLOW_ARTIFACT_CONTRACTS.require("review.evidence");
    for (const updater of ["draft-questions-review", "draft-coverage-review", "spec-review", "test-review", "impl-review", "task-review"]) {
      assert.doesNotThrow(() => reviewEvidence.authoritySlotFor(updater, "evidence"), updater);
      assert.equal(reviewEvidence.ownership.consumers.includes(updater), true, updater);
    }
    assert.throws(() => FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep: "report", digest: DIGEST_A }), /invalid review artifact owner/);
  });

  it("binds placement, ownership, and authority to the canonical publication boundary", () => {
    const draft = FLOW_ARTIFACT_CONTRACTS.require("draft");
    const tests = FLOW_ARTIFACT_CONTRACTS.require("tests.source");
    const fileMap = FLOW_ARTIFACT_CONTRACTS.require("file.map");
    assert.equal(draft.placement.toString(), "step-owner");
    assert.equal(draft.authoritySlot.authority.toString(), "canonical-flow-artifacts");
    assert.equal(tests.authoritySlot.authority.toString(), "canonical-flow-artifacts");
    assert.equal(fileMap.authoritySlot.authority.toString(), "execution-checkout");
    assert.deepEqual(fileMap.ownership.producers, ["implement", "task-impl"]);
    assert.equal(fileMap.ownership.consumers.includes("report"), true);
    assert.equal(FLOW_ARTIFACT_CONTRACTS.inventory().some((entry) => entry.logicalKey.toString() === "worker.handoff"), false);
    assert.throws(() => new FlowArtifactContract({
      logicalKey: "flow.state", canonicalPath: "flow.json", placement: "step-owner", retention: "permanent",
      ownership: new FlowArtifactOwnership({ producers: ["system"], updaters: ["system"], consumers: ["system"] }),
      authoritySlot: new FlowArtifactAuthoritySlot({ kind: "invalid-root", authority: "repository-metadata" }),
    }), /step-owner placement/);
    assert.throws(() => new FlowArtifactContract({
      logicalKey: "bad.transient", canonicalPath: "steps/bad/result.json", placement: "transient", retention: "permanent",
      ownership: new FlowArtifactOwnership({ producers: ["system"], updaters: ["system"], consumers: ["system"] }),
      authoritySlot: new FlowArtifactAuthoritySlot({ kind: "invalid-transient", authority: "canonical-flow-artifacts" }),
    }), /transient placement/);
    assert.throws(() => new FlowArtifactContract({
      logicalKey: "bad.deliverable", canonicalPath: "steps/bad/result.json", placement: "independent-deliverable", retention: "permanent",
      ownership: new FlowArtifactOwnership({ producers: ["system"], updaters: ["system"], consumers: ["system"] }),
      authoritySlot: new FlowArtifactAuthoritySlot({ kind: "invalid-deliverable", authority: "canonical-flow-artifacts" }),
    }), /independent deliverable placement/);
    assert.throws(() => new FlowArtifactContract({
      logicalKey: "bad.root", canonicalPath: "steps/root/result.json", placement: "root-authority", retention: "permanent",
      ownership: new FlowArtifactOwnership({ producers: ["system"], updaters: ["system"], consumers: ["system"] }),
      authoritySlot: new FlowArtifactAuthoritySlot({ kind: "invalid-root-path", authority: "repository-metadata" }),
    }), /root authority placement/);
    assert.throws(() => new FlowArtifactContract({
      logicalKey: "artifact.catalog", canonicalPath: "artifact-catalog.json", placement: "root-authority", retention: "permanent", cataloged: true,
      ownership: new FlowArtifactOwnership({ producers: ["system"], updaters: ["system"], consumers: ["system"] }),
      authoritySlot: new FlowArtifactAuthoritySlot({ kind: "invalid-catalog-self", authority: "repository-metadata" }),
    }), /catalog membership/);
    assert.throws(() => new FlowArtifactContract({
      logicalKey: "bad.owner", canonicalPath: "steps/a.json", placement: "step-owner", retention: "permanent",
      ownership: new FlowArtifactOwnership({ producers: ["system"], updaters: ["system"], consumers: ["system"] }),
      authoritySlot: new FlowArtifactAuthoritySlot({ kind: "invalid-shared-owner", authority: "canonical-flow-artifacts" }),
    }), /step owner placement/);
    assert.throws(() => new FlowArtifactContract({
      logicalKey: "draft", canonicalPath: "steps/not-draft/result.json", placement: "step-owner",
      stepOwner: FlowArtifactStepOwner.forStep("draft"), retention: "permanent",
      ownership: new FlowArtifactOwnership({ producers: ["system"], updaters: ["system"], consumers: ["system"] }),
      authoritySlot: new FlowArtifactAuthoritySlot({ kind: "invalid-owner-hierarchy", authority: "canonical-flow-artifacts" }),
    }), /does not own artifact path/);
    assert.throws(() => new FlowArtifactContract({
      logicalKey: "bad.shared", canonicalPath: "steps/owner/shared.json", placement: "step-shared", retention: "permanent",
      ownership: new FlowArtifactOwnership({ producers: ["system"], updaters: ["system"], consumers: ["system"] }),
      authoritySlot: new FlowArtifactAuthoritySlot({ kind: "invalid-nested-shared", authority: "canonical-flow-artifacts" }),
    }), /step shared placement/);
  });

  it("rejects invalid switch target actors, actions, duplicate old paths, and contract disagreement", () => {
    assert.throws(() => new FlowArtifactSwitchTarget({
      logicalKey: "draft", legacyPaths: ["draft.json"], canonicalPath: "steps/draft/result.json", action: "move", producer: "draft", consumer: "draft",
    }), /action is invalid/);
    assert.throws(() => new FlowArtifactSwitchTarget({
      logicalKey: "draft", legacyPaths: ["draft.json"], canonicalPath: "steps/draft/result.json", action: "switch", producer: "unknown", consumer: "draft",
    }), /authority step/);
    const roots = [
      contract("flow.state", "flow.json", "flow-state"), contract("flow.activities", "activities.jsonl", "activity-ledger"),
      contract("spec.record", "spec.json", "spec-record"), contract("issue.log", "issue-log.json", "issue-log"),
      contract("artifact.catalog", "artifact-catalog.json", "artifact-catalog"), contract("issue.snapshot", "issue.md", "issue-snapshot"),
    ];
    const targets = roots.map((entry) => new FlowArtifactSwitchTarget({
      logicalKey: entry.logicalKey.toString(), canonicalPath: entry.canonicalPath.toString(), action: "new", producer: "system", consumer: "system",
    }));
    assert.throws(() => new FlowArtifactRegistry({
      contracts: roots,
      switchTargets: [...targets, new FlowArtifactSwitchTarget({
        logicalKey: "legacy.one", legacyPaths: ["same.json"], action: "remove", producer: "system", consumer: "system",
      }), new FlowArtifactSwitchTarget({
        logicalKey: "legacy.two", legacyPaths: ["same.json"], action: "remove", producer: "system", consumer: "system",
      })],
    }), /duplicate legacy artifact switch path/);
    const mismatched = [...targets];
    mismatched[0] = new FlowArtifactSwitchTarget({
      logicalKey: "flow.state", canonicalPath: "steps/flow/result.json", action: "new", producer: "system", consumer: "system",
    });
    assert.throws(() => new FlowArtifactRegistry({ contracts: roots, switchTargets: mismatched }), /canonical path does not match/);
    const unauthorizedProducer = [...targets];
    unauthorizedProducer[0] = new FlowArtifactSwitchTarget({
      logicalKey: "flow.state", canonicalPath: "flow.json", action: "new", producer: "draft", consumer: "system",
    });
    assert.throws(() => new FlowArtifactRegistry({ contracts: roots, switchTargets: unauthorizedProducer }), /producer is not declared/);

    assert.throws(() => new FlowArtifactRegistry({
      contracts: roots,
      switchTargets: [...targets, new FlowArtifactSwitchTarget({
        logicalKey: "legacy.pattern", legacyPatterns: [new FlowArtifactLegacyPattern("tests/:{path}")], action: "remove", producer: "system", consumer: "system",
      }), new FlowArtifactSwitchTarget({
        logicalKey: "legacy.exact", legacyPaths: ["tests/foo.json"], action: "remove", producer: "system", consumer: "system",
      })],
    }), /overlapping legacy artifact switch paths/);

    const knownRoots = roots.map((entry) => new FlowArtifactKnownFile({
      logicalKey: entry.logicalKey.toString(), action: "new", canonicalPath: entry.canonicalPath.toString(),
    }));
    assert.throws(() => new FlowArtifactRegistry({
      contracts: roots, switchTargets: targets, knownFiles: knownRoots.slice(1),
    }), /switch target inventory entry must be declared exactly once/);
    assert.throws(() => new FlowArtifactRegistry({
      contracts: roots,
      switchTargets: [...targets, new FlowArtifactSwitchTarget({
        logicalKey: "legacy.pattern-one", legacyPatterns: [new FlowArtifactLegacyPattern("tests/:{path}")], action: "remove", producer: "system", consumer: "system",
      }), new FlowArtifactSwitchTarget({
        logicalKey: "legacy.pattern-two", legacyPatterns: [new FlowArtifactLegacyPattern("tests/:{file}")], action: "remove", producer: "system", consumer: "system",
      })],
    }), /overlapping legacy artifact switch paths/);
    assert.throws(() => new FlowArtifactRegistry({
      contracts: roots,
      switchTargets: [...targets, new FlowArtifactSwitchTarget({
        logicalKey: "legacy.pattern-three", legacyPatterns: [new FlowArtifactLegacyPattern("steps/audit/:{owner}/result.json")], action: "remove", producer: "system", consumer: "system",
      }), new FlowArtifactSwitchTarget({
        logicalKey: "legacy.pattern-four", legacyPatterns: [new FlowArtifactLegacyPattern("steps/audit/impl/:{file}")], action: "remove", producer: "system", consumer: "system",
      })],
    }), /overlapping legacy artifact switch paths/);
  });

  it("rejects duplicate logical keys, canonical paths, authority slots, and ambiguous patterns", () => {
    const roots = [
      contract("flow.state", "flow.json", "flow-state"),
      contract("flow.activities", "activities.jsonl", "activity-ledger"),
      contract("spec.record", "spec.json", "spec-record"),
      contract("issue.log", "issue-log.json", "issue-log"),
      contract("artifact.catalog", "artifact-catalog.json", "artifact-catalog"),
      contract("issue.snapshot", "issue.md", "issue-snapshot"),
    ];
    assert.throws(() => new FlowArtifactRegistry({ contracts: [...roots,
      contract("result.one", "steps/draft/result.json", "other", FlowArtifactStepOwner.forStep("draft")),
      contract("result.one", "steps/draft-gate/result.json", "other-two", FlowArtifactStepOwner.forStep("draft-gate")),
    ] }), /duplicate artifact logical key/);
    assert.throws(() => new FlowArtifactRegistry({ contracts: [...roots,
      contract("result.one", "steps/draft/result.json", "other", FlowArtifactStepOwner.forStep("draft")),
      contract("result.two", "steps/draft/result.json", "other-two", FlowArtifactStepOwner.forStep("draft")),
    ] }), /duplicate artifact canonical path/);
    assert.throws(() => new FlowArtifactRegistry({ contracts: [...roots,
      contract("result.one", "steps/draft/result.json", "same", FlowArtifactStepOwner.forStep("draft")),
      contract("result.two", "steps/draft-gate/result.json", "same", FlowArtifactStepOwner.forStep("draft-gate")),
    ] }), /duplicate artifact authority slot/);
    assert.throws(() => new FlowArtifactRegistry({ contracts: [
      ...roots,
      contract("result.one", "steps/impl/repair/deltas/:{deltaId}.json", "result-one", FlowArtifactStepOwner.forStep("impl-repair")),
      contract("result.two", "steps/impl/repair/deltas/fixed.json", "result-two", FlowArtifactStepOwner.forStep("impl-repair")),
    ] }), /overlapping artifact canonical paths/);
    assert.throws(() => new FlowArtifactRegistry({ contracts: [
      ...roots,
      new FlowArtifactContract({
        ...contract("result.one", "steps/impl/repair/:{owner}/result.json", "result-one", FlowArtifactStepOwner.forStep("impl-repair")),
        logicalKey: "result.one", canonicalPath: "steps/impl/repair/:{owner}/result.json",
      }),
      new FlowArtifactContract({
        ...contract("result.two", "steps/impl/repair/fixed/:{file}", "result-two", FlowArtifactStepOwner.forStep("impl-repair")),
        logicalKey: "result.two", canonicalPath: "steps/impl/repair/fixed/:{file}",
      }),
    ] }), /overlapping artifact canonical paths/);
    assert.throws(() => new FlowArtifactRegistry({ contracts: [
      ...roots,
      contract("result.one", "steps/impl/:{taskId}/review/result.json", "result-one", FlowArtifactStepOwner.taskCollection("review")),
    ] }), /parameterized catalog artifact paths require collection authority/);
  });

  it("allocates raw-log attempts as an append-only sequence", () => {
    const sequence = new FlowArtifactAttemptSequence([new FlowArtifactAttempt(1), new FlowArtifactAttempt(2)]);
    assert.equal(sequence.next().toString(), "003");
    assert.equal(FLOW_ARTIFACT_CONTRACTS.resolve("final.regression.raw-log", {
      attempt: sequence.next().toString(),
    }).relativePath, "steps/final-regression/attempt-003.log");
    assert.equal(FLOW_ARTIFACT_CONTRACTS.finalRegressionRawLog(1000).relativePath, "steps/final-regression/attempt-1000.log");
    assert.equal(FLOW_ARTIFACT_CONTRACTS.finalRegressionRawLog(10000).relativePath, "steps/final-regression/attempt-10000.log");
    assert.throws(() => FLOW_ARTIFACT_CONTRACTS.finalRegressionRawLog(10001), /between 1 and 10000/);
    assert.throws(() => FLOW_ARTIFACT_CONTRACTS.classify("steps/final-regression/attempt-bad.log"), /not uniquely classified/);
    assert.throws(() => FLOW_ARTIFACT_CONTRACTS.classify("steps/impl/review/evidence/not-a-digest.json"), /not uniquely classified/);
    assert.throws(() => new FlowArtifactAttemptSequence([new FlowArtifactAttempt(2), new FlowArtifactAttempt(1)]), /append-only/);
    for (const attempt of ["abc", "000", "1", "../001", "01000", "10001"]) {
      assert.throws(() => FLOW_ARTIFACT_CONTRACTS.resolve("final.regression.raw-log", { attempt }), /canonically padded attempt/, attempt);
    }
    assert.throws(() => new FlowArtifactAttemptRecord({ attempt: 1, payload: { attempt: 2 } }), /must not override/);
  });

  it("keeps review and execution attempts append-only without allowing a prior prefix rewrite", () => {
    const first = new FlowArtifactAttempt(1);
    const second = new FlowArtifactAttempt(2);
    const firstRecord = new FlowArtifactAttemptRecord({ attempt: first, payload: { result: "pass", evidence: { digest: "one" } } });
    const secondRecord = new FlowArtifactAttemptRecord({ attempt: second, payload: { result: "pass" } });
    const prefix = new FlowArtifactAttemptHistory([firstRecord]);
    const beforeAppend = prefix.toJSON();
    const history = prefix.append(secondRecord);
    assert.equal(history.current, secondRecord);
    assert.deepEqual(prefix.toJSON(), beforeAppend);
    assert.deepEqual(history.toJSON(), { attempts: [{ attempt: 1, result: "pass", evidence: { digest: "one" } }, { attempt: 2, result: "pass" }] });
    assert.throws(() => { history.attempts[0] = secondRecord; }, /read only|Cannot assign/);
    assert.throws(() => { history.attempts[0].payload.evidence.digest = "rewritten"; }, /read only|Cannot assign/);
    assert.deepEqual(history.toJSON().attempts[0], beforeAppend.attempts[0]);
    assert.throws(() => new FlowArtifactAttemptHistory([secondRecord, firstRecord]), /append-only/);
    assert.throws(() => new FlowArtifactAttemptHistory([firstRecord, firstRecord]), /append-only/);
    assert.doesNotThrow(() => FlowArtifactAttemptHistory.fromJSON(history.toJSON()).assertExtends(prefix));
    assert.throws(() => FlowArtifactAttemptHistory.fromJSON({ attempts: [{ attempt: 1, result: "changed" }] }).assertExtends(prefix), /preserve its prior prefix/);
    assert.throws(() => FlowArtifactAttemptHistory.fromJSON({ attempts: [{ attempt: 1, verdict: "pass" }], verdict: "pass" }), /derive verdict from its last attempt/);
  });

  it("scopes review evidence authority members by owner and digest", () => {
    const impl = FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep: "impl-review", digest: DIGEST_B });
    const spec = FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep: "spec-review", digest: DIGEST_B });
    const repeat = FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep: "impl-review", digest: DIGEST_B });
    assert.notEqual(impl.relativePath, spec.relativePath);
    assert.notEqual(impl.memberId, spec.memberId);
    assert.notEqual(impl.authoritySlotFor("impl-review").claimKey(), spec.authoritySlotFor("spec-review").claimKey());
    assert.equal(impl.memberId, repeat.memberId);
    assert.equal(impl.authoritySlotFor("impl-review").claimKey(), repeat.authoritySlotFor("impl-review").claimKey());
  });

  it("binds immutable Activity evidence to root, composite, static, and Task owners without suffix ambiguity", () => {
    const currentOwners = [
      ["flow", "steps/system/activity-evidence/"],
      ["impl", "steps/system/impl/activity-evidence/"],
      ["impl-gate", "steps/impl/gate/activity-evidence/"],
      ["spec-review", "steps/spec-review/activity-evidence/"],
      ["test-review", "steps/test-review/activity-evidence/"],
      ["draft-questions-review", "steps/draft-questions-review/activity-evidence/"],
    ];
    for (const [nodeId, prefix] of currentOwners) {
      const artifact = FLOW_ARTIFACT_CONTRACTS.activityEvidence({ nodeId, digest: DIGEST_A });
      assert.equal(artifact.relativePath, `${prefix}${DIGEST_A}.json`, nodeId);
      assert.equal(artifact.owner.nodeId, nodeId, nodeId);
      assert.equal(FLOW_ARTIFACT_CONTRACTS.classify(artifact.relativePath).logicalKey.toString(), "activity.evidence", nodeId);
    }
    for (const [taskId, segment, prefix] of [
      ["T-1", "impl", "steps/impl/T-1/impl/activity-evidence/"],
      ["T-1", "review", "steps/impl/T-1/review/activity-evidence/"],
      ["T-1", "gate", "steps/impl/T-1/gate/activity-evidence/"],
    ]) {
      const artifact = FLOW_ARTIFACT_CONTRACTS.taskActivityEvidence({ taskId, segment, digest: DIGEST_A });
      assert.equal(artifact.relativePath, `${prefix}${DIGEST_A}.json`, `${taskId}-${segment}`);
      assert.equal(artifact.owner.nodeId, `${taskId}-${segment}`);
      assert.equal(FLOW_ARTIFACT_CONTRACTS.classify(artifact.relativePath).logicalKey.toString(), "activity.evidence");
    }
    const historical = FLOW_ARTIFACT_CONTRACTS.historicalActivityEvidence({
      nodeId: "legacy-review",
      digest: DIGEST_A,
    });
    assert.equal(historical.relativePath, `steps/historical/legacy-review/activity-evidence/${DIGEST_A}.json`);
    assert.equal(historical.owner.historical, true);
    assert.equal(historical.owner.publicationStep, "system");
    assert.equal(FLOW_ARTIFACT_CONTRACTS.classify(historical.relativePath).logicalKey.toString(), "activity.evidence");
    const roundTrip = FlowArtifactActivityEvidence.fromCanonicalPath(
      FLOW_ARTIFACT_CONTRACTS.require("activity.evidence"),
      historical.relativePath,
    );
    assert.equal(roundTrip.owner.nodeId, "legacy-review");
    assert.equal(roundTrip.owner.historical, true);
    assert.throws(
      () => FLOW_ARTIFACT_CONTRACTS.activityEvidence({ nodeId: "T-1", digest: DIGEST_A }),
      /concrete current Flow leaf/,
    );
    assert.throws(
      () => FLOW_ARTIFACT_CONTRACTS.historicalActivityEvidence({ nodeId: "impl-gate", digest: DIGEST_A }),
      /already a current Flow node/,
    );
    assert.throws(
      () => FLOW_ARTIFACT_CONTRACTS.classify(`steps/historical/impl-gate/activity-evidence/${DIGEST_A}.json`),
      /not uniquely classified/,
    );
    assert.throws(
      () => FLOW_ARTIFACT_CONTRACTS.classify(`steps/unknown/activity-evidence/${DIGEST_A}.json`),
      /not uniquely classified/,
    );
  });

  it("places immutable evidence beneath the same owner directory as every review result", () => {
    for (const [logicalKey, reviewStep] of [
      ["draft.questions.review", "draft-questions-review"],
      ["draft.coverage.review", "draft-coverage-review"],
      ["test.review", "test-review"],
      ["impl.review", "impl-review"],
    ]) {
      const resultDirectory = path.posix.dirname(FLOW_ARTIFACT_CONTRACTS.require(logicalKey).canonicalPath.toString());
      const evidenceDirectory = path.posix.dirname(path.posix.dirname(
        FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ reviewStep, digest: DIGEST_A }).relativePath,
      ));
      assert.equal(evidenceDirectory, resultDirectory, reviewStep);
    }
    assert.equal(FLOW_ARTIFACT_CONTRACTS.require("spec.review").canonicalPath.toString(), "revisions/:{revision}/review.json");
    const taskResultDirectory = path.posix.dirname(
      FLOW_ARTIFACT_CONTRACTS.resolve("task.review", { taskId: "T-1" }).relativePath,
    );
    const taskEvidenceDirectory = path.posix.dirname(path.posix.dirname(
      FLOW_ARTIFACT_CONTRACTS.reviewEvidence({ taskId: "T-1", digest: DIGEST_A }).relativePath,
    ));
    assert.equal(taskEvidenceDirectory, taskResultDirectory);
  });

  it("keeps finalize cleanup and runtime locks cataloged only through their declared classification", () => {
    for (const key of [
      "finalize.cleanup.agent-metrics", "finalize.cleanup.notes", "finalize.cleanup.plugin-artifacts",
      "finalize.cleanup.runtime-log", "finalize.cleanup.journal", "runtime.lock.issue-log",
      "runtime.lock.current-flow-state", "runtime.lock.artifact-catalog", "runtime.lock.retry-recovery",
      "runtime.lock.flow-state-writer", "runtime.lock.flow-state-writer-owner", "runtime.lock.impl-repair",
      "runtime.lock.issue-log-owner", "runtime.lock.current-flow-state-owner", "runtime.lock.artifact-catalog-owner", "runtime.lock.retry-recovery-owner",
    ]) {
      const entry = FLOW_ARTIFACT_CONTRACTS.require(key);
      const target = FLOW_ARTIFACT_CONTRACTS.target(key);
      assert.notEqual(FLOW_ARTIFACT_NORMAL_FLOW_FILES.filter((file) => file.logicalKey === key).length, 0, key);
      assert.equal(target.canonicalPath, entry.canonicalPath.toString(), key);
      if (key.includes("runtime") || key.includes("runtime.lock")) {
        assert.equal(entry.retention.toString(), "transient", key);
        assert.equal(entry.cataloged, false, key);
      }
    }
  });

  it("classifies every executable leaf as an artifact producer/updater or explicit no-artifact step", () => {
    const contracts = FLOW_ARTIFACT_CONTRACTS.inventory();
    const noArtifact = new Set(FLOW_ARTIFACT_NO_ARTIFACT_STEPS.map((entry) => entry.stepId));
    const flowState = FLOW_ARTIFACT_CONTRACTS.require("flow.state");
    const definitionLeafIds = [...collectFlowLeafIds(), ...collectTaskLeafIds()].sort();
    const authorityLeafIds = FLOW_ARTIFACT_AUTHORITY_MATRIX.map((entry) => entry.stepId).sort();
    assert.deepEqual(authorityLeafIds, definitionLeafIds, "authority matrix must exactly cover the executable Flow definition");
    for (const entry of FLOW_ARTIFACT_AUTHORITY_MATRIX) {
      assert.equal(flowState.ownership.consumers.includes(entry.stepId), true, `${entry.stepId} does not consume flow state`);
      assert.equal(flowState.ownership.updaters.includes(entry.stepId), true, `${entry.stepId} transition is not a flow state updater`);
      assert.equal(contracts.some((contract) => (
        !["flow.state", "flow.activities", "issue.log"].includes(contract.logicalKey.toString())
        && (
        contract.ownership.producers.includes(entry.stepId)
        || contract.ownership.updaters.includes(entry.stepId)
        )
      )) || noArtifact.has(entry.stepId), true, `${entry.stepId} has no primary artifact classification`);
    }
  });

  it("does not retain ownership or switch actors outside the authority matrix", () => {
    const allowed = new Set(["system", ...FLOW_ARTIFACT_AUTHORITY_MATRIX.map((entry) => entry.stepId)]);
    for (const contract of FLOW_ARTIFACT_CONTRACTS.inventory()) {
      for (const actor of [...contract.ownership.producers, ...contract.ownership.updaters, ...contract.ownership.consumers]) {
        assert.equal(allowed.has(actor), true, `${contract.logicalKey}/${actor}`);
      }
    }
    for (const target of FLOW_ARTIFACT_SWITCH_TARGETS) {
      assert.equal(allowed.has(target.producer), true, `${target.logicalKey}.producer/${target.producer}`);
      assert.equal(allowed.has(target.consumer), true, `${target.logicalKey}.consumer/${target.consumer}`);
    }
  });
});
