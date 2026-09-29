import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { SyntheticStructureSeed } from "../fixtures/structure/synthetic.js";
import { createTmpDir, removeTmpDir } from "../support/builders/tmp-dir.js";
import { checkStructure } from "../support/structure/checker.js";
import { ProductionRegistrations } from "../support/structure/production-registrations.js";

class RegistrationFixture {
  constructor(t) {
    this.root = createTmpDir("structure-registration-");
    t.after(() => removeTmpDir(this.root));
    for (const [file, content] of new SyntheticStructureSeed("spec", "FixtureStep", "value", "spec").files()) {
      const destination = path.join(this.root, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
    this.modulePath = path.join(this.root, "registrations.mjs");
  }

  write(source) { fs.writeFileSync(this.modulePath, source); }
  source() { return new ProductionRegistrations(pathToFileURL(this.modulePath), "specStepRegistrations"); }
}

test("production registration source rejects missing, unreadable, and invalid exports", async (t) => {
  const missing = new RegistrationFixture(t);
  await assert.rejects(missing.source().load(), /Cannot load production registrations/);

  const unreadable = new RegistrationFixture(t);
  unreadable.write("import './missing.mjs';\n");
  await assert.rejects(unreadable.source().load(), /Cannot load production registrations/);

  const invalidSyntax = new RegistrationFixture(t);
  invalidSyntax.write("export const = ;\n");
  await assert.rejects(invalidSyntax.source().load(), /SyntaxError/);

  for (const source of [
    "export const other = [];\n",
    "export const specStepRegistrations = [];\n",
    "export const specStepRegistrations = [{}];\n",
  ]) {
    const invalid = new RegistrationFixture(t);
    invalid.write(source);
    await assert.rejects(invalid.source().load(), /nonempty specStepRegistrations array of StepRegistration instances/);
  }
});

test("valid loaded registration reaches the shared checker and rejects a violation", async (t) => {
  const fixture = new RegistrationFixture(t);
  const stepUrl = new URL("../../src/flow/engine/step.js", import.meta.url);
  const registrationUrl = new URL("../../src/flow/engine/composition/step-registration.js", import.meta.url);
  const executionUrl = new URL("../fixtures/structure/execution.js", import.meta.url);
  fixture.write([
    `import { Step } from ${JSON.stringify(stepUrl.href)};`,
    `import { StepRegistration } from ${JSON.stringify(registrationUrl.href)};`,
    `import { workerStepExecutionContract } from ${JSON.stringify(executionUrl.href)};`,
    "class Input {} class Writer {} class ServiceClass { static argumentTypes = [Input, Writer]; }",
    "class FixtureStep extends Step { static dependencies = [ServiceClass]; constructor(service) { super(); this.service = service; } }",
    "function prepareServiceArguments() { return [new Input(), new Writer()]; }",
    "export const specStepRegistrations = [new StepRegistration({ stepId: 'spec', StepClass: FixtureStep, ServiceClass, prepareServiceArguments, executionContract: workerStepExecutionContract })];",
  ].join("\n"));
  const registrations = await fixture.source().load();
  const scope = { root: fixture.root, entry: "src/flow/steps/spec", registrations };
  const clean = checkStructure(scope);
  assert.equal(clean.ok, true, clean.diagnostics.map((entry) => entry.toString()).join("\n"));
  assert.ok(clean.visited.size > 0);
  const target = path.join(fixture.root, "src/flow/steps/spec/value.js");
  fs.writeFileSync(target, "import fs from 'node:fs'; export const Value = fs.existsSync;\n");
  const broken = checkStructure(scope);
  assert.equal(broken.ok, false);
  assert.ok(broken.diagnostics.some((entry) => entry.rule === "A03" && entry.file === "src/flow/steps/spec/value.js"),
    broken.diagnostics.map((entry) => entry.toString()).join("\n"));
});
