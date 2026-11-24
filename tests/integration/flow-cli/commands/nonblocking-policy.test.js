import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ImplPhaseScenario } from "../../../support/impl-phase-scenario.js";
import { SpecPhaseScenario } from "../../../support/spec-phase-scenario.js";
import { SeedWorkRoot } from "../../../support/builders/seed-work-root.js";
import { FlowManager } from "../../../../src/lib/flow-manager.js";
import { canonicalSourceFindings } from "../../../../src/flow/lib/flow-finding-source.js";
import { CanonicalCommandAttemptArtifactHistory } from "../../../../src/flow/lib/canonical-command-result.js";
import { SeedCleanupScope } from "../../../support/builders/seed-work-root.js";
import { CanonicalPersistenceSnapshot } from "../../../support/assertions/canonical-persistence.js";
import { RuntimeChildExecution } from "../../../../src/lib/runtime-package.js";
import { decisionContextForActiveFlow, definitionNonblockingEligibilityForActiveFlow,
  recordEligibleNonblockingAttempt } from "../../../../src/flow/lib/nonblocking.js";
import { recordNonBlockingDecision } from "../../../../src/flow/lib/nonblocking-decision.js";

const SENNEL = fileURLToPath(new URL("../../../../src/cli-main.js", import.meta.url));
const seedScope = new SeedCleanupScope(after, mock);
let unavailableReviewSeed;
let qualityGateSeed;

function invoke(root, args) {
  const result = RuntimeChildExecution.runSync(SENNEL, ["flow", ...args], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, SENNEL_WORK_ROOT: root, SENNEL_SOURCE_ROOT: root },
  }, spawnSync);
  return { ...result, envelope: JSON.parse(result.stdout) };
}

async function produceUnavailableReview(flow) {
  await flow.advanceTo("impl-review");
  const result = await flow.executeCurrent();
  flow.reload();
  const eligibility = definitionNonblockingEligibilityForActiveFlow(flow.root,
    flow.manager.loadReadOnly(flow.specId), flow.manager);
  assert.ok(eligibility, `the actual bounded Review stop must be eligible: ${JSON.stringify(result)}`);
  assert.equal(eligibility.sourceStep, "impl-review");
  assert.equal(eligibility.resultKind, "tooling");
  assert.equal(flow.current(), "impl-review");
  const saved = flow.manager.readCurrentStepSettlement({ specId: flow.specId, stepId: "impl-review" });
  assert.equal(saved.result.kind, "impl-review-tooling");
  assert.equal(saved.settlement.kind, "await");
  assert.ok(saved.result.evidence.toolingObservation);
}

async function canonicalCliScenario(t) {
  unavailableReviewSeed ??= ImplPhaseScenario.seed(seedScope, { frontier: "impl-review",
    config: { lang: "en", type: "base", docs: { languages: ["en"], defaultLanguage: "en" } },
    reviewProcessResult(stage, _ordinal, options) {
      const child = RuntimeChildExecution.runSync(stage === "impl-review"
        ? fileURLToPath(new URL("../../../support/infrastructure/impl-tooling-review-worker.js", import.meta.url))
        : fileURLToPath(new URL("../../../support/impl-phase-review-worker.js", import.meta.url)), [],
      stage === "impl-review" ? options : { ...options, env: { ...options.env,
        SENNEL_IMPL_SCENARIO_RESPONSE: JSON.stringify({ blockingFindings: [], nonBlockingImprovements: [] }) } }, spawnSync);
      return { ...child, ok: child.status === 0 };
    },
    prepare: produceUnavailableReview,
  });
  const flow = ImplPhaseScenario.fromSeed(t, await unavailableReviewSeed);
  const state = flow.manager.loadReadOnly(flow.specId);
  return { flow, root: flow.root, manager: flow.manager, specId: flow.specId,
    guards: ["--expect-run-id", state.runId, "--expect-no-issue", "--expect-spec", flow.specId] };
}

