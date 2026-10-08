import assert from "node:assert/strict";
import { it } from "node:test";
import { TaskReviewScenario } from "../../support/builders/task-review-scenario.js";
import { container } from "../../../src/lib/container.js";
import RunGateCommand from "../../../src/flow/lib/run-gate.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { activateNonBlockingPolicy, decisionContextForActiveFlow, recordNonBlockingDecision } from "../../../src/flow/lib/nonblocking.js";
import { StepResult } from "../../../src/flow/engine/step-result.js";
import { settleTaskStepResult, DraftStepSettlementReceipt } from "../../../src/flow/definition.js";
import { ImplementationReviewProducer } from "../../support/infrastructure/implementation-review-producer.js";
import { FlowManager } from "../../../src/lib/flow-manager.js";
import { ImplPhaseScenario } from "../../support/impl-phase-scenario.js";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { settleImplStepResult } from "../../../src/flow/definition.js";
import { writeJson } from "../../support/builders/tmp-dir.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createTmpDir, removeTmpDir } from "../../support/builders/tmp-dir.js";
import { CanonicalReviewInputDescriptor } from "../../../src/flow/lib/review-work-unit-input.js";

it("continues an actual Task Gate tooling Error with a receipt-bound decision and no new evaluation", async (t) => {
  const scenario = new TaskReviewScenario(t);
  const review = await new ImplementationReviewProducer().publish(scenario.context());
  assert.notEqual(review.ok, false, JSON.stringify(review));
  assert.equal(scenario.state().current.at(-1), "T-1-gate");
  const originalGet = container.get.bind(container);
  t.after(() => { container.get = originalGet; });
  container.get = (key) => key === "agent" ? { resolve: () => false } : originalGet(key);
  const ctx = { ...scenario.context(), phase: "task-impl", skipGuardrail: true };
  await FLOW_COMMANDS.run.gate.pre(ctx);
  const observed = await new RunGateCommand().execute(ctx);
  await FLOW_COMMANDS.run.gate.post(ctx, observed);
  scenario.reload();
  const source = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "task-gate" });
  assert.equal(source.result.type, "error");
  const originalEvidence = source.result.error.data.evidence;
  const originalAttempt = scenario.state().attempt;
  activateNonBlockingPolicy({ root: scenario.root, flowManager: scenario.manager,
    reason: "The unavailable evaluator has an explicit acceptance path." });
  const decision = decisionContextForActiveFlow(scenario.root, scenario.manager.loadReadOnly(scenario.specId), scenario.manager);
  const input = { root: scenario.root, flowManager: scenario.manager, choice: "continue",
    reason: "Continue with the unavailable evaluation recorded.", remainingRisk: "Acceptance must retain the unavailable Task Gate.",
    expectEvidenceDigest: decision.evidenceDigest };
  const commit = scenario.manager.commitSpecStepResult.bind(scenario.manager);
  for (const field of ["sourceReceiptId", "sourceResultDigest", "publicationBytes", "oldAttempt"]) {
    const snapshot = scenario.snapshot();
    scenario.manager.commitSpecStepResult = (candidate) => {
      if (field === "oldAttempt") return commit({ ...candidate, binding: candidate.nonblockingPublication.sourceBinding });
      if (field === "publicationBytes") {
        candidate.nonblockingPublication.artifactWrites[0].bytes[0] ^= 1;
        return commit(candidate);
      }
      const stored = candidate.stepResult.toJSON();
      stored.evidence.acceptedDecision[field] = "f".repeat(64);
      const stepResult = StepResult.fromStored("task-gate", stored);
      return commit({ ...candidate, stepResult, settlement: settleTaskStepResult("task-gate", stepResult) });
    };
    assert.throws(() => recordNonBlockingDecision(input), (error) =>
      error.code === "CURRENT_FLOW_STATE_CONFLICT" || error.cause?.code === "CURRENT_FLOW_STATE_CONFLICT");
    scenario.manager.commitSpecStepResult = commit;
    assert.equal(scenario.snapshot(), snapshot, `${field} forgery must leave canonical state, catalog and Activities unchanged`);
  }
  const catalogFile = scenario.manager.specLocation(scenario.specId).catalogFile;
  const snapshot = scenario.snapshot();
  let interrupted = false;
  const refusedManager = new FlowManager({ root: scenario.root, mainRoot: scenario.root, inWorktree: false,
    versionStoreFaultInjector({ phase, filePath }) {
      if (!interrupted && phase === "before-json-rename" && filePath === catalogFile) {
        interrupted = true;
        throw new Error("acceptance publication before catalog rename");
      }
    } });
  assert.throws(() => recordNonBlockingDecision({ ...input, flowManager: refusedManager }), /before catalog rename/);
  assert.equal(interrupted, true);
  scenario.reload();
  assert.equal(scenario.snapshot(), snapshot, "a precommit decision failure leaves the original stop and publications unchanged");
  const before = scenario.manager.activityLedger(scenario.specId).length;
  let responseLost = false;
  const committedManager = new FlowManager({ root: scenario.root, mainRoot: scenario.root, inWorktree: false,
    versionStoreFaultInjector({ phase, filePath }) {
      if (!responseLost && phase === "before-json-directory-fsync" && filePath === catalogFile) {
        responseLost = true;
        throw new Error("accepted decision committed response loss");
      }
    } });
  const completed = recordNonBlockingDecision({ ...input, flowManager: committedManager });
  assert.equal(responseLost, true, "the response-loss probe must reach the real catalog publication boundary");
  scenario.reload();
  const state = scenario.state();
  assert.equal(state.findNode("T-1-gate").status, "done");
  assert.equal(state.nextAction().nodeId, "test-execute");
  assert.equal(scenario.manager.activityLedger(scenario.specId).length, before + 1);
  const terminal = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "task-gate", taskId: "T-1", completed: true });
  assert.equal(terminal.result.kind, "task-gate-awaiting-decision");
  const result = StepResult.fromStored("task-gate", terminal.result.toJSON());
  const settlement = settleTaskStepResult("task-gate", result);
  assert.equal(settlement.kind, "target-connection");
  DraftStepSettlementReceipt.assertStored(terminal.receipt, { result, settlement, binding: {
    runId: state.runId, specId: state.specId, stepId: "task-gate",
    attempt: { id: terminal.receipt.binding.attemptId, sequence: originalAttempt.sequence + 1 },
  } });
  const accepted = result.evidence.acceptedDecision;
  assert.equal(accepted.sourceReceiptId, source.receipt.id);
  assert.equal(accepted.sourceResultDigest, source.receipt.resultDigest);
  assert.notEqual(terminal.receipt.id, source.receipt.id);
  const evidence = result.evidence.toJSON();
  delete evidence.acceptedDecision;
  assert.deepEqual(evidence, originalEvidence);
  assert.equal(state.findNode("T-1-gate").attemptSequence, originalAttempt.sequence + 1);
  assert.deepEqual(recordNonBlockingDecision({ ...input, flowManager: scenario.manager }), completed);
  assert.equal(scenario.manager.activityLedger(scenario.specId).length, before + 1);
});

