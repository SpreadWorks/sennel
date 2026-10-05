import { StepRegistration, PreparedStepReplay } from "./step-registration.js";
import { SpecEntryConnector } from "../connectors/spec/spec-entry-connector.js";
import { SpecGateEvaluationBinding, SpecReviewStepBinding } from "../connectors/spec/spec-step-binding.js";
import { SpecService } from "../../services/spec-service.js";
import { SpecReviewService } from "../../services/spec-review-service.js";
import { SpecReviewWorkerService } from "../../services/spec-worker-review-service.js";
import { SpecGateService } from "../../services/spec-gate-service.js";
import { SpecGateRepairService } from "../../services/spec-gate-repair-service.js";
import { SpecStep } from "../../steps/spec/spec.js";
import { SpecReviewStep } from "../../steps/spec/spec-review.js";
import { SpecTriageStep } from "../../steps/spec/spec-triage.js";
import { SpecRepairStep } from "../../steps/spec/spec-repair.js";
import { SpecGateStep } from "../../steps/spec/spec-gate.js";
import { SpecGateRepairStep } from "../../steps/spec/spec-gate-repair.js";
import { attachedCanonicalCommandResultArtifact } from "../../lib/canonical-command-result.js";
import { SpecGateIssuePublication } from "../../lib/gate-issue-publication.js";
import { SpecGateAdmissionRefusal, readProspectiveSpecGateFacts } from "../../lib/gate-transition-facts.js";
import { SpecReviewExecutionRequiredResult } from "../step-result.js";
import { SpecReviewOperations } from "../../lib/spec-review-operations.js";
import { SpecWorkerInput } from "../../services/spec-worker-input.js";
import { SpecSettlementWriter } from "../../services/spec-settlement-writer.js";
import { SpecReviewInput } from "../../services/spec-review-input.js";
import { SpecReviewSettlementWriter } from "../../services/spec-review-settlement-writer.js";
import { SpecGateInput } from "../../services/spec-gate-input.js";
import { SpecGateSettlementWriter } from "../../services/spec-gate-settlement-writer.js";
import { SpecGatePublicationIntent, SpecGatePublicationVersion } from "../../lib/spec-gate-prospective.js";
import { SpecReviewConnector } from "../connectors/spec/spec-review-connector.js";
import { CurrentFlowStateConflictError } from "../../lib/current-flow-state-conflict-error.js";
import { prepareSpecGateRepairServiceArguments } from "./spec-gate-repair.js";
import { workerStepExecutionContract } from "../../lib/worker-execution-admission.js";
import { gateStepExecutionContract, reviewStepExecutionContract } from "../../lib/execution-admission.js";

export async function prepareSpecWorkerServiceArguments(input, ConnectorClass, stepId) {
  const { ctx, request, handoffCoordinator } = input;
  const preparation = input.preparation ?? handoffCoordinator.prepareSpecWorker({ ctx, request });
  if (preparation.completed) return new PreparedStepReplay(preparation);
  const binding = await new ConnectorClass(request).connect();
  const publication = preparation.settlementPublication(handoffCoordinator.now);
  const application = stepId === "spec"
    ? await new SpecReviewConnector({ binding, facts: preparation.facts }).connect()
    : null;
  return [new SpecWorkerInput({ stepId, facts: preparation.facts }),
    new SpecSettlementWriter({ flowManager: ctx.flowManager, request, binding, preparation,
      handoffCoordinator, publication, application })];
}

function workerRegistration(stepId, StepClass, ServiceClass, prepareServiceArguments) {
  return new StepRegistration({
    stepId, StepClass, ServiceClass, prepareServiceArguments,
    ConnectorClass: SpecEntryConnector,
    executionContract: workerStepExecutionContract,
  });
}

const workerRegistrations = [
  workerRegistration("spec", SpecStep, SpecService, prepareSpecWorkerServiceArguments),
  workerRegistration("spec-triage", SpecTriageStep, SpecReviewWorkerService, prepareSpecWorkerServiceArguments),
  workerRegistration("spec-repair", SpecRepairStep, SpecReviewWorkerService, prepareSpecWorkerServiceArguments),
  workerRegistration("spec-gate-repair", SpecGateRepairStep, SpecGateRepairService,
    prepareSpecGateRepairServiceArguments),
];

export const specStepRegistrations = Object.freeze([
  workerRegistrations[0],
  new StepRegistration({
    stepId: "spec-review", StepClass: SpecReviewStep, ServiceClass: SpecReviewService,
    prepareServiceArguments: prepareSpecReviewServiceArguments,
    executionContract: reviewStepExecutionContract,
  }),
  workerRegistrations[1],
  workerRegistrations[2],
  new StepRegistration({
    stepId: "spec-gate", StepClass: SpecGateStep, ServiceClass: SpecGateService,
    prepareServiceArguments: prepareSpecGateServiceArguments,
    executionContract: gateStepExecutionContract,
  }),
  workerRegistrations[3],
]);

