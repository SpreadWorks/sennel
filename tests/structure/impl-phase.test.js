import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

import { StepRegistration } from "../../src/flow/engine/composition/step-registration.js";
import { StepExecutionContract } from "../../src/flow/engine/composition/step-execution-contract.js";
import { TaskStepIdentity } from "../../src/flow/lib/task-step-identity.js";
import { StagedExecutionSeed } from "../fixtures/structure/staged-execution.js";
import { checkStructure, StructureChecker, StructureScope } from "../support/structure/checker.js";
import { ExecutionCaller, ExecutionLoader, NamedExecutionShape, ProductionRegistrations, SharedExecutionShape } from "../support/structure/production-registrations.js";
import { MemorySourceRepository } from "../support/structure/source-repository.js";
import { ImplPhaseProductionRegistrations, implPhaseExecutionForms, implPhaseExecutionShapes,
  implPhaseManifest, implPhaseScopes, implPhaseStructureContract } from "../support/structure/impl-phase-scope.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ids = ["implement", "test-execute", "test-result-review", "impl-review", "impl-triage", "impl-repair", "impl-gate",
  "task-impl", "task-review", "task-triage", "task-repair", "task-gate"];

/** Isolated source graph, never an alternative runtime registration registry. */
class ImplPhaseCheckerSeed {
  constructor(entry) {
    this.entry = entry;
    const phase = entry.entry.split("/").at(-1);
    this.base = new StagedExecutionSeed(phase, entry.definition.leaves.map((leaf) => leaf.stepId), entry.definition.leaves);
    // Synthetic named callers exercise checker wiring only. Production uses the
    // nominal shared shapes and their existing specialized routing judgments.
    this.shapes = implPhaseExecutionShapes(entry).map((shape) => shape instanceof SharedExecutionShape
      ? new NamedExecutionShape(shape.form, shape.adapterModule, shape.contractName,
        shape.selectorName, shape.projectorName, shape.executorName, [
          new ExecutionCaller("src/flow/lib/command-display.js", `project${shape.title}Execution`, `${phase}StepRegistration`, "project"),
          new ExecutionCaller("src/flow/lib/command-run.js", `execute${shape.title}Execution`, `${phase}StepRegistration`, "execute"),
          new ExecutionCaller(entry.composition, `consume${shape.title}Execution`, `${phase}StepRegistration`, "execute", null, "consume"),
          new ExecutionCaller(entry.composition, `recover${shape.title}Execution`, `${phase}StepRegistration`, "execute", `replay${shape.title}Receipt`, "consume"),
        ], [
          new ExecutionLoader("src/flow/registry.js", "loadGetNextActionCommand", "src/flow/lib/get-next-action.js"),
          new ExecutionLoader("src/flow/registry.js", "loadDispatchCommand", "src/flow/lib/run-dispatch.js"),
          new ExecutionLoader("src/flow/registry.js", "loadGateCommand", "src/flow/lib/run-gate.js"),
          new ExecutionLoader("src/flow/registry.js", "loadReviewCommand", "src/flow/lib/run-review.js"),
        ]) : shape);
    const contracts = new Map(this.shapes.map((shape) => {
      const named = (name) => Object.defineProperty((input) => input, "name", { value: name });
      return [shape.form, new StepExecutionContract({ select: named(shape.selectorName),
        project: named(shape.projectorName), execute: named(shape.executorName) })];
    }));
    this.registrations = this.base.registrations.map((registration) => new StepRegistration({
      ...registration, executionContract: contracts.get(implPhaseExecutionForms[registration.stepId]),
    }));
  }

  scope(registrations = this.registrations, registry = this.registrations) {
    return new StructureScope("/virtual", this.entry.entry, registrations, this.entry.composition,
      this.entry.contract(registry, this.shapes,
        Object.fromEntries(this.entry.definition.leaves.map((leaf) => [leaf.stepId, implPhaseExecutionForms[leaf.stepId]]))));
  }

