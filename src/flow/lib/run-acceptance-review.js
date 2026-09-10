import { repairJson } from "../../lib/json-parse.js";
import { createHash } from "node:crypto";
import { container } from "../../lib/container.js";
import { PromptBuilder } from "../../lib/prompt-builder.js";
import {
  AtomicPromptElement,
  PromptBatchExecutor,
  PromptBatchPlan,
  PromptBatchReducer,
  PromptBatchingError,
  PromptExecutionBudget,
  PromptExecutionLimit,
  PromptInputBuilder,
  PromptLogicalFootprint,
  PromptReductionLevel,
  PromptReductionPlan,
  PromptRequestEnvelope,
  PromptRequestLimit,
  PromptScopedBinding,
  RangedTextPromptElement,
  ScopedCartesianPromptBatchTopology,
} from "../../lib/prompt-batching.js";
import {
  AgentFailure,
  AgentPermissionConfigurationFailure,
} from "../../lib/agent-failure.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { FlowCommand } from "./base-command.js";
import {
  AcceptanceEvidenceBindings,
  artifactFromAcceptanceJudgments,
} from "./acceptance-review-artifacts.js";
import {
  CanonicalAcceptanceArtifactStore,
  CanonicalAcceptanceReviewPromotion,
} from "./canonical-acceptance-artifacts.js";

export const MAX_ACCEPTANCE_REQUEST_CHARS = 120_000;
export const MAX_ACCEPTANCE_RESPONSE_CHARS = 120_000;
const MAX_ACCEPTANCE_SCHEMA_ITEMS = MAX_ACCEPTANCE_RESPONSE_CHARS;
const MAX_ACCEPTANCE_SCHEMA_STRING_CHARS = MAX_ACCEPTANCE_RESPONSE_CHARS;
export const MAX_ACCEPTANCE_DEFERRED_REPAIR_CALLS = 1;
const DEFERRED_FINDING_DISPOSITION_ITEM_SCHEMA = Object.freeze({
  type: "object",
  required: ["findingId", "finalDisposition", "evidenceRefs"],
  additionalProperties: false,
  properties: {
    findingId: { type: "string", minLength: 1, maxLength: MAX_ACCEPTANCE_SCHEMA_STRING_CHARS },
    finalDisposition: {
      type: "string",
      enum: ["fixed", "not_needed", "false_positive", "pre_existing", "still_open", "blocking"],
    },
    evidenceRefs: {
      type: "array",
      minItems: 1,
      maxItems: MAX_ACCEPTANCE_SCHEMA_ITEMS,
      items: { type: "string", minLength: 1, maxLength: MAX_ACCEPTANCE_SCHEMA_STRING_CHARS },
    },
  },
});
const ACCEPTANCE_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  required: ["requirementJudgments", "deferredFindingDispositions"],
  additionalProperties: false,
  properties: {
    requirementJudgments: {
      type: "array",
      items: {
        type: "object",
        required: [
          "requirementId",
          "status",
          "requestRefs",
          "requirementRefs",
          "diffRefs",
          "repairRefs",
          "testRefs",
          "missingEvidence",
        ],
        additionalProperties: false,
        properties: {
          requirementId: { type: "string", minLength: 1, maxLength: MAX_ACCEPTANCE_SCHEMA_STRING_CHARS },
          status: { type: "string", enum: ["met", "notMet", "notVerifiable"] },
          requestRefs: { type: "array", maxItems: MAX_ACCEPTANCE_SCHEMA_ITEMS, items: { type: "string", enum: ["flow.request"] } },
          requirementRefs: { type: "array", maxItems: MAX_ACCEPTANCE_SCHEMA_ITEMS, items: { type: "string", minLength: 1, maxLength: MAX_ACCEPTANCE_SCHEMA_STRING_CHARS } },
          diffRefs: { type: "array", maxItems: MAX_ACCEPTANCE_SCHEMA_ITEMS, items: { type: "string", minLength: 1, maxLength: MAX_ACCEPTANCE_SCHEMA_STRING_CHARS } },
          repairRefs: { type: "array", maxItems: MAX_ACCEPTANCE_SCHEMA_ITEMS, items: { type: "string", minLength: 1, maxLength: MAX_ACCEPTANCE_SCHEMA_STRING_CHARS } },
          testRefs: { type: "array", maxItems: MAX_ACCEPTANCE_SCHEMA_ITEMS, items: { type: "string", minLength: 1, maxLength: MAX_ACCEPTANCE_SCHEMA_STRING_CHARS } },
          missingEvidence: { type: "array", maxItems: MAX_ACCEPTANCE_SCHEMA_ITEMS, items: { type: "string", minLength: 1, maxLength: MAX_ACCEPTANCE_SCHEMA_STRING_CHARS } },
        },
      },
      maxItems: MAX_ACCEPTANCE_SCHEMA_ITEMS,
    },
    deferredFindingDispositions: {
      type: "array",
      items: DEFERRED_FINDING_DISPOSITION_ITEM_SCHEMA,
      maxItems: MAX_ACCEPTANCE_SCHEMA_ITEMS,
    },
  },
});

