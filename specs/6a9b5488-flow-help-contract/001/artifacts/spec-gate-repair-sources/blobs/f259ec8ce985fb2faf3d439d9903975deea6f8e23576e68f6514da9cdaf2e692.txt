import { StepRegistration } from "./step-registration.js";
import { DraftService } from "../../services/draft-service.js";
import { ReviewService, GateService } from "../../services/review-service.js";
import { DraftStep } from "../../steps/draft/draft.js";
import { DraftRefineStep } from "../../steps/draft/draft-refine.js";
import { DraftQuestionsTriageStep } from "../../steps/draft/draft-questions-triage.js";
import { DraftCoverageTriageStep } from "../../steps/draft/draft-coverage-triage.js";
import { DraftQuestionsRepairStep } from "../../steps/draft/draft-questions-repair.js";
import { DraftCoverageRepairStep } from "../../steps/draft/draft-coverage-repair.js";
import { DraftGateRepairStep } from "../../steps/draft/draft-gate-repair.js";
import { DraftQuestionsReviewStep } from "../../steps/draft/draft-questions-review.js";
import { DraftCoverageReviewStep } from "../../steps/draft/draft-coverage-review.js";
import { DraftGateStep } from "../../steps/draft/draft-gate.js";
import { DraftEntryConnector } from "../connectors/draft/draft-entry-connector.js";
import { DraftRefineConnector } from "../connectors/draft/draft-refine-connector.js";
import { DraftTriageConnector } from "../connectors/draft/draft-triage-connector.js";
import { DraftRepairConnector } from "../connectors/draft/draft-repair-connector.js";
import { DraftReviewConnector } from "../connectors/draft/draft-review-connector.js";
import { DraftGateEvaluationBinding } from "../connectors/draft/draft-step-binding.js";
import { CanonicalDraftReviewSource } from "../../lib/canonical-review-artifacts.js";
import { DraftGateIssuePublication } from "../../lib/draft-gate-prospective.js";
import { attachedCanonicalCommandResultArtifact } from "../../lib/canonical-command-result.js";
import { DraftWorkerExecutionStepBinding } from "../connectors/draft/draft-step-binding.js";
import { isConditionalDraftWorkerStep } from "../../lib/draft-conditional-worker.js";
import { draftReviewRouteForStepId } from "../../lib/draft-review-routes.js";
import { DraftWorkerInput } from "../../services/draft-worker-input.js";
import { DraftSettlementWriter } from "../../services/draft-settlement-writer.js";
import { readDraftTransitionFacts } from "../../lib/draft-transition-facts-reader.js";
import { canonicalPlanGateRepairForTarget, PlanGateRepairRecord } from "../../lib/plan-gate-repair.js";
import { DraftGateRepairBinding } from "../../lib/draft-gate-repair-binding.js";
import { DraftReviewInput } from "../../services/draft-review-input.js";
import { DraftReviewSettlementWriter } from "../../services/draft-review-settlement-writer.js";
import { DraftGateInput } from "../../services/draft-gate-input.js";
import { DraftGateSettlementWriter } from "../../services/draft-gate-settlement-writer.js";
import { DraftReviewArtifactDocument, DraftReviewEvidenceSet } from "../../lib/draft-review-artifacts.js";
import { readProspectiveDraftGateFacts } from "../../lib/gate-transition-facts.js";
import { StepAdmissionRefusal } from "../../lib/step-admission-refusal.js";
import { CurrentFlowStateConflictError } from "../../lib/current-flow-state-conflict-error.js";
import { workerStepExecutionContract } from "../../lib/worker-execution-admission.js";
import { gateStepExecutionContract, reviewStepExecutionContract } from "../../lib/execution-admission.js";

