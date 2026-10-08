import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { PromptCallFootprint, PromptCallPlanFootprint, PromptResponseAllowance, PromptExecutionBudget,
  PromptLogicalFootprint } from "../../lib/prompt-batching.js";
import { workerArtifactStableStringify } from "./worker-artifact-input-format.js";
import { SpecGateRepairBundle } from "./spec-gate-repair-bundle.js";
import { freezeSpecGateRepairValue } from "./spec-gate-repair-selection.js";
import { WorkerArtifactHandoffError } from "./worker-artifact-handoff-error.js";

export function specGateRepairCallFootprint(request, instructionPrompt) {
  return new PromptCallFootprint({ instructions: instructionPrompt,
    documentTexts: [
      ...request.inputs.map((input) => workerArtifactStableStringify(input.document)),
      workerArtifactStableStringify(request.toJSON()),
      workerArtifactStableStringify(JSON.parse(JSON.stringify(request.invocation.action.nextAction))),
    ] });
}

export function specGateRepairResponseAllowance(context, limit) {
  if (!["locate", "navigate", "inspect", "repair"].includes(context.mode)) {
    throw specGateRepairProgressMismatch("Gate repair call has an unsupported context mode");
  }
  const items = context.mode !== "repair" ? 1
    : Math.max(SpecGateRepairBundle.fromJSON(context.bundle).selections().length, 1);
  return new PromptResponseAllowance({ characters: limit.maxResponseCharacters, items });
}

export function specGateRepairResponseCost(context, proposal) {
  return new PromptResponseAllowance({ characters: JSON.stringify(proposal).length,
    items: proposal.stage === "spec-gate-repair-input-unavailable" ? 1
      : context.mode === "locate" ? proposal.locations.length
      : proposal.stage === "spec-gate-repair" ? proposal.groups.length : 1 });
}

export function specGateRepairProgressMismatch(message) {
  return new WorkerArtifactHandoffError("recovery-required", "FLOW_SPEC_GATE_REPAIR_PROGRESS_MISMATCH",
    message, { retryable: false, recoveryPossible: false, data: { failureKind: "step-admission" } });
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) {
    throw specGateRepairProgressMismatch(`Gate repair ${label} has an invalid shape`);
  }
}

