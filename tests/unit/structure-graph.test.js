import assert from "node:assert/strict";
import { test } from "node:test";
import { Step } from "../../src/flow/engine/step.js";
import { StepRegistration } from "../../src/flow/engine/composition/step-registration.js";
import { SyntheticStructureSeed } from "../fixtures/structure/synthetic.js";
import { StructureChecker, StructureScope } from "../support/structure/checker.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";

class ServiceClass {}
class AlphaStep extends Step { static dependencies = [ServiceClass]; }
const registration = new StepRegistration({ stepId: "entry", StepClass: AlphaStep, prepareDependencies: () => new Map() });

function graph(files) {
  return new StructureChecker(new StructureScope("/virtual", "src/flow/steps/alpha", [registration]), new MemorySourceRepository(files)).check();
}

test("in-memory graph follows reexports to a forbidden dependency with a full trace", () => {
  const files = new SyntheticStructureSeed("alpha", "AlphaStep").files();
  files.set("src/flow/steps/alpha/value.js", "export { Value } from '../../lib/other.js';\n");
  files.set("src/flow/lib/other.js", "export { Value } from './current-flow-state.js';\n");
  files.set("src/flow/lib/current-flow-state.js", "export const Value = 1;\n");
  const report = graph(files);
  assert.ok(report.diagnostics.some((entry) => entry.rule === "A03" && entry.trace.join(" -> ")
    === "src/flow/steps/alpha/step.js -> src/flow/steps/alpha/value.js -> src/flow/lib/other.js -> src/flow/lib/current-flow-state.js"));
});

test("in-memory graph terminates on a helper cycle", () => {
  const files = new SyntheticStructureSeed("alpha", "AlphaStep").files();
  files.set("src/flow/steps/alpha/value.js", "export { Value } from '../../lib/other.js';\n");
  files.set("src/flow/lib/other.js", "import { Value } from '../steps/alpha/value.js'; export { Value };\n");
  const report = graph(files);
  assert.equal(report.ok, true, report.diagnostics.map((entry) => entry.toString()).join("\n"));
  assert.equal(report.visited.has("src/flow/lib/other.js"), true);
});

test("Step inherited through a reexport is registered and reverse indexed", () => {
  const files = new SyntheticStructureSeed("alpha", "AlphaStep").files();
  files.set("src/flow/steps/alpha/base.js", "export { Step } from '../../engine/step.js';\n");
  files.set("src/flow/steps/alpha/hidden.js", "import { Step } from './base.js'; export class Hidden extends Step {}\n");
  files.set("src/other.js", "import { Hidden } from './flow/steps/alpha/hidden.js';\n");
  const report = graph(files);
  assert.ok(report.diagnostics.some((entry) => entry.rule === "A01" && entry.file.endsWith("hidden.js") && entry.message.includes("no production registration")));
  assert.ok(report.diagnostics.some((entry) => entry.rule === "A06" && entry.file === "src/other.js"));
});

test("named aliases, local exports, and export stars resolve registered Step identity", () => {
  const files = new SyntheticStructureSeed("alpha", "AlphaStep").files();
  files.set("src/flow/steps/alpha/base.js", "export { Step as Base } from '../../engine/step.js';\n");
  files.set("src/flow/steps/alpha/step.js", [
    "import { Base } from './base.js';",
    "import { ServiceClass } from '../../services/service.js';",
    "import { Value } from './value.js';",
    "class AlphaStep extends Base { static dependencies = [ServiceClass]; value() { return Value; } }",
    "export { AlphaStep as Selected };",
  ].join("\n"));
  files.set("src/flow/engine/composition/alpha-barrel.js", "export * from '../../steps/alpha/step.js';\n");
  files.set("src/flow/engine/composition/alpha.js", "import { Selected as Entry } from './alpha-barrel.js'; export const registrations = [Entry];\n");
  const report = graph(files);
  assert.equal(report.ok, true, report.diagnostics.map((entry) => entry.toString()).join("\n"));
});

test("a cyclic or missing Step export cannot satisfy registration", () => {
  const files = new SyntheticStructureSeed("alpha", "AlphaStep").files();
  files.set("src/flow/steps/alpha/barrel.js", "export * from './cycle.js';\n");
  files.set("src/flow/steps/alpha/cycle.js", "export * from './barrel.js';\n");
  files.set("src/flow/engine/composition/alpha.js", "import { AlphaStep } from '../../steps/alpha/barrel.js';\n");
  const cyclic = graph(files);
  assert.ok(cyclic.diagnostics.some((entry) => entry.rule === "A01" && entry.message.includes("has 0 source declarations")));
  files.set("src/flow/steps/alpha/barrel.js", "export { AlphaStep } from './missing.js';\n");
  const missing = graph(files);
  assert.ok(missing.diagnostics.some((entry) => entry.rule === "A01" && entry.message.includes("has 0 source declarations")));
  assert.ok(missing.diagnostics.some((entry) => entry.rule === "A03" && entry.message.includes("missing dependency")));
});

test("Service local export alias preserves the declared dependency identity", () => {
  const files = new SyntheticStructureSeed("alpha", "AlphaStep").files();
  files.set("src/flow/services/service.js", "class ServiceClass {} export { ServiceClass as Offered };\n");
  files.set("src/flow/steps/alpha/step.js", [
    "import { Step } from '../../engine/step.js';",
    "import { Offered as ServiceClass } from '../../services/service.js';",
    "import { Value } from './value.js';",
    "export class AlphaStep extends Step { static dependencies = [ServiceClass]; value() { return Value; } }",
  ].join("\n"));
  const report = graph(files);
  assert.equal(report.ok, true, report.diagnostics.map((entry) => entry.toString()).join("\n"));
});

test("external imports through a composition reexport still index the scoped Step", () => {
  const files = new SyntheticStructureSeed("alpha", "AlphaStep").files();
  files.set("src/flow/engine/composition/barrel.js", "export { AlphaStep as Selected } from '../../steps/alpha/step.js';\n");
  files.set("src/other.js", "import { Selected } from './flow/engine/composition/barrel.js';\n");
  const report = graph(files);
  assert.ok(report.diagnostics.some((entry) => entry.rule === "A06" && entry.file === "src/other.js"));
});

for (const [form, statement] of [
  ["star", "export * from './flow/engine/composition/barrel.js';\n"],
  ["namespace", "export * as exposed from './flow/engine/composition/barrel.js';\n"],
]) {
  test(`external ${form} reexport of a Step barrel is rejected`, () => {
    const files = new SyntheticStructureSeed("alpha", "AlphaStep").files();
    files.set("src/flow/engine/composition/barrel.js", "export { AlphaStep } from '../../steps/alpha/step.js';\n");
    files.set("src/other.js", statement);
    const report = graph(files);
    assert.ok(report.diagnostics.some((entry) => entry.rule === "A06" && entry.file === "src/other.js"));
  });
}
