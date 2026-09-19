import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { describe, it } from "node:test";

import { sealWorkerArtifactHandoff } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { STEP_OUTPUT_TYPE, StepOutput } from "../../../src/flow/engine/step-output.js";
import { findStepById } from "../../../src/flow/lib/step-tree.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { commitAll, initGitRepo } from "../../support/infrastructure/git-repo.js";
import { DraftGateRepairScenario } from "../../support/infrastructure/draft-gate-repair-scenario.js";
import { CanonicalFlowFixture, canonicalDraftDocument } from "../../support/infrastructure/flow-setup.js";

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function observations() {
  return [{
    kind: "violation", failureMode: "guardrail-violation", requirementRef: "R-1",
    where: { file: "draft.json", locator: "goal" },
    observed: "The retained behavior must be explicit.", severity: "blocking", refs: ["R-1"],
  }, {
    kind: "violation", failureMode: "process-evidence-missing", requirementRef: "process:coverage",
    where: { file: "draft.json", locator: "analysis.proposedApproach" },
    observed: "The proposal must identify its retained behavior.", severity: "blocking", refs: ["process:coverage"],
  }];
}

function setup(specId, { selectRepair = true, draftDocument = null, compactDraft = false } = {}) {
  const root = createTmpDir("draft-gate-repair-handoff-");
  initGitRepo(root);
  fs.writeFileSync(`${root}/README.md`, "draft Gate repair boundary\n");
  commitAll(root, "draft Gate repair boundary");
  const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
  const fixture = new CanonicalFlowFixture({
    flowManager, specId, runId: `run-${specId}`, issue: 521,
    request: "Preserve retained behavior through a bounded Gate repair.",
    execution: { mode: "direct", baseBranch: "main", featureBranch: null },
  }).create().registerActive().activate("draft");
  const sourceDraft = draftDocument ?? canonicalDraftDocument({ goal: "Incomplete retained behavior", questions: [] });
  flowManager.confirmCurrentAttempt({ specId, artifactWrites: [{
    logicalKey: "draft", mediaType: "application/json",
    bytes: Buffer.from(compactDraft ? JSON.stringify(sourceDraft) : `${JSON.stringify(sourceDraft, null, 2)}\n`),
  }] });
  if (!selectRepair) return { root, flowManager, fixture };
  fixture.activate("draft-gate");
  const scenario = new DraftGateRepairScenario({ flowManager, root, specId })
    .select({ observations: observations(), issueLogId: `issue-${specId}` });
  return { root, flowManager, fixture, scenario };
}

function seal(request, payload) {
  fs.writeFileSync(request.payloadPath("draft-gate-repair.json"), `${JSON.stringify(payload, null, 2)}\n`);
  sealWorkerArtifactHandoff({ requestPath: request.requestPath, invocationId: request.dispatchInvocationId });
}

function catalogEntry(flowManager, specId, logicalKey) {
  return flowManager.artifactCatalog(specId).artifacts.find((entry) => entry.logicalKey === logicalKey) ?? null;
}

function assertNoRepairPublication(flowManager, specId, draftDigest) {
  assert.equal(catalogEntry(flowManager, specId, "draft.gate.repair"), null);
  assert.equal(catalogEntry(flowManager, specId, "plan.gate.repair.outcome"), null);
  const current = flowManager.readArtifact({
    specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair",
  });
  assert.equal(current.descriptor.hash, draftDigest);
}