/** Saved admission is verified at its original frontier, even during sealed replay. */
export class SpecGateRepairSavedCallPlan {
  constructor({ plan, limit }) {
    exactKeys(plan, ["version", "digest", "budgetFrontier", "calls"], "call plan");
    plan = freezeSpecGateRepairValue(structuredClone(plan));
    const { digest, ...unsigned } = plan;
    if (plan.version !== 1 || !/^[a-f0-9]{64}$/.test(digest)
      || createHash("sha256").update(workerArtifactStableStringify(unsigned)).digest("hex") !== digest
      || !Array.isArray(plan.calls) || plan.calls.length === 0) {
      throw specGateRepairProgressMismatch("Gate repair saved call plan identity is invalid");
    }
    this.calls = Object.freeze(plan.calls.map((call) => {
      exactKeys(call, ["inputDigest", "inputRevision", "requestDigest", "batchDigest", "batchIndex",
        "batchCount", "callCost", "responseAllowance", "synthesisCallCount", "physicalPromptFootprint", "deliveryMode"], "planned call");
      if ([call.inputDigest, call.inputRevision, call.requestDigest, call.batchDigest]
        .some((value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
        || !Number.isSafeInteger(call.batchIndex) || call.batchIndex < 0
        || !Number.isSafeInteger(call.batchCount) || call.batchCount <= call.batchIndex
        || !Number.isSafeInteger(call.synthesisCallCount) || call.synthesisCallCount < 0
        || !["inline", "file"].includes(call.deliveryMode)) {
        throw specGateRepairProgressMismatch("Gate repair planned call has invalid request or batch identity");
      }
      exactKeys(call.physicalPromptFootprint, ["systemPrompt", "userPrompt", "jsonSchema", "fmtFallback", "separators", "total"], "physical prompt footprint");
      const physical = new PromptLogicalFootprint(call.physicalPromptFootprint);
      if (physical.total !== call.physicalPromptFootprint.total || !physical.fits(limit.requestLimit())) {
        throw specGateRepairProgressMismatch("Gate repair planned physical prompt exceeds its request limit");
      }
      return Object.freeze({ ...call, callCost: PromptCallFootprint.fromJSON(call.callCost),
        physicalPromptFootprint: physical,
        responseAllowance: PromptResponseAllowance.fromJSON(call.responseAllowance) });
    }));
    if (new Set(this.calls.map((call) => call.requestDigest)).size !== this.calls.length) {
      throw specGateRepairProgressMismatch("Gate repair saved call plan repeats a request");
    }
    this.budgetFrontier = PromptExecutionBudget.fromSnapshot(limit, plan.budgetFrontier);
    this.footprint = new PromptCallPlanFootprint({ calls: this.calls.map((call) => call.callCost),
      responseAllowances: this.calls.map((call) => call.responseAllowance),
      synthesisCallCount: this.calls.reduce((total, call) => total + call.synthesisCallCount, 0) });
    this.footprint.assertFits(this.budgetFrontier);
    this.document = plan;
    Object.freeze(this);
  }

  currentCall(saved) {
    const matched = this.calls.filter((call) => call.inputDigest === saved.inputDigest
      && call.inputRevision === saved.inputRevision && call.requestDigest === saved.requestDigest
      && call.batchDigest === saved.context?.batchDigest && call.batchIndex === saved.context?.batchIndex
      && call.batchCount === saved.context?.batchCount);
    if (matched.length !== 1 || matched[0] !== this.calls[0]
      || !isDeepStrictEqual(matched[0].callCost.toJSON(), saved.callCost)
      || !isDeepStrictEqual(matched[0].physicalPromptFootprint.toJSON(), saved.physicalPromptFootprint)
      || matched[0].deliveryMode !== saved.deliveryMode
      || !isDeepStrictEqual(matched[0].responseAllowance.toJSON(), saved.responseAllowance)
      || !isDeepStrictEqual(saved.responseAllowance,
        specGateRepairResponseAllowance(saved.context, this.budgetFrontier.limit).toJSON())
      || matched[0].synthesisCallCount !== 0) {
      throw specGateRepairProgressMismatch("Gate repair progress differs from its admitted current call");
    }
    return matched[0];
  }
}

/** A measured immutable plan, bound to the request capture and durable budget frontier. */
export class SpecGateRepairCallPlan {
  constructor({ requests, invocation, dispatchWorkClass, limit, budget, promptOptions = {} }) {
    const calls = requests.map((request) => {
      const work = dispatchWorkClass.forAdmission(invocation, request);
      const context = request.inputs.find((input) => input.name === "spec-gate-repair-context.json").document;
      const workerInvocation = work.workerInvocation();
      const callCost = specGateRepairCallFootprint(request,
        { ...promptOptions, userPrompt: work.instructionPrompt(workerInvocation) });
      const physicalPromptFootprint = PromptLogicalFootprint.measure({ ...promptOptions,
        userPrompt: work.prompt(workerInvocation) });
      const responseAllowance = specGateRepairResponseAllowance(context, limit);
      return Object.freeze({ inputDigest: request.inputDigest, inputRevision: request.inputRevision,
        requestDigest: request.requestDigest, batchDigest: context.batchDigest,
        batchIndex: context.batchIndex, batchCount: context.batchCount,
        callCost: callCost.toJSON(), responseAllowance: responseAllowance.toJSON(),
        synthesisCallCount: 0, physicalPromptFootprint: physicalPromptFootprint.toJSON(),
        deliveryMode: request.inputs[0].descriptor.deliveryMode });
    });
    const value = { version: 1, budgetFrontier: budget.snapshot(), calls };
    this.document = Object.freeze({ ...value, digest: createHash("sha256")
      .update(workerArtifactStableStringify(value)).digest("hex") });
    this.saved = new SpecGateRepairSavedCallPlan({ plan: this.document, limit });
    this.document = this.saved.document;
    Object.freeze(this);
  }

  toJSON() { return this.document; }

  assertCurrent({ request, instructionPrompt, physicalRequest, budget }) {
    const context = request.inputs.find((input) => input.name === "spec-gate-repair-context.json").document;
    this.saved.currentCall({ inputDigest: request.inputDigest, inputRevision: request.inputRevision,
      requestDigest: request.requestDigest, context,
      callCost: specGateRepairCallFootprint(request, instructionPrompt).toJSON(),
      physicalPromptFootprint: PromptLogicalFootprint.measure(physicalRequest).toJSON(),
      deliveryMode: request.inputs[0].descriptor.deliveryMode,
      responseAllowance: specGateRepairResponseAllowance(context, budget.limit).toJSON() });
    if (!isDeepStrictEqual(budget.snapshot(), this.document.budgetFrontier)) {
      throw new WorkerArtifactHandoffError("stale", "FLOW_SPEC_GATE_REPAIR_PLAN_CHANGED",
        "Spec Gate repair budget differs from its measured plan",
        { data: { failureKind: "step-admission" }, recoveryPossible: false });
    }
    this.saved.footprint.assertFits(budget);
    return this.saved.calls[0];
  }
}