  files() {
    const files = this.base.files();
    files.delete(this.base.adapter);
    files.delete("src/flow/command-registry.js");
    for (const caller of this.base.callers) files.delete(caller.module);
    const adapterImports = new Map();
    for (const shape of this.shapes) {
      if (!adapterImports.has(shape.adapterModule)) adapterImports.set(shape.adapterModule, new Set());
      adapterImports.get(shape.adapterModule).add(shape.contractName);
    }
    let composition = files.get(this.entry.composition)
      .replace("import { commandStepExecutionContract } from '../../lib/command-execution.js';",
        [...adapterImports].map(([module, names]) => `import { ${[...names].join(", ")} } from '${path.posix.relative(path.posix.dirname(this.entry.composition), module)}';`).join("\n"))
      .replaceAll(/\bregistrations\b/g, this.entry.exportName)
      .replaceAll("commandRegistration", this.shapes[0].callers[0].lookupName);
    for (const registration of this.registrations) {
      const shape = this.shapes.find((shape) => shape.matches(registration.executionContract));
      composition = composition.replace(`stepId: '${registration.stepId}', StepClass: ${registration.StepClass.name}, ServiceClass,
        prepareServiceArguments, executionContract: commandStepExecutionContract`,
      `stepId: '${registration.stepId}', StepClass: ${registration.StepClass.name}, ServiceClass,
        prepareServiceArguments, executionContract: ${shape.contractName}`);
    }
    files.set(this.entry.composition, composition);
    for (const module of adapterImports.keys()) {
      const adapter = [...new Set(this.shapes.filter((shape) => shape.adapterModule === module).map((shape) => `
      export function ${shape.selectorName}(input) { return input; }
      export function ${shape.projectorName}(selection, input) { return selection; }
      export function ${shape.executorName}(selection, input) { return selection; }
      export const ${shape.contractName} = new StepExecutionContract({
        select: ${shape.selectorName}, project: ${shape.projectorName}, execute: ${shape.executorName} });`))].join("\n");
      files.set(module, adapter);
    }
    for (const shape of this.shapes) for (const caller of shape.callers) {
      const relative = path.posix.relative(path.posix.dirname(caller.module), this.entry.composition);
      const imported = caller.module === this.entry.composition ? ""
        : `import { ${caller.lookupName} } from '${relative.startsWith(".") ? relative : `./${relative}`}';`;
      const existing = files.get(caller.module) ?? "";
      if (existing.includes(`export function ${caller.declarationName}(input)`)) continue;
      const declaration = `${existing.includes(imported) ? "" : imported}
        ${caller.receiptReplayName === null || existing.includes(`function ${caller.receiptReplayName}(receipt)`) ? "" : `function ${caller.receiptReplayName}(receipt) { return receipt; }`}
        export function ${caller.declarationName}(input) { ${caller.body().replaceAll("$STRING_LITERAL", "'registration required'")} }`;
      files.set(caller.module, `${files.get(caller.module) ?? ""}\n${declaration}`);
    }
    files.set("src/flow/lib/run-gate.js", "export class RunGateCommand {}\n");
    files.set("src/flow/lib/run-review.js", "export class RunReviewCommand {}\n");
    return files;
  }

  inspect(files = this.files(), scope = this.scope()) {
    return new StructureChecker(scope, new MemorySourceRepository(files)).check();
  }
}

function success(report) {
  assert.equal(report.ok, true, report.diagnostics.map((diagnostic) => diagnostic.toString()).join("\n"));
}

function violation(report, rule, file, message, trace, source = null, marker = null) {
  const diagnostic = report.diagnostics.find((entry) => entry.rule === rule && entry.file === file && entry.message.includes(message));
  assert.ok(diagnostic, report.diagnostics.map((entry) => entry.toString()).join("\n"));
  assert.deepEqual(diagnostic.trace, trace);
  if (marker !== null) {
    const offset = source.indexOf(marker);
    assert.ok(offset >= 0, `fixture must contain exact diagnostic marker ${marker}`);
    const prefix = source.slice(0, offset);
    assert.equal(diagnostic.line, prefix.split("\n").length);
    assert.equal(diagnostic.column, offset - prefix.lastIndexOf("\n"));
  } else {
    assert.ok(diagnostic.line > 0 && diagnostic.column > 0);
  }
  return diagnostic;
}