export class AcceptanceBudgetError extends Error {
  constructor(kind, components, limit) {
    const summary = Object.entries(components).map(([name, size]) => `${name}=${size}`).join(", ");
    super(`acceptance ${kind} exceeds ${limit} characters (${summary})`);
    this.name = "AcceptanceBudgetError";
    this.code = kind === "response" ? "ACCEPTANCE_RESPONSE_TOO_LARGE" : "ACCEPTANCE_REQUEST_TOO_LARGE";
    this.components = Object.freeze({ ...components });
    this.limit = limit;
  }
}

export class AcceptanceReviewResponseSource {
  load(_context) {
    return null;
  }
}

const ACCEPTANCE_REVIEW_RULES = Object.freeze([
  "Return JSON only.",
  "Emit exactly one requirementJudgments[] entry for every requirement id in the evidence.",
  "Use status met only when request, requirement, diff, repair/no-repair, and fingerprint-matched test evidence support it.",
  "Use status notMet when the evidence contradicts or fails the requirement.",
  "Use status notVerifiable only when named evidence is unavailable, and list exact missingEvidence reasons.",
  "Every judgment must cite requestRefs, requirementRefs, repairRefs, and the available diffRefs/testRefs.",
  "Emit exactly one deferredFindingDispositions[] entry for every deferred finding whose finalDisposition is still_open or blocking; omit findings that already have a resolved finalDisposition.",
  "Classify each deferred finding as fixed, not_needed, false_positive, pre_existing, still_open, or blocking.",
  "Every deferred disposition must cite its exact sourceRef from deferredFindingEvidence; additional refs must come from the current diff, repair evidence, or test evidence.",
  "A still_open or blocking deferred disposition is an unresolved acceptance risk and routes to explicit acceptance-decision; it is not a mechanical evidence blocker.",
  "For each taskReviewHandoff with unreviewedAfterRepair=true, assess the fourth-review findings against its exact repair lineage and the current evidence. The repair was not re-reviewed by Task Review; do not treat that absence as a mechanical blocker, but account for it in the requirement judgment.",
  "For each taskReviewHandoff with noChange=true, assess the unchanged source against its bound Review, continuation reason, and any all-reject triage decision. Task Gate was skipped with advisory assurance; verify that the existing behavior satisfies the requirement without assuming a repair occurred.",
  "For each taskReviewHandoff with allRejected=true, assess the original REJECTED Task Review findings and every bound reject disposition with its rationale against the current evidence. Those triage decisions skipped Task repair; do not rewrite the Review verdict or treat the rejection as an unreviewed repair.",
]);

export function buildAcceptancePrompt(context) {
  const evidence = JSON.stringify(context.evidence, null, 2);
  const prompt = new PromptBuilder()
    .setRole("You are the semantic acceptance reviewer. Judge every requirement against the complete current evidence chain.")
    .setRules(ACCEPTANCE_REVIEW_RULES.join("\n"))
    .setJsonSchema(ACCEPTANCE_RESPONSE_SCHEMA)
    .setFmtFallback(`Return only JSON matching this schema:\n${JSON.stringify(ACCEPTANCE_RESPONSE_SCHEMA)}`)
    .addUserPrompt("## Acceptance Evidence", evidence)
    .build();
  return assertAcceptancePromptBudget(prompt);
}

function assertAcceptancePromptBudget(prompt) {
  const footprint = PromptLogicalFootprint.measure(prompt);
  if (!footprint.fits(new PromptRequestLimit({ maxCharacters: MAX_ACCEPTANCE_REQUEST_CHARS }))) {
    throw new AcceptanceBudgetError("request", footprint.toJSON(), MAX_ACCEPTANCE_REQUEST_CHARS);
  }
  return prompt;
}

export class DeferredDispositionCoverage {
  #expectedById;
  #judgments;