test("nonblocking policy reads cataloged V1 evidence and persists no legacy state fields", async (t) => {
  const scenario = await canonicalCliScenario(t);
  const { root, manager, specId, guards } = scenario;
  const activated = invoke(root, ["set", "policy", "nonblocking", "--reason", "Explicit acceptance disposition is required.", ...guards]);
  assert.equal(activated.status, 0, activated.stderr);
  assert.equal(activated.envelope.data.activatedStep, "impl-review");
  const persisted = manager.canonicalState(specId).toJSON();
  const activities = manager.activityLedger(specId);
  assert.equal(persisted.policy.nonblocking.enabled, true);
  assert.equal(Object.hasOwn(persisted, "nonblocking"), false);
  assert.equal(Object.hasOwn(persisted, "stepAttempts"), false);
  assert.equal(activities.at(-1).transition.nonblocking.kind, "observation");
  const decision = decisionContextForActiveFlow(root, manager.loadReadOnly(specId), manager);
  assert.equal(decision.resultKind, "tooling");
  const continued = invoke(root, ["set", "nonblocking-decision", "--choice", "continue",
    "--reason", "Continue with the exact unavailable Review obligation retained.",
    "--remaining-risk", "Acceptance must hold until complete implementation Review evidence is regenerated.",
    "--expect-evidence-digest", decision.evidenceDigest, ...guards]);
  assert.equal(continued.status, 0, continued.stderr);
  const after = manager.canonicalState(specId);
  assert.equal(after.findNode("impl-review").status, "done");
  assert.equal(after.findNode("impl-triage").status, "skipped");
  assert.equal(Object.hasOwn(manager.loadReadOnly(specId), "stepAttempts"), false);
});

test("CLI rejects a stale nonblocking digest while retaining the catalog observation", async (t) => {
  const scenario = await canonicalCliScenario(t);
  const activated = invoke(scenario.root, ["set", "policy", "nonblocking", "--reason", "Evidence needs a guarded decision.", ...scenario.guards]);
  assert.equal(activated.status, 0, activated.stderr);
  const before = new CanonicalPersistenceSnapshot(scenario.manager, scenario.specId);
  const stale = invoke(scenario.root, ["set", "nonblocking-decision", "--choice", "continue",
    "--reason", "This must remain guarded.", "--remaining-risk", "The evidence is durable.",
    "--expect-evidence-digest", "b".repeat(64), ...scenario.guards]);
  assert.notEqual(stale.status, 0);
  assert.equal(stale.envelope.errors[0].code, "NONBLOCKING_STALE_EVIDENCE");
  before.assertUnchanged(scenario.manager, scenario.specId, "stale decision");
  assert.equal(scenario.manager.activityLedger(scenario.specId)
    .filter((activity) => activity.transition.nonblocking?.kind === "observation").length, 1);
});

test("CLI target guards reject a mismatched canonical Flow before policy mutation", async (t) => {
  const scenario = await canonicalCliScenario(t);
  const before = new CanonicalPersistenceSnapshot(scenario.manager, scenario.specId);
  const rejected = invoke(scenario.root, ["set", "policy", "nonblocking", "--reason", "Wrong target must not mutate.",
    "--expect-run-id", "other-run", "--expect-no-issue", "--expect-spec", scenario.specId]);
  assert.notEqual(rejected.status, 0);
  assert.equal(scenario.manager.loadReadOnly(scenario.specId).policy.nonblocking, null);
  before.assertUnchanged(scenario.manager, scenario.specId, "wrong Flow guard");
});

