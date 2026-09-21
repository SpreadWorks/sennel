import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";

import { CanonicalGatePromotion } from "../../../src/flow/lib/canonical-gate-artifacts.js";
import { DraftRepairPath } from "../../../src/flow/lib/draft-repair-operations.js";
import {
  DraftGateRepairAppliedResult,
  DraftGateRepairCarryForwardResult,
  DraftGateRepairRequiredResult,
  DraftGateRepairWorkerRequiredResult,
} from "../../../src/flow/engine/step-result.js";
import {
  DraftGateEvaluationBinding,
  DraftWorkerExecutionStepBinding,
  DraftWorkerStepBinding,
} from "../../../src/flow/engine/connectors/draft/draft-step-binding.js";
import {
  DraftWorkerExecutionBinding,
  DraftWorkerExecutionClaim,
  settleDraftStepResult,
} from "../../../src/flow/definition.js";
import { readProspectiveDraftGateFacts } from "../../../src/flow/lib/gate-transition-facts.js";
import {
  DraftGateIssuePublication,
  DraftGatePublicationIntent,
} from "../../../src/flow/lib/draft-gate-prospective.js";
import {
  WorkerArtifactHandoffCoordinator,
  sealWorkerArtifactHandoff,
} from "../../../src/flow/lib/worker-artifact-handoff.js";

/** Caller owns the root; this fixture uses the production Gate repair boundary. */
export class DraftGateRepairScenario {
  constructor({ flowManager, root, specId }) {
    this.flowManager = flowManager;
    this.specId = specId;
    this.ctx = { root, mainRoot: root, executionRoot: root, flowManager, specId };
    this.coordinator = new WorkerArtifactHandoffCoordinator();
  }

  select({ observations, issueLogId }) {
    const artifacts = {
      phase: "draft", failureKind: "ai_semantic_fail", failureCode: "GATE_REJECTED",
      nextAction: { diagnosis: { observations } },
    };
    const commandResult = new CanonicalGatePromotion({
      state: this.flowManager.canonicalState(this.specId), phase: "draft", nodeId: "draft-gate",
    }).promote({ result: "fail", artifacts });
    const binding = new DraftGateEvaluationBinding({
      flowManager: this.flowManager,
      specId: this.specId,
    });
    const facts = readProspectiveDraftGateFacts({
      flowManager: this.flowManager,
      binding,
      commandResult,
    });
    const stepResult = new DraftGateRepairRequiredResult();
    this.flowManager.settleDraftStepResult({
      binding,
      stepResult,
      settlement: settleDraftStepResult(stepResult.stepId, stepResult),
      commandResult,
      gatePublication: new DraftGatePublicationIntent({
        facts,
        issue: new DraftGateIssuePublication({
          binding,
          entry: {
            issueLogId, step: "draft-gate", phase: "draft", observations,
            reason: "The draft needs a retained behavior made explicit.",
            trigger: "gate post hook (auto)", timestamp: binding.assertCurrent().attempt.startedAt,
          },
        }),
      }),
    });
    assert.equal(this.flowManager.canonicalState(this.specId).current.at(-1), "draft-gate-repair");
    return this;
  }

  createRequest() {
    const state = this.flowManager.loadReadOnly(this.specId);
    const invocation = {
      id: `draft-gate-repair-${this.flowManager.canonicalState(this.specId).attempt.id}`,
      target: { digest: "b".repeat(64) },
      action: { digest: "a".repeat(64), nextAction: { step: "draft-gate-repair" } },
    };
    this.request = this.coordinator.createRequest({
      ctx: this.ctx,
      state,
      invocation,
      deferPreparation: true,
      deferConditionalAdmission: true,
    });
    const binding = new DraftWorkerExecutionStepBinding({
      flowManager: this.flowManager,
      specId: this.specId,
      stepId: "draft-gate-repair",
    });
    const stepResult = new DraftGateRepairWorkerRequiredResult();
    const settlement = settleDraftStepResult(stepResult.stepId, stepResult);
    const executionBinding = new DraftWorkerExecutionBinding({
      executionGeneration: 0,
      inputDigest: this.request.inputDigest,
      inputRevision: this.request.inputRevision,
    });
    this.flowManager.checkpointDraftStepExecution({
      binding, stepResult, settlement, executionBinding,
    });
    this.flowManager.claimDraftStepExecution({
      binding,
      stepResult,
      settlement,
      executionBinding,
      executionClaim: new DraftWorkerExecutionClaim({
        dispatchInvocationId: this.request.dispatchInvocationId,
        generatedAt: this.request.generatedAt,
        actionDigest: this.request.actionDigest,
        requestDigest: this.request.requestDigest,
      }),
    });
    this.coordinator.admitConditionalDraftRequest({
      ctx: this.ctx,
      state: this.flowManager.loadReadOnly(this.specId),
      request: this.request,
    });
    this.request.prepare();
    return this.request;
  }

  replacement(path, replacement, { strategy = "Make the retained behavior explicit", reason = strategy } = {}) {
    const input = this.request.inputs.find((entry) => entry.name === "draft.json").document;
    const reference = new DraftRepairPath(path).resolve(input);
    assert.notEqual(reference, null, "repair scenario targets an existing field");
    const recurrence = this.request.inputs.find((entry) => entry.name === "gate-observation-recurrence.json").document;
    return {
      version: 1, baseRevision: `sha256:${this.request.inputRevision}`,
      operations: [{
        kind: "replace-value", path, replacement, reason,
        expectedDigest: crypto.createHash("sha256").update(JSON.stringify(reference.value)).digest("hex"),
      }],
      report: {
        version: 1, summary: reason,
        results: recurrence.entries.map((entry) => ({
          fingerprint: entry.fingerprint, strategy, summary: reason,
          priorRepairInsufficiency: entry.recurrenceCount > 0 ? "The prior correction did not cover the retained behavior." : null,
        })),
      },
    };
  }

  apply(payload) {
    fs.writeFileSync(this.request.payloadPath("draft-gate-repair.json"), `${JSON.stringify(payload, null, 2)}\n`);
    sealWorkerArtifactHandoff({ requestPath: this.request.requestPath, invocationId: this.request.dispatchInvocationId });
    const preparation = this.coordinator.prepareDraftWorker({
      ctx: this.ctx,
      request: this.request,
    });
    const binding = new DraftWorkerStepBinding({ request: this.request });
    const stepResult = preparation.planGateRepairOutcome.disposition === "rejected-no-progress"
      ? new DraftGateRepairCarryForwardResult()
      : new DraftGateRepairAppliedResult();
    const result = this.coordinator.commitDraftWorker({
      ctx: this.ctx,
      request: this.request,
      preparation,
      stepResult,
      settlement: settleDraftStepResult(stepResult.stepId, stepResult),
      binding,
    });
    assert.equal(result.completed, true, JSON.stringify(result));
    const source = this.flowManager.readArtifact({ specId: this.specId, logicalKey: "draft", consumerNodeId: "draft-coverage-review" });
    return { result, source: JSON.parse(source.bytes.toString("utf8")), bytes: source.bytes };
  }
}
