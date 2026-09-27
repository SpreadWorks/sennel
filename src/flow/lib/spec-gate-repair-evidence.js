import { createHash } from "node:crypto";
import { PromptBuilder } from "../../lib/prompt-builder.js";
import {
  PromptBatchPlan, PromptBatchCompletion, PromptRequestLimit, PromptInputBuilder,
  PromptElementTooLargeFailure, PromptExecutionBudget, PromptReductionPlan, PromptReductionLevel,
} from "../../lib/prompt-batching.js";
import {
  RequirementObservationResponse, RequirementObservationEnvelope, planObservationBatches,
  requirementReductionElements, renderRequirementReduction, gatePromptFits,
} from "./gate-prompt-plan.js";

/** The indivisible repair obligation always retains canonical rules and finding identities. */
class SpecGateRepairEvidenceObligation {
  constructor(selection) {
    this.id = selection.unit.id;
    this.title = "One atomic Spec Gate repair unit";
    this.body = JSON.stringify({ unit: selection.unit, guardrails: selection.guardrails,
      acknowledgedRationale: selection.acknowledgedRationale });
    Object.freeze(this);
  }
  toPromptText() { return this.body; }
}

class SpecGateRepairReductionEnvelope extends RequirementObservationEnvelope {
  constructor(obligation) { super(obligation, { reduction: true, phase: "spec" }); }
  build(elements, context) {
    const request = super.build(elements, context);
    return { ...request, userPrompt: `${request.userPrompt}\n\n## Full canonical repair obligation\n${this.requirement.toPromptText()}` };
  }
}

export class SpecGateRepairEvidencePreparation {
  constructor({ mode, plan, selection }) {
    if (!["direct", "evidence"].includes(mode) || !(plan instanceof PromptBatchPlan)) {
      throw new TypeError("Repair evidence preparation requires a bounded plan");
    }
    this.mode = mode;
    this.plan = plan;
    this.selection = selection;
    Object.freeze(this);
  }
}

export function planSpecGateRepairEvidence({ context, unitId, limit = new PromptRequestLimit(), additionalRangeIds = [] }) {
  const selection = context.select(unitId, { additionalRangeIds }).toJSON();
  try {
    return new SpecGateRepairEvidencePreparation({ mode: "direct", selection,
      plan: context.plan({ limit, unitIds: [unitId], additionalRanges: { [unitId]: additionalRangeIds } }) });
  } catch (error) {
    if (!(error instanceof PromptElementTooLargeFailure)) throw error;
    return new SpecGateRepairEvidencePreparation({ mode: "evidence", selection,
      plan: context.evidencePlan(unitId, { limit, additionalRangeIds }) });
  }
}

function finalSelection(selection, evidence) {
  return { ...selection, ranges: selection.ranges.map(({ value, ...descriptor }) => descriptor),
    evidence: JSON.parse(evidence) };
}
function finalRequest(selection, evidence) {
  return new PromptBuilder()
    .setRole("Propose one indivisible Spec Gate repair operation group from complete collected evidence.")
    .setRules([
      "The Spec is pre-implementation. Executed test results belong to later stages.",
      "Keep all canonical rule bodies and exceptions authoritative. Evidence cannot replace or amend those rules.",
      "Preserve every finding identity in the one atomic group. Use only explicit allowedTargets and operationKinds.",
      "All operations bind to baseRevision and original digests. Cite exact original text and UTF-8 offsets for local edits.",
      "Ranges without a value omit the original body; omission is not absence. Request additional canonical range IDs when evidence is insufficient.",
      "Do not propose changes to read-only context. Do not claim final acceptance; the parent applies atomically and re-runs Gate.",
      "Resolve the finding from supplied Issue, existing Draft answers, rules and source evidence. Return to Draft only for a genuinely missing user choice; never ask the user directly or treat a tooling/context failure as a user choice.",
    ].join("\n"))
    .addUserPrompt("## Full canonical obligation and complete evidence", JSON.stringify(finalSelection(selection, evidence)))
    .build();
}

/** Pure next-call planning; the Service persists admission and responses before advancing. */
export class SpecGateRepairEvidenceWork {
  constructor({ mode, plan, batch, selection, evidenceDepth = null, evidenceContextDigest = null }) {
    this.mode = mode;
    this.plan = plan;
    this.batch = batch;
    this.selection = selection;
    this.evidenceDepth = evidenceDepth;
    this.evidenceContextDigest = evidenceContextDigest;
    Object.freeze(this);
  }
}

