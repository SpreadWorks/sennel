/**
 * src/flow/lib/get-check.js
 *
 * Check prerequisites for a phase.
 * Prerequisites are derived from the definition hierarchy.
 */

import { isGhAvailable, runGit } from "../../lib/git-helpers.js";
import { VALID_CHECK_TARGETS } from "../../lib/constants.js";
import { FlowCommand } from "./base-command.js";
import { deriveFlowPrereqs } from "../definition.js";
import { flattenSteps } from "./step-tree.js";

function checkStepPrereqs(state, targetId) {
  const required = deriveFlowPrereqs(targetId);
  const flat = Array.isArray(state.steps) && state.steps.some((s) => s.children)
    ? flattenSteps(state.steps)
    : (state.steps || []);
  const checks = [];
  for (const id of required) {
    const step = flat.find((s) => s.id === id);
    const pass = step && (step.status === "done" || step.status === "skipped");
    checks.push({ id, pass, message: pass ? `${id}: ${step.status}` : `${id}: not completed` });
  }
  const pass = checks.every((c) => c.pass);
  const summary = pass ? "all prerequisites met" : `missing: ${checks.filter((c) => !c.pass).map((c) => c.id).join(", ")}`;
  return { pass, summary, checks };
}

function checkDirty(root) {
  const res = runGit(["status", "--short"], { cwd: root });
  if (!res.ok) {
    return { pass: false, summary: "git status failed", checks: [{ id: "dirty", pass: false, message: res.stderr }] };
  }
  const lines = res.stdout.trim().split("\n").filter(Boolean);
  const pass = lines.length === 0;
  return {
    pass,
    summary: pass ? "working tree clean" : `${lines.length} uncommitted change(s)`,
    checks: [{ id: "dirty", pass, message: pass ? "clean" : lines.join(", ") }],
  };
}

function checkGh() {
  const available = isGhAvailable();
  return {
    pass: available,
    summary: available ? "gh available" : "gh command not found",
    checks: [{ id: "gh", pass: available, message: available ? "available" : "not available" }],
  };
}

export default class GetCheckCommand extends FlowCommand {
  constructor() {
    super({ requiresFlow: false });
  }

  execute(ctx) {
    const { root } = ctx;
    const executionRoot = ctx.executionRoot || root;
    const target = ctx.target;

    if (!target) {
      throw new Error(`target required. valid: ${VALID_CHECK_TARGETS.join(", ")}`);
    }

    if (!VALID_CHECK_TARGETS.includes(target)) {
      throw new Error(`unknown target '${target}'. valid: ${VALID_CHECK_TARGETS.join(", ")}`);
    }

    if (target === "dirty") {
      return checkDirty(executionRoot);
    }

    if (target === "gh") {
      return checkGh();
    }

    const state = ctx.flowState;
    if (!state) {
      return { pass: false, summary: "no active flow", checks: [] };
    }

    return checkStepPrereqs(state, target === "impl" ? "implement" : target);
  }
}