test("board 37e4 fixes exactly the existing 03 seven Flow and five Task responsibilities", () => {
  assert.equal(implPhaseManifest.id, "03");
  assert.equal(implPhaseManifest.board, "3a50");
  assert.deepEqual(implPhaseManifest.leaves.map((leaf) => leaf.stepId), ids);
  assert.deepEqual(implPhaseScopes.map((entry) => [entry.entry, entry.composition, entry.exportName]), [
    ["src/flow/steps/impl", "src/flow/engine/composition/impl.js", "implStepRegistrations"],
    ["src/flow/steps/task", "src/flow/engine/composition/task.js", "taskStepRegistrations"],
  ]);
  const taskLeaves = implPhaseScopes[1].definition.leaves;
  assert.equal(taskLeaves.every((leaf) => leaf.taskIdentity instanceof TaskStepIdentity), true);
  assert.deepEqual(taskLeaves.map((leaf) => [leaf.stepId, leaf.nodeId]), [
    ["task-impl", "T17-impl"], ["task-review", "T17-review"], ["task-triage", "T17-triage"],
    ["task-repair", "T17-repair"], ["task-gate", "T17-gate"],
  ]);
  assert.equal(implPhaseScopes[0].definition.declarationName, "FLOW_DEFINITION");
  assert.equal(implPhaseScopes[1].definition.declarationName, "TASK_DEFINITION");
  assert.match(fs.readFileSync(path.join(root, "tests/integration/flow/impl-phase-board-source.md"), "utf8"), /^# Board 37e4/m);
  assert.deepEqual(Object.keys(implPhaseExecutionForms).sort(), [...ids].sort());
  assert.deepEqual([...new Set(Object.values(implPhaseExecutionForms))].sort(),
    ["aggregate-gate", "deterministic-review", "external-process", "host-filter", "semantic-review", "source-entry"]);
  assert.equal(implPhaseExecutionForms["impl-triage"], "source-entry", "Flow triage remains a readonly source worker");
  assert.equal(implPhaseExecutionForms["task-triage"], "host-filter");
  assert.equal(implPhaseExecutionForms["test-result-review"], "deterministic-review");
  assert.equal(implPhaseExecutionForms["impl-review"], "semantic-review");
  assert.equal(implPhaseExecutionForms["task-review"], "semantic-review");
});

test("existing shared adapters own worker, provider Review and Gate forms without phase-specific aliases", async () => {
  // Load through the already initialized production registration graph; direct
  // adapter-first initialization is not the CLI's composition entry path.
  const { workerStepExecutionContract } = await import("../../src/flow/lib/worker-execution-admission.js");
  const { reviewStepExecutionContract, gateStepExecutionContract } = await import("../../src/flow/lib/execution-admission.js");
  const existing = new Map([["worker", workerStepExecutionContract], ["review", reviewStepExecutionContract], ["gate", gateStepExecutionContract]]);
  for (const entry of implPhaseScopes) for (const shape of implPhaseExecutionShapes(entry)) {
    if (shape instanceof SharedExecutionShape) {
      assert.equal(shape.matches(existing.get(shape.kind)), true);
      assert.equal(shape.adapterModule, shape.kind === "worker" ? "src/flow/lib/worker-execution-admission.js" : "src/flow/lib/execution-admission.js");
      assert.deepEqual(shape.callers, [], "common caller judgments stay in the shared checker");
    } else {
      assert.equal(shape instanceof NamedExecutionShape, true);
      assert.equal(shape.adapterModule, shape.form === "host-filter" ? "src/flow/lib/execution-admission.js" : "src/flow/lib/test-chain-transition-facts.js");
    }
  }
  const testChain = implPhaseExecutionShapes(implPhaseScopes[0]).filter((shape) => ["external-process", "deterministic-review"].includes(shape.form));
  assert.equal(testChain.length, 2);
  assert.equal(testChain[0].contractName, testChain[1].contractName, "both test-chain leaves require one shared admission contract");
  assert.throws(() => new SharedExecutionShape("custom"), TypeError);
});

for (const entry of implPhaseScopes) {
  const name = entry.definition.declarationName;
  test(`${name}: lawful isolated scope proves fixed leaves, named routing and Service source closure`, (t) => {
    const seed = new ImplPhaseCheckerSeed(entry);
    const report = seed.inspect();
    t.diagnostic(report.describe());
    success(report);
    assert.equal(seed.registrations.length, entry.definition.leaves.length);
    for (let index = 0; index < seed.registrations.length; index++) {
      assert.ok(report.visited.has(`${entry.entry}/step${index}.js`));
    }
    assert.ok(report.serviceBoundaries.has("src/flow/services/service.js"));
    for (const shape of seed.shapes) for (const caller of shape.callers) assert.ok(report.reverseIndexed.has(caller.module));
  });

  for (const leaf of entry.definition.leaves) {
    test(`A01 ${leaf.stepId}: a missing responsibility cannot pass merely by deleting its Step source`, () => {
      const seed = new ImplPhaseCheckerSeed(entry);
      const files = seed.files();
      const index = seed.registrations.findIndex((registration) => registration.stepId === leaf.stepId);
      files.delete(`${entry.entry}/step${index}.js`);
      const original = files.get(entry.composition);
      files.set(entry.composition, original.replace(new RegExp(`import \\{ Entry${index}Step \\}[^;]+;`), "")
        .replace(new RegExp(`new StepRegistration\\(\\{ stepId: '${leaf.stepId}'[^)]+\\}\\)`), "")
        .replaceAll(",,", ",").replace("[,", "[").replace(",]", "]"));
      const selected = seed.registrations.filter((registration) => registration.stepId !== leaf.stepId);
      violation(seed.inspect(files, seed.scope(selected, selected)), "A01", entry.composition,
        `responsibility leaf ${leaf.stepId} has 0 selected registrations`, [entry.definition.module, entry.composition]);
      success(seed.inspect());
    });

    test(`A01/A11 production ${leaf.stepId} has its real fixed-scope registration and single lookup`, async () => {
      const registrations = await new ImplPhaseProductionRegistrations(root, entry).load();
      const registration = registrations.filter((registration) => registration.stepId === leaf.stepId);
      assert.equal(registration.length, 1, `A01 fixed leaf ${leaf.stepId} requires exactly one registration`);
      assert.equal(registration[0] instanceof StepRegistration, true);
      assert.deepEqual(registration[0].StepClass.dependencies, [registration[0].ServiceClass]);
    });
  }

  test(`${name}: production obeys A01-A12 through actual phase registration and all named callers`, async (t) => {
    const { selected, registry } = await new ImplPhaseProductionRegistrations(root, entry).registry();
    const report = checkStructure({ root, entry: entry.entry, registrations: selected,
      registrationModule: entry.composition, contract: implPhaseStructureContract(entry, registry) });
    t.diagnostic(report.describe());
    success(report);
    assert.ok(report.visited.size > 0 && report.serviceBoundaries.size > 0 && report.reverseIndexed.size > 0);
    for (const shape of implPhaseExecutionShapes(entry)) for (const caller of [...shape.callers, ...shape.loaders]) {
      assert.ok(report.reverseIndexed.has(caller.module), `A06/A09/A10/A11 did not index ${caller.module}`);
    }
  });

  for (const [label, source] of [["missing export", "export const unrelated = [];"],
    ["empty scope", `export const ${entry.exportName} = [];`],
    ["invalid registration export", `export const ${entry.exportName} = [{}];`]]) {
    test(`A01/A11 ${name}: ${label} is a contract assertion, not a syntax/import failure`, async (t) => {
      const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-37e4-registration-"));
      t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
      const module = path.join(isolated, entry.composition);
      fs.mkdirSync(path.dirname(module), { recursive: true });
      fs.writeFileSync(path.join(isolated, "package.json"), JSON.stringify({ type: "module" }));
      fs.writeFileSync(module, source);
      await assert.rejects(new ImplPhaseProductionRegistrations(isolated, entry).load(), (error) => {
        assert.equal(error.code, "ERR_ASSERTION");
        assert.match(error.message, /A01\/A11/);
        assert.ok(error.message.includes(entry.composition) && error.message.includes(entry.exportName));
        for (const leaf of entry.definition.leaves) assert.ok(error.message.includes(leaf.stepId));
        assert.match(error.message, /must export a nonempty/);
        return true;
      });
    });
  }
}

test("isolated valid production export reaches the shared loader and checker without replacing production acceptance", async (t) => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "sennel-37e4-valid-export-"));
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  const fixtureModule = pathToFileURL(path.join(root, "tests/fixtures/structure/staged-execution.js")).href;
  for (const entry of implPhaseScopes) {
    const module = path.join(isolated, `${entry.exportName}.mjs`);
    fs.writeFileSync(module, `import { StagedExecutionSeed } from ${JSON.stringify(fixtureModule)};
      export const ${entry.exportName} = new StagedExecutionSeed('export-fixture', ${JSON.stringify(entry.definition.leaves.map((leaf) => leaf.stepId))}).registrations;`);
    const loaded = await new ProductionRegistrations(pathToFileURL(module), entry.exportName).load();
    assert.deepEqual(loaded.map((registration) => registration.stepId), entry.definition.leaves.map((leaf) => leaf.stepId));
    const seed = new StagedExecutionSeed("export-fixture", loaded.map((registration) => registration.stepId));
    success(new StructureChecker(seed.scope(loaded, loaded), new MemorySourceRepository(seed.files())).check());
  }
});

