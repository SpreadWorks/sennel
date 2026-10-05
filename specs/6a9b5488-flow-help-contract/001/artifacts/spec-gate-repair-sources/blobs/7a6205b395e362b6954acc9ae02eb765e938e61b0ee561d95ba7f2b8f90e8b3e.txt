/**
 * src/flow/lib/get-guardrail.js
 *
 * Return guardrails filtered by phase.
 *
 * ctx.phase  — one of VALID_PHASES (see constants.js)
 * ctx.format — "json" or undefined (default: markdown string)
 */

import { loadMergedGuardrails, filterByPhase } from "../../lib/guardrail.js";
import { FlowCommand } from "./base-command.js";
import { VALID_GUARDRAIL_PHASES } from "../../lib/constants.js";

const PHASE_ALIASES = Object.freeze({
  impl: "task-impl",
});

function normalizeGuardrailPhase(phase) {
  return PHASE_ALIASES[phase] || phase;
}

/**
 * Render guardrails as Markdown text.
 * @param {Object[]} guardrails
 * @returns {string}
 */
function toMarkdown(guardrails) {
  return guardrails
    .map((g) => `## Guardrail: ${g.title} (${g.id})\n\n${g.body.trim()}`)
    .join("\n\n");
}

export default class GetGuardrailCommand extends FlowCommand {
  constructor() {
    super({ requiresFlow: false });
  }

  execute(ctx) {
    const { root } = ctx;
    const { phase, format } = ctx;

    const normalizedPhase = normalizeGuardrailPhase(phase);

    if (!phase) {
      throw new Error(`phase required. valid: ${VALID_GUARDRAIL_PHASES.join(", ")} (alias: impl -> task-impl)`);
    }

    if (!VALID_GUARDRAIL_PHASES.includes(normalizedPhase)) {
      throw new Error(`unknown phase '${phase}'. valid: ${VALID_GUARDRAIL_PHASES.join(", ")} (alias: impl -> task-impl)`);
    }

    const guardrails = loadMergedGuardrails(root);
    const filtered = filterByPhase(guardrails, normalizedPhase);

    if (format === "json") {
      return {
        phase: normalizedPhase,
        count: filtered.length,
        guardrails: filtered.map((g) => ({
          id: g.id,
          title: g.title,
          body: g.body.trim(),
          meta: g.meta,
        })),
      };
    }

    // Default: return markdown string
    return { markdown: toMarkdown(filtered) };
  }
}
