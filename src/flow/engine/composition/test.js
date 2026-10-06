import { StepRegistration } from "./step-registration.js";
import { StepExecutionContract } from "./step-execution-contract.js";
import { workerStepExecutionContract } from "../../lib/worker-execution-admission.js";
import { gateStepExecutionContract, reviewStepExecutionContract } from "../../lib/execution-admission.js";
import { NextActionDirective } from "../../lib/next-action-directive.js";
import { ApprovalInput } from "../../services/approval-input.js";
import { CanonicalSpecApproval } from "../../lib/canonical-spec-approval.js";
import {
  ApprovalResultEvidence, RequirementTestResultBinding, RequirementTestResultFrontier,
  RequirementTestRetryState, RequirementTestReviewExecutionEvidence,
  RequirementTestReviewEvidence, RequirementTestGateEvidence,
  RequirementTestRepairProgressIdentity, RequirementTestResultPublication,
  RequirementTestToolingEvidence,
} from "../step-result.js";
import {
  RequirementTestPlanPublication, RequirementTestSemanticFinding,
  RequirementTestSourceAttempt,
} from "../../lib/requirement-test-lifecycle.js";
import { RequirementTestCandidateBundle, RequirementTestCandidateSource } from "../../lib/requirement-test-artifacts.js";
import { SpecRevisionIdentity } from "../../lib/spec-revision-identity.js";
import { initializeRequirementTestLifecycle } from "../../definition.js";
import { ApprovalService } from "../../services/approval-service.js";
import { ApprovalSettlementWriter } from "../../services/approval-settlement-writer.js";
import { RequirementTestInput } from "../../services/requirement-test-input.js";
import { RequirementTestService } from "../../services/requirement-test-service.js";
import { RequirementTestSettlementWriter } from "../../services/requirement-test-settlement-writer.js";
import { validateSpecJsonObject } from "../../../lib/spec-json.js";
import { ApprovalStep } from "../../steps/test/approval.js";
import { TestGenerateStep } from "../../steps/test/test-generate.js";
import { TestReviewStep } from "../../steps/test/test-review.js";
import { TestRepairStep } from "../../steps/test/test-repair.js";
import { TestGateStep } from "../../steps/test/test-gate.js";

/** Inject previously acquired values; preparing a Service never re-reads canonical inputs. */
export function prepareApprovalServiceArguments(input) {
  if (!(input.observed instanceof ApprovalInput)) throw new TypeError("Approval composition requires its acquired typed input");
  return [new ApprovalInput(input.observed), new ApprovalSettlementWriter({
    flowManager: input.flowManager ?? input.ctx?.flowManager,
    specId: input.observed.evidence.specId,
    approval: input.observed.approval,
    plan: input.observed.plan,
    specRecordPublication: input.observed.specRecordPublication,
    expectedSpecDigest: input.expectedSpecDigest ?? null,
  })];
}

export function prepareRequirementTestServiceArguments(input, _ConnectorClass, stepId) {
  if (!(input.observed instanceof RequirementTestInput) || input.observed.stepId !== stepId) throw new TypeError("Requirement test composition requires its acquired typed leaf input");
  return [new RequirementTestInput(input.observed), new RequirementTestSettlementWriter({
    flowManager: input.flowManager ?? input.ctx?.flowManager,
    specId: input.observed.binding.specId,
    binding: input.observed.binding,
    commandResult: input.commandResult ?? null,
    artifactWrites: input.artifactWrites,
    artifactRemovals: input.artifactRemovals,
    artifactBaselines: input.artifactBaselines,
    deferredReceipt: input.deferredReceipt,
    findingsPublication: input.findingsPublication,
    activityId: input.activityId,
    result: input.result,
    references: input.references,
  })];
}

export function selectApprovalExecution(input) {
  if (input.stepId !== "approval" || !(input.registration instanceof StepRegistration)
    || input.registration.stepId !== input.stepId) throw new TypeError("Approval selection requires its registered leaf");
  if (input.observed instanceof ApprovalInput) {
    return new ApprovalExecutionSelection({ observed: input.observed, registration: input.registration, stepId: input.stepId });
  }
  if (input.action === undefined || input.action === null) {
    throw new TypeError("Approval display selection requires its Definition action");
  }
  return new ApprovalExecutionSelection({ registration: input.registration, stepId: input.stepId, action: input.action });
}

