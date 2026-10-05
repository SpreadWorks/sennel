/**
 * src/flow/lib/resolve-context-envelope.js
 *
 * Shared payload builder for `flow get resolve-context` and `flow run resume`.
 * Both commands expose the same envelope shape; centralizing the assembly here
 * removes the drift risk of maintaining two parallel copies (spec 219 review).
 */

import fs from "fs";
import { getWorktreeStatus, getCurrentBranch, getAheadCount, getLastCommit, isGhAvailable } from "../../lib/git-helpers.js";
import { derivePhase } from "../../lib/flow-helpers.js";
import { FlowCompletion } from "./flow-completion.js";
import { flattenSteps } from "./step-tree.js";
import { PRODUCT } from "../../lib/product.js";
import { CanonicalSpecRecord } from "./canonical-spec-record.js";

const SKILL_BY_PHASE = { sync: PRODUCT.skill("flow-sync") };
const DEFAULT_SKILL = PRODUCT.skill("flow");

function phaseToSkill(phase) {
  return SKILL_BY_PHASE[phase] ?? DEFAULT_SKILL;
}

/**
 * Build the shared `{ mainRepoPath, worktreePath, ... }` envelope consumed by
 * both `get-resolve-context` and `run-resume`. Throws when no active flow is
 * found, matching the legacy behavior of both commands.
 *
 * @param {Object} ctx - flow command context (mainRoot, root, flowManager, flowState)
 * @returns {Object} envelope fields shared by both commands
 */
export function buildResolvedFlowContext(ctx) {
  const { root, mainRoot, flowManager } = ctx;

  const resolved = flowManager.resolveActiveFlow(ctx.flowState, {
    selectSpecId: ctx.spec || undefined,
  });
  if (!resolved) {
    throw new Error("no active flow found");
  }

  const { state, specId, worktreePath } = resolved;
  const mainRepoPath = mainRoot;
  const specLocation = flowManager.specLocation(specId);
  const flowJsonPath = specLocation.flowStateFile;

  const steps = state.steps || [];
  const phase = derivePhase(state);
  // spec 251 R42: flatten nested children so impl-phase leaves
  // (test-execute, test-result-review, retro, finalize-*) participate in
  // currentStep / progress reporting consumed by skills.
  const leafSteps = flattenSteps(steps);
  const currentStep = leafSteps.find((s) => s.status === "in_progress");
  const doneSteps = leafSteps.filter((s) => s.status === "done" || s.status === "skipped");

  const specRecord = new CanonicalSpecRecord({
    flowManager,
    state,
    consumerNodeId: "system",
  });
  const spec = specRecord.document();
  const goal = typeof spec.goal === "string" && spec.goal.trim() ? spec.goal.trim() : null;
  const scope = spec.scope && typeof spec.scope === "object" ? spec.scope : null;
  const effectiveRoot = worktreePath && fs.existsSync(worktreePath) ? worktreePath : mainRepoPath;

  const { dirty, dirtyFiles } = getWorktreeStatus(effectiveRoot);
  const currentBranch = getCurrentBranch(effectiveRoot);
  const aheadCount = getAheadCount(effectiveRoot, state.baseBranch || "main");
  const lastCommit = getLastCommit(effectiveRoot);
  const ghAvailable = isGhAvailable();
  const completion = new FlowCompletion(state);
  return {
    mainRepoPath,
    worktreePath,
    activeFlow: specId,
    flowJsonPath,
    specId: state.specId,
    baseBranch: state.baseBranch,
    featureBranch: state.featureBranch,
    worktree: state.worktree || false,
    issue: state.issue || null,
    phase,
    currentStep: currentStep?.id || null,
    progress: { done: doneSteps.length, total: leafSteps.length },
    request: state.request || null,
    goal,
    scope,
    requirements: specRecord.requirements(),
    notes: state.notes || [],
    dirty,
    dirtyFiles,
    currentBranch,
    aheadCount,
    lastCommit,
    ghAvailable,
    completion: completion.toJSON(),
    recommendedSkill: phaseToSkill(phase),
  };
}