test("CLI activation records refreshed canonical review evidence from the current producer Attempt", async (t) => {
  const scenario = await canonicalCliScenario(t);
  const activated = invoke(scenario.root, ["set", "policy", "nonblocking", "--reason", "The bounded Review evaluator is unavailable.", ...scenario.guards]);
  assert.equal(activated.status, 0, activated.stderr);
  const context = decisionContextForActiveFlow(scenario.root, scenario.manager.loadReadOnly(scenario.specId), scenario.manager);
  recordNonBlockingDecision({ root: scenario.root, flowManager: scenario.manager, choice: "retry",
    reason: "Open a fresh producer Attempt for the corrected review.",
    expectEvidenceDigest: context.evidenceDigest, expectIdentity: context.identity().toJSON() });
  await produceUnavailableReview(scenario.flow);
  recordEligibleNonblockingAttempt({ root: scenario.root, flowManager: scenario.manager,
    flowState: scenario.manager.loadReadOnly(scenario.specId) }, "impl-review");
  const observations = scenario.manager.activityLedger(scenario.specId)
    .map((activity) => activity.transition.nonblocking).filter((record) => record?.kind === "observation");
  assert.equal(observations.length, 2);
  assert.equal(observations.at(-1).sourceAttempt,
    scenario.manager.canonicalState(scenario.specId).findNode("impl-review").attemptSequence);
  assert.ok(observations.at(-1).sourceAttempt > observations[0].sourceAttempt);
  assert.notEqual(observations.at(-1).evidenceDigest, observations[0].evidenceDigest);
});


test("CLI quality continuation retains exact findings from the normally exhausted Spec Gate", async (t) => {
  qualityGateSeed ??= SpecPhaseScenario.seed(seedScope);
  const seed = await qualityGateSeed;
  const clone = new SeedWorkRoot(seed.root, { prefix: "sennel-cli-quality-gate-" });
  t.after(() => clone.cleanup());
  const root = clone.root;
  const manager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId: seed.specId });
  seed.assertClone(manager);
  const state = manager.loadReadOnly(seed.specId);
  const guards = ["--expect-run-id", state.runId, "--expect-no-issue", "--expect-spec", seed.specId];
  const source = manager.readProducerArtifact({ specId: seed.specId, nodeId: "spec-gate", logicalKey: "spec.gate" });
  const payload = CanonicalCommandAttemptArtifactHistory.fromBytes({ logicalKey: "spec.gate", bytes: source.bytes }).current.payload;
  const findings = canonicalSourceFindings({ artifact: payload, sourceStep: "spec-gate", sourceArtifact: source.relativePath });
  assert.ok(findings.length > 0);
  const activated = invoke(root, ["set", "policy", "nonblocking", "--reason", "Retain the bounded quality findings for Acceptance.", ...guards]);
  assert.equal(activated.status, 0, activated.stderr);
  assert.equal(activated.envelope.data.activatedStep, "spec-gate");
  const context = decisionContextForActiveFlow(root, manager.loadReadOnly(seed.specId), manager);
  assert.equal(context.resultKind, "quality");
  const continued = invoke(root, ["set", "nonblocking-decision", "--choice", "continue",
    "--reason", "Carry the actual Spec Gate quality findings to Acceptance.",
    "--remaining-risk", "Acceptance must dispose of the unresolved specification finding.",
    "--expect-evidence-digest", context.evidenceDigest, ...guards]);
  assert.equal(continued.status, 0, continued.stderr);
  assert.equal(manager.canonicalState(seed.specId).findNode("spec-gate").status, "done");
  const retained = JSON.parse(manager.readArtifact({ specId: seed.specId,
    logicalKey: "flow.findings", consumerNodeId: "acceptance-review" }).bytes.toString("utf8"));
  const selected = retained.entries.filter(entry => entry.sourceStep === "spec-gate");
  assert.equal(selected.length, findings.length);
  for (const entry of selected) {
    const original = findings.find(finding => finding.identity.sourceFindingId === entry.sourceFindingId);
    assert.ok(original);
    assert.equal(entry.sourceArtifact, source.relativePath);
    assert.equal(entry.fingerprint, original.identity.fingerprint);
    assert.equal(entry.retryExhausted, true);
  }
  assert.equal(manager.readArtifact({ specId: seed.specId, consumerNodeId: "approval",
    logicalKey: "spec.gate" }).descriptor.hash, source.descriptor.hash);
});