test("A01 Step placement and production entries correspond in both directions", () => {
  for (const entry of implPhaseScopes) {
    const seed = new ImplPhaseCheckerSeed(entry);
    const files = seed.files();
    const unregistered = `${entry.entry}/unregistered.js`;
    const source = "import { Step } from '../../engine/step.js'; export class Unregistered extends Step {}";
    files.set(unregistered, source);
    violation(seed.inspect(files), "A01", unregistered, "Step has no production registration", [unregistered], source, "class Unregistered");
    files.delete(unregistered);
    success(seed.inspect(files));
    const outside = "src/flow/services/moved-step.js";
    files.set(outside, files.get(`${entry.entry}/step0.js`).replaceAll("../../engine/", "../engine/").replaceAll("../../services/", "./"));
    files.delete(`${entry.entry}/step0.js`);
    files.set(entry.composition, files.get(entry.composition).replace(`../../steps/${entry.entry.split("/").at(-1)}/step0.js`, "../../services/moved-step.js"));
    violation(seed.inspect(files), "A01", outside, "registered Step is outside scope entry", [outside]);
    success(seed.inspect());
  }
});

test("A01 single registry detects duplicate, invalid, foreign and excluded fixed registrations", () => {
  const seed = new ImplPhaseCheckerSeed(implPhaseScopes[0]);
  for (const [registry, message] of [
    [[...seed.registrations, seed.registrations[0]], "single production registry duplicates implement"],
    [[...seed.registrations, null], "single production registry contains an invalid registration type"],
    [new ImplPhaseCheckerSeed(implPhaseScopes[0]).registrations, "selection implement does not belong"],
  ]) violation(seed.inspect(seed.files(), seed.scope(seed.registrations, registry)), "A01", seed.entry.composition,
    message, [seed.entry.composition]);
  violation(seed.inspect(seed.files(), seed.scope(seed.registrations.slice(1), seed.registrations)),
    "A01", seed.entry.composition, "leaf implement was excluded", [seed.entry.composition]);
  success(seed.inspect());
});

