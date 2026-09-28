import assert from "node:assert/strict";
import { test } from "node:test";
import { FlowStructureRules } from "../support/structure/flow-rules.js";
import { SourceModule } from "../support/structure/source-reader.js";
import {
  assertServiceBoundary, ServiceBoundaryCoverage, ServiceBoundaryViolation,
} from "../support/structure/service-boundary.js";

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

test("A07 coverage finds a newly declared Service without an inspected instance", () => {
  class ExistingService { #state = 1; value() { return this.#state; } }
  class NewService { #state = 2; value() { return this.#state; } }
  class ExistingStep { static dependencies = [ExistingService]; }
  class AnotherExistingStep { static dependencies = [ExistingService]; }
  class NewStep { static dependencies = [NewService]; }
  const registrations = [
    { StepClass: ExistingStep }, { StepClass: AnotherExistingStep }, { StepClass: NewStep },
  ];
  const coverage = new ServiceBoundaryCoverage(registrations);

  assert.equal(assertServiceBoundary(new ExistingService()).value(), 1);
  coverage.inspect(ExistingService, new ExistingService());
  assert.throws(() => coverage.assertComplete(), /A07 has no inspected instance for NewService/);
  coverage.inspect(NewService, new NewService());
  assert.equal(coverage.assertComplete(), 2);
});

test("A07 coverage rejects a wrong instance under a declared Service key", () => {
  class FirstService {}
  class OtherService {}
  class FirstStep { static dependencies = [FirstService]; }
  const coverage = new ServiceBoundaryCoverage([{ StepClass: FirstStep }]);

  assert.throws(() => coverage.inspect(FirstService, new OtherService()), /registered FirstService instance/);
  assert.throws(() => coverage.assertComplete(), /no inspected instance for FirstService/);
});

test("A07 coverage credits only an instance that passes the public data boundary", () => {
  class PrivateService { #state = 1; value() { return this.#state; } }
  class PrivateStep { static dependencies = [PrivateService]; }
  const coverage = new ServiceBoundaryCoverage([{ StepClass: PrivateStep }]);
  const exposed = new PrivateService();
  exposed.publicState = 1;

  assert.throws(() => coverage.inspect(PrivateService, exposed), ServiceBoundaryViolation);
  assert.throws(() => coverage.assertComplete(), /no inspected instance for PrivateService/);
  assert.equal(coverage.inspect(PrivateService, new PrivateService()).value(), 1);
  assert.equal(coverage.assertComplete(), 1);
});
