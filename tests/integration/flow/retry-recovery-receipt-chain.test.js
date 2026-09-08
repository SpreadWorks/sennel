import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";

import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import {
  readRetryBaseline,
  retryEvidenceRouteForNode,
  RetryRecoveryReceipt,
} from "../../../src/flow/lib/retry-recovery.js";

function routeFor(state) {
  return retryEvidenceRouteForNode(state, state.attempt.nodeId);
}

function receiptSource(manager, state) {
  const route = routeFor(state);
  return manager.readArtifact({
    specId: state.specId,
    logicalKey: "retry.recovery.receipt",
    parameters: { routeId: `${route.kind}-${route.phase}-${route.taskId}`, attemptId: state.attempt.id },
    consumerNodeId: state.attempt.nodeId,
  });
}

function alteredReceiptManager(manager, state, alter, alterCatalog = (catalog) => catalog) {
  const source = receiptSource(manager, state);
  const document = alter(JSON.parse(source.bytes.toString("utf8")));
  const bytes = Buffer.from(`${JSON.stringify(document)}\n`, "utf8");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  const descriptor = { ...source.descriptor, hash };
  return {
    readArtifact(input) {
      const actual = manager.readArtifact(input);
      return actual?.relativePath === source.relativePath
        ? { ...actual, bytes, descriptor }
        : actual;
    },
    artifactCatalog(specId) {
      const catalog = manager.artifactCatalog(specId);
      return alterCatalog({
        ...catalog,
        artifacts: catalog.artifacts.map((entry) => entry.relativePath === source.relativePath ? { ...entry, hash } : entry),
      });
    },
    activityLedger(specId) { return manager.activityLedger(specId); },
  };
}

test("repeated exhausted recovery derives the active baseline from its cataloged receipt chain", (t) => {
  const scenario = new TaskReviewScenario(t).exhaust().changeEvidence(1);
  assert.equal(scenario.recover().reset, true);
  scenario.reload();
  const firstRecovery = scenario.state();
  const firstReceipt = new RetryRecoveryReceipt(JSON.parse(receiptSource(scenario.manager, firstRecovery).bytes.toString("utf8")));
  const recoveredBaseline = readRetryBaseline(scenario.manager, firstRecovery, routeFor(firstRecovery));
  assert.notEqual(recoveredBaseline, null);
  assert.equal(recoveredBaseline.equals(firstReceipt.current), true);

  scenario.exhaust().changeEvidence(2).reload();
  const exhaustedAgain = scenario.state();
  const chained = readRetryBaseline(scenario.manager, exhaustedAgain, routeFor(exhaustedAgain));
  assert.notEqual(chained, null);
  assert.equal(chained.equals(firstReceipt.current), true, "the receipt current baseline must bind the next failed Attempt");
  assert.equal(scenario.recover().reset, true);
  scenario.reload();
  assert.equal(scenario.state().attempt.sequence, exhaustedAgain.attempt.sequence + 1);
});

for (const [label, alter, alterCatalog] of [
  ["stale Attempt", (receipt) => ({ ...receipt, current: { ...receipt.current, attemptId: "stale-attempt" } })],
  ["wrong route", (receipt) => ({
    ...receipt,
    previous: { ...receipt.previous, route: { kind: "review", phase: "test", taskId: "T-1" } },
    current: { ...receipt.current, route: { kind: "review", phase: "test", taskId: "T-1" } },
  })],
  ["wrong catalog Activity", (receipt) => receipt, (catalog) => ({
    ...catalog,
    artifacts: catalog.artifacts.map((entry) => entry.logicalKey === "retry.recovery.receipt"
      ? { ...entry, activityId: "missing-recovery-activity" }
      : entry),
  })],
]) {
  test(`receipt baseline refuses ${label} evidence without mutating canonical state`, (t) => {
    const scenario = new TaskReviewScenario(t).exhaust().changeEvidence(1);
    assert.equal(scenario.recover().reset, true);
    scenario.reload();
    const state = scenario.state();
    const before = scenario.snapshot();
    const forged = alteredReceiptManager(scenario.manager, state, alter, alterCatalog);

    assert.throws(
      () => readRetryBaseline(forged, state, routeFor(state)),
      /retry recovery receipt (identity|is not a catalog-published Activity artifact|publication Activity)/,
    );
    assert.equal(scenario.snapshot(), before);
  });
}