describe("dedicated draft Gate repair handoff", () => {
  it("admits only the selected repair and publishes the bounded delta, audit, and outcome atomically", () => {
    const value = setup("521-gate-repair-applied");
    try {
      const request = value.scenario.createRequest();
      assert.deepEqual(request.inputs.map((entry) => entry.name), [
        "draft.json", "plan-gate-repair.json", "gate-observation-recurrence.json",
      ]);
      assert.deepEqual(request.payloads.map(({ rule }) => rule.logicalName), ["draft-gate-repair.json"]);
      const authority = request.inputs.find((entry) => entry.name === "plan-gate-repair.json").document;
      assert.equal(authority.sourceIssueLogId, "issue-521-gate-repair-applied");
      assert.equal(authority.sourceEntryDigest.length, 64);
      assert.equal(authority.connector.resultLogicalKey, "draft.gate");
      assert.equal(authority.connector.catalogFingerprint.length, 64);
      assert.equal(authority.observations.length, 2);
      assert.equal(authority.observationFingerprints.length, 2);

      const applied = value.scenario.apply(value.scenario.replacement(
        "goal", "Retain the complete behavior explicitly.",
      ));
      assert.equal(applied.source.goal, "Retain the complete behavior explicitly.");
      const audit = value.flowManager.readArtifact({
        specId: value.scenario.specId, logicalKey: "draft.gate.repair", consumerNodeId: "draft-coverage-review",
      });
      const draft = value.flowManager.readArtifact({
        specId: value.scenario.specId, logicalKey: "draft", consumerNodeId: "draft-coverage-review",
      });
      const outcomeEntry = catalogEntry(value.flowManager, value.scenario.specId, "plan.gate.repair.outcome");
      const repairId = outcomeEntry.relativePath.match(/plan-gate-repairs\/([^/]+)\/outcome\.json$/)?.[1];
      const outcome = value.flowManager.readArtifact({
        specId: value.scenario.specId, logicalKey: "plan.gate.repair.outcome",
        parameters: { repairId }, consumerNodeId: "draft-gate-repair",
      });
      assert.equal(JSON.parse(audit.bytes).report.outputEvidenceDigest, draft.descriptor.hash);
      assert.equal(JSON.parse(outcome.bytes).report.outputEvidenceDigest, draft.descriptor.hash);
      assert.equal(JSON.parse(outcome.bytes).disposition, "applied");
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("rejects direct request creation without a Definition-selected repair before any side effect", () => {
    const value = setup("521-gate-repair-no-plan", { selectRepair: false });
    try {
      const beforeActivities = value.flowManager.activityLedger(value.fixture.specId).length;
      const beforeFiles = fs.readdirSync(value.root, { recursive: true }).map(String).sort();
      const scenario = new DraftGateRepairScenario({
        flowManager: value.flowManager, root: value.root, specId: value.fixture.specId,
      });
      assert.throws(() => scenario.coordinator.createRequest({
        ctx: scenario.ctx,
        state: value.flowManager.loadReadOnly(value.fixture.specId),
        invocation: {
          id: "unselected-draft-gate-repair", target: { digest: "b".repeat(64) },
          action: { digest: "a".repeat(64), nextAction: { step: "draft-gate-repair" } },
        },
      }), (error) => error.code === "FLOW_WORKER_ACTION_NOT_SELECTED");
      assert.equal(value.flowManager.activityLedger(value.fixture.specId).length, beforeActivities);
      assert.deepEqual(fs.readdirSync(value.root, { recursive: true }).map(String).sort(), beforeFiles);
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("persists semantic no-progress across a canonical reload", () => {
    const value = setup("521-gate-repair-no-progress");
    try {
      const request = value.scenario.createRequest();
      const payload = value.scenario.replacement("goal", "Incomplete retained behavior");
      payload.operations = [];
      seal(request, payload);
      const preparation = value.scenario.coordinator.prepareDraftWorker({
        ctx: value.scenario.ctx,
        request,
      });
      const result = value.scenario.coordinator.commitDraftWorker({
        ctx: value.scenario.ctx,
        request,
        preparation,
        stepOutput: new StepOutput(STEP_OUTPUT_TYPE.COMPLETED),
      });
      assert.equal(result.rejected, true);
      assert.equal(catalogEntry(value.flowManager, value.scenario.specId, "draft.gate.repair"), null);
      const outcomeEntry = catalogEntry(value.flowManager, value.scenario.specId, "plan.gate.repair.outcome");
      assert.notEqual(outcomeEntry, null);
      const reloaded = new FlowManager({
        root: value.root, mainRoot: value.root, inWorktree: false, specId: value.scenario.specId,
      });
      const reloadedEntry = catalogEntry(reloaded, value.scenario.specId, "plan.gate.repair.outcome");
      const repairId = reloadedEntry.relativePath.match(/plan-gate-repairs\/([^/]+)\/outcome\.json$/)?.[1];
      const persisted = reloaded.readArtifact({
        specId: value.scenario.specId, logicalKey: "plan.gate.repair.outcome",
        parameters: { repairId }, consumerNodeId: "system",
      });
      assert.equal(JSON.parse(persisted.bytes).disposition, "rejected-no-progress");
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("rejects malformed or unauthorized batches without partial draft, audit, or outcome publication", () => {
    const variants = [
      ["wrong base revision", (payload) => { payload.baseRevision = `sha256:${"f".repeat(64)}`; }],
      ["foreign fingerprint", (payload) => { payload.report.results[0].fingerprint = "f".repeat(64); }],
      ["duplicate fingerprint", (payload) => { payload.report.results[1].fingerprint = payload.report.results[0].fingerprint; }],
      ["missing observation result", (payload) => { payload.report.results.pop(); }],
      ["missing target", (payload) => { payload.operations[0].path = "analysis.missing"; payload.operations[0].expectedDigest = "f".repeat(64); }],
      ["stale target digest", (payload) => { payload.operations[0].expectedDigest = "f".repeat(64); }],
      ["duplicate target", (payload) => { payload.operations.push(structuredClone(payload.operations[0])); }],
      ["overlapping targets", (payload, request) => {
        const draft = request.inputs.find((entry) => entry.name === "draft.json").document;
        payload.operations[0].path = "analysis";
        payload.operations[0].expectedDigest = digest(draft.analysis);
        payload.operations[0].replacement = { ...draft.analysis, problem: "Parent replacement" };
        payload.operations.push({
          ...structuredClone(payload.operations[0]),
          path: "analysis.problem",
          expectedDigest: digest(draft.analysis.problem),
          replacement: "Child replacement",
        });
      }],
      ["question authority", (payload, request) => {
        const draft = request.inputs.find((entry) => entry.name === "draft.json").document;
        payload.operations[0].path = "questionLedger";
        payload.operations[0].expectedDigest = digest(draft.questionLedger);
        payload.operations[0].replacement = structuredClone(draft.questionLedger);
      }],
      ["oversized replacement", (payload) => { payload.operations[0].replacement = "x".repeat((32 * 1024) + 1); }],
      ["invalid lifecycle", (payload, request) => {
        const draft = request.inputs.find((entry) => entry.name === "draft.json").document;
        payload.operations[0].path = "analysis";
        payload.operations[0].expectedDigest = digest(draft.analysis);
        payload.operations[0].replacement = null;
      }],
      ["unknown full draft field", (payload, request) => {
        payload.draft = request.inputs.find((entry) => entry.name === "draft.json").document;
      }],
      ["missing report strategy", (payload) => { payload.report.results[0].strategy = ""; }],
    ];
    for (const [name, mutate] of variants) {
      const value = setup(`521-invalid-${name.replaceAll(" ", "-")}`);
      try {
        const request = value.scenario.createRequest();
        const draftBefore = value.flowManager.readArtifact({
          specId: value.scenario.specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair",
        }).descriptor.hash;
        const payload = value.scenario.replacement("goal", "Retain the complete behavior explicitly.");
        mutate(payload, request);
        seal(request, payload);
        assert.throws(
          () => value.scenario.coordinator.prepareDraftWorker({ ctx: value.scenario.ctx, request }),
          (error) => ["FLOW_ARTIFACT_HANDOFF_INVALID", "FLOW_ARTIFACT_HANDOFF_STALE", "FLOW_PLAN_GATE_REPAIR_REPORT_INVALID", "FLOW_DRAFT_GATE_REPAIR_INVALID"].includes(error.code),
          name,
        );
        assert.equal(findStepById(value.flowManager.loadReadOnly(value.scenario.specId).steps, "draft-gate-repair").status, "in_progress", name);
        assertNoRepairPublication(value.flowManager, value.scenario.specId, draftBefore);
      } finally {
        removeTmpDir(value.root);
      }
    }
  });

  it("rejects an output whose actual canonical serialization exceeds the byte limit", () => {
    const source = canonicalDraftDocument({ goal: "Incomplete retained behavior", questions: [] });
    source.decisionMap.knownFacts = Array.from({ length: 260_000 }, () => "x");
    assert.ok(Buffer.byteLength(JSON.stringify(source)) < 2 * 1024 * 1024);
    assert.ok(Buffer.byteLength(`${JSON.stringify(source, null, 2)}\n`) > 2 * 1024 * 1024);
    const value = setup("521-gate-repair-pretty-size", { draftDocument: source, compactDraft: true });
    try {
      const request = value.scenario.createRequest();
      const draftBefore = value.flowManager.readArtifact({
        specId: value.scenario.specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair",
      }).descriptor.hash;
      seal(request, value.scenario.replacement("goal", "Retain the complete behavior explicitly."));
      assert.throws(
        () => value.scenario.coordinator.prepareDraftWorker({ ctx: value.scenario.ctx, request }),
        (error) => ["FLOW_ARTIFACT_HANDOFF_INVALID", "FLOW_PLAN_GATE_REPAIR_REPORT_INVALID", "FLOW_DRAFT_GATE_REPAIR_INVALID"].includes(error.code),
      );
      assert.equal(findStepById(value.flowManager.loadReadOnly(value.scenario.specId).steps, "draft-gate-repair").status, "in_progress");
      assertNoRepairPublication(value.flowManager, value.scenario.specId, draftBefore);
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("rejects a sealed request after the canonical draft revision changes", () => {
    const value = setup("521-gate-repair-stale-revision");
    try {
      const request = value.scenario.createRequest();
      const payload = value.scenario.replacement("goal", "Retain the complete behavior explicitly.");
      seal(request, payload);
      const replacement = canonicalDraftDocument({ goal: "A concurrent canonical revision", questions: [] });
      value.flowManager.publishArtifacts({
        specId: value.scenario.specId, nodeId: "draft-gate-repair", artifactWrites: [{
          logicalKey: "draft", mediaType: "application/json",
          bytes: Buffer.from(`${JSON.stringify(replacement, null, 2)}\n`),
        }],
      });
      const concurrent = value.flowManager.readArtifact({
        specId: value.scenario.specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair",
      }).descriptor.hash;
      assert.throws(
        () => value.scenario.coordinator.prepareDraftWorker({ ctx: value.scenario.ctx, request }),
        (error) => error.code === "FLOW_ARTIFACT_HANDOFF_STALE",
      );
      assertNoRepairPublication(value.flowManager, value.scenario.specId, concurrent);
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("rejects a sealed request after its exact source issue evidence changes", () => {
    const value = setup("521-gate-repair-stale-evidence");
    try {
      const request = value.scenario.createRequest();
      seal(request, value.scenario.replacement("goal", "Retain the complete behavior explicitly."));
      const source = value.flowManager.readArtifact({
        specId: value.scenario.specId, logicalKey: "issue.log", consumerNodeId: "draft-gate-repair",
      });
      const changed = JSON.parse(source.bytes);
      changed.entries[0].observations[0].observed = "Concurrent evidence no longer matches the selected repair.";
      value.flowManager.publishArtifacts({
        specId: value.scenario.specId, nodeId: "draft-gate-repair", artifactWrites: [{
          logicalKey: "issue.log", mediaType: "application/json",
          bytes: Buffer.from(`${JSON.stringify(changed, null, 2)}\n`),
        }],
      });
      const draftBefore = value.flowManager.readArtifact({
        specId: value.scenario.specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair",
      }).descriptor.hash;
      assert.throws(() => value.scenario.coordinator.reconcile({ ctx: value.scenario.ctx, request }));
      assertNoRepairPublication(value.flowManager, value.scenario.specId, draftBefore);
    } finally {
      removeTmpDir(value.root);
    }
  });

  it("rejects a recurring observation report without prior-repair insufficiency", () => {
    const value = setup("521-gate-repair-recurrence");
    try {
      value.scenario.createRequest();
      value.scenario.apply(value.scenario.replacement(
        "goal", "Retain the complete behavior explicitly.",
        { strategy: "State the retained behavior in the goal" },
      ));
      value.fixture
        .settle("draft-coverage-review")
        .settle("draft-coverage-triage")
        .settle("draft-coverage-repair")
        .activate("draft-gate");
      const recurring = new DraftGateRepairScenario({
        flowManager: value.flowManager, root: value.root, specId: value.scenario.specId,
      }).select({ observations: observations(), issueLogId: "issue-521-gate-repair-recurrence-second" });
      const request = recurring.createRequest();
      const payload = recurring.replacement(
        "analysis.proposedApproach", "Check each retained behavior against its canonical evidence.",
        { strategy: "Trace each retained behavior to canonical evidence" },
      );
      assert.equal(payload.report.results.every((entry) => entry.priorRepairInsufficiency !== null), true);
      payload.report.results[0].priorRepairInsufficiency = null;
      const beforeCatalog = value.flowManager.artifactCatalog(value.scenario.specId);
      const before = {
        draft: value.flowManager.readArtifact({
          specId: value.scenario.specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair",
        }).descriptor.hash,
        audits: beforeCatalog.artifacts.filter((entry) => entry.logicalKey === "draft.gate.repair").length,
        outcomes: beforeCatalog.artifacts.filter((entry) => entry.logicalKey === "plan.gate.repair.outcome").length,
      };
      seal(request, payload);
      assert.throws(
        () => recurring.coordinator.prepareDraftWorker({ ctx: recurring.ctx, request }),
        (error) => error.code === "FLOW_ARTIFACT_HANDOFF_INVALID" || error.code === "FLOW_DRAFT_STEP_OUTPUT_REQUIRED",
      );
      const afterCatalog = value.flowManager.artifactCatalog(value.scenario.specId);
      assert.equal(value.flowManager.readArtifact({
        specId: value.scenario.specId, logicalKey: "draft", consumerNodeId: "draft-gate-repair",
      }).descriptor.hash, before.draft);
      assert.equal(afterCatalog.artifacts.filter((entry) => entry.logicalKey === "draft.gate.repair").length, before.audits);
      assert.equal(afterCatalog.artifacts.filter((entry) => entry.logicalKey === "plan.gate.repair.outcome").length, before.outcomes);
    } finally {
      removeTmpDir(value.root);
    }
  });
});
