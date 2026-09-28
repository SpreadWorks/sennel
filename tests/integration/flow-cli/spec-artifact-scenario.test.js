import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { describe, it, mock } from "node:test";

import { FlowManager } from "../../../src/lib/flow-manager.js";
import { FlowTargetBinding } from "../../../src/lib/flow-target-guard.js";
import RunDispatchCommand from "../../../src/flow/lib/run-dispatch.js";
import SetApprovalCommand from "../../../src/flow/lib/set-approval.js";
import { NonBlockingPolicy, activateNonBlockingPolicy, decisionContextForActiveFlow, recordNonBlockingDecision } from "../../../src/flow/lib/nonblocking.js";
import GetNextActionCommand from "../../../src/flow/lib/get-next-action.js";
import { readCurrentGateTransitionFacts } from "../../../src/flow/lib/gate-transition-facts.js";
import { CanonicalSpecReview, SpecReviewDelta } from "../../../src/flow/lib/spec-review-artifacts.js";
import { CanonicalTestArtifactStore } from "../../../src/flow/lib/canonical-test-artifacts.js";
import { CanonicalAcceptanceArtifactStore } from "../../../src/flow/lib/canonical-acceptance-artifacts.js";
import { ReviewWorkUnit } from "../../../src/flow/lib/review-work-unit.js";
import {
  sealWorkerArtifactHandoff,
} from "../../../src/flow/lib/worker-artifact-handoff.js";
import {
  CanonicalFlowFixture,
} from "../../support/infrastructure/flow-setup.js";
import { removeTmpDir } from "../../support/builders/tmp-dir.js";
import { validWorkerHandoffTaskSpec, workerArtifactJson } from "../../support/infrastructure/worker-artifact.js";
import {
  dispatchContainer,
  fixtureRepository,
  installGateProviderFake,
  requestInput,
  requestPayloadPath,
} from "../../support/infrastructure/flow-dispatch-scenario.js";

