import assert from "node:assert/strict";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

import { FlowManager } from "../../../../src/lib/flow-manager.js";
import { FlowArtifactAttemptHistory, FlowArtifactAttemptRecord } from "../../../../src/lib/flow-artifact-contract.js";
import { CanonicalFlowFixture } from "../../../support/infrastructure/flow-setup.js";
import {
  decisionContextForActiveFlow,
  recordEligibleNonblockingAttempt,
  recordNonBlockingDecision,
} from "../../../../src/flow/lib/nonblocking.js";
import { createTmpDir, removeTmpDir, writeJson } from "../../../support/builders/tmp-dir.js";
import { commitAll, initGitRepo } from "../../../support/infrastructure/git-repo.js";

const SENNEL = path.resolve("src/sennel.js");

function invoke(root, args) {
  const result = spawnSync(process.execPath, [SENNEL, "flow", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root },
  });
  return { ...result, envelope: JSON.parse(result.stdout) };
}

function history(nodeId, logicalKey, payload, attempt = 1, prefix = []) {
  return Buffer.from(`${JSON.stringify(new FlowArtifactAttemptHistory([
    ...prefix,
    new FlowArtifactAttemptRecord({ attempt, payload: {
      nodeId, outcome: "completed", result: { result: "block" }, artifact: { logicalKey, payload },
    } }),
  ]).toJSON(), null, 2)}\n`, "utf8");
}

function rejectedReviewPayload(summary, fingerprint = "a".repeat(64)) {
  const finding = {
    fingerprint,
    disposition: "deferred",
    rationale: "Acceptance must retain this canonical semantic finding.",
  };
  return {
    version: 1,
    phase: "impl",
    verdict: "REJECTED",
    summary,
    blockingFindings: [finding],
    nonBlockingImprovements: [],
    canonicalEvidence: {
      phase: "impl",
      disposition: "REJECTED",
      identity: { evidenceDigest: "b".repeat(64) },
      blockingFindings: [finding],
      advisoryFindings: [],
    },
  };
}

function canonicalCliScenario({ specId, runId, step, logicalKey, payload }) {
  const root = createTmpDir("sennel-canonical-nonblocking-e2e-");
  writeJson(root, ".sennel/config.json", {
    lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" }, commands: { gh: "disable" },
  });
  initGitRepo(root);
  commitAll(root, "initial canonical fixture");
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
  const fixture = new CanonicalFlowFixture({ flowManager: manager, specId, runId })
    .create().registerActive().activate(step);
  manager.publishArtifacts({
    specId: fixture.specId, nodeId: step,
    artifactWrites: [{ logicalKey, mediaType: "application/json", bytes: history(step, logicalKey, payload) }],
  });
  if (step === "impl-review") {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      manager.appendMetric({ phase: "impl", counter: "reviewRetry", delta: 1 }, { taskId: null });
    }
  }
  return { root, manager, fixture, guards: ["--expect-run-id", runId, "--expect-no-issue", "--expect-spec", specId] };
}