export class ApprovalExecutionSelection {
  constructor({ observed = null, registration, stepId, action = null } = {}) {
    if (stepId !== "approval" || !(registration instanceof StepRegistration) || registration.stepId !== stepId
      || observed !== null && !(observed instanceof ApprovalInput)
      || observed === null && action === null) {
      throw new TypeError("Approval selection requires its registered action or acquired canonical input");
    }
    this.registration = registration;
    this.stepId = stepId;
    this.observed = observed;
    this.action = action;
    Object.freeze(this);
  }
}

/** Build approval evidence from the caller's already acquired canonical values. */
export function acquireApprovalInput({ state, specDescriptor, spec, review, approval = null, approved = true } = {}) {
  if (state?.current?.at(-1) !== "approval" || state.attempt === null
    || !(review?.identity instanceof SpecRevisionIdentity)
    || typeof approved !== "boolean"
    || approved && !(approval instanceof CanonicalSpecApproval)
    || !approved && approval !== null) {
    throw new TypeError("Approval acquisition requires its active Attempt, Spec Review, and explicit approval");
  }
  if (!approved) {
    return new ApprovalInput({
      evidence: new ApprovalResultEvidence({
        runId: state.runId,
        specId: state.specId,
        attempt: new RequirementTestSourceAttempt(state.attempt),
        specRevision: review.identity,
        approved: false,
        testsRequired: false,
      }),
      specRecordPublication: RequirementTestResultPublication.fromDescriptor(specDescriptor),
    });
  }
  const approvedSpec = spec.user_approval?.approved === true ? spec : approval.apply(spec);
  validateSpecJsonObject(approvedSpec);
  const initialization = initializeRequirementTestLifecycle({ spec: approvedSpec, specRevision: review.identity });
  return new ApprovalInput({
    evidence: new ApprovalResultEvidence({
      runId: state.runId,
      specId: state.specId,
      attempt: new RequirementTestSourceAttempt(state.attempt),
      specRevision: review.identity,
      approved: true,
      testsRequired: initialization.plan.workItems.length > 0,
    }),
    approval,
    plan: initialization.plan,
    specRecordPublication: RequirementTestResultPublication.fromDescriptor(specDescriptor),
  });
}

/** Bind one registered Requirement Step to the exact canonical inputs already read by its caller. */
export function acquireRequirementTestInput({ state, stepId, planRead, specRecordPublication,
  candidateBundle = null,
  structuralFinding = null, evidence = null, progressIdentity = null, error = null } = {}) {
  const activeWorkItem = planRead?.artifact?.plan?.activeWorkItem() ?? null;
  if (state?.attempt === null || state?.current?.at(-1) !== stepId || activeWorkItem === null) {
    const currentStep = state?.current?.at(-1) ?? "none";
    const attemptState = state?.attempt === null ? "missing" : "present";
    const workItemState = activeWorkItem?.requirementId ?? "missing";
    throw new TypeError(`Requirement test acquisition requires the active Attempt and plan (step=${currentStep}, attempt=${attemptState}, workItem=${workItemState})`);
  }
  if (specRecordPublication?.logicalKey !== "spec.record") {
    throw new TypeError("Requirement test acquisition requires its exact spec.record publication");
  }
  const workItem = activeWorkItem;
  const binding = new RequirementTestResultBinding({
    runId: state.runId,
    specId: state.specId,
    leaf: stepId,
    attempt: new RequirementTestSourceAttempt(state.attempt),
    specRecordPublication: RequirementTestResultPublication.fromDescriptor(specRecordPublication),
    planPublication: RequirementTestPlanPublication.fromDescriptor(planRead.descriptor),
    requirementId: workItem.requirementId,
    specRevision: workItem.specRevision,
    status: workItem.status,
    candidate: workItem.bundleRevision?.lineage ?? null,
  });
  const frontier = RequirementTestResultFrontier.fromPlan(planRead.artifact.plan, workItem.requirementId);
  const retryState = new RequirementTestRetryState({
    budget: workItem.budget,
    autoApprove: state.policy.autoApprove,
    findings: workItem.semanticFindings.map((finding) => finding instanceof RequirementTestSemanticFinding
      ? finding : RequirementTestSemanticFinding.fromJSON(finding)),
  });
  if (candidateBundle !== null && !(candidateBundle instanceof RequirementTestCandidateBundle)) {
    throw new TypeError("Requirement test candidate input must be canonical");
  }
  if (evidence !== null && !(evidence instanceof RequirementTestReviewExecutionEvidence
    || evidence instanceof RequirementTestReviewEvidence || evidence instanceof RequirementTestGateEvidence
    || evidence instanceof RequirementTestToolingEvidence)) {
    throw new TypeError("Requirement test evidence must be a typed Review or Gate publication");
  }
  if (progressIdentity !== null && !(progressIdentity instanceof RequirementTestRepairProgressIdentity)) {
    throw new TypeError("Requirement test repair progress must be typed");
  }
  return new RequirementTestInput({ binding, frontier, retryState, workItem,
    candidateBundle, structuralFinding, evidence, progressIdentity, error });
}