it("admits only the reacquired nominal quality selection and preserves an unparented plain Review failure", async (t) => {
  const scenario = ImplPhaseScenario.create(t, { gateResponse(_prompt, options, current) {
    if (current.current() !== "impl-gate" || !(options.jsonSchema?.required ?? []).includes("evaluations")) return null;
    return JSON.stringify({ evaluations: options.jsonSchema.properties.evaluations.items.properties.guardrail_id.enum
      .map((guardrail_id) => ({ guardrail_id, result: "fail",
        reason: `[REQ:${guardrail_id}] Evaluation ${current.state().attempt.sequence} confirms the required behavior remains unresolved.` })) });
  } });
  writeJson(scenario.root, ".sennel/config.json", { lang: "en", type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" } });
  const guardrailPath = path.join(scenario.root, ".sennel/guardrail.json");
  const guardrail = JSON.parse(fs.readFileSync(guardrailPath, "utf8"));
  guardrail.guardrails.push({ id: "R1", title: "Required behavior", body: "The mapped behavior must be implemented.",
    meta: { phase: ["integration"], category: "requirements" } });
  fs.writeFileSync(guardrailPath, JSON.stringify(guardrail));
  await scenario.advanceTo("impl-review");
  // Read-only standalone CLI input is captured from the real catalog. It has
  // no parent work-unit identity and cannot publish or replace this producer.
  const controlRoot = createTmpDir("unparented-review-input-");
  t.after(() => removeTmpDir(controlRoot));
  fs.mkdirSync(path.join(controlRoot, "inputs"));
  const environment = { ...process.env, SENNEL_REVIEW_OUTPUT_DIR: controlRoot,
    SENNEL_IMPL_SCENARIO_PLAIN_FAILURE: "true" };
  delete environment.SENNEL_REVIEW_WORK_UNIT_MANIFEST;
  for (const [logicalKey, logicalPath, variable] of [
    ["spec.record", "spec.json", "SENNEL_REVIEW_SPEC_SOURCE"],
    ["file.map", "file-map.json", "SENNEL_REVIEW_FILE_MAP_SOURCE"],
  ]) {
    const bytes = scenario.manager.readArtifact({ specId: scenario.specId, logicalKey, consumerNodeId: "impl-review" }).bytes;
    const sourcePath = path.join(controlRoot, "inputs", logicalPath);
    fs.writeFileSync(sourcePath, bytes);
    environment[variable] = JSON.stringify(new CanonicalReviewInputDescriptor({ version: 1, logicalKey, logicalPath,
      sourcePath, digest: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length }).toJSON());
  }
  const snapshot = () => JSON.stringify({ state: scenario.state(), activities: scenario.manager.activityLedger(scenario.specId),
    catalog: scenario.manager.artifactCatalog(scenario.specId) });
  const beforePlain = snapshot();
  const plain = spawnSync(process.execPath,
    [fileURLToPath(new URL("../../support/infrastructure/impl-tooling-review-worker.js", import.meta.url))],
    { cwd: scenario.root, env: environment, encoding: "utf8" });
  assert.equal(plain.status, 1);
  assert.match(plain.stderr, /UNPARENTED_ORIGINAL_PROVIDER_FAILURE/);
  assert.doesNotMatch(plain.stderr, /SENNEL_REVIEW_WORK_UNIT_MANIFEST.*required/);
  assert.equal(fs.existsSync(path.join(controlRoot, "impl-review.json")), false);
  assert.equal(snapshot(), beforePlain);

  await scenario.advanceTo("impl-gate");
  const limit = scenario.state().definition.contractForNode(scenario.state().findNode("impl-gate")).semanticRetryLimit + 2;
  let outcome;
  for (let count = 0; count < limit; count += 1) {
    const ctx = { ...scenario.context(), phase: "integration" };
    await FLOW_COMMANDS.run.gate.pre(ctx);
    outcome = await new RunGateCommand().execute(ctx);
    await FLOW_COMMANDS.run.gate.post(ctx, outcome);
    scenario.reload();
    if (ctx.gateTransitionDecision?.disposition.operation === "defer") break;
  }
  const source = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "impl-gate" });
  assert.ok(source, JSON.stringify({ outcome, current: scenario.state().current, next: scenario.state().nextAction() }));
  assert.equal(source.result.kind, "impl-gate-semantic-failure");
  assert.equal(source.settlement.application.decision.disposition.operation, "defer");

  activateNonBlockingPolicy({ root: scenario.root, flowManager: scenario.manager, reason: "Keep the actual semantic Gate risk explicit." });
  const context = decisionContextForActiveFlow(scenario.root, scenario.manager.loadReadOnly(scenario.specId), scenario.manager);
  assert.equal(context.resultKind, "quality");
  const prepare = scenario.manager.prepareAcceptedNonblockingPublication.bind(scenario.manager);
  let admitted;
  scenario.manager.prepareAcceptedNonblockingPublication = (input) => {
    const before = snapshot();
    for (const changed of [{ acceptancePublication: "nonblocking-handoff" }, { selectedFindingFingerprints: [] }]) {
      assert.throws(() => prepare({ ...input, eligibility: { ...input.eligibility, ...changed } }),
        (error) => error.code === "CURRENT_FLOW_STATE_CONFLICT");
      assert.equal(snapshot(), before, "a copied selection must leave state, catalog and Activities unchanged");
    }
    assert.throws(() => prepare({ ...input, specId: "998-foreign-selection" }),
      (error) => error.code === "CURRENT_FLOW_STATE_CONFLICT");
    assert.equal(snapshot(), before);
    admitted = prepare(input);
    assert.deepEqual(admitted.evidence.acceptedDecision.publications.map((entry) => entry.logicalKey), ["flow.findings"]);
    return admitted;
  };
  t.after(() => { scenario.manager.prepareAcceptedNonblockingPublication = prepare; });
  recordNonBlockingDecision({ root: scenario.root, flowManager: scenario.manager, choice: "continue",
    reason: "Continue with the exact semantic findings selected by Definition.", remainingRisk: "Acceptance retains the actual unresolved behavior.",
    expectEvidenceDigest: context.evidenceDigest });
  scenario.reload();
  const terminal = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "impl-gate", completed: true });
  assert.equal(terminal.result.evidence.acceptedDecision.sourceReceiptId, source.receipt.id);
  assert.deepEqual(terminal.result.evidence.toJSON(), admitted.evidence.toJSON());
  assert.equal(scenario.state().nextAction().nodeId, "retro");
});

