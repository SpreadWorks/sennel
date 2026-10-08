import path from "node:path";
import { Step } from "../../../src/flow/engine/step.js";
import { StepRegistration } from "../../../src/flow/engine/composition/step-registration.js";
import { StepExecutionContract } from "../../../src/flow/engine/composition/step-execution-contract.js";
import { MemorySourceRepository } from "../../support/structure/source-repository.js";
import { SyntheticStructureSeed } from "./synthetic.js";
import { DefinitionLeafScope, ExecutionCaller, ExecutionLoader, NamedExecutionShape, StructureLeaf, StructureScopeContract, SharedExecutionShape } from "../../support/structure/production-registrations.js";
import { StructureScope, StructureChecker } from "../../support/structure/checker.js";

class Input {}
class Writer {}
class ServiceClass {
  static argumentTypes = [Input, Writer];
  get settledOutcome() { return null; }
}
function prepareServiceArguments() { return [new Input(), new Writer()]; }
function selectCommand(input) { return input; }
function projectCommand(selection) { return selection; }
function executeCommand(selection) { return selection; }

/** Renamed phase fixture uses the real registration and execution value classes. */
export class StagedExecutionSeed {
  constructor(phase = "omega", ids = ["first", "second"], leaves = null, form = "command") {
    this.phase = phase;
    this.ids = Object.freeze([...ids]);
    this.entry = `src/flow/steps/${phase}`;
    this.composition = `src/flow/engine/composition/${phase}.js`;
    this.adapter = "src/flow/lib/command-execution.js";
    const executionContract = new StepExecutionContract({ select: selectCommand, project: projectCommand, execute: executeCommand });
    this.registrations = ids.map((stepId, index) => {
      const StepClass = class extends Step { static dependencies = [ServiceClass]; };
      Object.defineProperty(StepClass, "name", { value: `Entry${index}Step` });
      return new StepRegistration({ stepId, StepClass, ServiceClass, prepareServiceArguments, executionContract });
    });
    this.callers = Object.freeze([
      new ExecutionCaller("src/flow/lib/command-display.js", "display", "commandRegistration", "project"),
      new ExecutionCaller("src/flow/lib/command-run.js", "run", "commandRegistration", "execute", "replayReceipt"),
      new ExecutionCaller("src/flow/lib/command-direct.js", "direct", "commandRegistration", "execute"),
      new ExecutionCaller("src/flow/lib/command-post.js", "post", "commandRegistration", "execute", null, "consume"),
      new ExecutionCaller("src/flow/lib/command-recovery.js", "recover", "commandRegistration", "execute", null, "consume"),
    ]);
    this.shape = new NamedExecutionShape(form, this.adapter, "commandStepExecutionContract",
      "selectCommand", "projectCommand", "executeCommand", this.callers,
      [new ExecutionLoader("src/flow/command-registry.js", "loadCommand", "src/flow/lib/command-direct.js")]);
    this.definition = new DefinitionLeafScope("src/flow/definition.js", leaves?.[0]?.scope === "task" ? "TASK_DEFINITION" : "FLOW_DEFINITION",
      leaves ?? ids.map((id) => new StructureLeaf(id, "flow", id, form)));
  }

  scope(registrations = this.registrations, registry = this.registrations) {
    return new StructureScope("/virtual", this.entry, registrations, this.composition,
      new StructureScopeContract(this.definition, [this.shape], registry));
  }

