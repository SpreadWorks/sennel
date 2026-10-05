import assert from "node:assert/strict";
import { StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { StepExecutionContract } from "../../../src/flow/engine/composition/step-execution-contract.js";
import { flowStepExecutionRegistration } from "../../../src/flow/engine/composition/registered-step-execution.js";

class ExecutionObservation {
  constructor(operation, receiver, input, value) {
    this.operation = operation;
    this.receiver = receiver;
    this.stepId = input?.stepId;
    this.value = value;
  }
}

/** Inspect a registration snapshot; it never replaces production lookup or admission. */
export class PrepareExecutionObserver {
  #observations = [];
  #mocks = [];
  #registrations;
  #stepIds;

  constructor(t, { stepIds = ["branch", "prepare-spec"], registrations = stepIds
    .map((stepId) => flowStepExecutionRegistration(stepId)).filter((value) => value !== null) } = {}) {
    assert.ok(registrations.every((value) => value instanceof StepRegistration));
    this.#registrations = Object.freeze([...registrations]);
    this.#stepIds = new Set([...stepIds, ...registrations.map((registration) => registration.stepId)]);
    t.after(() => this.restore());
    const observations = this.#observations;
    const create = StepRegistration.prototype.create;
    this.#mocks.push(t.mock.method(StepRegistration.prototype, "create", async function (input) {
      const prepared = await create.call(this, input);
      observations.push(new ExecutionObservation("create", this, input, prepared));
      return prepared;
    }));
    for (const operation of ["select", "project", "execute"]) {
      const implementation = StepExecutionContract.prototype[operation];
      this.#mocks.push(t.mock.method(StepExecutionContract.prototype, operation, function (...args) {
        if (operation !== "select") {
          observations.push(new ExecutionObservation(operation, this, args[1], args[0]));
        }
        const value = implementation.apply(this, args);
        if (operation === "select") {
          observations.push(new ExecutionObservation(operation, this, args[0], value));
        }
        return value;
      }));
    }
  }

  restore() {
    for (const mocked of this.#mocks.splice(0).reverse()) mocked.mock.restore();
  }

  prepared(registration) {
    return this.#observations.filter((entry) => entry.operation === "create"
      && entry.receiver === registration).map((entry) => entry.value);
  }

  #calls(stepId, operation) {
    return this.#observations.filter((entry) => entry.operation === operation
      && entry.stepId === stepId);
  }

  assertCoherent() {
    const selections = new Map(this.#registrations.map((registration) => [registration, new Set()]));
    for (const entry of this.#observations) {
      if (entry.operation === "create") continue;
      const stepId = entry.stepId;
      const knownContract = this.#registrations.some((registration) => registration.executionContract === entry.receiver);
      if (!knownContract && !this.#stepIds.has(stepId)) continue;
      const registration = this.#registrations.find((candidate) => candidate.stepId === stepId);
      assert.ok(registration instanceof StepRegistration,
        `A10 ${stepId}: caller requires its production registration and selected Step identity`);
      assert.equal(entry.receiver, registration.executionContract,
        `A10 ${stepId}: caller must use the production execution contract`);
      if (entry.operation === "select") {
        assert.equal(entry.value !== null && typeof entry.value === "object", true,
          `A10 ${stepId}: selection must be an actual typed value`);
        selections.get(registration).add(entry.value);
      } else {
        assert.equal(selections.get(registration).has(entry.value), true,
          `A10 ${stepId}: ${entry.operation} must consume this registration's original selection object`);
      }
    }
  }

  assertExecuted(stepIds) {
    this.assertConsumed(stepIds);
    for (const stepId of stepIds) {
      assert.equal(this.#calls(stepId, "execute").length, 1,
        `A10 ${stepId}: prepare must consume its production selection exactly once`);
    }
  }

  assertConsumed(stepIds) {
    this.assertCoherent();
    for (const stepId of stepIds) {
      assert.ok(this.#calls(stepId, "select").length > 0,
        `A10 ${stepId}: caller must select through its production execution contract`);
      assert.ok(this.#calls(stepId, "execute").length > 0,
        `A10 ${stepId}: caller must consume its production selection`);
    }
  }

  assertProjected(stepId) {
    this.assertCoherent();
    assert.ok(this.#calls(stepId, "project").length > 0,
      `A10 ${stepId}: an available preparation Action must consume the production selection`);
  }
}
