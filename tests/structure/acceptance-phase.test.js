import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { NamedPhaseExecutionSeed, StagedExecutionSeed } from "../fixtures/structure/staged-execution.js";
import { checkStructure, StructureChecker } from "../support/structure/checker.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { ProductionRegistrations } from "../support/structure/production-registrations.js";
import { assertStructureSuccess as success, assertStructureViolation as violation } from "../support/structure/assertions.js";
import { AcceptancePhaseProductionRegistrations, acceptancePhaseManifest, acceptancePhaseScope as entry,
  acceptancePhaseExecutionForms, acceptancePhaseExecutionShapes, acceptancePhaseSnapshotEntries,
  acceptancePhaseStructureContract } from "../support/structure/acceptance-phase-scope.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ids = ["retro", "acceptance-review", "acceptance-decision", "final-regression", "report"];
function seed() { return new NamedPhaseExecutionSeed(entry, acceptancePhaseExecutionShapes, acceptancePhaseExecutionForms); }

test("04 fixes five existing responsibilities and includes introduced phases while excluding 05", () => {
  assert.equal(acceptancePhaseManifest.id, "04");
  assert.deepEqual(acceptancePhaseManifest.leaves.map((leaf) => leaf.stepId), ids);
  assert.deepEqual([entry.entry, entry.composition, entry.exportName],
    ["src/flow/steps/acceptance", "src/flow/engine/composition/acceptance.js", "acceptanceStepRegistrations"]);
  assert.deepEqual(acceptancePhaseSnapshotEntries.map((scope) => scope.exportName), [
    "draftStepRegistrations", "specStepRegistrations", "prepareStepRegistrations", "requirementTestStepRegistrations",
    "implStepRegistrations", "taskStepRegistrations", "acceptanceStepRegistrations",
  ]);
  assert.deepEqual(acceptancePhaseExecutionShapes.map((shape) => shape.form), ids);
  for (const shape of acceptancePhaseExecutionShapes) {
    assert.equal(shape.callers.some((caller) => caller.module === "src/flow/lib/run-dispatch.js"), true);
    assert.equal(shape.callers.some((caller) => caller.declarationName.startsWith("preview")), ["retro", "report"].includes(shape.form));
    assert.equal(shape.callers.some((caller) => caller.receiptReplayName !== null), true);
  }
});

test("A01-A12 lawful isolated five-leaf graph reaches the shared checker", (t) => {
  const fixture = seed();
  const report = fixture.inspect();
  success(report);
  t.diagnostic(report.describe());
  for (const [index] of ids.entries()) assert.ok(report.visited.has(`${entry.entry}/step${index}.js`));
  assert.ok(report.serviceBoundaries.has("src/flow/services/service.js"));
  for (const shape of fixture.shapes) for (const caller of [...shape.callers, ...shape.loaders]) {
    assert.ok(report.reverseIndexed.has(caller.module));
  }
});

for (const leaf of acceptancePhaseManifest.leaves) {
  test(`A01/A11 production ${leaf.stepId} requires its real fixed registration and lookup`, async () => {
    const registrations = await new AcceptancePhaseProductionRegistrations(root).load();
    assert.equal(registrations.filter((registration) => registration.stepId === leaf.stepId).length, 1);
  });
  test(`A01 ${leaf.stepId} removal cannot shrink the fixed responsibility scope`, () => {
    const fixture = seed();
    const files = fixture.files();
    const index = ids.indexOf(leaf.stepId);
    files.delete(`${entry.entry}/step${index}.js`);
    files.set(entry.composition, files.get(entry.composition)
      .replace(new RegExp(`import \\{ Entry${index}Step \\}[^;]+;`), "")
      .replace(new RegExp(`new StepRegistration\\(\\{ stepId: '${leaf.stepId}'[^)]+\\}\\)`), "")
      .replaceAll(",,", ",").replace("[,", "[").replace(",]", "]"));
    const selected = fixture.registrations.filter((registration) => registration.stepId !== leaf.stepId);
    violation(fixture.inspect(files, fixture.scope(selected, selected)), "A01", entry.composition,
      `responsibility leaf ${leaf.stepId} has 0 selected registrations`, [entry.definition.module, entry.composition]);
    success(fixture.inspect());
  });
}

