import assert from "node:assert/strict";
import test from "node:test";

import { StepFactory } from "../../src/flow/engine/step-factory.js";
import { Step } from "../../src/flow/engine/step.js";

test("StepFactory constructs a declared service with its bound arguments", () => {
  class Source {
    constructor(value) { this.value = value; }
  }
  class Service {
    static dependencies = [Source];
    constructor(binding, source) {
      this.binding = binding;
      this.source = source;
    }
  }
  class DraftStep extends Step {
    static dependencies = [Service];
    constructor(service) { super(); this.service = service; }
  }

  const step = new StepFactory()
    .provideArguments(Source, "source")
    .provideArguments(Service, "bound-attempt")
    .create(DraftStep);

  assert.equal(step.service.binding, "bound-attempt");
  assert.equal(step.service.source.value, "source");
});

test("StepFactory reuses an explicitly supplied dependency", () => {
  class Service {}
  class DraftStep extends Step {
    static dependencies = [Service];
    constructor(service) { super(); this.service = service; }
  }
  const service = new Service();
  assert.equal(new StepFactory().provide(Service, service).create(DraftStep).service, service);
});
