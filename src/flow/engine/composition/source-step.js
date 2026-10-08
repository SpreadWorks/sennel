import { SourceEntryConnector } from "../connectors/impl/source-entry-connector.js";
import { ImplementStep } from "../../steps/impl/implement.js";
import { ImplTriageStep } from "../../steps/impl/impl-triage.js";
import { ImplRepairStep } from "../../steps/impl/impl-repair.js";
import { TaskImplementationStep } from "../../steps/task/task-impl.js";
import { TaskRepairStep } from "../../steps/task/task-repair.js";
import { SourceStepService } from "../../services/source-step-service.js";
import { workerStepExecutionContract } from "../../lib/worker-execution-admission.js";
import { StepRegistration, PreparedStepReplay } from "./step-registration.js";
import { SourceStepFacts } from "../../lib/source-effect-values.js";
import { SourceStepInput } from "../../services/source-step-input.js";
import { SourceStepSettlementWriter } from "../../services/source-step-settlement-writer.js";

/** Reads and validation happen before the Source Service is constructed. */
export function prepareSourceWorkerServiceArguments(input, ConnectorClass, stepId) {
  const { ctx, request = null, handoffCoordinator = null } = input;
  const flowManager = input.flowManager ?? ctx?.flowManager;
  const preparation = request === null ? null : input.preparation
    ?? handoffCoordinator.prepareSourceStepHandoff({ ctx, request, mutationAuthority: input.mutationAuthority });
  if (preparation?.completed) return new PreparedStepReplay(preparation);
  const binding = input.binding ?? new ConnectorClass({ flowManager,
    specId: request?.specId ?? ctx?.specId ?? ctx?.flowState?.specId, stepId }).connect();
  binding.assertCurrent();
  const facts = preparation?.facts ?? new SourceStepFacts({ stepId });
  return [new SourceStepInput(facts), new SourceStepSettlementWriter({ flowManager, binding,
    request, preparation, handoffCoordinator })];
}

/** Shared source subset; primary phase registries publish these exact registrations. */
export const sourceStepRegistrations = Object.freeze([
  new StepRegistration({ stepId: "implement", StepClass: ImplementStep, ServiceClass: SourceStepService,
    prepareServiceArguments: prepareSourceWorkerServiceArguments, ConnectorClass: SourceEntryConnector,
    executionContract: workerStepExecutionContract }),
  new StepRegistration({ stepId: "impl-triage", StepClass: ImplTriageStep, ServiceClass: SourceStepService,
    prepareServiceArguments: prepareSourceWorkerServiceArguments, ConnectorClass: SourceEntryConnector,
    executionContract: workerStepExecutionContract }),
  new StepRegistration({ stepId: "impl-repair", StepClass: ImplRepairStep, ServiceClass: SourceStepService,
    prepareServiceArguments: prepareSourceWorkerServiceArguments, ConnectorClass: SourceEntryConnector,
    executionContract: workerStepExecutionContract }),
  new StepRegistration({ stepId: "task-impl", StepClass: TaskImplementationStep, ServiceClass: SourceStepService,
    prepareServiceArguments: prepareSourceWorkerServiceArguments, ConnectorClass: SourceEntryConnector,
    executionContract: workerStepExecutionContract }),
  new StepRegistration({ stepId: "task-repair", StepClass: TaskRepairStep, ServiceClass: SourceStepService,
    prepareServiceArguments: prepareSourceWorkerServiceArguments, ConnectorClass: SourceEntryConnector,
    executionContract: workerStepExecutionContract }),
]);
const sourceById = new Map(sourceStepRegistrations.map((registration) => [registration.stepId, registration]));
export function sourceStepRegistration(stepId) { return sourceById.get(stepId) ?? null; }