test("production Acceptance closure, registry origin, and all direct/dispatch/preview/recovery adapters comply", async (t) => {
  const { selected: registrations, registry } = await new AcceptancePhaseProductionRegistrations(root).registry();
  const report = checkStructure({ root, entry: entry.entry, registrations, registrationModule: entry.composition,
    contract: acceptancePhaseStructureContract(registry) });
  t.diagnostic(report.describe());
  success(report);
  assert.ok(report.visited.size > 0 && report.serviceBoundaries.size > 0);
});

for (const [label, source, reason] of [
  ["missing module", null, "missing composition"],
  ["missing export", "export const unrelated = [];", "must export a nonempty"],
  ["empty export", `export const ${entry.exportName} = [];`, "must export a nonempty"],
  ["invalid export", `export const ${entry.exportName} = [{}];`, "must export a nonempty"],
]) test(`A01/A11 ${label} fails with the fixed contract, before an import error`, async (t) => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-acceptance-registration-"));
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  if (source !== null) {
    const module = path.join(isolated, entry.composition);
    fs.mkdirSync(path.dirname(module), { recursive: true });
    fs.writeFileSync(path.join(isolated, "package.json"), '{"type":"module"}');
    fs.writeFileSync(module, source);
  }
  await assert.rejects(new AcceptancePhaseProductionRegistrations(isolated).load(), (error) => {
    assert.equal(error.code, "ERR_ASSERTION");
    for (const part of ["A01/A11", entry.composition, entry.exportName, ...ids, reason]) assert.ok(error.message.includes(part));
    return true;
  });
  // Restoration proves the shared checker independently; it cannot satisfy production coverage.
  success(seed().inspect());
});

test("isolated valid export reaches the common registration loader and checker", async (t) => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-acceptance-valid-export-"));
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  const module = path.join(isolated, "registrations.mjs");
  const fixtureModule = pathToFileURL(path.join(root, "tests/fixtures/structure/staged-execution.js")).href;
  fs.writeFileSync(module, `import { StagedExecutionSeed } from ${JSON.stringify(fixtureModule)};
    export const acceptanceStepRegistrations = new StagedExecutionSeed('valid-acceptance', ${JSON.stringify(ids)}).registrations;`);
  const registrations = await new ProductionRegistrations(pathToFileURL(module), entry.exportName).load();
  assert.deepEqual(registrations.map((registration) => registration.stepId), ids);
  const fixture = new StagedExecutionSeed("valid-acceptance", ids);
  success(new StructureChecker(fixture.scope(registrations, registrations), new MemorySourceRepository(fixture.files())).check());
});

test("A01 duplicate, foreign-origin and excluded registrations each fail and restore independently", () => {
  const fixture = seed();
  for (const [selected, registry, message] of [
    [fixture.registrations, [...fixture.registrations, fixture.registrations[0]], "single production registry duplicates retro"],
    [fixture.registrations, seed().registrations, "selection retro does not belong"],
    [fixture.registrations.slice(1), fixture.registrations, "leaf retro was excluded"],
  ]) {
    violation(fixture.inspect(fixture.files(), fixture.scope(selected, registry)), "A01", entry.composition,
      message, [entry.composition]);
    success(fixture.inspect());
  }
});