it("publishes a genuine bounded Flow Review tooling stop and accepts its unchanged child frontier", async (t) => {
  let childFailure = null;
  const scenario = ImplPhaseScenario.create(t, { reviewProcessResult(stage, _ordinal, options) {
    const child = spawnSync(process.execPath,
      stage === "impl-review"
        ? [fileURLToPath(new URL("../../support/infrastructure/impl-tooling-review-worker.js", import.meta.url))]
        : [fileURLToPath(new URL("../../support/impl-phase-review-worker.js", import.meta.url))],
      stage === "impl-review" ? options : { ...options, env: { ...options.env,
        SENNEL_IMPL_SCENARIO_RESPONSE: JSON.stringify({ blockingFindings: [], nonBlockingImprovements: [] }) } });
    if (stage === "impl-review") childFailure = child.stderr?.toString();
    return { ...child, ok: child.status === 0 };
  } });
  writeJson(scenario.root, ".sennel/config.json", { lang: "en", type: "base",
    docs: { languages: ["en"], defaultLanguage: "en" } });
  await scenario.advanceTo("impl-review");
  const outcome = await scenario.executeCurrent();
  scenario.reload();
  const original = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "impl-review" });
  assert.ok(original, JSON.stringify(outcome));
  assert.equal(original.result.kind, "impl-review-tooling", JSON.stringify({ outcome, result: original.result.toJSON(), childFailure }));
  assert.equal(original.settlement.kind, "await");
  assert.equal(original.result.evidence.review, null);
  assert.ok(original.result.evidence.toolingObservation);
  const sourceEvidence = original.result.evidence.toJSON();
  for (const alter of [
    (stored) => { stored.evidence.toolingObservation.manifestDigest = "f".repeat(64); },
    (stored) => { stored.evidence.toolingObservation.failureMode = "provider_failure"; },
    (stored) => { stored.evidence.toolingObservation.responseProtocolEvidence.groups[0].outcome = "accepted"; },
    (stored) => { stored.evidence.toolingObservation.responseProtocolEvidence.groups[0].stopReason = "provider_failure"; },
  ]) {
    const before = JSON.stringify({ state: scenario.state(), activities: scenario.manager.activityLedger(scenario.specId),
      catalog: scenario.manager.artifactCatalog(scenario.specId) });
    const stored = original.result.toJSON();
    alter(stored);
    assert.throws(() => StepResult.fromStored("impl-review", stored));
    assert.equal(JSON.stringify({ state: scenario.state(), activities: scenario.manager.activityLedger(scenario.specId),
      catalog: scenario.manager.artifactCatalog(scenario.specId) }), before);
  }
  const children = ["impl-triage", "impl-repair"].map((id) => ({ id,
    cursor: scenario.state().findNode(id).attemptSequence,
    activityCount: scenario.manager.activityLedger(scenario.specId).filter((entry) => entry.nodeId === id).length }));
  activateNonBlockingPolicy({ root: scenario.root, flowManager: scenario.manager,
    reason: "Accept the exact bounded inability to evaluate current implementation input." });
  const context = decisionContextForActiveFlow(scenario.root, scenario.manager.loadReadOnly(scenario.specId), scenario.manager);
  recordNonBlockingDecision({ root: scenario.root, flowManager: scenario.manager, choice: "continue",
    reason: "Continue with the bounded Review observation retained.", remainingRisk: "Acceptance retains the unreviewed implementation risk.",
    expectEvidenceDigest: context.evidenceDigest });
  scenario.reload();
  assert.equal(scenario.state().nextAction().nodeId, "impl-gate");
  const completed = scenario.manager.readCurrentStepSettlement({ specId: scenario.specId, stepId: "impl-review", completed: true });
  const restored = StepResult.fromStored("impl-review", completed.result.toJSON());
  assert.equal(settleImplStepResult("impl-review", restored).kind, "target-connection");
  const afterEvidence = restored.evidence.toJSON();
  delete afterEvidence.acceptedDecision;
  assert.deepEqual(afterEvidence, sourceEvidence);
  for (const { id, cursor, activityCount } of children) {
    const child = scenario.state().findNode(id);
    assert.equal(child.status, "skipped");
    assert.equal(child.attemptSequence, cursor);
    assert.equal(child.result.stepResult, null);
    assert.equal(child.result.draftSettlementReceipt, null);
    assert.deepEqual(child.result.artifactRefs.map((ref) => ref.id), [completed.receipt.id]);
    assert.equal(scenario.manager.activityLedger(scenario.specId).filter((entry) => entry.nodeId === id).length, activityCount);
  }
});
