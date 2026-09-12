import { createHash } from "node:crypto";
import { PromptBuilder } from "../../lib/prompt-builder.js";
import {
  RangedTextPromptElement,
  PromptInputBuilder,
  PromptRequestEnvelope,
  PromptRequestLimit,
  PromptBatchPlan,
  PromptBatchExecutor,
  PromptBatchReducer,
  PromptLogicalFootprint,
  PromptBatchingError,
  PromptReductionPlan,
  PromptReductionLevel,
} from "../../lib/prompt-batching.js";

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

export class GateResultCollection {
  constructor(completions) {
    this.results = Object.freeze(completions.map((completion) => completion.response));
    this.completions = Object.freeze([...completions]);
    Object.freeze(this);
  }
}

export class GateResultReducer extends PromptBatchReducer {
  reduce(completions) {
    return new GateResultCollection(completions);
  }
}

/** A cited observation is evidence for a later judgment, never a partial PASS/FAIL. */
export class RequirementSourceObservation {
  constructor(value, { requirementId, allowedIds, coveredSourceRefs }) {
    if (!value || value.requirementId !== requirementId
      || typeof value.sourceRef !== "string" || !allowedIds.has(value.sourceRef)) {
      throw new PromptBatchingError("PROMPT_RESPONSE_COVERAGE_INVALID", "Requirement observation has a foreign requirement or source reference");
    }
    this.requirementId = requirementId;
    this.sourceRef = value.sourceRef;
    if (coveredSourceRefs) {
      const actual = value.coveredSourceRefs;
      if (!Array.isArray(actual) || actual.length !== coveredSourceRefs.length
        || new Set(actual).size !== actual.length || actual.some((ref) => !coveredSourceRefs.includes(ref))) {
        throw new PromptBatchingError("PROMPT_RESPONSE_COVERAGE_INVALID", "Reduced observation must retain its exact original source references");
      }
      this.coveredSourceRefs = Object.freeze([...actual]);
    }
    for (const field of ["support", "contradictions", "unresolved"]) {
      if (!Array.isArray(value[field]) || value[field].some((text) => typeof text !== "string" || !text.trim())) {
        throw new PromptBatchingError("PROMPT_RESPONSE_INVALID", `Requirement observation ${field} must contain non-empty strings`);
      }
      this[field] = Object.freeze([...value[field]]);
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      requirementId: this.requirementId, sourceRef: this.sourceRef,
      ...(this.coveredSourceRefs ? { coveredSourceRefs: this.coveredSourceRefs } : {}),
      support: this.support, contradictions: this.contradictions, unresolved: this.unresolved,
    };
  }
}

export class RequirementObservationResponse {
  constructor(value, requirementId, batch) {
    if (!value || !Array.isArray(value.observations)) {
      throw new PromptBatchingError("PROMPT_RESPONSE_INVALID", "Requirement source response must contain observations");
    }
    const allowedIds = new Set(batch.elements.map((entry) => entry.id));
    const sourcesById = new Map(batch.elements.map((entry) => [entry.id, entry.coveredSourceRefs]));
    const entries = value.observations.map((entry) => new RequirementSourceObservation(entry, {
      requirementId, allowedIds, coveredSourceRefs: sourcesById.get(entry?.sourceRef),
    }));
    const actualIds = new Set(entries.map((entry) => entry.sourceRef));
    if (actualIds.size !== entries.length || actualIds.size !== allowedIds.size) {
      throw new PromptBatchingError("PROMPT_RESPONSE_COVERAGE_INVALID", "Requirement observations must cover every supplied range exactly once");
    }
    this.observations = Object.freeze(entries);
    Object.freeze(this);
  }
}

export class RequirementObservationCollection {
  constructor(completions) {
    this.completions = Object.freeze([...completions]);
    this.observations = Object.freeze(completions.flatMap((completion) => completion.response.observations));
    Object.freeze(this);
  }

  toPromptText() {
    return JSON.stringify(this.observations.map((entry) => entry.toJSON()));
  }
}

class RequirementObservationReducer extends PromptBatchReducer {
  reduce(completions) {
    return new RequirementObservationCollection(completions);
  }
}

