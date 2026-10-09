import { createHash } from "node:crypto";
import { PromptBuilder } from "../../lib/prompt-builder.js";
import { gatePromptFits } from "../../lib/prompt-input-delivery.js";
export { gatePromptFits } from "../../lib/prompt-input-delivery.js";
import {
  RangedTextPromptElement,
  PromptBatchCompletion,
  PromptInputBuilder,
  PromptRequestEnvelope,
  PromptRequestLimit,
  PromptBatchPlan,
  PromptBatchExecutor,
  PromptBatchReducer,
  PromptBatchingError,
  PromptExecutionLimit,
  PromptResponseTooLargeFailure,
  GroupedPromptBatchTopology,
  PromptBatchGroup,
  PromptReductionPlan,
  PromptReductionLevel,
} from "../../lib/prompt-batching.js";

function digest(text) {
  return createHash("sha256").update(text).digest("hex");
}

function observationResponseFootprint(elements, rules, { reduction = false } = {}) {
  const required = elements.flatMap((range) => rules.map((rule) => ({
      requirementId: rule.id, sourceRef: range.id,
      ...(reduction ? { coveredSourceRefs: range.coveredSourceRefs } : {}),
      support: [], contradictions: [], unresolved: [],
    })));
  return { items: required.length, characters: JSON.stringify({ observations: required }).length };
}

function responseFits(elements, rules, executionLimit, options) {
  const required = observationResponseFootprint(elements, rules, options);
  return required.items <= executionLimit.maxAggregateItemCount
    && (executionLimit.maxResponseCharacters === null
      || required.characters <= executionLimit.maxResponseCharacters);
}

