import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { flowStepExecutionRegistration } from "../../../src/flow/engine/composition/registered-step-execution.js";
import { draftStructureManifest, specStructureManifest, futurePhaseManifests } from "./phase-manifest.js";
import { ExecutionCaller, ExecutionLoader, NamedExecutionShape, ProductionRegistrations, SharedExecutionShape } from "./production-registrations.js";

/** Board 37e4 fixes tests for the existing 03 production responsibility manifest. */
export const implPhaseManifest = futurePhaseManifests.find((manifest) => manifest.id === "03");
export const implPhaseScopes = implPhaseManifest.entries;
export const implPhaseExecutionForms = Object.freeze({
  implement: "source-entry", "task-impl": "source-entry",
  "task-review": "semantic-review", "task-triage": "host-filter",
  "task-repair": "source-entry", "task-gate": "aggregate-gate",
  "test-execute": "external-process", "test-result-review": "deterministic-review",
  "impl-review": "semantic-review", "impl-triage": "source-entry",
  "impl-repair": "source-entry", "impl-gate": "aggregate-gate",
});

/** Existing source workers, provider Reviews and Gates reuse their shared adapters.
 * Missing contracts belong to existing common owners:
 * - execution-admission.js must expose the host filter's acquired four-guard
 *   selection/project/execute contract around TaskReviewHostFilter and the
 *   existing confirmTaskReviewHostFilter save boundary.
 * - test-chain-transition-facts.js must expose one registration contract shared
 *   by external test execution and deterministic evidence Review, reusing
 *   admitTestChainDirectExecution/readCurrentTestChainTransitionFacts.
 * Source handoff/capability validation remains in WorkerArtifactHandoffCoordinator;
 * Task mapping extends existing worker admission with TaskStepIdentity.
 * These are declarations, never phase-specific adapter implementations.
 */
export function implPhaseExecutionShapes(entry) {
  const phase = entry.entry.split("/").at(-1);
  const lookup = `${phase}StepRegistration`;
  const forms = new Set(entry.definition.leaves.map((leaf) => implPhaseExecutionForms[leaf.stepId]));
  const shared = [new SharedExecutionShape("worker", "source-entry"),
    new SharedExecutionShape("review", "semantic-review"), new SharedExecutionShape("gate", "aggregate-gate")];
  const loaders = [
    new ExecutionLoader("src/flow/registry.js", "loadGetNextActionCommand", "src/flow/lib/get-next-action.js"),
    new ExecutionLoader("src/flow/registry.js", "loadDispatchCommand", "src/flow/lib/run-dispatch.js"),
    new ExecutionLoader("src/flow/registry.js", "loadGateCommand", "src/flow/lib/run-gate.js"),
    new ExecutionLoader("src/flow/registry.js", "loadReviewCommand", "src/flow/lib/run-review.js"),
  ];
  const additional = [
    new NamedExecutionShape("host-filter", "src/flow/lib/execution-admission.js", "hostFilterStepExecutionContract",
      "selectHostFilterExecution", "projectHostFilterExecution", "executeHostFilterSelection", [
        new ExecutionCaller("src/flow/lib/get-next-action.js", "projectHostFilterExecutionDirective", lookup, "project", null, "select", true),
        new ExecutionCaller("src/flow/lib/run-filter-task-review.js", "executeHostFilterInput", lookup, "execute", null, "select", true),
        new ExecutionCaller(entry.composition, "consumeHostFilterExecution", lookup, "execute", null, "consume", true),
        new ExecutionCaller(entry.composition, "recoverHostFilterExecution", lookup, "execute", "replayHostFilterReceipt", "consume", true),
      ], loaders),
    ...["external-process", "deterministic-review"].map((form) => new NamedExecutionShape(form,
      "src/flow/lib/test-chain-transition-facts.js", "testChainStepExecutionContract",
      "selectTestChainExecution", "projectTestChainExecution", "executeTestChainSelection", [
        new ExecutionCaller("src/flow/lib/get-next-action.js", "projectTestChainExecutionDirective", lookup, "project", null, "select", true),
        new ExecutionCaller(form === "external-process" ? "src/flow/lib/run-test-execute.js" : "src/flow/lib/run-test-result-review.js",
          "executeTestChainInput", lookup, "execute", null, "select", true),
        new ExecutionCaller(entry.composition, "consumeTestChainExecution", lookup, "execute", null, "consume", true),
        new ExecutionCaller(entry.composition, "recoverTestChainExecution", lookup, "execute", "replayTestChainReceipt", "consume", true),
      ], loaders)),
  ];
  return Object.freeze([...shared, ...additional].filter((shape) => forms.has(shape.form)));
}

export function implPhaseStructureContract(entry, registry) {
  const forms = Object.fromEntries(entry.definition.leaves.map((leaf) => [leaf.stepId, implPhaseExecutionForms[leaf.stepId]]));
  return entry.contract(registry, implPhaseExecutionShapes(entry), forms);
}

/** Admit the fixed production export before imports can obscure an absent contract. */
export class ImplPhaseProductionRegistrations extends ProductionRegistrations {
  #root;
  #entry;

  constructor(root, entry) {
    super(pathToFileURL(path.join(root, entry.composition)), entry.exportName);
    this.#root = root;
    this.#entry = entry;
  }

  async load() {
    const entry = this.#entry;
    const ids = entry.definition.leaves.map((leaf) => leaf.stepId);
    const contract = `A01/A11 ${entry.composition}: production ${entry.exportName} must register fixed leaves ${ids.join(", ")}`;
    assert.equal(fs.existsSync(path.join(this.#root, entry.composition)), true, `${contract}; missing composition`);
    let registrations;
    try { registrations = await super.load(); }
    catch (error) {
      if (!(error instanceof TypeError)) throw error;
      assert.fail(`${contract}; ${error.message}`);
    }
    assert.deepEqual(registrations.map((registration) => registration.stepId).sort(), [...ids].sort(), contract);
    for (const registration of registrations) {
      const selected = flowStepExecutionRegistration(registration.stepId);
      assert.equal(selected instanceof StepRegistration, true, `A11 ${registration.stepId}: missing single production execution lookup`);
      assert.equal(selected, registration, `A10/A11 ${registration.stepId}: lookup must consume the actual production registration`);
    }
    return registrations;
  }

  async registry() {
    const selected = await this.load();
    // Snapshot only existing earlier scopes and this implementation phase.
    // Future 04/05 contracts never participate in board 37e4 acceptance.
    const entries = [draftStructureManifest, specStructureManifest,
      ...futurePhaseManifests.filter((manifest) => ["01", "02", "03"].includes(manifest.id))]
      .flatMap((manifest) => manifest.entries)
      .filter((entry) => entry.composition !== this.#entry.composition
        && fs.existsSync(path.join(this.#root, entry.composition)));
    const others = await Promise.all(entries.map((entry) => new ProductionRegistrations(
      pathToFileURL(path.join(this.#root, entry.composition)), entry.exportName).load()));
    return { selected, registry: [...selected, ...others.flat()] };
  }
}