export class RequirementObservationEnvelope extends PromptRequestEnvelope {
  constructor(requirement, { reduction = false } = {}) {
    super();
    this.requirement = requirement;
    this.reduction = reduction;
  }

  build(elements, context) {
    const ids = elements.map((entry) => entry.id);
    const pb = new PromptBuilder()
      .setRole("Collect evidence for one obligation from the supplied canonical source and contract ranges.")
      .setRules([
        ...(this.reduction ? [
          "This is an evidence reduction round, not another source scan. Strictly compress the supplied observation groups by merging redundant facts and removing repeated JSON structure.",
          "Preserve all distinct support, contradictions and unresolved questions, including their original source citations and exception/ownership relationships. Do not turn an unresolved question into a negative finding.",
          "For each observation return coveredSourceRefs exactly as supplied for that input range, even if its evidence is empty. These references are immutable coverage metadata, not evidence of compliance.",
        ] : []),
        "Do not issue PASS, FAIL or SKIP. These ranges are only part of the complete input.",
        "Do not infer missing implementation or missing requirements from the absence of another range.",
        "Record supporting facts, explicit contradictions, and unresolved questions separately; cite the supplied sourceRef.",
        "Contract/context ranges define obligations; source ranges supply implementation evidence. Do not treat a requested behavior as proof of its implementation.",
        "Return one observation for each supplied range, with empty lists when it contains no relevant facts.",
        "Preserve exact names, source references, later-step ownership, preservation/replacement clauses, and execution evidence in your facts.",
        "Preserve every distinct occurrence and its original file/location, quoted text, and diff added/removed status; do not collapse separate actionable occurrences.",
        "Retain document-level structural facts and applicable exception clauses with their acknowledgment rationale so the final judgment can reconcile all ranges.",
      ].join("\n"))
      .setJsonSchema({
        type: "object", additionalProperties: false, required: ["observations"],
        properties: { observations: { type: "array", minItems: ids.length, maxItems: ids.length, items: {
          type: "object", additionalProperties: false,
          required: ["requirementId", "sourceRef", "support", "contradictions", "unresolved", ...(this.reduction ? ["coveredSourceRefs"] : [])],
          properties: {
            requirementId: { type: "string", enum: [this.requirement.id] },
            sourceRef: { type: "string", enum: ids },
            ...(this.reduction ? { coveredSourceRefs: { type: "array", uniqueItems: true, items: { type: "string" } } } : {}),
            support: { type: "array", items: { type: "string" } },
            contradictions: { type: "array", items: { type: "string" } },
            unresolved: { type: "array", items: { type: "string" } },
          },
        } } },
      })
      .setFmtFallback('Return JSON {"observations":[{"requirementId":"...","sourceRef":"...","support":[],"contradictions":[],"unresolved":[]}]} only.')
      .addUserPrompt("## Obligation identity", this.requirement.id)
      .addUserPrompt("## Batch", JSON.stringify({ index: context.index, count: context.count }))
      .addUserPrompt("## Canonical input ranges", JSON.stringify(elements.map((entry) => ({
        sourceRef: entry.id, revision: entry.sourceRevision, start: entry.start, end: entry.end,
        ...(entry.coveredSourceRefs ? { coveredSourceRefs: entry.coveredSourceRefs } : {}),
        content: entry.toPromptText(),
      }))));
    return pb.build();
  }
}

/** Domain bindings are declared before the shared planner can subdivide them. */
export class RequirementEvidenceInput {
  constructor({ id, text }) {
    if (typeof id !== "string" || !id || typeof text !== "string") throw new Error("Requirement evidence requires an identity and text");
    this.id = id;
    this.text = text;
    Object.freeze(this);
  }
}

export class RequirementEvidencePlan {
  constructor({ requirement, inputs, canonicalInput = null, limit = new PromptRequestLimit() }) {
    const envelope = new RequirementObservationEnvelope(requirement);
    const builder = new PromptInputBuilder({ envelope, limit });
    const canonicalInputs = [
      canonicalInput ?? new RequirementEvidenceInput({
        id: `${requirement.id}:canonical-obligation`,
        text: requirement.toPromptText(),
      }),
      ...inputs,
    ];
    canonicalInputs.forEach((input, sequence) => {
      if (!(input instanceof RequirementEvidenceInput)) throw new Error("Requirement evidence plan requires typed inputs");
      builder.add(new RangedTextPromptElement({
        id: input.id, text: input.text, sourceRevision: digest(input.text), sequence,
      }));
    });
    this.plan = PromptBatchPlan.create({ collection: builder.build(), envelope, limit });
    this.requirement = requirement;
    this.limit = limit;
    Object.freeze(this);
  }

