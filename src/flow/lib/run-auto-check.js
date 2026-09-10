/**
 * src/flow/lib/run-auto-check.js
 *
 * `sennel flow run auto-check` — phase-aware eligibility check for auto mode.
 *
 * Flow (spec 220):
 *   - resolve the target flow (active flow.json or preparing record via --run-id)
 *   - delegate input resolution to `resolve-auto-check-input` which picks the
 *     payload based on phase markers in flow state (see that module for rules)
 *   - if the resolver signals skip (spec approved), return without invoking
 *     the AI; exact V1 state never caches the verdict
 *   - otherwise: static gates (keyword match, sync) → AI scoring → compose
 *     eligible verdict
 *
 * The preparing-state persistence path is what allows the subsequent
 * `flow set auto on` to trust this verdict instead of re-invoking the AI
 * with a different input (spec 218).
 *
 * Spec 208: R1 / R2 / R3 / R4 / R5 / R6 / R13.
 * Spec 218: preparing-flow persistence for split-brain elimination.
 * Spec 220: phase-aware input, spec-approved skip, --run-id required for
 *           preparing-mode targeting (no auto-select).
 *
 * ctx inputs (merged from CLI by FlowCommand base):
 *   - runId: optional for active flow; REQUIRED in preparing mode.
 */

import { FlowCommand } from "./base-command.js";
import { evaluateStaticGates } from "./auto-check-static.js";
import { resolvePreparingRunId } from "./resolve-preparing-run-id.js";
import {
  CanonicalAutoCheckInputError,
  resolvePreparingAutoCheckInput,
  resolveAutoCheckInputForFlow,
  buildSkipVerdict,
} from "./resolve-auto-check-input.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { PromptBuilder } from "../../lib/prompt-builder.js";
import { PromptBatchPlan, PromptRequestLimit, PromptBatchingError } from "../../lib/prompt-batching.js";
import {
  AgentFailure,
  AgentPermissionConfigurationFailure,
} from "../../lib/agent-failure.js";

const AUTO_CHECK_ROLE = `You evaluate whether a feature request can safely proceed in Spec-Driven Development "auto mode" —
meaning the AI drafts, specs, and implements without human confirmation loops.`;

const AUTO_CHECK_RULES = `Score the following request on six dimensions (0/1/2 each).

- specBuildability (weight 3) — can Goal / Scope / Acceptance be derived?
  0 = cannot determine Goal or Acceptance without clarification
  1 = main requirements derivable but some inference needed
  2 = Goal / Scope / Acceptance all directly derivable
- ambiguity (weight 3) — is the input unambiguous?
  0 = multiple plausible interpretations
  1 = minor ambiguity survivable with defaults
  2 = no meaningful ambiguity
- verifiability (weight 2) — can success be verified mechanically?
  0 = no observable criterion
  1 = partially subjective
  2 = clear, testable criterion
- scopeBoundedness (weight 2) — is the scope bounded?
  0 = open-ended
  1 = mostly bounded
  2 = clearly bounded
- targetSpecificity (weight 1) — are the targets specified?
  0 = unclear
  1 = partially specified
  2 = specific files/modules/commands identified
- precedent (weight 1) — is there similar prior work?
  0 = novel
  1 = partial precedent
  2 = clear precedent

Also include a temporary goal field. The goal is the concrete outcome this request asks the flow to achieve. If no concrete goal can be derived, output null.
Also include a reason field (short string, under 200 chars, Japanese).`;

export const AUTO_CHECK_SCHEMA = {
  type: "object",
  properties: {
    specBuildability: { type: "integer" },
    ambiguity: { type: "integer" },
    verifiability: { type: "integer" },
    scopeBoundedness: { type: "integer" },
    targetSpecificity: { type: "integer" },
    precedent: { type: "integer" },
    goal: { type: ["string", "null"] },
    reason: { type: "string" },
  },
  required: ["specBuildability", "ambiguity", "verifiability", "scopeBoundedness", "targetSpecificity", "precedent", "goal", "reason"],
  additionalProperties: false,
};

const AUTO_CHECK_FMT_FALLBACK = 'Output JSON only, no prose. Use these exact keys and integer scores.\nOutput JSON shape (no markdown fence, no prose):\n{"specBuildability": N, "ambiguity": N, "verifiability": N, "scopeBoundedness": N, "targetSpecificity": N, "precedent": N, "goal": "...", "reason": "..."}';

const WEIGHTS = {
  specBuildability: 3,
  ambiguity: 3,
  verifiability: 2,
  scopeBoundedness: 2,
  targetSpecificity: 1,
  precedent: 1,
};
const MAX_SCORE = Object.values(WEIGHTS).reduce((a, b) => a + b, 0) * 2; // 24
const THRESHOLD = 16;
const HARD_GATE_KEYS = ["specBuildability", "ambiguity", "verifiability"];
const CATEGORY_KEYS = Object.keys(WEIGHTS);

