import { acquireRequirementTestInput, requirementTestWorkerStepRegistration } from "../engine/composition/test.js";
import { RequirementTestArtifactStore } from "../lib/requirement-test-store.js";
import { RequirementTestSemanticFinding } from "../lib/requirement-test-lifecycle.js";
import { RequirementTestFailureArtifact, RequirementTestDeferredReceipt } from "../lib/requirement-test-artifacts.js";
import { buildDeferredSemanticFindingsPublication } from "../lib/flow-findings.js";
import { RequirementTestExternalBlockedError, RequirementTestToolingEvidence } from "../engine/step-result.js";
import { RequirementTestSettlementPublication } from "./requirement-test-settlement-writer.js";
import { RequirementTestService } from "./requirement-test-service.js";
import { CanonicalFlowArtifactBaseline } from "../lib/current-flow-state.js";
import { requirementTestToolingFailureFinding } from "../lib/canonical-flow-manager-store.js";

/** Persist a classified worker failure through the same registered Result and Service as worker success. */
export function settleRequirementTestFailure({
  flowManager, specId = null, kind, message = null, failure = null,
  structuralResult = null, commandResult = null,
} = {}) {
  const state = flowManager.canonicalState(specId);
  const stepId = state.current?.at(-1) ?? null;
  if (!new Set(["test-generate", "test-review", "test-repair"]).has(stepId) || state.attempt === null) {
    throw new Error("Requirement test failure settlement requires an active worker-leaf Attempt");
  }
  const store = new RequirementTestArtifactStore({ flowManager, state });
  const planRead = store.readPlan(stepId);
  const specRecord = flowManager.readArtifact({ specId: state.specId, logicalKey: "spec.record", consumerNodeId: stepId });
  let candidateBundle = null;
  let structuralFinding = null;
  let evidence = null;
  let error = null;
  let inputPublications = { artifactWrites: [], artifactRemovals: [], artifactBaselines: [] };

  if (kind === "structural") {
    const input = structuralResult.connectorInput();
    candidateBundle = input.candidate;
    structuralFinding = new RequirementTestSemanticFinding({
      requirementId: input.finding.requirementId,
      bundleRevision: input.finding.bundleRevision,
      fingerprint: input.finding.fingerprint,
    });
    inputPublications = input.publications;
  } else {
    const reason = kind === "external" ? failure?.message : message;
    evidence = new RequirementTestToolingEvidence({
      reason: String(reason || "Requirement test worker unavailable"),
      stage: "worker-handoff",
    });
    if (kind === "external") {
      error = new RequirementTestExternalBlockedError({
        code: failure.code,
        message: failure.message,
        runId: state.runId,
        stepId,
        attemptId: state.attempt.id,
      });
    }
  }

  const observed = acquireRequirementTestInput({ state, stepId, planRead,
    specRecordPublication: specRecord.descriptor, candidateBundle, structuralFinding, evidence, error });
  const registration = requirementTestWorkerStepRegistration(stepId);
  if (registration === null) throw new Error(`Requirement test Step registration is missing: ${stepId}`);
  const lifecycleResult = kind === "structural"
    ? {
        outcome: "passed",
        summary: `Requirement test structural finding recorded for ${structuralResult.requirementId}`,
        confirmedAt: new Date().toISOString(),
        artifactRefs: [
          { kind: "worker-handoff", id: structuralResult.handoffDigest },
          { kind: "worker-handoff-request", id: structuralResult.requestDigest },
        ],
      }
    : null;
  const prepared = registration.create({ observed, flowManager, specId: state.specId,
    commandResult, result: lifecycleResult });
  if (prepared instanceof Promise) throw new TypeError(`Requirement test failure preparation must be synchronous for ${stepId}`);
  const service = prepared.dependency(RequirementTestService);
  const stepResult = prepared.step.selectResult();
  const settlement = service.selectSettlement(stepResult);
  const publication = requirementTestFailurePublication({ flowManager, state, planRead,
    stepId, kind, stepResult, settlement, structuralResult, inputPublications });
  service.selectSettlementPublication(publication);
  service.persistStepResult(stepResult);
  return Object.freeze({ decision: settlement.requirementTestDecision, completion: service.settlementOutcome });
}

