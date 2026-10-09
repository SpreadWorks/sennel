import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { describe, it } from "node:test";

import { WorkerArtifactHandoffCoordinator } from "../../../src/flow/lib/worker-artifact-handoff.js";
import { CanonicalTestArtifactStore } from "../../../src/flow/lib/canonical-test-artifacts.js";
import RunRequirementTestGateCommand from "../../../src/flow/lib/run-requirement-test-gate.js";
import { FLOW_COMMANDS } from "../../../src/flow/registry.js";
import { FLOW_ARTIFACT_CONTRACTS } from "../../../src/lib/flow-artifact-contract.js";
import { CurrentFlowStateInvariantError } from "../../../src/flow/lib/current-flow-state.js";
import { StepPersistenceFailure } from "../../../src/flow/lib/definition-lifecycle-failure.js";
import { RequirementTestPhaseScenario } from "../../support/requirement-test-phase-scenario.js";
import { enterRequirementTestLeaf as enter, assertSavedRequirementTestResult as savedResult, LifecycleSaveFault,
  gatePublicationBytes, assertGatePublicationRollback, assertGatePublicationMembers, readGateSupportBaseline,
  assertSnapshotAfterMetricFlush } from "../../support/requirement-test-save-boundary.js";

describe("Requirement Test durable save, rejection and recovery boundaries", { concurrency: false }, () => {
  it("SAV-01 interrupted approval initialization cannot leave admitted Tasks or changed Spec before commit", async (t) => {
    const scenario = await enter(t, "approval");
    const before = scenario.snapshot();
    const source = Buffer.from(scenario.artifact("spec.record").bytes);
    const failure = new Error("a1ee approval initialization before journal commit");
    let hit = false;
    scenario.reload({ versionStoreFaultInjector({ phase, activity }) {
      if (!hit && phase === "activity-ready-to-append"
        && activity.nodeId === "approval"
        && activity.transition.operation === "initialize_requirement_test_lifecycle") {
        hit = true;
        throw failure;
      }
    } });
    await assert.rejects(() => scenario.approve(), (error) => error instanceof StepPersistenceFailure
      && error.cause === failure);
    assert.equal(hit, true, "inject at the actual approval finalization transaction");
    scenario.reload();
    assert.deepEqual(scenario.artifact("spec.record").bytes, source);
    assert.equal(scenario.manager.artifactCatalog(scenario.specId).artifacts
      .some((artifact) => artifact.logicalKey === "test.requirement.plan"), false);
    assert.deepEqual(scenario.snapshot(), before,
      "Task admission, approval, initial plan and target activation must form one atomic candidate");
  });

  it("SAV-02 approval commit response loss preserves exact approval and rejects requested reapproval without effects", async (t) => {
    const scenario = await enter(t, "approval");
    const fault = new LifecycleSaveFault(t, scenario, "approval", "after-commit");
    await scenario.approve();
    assert.equal(fault.hit, true);
    fault.restore();
    scenario.reload();
    assert.deepEqual(scenario.snapshot(), fault.committed);
    assert.equal(scenario.current(), "test-generate");
    const spec = JSON.parse(scenario.artifact("spec.record").bytes);
    assert.equal(spec.user_approval.confirmed_at, "2026-10-05T00:00:00.000Z");
    const beforeReplay = scenario.snapshot();
    assert.throws(() => scenario.approve(), /active approval Attempt/i,
      "requested reapproval after advancement must be refused synchronously");
    assert.deepEqual(scenario.snapshot(), beforeReplay);
    assert.deepEqual(JSON.parse(scenario.artifact("spec.record").bytes).user_approval, spec.user_approval);
    assert.equal(scenario.manager.loadReadOnly(scenario.specId).tasks.filter((task) => task.id === "T1").length, 1);
    savedResult(scenario, "approval");
  });

  it("SAV-03 sealed generation payload tamper is refused without candidate, promotion or retry budget", async (t) => {
    const scenario = await enter(t, "test-generate", { afterSeal(request) {
      if (request.stepId !== "test-generate") return;
      const payload = request.payloads.find((entry) => entry.logicalName === "spec-tests");
      fs.appendFileSync(path.join(payload.payloadPath, "r1.test.js"), "// changed after seal\n");
    } });
    const before = scenario.plan().toJSON();
    const result = await scenario.dispatch();
    assert.equal(result.errors[0].code, "FLOW_ARTIFACT_HANDOFF_INVALID");
    scenario.reload();
    assert.deepEqual(scenario.plan().toJSON(), before);
    assert.equal(scenario.artifact("test.requirement.candidate.bundle", {
      specRevision: String(scenario.plan().specRevision.revision.value), requirementId: "R1", bundleRevision: "1",
    }), null);
    assert.equal(scenario.artifact("tests.source", { testPath: "r1.test.js" }), null);
    assert.equal(scenario.requests.filter((request) => request.stepId === "test-generate").length, 1);
  });

  it("SAV-04 same-byte new plan Activity invalidates a sealed generator claim before adoption", async (t) => {
    const scenario = await enter(t, "test-generate", { afterSeal(request, current) {
      if (request.stepId !== "test-generate") return;
      const original = current.artifact("test.requirement.plan");
      current.manager.publishArtifacts({ specId: current.specId, nodeId: "test-generate",
        artifactWrites: [{ logicalKey: "test.requirement.plan", mediaType: "application/json", bytes: original.bytes }] });
      const replaced = current.artifact("test.requirement.plan");
      assert.equal(replaced.descriptor.hash, original.descriptor.hash);
      assert.notEqual(replaced.descriptor.activityId, original.descriptor.activityId,
        "real publication changes Activity identity while preserving byte hash");
    } });
    const beforePlan = scenario.plan().toJSON();
    const result = await scenario.dispatch();
    assert.equal(result.errors[0].code, "FLOW_REQUIREMENT_TEST_HANDOFF_STALE",
      `same-byte plan publication must surface stale admission: ${JSON.stringify(result.errors)}`);
    scenario.reload();
    assert.deepEqual(scenario.plan().toJSON(), beforePlan);
    assert.equal(scenario.current(), "test-generate");
    assert.ok(result.errors?.length > 0, "one bounded dispatch must stop after the stale handoff is refused");
    assert.equal(scenario.manager.activityLedger(scenario.specId)
      .some((activity) => activity.nodeId === "test-generate" && activity.result?.stepResult), false,
    "a stale source binding cannot persist a candidate Result");
    assert.equal(scenario.artifact("test.requirement.candidate.bundle", {
      specRevision: String(scenario.plan().specRevision.revision.value), requirementId: "R1", bundleRevision: "1",
    }), null);
    assert.equal(scenario.artifact("tests.source", { testPath: "r1.test.js" }), null);
    assert.equal(scenario.requests.filter((request) => request.stepId === "test-generate").length, 1);
  });

  for (const leaf of ["test-generate", "test-review", "test-repair"]) {
    for (const phase of ["before-commit", "after-commit"]) {
      it(`SAV-05 ${leaf} ${phase === "before-commit" ? "caller-before-save" : "after-commit"} loss preserves the correct durable frontier and never creates fallback failure`, async (t) => {
        const scenario = await enter(t, leaf);
        const fault = new LifecycleSaveFault(t, scenario, leaf, phase);
        const result = await scenario.dispatch();
        assert.equal(fault.hit, true, `must reach the real ${leaf} save boundary, not merely fail its setup: ${JSON.stringify({ result, activities: scenario.manager.activityLedger(scenario.specId).filter((entry) => entry.nodeId === leaf).map((entry) => ({ operation: entry.transition.operation, kind: entry.result?.stepResult?.kind ?? null })) })}`);
        fault.restore();
        assert.ok(result.errors?.length > 0, "save response loss must be surfaced");
        if (phase === "before-commit") {
          if (leaf === "test-review") {
            assert.equal(result.errors?.[0]?.code, "POST_HOOK_FAILED",
              "the parent Review command reports its post-hook persistence failure through the subprocess boundary");
          } else {
            assert.equal(JSON.stringify(result).includes(fault.error.message), true);
          }
        } else {
          assert.equal(result.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED",
            "an exact recovered receipt completes normally and only the one-action dispatcher limit stops continuation");
          assert.equal(JSON.stringify(result).includes(fault.error.message), false,
            "recovered commit response loss is not reported as an unresolved save failure");
        }
        scenario.reload();
        const recovered = scenario.snapshot();
        const durableFrontier = phase === "before-commit" ? fault.before : fault.committed;
        if (leaf === "test-review") {
          assert.deepEqual(recovered, durableFrontier,
            "the fixture's mocked Review subprocess does not append a provider metric");
        } else {
          assertSnapshotAfterMetricFlush(recovered, durableFrontier, leaf);
        }
        assert.equal(scenario.manager.canonicalState(scenario.specId).attempt?.failure ?? null, null);
        const calls = scenario.requests.length;
        const observed = await scenario.next();
        const afterRead = scenario.snapshot();
        scenario.reload();
        assert.deepEqual(await scenario.next(), observed);
        assert.deepEqual(scenario.snapshot(), afterRead);
        if (phase === "after-commit") {
          const retained = savedResult(scenario, leaf);
          await scenario.dispatch();
          assert.equal(scenario.requests.filter((request) => request.stepId === leaf).length,
            scenario.requests.slice(0, calls).filter((request) => request.stepId === leaf).length,
            "recovery must not invoke an already committed producer again");
          assert.deepEqual(savedResult(scenario, leaf).result, retained.result);
        }
      });
    }
  }

  for (const leaf of ["test-generate", "test-repair"]) {
    it(`SAV-06 ${leaf} cleanup failure retains committed receipt and recovers without another worker publication`, async (t) => {
      const failure = new Error(`a1ee ${leaf} cleanup interruption`);
      let hit = false;
      const scenario = await enter(t, leaf, { handoffCoordinator: new WorkerArtifactHandoffCoordinator({
        faultInjector({ phase, stepId }) {
          if (!hit && stepId === leaf && phase === "before-worker-handoff-cleanup-rename") {
            hit = true;
            throw failure;
          }
        },
      }) });
      const result = await scenario.dispatch();
      assert.equal(hit, true, "fault must happen after real Store commit");
      assert.ok(JSON.stringify(result).includes(failure.message));
      scenario.reload();
      const retained = savedResult(scenario, leaf);
      const count = scenario.requests.filter((request) => request.stepId === leaf).length;
      await scenario.dispatch();
      scenario.reload();
      assert.equal(scenario.requests.filter((request) => request.stepId === leaf).length, count);
      assert.deepEqual(savedResult(scenario, leaf).result, retained.result);
      assert.equal(scenario.manager.activityLedger(scenario.specId).filter((activity) => activity.id === retained.id).length, 1);
    });
  }

  it("SAV-07 receipt read failure after generation commit stops without overwriting the committed Result", async (t) => {
    const scenario = await enter(t, "test-generate");
    const fault = new LifecycleSaveFault(t, scenario, "test-generate", "receipt-read");
    let dispatchError = null;
    try { await scenario.dispatch(); } catch (error) { dispatchError = error; }
    assert.equal(fault.hit, true);
    assert.equal(fault.readHit, true, "the normal caller must actually read the committed receipt");
    fault.restore();
    assert.equal(dispatchError, fault.error, "receipt read failure must stop the caller at the committed boundary");
    scenario.reload();
    assertSnapshotAfterMetricFlush(scenario.snapshot(), fault.committed, "test-generate");
    savedResult(scenario, "test-generate");
    assert.equal(scenario.requests.filter((request) => request.stepId === "test-generate").length, 1);
  });

  for (const phase of ["before-commit", "after-commit"]) {
    it(`SAV-08 Gate ${phase} binds primary and shared support promotion to one durable Result and frontier`, async (t) => {
      const supportBytes = Buffer.from("export const beforeImplementation = 'required behavior';\n");
      const scenario = await enter(t, "test-gate", {
        supportFiles: { "fixture.mjs": supportBytes },
        testSource(id) {
          return `// spec: ${id}\nimport test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { beforeImplementation } from './support/fixture.mjs';\ntest('${id}: required behavior', () => { assert.equal(beforeImplementation, 'implemented'); });\n`;
        },
      });
      const sourceAttempt = scenario.manager.canonicalState(scenario.specId).attempt;
      // Observe the real Gate command without replacing its producer, runner,
      // publication or selected transition.
      const gateExecution = t.mock.method(RunRequirementTestGateCommand.prototype, "execute",
        RunRequirementTestGateCommand.prototype.execute);
      const candidate = scenario.candidate("R1").candidate;
      assert.equal(candidate.support.length, 1, "the normal handoff must create the immutable shared support manifest");
      const support = candidate.support[0];
      assert.equal(support.ownerRequirementId, "R1");
      const supportParameters = { ownerRequirementId: support.ownerRequirementId,
        supportPath: support.supportPath.slice("tests/".length), supportDigest: support.digest };
      const supportBefore = readGateSupportBaseline(scenario, supportParameters);
      const planBefore = scenario.plan().toJSON();
      const expectedMembers = [...candidate.sources, ...candidate.support].map((member) => ({
        testPath: (member.testPath ?? member.supportPath).slice("tests/".length), hash: member.digest, size: member.byteLength,
      }));
      const fault = new LifecycleSaveFault(t, scenario, "test-gate", phase, {
        method: "commitSpecStepResult", storeCommit: true,
        observePersisted: () => gatePublicationBytes(scenario, candidate),
      });
      const executeGatePost = async () => {
        const ctx = scenario.context();
        const gateResult = await new RunRequirementTestGateCommand().execute(ctx);
        await FLOW_COMMANDS.run["requirement-test-gate"].post(ctx, gateResult);
        return gateResult;
      };
      let postError = null;
      try { await executeGatePost(); } catch (error) { postError = error; }
      assert.equal(fault.hit, true,
        `Gate must reach the selected real Store commit/response boundary: ${JSON.stringify({
          error: postError?.stack ?? null,
          gateCalls: gateExecution.mock.callCount(), current: scenario.current(),
          activities: scenario.manager.activityLedger(scenario.specId).filter((entry) => entry.nodeId === "test-gate")
            .map((entry) => ({ operation: entry.transition.operation, kind: entry.result?.stepResult?.kind ?? null })),
        })}`);
      fault.restore();
      assert.ok(postError, "the transaction/response fault must stop Gate post-settlement");
      if (phase === "before-commit") assert.equal(postError.cause, fault.error);
      else assert.equal(postError, fault.error);
      scenario.reload();
      assert.equal(scenario.manager.canonicalState(scenario.specId).attempt?.failure ?? null, null);
      if (phase === "after-commit") {
        assert.deepEqual(scenario.snapshot(), fault.committed);
      }
      if (phase === "before-commit") {
        // VersionTreeSnapshot writes state/Activity and all declared artifacts
        // before AtomicJsonFile's catalog rename. Observe actual partial writes,
        // then require both physical rollback and authoritative reload equality.
        const location = scenario.manager.specLocation(scenario.specId);
        for (const member of expectedMembers) {
          const file = location.artifact("tests.source", { testPath: member.testPath });
          const key = file;
          assert.equal(fault.beforePersisted[key], null);
          assert.ok(Buffer.isBuffer(fault.pendingPersisted[key]), "fault must follow the real primary/support write");
          assert.equal(crypto.createHash("sha256").update(fault.pendingPersisted[key]).digest("hex"), member.hash);
        }
        assert.notDeepEqual(fault.pendingPersisted, fault.beforePersisted, "failure must interrupt a partially written transaction");
        assertGatePublicationRollback(fault.beforePersisted, gatePublicationBytes(scenario, candidate));
        assert.deepEqual(scenario.snapshot(), fault.before);
        assert.deepEqual(scenario.plan().toJSON(), planBefore);
        assert.equal(scenario.current(), "test-gate");
        assert.equal(scenario.artifact("test.requirement.gate"), null);
        assert.equal(scenario.manager.activityLedger(scenario.specId).some((entry) => entry.nodeId === "test-gate" && entry.result?.stepResult), false);
        // Retry the same active Gate through its real producer after rollback.
        await executeGatePost();
        scenario.reload();
      }
      assert.equal(scenario.current(), "implement", "the final Requirement must activate the current implementation entry");
      assert.equal(scenario.plan().workItem("R1").status, "promoted");
      const activity = savedResult(scenario, "test-gate");
      assert.equal(activity.attemptId, sourceAttempt.id);
      assert.equal(activity.sequence, sourceAttempt.sequence);
      assert.equal(activity.result.stepResult.kind, "test-gate-compatible");
      const receipt = activity.result.draftSettlementReceipt;
      assert.equal(receipt.binding.runId, scenario.manager.canonicalState(scenario.specId).runId);
      assert.equal(receipt.binding.specId, scenario.specId);
      assert.equal(receipt.binding.stepId, "test-gate");
      assert.equal(receipt.binding.attemptId, sourceAttempt.id);
      assert.equal(receipt.binding.attemptSequence, sourceAttempt.sequence);
      assert.equal(scenario.artifact("test.requirement.plan").descriptor.activityId, activity.id);
      assert.equal(scenario.artifact("test.requirement.gate").descriptor.activityId, activity.id);
      const supportAfter = readGateSupportBaseline(scenario, supportParameters);
      assert.deepEqual(supportAfter.descriptor, supportBefore.descriptor,
        "promotion must preserve the immutable support baseline and owner publication");
      assert.deepEqual(supportAfter.bytes, supportBytes);
      const downstream = new CanonicalTestArtifactStore({ flowManager: scenario.manager,
        state: scenario.manager.loadReadOnly(scenario.specId) });
      const revision = downstream.testSourceRevision();
      assertGatePublicationMembers(expectedMembers, revision.members, activity.id);
      assert.equal(revision.finalizedAt, activity.result.confirmedAt);
      const sources = downstream.testSources("implement");
      assert.deepEqual(sources.map((entry) => entry.testPath), expectedMembers.map((entry) => entry.testPath).sort());
      for (const source of sources) {
        const expected = expectedMembers.find((member) => member.testPath === source.testPath);
        assert.equal(crypto.createHash("sha256").update(source.bytes).digest("hex"), expected.hash);
        assert.equal(source.bytes.length, expected.size);
      }
      const retained = structuredClone(activity.result);
      const savedFrontier = scenario.snapshot();
      const observed = await scenario.next();
      scenario.reload();
      assert.deepEqual(await scenario.next(), observed);
      assert.deepEqual(scenario.snapshot(), savedFrontier, "durable frontier reads must be side-effect free");
      const gateCalls = gateExecution.mock.callCount();
      assert.ok(gateCalls > 0, "the forwarding observer must have witnessed the actual Gate execution");
      await scenario.dispatch(4);
      assert.ok(scenario.implementationInput, "the actual next dispatcher must consume persisted Spec input");
      assert.deepEqual(scenario.implementationInput.document.requirements, JSON.parse(scenario.artifact("spec.record").bytes).requirements);
      assert.equal(gateExecution.mock.callCount(), gateCalls, "downstream dispatch must not execute Gate again");
      assert.deepEqual(savedResult(scenario, "test-gate").result, retained, "next activation must not resettle Gate");
    });
  }

  it("SAV-09 Gate assertion controls reject missing support, foreign producer and incomplete rollback", () => {
    // Assertion-only projections: never supplied to a production producer,
    // Store or canonical state constructor. They isolate the audit oracles
    // while initial producer/typed-Result contracts remain independently red.
    const bytes = Buffer.from("support audit bytes");
    const expected = ["r1.test.js", "support/fixture.mjs"].map((testPath) => ({
      testPath, hash: crypto.createHash("sha256").update(bytes).digest("hex"), size: bytes.length,
    }));
    const observed = expected.map((member) => ({ ...member, activityId: "gate-result-audit" }));
    assertGatePublicationMembers(expected, observed, "gate-result-audit");
    assert.throws(() => assertGatePublicationMembers(expected, observed.slice(0, 1), "gate-result-audit"), assert.AssertionError);
    assert.throws(() => assertGatePublicationMembers(expected, observed.map((member) => ({ ...member, activityId: "foreign-audit" })), "gate-result-audit"), assert.AssertionError);
    const baseline = { plan: bytes, activity: bytes, catalog: bytes, primary: null, support: null };
    assertGatePublicationRollback(baseline, { ...baseline });
    for (const field of Object.keys(baseline)) {
      assert.throws(() => assertGatePublicationRollback(baseline, { ...baseline, [field]: Buffer.from("partial write") }), assert.AssertionError);
    }
  });

  it("SAV-10 Gate support audit retains its authorized reader while implementation reads promoted sources", (t) => {
    const scenario = RequirementTestPhaseScenario.create(t);
    const parameters = { ownerRequirementId: "R1", supportPath: "fixture.mjs", supportDigest: "a".repeat(64) };
    const supportContract = FLOW_ARTIFACT_CONTRACTS.resolve("test.requirement.support", parameters).contract;
    assert.equal(supportContract.ownership.consumers.includes("test-gate"), true);
    assert.equal(supportContract.ownership.consumers.includes("implement"), false);
    assert.equal(FLOW_ARTIFACT_CONTRACTS.resolve("tests.source", { testPath: "support/fixture.mjs" })
      .contract.ownership.consumers.includes("implement"), true);
    const before = scenario.snapshot();
    // An absent artifact still exercises real Store ownership admission before
    // catalog lookup. No missing producer or typed Result is bypassed here.
    assert.equal(readGateSupportBaseline(scenario, parameters), null);
    assert.throws(() => scenario.manager.readArtifact({ specId: scenario.specId,
      logicalKey: "test.requirement.support", parameters, consumerNodeId: "implement", optional: true }),
    (error) => error instanceof CurrentFlowStateInvariantError && error.message ===
      "canonical artifact consumer is not authorized: implement/test.requirement.support");
    assert.equal(scenario.manager.readArtifact({ specId: scenario.specId,
      logicalKey: "tests.source", parameters: { testPath: "support/fixture.mjs" }, consumerNodeId: "implement", optional: true }), null);
    assert.deepEqual(scenario.snapshot(), before, "ownership reads/refusal must leave canonical state unchanged");
  });
});
