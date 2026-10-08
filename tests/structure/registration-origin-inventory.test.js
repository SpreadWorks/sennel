import assert from "node:assert/strict";
import { test } from "node:test";
import { Step } from "../../src/flow/engine/step.js";
import { StepRegistration } from "../../src/flow/engine/composition/step-registration.js";
import { SyntheticStructureSeed } from "../fixtures/structure/synthetic.js";
import { workerStepExecutionContract } from "../fixtures/structure/execution.js";
import { StructureChecker, StructureScope } from "../support/structure/checker.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { SourceModule, readInvocations } from "../support/structure/source-reader.js";

class Input {}
class Writer {}
class ServiceClass { static argumentTypes = [Input, Writer]; }
class InventoryStep extends Step { static dependencies = [ServiceClass]; }
function prepareServiceArguments() { return []; }

function fixture(phase) {
  const files = new SyntheticStructureSeed(phase, "InventoryStep").files();
  const primary = `src/flow/engine/composition/${phase}.js`;
  const owner = `src/flow/engine/composition/${phase}-owner.js`;
  const barrel = `src/flow/engine/composition/${phase}-exports.js`;
  const original = files.get(primary);
  const declaration = new SourceModule(primary, original).declaration("registrations");
  const call = readInvocations({ tokens: declaration.tokens }).find((entry) => entry.name === "StepRegistration");
  const constructor = original.slice(call.token.offset - 4, call.endToken.offset + 1);
  files.set("src/flow/engine/composition/step-registration.js", "export class StepRegistration {}\n");
  files.set(owner, `import { StepRegistration } from './step-registration.js';\n`
    + original.slice(0, original.indexOf("export const registrations"))
    + `export const originalRegistration = ${constructor};`);
  files.set(barrel, `export { originalRegistration as sharedRegistration } from './${phase}-owner.js';`);
  files.set(primary, `import { sharedRegistration as selectedRegistration } from './${phase}-exports.js';\n`
    + original.replace(`export const registrations = [${constructor}];`, "export const registrations = Object.freeze([selectedRegistration]);"));
  const route = "src/flow/engine/composition/registered-step-execution.js";
  files.set(route, `import { originalRegistration } from './${phase}-owner.js';\n` + files.get(route));
  const registration = new StepRegistration({ stepId: "entry", StepClass: InventoryStep, ServiceClass,
    prepareServiceArguments, executionContract: workerStepExecutionContract });
  const scope = new StructureScope("/virtual", `src/flow/steps/${phase}`, [registration], primary);
  const inspect = () => new StructureChecker(scope, new MemorySourceRepository(files)).check();
  const clean = () => { const report = inspect(); assert.equal(report.ok, true, report.diagnostics.map(String).join("\n")); };
  return { files, primary, owner, route, constructor, inspect, clean };
}

for (const phase of ["omega", "sigma"]) {
  test(`whole registration inventory ${phase} counts original constructor once through import, re-export and owner`, () => fixture(phase).clean());
  for (const kind of ["distinct constructors with the same Step id", "duplicate members referencing the same registration"]) {
    test(`whole registration inventory ${phase} rejects ${kind}`, () => {
      const built = fixture(phase);
      built.clean();
      const path = kind.startsWith("distinct") ? built.owner : built.primary;
      const original = built.files.get(path);
      built.files.set(path, kind.startsWith("distinct")
        ? original + `\nexport const otherRegistration = ${built.constructor};`
        : original.replace("[selectedRegistration]", "[selectedRegistration, selectedRegistration]"));
      try {
        const report = built.inspect();
        const expectedFile = kind.startsWith("distinct") ? built.route : built.primary;
        const expectedMessage = kind.startsWith("distinct") ? "duplicate static execution route registration" : "duplicate static registration array member";
        const diagnostic = report.diagnostics.find((entry) => entry.rule === "A11" && entry.file === expectedFile
          && entry.message === expectedMessage);
        assert.ok(diagnostic, report.diagnostics.map(String).join("\n"));
        assert.ok(diagnostic.line > 0 && diagnostic.column > 0);
        assert.ok(diagnostic.trace.includes(expectedFile));
      } finally { built.files.set(path, original); }
      assert.equal(built.files.get(path), original);
      built.clean();
    });
  }
}