describe("Spec artifact lifecycle and downstream consumption", { concurrency: false }, () => {
  for (const { retainGateFindings, advisoryRepair, largeGateResponse = false, largeSpecFile = false } of [
    { retainGateFindings: false, advisoryRepair: false },
    { retainGateFindings: true, advisoryRepair: false },
    { retainGateFindings: false, advisoryRepair: true },
    { retainGateFindings: false, advisoryRepair: false, largeGateResponse: true, largeSpecFile: false },
    { retainGateFindings: false, advisoryRepair: false, largeGateResponse: true, largeSpecFile: true },
  ]) {
  it(largeGateResponse
    ? `retains complete large ${largeSpecFile ? "file" : "inline"} Spec Gate findings through repair and reload`
    : advisoryRepair
    ? "saves an advisory Spec repair, runs its worker, then gates the changed Spec"
    : retainGateFindings
      ? "retains unresolved Spec Gate findings for Acceptance after a durable strict stop"
      : "publishes and repairs Spec, then reloads it for Approval, Test and Acceptance", async () => {
    const root = fixtureRepository("spec-artifact-scenario-");
    let gateAgentLookup = null;
    let reviewProcess = null;
    try {
      fs.mkdirSync(path.join(root, ".sennel"), { recursive: true });
      fs.writeFileSync(path.join(root, ".sennel", "guardrail.json"), workerArtifactJson({
        guardrails: [{
          id: "SPEC-SHARED",
          title: "Retained plan behavior",
          body: "The plan artifact states every required behavior and its rationale explicitly.",
          meta: { phase: ["spec"], category: "requirements" },
        }],
      }));
      const specId = "802-spec-artifact-scenario";
      const flowManager = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      // Immutable upstream inputs are established by the existing fixture's
      // production publication/settlement APIs; all Spec work starts here.
      new CanonicalFlowFixture({
        flowManager, specId, runId: "run-spec-artifact-scenario",
        request: "Preserve repaired Spec requirements in downstream consumers.",
        execution: { mode: "direct", baseBranch: "main", featureBranch: null },
        nonblocking: advisoryRepair ? new NonBlockingPolicy({
          activatedStep: "spec-gate", reason: "Use an advisory decision for accepted Spec Gate evidence.",
        }).toJSON() : null,
      }).create().registerActive().activate("spec");
      const requests = [];
      const sharedGuardrail = "SPEC-SHARED";
      const specGateAttempts = new Set();
      let specReviewRuns = 0;
      let specWorkerRuns = 0;
      let gateRepairWorkerRuns = 0;
      const repairedFindingIdentities = new Set();
      const findingId = "spec-review-requirement";
      const approvedGoal = "Publish the required behavior in the Spec.";
      const reviewedRequirement = "Retain the repaired Spec requirement in every downstream consumer.";
      const gateRequirement = "R10 must retain its original planned verification wording.";
      const gateTarget = { entity: "requirement", id: "R10", field: "desc" };
      const largeFindingIds = Array.from({ length: 8 }, (_, index) => `R${index + 10}`);
      const largeFindingReason = (id, occurrence) => `The planned verification for ${id}, gap ${occurrence + 1}, omits the required cross-section rationale. `
        + Array.from({ length: 47 }, (_, index) => `Evidence ${index + 1} for ${id} compares the stated behavior with its planned check.`).join(" ");
      let largeFirstResponse = null;
      gateAgentLookup = installGateProviderFake((_prompt, options) => {
        const observationSchema = options.jsonSchema?.properties?.observations?.items;
        const evidenceIds = observationSchema?.properties?.requirementId?.enum ?? [];
        const sourceRefs = observationSchema?.properties?.sourceRef?.enum ?? [];
        const knownIds = observationSchema?.properties?.requirementRef?.enum ?? [];
        const state = flowManager.canonicalState(specId);
        const phase = state.current.at(-1);
        assert.equal(phase, "spec-gate");
        const attempts = specGateAttempts;
        attempts.add(state.attempt.id);
        const fail = retainGateFindings || attempts.size === 1;
        const findingSources = largeGateResponse
          ? largeFindingIds.flatMap((id) => Array.from({ length: 5 }, (_, occurrence) => ({ id, occurrence })))
          : [{ id: "R10", occurrence: 0 }];
        const selected = findingSources.map(({ id, occurrence }) => ({
          failureMode: "guardrail-violation",
          requirementRef: sharedGuardrail,
          where: { file: "spec.json", locator: `requirements.${id}.desc` },
          observed: largeGateResponse ? largeFindingReason(id, occurrence) : retainGateFindings
            ? `Spec behavior ${attempts.size} needs a separate clarification.`
            : "Requirement R10 needs the Gate clarification.",
          targets: [{ ...gateTarget, id }],
          allowedTargets: [{ target: { ...gateTarget, id }, operationKinds: ["edit-text-field"] }],
        }));
        if (evidenceIds.length > 0) {
          return JSON.stringify({ observations: evidenceIds.flatMap((requirementId) => sourceRefs.map((sourceRef) => ({
            requirementId, sourceRef, support: [],
            contradictions: fail && requirementId === sharedGuardrail
              ? [selected[0].observed] : [], unresolved: [],
          }))) });
        }
        const response = JSON.stringify({
          observations: fail && knownIds.includes(sharedGuardrail)
            ? selected.map(({ failureMode, requirementRef, where, observed, targets, allowedTargets }) => ({
              failureMode, requirementRef: sharedGuardrail, where, observed, targets, allowedTargets,
            }))
            : [],
          ...(options.jsonSchema?.required?.includes("evaluationUnavailable") ? { evaluationUnavailable: null } : {}),
        });
        if (largeGateResponse && fail) {
          largeFirstResponse = response;
          assert.ok(response.length > 120_000 && response.length < 160_000, response.length);
        }
        return response;
      });
      const agent = {
        async call(_prompt, options) {
          if (options.commandId === "flow.dispatch.nonblocking-decision") {
            return JSON.stringify({
              choice: "repair",
              reason: "Repair the accepted Spec Gate observation before continuing.",
            });
          }
          const requestPath = options.executionEnvironment.SENNEL_FLOW_HANDOFF_REQUEST;
          const invocationId = options.executionEnvironment.SENNEL_FLOW_DISPATCH_INVOCATION_ID;
          const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
          requests.push(request);
          writeWorkerPayload(request);
          sealWorkerArtifactHandoff({ requestPath, invocationId });
          return JSON.stringify({ sealed: true, requestDigest: request.requestDigest });
        },
      };
      function writeWorkerPayload(request) {
          if (request.stepId === "spec") {
            specWorkerRuns += 1;
            assert.equal(specWorkerRuns, 1);
            fs.writeFileSync(requestPayloadPath(request, "spec.json"), workerArtifactJson({
              ...validWorkerHandoffTaskSpec(),
              goal: approvedGoal,
              ...(largeSpecFile ? { background: `Full canonical background: ${"x".repeat(125_000)}` } : {}),
              requirements: [...validWorkerHandoffTaskSpec().requirements.map((requirement) => ({
                ...requirement, ...(largeGateResponse ? { priority: "must" } : {}),
              })),
                ...((largeGateResponse ? largeFindingIds : ["R10"]).map((id) => ({
                  id, desc: id === "R10" ? gateRequirement : `Plan verification for ${id}.`,
                  ...(largeGateResponse ? { priority: "must" } : {}),
                  testable: false, task_ids: ["T1"],
                })))],
              tasks: validWorkerHandoffTaskSpec().tasks.map((task) => ({
                ...task,
                test_strategy: "Verify the retained behavior through the focused Flow scenario.",
              })),
            }));
            return true;
          }
          if (request.stepId === "spec-gate-repair") {
            gateRepairWorkerRuns += 1;
            const context = requestInput(request, "spec-gate-repair-context.json").document;
            assert.equal(context.mode, "repair");
            const groups = context.selections.map((selection) => {
              const finding = selection.unit.findings[0];
              const target = finding.targets[0];
              const range = selection.ranges.find((entry) => entry.path === `requirements[${target.id}].desc` && entry.writable);
              assert.ok(range);
              if (largeGateResponse) {
                assert.ok(largeFindingIds.includes(target.id));
                assert.deepEqual(finding.targets, [{ entity: "requirement", id: target.id, field: "desc" }]);
                assert.equal(selection.unit.findings.length, 5);
                assert.deepEqual(new Set(selection.unit.findings.map((entry) => entry.observed)),
                  new Set(Array.from({ length: 5 }, (_, occurrence) => largeFindingReason(target.id, occurrence))));
                for (const entry of selection.unit.findings) {
                  assert.deepEqual(entry.targets, [target]);
                  assert.deepEqual(entry.allowedTargets, [{ target,
                    operationKinds: ["edit-text-field"] }]);
                  assert.equal(entry.specRevision, context.baseRevision);
                  const key = JSON.stringify(entry.identity);
                  assert.equal(repairedFindingIdentities.has(key), false);
                  repairedFindingIdentities.add(key);
                }
              } else {
                assert.deepEqual(finding.targets, [gateTarget]);
                assert.deepEqual(finding.allowedTargets, [{ target: gateTarget,
                  operationKinds: ["edit-text-field"] }]);
                assert.equal(finding.observed, retainGateFindings
                  ? `Spec behavior ${gateRepairWorkerRuns} needs a separate clarification.`
                  : "Requirement R10 needs the Gate clarification.");
              }
              assert.equal(context.baseRevision, selection.baseRevision);
              assert.equal(finding.specRevision, context.baseRevision);
              return { findingIdentities: selection.unit.findings.map((entry) => entry.identity),
                operations: [{ kind: "edit-text-field", target: range.target,
                  expectedDigest: range.digest,
                  edits: [{ startByte: Buffer.byteLength(range.value, "utf8"),
                    endByte: Buffer.byteLength(range.value, "utf8"),
                    replacement: " The Spec Gate observation is addressed." }],
                  reason: `Address the exact Spec Gate ${target.id} observation.`,
                }] };
            });
            fs.writeFileSync(requestPayloadPath(request, "spec-gate-repair.json"), workerArtifactJson({
              version: 1, stage: "spec-gate-repair", baseRevision: context.baseRevision,
              groups,
            }));
            return true;
          }
          if (request.stepId === "spec-triage") {
            const review = new CanonicalSpecReview(requestInput(request, "review.json").document);
            const hasFinding = review.findings.byId(findingId) !== null;
            fs.writeFileSync(requestPayloadPath(request, "review.delta.json"), workerArtifactJson({
              version: 2,
              stage: "spec-triage",
              identity: review.identity.toJSON(),
              baseReviewDigest: review.digest,
              findings: hasFinding ? [{
                findingId,
                disposition: "apply",
                evidence: "The reviewed requirement exists in the immutable Spec snapshot.",
                allowedTargets: [{
                  target: { entity: "requirement", id: "R1", field: "desc" },
                  operationKinds: ["replace-entity-field"],
                }],
              }] : [],
              operations: [],
            }));
            return true;
          }
          if (request.stepId === "spec-repair") {
            const review = new CanonicalSpecReview(requestInput(request, "review.json").document);
            const spec = requestInput(request, "spec.json").document;
            const hasFinding = review.findings.byId(findingId) !== null;
            fs.writeFileSync(requestPayloadPath(request, "review.delta.json"), workerArtifactJson({
              version: 2,
              stage: "spec-repair",
              identity: review.identity.toJSON(),
              baseReviewDigest: review.digest,
              findings: [],
              scopeExpansions: [],
              operations: hasFinding ? [{
                findingIds: [findingId],
                kind: "replace-entity-field",
                target: { entity: "requirement", id: "R1", field: "desc" },
                expectedDigest: crypto.createHash("sha256").update(JSON.stringify(spec.requirements[0].desc)).digest("hex"),
                replacement: reviewedRequirement,
                reason: "Apply the review finding to requirement R1.",
              }] : [],
            }));
            return true;
          }
          throw new Error(`Unexpected Spec worker: ${request.stepId}`);
      }
      const originalSpawnSync = childProcess.spawnSync;
      reviewProcess = mock.method(childProcess, "spawnSync", (command, args, options) => {
        if (command !== "node" || !String(args[0]).endsWith("/flow/commands/review.js")) {
          return originalSpawnSync(command, args, options);
        }
        const nodeId = flowManager.canonicalState(specId).current.at(-1);
        const work = ReviewWorkUnit.fromEnvironment(options.env);
        if (nodeId === "spec-review") {
          specReviewRuns += 1;
          const source = JSON.parse(options.env.SENNEL_REVIEW_SPEC_REVIEW_SOURCE);
          const canonical = new CanonicalSpecReview(JSON.parse(fs.readFileSync(source.sourcePath, "utf8")));
          const delta = new SpecReviewDelta({
            version: 2,
            stage: "spec-review",
            identity: canonical.identity.toJSON(),
            baseReviewDigest: canonical.digest,
            findings: specReviewRuns === 1 ? [{
              findingId,
              kind: "blocking",
              title: "Retain the reviewed requirement",
              target: "R1",
              body: "Requirement R1 must describe the retained behavior.",
              issue: "The original requirement omits the review wording.",
              requiredChange: "State the retained behavior in requirement R1.",
              whyBlocking: "The reviewed requirement is an approval condition.",
            }] : [],
            operations: [],
          });
          fs.writeFileSync(path.join(options.env.SENNEL_REVIEW_OUTPUT_DIR, "review.delta.json"),
            `${JSON.stringify(delta.toJSON(), null, 2)}\n`);
        }
        work.seal();
        return { status: 0, signal: null, stdout: "", stderr: "" };
      });
      syncBuiltinESMExports();
      async function dispatch(maxDispatches = 64) {
        const dispatcher = new RunDispatchCommand({ agent, maxDispatches });
        dispatcher.container = dispatchContainer({ root, flowManager, agent });
        return dispatcher.execute({
          root, mainRoot: root, executionRoot: root, specId, flowManager,
          flowState: flowManager.loadReadOnly(specId),
          expectBinding: FlowTargetBinding.capture({
            flowState: flowManager.loadReadOnly(specId), mainRoot: root, authorityRoot: root,
          }).serialize(),
          _envelopeType: "run", _envelopeKey: "dispatch",
        });
      }
      let result;
      if (advisoryRepair) {
        let observedAwaitAfterReload = false;
        for (let index = 0; index < 32; index += 1) {
          const repaired = flowManager.activityLedger(specId).some((entry) => (
            entry.transition?.operation === "plan_gate_repair"
            && entry.transition?.nonblocking?.action === "repair"
          ));
          if (repaired) break;
          if (flowManager.canonicalState(specId).current?.at(-1) === "spec-gate") {
            const restored = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
            const saved = restored.readCurrentStepSettlement({ specId, stepId: "spec-gate" });
            if (saved?.result.kind === "spec-gate-awaiting-decision") {
              assert.equal(saved.receipt.settlementKind, "await");
              assert.ok(readCurrentGateTransitionFacts({
                flowManager: restored, flowState: restored.loadReadOnly(specId), phase: "spec", root,
              }));
              const next = await new GetNextActionCommand().execute({
                root, mainRoot: root, executionRoot: root, specId,
                flowManager: restored, flowState: restored.loadReadOnly(specId),
              });
              assert.ok(next.nonblockingDecision.allowedActions.includes("repair"));
              observedAwaitAfterReload = true;
            }
          }
          const partial = await dispatch(1);
          assert.equal(partial.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(partial));
        }
        assert.equal(observedAwaitAfterReload, true);
        const reloadedRepair = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        assert.equal(reloadedRepair.canonicalState(specId).current.at(-1), "spec-gate-repair");
        assert.equal(reloadedRepair.activityLedger(specId).filter((entry) => (
          entry.transition?.operation === "plan_gate_repair"
          && entry.transition?.nonblocking?.action === "repair"
        )).length, 1);
        const continuation = new RunDispatchCommand({ agent, maxDispatches: 64 });
        continuation.container = dispatchContainer({ root, flowManager: reloadedRepair, agent });
        result = await continuation.execute({
          root, mainRoot: root, executionRoot: root, specId, flowManager: reloadedRepair,
          flowState: reloadedRepair.loadReadOnly(specId),
          expectBinding: FlowTargetBinding.capture({
            flowState: reloadedRepair.loadReadOnly(specId), mainRoot: root, authorityRoot: root,
          }).serialize(),
          _envelopeType: "run", _envelopeKey: "dispatch",
        });
      } else if (largeGateResponse) {
        let savedGate = null;
        for (let index = 0; index < 16; index += 1) {
          savedGate = flowManager.activityLedger(specId).find((entry) => entry.nodeId === "spec-gate"
            && entry.result?.stepResult?.kind === "spec-gate-repair-required");
          if (savedGate) break;
          const partial = await dispatch(1);
          assert.equal(partial.errors?.[0]?.code, "FLOW_DISPATCH_LIMIT_REACHED", JSON.stringify(partial));
        }
        assert.equal(savedGate?.result.stepResult.kind, "spec-gate-repair-required");
        const restored = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        const savedHistory = JSON.parse(restored.readArtifact({
          specId, logicalKey: "spec.gate", consumerNodeId: "spec-gate-repair",
        }).bytes.toString("utf8"));
        const savedFindings = savedHistory.attempts[0].artifact.payload.artifacts.nextAction.diagnosis.observations;
        assert.equal(savedFindings.length, 40);
        assert.equal(new Set(savedFindings.map((finding) => JSON.stringify(finding.targets))).size, 8);
        const continuation = new RunDispatchCommand({ agent, maxDispatches: 64 });
        continuation.container = dispatchContainer({ root, flowManager: restored, agent });
        result = await continuation.execute({
          root, mainRoot: root, executionRoot: root, specId, flowManager: restored,
          flowState: restored.loadReadOnly(specId),
          expectBinding: FlowTargetBinding.capture({
            flowState: restored.loadReadOnly(specId), mainRoot: root, authorityRoot: root,
          }).serialize(),
          _envelopeType: "run", _envelopeKey: "dispatch",
        });
      } else {
        result = await dispatch();
      }
      if (retainGateFindings) {
        const stopped = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        const strict = await new GetNextActionCommand().execute({
          root, mainRoot: root, executionRoot: root, specId,
          flowManager: stopped, flowState: stopped.loadReadOnly(specId),
        });
        assert.equal(strict.directive.kind, "blocked", JSON.stringify({ result, strict }));
        assert.equal(strict.directive.requiresUserAction, false);
        assert.match(strict.directive.reason, /cycle 4 reached maximum 4/);
        assert.match(strict.directive.resumeInstruction, /sennel flow set policy nonblocking/);
        const before = stopped.readCurrentStepSettlement({ specId, stepId: "spec-gate" });
        assert.equal(before.result.kind, "spec-gate-blocked");
        assert.equal(before.result.error.data.reason, "cycle-limit");
        const strictState = stopped.canonicalState(specId).toJSON();
        const strictActivities = stopped.activityLedger(specId);
        const strictCatalog = stopped.artifactCatalog(specId).toJSON();
        const strictDispatcher = new RunDispatchCommand({ agent, maxDispatches: 64 });
        strictDispatcher.container = dispatchContainer({ root, flowManager: stopped, agent });
        const strictBoundary = await strictDispatcher.execute({
          root, mainRoot: root, executionRoot: root, specId, flowManager: stopped,
          flowState: stopped.loadReadOnly(specId),
          expectBinding: FlowTargetBinding.capture({
            flowState: stopped.loadReadOnly(specId), mainRoot: root, authorityRoot: root,
          }).serialize(),
          _envelopeType: "run", _envelopeKey: "dispatch",
        });
        assert.equal(strictBoundary.dispatch?.boundary, "blocked");
        assert.deepEqual(stopped.canonicalState(specId).toJSON(), strictState);
        assert.deepEqual(stopped.activityLedger(specId), strictActivities);
        assert.deepEqual(stopped.artifactCatalog(specId).toJSON(), strictCatalog);
        activateNonBlockingPolicy({ root, flowManager: stopped, reason: "Retain the unresolved Spec observation for Acceptance." });
        const decision = decisionContextForActiveFlow(root, stopped.loadReadOnly(specId), stopped);
        assert.equal(decision.resultKind, "quality");
        assert.deepEqual(decision.allowedActions, ["continue"]);
        const advisoryState = stopped.canonicalState(specId).toJSON();
        const advisoryActivities = stopped.activityLedger(specId);
        const advisoryCatalog = stopped.artifactCatalog(specId).toJSON();
        assert.throws(() => recordNonBlockingDecision({
          root, flowManager: stopped, choice: "repair",
          reason: "An exhausted Spec repair must be rejected.",
          expectEvidenceDigest: decision.evidenceDigest,
        }), /not allowed/);
        assert.deepEqual(stopped.canonicalState(specId).toJSON(), advisoryState);
        assert.deepEqual(stopped.activityLedger(specId), advisoryActivities);
        assert.deepEqual(stopped.artifactCatalog(specId).toJSON(), advisoryCatalog);
        recordNonBlockingDecision({
          root, flowManager: stopped, choice: "continue",
          reason: "The Spec can proceed with explicit deferred review.",
          remainingRisk: "Acceptance must decide the unresolved Spec Gate observation.",
          expectEvidenceDigest: decision.evidenceDigest,
        });
        const resumed = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
        const continuation = new RunDispatchCommand({ agent, maxDispatches: 64 });
        continuation.container = dispatchContainer({ root, flowManager: resumed, agent });
        result = await continuation.execute({
          root, mainRoot: root, executionRoot: root, specId, flowManager: resumed,
          flowState: resumed.loadReadOnly(specId),
          expectBinding: FlowTargetBinding.capture({
            flowState: resumed.loadReadOnly(specId), mainRoot: root, authorityRoot: root,
          }).serialize(),
          _envelopeType: "run", _envelopeKey: "dispatch",
        });
      }
      assert.equal(result.dispatch?.boundary, "approval_required", JSON.stringify({
        boundary: result.dispatch?.boundary,
        errors: result.errors,
        requests: requests.map((request) => request.stepId),
        next: flowManager.canonicalState(specId).nextAction().nodeId,
        specGateRuns: specGateAttempts.size,
        specReviewRuns, specWorkerRuns,
      }, null, 2));
      const reloaded = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      const cycles = retainGateFindings ? 4 : 2;
      assert.deepEqual(requests.map((request) => request.stepId), [
        "spec", "spec-triage", "spec-repair",
        ...Array.from({ length: cycles - 1 }, () => [
          ...Array.from({ length: largeGateResponse ? gateRepairWorkerRuns : 1 }, () => "spec-gate-repair"),
          "spec-triage", "spec-repair",
        ]).flat(),
      ]);
      if (largeGateResponse) {
        assert.ok(gateRepairWorkerRuns > 1);
        assert.equal(repairedFindingIdentities.size, 40);
      } else {
        assert.equal(gateRepairWorkerRuns, cycles - 1);
      }
      assert.equal(specGateAttempts.size, cycles);
      assert.equal(specReviewRuns, cycles);
      const activities = reloaded.activityLedger(specId);
      assert.equal(activities.find((entry) => entry.nodeId === "spec"
        && entry.result?.stepResult?.kind === "spec-created")
        ?.result.draftSettlementReceipt.targetStepId, "spec-review");
      assert.equal(activities.filter((entry) => entry.nodeId === "spec-gate-repair"
        && entry.result?.stepResult?.kind === "spec-gate-repair-review-required"
        && entry.result.draftSettlementReceipt.targetStepId === "spec-review").length, cycles - 1);
      const reviewPublications = activities.filter((entry) => entry.reviewPublication?.stage === "spec-review");
      assert.equal(reviewPublications.length, cycles);
      assert.notDeepEqual(reviewPublications[0].reviewPublication.identity.revision,
        reviewPublications[1].reviewPublication.identity.revision);
      assert.notEqual(reviewPublications[0].reviewPublication.identity.digest,
        reviewPublications[1].reviewPublication.identity.digest);
      assert.equal(activities.filter((entry) => entry.nodeId === "spec-triage"
        && entry.result?.draftSettlementReceipt?.targetStepId === "spec-repair").length, cycles);
      assert.equal(activities.filter((entry) => entry.nodeId === "spec-repair"
        && entry.result?.draftSettlementReceipt?.targetStepId === "spec-gate").length, cycles);
      if (advisoryRepair) {
        assert.equal(activities.find((entry) => entry.nodeId === "spec-gate"
          && entry.result?.stepResult?.kind === "spec-gate-awaiting-decision")
          ?.result.draftSettlementReceipt.settlementKind, "await");
      } else {
        assert.equal(activities.find((entry) => entry.nodeId === "spec-gate"
          && entry.result?.stepResult?.kind === "spec-gate-repair-required")
          ?.result.draftSettlementReceipt.targetStepId, "spec-gate-repair");
      }
      if (!retainGateFindings) {
        assert.equal(activities.find((entry) => entry.nodeId === "spec-gate"
          && entry.result?.stepResult?.kind === "spec-gate-passed")
          ?.result.draftSettlementReceipt.targetStepId, "approval");
      }
      const specGateHistory = JSON.parse(reloaded.readArtifact({
        specId, logicalKey: "spec.gate", consumerNodeId: "approval",
      }).bytes.toString("utf8"));
      assert.deepEqual(specGateHistory.attempts.map((entry) => [
        entry.artifact.payload.result, entry.artifact.payload.artifacts.failureKind ?? null,
      ]), retainGateFindings
        ? Array.from({ length: cycles }, () => ["fail", "ai_semantic_fail"])
        : [["fail", "ai_semantic_fail"], ["pass", null]]);
      if (largeGateResponse) {
        assert.ok(largeFirstResponse.length > 120_000);
        assert.equal(specGateHistory.attempts[0].artifact.payload.artifacts.nextAction.diagnosis.observations.length, 40);
      }
      assert.equal(reloaded.canonicalState(specId).nextAction().nodeId, "approval");
      const projected = await new GetNextActionCommand().execute({
        root, mainRoot: root, executionRoot: root, specId,
        flowManager: reloaded, flowState: reloaded.loadReadOnly(specId),
      });
      assert.equal(projected.step, "approval");
      const spec = JSON.parse(reloaded.readArtifact({
        specId, logicalKey: "spec.record", consumerNodeId: "approval",
      }).bytes.toString("utf8"));
      assert.equal(spec.goal, approvedGoal);
      assert.equal(spec.requirements[0].desc, reviewedRequirement);
      assert.match(spec.requirements.find((entry) => entry.id === "R10").desc,
        /Spec Gate observation is addressed/);
      if (largeGateResponse) {
        for (const id of largeFindingIds) {
          assert.match(spec.requirements.find((entry) => entry.id === id).desc,
            /Spec Gate observation is addressed/);
        }
      }
      const testSpec = new CanonicalTestArtifactStore({
        flowManager: reloaded, state: reloaded.loadReadOnly(specId),
      }).readSpec("test-generate");
      assert.equal(testSpec.requirements[0].desc, reviewedRequirement);
      assert.deepEqual(testSpec.requirements, spec.requirements);
      const acceptance = await new CanonicalAcceptanceArtifactStore({
        state: reloaded.loadReadOnly(specId), flowManager: reloaded,
      }).buildContext({ executionRoot: root });
      assert.deepEqual(acceptance.requirementIds, ["R1", ...(largeGateResponse ? largeFindingIds : ["R10"])]);
      assert.equal(acceptance.evidence.requirements[0].desc, reviewedRequirement);
      assert.deepEqual(acceptance.evidence.requirements, spec.requirements);
      assert.equal(acceptance.mechanicalBlockers.some((entry) => entry.kind === "invalid_spec"), false);
      if (retainGateFindings) {
        assert.equal(acceptance.deferredFindings.length, 1);
        assert.equal(acceptance.deferredFindings[0].sourceStep, "spec-gate");
        assert.equal(acceptance.deferredFindings[0].finalDisposition, "still_open");
        assert.equal(acceptance.evidence.deferredFindingEvidence.length, 1);
        assert.equal(acceptance.evidence.deferredFindingEvidence[0].sourceFinding.observed,
          "Spec behavior 4 needs a separate clarification.");
        assert.equal(acceptance.mechanicalBlockers.some((entry) => entry.kind === "missing_deferred_source"), false);
      }
      // Later Test/Implementation evidence has deliberately not been produced;
      // only Acceptance's use of Spec artifacts belongs to this scenario.
      assert.equal(acceptance.mechanicalBlockers.some((entry) => entry.kind === "missing_artifact"), true);
      const approval = new SetApprovalCommand().execute({
        root, mainRoot: root, executionRoot: root, specId, flowManager: reloaded,
        flowState: reloaded.loadReadOnly(specId), approved: true,
        confirmedAt: "2026-09-23T00:00:00.000Z", notes: "The repaired requirement was reviewed.",
      });
      assert.deepEqual(approval.added, ["T1"]);
      const approved = new FlowManager({ root, mainRoot: root, inWorktree: false, specId });
      const saved = JSON.parse(approved.readArtifact({
        specId, logicalKey: "spec.record", consumerNodeId: "approval",
      }).bytes.toString("utf8"));
      assert.deepEqual(approved.loadReadOnly(specId).tasks.map(({ id, goal }) => ({ id, goal })),
        saved.tasks.map(({ id, goal }) => ({ id, goal })));
      assert.equal(saved.requirements[0].desc, reviewedRequirement);
      assert.equal(saved.user_approval.confirmed_at, "2026-09-23T00:00:00.000Z");
      assert.notEqual(approved.canonicalState(specId).nextAction().nodeId, "approval");
    } finally {
      reviewProcess?.mock.restore();
      syncBuiltinESMExports();
      gateAgentLookup?.mock.restore();
      removeTmpDir(root);
    }
  });
  }
});