test("nonblocking policy reads cataloged V1 evidence and persists no legacy state fields", () => {
  const root = createTmpDir("sennel-canonical-nonblocking-e2e-");
  try {
    writeJson(root, ".sennel/config.json", {
      lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" }, commands: { gh: "disable" },
    });
    initGitRepo(root);
    commitAll(root, "initial canonical fixture");
    const manager = new FlowManager({ root, mainRoot: root, inWorktree: false });
    const fixture = new CanonicalFlowFixture({ flowManager: manager, specId: "477-nonblocking-e2e", runId: "run-477" })
      .create().registerActive().activate("impl-review");
    manager.publishArtifacts({
      specId: fixture.specId,
      nodeId: "impl-review",
      artifactWrites: [{
        logicalKey: "impl.review",
        mediaType: "application/json",
        bytes: history("impl-review", "impl.review", rejectedReviewPayload("Cataloged rejected review.")),
      }],
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      manager.appendMetric({ phase: "impl", counter: "reviewRetry", delta: 1 }, { taskId: null });
    }

    const guards = ["--expect-run-id", "run-477", "--expect-no-issue", "--expect-spec", fixture.specId];
    const activated = invoke(root, ["set", "policy", "nonblocking", "--reason", "Explicit acceptance disposition is required.", ...guards]);
    assert.equal(activated.status, 0, activated.stderr);
    assert.equal(activated.envelope.data.activatedStep, "impl-review");
    const persisted = manager.canonicalState(fixture.specId).toJSON();
    const activities = manager.activityLedger(fixture.specId);
    assert.equal(persisted.policy.nonblocking.enabled, true);
    assert.equal(Object.hasOwn(persisted, "nonblocking"), false);
    assert.equal(Object.hasOwn(persisted, "stepAttempts"), false);
    assert.equal(activities.at(-1).transition.nonblocking.kind, "observation");
    const decisionPayload = rejectedReviewPayload("Cataloged rejected review.");
    const continued = invoke(root, [
      "set", "nonblocking-decision", "--choice", "continue",
      "--reason", "The requested behavior is complete despite the review finding.",
      "--remaining-risk", "The rejected review remains in the acceptance evidence.",
      "--expect-evidence-digest", crypto.createHash("sha256").update(`${JSON.stringify(decisionPayload, null, 2)}\n`).digest("hex"),
      ...guards,
    ]);
    assert.equal(continued.status, 0, continued.stderr);
    const after = manager.load(fixture.specId);
    assert.equal(after.steps.flatMap((entry) => entry.children || [entry]).find((entry) => entry.id === "impl-review").status, "done");
    assert.equal(after.steps.flatMap((entry) => entry.children || [entry]).find((entry) => entry.id === "impl-triage").status, "skipped");
    assert.equal(Object.hasOwn(after, "stepAttempts"), false);
  } finally {
    removeTmpDir(root);
  }
});

test("CLI rejects a stale nonblocking digest while retaining the catalog observation", () => {
  const scenario = canonicalCliScenario({
    specId: "478-nonblocking-stale", runId: "run-478", step: "impl-review", logicalKey: "impl.review",
    payload: rejectedReviewPayload("Canonical review evidence remains guarded."),
  });
  try {
    const activated = invoke(scenario.root, ["set", "policy", "nonblocking", "--reason", "Evidence needs a guarded decision.", ...scenario.guards]);
    assert.equal(activated.status, 0, activated.stderr);
    const stale = invoke(scenario.root, [
      "set", "nonblocking-decision", "--choice", "continue", "--reason", "This must remain guarded.",
      "--remaining-risk", "The evidence is durable.", "--expect-evidence-digest", "b".repeat(64), ...scenario.guards,
    ]);
    assert.notEqual(stale.status, 0);
    assert.equal(stale.envelope.errors[0].code, "NONBLOCKING_STALE_EVIDENCE");
    assert.equal(scenario.manager.activityLedger(scenario.fixture.specId).filter((activity) => activity.transition.nonblocking?.kind === "observation").length, 1);
  } finally { removeTmpDir(scenario.root); }
});

test("CLI target guards reject a mismatched canonical Flow before policy mutation", () => {
  const scenario = canonicalCliScenario({
    specId: "479-nonblocking-guard", runId: "run-479", step: "impl-review", logicalKey: "impl.review",
    payload: rejectedReviewPayload("Canonical review evidence remains guarded."),
  });
  try {
    const rejected = invoke(scenario.root, [
      "set", "policy", "nonblocking", "--reason", "Wrong target must not mutate.",
      "--expect-run-id", "other-run", "--expect-no-issue", "--expect-spec", scenario.fixture.specId,
    ]);
    assert.notEqual(rejected.status, 0);
    assert.equal(scenario.manager.load(scenario.fixture.specId).policy.nonblocking, null);
  } finally { removeTmpDir(scenario.root); }
});
test("CLI activation records refreshed canonical review evidence from the current producer Attempt", () => {
  const firstPayload = rejectedReviewPayload("First canonical review.");
  const scenario = canonicalCliScenario({
    specId: "480-nonblocking-review", runId: "run-480", step: "impl-review", logicalKey: "impl.review",
    payload: firstPayload,
  });
  try {
    const activated = invoke(scenario.root, ["set", "policy", "nonblocking", "--reason", "Review recovery is exhausted.", ...scenario.guards]);
    assert.equal(activated.status, 0, activated.stderr);
    const context = decisionContextForActiveFlow(
      scenario.root,
      scenario.manager.load(scenario.fixture.specId),
      scenario.manager,
    );
    recordNonBlockingDecision({
      root: scenario.root,
      flowManager: scenario.manager,
      choice: "repair",
      reason: "Open a fresh producer Attempt for the corrected review.",
      expectEvidenceDigest: context.evidenceDigest,
      expectIdentity: context.identity().toJSON(),
    });
    const refreshedPayload = {
      ...firstPayload,
      summary: "Refreshed canonical review.",
    };
    scenario.manager.publishArtifacts({
      specId: scenario.fixture.specId, nodeId: "impl-review",
      artifactWrites: [{ logicalKey: "impl.review", mediaType: "application/json", bytes: history(
        "impl-review", "impl.review", refreshedPayload, 2,
        [new FlowArtifactAttemptRecord({ attempt: 1, payload: {
          nodeId: "impl-review", outcome: "completed", result: { result: "block" },
          artifact: { logicalKey: "impl.review", payload: firstPayload },
        } })],
      ) }],
    });
    recordEligibleNonblockingAttempt({ root: scenario.root, flowManager: scenario.manager, flowState: scenario.manager.load(scenario.fixture.specId) }, "impl-review");
    const observations = scenario.manager.activityLedger(scenario.fixture.specId)
      .map((activity) => activity.transition.nonblocking)
      .filter((record) => record?.kind === "observation");
    assert.equal(observations.length, 2);
    assert.equal(observations.at(-1).sourceAttempt, 2);
    assert.notEqual(observations.at(-1).evidenceDigest, observations[0].evidenceDigest);
  } finally { removeTmpDir(scenario.root); }
});