/** Project persisted test-review repair progress into the Step Result value type. */
export function requirementTestRepairProgressIdentity(progress) {
  if (progress === null || progress === undefined || typeof progress.toJSON !== "function") {
    throw new TypeError("Requirement test repair progress requires its canonical checkpoint");
  }
  const document = progress.toJSON();
  return new RequirementTestRepairProgressIdentity({
    sourceArtifactDigest: document.sourceArtifactDigest,
    sourceEvidenceId: document.sourceEvidenceId,
    sourceCandidate: RequirementTestCandidateBundle.fromJSON(document.sourceCandidate),
    coordinatorAttempt: RequirementTestSourceAttempt.fromJSON(document.coordinatorAttempt),
    entries: progress.entries,
    stagedSources: progress.stagedSources.map((source) => new RequirementTestCandidateSource({
      testPath: source.testPath.startsWith("tests/") ? source.testPath : `tests/${source.testPath}`,
      digest: source.digest,
      byteLength: source.bytes.length,
    })),
  });
}

/** Consume the production Approval registration from its acquired typed input. */
export function executeApprovalInput(input) {
  const registration = requirementTestStepRegistration(input.stepId);
  if (registration === null) throw new TypeError("Approval execution requires its production registration");
  const selection = registration.executionContract.select({ ...input, registration });
  return registration.executionContract.execute(selection, { ...input, registration });
}

export function projectApprovalExecution(selection, input) {
  if (!(selection instanceof ApprovalExecutionSelection) || selection.stepId !== input.stepId
    || selection.registration !== input.registration
    || !(input.directive instanceof NextActionDirective)) throw new TypeError("Approval projection requires its registered selection and directive");
  return input.directive;
}

export function executeApprovalSelection(selection, input) {
  if (!(selection instanceof ApprovalExecutionSelection) || !(selection.observed instanceof ApprovalInput)
    || selection.stepId !== input.stepId || selection.registration !== input.registration
    || input.registration?.stepId !== selection.stepId) {
    throw new TypeError("Approval execution requires its registered selection");
  }
  const execute = (prepared) => {
    const execution = prepared.step.execute();
    const service = prepared.dependency(ApprovalService);
    return service.settlementOutcome ?? execution.then(() => service.settlementOutcome);
  };
  const prepared = input.registration.create({ ...input, observed: selection.observed });
  return prepared instanceof Promise ? prepared.then(execute) : execute(prepared);
}

export const approvalStepExecutionContract = new StepExecutionContract({
  select: selectApprovalExecution, project: projectApprovalExecution, execute: executeApprovalSelection,
});

export const requirementTestStepRegistrations = Object.freeze([
  new StepRegistration({ stepId: "approval", StepClass: ApprovalStep, ServiceClass: ApprovalService,
    prepareServiceArguments: prepareApprovalServiceArguments, executionContract: approvalStepExecutionContract }),
  new StepRegistration({ stepId: "test-generate", StepClass: TestGenerateStep, ServiceClass: RequirementTestService,
    prepareServiceArguments: prepareRequirementTestServiceArguments, executionContract: workerStepExecutionContract }),
  new StepRegistration({ stepId: "test-review", StepClass: TestReviewStep, ServiceClass: RequirementTestService,
    prepareServiceArguments: prepareRequirementTestServiceArguments, executionContract: reviewStepExecutionContract }),
  new StepRegistration({ stepId: "test-repair", StepClass: TestRepairStep, ServiceClass: RequirementTestService,
    prepareServiceArguments: prepareRequirementTestServiceArguments, executionContract: workerStepExecutionContract }),
  new StepRegistration({ stepId: "test-gate", StepClass: TestGateStep, ServiceClass: RequirementTestService,
    prepareServiceArguments: prepareRequirementTestServiceArguments, executionContract: gateStepExecutionContract }),
]);

const byId = new Map(requirementTestStepRegistrations.map((registration) => [registration.stepId, registration]));
export function requirementTestStepRegistration(stepId) { return byId.get(stepId) ?? null; }
export function requirementTestWorkerStepRegistration(stepId) {
  return ["test-generate", "test-repair"].includes(stepId) ? requirementTestStepRegistration(stepId) : null;
}