const step = `${entry.entry}/step0.js`;
const helper = "src/flow/lib/acceptance-value.js";
for (const [label, rule, file, source, importSource, trace, marker, message] of [
  ["unregistered Step", "A01", `${entry.entry}/extra.js`, "import { Step } from '../../engine/step.js'; export class Extra extends Step {}", null,
    [`${entry.entry}/extra.js`], "class Extra", "Step has no production registration"],
  ["direct Definition route", "A02", step, "import { FLOW_DEFINITION } from '../../definition.js';", null,
    [step, "src/flow/definition.js"], "import", "step depends on forbidden"],
  ["indirect Store dependency", "A03", helper, "export { Store } from './canonical-probe-store.js';",
    "import { Store } from '../../lib/acceptance-value.js';", [step, helper, "src/flow/lib/canonical-probe-store.js"], "export", "helper depends on forbidden"],
  ["Service re-export", "A04", helper, "export { ServiceClass } from '../services/service.js';",
    "import { ServiceClass as Hidden } from '../../lib/acceptance-value.js';", [step, helper, "src/flow/services/service.js"], "export", "Service reached outside declared Step dependency"],
  ["dynamic IO", "A05", step, "export function load() { return import('node:fs'); }", null,
    [step], "import", "dynamic"],
  ["process read", "A05", step, "export const env = process.env;", null, [step], "process", "process"],
  ["Service alias construction", "A09", "src/flow/lib/illegal-service.js", "import { ServiceClass as Alias } from '../services/service.js'; export function create() { return new Alias(); }", null,
    ["src/flow/lib/illegal-service.js", "src/flow/services/service.js"], "new", "outside StepRegistration"],
]) test(`${rule} ${label} reports exact source location/path then accepts removal`, () => {
  const fixture = seed();
  const files = fixture.files();
  const original = files.get(file);
  files.set(file, file === step ? `${source}\n${original}` : source);
  if (importSource !== null) files.set(step, `${importSource}\n${files.get(step)}`);
  if (label === "indirect Store dependency") files.set("src/flow/lib/canonical-probe-store.js", "export class Store {}");
  violation(fixture.inspect(files), rule, file, message, trace, files.get(file), marker);
  if (original === undefined) files.delete(file); else files.set(file, original);
  if (importSource !== null) files.set(step, fixture.files().get(step));
  files.delete("src/flow/lib/canonical-probe-store.js");
  success(fixture.inspect(files));
});

test("A06 reverse references retain both re-export and illegal caller paths", () => {
  const fixture = seed();
  const files = fixture.files();
  const barrel = "src/flow/lib/acceptance-barrel.js";
  const caller = "src/flow/lib/illegal-step.js";
  const reexport = "export { Entry0Step as Escaped } from '../steps/acceptance/step0.js';";
  const source = "import { Escaped } from './acceptance-barrel.js'; export const reference = Escaped;";
  files.set(barrel, reexport); files.set(caller, source);
  violation(fixture.inspect(files), "A06", barrel, "Step is referenced outside composition", [barrel, step], reexport, "export");
  violation(fixture.inspect(files), "A06", caller, "Step is referenced outside composition", [caller, barrel], source, "import");
  files.delete(barrel); files.delete(caller);
  success(fixture.inspect(files));
});

for (const [label, replacement, marker, message] of [
  ["manager read through alias", "const alias = this.#flowManager; return alias.artifactCatalog('x');", "artifactCatalog", "settlement writer reads or escapes manager through artifactCatalog"],
  ["captured manager", "return () => this.#flowManager;", "flowManager", "manager"],
]) test(`A08 ${label} cannot hide behind a settlement Writer`, () => {
  const fixture = seed(); const files = fixture.files();
  const file = "src/flow/services/alpha-settlement-writer.js";
  const original = files.get(file);
  const source = `export class Writer { #flowManager; constructor(source) { this.#flowManager = source; } settle() { ${replacement} } }`;
  files.set(file, source);
  violation(fixture.inspect(files), "A08", file, message, ["src/flow/services/service.js", file]);
  files.set(file, original); success(fixture.inspect(files));
});

for (const input of ["ctx", "flowManager", "reader"]) test(`A12 typed input cannot capture broad ${input}`, () => {
  const fixture = seed(); const files = fixture.files(); const original = files.get(entry.composition);
  const changed = original.replace("new Input()", `new Input(${input})`);
  files.set(entry.composition, input === "reader" ? changed.replace("function prepareServiceArguments() {", "function prepareServiceArguments(ctx) { const reader = ctx.reader;") : changed);
  violation(fixture.inspect(files), "A12", entry.composition, `typed input receives broad dependency ${input}`,
    [entry.composition]);
  files.set(entry.composition, original); success(fixture.inspect(files));
});