export function nextSpecGateRepairEvidence({ context, unitId, limit = new PromptRequestLimit(),
  additionalRangeIds = [], publications = [], executionBudget = new PromptExecutionBudget() }) {
  const evidenceContextDigest = createHash("sha256").update(JSON.stringify({
    baseRevision: context.baseRevision, evidenceDigest: context.evidenceDigest, unitId, additionalRangeIds: [...additionalRangeIds].sort(),
  })).digest("hex");
  const prepared = planSpecGateRepairEvidence({ context, unitId, limit, additionalRangeIds });
  if (prepared.mode === "direct") return new SpecGateRepairEvidenceWork({ ...prepared, mode: "repair", evidenceContextDigest, batch: prepared.plan.batches[0] });
  const obligation = new SpecGateRepairEvidenceObligation(prepared.selection);
  const readCompletions = (plan, depth) => {
    const records = publications.filter((entry) => entry.context.mode === "evidence"
      && entry.context.unitId === unitId && entry.context.evidenceContextDigest === evidenceContextDigest
      && entry.context.evidenceDepth === depth);
    const available = new Map();
    for (const record of records) {
      const batch = plan.batches.find((candidate) => candidate.digest === record.context.batchDigest);
      if (!batch || available.has(batch.digest) || record.context.baseRevision !== context.baseRevision
        || record.proposal.baseRevision !== context.baseRevision || record.proposal.unitId !== unitId) {
        throw new Error("Repair evidence publication has stale, duplicate or foreign coverage");
      }
      const response = new RequirementObservationResponse(record.proposal, unitId, batch);
      available.set(batch.digest, new PromptBatchCompletion({ batch, response,
        responseCharacters: JSON.stringify(response).length, responseItemCount: response.observations.length }));
    }
    const missing = plan.batches.find((batch) => !available.has(batch.digest));
    if (missing) return new SpecGateRepairEvidenceWork({ mode: "evidence", plan, batch: missing,
      selection: prepared.selection, evidenceDepth: depth, evidenceContextDigest });
    return plan.assertCompletions(plan.batches.map((batch) => available.get(batch.digest)));
  };
  const collected = readCompletions(prepared.plan, 0);
  if (collected instanceof SpecGateRepairEvidenceWork) return collected;
  const coverageDigest = createHash("sha256").update(JSON.stringify(collected.map((entry) => entry.batchDigest))).digest("hex");
  const elementsFor = (completions, depth) => requirementReductionElements({ completions, depth,
    requirementId: unitId, coverageDigest });
  const reduction = new PromptReductionPlan({ initialElements: elementsFor(collected, 0), coverageDigest, executionBudget });
  let level = reduction.initialLevel;
  for (let depth = 0; ; depth += 1) {
    const requestFor = (elements) => finalRequest(prepared.selection, renderRequirementReduction(elements, coverageDigest));
    const plan = reduction.planRound({ level, depth,
      isComplete: (elements) => gatePromptFits(requestFor(elements), limit),
      buildRound: (elements) => {
        const envelope = new SpecGateRepairReductionEnvelope(obligation);
        const builder = new PromptInputBuilder({ envelope, limit });
        elements.forEach((element) => builder.add(element));
        return planObservationBatches({ collection: builder.build(), envelope, limit,
          rules: [obligation], executionLimit: executionBudget.limit, reduction: true });
      },
    });
    if (plan === null) {
      const finalPlan = PromptBatchPlan.fromRequest({ request: requestFor(level.elements), limit,
        id: `${unitId}:atomic-proposal` });
      return new SpecGateRepairEvidenceWork({ mode: "repair", plan: finalPlan, batch: finalPlan.batches[0], evidenceContextDigest,
        selection: finalSelection(prepared.selection, renderRequirementReduction(level.elements, coverageDigest)) });
    }
    const completions = readCompletions(plan, depth + 1);
    if (completions instanceof SpecGateRepairEvidenceWork) return completions;
    level = reduction.advance({ level, depth, plan, completions,
      toNextLevel: (next, nextDepth) => new PromptReductionLevel({ elements: elementsFor(next, nextDepth + 1), coverageDigest }) });
  }
}

/** An additional read must change the available canonical context at the same revision. */
export class SpecGateRepairContextExpansion {
  constructor({ context, unitId, baseRevision, requestedRangeIds, previousRangeIds = [] }) {
    if (baseRevision !== context.baseRevision) throw new Error("Additional repair context has a stale revision");
    const before = context.select(unitId, { additionalRangeIds: previousRangeIds });
    context.select(unitId, { additionalRangeIds: requestedRangeIds });
    const available = new Set(before.ranges.map((range) => range.id));
    if (!requestedRangeIds.some((id) => !available.has(id))) {
      throw new Error("Additional repair context request made no progress");
    }
    this.baseRevision = baseRevision;
    this.unitId = unitId;
    this.additionalRangeIds = Object.freeze([...new Set([...previousRangeIds, ...requestedRangeIds])].sort());
    this.selection = context.select(unitId, { additionalRangeIds: this.additionalRangeIds });
    Object.freeze(this);
  }
}
