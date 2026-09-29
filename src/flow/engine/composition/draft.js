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

function workerRegistration(stepId, StepClass, Connector) {
  return new StepRegistration({
    stepId, StepClass,
    async prepareDependencies(input) {
      const service = input.executionBinding === undefined
        ? await DraftService.prepare({ ...input, Connector })
        : new DraftService({
          flowManager: input.flowManager, binding: input.binding,
          executionBinding: input.executionBinding,
        });
      return new Map([[DraftService, service]]);
    },
  });
}

export async function prepareDraftReviewBinding({ flowManager, state, phase }) {
  const source = new CanonicalDraftReviewSource({ flowManager, state, phase });
  return new DraftReviewConnector(source).connect();
}

function reviewRegistration(stepId, StepClass, phase) {
  return new StepRegistration({
    stepId, StepClass,
    async prepareDependencies(input) {
      const flowManager = input.flowManager ?? input.ctx.flowManager;
      const binding = input.binding === undefined
        ? await prepareDraftReviewBinding({
          flowManager,
          state: input.state ?? flowManager.canonicalState(input.ctx.specId ?? input.ctx.flowState.specId),
          phase,
        })
        : input.binding;
      return new Map([[ReviewService, new ReviewService({
        flowManager, binding,
        ...(input.executionBinding === undefined ? {} : { executionBinding: input.executionBinding }),
        ...(input.commandResult === undefined ? {} : { commandResult: input.commandResult }),
        ...(input.publicationResult === undefined ? {} : { publicationResult: input.publicationResult }),
      })]]);
    },
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
  reviewRegistration("draft-questions-review", DraftQuestionsReviewStep, "draft-questions"),
  reviewRegistration("draft-coverage-review", DraftCoverageReviewStep, "draft-coverage"),
  new StepRegistration({
    stepId: "draft-gate", StepClass: DraftGateStep,
    async prepareDependencies({ ctx, result }) {
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
      return new Map([[GateService, new GateService({
        flowManager: ctx.flowManager, binding, commandResult: result, issuePublication,
      })]]);
    },
  }),
];

export const draftStepRegistrations = Object.freeze(registrations);
const draftById = new Map(registrations.map((registration) => [registration.stepId, registration]));
const draftWorkerById = new Map(workerRegistrations.map((registration) => [registration.stepId, registration]));

export function draftStepRegistration(stepId) {
  return draftById.get(stepId) ?? null;
}

export function draftWorkerStepRegistration(stepId) {
  return draftWorkerById.get(stepId) ?? null;
}