export function planObservationBatches({ collection, envelope, limit, rules, executionLimit, reduction = false }) {
  const groups = [];
  let pending = [];
  for (const element of collection.payloadElements) {
    const candidate = [...pending, element];
    if (responseFits(candidate, rules, executionLimit, { reduction })) {
      pending = candidate;
      continue;
    }
    if (pending.length === 0) {
      throw new PromptResponseTooLargeFailure("One rule-range response structure exceeds its execution budget", {
        sourceRef: element.id,
      });
    }
    groups.push(new PromptBatchGroup({ id: `response:${groups.length}`, payloadElements: pending }));
    pending = [element];
    if (!responseFits(pending, rules, executionLimit, { reduction })) {
      throw new PromptResponseTooLargeFailure("One rule-range response structure exceeds its execution budget", {
        sourceRef: element.id,
      });
    }
  }
  groups.push(new PromptBatchGroup({ id: `response:${groups.length}`, payloadElements: pending }));
  const topology = groups.length === 1 ? undefined : new GroupedPromptBatchTopology({ groups });
  const plan = PromptBatchPlan.create({ collection, envelope, limit, ...(topology ? { topology } : {}) });
  for (const batch of plan.batches) {
    if (!responseFits(batch.payloadElements, rules, executionLimit, { reduction })) {
      throw new PromptResponseTooLargeFailure("The required rule-range response structure exceeds its execution budget", {
        batchDigest: batch.digest,
      });
    }
  }
  return plan;
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
    const allowedIds = new Set(batch.payloadElements.map((entry) => entry.id));
    const sourcesById = new Map(batch.payloadElements.map((entry) => [entry.id, entry.coveredSourceRefs]));
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

/** Evidence bound to its full canonical rule for complete judgment. */
export class GuardrailJudgmentInput {
  constructor({ article, facts, omitArticleBody = false }) {
    if (!article || typeof article.id !== "string" || !article.id || typeof facts !== "string") {
      throw new TypeError("Guardrail judgment requires a rule and its collected facts");
    }
    this.article = article;
    this.facts = facts;
    this.omitArticleBody = omitArticleBody;
    Object.freeze(this);
  }

  toPromptValue() {
    return { guardrailId: this.article.id, evidence: JSON.parse(this.facts) };
  }
}

export class GuardrailFileJudgmentInput {
  constructor(article) {
    if (!article || typeof article.id !== "string" || !article.id) {
      throw new TypeError("File judgment requires a guardrail article");
    }
    this.article = article;
    Object.freeze(this);
  }
}

/** Greedy stable grouping preserves one judgment when the complete input fits. */
export class GuardrailJudgmentPlan {
  constructor({ inputs, limit, buildRequest, projectInvocation = null }) {
    if (!Array.isArray(inputs) || inputs.length === 0 || inputs.some((input) =>
      !(input instanceof GuardrailJudgmentInput) && !(input instanceof GuardrailFileJudgmentInput))) {
      throw new TypeError("Guardrail judgment plan requires typed inputs");
    }
    if (inputs.some((input) => input.constructor !== inputs[0].constructor)) {
      throw new TypeError("Guardrail judgment plan cannot mix evidence and file inputs");
    }
    if (typeof buildRequest !== "function") throw new TypeError("Guardrail judgment plan requires a request builder");
    const groups = [];
    let pending = [];
    let pendingPlan = null;
    for (const input of inputs) {
      const candidate = [...pending, input];
      const request = buildRequest(candidate);
      if (gatePromptFits(request, limit, projectInvocation)) {
        pending = candidate;
        pendingPlan = PromptBatchPlan.fromRequest({ request, limit, id: `guardrail-judgment:${groups.length}` });
        continue;
      }
      if (pending.length === 0) {
        throw new PromptBatchingError("PROMPT_ELEMENT_TOO_LARGE", "One guardrail cannot fit its final judgment");
      }
      groups.push(pendingPlan);
      pending = [input];
      const singleRequest = buildRequest(pending);
      if (!gatePromptFits(singleRequest, limit, projectInvocation)) {
        throw new PromptBatchingError("PROMPT_ELEMENT_TOO_LARGE", "One guardrail cannot fit its final judgment");
      }
      pendingPlan = PromptBatchPlan.fromRequest({ request: singleRequest, limit, id: `guardrail-judgment:${groups.length}` });
    }
    groups.push(pendingPlan);
    this.plans = Object.freeze(groups);
    Object.freeze(this);
  }
}

export function countDistinctGuardrailSourceRanges(plans) {
  const ranges = plans.flatMap((plan) => plan.batches.flatMap((batch) => batch.payloadElements))
    .filter((element) => element.originId.includes(":source"));
  return new Set(ranges.map((element) => JSON.stringify([
    element.sourceRevision, element.start, element.end,
  ]))).size;
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
  constructor(requirement, { reduction = false, phase = null } = {}) {
    super();
    this.requirement = requirement;
    this.reduction = reduction;
    this.phase = phase;
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
        ...(this.phase === "spec" ? [
          "At the Spec stage, identify the confirmation method and acceptance condition; later implementation or test execution is owned by a later step unless explicit execution evidence is supplied.",
          "Do not turn a planned later check into executed evidence or treat missing later execution as a present Spec violation.",
        ] : []),
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
        ...(entry.sourcePath ? { sourcePath: entry.sourcePath, recordId: entry.recordId, fields: entry.fields,
          members: entry.members.map((member) => member.toJSON()) } : {}),
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
    if (new.target === RequirementEvidenceInput) Object.freeze(this);
  }
}

function guardrailSourceElement(input, sequence) {
  return new RangedTextPromptElement({
    id: input.id, text: input.text, sourceRevision: digest(input.text), sequence,
  });
}

export class RequirementEvidencePlan {
  constructor({
    requirement,
    inputs,
    canonicalInput = null,
    limit = new PromptRequestLimit(),
    phase = null,
    executionLimit = new PromptExecutionLimit({ maxAggregateCharacters: null }),
  }) {
    const envelope = new RequirementObservationEnvelope(requirement, { phase });
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
      builder.add(guardrailSourceElement(input, sequence));
    });
    this.plan = planObservationBatches({
      collection: builder.build(), envelope, limit, rules: [requirement], executionLimit,
    });
    this.requirement = requirement;
    this.limit = limit;
    this.executionLimit = executionLimit;
    Object.freeze(this);
  }

  async execute({ callAgent, projectInvocation, protocolPolicy, executionBudget }) {
    return new PromptBatchExecutor({ executionLimit: this.executionLimit, executionBudget }).execute({
      plan: this.plan,
      callAgent,
      projectInvocation,
      protocolPolicy,
      responseContract: { itemCount: (response) => response.observations.length, parse: (response) => {
        if (!(response instanceof RequirementObservationResponse)) {
          throw new PromptBatchingError("PROMPT_RESPONSE_INVALID", "Gate protocol did not produce typed observations");
        }
        return response;
      } },
      reducer: new RequirementObservationReducer(),
    });
  }
}

