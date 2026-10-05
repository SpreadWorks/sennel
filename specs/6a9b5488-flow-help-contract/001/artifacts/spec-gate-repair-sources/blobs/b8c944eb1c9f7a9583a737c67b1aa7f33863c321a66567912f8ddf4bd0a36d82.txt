/**
 * src/flow/lib/run-lint.js
 *
 * FlowCommand: lint — run guardrail lint patterns against changed files.
 */

import { loadMergedGuardrails } from "../../lib/guardrail.js";
import { runLint } from "../../lib/lint.js";
import { FlowCommand } from "./base-command.js";

export class RunLintCommand extends FlowCommand {
  async execute(ctx) {
    const root = ctx.executionRoot || ctx.root;

    // Resolve base branch from flow state if not provided
    let base = ctx.base || "";
    if (!base) {
      const state = ctx.flowState;
      if (state?.baseBranch) {
        base = state.baseBranch;
      } else {
        throw new Error("no --base provided and no active flow found");
      }
    }

    // Load merged guardrail articles
    const allGuardrails = loadMergedGuardrails(root);
    if (allGuardrails.length === 0) {
      return {
        result: "pass",
        message: "no guardrails found",
        warnings: [],
        failures: [],
      };
    }

    const result = runLint(root, allGuardrails, base);

    for (const w of result.warnings) {
      console.error(w);
    }

    if (!result.ok) {
      throw new Error(
        [`${result.failures.length} violation(s) found`,
          ...result.failures.map((f) => `FAIL: [${f.guardrail}] ${f.file}:${f.line} — ${f.match}`),
        ].join("\n"),
      );
    }

    return {
      result: "pass",
      lintGuardrailCount: result.lintGuardrailCount,
      fileCount: result.fileCount,
      warnings: result.warnings,
      failures: [],
    };
  }
}

export default RunLintCommand;
