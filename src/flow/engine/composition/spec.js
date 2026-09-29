import { StepRegistration } from "./step-registration.js";
import { SpecEntryConnector } from "../connectors/spec/spec-entry-connector.js";
import { SpecGateEvaluationBinding } from "../connectors/spec/spec-step-binding.js";
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
import { SpecGateAdmissionRefusal } from "../../lib/gate-transition-facts.js";
import { SpecReviewExecutionRequiredResult } from "../step-result.js";

function workerRegistration(stepId, StepClass, Service) {
  return new StepRegistration({
    stepId, StepClass,
    async prepareDependencies(input) {
      const service = input.service ?? await Service.prepare({ ...input, Connector: SpecEntryConnector });
      if (!(service instanceof Service)) {
        throw new TypeError(`Spec Step ${stepId} requires its prepared Service`);
      }
      return new Map([[Service, service]]);
    },
  });
}

const workerRegistrations = [
  workerRegistration("spec", SpecStep, SpecService),
  workerRegistration("spec-triage", SpecTriageStep, SpecReviewWorkerService),
  workerRegistration("spec-repair", SpecRepairStep, SpecReviewWorkerService),
  workerRegistration("spec-gate-repair", SpecGateRepairStep, SpecGateRepairService),
];

export const specStepRegistrations = Object.freeze([
  workerRegistrations[0],
  new StepRegistration({
    stepId: "spec-review", StepClass: SpecReviewStep,
    prepareDependencies(input) {
      const service = input.service ?? new SpecReviewService(input);
      return new Map([[SpecReviewService, service]]);
    },
  }),
  workerRegistrations[1],
  workerRegistrations[2],
  new StepRegistration({
    stepId: "spec-gate", StepClass: SpecGateStep,
    async prepareDependencies(input) {
      if (input.service !== undefined) return new Map([[SpecGateService, input.service]]);
      if (input.ctx === undefined) return new Map([[SpecGateService, new SpecGateService(input)]]);
      const { ctx, result } = input;
      const binding = new SpecGateEvaluationBinding({
        flowManager: ctx.flowManager, specId: ctx.specId ?? ctx.flowState.specId,
      });
      let state;
      try { state = binding.assertCurrent(); }
      catch (cause) { throw new SpecGateAdmissionRefusal("Spec Gate binding is stale", cause); }
      const attached = attachedCanonicalCommandResultArtifact(result);
      let issuePublication = null;
      if (attached?.payload?.result === "fail") {
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
      return new Map([[SpecGateService, new SpecGateService({
        flowManager: ctx.flowManager, binding, commandResult: result, issuePublication,
      })]]);
    },
  }),
  workerRegistrations[3],
]);

const byId = new Map(specStepRegistrations.map((registration) => [registration.stepId, registration]));
const workerById = new Map(workerRegistrations.map((registration) => [registration.stepId, registration]));

export function specStepRegistration(stepId) { return byId.get(stepId) ?? null; }
export function specWorkerStepRegistration(stepId) { return workerById.get(stepId) ?? null; }

/** A completed handoff is already settled and must pass through unchanged. */
export async function prepareSpecWorkerStep(registration, input) {
  const Service = registration.StepClass.dependencies[0];
  const service = await Service.prepare({ ...input, Connector: SpecEntryConnector });
  return service instanceof Service ? registration.create({ service }) : service;
}

/** Resume an exact published repair with its existing service and binding. */
export function resumeSpecWorkerStep(registration, service) {
  return registration.create({ service });
}

export async function claimSpecReviewExecution(input) {
  const claim = SpecReviewService.prepareExecutionClaim(input);
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
  return SpecReviewService.commitExecutionClaim(claim);
}

export async function completeSpecReviewPublication(input) {
  const publication = await SpecReviewService.preparePublication(input);
  if (publication === null || publication.completed) return publication?.result ?? null;
  const prepared = await specStepRegistration("spec-review").create({
    flowManager: input.flowManager, binding: publication.binding,
  });
  let result;
  try { result = await prepared.step.execute(); }
  catch (error) {
    const replay = await SpecReviewService.terminalReplay({
      flowManager: input.flowManager,
      state: input.flowManager.canonicalState(input.state.specId),
    });
    if (replay !== null) return replay;
    throw error;
  }
  return SpecReviewService.resultFromStepResult(result, publication.reviewDigest);
}