export async function prepareDraftWorkerServiceArguments(input, ConnectorClass) {
  const { ctx, request, preparation, handoffCoordinator } = input;
  const binding = input.binding ?? (isConditionalDraftWorkerStep(request.stepId)
    ? new DraftWorkerExecutionStepBinding({ flowManager: ctx.flowManager,
      specId: request.specId, stepId: request.stepId })
    : await new ConnectorClass(request).connect());
  const flowManager = input.flowManager ?? ctx.flowManager;
  const state = binding.assertCurrent();
  const workerFacts = preparation?.facts ?? null;
  const draftTransitionFacts = binding.stepId === "draft-refine"
    ? workerFacts?.draftTransitionFacts ?? readDraftTransitionFacts({
      flowManager, flowState: flowManager.loadReadOnly(binding.specId),
    }) : null;
  let planGateRepair = null;
  if (binding.stepId === "draft-gate-repair") {
    const repair = canonicalPlanGateRepairForTarget({ flowManager, state,
      targetStepId: binding.stepId });
    if (!(repair instanceof PlanGateRepairRecord)) {
      throw new Error("draft-gate-repair has no canonical repair binding");
    }
    planGateRepair = new DraftGateRepairBinding(repair);
  }
  const executionBinding = input.executionBinding ?? null;
  const observed = new DraftWorkerInput({ stepId: binding.stepId,
    executionBinding, draftTransitionFacts,
    autoApprove: draftTransitionFacts === null ? null
      : workerFacts?.autoApprove ?? state.policy.autoApprove,
    planGateRepair,
    draftCompletionFacts: preparation?.publications?.draftCoverageRepairFacts
      ?? workerFacts?.draftCompletionFacts ?? null,
    repairSelection: workerFacts?.repairSelection ?? null,
    repairInput: workerFacts?.repairInput ?? null,
    prepared: preparation !== undefined && preparation !== null });
  const publicationRecovery = preparation !== undefined && preparation !== null
    && isConditionalDraftWorkerStep(binding.stepId)
    && flowManager.draftStepExecutionState({ binding }).lifecycle?.phase === "publication";
  const writer = new DraftSettlementWriter({ flowManager, binding, ctx, request,
    preparation, handoffCoordinator, executionBinding, publicationRecovery });
  return [observed, writer];
}

function workerRegistration(stepId, StepClass, ConnectorClass) {
  return new StepRegistration({
    stepId, StepClass, ServiceClass: DraftService, ConnectorClass,
    prepareServiceArguments: prepareDraftWorkerServiceArguments,
    executionContract: workerStepExecutionContract,
  });
}

export async function prepareDraftReviewBinding({ flowManager, state, phase }) {
  const source = new CanonicalDraftReviewSource({ flowManager, state, phase });
  return new DraftReviewConnector(source).connect();
}

export async function prepareDraftReviewServiceArguments(input, _ConnectorClass, stepId) {
  const route = draftReviewRouteForStepId(stepId);
  const phase = route?.retryPhase;
  const flowManager = input.flowManager ?? input.ctx.flowManager;
  const binding = input.binding === undefined
    ? await prepareDraftReviewBinding({ flowManager,
      state: input.state ?? flowManager.canonicalState(input.ctx.specId ?? input.ctx.flowState.specId),
      phase })
    : input.binding;
  let state;
  try { state = binding.assertCurrent(); }
  catch (error) {
    if (error instanceof CurrentFlowStateConflictError) {
      throw new StepAdmissionRefusal(error.message, error);
    }
    throw error;
  }
  const commandResult = input.commandResult ?? null;
  const executionBinding = input.executionBinding ?? null;
  const publicationResult = input.publicationResult ?? null;
  let document = null;
  let completionFacts = null;
  if (commandResult !== null) {
    const artifact = attachedCanonicalCommandResultArtifact(commandResult);
    if (artifact?.logicalKey !== route.reviewLogicalKey) {
      throw new StepAdmissionRefusal("draft review command result does not match the bound review route");
    }
    try { document = DraftReviewArtifactDocument.fromStored(artifact.payload); }
    catch (error) { throw new StepAdmissionRefusal(error.message || String(error), error); }
    if (JSON.stringify(document.sourceDraftRevision) !== JSON.stringify(binding.revision)) {
      throw new StepAdmissionRefusal("draft review command result does not match the bound canonical Draft revision");
    }
    const issues = new DraftReviewEvidenceSet({ route, state,
      reviewFile: { document: document.toJSON() } }).validateReview({ validateBinding: false });
    if (issues.length > 0) throw new StepAdmissionRefusal(issues.join("; "));
    if (stepId === "draft-coverage-review" && document.verdict === "PASS") {
      completionFacts = flowManager.readProspectiveDraftCoveragePassFacts({ binding, commandResult });
    }
  } else if (publicationResult !== null
    && attachedCanonicalCommandResultArtifact(publicationResult)?.logicalKey !== route.reviewLogicalKey) {
    throw new TypeError("ReviewService publication requires its canonical review result");
  }
  return [new DraftReviewInput({ stepId, route, document,
    executionBinding, publicationPending: publicationResult !== null, completionFacts }),
    new DraftReviewSettlementWriter({ flowManager, binding, commandResult,
      executionBinding, publicationResult })];
}

