import { executeFinalizationCommand, finalizationStepRegistration } from "../engine/composition/finalization.js";
import { CanonicalReportArtifactStore, assertCanonicalReportFinalEvidence } from "./canonical-report-artifacts.js";
import { runGit } from "../../lib/git-helpers.js";
import { FlowCommand } from "./base-command.js";
import {
  runFinalizePreflight,
  runPreflightChecks,
  commitOrSkip,
  hasOutboxCommit,
  outboxCommitMarker,
  runMigrationHook,
} from "./run-finalize.js";
import { FinalizeCommitPathSet } from "./finalize-commit-paths.js";
import { finalizationOutboxIdentity } from "./flow-outbox.js";
import { StepAdmissionRefusal } from "./step-admission-refusal.js";

export class FinalizeCommitEffectPreparation {
  constructor({ root, artifactRoot, specId, message, idempotencyKey, implementationPaths = [], resumed = false }) {
    Object.assign(this, { root, artifactRoot, specId, message, idempotencyKey, resumed });
    this.implementationPaths = Object.freeze([...implementationPaths]);
    Object.freeze(this);
  }
  assertContext(ctx) {
    if (this.root !== (ctx.executionRoot || ctx.root) || this.artifactRoot !== (ctx.repositoryRoot || ctx.root)
      || this.specId !== ctx.flowState.specId) throw new StepAdmissionRefusal("Finalize commit preparation belongs to another execution context");
  }
  assertCurrent(ctx) {
    this.assertContext(ctx);
    if (this.resumed) return;
    const report = new CanonicalReportArtifactStore({ flowManager: ctx.flowManager, state: ctx.flowState })
      .readDocument({ logicalKey: "report", consumerNodeId: "finalize-commit" });
    assertCanonicalReportFinalEvidence({ flowManager: ctx.flowManager, specId: this.specId, report: report.value });
  }
}

export function executeFinalizeCommitInput(input) {
  const registration = finalizationStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Finalize commit execution requires its registered Step");
  const selection = registration.executionContract.select({ ...input, registration });
  return registration.executionContract.execute(selection, { ...input, registration });
}

export class RunFinalizeCommitCommand extends FlowCommand {
  async execute(ctx) {
    return executeFinalizationCommand({ ctx, command: this, stepId: "finalize-commit", executeInput: (input) => executeFinalizeCommitInput(input) });
  }

  async prepareEffect(ctx) {
    const root = ctx.executionRoot || ctx.root;
    const artifactRoot = ctx.repositoryRoot || ctx.root;
    const state = ctx.flowState;
    const message = ctx.message || "";
    const idempotencyKey = ctx.flowOutboxEntry?.idempotencyKey
      || finalizationOutboxIdentity(state, "finalize-commit").idempotencyKey;
    const msg = message || `feat: ${state.featureBranch || "finalize"}`;

    if (hasOutboxCommit({ root, ref: "HEAD", idempotencyKey })) {
      return new FinalizeCommitEffectPreparation({ root, artifactRoot, specId: state.specId,
        message: msg, idempotencyKey, resumed: true });
    }

    try { await runFinalizePreflight(root); }
    catch (error) {
      if (error.code !== "FINALIZE_PREFLIGHT_FAILED") throw error;
      const refusal = new StepAdmissionRefusal(error.message, error);
      refusal.code = error.code;
      throw refusal;
    }

    const preflight = runPreflightChecks({
      root,
      baseBranch: state.baseBranch,
      featureBranch: state.featureBranch ?? state.baseBranch,
      commitStepActive: true,
    });
    if (!preflight.ok) {
      throw new StepAdmissionRefusal(preflight.reason === "no-commits"
        ? `no commits on ${preflight.featureBranch} beyond ${preflight.baseBranch}`
        : `uncommitted changes in worktree: ${preflight.uncommittedFiles.join(", ")}`);
    }

    const specId = state.specId;

    const commitPaths = new FinalizeCommitPathSet({
      repositoryRoot: artifactRoot,
      specRoot: ctx.specRoot,
      specId,
    });
    const sourceAuthorities = ctx.flowManager.sourceHandoffAuthorities({ specId })
      .filter((authority) => authority.identity.runId === state.runId);
    const implementationPaths = commitPaths.resolveImplementationPaths({ root, sourceAuthorities });
    const acquired = new FinalizeCommitEffectPreparation({ root, artifactRoot, specId, message: msg, idempotencyKey, implementationPaths });
    acquired.assertCurrent(ctx);
    return acquired;
  }

  async executeEffect(ctx, preparation = null) {
    const acquired = preparation ?? await this.prepareEffect(ctx);
    if (!(acquired instanceof FinalizeCommitEffectPreparation)) throw new TypeError("Finalize commit requires its acquired effect preparation");
    acquired.assertContext(ctx);
    if (acquired.resumed) return { status: "done", message: acquired.message, resumed: true };
    runMigrationHook(acquired.artifactRoot, ctx.flowManager.specLocation(acquired.specId).relativeSpecFile, acquired.root);
    if (acquired.implementationPaths.length === 0) return { status: "skipped", message: "nothing to commit" };
    const add = runGit(["add", "-A", "--", ...acquired.implementationPaths], { cwd: acquired.root });
    if (!add.ok) throw new Error(`failed to stage implementation paths: ${add.stderr || add.stdout}`);

    const markerArgs = acquired.idempotencyKey ? ["-m", outboxCommitMarker(acquired.idempotencyKey)] : [];
    const res = commitOrSkip(["--only", "-m", acquired.message, ...markerArgs, "--", ...acquired.implementationPaths], { cwd: acquired.root });
    return { ...res, message: acquired.message };
  }
}

export default RunFinalizeCommitCommand;
