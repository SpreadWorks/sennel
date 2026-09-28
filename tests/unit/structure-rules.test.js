import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowStructureRules } from "../support/structure/flow-rules.js";
import { SourceModule } from "../support/structure/source-reader.js";
import { assertServiceBoundary, ServiceBoundaryViolation } from "../support/structure/service-boundary.js";

test("Flow rules classify module roles and normalize allowed builtins", () => {
  const rules = new FlowStructureRules();
  const plain = new SourceModule("plain.js", "export const Value = 1;");
  const step = new SourceModule("step.js", "export class Example extends Step {}");
  assert.equal(rules.role("src/flow/steps/alpha/value.js", plain, () => false), "helper");
  assert.equal(rules.role("src/flow/steps/alpha/step.js", step, () => true), "step");
  assert.equal(rules.role("src/flow/services/example.js", plain, () => false), "service");
  assert.equal(rules.role("src/flow/lib/current-flow-state.js", plain, () => false), "forbidden");
  assert.equal(rules.builtin("node:crypto"), "crypto");
  assert.equal(rules.builtin("crypto"), "crypto");
  assert.equal(rules.allowsBuiltin("crypto"), true);
  assert.equal(rules.allowsBuiltin("fs"), false);
  assert.equal(rules.violationRule("helper", "service"), "A04");
});

test("Service boundary rejects hidden and Symbol own data but allows private fields", () => {
  class PrivateService { #state = 1; value() { return this.#state; } }
  assert.equal(assertServiceBoundary(new PrivateService()).value(), 1);
  const exposed = new PrivateService();
  Object.defineProperty(exposed, "hidden", { value: 1, enumerable: false });
  assert.throws(() => assertServiceBoundary(exposed), (error) => error instanceof ServiceBoundaryViolation && error.property === "hidden");
  const symbol = Symbol("state");
  const symbolService = new PrivateService();
  symbolService[symbol] = 1;
  assert.throws(() => assertServiceBoundary(symbolService), (error) => error instanceof ServiceBoundaryViolation && error.property === symbol);
});