function reviewRegistration(stepId, StepClass) {
  return new StepRegistration({
    stepId, StepClass, ServiceClass: ReviewService,
    prepareServiceArguments: prepareDraftReviewServiceArguments,
    executionContract: reviewStepExecutionContract,
  });
}

const workerRegistrations = [
  workerRegistration("draft", DraftStep, DraftEntryConnector),
  workerRegistration("draft-refine", DraftRefineStep, DraftRefineConnector),
  workerRegistration("draft-questions-triage", DraftQuestionsTriageStep, DraftTriageConnector),
  workerRegistration("draft-coverage-triage", DraftCoverageTriageStep, DraftTriageConnector),
  workerRegistration("draft-questions-repair", DraftQuestionsRepairStep, DraftRepairConnector),
  workerRegistration("draft-coverage-repair", DraftCoverageRepairStep, DraftRepairConnector),
  workerRegistration("draft-gate-repair", DraftGateRepairStep, DraftRepairConnector),
];
const registrations = [
  ...workerRegistrations,
  reviewRegistration("draft-questions-review", DraftQuestionsReviewStep),
  reviewRegistration("draft-coverage-review", DraftCoverageReviewStep),
  new StepRegistration({
    stepId: "draft-gate", StepClass: DraftGateStep, ServiceClass: GateService,
    prepareServiceArguments: prepareDraftGateServiceArguments,
    executionContract: gateStepExecutionContract,
  }),
];

export async function prepareDraftGateServiceArguments({ ctx, result }) {
      const binding = new DraftGateEvaluationBinding({
        flowManager: ctx.flowManager,
        specId: ctx.specId ?? ctx.flowState.specId,
      });
      const state = binding.assertCurrent();
      const attached = attachedCanonicalCommandResultArtifact(result);
      let issuePublication = null;
      if (attached?.payload?.result === "fail") {
        const { GateIssueLogEntry } = await import("../../lib/run-gate.js");
        issuePublication = new DraftGateIssuePublication({
          binding,
          entry: new GateIssueLogEntry({ ctx, result, timestamp: state.attempt.startedAt }).toJSON(),
        });
      }
      const facts = readProspectiveDraftGateFacts({ flowManager: ctx.flowManager,
        binding, commandResult: result });
      return [new DraftGateInput({ facts, issuePublication }),
        new DraftGateSettlementWriter({ flowManager: ctx.flowManager, binding,
          commandResult: result })];
}

export const draftStepRegistrations = Object.freeze(registrations);
const draftById = new Map(registrations.map((registration) => [registration.stepId, registration]));
const draftWorkerById = new Map(workerRegistrations.map((registration) => [registration.stepId, registration]));

export function draftStepRegistration(stepId) {
  return draftById.get(stepId) ?? null;
}

export function draftWorkerStepRegistration(stepId) {
  return draftWorkerById.get(stepId) ?? null;
}