  async execute({ callAgent, projectInvocation, protocolPolicy, executionBudget }) {
    return new PromptBatchExecutor({ executionBudget }).execute({
      plan: this.plan,
      callAgent,
      projectInvocation,
      protocolPolicy,
      responseContract: { parse: (response) => {
        if (!(response instanceof RequirementObservationResponse)) {
          throw new PromptBatchingError("PROMPT_RESPONSE_INVALID", "Gate protocol did not produce typed observations");
        }
        return response;
      } },
      reducer: new RequirementObservationReducer(),
    });
  }
}

class RequirementReductionEvidenceElement extends RangedTextPromptElement {
  constructor({ coveredSourceRefs, ...options }) {
    super(options);
    this.coveredSourceRefs = Object.freeze([...new Set(coveredSourceRefs)]);
    Object.freeze(this);
  }

  createRange(range) {
    return new RequirementReductionEvidenceElement({ ...super.createRange(range), coveredSourceRefs: this.coveredSourceRefs });
  }
}

/** Semantic evidence reduction retains the source-completion authority at every level. */
export async function reduceRequirementEvidence({ evidence, requirement, limit, buildFinalRequest, evaluateBatch, projectInvocation, protocolPolicy, executionBudget }) {
  const coverageDigest = digest(JSON.stringify(evidence.completions.map((completion) => completion.batchDigest)));
  const elementsFor = (completions, depth) => completions.map((completion, sequence) => {
    const text = JSON.stringify(completion.response.observations.map((observation) => observation.toJSON()));
    return new RequirementReductionEvidenceElement({
      id: `${requirement.id}:observation:${depth}:${sequence}`, sequence, text, sourceRevision: coverageDigest,
      coveredSourceRefs: completion.response.observations.flatMap((observation) => observation.coveredSourceRefs ?? [observation.sourceRef]),
    });
  });
  const render = (elements) => JSON.stringify({
    coverageDigest,
    observations: elements.map((element) => ({ coveredSourceRefs: element.coveredSourceRefs, content: element.toPromptText() })),
  });
  const initialElements = elementsFor(evidence.completions, 0);
  const reduction = new PromptReductionPlan({ initialElements, coverageDigest, executionBudget });
  return reduction.execute({
    isComplete: (elements) => gatePromptFits(buildFinalRequest(render(elements)), limit),
    buildRound: (elements) => {
      const envelope = new RequirementObservationEnvelope(requirement, { reduction: true });
      const builder = new PromptInputBuilder({ envelope, limit });
      elements.forEach((element) => builder.add(element));
      return PromptBatchPlan.create({ collection: builder.build(), envelope, limit });
    },
    executeRound: (plan) => new PromptBatchExecutor({ executionBudget }).executeCompletions({
      plan, projectInvocation, protocolPolicy,
      callAgent: evaluateBatch,
      responseContract: { parse: (response) => {
        if (!(response instanceof RequirementObservationResponse)) {
          throw new PromptBatchingError("PROMPT_RESPONSE_INVALID", "Reduction requires typed requirement observations");
        }
        return response;
      } },
    }),
    toNextLevel: (completions, depth) => new PromptReductionLevel({
      elements: elementsFor(completions, depth + 1),
      coverageDigest,
    }),
    finalize: (elements) => {
      reduction.executionBudget.consumeSynthesisCalls(1);
      return buildFinalRequest(render(elements));
    },
  });
}

export function gatePromptFits(request, limit = new PromptRequestLimit()) {
  return PromptLogicalFootprint.measure(request).fits(limit);
}

export async function executeGatePlan({ plan, callAgent, parseResponse, projectInvocation, protocolPolicy, executionBudget }) {
  return new PromptBatchExecutor({ executionBudget }).execute({
    plan, callAgent, projectInvocation, protocolPolicy,
    responseContract: { parse: parseResponse }, reducer: new GateResultReducer(),
  });
}
