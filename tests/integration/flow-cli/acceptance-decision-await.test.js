import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, mock, test } from "node:test";
import { AcceptancePhaseScenario, acceptanceProviderResponse } from "../../support/acceptance-phase-scenario.js";
import { executeAcceptanceReviewInput } from "../../../src/flow/lib/run-acceptance-review.js";

describe("Acceptance decision persists its own tokenless Await", { concurrency: false }, () => {
  let seed;
  const cleanups = [];
  after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });
  before(async () => {
    seed = await AcceptancePhaseScenario.seed({ mock, after(cleanup) { cleanups.push(cleanup); } }, {
      frontier: "acceptance-review",
      acceptanceResponse: (_ordinal, scenario) => acceptanceProviderResponse(scenario, { status: "notVerifiable" }),
    });
  });

  for (const interrupted of [false, true]) {
    test(`${interrupted ? "interrupted Review handoff resumes" : "Review handoff enters"} an exact decision Await before explicit choice`, async (t) => {
      const flow = AcceptancePhaseScenario.fromSeed(t, seed);
      const failure = new Error("decision Await persistence interrupted after Review activation");
      let injected = false;
      if (interrupted) flow.reload({ versionStoreFaultInjector({ phase, activity }) {
        if (!injected && phase === "activity-ready-to-append" && activity.nodeId === "acceptance-decision") {
          injected = true;
          throw failure;
        }
      } });
      const reviewed = await flow.runRegistered("acceptance-review");
      assert.equal(interrupted ? reviewed.ok === false : reviewed.verdict === "user_decision_required", true,
        JSON.stringify(reviewed));
      assert.equal(injected, interrupted);
      flow.reload();
      const read = () => flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "acceptance-decision" });
      const source = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "acceptance-review", completed: true });
      assert.equal(source.result.kind, "acceptance-review-decision-required");
      assert.equal(flow.current(), "acceptance-decision");
      const targetAttempt = flow.state().attempt;
      if (interrupted) assert.equal(read(), null);
      else assert.equal(read().result.kind, "acceptance-decision-awaiting-choice");
      const beforeRead = flow.snapshot();
      const projected = await flow.next();
      assert.equal(projected.directive.kind, "await_user_decision");
      assert.deepEqual(flow.reload().snapshot(), beforeRead, "get-next-action cannot persist an Await");
      const calls = flow.acceptanceCalls.length;
      const boundary = await flow.dispatch(1);
      assert.equal(boundary.dispatch.boundary, "await_user_decision");
      flow.reload();
      const awaiting = read();
      assert.equal(awaiting.result.kind, "acceptance-decision-awaiting-choice");
      assert.equal(awaiting.result.evidence.choice, null);
      assert.equal(awaiting.result.evidence.publication, null);
      assert.equal(awaiting.result.evidence.sourcePublication.producerActivityId, source.activityId);
      assert.equal(awaiting.receipt.settlementKind, "await");
      assert.equal(awaiting.receipt.binding.attemptId, targetAttempt.id);
      assert.equal(awaiting.receipt.binding.attemptSequence, targetAttempt.sequence);
      assert.equal(awaiting.receipt.connector, null);
      assert.equal(awaiting.receipt.targetStepId, null);
      assert.equal(flow.manager.readArtifact({ specId: flow.specId, logicalKey: "acceptance.decision",
        consumerNodeId: "final-regression", optional: true }), null, "waiting cannot fabricate a choice artifact");
      flow.assertResults(["acceptance-decision"]);
      const beforeReplay = flow.snapshot();
      const replayedReceipt = await executeAcceptanceReviewInput({ flowManager: flow.manager,
        specId: flow.specId, stepId: "acceptance-decision", receipt: awaiting.receipt });
      assert.equal(replayedReceipt.id, awaiting.receipt.id);
      assert.deepEqual(flow.snapshot(), beforeReplay, "an artifactless Await replays only its exact current receipt");
      assert.equal(flow.acceptanceCalls.length, calls);
      await flow.dispatch(1);
      flow.reload();
      assert.deepEqual(flow.snapshot(), beforeReplay, "repeated dispatch must replay its exact existing Await receipt");
      assert.equal(read().receipt.id, awaiting.receipt.id);
      assert.equal(flow.acceptanceCalls.length, calls);
      const selected = await flow.acceptDecision("accept_risk_and_continue");
      assert.equal(selected.choice, "accept_risk_and_continue", JSON.stringify(selected));
      flow.reload();
      assert.equal(flow.current(), "final-regression");
      const completed = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "acceptance-decision", completed: true });
      assert.equal(completed.result.kind, "acceptance-decision-risk-accepted");
      assert.equal(completed.receipt.binding.attemptId, awaiting.receipt.binding.attemptId);
      assert.ok(flow.manager.activityLedger(flow.specId).some((entry) => entry.result?.draftSettlementReceipt?.id === awaiting.receipt.id));
      assert.equal(flow.commandArtifact("acceptance.decision", "final-regression").payload.acceptanceReviewDigest,
        awaiting.result.evidence.reviewDigest);
      flow.assertResults(["acceptance-decision"]);
    });
  }

  test("project policy without a supported command persists skipped regression through report and 05 admission", async (t) => {
    const flow = AcceptancePhaseScenario.fromSeed(t, seed, {
      acceptanceResponse: (_ordinal, scenario) => acceptanceProviderResponse(scenario),
    });
    await flow.advanceTo("final-regression");
    const packagePath = path.join(flow.root, "package.json");
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    delete pkg.scripts.test;
    fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    const configPath = path.join(flow.root, ".sennel", "config.json");
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
    assert.equal(Object.hasOwn(config.test ?? {}, "command"), false);
    const result = await flow.runRegistered("final-regression");
    assert.equal(result.result, "skipped", JSON.stringify(result));
    flow.reload();
    const saved = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "final-regression", completed: true });
    assert.equal(saved.result.kind, "final-regression-policy-skipped");
    const artifact = flow.commandArtifact("final.regression", "report");
    assert.equal(artifact.payload.result, "skipped");
    assert.equal(artifact.payload.skipKind, "skipped_by_project_policy");
    assert.equal(Object.hasOwn(artifact.payload, "executionBinding"), false, "policy skip cannot fabricate an executed process");
    assert.equal(artifact.payload.process.started, false);
    assert.deepEqual(artifact.payload.childProcesses, []);
    assert.equal(artifact.payload.proof.commandDiscovery.supportedCommandFound, false);
    assert.equal(artifact.payload.proof.commandDiscovery.invalidConfiguredCommand, false);
    assert.ok(artifact.payload.proof.commandDiscovery.checkedSources.length > 0);
    assert.equal(flow.current(), "report");
    flow.assertResults(["final-regression"]);
    await flow.advanceTo("report");
    const report = await flow.runRegistered("report");
    assert.equal(report.result, "ok", JSON.stringify(report));
    flow.reload();
    assert.equal(JSON.parse(flow.artifact("report").bytes).data.tests.finalRegression.result, "skipped");
    await flow.advanceTo("finalize-commit");
    const commit = await flow.runRegistered("finalize-commit");
    assert.equal(commit.status, "done", JSON.stringify(commit));
    flow.reload();
    flow.assertResults(["final-regression", "report"]);
  });
});
