import { repairJson } from "../../lib/json-parse.js";
import { container } from "../../lib/container.js";
import { PromptBuilder } from "../../lib/prompt-builder.js";
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

export const MAX_ACCEPTANCE_REQUEST_CHARS = 900_000;
export const MAX_ACCEPTANCE_RESPONSE_CHARS = 900_000;
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

export function buildAcceptancePrompt(context) {
  const evidence = JSON.stringify(context.evidence, null, 2);
  const prompt = new PromptBuilder()
    .setRole("You are the semantic acceptance reviewer. Judge every requirement against the complete current evidence chain.")
    .setRules([
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
    ].join("\n"))
    .setJsonSchema(ACCEPTANCE_RESPONSE_SCHEMA)
    .setFmtFallback(`Return only JSON matching this schema:\n${JSON.stringify(ACCEPTANCE_RESPONSE_SCHEMA)}`)
    .addUserPrompt("## Acceptance Evidence", evidence)
    .build();
  return assertAcceptancePromptBudget(prompt);
}

function assertAcceptancePromptBudget(prompt) {
  const components = {
    systemPrompt: prompt.systemPrompt?.length || 0,
    userPrompt: prompt.userPrompt.length,
    jsonSchema: JSON.stringify(prompt.jsonSchema).length,
    fmtFallback: prompt.fmtFallback?.length || 0,
  };
  const total = Object.values(components).reduce((sum, size) => sum + size, 0);
  if (total > MAX_ACCEPTANCE_REQUEST_CHARS) {
    throw new AcceptanceBudgetError("request", { ...components, total }, MAX_ACCEPTANCE_REQUEST_CHARS);
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

async function callAcceptanceAgent(agent, prompt) {
  const response = await agent.call(prompt.userPrompt, {
    commandId: "flow.acceptance.review",
    systemPrompt: prompt.systemPrompt,
    jsonSchema: prompt.jsonSchema,
    fmtFallback: prompt.fmtFallback,
  });
  return parseAcceptanceResponse(response);
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
    const parsed = await callAcceptanceAgent(agent, buildAcceptancePrompt(context));
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
