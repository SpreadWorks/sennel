import assert from "node:assert/strict";
import { test } from "node:test";
import { StagedExecutionSeed } from "../fixtures/structure/staged-execution.js";
import { StepRegistration } from "../../src/flow/engine/composition/step-registration.js";
import { StepExecutionContract } from "../../src/flow/engine/composition/step-execution-contract.js";
import { NamedExecutionShape, StructureScopeContract } from "../support/structure/production-registrations.js";
import { StructureChecker, StructureScope } from "../support/structure/checker.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { SourceModule, readInvocations } from "../support/structure/source-reader.js";

function fixture(phase, review = false, constants = !review) {
  const seed = new StagedExecutionSeed(phase);
  const files = seed.files();
  const primary = seed.composition;
  const shared = `src/flow/engine/composition/${phase}-source.js`;
  const barrel = `src/flow/engine/composition/${phase}-exports.js`;
  const constructorOwner = "src/flow/engine/composition/step-registration.js";
  files.set(constructorOwner, "export class StepRegistration {}\n");
  const original = files.get(primary);
  const module = new SourceModule(primary, original);
  const array = module.declaration("registrations");
  const constructors = readInvocations({ tokens: array.tokens }).filter((call) => call.constructed);
  assert.equal(constructors.length, seed.ids.length);
  const values = constructors.map((call) => original.slice(call.token.offset - 4, call.endToken.offset + 1));
  const prefix = original.slice(0, original.indexOf("export const registrations"));
  files.set(shared, `import { StepRegistration } from './step-registration.js';\n${prefix}`
    + values.map((value, index) => `export const selected${index} = ${value};`).join("\n"));
  files.set(barrel, `export { selected0 as firstRegistration, selected1 as secondRegistration } from './${phase}-source.js';`);
  files.set(primary, `import { firstRegistration as member0, secondRegistration as member1 } from './${phase}-exports.js';\n`
    + original.slice(0, original.indexOf("export const registrations"))
    + "export const registrations = Object.freeze([member0, member1]);\n"
    + original.slice(original.indexOf("const byId")));
  if (!constants) {
    files.set(primary, original);
    files.delete(shared);
    files.delete(barrel);
  }
  let scope = seed.scope();
  if (review) {
    function selectReviewExecutionAdmission(input) { return input; }
    function projectReviewExecutionAdmission(input) { return input; }
    function executeReviewExecutionAdmission(input) { return input; }
    const contract = new StepExecutionContract({ select: selectReviewExecutionAdmission,
      project: projectReviewExecutionAdmission, execute: executeReviewExecutionAdmission });
    const registrations = seed.registrations.map((entry) => new StepRegistration({ stepId: entry.stepId,
      StepClass: entry.StepClass, ServiceClass: entry.ServiceClass,
      prepareServiceArguments: entry.prepareServiceArguments, executionContract: contract }));
    const shape = new NamedExecutionShape(seed.shape.form, seed.adapter, seed.shape.contractName,
      contract.selectorName, contract.projectorName, contract.executorName, seed.callers, seed.shape.loaders);
    files.set(seed.adapter, files.get(seed.adapter).replaceAll("selectCommand", contract.selectorName)
      .replaceAll("projectCommand", contract.projectorName).replaceAll("executeCommand", contract.executorName));
    scope = new StructureScope("/virtual", seed.entry, registrations, primary,
      new StructureScopeContract(seed.definition, [shape], registrations));
    files.set(primary, files.get(primary) + `\nexport async function finishObservedReview(input) {
      const prepared = await commandRegistration('first').create(input);
      if (prepared.completed === true) return prepared;
      await prepared.step.execute();
      return prepared.dependency(ServiceClass).settlementOutcome;
    }`);
  }
  const inspect = (sources = files) => new StructureChecker(scope, new MemorySourceRepository(sources)).check();
  const clean = () => { const report = inspect(); assert.equal(report.ok, true, report.diagnostics.map(String).join("\n")); };
  return { files, primary, shared, barrel, constructorOwner, inspect, clean };
}