export class RequirementReductionEvidenceElement extends RangedTextPromptElement {
  constructor({ coveredSourceRefs, ...options }) {
    super(options);
    this.coveredSourceRefs = Object.freeze([...new Set(coveredSourceRefs)]);
    Object.freeze(this);
  }

  createRange(range) {
    return new RequirementReductionEvidenceElement({ ...super.createRange(range), coveredSourceRefs: this.coveredSourceRefs });
  }
}

/** One reduction level keeps the exact completed source coverage separate from prose. */
export function requirementReductionElements({ completions, depth, requirementId, coverageDigest }) {
  return completions.map((completion, sequence) => {
    const text = JSON.stringify(completion.response.observations.map((observation) => observation.toJSON()));
    return new RequirementReductionEvidenceElement({
      id: `${requirementId}:observation:${depth}:${sequence}`, sequence, text, sourceRevision: coverageDigest,
      coveredSourceRefs: completion.response.observations.flatMap((observation) => observation.coveredSourceRefs ?? [observation.sourceRef]),
    });
  });
}

export function renderRequirementReduction(elements, coverageDigest) {
  return JSON.stringify({
    coverageDigest,
    observations: elements.map((element) => ({ coveredSourceRefs: element.coveredSourceRefs, content: element.toPromptText() })),
  });
}

/** Semantic evidence reduction retains the source-completion authority at every level. */
export async function reduceRequirementEvidence({ evidence, requirement, limit, buildFinalRequest, evaluateBatch, projectInvocation, protocolPolicy, executionBudget, phase = null }) {
  const coverageDigest = digest(JSON.stringify(evidence.completions.map((completion) => completion.batchDigest)));
  const initialElements = requirementReductionElements({
    completions: evidence.completions, depth: 0, requirementId: requirement.id, coverageDigest,
  });
  const reduction = new PromptReductionPlan({ initialElements, coverageDigest, executionBudget });
  return reduction.execute({
    isComplete: (elements) => gatePromptFits(buildFinalRequest(renderRequirementReduction(elements, coverageDigest)), limit),
    buildRound: (elements) => {
      const envelope = new RequirementObservationEnvelope(requirement, { reduction: true, phase });
      const builder = new PromptInputBuilder({ envelope, limit });
      elements.forEach((element) => builder.add(element));
      return planObservationBatches({
        collection: builder.build(), envelope, limit, rules: [requirement],
        executionLimit: executionBudget.limit, reduction: true,
      });
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
      elements: requirementReductionElements({
        completions, depth: depth + 1, requirementId: requirement.id, coverageDigest,
      }),
      coverageDigest,
    }),
    finalize: (elements) => {
      reduction.executionBudget.consumeSynthesisCalls(1);
      return buildFinalRequest(renderRequirementReduction(elements, coverageDigest));
    },
  });
}

export async function executeGatePlan({ plan, callAgent, parseResponse, projectInvocation, protocolPolicy, executionBudget, protocolRetryLimit, providerAttemptLimit }) {
  return new PromptBatchExecutor({ executionBudget }).execute({
    plan, callAgent, projectInvocation, protocolPolicy, protocolRetryLimit, providerAttemptLimit,
    responseContract: { parse: parseResponse }, reducer: new GateResultReducer(),
  });
}