export function computeScore(breakdown) {
  let total = 0;
  for (const key of CATEGORY_KEYS) {
    const v = Number(breakdown?.[key] ?? 0);
    total += v * WEIGHTS[key];
  }
  return total;
}

const HARD_GATE_MIN_SUM = 2;

function computeHardGateSum(breakdown) {
  return HARD_GATE_KEYS.reduce((acc, k) => acc + Number(breakdown?.[k] ?? 0), 0);
}

export function hardGateFailed(breakdown) {
  return computeHardGateSum(breakdown) < HARD_GATE_MIN_SUM;
}

function parseAiResponse(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?|```$/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error("no JSON object in AI response");
  return JSON.parse(cleaned.slice(start, end + 1));
}

function emptyBreakdown() {
  const b = {};
  for (const k of CATEGORY_KEYS) b[k] = 0;
  return b;
}

function sanitizeBreakdown(raw) {
  const b = {};
  for (const k of CATEGORY_KEYS) {
    const v = Number(raw?.[k]);
    b[k] = Number.isFinite(v) ? Math.max(0, Math.min(2, Math.floor(v))) : 0;
  }
  return b;
}

function goalMissing(goal) {
  if (goal == null) return true;
  const normalized = String(goal).trim().toLowerCase();
  return normalized === "" || ["unknown", "n/a", "na", "not specified", "null"].includes(normalized);
}

async function scoreWithAi(container, inputText) {
  let agent;
  try {
    agent = container.get("agent");
  } catch (err) {
    return { breakdown: emptyBreakdown(), reason: `agent unavailable: ${err.message}`, ok: false };
  }
  let resolvedAgent;
  try {
    resolvedAgent = agent?.resolve?.("flow.auto-check");
  } catch (error) {
    const failure = error instanceof AgentFailure ? error : AgentFailure.from(error);
    return { breakdown: emptyBreakdown(), reason: failure.message, failure: failure.toJSON(), ok: false };
  }
  if (!resolvedAgent) {
    const failure = new AgentPermissionConfigurationFailure({
      message: "no agent profile for auto-check",
    });
    return { breakdown: emptyBreakdown(), reason: failure.message, failure: failure.toJSON(), ok: false };
  }
  const pb = new PromptBuilder();
  pb.setRole(AUTO_CHECK_ROLE);
  pb.setRules(AUTO_CHECK_RULES);
  pb.setJsonSchema(AUTO_CHECK_SCHEMA);
  pb.setFmtFallback(AUTO_CHECK_FMT_FALLBACK);
  pb.addUserPrompt("## Input text (request / Issue body)", inputText);
  const built = pb.build();

  let responseText;
  try {
    const limit = new PromptRequestLimit({ maxCharacters: agent.promptCharacterLimit ?? 120_000 });
    PromptBatchPlan.fromRequest({ request: built, limit, id: "auto-check-input" });
    responseText = await agent.call(built.userPrompt, {
      commandId: "flow.auto-check",
      systemPrompt: built.systemPrompt,
      jsonSchema: built.jsonSchema,
      fmtFallback: built.fmtFallback,
    });
  } catch (err) {
    if (err instanceof PromptBatchingError) {
      return {
        breakdown: emptyBreakdown(), reason: err.message,
        failure: { code: err.code, message: err.message, details: err.details }, ok: false,
      };
    }
    const failure = err instanceof AgentFailure ? err : AgentFailure.from(err);
    return {
      breakdown: emptyBreakdown(),
      reason: `agent call failed: ${failure.message}`,
      failure: failure.toJSON(),
      ok: false,
    };
  }
  let parsed;
  try {
    parsed = parseAiResponse(responseText);
  } catch (err) {
    return { breakdown: emptyBreakdown(), reason: `parse error: ${err.message}`, ok: false };
  }
  return {
    breakdown: sanitizeBreakdown(parsed),
    goal: parsed.goal,
    reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 300) : "",
    ok: true,
  };
}

/**
 * Pure function: given input text and an optional AI result, compute the
 * final autoCheck envelope. Kept separate so set-auto.js can re-use the
 * same shape without re-invoking the CLI.
 */
export function composeAutoCheck({ staticGates, aiBreakdown, aiReason, aiOk, aiGoal, aiFailure = null }) {
  const staticFail = !staticGates.eligible;
  const breakdown = staticFail ? emptyBreakdown() : aiBreakdown;
  const score = computeScore(breakdown);
  const hardFail = staticFail ? false : hardGateFailed(breakdown);
  const goalFail = staticFail ? false : goalMissing(aiGoal);
  const eligible = !staticFail && aiOk && !hardFail && !goalFail && score >= THRESHOLD;
  const reasonParts = [];
  if (staticFail) {
    const hits = ["G", "H", "I"].filter((k) => staticGates[k]);
    reasonParts.push(`static gate hit: ${hits.join(", ")}`);
  }
  if (!staticFail && !aiOk) reasonParts.push(aiReason || "ai call failed");
  if (!staticFail && aiOk && hardFail) {
    reasonParts.push(`hard-gate sum ${computeHardGateSum(breakdown)} below ${HARD_GATE_MIN_SUM}`);
  }
  if (!staticFail && aiOk && !hardFail && goalFail) {
    reasonParts.push("goal missing");
  }
  if (!staticFail && aiOk && !hardFail && !goalFail && score < THRESHOLD) {
    reasonParts.push(`score ${score}/${MAX_SCORE} below threshold ${THRESHOLD}`);
  }
  if (reasonParts.length === 0 && aiReason) reasonParts.push(aiReason);
  return {
    eligible,
    score,
    maxScore: MAX_SCORE,
    threshold: THRESHOLD,
    breakdown,
    staticGates: { G: !!staticGates.G, H: !!staticGates.H, I: !!staticGates.I },
    goalGate: { checked: !staticFail && aiOk, passed: !staticFail && aiOk && !goalFail },
    reason: reasonParts.join("; "),
    ...(aiFailure ? { failure: aiFailure } : {}),
  };
}

export async function runAutoCheckCore(container, inputText) {
  const staticGates = evaluateStaticGates(inputText);
  let aiResult = { breakdown: emptyBreakdown(), reason: "", ok: true };
  if (staticGates.eligible) {
    aiResult = await scoreWithAi(container, inputText);
  }
  return composeAutoCheck({
    staticGates,
    aiBreakdown: aiResult.breakdown,
    aiReason: aiResult.reason,
    aiOk: aiResult.ok,
    aiGoal: aiResult.goal,
    aiFailure: aiResult.failure,
  });
}

export default class RunAutoCheckCommand extends FlowCommand {
  constructor() {
    super({ requiresFlow: false });
  }

  async execute(ctx) {
    // Active flow path: state is already loaded; resolve input from state phase
    if (ctx.flowManager && ctx.flowState) {
      let resolved;
      try {
        resolved = resolveAutoCheckInputForFlow({
          flowManager: ctx.flowManager,
          state: ctx.flowState,
        });
      } catch (error) {
        if (error instanceof CanonicalAutoCheckInputError) {
          return Envelope.fail("run", "auto-check", error.code, error.message);
        }
        throw error;
      }
      if (resolved.skip) {
        const verdict = buildSkipVerdict();
        return verdict;
      }
      if (resolved.fail) {
        return resolved.verdict;
      }
      const result = {
        ...(await runAutoCheckCore(this.container, resolved.text)),
        ...(resolved.goalGate ? { goalGate: resolved.goalGate } : {}),
      };
      return result;
    }

    // Preparing flow path: --run-id is required (no auto-select, no auto-skip).
    // Per spec 220 A3: both zero-preparing and multi-preparing cases without
    // --run-id surface as MISSING_RUN_ID so the caller always sees a consistent
    // error code for "you must specify which preparing flow to target".
    if (ctx.flowManager) {
      if (!ctx.runId) {
        return Envelope.fail(
          "run",
          "auto-check",
          "MISSING_RUN_ID",
          "--run-id is required when no active flow exists",
        );
      }
      const resolvedId = resolvePreparingRunId(ctx.flowManager, ctx.runId, {
        type: "run",
        key: "auto-check",
      });
      if (resolvedId.fail) return resolvedId.fail;
      const state = ctx.flowManager.loadPreparingFlow(resolvedId.runId);
      // Preparing records have no spec directory yet, so draft body is not
      // available. Only base input (issue + request) is used.
      const resolvedInput = resolvePreparingAutoCheckInput(state);
      if (resolvedInput.skip) {
        const verdict = buildSkipVerdict();
        ctx.flowManager.mutatePreparingFlow(resolvedId.runId, (s) => {
          s.autoCheck = verdict;
        });
        return verdict;
      }
      if (resolvedInput.fail) {
        ctx.flowManager.mutatePreparingFlow(resolvedId.runId, (s) => {
          delete s.autoCheck;
        });
        return resolvedInput.verdict;
      }
      const result = {
        ...(await runAutoCheckCore(this.container, resolvedInput.text)),
        ...(resolvedInput.goalGate ? { goalGate: resolvedInput.goalGate } : {}),
      };
      if (result.eligible) {
        ctx.flowManager.mutatePreparingFlow(resolvedId.runId, (s) => {
          s.autoCheck = result;
        });
      } else {
        ctx.flowManager.mutatePreparingFlow(resolvedId.runId, (s) => {
          delete s.autoCheck;
        });
      }
      return result;
    }

    // No flowManager (unusual; defensive): run stateless with empty input
    return await runAutoCheckCore(this.container, "");
  }
}