  constructor(context, judgments = []) {
    this.#expectedById = new Map(context.deferredFindings
      .filter((finding) => ["still_open", "blocking"].includes(finding.finalDisposition))
      .map((finding) => [finding.findingId, finding]));
    this.#judgments = new Map();
    this.add(judgments);
  }

  add(judgments) {
    if (!Array.isArray(judgments)) throw new Error("deferredFindingDispositions must be an array");
    for (const judgment of judgments) {
      if (!this.#expectedById.has(judgment?.findingId)) {
        throw new Error(`unknown deferred finding disposition: ${judgment?.findingId || "missing-id"}`);
      }
      if (this.#judgments.has(judgment.findingId)) {
        throw new Error(`duplicate deferred finding disposition: ${judgment.findingId}`);
      }
      this.#judgments.set(judgment.findingId, judgment);
    }
    return this;
  }

  get missingFindings() {
    return [...this.#expectedById]
      .filter(([findingId]) => !this.#judgments.has(findingId))
      .map(([, finding]) => finding);
  }

  requireComplete() {
    const [missing] = this.missingFindings;
    if (missing) throw new Error(`missing deferred finding disposition: ${missing.findingId}`);
    return [...this.#expectedById.keys()].map((findingId) => this.#judgments.get(findingId));
  }
}

export function buildDeferredDispositionRepairPrompt(context, missingFindings) {
  if (!Array.isArray(missingFindings) || missingFindings.length === 0) {
    throw new Error("missing deferred findings are required for disposition repair");
  }
  const missingIds = new Set(missingFindings.map((finding) => finding.findingId));
  const evidence = JSON.stringify({
    originalRequest: context.evidence.originalRequest,
    requirements: context.evidence.requirements,
    diff: context.evidence.diff,
    repairEvidence: context.evidence.repairEvidence,
    upgradeEvidence: context.evidence.upgradeEvidence,
    testEvidence: context.evidence.testEvidence,
    deferredFindings: missingFindings,
    deferredFindingEvidence: context.evidence.deferredFindingEvidence.filter((entry) => (
      missingIds.has(entry.findingId)
    )),
  }, null, 2);
  const schema = {
    type: "object",
    required: ["deferredFindingDispositions"],
    additionalProperties: false,
    properties: {
      deferredFindingDispositions: {
        type: "array",
        minItems: missingFindings.length,
        maxItems: missingFindings.length,
        items: {
          ...DEFERRED_FINDING_DISPOSITION_ITEM_SCHEMA,
          properties: {
            ...DEFERRED_FINDING_DISPOSITION_ITEM_SCHEMA.properties,
            findingId: { type: "string", enum: [...missingIds] },
          },
        },
      },
    },
  };
  const prompt = new PromptBuilder()
    .setRole("You are the semantic acceptance reviewer repairing incomplete deferred-finding coverage without changing prior requirement judgments.")
    .setRules([
      "Return JSON only.",
      "Emit exactly one deferredFindingDispositions[] entry for every supplied deferred finding id.",
      "Classify each finding as fixed, not_needed, false_positive, pre_existing, still_open, or blocking.",
      "Cite the exact sourceRef from deferredFindingEvidence in every entry.",
      `This is the only bounded coverage-repair call; the CLI permits ${MAX_ACCEPTANCE_DEFERRED_REPAIR_CALLS}.`,
    ].join("\n"))
    .setJsonSchema(schema)
    .setFmtFallback(`Return only JSON matching this schema:\n${JSON.stringify(schema)}`)
    .addUserPrompt("## Missing Deferred Finding Evidence", evidence)
    .build();
  return assertAcceptancePromptBudget(prompt);
}

export function parseAcceptanceResponse(text) {
  const response = String(text);
  if (response.length > MAX_ACCEPTANCE_RESPONSE_CHARS) {
    throw new AcceptanceBudgetError("response", { response: response.length }, MAX_ACCEPTANCE_RESPONSE_CHARS);
  }
  try {
    return JSON.parse(response);
  } catch (_) {
    return JSON.parse(repairJson(response));
  }
}

export class AcceptanceResponseBinding {
  constructor(context) {
    this.context = context;
    this.evidenceBindings = new AcceptanceEvidenceBindings(context);
    this.deferredById = new Map(
      context.deferredFindings.map((finding) => [finding.findingId, finding]),
    );
    Object.freeze(this);
  }

  bind(response) {
    if (!Array.isArray(response.requirementJudgments)) {
      throw new Error("requirementJudgments must be an array");
    }
    const deferredFindingDispositions = response.deferredFindingDispositions ?? [];
    if (!Array.isArray(deferredFindingDispositions)) {
      throw new Error("deferredFindingDispositions must be an array");
    }
    const repairRef = this.context.evidence.repairEvidence.ref;
    return {
      requirementJudgments: response.requirementJudgments.map((judgment) => {
        const diffRefs = (judgment.diffRefs || []).filter((ref) => (
          this.evidenceBindings.diff.includes(ref)
        ));
        return {
          ...judgment,
          requestRefs: ["flow.request"],
          requirementRefs: [`spec.json#${judgment.requirementId}`],
          diffRefs: judgment.status !== "notVerifiable" && diffRefs.length === 0
            ? [...this.evidenceBindings.diff]
            : diffRefs,
          repairRefs: [repairRef],
          testRefs: judgment.status === "notVerifiable"
            ? []
            : [`test-execute-result.json#${judgment.requirementId}`, "test-result-review.json"],
        };
      }),
      deferredFindingDispositions: this.bindDeferredFindingDispositions(deferredFindingDispositions),
    };
  }

  bindDeferredFindingDispositions(judgments) {
    if (!Array.isArray(judgments)) throw new Error("deferredFindingDispositions must be an array");
    return judgments.map((judgment) => {
        const finding = this.deferredById.get(judgment.findingId);
        if (!finding) return judgment;
        const sourceRef = `${finding.sourceArtifact}#${finding.sourceFindingId}`;
        const allowedRefs = new Set([
          sourceRef,
          ...this.evidenceBindings.diffRefs,
          ...this.evidenceBindings.repairRefs,
          ...this.evidenceBindings.testRefs,
        ]);
        return {
          ...judgment,
          evidenceRefs: [
            sourceRef,
            ...(judgment.evidenceRefs || []).filter((ref) => ref !== sourceRef && allowedRefs.has(ref)),
          ],
        };
      });
  }
}

export function bindAcceptanceResponse(context, response) {
  return new AcceptanceResponseBinding(context).bind(response);
}

function acceptanceDigest(value) {
  return createHash("sha256").update(value).digest("hex");
}

class AcceptanceEvidencePromptElement extends RangedTextPromptElement {
  constructor({ sourceKey, ...options }) {
    super(options);
    this.sourceKey = sourceKey;
    Object.freeze(this);
  }

  createRange({ start, end }) {
    return new AcceptanceEvidencePromptElement({
      sourceKey: this.sourceKey,
      id: this.rangeId(start, end),
      originId: this.originId,
      sourceRevision: this.sourceRevision,
      sequence: this.sequence,
      text: this.text.slice(start - this.start, end - this.start),
      start,
      end,
      sourceLength: this.sourceLength,
      status: this.status,
    });
  }

  toPromptText() {
    return JSON.stringify({
      sourceRef: this.id,
      sourceKey: this.sourceKey,
      revision: this.sourceRevision,
      start: this.start,
      end: this.end,
      sourceLength: this.sourceLength,
      content: this.text,
    });
  }
}

class AcceptanceObservation {
  constructor({ sourceRef, facts }, allowedIds) {
    if (typeof sourceRef !== "string" || !allowedIds.has(sourceRef)) {
      throw new PromptBatchingError("PROMPT_RESPONSE_COVERAGE_INVALID", "Acceptance observation cites a foreign source range");
    }
    if (!Array.isArray(facts) || facts.some((fact) => typeof fact !== "string" || fact.trim() === "")) {
      throw new PromptBatchingError("PROMPT_RESPONSE_INVALID", "Acceptance observation facts must be non-empty strings");
    }
    this.sourceRef = sourceRef;
    this.facts = Object.freeze([...facts]);
    Object.freeze(this);
  }

  toJSON() {
    return { sourceRef: this.sourceRef, facts: [...this.facts] };
  }
}

class AcceptanceObservationElement extends RangedTextPromptElement {
  constructor({ sourceRefs, summary, ...options }) {
    super({ ...options, text: summary });
    if (!Array.isArray(sourceRefs) || sourceRefs.length === 0 || sourceRefs.some((ref) => typeof ref !== "string" || ref === "")) {
      throw new TypeError("Acceptance observation summary requires source references");
    }
    this.sourceRefs = Object.freeze([...sourceRefs]);
    Object.freeze(this);
  }

  createRange({ start, end }) {
    return new AcceptanceObservationElement({
      id: this.rangeId(start, end),
      originId: this.originId,
      sourceRevision: this.sourceRevision,
      sequence: this.sequence,
      sourceRefs: this.sourceRefs,
      summary: this.text.slice(start - this.start, end - this.start),
      start,
      end,
      sourceLength: this.sourceLength,
      status: this.status,
    });
  }

  toPromptText() {
    return JSON.stringify({ sourceRefs: this.sourceRefs, summary: this.text });
  }
}

class AcceptanceObservationEnvelope extends PromptRequestEnvelope {
  constructor() {
    super({ revision: "acceptance-observation-v1" });
  }

  build(elements, batchContext) {
    const ids = elements.map((element) => element.id);
    return new PromptBuilder()
      .setRole("Extract acceptance-relevant facts from bounded canonical evidence ranges without issuing a final judgment.")
      .setRules([
        "Return exactly one observation for every supplied sourceRef, including an empty facts array when the range is irrelevant.",
        "Record only facts present in the supplied range. Do not issue requirement status or deferred-finding disposition.",
        "Keep exact requirement, finding, artifact, path, test, repair, and lineage identities in the facts.",
      ].join("\n"))
      .setJsonSchema({
        type: "object", required: ["observations"], additionalProperties: false,
        properties: { observations: {
          type: "array", minItems: ids.length, maxItems: ids.length,
          items: {
            type: "object", required: ["sourceRef", "facts"], additionalProperties: false,
            properties: {
              sourceRef: { type: "string", enum: ids },
              facts: { type: "array", items: { type: "string" } },
            },
          },
        } },
      })
      .setFmtFallback('{"observations":[{"sourceRef":"supplied-id","facts":[]}]}')
      .addUserPrompt("## Batch", JSON.stringify({ index: batchContext.index, count: batchContext.count }))
      .addUserPrompt("## Canonical evidence ranges", elements.map((element) => element.toPromptText()).join("\n"))
      .build();
  }
}

class AcceptanceObservationReducer extends PromptBatchReducer {
  reduce(completions) {
    return Object.freeze(completions.flatMap((completion) => completion.response));
  }
}

class AcceptanceSummaryEnvelope extends PromptRequestEnvelope {
  constructor() {
    super({ revision: "acceptance-observation-reduction-v1" });
  }

  build(elements) {
    const sourceRefs = [...new Set(elements.flatMap((element) => element.sourceRefs))];
    return new PromptBuilder()
      .setRole("Compress structured acceptance observations without losing any cited evidence identity or contradiction.")
      .setRules("Return one concise summary. Preserve every fact that could affect a requirement judgment or deferred-finding disposition.")
      .setJsonSchema({
        type: "object", required: ["sourceRefs", "summary"], additionalProperties: false,
        properties: {
          sourceRefs: { type: "array", minItems: sourceRefs.length, maxItems: sourceRefs.length, items: { type: "string", enum: sourceRefs } },
          summary: { type: "string", minLength: 1 },
        },
      })
      .setFmtFallback('{"sourceRefs":["all-supplied-source-refs"],"summary":"concise evidence facts"}')
      .addUserPrompt("## Observations", elements.map((element) => element.toPromptText()).join("\n"))
      .build();
  }
}

class SingleResponseReducer extends PromptBatchReducer {
  reduce(completions) {
    if (completions.length !== 1) throw new Error("Acceptance final response requires one atomic completion");
    return completions[0].response;
  }
}

function acceptanceAgentOptions(request) {
  return {
    commandId: "flow.acceptance.review",
    systemPrompt: request.systemPrompt,
    jsonSchema: request.jsonSchema,
    fmtFallback: request.fmtFallback,
  };
}

function acceptanceExecutorOptions(agent, budget) {
  return {
    callAgent: (request, _batch, _protocolRetryIndex, _attemptContext, providerCallAdmission) => agent.call(
      request.userPrompt,
      { ...acceptanceAgentOptions(request), providerCallAdmission },
    ),
    ...(typeof agent.projectInvocation === "function" ? {
      projectInvocation: (request) => agent.projectInvocation(request.userPrompt, acceptanceAgentOptions(request)),
    } : {}),
    executionBudget: budget,
  };
}

function parseObservations(raw, batch) {
  const value = parseAcceptanceResponse(raw);
  if (!Array.isArray(value?.observations)) throw new PromptBatchingError("PROMPT_RESPONSE_INVALID", "Acceptance observation response is invalid");
  const allowed = new Set(batch.payloadElements.map((element) => element.id));
  const observations = value.observations.map((entry) => new AcceptanceObservation(entry, allowed));
  if (observations.length !== allowed.size || new Set(observations.map((entry) => entry.sourceRef)).size !== allowed.size) {
    throw new PromptBatchingError("PROMPT_RESPONSE_COVERAGE_INVALID", "Acceptance observations must cover every range exactly once");
  }
  return observations;
}

function acceptanceEvidenceElements(context) {
  return Object.entries(context.evidence).map(([sourceKey, value], sequence) => {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return new AcceptanceEvidencePromptElement({
      sourceKey,
      id: `acceptance-evidence.${sourceKey}`,
      sourceRevision: acceptanceDigest(text),
      sequence,
      text,
    });
  });
}

function observationsAsElements(observations) {
  return observations.map((observation, sequence) => {
    const summary = JSON.stringify(observation.toJSON());
    return new AcceptanceObservationElement({
      id: `acceptance-observation.${sequence}`,
      sourceRevision: acceptanceDigest(summary),
      sequence,
      sourceRefs: [observation.sourceRef],
      summary,
    });
  });
}

class AcceptanceFinalBindingElement extends AtomicPromptElement {
  constructor({ kind, identity, sequence }) {
    if (!new Set(["requirement", "deferredFinding"]).has(kind)) {
      throw new TypeError("Acceptance final binding kind is invalid");
    }
    const sourceRevision = acceptanceDigest(`${kind}\0${identity}`);
    super({
      id: `acceptance-final.${kind}.${identity}`,
      sourceRevision,
      sequence,
      text: JSON.stringify({ kind, identity }),
    });
    this.kind = kind;
    this.identity = identity;
    Object.freeze(this);
  }
}

function acceptanceFinalBindings(context, sequenceStart) {
  const requirements = context.evidence.requirements.map((requirement, index) => (
    new AcceptanceFinalBindingElement({
      kind: "requirement",
      identity: requirement.id,
      sequence: sequenceStart + index,
    })
  ));
  const deferred = context.evidence.deferredFindings
    .filter((finding) => ["still_open", "blocking"].includes(finding.finalDisposition))
    .map((finding, index) => new AcceptanceFinalBindingElement({
      kind: "deferredFinding",
      identity: finding.findingId,
      sequence: sequenceStart + requirements.length + index,
    }));
  return [...requirements, ...deferred];
}

function scopedAcceptanceResponseSchema(binding) {
  const requirement = binding.kind === "requirement";
  return {
    ...ACCEPTANCE_RESPONSE_SCHEMA,
    properties: {
      ...ACCEPTANCE_RESPONSE_SCHEMA.properties,
      requirementJudgments: {
        ...ACCEPTANCE_RESPONSE_SCHEMA.properties.requirementJudgments,
        minItems: requirement ? 1 : 0,
        maxItems: requirement ? 1 : 0,
        items: requirement ? {
          ...ACCEPTANCE_RESPONSE_SCHEMA.properties.requirementJudgments.items,
          properties: {
            ...ACCEPTANCE_RESPONSE_SCHEMA.properties.requirementJudgments.items.properties,
            requirementId: { type: "string", enum: [binding.identity] },
          },
        } : ACCEPTANCE_RESPONSE_SCHEMA.properties.requirementJudgments.items,
      },
      deferredFindingDispositions: {
        ...ACCEPTANCE_RESPONSE_SCHEMA.properties.deferredFindingDispositions,
        minItems: requirement ? 0 : 1,
        maxItems: requirement ? 0 : 1,
        items: requirement ? DEFERRED_FINDING_DISPOSITION_ITEM_SCHEMA : {
          ...DEFERRED_FINDING_DISPOSITION_ITEM_SCHEMA,
          properties: {
            ...DEFERRED_FINDING_DISPOSITION_ITEM_SCHEMA.properties,
            findingId: { type: "string", enum: [binding.identity] },
          },
        },
      },
    },
  };
}

class AcceptanceFinalEnvelope extends PromptRequestEnvelope {
  constructor() {
    super({ revision: "acceptance-scoped-final-v1" });
  }

  build(elements) {
    const bindings = elements.filter((element) => element instanceof AcceptanceFinalBindingElement);
    const observations = elements.filter((element) => element instanceof AcceptanceObservationElement);
    // The builder measures observation leaves before topology binds them to a
    // final identity. Keep that sizing request faithful to their transported
    // representation without pretending it is an executable judgment.
    if (bindings.length === 0) {
      return { userPrompt: observations.map((element) => element.toPromptText()).join("\n") };
    }
    if (bindings.length !== 1) throw new Error("Acceptance final request requires exactly one scoped binding");
    const [binding] = bindings;
    const schema = scopedAcceptanceResponseSchema(binding);
    return new PromptBuilder()
      .setRole("You are the semantic acceptance reviewer. Issue one final judgment for the supplied binding from complete, reduced canonical evidence.")
      .setRules([
        ...ACCEPTANCE_REVIEW_RULES,
        "For a requirement binding, emit exactly its one requirement judgment and no deferred finding dispositions.",
        "For a deferred-finding binding, emit exactly its one disposition and no requirement judgments.",
        "Preserve exact evidence references and report missing evidence rather than inventing support.",
      ].join("\n"))
      .setJsonSchema(schema)
      .setFmtFallback(`Return only JSON matching this schema:\n${JSON.stringify(schema)}`)
      .addUserPrompt("## Scoped binding", binding.toPromptText())
      .addUserPrompt("## Complete reduced acceptance evidence", observations.map((element) => element.toPromptText()).join("\n"))
      .build();
  }
}

class AcceptanceScopedResponse {
  constructor({ binding, response }) {
    const requirementJudgments = response?.requirementJudgments;
    const deferredFindingDispositions = response?.deferredFindingDispositions;
    if (!Array.isArray(requirementJudgments) || !Array.isArray(deferredFindingDispositions)) {
      throw new PromptBatchingError("PROMPT_RESPONSE_INVALID", "Acceptance scoped response arrays are invalid");
    }
    const expectedRequirement = binding.kind === "requirement";
    if (requirementJudgments.length !== (expectedRequirement ? 1 : 0)
      || deferredFindingDispositions.length !== (expectedRequirement ? 0 : 1)
      || (expectedRequirement && requirementJudgments[0]?.requirementId !== binding.identity)
      || (!expectedRequirement && deferredFindingDispositions[0]?.findingId !== binding.identity)) {
      throw new PromptBatchingError("PROMPT_RESPONSE_COVERAGE_INVALID", "Acceptance scoped response does not exactly cover its binding");
    }
    this.binding = binding;
    this.requirementJudgments = Object.freeze([...requirementJudgments]);
    this.deferredFindingDispositions = Object.freeze([...deferredFindingDispositions]);
    Object.freeze(this);
  }
}

class AcceptanceScopedReducer extends PromptBatchReducer {
  constructor(bindings) {
    super();
    this.bindings = Object.freeze([...bindings]);
    Object.freeze(this);
  }

  reduce(completions) {
    const responses = completions.map((completion) => completion.response);
    const expected = new Set(this.bindings.map((binding) => binding.id));
    const actual = responses.map((response) => response.binding.id);
    if (actual.length !== expected.size || new Set(actual).size !== expected.size || actual.some((id) => !expected.has(id))) {
      throw new PromptBatchingError("PROMPT_RESPONSE_COVERAGE_INVALID", "Acceptance scoped responses do not cover every final binding exactly once");
    }
    return {
      requirementJudgments: responses.flatMap((response) => response.requirementJudgments),
      deferredFindingDispositions: responses.flatMap((response) => response.deferredFindingDispositions),
    };
  }
}

function buildAcceptanceScopedFinalPlan(context, observationElements, limit) {
  const envelope = new AcceptanceFinalEnvelope();
  const bindings = acceptanceFinalBindings(context, observationElements.length);
  if (bindings.length === 0) throw new Error("Acceptance final plan requires at least one binding");
  const builder = new PromptInputBuilder({ envelope, limit });
  [...observationElements, ...bindings].forEach((element) => builder.add(element));
  const collection = builder.build();
  const observations = collection.elements.filter((element) => element instanceof AcceptanceObservationElement);
  const finalBindings = collection.elements.filter((element) => element instanceof AcceptanceFinalBindingElement);
  const topology = new ScopedCartesianPromptBatchTopology({
    bindings: finalBindings.map((binding) => new PromptScopedBinding({
      id: binding.id,
      scopeElements: observations,
      payloadElements: [binding],
    })),
  });
  return {
    bindings: finalBindings,
    plan: PromptBatchPlan.create({ collection, envelope, limit, topology }),
  };
}

/** Typed map/reduce plan used only when the complete canonical request cannot fit. */
export class AcceptanceEvidenceExecutionPlan {
  constructor(context, { limit = new PromptRequestLimit(), executionLimit = new PromptExecutionLimit({
    maxProviderCallCount: 100,
    maxProtocolRetryCount: 0,
    maxSynthesisCallCount: 32,
  }) } = {}) {
    this.context = context;
    this.limit = limit;
    this.executionLimit = executionLimit;
    const envelope = new AcceptanceObservationEnvelope();
    const builder = new PromptInputBuilder({ envelope, limit });
    acceptanceEvidenceElements(context).forEach((element) => builder.add(element));
    this.observationEnvelope = envelope;
    this.observationPlan = PromptBatchPlan.create({
      collection: builder.build(), envelope, limit, executionLimit,
    });
    Object.freeze(this);
  }

  async execute(agent, executionBudget = new PromptExecutionBudget(this.executionLimit)) {
    if (!(executionBudget instanceof PromptExecutionBudget)) throw new TypeError("Acceptance evidence execution requires a shared prompt budget");
    const budget = executionBudget;
    const minimumFinalCalls = acceptanceFinalBindings(this.context, 0).length;
    budget.assertCanExecute(this.observationPlan.batches.length + minimumFinalCalls);
    // Final bindings are known before evidence execution even though their
    // reduced context is adaptive. Reserve their synthesis allowance now so
    // an impossible command cannot consume map calls first.
    budget.consumeSynthesisCalls(minimumFinalCalls);
    const executor = new PromptBatchExecutor(acceptanceExecutorOptions(agent, budget));
    const observations = await executor.execute({
      plan: this.observationPlan,
      ...acceptanceExecutorOptions(agent, budget),
      responseContract: { parse: parseObservations, itemCount: (items) => items.length },
      reducer: new AcceptanceObservationReducer(),
    });
    const initialElements = observationsAsElements(observations);
    const reductionEnvelope = new AcceptanceSummaryEnvelope();
    const reduction = new PromptReductionPlan({
      initialElements,
      coverageDigest: this.observationPlan.collection.digest,
      executionBudget: budget,
    });
    let finalCandidate = null;
    const final = await reduction.execute({
      isComplete: (elements) => {
        try {
          finalCandidate = buildAcceptanceScopedFinalPlan(this.context, elements, this.limit);
          return true;
        } catch (error) {
          if (error instanceof PromptBatchingError && [
            "PROMPT_ELEMENT_TOO_LARGE",
            "PROMPT_FIXED_CONTEXT_TOO_LARGE",
            "PROMPT_BATCH_OVERFLOW",
          ].includes(error.code)) return false;
          throw error;
        }
      },
      buildRound: (elements) => {
        const builder = new PromptInputBuilder({ envelope: reductionEnvelope, limit: this.limit });
        elements.forEach((element) => builder.add(element));
        return PromptBatchPlan.create({ collection: builder.build(), envelope: reductionEnvelope, limit: this.limit });
      },
      executeRound: (plan) => executor.executeCompletions({
        plan,
        ...acceptanceExecutorOptions(agent, budget),
        responseContract: {
          parse: (raw, batch) => {
            const value = parseAcceptanceResponse(raw);
            const expected = [...new Set(batch.payloadElements.flatMap((element) => element.sourceRefs))];
            if (!Array.isArray(value?.sourceRefs) || value.sourceRefs.length !== expected.length
              || new Set(value.sourceRefs).size !== expected.length
              || expected.some((ref) => !value.sourceRefs.includes(ref)) || typeof value.summary !== "string" || value.summary.trim() === "") {
              throw new PromptBatchingError("PROMPT_RESPONSE_COVERAGE_INVALID", "Acceptance reduction response lost source coverage");
            }
            return new AcceptanceObservationElement({
              id: `acceptance-summary.${batch.index}`,
              sourceRevision: acceptanceDigest(JSON.stringify(value)),
              sequence: batch.index,
              sourceRefs: expected,
              summary: value.summary,
            });
          },
        },
      }),
      toNextLevel: (completions) => new PromptReductionLevel({
        elements: completions.map((completion) => completion.response),
        coverageDigest: this.observationPlan.collection.digest,
      }),
      finalize: () => finalCandidate,
    });
    if (final.plan.batches.length !== minimumFinalCalls) {
      throw new PromptBatchingError("PROMPT_COVERAGE_INVALID", "Acceptance final plan count changed from its reserved binding count");
    }
    return executor.execute({
      plan: final.plan,
      ...acceptanceExecutorOptions(agent, budget),
      responseContract: {
        parse: (raw, batch) => {
          const binding = batch.payloadElements.find((element) => element instanceof AcceptanceFinalBindingElement);
          return new AcceptanceScopedResponse({ binding, response: parseAcceptanceResponse(raw) });
        },
      },
      reducer: new AcceptanceScopedReducer(final.bindings),
    });
  }
}

async function callAcceptanceAgent(agent, prompt, budget = new PromptExecutionBudget(), limit = new PromptRequestLimit()) {
  const plan = PromptBatchPlan.fromRequest({ request: prompt, limit, id: "acceptance-request" });
  return new PromptBatchExecutor({ executionBudget: budget }).execute({
    plan,
    ...acceptanceExecutorOptions(agent, budget),
    responseContract: { parse: parseAcceptanceResponse },
    reducer: new SingleResponseReducer(),
  });
}

function acceptanceAgentFailure(ctx, failure) {
  const envelope = Envelope.fail(
    "run",
    "acceptance-review",
    failure.code,
    failure.message,
    failure.toJSON(),
  );
  ctx.flowManager.failCurrentAttempt({
    specId: ctx.flowState.specId,
    failure: {
      category: "agent",
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable === true,
      retryKind: failure.retryable === true ? "tooling" : null,
    },
    result: {
      outcome: "failed",
      summary: failure.message,
      confirmedAt: new Date().toISOString(),
      artifactRefs: [],
    },
  });
  return envelope;
}

async function resolveAcceptanceArtifact(ctx, context, responseSource) {
  const fixture = responseSource.load(context);
  if (fixture) {
    return {
      artifact: artifactFromAcceptanceJudgments({
        context,
        requirementJudgments: fixture.requirementJudgments || [],
        deferredFindingDispositions: fixture.deferredFindingDispositions || [],
      }),
    };
  }
  if (context.mechanicalBlockers.length > 0) {
    return { artifact: artifactFromAcceptanceJudgments({ context, requirementJudgments: [] }) };
  }
  const agent = container.get("agent");
  let resolvedAgent;
  try {
    resolvedAgent = agent.resolve("flow.acceptance.review");
  } catch (error) {
    const failure = error instanceof AgentFailure ? error : AgentFailure.from(error);
    return { response: acceptanceAgentFailure(ctx, failure) };
  }
  if (!resolvedAgent) {
    return {
      response: acceptanceAgentFailure(ctx, new AgentPermissionConfigurationFailure({
        message: "no AI agent configured for flow.acceptance.review",
      })),
    };
  }
  try {
    const limit = new PromptRequestLimit({ maxCharacters: agent.promptCharacterLimit });
    const executionLimit = new PromptExecutionLimit({
      maxRequestCharacters: limit.maxCharacters,
      maxProviderCallCount: 100,
      maxProtocolRetryCount: 0,
      maxSynthesisCallCount: 32,
    });
    const budget = new PromptExecutionBudget(executionLimit);
    let parsed;
    try {
      const directPrompt = buildAcceptancePrompt(context);
      const directFootprint = PromptLogicalFootprint.measure(directPrompt);
      if (!directFootprint.fits(limit)) {
        throw new AcceptanceBudgetError("request", directFootprint.toJSON(), limit.maxCharacters);
      }
      parsed = await callAcceptanceAgent(agent, directPrompt, budget, limit);
    } catch (error) {
      if (!(error instanceof AcceptanceBudgetError)) throw error;
      parsed = await new AcceptanceEvidenceExecutionPlan(context, { limit, executionLimit }).execute(agent, budget);
    }
    const bound = bindAcceptanceResponse(context, parsed);
    const deferredCoverage = new DeferredDispositionCoverage(
      context,
      bound.deferredFindingDispositions,
    );
    const missingFindings = deferredCoverage.missingFindings;
    if (missingFindings.length > 0) {
      const repairParsed = await callAcceptanceAgent(
        agent,
        buildDeferredDispositionRepairPrompt(context, missingFindings),
        budget,
        limit,
      );
      const repairBound = new AcceptanceResponseBinding(context)
        .bindDeferredFindingDispositions(repairParsed.deferredFindingDispositions ?? []);
      deferredCoverage.add(repairBound);
    }
    return {
      artifact: artifactFromAcceptanceJudgments({
        context,
        requirementJudgments: bound.requirementJudgments,
        deferredFindingDispositions: deferredCoverage.requireComplete(),
      }),
    };
  } catch (error) {
    if (error instanceof AgentFailure) return { response: acceptanceAgentFailure(ctx, error) };
    throw error;
  }
}

async function executeCanonicalAcceptanceReview(ctx) {
  const state = ctx.flowState;
  const store = new CanonicalAcceptanceArtifactStore({ flowManager: ctx.flowManager, state });
  const context = await store.buildContext({ executionRoot: ctx.executionRoot || ctx.root });
  const resolved = await resolveAcceptanceArtifact(ctx, context, this.responseSource);
  if (resolved.response) return resolved.response;
  const { artifact } = resolved;
  const response = {
    result: "ok",
    verdict: artifact.verdict,
    artifact_path: store.location.relativeArtifact("acceptance.review"),
    repairFingerprint: artifact.repairFingerprint,
    requirementJudgments: artifact.requirementJudgments,
    deferredFindings: artifact.deferredFindings,
    mechanicalBlockers: artifact.mechanicalBlockers,
    hardBlockers: artifact.hardBlockers,
    evidenceRefresh: null,
  };
  return new CanonicalAcceptanceReviewPromotion({
    state,
    requirementIds: context.requirementIds,
  }).promote(response, artifact);
}

export default class RunAcceptanceReviewCommand extends FlowCommand {
  constructor({ responseSource = new AcceptanceReviewResponseSource() } = {}) {
    super();
    if (!(responseSource instanceof AcceptanceReviewResponseSource)) {
      throw new TypeError("responseSource must be an AcceptanceReviewResponseSource");
    }
    this.responseSource = responseSource;
  }

  async execute(ctx) {
    const state = ctx.flowManager.load();
    if (state?.schemaRevision !== 3) {
      throw new Error("acceptance review requires a Version-1 Flow");
    }
    return executeCanonicalAcceptanceReview.call(this, { ...ctx, flowState: state });
  }
}