function requirementTestFailurePublication({ flowManager, state, planRead, stepId, kind,
  stepResult, settlement, structuralResult, inputPublications }) {
  const artifactWrites = [...(inputPublications.artifactWrites ?? [])];
  const artifactRemovals = [...(inputPublications.artifactRemovals ?? [])];
  const artifactBaselines = [...(inputPublications.artifactBaselines ?? [])];
  let deferredReceipt = null;
  let findingsPublication = null;
  const workItem = planRead.artifact.plan.activeWorkItem();
  const candidate = stepResult.candidateBundle ?? (workItem.bundleRevision === null
    ? null
    : new RequirementTestArtifactStore({ flowManager, state })
      .readCandidate({ bundle: workItem.bundleRevision, consumerNodeId: stepId }).candidate);
  let sourceArtifact = null;
  let sourcePayload = null;

  if (kind === "structural") {
    const finding = structuralResult.connectorInput().finding;
    const failureArtifact = new RequirementTestFailureArtifact({
      requirementId: finding.requirementId,
      bundleRevision: finding.bundleRevision,
      fingerprint: finding.fingerprint,
    });
    sourceArtifact = failureArtifact.relativePath;
    sourcePayload = { sourceStepId: stepId, blockingFindings: [finding] };
    artifactWrites.push(failureArtifact.artifactWrite(sourcePayload));
  }

  if ((kind === "tooling" || kind === "structural") && stepId === "test-repair") {
    const parameters = { requirementId: workItem.requirementId };
    const progress = flowManager.readArtifact({ specId: state.specId,
      logicalKey: "test.requirement.repair.progress", parameters, consumerNodeId: stepId, optional: true });
    if (progress !== null) {
      artifactRemovals.push({ logicalKey: "test.requirement.repair.progress", parameters });
      artifactBaselines.push(new CanonicalFlowArtifactBaseline({ logicalKey: "test.requirement.repair.progress",
        parameters, digest: progress.descriptor.hash, byteLength: progress.descriptor.size }));
    }
  }

  if (settlement.requirementTestDecision?.disposition === "defer") {
    if (kind !== "structural") {
      const reason = stepResult.evidence.reason;
      const finding = requirementTestToolingFailureFinding({
        nodeId: stepId, workItem, candidate, attempt: state.attempt, reason,
      });
      const failureArtifact = new RequirementTestFailureArtifact({
        requirementId: workItem.requirementId,
        bundleRevision: candidate?.bundle.revision ?? 1,
        fingerprint: finding.fingerprint,
      });
      sourceArtifact = failureArtifact.relativePath;
      sourcePayload = { sourceStepId: stepId, blockingFindings: [finding] };
      artifactWrites.push(failureArtifact.artifactWrite(sourcePayload));
    }
    findingsPublication = buildDeferredSemanticFindingsPublication({
      flowManager,
      flowState: flowManager.loadReadOnly(state.specId),
      nodeId: stepId,
      sourceStep: stepId,
      sourceArtifact,
      sourcePayload,
      sourceRelativePath: sourceArtifact,
      attempts: workItem.budget.autoSemantic + workItem.budget.manualSemantic + workItem.budget.tooling + 1,
    });
    deferredReceipt = new RequirementTestDeferredReceipt({
      requirementId: workItem.requirementId,
      specRevision: workItem.specRevision,
      bundleRevision: candidate?.bundle.revision ?? null,
      candidateDigest: candidate?.digest ?? null,
      expectation: workItem.expectation,
      budget: workItem.budget,
      sourceAttempt: { id: state.attempt.id, sequence: state.attempt.sequence },
      sourceArtifact,
      sourceFindingFingerprints: findingsPublication.deferred.map((finding) => finding.fingerprint),
    });
  }
  return new RequirementTestSettlementPublication({
    artifactWrites, artifactRemovals, artifactBaselines, deferredReceipt, findingsPublication,
  });
}