const mutations = [
  ["unknown imported constant", "primary", "[member0, member1]", "[member0, unknownRegistration]", "A10", "primary"],
  ["unknown re-export", "barrel", "selected1 as secondRegistration", "missing as secondRegistration", "A10", "primary"],
  ["non-composition registration owner", "barrel", "-source.js'", "-foreign.js'", "A10", "primary"],
  ["rebound source constant", "shared", "export const selected1", "export let selected1", "A10", "primary"],
  ["source constant assignment", "shared", "export const selected1", "selected0 = null;\nexport const selected1", "A10", "primary"],
  ["source constant member mutation", "shared", "export const selected1", "selected0.StepClass = null;\nexport const selected1", "A10", "primary"],
  ["imported constant reassignment", "primary", "const byId", "member0 = null;\nconst byId", "A10", "primary"],
  ["duplicate imported identity", "primary", "[member0, member1]", "[member0, member0]", "A10", "primary"],
  ["unknown constructor shape", "shared", "export const selected0 = new StepRegistration", "export const selected0 = createRegistration", "A10", "primary"],
  ["wrong constructor owner", "shared", "'./step-registration.js'", "'./other-registration.js'", "A10", "primary"],
  ["changed source preparation", "shared", "prepareServiceArguments, executionContract", "prepareOtherArguments, executionContract", "A08", "shared"],
];
for (const phase of ["omega", "sigma"]) {
  test(`imported registration constant ${phase} resolves exact constructor through renamed re-export`, () => fixture(phase).clean());
  test(`imported registration constant ${phase} resolves renamed constructor binding`, () => {
    const built = fixture(phase);
    built.files.set(built.shared, built.files.get(built.shared)
      .replace("import { StepRegistration }", "import { StepRegistration as RegisteredConstructor }")
      .replaceAll("new StepRegistration(", "new RegisteredConstructor("));
    built.clean();
  });
  for (const [name, role, before, after, rule, diagnosticRole] of mutations) {
    test(`imported registration constant ${phase} rejects ${name}`, () => {
      const built = fixture(phase);
      built.files.set(`src/flow/engine/composition/other-registration.js`, "export class StepRegistration {}\n");
      built.files.set(`src/flow/engine/composition/${phase}-foreign.js`, `export { selected0, selected1 } from '../../lib/foreign-registration.js';`);
      built.files.set("src/flow/lib/foreign-registration.js", built.files.get(built.shared));
      built.clean();
      const path = built[role];
      const original = built.files.get(path);
      assert.ok(original.includes(before), `mutation anchor missing: ${before}`);
      built.files.set(path, original.replace(before, after));
      try {
        const report = built.inspect();
        const found = report.diagnostics.find((entry) => entry.rule === rule && entry.file === built[diagnosticRole]);
        assert.ok(found, report.diagnostics.map(String).join("\n"));
        assert.ok(found.line > 0 && found.column > 0);
        assert.ok(found.trace.includes(built[diagnosticRole]));
      } finally { built.files.set(path, original); }
      assert.equal(built.files.get(path), original);
      built.clean();
    });
  }
  test(`registered Review ${phase} completion resolves exact imported Service`, () => fixture(phase, true).clean());
  test(`registered Review ${phase} completion resolves bounded registration constant`, () => fixture(phase, true, true).clean());
  test(`registered Review ${phase} completion resolves renamed re-exported Service`, () => {
    const built = fixture(phase, true);
    built.files.set("src/flow/services/service-exports.js", "export { ServiceClass as RenamedService } from './service.js';");
    built.files.set(built.primary, built.files.get(built.primary)
      .replace("import { ServiceClass } from '../../services/service.js';", "import { ServiceClass } from '../../services/service.js';\nimport { RenamedService as SelectedService } from '../../services/service-exports.js';")
      .replace("prepared.dependency(ServiceClass)", "prepared.dependency(SelectedService)"));
    built.clean();
  });
  for (const [name, before, after] of [
    ["removed Service import", "import { ServiceClass } from '../../services/service.js';", ""],
    ["rebound Service symbol", "import { ServiceClass } from '../../services/service.js';", "import { ServiceClass } from '../../services/other-service.js';"],
    ["assigned Service symbol", "export async function finishObservedReview", "ServiceClass = null;\nexport async function finishObservedReview"],
  ]) test(`registered Review ${phase} rejects ${name}`, () => {
    const built = fixture(phase, true);
    built.files.set("src/flow/services/other-service.js", "export class ServiceClass {}\n");
    built.clean();
    const original = built.files.get(built.primary);
    assert.ok(original.includes(before));
    built.files.set(built.primary, original.replace(before, after));
    try {
      const report = built.inspect();
      const found = report.diagnostics.find((entry) => entry.rule === "A10" && entry.file === built.primary);
      assert.ok(found, report.diagnostics.map(String).join("\n"));
      assert.ok(found.line > 0 && found.column > 0);
      assert.ok(found.trace.includes(built.primary));
    } finally { built.files.set(built.primary, original); }
    assert.equal(built.files.get(built.primary), original);
    built.clean();
  });
}