  files() {
    const files = new SyntheticStructureSeed(this.phase, "Entry0Step", "value", this.ids[0]).files();
    const imports = [];
    const registrations = [];
    this.ids.forEach((id, index) => {
      const name = `Entry${index}Step`;
      files.set(`${this.entry}/step${index}.js`, `import { Step } from '../../engine/step.js';
        import { ServiceClass } from '../../services/service.js';
        export class ${name} extends Step { static dependencies = [ServiceClass]; }`);
      imports.push(`import { ${name} } from '../../steps/${this.phase}/step${index}.js';`);
      registrations.push(`new StepRegistration({ stepId: '${id}', StepClass: ${name}, ServiceClass,
        prepareServiceArguments, executionContract: commandStepExecutionContract })`);
    });
    files.delete(`${this.entry}/step.js`);
    files.set(this.composition, `${imports.join("\n")}
      import { ServiceClass } from '../../services/service.js';
      import { Input } from '../../services/input.js';
      import { Writer } from '../../services/alpha-settlement-writer.js';
      import { commandStepExecutionContract } from '../../lib/command-execution.js';
      function prepareServiceArguments() { return [new Input(), new Writer()]; }
      export const registrations = [${registrations.join(",")}];
      const byId = new Map(registrations.map((registration) => [registration.stepId, registration]));
      export function commandRegistration(stepId) { return byId.get(stepId) ?? null; }`);
    files.set(this.adapter, `export function selectCommand(input) { return input; }
      export function projectCommand(selection, input) { return selection; }
      export function executeCommand(selection, input) { return selection; }
      export const commandStepExecutionContract = new StepExecutionContract({
        select: selectCommand, project: projectCommand, execute: executeCommand });`);
    files.set(this.definition.module, `const ${this.definition.declarationName} = Object.freeze([
      ${this.ids.map((id) => `new FlowNode({ id: '${id}' })`).join(",")}]);`);
    for (const caller of this.callers) files.set(caller.module,
      `import { commandRegistration } from '../engine/composition/${this.phase}.js';
       ${caller.receiptReplayName === null ? "" : "function replayReceipt(receipt) { return receipt; }"}
       export function ${caller.declarationName}(input) { ${caller.body().replaceAll("$STRING_LITERAL", "'registration required'")} }`);
    files.set("src/flow/command-registry.js", "export function loadCommand() { return import('./lib/command-direct.js'); }");
    // This seed uses its named command routes; unrelated legacy execution consumers are absent.
    files.delete("src/flow/lib/get-next-action.js");
    files.delete("src/flow/lib/run-dispatch.js");
    return files;
  }
}

/** Isolated source graph, never an alternative runtime registration registry. */
export class NamedPhaseExecutionSeed {
  constructor(entry, executionShapes, executionForms) {
    this.executionForms = executionForms;
    this.entry = entry;
    const phase = entry.entry.split("/").at(-1);
    this.base = new StagedExecutionSeed(phase, entry.definition.leaves.map((leaf) => leaf.stepId), entry.definition.leaves);
    // Synthetic named callers exercise checker wiring only. Production uses the
    // nominal shared shapes and their existing specialized routing judgments.
    this.shapes = executionShapes.map((shape) => shape instanceof SharedExecutionShape
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
      ...registration, executionContract: contracts.get(this.executionForms[registration.stepId]),
    }));
  }

  scope(registrations = this.registrations, registry = this.registrations) {
    return new StructureScope("/virtual", this.entry.entry, registrations, this.entry.composition,
      this.entry.contract(registry, this.shapes,
        Object.fromEntries(this.entry.definition.leaves.map((leaf) => [leaf.stepId, this.executionForms[leaf.stepId]]))));
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
        [...adapterImports].filter(([module]) => module !== this.entry.composition).map(([module, names]) => `import { ${[...names].join(", ")} } from '${path.posix.relative(path.posix.dirname(this.entry.composition), module)}';`).join("\n"))
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
      files.set(module, module === this.entry.composition ? `${files.get(module)}\n${adapter}` : adapter);
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
    const loaders = [...new Map(this.shapes.flatMap((shape) => shape.loaders)
      .map((loader) => [`${loader.module}#${loader.declarationName}`, loader])).values()];
    for (const module of new Set(loaders.map((loader) => loader.module))) {
      const selected = loaders.filter((loader) => loader.module === module);
      const groups = new Map();
      const defaults = { loadGetNextActionCommand: ["get", "next-action"], loadDispatchCommand: ["run", "dispatch"],
        loadGateCommand: ["run", "gate"], loadReviewCommand: ["run", "review"] };
      for (const loader of selected) {
        const [group, command] = loader.commandGroup === null ? defaults[loader.declarationName] ?? []
          : [loader.commandGroup, loader.commandName];
        if (group === undefined) continue;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(`'${command}': { command: ${loader.declarationName} }`);
      }
      files.set(module, selected.map((loader) => {
        const relative = path.posix.relative(path.posix.dirname(module), loader.commandModule);
        return `function ${loader.declarationName}() { return import('${relative.startsWith(".") ? relative : `./${relative}`}'); }`;
      }).join("\n") + `\nexport const FLOW_COMMANDS = { ${[...groups].map(([group, entries]) => `${group}: { ${entries.join(",")} }`).join(",")} };`);
    }
    files.set("src/flow/lib/run-gate.js", "export class RunGateCommand {}\n");
    files.set("src/flow/lib/run-review.js", "export class RunReviewCommand {}\n");
    return files;
  }

  inspect(files = this.files(), scope = this.scope()) {
    return new StructureChecker(scope, new MemorySourceRepository(files)).check();
  }
}