for (const [form, callerName, before, after] of [
  ["source-entry", "consumeWorkerExecution", "const selection = input.selection;", "const selection = registration.executionContract.select({ ...input, registration });"],
  ["host-filter", "executeHostFilterInput", "const registration =", "if (input.stepId === 'task-triage') return null; const registration ="],
  ["external-process", "executeTestChainInput", "const registration =", "if (input.fast) return input.command.execute(input); const registration ="],
  ["deterministic-review", "projectTestChainExecutionDirective", "project(selection,", "project(null,"],
  ["semantic-review", "projectReviewExecution", "project(selection,", "project(null,"],
  ["aggregate-gate", "recoverGateExecution", "const selection = input.selection;", "let selection = input.selection; selection = null;"],
]) {
  test(`A10 ${form} callers preserve the same selection through display/execute/post/recovery`, () => {
    const seed = new ImplPhaseCheckerSeed(implPhaseScopes[form === "host-filter" ? 1 : 0]);
    const shape = seed.shapes.find((shape) => shape.form === form);
    const caller = shape.callers.find((caller) => caller.declarationName === callerName);
    const files = seed.files();
    const original = files.get(caller.module);
    assert.ok(original.includes(before));
    const declarationOffset = original.indexOf(`export function ${callerName}(input)`);
    assert.ok(declarationOffset >= 0);
    files.set(caller.module, original.slice(0, declarationOffset)
      + original.slice(declarationOffset).replace(before, after));
    violation(seed.inspect(files), "A10", caller.module, `${callerName} does not preserve registered lookup and selection`,
      [seed.entry.composition, shape.adapterModule, caller.module]);
    files.set(caller.module, original);
    success(seed.inspect(files));
  });
}

