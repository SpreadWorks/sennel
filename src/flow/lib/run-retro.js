/**
 * src/flow/lib/run-retro.js
 *
 * FlowCommand: retro — aggregate per-requirement pass/fail from cataloged
 * test.execute and test.result.review Attempt histories, then attach the retro
 * publication to the active Attempt. Performs no test execution.
 */

import { FlowCommand } from "./base-command.js";
import { Envelope } from "../../lib/flow-envelope.js";
import { validateTestExecuteResultV2, validateTestResultReview } from "./test-artifacts.js";
import { buildRepairFingerprint } from "./repair-fingerprint.js";
import {
  CanonicalTestArtifactStore,
  isCanonicalFlowState,
} from "./canonical-test-artifacts.js";
import { attachCanonicalCommandResultPublications } from "./canonical-command-result.js";
import { RetroAggregate } from "./retro-values.js";
import { acceptanceStepRegistration, prepareRetroInput } from "../engine/composition/acceptance.js";
import { readCurrentRetroStaleEvidenceRecoveryFacts } from "./retro-stale-evidence-transition-facts.js";

async function executeCanonicalRetro(ctx) {
  const store = new CanonicalTestArtifactStore({ flowManager: ctx.flowManager, state: ctx.flowState });
  const reviewArtifact = store.readCurrentAttempt({
    logicalKey: "test.result.review",
    consumerNodeId: "retro",
    optional: true,
  });
  if (reviewArtifact === null) {
    return Envelope.fail(
      "run",
      "retro",
      "TEST_RESULT_REVIEW_MISSING",
      "test-result-review canonical artifact is absent: test-result-review step has not been run",
    );
  }
  const resultArtifact = store.readCurrentAttempt({
    logicalKey: "test.execute",
    consumerNodeId: "retro",
    optional: true,
  });
  if (resultArtifact === null) {
    return Envelope.fail(
      "run",
      "retro",
      "TEST_EXECUTE_RESULT_MISSING",
      "test-execute canonical artifact is absent: test-execute step has not been run",
    );
  }
  const review = reviewArtifact.payload;
  const result = resultArtifact.payload;
  try {
    validateTestResultReview(review);
    validateTestExecuteResultV2(result);
  } catch (error) {
    return Envelope.fail("run", "retro", "TEST_ARTIFACT_INVALID", error.message);
  }
  const currentFingerprint = buildRepairFingerprint({
    root: ctx.executionRoot || ctx.root,
    artifactRoot: ctx.root,
    specPath: store.location.relativeSpecFile,
  });
  const staleFacts = readCurrentRetroStaleEvidenceRecoveryFacts({
    flowManager: ctx.flowManager,
    specId: ctx.flowState.specId,
    currentFingerprint: currentFingerprint.hash,
  });
  if (staleFacts !== null) {
    const commandResult = { result: "recovered", changed: [], artifacts: {
      staleArtifacts: [...staleFacts.artifactNames], evidenceRefresh: { recovered: true,
        previousFingerprint: staleFacts.previousFingerprint, currentFingerprint: staleFacts.currentFingerprint,
        invalidatedArtifacts: [], invalidations: [], activeStep: "test-execute" } } };
    if (ctx.dryRun === true) {
      previewRetroInput({ ctx, stepId: "retro" });
      return { ...commandResult, result: "dry-run" };
    }
    const state = ctx.flowManager.canonicalState(ctx.flowState.specId);
    const preparation = prepareRetroInput({ flowManager: ctx.flowManager, state, commandResult,
      fingerprint: currentFingerprint.hash, staleFacts });
    await executeRetroInput({ ctx, flowManager: ctx.flowManager, stepId: "retro", binding: preparation.binding, preparation, commandResult });
    return {
      result: "recovered",
      changed: [],
      artifacts: {
        staleArtifacts: [...staleFacts.artifactNames],
        evidenceRefresh: {
          recovered: true,
          previousFingerprint: staleFacts.previousFingerprint,
          currentFingerprint: staleFacts.currentFingerprint,
          invalidatedArtifacts: [],
          invalidations: [],
          activeStep: "test-execute",
        },
      },
    };
  }
  if (review.verdict !== "pass") {
    return Envelope.fail(
      "run",
      "retro",
      "TEST_RESULT_REVIEW_NOT_PASSED",
      "test-result-review canonical verdict is not pass; cannot aggregate untrusted results.",
    );
  }
  const spec = store.readSpec("retro");
  const requirements = Array.isArray(spec.requirements) ? spec.requirements : [];
  if (requirements.length === 0) {
    return Envelope.fail("run", "retro", "NO_REQUIREMENTS", "no requirements found in canonical spec.json");
  }
  const retro = {
    spec: store.location.relativeSpecFile,
    repairFingerprint: currentFingerprint.hash,
    date: new Date().toISOString(),
    mode: "attempt-history",
    ...new RetroAggregate(requirements, result.summary).toJSON(),
  };
  const retroPath = store.location.relativeArtifact("retro");
  if (ctx.dryRun === true) {
    previewRetroInput({ ctx, stepId: "retro" });
    return {
      result: "dry-run",
      artifacts: { spec: store.location.relativeSpecFile, retroPath, summary: retro.summary, requirements: retro.requirements },
    };
  }
  const commandResult = attachCanonicalCommandResultPublications({
    result: "ok",
    changed: [retroPath],
    artifacts: {
      spec: store.location.relativeSpecFile,
      retroPath,
      summary: retro.summary,
      requirements: retro.requirements,
      mode: "attempt-history",
    },
  }, [{ logicalKey: "retro", payload: retro }]);
  const preparation = prepareRetroInput({ flowManager: ctx.flowManager,
    state: ctx.flowManager.canonicalState(ctx.flowState.specId), commandResult, fingerprint: currentFingerprint.hash });
  await executeRetroInput({ ctx, flowManager: ctx.flowManager, stepId: "retro", binding: preparation.binding, preparation, commandResult });
  return commandResult;
}

export function executeRetroInput(input) {
  const registration = acceptanceStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Retro execution requires its production registration");
  const selection = registration.executionContract.select({ ...input, registration });
  return registration.executionContract.execute(selection, { ...input, registration });
}
export function previewRetroInput(input) {
  const registration = acceptanceStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Retro preview requires its production registration");
  const selection = registration.executionContract.select({ ...input, registration });
  return registration.executionContract.project(selection, { ...input, registration });
}

export class RunRetroCommand extends FlowCommand {
  async execute(ctx) {
    const state = ctx.flowState;
    if (isCanonicalFlowState(state)) return executeCanonicalRetro(ctx);
    throw new Error("retro requires a Version-1 Flow");
  }
}

export default RunRetroCommand;