export function prepareSpecReviewServiceArguments(input) {
  const flowManager = input.flowManager ?? input.ctx.flowManager;
  const binding = input.binding ?? new SpecReviewStepBinding({ flowManager,
    specId: input.ctx.specId ?? input.ctx.flowState.specId });
  binding.assertCurrent();
  let review = null;
  if (input.executionBinding === undefined || input.executionBinding === null) {
    const read = flowManager.readCurrentSpecReviewInput({ specId: binding.specId,
      consumerNodeId: binding.stepId });
    if (!read.persisted || read.review.audit.at(-1)?.stage !== "spec-review") {
      throw new Error("Spec Review settlement requires its durable accepted publication");
    }
    review = read.review;
  }
  return [new SpecReviewInput({ review,
    executionBinding: input.executionBinding ?? null, manifest: input.manifest ?? null }),
    new SpecReviewSettlementWriter({ flowManager, binding,
      executionBinding: input.executionBinding ?? null })];
}

export async function prepareSpecGateServiceArguments(input) {
  const ctx = input.ctx;
  const flowManager = input.flowManager ?? ctx.flowManager;
  const result = input.result ?? input.commandResult;
  const binding = input.binding ?? new SpecGateEvaluationBinding({
    flowManager, specId: ctx.specId ?? ctx.flowState.specId,
  });
  let state;
  try { state = binding.assertCurrent(); }
  catch (cause) { throw new SpecGateAdmissionRefusal("Spec Gate binding is stale", cause); }
  const attached = attachedCanonicalCommandResultArtifact(result);
  let issuePublication = null;
  if (input.issuePublication === undefined && attached?.payload?.result === "fail") {
    const { GateIssueLogEntry } = await import("../../lib/run-gate.js");
    try {
      issuePublication = new SpecGateIssuePublication({
        binding,
        entry: new GateIssueLogEntry({ ctx, result, timestamp: state.attempt.startedAt }).toJSON(),
      });
    } catch (cause) {
      throw new SpecGateAdmissionRefusal("Spec Gate issue evidence is invalid", cause);
    }
  }
  const selectedIssue = input.issuePublication ?? issuePublication;
  let publication;
  try {
    const version = flowManager.readCanonicalTransitionView({
      specId: binding.specId, read: (view) => new SpecGatePublicationVersion({ binding, view }),
    });
    const facts = readProspectiveSpecGateFacts({ flowManager, binding,
      commandResult: result, issuePublication: selectedIssue });
    flowManager.readCanonicalTransitionView({ specId: binding.specId,
      read: (view) => version.assert(view) });
    publication = new SpecGatePublicationIntent({ facts, issue: selectedIssue,
      version, binding, commandResult: result });
  } catch (cause) {
    if (!(cause instanceof CurrentFlowStateConflictError)) throw cause;
    throw new SpecGateAdmissionRefusal("Spec Gate inputs changed while reading prospective facts", cause);
  }
  return [new SpecGateInput(publication.facts),
    new SpecGateSettlementWriter({ flowManager, binding,
      commandResult: result, publication })];
}

const byId = new Map(specStepRegistrations.map((registration) => [registration.stepId, registration]));
const workerById = new Map(workerRegistrations.map((registration) => [registration.stepId, registration]));

export function specStepRegistration(stepId) { return byId.get(stepId) ?? null; }
export function specWorkerStepRegistration(stepId) { return workerById.get(stepId) ?? null; }

export async function claimSpecReviewExecution(input) {
  const claim = SpecReviewOperations.prepareExecutionClaim(input);
  if (claim.needsCheckpoint) {
    const prepared = await specStepRegistration("spec-review").create({
      flowManager: input.flowManager, binding: claim.binding,
      executionBinding: claim.executionBinding, manifest: input.manifest,
    });
    const selected = await prepared.step.execute();
    if (!(selected instanceof SpecReviewExecutionRequiredResult)) {
      throw new Error("Spec Review Step did not select execution");
    }
  }
  return SpecReviewOperations.commitExecutionClaim(claim);
}

export async function completeSpecReviewPublication(input) {
  const publication = await SpecReviewOperations.preparePublication(input);
  if (publication === null || publication.completed) return publication?.result ?? null;
  const prepared = await specStepRegistration("spec-review").create({
    flowManager: input.flowManager, binding: publication.binding,
  });
  let result;
  try { result = await prepared.step.execute(); }
  catch (error) {
    const replay = await SpecReviewOperations.terminalReplay({
      flowManager: input.flowManager,
      state: input.flowManager.canonicalState(input.state.specId),
    });
    if (replay !== null) return replay;
    throw error;
  }
  return SpecReviewOperations.resultFromStepResult(result, publication.reviewDigest);
}