for (const shape of acceptancePhaseExecutionShapes) for (const caller of shape.callers) {
  // Shared callers are checked once; every leaf-specific direct and preview path is checked.
  if (shape !== acceptancePhaseExecutionShapes[0] && !caller.declarationName.match(/^(execute|preview)(Retro|AcceptanceReview|AcceptanceDecision|FinalRegression|Report)Input$/)) continue;
  const probes = caller.operation === "project"
    ? [["discard selection", "project(selection,", "project(null,"]]
    : [["bypass", "const registration =", "if (input.fast) return input.command.execute(input); const registration ="],
      ["independent route", "const registration =", "if (input.stepId === 'retro') return { target: 'report' }; const registration ="]];
  for (const [label, before, after] of probes) test(`A10 ${caller.declarationName} rejects ${label} alone`, () => {
    const fixture = seed(); const files = fixture.files(); const original = files.get(caller.module);
    const offset = original.indexOf(`export function ${caller.declarationName}(input)`);
    assert.ok(offset >= 0 && original.slice(offset).includes(before));
    files.set(caller.module, original.slice(0, offset) + original.slice(offset).replace(before, after));
    violation(fixture.inspect(files), "A10", caller.module, `${caller.declarationName} does not preserve registered lookup and selection`,
      [entry.composition, shape.adapterModule, caller.module]);
    files.set(caller.module, original); success(fixture.inspect(files));
  });
}

for (const loader of new Map(acceptancePhaseExecutionShapes.flatMap((shape) => shape.loaders)
  .map((loader) => [loader.declarationName, loader])).values()) {
  test(`A11 ${loader.declarationName} cannot bypass named command loading`, () => {
    const fixture = seed(); const files = fixture.files(); const original = files.get(loader.module);
    files.set(loader.module, original.replace(`command: ${loader.declarationName}`, "command: loadUnknownCommand"));
    if (loader.commandGroup === null) {
      violation(fixture.inspect(files), "A11", loader.module, `must have one named ${loader.declarationName}`,
        [loader.module], files.get(loader.module), "const FLOW_COMMANDS");
    } else {
      violation(fixture.inspect(files), "A11", loader.module, `${loader.declarationName} is not its named command loader`,
        [loader.module, loader.commandModule], files.get(loader.module), `function ${loader.declarationName}`);
    }
    files.set(loader.module, original); success(fixture.inspect(files));
  });
}

test("A08 Service getter cannot hide IO through an imported reader instance", () => {
  const fixture = seed(); const files = fixture.files();
  const service = "src/flow/services/service.js";
  const helper = "src/flow/lib/acceptance-reader.js";
  const original = files.get(service);
  files.set(service, "import { InputReader } from '../lib/acceptance-reader.js';\n" + original.replace(
    "throw new TypeError(); } }", "throw new TypeError(); } get payload() { const reader = new InputReader(); return reader.payload; } }"));
  const lawful = "import fs from 'node:fs'; export class InputReader { get payload() { return 1; } }";
  files.set(helper, lawful);
  success(fixture.inspect(files));
  const malformed = lawful.replace("return 1", "return fs.readFileSync('x')");
  files.set(helper, malformed);
  violation(fixture.inspect(files), "A08", helper, "Service reaches IO builtin fs", [service, helper], malformed, "import");
  files.set(helper, lawful);
  success(fixture.inspect(files));
});

test("A10 post consumption cannot overwrite an acquired selection or repeat selection", () => {
  const fixture = seed(); const files = fixture.files();
  const original = files.get(entry.composition);
  const declaration = original.indexOf("export function consumeAcceptanceExecution(input)");
  for (const malformed of ["let selection = input.selection; selection = null;",
    "const selection = registration.executionContract.select({ ...input, registration });"]) {
    files.set(entry.composition, original.slice(0, declaration) + original.slice(declaration)
      .replace("const selection = input.selection;", malformed));
    violation(fixture.inspect(files), "A10", entry.composition,
      "consumeAcceptanceExecution does not preserve registered lookup and selection", [entry.composition, entry.composition, entry.composition]);
    files.set(entry.composition, original); success(fixture.inspect(files));
  }
});

test("A11 an unregistered direct caller cannot escape the assembly execution adapter", () => {
  const fixture = seed(); const files = fixture.files(); const file = "src/flow/lib/acceptance-bypass.js";
  const source = "import { acceptanceStepExecutionContract as escaped } from '../engine/composition/acceptance.js'; export function execute(input) { return escaped.execute(input.selection, input); }";
  files.set(file, source);
  violation(fixture.inspect(files), "A11", file, "shared execution adapter imported outside production registration",
    [file, entry.composition], source, "import");
  files.delete(file); success(fixture.inspect(files));
});