test("A11 named routes bind display, dispatch, gate and review CLI entries to their actual named loaders", () => {
  const seed = new ImplPhaseCheckerSeed(implPhaseScopes[0]);
  const files = seed.files();
  const file = "src/flow/registry.js";
  const original = files.get(file);
  for (const [group, command, loader] of [["get", "next-action", "loadGetNextActionCommand"],
    ["run", "dispatch", "loadDispatchCommand"], ["run", "gate", "loadGateCommand"], ["run", "review", "loadReviewCommand"]]) {
    const malformed = original.replace(`command: ${loader}`, "command: loadUnknownCommand");
    files.set(file, malformed);
    violation(seed.inspect(files), "A11", file, `FLOW_COMMANDS ${group}.${command} must have one named ${loader}`,
      [file], malformed, "const FLOW_COMMANDS");
    files.set(file, original);
    success(seed.inspect(files));
  }
});

for (const entry of implPhaseScopes) {
  const step = `${entry.entry}/step0.js`;
  const helper = "src/flow/lib/implementation-value.js";
  for (const [label, rule, target, source, importSource, trace, marker, message] of [
    ["direct Definition dependency", "A02", step, "import { FLOW_DEFINITION } from '../../definition.js';", null,
      [step, "src/flow/definition.js"], "import", "step depends on forbidden"],
    ["helper-to-Definition dependency", "A03", helper, "export { FLOW_DEFINITION } from '../definition.js';",
      "import { FLOW_DEFINITION } from '../../lib/implementation-value.js';",
      [step, helper, "src/flow/definition.js"], "export", "helper depends on forbidden"],
    ["hidden Service dependency", "A04", helper, "export { ServiceClass } from '../services/service.js';",
      "import { ServiceClass as HiddenService } from '../../lib/implementation-value.js';",
      [step, helper, "src/flow/services/service.js"], "export", "Service reached outside declared Step dependency"],
    ["direct environment read", "A05", step, "export const environment = process.env;", null,
      [step], "process", "process"],
    ["dynamic loading", "A05", step, "export function load() { return import('node:fs'); }", null,
      [step], "import", "dynamic"],
    // Static builtin dependency violations belong to A02/A03; A05 owns dynamic/global loading.
    ["prohibited normalized builtin", "A02", step, "import fs from 'fs';", null,
      [step], "import", "builtin fs"],
    ["Service global read", "A08", "src/flow/services/service.js", null, null,
      ["src/flow/services/service.js"], "process", "external state through process"],
    ["typed input broad-source smuggling", "A12", entry.composition, null, null,
      [entry.composition], "ctx", "typed input receives broad dependency ctx"],
    ["Service construction outside registration", "A09", "src/flow/lib/illegal-service-construction.js",
      "import { ServiceClass as Alias } from '../services/service.js'; export function create() { return new Alias(); }", null,
      ["src/flow/lib/illegal-service-construction.js", "src/flow/services/service.js"], "new", "outside StepRegistration"],
    ["named adapter bypass", "A11", "src/flow/lib/illegal-adapter.js",
      "import { workerStepExecutionContract as escaped } from './worker-execution-admission.js'; export function execute(input) { return escaped.execute(input.selection, input); }", null,
      ["src/flow/lib/illegal-adapter.js", "src/flow/lib/worker-execution-admission.js"], "import", "shared execution adapter imported outside production registration"],
  ]) {
    test(`${entry.exportName}: ${rule} rejects ${label} alone and accepts exact restoration`, () => {
      const seed = new ImplPhaseCheckerSeed(entry);
      const files = seed.files();
      const original = files.get(target);
      if (rule === "A08") files.set(target, original.replace("throw new TypeError(); } }",
        "throw new TypeError(); } environment() { return process.env; } }"));
      else if (rule === "A12") files.set(target, original.replace("new Input()", "new Input(ctx)"));
      else if (target === step) files.set(target, `${source}\n${original}`);
      else files.set(target, source);
      if (importSource !== null) files.set(step, `${importSource}\n${files.get(step)}`);
      violation(seed.inspect(files), rule, target, message, trace, files.get(target), marker);
      if (original === undefined) files.delete(target);
      else files.set(target, original);
      if (importSource !== null) files.set(step, seed.files().get(step));
      success(seed.inspect(files));
    });
  }

  test(`${entry.exportName}: A06 reverse index traces a Step through re-export to the illegal caller`, () => {
    const seed = new ImplPhaseCheckerSeed(entry);
    const files = seed.files();
    const barrel = "src/flow/lib/step-barrel.js";
    const caller = "src/flow/lib/step-caller.js";
    const reexport = `export { Entry0Step as Escaped } from '../steps/${entry.entry.split("/").at(-1)}/step0.js';`;
    files.set(barrel, reexport);
    const source = "import { Escaped as Alias } from './step-barrel.js'; export const reference = Alias;";
    files.set(caller, source);
    const report = seed.inspect(files);
    // A06 reports each indexed edge; together these prove the indirect Step reference.
    violation(report, "A06", caller, "Step is referenced outside composition", [caller, barrel], source, "import");
    violation(report, "A06", barrel, "Step is referenced outside composition", [barrel, step], reexport, "export");
    files.delete(caller);
    files.delete(barrel);
    success(seed.inspect(files));
  });

  test(`${entry.exportName}: A08 settlement writer rejects manager reads behind an alias`, () => {
    const seed = new ImplPhaseCheckerSeed(entry);
    const files = seed.files();
    const writer = "src/flow/services/alpha-settlement-writer.js";
    const original = files.get(writer);
    const source = "export class Writer { #flowManager; constructor(source) { this.#flowManager = source; } settle() { const alias = this.#flowManager; return alias.artifactCatalog('x'); } }";
    files.set(writer, source);
    const report = seed.inspect(files);
    violation(report, "A08", writer, "settlement writer reads or escapes manager through artifactCatalog",
      ["src/flow/services/service.js", writer], source, "artifactCatalog");
    files.set(writer, original);
    success(seed.inspect(files));
  });
}
