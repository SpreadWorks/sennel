/** Immutable source seed. Tests copy these files into their own temporary roots. */
export class SyntheticStructureSeed {
  constructor(phase, stepName, helperName = "value", stepId = "entry") {
    this.phase = phase;
    this.stepName = stepName;
    this.helperName = helperName;
    this.stepId = stepId;
  }

  files() {
    const entry = `src/flow/steps/${this.phase}`;
    return new Map([
      ["src/flow/engine/step.js", "export class Step {}\n"],
      ["src/flow/engine/step-result.js", "export class StepResult {}\n"],
      ["src/flow/engine/flow-execution-error.js", "export class FlowExecutionError extends Error {}\n"],
      ["src/flow/definition.js", `const FLOW_DEFINITION = Object.freeze([new FlowNode({ id: '${this.stepId}' })]);\n`],
      ["src/flow/engine/composition/registered-step-execution.js", [
        `const registeredPhaseSteps = new Set(flowLeafIdsBetween('${this.stepId}', '${this.stepId}'));`,
        "export function workerStepExecutionRegistration(stepId) { const registration = draftWorkerStepRegistration(stepId) ?? specWorkerStepRegistration(stepId); if (registration === null && registeredPhaseSteps.has(stepId)) { throw new Error(`Definition leaf ${stepId} has no registered worker execution contract`); } return registration; }",
        "export function flowStepExecutionRegistration(stepId) { const registration = draftStepRegistration(stepId) ?? specStepRegistration(stepId); if (registration === null && registeredPhaseSteps.has(stepId)) throw new Error(); return registration; }",
      ].join("\n") + "\n"],
      ["src/flow/engine/composition/draft.js", "const workerRegistrations = []; const draftWorkerById = new Map(workerRegistrations.map((registration) => [registration.stepId, registration])); export function draftWorkerStepRegistration(stepId) { return draftWorkerById.get(stepId) ?? null; }\n"],
      ["src/flow/engine/composition/spec.js", "const workerRegistrations = []; const workerById = new Map(workerRegistrations.map((registration) => [registration.stepId, registration])); export function specWorkerStepRegistration(stepId) { return workerById.get(stepId) ?? null; }\n"],
      ["src/flow/registry.js", [
        "function loadDispatchCommand() { return import('./lib/run-dispatch.js'); }",
        "function loadGateCommand() { return import('./lib/run-gate.js'); }",
        "function loadReviewCommand() { return import('./lib/run-review.js'); }",
        "function loadGetNextActionCommand() { return import('./lib/get-next-action.js'); }",
        "export const FLOW_COMMANDS = { get: { 'next-action': { command: loadGetNextActionCommand } }, run: { dispatch: { command: loadDispatchCommand }, gate: { command: loadGateCommand }, review: { command: loadReviewCommand } } };",
      ].join("\n") + "\n"],
      ["src/flow/services/input.js", "export class Input {}\n"],
      ["src/flow/lib/worker-execution-admission.js", [
        "export function selectWorkerExecutionAdmission(input) { return input; }",
        "export function projectWorkerExecutionAdmission(selection) { return selection; }",
        "export function executeWorkerExecutionAdmission(selection, input) { return input.command.executeSelectedWorker(selection, input); }",
        "export const workerStepExecutionContract = new StepExecutionContract({ select: selectWorkerExecutionAdmission, project: projectWorkerExecutionAdmission, execute: executeWorkerExecutionAdmission });",
      ].join("\n") + "\n"],
      ["src/flow/services/alpha-settlement-writer.js", "export class Writer { settle(value) { return value; } }\n"],
      ["src/flow/services/service.js", [
        "import { Input } from './input.js';",
        "import { Writer } from './alpha-settlement-writer.js';",
        "export class ServiceClass { static argumentTypes = [Input, Writer]; constructor(input, writer) { if (!(input instanceof Input) || !(writer instanceof Writer)) throw new TypeError(); } }",
      ].join("\n") + "\n"],
      [`${entry}/step.js`, [
        "import { Step } from '../../engine/step.js';",
        "import { ServiceClass } from '../../services/service.js';",
        `import { Value } from './${this.helperName}.js';`,
        `export class ${this.stepName} extends Step { static dependencies = [ServiceClass]; value() { return Value; } }`,
      ].join("\n") + "\n"],
      [`${entry}/${this.helperName}.js`, "export const Value = 1;\n"],
      [`src/flow/engine/composition/${this.phase}.js`, [
        `import { ${this.stepName} } from '../../steps/${this.phase}/step.js';`,
        "import { ServiceClass } from '../../services/service.js';",
        "import { Input } from '../../services/input.js';",
        "import { Writer } from '../../services/alpha-settlement-writer.js';",
        "import { workerStepExecutionContract } from '../../lib/worker-execution-admission.js';",
        "function prepareServiceArguments() { return [new Input(), new Writer()]; }",
        `export const registrations = [new StepRegistration({ stepId: '${this.stepId}', StepClass: ${this.stepName}, ServiceClass, prepareServiceArguments, executionContract: workerStepExecutionContract })];`,
        ...(this.phase === "draft" ? [
          "const workerRegistrations = registrations;",
          "const draftWorkerById = new Map(workerRegistrations.map((registration) => [registration.stepId, registration]));",
          "export function draftWorkerStepRegistration(stepId) { return draftWorkerById.get(stepId) ?? null; }",
        ] : this.phase === "spec" ? [
          "const workerRegistrations = registrations;",
          "const workerById = new Map(workerRegistrations.map((registration) => [registration.stepId, registration]));",
          "export function specWorkerStepRegistration(stepId) { return workerById.get(stepId) ?? null; }",
        ] : []),
      ].join("\n") + "\n"],
      ["src/flow/lib/get-next-action.js", [
        "export function project(input) { const registration = workerStepExecutionRegistration(input); const selection = registration.executionContract.select(input); return registration.executionContract.project(selection); }",
        "function buildCanonicalNextActionResult(ctx, binding, recoveryCommand, recoveryPlan, missingRoute, target) {",
        "const workerRegistration = target.scope === 'flow' ? draftWorkerStepRegistration(target.stepId) ?? specWorkerStepRegistration(target.stepId) : null;",
        "const workerSelection = workerRegistration?.executionContract.select({ ctx, stepId: target.stepId });",
        "const workerDirective = workerSelection === undefined ? null : workerRegistration.executionContract.project(workerSelection, { binding, recoveryCommand, retryRecoveryPlan: recoveryPlan, missingProducerArtifactRoute: missingRoute, });",
        "let selectedDirective = specPostFailure === null ? null : new BlockedDirective({ code: specPostFailure.code, reason: specPostFailure.reason, resumeInstruction: specPostFailure.resumeInstruction, });",
        "selectedDirective ??= userDecisionDirective ?? (workerDirective instanceof ExecuteStepDirective ? null : workerDirective) ?? approvalDirective ?? activationDirective ?? outboxRecovery?.directive ?? gateDirective ?? lifecycleDirective;",
        "const claimRequired = selectedDirective instanceof ExecuteStepDirective;",
        "const claimDirective = claimRequired ? new ExecuteCommandDirective({ actionId: 'CLAIM_NEXT_ACTION', nextAction: guardedCommand('sennel flow run claim-next-action', state, binding), instruction: 'Claim the current Definition-selected action through the canonical Store before starting its worker.', reason: 'get-next-action is read-only; the explicit claim command rechecks canonical facts immediately before creating the Attempt.', }) : selectedDirective;",
        "const result = { directive: claimDirective.toJSON() };",
        "return result;",
        "}",
        "export default class GetNextActionCommand { execute(ctx) { return this.executeCanonical(ctx); } executeCanonical(ctx) { return buildCanonicalNextActionResult(ctx); } }",
      ].join("\n") + "\n"],
      ["src/flow/lib/run-dispatch.js", "export function run(input) { const registration = workerStepExecutionRegistration(input); const selection = registration.executionContract.select(input); return registration.executionContract.execute(selection, input); }\n"],
    ]);
  }
}
